import { useCallback, useEffect, useRef, useState } from "react";
import { type ProjectClient } from "./api";
import { ago, dur, fmt, hhmmss, outcomeOf, opsSummary, pillCls, producedCount, plainArtifact, plainEvent, plainLifecycle, plainReason, shortTurn, MESSAGE_PLAIN, RUNNING, type OutcomeInput } from "./format";
import { buildLedger, ledgerTally, msgSnippet, opHead, producedFromTimeline, splitSummary } from "./ledger";
import { planLabel, planStale } from "./plan";
import { useMesh, useMeshStreams, type TimelineEvent, type TurnStep } from "./store";
import { StatusPill, LifecyclePill, StepMini, OutcomePill, isTopTrap, rowKey, AgentAvatar, Banner, Button, Chip, ErrorState, Input, Pill, Select, TabPanel, Tabs, TextArea, ZoneNote, agentColor, type ConfirmFn } from "./components";
import { Icon } from "./icons";
import { messageTypeLabel, recipientsOf, toggleRecipient } from "./message-form";
import { actionNote, controlsHint, controlsOf, pauseWarning } from "./agents";
import { CopyBtn, SandboxStrip, StepSkeleton, StepStatusBlock, envLine, stateMeta, textStats, useSandboxPerms } from "./stepdetail";
import { ArtifactReader } from "./artifactreader";
import { baselineOf, vitalsOf, type TurnPhases } from "./vitals";
import { BaselineChip, CausalRail, ErrorPanel, LiveOps, OpLatency, PhaseRail, VitalsStrip, causalLinks } from "./observability";
import { ClampedProse, EventRows, Inspector, JsonBlock, OpLedger, Prose, STEP_NARROW, StepJump, ToolRows, useStepMedia, type Section, type Sel } from "./stepview";
import { placeLabel, placeStep } from "./stepwalk";
import { ageText, deadlineOf, deadlineText, firstDeadline, hardStopText, liveWorkOf, mergeLiveTools, tokenText, type DeadlineInput } from "./livework";
import { DeadlineBar, LiveWork, NowLine } from "./liveview";

/** The most steps `/steps` will return (the server clamps `limit` to it). */
const STEPS_MAX = 200;

export function CloseX({ extra }: { extra?: string } = {}): React.JSX.Element {
  const { closeDrawer, closeDetail, drawerDepth } = useMesh();
  // A deep-linked step or agent lives in `detail`, not in the drawer stack, so
  // popping the stack was a no-op and the × did nothing on exactly the URLs
  // people share. Mirror the shell's own Esc/scrim handler: pop a stacked
  // panel if there is one, otherwise close the URL-backed detail.
  const close = (): void => {
    if (drawerDepth > 0) closeDrawer();
    else closeDetail();
  };
  return (
    <button type="button" className={`close-x${extra ? ` ${extra}` : ""}`} aria-label="Close panel" title="Close (Esc)" onClick={close}>
      <Icon name="x" size={16} />
    </button>
  );
}

/**
 * Wake, suspend or resume an agent, and say what came of it. What the toast says is decided in agents.ts (`actionNote`): a wake
 * runs one turn and lets go, a pause says whether it stopped a turn, a refusal keeps the server's own reason, and a request that
 * got no answer says it is not known whether it took effect.
 */
export async function agentAction(client: ProjectClient, id: string, act: string, toast: (t: string, m: string, k?: string) => void, after?: () => void): Promise<void> {
  let note;
  try {
    const { status, json } = await client.post(`/agents/${encodeURIComponent(id)}/${act}`);
    note = actionNote(act, id, status, json);
  } catch {
    note = actionNote(act, id, null, null);
  }
  toast(note.title, note.text, note.kind);
  if (after) setTimeout(after, 400);
}

/**
 * Pausing an agent that is in a turn stops that turn, and what it has spent is billed, so that one asks first. Pausing an agent that
 * is between turns costs nothing and does not ask. Resolves true when the pause should go ahead.
 */
export async function confirmPause(confirm: ConfirmFn, id: string, midTurn: boolean): Promise<boolean> {
  if (!midTurn) return true;
  const w = pauseWarning(id);
  return (await confirm({ title: w.title, body: w.body, confirmLabel: w.confirmLabel, danger: true })) !== null;
}

export function MessageDrawer(): React.JSX.Element {
  const { status, vocab, toast, refreshStatus, client } = useMesh();
  const ids = (status?.agents || []).filter((a: any) => a.id !== "human").map((a: any) => a.id);
  const parked = Boolean(status?.uiOnly) || status?.mode === "parked";
  const missionOver = status?.goal?.status === "COMPLETED" || status?.goal?.status === "FAILED";
  const [to, setTo] = useState("");
  const picked = recipientsOf(to, ids);
  const [type, setType] = useState("INFORM");
  const [note, setNote] = useState("");
  const [payload, setPayload] = useState('{ "note": "" }');
  const [advanced, setAdvanced] = useState(false);
  // Default ON whenever mail alone cannot start a turn: parked, or a mission
  // that already finished. Defaulting to `parked` only was the second half of
  // the "feedback did nothing" bug — a completed mission reported live, so the
  // box stayed unticked and the message sat unread in the mailbox.
  const [wake, setWake] = useState(parked || missionOver);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  // The panel says what came of a send in its own line under the button, so a corner notice as well only said it twice (and a
  // screen reader heard it twice). The notice is for a panel closed before the answer came back, refusals included, which
  // nothing used to report at all.
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (sending) return;
    let body: unknown;
    if (advanced) {
      try {
        body = JSON.parse(payload || "{}");
      } catch {
        setOut({ ok: false, text: "That is not valid JSON." });
        return;
      }
    } else {
      body = { note };
    }
    const recipients = recipientsOf(to, ids);
    if (!recipients.length) {
      setOut({ ok: false, text: "Pick at least one agent." });
      return;
    }
    setSending(true);
    setOut(null);
    try {
      const { status: st, json } = await client.post("/messages", { to: recipients, type, payload: body, wake });
      if (st === 202) {
        // The words are cleared and the recipients kept: a second note to the same seat is the common next step.
        setOut({ ok: true, text: `Sent to ${recipients.join(", ")}.` });
        if (!shown.current) toast("Message sent", `to ${recipients.join(", ")}`, "ok");
        setNote("");
      } else {
        const reason = json?.reason ?? `the server answered ${st}`;
        setOut({ ok: false, text: `Could not send it: ${reason}` });
        if (!shown.current) toast("Message not sent", `To ${recipients.join(", ")}: ${reason}`, "bad");
      }
    } catch {
      setOut({ ok: false, text: "The server did not answer. Try again." });
      if (!shown.current) toast("Message not sent", "The server did not answer.", "bad");
    } finally {
      setSending(false);
    }
    void refreshStatus();
  };
  return (
    <>
      <h2 id="drawer-title">Message an agent <CloseX /></h2>
      <p className="muted" style={{ marginTop: 0 }}>
        You write as the human, the one seat every agent listens to.{parked ? " The project is parked and nothing runs on its own, so a message waits until the agent is run." : ""}
      </p>
      {missionOver ? (
        <Banner tone="warn" title={`The mission is ${status?.goal?.status === "COMPLETED" ? "delivered" : "failed"}.`}>
          Agents can still reply, but anything that would produce something (a file, a task, an approval) is refused, so a message alone changes nothing. Reopen the mission from the Overview first.
        </Banner>
      ) : null}
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="send-to">To</label>
          <Input id="send-to" list="send-to-list" placeholder="Choose an agent" required autoComplete="off" value={to} onChange={(e) => setTo(e.target.value)} aria-describedby="send-to-hint" />
          <datalist id="send-to-list">{ids.map((i: string) => <option key={i}>{i}</option>)}</datalist>
          {/* One chip per seat, each adding or taking out its name in the field above, so nobody has to type an id. There is no
              "everyone": the server takes "all" as a name and puts it in no seat's mailbox. */}
          {ids.length ? (
            <div className="chips send-chips" role="group" aria-label="Recipients">
              {ids.map((id: string) => {
                const on = picked.includes(id);
                return (
                  <button key={id} type="button" className={`chip-toggle${on ? " on" : ""}`} aria-pressed={on} onClick={() => setTo(toggleRecipient(to, id, ids))}>
                    <Icon name={on ? "check" : "plus"} size={12} />{id}
                  </button>
                );
              })}
            </div>
          ) : null}
          <span id="send-to-hint" className="muted" style={{ fontSize: 12 }}>
            {ids.length ? "Pick the agents, or type their names separated by commas." : "To write to several agents, separate their names with commas."}
          </span>
        </div>
        <div className="field"><label htmlFor="send-type">What is this?</label><Select id="send-type" value={type} onChange={(e) => setType(e.target.value)}>{(vocab?.messageTypes || ["INFORM", "MISSION", "REQUEST", "REQUEST_REVIEW", "ESCALATE", "DONE"]).map((t: string) => <option key={t} value={t} title={t}>{messageTypeLabel(t)}</option>)}</Select></div>
        {advanced ? (
          <div className="field"><label htmlFor="send-payload">Message (JSON)</label><TextArea id="send-payload" rows={4} mono spellCheck={false} value={payload} onChange={(e) => setPayload(e.target.value)} /></div>
        ) : (
          <div className="field"><label htmlFor="send-note">Message</label><TextArea id="send-note" rows={4} placeholder="Say it in plain words" required value={note} onChange={(e) => setNote(e.target.value)} /></div>
        )}
        <label className="chk"><input type="checkbox" checked={advanced} onChange={(e) => setAdvanced(e.target.checked)} /> Send a raw JSON payload instead</label>
        <label className="chk"><input type="checkbox" checked={wake} onChange={(e) => setWake(e.target.checked)} /> Run them right after sending</label>
        <div className="row">
          <Button variant="primary" type="submit" disabled={sending}>{sending ? "Sending…" : "Send"}</Button>
          <span className={`form-out${out && !out.ok ? " bad" : ""}`} role={out && !out.ok ? "alert" : "status"}>{out?.text ?? ""}</span>
        </div>
      </form>
    </>
  );
}

