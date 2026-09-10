#!/usr/bin/env python3
"""Side-by-side: one agent-mesh run vs one plain opencode baseline.

Reads the mesh state dir (events.jsonl / turns.jsonl / projection-rejections.log)
and the baseline dir written by run-baseline.sh (baseline-events.json,
baseline-meta.json, baseline-export.json, criteria.json). Prints one bounded
table plus a per-criterion rubric; never prints raw events.

Cost caveat: mesh tokens come from turns.jsonl. Baseline billed tokens exclude
cache reads, matching the mesh total's definition (input + output + reasoning +
cache write). A $ estimate for the mesh is printed only when the baseline
actually cost money and the models look the same; otherwise it is n/a, not
guessed.

usage: compare-runs.py <mesh-state-dir> <baseline-dir> [--top N]
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import sys

TERMINAL = {"MERGED", "ACCEPTED", "FINAL", "ARCHIVED", "REJECTED"}


def read_jsonl(path):
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def iso(value):
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def span(records, start_key, end_key):
    starts = [iso(r.get(start_key)) for r in records]
    ends = [iso(r.get(end_key)) or iso(r.get(start_key)) for r in records]
    starts = [s for s in starts if s]
    ends = [e for e in ends if e]
    if not starts or not ends:
        return None
    return (max(ends) - min(starts)).total_seconds()


def fmt_secs(value):
    if value is None:
        return "?"
    if value >= 3600:
        return f"{value / 3600:.1f}h"
    if value >= 60:
        return f"{value / 60:.1f}m"
    return f"{value:.0f}s"


def model_name(value):
    if isinstance(value, dict):
        provider = value.get("providerID") or value.get("provider") or ""
        model = value.get("id") or value.get("modelID") or ""
        return f"{provider}/{model}".strip("/")
    return str(value or "")


def mesh_metrics(state_dir):
    events = list(read_jsonl(os.path.join(state_dir, "logs", "events.jsonl")))
    turns = list(read_jsonl(os.path.join(state_dir, "logs", "turns.jsonl")))
    m = {}
    outcome = "UNTERMINATED"
    for e in events:
        if e.get("type") in ("goal.completed", "goal.failed", "goal.escalated"):
            outcome = e["type"]
    m["outcome"] = outcome
    m["turns"] = len(turns)
    m["tokens"] = sum(int(t.get("tokens") or 0) for t in turns)
    m["models"] = sorted({t.get("model") for t in turns if t.get("model")})
    m["tool_calls"] = sum(int(t.get("toolCalls") or 0) for t in turns)
    m["zero_evidence_turns"] = sum(1 for t in turns if not t.get("toolCalls"))
    m["denials"] = sum(1 for e in events if e.get("type") == "message.rejected")
    m["rejected_ops"] = sum(
        1 for t in turns for o in (t.get("opTimings") or []) if not o.get("ok")
    )
    created = [
        c
        for e in events
        if e.get("type") == "requirements.created"
        for c in ((e.get("payload") or {}).get("criteria") or [])
    ]
    satisfied = [
        e.get("payload") or {}
        for e in events
        if e.get("type") == "requirement.satisfied"
    ]
    satisfied_ids = {p.get("criterionId") for p in satisfied}
    m["criteria_total"] = len(created)
    m["criteria_satisfied"] = sum(
        1
        for c in created
        if (c.get("id") if isinstance(c, dict) else c) in satisfied_ids
    )
    m["satisfied_unverified"] = sum(1 for p in satisfied if p.get("verified") is False)
    m["criterion_ids"] = [
        c.get("id") if isinstance(c, dict) else str(c) for c in created
    ]
    m["criterion_satisfied_ids"] = satisfied_ids

    names, status = {}, {}
    for e in events:
        p = e.get("payload") or {}
        if e.get("type") == "artifact.created":
            a = p.get("artifact") or {}
            names[a.get("id")] = f"{a.get('type')}/{a.get('name')}"
            status[a.get("id")] = a.get("status")
        elif e.get("type") == "artifact.transition":
            status[p.get("artifactId")] = p.get("to")
    stuck = sorted((names.get(i, i), s) for i, s in status.items() if s not in TERMINAL)
    m["stuck_artifacts"] = len(stuck)
    m["stuck_sample"] = stuck[:5]

    proj = os.path.join(state_dir, "logs", "projection-rejections.log")
    m["projection_rejections"] = (
        sum(1 for _ in open(proj, encoding="utf-8", errors="replace"))
        if os.path.exists(proj)
        else 0
    )
    m["span"] = span(turns, "startedAt", "endedAt")
    return m


def baseline_metrics(baseline_dir):
    events = list(read_jsonl(os.path.join(baseline_dir, "baseline-events.json")))
    meta = {}
    meta_path = os.path.join(baseline_dir, "baseline-meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as fh:
            meta = json.load(fh)
    m = {
        "meta": meta,
        "steps": 0,
        "tool_calls": 0,
        "tools": collections.Counter(),
        "tokens": 0,
        "cache_read": 0,
        "cost": 0.0,
        "files": [],
        "session": "",
        "model": "",
        "timestamps": [],
    }
    for e in events:
        if e.get("sessionID") and not m["session"]:
            m["session"] = e["sessionID"]
        if e.get("timestamp"):
            m["timestamps"].append(e["timestamp"])
        typ = e.get("type")
        part = e.get("part") or {}
        if typ == "step_finish":
            m["steps"] += 1
            tok = part.get("tokens") or {}
            cache = tok.get("cache") or {}
            m["tokens"] += (
                int(tok.get("input") or 0)
                + int(tok.get("output") or 0)
                + int(tok.get("reasoning") or 0)
                + int(cache.get("write") or 0)
            )
            m["cache_read"] += int(cache.get("read") or 0)
            m["cost"] += float(part.get("cost") or 0)
        elif typ == "tool_use":
            m["tool_calls"] += 1
            tool = part.get("tool") or "?"
            m["tools"][tool] += 1
            inp = (part.get("state") or {}).get("input") or {}
            path = inp.get("filePath") or inp.get("path")
            if tool in ("write", "edit", "patch", "multiedit") and path:
                if path not in m["files"]:
                    m["files"].append(path)
    export_path = os.path.join(baseline_dir, "baseline-export.json")
    if os.path.exists(export_path):
        try:
            with open(export_path, encoding="utf-8") as fh:
                info = (json.load(fh) or {}).get("info") or {}
            m["model"] = model_name(info.get("model"))
        except (json.JSONDecodeError, OSError):
            pass
    if not m["model"]:
        m["model"] = meta.get("model_env") or ""
    m["span"] = (
        (max(m["timestamps"]) - min(m["timestamps"])) / 1000
        if len(m["timestamps"]) > 1
        else None
    )
    return m


def models_match(mesh_models, baseline_model):
    if not mesh_models or not baseline_model:
        return False
    base = baseline_model.split("/")[-1].lower()
    for model in mesh_models:
        short = model.split("/")[-1].lower()
        if short == base or base in short or short in base:
            return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("state_dir")
    ap.add_argument("baseline_dir")
    ap.add_argument("--top", type=int, default=8)
    args = ap.parse_args()

    if not os.path.exists(os.path.join(args.state_dir, "logs", "events.jsonl")):
        print(f"no mesh run at {args.state_dir}/logs/events.jsonl")
        return 1
    if not os.path.exists(
        os.path.join(args.baseline_dir, "baseline-events.json")
    ):
        print(
            f"no baseline at {args.baseline_dir}/baseline-events.json — "
            "run scripts/run-baseline.sh first"
        )
        return 1

    me = mesh_metrics(args.state_dir)
    ba = baseline_metrics(args.baseline_dir)

    print("# mesh vs opencode baseline")
    print(f"mesh:     {os.path.abspath(args.state_dir)}")
    print(
        f"baseline: {os.path.abspath(args.baseline_dir)}  "
        f"({ba['meta'].get('status', '?')}, "
        f"model={ba['meta'].get('model_env') or 'config default'})"
    )

    def row(label, mesh, solo, ratio=False):
        extra = ""
        if ratio and isinstance(mesh, (int, float)) and isinstance(solo, (int, float)) and solo:
            extra = f"{mesh / solo:.2f}x mesh/solo"
        print(f"{label:<28} {str(mesh):>14} {str(solo):>14}   {extra}")

    if me["models"] and ba["cost"] > 0 and ba["tokens"] > 0:
        if models_match(me["models"], ba["model"]):
            mesh_cost = f"~${me['tokens'] * ba['cost'] / ba['tokens']:.4f} est"
        else:
            mesh_cost = f"n/a (mesh={','.join(me['models'])})"
    elif ba["cost"] == 0:
        mesh_cost = "n/a (solo $0)"
    else:
        mesh_cost = "n/a (stub)"

    print()
    row("outcome / status", me["outcome"], ba["meta"].get("status", "?"))
    row("billed tokens", me["tokens"], ba["tokens"], ratio=True)
    row("cache read tokens", "-", ba["cache_read"])
    row("cost (usd)", mesh_cost, f"${ba['cost']:.4f}")
    row("turns / steps", me["turns"], ba["steps"], ratio=True)
    row("tool calls", me["tool_calls"], ba["tool_calls"], ratio=True)
    row("wall span", fmt_secs(me["span"]), fmt_secs(ba["span"]))
    row(
        "criteria satisfied",
        f"{me['criteria_satisfied']}/{me['criteria_total']}"
        if me["criteria_total"]
        else "?",
        "judge below",
    )
    row("denials (policy)", me["denials"], "-")
    row("rejected ops", me["rejected_ops"], "-")
    row("zero-evidence turns", me["zero_evidence_turns"], "-")
    row("satisfied w/o tool evidence", me["satisfied_unverified"], "-")
    row("non-terminal artifacts", me["stuck_artifacts"], "-")
    row("projection rejections", me["projection_rejections"], "-")
    row("files delivered", "-", len(ba["files"]))

    print()
    print(f"mesh models: {', '.join(me['models']) or 'none (stub)'}")
    print(f"baseline model: {ba['model'] or 'unknown'}")
    print(f"baseline session: {ba['session']}")
    print(f"baseline sandbox: {ba['meta'].get('sandbox', '?')}")
    if me["stuck_sample"]:
        print(
            "mesh stuck: "
            + "; ".join(f"{name} [{status}]" for name, status in me["stuck_sample"])
        )
    if ba["tools"]:
        print(
            "baseline tools: "
            + ", ".join(f"{tool} x{n}" for tool, n in ba["tools"].most_common(args.top))
        )
    if ba["files"]:
        shown = [os.path.basename(f) for f in ba["files"][: args.top]]
        more = " ..." if len(ba["files"]) > args.top else ""
        print("baseline files: " + ", ".join(shown) + more)

    criteria = []
    criteria_path = os.path.join(args.baseline_dir, "criteria.json")
    if os.path.exists(criteria_path):
        with open(criteria_path, encoding="utf-8") as fh:
            criteria = json.load(fh)
    if criteria:
        print(
            "\n## criterion rubric — mesh auto-filled; judge the baseline from "
            "baseline-files.txt + the sandbox tree"
        )
        for c in criteria:
            cid = c.get("id") if isinstance(c, dict) else str(c)
            desc = (c.get("description") if isinstance(c, dict) else "") or ""
            state = (
                "satisfied"
                if cid in me["criterion_satisfied_ids"]
                else "NEVER satisfied"
            )
            print(f"  {cid:<28} mesh: {state:<16} baseline: ?   {desc}")

    print()
    if not me["models"]:
        print(
            "note: mesh used no model (stub token totals are synthetic) — read the "
            "token row as structure, not cost."
        )
    elif ba["cost"] == 0:
        print(
            "note: baseline cost is $0 (free/subscription model) — compare tokens only."
        )
    elif not models_match(me["models"], ba["model"]):
        print(
            "note: mesh and baseline ran different models — the $ estimate and token "
            "ratio are not directly comparable."
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
