import { useEffect, useState } from "react";
import { fmt, goalTone, plainGoal, plainArtifact, artifactCls, shortUri, dur, RUNNING, mandatoryProgress } from "../format";
import { useMesh, type TimelineEvent } from "../store";
import { Button, Card, Chip, ErrorState, EventRow, Pill, StepMini } from "../components";
import { ArtifactDrawer, StepDrawer, CloseX } from "../drawers";
import { useGoLive, useReopenMission, useResetMission } from "../actions";
import { useProjectsOptional } from "../projects";
import { CollabCard } from "../collabcard";
import { liveMissionVerdict, terminalMissionVerdict } from "../../../../packages/protocol/src/catalog";

export function MeshMark(): React.JSX.Element {
  return (
    <span className="mesh-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.4" fill="var(--accent)" /><circle cx="13" cy="4.5" r="1.4" fill="var(--ok)" /><circle cx="3" cy="4.5" r="1.4" fill="var(--warn)" /><circle cx="4" cy="13" r="1.4" fill="var(--bad)" /><path d="M8 8l5-3.5M8 8 3 4.5M8 8l-4 5" stroke="var(--line-strong)" strokeWidth="1" /></svg>
    </span>
  );
}

const SHIP_STATES = new Set(["MERGED", "APPROVED", "VERIFIED", "MERGEABLE", "FINAL", "ACCEPTED", "QA_VERIFIED", "SECURITY_VERIFIED", "UNDER_REVIEW"]);

/**
 * Policy blocks that are still standing, newest first.
 *
 * `message.rejected` has carried the policy's own sentence all along —
 * `max_activations 3 reached`, `thread budget exhausted (12/12)`, `transition
 * 'x' requires a,b; missing: b` — and nothing has ever rendered it. Two rules
 * keep this honest:
 *
 * - A refusal is reported once and re-reported only when its WORDING changes,
 *   so the newest denial for an agent is its current reason. Age proves
 *   nothing: a block that has stood quietly for ten minutes is still the
 *   reason that agent is not working, which is why this does not time-window.
 * - A block has lifted when the agent has done anything since. If the newest
 *   event naming it as actor is still its denial, it never ran.
 */
/**
 * The three concurrency ceilings, labelled the way the designer's Mesh panel
 * labels them, so "raise it" names a control the operator can actually find
 * rather than a raw config key they would have to go hunting for.
 */
const CEILING_LABEL: Record<string, string> = {
  "scheduling.concurrency.max_active_agents": "peers at once",
  "scheduling.concurrency.max_parallel_service_agents": "services at once",
  "scheduling.concurrency.max_total_agents": "total turns at once",
};

function standingBlocks(events: TimelineEvent[]): TimelineEvent[] {
  const newestByActor = new Map<string, TimelineEvent>();
  for (const e of events) {
    if (!e.actorId) continue;
    const prev = newestByActor.get(e.actorId);
    if (!prev || e.seq >= prev.seq) newestByActor.set(e.actorId, e);
  }
  return [...newestByActor.values()]
    .filter((e) => e.type === "message.rejected" && e.payload?.denied)
    .sort((a, b) => b.seq - a.seq);
}

