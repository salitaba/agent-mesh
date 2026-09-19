import { useEffect, useState } from "react";
import { Button, rowKey } from "./components";
import { hhmmss, plainEvent } from "./format";
import { evClass } from "./events";
import { salientArg, toolGroupOf, type ToolCall, type SandboxPerms } from "./stepdetail";
// Type-only: erased at build time, so this does not create an import cycle
// with drawers.tsx, which composes the pieces below.
import type { OpRow } from "./drawers";

/* Step view: the wide, single-scroll replacement for the tabbed step drawer.
   The old surface split four reader jobs — follow the reasoning, debug the
   failure, audit the tool calls, move between turns — across five mutually
   exclusive tabs, so at most one job was served per viewport. Everything here
   is on one scroll, ordered by urgency, with a sticky inspector column that
   takes the place of the drill-down drawers that used to *replace* this panel
   (shell.tsx builds the panel as `drawer ?? detailNode`, so a nested drawer
   unmounted the step and lost the reader's position entirely). */

/** What the inspector column is currently showing. */
export type Sel =
  | { kind: "tool"; idx: number }
  | { kind: "op"; idx: number }
  | { kind: "event"; seq: number }
  | null;

export interface Section { id: string; label: string; n?: number }

/* ---------- section jump nav, with scroll spy ---------- */

/**
 * Sticky in-header nav. The drawer is the scroll container, so the observer
 * roots on it rather than the viewport; without an explicit root every section
 * reads as intersecting and the active pill never moves.
 */
