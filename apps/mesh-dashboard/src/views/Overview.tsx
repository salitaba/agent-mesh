import { useEffect, useMemo, useRef, useState } from "react";
import { zoneLabel } from "../format";
import { useMesh, type View } from "../store";
import { Button, ErrorState, EventRow, PageHeader, Pill, StepMini } from "../components";
import { ArtifactDrawer, StepDrawer } from "../drawers";
import { latestArtifactSeq } from "../files";
import { CollabCard } from "../collabcard";
import { useNameOf } from "../events";
import { useProjectsOptional } from "../projects";
import { useMission } from "../useMission";
import { useMissionActions } from "../useMissionActions";
import { useToolApprovals } from "../useToolApprovals";
import { escalationText, holdsOf } from "../escalation-card";
import { orderDecisions, toolRequestsBySeat, type LoadState } from "../inbox-model";
import type { HeroAction, MissionAction } from "../mission";
import { buildAttention, bufferIsBehind, bySeq, capacityWaits, checksSummary, heroNote, missionRead, standingBlocks, type FixTarget } from "../overview-model";
import { rightNowInput } from "../rightnow";
import { HOST_SPEND_CEILING_REASON, liveMissionVerdict, terminalMissionVerdict, verdictText } from "../../../../packages/protocol/src/catalog";
import { AttentionList } from "./AttentionList";
import { GoalChecks } from "./GoalChecks";
import { MissionHero } from "./MissionHero";
import { Panel } from "./Panel";
import { ReplayDrawer } from "./ReplayDrawer";
import { Shipped } from "./Shipped";
import "./overview.css";

/** How many of the newest events the page asks for when its buffer stops short of the log. */
const EVENT_TAIL = 150;

/** Where each fix on the attention list lives. */
const FIX_VIEW: Record<FixTarget, View> = { inbox: "escalations", tools: "gates", designer: "designer", hostsettings: "hostsettings" };

/**
 * Mission control. Two questions, in order: is it OK, and does it need me. The hero answers the first in one status, one
 * headline and one button, all read from the same mission state the top bar reads; the attention list answers the second for
 * everything the headline does not already say; a finished mission shows what it made. Under them: the latest work, the goal
 * with its checks, and what just happened.
 */
