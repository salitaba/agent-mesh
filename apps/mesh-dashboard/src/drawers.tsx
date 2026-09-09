import { useEffect, useRef, useState } from "react";
import { api, getText, post } from "./api";
import { ago, dur, fmt, hhmmss, outcomeOf, pillCls, plainArtifact, plainEvent, plainLifecycle, plainReason, MESSAGE_PLAIN, RUNNING } from "./format";
import { evClass, evSummary } from "./events";
import { useMesh, type TimelineEvent, type TurnStep } from "./store";
import { EventRow, StatusPill, LifecyclePill, StepMini, OutcomePill, rowKey, AgentAvatar, Button, Chip, Input, Pill, Select, TextArea } from "./components";
import { baselineOf, parsePartialOps, vitalsOf, type TurnPhases } from "./vitals";
import { BaselineChip, CausalRail, ErrorPanel, LiveOps, OpLatency, PhaseRail, VitalsStrip, causalLinks, useTick } from "./observability";

export function CloseX(): React.JSX.Element {
  const { closeDrawer } = useMesh();
  return <button className="close-x" onClick={closeDrawer}>×</button>;
}

export async function agentAction(id: string, act: string, toast: (t: string, m: string, k?: string) => void, after?: () => void): Promise<void> {
  const { status, json } = await post(`/agents/${encodeURIComponent(id)}/${act}`);
  if (status === 200) toast(act, `${id}: ok`, "ok");
  else toast(`${act} blocked`, `${id}: ${json?.reason ?? "denied"}`, "warn");
  if (after) setTimeout(after, 400);
}

function agentsToWake(agents: any[]): string[] {
  return (agents || []).filter((a: any) => a.id !== "human" && ["WAITING", "SUSPENDED", "IDLE"].includes(a.lifecycle)).map((a: any) => a.id).slice(0, 4);
}

export function MessageDrawer(): React.JSX.Element {
  const { status, vocab, toast, refreshStatus, closeDrawer } = useMesh();
  const ids = (status?.agents || []).filter((a: any) => a.id !== "human").map((a: any) => a.id);
  const parked = Boolean(status?.uiOnly) || status?.mode === "parked";
  const [to, setTo] = useState("");
  const [type, setType] = useState("INFORM");
  const [note, setNote] = useState("");
  const [payload, setPayload] = useState('{ "note": "" }');
  const [advanced, setAdvanced] = useState(false);
  const [wake, setWake] = useState(parked);
  const [out, setOut] = useState("");
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    let body: unknown;
    if (advanced) {
      try {
        body = JSON.parse(payload || "{}");
      } catch {
        setOut("That doesn't look like valid JSON.");
        return;
      }
    } else {
      body = { note };
    }
    const recipients = to.split(",").map((s) => s.trim()).filter(Boolean);
    const { status: st, json } = await post("/messages", { to: recipients, type, payload: body, wake });
    setOut(st === 202 ? "Sent." : `Couldn't send: ${json?.reason ?? st}`);
    if (st === 202) toast("Sent", `to ${recipients.join(", ")}`, "ok");
    void refreshStatus();
  };
  return (
    <>
      <h2>Message an agent <CloseX /></h2>
      <p className="muted" style={{ marginTop: 0 }}>You speak as <b>human</b> — agents always listen. {parked ? <>Currently <b>parked</b>: tick <i>run them right after</i> so they act immediately.</> : null}</p>
      <form className="stack" onSubmit={submit}>
        <div className="field"><label htmlFor="send-to">To</label><input id="send-to" list="send-to-list" placeholder="pick an agent…" required autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} /><datalist id="send-to-list">{ids.map((i: string) => <option key={i}>{i}</option>)}</datalist></div>
        <div className="field"><label htmlFor="send-type">What is this?</label><Select id="send-type" value={type} onChange={(e) => setType(e.target.value)}>{(vocab?.messageTypes || ["INFORM", "MISSION", "REQUEST", "REQUEST_REVIEW", "ESCALATE", "DONE"]).map((t: string) => <option key={t} value={t}>{MESSAGE_PLAIN[t] || t.toLowerCase()} ({t})</option>)}</Select></div>
        {advanced ? (
          <div className="field"><label htmlFor="send-payload">Message (JSON)</label><TextArea id="send-payload" rows={4} spellCheck={false} value={payload} onChange={(e) => setPayload(e.target.value)} /></div>
        ) : (
          <div className="field"><label htmlFor="send-note">Message</label><TextArea id="send-note" rows={4} placeholder="Say it in plain words…" required value={note} onChange={(e) => setNote(e.target.value)} /></div>
        )}
        <div className="row"><label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> send a raw JSON payload</label></div>
        <div className="row"><label className="muted" style={{ display: "flex", gap: 6, alignItems: "center" }}><input type="checkbox" checked={wake} onChange={(e) => setWake(e.target.checked)} /> run them right after sending</label></div>
        <div className="row"><Button variant="primary" type="submit">send</Button><span className="muted">{out}</span></div>
      </form>
    </>
  );
}

