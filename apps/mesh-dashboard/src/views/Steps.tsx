import { useEffect, useMemo, useState } from "react";
import { ago, dur, fmt, opsSummary, outcomeOf, plainReason, OUTCOME_META, type Outcome } from "../format";
import { useMesh, type TurnStep } from "../store";
import { rowKey, agentColor, AgentAvatar, Button, Card } from "../components";
import { StepDrawer } from "../drawers";

const FILTERS: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "live", label: "Working now" },
  { id: "shipped", label: "Produced" },
  { id: "quiet", label: "No output" },
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

/* ---------------------------- now bar -------------------------------- */

function NowBar({ steps, onPick }: { steps: TurnStep[]; onPick: (s: TurnStep) => void }): React.JSX.Element {
  const live = steps.filter((s) => outcomeOf(s) === "live");
  const done = steps.filter((s) => outcomeOf(s) !== "live");
  const quiet = done.filter((s) => outcomeOf(s) === "quiet");
  const tokens = steps.reduce((a, s) => a + (s.tokens || 0), 0);
  const wasted = quiet.reduce((a, s) => a + (s.tokens || 0), 0);
  const wastePct = tokens ? Math.round((wasted / tokens) * 100) : 0;
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className={`nowbar ${live.length ? "hot" : ""}`}>
      <div className="nowbar-live">
        <div className="nowbar-h">
          {live.length ? <span className="live-dot on" /> : <span className="live-dot idle" />}
          {live.length ? `${live.length} agent${live.length > 1 ? "s" : ""} working right now` : "Nothing running — the mesh is idle"}
        </div>
        {live.length ? (
          <div className="now-chips">
            {live.map((s) => {
              const elapsed = Date.now() - Date.parse(s.startedAt);
              return (
                <button key={s.turnId} className="now-chip" onClick={() => onPick(s)} title={`${s.agentId} · ${plainReason(s.reasonKind)}`}>
                  <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} size="sm" />
                  <span className="now-chip-name">{s.agentId}</span>
                  <span className="now-chip-t">{dur(elapsed)}</span>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            Every agent finished its turn and parked on its mailbox. That is a healthy resting state, not a stall.
          </div>
        )}
      </div>
      <div className="nowbar-stats">
        <div className="nstat"><b>{done.length}</b><span>turns finished</span></div>
        <div className="nstat"><b>{fmt(tokens)}</b><span>tokens spent</span></div>
        <div className={`nstat ${wastePct >= 40 ? "warn" : ""}`}>
          <b>{wastePct}%</b><span>on turns that wrote nothing</span>
        </div>
      </div>
    </div>
  );
}

/* --------------------------- swimlanes ------------------------------- */

function Lanes({ steps, onPick }: { steps: TurnStep[]; onPick: (s: TurnStep) => void }): React.JSX.Element | null {
  const model = useMemo(() => {
    if (!steps.length) return null;
    const now = Date.now();
    const t0 = Math.min(...steps.map((s) => Date.parse(s.startedAt)));
    const t1 = Math.max(now, ...steps.map((s) => Date.parse(s.endedAt || s.startedAt)));
    const span = Math.max(1, t1 - t0);
    const byAgent = new Map<string, TurnStep[]>();
    for (const s of steps) {
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
    return { t0, span, lanes, windowMs: t1 - t0 };
  }, [steps]);

  if (!model) return null;

  return (
    <Card variant="lanes-card">
      <div className="lanes-head">
        <h3 style={{ margin: 0 }}>Who was busy, when</h3>
        <span className="muted" style={{ fontSize: 11 }}>
          left = {dur(model.windowMs)} ago · right = now · each bar is one turn, width is how long it ran
        </span>
      </div>
      <div className="lanes">
        {model.lanes.map((ln) => (
          <div className="lane" key={ln.agentId}>
            <div className="lane-label" title={`${ln.agentId} · ${fmt(ln.tokens)} tokens`}>
              <AgentAvatar id={ln.agentId} color={agentColor(ln.agentId)} size="sm" />
              <span className="lane-name">{ln.agentId}</span>
            </div>
            <div className="lane-track">
              {ln.list.map((s) => {
                const start = Date.parse(s.startedAt);
                const end = Date.parse(s.endedAt || new Date().toISOString());
                const left = ((start - model.t0) / model.span) * 100;
                const w = Math.max(0.9, ((end - start) / model.span) * 100);
                const oc = outcomeOf(s);
                return (
                  <button
                    key={s.turnId}
                    className={`lane-bar ${OUTCOME_META[oc].cls}`}
                    style={{ left: `${left}%`, width: `${Math.min(w, 100 - left)}%` }}
                    onClick={() => onPick(s)}
                    title={`${s.agentId} · ${OUTCOME_META[oc].label} · ${dur(s.durationMs)} · ${opsSummary(s)} · ${fmt(s.tokens)} tokens`}
                    aria-label={`${s.agentId} turn, ${OUTCOME_META[oc].label}, ${dur(s.durationMs)}`}
                  />
                );
              })}
            </div>
            <div className="lane-sum muted">{fmt(ln.tokens)}</div>
          </div>
        ))}
      </div>
      <div className="lane-legend">
        {(["live", "shipped", "quiet", "blocked", "crashed"] as Outcome[]).map((o) => (
          <span key={o} className="lgd"><i className={OUTCOME_META[o].cls} />{OUTCOME_META[o].label}</span>
        ))}
      </div>
    </Card>
  );
}

/* ---------------------------- step card ------------------------------ */

function StepCard({ s, onPick }: { s: TurnStep; onPick: (s: TurnStep) => void }): React.JSX.Element {
  const oc = outcomeOf(s);
  const meta = OUTCOME_META[oc];
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
  const { steps, stepFilter, setStepFilter, stepSearch, setStepSearch, openDetail, refreshSteps, stepLimit, setStepLimit } = useMesh();
  const [fold, setFold] = useState(true);

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

      <NowBar steps={all} onPick={pick} />
      <Lanes steps={all} onPick={pick} />

      <div className="steps-toolbar">
        <div className="ev-filters" role="group" aria-label="filter by outcome">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`fchip ${stepFilter === f.id ? "on" : ""}`}
              onClick={() => setStepFilter(stepFilter === f.id ? "" : f.id)}
              title={f.id ? OUTCOME_META[f.id as Outcome].hint : "no filter"}
            >
              {f.label}
              {f.id ? <span className="fchip-n">{counts[f.id] || 0}</span> : <span className="fchip-n">{all.length}</span>}
            </button>
          ))}
        </div>
        <label className="fold-toggle">
          <input type="checkbox" checked={fold} onChange={(e) => setFold(e.target.checked)} />
          collapse quiet turns
        </label>
      </div>

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