/* strip scheme:// and everything before .mesh-state — the artifact's own path. */
function shortRef(ref: unknown): string {
  const s = String(ref || "").replace(/^file:\/\//, "");
  const i = s.indexOf("/.mesh-state/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function workspaceOf(arts: any[]): string {
  for (const a of arts) {
    const m = /^file:\/\/(.+)\/\.mesh-state\//.exec(String(a.contentRef || ""));
    if (m) return m[1];
  }
  return "";
}

/* artifact://Type/Name/1 → the artifact row it names, so evidence chips deep-link. */
function artOfUri(arts: any[], uri: unknown): any | null {
  const m = /^artifact:\/\/([^/]+)\/([^/]+)\//.exec(String(uri || ""));
  if (!m) return null;
  return arts.find((a: any) => a.type === m[1] && a.name === decodeURIComponent(m[2])) || null;
}

/* cargo manifest: everything the team produced, clickable to read. */
function Delivered({ goal, arts, artsLoaded, artsErr, onRetryArts, openArt }: { goal: any; arts: any[]; artsLoaded: boolean; artsErr: boolean; onRetryArts: () => void; openArt: (a: any) => void }): React.JSX.Element | null {
  if (goal.status !== "COMPLETED") return null;
  const mandatory = (goal.acceptanceCriteria || []).filter((c: any) => c.mandatory);
  const ran = dur(Date.parse(goal.completedAt) - Date.parse(goal.createdAt));
  const files = [...arts].sort((a, b) => Number(SHIP_STATES.has(b.status)) - Number(SHIP_STATES.has(a.status)));
  const ws = workspaceOf(arts);
  return (
    <div className="deliver">
      <div className="deliver-head">
        <div className="finish-flag">✔</div>
        <div className="deliver-title">
          <h3>Mission delivered</h3>
          <p className="muted">All {mandatory.length} mandatory checks are evidenced. Everything the team produced is in the manifest below — click any file to read it.</p>
        </div>
        <div className="deliver-stats">
          <div><small>ran for</small><b>{ran}</b></div>
          <div><small>spent</small><b>{fmt(goal.budget?.tokens ?? 0)} tokens</b></div>
          <div><small>files</small><b>{arts.length}</b></div>
        </div>
      </div>
      <div className="proof">
        {mandatory.map((c: any) => {
          const ev = c.evidence || [];
          return (
            <div key={c.id} className="proof-row">
              <span className="icon">✔</span>
              <div className="desc"><b>{c.id}</b> <span className="muted">· done</span><small>{c.description}</small></div>
              <span className="ev-chips">
                {ev.map((e: any, i: number) => {
                  const art = artOfUri(arts, e.artifactRef?.uri);
                  if (art) return <Chip key={i} title={`evidence: ${String(e.kind)} · by ${String(e.by || e.recordedAt || "")}`} onClick={() => openArt(art)}>{e.kind} · {(shortUri(e.artifactRef?.uri))}</Chip>;
                  return <Chip key={i} title={`evidence: ${String(e.kind)}`}>{e.kind}</Chip>;
                })}
              </span>
            </div>
          );
        })}
      </div>
      <div className="crate">
        {files.map((a) => (
          <button key={a.id} className="art-card" onClick={() => openArt(a)}>
            <span className={`pill ${artifactCls(a.status)}`}>{plainArtifact(a.status)}</span>
            <b>{a.name}</b>
            <span className="muted">{a.type} · v{a.version} · by {a.owner}</span>
            <span className="mono path">{shortRef(a.contentRef)}</span>
          </button>
        ))}
        {!files.length ? (
          <div className="muted">
            {artsErr ? (
              <>Could not load the manifest. <Button variant="linklike" onClick={onRetryArts}>try again</Button></>
            ) : artsLoaded ? "No files recorded for this goal." : "loading the manifest…"}
          </div>
        ) : null}
      </div>
      {ws ? <div className="deliver-foot muted">Delivered into <span className="mono">{ws}</span></div> : null}
    </div>
  );
}

export default function Overview(): React.JSX.Element {
  const { status, events, steps, stepsLoaded, setSteps, setView, openDrawer, openDetail, goalId, serverDown, refreshStatus, toast, client } = useMesh();
  const [metrics, setMetrics] = useState<any>(null);
  const [arts, setArts] = useState<any[]>([]);
  const [artsLoaded, setArtsLoaded] = useState(false);
  const [artsErr, setArtsErr] = useState(false);
  const [artsAttempt, setArtsAttempt] = useState(0);
  const { busy: bootBusy, goLive: doBoot } = useGoLive();
  const { busy: resetBusy, resetMission } = useResetMission();
  const { busy: reopenBusy, reopenMission } = useReopenMission();
  // Optional by design: `mesh console` serves a single mesh and has no project
  // registry, so a null context means "no host that could have a ceiling".
  //
  // Read here with the other hooks rather than at its point of use further
  // down, where it reads more naturally but is a hook behind the `!status`
  // early return: on the render where the server has not answered yet the
  // call is skipped, on the next one it is made, and React — which counts
  // hooks per render — throws "rendered more hooks than during the previous
  // render" and takes the whole overview down. That is the exact path an
  // operator hits when the server comes back.
  const hostSpend = useProjectsOptional()?.hostSpend ?? null;

  useEffect(() => {
    let dead = false;
    (async () => {
      const [{ json: m }, stepsRes, artsRes] = await Promise.all([
        client.api("GET", "/metrics"),
        client.api("GET", "/steps?limit=6").catch(() => ({ json: [] as unknown })),
        client.api("GET", "/artifacts").catch(() => ({ json: [] as unknown })),
      ]);
      if (dead) return;
      setMetrics(m);
      if (Array.isArray((stepsRes as any).json)) setSteps((stepsRes as any).json);
      const artsOk = Array.isArray((artsRes as any).json);
      if (artsOk) setArts((artsRes as any).json);
      setArtsLoaded(true);
      setArtsErr(!artsOk);
    })().catch(() => undefined);
    return () => {
      dead = true;
    };
    // goalId is in the deps so a Reset/reopen refetches the manifest instead of
    // showing the previous mission's artifacts.
  }, [setSteps, client, goalId, artsAttempt]);

  // A permanent "loading overview" is what an operator saw when the server was
  // down, because nothing here ever distinguished slow from gone.
  if (!status) {
    return serverDown
      ? <ErrorState what="the overview" detail="the mesh server stopped answering — it may be restarting." onRetry={() => void refreshStatus()} />
      : <div className="empty"><div className="big">…</div><div>loading overview</div></div>;
  }
  const st = status;
  const goal = st.goal || {};
  const crit = goal.acceptanceCriteria || [];
  const mandatory = crit.filter((c: any) => c.mandatory);
  const { done } = mandatoryProgress(crit);
  const mission = (st.budgets || []).find((b: any) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  const pct = mandatory.length ? Math.round((done / mandatory.length) * 100) : 0;
  const agents = (st.agents || []).filter((a: any) => a.id !== "human");
  const active = agents.filter((a: any) => RUNNING.has(a.lifecycle));
  const waiting = agents.filter((a: any) => a.lifecycle === "WAITING");
  const escOpen = st.openEscalations || [];
  const sched = st.scheduler || {};
  const runningSteps = (steps || []).filter((s: any) => s.status === "running");
  const needYou = escOpen.length > 0;
  // The mission's own verdict, phrased. `TerminationManager.evaluate` is what
  // decides it, but it is unreachable from here: the tick that sees the
  // condition escalates and flips the goal to ESCALATED, and from the next tick
  // on `evaluate` returns `continue` — the verdict is computable for exactly
  // one tick. The card that tick raised carries the reason literal and outlives
  // it, so the banner reads the card. Null for an agent-raised escalation,
  // whose reason is free prose with no phrasing behind it.
  const verdict = liveMissionVerdict(escOpen);
  // The same phrasing for a mission that is over rather than halted. A
  // different channel by necessity: the completion path raises no escalation,
  // so there is no card for the selector above to read — but it does emit
  // `goal.completed` carrying the reason, and an event is the right carrier
  // here precisely because a finished mission never needs its banner to clear.
  const finalVerdict = terminalMissionVerdict(events, goal.status);
  const halted = needYou || goal.status === "PAUSED" || goal.status === "ESCALATED" || goal.status === "FAILED";
  const parked = Boolean(st.uiOnly) || st.mode === "parked";
  // How many seats boot was asked to start. null means the server predates the
  // field — then we can only guess the cause, as before.
  const startupSeats: number | null = typeof st.startupActivateCount === "number" ? st.startupActivateCount : null;
  // The last boot's actual outcome. Reaching the console on /status rather than
  // only on the go-live response is the whole point: the response is gone by the
  // time the operator refreshes, which is when they come looking. Absent when
  // this process never booted from parked (a `mesh run` start, or a server that
  // predates the field) — then the hedged wording below is still the honest one.
  const lastBoot = st.lastBoot as
    | { at: string; activated: string[]; refused: Array<{ agentId: string; reason: string }> }
    | null
    | undefined;
  const why = (rs: Array<{ agentId: string; reason: string }>) => rs.map((r) => `${r.agentId} — ${r.reason}`).join("; ");
  const idleCause =
    startupSeats === 0
      ? "No startup agents are configured, so boot had nobody to start and the scheduler came up with an empty queue."
      : lastBoot && lastBoot.activated.length === 0 && lastBoot.refused.length > 0
        ? `Every startup agent was refused at the last boot: ${why(lastBoot.refused)}.`
        : lastBoot && lastBoot.activated.length > 0
          ? `The last boot started ${lastBoot.activated.join(", ")}${lastBoot.refused.length ? `, and was refused ${why(lastBoot.refused)}` : ""} — that work has since finished or stopped.`
          : startupSeats === null
            ? "The scheduler is running with nothing queued behind it — usually startup agents that were never configured, or that were refused at boot."
            : `The scheduler is running with nothing queued behind it — all ${startupSeats} startup agent${startupSeats === 1 ? "" : "s"} were either refused at boot or have since stopped.`;
  // A finished mission rejects every mutating op, so "send the PM a message"
  // silently does nothing until the goal is reopened — offer the reopen right
  // where the operator sees the verdict.
  const missionOver = goal.status === "COMPLETED" || goal.status === "FAILED";
  const ceilingHit = hostSpend?.ceilingTripped === true;
  const blocks = standingBlocks(events);
  const anyDeny = blocks.some((b) => b.payload?.decision === "DENY");
  // Queued agents with no slot. Deliberately NOT derived from `events` the way
  // `standingBlocks` is: a capacity block is not a refusal, so it emits no
  // `message.rejected` — and it must not, because these resolve constantly and
  // one event apiece would bury the log. Live scheduler state or nothing.
  const capacityWaits: Array<{ agentId: string; kind?: string; limit?: number; running?: number; configKey?: string }> =
    (sched.waits || []).filter((w: any) => w.kind === "capacity");
  const ceiling = capacityWaits[0];
  const ceilingLabel = ceiling?.configKey ? CEILING_LABEL[ceiling.configKey] : undefined;
  // Events a triage rule dropped this mission. Read the same way `waits` is —
  // live scheduler state, untyped on the wire — but it is not a wait: nothing
  // is queued and nothing resolves. Reads 0 unless the operator set BOTH
  // `scheduling.triage.mode: heuristic` and a non-empty `ignore_if_text_matches`,
  // so the strip below is invisible in a default mesh.
  const triagedAway: number = sched.triagedAway ?? 0;
  const hasHistory = (steps?.length ?? 0) > 0 || (metrics?.metrics?.messages ?? 0) > 0 || (st.eventCount ?? 0) > 15;
  const goalArts = arts.filter((a: any) => a.goalId === goal.id);
  const openArt = (art: any) => art && openDrawer(<ArtifactDrawer id={art.id} />);

  const doReplay = async () => {
    try {
      const { json } = await client.api("GET", `/goals/${encodeURIComponent(goalId ?? "")}/replay`, undefined, { timeoutMs: 60000 });
      openDrawer(
        <>
          <h2 id="drawer-title">Deterministic replay <CloseX /></h2>
          <p className="muted">rebuilt from {json?.eventCount ?? 0} events with zero model calls</p>
          <pre>{(JSON.stringify({ goal: json?.goal?.status, agents: json?.agents?.map((a: any) => [a.agentId, a.lifecycle]), artifacts: json?.artifacts?.length, budgets: json?.budgets }, null, 1))}</pre>
        </>,
      );
    } catch {
      toast("replay failed", "the server did not answer", "bad");
    }
  };

  return (
    <div className={halted ? "is-halted" : ""}>
      <div className="view-title"><h2>Overview</h2><span className={`pill ${goalTone(goal.status)}`}>{(plainGoal(goal.status))}</span><span className="page-actions"><Button variant="small" onClick={() => setView("steps")}>See what agents did</Button>{missionOver ? <Button variant="small" disabled={reopenBusy} title="Reject the result and put the agents back to work — nothing is deleted" onClick={reopenMission}>{reopenBusy ? "reopening…" : "Not good enough — reopen"}</Button> : null}<Button variant="small" danger disabled={resetBusy} title="Wipe all mission data and restart the goal from zero" onClick={resetMission}>{resetBusy ? "resetting…" : "Reset to zero"}</Button></span></div>
      <div className="view-sub">Is the mission healthy? Start here. Details live in Steps and Events.</div>
      {st.uiOnly ? (
        ceilingHit ? (
          // The one parked state Continue cannot fix. The host parks every
          // running project when aggregate spend crosses `spend_ceiling_usd`
          // (`applyLimits` in mesh-server/src/host.ts — named, not cited by
          // line, because the last line number here went stale in one commit)
          // and re-runs that check on each child heartbeat — so a click here
          // goes live, activates its startup seats, and is parked again
          // seconds later. Offering "continue" as the remedy is what made this
          // look like a broken button instead of a budget that ran out. The
          // ceiling has to move first.
          <div className="status-strip bad" style={{ marginBottom: 12 }}><MeshMark /><div><b>Parked — the host hit its spend ceiling.</b> <span className="muted">Total spend across open projects is ${hostSpend!.usd.toFixed(2)}{hostSpend!.ceilingUsd !== null ? ` against a ceiling of $${hostSpend!.ceilingUsd.toFixed(2)}` : ""}{hostSpend!.parked.length ? ` — parked ${hostSpend!.parked.join(", ")}` : ""}. Continuing will not hold: while the total is over, the host re-parks every open project on the next heartbeat. The ceiling is host-wide, not this mission's — raise it in the host's settings and it takes effect on the next heartbeat, no restart. Editing <code>~/.agent-mesh/host.yaml</code> by hand still needs one, because the file is read only at startup. Projects the host already parked stay parked until you reopen them.</span></div></div>
        ) : (
          <div className="status-strip warn" style={{ marginBottom: 12 }}><MeshMark /><div><b>Parked.</b> <span className="muted">{hasHistory ? "Previous progress is loaded. Review, answer, add budget — then continue where it left off." : "Nothing runs on its own. Wake to run one step at a time, or start the mission to go live."} <Button variant="banner-act" data-boot disabled={bootBusy} title="Start the scheduler — agents resume work" onClick={doBoot}>continue</Button></span></div></div>
        )
      ) : null}
      {!st.uiOnly && blocks.length > 0 ? (
        // The policy engine has always written this sentence; the scheduler
        // threw it away before anything could render it, so a seat refused by
        // `max_activations` looked exactly like a seat with nothing to do.
        // Additive rather than part of the chain below: "why is nothing
        // happening" and "the mission is paused" are different questions and
        // the operator can be owed both answers at once.
        <div className={`status-strip ${anyDeny ? "bad" : "warn"}`} style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{blocks.length === 1 ? `${blocks[0].actorId} is not being woken.` : `${blocks.length} agents are not being woken.`}</b>{" "}
          <span className="muted">
            {blocks.slice(0, 3).map((b) => `${b.actorId} — ${String(b.payload?.reason || "refused by policy")}${b.payload?.ruleId ? ` (${b.payload.ruleId})` : ""}`).join("; ")}
            {blocks.length > 3 ? `; and ${blocks.length - 3} more` : ""}.{" "}
            {anyDeny
              ? "Refused outright: these do not retry on their own, and waking one by hand is refused the same way — the named rule has to change before anything moves."
              : "Deferred, not refused: each queues itself again the moment the budget or goal it is waiting on moves. Waking one by hand will not stick while the limit still binds — raise the limit instead."}
          </span>{" "}
          <Button variant="banner-act" onClick={() => setView("designer")}>Open designer</Button>
        </div></div>
      ) : null}
      {!st.uiOnly && !parked && capacityWaits.length > 0 ? (
        // Queued, not refused — and the difference is the whole banner. These
        // clear on their own when a running turn finishes, so wording this like
        // the refusal strip above would cry wolf on a state that is usually
        // seconds old, and would send the operator off to change a limit that
        // was never the problem. Neutral grey for the same reason.
        // The remedy carries its timing because the limit is read once at boot:
        // without that clause the strip sends the operator to raise a ceiling
        // that cannot move until the next run.
        <div className="status-strip" style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{capacityWaits.length === 1 ? `${capacityWaits[0].agentId} is queued, waiting for a slot.` : `${capacityWaits.length} agents are queued, waiting for a slot.`}</b>{" "}
          <span className="muted">
            {typeof ceiling?.running === "number" && typeof ceiling?.limit === "number" ? (
              <>The mesh is running {ceiling.running} of {ceiling.limit}{ceilingLabel ? <> — <code>{ceilingLabel}</code> is the ceiling that binds</> : null}. </>
            ) : null}
            Nothing was refused and nothing is lost: each one starts on its own the moment a running turn finishes, so this normally clears within a turn. Waking one by hand will not help — an explicit wake skips a parked scheduler, not a full one.{" "}
            {ceilingLabel
              ? <>Raise <code>{ceilingLabel}</code> in the designer's Mesh panel if these should run in parallel instead</>
              : <>Raise the concurrency limits in the designer's Mesh panel if these should run in parallel instead</>}
            {" "}— but <code>scheduling.*</code> edits apply on the next mesh boot, so raising it will not release the agents queued right now.
          </span>
        </div></div>
      ) : null}
      {needYou ? (
        // The count alone said *that* the mission stopped and never *why*: a run
        // killed by its wall-clock limit rendered as "1 decision waiting on
        // you", and the operator had to open the escalations view to find the
        // sentence the catalog has had phrased all along. The verdict leads now;
        // the count keeps its place in the detail line, where it still earns one
        // once there is more than a single card. Agent-raised escalations have
        // no phrasing, so those keep the original wording exactly.
        <div className="status-strip bad" style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{verdict ? `${verdict.title}.` : `${escOpen.length} decision${escOpen.length > 1 ? "s" : ""} waiting on you — mission is paused.`}</b>{" "}
          {verdict ? (
            <span className="muted">
              {verdict.summary} This is the mission's own stopping condition, not a quiet patch: it will not clear on its own, and the mission stays parked until it is answered.{escOpen.length > 1 ? ` ${escOpen.length} decisions are waiting in total.` : ""}{" "}
            </span>
          ) : null}
          <Button variant="banner-act" onClick={() => setView("escalations")}>Review now</Button>
        </div></div>
      ) : goal.status === "PAUSED" ? (
        // Wired to the selector for shape, and it will stay on the fallback
        // until a pause carries a real reason: the one `goal.paused` emitter
        // sends `"user pause"`, free prose with no phrasing behind it, which is
        // the right thing for the catalog guard to refuse.
        <div className="status-strip warn" style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{finalVerdict ? `${finalVerdict.title}.` : "Mission is paused. Nothing is running."}</b>
          {finalVerdict ? <> <span className="muted">{finalVerdict.summary}</span></> : null}
        </div></div>
      ) : goal.status === "COMPLETED" ? (
        // "all mandatory checks passed" was the code's summary of the verdict,
        // not the verdict itself, and it dropped the two conditions completion
        // actually also requires — no open escalations, and no work still
        // claimed. Those are in the phrased summary, which is the sentence an
        // operator needs to trust a green banner. The counts stay in the KPI
        // row below and the remedy stays on the reopen button in the title, so
        // this says what happened and leaves both where they already were.
        <div className="status-strip ok" style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{finalVerdict ? `${finalVerdict.title}.` : "Done — all mandatory checks passed."}</b>{" "}
          <span className="muted">{finalVerdict ? `${finalVerdict.summary} ` : ""}Here's what the mission shipped.</span>{" "}
          <Button variant="banner-act" onClick={doReplay}>replay</Button>
        </div></div>
      ) : goal.status === "FAILED" ? (
        // Also fallback-only today, and for a sharper reason than the pause:
        // `{ kind: "fail" }` is a declared verdict arm that nothing in
        // `termination.ts` constructs, so the `goal.failed` emit it guards is
        // unreachable. Wired anyway — the day a producer lands, the phrasing is
        // already on the wire and this needs no second visit.
        <div className="status-strip bad" style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{finalVerdict ? `${finalVerdict.title}.` : "Failed."}</b>
          {finalVerdict ? <> <span className="muted">{finalVerdict.summary}</span></> : null}
        </div></div>
      ) : !parked && active.length === 0 && runningSteps.length === 0 && goal.status === "ACTIVE" ? (
        // One neutral-grey "All quiet" used to cover this, and only when nothing
        // was WAITING either — so the state an operator actually gets stuck in
        // (scheduler live, no seat ever queued, because startup activation was
        // empty or refused at boot) rendered as a routine lull, or, with anyone
        // waiting, as no banner at all. A live mission with nobody working is
        // never routine: say which of the two it is and what unblocks it.
        waiting.length === 0 ? (
          <div className="status-strip warn" style={{ marginBottom: 12 }}><MeshMark /><div><b>Live, but no agent is working.</b> <span className="muted">{idleCause} {startupSeats === 0 ? "Wake an agent now, or say who should start next time." : "Wake an agent to get going."}</span>{startupSeats === 0 ? <> <Button variant="banner-act" onClick={() => setView("designer")}>Set startup agents</Button></> : null}</div></div>
        ) : (
          <div className="status-strip" style={{ marginBottom: 12 }}><MeshMark /><div><b>All quiet.</b> <span className="muted">{waiting.length} agent{waiting.length > 1 ? "s" : ""} waiting, none working right now. Wake one or send a message to get going.</span></div></div>
        )
      ) : null}
      {!st.uiOnly && triagedAway > 0 ? (
        // Silent loss, not a block — which is why this sits BELOW the whole
        // banner chain rather than inside it, and why it is neutral grey. A
        // triage drop refuses nothing, queues nothing and waits for nothing, so
        // a mesh that filtered 40 events may be in perfect health; wording it
        // like a halt would cry wolf on the operator's own working config.
        // But it never clears either — unlike a capacity wait, the event is
        // gone. Permanent yet not blocking is a third state, so neither the
        // "clears within a turn" strip above nor the verdict banners fit it.
        // Polled, never emitted: one event per drop would bury the log exactly
        // as a capacity block would have.
        <div className="status-strip" style={{ marginBottom: 12 }}><MeshMark /><div>
          <b>{triagedAway === 1 ? "1 event was triaged away — no agent saw it." : `${triagedAway} events were triaged away — no agent saw them.`}</b>{" "}
          <span className="muted">
            Nothing is blocked and nothing is waiting: a triage rule matched {triagedAway === 1 ? "it" : "them"} and dropped {triagedAway === 1 ? "it" : "them"} before anything was queued. {triagedAway === 1 ? "It" : "They"} will not be retried, so an agent that looks idle may simply never have been told. Loosen or remove the rule under Triage in the designer's Mesh panel — <code>scheduling.*</code> edits apply on the next mesh boot, not to this run.
          </span>
        </div></div>
      ) : null}
      <Delivered goal={goal} arts={goalArts} artsLoaded={artsLoaded} artsErr={artsErr} onRetryArts={() => setArtsAttempt((n) => n + 1)} openArt={openArt} />
      <div className="grid kpis">
        <Card variant="kpi"><small>Goal progress</small><b>{pct}%</b><div className="progress"><div style={{ transform: `scaleX(${pct / 100})` }} /></div><div className="delta">{done} of {mandatory.length} checks done</div></Card>
        <Card variant="kpi"><small>Working now</small><b>{active.length}</b><div className="delta">{waiting.length} waiting · {sched.pending ?? 0} queued</div></Card>
        <Card variant="kpi"><small>Spent</small><b>{fmt(mission?.consumed ?? 0)}<span className="muted" style={{ fontSize: 13 }}>/{fmt(mission?.limit ?? 0)}</span></b><div className="delta">{metrics?.metrics?.messages ?? 0} messages · {st.eventCount} events</div></Card>
      </div>
      <Card
        style={{ marginTop: 12 }}
        title={<>Latest work {runningSteps.length ? <Pill tone="awakened" pulse>{runningSteps.length} working now</Pill> : null}</>}
        actions={<Button variant="small" onClick={() => setView("steps")}>All steps</Button>}
      >
        <div className="steps-mini">{(steps || []).length ? (steps || []).slice(0, 5).map((s: any) => <StepMini key={s.turnId} s={s} onOpen={(t) => openDrawer(<StepDrawer turnId={t} steps={steps} />)} />) : stepsLoaded ? <div className="muted">No work yet — wake an agent or start the mission.</div> : <div className="muted">loading recent work…</div>}</div>
      </Card>
      {/* Renders nothing unless a collaboration is actually open, and owns its
          own hooks so this component's hook count does not move. */}
      <CollabCard />
      <div className="grid two" style={{ marginTop: 12 }}>
        <Card title="Goal">
          <p style={{ margin: "0 0 10px", maxWidth: "70ch" }}>{((goal.description || "").replace(/\n+/g, " "))}</p>
          <div>{crit.length ? crit.map((c: any) => (
            // ASSERTED must read differently from both "done" and "to do": an
            // agent claimed it without checking anything, and the operator is
            // the one who needs to know that a claim is standing unproven.
            <div key={c.id} className={`crit ${c.status}`}><span className="icon">{c.status === "EVIDENCED" ? "✔" : c.status === "WAIVED" ? "◌" : c.status === "ASSERTED" ? "!" : "○"}</span><div className="desc"><b>{(c.id)}</b> <span className="muted">· {c.status === "EVIDENCED" ? "done" : c.status === "WAIVED" ? "skipped" : c.status === "ASSERTED" ? "claimed, not verified" : "to do"}</span>{c.mandatory ? null : <Chip>optional</Chip>}<small>{(c.description)}</small></div></div>
          )) : <div className="muted">no checks declared</div>}</div>
        </Card>
        <Card title="Just happened" actions={<Button variant="small" onClick={() => setView("events")}>All events</Button>}>
          {/* The mini-feed hands off to the console rather than opening a drawer
              over the Overview: the events page is where an event can actually be
              read, and arriving there with it selected keeps the stream in view. */}
          <div className="ev-list">{events.length ? events.slice(-8).reverse().map((e) => <EventRow key={e.seq || e.id} e={e} onOpen={(s) => openDetail("event", String(s), "events")} />) : <div className="muted">Waiting for events…</div>}</div>
        </Card>
      </div>
    </div>
  );
}