export function ApprovalDrawer(): React.JSX.Element {
  const { status, toast, refreshStatus } = useMesh();
  const subjects = ["architecture", "implementation", "quality", "security", "requirements", "release"];
  const [arts, setArts] = useState<any[]>([]);
  const [kind, setKind] = useState("approve");
  const [subject, setSubject] = useState("");
  const [comment, setComment] = useState("");
  const [out, setOut] = useState("");
  useEffect(() => {
    api("GET", "/artifacts").then(({ json }) => {
      if (Array.isArray(json)) setArts(json.slice().reverse());
    }).catch(() => undefined);
  }, []);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    const { status: st, json } = await post("/approvals", { kind, subject, comment: comment || undefined });
    setOut(st === 200 ? "Recorded." : `Couldn't record: ${json?.reason ?? st}`);
    if (st === 200) toast("Recorded", `${kind} ${subject}`, "ok");
    void refreshStatus();
  };
  return (
    <>
      <h2>Decide <CloseX /></h2>
      <p className="muted" style={{ marginTop: 0 }}>Say yes or no to something. Gates listen to this — e.g. release can't finish without your approval.</p>
      <form className="stack" onSubmit={submit}>
        <div className="field"><label htmlFor="appr-kind">Decision</label><Select id="appr-kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="approve">Approve</option><option value="reject">Reject</option><option value="accept">Accept</option></Select></div>
        <div className="field"><label htmlFor="appr-subject">About what?</label><input id="appr-subject" list="subj" placeholder="release, architecture…" required autoComplete="off" value={subject} onChange={(e) => setSubject(e.target.value)} />
          <datalist id="subj">{[...subjects, ...((status?.goal?.acceptanceCriteria || []).map((c: any) => `criterion:${c.id}`))].map((s: string) => <option key={s}>{s}</option>)}</datalist></div>
        <div className="field"><label htmlFor="appr-comment">Why? (optional)</label><Input id="appr-comment" placeholder="one line for the log" value={comment} onChange={(e) => setComment(e.target.value)} /></div>
        {arts.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Recent files: {arts.slice(0, 3).map((a) => a.name).join(", ")}</div>}
        <div className="row"><Button variant="primary" type="submit">record it</Button><span className="muted">{out}</span></div>
      </form>
    </>
  );
}

function msgSnippet(payload: unknown, max = 140): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload.slice(0, max);
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const k of ["question", "summary", "note", "reason", "text", "response"]) {
      if (typeof p[k] === "string" && (p[k] as string).length > 0) return (p[k] as string).slice(0, max);
    }
    try {
      return JSON.stringify(payload).slice(0, max);
    } catch {
      return "";
    }
  }
  return String(payload).slice(0, max);
}

type AgentTab = "now" | "work" | "comms" | "memory" | "config";

const AGENT_TABS: Array<{ id: AgentTab; label: string; hint: string }> = [
  { id: "now", label: "Now", hint: "what this agent is doing this second" },
  { id: "work", label: "Work", hint: "its turns, tasks and files" },
  { id: "comms", label: "Comms", hint: "inbox, messages and threads" },
  { id: "memory", label: "Memory", hint: "what it has written down" },
  { id: "config", label: "Config", hint: "how it was set up" },
];

