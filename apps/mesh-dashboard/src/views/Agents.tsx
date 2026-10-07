import { useCallback, useEffect, useMemo, useState } from "react";
import { fmt, localTime, plainLifecycle, pillCls, zoneLabel, RUNNING } from "../format";
import { useMesh, type TurnStep } from "../store";
import { AgentAvatar, Button, EmptyState, ErrorState, PageHeader, Pill, Progress, Segmented, Skeleton, Sparkline, agentColor, useNow } from "../components";
import { Icon } from "../icons";
import { agentAction, confirmPause } from "../drawers";
import { vitalsOf, type Vitals } from "../vitals";
import { planSummary, planSummaryStale } from "../plan";
import { compactNow, nowLine, timeLeftText } from "../livework";
import { FeedStatus } from "../feedstatus";
import { budgetTone } from "../cost";
import {
  DENSE_FROM, controlsHint, controlsOf, groupAgents, seatBudgets, stateText, turnSeries, turnsByAgent, worryText,
  type Control, type GroupId, type SeatBudget, type SeatSetting,
} from "../agents";
import { useMission } from "../useMission";
import "./agents.css";

/* A card says what the agent is doing, for how long, how heavy its turns are and whether it is stuck; its controls are the ones that
   make sense for an agent in that state. What it decides lives in agents.ts, which node:test covers. */

interface RosterAgent {
  id: string;
  role: string;
  lifecycle: string;
  mailbox?: number;
  tokens?: number;
  activations?: number;
  taskId?: string | null;
  planDone?: number | null;
  planTotal?: number;
  planTaskId?: string | null;
}

interface CardProps {
  a: RosterAgent;
  group: GroupId;
  running?: TurnStep;
  last?: TurnStep;
  vitals?: Vitals;
  now: number;
  setting: SeatSetting;
  loaded: boolean;
  series: number[];
  budget?: SeatBudget;
  onOpen: () => void;
  onControl: (a: RosterAgent, c: Control) => void;
}

/** What one seat is, shared by the card and the row: the lines of its state, whether it is in a turn, how a person may act on it. */
function readSeat({ a, running, last, vitals, now, setting, loaded }: Pick<CardProps, "a" | "running" | "last" | "vitals" | "now" | "setting" | "loaded">) {
  const run = RUNNING.has(a.lifecycle);
  const doing = run && running?.currentTool ? running.currentTool : null;
  const text = stateText(a, { running: run ? running : undefined, doing: doing ? compactNow(doing, now) : null, last, now, ...setting, loaded });
  const stalled = vitals?.health === "stalled";
  return { run, doing, text, stalled, controls: controlsOf(a.lifecycle) };
}

/** The badge: the kernel still says WORKING for a silent turn, so it says what the vitals say, and does not read as healthy. */
function SeatPill({ a, run, stalled, setting }: { a: RosterAgent; run: boolean; stalled: boolean; setting: SeatSetting }): React.JSX.Element {
  return <span className={`pill ${stalled ? "failed" : pillCls(a.lifecycle)}${run && !stalled ? " running-pulse" : ""}`}>{stalled ? "stalled" : plainLifecycle(a.lifecycle, setting)}</span>;
}

/** Its tokens beside the shape of its last turns, and against its own budget where it has one. */
function Spend({ a, series, budget }: { a: RosterAgent; series: number[]; budget?: SeatBudget }): React.JSX.Element {
  const tone = budget ? budgetTone(budget.ratio) : "ok";
  const tokens = typeof a.tokens === "number" ? a.tokens : 0;
  const turns = typeof a.activations === "number" && a.activations > 0 ? a.activations : 0;
  const of = [budget ? `of ${fmt(budget.limit)}` : "", turns ? `${turns} ${turns === 1 ? "turn" : "turns"}` : ""].filter(Boolean).join(" · ");
  return (
    <div className="agent-spend">
      <div className="agent-spend-top">
        <Sparkline values={series} width={96} height={28} label={series.length ? `Tokens in each of its last ${series.length} ${series.length === 1 ? "turn" : "turns"}` : "No turn in the loaded history"} tone={tone === "ok" ? undefined : tone} />
        <span className="agent-fig">
          {tokens > 0 ? <span><b>{fmt(tokens)}</b> tokens</span> : <span className="agent-of">No tokens spent</span>}
          {of ? <span className="agent-of">{of}</span> : null}
        </span>
      </div>
      {budget ? <Progress value={budget.used} max={budget.limit} label={`${a.id}'s own token budget`} tone={tone === "ok" ? undefined : tone} valueText={`${fmt(budget.used)} of ${fmt(budget.limit)} tokens`} /> : null}
    </div>
  );
}

