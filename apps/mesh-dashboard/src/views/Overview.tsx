import { useEffect, useState } from "react";
import { fmt, pillCls, plainGoal, plainArtifact, artifactCls, shortUri, dur, RUNNING } from "../format";
import { useMesh } from "../store";
import { Button, Card, Chip, ErrorState, EventRow, Pill, StepMini } from "../components";
import { ArtifactDrawer, EventDrawerBySeq, StepDrawer, CloseX } from "../drawers";
import { useGoLive, useReopenMission, useResetMission } from "../actions";

export function MeshMark(): React.JSX.Element {
  return (
    <span className="mesh-mark" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="2.4" fill="var(--accent)" /><circle cx="13" cy="4.5" r="1.4" fill="var(--ok)" /><circle cx="3" cy="4.5" r="1.4" fill="var(--warn)" /><circle cx="4" cy="13" r="1.4" fill="var(--bad)" /><path d="M8 8l5-3.5M8 8 3 4.5M8 8l-4 5" stroke="var(--line-strong)" strokeWidth="1" /></svg>
    </span>
  );
}

const SHIP_STATES = new Set(["MERGED", "APPROVED", "VERIFIED", "MERGEABLE", "FINAL", "ACCEPTED", "QA_VERIFIED", "SECURITY_VERIFIED", "UNDER_REVIEW"]);

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
function Delivered({ goal, arts, artsLoaded, openArt }: { goal: any; arts: any[]; artsLoaded: boolean; openArt: (a: any) => void }): React.JSX.Element | null {
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
        {!files.length ? <div className="muted">{artsLoaded ? "No files recorded for this goal." : "loading the manifest…"}</div> : null}
      </div>
      {ws ? <div className="deliver-foot muted">Delivered into <span className="mono">{ws}</span></div> : null}
    </div>
  );
}

export default function Overview(): React.JSX.Element {
  const { status, events, steps, stepsLoaded, setSteps, setView, openDrawer, goalId, serverDown, refreshStatus, toast, client } = useMesh();
  const [metrics, setMetrics] = useState<any>(null);
  const [arts, setArts] = useState<any[]>([]);
  const [artsLoaded, setArtsLoaded] = useState(false);
  const { busy: bootBusy, goLive: doBoot } = useGoLive();
  const { busy: resetBusy, resetMission } = useResetMission();
  const { busy: reopenBusy, reopenMission } = useReopenMission();

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
      if (Array.isArray((artsRes as any).json)) {
        setArts((artsRes as any).json);
        setArtsLoaded(true);
      }
    })().catch(() => undefined);
    return () => {
      dead = true;
    };
    // goalId is in the deps so a Reset/reopen refetches the manifest instead of
    // showing the previous mission's artifacts.
  }, [setSteps, client, goalId]);

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
  const done = mandatory.filter((c: any) => c.status !== "UNSATISFIED").length;
  const mission = (st.budgets || []).find((b: any) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  const pct = mandatory.length ? Math.round((done / mandatory.length) * 100) : 0;
  const agents = (st.agents || []).filter((a: any) => a.id !== "human");
  const active = agents.filter((a: any) => RUNNING.has(a.lifecycle));
  const waiting = agents.filter((a: any) => a.lifecycle === "WAITING");
  const escOpen = st.openEscalations || [];
  const sched = st.scheduler || {};
  const runningSteps = (steps || []).filter((s: any) => s.status === "running");
  const needYou = escOpen.length > 0;
  const halted = needYou || goal.status === "PAUSED" || goal.status === "ESCALATED" || goal.status === "FAILED";
  const parked = Boolean(st.uiOnly) || st.mode === "parked";
  // A finished mission rejects every mutating op, so "send the PM a message"
  // silently does nothing until the goal is reopened — offer the reopen right
  // where the operator sees the verdict.
  const missionOver = goal.status === "COMPLETED" || goal.status === "FAILED";
  const hasHistory = (steps?.length ?? 0) > 0 || (metrics?.metrics?.messages ?? 0) > 0 || (st.eventCount ?? 0) > 15;
  const goalArts = arts.filter((a: any) => a.goalId === goal.id);
  const openArt = (art: any) => art && openDrawer(<ArtifactDrawer id={art.id} />);

  const doReplay = async () => {
    try {
      const { json } = await client.api("GET", `/goals/${encodeURIComponent(goalId ?? "")}/replay`, undefined, { timeoutMs: 60000 });
      openDrawer(
        <>
          <h2>Deterministic replay <CloseX /></h2>
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
      <div className="view-title"><h2>Overview</h2><span className={`pill ${pillCls(goal.status)}`}>{(plainGoal(goal.status))}</span><span className="page-actions"><Button variant="small" onClick={() => setView("steps")}>See what agents did</Button>{missionOver ? <Button variant="small" disabled={reopenBusy} title="Reject the result and put the agents back to work — nothing is deleted" onClick={reopenMission}>{reopenBusy ? "reopening…" : "Not good enough — reopen"}</Button> : null}<Button variant="small" danger disabled={resetBusy} title="Wipe all mission data and restart the goal from zero" onClick={resetMission}>{resetBusy ? "resetting…" : "Reset to zero"}</Button></span></div>
      <div className="view-sub">Is the mission healthy? Start here. Details live in Steps and Events.</div>
      {st.uiOnly ? (
        <div className="status-strip warn" style={{ marginBottom: 12 }}><MeshMark /><div><b>Parked.</b> <span className="muted">{hasHistory ? "Previous progress is loaded. Review, answer, add budget — then continue where it left off." : "Nothing runs on its own. Wake to run one step at a time, or start the mission to go live."} <Button variant="banner-act" data-boot disabled={bootBusy} title="Start the scheduler — agents resume work" onClick={doBoot}>continue</Button></span></div></div>
      ) : null}
      {needYou ? (
        <div className="status-strip bad" style={{ marginBottom: 12 }}><MeshMark /><div><b>{escOpen.length} decision{escOpen.length > 1 ? "s" : ""} waiting on you — mission is paused.</b> <Button variant="banner-act" onClick={() => setView("escalations")}>Review now</Button></div></div>
      ) : goal.status === "PAUSED" ? (
        <div className="status-strip warn" style={{ marginBottom: 12 }}><MeshMark /><div><b>Mission is paused. Nothing is running.</b></div></div>
      ) : goal.status === "COMPLETED" ? (
        <div className="status-strip ok" style={{ marginBottom: 12 }}><MeshMark /><div><b>Done — all mandatory checks passed.</b> <span className="muted">Here's what the mission shipped.</span> <Button variant="banner-act" onClick={doReplay}>replay</Button></div></div>
      ) : goal.status === "FAILED" ? (
        <div className="status-strip bad" style={{ marginBottom: 12 }}><MeshMark /><div><b>Failed.</b></div></div>
      ) : active.length === 0 && waiting.length === 0 && goal.status === "ACTIVE" ? (
        <div className="status-strip" style={{ marginBottom: 12 }}><MeshMark /><div>All quiet. Wake an agent or send a message to get going.</div></div>
      ) : null}
      <Delivered goal={goal} arts={goalArts} artsLoaded={artsLoaded} openArt={openArt} />
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
          <div className="ev-list">{events.length ? events.slice(-8).reverse().map((e) => <EventRow key={e.seq || e.id} e={e} onOpen={(s) => openDrawer(<EventDrawerBySeq seq={s} />)} />) : <div className="muted">Waiting for events…</div>}</div>
        </Card>
      </div>
    </div>
  );
}
