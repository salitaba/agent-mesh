import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ago, dur, fmt, opsSummary, outcomeOf, plainReason, refusalSummary, OUTCOME_META, type Outcome } from "../format";
import { useMesh, type TurnStep } from "../store";
import { rowKey, agentColor, AgentAvatar, Button, ErrorState } from "../components";

/* The page is a ledger: one console strip on top (who is working, what the
   run has cost, who was busy when), one sticky toolbar (the outcome legend is
   the filter), and one spine of turns underneath. Everything shares the
   outcome palette in `.o-*` so a colour means the same thing everywhere. */

const OUTCOME_ORDER: Outcome[] = ["live", "shipped", "quiet", "rejected", "blocked", "crashed"];

const FILTERS: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "live", label: "Working now" },
  { id: "shipped", label: "Produced" },
  { id: "quiet", label: "No output" },
  { id: "rejected", label: "Refused" },
  { id: "blocked", label: "Blocked" },
  { id: "crashed", label: "Crashed" },
];

/* ------------------------------ clock -------------------------------- */

/** One shared ticking clock so live durations on the strip and in the ledger
    move in step instead of each row running its own interval. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(iv);
  }, [ms]);
  return now;
}

/* ------------------------------ icons -------------------------------- */
/* Drawn once, 12px, 1.5 stroke, currentColor — the ops a turn left behind. */

const ICON = {
  messages: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />
    </svg>
  ),
  artifacts: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" />
    </svg>
  ),
  tasks: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" /><path d="M5.5 8.2l1.8 1.8 3.4-3.8" />
    </svg>
  ),
  decisions: (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2l5.8 5.8L8 13.8 2.2 8z" />
    </svg>
  ),
} as const;

const OPS_LABEL: Record<keyof typeof ICON, [string, string]> = {
  messages: ["message", "messages"],
  artifacts: ["file", "files"],
  tasks: ["task", "tasks"],
  decisions: ["decision", "decisions"],
};

function OpsBadges({ s }: { s: TurnStep }): React.JSX.Element | null {
  const keys = (Object.keys(ICON) as (keyof typeof ICON)[]).filter((k) => s.ops?.[k] > 0);
  if (!keys.length) return null;
  return (
    <span className="st-ops" aria-label={opsSummary(s)}>
      {keys.map((k) => {
        const n = s.ops[k];
        return (
          <span key={k} className="st-op" title={`${n} ${OPS_LABEL[k][n === 1 ? 0 : 1]}`}>
            {ICON[k]}<span>{n}</span>
          </span>
        );
      })}
    </span>
  );
}

/* ---------------- rows: a step, or a folded run of quiet steps -------- */

type Row = { kind: "step"; s: TurnStep } | { kind: "fold"; items: TurnStep[] };

function foldQuiet(list: TurnStep[], enabled: boolean): Row[] {
  if (!enabled) return list.map((s) => ({ kind: "step", s }) as Row);
  const out: Row[] = [];
  let run: TurnStep[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "fold", items: run });
    else for (const r of run) out.push({ kind: "step", s: r });
    run = [];
  };
  for (const s of list) {
    if (outcomeOf(s) === "quiet") {
      run.push(s);
      continue;
    }
    flush();
    out.push({ kind: "step", s });
  }
  flush();
  return out;
}

/* ------------------------- time buckets ------------------------------ */
/* Newest-first is right, but 80 rows with only an "ago" column is a wall.
   Coarse recency groups give the eye somewhere to land and make the gap
   between "the mission is moving" and "that was an hour ago" visible. */

const BUCKETS: { id: string; label: string; ms: number }[] = [
  { id: "now", label: "Last 5 minutes", ms: 5 * 60_000 },
  { id: "recent", label: "5 to 30 minutes ago", ms: 30 * 60_000 },
  { id: "hour", label: "30 minutes to 2 hours ago", ms: 2 * 3_600_000 },
  { id: "day", label: "2 to 12 hours ago", ms: 12 * 3_600_000 },
  { id: "older", label: "Earlier", ms: Infinity },
];

function bucketOf(s: TurnStep, now: number): string {
  const age = now - Date.parse(s.startedAt);
  return (BUCKETS.find((b) => age < b.ms) ?? BUCKETS[BUCKETS.length - 1]).id;
}

/* ------------------------- timeline windowing ------------------------ */

