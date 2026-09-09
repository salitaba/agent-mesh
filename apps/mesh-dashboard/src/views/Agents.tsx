import { useEffect, useMemo } from "react";
import { dur, fmt, plainLifecycle, pillCls, RUNNING, HEALTH_CLS } from "../format";
import { useMesh, type TurnStep } from "../store";
import { agentColor, AgentAvatar, Card, rowKey } from "../components";
import { agentAction } from "../drawers";
import { vitalsOf } from "../vitals";
import { useTick } from "../observability";

/**
 * A card that says what the agent is doing, not merely that it exists. The
 * old card showed the lifecycle word twice and nothing else — a stalled agent
 * and a happily streaming one were pixel-identical.
 */
function AgentCard({ a, step, onWake, onOpen }: { a: any; step?: TurnStep; onWake: () => void; onOpen: () => void }): React.JSX.Element {
  const run = RUNNING.has(a.lifecycle);
  useTick(1000, run);
  const sub =
    a.lifecycle === "FAILED" ? "crashed — needs you"
    : a.lifecycle === "WAITING" ? (a.mailbox ? `${a.mailbox} unread` : "waiting")
    : run ? "working now"
    : a.lifecycle === "SUSPENDED" ? "paused by you"
    : "idle";
  const v = run && step ? vitalsOf({ phases: step.phases, clientChars: step.streamChars ?? 0, running: true, startedAt: step.startedAt }) : null;
  const elapsed = step && run ? Date.now() - Date.parse(step.startedAt) : null;
  return (
    <div className={`card agent-card${v ? ` ${HEALTH_CLS[v.health]}` : ""}`} data-agent={a.id} role="button" tabIndex={0} onClick={onOpen} onKeyDown={rowKey(onOpen)}>
      <div className="agent-head"><AgentAvatar id={a.id} color={agentColor(a.role)} />
        <div style={{ minWidth: 0 }}><b>{(a.id)}</b><div className="role">{(a.role)} · {(sub)}</div></div>
        <span className="row-actions"><button data-act="wake" data-id={a.id} title="Run one step now" onClick={(e) => { e.stopPropagation(); onWake(); }}>wake</button></span></div>
      <div className="agent-foot">
        <span className={`pill ${pillCls(a.lifecycle)}${run ? " running-pulse" : ""}`}>{(plainLifecycle(a.lifecycle))}</span>
        {v ? (
          <span className="agent-live" title={v.detail}>
            {v.label}
            {elapsed !== null ? <span className="muted"> · {dur(elapsed)}</span> : null}
            {v.chars ? <span className="muted"> · {fmt(v.chars)} chars</span> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function Agents(): React.JSX.Element {
  const { status, toast, openDetail, refreshStatus, steps, refreshSteps } = useMesh();
  const st = status;
  // Live turns are what make the cards say anything useful, and they only
  // arrive with /steps — the agent list alone has no turn timing.
  useEffect(() => {
    void refreshSteps(true);
    const iv = setInterval(() => void refreshSteps(true), 3000);
    return () => clearInterval(iv);
  }, [refreshSteps]);
  const runningByAgent = useMemo(() => {
    const m = new Map<string, TurnStep>();
    for (const s of steps || []) if (s.status === "running" && !m.has(s.agentId)) m.set(s.agentId, s);
    return m;
  }, [steps]);
  const all = (st?.agents || []).filter((a: any) => a.id !== "human");
  const attention = all.filter((a: any) => a.lifecycle === "FAILED" || a.lifecycle === "BLOCKED");
  const working = all.filter((a: any) => RUNNING.has(a.lifecycle));
  const idle = all.filter((a: any) => !RUNNING.has(a.lifecycle) && a.lifecycle !== "FAILED" && a.lifecycle !== "BLOCKED");
  const wake = (id: string) => void agentAction(id, "wake", toast, () => void refreshStatus());
  const group = (title: string, list: any[]) =>
    list.length ? (
      <>
        <h3 className="group-h">{(title)} <span className="muted">· {list.length}</span></h3>
        <div className="grid agents">{list.map((a: any) => <AgentCard key={a.id} a={a} step={runningByAgent.get(a.id)} onWake={() => wake(a.id)} onOpen={() => openDetail("agent", a.id)} />)}</div>
      </>
    ) : null;

  if (!st) return <div className="empty"><div className="big">…</div><div>loading agents</div></div>;
  return (
    <>
      <div className="view-title"><h2>Agents</h2></div>
      <div className="view-sub">Who is working, stuck, or idle. <b>Wake</b> runs one step. Click a card for details.</div>
      {group("Needs you", attention)}
      {working.length === 0 && attention.length === 0
        ? <Card><div className="empty"><div className="big">◉</div><div>Everyone is idle.</div><div className="muted">Wake someone or send a message to get going.</div></div></Card>
        : group("Working now", working)}
      {group("Idle & waiting", idle)}
      {!all.length ? <Card><div className="empty"><div className="big">◉</div><div>No agents yet.</div></div></Card> : null}
    </>
  );
}
