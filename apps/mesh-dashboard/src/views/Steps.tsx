import { useEffect, useMemo, useState } from "react";
import { ago, dur, fmt, opsSummary, outcomeOf, plainReason, refusalSummary, OUTCOME_META, type Outcome } from "../format";
import { useMesh, type TurnStep } from "../store";
import { rowKey, agentColor, AgentAvatar, Button, Card } from "../components";
import { StepDrawer } from "../drawers";

const FILTERS: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "live", label: "Working now" },
  { id: "shipped", label: "Produced" },
  { id: "quiet", label: "No output" },
  { id: "rejected", label: "Refused" },
  { id: "blocked", label: "Blocked" },
  { id: "crashed", label: "Crashed" },
];

/* ---------------- rows: a step, or a folded run of quiet steps -------- */

type Row = { kind: "step"; s: TurnStep } | { kind: "fold"; items: TurnStep[] };

function foldQuiet(list: TurnStep[], enabled: boolean): Row[] {
  if (!enabled) return list.map((s) => ({ kind: "step", s }) as Row);
  const out: Row[] = [];
  let run: TurnStep[] = [];
  for (const s of list) {
    if (outcomeOf(s) === "quiet") {
      run.push(s);
      continue;
    }
    if (run.length >= 3) out.push({ kind: "fold", items: run });
    else for (const r of run) out.push({ kind: "step", s: r });
    run = [];
    out.push({ kind: "step", s });
  }
  if (run.length >= 3) out.push({ kind: "fold", items: run });
  else for (const r of run) out.push({ kind: "step", s: r });
  return out;
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

/* ------------------------------ pulse -------------------------------- */
/* One card: what is running, what it cost, when each agent was busy, and the
   filters. Previously three stacked panels that repeated the same outcome
   legend twice and pushed the actual step list below the fold. */

function Pulse({
  steps, onPick, filter, setFilter, counts, fold, setFold, missionTokens,
}: {
  steps: TurnStep[];
  onPick: (s: TurnStep) => void;
  filter: string;
  setFilter: (v: string) => void;
  counts: Record<string, number>;
  fold: boolean;
  setFold: (v: boolean) => void;
  /** Whole-mission spend from the budget projection, or null before /status lands. */
  missionTokens: number | null;
}): React.JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  const [win, setWin] = useState<string | null>(null);
  const now = Date.now();
  const auto = useMemo(() => autoWindow(steps, Date.now()), [steps]);
  const winId = win ?? auto;

  const live = steps.filter((s) => outcomeOf(s) === "live");
  const done = steps.filter((s) => outcomeOf(s) !== "live");
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
    return { t0, t1, span, lanes, hidden: steps.length - shown.length };
    // `now` ticks every second; the lane geometry only needs to follow the data
    // and the chosen window, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, winId]);

  return (
    <Card variant={`pulse ${live.length ? "hot" : ""}`}>
      <div className="pulse-top">
        <div className="pulse-live">
          <span className={`live-dot ${live.length ? "on" : "idle"}`} />
          <span className="pulse-h">
            {live.length ? `${live.length} agent${live.length > 1 ? "s" : ""} working` : "Idle — every agent is parked on its mailbox"}
          </span>
          {live.map((s) => (
            <button
              key={s.turnId}
              className="now-chip"
              onClick={() => onPick(s)}
              title={`${s.agentId} · ${plainReason(s.reasonKind)}`}
            >
              <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} size="sm" />
              <span className="now-chip-name">{s.agentId}</span>
              <span className="now-chip-t">{dur(Date.now() - Date.parse(s.startedAt))}</span>
            </button>
          ))}
        </div>
        <div className="pulse-stats">
          <div className="nstat" title="turns that have finished"><b>{done.length}</b><span>done</span></div>
          <div
            className="nstat"
            title={
              missionTokens == null
                ? `${fmt(loadedTokens)} tokens across the ${steps.length} turns loaded here`
                : `every turn of the mission, from the budget ledger${partial ? ` — the ${steps.length} turns loaded below account for ${fmt(loadedTokens)}` : ""}`
            }
          >
            <b>{fmt(tokens)}</b><span>tokens</span>
          </div>
          <div
            className={`nstat ${wastePct >= 40 ? "warn" : ""}`}
            title={`share of the ${fmt(loadedTokens)} tokens in the ${steps.length} loaded turns that went to turns which wrote nothing${partial ? " — older turns are not counted" : ""}`}
          >
            <b>{wastePct}%</b><span>wasted{partial ? "*" : ""}</span>
          </div>
        </div>
      </div>

      {model ? (
        <div className="pulse-tl">
          <div className="pulse-tl-head">
            <span className="pulse-cap">Who was busy, when</span>
            <span className="win-picker" role="group" aria-label="timeline window">
              {WINDOWS.map((w) => (
                <button
                  key={w.id}
                  className={`win ${winId === w.id ? "on" : ""}`}
                  onClick={() => setWin(w.id)}
                  title={w.ms ? `show the last ${w.label}` : "show the whole run"}
                >
                  {w.label}
                </button>
              ))}
            </span>
          </div>
          <div className="lanes">
            {model.lanes.map((ln) => {
              const busyPct = Math.min(100, Math.round((ln.busy / model.span) * 100));
              return (
                <div className="lane" key={ln.agentId}>
                  <div className="lane-label" title={ln.agentId}>
                    <AgentAvatar id={ln.agentId} color={agentColor(ln.agentId)} size="sm" />
                    <span className="lane-name">{ln.agentId}</span>
                  </div>
                  <div className="lane-track">
                    {axisTicks(model.t0, model.t1).map((t) => (
                      <span key={t.at} className="lane-grid" style={{ left: `${t.at}%` }} />
                    ))}
                    {ln.list.map((s) => {
                      const start = Date.parse(s.startedAt);
                      const end = Date.parse(s.endedAt || new Date().toISOString());
                      const rawLeft = ((start - model.t0) / model.span) * 100;
                      const left = Math.max(0, rawLeft);
                      const w = Math.max(0.8, ((end - start) / model.span) * 100 - (left - rawLeft));
                      const oc = outcomeOf(s);
                      const dim = filter && oc !== filter;
                      return (
                        <button
                          key={s.turnId}
                          className={`lane-bar ${OUTCOME_META[oc].cls} ${dim ? "dim" : ""} ${rawLeft < 0 ? "clipped" : ""}`}
                          style={{ left: `${left}%`, width: `${Math.min(w, 100 - left)}%` }}
                          onClick={() => onPick(s)}
                          title={`${s.agentId} · ${OUTCOME_META[oc].label} · ${dur(s.durationMs)} · ${opsSummary(s)} · ${fmt(s.tokens)} tokens`}
                          aria-label={`${s.agentId} turn, ${OUTCOME_META[oc].label}, ${dur(s.durationMs)}`}
                        />
                      );
                    })}
                  </div>
                  <div className="lane-sum" title={`busy ${busyPct}% of the window · ${fmt(ln.tokens)} tokens`}>
                    <b>{busyPct}%</b>
                    <span>{fmt(ln.tokens)}</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="pulse-axis">
            {axisTicks(model.t0, model.t1).map((t) => (
              <span key={t.at} className="atick" style={{ left: `${t.at}%` }}>{t.label}</span>
            ))}
            {model.hidden ? <span className="axis-note">{model.hidden} older turn{model.hidden > 1 ? "s" : ""} outside this window</span> : null}
          </div>
        </div>
      ) : null}

      <div className="pulse-foot">
        <div className="ev-filters" role="group" aria-label="filter by outcome">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`fchip ${f.id ? OUTCOME_META[f.id as Outcome].cls : ""} ${filter === f.id ? "on" : ""}`}
              onClick={() => setFilter(filter === f.id ? "" : f.id)}
              title={f.id ? OUTCOME_META[f.id as Outcome].hint : "no filter"}
            >
              {f.id ? <i className="fdot" /> : null}
              {f.label}
              <span className="fchip-n">{f.id ? counts[f.id] || 0 : steps.length}</span>
            </button>
          ))}
        </div>
        <label className="fold-toggle">
          <input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} />
          collapse quiet turns
        </label>
      </div>
    </Card>
  );
}

