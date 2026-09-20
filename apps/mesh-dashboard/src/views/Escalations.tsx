import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ago, fmt, fmtBudget, roundNice } from "../format";
import { applyAdvisoryTone, PAUSED_CLAUSE, RESUMES, RESUMES_AND_WAKES } from "../escalation-tone";
import { useMesh } from "../store";
import { Button, Card, ErrorState, Input } from "../components";
import { AgentDrawer, ArtifactDrawer } from "../drawers";
import { MeshMark } from "./Overview";
import { isParkedStatus, useGoLive } from "../actions";
// Deep import, not the package barrel: the catalog imports nothing but types,
// so this pulls in the verdict phrasing and nothing else — the same
// arrangement events.tsx uses for EVENT_SEVERITY. Going through
// `protocol/src/index` would drag AJV into the bundle.
// Card titles used to be a second copy of the termination vocabulary that
// drifted from the reasons in `packages/core/src/termination.ts`; the headline
// now comes from the shared table, while the `what` / `next` / placeholder copy
// below stays local because it talks about clicking and answering *below*.
import { verdictText } from "../../../../packages/protocol/src/catalog";

interface BudgetInfo {
  title: string;
  what: string;
  next: string;
  placeholder: string;
  key?: string;
  agent?: string;
  consumed?: number;
  limit?: number;
  unit: string;
  raisable: boolean;
  configCap?: "events" | "time";
}

/**
 * A half-written answer to a blocking question is expensive to lose: the
 * operator has usually gone off to read code or a log in order to write it, and
 * coming back to an empty box means reconstructing the whole thought. The forms
 * are otherwise uncontrolled (submit reads the DOM), so the draft rides
 * alongside in localStorage rather than being lifted into React state — no
 * re-render per keystroke, and it survives a reload, a tab switch or a stray
 * close. Cleared only on a send the server accepted; a failed send keeps it.
 */
const DRAFT_KEY = "mesh-esc-draft:";
const draftGet = (id: string): string => {
  try {
    return localStorage.getItem(DRAFT_KEY + id) || "";
  } catch {
    // Private mode / blocked storage: drafts are a convenience, never a
    // precondition for answering.
    return "";
  }
};
const draftSet = (id: string, v: string): void => {
  try {
    if (v) localStorage.setItem(DRAFT_KEY + id, v);
    else localStorage.removeItem(DRAFT_KEY + id);
  } catch {
    /* ignore */
  }
};
const draftClear = (id: string): void => draftSet(id, "");

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

interface StuckInfo {
  agentId: string;
  askerId: string;
  requestId: string;
  requestType: string;
  age: string;
  requestLabel: string;
  underlying: Array<{ id: string; conflictKey?: string; reason?: string }>;
}

function msgText(m: any): string {
  const p = m?.payload;
  if (!p || typeof p !== "object") return "";
  for (const k of ["question", "summary", "note", "reason", "text", "answer"]) {
    if (typeof (p as Record<string, unknown>)[k] === "string") return (p as Record<string, unknown>)[k] as string;
  }
  return "";
}

function plainTaskOf(m: any, fallbackType: string): { title: string; task: string } {
  const q = msgText(m).trim();
  const t = m?.type || fallbackType || "REQUEST";
  if (q.length > 0) {
    const first = q.split(/\n+/)[0].slice(0, 140);
    return { title: first, task: q.slice(0, 500) };
  }
  if (t === "REQUEST_REVIEW") return { title: "Review requested", task: "Review the file and approve or reject it." };
  return { title: "Input needed", task: "Answer so the waiting agent can continue." };
}

function suggestedAnswerOf(m: any, askerId: string, target: string): string {
  const q = msgText(m).trim();
  if (/test_result|ui suite|e2e/i.test(q)) return `Approved — ${target}, run the UI suite + preset/headless e2e and post TEST_RESULT.`;
  if (/eta|still in progress|patch/i.test(q)) return `Still in progress — ETA 1h, will post patch.ready when the new version is up.`;
  if (q) return `Approved — proceed${askerId ? ` (${askerId} asked: ${q.slice(0, 100)})` : ""}.`;
  return `Approved — ${target} can continue.`;
}

function requestLabelOf(m: any, fallbackType: string): string {
  const t = m?.type || fallbackType || "request";
  const q = msgText(m);
  const refs = Array.isArray(m?.artifactRefs) ? m.artifactRefs : [];
  const art = refs.length > 0 ? ` (${refs.map((r: any) => shortArt(String(r?.uri || ""))).join(", ")})` : "";
  const head = t === "REQUEST_REVIEW" ? "a review" : t === "REQUEST" ? "a status update" : `a ${String(t).toLowerCase().replace(/_/g, " ")}`;
  return q ? `${head}${art}: “${q.slice(0, 160)}”` : `${head}${art}`;
}

function shortArt(uri: string): string {
  const m = /artifact:\/\/([^/]+)\/([^/]+)/.exec(uri);
  return m ? `${decodeURIComponent(m[2])}` : uri.slice(0, 40);
}

/* Evidence on an escalation arrives as `artifact://<type>/<name>/<version>`.
 * That is enough to print a filename and it is what this screen printed: a
 * dead comma-joined string naming the one file the answer depends on, with no
 * way to read it. The drawer is keyed by artifact id, which the uri does not
 * carry, so the view fetches the artifact list once and resolves refs against
 * it — mirroring supervisor.findArtifactByUri's order (exact versioned uri
 * first, then newest version of that type/name). Anything that still will not
 * resolve stays plain text rather than becoming a button that does nothing. */
const ArtIndexCtx = createContext<any[]>([]);

function resolveArtifactId(list: any[], uri: string): string | null {
  const m = /^artifact:\/\/([^/]+)\/([^/]+?)(?:\/(\d+))?$/.exec(uri);
  if (!m) return null;
  const type = m[1];
  const name = decodeURIComponent(m[2]);
  const version = m[3] ? Number(m[3]) : undefined;
  let best: any = null;
  for (const a of list) {
    if (a?.type !== type || a?.name !== name) continue;
    if (version !== undefined && a.version === version) return String(a.id);
    if (!best || Number(a.version) > Number(best.version)) best = a;
  }
  return best ? String(best.id) : null;
}