export function ApprovalDrawer(): React.JSX.Element {
  const { status, toast, refreshStatus, client } = useMesh();
  const subjects = ["architecture", "implementation", "quality", "security", "requirements", "release"];
  const [arts, setArts] = useState<any[]>([]);
  const [kind, setKind] = useState("approve");
  const [subject, setSubject] = useState("");
  const [comment, setComment] = useState("");
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    client.api("GET", "/artifacts").then(({ json }) => {
      if (Array.isArray(json)) setArts(json.slice().reverse());
    }).catch(() => undefined);
  }, [client]);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (sending) return;
    setSending(true);
    setOut(null);
    try {
      const { status: st, json } = await client.post("/approvals", { kind, subject, comment: comment || undefined });
      if (st === 200) {
        // Cleared so the next decision can be typed straight away: several criteria are often answered in one sitting.
        setOut({ ok: true, text: `Recorded: ${kind} ${subject}.` });
        toast("Recorded", `${kind} ${subject}`, "ok");
        setSubject("");
        setComment("");
      } else {
        setOut({ ok: false, text: `Could not record it: ${json?.reason ?? `the server answered ${st}`}` });
      }
    } catch {
      setOut({ ok: false, text: "The server did not answer. Try again." });
    } finally {
      setSending(false);
    }
    void refreshStatus();
  };
  return (
    <>
      <h2 id="drawer-title">Approve or reject <CloseX /></h2>
      <p className="muted" style={{ marginTop: 0 }}>Record a decision that a gate may be waiting for, such as approving the release. It goes in the log.</p>
      <form className="stack" onSubmit={submit}>
        <div className="field"><label htmlFor="appr-kind">Decision</label><Select id="appr-kind" value={kind} onChange={(e) => setKind(e.target.value)}><option value="approve">Approve</option><option value="reject">Reject</option><option value="accept">Accept</option></Select></div>
        <div className="field">
          <label htmlFor="appr-subject">What it is about</label>
          <Input id="appr-subject" list="subj" placeholder="release" required autoComplete="off" value={subject} onChange={(e) => setSubject(e.target.value)} aria-describedby="appr-subject-hint" />
          <datalist id="subj">{[...subjects, ...((status?.goal?.acceptanceCriteria || []).map((c: any) => `criterion:${c.id}`))].map((s: string) => <option key={s}>{s}</option>)}</datalist>
          <span id="appr-subject-hint" className="muted" style={{ fontSize: 12 }}>A gate reads this name exactly. Pick one from the list or type your own.</span>
        </div>
        <div className="field"><label htmlFor="appr-comment">Reason (optional)</label><Input id="appr-comment" placeholder="One line, kept in the log" value={comment} onChange={(e) => setComment(e.target.value)} /></div>
        {arts.length > 0 && <div className="muted" style={{ fontSize: 12 }}>Files made recently: {arts.slice(0, 3).map((a) => a.name).join(", ")}</div>}
        <div className="row">
          <Button variant="primary" type="submit" disabled={sending}>{sending ? "Recording…" : "Record the decision"}</Button>
          <span className={`form-out${out && !out.ok ? " bad" : ""}`} role={out && !out.ok ? "alert" : "status"}>{out?.text ?? ""}</span>
        </div>
      </form>
    </>
  );
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
  const { toast, closeDrawer, openDrawer, openDetail, steps: allSteps, lastSeq, client, confirm } = useMesh();
  const { streams } = useMeshStreams();
  // The events console is where an event can be read properly now, so this feed
  // hands off to it rather than stacking a third drawer on top of this one.
  // `closeDrawer` is a no-op when this drawer came from the route instead of the
  // stack — `slice(0, -1)` of an empty stack is an empty stack — and the
  // `openDetail` below replaces the routed agent detail in that case anyway.
  const seeEvent = (seq: number): void => {
    closeDrawer();
    openDetail("event", String(seq), "events");
  };
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
        const { json: j } = await client.api("GET", `/agents/${encodeURIComponent(id)}?limit=10`, undefined, { timeoutMs: 45000 });
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
  }, [id, client]);
  // Nudge a refresh as soon as the log moves, instead of waiting out the poll.
  useEffect(() => {
    lastLoad.current = 0;
  }, [lastSeq]);
  // This used to toast and close the drawer *during render* — a side effect in
  // a render body, which React may run twice, and which yanked the panel out
  // from under the reader before they could see why. The drawer now stays open
  // and says what broke; the reader decides when to leave.
  const failed = Boolean(json?.error);
  useEffect(() => {
    if (failed) toast("Could not open the agent", String(json.error) || "It was not found.", "bad");
  }, [failed, json?.error, toast]);
  if (!json) return <div className="muted">loading…</div>;
  if (failed) {
    const unreachable = json.error === "unreachable";
    return (
      <>
        <h2 id="drawer-title">{(id)}<CloseX /></h2>
        <ErrorState
          what={`agent ${id}`}
          detail={unreachable ? "the mesh server did not answer. The agent may still be running." : String(json.error)}
          onRetry={unreachable ? () => {
            lastLoad.current = 0;
            setJson(null);
          } : undefined}
        />
        <div className="row" style={{ marginTop: 8 }}><Button variant="small" onClick={closeDrawer}>close</Button></div>
      </>
    );
  }
  const d = json.definition, s = json.state;
  // A pause that would stop a turn in progress asks first; every answer is worded in agents.ts.
  const act = (a: string): void => {
    void (async () => {
      if (a === "suspend" && !(await confirmPause(confirm, id, RUNNING.has(s.lifecycle)))) return;
      await agentAction(client, id, a, toast);
    })();
  };
  const unreadFull: any[] = Array.isArray(json.unreadMessages) ? json.unreadMessages : [];
  const unreadCount: number = Array.isArray(json.unread) ? json.unread.length : unreadFull.length;
  const steps: any[] = Array.isArray(json.recentSteps) ? json.recentSteps : [];
  const recentMsgs: any[] = Array.isArray(json.recentMessages) ? json.recentMessages : [];
  const tasks: any[] = Array.isArray(json.tasksInvolved) ? json.tasksInvolved : [];
  const plan: any = json.plan ?? null;
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
        toolFrames: current?.toolFrames ?? 0,
        toolCallCount: current?.toolCallCount,
        running: true,
        startedAt: current?.startedAt,
      })
    : null;
  // The step row carries the stops at top level as well as inside `phases`;
  // either is enough for the bar.
  const currentStops: DeadlineInput | undefined = current
    ? { ...current.phases, deadlineAt: current.deadlineAt ?? current.phases?.deadlineAt, ceilingAt: current.ceilingAt ?? current.phases?.ceilingAt }
    : undefined;
  const signalCount = approvals.length + decisions.length + escalations.length + pending.length;
  return (
    <>
      <h2 id="drawer-title"><AgentAvatar id={id} color="var(--accent)" />{(id)}
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
          <div className="esc-next"><b>Next:</b> <span className="muted">retry it once, or open its last step for the failing call.</span> <Button variant="small" onClick={() => act("wake")}>Retry one step</Button></div>
        </>
      ) : null}
      {/* Only what the kernel would accept for an agent in this state, and one sentence on what it does. */}
      <div className="ag-controls">
        {controlsOf(s.lifecycle).map((c) => <Button key={c.id} variant="small" title={c.title} onClick={() => act(c.id)}>{c.label}</Button>)}
      </div>
      <p className="ag-hint">{controlsHint(s.lifecycle, vitals?.health === "stalled")}</p>

      <Tabs
        idPrefix="agent"
        label="agent detail sections"
        tabs={AGENT_TABS.map((t) => ({
          ...t,
          badge: t.id === "comms" && unreadCount ? unreadCount : t.id === "now" && signalCount ? signalCount : undefined,
          badgeHot: t.id === "now",
        }))}
        value={tab}
        onChange={(id) => setTab(id as AgentTab)}
      />

      {tab === "now" ? (
        <TabPanel idPrefix="agent" id="now">
          {json.currentTurnId && vitals ? (
            <>
              <VitalsStrip v={vitals} model={current?.model ?? d.model} attempt={current?.attempt} />
              <NowLine tool={current?.currentTool} />
              <DeadlineBar turnId={String(json.currentTurnId)} phases={currentStops} />
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
                  : `Not running (${plainLifecycle(s.lifecycle)}).`}
            </div>
          )}
          {json.activeTask ? <div className="now-task"><b>Working on:</b> {(String(json.activeTask.title ?? json.activeTask.id).slice(0, 90))} <Chip>{(json.activeTask.status)}</Chip></div> : null}
          {signalCount || leases.length ? (
            <>
              <h3>Signals</h3>
              {escalations.length ? <div className="sig bad">{escalations.length} escalation{escalations.length > 1 ? "s" : ""} — latest [{(escalations[0].reason)}] {(escalations[0].status)}</div> : null}
              {pending.length ? <div className="sig warn">{pending.length} open request{pending.length > 1 ? "s" : ""} waiting on an answer</div> : null}
              {approvals.length ? <div className="sig">{approvals.length} approvals — latest {(approvals[0].kind)} {(approvals[0].subject)}</div> : null}
              {decisions.length ? <div className="sig">{decisions.length} decisions proposed — latest “{(String(decisions[0].topic ?? "").slice(0, 60))}”</div> : null}
              {leases.length ? <div className="sig">{leases.filter((l: any) => l.active).length} active file locks{leases[0] ? ` — ${(String(leases[0].artifactId).slice(0, 20))}` : ""}</div> : null}
            </>
          ) : null}
          {evs.length ? (
            <>
              <h3>Just happened<ZoneNote /></h3>
              <div className="ev-list">{evs.slice(0, 6).map((e: any) => (
                <div className="ev" key={e.seq} data-seq={e.seq} role="button" tabIndex={0} onClick={() => seeEvent(e.seq)} onKeyDown={rowKey(() => seeEvent(e.seq))}>
                  <time>{hhmmss(e.at)}</time><span className="type">{(plainEvent(e.type))}</span><span className="summary">{(e.summary)}</span>
                </div>
              ))}</div>
            </>
          ) : null}
        </TabPanel>
      ) : null}

      {tab === "work" ? (
        <TabPanel idPrefix="agent" id="work">
          <h3>Recent steps {steps.length ? `(${steps.length})` : ""}</h3>
          {steps.length ? (
            <div className="steps-mini">{steps.slice(0, 12).map((st: any) => <StepMini key={st.turnId} s={st} onOpen={openStep} />)}</div>
          ) : <div className="muted">No steps yet — wake it to run once.</div>}
          {plan && plan.steps?.length ? (
            <>
              <h3>
                Its plan {planLabel(plan)}
                {planStale(plan, json.activeTask?.id) ? <> <Chip warn>stale</Chip></> : null}
              </h3>
              <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>
                Private to this agent — other agents cannot see or claim these steps.
              </div>
              <div>{plan.steps.map((s: any) => (
                <div key={s.id} style={{ fontSize: 13, margin: "4px 0" }}>
                  <span className="mono muted">{s.status === "DONE" ? "☑" : "☐"}</span>{" "}
                  <span style={{ opacity: s.status === "DONE" ? 0.55 : 1 }}>{String(s.text ?? "").slice(0, 120)}</span>
                  {(s.capabilities ?? []).length ? <> <Chip>{s.capabilities.join(", ")}</Chip></> : null}
                </div>
              ))}</div>
            </>
          ) : null}
          {tasks.length || json.activeTask ? (
            <>
              <h3>Tasks {tasks.length ? `(${tasks.length})` : ""}</h3>
              <div>{tasks.slice(0, 12).map((t: any) => <div key={t.id} style={{ fontSize: 13, margin: "4px 0" }}><span className="mono muted">{(String(t.id).slice(0, 8))}</span> {(String(t.title ?? "").slice(0, 70))} <Chip>{(t.status)}</Chip></div>)}</div>
            </>
          ) : null}
          {arts.length ? (
            <>
              <h3>Files {`(${arts.length})`}</h3>
              <div>{arts.slice(0, 12).map((a: any) => <div key={a.id} className="ev" role="button" tabIndex={0} onClick={() => openDrawer(<ArtifactDrawer id={a.id} />)} onKeyDown={rowKey(() => openDrawer(<ArtifactDrawer id={a.id} />))}><time>v{a.version}</time><span className="type">{(plainArtifact(a.status))}</span><span className="summary">{(a.name)} · {(a.type)}</span></div>)}</div>
            </>
          ) : <div className="muted">It has not produced any files.</div>}
        </TabPanel>
      ) : null}

      {tab === "comms" ? (
        <TabPanel idPrefix="agent" id="comms">
          <h3>Inbox {unreadCount ? `(${unreadCount} unread)` : ""}<ZoneNote /></h3>
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
              <h3>Recent messages<ZoneNote /></h3>
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
              <h3>Threads {`(${threads.length})`}</h3>
              <div>{threads.slice(0, 10).map((t: any) => <div key={t.id} style={{ fontSize: 13, margin: "4px 0" }}>“{(String(t.subject ?? "").slice(0, 60))}” <span className="muted">· {t.messageCount} msgs · {((t.participants || []).join(", "))}</span></div>)}</div>
            </>
          ) : null}
        </TabPanel>
      ) : null}

      {tab === "memory" ? (
        <TabPanel idPrefix="agent" id="memory">
          <h3>Memory {mem.length ? `(${mem.length})` : ""}</h3>
          {mem.length
            ? <div>{mem.map((n: any) => <div key={n.key} className="mem-row"><span className="mono">{(n.key)}</span> <span className="muted">— {(String(n.value ?? "").slice(0, 400))}</span></div>)}</div>
            : <div className="muted">No notes yet. Agents write here when they use the remember op.</div>}
        </TabPanel>
      ) : null}

      {tab === "config" ? (
        <TabPanel idPrefix="agent" id="config">
          <h3>What it does</h3>
          <div>{(d.capabilities || []).length ? (d.capabilities || []).map((c: string) => <Chip key={c}>{(c)}</Chip>) : <span className="muted">—</span>}</div>
          {(d.authority || []).length ? <div style={{ marginTop: 6 }}><span className="muted" style={{ fontSize: 12 }}>Can decide:</span> {(d.authority || []).map((c: string) => <Chip key={c} hot>{(c)}</Chip>)}</div> : null}
          <h3>Setup</h3>
          <table className="tbl"><tbody>
            <tr><td>runtime</td><td className="mono">{(d.runtime)}{d.model ? ` · ${(d.model)}` : ""}</td></tr>
            {/* Off is the default everywhere, so it is the common case and worth
                stating outright rather than leaving the operator to infer it
                from an absent row. */}
            <tr><td>plan gate</td><td>
              {d.hardActions && d.hardActions.mode !== "off" ? (
                <>
                  <Chip hot>{(d.hardActions.mode)}</Chip>
                  {(d.hardActions.capabilities || []).map((c: string) => <Chip key={c}>{(c)}</Chip>)}
                </>
              ) : <span className="muted">off — it may act without a plan</span>}
            </td></tr>
            <tr><td>listens for</td><td>{(d.interests || []).length ? (d.interests || []).slice(0, 12).map((c: string) => <Chip key={c}>{(c)}</Chip>) : <span className="muted">—</span>}</td></tr>
            <tr><td>budget</td><td className="mono">{fmt(d.budget?.tokens ?? 0)} tokens{json.budgets?.mission ? ` · mission ${fmt(json.budgets.mission.consumed)} / ${json.budgets.mission.limit ?? "?"}` : ""}</td></tr>
            {json.communication ? <tr><td>contacts</td><td style={{ fontSize: 12 }}>→ {((json.communication.mayContact || []).join(", ") || "nobody new")}<br />← {((json.communication.mayBeContactedBy || []).join(", ") || "restricted")}</td></tr> : null}
            {json.session ? <tr><td>session</td><td className="mono">{(json.session.sessionId)} ({(json.session.runtime)})</td></tr> : null}
            {json.stats ? <tr><td>totals</td><td className="mono" style={{ fontSize: 12 }}>{json.stats.messagesSent} sent · {json.stats.messagesReceived} received · {json.stats.artifactsCreated} files</td></tr> : null}
          </tbody></table>
        </TabPanel>
      ) : null}
    </>
  );
}