export function StepJump({ sections, scroller }: { sections: Section[]; scroller: HTMLElement | null }): React.JSX.Element {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");
  useEffect(() => {
    if (!scroller) return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.intersectionRatio);
        let best = "";
        let bestRatio = 0;
        for (const [id, ratio] of seen) {
          if (ratio > bestRatio) { bestRatio = ratio; best = id; }
        }
        if (best) setActive(best);
      },
      { root: scroller, threshold: [0, 0.15, 0.5, 1], rootMargin: "-72px 0px -55% 0px" },
    );
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections, scroller]);
  const go = (id: string): void => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActive(id);
  };
  return (
    <nav className="sv-jump" aria-label="step sections">
      {sections.map((s) => (
        <button
          type="button"
          key={s.id}
          className={`sv-jump-b${active === s.id ? " on" : ""}`}
          aria-current={active === s.id ? "true" : undefined}
          onClick={() => go(s.id)}
        >
          {s.label}
          {s.n != null ? <span className="sv-jump-n mono">{s.n}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/* ---------- prose ---------- */

/**
 * Narrative text at a reading measure. The old drawer pushed reasoning,
 * summaries and instructions all through `<pre class="token-stream">`, so the
 * one genuinely prose-shaped thing on the page was set in monospace at full
 * drawer width. Mono is reserved here for payloads and identifiers.
 */
export function Prose({ children, dim }: { children: React.ReactNode; dim?: boolean }): React.JSX.Element {
  return <p className={`sv-prose${dim ? " dim" : ""}`}>{children}</p>;
}

/* ---------- op ledger ---------- */

/** Terse badge copy; the full sentence lives in the tooltip. Three lowercase
 *  words tracked uppercase at 9.5px competed with the row's actual content. */
const FX: Record<"ok" | "miss" | "na", { label: string; hint: string }> = {
  ok: { label: "recorded", hint: "the matching event was found in the log" },
  miss: { label: "not recorded", hint: "no matching event was found — this action may not have landed" },
  na: { label: "n/a", hint: "this action produces nothing observable in the event log" },
};

export function OpLedger({ rows, sel, onSelect }: {
  rows: OpRow[];
  sel: Sel;
  onSelect: (s: Sel) => void;
}): React.JSX.Element {
  return (
    <div className="sv-ops">
      {rows.map((r, i) => {
        const on = sel?.kind === "op" && sel.idx === i;
        // `undefined` means the op has no observable effect to look for (done,
        // reads, leases) — that is not a failure and must not be styled as one.
        const cls = r.fx === undefined ? "na" : r.fx ? "ok" : "miss";
        const pick = (): void => onSelect(on ? null : { kind: "op", idx: i });
        return (
          <div
            className={`sv-op sv-op-${cls}${on ? " on" : ""}`}
            key={i}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            onClick={pick}
            onKeyDown={rowKey(pick)}
          >
            <span className="sv-op-i mono" aria-hidden="true">{i + 1}</span>
            {/* Title and labelled parameters on the first line, the op's own
                prose on the second — rather than one run-on line where the
                detail was a truncated JSON blob squeezed to nothing. */}
            <div className="sv-op-main">
              <div className="sv-op-r1">
                <span className="sv-op-t">{r.head.title}</span>
                {r.head.facts.map((f) => (
                  <span className="sv-op-f" key={f.k} title={`${f.k}: ${f.v}`}>
                    <b>{f.k}</b>{f.v}
                  </span>
                ))}
              </div>
              {r.head.detail ? <span className="sv-op-d" title={r.head.detail}>{r.head.detail}</span> : null}
            </div>
            <span className={`sv-op-fx sv-op-fx-${cls}`} title={FX[cls].hint}>{FX[cls].label}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- tool calls ---------- */

/**
 * Flat, dense, one row per call in execution order. The grouped-accordion
 * version buried the sequence: reading it, you could not tell whether the
 * shell call happened before or after the edit it was supposed to verify.
 * Family is kept as a tag so a sandbox-blocked family still stands out.
 */
export function ToolRows({ calls, perms, sel, onSelect }: {
  calls: ToolCall[];
  perms?: SandboxPerms;
  sel: Sel;
  onSelect: (s: Sel) => void;
}): React.JSX.Element {
  return (
    <div className="sv-tools">
      {calls.map((c, i) => {
        const name = String(c.name ?? "tool");
        const fam = toolGroupOf(name);
        const perm = perms && fam in perms ? perms[fam as keyof SandboxPerms] : undefined;
        const blocked = perm?.level === "deny";
        const on = sel?.kind === "tool" && sel.idx === i;
        const pick = (): void => onSelect(on ? null : { kind: "tool", idx: i });
        return (
          <div
            className={`sv-tool${on ? " on" : ""}${blocked ? " blocked" : ""}`}
            key={i}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            onClick={pick}
            onKeyDown={rowKey(pick)}
          >
            <span className="sv-tool-i mono" aria-hidden="true">{i + 1}</span>
            <span className={`sv-tool-fam sv-fam-${fam}`}>{fam}</span>
            <span className="sv-tool-n mono">{name}</span>
            <span className="sv-tool-a mono">{salientArg(name, c.args) || "—"}</span>
            {blocked ? <span className="sv-tool-blk" title={perm?.via}>sandbox</span> : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- events ---------- */

export function EventRows({ rows, sel, onSelect, t0 }: {
  rows: any[];
  sel: Sel;
  onSelect: (s: Sel) => void;
  t0?: string;
}): React.JSX.Element {
  const base = t0 ? Date.parse(t0) : NaN;
  return (
    <div className="sv-evs">
      {rows.map((e) => {
        const on = sel?.kind === "event" && sel.seq === e.seq;
        const pick = (): void => onSelect(on && e.seq != null ? null : { kind: "event", seq: e.seq });
        // Offset from the turn's own start reads better than a wall clock when
        // the question is "how long after it woke did this land?".
        const ms = Number.isNaN(base) ? NaN : Date.parse(e.at) - base;
        const off = Number.isNaN(ms) ? null : ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
        return (
          <div
            className={`sv-ev ${evClass(e.type)}${on ? " on" : ""}`}
            key={e.seq ?? e.id}
            role={e.seq != null ? "button" : undefined}
            tabIndex={e.seq != null ? 0 : undefined}
            aria-pressed={e.seq != null ? on : undefined}
            onClick={() => e.seq != null && pick()}
            onKeyDown={rowKey(() => { if (e.seq != null) pick(); })}
          >
            <span className="sv-ev-off mono">{off ?? hhmmss(e.at)}</span>
            <span className={`sv-ev-t ${evClass(e.type)}`}>{plainEvent(e.type)}</span>
            <span className="sv-ev-s">{e.summary}</span>
            <span className="sv-ev-q mono">#{e.seq}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------- inspector ---------- */

export function JsonBlock({ value, max = 6000 }: { value: unknown; max?: number }): React.JSX.Element {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  s = s ?? "";
  return <pre className="sv-json">{s.slice(0, max)}{s.length > max ? "\n… truncated" : ""}</pre>;
}

/**
 * The right column. Selecting a tool call, op or event fills this instead of
 * pushing a drawer, which is what kept costing the reader their scroll
 * position and forced a refetch of /turns/:id on the way back.
 */
export function Inspector({ sel, toolCalls, opRows, timeline, onClose, onArtifact }: {
  sel: Sel;
  toolCalls: ToolCall[];
  opRows: OpRow[] | null;
  timeline: any[];
  onClose: () => void;
  /** Opening an artifact is the one drill-down still worth leaving for. */
  onArtifact?: (id: string) => void;
}): React.JSX.Element {
  if (!sel) {
    return (
      <div className="sv-insp sv-insp-empty">
        <p className="muted">Select a tool call, an action or an event to inspect its payload here.</p>
      </div>
    );
  }
  let title = "";
  let body: React.ReactNode = null;

  if (sel.kind === "tool") {
    const c = toolCalls[sel.idx];
    title = String(c?.name ?? "tool call");
    body = (
      <>
        <h5>arguments</h5>
        <JsonBlock value={c?.args ?? {}} />
        <h5>result</h5>
        {c?.resultDigest ? <JsonBlock value={c.resultDigest} /> : <p className="muted">No result captured.</p>}
      </>
    );
  } else if (sel.kind === "op") {
    const r = opRows?.[sel.idx];
    title = r?.head.title ?? "action";
    body = (
      <>
        {r?.head.detail ? <Prose dim>{r.head.detail}</Prose> : null}
        <h5>written</h5>
        <JsonBlock value={r?.op ?? {}} />
        <h5>landed effect</h5>
        {r?.fx === undefined
          ? <p className="muted">This action produces nothing observable in the event log.</p>
          : r?.fx
            ? (
              <>
                <JsonBlock value={{ seq: r.fx.seq, type: r.fx.type, at: r.fx.at, payload: r.fx.payload }} />
                {onArtifact && (r.fx.type === "artifact.created" || r.fx.type === "artifact.versioned") && r.fx.payload?.artifact?.id ? (
                  <Button variant="linklike" onClick={() => onArtifact(r.fx.payload.artifact.id)}>
                    open {r.fx.payload.artifact.name} v{r.fx.payload.artifact.version} →
                  </Button>
                ) : null}
              </>
            )
            : <p className="muted">No matching effect was recorded for this action.</p>}
      </>
    );
  } else {
    const e = timeline.find((x: any) => x.seq === sel.seq);
    title = e ? plainEvent(e.type) : `event #${sel.seq}`;
    body = e ? (
      <>
        <div className="sv-insp-meta mono">#{e.seq} · {hhmmss(e.at)}{e.actor ? ` · ${e.actor}` : ""}</div>
        {e.summary ? <Prose dim>{e.summary}</Prose> : null}
        <h5>payload</h5>
        <JsonBlock value={e.payload ?? {}} />
      </>
    ) : <p className="muted">That event is no longer in the loaded window.</p>;
  }

  return (
    <div className="sv-insp">
      <div className="sv-insp-head">
        <h4>{title}</h4>
        <Button variant="ghost" onClick={onClose} title="Clear selection">×</Button>
      </div>
      <div className="sv-insp-body">{body}</div>
    </div>
  );
}