function EvidenceRefs({ uris }: { uris: string[] }): React.JSX.Element | null {
  const { openDrawer } = useMesh();
  const list = useContext(ArtIndexCtx);
  if (!uris.length) return null;
  return (
    <div className="muted evidence-refs">
      <span>{uris.length > 1 ? "files" : "file"}:</span>
      {uris.map((uri, i) => {
        const id = resolveArtifactId(list, uri);
        const label = shortArt(uri);
        return id
          ? <Button key={`${uri}-${i}`} variant="small" title={uri} onClick={() => openDrawer(<ArtifactDrawer id={id} />)}>{label}</Button>
          : <code key={`${uri}-${i}`} title={uri}>{label}</code>;
      })}
    </div>
  );
}

function ageOf(iso: unknown): string {
  const ms = Date.now() - Date.parse(String(iso ?? ""));
  if (!Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m waiting`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""} waiting`;
}

function stuckInfoOf(e: any, msgs?: Map<string, any>): StuckInfo {
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  const agentId = typeof d.agentId === "string" ? d.agentId : "";
  const requestId = typeof d.requestMessageId === "string" ? d.requestMessageId : "";
  const requestType = typeof d.requestType === "string" ? d.requestType : "";
  const m = requestId && msgs ? msgs.get(requestId) : undefined;
  const askerId = m && typeof m.from === "string" ? m.from : "";
  return {
    agentId,
    askerId,
    requestId,
    requestType,
    age: d.awaitingSince ? ageOf(d.awaitingSince) : e.createdAt ? ageOf(e.createdAt) : "",
    requestLabel: requestLabelOf(m, requestType),
    underlying: Array.isArray(d.openDeadlockEscalations)
      ? d.openDeadlockEscalations.filter((o: any) => o && typeof o.id === "string")
      : [],
  };
}

type EscPlain = { title: string; what: string; next: string; placeholder: string; budget?: BudgetInfo };

/** Reason-specific wording, then the advisory correction. Split in two so no
    arm has to remember which of the two kinds of card it is being asked for;
    see escalation-tone.ts for why the correction is not an arm's business. */
function escPlain(e: any, status: any, msgs?: Map<string, any>, parked = false): EscPlain {
  return applyAdvisoryTone(escPlainBody(e, status, msgs, parked), e?.advisory === true);
}

function escPlainBody(e: any, status: any, msgs?: Map<string, any>, parked = false): EscPlain {
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  const failed: string[] = d.failedAgents || (d.agentId ? [d.agentId] : []);
  const err = d.error ? String(d.error).slice(0, 220) : "";
  const isSys = ["termination-manager", "recovery-manager", "deadlock-detector"].includes(e.raisedBy);
  const who = isSys ? "Mesh watchdog" : e.raisedBy;
  switch (e.reason) {
    case "runtime_failure":
      return {
        title: verdictText("runtime_failure", { agents: failed }).title,
        what: `${who} detected a runtime failure${failed.length ? ` in ${failed.join(", ")}` : ""}${err ? ` — ${err}` : ""}. ${PAUSED_CLAUSE}`,
        next: `Check the agent's last step for the error, then tell the mesh how to proceed (retry, skip, or reassign). ${RESUMES_AND_WAKES}`,
        placeholder: failed.length ? `e.g. retry ${failed[0]} once, else skip and continue` : "e.g. retry once, else skip and continue",
      };
    case "backend_unreachable": {
      const agent = typeof d.agentId === "string" && d.agentId ? d.agentId : failed[0] || "agent";
      const backend = typeof d.backend === "string" ? d.backend : "";
      const backendLine = backend && backend !== "unknown — check the agent's runtime (opencode server port, http baseUrl)"
        ? ` Its backend at ${backend} stopped answering.`
        : ` Its model backend stopped answering.`;
      return {
        title: `${agent}'s backend is down`,
        what: `${agent} failed ${typeof d.consecutiveFailures === "number" ? d.consecutiveFailures : "several"} turns in a row because the model backend is unreachable.${backendLine}`,
        next: "Check the backend process is alive, look for OOM, or restart it — then respond and wake the agent for a fresh turn. Retrying without fixing the backend just burns more turns.",
        placeholder: `e.g. restarted backend; wake ${agent} to retry`,
      };
    }
    case "thread_budgets_exhausted": {
      const n = typeof d.exhaustedThreads === "number" ? d.exhaustedThreads : (Array.isArray(d.threads) ? d.threads.length : 0);
      return {
        title: verdictText("thread_budgets_exhausted", { threads: n }).title,
        what: `${n} conversation thread${n === 1 ? " has" : "s have"} spent their token budget, and no thread is left that agents can talk in. Work stopped silently — nobody is running.`,
        next: "Raise the per-thread budget in mesh.yaml (budgets.thread_tokens), or respond to have the agents start a fresh thread with a tighter question.",
        placeholder: "e.g. start a fresh thread and keep it short",
      };
    }
    case "budget_exhausted":
    case "agent_budget_exhausted":
    case "thread_budget_exhausted":
    case "budget_exhausted_tokens":
    case "max_events_exceeded":
    case "wall_clock_exceeded": {
      const b = budgetInfoOf(e, status);
      return { title: b.title, what: b.what, next: b.next, placeholder: b.placeholder, budget: b };
    }
    case "stalemate":
    case "stalemate:unanswered_request": {
      const stuck = stuckInfoOf(e, msgs);
      if (e.reason === "stalemate") {
        const n = stuck.underlying.length;
        return {
          title: verdictText("stalemate", { waiting: n }).title,
          what: n > 0
            ? `Mission paused — ${n} answer${n === 1 ? "" : "s"} still missing. Answer them below, or answer all at once.`
            : `Mission paused on a stalemate whose underlying requests are already resolved. The mesh retires this automatically; answer below to clear it now.`,
          next: "Answer the requests below, or send one decision that covers all of them.",
          placeholder: "e.g. approved it myself; continue",
        };
      }
      const target = stuck.agentId || escAgents(e)[0] || "agent";
      const task = plainTaskOf(msgs?.get(stuck.requestId), stuck.requestType);
      return {
        title: task.title || `${target} is waiting`,
        what: task.task,
        next: parked
          ? "One click sends your answer and restarts work."
          : "One click sends your answer and work resumes.",
        placeholder: suggestedAnswerOf(msgs?.get(stuck.requestId), stuck.askerId, target),
      };
    }
    default:
      if (String(e.reason || "").startsWith("collab_overrun:")) {
        const why = String(e.reason).slice("collab_overrun:".length);
        const topic = typeof d.topic === "string" && d.topic ? d.topic : "";
        const parts = Array.isArray(d.participants) ? d.participants.filter((x: any) => typeof x === "string" && x) : [];
        const n = Number(d.exchanges);
        const cap = Number(d.maxExchanges);
        const meter = Number.isFinite(n) ? ` after ${n}${cap > 0 ? `/${cap}` : ""} exchange${n === 1 ? "" : "s"}` : "";
        return {
          title: topic ? `A conversation ran long: ${topic}` : "A conversation ran long",
          what: `${parts.length ? parts.join(" and ") : "Two agents"} were still talking when ${
            why === "expired" ? "their time box ran out" : "they hit their message limit"
          }${meter}, so the mesh closed the conversation.`,
          next: "If the topic still needs settling, tell them the answer, or say which one of them has the call.",
          placeholder: "e.g. go with v2; stop debating it",
        };
      }
      if (String(e.reason || "").startsWith("deadlock:")) {
        const desc = typeof d.description === "string" ? d.description.trim() : "";
        return {
          title: "Deadlock detected",
          what: desc
            ? `${who}: ${desc}. Work is paused to avoid burning budget.`
            : `${who} found agents blocking each other (${e.reason}). Work is paused to avoid burning budget.`,
          next: "Break the cycle: approve / reject the contested artifact, or respond with who should yield.",
          placeholder: "e.g. approve v2; the other side yields",
        };
      }
      return {
        title: e.reason || "Needs a human decision",
        what: `${who} needs you to decide. ${PAUSED_CLAUSE}`,
        next: `Read the context below, then respond with the decision. ${RESUMES}`,
        placeholder: "e.g. decided: …",
      };
  }
}

function budgetInfoOf(e: any, status: any): BudgetInfo {
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  if (e.reason === "agent_budget_exhausted") {
    const agent = (/^agent:[^/]+\/(.+)$/.exec(String(d.key || "")) || [])[1] || "agent";
    const consumed = num(d.consumed) ?? 0;
    const limit = num(d.limit) ?? 0;
    return {
      title: `${agent} ran out of tokens`, key: d.key, agent, consumed, limit, unit: "tokens", raisable: true,
      what: `The watchdog stopped the mission: ${agent} spent ${fmt(consumed)} of its ${fmt(limit)} token budget. Nobody can run until this is resolved.`,
      next: "Add more tokens below (takes effect immediately, no restart), or narrow the work and respond.",
      placeholder: `e.g. raised ${agent} to ${fmt(Math.ceil(limit * 1.5 / 1000) * 1000)}; keep research shallow`,
    };
  }
  if (e.reason === "budget_exhausted" || e.reason === "budget_exhausted_tokens") {
    const consumed = num(d.consumed) ?? 0;
    const limit = num(d.limit) ?? 0;
    return {
      title: "Mission budget spent", key: d.key, consumed, limit, unit: "tokens", raisable: true,
      what: `The watchdog stopped the mission: ${fmt(consumed)} of ${fmt(limit)} mission tokens are gone. Nobody can run until this is resolved.`,
      next: "Add more tokens below (takes effect immediately, no restart), or narrow the scope and respond.",
      placeholder: `e.g. raised mission to ${fmt(Math.ceil(limit * 1.5 / 1000) * 1000)}; skip optional criteria`,
    };
  }
  if (e.reason === "thread_budget_exhausted") {
    const key = d.threadId && e.goalId ? `thread:${e.goalId}/${d.threadId}` : undefined;
    const entry = key && (status?.budgets || []).find((b: any) => b.key === key);
    return {
      title: "A thread ran out of tokens", key, consumed: entry?.consumed ?? 0, limit: entry?.limit ?? 0, unit: "tokens", raisable: !!key,
      what: `One conversation thread spent its token budget, so work in it stopped and the mission paused.`,
      next: key ? "Add tokens to the thread below, or start a fresh thread with a tighter question." : "Start a fresh thread with a tighter question, then respond.",
      placeholder: "e.g. raised thread budget; continue with a yes/no question",
    };
  }
  if (e.reason === "max_events_exceeded") {
    const live = status?.goal?.budget?.maxEvents;
    const limit = (typeof live === "number" ? live : undefined) ?? num(d.limit) ?? 0;
    return {
      title: "Too many events", consumed: num(d.events) ?? 0, limit, unit: "events", raisable: false,
      what: `The mission passed its event cap (${fmt(num(d.events) ?? 0)} of ${fmt(limit)} events).`,
      next: "",
      placeholder: "",
      configCap: "events",
    };
  }
  if (e.reason === "wall_clock_exceeded") {
    const mins = (ms: unknown) => (typeof ms === "number" ? `${Math.round(ms / 60000)}m` : "?");
    return {
      title: "Time limit reached", consumed: d.wallClockMs, limit: d.limitMs, unit: "minutes", raisable: false,
      what: `The mission ran past its wall-clock limit (${mins(d.wallClockMs)} of ${mins(d.limitMs)}).`,
      next: "",
      placeholder: "",
      configCap: "time",
    };
  }
  return { title: "Budget exhausted", unit: "tokens", raisable: false, what: "A budget ran out and the mission paused.", next: "See Cost for details, then respond with how to proceed.", placeholder: "e.g. decided: …" };
}

function escAgents(e: any): string[] {
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  const out = new Set<string>();
  if (Array.isArray(d.failedAgents)) for (const a of d.failedAgents) out.add(a);
  if (typeof d.agentId === "string") out.add(d.agentId);
  if (typeof d.key === "string") {
    const m = /^agent:[^/]+\/(.+)$/.exec(d.key);
    if (m && m[1]) out.add(m[1]);
  }
  if (typeof e.raisedBy === "string" && !["termination-manager", "recovery-manager", "deadlock-detector", "human"].includes(e.raisedBy)) out.add(e.raisedBy);
  if (Array.isArray(d.participants)) for (const a of d.participants) if (typeof a === "string") out.add(a);
  return [...out].filter((a) => a && a !== "human");
}

function BudgetMeter({ b }: { b: BudgetInfo }): React.JSX.Element {
  const pct = b.limit ? Math.min(100, Math.round(((b.consumed ?? 0) / b.limit) * 100)) : 100;
  const unitWord = b.unit === "minutes" ? "" : b.unit === "events" ? "events" : "tokens";
  const over = typeof b.consumed === "number" && b.limit ? b.consumed - b.limit : 0;
  return (
    <div style={{ margin: "8px 0" }}>
      <div className="row" style={{ justifyContent: "space-between" }}><span><b>{fmtBudget(b.consumed, b.unit)}</b> <span className="muted">of {fmtBudget(b.limit, b.unit)} {unitWord}</span></span><span className="muted">{over > 0 ? `over by ${b.unit === "minutes" ? fmtBudget(over, b.unit) : fmt(over)}` : `${pct}%`}</span></div>
      <div className="progress"><div style={{ transform: `scaleX(${pct / 100})` }} /></div>
      {b.key ? <div className="muted mono" style={{ fontSize: 11, marginTop: 2 }}>{(b.agent ? `${b.agent}'s budget` : "mission budget")}</div> : null}
    </div>
  );
}

function capTarget(kind: "events" | "time", info: { budget?: BudgetInfo }, status: any): number {
  if (kind === "events") {
    const live = status?.goal?.budget?.maxEvents;
    const current = (typeof live === "number" ? live : undefined) ?? info.budget?.limit ?? 8000;
    return roundNice(current * 2);
  }
  const live = status?.goal?.budget?.wallClockMinutes;
  return ((typeof live === "number" ? live : undefined) ?? 240) * 2;
}

export default function Escalations(): React.JSX.Element {
  const mesh = useMesh();
  const { status, setView, openDrawer, toast, refreshStatus, client, confirm } = mesh;
  const [list, setList] = useState<any[]>([]);
  const { busy: bootBusy, goLive } = useGoLive();
  const [raiseBusy, setRaiseBusy] = useState<string | null>(null);
  // One in-flight decision at a time: the question is the gate, and a
  // double-click must not send it twice.
  const [opBusy, setOpBusy] = useState<string | null>(null);
  const parked = isParkedStatus(status);

  const reload = async () => {
    try {
      const { json } = await client.api("GET", "/escalations");
      // An error payload is an object; assigning it made list.filter throw.
      if (Array.isArray(json)) setList(json);
    } catch {
      /* keep the last list; the load effect's retry is the visible path */
    }
  };
  // The swallowed catch here told the operator "no escalations — the mesh is
  // converging on its own" whenever the fetch failed. That is the one screen
  // where a false all-clear costs the most: it is the queue of things that
  // are blocking the mission on a human answer.
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let dead = false;
    setLoadErr(null);
    (async () => {
      const [{ json, timeout }, stRes] = await Promise.all([
        client.api("GET", "/escalations"),
        client.api("GET", "/status").catch(() => ({ json: null })),
      ]);
      if (dead) return;
      if (timeout || (json && json.error)) {
        setLoadErr(timeout ? "the request timed out — the server may be busy." : String(json.error));
        return;
      }
      setList(json || []);
      setLoaded(true);
      if (stRes.json) await refreshStatus();
    })().catch((e: unknown) => {
      if (!dead) setLoadErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [attempt, client, refreshStatus]);

  // Staleness here is a correctness problem, not a nicety: an unanswered
  // escalation is an agent stopped dead, and until now the list only refetched
  // on mount — so a question raised while this tab was open showed an empty
  // queue, which reads as "the mesh is converging on its own". The event stream
  // already knows the moment it happens; follow it instead of asking the
  // operator to reload. Refetching (rather than patching the list from the
  // payload) keeps one source of truth for status, threads and budget deltas.
  const escSeq = useMemo(() => {
    let top = 0;
    for (const e of mesh.events) if (e.type.startsWith("escalation.") && e.seq > top) top = e.seq;
    return top;
  }, [mesh.events]);
  // `reload` is redefined every render; a ref keeps this effect keyed on the
  // event sequence alone, so it fires once per new escalation event.
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => {
    if (!escSeq || !loaded) return;
    void reloadRef.current();
  }, [escSeq, loaded]);

  // The index behind EvidenceRefs. Refetched when an artifact event lands so a
  // file written after this screen opened is still openable; a failure leaves
  // the refs as plain names, which is what they were before.
  const [artIndex, setArtIndex] = useState<any[]>([]);
  const artSeq = useMemo(() => {
    let top = 0;
    for (const e of mesh.events) if (e.type.startsWith("artifact.") && e.seq > top) top = e.seq;
    return top;
  }, [mesh.events]);
  useEffect(() => {
    let dead = false;
    client.api("GET", "/artifacts").then(({ json }) => {
      if (!dead && Array.isArray(json)) setArtIndex(json);
    }).catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [attempt, artSeq, client]);

  const openList = list.filter((e) => e.status === "OPEN");
  const [msgs, setMsgs] = useState<Map<string, any>>(new Map());

  useEffect(() => {
    let dead = false;
    (async () => {
      const ids = new Set<string>();
      const byId = new Map<string, any>();
      for (const e of list) if (e?.id) byId.set(e.id, e);
      for (const e of list) {
        if (e.reason === "stalemate:unanswered_request") {
          const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
          if (typeof d.requestMessageId === "string") ids.add(d.requestMessageId);
        } else if (e.reason === "stalemate") {
          // Derived summary card: also load the underlying requests so the
          // card can name each one instead of saying "see below".
          const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
          const under = Array.isArray(d.openDeadlockEscalations) ? d.openDeadlockEscalations : [];
          for (const o of under) {
            const u = o?.id ? byId.get(o.id) : undefined;
            const rid = u?.detail?.requestMessageId;
            if (typeof rid === "string") ids.add(rid);
          }
        }
      }
      const next = new Map<string, any>();
      await Promise.all([...ids].slice(0, 20).map(async (id) => {
        try {
          const { status: st, json } = await client.api("GET", `/messages/${encodeURIComponent(id)}`);
          if (st === 200 && json?.id) next.set(id, json);
        } catch {
          /* card renders without the preview */
        }
      }));
      if (!dead && next.size > 0) setMsgs(next);
    })().catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [list, client]);

  const doRespond = async (escId: string, text: string) => {
    if (!text.trim() || opBusy) return;
    setOpBusy(escId);
    try {
      const { status: st } = await client.post(`/escalations/${encodeURIComponent(escId)}/respond`, { response: text });
      if (st !== 200) toast("respond failed — try again", escId, "bad");
      else {
        draftClear(escId);
        if (parked) toast("recorded — press Continue to go live", escId, "ok");
        else toast("responded — mission resumed", escId, "ok");
      }
    } catch {
      toast("respond failed", "the server did not answer", "bad");
    } finally {
      setOpBusy(null);
    }
    await reload();
    void refreshStatus();
  };

  const doAnswer = async (escId: string, text: string) => {
    if (!text.trim() || opBusy) return;
    setOpBusy(escId);
    try {
      const { status: st, json } = await client.post(`/escalations/${encodeURIComponent(escId)}/answer`, { text, response: text });
      if (st !== 200) {
        toast("answer failed — try again", json?.reason ?? escId, "bad");
      } else {
        draftClear(escId);
        toast("answered — work resumed", escId, "ok");
        // Parked consoles used to need a second "Continue" click after every
        // answer. Fold it in: one click sends the answer AND restarts work.
        if (parked) await goLive().catch(() => undefined);
      }
    } catch {
      toast("answer failed", "the server did not answer", "bad");
    } finally {
      setOpBusy(null);
    }
    await reload();
    void refreshStatus();
  };

  const doDrop = async (escId: string, label: string) => {
    if (
      (await confirm({
        title: "Skip this question?",
        body: [label, "The waiting agent moves on without an answer — it cannot ask again."],
        danger: true,
        confirmLabel: "Skip it",
      })) === null
    )
      return;
    if (opBusy) return;
    setOpBusy(escId);
    try {
      const { status: st, json } = await client.post(`/escalations/${encodeURIComponent(escId)}/drop`, { reason: `dropped by operator: ${label}`, response: `dropped: ${label}` });
      if (st !== 200) {
        toast("drop failed — try again", json?.reason ?? escId, "bad");
      } else {
        toast("skipped — work resumed", escId, "ok");
        if (parked) await goLive().catch(() => undefined);
      }
    } catch {
      toast("drop failed", "the server did not answer", "bad");
    } finally {
      setOpBusy(null);
    }
    await reload();
    void refreshStatus();
  };

  const doRaise = async (escId: string, key: string, newLimit: number, needConfirm: boolean) => {
    if (
      needConfirm &&
      (await confirm({
        title: `Raise the budget to ${fmt(newLimit)}?`,
        body: ["This wakes the blocked agents and resumes spend against the new limit."],
        confirmLabel: "Raise and resume",
      })) === null
    )
      return;
    const form = document.querySelector(`#respond-form-${CSS.escape(escId)} input`) as HTMLInputElement | null;
    const response = (form?.value || "").trim() || `raised budget to ${fmt(newLimit)} — continue with smaller steps`;
    setRaiseBusy(escId + key);
    try {
      const { status: st, json } = await client.post("/budgets/raise", { key, limit: newLimit });
      if (st !== 200 || !json?.ok) {
        toast("couldn't raise budget", json?.reason || `status ${st}`, "bad");
        return;
      }
      const r2 = await client.post(`/escalations/${encodeURIComponent(escId)}/respond`, { response });
      if (r2.status !== 200) toast("budget raised, resume failed", escId, "warn");
      else if (parked) toast("budget raised — press Continue to go live", `${fmtBudget(newLimit, "tokens")} · ${escId}`, "ok");
      else toast("budget raised — mission resumed", `${fmtBudget(newLimit, "tokens")} · ${escId}`, "ok");
    } catch {
      toast("couldn't raise budget", "the server did not answer", "bad");
    } finally {
      setRaiseBusy(null);
    }
    await reload();
    void refreshStatus();
  };

  const doRaiseCustom = (escId: string, key: string) => {
    const input = document.querySelector(`[data-raise-custom="${CSS.escape(key)}"]`) as HTMLInputElement | null;
    const v = Number(input?.value);
    if (!Number.isFinite(v) || v <= 0) {
      toast("invalid limit", "type a positive number", "warn");
      return;
    }
    void doRaise(escId, key, Math.floor(v), false);
  };

  const doCapRaise = async (kind: "events" | "time", escId: string) => {
    const target = capTarget(kind, { budget: openList.find((e) => e.id === escId) ? budgetInfoOf(openList.find((e) => e.id === escId), status) : undefined }, status);
    setRaiseBusy(escId + kind);
    try {
      const patch = kind === "events" ? { maxEvents: target } : { wallClockMinutes: target };
      const r = await client.post("/mission/limits", patch);
      if (!r.json?.ok) {
        toast("couldn't raise cap", r.json?.reason || `status ${r.status}`, "bad");
        return;
      }
      let yamlNote = "";
      try {
        const { json: cfg } = await client.api("GET", "/config");
        if (cfg?.raw && cfg?.filePath) {
          const raw = JSON.parse(JSON.stringify(cfg.raw));
          raw.budgets = raw.budgets || {};
          raw.budgets.mission = raw.budgets.mission || {};
          if (kind === "events") raw.budgets.mission.max_events = target;
          else raw.budgets.mission.wall_clock_minutes = target;
          const saved = await client.post("/config/save", { config: raw, path: cfg.filePath });
          yamlNote = saved.status === 200 ? " · mesh.yaml updated" : " · mesh.yaml left unchanged";
        }
      } catch {
        yamlNote = " · mesh.yaml left unchanged";
      }
      const label = kind === "events" ? `event cap to ${fmt(target)}` : `time limit to ${target}m`;
      const r2 = await client.post(`/escalations/${encodeURIComponent(escId)}/respond`, { response: `raised ${label} — resuming` });
      if (r2.status !== 200) toast("cap raised, resume failed", escId, "warn");
      else if (parked) toast(`cap raised — press Continue to go live${yamlNote}`, label, "ok");
      else toast(`cap raised — mission resumed${yamlNote}`, label, "ok");
    } catch {
      toast("couldn't raise cap", "the server did not answer", "bad");
    } finally {
      setRaiseBusy(null);
    }
    await reload();
    void refreshStatus();
  };

  const copyId = async (id: string) => {
    try {
      await navigator.clipboard.writeText(id);
      toast("copied", id, "ok");
    } catch {
      toast("copy failed", id, "warn");
    }
  };

  // These are agents stopped dead waiting on an answer, so the queue is ordered
  // by how long each has been stopped. Newest-first buried the longest-blocked
  // question at the bottom of the list, where it kept accruing the most idle
  // time — the exact inversion of what a triage queue is for. Each row already
  // prints its age, so the ordering explains itself.
  const waitedSince = (e: any): number => {
    const d = e?.detail && typeof e.detail === "object" ? e.detail : {};
    const t = Date.parse(d.awaitingSince || e?.createdAt || "");
    // Undatable rows sort last rather than pretending to be the oldest.
    return Number.isNaN(t) ? Infinity : t;
  };
  const byLongestWait = (x: any, y: any): number => waitedSince(x) - waitedSince(y);
  const openStuck = list.filter((x) => x.status === "OPEN" && x.reason === "stalemate:unanswered_request");
  const openOther = list.filter((x) => !(x.status === "OPEN" && (x.reason === "stalemate:unanswered_request" || x.reason === "stalemate")));
  const derived = list.filter((x) => x.status === "OPEN" && x.reason === "stalemate");
  const resolved = list.filter((x) => x.status !== "OPEN");

  return (
    <ArtIndexCtx.Provider value={artIndex}>
      {/* "all clear" is a verdict, so it may only be said once the queue has
          actually been read. Pre-fetch and post-failure it must not appear. */}
      <div className="view-title"><h2>Waiting on you{loaded ? ` (${openStuck.length})` : ""}</h2><span className="muted">{openStuck.length ? "answer one — work restarts by itself" : loadErr ? "queue unavailable" : !loaded ? "checking…" : "all clear"}</span></div>
      <div className="view-sub">Each card is one missing answer. Press Send — no second button, no Continue needed.</div>
      {openStuck.length ? openStuck.slice().sort(byLongestWait).map((e) => (
        <EscCard
          key={e.id} e={e} status={status} parked={parked} raiseBusy={raiseBusy} opBusy={opBusy} msgs={msgs} list={list}
          onRespond={doRespond} onAnswer={doAnswer} onDrop={doDrop} onRaise={doRaise} onRaiseCustom={doRaiseCustom} onCapRaise={doCapRaise} onCopyId={copyId}
        />
      )) : null}
      {derived.length ? derived.slice().sort(byLongestWait).map((e) => (
        <EscCard
          key={e.id} e={e} status={status} parked={parked} raiseBusy={raiseBusy} opBusy={opBusy} msgs={msgs} list={list}
          onRespond={doRespond} onAnswer={doAnswer} onDrop={doDrop} onRaise={doRaise} onRaiseCustom={doRaiseCustom} onCapRaise={doCapRaise} onCopyId={copyId}
        />
      )) : null}
      {openOther.length ? (
        <>
          <div className="group-h">Other decisions ({openOther.length})</div>
          {openOther.slice().reverse().map((e) => (
            <EscCard
              key={e.id} e={e} status={status} parked={parked} raiseBusy={raiseBusy} opBusy={opBusy} msgs={msgs} list={list}
              onRespond={doRespond} onAnswer={doAnswer} onDrop={doDrop} onRaise={doRaise} onRaiseCustom={doRaiseCustom} onCapRaise={doCapRaise} onCopyId={copyId}
            />
          ))}
        </>
      ) : null}
      {!list.length && loadErr ? <Card><ErrorState what="the decision queue" detail={`${loadErr} There may be decisions waiting that this list cannot show.`} onRetry={() => setAttempt((n) => n + 1)} /></Card> : null}
      {!list.length && !loadErr && !loaded ? <Card><div className="empty"><div className="big">…</div><div>loading decisions</div></div></Card> : null}
      {!list.length && !loadErr && loaded ? <Card><div className="empty"><div className="big">⚑</div><div>no escalations — the mesh is converging on its own.<br /><span className="muted">Escalations appear on budget exhaustion, stalemate (deadlock detector), runtime failure, or an agent asking via <code>mesh_escalate</code>.</span></div></div></Card> : null}
      {resolved.length ? (
        <details className="esc-raw"><summary>Done ({resolved.length})</summary>
          {resolved.slice().reverse().slice(0, 10).map((e) => (
            <div key={e.id} className="muted" style={{ fontSize: 12, marginTop: 4 }}>✔ {(escPlain(e, status, msgs, parked).title)} {e.respondedAt ? `· ${(ago(e.respondedAt))}` : ""}</div>
          ))}
        </details>
      ) : null}
    </ArtIndexCtx.Provider>
  );
}

function EscCard(props: {
  e: any; status: any; parked: boolean; raiseBusy: string | null; opBusy: string | null; msgs?: Map<string, any>; list?: any[];
  onRespond: (id: string, text: string) => void;
  onAnswer: (id: string, text: string) => void;
  onDrop: (id: string, label: string) => void;
  onRaise: (id: string, key: string, limit: number, confirm: boolean) => void;
  onRaiseCustom: (id: string, key: string) => void;
  onCapRaise: (kind: "events" | "time", id: string) => void;
  onCopyId: (id: string) => void;
}): React.JSX.Element {
  const { e, status, parked, raiseBusy, opBusy, msgs, list, onRespond, onAnswer, onDrop, onRaise, onRaiseCustom, onCapRaise, onCopyId } = props;
  // The parent already refused a second submit while one was in flight, but it
  // did so silently: the button stayed lit and the click vanished. `busy` is
  // that same guard made visible.
  const busy = opBusy === e.id;
  const otherBusy = opBusy !== null && !busy;
  const { openDrawer, setView, setEvSearch, setEvFilter } = useMesh();
  const info = escPlain(e, status, msgs, parked);
  const agents = escAgents(e);
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  const disUri = d.disagreementRef?.uri || e.disagreementArtifactRef?.uri;
  const cfgCap = info.budget?.configCap;
  const capKind = cfgCap === "time" ? "time" as const : "events" as const;
  const isStuck = e.reason === "stalemate:unanswered_request";
  const isDerived = e.reason === "stalemate";
  const stuck = (isStuck || isDerived) ? stuckInfoOf(e, msgs) : null;
  const reqMsg = stuck?.requestId && msgs ? msgs.get(stuck.requestId) : undefined;

  const submitRespond = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const input = ev.currentTarget.querySelector("input");
    onRespond(e.id, input?.value || "");
  };
  const submitAnswer = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const input = ev.currentTarget.querySelector("input");
    onAnswer(e.id, input?.value || "");
  };

  return (
    <div className={`card esc-card ${e.status === "OPEN" ? "" : "responded"}`} data-esc={e.id} style={{ marginBottom: 10 }}>
      <div className="row"><b style={{ fontSize: 15 }}>{(info.title)}</b><span className={`pill ${e.status === "OPEN" ? "failed" : "completed"}`}>{e.status === "OPEN" ? "waiting on you" : e.status === "AUTO_RESOLVED" ? "cleared itself" : "done"}</span></div>
      {!(isStuck || isDerived) ? (
        <div className="muted" style={{ margin: "4px 0", fontSize: 12 }}>{(e.raisedBy)} · {(ago(e.createdAt))} · <code>{(e.reason)}</code></div>
      ) : null}
      <p style={{ margin: "8px 0" }}>{(info.what)}</p>
      {info.budget && (info.budget.consumed || info.budget.limit) ? <BudgetMeter b={info.budget} /> : null}
      {agents.length && !(isStuck || isDerived) ? <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 6 }}><span className="muted" style={{ fontSize: 12 }}>involved:</span>{agents.map((a) => <button key={a} type="button" className="chip-toggle" onClick={() => openDrawer(<AgentDrawer id={a} />)}>{(a)}</button>)}</div> : null}
      {cfgCap && e.status === "OPEN" ? (
        <>
          <div className="row" style={{ marginTop: 10 }}><Button variant="primary" data-cap-raise={cfgCap} data-esc={e.id} disabled={raiseBusy === e.id + cfgCap} onClick={() => onCapRaise(capKind, e.id)}>Raise to {cfgCap === "events" ? fmt(capTarget("events", info, status)) : `${capTarget("time", info, status)}m`} &amp; resume</Button></div>
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>One click: raises the cap, updates mesh.yaml, records your decision.</div>
        </>
      ) : (
        <>
          {!(isStuck || isDerived) && info.next ? <div className="esc-next"><b>Next:</b> <span className="muted">{(info.next)}</span></div> : null}
          {info.budget?.raisable && e.status === "OPEN" && info.budget.key ? <TokenRaiseRow e={e} b={info.budget} raiseBusy={raiseBusy} onRaise={onRaise} onRaiseCustom={onRaiseCustom} /> : null}
          {!(isStuck || isDerived) ? (
          <div className="row esc-actions" style={{ marginTop: 8, flexWrap: "wrap" }}>
            {agents.map((a) => <Button key={a} variant="small" onClick={() => openDrawer(<AgentDrawer id={a} />)}>view {(a)}</Button>)}
            <Button variant="small" onClick={() => setView("cost")}>view cost</Button>
            <Button variant="small" onClick={() => { setEvSearch(e.id); setEvFilter(""); setView("events"); }}>related events</Button>
            {disUri ? <EvidenceRefs uris={[String(disUri)]} /> : null}
            <Button variant="small" title="Copy id" onClick={() => onCopyId(e.id)}>copy id</Button>
          </div>
          ) : null}
          {e.status === "OPEN" && isStuck && stuck ? (
            <StuckTaskCard
              e={e} stuck={stuck} reqMsg={reqMsg} parked={parked} busy={busy} otherBusy={otherBusy}
              placeholder={info.placeholder}
              onOpenThread={() => { if (reqMsg?.threadId) { setEvSearch(reqMsg.threadId); setEvFilter(""); setView("events"); } }}
              onAnswer={onAnswer} onDrop={onDrop}
            />
          ) : e.status === "OPEN" && isDerived ? (
            // A derived card lists the answers it is waiting on AND keeps its
            // own respond form. Previously it rendered the list alone, so when
            // the underlying cards were not rendered (already resolved, or the
            // summary listed none at all) the operator was left with a card
            // that had no button that did anything — the mission could only be
            // freed from the CLI. Answering here answers every support.
            <>
              <DerivedStuckSummary e={e} list={list ?? []} msgs={msgs} />
              <form className="respond-form" data-id={e.id} id={`respond-form-${e.id}`} onSubmit={submitRespond}>
                <div className="row" style={{ marginTop: 10 }}>
                  <Input style={{ flex: 1 }} defaultValue={draftGet(e.id)} onChange={(ev) => draftSet(e.id, ev.currentTarget.value)} placeholder={info.placeholder || "e.g. decided: …"} required disabled={busy} aria-label="Your decision" />
                  <Button variant="primary" type="submit" disabled={busy || otherBusy}>{busy ? "sending…" : "Answer all & resume"}</Button>
                </div>
                <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Sends this decision to every request listed above and resumes the mission.</div>
              </form>
            </>
          ) : e.status === "OPEN" ? (
            <form className="respond-form" data-id={e.id} id={`respond-form-${e.id}`} onSubmit={submitRespond}>
              <div className="row" style={{ marginTop: 10 }}><Input style={{ flex: 1 }} defaultValue={draftGet(e.id)} onChange={(ev) => draftSet(e.id, ev.currentTarget.value)} placeholder={info.placeholder || "e.g. decided: …"} required disabled={busy} aria-label="Your decision" /><Button variant="primary" type="submit" disabled={busy || otherBusy}>{busy ? "sending…" : parked ? "respond (stays parked)" : "respond + resume"}</Button></div>
              <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{info.budget?.raisable ? "Heads up: responding without adding budget just pauses again — the limit is still hit. " : ""}Your response is recorded as the <code>human</code> seat{parked ? <>. Nothing runs while parked — press <b>Continue</b> above to put it to work.</> : <>, unpauses the mission, and wakes {agents.length ? (agents.join(", ")) : "the affected agents"}.</>}</div>
            </form>
          ) : <div className="muted" style={{ marginTop: 8 }}>✔ {(e.response || "")} {e.respondedAt ? `· ${(ago(e.respondedAt))}` : ""}</div>}
        </>
      )}
      <details className="esc-raw"><summary>technical details</summary><pre>{(JSON.stringify({ reason: e.reason, raisedBy: e.raisedBy, conflictKey: e.conflictKey, detail: e.detail }, null, 2).slice(0, 2000))}</pre></details>
    </div>
  );
}