function AgentCard(p: CardProps): React.JSX.Element {
  const { a, group, running, now, setting, series, budget, onOpen, onControl } = p;
  const { run, doing, text, stalled, controls } = readSeat(p);
  const left = run && running && typeof running.deadlineAt === "number" ? timeLeftText(running.deadlineAt, now) : null;
  // A quiet turn is the one failure that otherwise reads as "working", so it is said in words on the card, not only by a colour.
  const worry = run && p.vitals && (p.vitals.health === "stalled" || p.vitals.health === "slow") ? p.vitals : null;
  const plan = planSummary(a);
  const stalePlan = planSummaryStale(plan, a.taskId);
  const at = (ms: number): string => localTime(new Date(ms).toISOString());
  return (
    // The card keeps its mouse affordance; the keyboard way in is the name, a real button, beside the controls rather than around them.
    <div className="card interactive agent-card" data-agent={a.id} data-group={group} data-life={a.lifecycle} onClick={onOpen}>
      <div className="agent-head">
        <AgentAvatar id={a.id} color={agentColor(a.role)} size="lg" />
        <div className="agent-who">
          <button type="button" className="agent-open" onClick={(e) => { e.stopPropagation(); onOpen(); }}><b>{a.id}</b></button>
          <div className="role">{a.role}</div>
        </div>
        <SeatPill a={a} run={run} stalled={stalled} setting={setting} />
      </div>

      <div className="agent-state">
        <b>{text.headline}</b>
        <span className={`agent-detail${doing ? " mono" : ""}`} title={doing ? nowLine(doing, now) : text.detail}>{text.detail}</span>
      </div>

      {worry ? (
        <p className={`agent-worry ${stalled ? "bad" : "warn"}`} title={worry.detail}>
          <Icon name="alert" size={14} />
          <span>{worryText(stalled, worry.detail)}</span>
        </p>
      ) : null}

      <Spend a={a} series={series} budget={budget} />

      {plan || left ? (
        <div className="agent-meta">
          {plan ? (
            <span
              className={`chip plan-chip${stalePlan ? " warn" : ""}`}
              title={stalePlan
                ? "Its plan was written for a task it has since moved on from, so the steps no longer describe what it is doing."
                : "Its private plan for the task it is on. Other agents cannot see or claim these steps."}
            >
              plan {plan.done}/{plan.total}{plan.done === plan.total ? " done" : ""}{stalePlan ? " · stale" : ""}
            </span>
          ) : null}
          {left && running && typeof running.deadlineAt === "number" ? (
            <span
              className={running.deadlineAt - now < 60_000 ? "agent-left warn" : "agent-left"}
              title={`This turn is stopped at ${at(running.deadlineAt)} ${zoneLabel()} unless it is extended.`}
            >
              {left === "overdue" ? "past its deadline" : `${left} before it is stopped`}
            </span>
          ) : null}
        </div>
      ) : null}

      {controls.length ? (
        <div className="agent-controls">
          {controls.map((c) => (
            <Button key={c.id} variant="small" data-act={c.id} data-id={a.id} title={c.title} onClick={(e) => { e.stopPropagation(); onControl(a, c); }}>
              {c.label}
            </Button>
          ))}
        </div>
      ) : null}
      {/* Where a person has to decide, one sentence on what each button will do. Everywhere else the tooltips carry it. */}
      {group === "help" ? <p className="agent-hint">{controlsHint(a.lifecycle, stalled)}</p> : null}
    </div>
  );
}

interface RowsProps {
  rows: RosterAgent[];
  now: number;
  setting: SeatSetting;
  loaded: boolean;
  running: Map<string, TurnStep>;
  last: Map<string, TurnStep>;
  vitals: Map<string, Vitals>;
  budgets: Map<string, SeatBudget>;
  groupOf: (id: string) => GroupId;
  onOpen: (id: string) => void;
  onControl: (a: RosterAgent, c: Control) => void;
}

