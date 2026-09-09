/* ---------------------------------------------------------------------- *
 * Observability widgets shared by the step and agent views.
 *
 * Each one answers a single question that the old UI could not:
 *   VitalsStrip   — is this running turn alive, or wedged?
 *   PhaseRail     — where did the turn's time actually go?
 *   BaselineChip  — is this number normal for this agent?
 *   CausalRail    — what woke this, and what did it wake?
 *   LiveOps       — what has the agent committed to, mid-stream?
 * ---------------------------------------------------------------------- */

import { useEffect, useState } from "react";
import { dur, fmt, plainEvent, HEALTH_CLS } from "./format";
import { PHASE_PLAIN, deviation, phaseLegs, slowestLeg, type Baseline, type OpTiming, type PhaseLeg, type TurnError, type TurnPhases, type Vitals } from "./vitals";
import type { TimelineEvent, TurnStep } from "./store";

/** Re-render on a timer so elapsed/silence counters actually tick. */
export function useTick(ms: number, on = true): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const iv = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(iv);
  }, [ms, on]);
}

/* ----------------------------- vitals strip --------------------------- */

/**
 * The live header for a running turn. Replaces "streaming · N chars", which
 * looked identical whether the model was mid-sentence or had died 40 seconds
 * earlier.
 */
export function VitalsStrip({ v, model, attempt }: { v: Vitals; model?: string; attempt?: number }): React.JSX.Element {
  useTick(1000);
  const stalled = v.health === "stalled";
  return (
    <div className={`vitals ${HEALTH_CLS[v.health]}`} role="status">
      <div className="vitals-head">
        <span className={`live-dot${v.health === "streaming" ? " on" : stalled ? " off" : ""}`} />
        <b>{v.label}</b>
        {attempt && attempt > 1 ? <span className="v-retry" title="the scheduler re-woke this agent after an earlier attempt timed out">attempt {attempt}</span> : null}
        {model ? <span className="mono muted v-model">{model}</span> : null}
      </div>
      <div className="vitals-nums">
        <Vital
          label="first token"
          value={v.ttftMs !== undefined ? dur(v.ttftMs) : "—"}
          warn={v.ttftMs !== undefined && v.ttftMs > 12000}
          hint="how long the model took to say anything after the prompt was sent"
        />
        <Vital
          label="silent for"
          value={v.silentMs !== undefined ? dur(v.silentMs) : "—"}
          warn={v.silentMs !== undefined && v.silentMs > 8000}
          bad={stalled}
          hint="time since the last token — the single best signal that a turn is wedged"
        />
        <Vital
          label="speed"
          value={v.charsPerSec ? `${Math.round(v.charsPerSec)}/s` : "—"}
          hint="characters per second across the streaming window"
        />
        <Vital label="written" value={v.chars ? fmt(v.chars) : "—"} hint="characters produced so far" />
      </div>
      <div className="vitals-detail muted">{v.detail}</div>
    </div>
  );
}