function StuckTaskCard(props: {
  e: any; stuck: StuckInfo; reqMsg?: any; parked: boolean; placeholder: string; busy: boolean; otherBusy: boolean;
  onOpenThread: () => void; onAnswer: (id: string, text: string) => void; onDrop: (id: string, label: string) => void;
}): React.JSX.Element {
  const { e, stuck, reqMsg, placeholder, busy, otherBusy, onOpenThread, onAnswer, onDrop } = props;
  const refs: any[] = Array.isArray(reqMsg?.artifactRefs) ? reqMsg.artifactRefs : [];
  // This used to be an uncontrolled input with `defaultValue={placeholder}`: the
  // suggested wording arrived pre-typed, and `required` was already satisfied by
  // it. Pressing Send therefore recorded a machine-written sentence as the
  // human seat's decision unless the operator noticed and overwrote it. The
  // suggestion is worth keeping — but as something you choose, not something
  // already in your mouth. Empty by default, one click to adopt it.
  // Seeded from the saved draft, not from the suggestion — a restored draft is
  // something the operator wrote, so `required` being satisfied is honest here.
  const [text, setText] = useState(() => draftGet(e.id));
  // Persisted outside React so a reload restores it; see draftGet's note.
  const write = (v: string) => {
    setText(v);
    draftSet(e.id, v);
  };
  const submit = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    onAnswer(e.id, text);
  };
  return (
    <div className="esc-next" style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13 }}>
        <b>{(stuck.askerId || "someone")} needs {(stuck.agentId || "an agent")}</b>
        {stuck.age ? <span className="muted"> · waiting {(stuck.age)}</span> : null}
      </div>
      <div style={{ fontSize: 13, marginTop: 6 }}>Do this: {(stuck.requestLabel.slice(0, 280))}</div>
      <EvidenceRefs uris={refs.map((r: any) => String(r?.uri || "")).filter(Boolean)} />
      <form className="respond-form" data-id={e.id} id={`respond-form-${e.id}`} onSubmit={submit}>
        <div className="row" style={{ marginTop: 10 }}>
          <Input
            style={{ flex: 1 }} value={text} onChange={(ev) => write(ev.currentTarget.value)}
            placeholder={placeholder || "your answer…"} required disabled={busy}
            aria-label={`Your answer to ${stuck.askerId || "the agent"}`}
          />
          <Button variant="primary" type="submit" disabled={busy || otherBusy || !text.trim()}>{busy ? "sending…" : "Send + resume work"}</Button>
        </div>
        <div className="row esc-stuck-acts" style={{ marginTop: 6 }}>
          {placeholder && text !== placeholder ? (
            <Button variant="small" title="Fill the box with the suggested answer — you can still edit it" onClick={() => write(placeholder)}>use suggested answer</Button>
          ) : null}
          {reqMsg?.threadId ? <Button variant="small" onClick={onOpenThread}>see full thread</Button> : null}
          <Button variant="small" danger disabled={busy || otherBusy} title="Drop this request — the waiting agent continues without an answer" onClick={() => onDrop(e.id, stuck.requestLabel)}>Skip — not needed</Button>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>Sends the answer and restarts work. Nothing else to press.</div>
      </form>
    </div>
  );
}