export function AgentDrawer({ id }: { id: string }): React.JSX.Element {
  const { toast, closeDrawer, openDrawer, streams, steps: allSteps, lastSeq } = useMesh();
  const [json, setJson] = useState<any>(null);
  const [tab, setTab] = useState<AgentTab>("now");
  // The old drawer fetched once and then lied for the rest of its life: open
  // it mid-turn and it showed a snapshot from before the agent started. It
  // now refetches on every batch of new events (SSE-driven, so it is quiet
  // when the mesh is), with a slow floor so a busy mesh cannot hammer it.
  const lastLoad = useRef(0);
  useEffect(() => {
    let dead = false;
    const load = async (): Promise<void> => {
      lastLoad.current = Date.now();
      try {
        const { json: j } = await api("GET", `/agents/${encodeURIComponent(id)}?limit=10`, undefined, { timeoutMs: 45000 });
        if (!dead) setJson(j);
      } catch {
        if (!dead) setJson((prev: any) => prev ?? { error: "unreachable" });
      }
    };
    void load();
    const iv = setInterval(() => {
      if (Date.now() - lastLoad.current >= 2500) void load();
    }, 2500);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [id]);
  // Nudge a refresh as soon as the log moves, instead of waiting out the poll.
  useEffect(() => {
    lastLoad.current = 0;
  }, [lastSeq]);
  if (!json) return <div className="muted">loading…</div>;
  if (json.error) {
    toast("agent", json.error || "not found", "bad");
    closeDrawer();
    return <div className="muted">not found</div>;
  }
  const d = json.definition, s = json.state;
  const act = (a: string) => void agentAction(id, a, toast);
  const unreadFull: any[] = Array.isArray(json.unreadMessages) ? json.unreadMessages : [];
  const unreadCount: number = Array.isArray(json.unread) ? json.unread.length : unreadFull.length;
  const steps: any[] = Array.isArray(json.recentSteps) ? json.recentSteps : [];
  const recentMsgs: any[] = Array.isArray(json.recentMessages) ? json.recentMessages : [];
  const tasks: any[] = Array.isArray(json.tasksInvolved) ? json.tasksInvolved : [];
  const arts: any[] = Array.isArray(json.artifacts) ? json.artifacts : [];
  const threads: any[] = Array.isArray(json.threads) ? json.threads : [];
  const mem: any[] = Array.isArray(json.memory) ? json.memory : [];
  const evs: any[] = Array.isArray(json.recentEvents) ? json.recentEvents : [];
  const approvals: any[] = Array.isArray(json.approvals) ? json.approvals : [];
  const decisions: any[] = Array.isArray(json.decisions) ? json.decisions : [];
  const escalations: any[] = Array.isArray(json.escalations) ? json.escalations : [];
  const leases: any[] = Array.isArray(json.leases) ? json.leases : [];
  const pending: any[] = Array.isArray(json.pendingRequests) ? json.pendingRequests : [];
  const ab = json.budgets?.agent;
  const pct = typeof ab?.pct === "number" ? Math.round(ab.pct * 100) : null;
  const openStep = (turnId: string): void => openDrawer(<StepDrawer turnId={turnId} steps={steps.length ? steps : allSteps || []} />);
  // Health facts an operator judges an agent by, none of which the old drawer
  // showed: how often its turns produce anything, and what "normal" looks
  // like for this agent specifically.
  const finished = steps.filter((x: any) => x.status !== "running");
  const produced = finished.filter((x: any) => outcomeOf(x) === "shipped").length;
  const producedPct = finished.length ? Math.round((produced / finished.length) * 100) : null;
  const base = baselineOf(steps.length ? steps : (allSteps || []), id);
  const current = steps.find((x: any) => x.turnId === json.currentTurnId) ?? steps.find((x: any) => x.status === "running");
  const buf = json.currentTurnId ? streams[json.currentTurnId] : undefined;
  const vitals = json.currentTurnId
    ? vitalsOf({
        phases: current?.phases,
        clientChars: buf?.chars ?? 0,
        clientUpdatedAt: buf?.updatedAt,
        running: true,
        startedAt: current?.startedAt,
      })
    : null;
  const signalCount = approvals.length + decisions.length + escalations.length + pending.length;
  return (
    <>
      <h2><AgentAvatar id={id} color="var(--accent)" />{(id)}
        <span className={`pill ${pillCls(s.lifecycle)}${RUNNING.has(s.lifecycle) ? " running-pulse" : ""}`}>{(plainLifecycle(s.lifecycle))}</span>
        <CloseX /></h2>
      <p className="muted" style={{ margin: "4px 0" }}>{(d.role)} · active {(ago(s.lastActivityAt))}</p>

      <div className="agent-vitals">
        <div className="avital"><b>{s.activations}</b><span>turns run</span></div>
        <div className={`avital${producedPct !== null && producedPct < 40 ? " warn" : ""}`} title="share of finished turns that left a message, file, task or decision behind">
          <b>{producedPct === null ? "—" : `${producedPct}%`}</b><span>produced something</span>
        </div>
        <div className="avital" title="median turn length for this agent"><b>{base.n >= 4 ? dur(base.medianDurationMs) : "—"}</b><span>typical turn</span></div>
        <div className={`avital${ab?.exceeded ? " bad" : pct !== null && pct >= 80 ? " warn" : ""}`} title={ab ? `${fmt(ab.consumed)} of ${ab.limit ?? "?"} tokens` : "no budget set"}>
          <b>{pct === null ? fmt(s.tokensConsumed) : `${pct}%`}</b><span>{pct === null ? "tokens used" : "of its budget"}</span>
        </div>
      </div>
      {pct !== null ? <div className="progress"><div style={{ transform: `scaleX(${Math.min(1, pct / 100)})` }} /></div> : null}

      {s.lastError ? (
        <>
          {/* Prefer the structured detail from the crashing turn — it names the
              phase and carries the stack; `state.lastError` is only a string. */}
          <ErrorPanel
            err={steps.find((x: any) => x.status === "failed" && x.errorDetail)?.errorDetail}
            fallback={`Crashed: ${String(s.lastError).slice(0, 220)}`}
          />
          <div className="esc-next"><b>Next:</b> <span className="muted">wake it once to retry, or open its last step for the failing call.</span> <Button variant="small" onClick={() => act("wake")}>wake to retry</Button></div>
        </>
      ) : null}
      <div className="row" style={{ margin: "8px 0 4px" }}>
        <Button variant="small" onClick={() => act("wake")}>run one step</Button>
        <Button variant="small" onClick={() => act("suspend")}>pause</Button>
        <Button variant="small" onClick={() => act("resume")}>unpause</Button>
      </div>

      <div className="tabs" role="tablist">
        {AGENT_TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab-btn${tab === t.id ? " on" : ""}`} title={t.hint} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === "comms" && unreadCount ? <em className="tab-n">{unreadCount}</em> : null}
            {t.id === "now" && signalCount ? <em className="tab-n hot">{signalCount}</em> : null}
          </button>
        ))}
      </div>

      {tab === "now" ? (
        <>
          {json.currentTurnId && vitals ? (
            <>
              <VitalsStrip v={vitals} model={current?.model ?? d.model} attempt={current?.attempt} />
              <PhaseRail phases={current?.phases} running />
              <Button variant="small" onClick={() => openStep(String(json.currentTurnId))}>open this step →</Button>
              {buf?.text ? <pre className="token-stream live agent-peek">{buf.text.slice(-900)}<span className="caret">▍</span></pre> : null}
            </>
          ) : (
            <div className="idle-box muted">
              {RUNNING.has(s.lifecycle)
                ? "Woken and starting a turn — output will appear here."
                : s.lifecycle === "WAITING"
                  ? "Parked on its mailbox with nothing to do. That is a healthy resting state, not a stall."
                  : `Not running (${plainLifecycle(s.lifecycle)}). Use “run one step” to wake it.`}
            </div>
          )}
          {json.activeTask ? <div className="now-task"><b>Working on:</b> {(String(json.activeTask.title ?? json.activeTask.id).slice(0, 90))} <Chip>{(json.activeTask.status)}</Chip></div> : null}
          {signalCount || leases.length ? (
            <>
              <h4>Signals</h4>
              {escalations.length ? <div className="sig bad">{escalations.length} escalation{escalations.length > 1 ? "s" : ""} — latest [{(escalations[0].reason)}] {(escalations[0].status)}</div> : null}
              {pending.length ? <div className="sig warn">{pending.length} open request{pending.length > 1 ? "s" : ""} waiting on an answer</div> : null}
              {approvals.length ? <div className="sig">{approvals.length} approvals — latest {(approvals[0].kind)} {(approvals[0].subject)}</div> : null}
              {decisions.length ? <div className="sig">{decisions.length} decisions proposed — latest “{(String(decisions[0].topic ?? "").slice(0, 60))}”</div> : null}
              {leases.length ? <div className="sig">{leases.filter((l: any) => l.active).length} active file locks{leases[0] ? ` — ${(String(leases[0].artifactId).slice(0, 20))}` : ""}</div> : null}
            </>
          ) : null}
          {evs.length ? (
            <>
              <h4>Just happened</h4>
              <div className="ev-list">{evs.slice(0, 6).map((e: any) => (
                <div className="ev" key={e.seq} data-seq={e.seq} role="button" tabIndex={0} onClick={() => openDrawer(<EventDrawerBySeq seq={e.seq} />)} onKeyDown={rowKey(() => openDrawer(<EventDrawerBySeq seq={e.seq} />))}>
                  <time>{hhmmss(e.at)}</time><span className="type">{(plainEvent(e.type))}</span><span className="summary">{(e.summary)}</span>
                </div>
              ))}</div>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "work" ? (
        <>
          <h4>Recent steps {steps.length ? `(${steps.length})` : ""}</h4>
          {steps.length ? (
            <div className="steps-mini">{steps.slice(0, 12).map((st: any) => <StepMini key={st.turnId} s={st} onOpen={openStep} />)}</div>
          ) : <div className="muted">No steps yet — wake it to run once.</div>}
          {tasks.length || json.activeTask ? (
            <>
              <h4>Tasks {tasks.length ? `(${tasks.length})` : ""}</h4>
              <div>{tasks.slice(0, 12).map((t: any) => <div key={t.id} style={{ fontSize: 13, margin: "4px 0" }}><span className="mono muted">{(String(t.id).slice(0, 8))}</span> {(String(t.title ?? "").slice(0, 70))} <Chip>{(t.status)}</Chip></div>)}</div>
            </>
          ) : null}
          {arts.length ? (
            <>
              <h4>Files {`(${arts.length})`}</h4>
              <div>{arts.slice(0, 12).map((a: any) => <div key={a.id} className="ev" role="button" tabIndex={0} onClick={() => openDrawer(<ArtifactDrawer id={a.id} />)} onKeyDown={rowKey(() => openDrawer(<ArtifactDrawer id={a.id} />))}><time>v{a.version}</time><span className="type">{(plainArtifact(a.status))}</span><span className="summary">{(a.name)} · {(a.type)}</span></div>)}</div>
            </>
          ) : <div className="muted">It has not produced any files.</div>}
        </>
      ) : null}

      {tab === "comms" ? (
        <>
          <h4>Inbox {unreadCount ? `(${unreadCount} unread)` : ""}</h4>
          {unreadFull.length ? (
            <div className="ev-list">{unreadFull.slice(0, 12).map((m: any) => (
              <div className="ev" key={m.id}>
                <time>{hhmmss(m.timestamp)}</time>
                <span className="type">{(MESSAGE_PLAIN[m.type] ?? m.type)}</span>
                <span className="summary">{(m.from)} → {((m.to || []).join(","))}: {(msgSnippet(m.payload, 110))}</span>
              </div>
            ))}</div>
          ) : <div className="muted">Inbox is empty — it has read everything sent to it.</div>}
          {unreadCount > unreadFull.length ? <div className="muted" style={{ fontSize: 12 }}>+{unreadCount - unreadFull.length} more unread</div> : null}
          {recentMsgs.length ? (
            <>
              <h4>Recent messages</h4>
              <div className="ev-list">{recentMsgs.slice(0, 12).map((m: any) => (
                <div className="ev" key={m.id}>
                  <time>{hhmmss(m.timestamp)}</time>
                  <span className="type">{(m.from === id ? `→ ${(m.to || []).join(",")}` : `⇐ ${m.from}`)}</span>
                  <span className="summary">{(MESSAGE_PLAIN[m.type] ?? m.type)}: {(msgSnippet(m.payload, 100))}</span>
                </div>
              ))}</div>
            </>
          ) : null}
          {threads.length ? (
            <>
              <h4>Threads {`(${threads.length})`}</h4>
              <div>{threads.slice(0, 10).map((t: any) => <div key={t.id} style={{ fontSize: 13, margin: "4px 0" }}>“{(String(t.subject ?? "").slice(0, 60))}” <span className="muted">· {t.messageCount} msgs · {((t.participants || []).join(", "))}</span></div>)}</div>
            </>
          ) : null}
        </>
      ) : null}

      {tab === "memory" ? (
        <>
          <h4>Memory {mem.length ? `(${mem.length})` : ""}</h4>
          {mem.length
            ? <div>{mem.map((n: any) => <div key={n.key} className="mem-row"><span className="mono">{(n.key)}</span> <span className="muted">— {(String(n.value ?? "").slice(0, 400))}</span></div>)}</div>
            : <div className="muted">No notes yet. Agents write here when they use the remember op.</div>}
        </>
      ) : null}

      {tab === "config" ? (
        <>
          <h4>What it does</h4>
          <div>{(d.capabilities || []).map((c: string) => <Chip key={c}>{(c)}</Chip>) || <span className="muted">—</span>}</div>
          {(d.authority || []).length ? <div style={{ marginTop: 6 }}><span className="muted" style={{ fontSize: 12 }}>Can decide:</span> {(d.authority || []).map((c: string) => <Chip key={c} hot>{(c)}</Chip>)}</div> : null}
          <h4>Setup</h4>
          <table className="tbl"><tbody>
            <tr><td>runtime</td><td className="mono">{(d.runtime)}{d.model ? ` · ${(d.model)}` : ""}</td></tr>
            <tr><td>listens for</td><td>{(d.interests || []).slice(0, 12).map((c: string) => <Chip key={c}>{(c)}</Chip>) || <span className="muted">—</span>}</td></tr>
            <tr><td>budget</td><td className="mono">{fmt(d.budget?.tokens ?? 0)} tokens{json.budgets?.mission ? ` · mission ${fmt(json.budgets.mission.consumed)} / ${json.budgets.mission.limit ?? "?"}` : ""}</td></tr>
            {json.communication ? <tr><td>contacts</td><td style={{ fontSize: 12 }}>→ {((json.communication.mayContact || []).join(", ") || "nobody new")}<br />← {((json.communication.mayBeContactedBy || []).join(", ") || "restricted")}</td></tr> : null}
            {json.session ? <tr><td>session</td><td className="mono">{(json.session.sessionId)} ({(json.session.runtime)})</td></tr> : null}
            {json.stats ? <tr><td>totals</td><td className="mono" style={{ fontSize: 12 }}>{json.stats.messagesSent} sent · {json.stats.messagesReceived} received · {json.stats.artifactsCreated} files</td></tr> : null}
          </tbody></table>
        </>
      ) : null}
    </>
  );
}

/** Display-only parse of the mesh-json ops block (mirrors the server parser). */
function parseOpsBlock(text: unknown): any[] | null {
  if (typeof text !== "string" || !text) return null;
  const cands: string[] = [];
  const m = /```(?:mesh-json|json|mesh-op)?\s*\n?([\s\S]*?)```/.exec(text);
  if (m) cands.push(m[1]);
  const t = text.trim();
  if (t.startsWith("[") || t.startsWith("{")) cands.push(t);
  for (const c of cands) {
    try {
      const p = JSON.parse(c);
      if (Array.isArray(p)) return p;
      if (p && typeof p === "object") {
        if (Array.isArray((p as any).operations)) return (p as any).operations;
        if (typeof (p as any).op === "string") return [p];
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** Canonicalize display names for ops emitted under old/invented vocabularies. */
function displayOpName(raw: unknown): string {
  const o = String(raw ?? "op");
  const m: Record<string, string> = {
    mesh_send: "send", mesh_message: "send", message_send: "send", "message.send": "send",
    mesh_broadcast: "broadcast", mesh_request: "send", mesh_respond: "respond",
    mesh_artifact_publish: "publish_artifact", mesh_publish_artifact: "publish_artifact",
    mesh_artifact_read: "read_artifact", mesh_artifact_transition: "transition_artifact",
    mesh_request_review: "request_review", mesh_task_claim: "claim_task",
    mesh_task_complete: "complete_task", mesh_task_create: "create_task",
    mesh_research_request: "request_research", mesh_decision_propose: "propose_decision",
    mesh_decision_ratify: "ratify_decision", mesh_wait: "wait", mesh_done: "done",
  };
  return m[o] ?? o;
}

function opHead(o: any): { title: string; detail: string } {
  const op = displayOpName(o.op);
  const to = (v: unknown): string => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));
  switch (op) {
    case "send":
    case "broadcast":
    case "respond": {
      const recips = to(o.to) || "—";
      const note = msgSnippet(o.payload ?? o.body, 150);
      return { title: `${String(o.type || "message")} → ${recips}`, detail: note };
    }
    case "publish_artifact": {
      const len = typeof o.content === "string" ? o.content.length : 0;
      return { title: `Published ${String(o.name || "artifact")}`, detail: `${String(o.type || o.kind || "")}${len ? ` · ${len} chars` : ""}` };
    }
    case "request_review": {
      const art = String(o.artifactId || o.artifact || o.artifactUri || "?").split("/").pop() || "?";
      return { title: `Review requested: ${art}`, detail: `reviewers: ${to(o.reviewers || o.to) || "—"}` };
    }
    case "propose_decision":
      return { title: `Proposed: ${String(o.topic || o.summary || o.id || "decision").slice(0, 90)}`, detail: msgSnippet(o.decision ?? o.summary, 150) };
    case "ratify_decision":
      return { title: `Ratified ${String(o.decisionId || o.id || "").slice(0, 20)}`, detail: "" };
    case "escalate":
      return { title: `Escalated: ${String(o.reason || "").slice(0, 90)}`, detail: msgSnippet(o.detail, 150) };
    case "create_task":
      return { title: `Task: ${String(o.title || "").slice(0, 90)}`, detail: o.assignedTo ? `→ ${o.assignedTo}` : "" };
    case "claim_task":
    case "complete_task":
      return { title: `${op === "claim_task" ? "Claimed" : "Completed"} ${String(o.taskId || o.task || "").slice(0, 20)}`, detail: msgSnippet(o.summary, 140) };
    case "delegate":
      return { title: `Delegated to ${String(o.to || "")}: ${String(o.title || "").slice(0, 70)}`, detail: "" };
    case "wait":
      return { title: "Waiting", detail: String(o.reason || "") };
    case "done":
      return { title: "Done", detail: msgSnippet(o.summary, 140) };
    case "remember":
      return { title: `Remembered ${String(o.key || "")}`, detail: String(o.value || "").slice(0, 140) };
    case "transition_artifact":
      return { title: `Moved → ${String(o.to || "")}`, detail: String(o.artifactId || o.artifact || "") };
    default:
      return { title: op, detail: msgSnippet(o, 150) };
  }
}

/** Event types that can be the observable effect of a given op. */
const OP_EFFECT_TYPES: Record<string, string[]> = {
  send: ["message.sent"],
  broadcast: ["message.sent"],
  respond: ["message.sent"],
  delegate: ["message.sent", "task.created"],
  publish_artifact: ["artifact.created", "artifact.versioned"],
  request_review: ["review.requested"],
  propose_decision: ["decision.proposed", "decision.ratified"],
  ratify_decision: ["decision.ratified", "decision.proposed"],
  escalate: ["escalation.requested"],
  create_task: ["task.created"],
  claim_task: ["task.claimed"],
  complete_task: ["task.completed"],
  remember: ["memory.updated"],
  transition_artifact: ["artifact.transition", "artifact.versioned"],
};

export interface OpRow {
  op: any;
  head: { title: string; detail: string };
  /** The landed effect, `null` when none was found, `undefined` when the op has none to find. */
  fx: any | null | undefined;
}

/**
 * Pair each written op with the event it produced.
 *
 * The previous version drained shared per-type queues with `.shift()`, so the
 * answer depended on op order and one unmatched op poisoned every later one —
 * turns that fully succeeded were reported as "no effect". This matches each
 * op against the events of *its own* types, consumes each event at most once,
 * and preserves log order within a type, so a mismatch stays local to the op
 * that caused it.
 */
export function matchOpEffects(ops: any[], timeline: any[]): OpRow[] {
  const used = new Set<any>();
  const waitEv = timeline.find((e: any) => e.type === "agent.state_changed" && (e.payload as any)?.to === "WAITING");
  return ops.map((o: any) => {
    const name = displayOpName(o?.op);
    if (name === "wait") return { op: o, head: opHead(o), fx: waitEv ?? null };
    const types = OP_EFFECT_TYPES[name];
    // done / reads / leases produce nothing observable — `undefined` means
    // "not applicable", which the UI renders as no badge at all rather than
    // as a failure.
    if (!types) return { op: o, head: opHead(o), fx: undefined };
    const fx = timeline.find((e: any) => types.includes(e.type) && !used.has(e)) ?? null;
    if (fx) used.add(fx);
    return { op: o, head: opHead(o), fx };
  });
}

export function StepDrawer({ turnId, steps }: { turnId: string; steps: any[] }): React.JSX.Element {
  const { toast, openDrawer, events, streams } = useMesh();
  const [json, setJson] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let dead = false;
    const load = async (): Promise<boolean> => {
      try {
        const { json: j } = await api("GET", `/turns/${encodeURIComponent(turnId)}`, undefined, { timeoutMs: 15000 });
        if (!dead) setJson(j);
        return (j as any)?.turn?.status === "running";
      } catch {
        if (!dead) setJson((prev: any) => prev ?? { error: true });
        return false;
      }
    };
    void load();
    // While the agent is still working, two live channels feed this drawer:
    // token frames over SSE (see streams in store) for instant output, plus
    // this poll as the fallback that also delivers completion + op effects.
    const iv = setInterval(async () => {
      const stillRunning = await load();
      if (!stillRunning) clearInterval(iv);
    }, 1500);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [turnId]);
  if (!json) return <div className="muted">loading…</div>;
  if (!json || json.error || (!json.turn && (json.events || []).length === 0)) {
    const s = (steps || []).find((x: any) => x.turnId === turnId);
    if (!s) {
      toast("step", "not found", "bad");
      return <div className="muted">not found</div>;
    }
    return (
      <>
        <h2>Step <span className="mono muted">{(turnId)}</span><CloseX /></h2>
        <div className="row"><StatusPillOf status={s.status} ops={s.ops} /><span className="muted">{(s.agentId)} · {(s.reasonKind)}</span></div>
        <pre>{(JSON.stringify(s, null, 2))}</pre>
      </>
    );
  }
  const t = json.turn || {};
  const isRunning = t.status === "running";
  // Live timeline: stored entries plus SSE events for this turn that arrived
  // after the fetch (deduped by seq). Keeps "what happened" fresh while open.
  const storedTl: any[] = Array.isArray(json.timeline) ? json.timeline : [];
  const liveExtra: any[] = (events || [])
    .filter((e: any) => e.correlationId === turnId && !storedTl.some((s: any) => s.seq === e.seq))
    .map((e: any) => ({ seq: e.seq, at: e.timestamp, type: e.type, actor: e.actorId, summary: e.summary, id: e.id, correlationId: e.correlationId, causationId: e.causationId, payload: e.payload }));
  const timeline = [...storedTl, ...liveExtra].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const elapsed = isRunning && t.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(t.startedAt)) / 1000)) : null;
  // Live text: SSE token frames are freshest, but the polled turn carries the
  // same deltas via the server-side buffer — whichever is longer wins, so a
  // dropped SSE frame degrades to polling instead of losing content.
  const streamText = streams[turnId]?.text ?? "";
  const liveText = isRunning ? (streamText.length >= (t.text?.length ?? 0) ? streamText : (t.text ?? "")) : "";
  const liveChars = isRunning ? Math.max(streamText.length, t.text?.length ?? 0, streams[turnId]?.chars ?? 0) : 0;
  const copyOutput = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(String(t.text || ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };
  // Structured ops (intent) + landed effects (reality), matched in execution
  // order. Answers "did the step work?" without reading raw JSON.
  const ops: any[] | null = parseOpsBlock(t.text);
  const summaryIsOps = typeof t.summary === "string" && /^\s*[\[{]/.test(t.summary) && t.summary.includes('"op"');
  const opRows = ops ? matchOpEffects(ops, timeline) : null;
  const landedCount = opRows ? opRows.filter((r) => r.fx).length : 0;
  // The Steps list already carries exact op counters; prefer them over the
  // drawer's "how many ops landed" heuristic when the turn is in that list.
  const listStep: TurnStep | undefined = (steps || []).find((x: any) => x.turnId === turnId);
  const showSplit = typeof t.tokensInput === "number" && typeof t.tokensOutput === "number"
    && t.tokensInput >= 100 && (t.tokensInput + t.tokensOutput) >= (t.tokens ?? 0) * 0.3;
  // Phase marks are live-only; a turn evicted from the server's ring has none,
  // in which case the rail and parts of the vitals simply do not render.
  const phases: TurnPhases | undefined = t.phases ?? listStep?.phases;
  const buf = streams[turnId];
  const vitals = vitalsOf({
    phases,
    clientChars: Math.max(buf?.chars ?? 0, liveChars),
    clientUpdatedAt: buf?.updatedAt,
    running: isRunning,
    startedAt: t.startedAt,
  });
  const base = baselineOf(steps || [], t.agentId);
  const links = causalLinks(turnId, events || [], steps || []);
  const partial = isRunning ? parsePartialOps(liveText) : null;
  return (
    <>
      <h2><AgentAvatar id={t.agentId || "?"} />{(t.agentId || "step")} <StatusPillOf status={t.status || "running"} ops={listStep?.ops} landed={landedCount} /><CloseX /></h2>
      <p className="muted" style={{ margin: "4px 0" }}>{(plainReason(t.reason?.kind))}{t.reason?.note ? ` — ${(t.reason.note)}` : ""} · {(ago(t.startedAt || ""))}{t.durationMs != null && !isRunning ? ` · took ${(t.durationMs / 1000).toFixed(1)}s` : ""}{elapsed !== null ? ` · working for ${elapsed}s` : ""}
        {!isRunning && t.durationMs != null ? <> <BaselineChip value={t.durationMs} base={base} kind="duration" /></> : null}</p>
      <CausalRail
        links={links}
        onTurn={(id) => openDrawer(<StepDrawer turnId={id} steps={steps} />)}
        onEvent={(seq) => openDrawer(<EventDrawerBySeq seq={seq} />)}
      />
      {isRunning ? <VitalsStrip v={vitals} model={t.model} attempt={t.attempt ?? listStep?.attempt} /> : null}
      <PhaseRail phases={phases} running={isRunning} />
      <ErrorPanel err={t.errorDetail ?? listStep?.errorDetail} fallback={t.error} />
      {(t.tokens != null || t.model) ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {t.tokens != null ? <>{fmt(t.tokens)} tokens{showSplit ? ` (in ${fmt(t.tokensInput)} · out ${fmt(t.tokensOutput)})` : (t.tokensInput != null ? " · incl. reasoning" : "")}</> : null}
          {t.tokens ? <> <BaselineChip value={t.tokens} base={base} kind="tokens" /></> : null}
          {t.model ? <> · <span className="mono">{(t.model)}</span></> : null}
          {t.toolCalls ? <> · {t.toolCalls} tool calls</> : null}
        </div>
      ) : null}
      {t.summary && !summaryIsOps ? <><h4>What it says it did</h4><p>{(t.summary)}</p></> : null}
      {isRunning ? (
        <>
          {partial ? <LiveOps ops={partial.ops} writing={partial.writing} heads={opHead} /> : null}
          {partial?.prose ? <><h4>Its reasoning</h4><p className="live-prose">{partial.prose.slice(-1200)}</p></> : null}
          <LiveStream text={liveText} hasInstructions={Boolean(t.instructions)} copyOutput={copyOutput} copied={copied} />
        </>
      ) : (
        <>
          <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
            <h4 style={{ marginBottom: 0 }}>What it did{opRows ? ` (${opRows.length} op${opRows.length === 1 ? "" : "s"} · ${landedCount} landed)` : ""}</h4>
            {t.text ? <Button variant="small" onClick={() => void copyOutput()}>{copied ? "copied ✓" : "copy raw"}</Button> : null}
          </div>
          {opRows ? (
            <div className="op-list">{opRows.map((r, i) => (
              <div className="op" key={i}>
                <div className="op-head">
                  <span className="op-name">{r.head.title}</span>
                  {r.fx === undefined ? null : r.fx ? <span className="op-ok" title="effect found in the event log">✓ landed</span> : <span className="op-miss" title="no matching effect in the event log">○ no effect</span>}
                </div>
                {r.head.detail ? <div className="op-detail">{r.head.detail}</div> : null}
                {r.fx ? (
                  <div className="op-fx">
                    {(r.fx.type === "artifact.created" || r.fx.type === "artifact.versioned") && (r.fx.payload as any)?.artifact?.id ? (
                      <Button variant="small" onClick={() => openDrawer(<ArtifactDrawer id={(r.fx.payload as any).artifact.id} />)}>
                        open {(r.fx.payload as any).artifact.name} v{(r.fx.payload as any).artifact.version}
                      </Button>
                    ) : (
                      <Button variant="small" onClick={() => r.fx.seq != null && openDrawer(<EventDrawerBySeq seq={r.fx.seq} />)}>
                        see {plainEvent(r.fx.type)} #{r.fx.seq}
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            ))}</div>
          ) : t.text ? (
            <div className="muted">Output isn't an ops block — see raw output below.</div>
          ) : (
            <div className="muted">No output captured for this step — it predates output capture or left the recent-turn window (server restart / over 200 turns ago).</div>
          )}
          {t.text ? (
            <details className="esc-raw"><summary>raw model output</summary><pre className="token-stream">{(t.text)}</pre></details>
          ) : null}
        </>
      )}
      {t.instructions ? (
        <details className="esc-raw"><summary>what it was asked to do</summary><pre className="token-stream">{(String(t.instructions).slice(0, 8000))}</pre></details>
      ) : null}
      {Array.isArray(t.toolCallsDetail) && t.toolCallsDetail.length ? (
        <>
          <h4>Tool calls ({t.toolCallsDetail.length})</h4>
          <div>{t.toolCallsDetail.slice(0, 30).map((c: any, i: number) => <div key={i} style={{ fontSize: 13, margin: "4px 0" }}><Chip mono>{(String(c.name ?? "tool"))}</Chip> <span className="muted mono" style={{ fontSize: 11 }}>{(JSON.stringify(c.args ?? {}).slice(0, 160))}</span></div>)}</div>
        </>
      ) : null}
      <OpLatency timings={t.opTimings ?? listStep?.opTimings} />
      <h4>What happened ({timeline.length})</h4>
      <div className="ev-list">{timeline.map((e: any) => (
        <div className="ev" key={e.seq ?? e.id} data-seq={e.seq} role={e.seq != null ? "button" : undefined} tabIndex={e.seq != null ? 0 : undefined} onClick={() => e.seq != null && openDrawer(<EventDrawerBySeq seq={e.seq} />)} onKeyDown={rowKey(() => { if (e.seq != null) openDrawer(<EventDrawerBySeq seq={e.seq} />); })}>
          <time>{hhmmss(e.at)}</time><span className="type">{(plainEvent(e.type))}</span><span className="summary">{(e.summary)}</span>
        </div>
      )) || <div className="muted">No linked events — this turn is older than the log window.</div>}</div>
      <details className="esc-raw"><summary>technical details</summary><pre>{(JSON.stringify({ turn: { ...t, text: t.text ? `${String(t.text).slice(0, 500)}… [truncated in details]` : t.text } }, null, 2).slice(0, 4000))}</pre></details>
    </>
  );
}

/** Compact live header for a running turn: streaming/thinking state + volume. */
function LiveHead({ streaming, chars, model }: { streaming: boolean; chars: number; model?: string }): React.JSX.Element {
  return (
    <div className="stream-head">
      <span className={`live-dot${streaming ? " on" : ""}`} />
      <div className="stream-head-main">
        <b>{streaming ? "streaming" : "thinking"}</b>
        <span className="muted">{streaming ? ` · ${fmt(chars)} chars` : " · waiting for first tokens"}{model ? ` · ${model}` : ""}</span>
      </div>
    </div>
  );
}

/**
 * Live token viewport: auto-scrolls while following, blinking caret while the
 * turn runs, "jump to live" when the user scrolled up. Thinking state (no
 * text yet) shows a shimmer instead of an empty box.
 */
function LiveStream({ text, hasInstructions, copyOutput, copied }: {
  text: string;
  hasInstructions: boolean;
  copyOutput: () => void;
  copied: boolean;
}): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  const followRef = useRef(true);
  useEffect(() => {
    if (followRef.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text]);
  const onScroll = (): void => {
    const el = ref.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    followRef.current = nearBottom;
    setFollow(nearBottom);
  };
  const jumpLive = (): void => {
    followRef.current = true;
    setFollow(true);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };
  if (!text) {
    return (
      <div className="think-box">
        <span className="think-dots"><i /><i /><i /></span>
        <span className="muted">thinking…{hasInstructions ? " see what it was asked to do below." : ""}</span>
      </div>
    );
  }
  return (
    <div className="stream-wrap">
      <div className="row stream-bar">
        <span className="muted">live output</span>
        <span className="row" style={{ gap: 6 }}>
          {!follow ? <Button variant="small" onClick={jumpLive}>↓ jump to live</Button> : null}
          <Button variant="small" onClick={copyOutput}>{copied ? "copied ✓" : "copy"}</Button>
        </span>
      </div>
      <pre ref={ref} className="token-stream live" onScroll={onScroll}>{text}<span className="caret">▍</span></pre>
    </div>
  );
}

/* Outcome badge for a turn. `ops` comes from the Steps list entry when we have
   it; the /turns payload only carries op *names*, so `landed` is the fallback
   count of effects that actually took hold. Raw "waiting" is never shown —
   it means "turn over, agent parked", not "stuck". */
function StatusPillOf({ status, ops, landed }: { status: string; ops?: TurnStep["ops"]; landed?: number }): React.JSX.Element {
  const resolved = ops ?? (landed === undefined ? undefined : { messages: landed, artifacts: 0, tasks: 0, decisions: 0 });
  return <OutcomePill step={{ status, ops: resolved }} />;
}

export function EventDrawerBySeq({ seq }: { seq: number }): React.JSX.Element {
  const { events, openDrawer } = useMesh();
  const e: TimelineEvent | undefined = events.find((x) => x.seq === seq);
  if (!e) return <div className="muted">event #{seq} is no longer in the live window</div>;
  const parent = e.causationId ? events.find((x) => x.id === e.causationId) : undefined;
  const sameTurn = e.correlationId ? events.filter((x) => x.correlationId === e.correlationId && x.seq !== e.seq).slice(-6) : [];
  const isTurn = e.correlationId && String(e.correlationId).startsWith("turn-");
  return (
    <>
      <h2>{(plainEvent(e.type))} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{(e.type)} · #{e.seq}</span><CloseX /></h2>
      <p className="muted" style={{ margin: "4px 0" }}>{(hhmmss(e.timestamp))} · by {(e.actorId ?? "system")}</p>
      <p dangerouslySetInnerHTML={{ __html: evSummary(e) }} />
      {isTurn ? <div className="row" style={{ margin: "8px 0" }}><StepOpener turnId={e.correlationId as string} /></div> : null}
      {parent ? <><h4>Why it happened</h4><div className="ev" data-seq={parent.seq} role="button" tabIndex={0} onClick={() => openDrawer(<EventDrawerBySeq seq={parent.seq} />)} onKeyDown={rowKey(() => openDrawer(<EventDrawerBySeq seq={parent.seq} />))}><time>{hhmmss(parent.timestamp)}</time><span className={`type ${evClass(parent.type)}`}>{(plainEvent(parent.type))}</span><span className="summary" dangerouslySetInnerHTML={{ __html: evSummary(parent) }} /></div></> : null}
      {sameTurn.length ? <><h4>Same step</h4><div className="ev-list">{sameTurn.map((c) => (
        <div className="ev" key={c.seq} data-seq={c.seq} role="button" tabIndex={0} onClick={() => openDrawer(<EventDrawerBySeq seq={c.seq} />)} onKeyDown={rowKey(() => openDrawer(<EventDrawerBySeq seq={c.seq} />))}><time>{hhmmss(c.timestamp)}</time><span className={`type ${evClass(c.type)}`}>{(plainEvent(c.type))}</span><span className="summary" dangerouslySetInnerHTML={{ __html: evSummary(c) }} /></div>
      ))}</div></> : null}
      <details className="esc-raw"><summary>technical details</summary><pre>{(JSON.stringify(e, null, 2).slice(0, 3000))}</pre></details>
    </>
  );
}

function StepOpener({ turnId }: { turnId: string }): React.JSX.Element {
  const { openDrawer, steps } = useMesh();
  return <Button variant="small" onClick={() => openDrawer(<StepDrawer turnId={turnId} steps={steps} />)}>See the full step →</Button>;
}

export function ArtifactDrawer({ id }: { id: string }): React.JSX.Element {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      const { json } = await api("GET", "/artifacts");
      const arts = Array.isArray(json) ? json : [];
      const a = arts.find((x: any) => x.id === id);
      if (!a || dead) {
        if (!dead) setData({ missing: true });
        return;
      }
      const [{ json: versions }, content] = await Promise.all([
        api("GET", `/artifacts/${encodeURIComponent(id)}/versions`),
        getText(`/artifacts/${encodeURIComponent(id)}/content`),
      ]);
      if (!dead) setData({ a, versions: versions || [], content });
    })().catch(() => {
      if (!dead) setData({ missing: true });
    });
    return () => {
      dead = true;
    };
  }, [id]);
  if (!data) return <div className="muted">loading…</div>;
  if (data.missing) return <div className="muted">not found</div>;
  const { a } = data;
  const done = ["MERGED", "ACCEPTED", "APPROVED", "FINAL", "VERIFIED", "MERGEABLE", "QA_VERIFIED", "SECURITY_VERIFIED"].includes(a.status);
  return (
    <>
      <h2>{(a.name)} <Pill tone={done ? "completed" : a.status === "REJECTED" ? "failed" : "idle"}>{(plainArtifact(a.status))}</Pill><CloseX /></h2>
      <p className="muted" style={{ margin: "4px 0" }}>v{a.version} · {(a.type)} · by {(a.owner)} · {(ago(a.createdAt))}</p>
      <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>history: {(data.versions || []).map((v: any) => `v${v.version} (${plainArtifact(v.status)})`).join(" → ")}</div>
      <h4>Contents</h4><pre>{(data.content.slice(0, 8000))}{data.content.length > 8000 ? "… truncated" : ""}</pre>
    </>
  );
}

export function useAgentsToWakeConfirm(): (action: string) => boolean {
  const { status } = useMesh();
  return (action: string) => {
    const names = agentsToWake(status?.agents || []);
    if (!names.length) return true;
    return window.confirm(`${action} wakes ${names.join(", ")} and resumes spend. Continue?`);
  };
}