/** The same seats as rows, for a team too long to read as cards: the name opens it, the state is one line, the controls are at the end. */
function AgentRows(p: RowsProps): React.JSX.Element {
  return (
    <table className="tbl dense ag-table">
      <thead>
        <tr><th scope="col" className="ag-t-who">Agent</th><th scope="col" className="ag-t-state">State</th><th scope="col" className="ag-t-now">Now</th><th scope="col" className="num ag-t-tok">Tokens</th><th scope="col" className="ag-t-act"><span className="sr-only">Controls</span></th></tr>
      </thead>
      <tbody>
        {p.rows.map((a) => {
          const seat = readSeat({ a, running: p.running.get(a.id), last: p.last.get(a.id), vitals: p.vitals.get(a.id), now: p.now, setting: p.setting, loaded: p.loaded });
          const budget = p.budgets.get(a.id);
          const tone = budget ? budgetTone(budget.ratio) : "ok";
          return (
            <tr key={a.id} className="clickable" data-agent={a.id} data-group={p.groupOf(a.id)} data-life={a.lifecycle} onClick={() => p.onOpen(a.id)}>
              <td className="ag-t-who">
                <span className="ag-who">
                  <AgentAvatar id={a.id} color={agentColor(a.role)} size="sm" />
                  <span>
                    <button type="button" className="agent-open" onClick={(e) => { e.stopPropagation(); p.onOpen(a.id); }}><b>{a.id}</b></button>
                    <span className="role">{a.role}</span>
                  </span>
                </span>
              </td>
              <td className="ag-t-state"><SeatPill a={a} run={seat.run} stalled={seat.stalled} setting={p.setting} /></td>
              <td className="ag-t-now">
                <span className="agent-state"><b>{seat.text.headline}</b><span className={`agent-detail${seat.doing ? " mono" : ""}`} title={seat.text.detail}>{seat.text.detail}</span></span>
              </td>
              <td className="num ag-t-tok">
                <b>{fmt(a.tokens ?? 0)}</b>
                {budget ? <Progress value={budget.used} max={budget.limit} label={`${a.id}'s own token budget`} tone={tone === "ok" ? undefined : tone} valueText={`${fmt(budget.used)} of ${fmt(budget.limit)} tokens`} /> : null}
              </td>
              <td className="ag-t-act">
                <span className="agent-controls">
                  {seat.controls.map((c) => (
                    <Button key={c.id} variant="ghost" data-act={c.id} data-id={a.id} title={c.title} onClick={(e) => { e.stopPropagation(); p.onControl(a, c); }}>{c.label}</Button>
                  ))}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** The loading page has the shape of the loaded one: a card is an avatar and its name, the state, a drawing and a row of buttons. */
function Loading(): React.JSX.Element {
  return (
    <div className="ag-grid" role="status" aria-busy="true">
      <span className="sr-only">Loading agents</span>
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card agent-card ag-skel" aria-hidden="true">
          <div className="agent-head"><Skeleton w={40} h={40} /><div className="agent-who"><Skeleton w="45%" h={14} /></div></div>
          <Skeleton w="55%" h={14} /><Skeleton w="85%" h={12} />
          <Skeleton w="100%" h={28} />
          <div className="agent-controls"><Skeleton w={96} h={28} /><Skeleton w={64} h={28} /></div>
        </div>
      ))}
    </div>
  );
}

const MODE_KEY = "curule-agents-view";
type Mode = "cards" | "list";
const readMode = (): Mode | null => {
  try {
    const v = localStorage.getItem(MODE_KEY);
    return v === "cards" || v === "list" ? v : null;
  } catch {
    return null;
  }
};

export default function Agents(): React.JSX.Element {
  const { status, toast, openDetail, refreshStatus, steps, stepsLoaded, refreshSteps, serverDown, client, confirm } = useMesh();
  const { facts } = useMission();
  const now = useNow(1000);
  // Live turns are what make a card say anything useful, and they arrive with /steps: the roster alone has no turn timing.
  useEffect(() => {
    void refreshSteps(true);
    const iv = setInterval(() => void refreshSteps(true), 3000);
    return () => clearInterval(iv);
  }, [refreshSteps]);

  const roster: RosterAgent[] = useMemo(() => (status?.agents || []).filter((a: RosterAgent) => a.id !== "human"), [status]);
  const { running, last } = useMemo(() => turnsByAgent<TurnStep>(steps ?? []), [steps]);
  const vitals = useMemo(() => {
    const m = new Map<string, Vitals>();
    for (const [id, s] of running) {
      m.set(id, vitalsOf({ phases: s.phases, clientChars: s.streamChars ?? 0, toolFrames: s.toolFrames ?? 0, toolCallCount: s.toolCallCount, running: true, startedAt: s.startedAt, now }));
    }
    return m;
  }, [running, now]);
  const stalled = useMemo(() => new Set([...vitals].filter(([, v]) => v.health === "stalled").map(([id]) => id)), [vitals]);
  const budgets = useMemo(() => seatBudgets(status?.budgets), [status]);
  // A seat that has never run is ready on a parked team and never ran once the mission is over; the card, its badge and the group
  // heading all read this, as the Graph and the agent drawer do.
  const parked = facts.parked;
  const over = facts.goalStatus === "COMPLETED" || facts.goalStatus === "FAILED";
  const started = facts.hasHistory;
  const setting = useMemo<SeatSetting>(() => ({ parked, over, started }), [parked, over, started]);
  const groups = useMemo(() => groupAgents(roster, stalled, setting), [roster, stalled, setting]);
  const groupOf = useMemo(() => new Map(groups.flatMap((g) => g.agents.map((a) => [a.id, g.id] as const))), [groups]);

  // A team of a dozen seats or more is offered as rows; the choice is kept in this browser and is only ever a convenience.
  const dense = roster.length >= DENSE_FROM;
  const [chosen, setChosen] = useState<Mode | null>(readMode);
  const mode: Mode = dense ? chosen ?? "list" : "cards";
  const pick = (m: Mode): void => {
    setChosen(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* the choice lasts as long as the page */
    }
  };

  const control = useCallback(async (a: RosterAgent, c: Control): Promise<void> => {
    if (c.id === "suspend" && c.asks && !(await confirmPause(confirm, a.id, true))) return;
    await agentAction(client, a.id, c.id, toast, () => void refreshStatus());
  }, [client, confirm, toast, refreshStatus]);

  const header = (
    <PageHeader
      title="Agents"
      status={<FeedStatus />}
      lede="Who is working, who is stuck, who is waiting. Run one step wakes an agent for a single turn and it goes back to waiting. Pause stops its turn and keeps it asleep until you unpause it."
      actions={dense ? <Segmented label="Show agents as" value={mode} onChange={pick} options={[{ id: "cards", label: "Cards" }, { id: "list", label: "List" }]} /> : undefined}
    />
  );

  // Three states, never conflated: the status poll has not answered yet, it answered and the mesh has no agents, or the server stopped
  // answering. The old page said "Everyone is idle" for all three, an all-clear the console had not verified.
  if (!status) {
    return (
      <>
        {header}
        {serverDown
          ? <ErrorState what="the agent list" detail="The mesh server stopped answering. It may be restarting." onRetry={() => void refreshStatus()} />
          : <Loading />}
      </>
    );
  }
  return (
    <>
      {header}
      {groups.map((g) => (
        <section key={g.id} className="ag-group" aria-labelledby={`ag-g-${g.id}`}>
          <div className="ag-group-head">
            <h3 id={`ag-g-${g.id}`}>{g.title}</h3>
            <Pill tone={g.id === "help" ? "bad" : g.id === "working" ? "ok" : "neutral"} dot={false}>{g.agents.length}</Pill>
            <span className="ag-group-hint">{g.hint}</span>
          </div>
          {mode === "list" ? (
            <AgentRows
              rows={g.agents} now={now} setting={setting} loaded={stepsLoaded} running={running} last={last} vitals={vitals} budgets={budgets}
              groupOf={(id) => groupOf.get(id) ?? "idle"} onOpen={(id) => openDetail("agent", id)} onControl={(ag, c) => void control(ag, c)}
            />
          ) : (
            <div className="ag-grid">
              {g.agents.map((a) => (
                <AgentCard
                  key={a.id}
                  a={a}
                  group={g.id}
                  running={running.get(a.id)}
                  last={last.get(a.id)}
                  vitals={vitals.get(a.id)}
                  now={now}
                  setting={setting}
                  loaded={stepsLoaded}
                  series={turnSeries(steps ?? [], a.id)}
                  budget={budgets.get(a.id)}
                  onOpen={() => openDetail("agent", a.id)}
                  onControl={(ag, c) => void control(ag, c)}
                />
              ))}
            </div>
          )}
        </section>
      ))}
      {!roster.length ? (
        <EmptyState icon="agents" title="No agents in this mesh">
          The mesh answered, and this project has no agents configured. Add seats in the Designer.
        </EmptyState>
      ) : null}
    </>
  );
}
