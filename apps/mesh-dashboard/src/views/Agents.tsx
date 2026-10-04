import { useCallback, useEffect, useMemo } from "react";
import { localTime, plainLifecycle, pillCls, zoneLabel, RUNNING } from "../format";
import { useMesh, type TurnStep } from "../store";
import { AgentAvatar, Button, EmptyState, ErrorState, PageHeader, agentColor, useNow } from "../components";
import { Icon } from "../icons";
import { agentAction, confirmPause } from "../drawers";
import { vitalsOf, type Vitals } from "../vitals";
import { planSummary, planSummaryStale } from "../plan";
import { compactNow, nowLine, timeLeftText } from "../livework";
import { FeedStatus } from "../feedstatus";
import { controlsHint, controlsOf, groupAgents, stateText, totalsText, turnsByAgent, type Control, type GroupId } from "../agents";
import "./agents.css";

/* A card says what the agent is doing, for how long, and whether it is stuck; its controls are the ones that make sense for an
   agent in that state. What it decides lives in agents.ts, which node:test covers. */

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

function AgentCard({ a, group, running, last, vitals, now, parked, loaded, onOpen, onControl }: {
  a: RosterAgent;
  group: GroupId;
  running?: TurnStep;
  last?: TurnStep;
  vitals?: Vitals;
  now: number;
  parked: boolean;
  loaded: boolean;
  onOpen: () => void;
  onControl: (a: RosterAgent, c: Control) => void;
}): React.JSX.Element {
  const run = RUNNING.has(a.lifecycle);
  const doing = run && running?.currentTool ? running.currentTool : null;
  const text = stateText(a, { running: run ? running : undefined, doing: doing ? compactNow(doing, now) : null, last, now, parked, loaded });
  const left = run && running && typeof running.deadlineAt === "number" ? timeLeftText(running.deadlineAt, now) : null;
  const stalled = vitals?.health === "stalled";
  // A quiet turn is the one failure that otherwise reads as "working", so it is said in words on the card, not only by a colour.
  const worry = run && vitals && (vitals.health === "stalled" || vitals.health === "slow") ? vitals : null;
  const plan = planSummary(a);
  const stalePlan = planSummaryStale(plan, a.taskId);
  const totals = totalsText(a);
  const controls = controlsOf(a.lifecycle);
  const at = (ms: number): string => localTime(new Date(ms).toISOString());
  return (
    // The card keeps its mouse affordance; the keyboard way in is the name, a real button, beside the controls rather than around them.
    <div className="card agent-card" data-agent={a.id} data-group={group} onClick={onOpen}>
      <div className="agent-head">
        <AgentAvatar id={a.id} color={agentColor(a.role)} />
        <div className="agent-who">
          <button type="button" className="agent-open" onClick={(e) => { e.stopPropagation(); onOpen(); }}><b>{a.id}</b></button>
          <div className="role">{a.role}</div>
        </div>
        {/* The kernel still says WORKING for a silent turn; the badge says what the vitals say, so it does not read as healthy. */}
        <span className={`pill ${stalled ? "failed" : pillCls(a.lifecycle)}${run && !stalled ? " running-pulse" : ""}`}>{stalled ? "stalled" : plainLifecycle(a.lifecycle)}</span>
      </div>

      <div className="agent-state">
        <b>{text.headline}</b>
        <span className={`agent-detail${doing ? " mono" : ""}`} title={doing ? nowLine(doing, now) : text.detail}>{text.detail}</span>
      </div>

      {worry ? (
        <p className={`agent-worry ${stalled ? "bad" : "warn"}`} title={worry.detail}>
          <Icon name="alert" size={14} />
          <span>{stalled ? "No sign of life. " : "Quiet. "}{worry.detail}</span>
        </p>
      ) : null}

      {plan || totals || left ? (
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
          {totals ? <span>{totals}</span> : null}
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

function Skeleton(): React.JSX.Element {
  return (
    <div className="ag-grid" aria-busy="true" aria-label="Loading agents">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="card agent-card ag-skel">
          <div className="agent-head"><span className="sk sk-ag-av" /><span className="sk sk-ag-name" /></div>
          <span className="sk sk-ag-l1" /><span className="sk sk-ag-l2" />
        </div>
      ))}
    </div>
  );
}

export default function Agents(): React.JSX.Element {
  const { status, toast, openDetail, refreshStatus, steps, stepsLoaded, refreshSteps, serverDown, client, confirm } = useMesh();
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
  const groups = useMemo(() => groupAgents(roster, stalled), [roster, stalled]);
  const parked = Boolean(status?.uiOnly) || status?.mode === "parked";

  const control = useCallback(async (a: RosterAgent, c: Control): Promise<void> => {
    if (c.id === "suspend" && c.asks && !(await confirmPause(confirm, a.id, true))) return;
    await agentAction(client, a.id, c.id, toast, () => void refreshStatus());
  }, [client, confirm, toast, refreshStatus]);

  const header = (
    <PageHeader
      title="Agents"
      status={<FeedStatus />}
      lede="Who is working, who is stuck, who is waiting. Run one step wakes an agent for a single turn and it goes back to waiting. Pause stops its turn and keeps it asleep until you unpause it."
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
          : <Skeleton />}
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
            <span className="ag-count">{g.agents.length}</span>
            <span className="ag-group-hint">{g.hint}</span>
          </div>
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
                parked={parked}
                loaded={stepsLoaded}
                onOpen={() => openDetail("agent", a.id)}
                onControl={(ag, c) => void control(ag, c)}
              />
            ))}
          </div>
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