/* ---------------------------- step card ------------------------------ */

function StepCard({ s, onPick }: { s: TurnStep; onPick: (s: TurnStep) => void }): React.JSX.Element {
  const oc = outcomeOf(s);
  const meta = OUTCOME_META[oc];
  const refusal = refusalSummary(s);
  const open = () => onPick(s);
  const elapsed = oc === "live" ? Date.now() - Date.parse(s.startedAt) : s.durationMs;
  const color = agentColor(s.agentId);
  return (
    <div
      className={`step-row ${meta.cls}`}
      data-turn={s.turnId}
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={rowKey(open)}
    >
      <span className="step-rail" />
      <AgentAvatar id={s.agentId} color={color} />
      <div className="step-body">
        <div className="step-top">
          <b>{s.agentId}</b>
          <span className="step-verb">{opsSummary(s)}</span>
          <span className={`otag ${meta.cls}`} title={meta.hint}>{meta.label}</span>
        </div>
        <div className="step-sub muted">
          woken by {plainReason(s.reasonKind)}
          {s.reasonNote && s.reasonNote !== s.triggerEventType ? ` — ${s.reasonNote.slice(0, 90)}` : ""}
        </div>
        {refusal ? <div className="step-refusal" title="the kernel rejected this op">kernel refused: {refusal.slice(0, 160)}</div> : null}
        {s.error ? <div className="step-err">{s.error.slice(0, 160)}</div> : null}
      </div>
      <div className="step-num">
        <b>{dur(elapsed) || "—"}</b>
        <span>{s.tokens ? `${fmt(s.tokens)} tok` : "no cost"}</span>
        <span>{ago(s.startedAt)}</span>
      </div>
    </div>
  );
}