const WINDOWS: { id: string; label: string; ms: number }[] = [
  { id: "5m", label: "5m", ms: 5 * 60_000 },
  { id: "30m", label: "30m", ms: 30 * 60_000 },
  { id: "2h", label: "2h", ms: 2 * 3_600_000 },
  { id: "12h", label: "12h", ms: 12 * 3_600_000 },
  { id: "all", label: "all", ms: 0 },
];

const TICK_STEPS = [
  10_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
];

/**
 * A linear time axis is honest but useless when every turn lands in the last
 * few minutes of a long run: the bars collapse into a stripe at the right edge
 * and 90% of the widget is empty. So the default window is the smallest preset
 * that still holds ~90% of the turns — full history is one click away.
 */
function autoWindow(steps: TurnStep[], now: number): string {
  if (!steps.length) return "all";
  const need = steps.length * 0.9;
  for (const w of WINDOWS) {
    if (!w.ms) break;
    const held = steps.filter((s) => Date.parse(s.endedAt || s.startedAt) >= now - w.ms).length;
    if (held >= need) return w.id;
  }
  return "all";
}

function axisTicks(t0: number, t1: number): { at: number; label: string }[] {
  const span = Math.max(1, t1 - t0);
  const step = TICK_STEPS.find((s) => span / s <= 6) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const out: { at: number; label: string }[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    const back = t1 - t;
    out.push({ at: ((t - t0) / span) * 100, label: back < step / 2 ? "now" : `-${dur(back)}` });
  }
  return out;
}

/* ----------------------------- console -------------------------------- */
/* One strip: what is running, what it cost, and who was busy when. */

