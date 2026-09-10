#!/usr/bin/env python3
"""Reduce one agent-mesh run's state dir to a bounded, deterministic digest.

The event log is thousands of lines of JSONL; turns.jsonl carries the full
prompt of every turn. Reading either into an agent context burns a session and
teaches nothing. This does the reduction on disk and prints ~<120 lines.

Deterministic: no timestamps, no durations, no ids in the default output, so
two runs of the same config diff cleanly. Pass --ids to include artifact ids.

usage: digest-run.py <state-dir> [--ids] [--top N]
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys

TOP_DEFAULT = 12
# Statuses that mean the artifact reached the end of its state machine.
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


def section(title):
    print(f"\n## {title}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("state_dir")
    ap.add_argument("--ids", action="store_true", help="include artifact ids (breaks run-to-run diffing)")
    ap.add_argument("--top", type=int, default=TOP_DEFAULT)
    args = ap.parse_args()

    sd = args.state_dir
    logs = os.path.join(sd, "logs")
    events = list(read_jsonl(os.path.join(logs, "events.jsonl")))
    turns = list(read_jsonl(os.path.join(logs, "turns.jsonl")))
    if not events:
        print(f"NO EVENTS at {logs}/events.jsonl — the run never started or wrote elsewhere.")
        return 1

    def payload(e):
        return e.get("payload") or {}

    by_type = collections.Counter(e.get("type") for e in events)

    # ---- outcome -------------------------------------------------------
    print("# mesh run digest")
    outcome = "UNTERMINATED"
    reason = ""
    for e in events:
        if e.get("type") in ("goal.completed", "goal.failed", "goal.escalated"):
            outcome = e["type"]
            reason = str(payload(e).get("reason", ""))[:100]
    print(f"outcome: {outcome} {reason}")
    print(f"events: {len(events)}   turns: {len(turns)}   event types: {len(by_type)}")

    prog = [payload(e) for e in events if e.get("type") == "goal.progress"]
    if prog:
        last = prog[-1]
        print(f"progress: {last.get('completed')}/{last.get('total')} criteria")

    unsat = [
        c
        for e in events
        if e.get("type") == "requirements.created"
        for c in (payload(e).get("criteria") or [])
    ]
    satisfied = {payload(e).get("criterionId") for e in events if e.get("type") == "requirement.satisfied"}
    missing = [c.get("id", str(c)) if isinstance(c, dict) else str(c) for c in unsat]
    missing = [c for c in missing if c not in satisfied]
    if missing:
        print(f"criteria NEVER satisfied: {', '.join(sorted(missing)[:8])}")

    # ---- what the runtime refused --------------------------------------
    # message.rejected carries {from, action, subject, reason, ruleId, denied}.
    # It is the single richest "the policy engine said no" signal.
    section("denials (message.rejected)")
    denials = collections.Counter()
    for e in events:
        if e.get("type") == "message.rejected":
            p = payload(e)
            denials[(p.get("ruleId") or "-", p.get("action") or "-", str(p.get("reason"))[:70])] += 1
    if not denials:
        print("(none)")
    for (rule, action, why), n in denials.most_common(args.top):
        print(f"{n:>3}x rule={rule} action={action} :: {why}")

    # ---- ops the supervisor rejected inside a turn ----------------------
    section("rejected ops (turns.jsonl opTimings)")
    op_fail = collections.Counter()
    no_tool_turns = collections.Counter()
    all_rejected = 0
    tokens = 0
    for t in turns:
        tokens += int(t.get("tokens") or 0)
        for o in t.get("opTimings") or []:
            if not o.get("ok"):
                op_fail[(o.get("op"), str(o.get("reason"))[:70])] += 1
        ops = t.get("ops") or []
        failed = sum(1 for o in (t.get("opTimings") or []) if not o.get("ok"))
        if ops and failed == len(t.get("opTimings") or []):
            all_rejected += 1
        if not t.get("toolCalls"):
            no_tool_turns[t.get("agentId")] += 1
    if not op_fail:
        print("(none)")
    for (op, why), n in op_fail.most_common(args.top):
        print(f"{n:>3}x op={op} :: {why}")
    print(f"turns where EVERY op was rejected: {all_rejected}/{len(turns)}")

    # ---- turns that produced nothing -----------------------------------
    # toolCalls == 0 means the agent read, ran and checked nothing. A claim from
    # such a turn is the agent's own word (see ASSERTED in protocol/types.ts).
    section("turns with zero tool calls (claims with no evidence)")
    if not no_tool_turns:
        print("(none)")
    for agent, n in sorted(no_tool_turns.items(), key=lambda kv: (-kv[1], str(kv[0])))[: args.top]:
        print(f"{n:>3} turns  {agent}")

    # ---- artifacts stuck --------------------------------------------------
    section("artifacts not terminal")
    names, status, gate_blocked = {}, {}, collections.Counter()
    for e in events:
        p = payload(e)
        if e.get("type") == "artifact.created":
            a = p.get("artifact") or {}
            names[a.get("id")] = f"{a.get('type')}/{a.get('name')}"
            status[a.get("id")] = a.get("status")
        elif e.get("type") == "artifact.transition":
            status[p.get("artifactId")] = p.get("to")
            if p.get("gateSatisfied") is False:
                gate_blocked[p.get("artifactId")] += 1
    stuck = [(names.get(i, i), s, i) for i, s in status.items() if s not in TERMINAL]
    if not stuck:
        print("(all terminal)")
    for name, st, aid in sorted(stuck)[: args.top]:
        gate = f" gate-blocked x{gate_blocked[aid]}" if gate_blocked[aid] else ""
        suffix = f"  {aid}" if args.ids else ""
        print(f"{st:<18} {name}{gate}{suffix}")

    # ---- conflicts / escalations / deadlocks ---------------------------
    section("conflicts, escalations, deadlocks")
    interesting = [
        "review.rejected",
        "requirement.blocked",
        "escalation.requested",
        "escalation.responded",
        "escalation.auto_resolved",
        "deadlock.auto_resolved",
        "goal.reopened",
        "agent.failed",
        "agent.restarted",
        "budget.exceeded",
    ]
    # An accepted block is a BLOCK message (message.sent), not a
    # review.rejected — the kernel emits review.rejected for a block only when
    # the blocked party refuses it (blockedInstead). Without this, a
    # successfully handled conflict reads as "(none)".
    blocks = [
        payload(e).get("message") or {}
        for e in events
        if e.get("type") == "message.sent" and (payload(e).get("message") or {}).get("type") == "BLOCK"
    ]
    hits = [(t, by_type[t]) for t in interesting if by_type[t]]
    if blocks:
        hits.append(("message.sent (BLOCK)", len(blocks)))
    if not hits:
        print("(none)")
    for t, n in hits:
        print(f"{n:>3}x {t}")
    for e in events:
        if e.get("type") in ("review.rejected", "requirement.blocked", "escalation.requested"):
            p = payload(e)
            why = p.get("reason") or p.get("comment") or p.get("question") or ""
            print(f"    {e['type']}: {str(why)[:90]}")
    for m in blocks:
        reason = (m.get("payload") or {}).get("reason") or ""
        targets = ",".join(m.get("to") or [])
        print(f"    BLOCK {m.get('from')} -> {targets}: {str(reason)[:90]}")

    # ---- projection rejections (a real bug class, not policy) ----------
    section("projection rejections")
    rej = os.path.join(logs, "projection-rejections.log")
    lines = []
    if os.path.exists(rej):
        with open(rej, encoding="utf-8", errors="replace") as fh:
            # strip the leading ISO timestamp so the digest stays diffable
            lines = [ln.strip().split(" ", 1)[-1] for ln in fh if ln.strip()]
    if not lines:
        print("(none)")
    for text, n in collections.Counter(lines).most_common(args.top):
        print(f"{n:>3}x {text[:110]}")

    # ---- budget ---------------------------------------------------------
    section("budget")
    consumed = collections.Counter()
    for e in events:
        if e.get("type") == "budget.consumed":
            p = payload(e)
            consumed[p.get("agentId") or p.get("key")] += int(p.get("amount") or 0)
    print(f"tokens (turns.jsonl): {tokens}")
    for who, amt in consumed.most_common(args.top):
        print(f"{amt:>9}  {who}")

    # ---- histogram last: bulky, least surprising ------------------------
    section("event histogram")
    for t, n in sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0])):
        print(f"{n:>4} {t}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