/* The action ledger — the tool→op vocabulary, op titles, effect pairing — is
   DOM-free in ledger.ts so node:test can cover it. Re-exported here because
   stepview.tsx types its rows against this module. */
export { matchOpEffects, type OpRow } from "./ledger";

/**
 * `routed` means this drawer is the URL's detail layer, so walking to another
 * turn moves the URL (Back and a shared link stay honest). Opened with
 * `openDrawer` instead — from Overview or an agent — it sits on top of the
 * detail layer, so moving the URL would change a panel nobody can see; there
 * the walk stays local to this drawer.
 */
export function StepDrawer({ turnId: openedId, steps, routed }: { turnId: string; steps: any[]; routed?: boolean }): React.JSX.Element {
  const { openDrawer, openDetail, closeDrawer, drawerDepth, view, setView, events, client, stepLimit, setStepLimit, refreshSteps } = useMesh();
  const { streams } = useMeshStreams();
  const [walked, setWalked] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  useEffect(() => { setWalked(null); }, [openedId]);
  const turnId = walked ?? openedId;
  // The record on screen, tagged with the turn it belongs to. Walking keeps
  // the previous step up (dimmed) until the next one arrives, instead of
  // flashing the skeleton on every j/k; `vid` is the turn actually shown.
  const [data, setData] = useState<{ id: string; json: any } | null>(null);
  const json = data?.json ?? null;
  const vid = data?.id ?? turnId;
  const pending = data != null && data.id !== turnId;
  // A live turn whose poll failed: the page keeps its last good record and
  // says so, rather than freezing on "Working" with no sign anything broke.
  const [stale, setStale] = useState(false);
  const narrow = useStepMedia(STEP_NARROW);
  const [sel, setSel] = useState<Sel>(null);
  // The drawer, not the window, is the scroll container the jump nav observes.
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  // Past the top, the header drops its reason line: five sticky rows ate a
  // third of a laptop screen. Hysteresis (80 in, 8 out) keeps the height
  // change from pushing scrollTop back across the threshold.
  const [stuck, setStuck] = useState(false);
  useEffect(() => { setScroller(document.getElementById("drawer")); }, []);
  useEffect(() => {
    if (!scroller) return;
    const on = (): void => setStuck((s) => (s ? scroller.scrollTop > 8 : scroller.scrollTop > 80));
    scroller.addEventListener("scroll", on, { passive: true });
    return () => scroller.removeEventListener("scroll", on);
  }, [scroller]);
  // The row that opened the inspector, so clearing it hands focus back — and,
  // on the single-column layout, scrolls the reader back to where they were.
  const origin = useRef<HTMLElement | null>(null);
  const select = useCallback((s: Sel): void => {
    if (s) {
      const a = document.activeElement;
      origin.current = a instanceof HTMLElement && a !== document.body ? a : null;
      setSel(s);
      return;
    }
    setSel(null);
    const o = origin.current;
    origin.current = null;
    if (o?.isConnected) o.focus();
  }, []);
  // A different turn is a different subject: keep no stale selection across it.
  useEffect(() => {
    setSel(null);
    origin.current = null;
  }, [turnId]);
  // Walking lands at the top of the next step, not mid-way down its events —
  // once that step is on screen, not while the previous one is still shown.
  useEffect(() => {
    setSel(null);
    origin.current = null;
    document.getElementById("drawer")?.scrollTo({ top: 0 });
  }, [vid]);
  // The sticky header's height varies (metrics and the jump nav wrap), and the
  // inspector's sticky offset and every section's scroll margin hang off it.
  // Hardcoded, a wrapped header slid over both.
  const measureHead = useCallback((el: HTMLElement | null) => {
    const root = el?.parentElement;
    if (!el || !root) return;
    const ro = new ResizeObserver(() => root.style.setProperty("--sv-head-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wasRunning = false;
    setStale(false);
    const load = async (): Promise<"running" | "done" | "error"> => {
      try {
        const { json: j } = await client.api("GET", `/turns/${encodeURIComponent(turnId)}`, undefined, { timeoutMs: 15000 });
        if (dead) return "done";
        setData({ id: turnId, json: j });
        setStale(false);
        return (j as any)?.turn?.status === "running" ? "running" : "done";
      } catch {
        if (dead) return "done";
        setData((prev) => (prev && prev.id === turnId ? prev : { id: turnId, json: { error: true } }));
        if (wasRunning) setStale(true);
        return "error";
      }
    };
    // While the agent is still working, two live channels feed this drawer:
    // token frames over SSE (see streams in store) for instant output, plus
    // this poll as the fallback that also delivers completion + op effects.
    // One request at a time, re-armed only after the last one settles: a
    // fixed interval stacked requests behind a slow server and refetched every
    // finished turn once for nothing. A failed poll of a live turn backs off
    // and retries instead of ending the poll for good.
    const tick = async (): Promise<void> => {
      const r = await load();
      if (dead) return;
      if (r === "running") wasRunning = true;
      if (r === "running" || (r === "error" && wasRunning)) {
        timer = setTimeout(() => void tick(), r === "error" ? 4000 : 1500);
      }
    };
    void tick();
    return () => {
      dead = true;
      if (timer) clearTimeout(timer);
    };
  }, [turnId, client]);

  // Prev/next walk the same list the Steps view shows. A turn that is not in
  // it — a deep link or a causal hop to something older than the loaded
  // page — is placed among the loaded steps by when it started, once its own
  // record is here to say when that was. It used to read "—" with both
  // arrows dead.
  const list: any[] = steps || [];
  const place = placeStep(list, turnId, data?.id === turnId ? json?.turn?.startedAt : undefined);
  const goTo = (id: string): void => {
    if (routed) openDetail("step", id);
    else setWalked(id);
  };
  const goStep = (d: number): void => {
    const id = d > 0 ? place.older : place.newer;
    if (id) goTo(id);
  };
  // A turn older than everything loaded can have the list grown under it, the
  // way the Steps view's own "Load 60 older turns" does. Only for the routed
  // drawer, which walks the store's list, and only over the Steps view, which
  // keeps refetching at the store's limit (the Overview refetches six, and
  // would shrink it straight back). A list shorter than the limit already
  // holds everything the server has.
  const canLoadOlder = Boolean(routed) && view === "steps" && place.where === "older-than-list"
    && list.length >= stepLimit && stepLimit < STEPS_MAX;
  const loadOlder = (): void => {
    setLoadingOlder(true);
    setStepLimit(Math.min(STEPS_MAX, stepLimit + 60));
    void refreshSteps(true).finally(() => setLoadingOlder(false));
  };
  // The shell's key router swallows every key but Esc while a panel is open,
  // so the step view owns its own: j/k walk (the one action a reader repeats),
  // and Esc clears the inspector before it is allowed to close the drawer.
  // Capture phase + preventDefault is the documented way for an inner layer to
  // claim a key ahead of the shell (see CommandPalette in shell.tsx).
  const keys = useRef({ sel, select, goStep });
  keys.current = { sel, select, goStep };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      // A confirm dialog stacked over the step owns the keyboard.
      if (!isTopTrap(document.getElementById("drawer"))) return;
      const t = ev.target as HTMLElement | null;
      if (t?.matches?.("input, textarea, select")) return;
      const k = keys.current;
      if (ev.key === "Escape" && k.sel) {
        ev.preventDefault();
        k.select(null);
      } else if (ev.key === "j" || ev.key === "k") {
        ev.preventDefault();
        k.goStep(ev.key === "j" ? 1 : -1);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  const listStep: TurnStep | undefined = (steps || []).find((x: any) => x.turnId === vid);
  const sbx = useSandboxPerms(json?.turn?.agentId ?? listStep?.agentId);

  // Before an unlisted turn's record arrives there is nothing to place it by
  // yet; "not in list" would be a verdict on a question not yet asked.
  const where = place.where === "unplaced" && data?.id !== turnId && list.length
    ? { text: "…", title: "placing this step among the loaded ones" }
    : placeLabel(place, list.length);
  const walker = (
    <div className="sv-walk">
      <Button variant="ghost" disabled={!place.newer} onClick={() => goStep(-1)} title="Newer step (k)" aria-label="Newer step">‹</Button>
      <span className="sv-walk-n mono" title={where.title}>{where.text}</span>
      <Button variant="ghost" disabled={!place.older} onClick={() => goStep(1)} title="Older step (j)" aria-label="Older step">›</Button>
      {canLoadOlder ? (
        <Button variant="linklike" extra="sv-walk-more" disabled={loadingOlder} onClick={loadOlder} title={`load the next ${Math.min(60, STEPS_MAX - stepLimit)} older steps into the list (the server returns at most ${STEPS_MAX})`}>
          {loadingOlder ? "loading…" : "load older"}
        </Button>
      ) : null}
    </div>
  );

  if (!json) return <StepSkeleton close={<CloseX />} />;
  const shell = `stepv${pending ? " pending" : ""}`;
  if (json.error || (!json.turn && (json.events || []).length === 0)) {
    // One message, in place. The toast that used to fire alongside it said the
    // same thing a second time, somewhere else, and outlived the drawer. A dead
    // end with no way on is what a mistyped or stale link used to be, so the
    // two moves a reader actually wants are offered right here.
    if (!listStep) {
      const newest = (steps || [])[0]?.turnId as string | undefined;
      const allSteps = (): void => {
        if (drawerDepth > 0) closeDrawer();
        setView("steps");
      };
      return (
        <div className={shell} aria-busy={pending || undefined}>
          <div className="sv-head">
            <div className="sv-topbar">{walker}<CloseX /></div>
            <div className="sv-ident"><div className="sv-who"><b id="drawer-title">Step not found</b><span className="sv-id mono" title={vid}>turn-{shortTurn(vid)}</span></div></div>
          </div>
          <div className="step-empty sv-gone">
            <b>No step with this id is in the log.</b>
            <span>A mission reset may have cleared it, or the link is mistyped.</span>
            <div className="sv-gone-actions">
              {newest && newest !== vid ? <Button variant="soft" onClick={() => goTo(newest)}>open the newest step</Button> : null}
              <Button variant="ghost" onClick={allSteps}>back to all steps</Button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className={shell} aria-busy={pending || undefined}>
        <div className="sv-head">
          <div className="sv-topbar">{walker}<CloseX /></div>
          <div className="sv-ident">
            <AgentAvatar id={listStep.agentId || "?"} color={agentColor(listStep.agentId || "?")} />
            <div className="sv-who">
              <b id="drawer-title">{(listStep.agentId || "step")}</b>
              <span className="sv-id mono" title={vid}>turn-{shortTurn(vid)}{listStep.startedAt ? ` · ${ago(listStep.startedAt)}` : ""}</span>
            </div>
            <StatusPillOf status={listStep.status} ops={listStep.ops} />
          </div>
          <p className="sv-why"><span className="sv-why-k">{(plainReason(listStep.reasonKind))}</span></p>
          <div className="sv-metrics">
            {listStep.durationMs != null ? <span>{dur(listStep.durationMs)}</span> : null}
            {listStep.tokens != null ? <span>{fmt(listStep.tokens)} tok</span> : null}
          </div>
        </div>
        <div className="step-empty sv-gone">
          <b>Only this step's summary is left.</b>
          <span>The full record has aged out of the server's recent-turn window, or the server did not answer — reasoning, actions and events are no longer available here.</span>
        </div>
        <details className="sv-fold">
          <summary>list entry (JSON)</summary>
          <JsonBlock value={listStep} />
        </details>
      </div>
    );
  }
  const t = json.turn || {};
  const isRunning = t.status === "running";
  // Live timeline: stored entries plus SSE events for this turn that arrived
  // after the fetch (deduped by seq). Keeps "what happened" fresh while open.
  const storedTl: any[] = Array.isArray(json.timeline) ? json.timeline : [];
  const liveExtra: any[] = (events || [])
    .filter((e: any) => e.correlationId === vid && !storedTl.some((s: any) => s.seq === e.seq))
    .map((e: any) => ({ seq: e.seq, at: e.timestamp, type: e.type, actor: e.actorId, summary: e.summary, id: e.id, correlationId: e.correlationId, causationId: e.causationId, payload: e.payload }));
  const timeline = [...storedTl, ...liveExtra].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const elapsed = isRunning && t.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(t.startedAt)) / 1000)) : null;
  // Live text: SSE token frames are freshest, but the polled turn carries the
  // same deltas via the server-side buffer — whichever is longer wins, so a
  // dropped SSE frame degrades to polling instead of losing content.
  const streamText = streams[vid]?.text ?? "";
  const liveText = isRunning ? (streamText.length >= (t.text?.length ?? 0) ? streamText : (t.text ?? "")) : "";
  const liveChars = isRunning ? Math.max(streamText.length, t.text?.length ?? 0, streams[vid]?.chars ?? 0) : 0;
  // Structured ops (intent) + landed effects (reality), matched in execution
  // order. Answers "did the step work?" without reading raw JSON. The rows are
  // the kernel's complete op list, not the captured tool calls: the runtime
  // keeps arguments for only the first few calls of a turn, of ANY tool, so a
  // turn that read and edited first used to show 13 of its 23 ops and drop
  // the rest without a word. See buildLedger in ledger.ts.
  const toolCalls: any[] = Array.isArray(t.toolCallsDetail) ? t.toolCallsDetail : [];
  // What the turn is doing while it does it: its own tool calls, files, tokens
  // and advisories, from the polled record (which survives a reload). The SSE
  // stream only adds what arrived since the last poll. A failed turn keeps the
  // record — it has no `toolCallsDetail`, which is written on success only.
  const work = liveWorkOf(t);
  const workTools = isRunning ? mergeLiveTools(work.liveTools, streams[vid]?.tools) : work.liveTools;
  const summaryIsOps = typeof t.summary === "string" && /^\s*[\[{]/.test(t.summary) && t.summary.includes('"op"');
  const ledger = buildLedger({ ops: t.ops, opTimings: t.opTimings ?? listStep?.opTimings, toolCalls, timeline });
  const opRows = ledger?.rows ?? null;
  const tally = opRows ? ledgerTally(opRows) : null;
  // A live op is a ledger row's `op`, so it takes the row's head: that one
  // read argument sizes from the clip map and was named from its effect.
  const heads = (o: any) => opRows?.find((r) => r.op === o)?.head ?? opHead(o, { names: ledger?.names });
  // The split is on the raw `TurnRecord` while the turn is still in the
  // tracker's ring; once it has aged out, the log-reconstructed step carries the
  // same figures, so fall back to it instead of losing the bar and the cached
  // share — which is the one number that says whether a seat is re-reading its
  // transcript or starting cold.
  const tokIn = typeof t.tokensInput === "number" ? t.tokensInput : listStep?.tokensInput;
  const tokOut = typeof t.tokensOutput === "number" ? t.tokensOutput : listStep?.tokensOutput;
  const tokCached = typeof t.tokensCacheRead === "number" ? t.tokensCacheRead : listStep?.tokensCacheRead;
  // Thinking is billed inside `out` at the same rate as text the seat actually
  // said, so a turn that looks expensive to WRITE may have been expensive to
  // DECIDE — opposite fixes. Rendered only where the backend reported it;
  // absent it simply does not appear, rather than showing a 0 nobody measured.
  const tokThinking = typeof t.tokensThinking === "number" ? t.tokensThinking : listStep?.tokensThinking;
  const showSplit = typeof tokIn === "number" && typeof tokOut === "number"
    && tokIn >= 100 && (tokIn + tokOut) >= (t.tokens ?? listStep?.tokens ?? 0) * 0.3;
  const splitText = showSplit
    ? `in ${fmt(tokIn ?? 0)} fresh · out ${fmt(tokOut ?? 0)}${typeof tokThinking === "number" ? ` (${fmt(tokThinking)} thinking)` : ""}${tokCached ? ` · ${fmt(tokCached)} replayed from cache` : ""}`
    : null;
  // Phase marks are live-only; a turn evicted from the server's ring has none,
  // in which case the rail and parts of the vitals simply do not render.
  const phases: TurnPhases | undefined = t.phases ?? listStep?.phases;
  // The stops for the deadline bar: the record's own, else the list row's.
  const stops: DeadlineInput | undefined = phases || listStep?.deadlineAt !== undefined
    ? { ...phases, deadlineAt: phases?.deadlineAt ?? listStep?.deadlineAt, ceilingAt: phases?.ceilingAt ?? listStep?.ceilingAt }
    : undefined;
  const buf = streams[vid];
  const vitals = vitalsOf({
    phases,
    clientChars: Math.max(buf?.chars ?? 0, liveChars),
    clientUpdatedAt: buf?.updatedAt,
    toolFrames: t.toolFrames ?? listStep?.toolFrames ?? 0,
    toolCallCount: work.toolCallCount ?? listStep?.toolCallCount,
    running: isRunning,
    startedAt: t.startedAt,
  });
  // The sticky header's one-word version of the deadline bar.
  const deadline = isRunning ? deadlineOf(stops, Date.now(), firstDeadline(vid, stops?.deadlineAt)) : null;
  const base = baselineOf(steps || [], t.agentId);
  const links = causalLinks(vid, events || [], steps || []);
  // Live view: the ops are the tool calls recorded so far (a running turn has
  // no kernel op list yet). The streamed text is shown once, in the live
  // viewport — never parsed for ops.
  const liveOps: any[] | null = isRunning ? (opRows ?? []).map((r) => r.op) : null;

  const attempt = t.attempt ?? listStep?.attempt;
  const inShare = showSplit ? Math.round(((tokIn ?? 0) / Math.max(1, (tokIn ?? 0) + (tokOut ?? 0))) * 100) : null;
  const cachedShare = showSplit && tokCached && tokCached > 0
    ? Math.round((tokCached / Math.max(1, (tokIn ?? 0) + (tokOut ?? 0) + tokCached)) * 100)
    : null;
  // "17m 3s", not "1023s": a long turn is exactly the one someone is watching.
  const durText = isRunning ? (elapsed !== null ? ageText(elapsed * 1000) : "—") : (t.durationMs != null ? dur(t.durationMs) : "—");
  const liveTokens = isRunning ? work.liveTokens ?? listStep?.liveTokens : undefined;
  // Outcome-shaped state: raw "waiting" reads like "stuck", so the status
  // block classifies the turn and always answers why and what happens next.
  //
  // What the turn produced comes from the drawer's own evidence, best first:
  // the server's step for this turn, then this turn's own events counted into
  // the same buckets, and the Steps list entry only when neither exists. The
  // list entry used to win outright, and it is zero-filled for a turn rebuilt
  // without its effects — so a turn that published eight artifacts, next to
  // the one op the kernel refused, was headlined "Refused".
  const outcomeInput: OutcomeInput = {
    status: t.status || "running",
    ops: json.step?.ops ?? producedFromTimeline(timeline) ?? listStep?.ops,
    opTimings: t.opTimings ?? listStep?.opTimings,
  };
  const outcome = outcomeOf(outcomeInput);
  const produced = opsSummary(outcomeInput);
  const state = stateMeta(outcome, t.status || "running", produced);
  // The drawer answered "did this turn do anything?" twice from two unrelated
  // facts: Reasoning read the ops, Outcome read `t.text`. On a turn that
  // messaged and decided without writing ops, both empty states fired and
  // contradicted each other under a header reading "produced". Neither
  // question is about `t.text`, so both now read these two signals.
  const wroteOps = Boolean(opRows?.length) || Boolean(liveOps?.length);
  const leftEffects = producedCount(outcomeInput) > 0;
  // Only the wake note: the summary is Reasoning's, and a crash's message is
  // the error panel's, both directly beside this card.
  const why = typeof t.reason?.note === "string" ? t.reason.note.trim() : "";

  // The summary is two voices in one string: the kernel's verdicts on the turn
  // (verified — it counted the refusals itself) and the model's account of it
  // (not verified). Rendered whole under "narration · not verified" the
  // kernel's half was disowned. A record that carries them apart is used as
  // is; an older one is split on the supervisor's own markers.
  const split = Array.isArray(t.notices) || typeof t.modelSummary === "string"
    ? null
    : typeof t.summary === "string" && !summaryIsOps ? splitSummary(t.summary) : null;
  const notices: string[] = Array.isArray(t.notices)
    ? t.notices.filter((n: unknown): n is string => typeof n === "string" && n.trim().length > 0)
    : split?.notices ?? [];
  // The model's own summary when there is one; otherwise the reply itself.
  // Showing only the summary told the reader "no narration" on turns whose
  // reply was all prose, while Outcome said the model wrote prose. A summary
  // that is just the reply's opening line (what a runtime reports when the
  // model declared none) loses to the reply it was cut from: "Here's what
  // happened:" followed by nothing is not a narration.
  const modelSummary = typeof t.modelSummary === "string" ? t.modelSummary.trim() : split?.model ?? "";
  const reply = typeof t.text === "string" ? t.text.trim() : "";
  const narration = modelSummary && !(reply.length > modelSummary.length && reply.startsWith(modelSummary.slice(0, 60)))
    ? modelSummary
    : reply || modelSummary;
  // Only offer a jump target for a section that actually rendered. A running
  // turn's narration is the live viewport; Reasoning takes over once it ends.
  const hasReasoning = !isRunning && Boolean(narration || notices.length || t.summary);
  // The header used to print the tracker's count while the list showed the
  // captured calls; when the two differ, the Tools section says so.
  const toolTotal = typeof t.toolCalls === "number" ? Math.max(t.toolCalls, toolCalls.length) : toolCalls.length;
  // A finished turn's live record, for what the Tools section cannot show: the
  // calls of a turn that died before its trace was written, the files it
  // touched, the warnings it was sent and where its uncommitted work went.
  const finishedWorkTools = toolCalls.length ? [] : work.liveTools;
  const showWork = !isRunning
    && Boolean(work.checkpoint || work.advisories.length || work.filesTouched.length || finishedWorkTools.length);
  // Capture loss, said once and quietly. With the kernel's op list every
  // action is on the ledger, some by name only; without it (a running turn,
  // an old record) the ledger IS the captured calls and may be short.
  const capture = !ledger
    ? null
    : ledger.source === "ops"
      ? ledger.captured < ledger.rows.length
        ? {
            text: `arguments captured for ${ledger.captured} of ${ledger.rows.length} actions`,
            title: `the runtime kept arguments for ${toolCalls.length} of ${toolTotal} tool calls; the other actions are listed by name, from the kernel's own record`,
            warn: false,
          }
        : null
      : !isRunning && toolCalls.length < toolTotal
        ? {
            text: `from the first ${toolCalls.length} of ${toolTotal} tool calls — later actions may be missing`,
            title: "this record has no kernel op list, so its actions are read from the captured tool calls, which the runtime truncates",
            warn: true,
          }
        : null;
  const refusedTitle = (opRows ?? [])
    .filter((r) => r.refusal)
    .map((r) => `${r.head.title}: ${r.refusal?.reason ?? "refused"}`)
    .join("\n");
  // Same order as the page: what it did before what it said about it.
  const sections: Section[] = [
    ...(isRunning ? [{ id: "sv-live", label: "Live" }] : []),
    { id: "sv-outcome", label: "Outcome", n: opRows ? opRows.length : undefined },
    ...(hasReasoning ? [{ id: "sv-reasoning", label: "Reasoning" }] : []),
    ...(toolTotal ? [{ id: "sv-tools", label: "Tools", n: toolTotal }] : []),
    ...(showWork ? [{ id: "sv-work", label: "Work", n: finishedWorkTools.length ? work.toolCallCount ?? finishedWorkTools.length : undefined }] : []),
    { id: "sv-events", label: "Events", n: timeline.length || undefined },
    ...(t.instructions ? [{ id: "sv-brief", label: "Brief" }] : []),
    { id: "sv-raw", label: "Raw" },
  ];

  // What the side column says when nothing is selected — the context a reader
  // wants before they pick a row, instead of a lone hint in an empty 340px.
  // Time and tokens are already in the sticky header; this column adds only
  // what the header cannot: the comparison with the agent's usual, and the
  // token split the header draws as a bar.
  //
  // Below four finished turns there is no "usual" worth quoting: a median of
  // two beside "too few to compare" stated a baseline and disowned it in the
  // same breath. BaselineChip renders nothing without a median, so the row it
  // would sit in is only drawn when a chip will actually be there.
  const comparable = base.n >= 4;
  const chipTime = comparable && !isRunning && t.durationMs != null && base.medianDurationMs
    ? <BaselineChip value={t.durationMs} base={base} kind="duration" /> : null;
  const chipTok = comparable && t.tokens && base.medianTokens ? <BaselineChip value={t.tokens} base={base} kind="tokens" /> : null;
  const ctx = (
    <div className="sv-ctx">
      {base.n || splitText ? (
        <>
          <h5>against its usual</h5>
          <dl>
            {comparable ? (
              <>
                <dt>usual</dt>
                <dd>{dur(base.medianDurationMs)} · {fmt(base.medianTokens)} tok <span className="muted">(median of {base.n})</span></dd>
                {chipTime || chipTok ? <><dt>this step</dt><dd>{chipTime}{chipTime && chipTok ? " " : null}{chipTok}</dd></> : null}
              </>
            ) : base.n ? (
              <><dt>usual</dt><dd className="muted">too few finished turns to compare ({base.n} so far)</dd></>
            ) : null}
            {splitText ? <><dt>split</dt><dd className="mono">{splitText}</dd></> : null}
          </dl>
        </>
      ) : null}
      {/* The strip carries its own "sandbox" label; a heading above it said
          the word twice. */}
      {sbx.perms !== undefined ? (
        <>
          <SandboxStrip perms={sbx.perms ?? undefined} runtime={sbx.runtime} loading={sbx.perms === null} />
          {sbx.perms ? <p className="sv-sec-n">{envLine(sbx.perms)}</p> : null}
        </>
      ) : null}
    </div>
  );

  // Wide layout: the inspector fills the sticky side column. Narrow: it opens
  // inline under the picked row, so reading a payload no longer means a trip
  // to the bottom of the page and back for every row.
  const inspector = (
    <Inspector
      sel={sel}
      toolCalls={toolCalls}
      opRows={opRows}
      timeline={timeline}
      onClose={() => select(null)}
      onArtifact={(id: string) => openDrawer(<ArtifactDrawer id={id} />)}
    />
  );
  const inline = narrow && sel ? inspector : undefined;
  // An event picked from the causal rail may have no row to open under.
  const orphan = narrow && sel?.kind === "event" && !timeline.some((e: any) => e.seq === sel.seq);

  return (
    <div className={shell} aria-busy={pending || undefined}>
      <div className={`sv-head${stuck ? " stuck" : ""}`} ref={measureHead}>
        <div className="sv-topbar">
          {walker}
          <CloseX />
        </div>
        <div className="sv-ident">
          <AgentAvatar id={t.agentId || "?"} color={agentColor(t.agentId || "?")} />
          <div className="sv-who">
            {/* The dialog's aria-labelledby points here; without this id the
                loaded step announced only the generic "Details panel". */}
            <b id="drawer-title">{(t.agentId || "step")}</b>
            <span className="sv-id mono" title={vid}>turn-{shortTurn(vid)} · {ago(t.startedAt || "")}</span>
          </div>
          <span className={`sstat-badge sstat-${state.tone}`} title={state.headline}>{state.label}</span>
          {attempt != null && attempt > 1 ? <span className="sv-why-a" title="the scheduler re-woke this agent after an earlier attempt">attempt {attempt}</span> : null}
        </div>
        <p className="sv-why">
          <span className="sv-why-k">{(plainReason(t.reason?.kind))}</span>
          {t.reason?.eventType ? <span className="sv-why-x mono">{t.reason.eventType}</span> : null}
        </p>
        <div className="sv-metrics">
          <span title="wall clock for this turn">{durText}</span>
          {deadline ? (
            <span className={`lw-${deadline.tone}`} title={[hardStopText(deadline), deadline.extended ? "extended while you watched" : null].filter(Boolean).join(" · ") || "when this turn will be stopped as things stand"}>
              {deadlineText(deadline)}
            </span>
          ) : null}
          <span title={splitText ?? (t.tokens == null && liveTokens !== undefined ? "billable tokens the runtime has reported so far (cache reads excluded)" : "total tokens")}>
            {tokenText(t.tokens, liveTokens, fmt)}
            {inShare !== null ? <i className="sv-split" aria-hidden="true"><b style={{ width: `${inShare}%` }} /></i> : null}
            {splitText ? <span className="sr-only">{splitText}</span> : null}
          </span>
          {cachedShare !== null ? (
            <span className="mono" title="share of this turn's prompt that was replayed from cache rather than sent fresh">
              cached {cachedShare}%
            </span>
          ) : null}
          {/* Out of the actions that should have left an effect and were
              allowed to: a refused op did not go missing, and one with
              nothing observable to look for cannot be found. Amber only when
              an expected effect is absent; refusals are counted on their own. */}
          <span
            className={tally && tally.landed < tally.expected ? "part" : undefined}
            title="actions whose expected effect was found in the event log — refused actions, and ones that leave nothing to find, are not counted"
          >
            {tally && tally.expected ? `${tally.landed}/${tally.expected} recorded` : "— recorded"}
          </span>
          {tally?.refused ? (
            <span className="sv-met-rej" title={refusedTitle}>{tally.refused} refused</span>
          ) : null}
          {t.model ? <span className="mono sv-model" title={t.model}>{t.model}</span> : null}
          {stale ? <span className="part" role="status" title="the last poll for this live turn failed; showing the last record received, retrying every 4s">connection lost — retrying</span> : null}
        </div>
        <StepJump key={vid} sections={sections} scroller={scroller} />
      </div>

      <div className="sv-body">
        <div className="sv-main">
          {/* Loudest thing on the page when it exists, absent otherwise. */}
          <ErrorPanel err={t.errorDetail ?? listStep?.errorDetail} fallback={t.error} />
          {/* What happened, why, and what next — ahead of the narration, which
              can run to screens and is the least trustworthy thing here. */}
          <StepStatusBlock outcome={outcome} status={t.status || "running"} produced={produced} why={why} />

          {isRunning ? (
            <section className="sv-sec sv-live" id="sv-live">
              <VitalsStrip v={vitals} model={t.model} />
              <LiveWork turnId={vid} work={work} tools={workTools} phases={stops} running />
              {liveOps ? <LiveOps ops={liveOps} writing={false} heads={heads} /> : null}
              <LiveStream text={liveText} hasInstructions={Boolean(t.instructions)} working={workTools.length > 0} />
            </section>
          ) : null}

          {/* What the turn did comes before what it said about it: the ledger
              is checked against the log, the narration is not. */}
          <section className="sv-sec" id="sv-outcome">
            {/* The recorded count is in the sticky header, which stays on screen. */}
            <div className="sv-sec-h">
              <h4>Outcome</h4>
              {capture ? <span className={`sv-sec-n${capture.warn ? " part" : ""}`} title={capture.title}>{capture.text}</span> : null}
            </div>
            {opRows
              ? <OpLedger rows={opRows} sel={sel} onSelect={select} detail={inline} />
              : (
                <div className="step-empty">
                  {/* A running turn has not finished choosing; every sentence
                      below is a verdict on a turn that has. */}
                  {isRunning
                    ? <><b>No mesh tool calls yet.</b><span>Actions appear here as the agent calls mesh tools — nothing is final until the turn ends.</span></>
                    : leftEffects
                      ? <><b>No mesh tool calls recorded for this turn.</b><span>It still produced {produced} — recorded from the event log below.</span></>
                      : t.text
                        ? <><b>No mesh tool calls.</b><span>The model wrote prose but called no mesh tool, so nothing was applied — reply text is never parsed for ops.</span></>
                        : <><b>No operations were recorded.</b><span>This step ended without attempting anything, or it left the recent-turn window.</span></>}
                </div>
              )}
            <OpLatency timings={t.opTimings ?? listStep?.opTimings} />
          </section>

          {hasReasoning ? (
            <section className="sv-sec" id="sv-reasoning">
              <div className="sv-sec-h">
                <h4>Reasoning</h4>
                <span className="sv-sec-n">{notices.length ? "kernel notices · verified" : "narration · not verified"}</span>
              </div>
              {notices.length ? (
                <>
                  <ul className="sv-notices" aria-label="kernel notices, verified">
                    {notices.map((n, i) => <li className="sv-notice" key={i}>{n}</li>)}
                  </ul>
                  <p className="sv-sec-n" style={{ margin: "0 0 var(--s1-5)" }}>narration · not verified</p>
                </>
              ) : null}
              {narration
                ? <ClampedProse key={vid} text={narration} markdown />
                : <Prose dim>{wroteOps
                    ? "The model wrote no prose for this turn — only operations."
                    : "The model left no narration for this turn."}</Prose>}
            </section>
          ) : null}

          {toolTotal ? (
            <section className="sv-sec" id="sv-tools">
              <div className="sv-sec-h">
                <h4>Tools</h4>
                <span className={`sv-sec-n mono${toolCalls.length < toolTotal ? " part" : ""}`}>
                  {toolCalls.length < toolTotal ? `${toolCalls.length} of ${toolTotal} captured · ` : ""}
                  {new Set(toolCalls.map((c: any) => String(c.name ?? ""))).size} distinct
                </span>
              </div>
              {toolCalls.length
                ? <ToolRows key={vid} calls={toolCalls} perms={sbx.perms ?? undefined} sel={sel} onSelect={select} detail={inline} />
                : <div className="step-empty"><b>{toolTotal} {toolTotal === 1 ? "call was" : "calls were"} counted, but none was captured.</b><span>The runtime reported how many tools it called without recording their arguments.</span></div>}
            </section>
          ) : null}

          {showWork ? (
            <section className="sv-sec" id="sv-work">
              <div className="sv-sec-h">
                <h4>{t.status === "failed" && finishedWorkTools.length ? "Work before it stopped" : "Work"}</h4>
                {finishedWorkTools.length ? (
                  <span className="sv-sec-n" title="the full tool trace is written only when a turn succeeds; this is what was recorded while it ran">recorded live</span>
                ) : null}
              </div>
              <LiveWork turnId={vid} work={work} tools={finishedWorkTools} running={false} />
            </section>
          ) : null}

          <section className="sv-sec" id="sv-events">
            {/* The count is on the section's jump pill. */}
            <div className="sv-sec-h"><h4>Events</h4></div>
            {timeline.length
              ? <EventRows rows={timeline} sel={sel} onSelect={select} t0={t.startedAt} detail={inline} />
              : <div className="step-empty"><b>No linked events.</b><span>Either this step changed nothing, or it is older than the live log window.</span></div>}
            <CausalRail links={links} onTurn={goTo} onEvent={(seq: number) => select({ kind: "event", seq })} />
          </section>

          {t.instructions ? (
            <section className="sv-sec" id="sv-brief">
              <div className="sv-sec-h">
                <h4>Brief</h4>
                <span className="sec-tools"><span className="sv-sec-n mono">{textStats(String(t.instructions))}</span><CopyBtn text={String(t.instructions)} /></span>
              </div>
              <details className="sv-fold">
                <summary>the prompt the runtime assembled for this turn, inbox and all</summary>
                <pre className="token-stream">{(String(t.instructions).slice(0, 8000))}{String(t.instructions).length > 8000 ? "\n… [truncated at 8k chars — copy for the full text]" : ""}</pre>
              </details>
            </section>
          ) : null}

          <section className="sv-sec" id="sv-raw">
            <div className="sv-sec-h">
              <h4>Raw</h4>
              {t.text || liveText ? <span className="sec-tools"><span className="sv-sec-n mono">{textStats(String(t.text || liveText))}</span><CopyBtn text={String(t.text || liveText)} /></span> : null}
            </div>
            <details className="sv-fold">
              <summary>model output</summary>
              {t.text || liveText
                ? <pre className="token-stream">{(t.text || liveText)}</pre>
                : <div className="step-empty"><b>Nothing captured.</b><span>No text was stored for this turn.</span></div>}
            </details>
            <details className="sv-fold">
              <summary>turn record (JSON)</summary>
              <pre>{(JSON.stringify({ turn: { ...t, text: t.text ? `${String(t.text).slice(0, 500)}… [truncated in details]` : t.text } }, null, 2).slice(0, 4000))}</pre>
            </details>
          </section>
        </div>

        <div className="sv-side">
          <PhaseRail phases={phases} running={isRunning} />
          {sel && !narrow ? null : ctx}
          {!narrow || orphan ? inspector : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Live token viewport: auto-scrolls while following, blinking caret while the
 * turn runs, "jump to live" when the user scrolled up. Thinking state (no
 * text yet) shows a shimmer instead of an empty box.
 */
function LiveStream({ text, hasInstructions, working }: {
  text: string;
  hasInstructions: boolean;
  /** The seat is making tool calls: silence is work, not a model yet to answer. */
  working?: boolean;
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
  if (!text && working) {
    // "Thinking. No tokens yet — the model has not answered" sat under a seat
    // making its ninetieth Write call. A seat that works through tools streams
    // no prose; its work is the list above.
    return <p className="lw-quiet muted">No prose yet — it is working through tools; the calls above are its output so far.</p>;
  }
  if (!text) {
    return (
      <div className="think-box">
        <span className="think-dots"><i /><i /><i /></span>
        <span className="think-txt">
          <b>Thinking.</b>
          <span className="muted">
            No tokens yet — the prompt is out and the model has not answered.
            {hasInstructions ? " The Brief section shows what it was handed." : ""}
          </span>
        </span>
      </div>
    );
  }
  return (
    <div className="stream-wrap">
      <div className="stream-bar">
        <span className="stream-live"><i className="live-dot on" aria-hidden="true" /><span className="sec-label">Live output</span><span className="sec-stat mono">{textStats(text)}</span></span>
        <span className="row" style={{ gap: 6 }}>
          {!follow ? <Button variant="small" onClick={jumpLive}>↓ jump to live</Button> : null}
          <CopyBtn text={text} />
        </span>
      </div>
      <pre ref={ref} className="token-stream live" onScroll={onScroll} tabIndex={0} aria-live="off">{text}<span className="caret">▍</span></pre>
      {!follow ? <div className="stream-paused muted">Scrolled up — output is still arriving.</div> : null}
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

/**
 * The details panel's file reader. It is the component the Files page draws beside its list (artifactreader.tsx), so one file reads
 * the same in both places. The panel used to have its own copy, which drew a version once per status change ("v2 v2 v2") and
 * repeated React keys for it.
 */
export function ArtifactDrawer({ id }: { id: string }): React.JSX.Element {
  return <ArtifactReader id={id} as="drawer" />;
}