export default function Overview(): React.JSX.Element {
  const { status, events, primeEvents, steps, stepsLoaded, setSteps, setView, openDrawer, openDetail, goalId, serverDown, refreshStatus, client, sseState } = useMesh();
  const { facts, state } = useMission();
  const actions = useMissionActions();
  // Optional by design: `curule console` serves one mesh and has no project registry, so a null context means no host that
  // could have a ceiling.
  const hostSpend = useProjectsOptional()?.hostSpend ?? null;
  const tools = useToolApprovals(client, 6000, !serverDown);

  const [metrics, setMetrics] = useState<any>(null);
  const [arts, setArts] = useState<any[]>([]);
  const [artsState, setArtsState] = useState<LoadState>("loading");
  const [stepsErr, setStepsErr] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // What the page read when it opened is the mission as it was then. A mission that is started while the person watches, and
  // finishes in front of them, has to be read again: it said "No files are recorded for this goal" at the moment of delivery,
  // the one time the answer matters, until a reload. The files are read again when an artifact event arrives (a beat later, so a
  // burst of publishes is one read), and the message count while the mission runs and once more when it stops.
  const artSeq = useMemo(() => latestArtifactSeq(events), [events]);
  const goalStatus = String(status?.goal?.status ?? "");
  const running = state.pulse;

  useEffect(() => {
    let dead = false;
    // A failure from before the mission was read (a project still starting answers 409) is not this read's: while it is in flight
    // the panel says it is loading, not "Could not load recent work".
    setStepsErr(false);
    client.api("GET", "/steps?limit=6").catch(() => null).then((st) => {
      if (dead) return;
      if (Array.isArray(st?.json)) {
        setSteps(st.json);
        setStepsErr(false);
      } else {
        setStepsErr(true);
      }
    });
    return () => {
      dead = true;
    };
    // goalId is a dependency so a reset or a reopen refetches instead of showing the previous mission's.
  }, [setSteps, client, goalId, attempt]);

  const filesLoaded = useRef(false);
  useEffect(() => {
    let dead = false;
    setArtsState((s) => (s === "ready" ? s : "loading"));
    const t = setTimeout(() => {
      client.api("GET", "/artifacts").catch(() => null).then((ar) => {
        if (dead) return;
        if (Array.isArray(ar?.json)) {
          filesLoaded.current = true;
          setArts(ar.json);
          setArtsState("ready");
        } else if (!filesLoaded.current) {
          // A refresh that fails after a good read keeps the list it has; only a page that never had one reports the failure.
          setArtsState("error");
        }
      });
    }, filesLoaded.current ? 350 : 0);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [client, goalId, attempt, artSeq]);

  useEffect(() => {
    let dead = false;
    const read = (): void => {
      client.api("GET", "/metrics").catch(() => null).then((m) => {
        if (!dead && m?.json?.metrics) setMetrics(m.json.metrics);
      });
    };
    read();
    const every = running ? setInterval(read, 5000) : null;
    return () => {
      dead = true;
      if (every) clearInterval(every);
    };
    // goalStatus: the figure is read once more when the mission stops, so the page ends on the final count and not the last one it polled.
  }, [client, goalId, attempt, running, goalStatus]);

  // The page's buffer is what the stream's catch-up gave it, and for a long log that is the oldest 200 events, with a hole before
  // the live ones. The Overview reads the latest events, so it asks for them once when it finds the buffer behind the log, and reads
  // the buffer in the order it was written.
  const timeline = useMemo(() => bySeq(events), [events]);
  const nameOf = useNameOf(events);
  const behind = bufferIsBehind(timeline.length ? timeline[timeline.length - 1]!.seq : 0, status?.eventCount);
  const tailAsked = useRef(false);
  const [tailFailed, setTailFailed] = useState(false);
  useEffect(() => {
    if (!behind || tailAsked.current) return;
    tailAsked.current = true;
    client.api("GET", `/events?limit=${EVENT_TAIL}`)
      .then(({ json }) => {
        if (Array.isArray(json)) primeEvents(json);
        else setTailFailed(true);
      })
      .catch(() => setTailFailed(true));
  }, [behind, client, primeEvents]);

  const goal = status?.goal || {};
  const openEscalations: any[] | undefined = status?.openEscalations;
  const escOpen: any[] = useMemo(() => openEscalations ?? [], [openEscalations]);
  const sched = status?.scheduler || {};

  // What the log says about how the mission stopped, phrased. A halted mission reads it from the open card (the verdict is
  // computable for one tick only; the card outlives it), a finished one from the event that ended it.
  const verdict = useMemo(
    () => (state.phase === "needs-you" ? liveMissionVerdict(escOpen) : terminalMissionVerdict(timeline, String(goal.status ?? ""))),
    [state.phase, escOpen, timeline, goal.status],
  );
  const blocks = useMemo(() => standingBlocks(timeline), [timeline]);

  // Until the mission has been read, the headline says what is happening (connecting, starting, closed) and nothing is drawn under
  // it: no figure, check or failure about a mission that is not there yet. The skeleton is for a mission on its way, not a stopped one.
  if (!missionRead(status)) {
    const busy = state.phase === "loading";
    return (
      <div className="ov">
        <PageHeader title="Overview" />
        {serverDown ? (
          <ErrorState what="the overview" detail="The server stopped answering. It may be restarting." onRetry={() => void refreshStatus()} />
        ) : (
          <section className="ov-hero" aria-busy={busy || undefined} aria-label="Mission status">
            <p className="ov-headline" role="status">{state.headline}</p>
            {busy ? <div className="ov-skel" aria-hidden="true"><i className="big" /><i className="mid" /><i className="short" /></div> : null}
          </section>
        )}
      </div>
    );
  }

  const checks = checksSummary(goal.acceptanceCriteria);
  const ledger = (status.budgets || []).find((b: any) => String(b.key).startsWith("mission:") && b.limitKind === "tokens");
  const spend = hostSpend ? { usd: hostSpend.usd, ceilingUsd: hostSpend.ceilingUsd, parked: hostSpend.parked } : null;
  const delivered = goal.status === "COMPLETED";
  // The mission's own actions go where the bar sends them; the three that read a result are this page's.
  const run = (a: HeroAction): void => {
    switch (a) {
      case "files": return setView("artifacts");
      case "cost": return setView("cost");
      case "replay": return openDrawer(<ReplayDrawer goalId={goalId ?? ""} />);
      default: return actions.run(a satisfies MissionAction, { inboxView: "escalations" });
    }
  };
  const fix = (t: FixTarget): void => setView(FIX_VIEW[t]);
  const goalArts = arts.filter((a: any) => a.goalId === goal.id);
  const openArt = (art: any): void => { if (art) openDrawer(<ArtifactDrawer id={art.id} />); };
  const runningSteps = (steps || []).filter((s) => s.status === "running");
  const holding = orderDecisions(escOpen).blocking;
  const seatHolds = holding.flatMap((e) => { const h = holdsOf(e); return h.scope === "seat" ? [h.seat] : []; });
  const attention = buildAttention({
    phase: state.phase,
    parked: facts.parked,
    blockingDecisions: facts.blockingDecisions,
    ceilingCards: holding.filter((e) => e.reason === HOST_SPEND_CEILING_REASON).length,
    notices: escOpen.filter((e) => e.advisory === true).map((e) => ({ title: escalationText(e, { status, parked: facts.parked, phrase: verdictText }).title })),
    toolRequests: toolRequestsBySeat(tools.seats),
    spend: spend ? { ...spend, tripped: hostSpend?.ceilingTripped === true } : null,
    blocks,
    coveredSeats: seatHolds,
    capacity: capacityWaits(sched.waits),
    triagedAway: Number(sched.triagedAway ?? 0) || 0,
  });
  const note = heroNote({
    phase: state.phase,
    hasHistory: facts.hasHistory,
    parked: facts.parked,
    parkedNotice: typeof status.parkedNotice === "string" ? status.parkedNotice : null,
    verdict,
    blockingDecisions: facts.blockingDecisions,
    decisionTitles: holding.map((e) => escalationText(e, { status, parked: facts.parked, phrase: verdictText }).title),
    startupSeats: facts.startupSeats,
    lastBoot: status.lastBoot,
    spend,
  });
  const stale = serverDown;
  // What waits for the person, beyond the headline: what the attention list asks them to look at, and notices (which hold nothing, and are still for them).
  const forYou = attention.filter((a) => a.tone !== "info" || a.kind === "notices").length;
  const live = rightNowInput(status, { phase: state.phase, now: 0, forYou, steps: runningSteps });

  return (
    <div className="ov">
      <PageHeader title="Overview" />
      <MissionHero
        state={state}
        headline={state.headline}
        goalText={String(goal.description || "").replace(/\s*\n+\s*/g, " ").trim()}
        note={note}
        checks={checks}
        goal={goal}
        tokens={ledger ? { consumed: ledger.consumed ?? 0, limit: ledger.limit ?? 0 } : null}
        events={status.eventCount ?? 0}
        messages={typeof metrics?.messages === "number" ? metrics.messages : null}
        agents={{ working: facts.working, waiting: facts.waiting, queued: Number(sched.pending ?? 0) || 0 }}
        stale={stale}
        ticking={state.phase === "running" || state.phase === "quiet" || state.phase === "stalled"}
        live={live}
        next={state.next}
        secondary={state.secondary}
        run={run}
      />
      <AttentionList items={attention} onFix={fix} />
      {delivered ? <Shipped arts={goalArts} state={artsState} onRetry={() => setAttempt((n) => n + 1)} openArt={openArt} onOpenFiles={() => setView("artifacts")} /> : null}
      {/* Renders nothing unless a collaboration is actually open, and owns its own hooks so this component's hook count does not move. */}
      <CollabCard />
      <div className="ov-grid">
        <Panel
          id="ov-work" className="ov-work" title="Latest work"
          meta={runningSteps.length ? <Pill tone="awakened" pulse>{runningSteps.length} working now</Pill> : undefined}
          actions={<Button variant="small" onClick={() => setView("steps")}>All steps</Button>}
        >
          {stepsErr && !steps.length ? (
            <div className="ov-retry">Could not load recent work. <Button variant="small" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Try again</Button></div>
          ) : steps.length ? (
            <div className="steps-mini">
              {steps.slice(0, 5).map((s) => <StepMini key={s.turnId} s={s} onOpen={(t) => openDrawer(<StepDrawer turnId={t} steps={steps} />)} />)}
            </div>
          ) : stepsLoaded ? (
            <p className="ov-empty">No work yet.</p>
          ) : <p className="ov-empty">Loading recent work.</p>}
        </Panel>
        <GoalChecks goal={goal} arts={arts} openArt={openArt} />
        <Panel
          id="ov-events" className="ov-events" title="Just happened"
          meta={sseState === "reconnecting"
            ? "Live updates paused while reconnecting. This list may be stale."
            : behind && tailFailed ? "These are older events: the latest could not be loaded." : `Times are in ${zoneLabel()}.`}
          actions={<Button variant="small" onClick={() => setView("events")}>All events</Button>}
        >
          {/* The mini-feed hands off to the console rather than opening a drawer over the Overview: the events page is where an
              event can actually be read, and arriving there with it selected keeps the stream in view. */}
          {timeline.length ? (
            <div className="ev-list">
              {timeline.slice(-8).reverse().map((e) => <EventRow key={e.seq || e.id} e={e} nameOf={nameOf} onOpen={(s) => openDetail("event", String(s), "events")} />)}
            </div>
          ) : <p className="ov-empty">No events yet.</p>}
        </Panel>
      </div>
    </div>
  );
}