function FoldRow({ items, onPick }: { items: TurnStep[]; onPick: (s: TurnStep) => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const tokens = items.reduce((a, s) => a + (s.tokens || 0), 0);
  const agents = [...new Set(items.map((s) => s.agentId))];
  return (
    <div className="fold">
      <button className="fold-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`fold-caret ${open ? "on" : ""}`}>▸</span>
        <b>{items.length} quiet turns</b>
        <span className="muted">
          {agents.slice(0, 4).join(", ")}
          {agents.length > 4 ? ` +${agents.length - 4}` : ""} woke up, wrote nothing
        </span>
        <span className="fold-cost">{fmt(tokens)} tok</span>
      </button>
      {open ? (
        <div className="fold-body">
          {items.map((s) => <StepCard key={s.turnId} s={s} onPick={onPick} />)}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ page --------------------------------- */

export default function Steps(): React.JSX.Element {
  const { steps, stepFilter, setStepFilter, stepSearch, setStepSearch, openDetail, refreshSteps, stepLimit, setStepLimit, status } = useMesh();
  const [fold, setFold] = useState(true);

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

  const all = steps || [];
  // Deep link rather than a bare drawer push: a step someone is debugging
  // should survive a refresh and be pasteable into a chat.
  const pick = (s: TurnStep) => openDetail("step", s.turnId);

  const q = (stepSearch || "").toLowerCase();
  const rows = all.filter(
    (s) =>
      (!stepFilter || outcomeOf(s) === stepFilter) &&
      (!q || `${s.agentId} ${plainReason(s.reasonKind)} ${s.reasonNote || ""}`.toLowerCase().includes(q)),
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of all) c[outcomeOf(s)] = (c[outcomeOf(s)] || 0) + 1;
    return c;
  }, [all]);

  const folded = foldQuiet(rows, fold && !stepFilter && !q);

  return (
    <>
      <div className="view-title">
        <h2>Steps</h2>
        <span className="page-actions">
          <label className="sr-only" htmlFor="step-search">Filter steps</label>
          <input
            className="search"
            id="step-search"
            placeholder="filter by agent or word… ( / )"
            value={stepSearch}
            onChange={(e) => setStepSearch(e.target.value)}
            style={{ minWidth: 180 }}
            aria-label="Filter steps"
          />
        </span>
      </div>
      <div className="view-sub">
        One row per agent turn, newest first. A turn is one wake-up: the agent read its inbox, thought, and either
        produced something or didn't. Click any row for its token stream, messages, files and timing.
      </div>

      <Pulse
        steps={all}
        onPick={pick}
        filter={stepFilter}
        setFilter={setStepFilter}
        counts={counts}
        fold={fold}
        setFold={setFold}
        missionTokens={missionTokens}
      />

      <div className="steps-list">
        {folded.length ? (
          folded.map((r) =>
            r.kind === "fold" ? (
              <FoldRow key={`fold-${r.items[0].turnId}`} items={r.items} onPick={pick} />
            ) : (
              <StepCard key={r.s.turnId} s={r.s} onPick={pick} />
            ),
          )
        ) : (
          <Card>
            <div className="empty">
              <div className="big">▶</div>
              <div>No steps match.</div>
              <div className="muted">Run the mission or wake an agent, then come back.</div>
            </div>
          </Card>
        )}
        {all.length >= stepLimit ? (
          <div className="row" style={{ justifyContent: "center", marginTop: 4 }}>
            <Button variant="small" onClick={() => setStepLimit(stepLimit + 60)}>Show older steps</Button>
          </div>
        ) : null}
      </div>
    </>
  );
}