function Vital({ label, value, hint, warn, bad }: { label: string; value: string; hint: string; warn?: boolean; bad?: boolean }): React.JSX.Element {
  return (
    <div className={`vital${bad ? " bad" : warn ? " warn" : ""}`} title={hint}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}

/* ------------------------------ phase rail ---------------------------- */

const LEG_CLS: Record<string, string> = { prep: "lg-prep", wait: "lg-wait", stream: "lg-stream", ops: "lg-ops" };

/**
 * Proportional breakdown of one turn. "12s" tells you nothing; "11s waiting on
 * the model, 0.4s applying changes" tells you where to look.
 */
export function PhaseRail({ phases, running }: { phases?: TurnPhases; running: boolean }): React.JSX.Element | null {
  useTick(500, running);
  const legs = phaseLegs(phases, running);
  if (legs.length < 2) return null;
  const total = legs.reduce((a, l) => a + l.ms, 0) || 1;
  const worst = slowestLeg(legs);
  return (
    <div className="prail">
      <div className="prail-bar">
        {legs.map((l: PhaseLeg) => (
          <div
            key={l.key}
            className={`prail-seg ${LEG_CLS[l.key] ?? ""}${l.open ? " open" : ""}`}
            style={{ width: `${(l.ms / total) * 100}%` }}
            title={`${l.label} — ${dur(l.ms)} · ${l.hint}`}
          />
        ))}
      </div>
      <div className="prail-keys">
        {legs.map((l) => (
          <span key={l.key} className={`prail-key ${LEG_CLS[l.key] ?? ""}`}>
            <i />
            {l.label} <b>{dur(l.ms)}</b>
          </span>
        ))}
      </div>
      {worst && worst.ms / total > 0.6 ? (
        <div className="prail-verdict muted">
          Most of this turn was <b>{worst.label}</b> — {worst.hint}.
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------- baselines ------------------------------ */

/**
 * A number next to what is normal for the same agent. Without this every
 * duration and token count is unreadable: nobody knows if 4.2k is a lot.
 */
export function BaselineChip({ value, base, kind }: { value: number; base: Baseline; kind: "duration" | "tokens" }): React.JSX.Element | null {
  const b = kind === "duration" ? base.medianDurationMs : base.medianTokens;
  const dev = deviation(value, b, base.n);
  if (!b || base.n < 4) return null;
  const ratio = value / b;
  const word = dev === "high" ? `${ratio.toFixed(1)}× its usual` : dev === "low" ? "faster than usual" : "typical";
  return (
    <span className={`bchip ${dev}`} title={`this agent's median over ${base.n} finished turns is ${kind === "duration" ? dur(b) : `${fmt(b)} tokens`}`}>
      {word}
    </span>
  );
}

/* ----------------------------- causal rail ---------------------------- */

export interface CausalLinks {
  cause: { label: string; seq?: number; turnId?: string } | null;
  effects: Array<{ label: string; seq?: number; turnId?: string }>;
}

/**
 * Reconstruct why a turn ran and what it set off, from the causation graph
 * already carried on every event. A step in a mesh is never an isolated
 * event; reading it as one is why the old flat timeline explained nothing.
 */
export function causalLinks(turnId: string, events: TimelineEvent[], steps: TurnStep[]): CausalLinks {
  const mine = events.filter((e) => e.correlationId === turnId);
  const myIds = new Set(mine.map((e) => e.id));

  // The cause: whatever event this turn's first event was caused by, resolved
  // back to its own turn when it belongs to one.
  let cause: CausalLinks["cause"] = null;
  const root = mine.find((e) => e.causationId && !myIds.has(e.causationId));
  if (root?.causationId) {
    const parent = events.find((e) => e.id === root.causationId);
    if (parent) {
      const pTurn = parent.correlationId && String(parent.correlationId).startsWith("turn-") ? parent.correlationId : undefined;
      const pAgent = pTurn ? steps.find((s) => s.turnId === pTurn)?.agentId : undefined;
      cause = {
        label: pAgent ? `${pAgent} — ${plainEvent(parent.type)}` : plainEvent(parent.type),
        seq: parent.seq,
        turnId: pTurn,
      };
    }
  }

  // The effects: turns that started from an event this turn produced.
  const effects: CausalLinks["effects"] = [];
  const seenTurns = new Set<string>();
  for (const e of events) {
    if (!e.causationId || !myIds.has(e.causationId)) continue;
    if (e.correlationId === turnId) continue;
    const tid = e.correlationId && String(e.correlationId).startsWith("turn-") ? e.correlationId : undefined;
    if (tid) {
      if (seenTurns.has(tid)) continue;
      seenTurns.add(tid);
      const agent = steps.find((s) => s.turnId === tid)?.agentId ?? e.actorId;
      effects.push({ label: `${agent ?? "an agent"} woke up`, turnId: tid, seq: e.seq });
    } else if (effects.length < 6) {
      effects.push({ label: plainEvent(e.type), seq: e.seq });
    }
  }
  return { cause, effects: effects.slice(0, 6) };
}

export function CausalRail({ links, onTurn, onEvent }: {
  links: CausalLinks;
  onTurn: (turnId: string) => void;
  onEvent: (seq: number) => void;
}): React.JSX.Element | null {
  if (!links.cause && !links.effects.length) return null;
  const go = (l: { seq?: number; turnId?: string }) => () => {
    if (l.turnId) onTurn(l.turnId);
    else if (l.seq !== undefined) onEvent(l.seq);
  };
  return (
    <div className="causal">
      {links.cause ? (
        <div className="causal-row">
          <span className="causal-dir" title="what caused this turn to run">woken by</span>
          <button className="causal-link" onClick={go(links.cause)}>{links.cause.label}</button>
        </div>
      ) : null}
      {links.effects.length ? (
        <div className="causal-row">
          <span className="causal-dir out" title="what this turn set off downstream">set off</span>
          <span className="causal-links">
            {links.effects.map((l, i) => (
              <button key={i} className="causal-link" onClick={go(l)}>{l.label}</button>
            ))}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------- crash detail ---------------------------- */

/**
 * A crash you can act on. The old UI printed the error string and stopped, so
 * every failure meant re-running the mission with debug env vars to find out
 * where it happened. This names the phase, the error type, the wrapped cause
 * chain, and keeps the frames one click away.
 */
export function ErrorPanel({ err, fallback }: { err?: TurnError; fallback?: string }): React.JSX.Element | null {
  if (!err) return fallback ? <div className="verdict bad">{fallback}</div> : null;
  const where = err.phase ? PHASE_PLAIN[err.phase] : undefined;
  const root = err.causes?.length ? err.causes[err.causes.length - 1] : null;
  return (
    <div className="crash">
      <div className="crash-head">
        <span className="crash-kind">{err.kind}</span>
        {where ? <span className="muted">— failed {where}</span> : null}
      </div>
      <div className="crash-msg">{err.message}</div>
      {root ? (
        <div className="crash-root">
          <b>Root cause:</b> <span className="mono">{root.kind}</span> — {root.message}
        </div>
      ) : null}
      {err.causes && err.causes.length > 1 ? (
        <div className="crash-chain muted">
          {err.causes.map((c, i) => <span key={i}>{i ? " ← " : "wrapped: "}{c.kind}</span>)}
        </div>
      ) : null}
      {err.frames?.length ? (
        <details className="esc-raw">
          <summary>stack ({err.frames.length} frames)</summary>
          <pre className="crash-stack">{err.frames.join("\n")}</pre>
        </details>
      ) : (
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>No stack was attached to this throw.</div>
      )}
    </div>
  );
}

/* ---------------------------- op latency ------------------------------ */

/**
 * Which op made the ops leg slow. The phase rail can say "applying changes:
 * 4.2s"; only this says that 4.0s of it was one artifact publish.
 */
export function OpLatency({ timings }: { timings?: OpTiming[] }): React.JSX.Element | null {
  if (!timings?.length) return null;
  const total = timings.reduce((a, t) => a + t.ms, 0);
  const max = Math.max(1, ...timings.map((t) => t.ms));
  // Sub-millisecond op lists are noise: the ops leg was not the problem.
  if (total < 50 && timings.every((t) => t.ok)) return null;
  return (
    <>
      <h4>Where the apply time went <span className="muted" style={{ fontWeight: 400 }}>({dur(total)} across {timings.length} op{timings.length === 1 ? "" : "s"})</span></h4>
      <div className="oplat">
        {timings.map((t, i) => (
          <div className={`oplat-row${t.ok ? "" : " bad"}`} key={i} title={t.reason ?? (t.ok ? "accepted by the kernel" : "rejected")}>
            <span className="oplat-name mono">{t.op}</span>
            <span className="oplat-bar"><i style={{ width: `${(t.ms / max) * 100}%` }} /></span>
            <span className="oplat-ms">{dur(t.ms) || "0ms"}</span>
            {!t.ok ? <span className="oplat-x" title={t.reason}>rejected</span> : null}
          </div>
        ))}
      </div>
    </>
  );
}

/* ------------------------------ live ops ------------------------------ */

/**
 * Ops as they appear in the stream. Watching a plan assemble itself is
 * legible; watching raw tokens scroll is not.
 */
export function LiveOps({ ops, writing, heads }: {
  ops: any[];
  writing: boolean;
  heads: (o: any) => { title: string; detail: string };
}): React.JSX.Element | null {
  if (!ops.length && !writing) return null;
  return (
    <div className="live-ops">
      <div className="live-ops-h muted">
        {ops.length ? `${ops.length} op${ops.length === 1 ? "" : "s"} written so far` : "starting to write operations…"}
      </div>
      {ops.map((o, i) => {
        const h = heads(o);
        return (
          <div className="op op-live" key={i}>
            <div className="op-head"><span className="op-name">{h.title}</span><span className="op-pending" title="written by the model, not applied yet">pending</span></div>
            {h.detail ? <div className="op-detail">{h.detail}</div> : null}
          </div>
        );
      })}
      {writing ? <div className="op op-ghost"><span className="think-dots"><i /><i /><i /></span></div> : null}
    </div>
  );
}