function DerivedStuckSummary(props: { e: any; list: any[]; msgs?: Map<string, any> }): React.JSX.Element {
  const { e, list, msgs } = props;
  const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  const supports: string[] = Array.isArray(e.supports)
    ? e.supports.filter((x: any) => typeof x === "string")
    : (Array.isArray(d.openDeadlockEscalations) ? d.openDeadlockEscalations : []).map((o: any) => o?.id).filter((x: any) => typeof x === "string");
  const byId = new Map((list || []).map((x: any) => [x.id, x]));
  // Only rows whose card is actually rendered (i.e. still OPEN) get the jump
  // button — pointing at a card that was filtered out of the list produced a
  // button that silently did nothing.
  const rows = supports.map((id) => ({ id, u: byId.get(id) }));
  const live = rows.filter((r) => r.u?.status === "OPEN");
  return (
    <div className="esc-next" style={{ marginTop: 8 }}>
      <b>Waiting on ({live.length}):</b>
      {live.length === 0 ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Nothing is waiting any more — every request this summary covered has already been answered. The mesh retires this card on its
          own within a few seconds; answering below clears it immediately.
        </div>
      ) : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
        {live.map(({ id, u }) => {
          const dd = (u?.detail && typeof u.detail === "object" ? u.detail : {}) as Record<string, any>;
          const rid = typeof dd.requestMessageId === "string" ? dd.requestMessageId : "";
          const m = rid && msgs ? msgs.get(rid) : undefined;
          const desc = typeof dd.description === "string" ? dd.description.trim() : "";
          const title = m ? plainTaskOf(m, dd.requestType).title : desc || plainTaskOf(m, dd.requestType).title;
          const participants = Array.isArray(dd.participants) ? dd.participants.filter((p: any) => typeof p === "string") : [];
          const who = dd.agentId ? `needs ${dd.agentId}` : participants.length > 0 ? participants.join(", ") : "waiting";
          return (
            <div key={id} className="row" style={{ justifyContent: "space-between" }}>
              <span style={{ fontSize: 13 }}>{(title)} <span className="muted">· {(who)}</span></span>
              <Button
                variant="small"
                onClick={() => document.querySelector(`[data-esc="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
              >
                Open below ↓
              </Button>
            </div>
          );
        })}
      </div>
      {live.length ? <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>Answer each one below, or answer them all at once here.</div> : null}
    </div>
  );
}

function StuckRequestBox(props: { stuck: { agentId: string; askerId: string; requestId: string; requestType: string; age: string; requestLabel: string }; reqMsg?: any; onOpenThread: () => void }): React.JSX.Element {
  const { stuck, reqMsg, onOpenThread } = props;
  const refs: any[] = Array.isArray(reqMsg?.artifactRefs) ? reqMsg.artifactRefs : [];
  return (
    <div className="esc-next" style={{ marginTop: 8 }}>
      <div style={{ fontSize: 13 }}>
        <b>{(stuck.askerId || "someone")} → {(stuck.agentId || "agent")}</b>
        <span className="muted"> · {(stuck.requestType || "request")}{stuck.age ? ` · ${(stuck.age)}` : ""}</span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>“{(stuck.requestLabel.slice(0, 280))}”</div>
      <EvidenceRefs uris={refs.map((r: any) => String(r?.uri || "")).filter(Boolean)} />
      <div className="row" style={{ marginTop: 6 }}>
        {reqMsg?.threadId ? <Button variant="small" onClick={onOpenThread}>open thread</Button> : null}
        {stuck.requestId ? <span className="muted mono" style={{ fontSize: 11 }}>{(stuck.requestId.slice(0, 24))}</span> : null}
      </div>
    </div>
  );
}

function TokenRaiseRow(props: { e: any; b: BudgetInfo; raiseBusy: string | null; onRaise: (id: string, key: string, limit: number, confirm: boolean) => void; onRaiseCustom: (id: string, key: string) => void }): React.JSX.Element {
  const { e, b, raiseBusy, onRaise, onRaiseCustom } = props;
  const { status } = useMesh();
  const live = (status?.budgets || []).find((x: any) => x.key === b.key);
  const limit = live?.limit ?? b.limit ?? 0;
  if (!limit) return <></>;
  const half = roundNice(limit * 1.5);
  const dbl = roundNice(limit * 2);
  const busy = raiseBusy === e.id + (b.key || "");
  return (
    <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 10 }}>
      <Button variant="small" disabled={busy} onClick={() => onRaise(e.id, b.key as string, half, true)}>+50% ({fmt(half)}) &amp; resume</Button>
      <Button variant="small" disabled={busy} onClick={() => onRaise(e.id, b.key as string, dbl, true)}>×2 ({fmt(dbl)}) &amp; resume</Button>
      <span className="row" style={{ gap: 6 }}><Input style={{ width: 110 }} defaultValue={half} data-raise-custom={b.key} title="New absolute limit" /><Button variant="small" disabled={busy} onClick={() => onRaiseCustom(e.id, b.key as string)}>set &amp; resume</Button></span>
    </div>
  );
}