function Console({
  steps, onPick, filter, setFilter, counts, missionTokens,
}: {
  steps: TurnStep[];
  onPick: (s: TurnStep) => void;
  filter: string;
  setFilter: (v: string) => void;
  counts: Record<string, number>;
  /** Whole-mission spend from the budget projection, or null before /status lands. */
  missionTokens: number | null;
}): React.JSX.Element {
  const now = useNow(1000);
  const [win, setWin] = useState<string | null>(null);
  const auto = useMemo(() => autoWindow(steps, Date.now()), [steps]);
  const winId = win ?? auto;

  const live = steps.filter((s) => outcomeOf(s) === "live");
  const done = steps.length - live.length;
  // `/steps` reconstructs turns from a log *tail*, so this sum only covers the
  // turns currently loaded — it is not the mission total. The budget
  // projection behind `/status` is, so the headline stat comes from there and
  // this window sum is kept only as the denominator of the waste ratio, which
  // has to divide by the same turns it counts.
  const loadedTokens = steps.reduce((a, s) => a + (s.tokens || 0), 0);
  const tokens = missionTokens ?? loadedTokens;
  const partial = missionTokens != null && missionTokens > loadedTokens;
  // Refused turns burn tokens and land nothing, exactly like quiet ones — they
  // are split out for the operator's benefit, not the accountant's, so both
  // still count as waste.
  const wasted = steps
    .filter((s) => { const o = outcomeOf(s); return o === "quiet" || o === "rejected"; })
    .reduce((a, s) => a + (s.tokens || 0), 0);
  const wastePct = loadedTokens ? Math.round((wasted / loadedTokens) * 100) : 0;

  const model = useMemo(() => {
    if (!steps.length) return null;
    const t1 = Math.max(now, ...steps.map((s) => Date.parse(s.endedAt || s.startedAt)));
    const chosen = WINDOWS.find((w) => w.id === winId);
    const earliest = Math.min(...steps.map((s) => Date.parse(s.startedAt)));
    const t0 = chosen && chosen.ms ? t1 - chosen.ms : earliest;
    const span = Math.max(1, t1 - t0);
    const shown = steps.filter((s) => Date.parse(s.endedAt || s.startedAt) >= t0);
    const byAgent = new Map<string, TurnStep[]>();
    for (const s of shown) {
      const a = byAgent.get(s.agentId) || [];
      a.push(s);
      byAgent.set(s.agentId, a);
    }
    const lanes = [...byAgent.entries()]
      .map(([agentId, list]) => ({
        agentId,
        list,
        busy: list.reduce((a, s) => a + (s.durationMs ?? now - Date.parse(s.startedAt)), 0),
        tokens: list.reduce((a, s) => a + (s.tokens || 0), 0),
      }))
      .sort((a, b) => b.busy - a.busy);
    return { t0, t1, span, lanes, hidden: steps.length - shown.length, ticks: axisTicks(t0, t1) };
  }, [steps, winId, now]);

  const mix = OUTCOME_ORDER.map((o) => ({ o, n: counts[o] || 0 })).filter((x) => x.n > 0);

  return (
    <section className={`st-console ${live.length ? "hot" : ""}`} aria-label="mission pulse">
      <div className="st-console-top">
        <div className="st-live">
          <span className={`st-beacon ${live.length ? "on" : ""}`} aria-hidden="true" />
          <div className="st-live-text">
            <b>{live.length ? `${live.length} agent${live.length > 1 ? "s" : ""} working` : "Idle"}</b>
            <span>{live.length ? "mid-turn right now" : "every agent is parked on its mailbox"}</span>
          </div>
          {live.map((s) => (
            <button
              key={s.turnId}
              className="st-now"
              onClick={() => onPick(s)}
              title={`${s.agentId} · woken by ${plainReason(s.reasonKind)}`}
            >
              <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} size="sm" />
              <span className="st-now-name">{s.agentId}</span>
              <span className="st-now-t">{dur(now - Date.parse(s.startedAt))}</span>
            </button>
          ))}
        </div>

        <dl className="st-stats">
          <div title="turns that have finished">
            <dt>done</dt><dd>{done}</dd>
          </div>
          <div
            title={
              missionTokens == null
                ? `${fmt(loadedTokens)} tokens across the ${steps.length} turns loaded here`
                : `every turn of the mission, from the budget ledger${partial ? ` — the ${steps.length} turns loaded below account for ${fmt(loadedTokens)}` : ""}`
            }
          >
            <dt>tokens</dt><dd>{fmt(tokens)}</dd>
          </div>
          <div
            className={wastePct >= 40 ? "warn" : ""}
            title={`share of the ${fmt(loadedTokens)} tokens in the ${steps.length} loaded turns that went to turns which wrote nothing${partial ? " — older turns are not counted" : ""}`}
          >
            <dt>wasted{partial ? "*" : ""}</dt><dd>{wastePct}%</dd>
          </div>
        </dl>
      </div>

      {mix.length ? (
        <div className="st-mix" role="group" aria-label="outcome mix — click a segment to filter">
          {mix.map(({ o, n }) => (
            <button
              key={o}
              className={`st-mix-seg ${OUTCOME_META[o].cls} ${filter && filter !== o ? "dim" : ""}`}
              style={{ flexGrow: n }}
              onClick={() => setFilter(filter === o ? "" : o)}
              title={`${n} ${OUTCOME_META[o].label} · ${Math.round((n / steps.length) * 100)}%`}
              aria-label={`${n} turns ${OUTCOME_META[o].label}`}
              aria-pressed={filter === o}
            />
          ))}
        </div>
      ) : null}

      {model ? (
        <div className="st-tl">
          <div className="st-tl-head">
            <span className="st-tl-cap">Who was busy, when</span>
            <span className="st-win" role="group" aria-label="timeline window">
              {WINDOWS.map((w) => (
                <button
                  key={w.id}
                  className={winId === w.id ? "on" : ""}
                  onClick={() => setWin(w.id)}
                  title={w.ms ? `show the last ${w.label}` : "show the whole run"}
                  aria-pressed={winId === w.id}
                >
                  {w.label}
                </button>
              ))}
            </span>
          </div>
          <div className="st-lanes">
            {model.lanes.map((ln) => {
              const busyPct = Math.min(100, Math.round((ln.busy / model.span) * 100));
              return (
                <div className="st-lane" key={ln.agentId}>
                  <div className="st-lane-label" title={ln.agentId}>
                    <AgentAvatar id={ln.agentId} color={agentColor(ln.agentId)} size="sm" />
                    <span>{ln.agentId}</span>
                  </div>
                  <div className="st-track">
                    {model.ticks.map((t) => (
                      <span key={t.at} className="st-grid" style={{ left: `${t.at}%` }} />
                    ))}
                    {ln.list.map((s) => {
                      const start = Date.parse(s.startedAt);
                      const end = s.endedAt ? Date.parse(s.endedAt) : now;
                      const rawLeft = ((start - model.t0) / model.span) * 100;
                      const left = Math.max(0, rawLeft);
                      const w = Math.max(0.8, ((end - start) / model.span) * 100 - (left - rawLeft));
                      const oc = outcomeOf(s);
                      const dim = filter && oc !== filter;
                      return (
                        <button
                          key={s.turnId}
                          className={`st-bar ${OUTCOME_META[oc].cls} ${dim ? "dim" : ""} ${rawLeft < 0 ? "clipped" : ""}`}
                          style={{ left: `${left}%`, width: `${Math.min(w, 100 - left)}%` }}
                          onClick={() => onPick(s)}
                          title={`${s.agentId} · ${OUTCOME_META[oc].label} · ${dur(s.durationMs)} · ${opsSummary(s)} · ${fmt(s.tokens)} tokens`}
                          aria-label={`${s.agentId} turn, ${OUTCOME_META[oc].label}, ${dur(s.durationMs)}`}
                        />
                      );
                    })}
                  </div>
                  <div className="st-lane-sum" title={`busy ${busyPct}% of the window · ${fmt(ln.tokens)} tokens`}>
                    <b>{busyPct}%</b>
                    <span>{fmt(ln.tokens)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="st-axis">
            {model.ticks.map((t) => (
              <span key={t.at} className={`st-tick ${t.label === "now" ? "now" : ""}`} style={{ left: `${t.at}%` }}>{t.label}</span>
            ))}
            {model.hidden ? <span className="st-axis-note">{model.hidden} older turn{model.hidden > 1 ? "s" : ""} outside this window</span> : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------ ledger ------------------------------- */

function LiveElapsed({ startedAt }: { startedAt: string }): React.JSX.Element {
  const now = useNow(1000);
  return <>{dur(now - Date.parse(startedAt)) || "—"}</>;
}

const StepRow = memo(function StepRow({ s, maxTokens, onPick }: { s: TurnStep; maxTokens: number; onPick: (s: TurnStep) => void }): React.JSX.Element {
  const oc = outcomeOf(s);
  const meta = OUTCOME_META[oc];
  const refusal = refusalSummary(s);
  const open = () => onPick(s);
  const live = oc === "live";
  const elapsed = live ? Date.now() - Date.parse(s.startedAt) : s.durationMs;
  const share = maxTokens && s.tokens ? Math.max(4, Math.round((s.tokens / maxTokens) * 100)) : 0;
  const note = s.reasonNote && s.reasonNote !== s.triggerEventType ? s.reasonNote.slice(0, 110) : "";
  return (
    <li
      className={`st-row ${meta.cls}`}
      data-turn={s.turnId}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={rowKey(open)}
      aria-label={`${s.agentId}, ${meta.label}, ${dur(elapsed) || "no duration"}, ${ago(s.startedAt)}`}
    >
      <span className="st-mark" aria-hidden="true" />
      <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} />
      <div className="st-main">
        <div className="st-l1">
          <b className="st-agent">{s.agentId}</b>
          <span className="st-verb">{oc === "live" ? (s.lifecycle ? s.lifecycle.toLowerCase().replace(/_/g, " ") : "thinking") + "…" : opsSummary(s)}</span>
          <span className="otag" title={meta.hint}>{meta.label}</span>
          {s.attempt && s.attempt > 1 ? (
            <span className="st-retry" title="the scheduler re-activated this agent after a timeout">attempt {s.attempt}</span>
          ) : null}
        </div>
        <div className="st-l2">
          <span className="st-woke">woken by {plainReason(s.reasonKind)}</span>
          {note ? <span className="st-note">{note}</span> : null}
        </div>
        {refusal ? <div className="st-refusal" title="the kernel rejected this op">kernel refused: {refusal.slice(0, 160)}</div> : null}
        {s.error ? <div className="st-err">{s.error.slice(0, 160)}</div> : null}
      </div>
      <OpsBadges s={s} />
      <div className="st-num">
        <b>{live ? <LiveElapsed startedAt={s.startedAt} /> : (dur(elapsed) || "—")}</b>
        <span className="st-tok" title={s.tokens ? `${fmt(s.tokens)} tokens — bar is relative to the costliest loaded turn` : "no tokens spent"}>
          {share ? <i style={{ width: `${share}%` }} /> : null}
          {s.tokens ? `${fmt(s.tokens)} tok` : "no cost"}
        </span>
        <span>{ago(s.startedAt)}</span>
      </div>
    </li>
  );
});

const FoldRow = memo(function FoldRow({ items, maxTokens, onPick }: { items: TurnStep[]; maxTokens: number; onPick: (s: TurnStep) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const tokens = items.reduce((a, s) => a + (s.tokens || 0), 0);
  const agents = [...new Set(items.map((s) => s.agentId))];
  return (
    <li className={`st-fold ${open ? "open" : ""}`}>
      <button className="st-fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="st-mark" aria-hidden="true" />
        <svg className="st-caret" viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M4 2.5L8 6l-4 3.5" />
        </svg>
        <b>{items.length} quiet turns</b>
        <span className="st-fold-who">
          {agents.slice(0, 4).join(", ")}
          {agents.length > 4 ? ` +${agents.length - 4}` : ""} woke up and wrote nothing
        </span>
        <span className="st-fold-cost">{fmt(tokens)} tok</span>
      </button>
      {open ? (
        <ol className="st-fold-body">
          {items.map((s) => <StepRow key={s.turnId} s={s} maxTokens={maxTokens} onPick={onPick} />)}
        </ol>
      ) : null}
    </li>
  );
});

function Skeleton(): React.JSX.Element {
  return (
    <ol className="st-list" aria-busy="true" aria-label="loading steps">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="st-row st-skel" style={{ animationDelay: `${i * 90}ms` }}>
          <span className="st-mark" /><span className="sk sk-av" />
          <div className="st-main"><span className="sk sk-l1" /><span className="sk sk-l2" /></div>
          <div className="st-num"><span className="sk sk-n" /><span className="sk sk-n2" /></div>
        </li>
      ))}
    </ol>
  );
}

function EmptyGlyph({ dashed }: { dashed?: boolean }): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 24" width="64" height="24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M2 12h60" strokeDasharray={dashed ? "3 4" : undefined} />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" opacity=".35" />
      <circle cx="32" cy="12" r="3.5" fill="currentColor" stroke="none" opacity=".6" />
      <circle cx="52" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ------------------------------ page --------------------------------- */

export default function Steps(): React.JSX.Element {
  const { steps, stepsLoaded, stepFilter, setStepFilter, stepSearch, setStepSearch, openDetail, refreshSteps, stepLimit, setStepLimit, status, serverDown } = useMesh();
  const [fold, setFold] = useState(true);
  // Buckets only move at minute scale; a 30s clock keeps the ledger out of the
  // per-second render path while live durations tick inside their own leaves.
  const now = useNow(30_000);

  // Mission-wide spend lives in the budget projection, not in the step tail.
  // `/status` is already polled every 4s by the store, so this costs nothing.
  const missionTokens = useMemo(() => {
    const agents: { tokens?: number }[] = status?.agents ?? [];
    return agents.length ? agents.reduce((a, x) => a + (x.tokens || 0), 0) : null;
  }, [status]);

  useEffect(() => {
    void refreshSteps(true);
    const iv = setInterval(() => {
      void refreshSteps(true);
    }, 3500);
    return () => clearInterval(iv);
  }, [refreshSteps]);

  const all = useMemo(() => steps ?? [], [steps]);
  // Deep link rather than a bare drawer push: a step someone is debugging
  // should survive a refresh and be pasteable into a chat.
  const pick = useCallback((s: TurnStep) => openDetail("step", s.turnId), [openDetail]);

  const q = (stepSearch || "").toLowerCase();
  const rows = useMemo(
    () => all.filter(
      (s) =>
        (!stepFilter || outcomeOf(s) === stepFilter) &&
        (!q || `${s.agentId} ${plainReason(s.reasonKind)} ${s.reasonNote || ""}`.toLowerCase().includes(q)),
    ),
    [all, stepFilter, q],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of all) c[outcomeOf(s)] = (c[outcomeOf(s)] || 0) + 1;
    return c;
  }, [all]);

  const maxTokens = useMemo(() => all.reduce((m, s) => Math.max(m, s.tokens || 0), 0), [all]);

  const folding = fold && !stepFilter && !q;
  const groups = useMemo(() => {
    const by = new Map<string, TurnStep[]>();
    for (const s of rows) {
      const b = bucketOf(s, now);
      const list = by.get(b) || [];
      list.push(s);
      by.set(b, list);
    }
    return BUCKETS.filter((b) => by.has(b.id)).map((b) => {
      const list = by.get(b.id)!;
      return { ...b, list, rows: foldQuiet(list, folding), tokens: list.reduce((a, s) => a + (s.tokens || 0), 0) };
    });
    // Re-group on data, filter and coarse-tick changes. Keying this on
    // rows.length/rows[0] reused stale TurnStep objects when a refresh kept the
    // same length and first id (in-place updates), showing old rows for up to 30s.
  }, [rows, folding, now]);

  const filtered = Boolean(stepFilter || q);

  return (
    <div className="st-page">
      <div className="view-title">
        <h2>Steps</h2>
        <span className="st-lede">one row per agent turn, newest first</span>
        <span className="page-actions">
          <label className="sr-only" htmlFor="step-search">Filter steps</label>
          <input
            className="search"
            id="step-search"
            placeholder="agent or word…  /"
            value={stepSearch}
            onChange={(e) => setStepSearch(e.target.value)}
            aria-label="Filter steps"
          />
        </span>
      </div>

      <Console
        steps={all}
        onPick={pick}
        filter={stepFilter}
        setFilter={setStepFilter}
        counts={counts}
        missionTokens={missionTokens}
      />

      <div className="st-toolbar">
        <div className="st-filters" role="group" aria-label="filter by outcome">
          {FILTERS.map((f) => {
            const n = f.id ? counts[f.id] || 0 : all.length;
            return (
              <button
                key={f.id}
                className={`st-chip ${f.id ? OUTCOME_META[f.id as Outcome].cls : ""} ${stepFilter === f.id ? "on" : ""}`}
                onClick={() => setStepFilter(stepFilter === f.id ? "" : f.id)}
                title={f.id ? OUTCOME_META[f.id as Outcome].hint : "no filter"}
                aria-pressed={stepFilter === f.id}
                disabled={Boolean(f.id) && n === 0}
              >
                {f.id ? <i className="st-chip-dot" /> : null}
                {f.label}
                <span className="st-chip-n">{n}</span>
              </button>
            );
          })}
        </div>
        <div className="st-toolbar-right">
          <span className="st-count" aria-live="polite">
            {filtered ? `${rows.length} of ${all.length}` : `${all.length} turn${all.length === 1 ? "" : "s"}`}
          </span>
          <label className={`st-fold-toggle ${filtered ? "off" : ""}`} title={filtered ? "folding is off while a filter or search is active" : "collapse runs of three or more quiet turns"}>
            <input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} disabled={filtered} />
            collapse quiet runs
          </label>
        </div>
      </div>

      {groups.length ? (
        <div className="st-ledger">
          {groups.map((g) => (
            <section key={g.id} className="st-group" aria-label={g.label}>
              <header className="st-group-head">
                <h4>{g.label}</h4>
                <span>{g.list.length} turn{g.list.length === 1 ? "" : "s"} · {fmt(g.tokens)} tok</span>
              </header>
              <ol className="st-list">
                {g.rows.map((r) =>
                  r.kind === "fold" ? (
                    <FoldRow key={`fold-${r.items[0].turnId}`} items={r.items} maxTokens={maxTokens} onPick={pick} />
                  ) : (
                    <StepRow key={r.s.turnId} s={r.s} maxTokens={maxTokens} onPick={pick} />
                  ),
                )}
              </ol>
            </section>
          ))}
          {all.length >= stepLimit ? (
            <div className="st-more">
              <Button variant="small" onClick={() => setStepLimit(stepLimit + 60)}>Load 60 older turns</Button>
            </div>
          ) : null}
        </div>
      ) : !stepsLoaded ? (
        // Before the first /steps response "No steps match" was a lie twice
        // over: nothing had been fetched, and no filter had been applied.
        <div className="st-ledger">
          {serverDown ? (
            <div className="st-empty">
              <ErrorState what="the step history" detail="the mesh server stopped answering — it may be restarting." onRetry={() => void refreshSteps(true)} />
            </div>
          ) : (
            <Skeleton />
          )}
        </div>
      ) : (
        <div className="st-ledger">
          <div className="st-empty">
            <EmptyGlyph dashed={all.length > 0} />
            <b>{all.length ? "No turns match" : "No turns yet"}</b>
            <span>{all.length ? "Clear the outcome filter or the search to see every turn." : "Run the mission or wake an agent, then come back."}</span>
            {all.length ? (
              <Button variant="small" onClick={() => { setStepFilter(""); setStepSearch(""); }}>Clear filters</Button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
