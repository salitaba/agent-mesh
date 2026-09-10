import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, clientFor, setApiNotifier, onServerDownChange, type ProjectClient } from "./api";
import { VIEWS, hashFor, parseHash, type HashRoute, type View } from "./route";
import { useProjectsOptional, type ProjectSink } from "./projects";
import { retainCap, trimRetained } from "./tabmodel";

export interface TimelineEvent {
  seq: number;
  id: string;
  type: string;
  timestamp: string;
  actorId?: string;
  payload: any;
  causationId?: string;
  correlationId?: string;
  goalId?: string;
  summary?: string;
}

export interface TurnStep {
  turnId: string;
  agentId: string;
  reasonKind: string;
  reasonNote?: string;
  triggerEventType?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "ok" | "waiting" | "blocked" | "failed";
  lifecycle: string;
  ops: { messages: number; artifacts: number; tasks: number; decisions: number };
  messageIds: string[];
  artifactIds: string[];
  tokens: number;
  model?: string;
  error?: string;
  seqStart: number;
  seqEnd: number;
  eventCount: number;
  /** Sub-turn timing — present only for turns still in the server's memory. */
  phases?: import("./vitals").TurnPhases;
  /** >1 when the scheduler re-activated this agent after a timeout. */
  attempt?: number;
  streamChars?: number;
  errorDetail?: import("./vitals").TurnError;
  opTimings?: import("./vitals").OpTiming[];
}

export interface Toast {
  id: number;
  title: string;
  msg: string;
  kind: string;
}

/** Live token buffer for one running turn (out-of-band, never in the log). */
export interface StreamBuf {
  text: string;
  chars: number;
  updatedAt: number;
  /** When the first delta landed — client-side TTFT when the server has no marks. */
  firstAt: number;
}

/** Client-side caps: DOM stays cheap even if a turn streams a novel. */
const STREAM_TEXT_MAX = 40000;
const STREAM_TURNS_MAX = 50;

// Routing moved to ./route (DOM-free, and therefore testable); re-exported here
// because every view imports `View` from the store.
export { VIEWS, hashFor, parseHash };
export type { HashRoute, View };

function normEvent(raw: any): TimelineEvent | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type && (raw.timestamp || raw.at)) {
    return {
      seq: raw.seq ?? 0,
      id: raw.id ?? `seq-${raw.seq}`,
      type: raw.type,
      timestamp: raw.timestamp ?? raw.at,
      actorId: raw.actorId ?? raw.actor,
      payload: raw.payload ?? {},
      causationId: raw.causationId,
      correlationId: raw.correlationId,
      goalId: raw.goalId,
      summary: raw.summary,
    };
  }
  return null;
}

const currentRoute = (): HashRoute => parseHash(window.location.hash);

function viewFromHash(): View {
  return currentRoute().view;
}

interface MeshState {
  /** The project every call from this store is addressed to. */
  projectId: string | null;
  /** api/post/getText already bound to `projectId` — the way views should
   *  reach the server, instead of a bare path that the host has to guess at. */
  client: ProjectClient;
  view: View;
  setView: (v: View) => void;
  status: any;
  events: TimelineEvent[];
  lastSeq: number;
  serverDown: boolean;
  sseState: "connecting" | "open" | "reconnecting";
  livePaused: boolean;
  setLivePaused: (b: boolean) => void;
  steps: TurnStep[];
  setSteps: (s: TurnStep[]) => void;
  /** False until a /steps response has landed once. An empty `steps` array
   *  means nothing on its own — every consumer used to render "no work yet"
   *  during the very first fetch. */
  stepsLoaded: boolean;
  streams: Record<string, StreamBuf>;
  stepLimit: number;
  setStepLimit: (n: number) => void;
  stepFilter: string;
  setStepFilter: (s: string) => void;
  stepSearch: string;
  setStepSearch: (s: string) => void;
  vocab: any;
  goalId: string | null;
  toasts: Toast[];
  toast: (title: string, msg: string, kind?: string) => void;
  drawer: ReactNode;
  drawerDepth: number;
  openDrawer: (node: ReactNode) => void;
  closeDrawer: () => void;
  /** Deep-linked detail (step/agent) reflected in the URL hash. */
  detail: HashRoute["detail"] | null;
  openDetail: (kind: "step" | "agent", id: string) => void;
  closeDetail: () => void;
  primeEvents: (list: unknown[]) => void;
  refreshStatus: () => Promise<void>;
  refreshSteps: (force?: boolean) => Promise<void>;
  evSearch: string;
  setEvSearch: (s: string) => void;
  evFilter: string;
  setEvFilter: (s: string) => void;
}

const Ctx = createContext<MeshState | null>(null);
export const useMesh = (): MeshState => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMesh outside provider");
  return v;
};

let toastId = 1;

/**
 * One instance per open project, mounted with `key={projectId}` so React gives
 * each project its own state. `MeshState` deliberately has no project dimension:
 * a map inside the store would put every projection behind a lookup and make
 * every consumer responsible for asking about the right project.
 *
 * `background` is the tab that is open but not on screen. It keeps ingesting —
 * that is what makes switching back instant — but renders nothing, polls
 * nothing, and retains a fraction of the events. Ten idle tabs each holding a
 * full foreground buffer and each polling `/status` every 4s is an unbounded
 * leak plus 10 requests a second; the events a background tab drops are
 * exactly the ones `/events` refills when it comes back into focus.
 */
export function MeshProvider({ children, projectId = null, background = false }: { children: ReactNode; projectId?: string | null; background?: boolean }): React.JSX.Element {
  const [view, setViewState] = useState<View>(viewFromHash);
  const [detail, setDetail] = useState<HashRoute["detail"] | null>(() => currentRoute().detail ?? null);
  const [status, setStatus] = useState<any>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [serverDown, setServerDown] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const [steps, setStepsState] = useState<TurnStep[]>([]);
  const [stepsLoaded, setStepsLoaded] = useState(false);
  const [streams, setStreams] = useState<Record<string, StreamBuf>>({});
  const [stepLimit, setStepLimit] = useState(60);
  const [stepFilter, setStepFilter] = useState("");
  const [stepSearch, setStepSearch] = useState("");
  const [evSearch, setEvSearch] = useState("");
  const [evFilter, setEvFilter] = useState("");
  const [vocab, setVocab] = useState<any>(null);
  const [goalId, setGoalId] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [drawerStack, setDrawerStack] = useState<ReactNode[]>([]);

  const eventById = useRef(new Map<string, TimelineEvent>());
  const seqSeen = useRef(new Set<string | number>());
  const viewRef = useRef(view);
  viewRef.current = view;
  const livePausedRef = useRef(livePaused);
  livePausedRef.current = livePaused;
  const vocabRef = useRef(vocab);
  vocabRef.current = vocab;
  const lastSeqRef = useRef(0);
  const stepsAt = useRef(0);
  const statusInflight = useRef<Promise<void> | null>(null);

  // Every call this store makes is bound to its own project, so two mounted
  // providers can never answer each other's requests.
  const client = useMemo<ProjectClient>(() => clientFor(projectId), [projectId]);
  const clientRef = useRef(client);
  clientRef.current = client;
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const backgroundRef = useRef(background);
  backgroundRef.current = background;
  /** Set while backgrounded and cleared on focus: what tells the refill it has
   *  a gap to close rather than a full buffer it can trust. */
  const droppedRef = useRef(false);

  // The live connection belongs to ProjectsProvider — one socket for every
  // project, not one per store. Its state is surfaced here unchanged so the
  // shell's connection indicator keeps working.
  const projectsCtx = useProjectsOptional();
  const sseState = projectsCtx?.sseState ?? "connecting";
  const subscribe = projectsCtx?.subscribe;

  const toast = useCallback((title: string, msg: string, kind = "") => {
    const id = toastId++;
    setToasts((t) => [...t.slice(-3), { id, title, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "bad" ? 7600 : 4800);
  }, []);

  useEffect(() => {
    setApiNotifier((t, m, k) => toast(t, m, k));
    return onServerDownChange(setServerDown);
  }, [toast]);

  const setView = useCallback((v: View) => {
    window.location.hash = hashFor(projectIdRef.current, v);
    setViewState(v);
    setDetail(null);
  }, []);

  // Detail lives in the URL so a step or agent can be refreshed, shared and
  // reached with the browser Back button. The drawer stack stays for the
  // deeper drill-downs (event → artifact) that have no stable identity worth
  // a URL of their own.
  const openDetail = useCallback((kind: "step" | "agent", id: string) => {
    setDetail({ kind, id });
    window.location.hash = hashFor(projectIdRef.current, viewRef.current, { kind, id });
  }, []);

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.location.hash = hashFor(projectIdRef.current, viewRef.current);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const r = currentRoute();
      // A bare `#/steps` is a pre-projects link: rewrite it onto this project
      // rather than letting the hash and the mounted store disagree.
      if (r.projectId === null && projectIdRef.current) {
        window.location.replace(hashFor(projectIdRef.current, r.view, r.detail));
        return;
      }
      if (r.view !== viewRef.current) setViewState(r.view);
      setDetail((cur) => {
        const next = r.detail ?? null;
        if (cur?.kind === next?.kind && cur?.id === next?.id) return cur;
        return next;
      });
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const openDrawer = useCallback((node: ReactNode) => setDrawerStack((s) => [...s, node]), []);
  const closeDrawer = useCallback(() => setDrawerStack((s) => s.slice(0, -1)), []);
  // The drawer is a stack: drilling event → step → artifact pushes, Esc / × /
  // scrim pops one level so the user never loses their place mid-investigation.
  const drawer = drawerStack.length ? drawerStack[drawerStack.length - 1] : null;
  const drawerDepth = drawerStack.length;

  const refreshStatus = useCallback(async () => {
    if (statusInflight.current) return statusInflight.current;
    statusInflight.current = (async () => {
      const { json } = await clientRef.current.api("GET", "/status");
      if (!json) return;
      setStatus(json);
      setGoalId(json.goal?.id ?? null);
    })().finally(() => {
      statusInflight.current = null;
    });
    return statusInflight.current;
  }, []);

  const setSteps = useCallback((s: TurnStep[]) => {
    setStepsState(s);
    setStepsLoaded(true);
    stepsAt.current = Date.now();
  }, []);

  const refreshSteps = useCallback(async (force = false) => {
    if (viewRef.current !== "steps" && !force) return;
    if (Date.now() - stepsAt.current < 1800 && !force) return;
    try {
      const { json } = await clientRef.current.api("GET", `/steps?limit=${stepLimit}`);
      if (Array.isArray(json)) {
        setStepsState(json);
        setStepsLoaded(true);
        stepsAt.current = Date.now();
      }
    } catch {
      /* keep stale */
    }
  }, [stepLimit]);

  const ingestEvent = useCallback((raw: any) => {
    const e = normEvent(raw);
    if (!e || !e.type) return;
    const key = e.seq || e.id;
    if (key && seqSeen.current.has(key)) return;
    if (key) seqSeen.current.add(key);
    if (e.seq && e.seq > lastSeqRef.current) {
      lastSeqRef.current = e.seq;
      setLastSeq(e.seq);
    }
    if (e.id) eventById.current.set(e.id, e);
    setEvents((prev) => {
      const cap = retainCap(backgroundRef.current);
      const next = [...prev, e];
      if (next.length > cap) {
        // What falls off the front is gone from this store until a refill.
        // Recording that is what stops a backgrounded tab from coming back with
        // a plausible-looking timeline that quietly starts mid-mission.
        if (backgroundRef.current) droppedRef.current = true;
        for (const d of next.splice(0, next.length - cap)) if (d.id) eventById.current.delete(d.id);
      }
      return next;
    });
    // A background tab must not shout: its toasts belong to a mission the
    // operator is not looking at, and the project's own tab already carries
    // its status.
    if (backgroundRef.current) return;
    if (e.type === "goal.completed") toast("goal completed", "all mandatory criteria evidenced", "ok");
    if (e.type === "goal.escalated") toast("mission escalated", String(e.payload?.reason || ""), "bad");
    if (e.type === "goal.failed") toast("mission failed", String(e.payload?.reason || ""), "bad");
    if (e.type === "escalation.requested") toast("escalation opened", `${e.payload?.escalation?.reason} (by ${e.payload?.escalation?.raisedBy})`, "warn");
    if (e.type === "agent.failed") toast("agent failed", `${e.payload?.agentId}: ${String(e.payload?.error || "").slice(0, 90)}`, "bad");
    if (e.type === "budget.exceeded") toast("budget exceeded", `${e.payload?.key}`, "warn");
  }, [toast]);

  const ingestToken = useCallback((raw: any) => {
    // turn.token frames bypass the event timeline entirely (no seq, no log):
    // they only feed the live stream buffers of open step drawers.
    const turnId = raw?.turnId;
    const delta = raw?.delta;
    if (typeof turnId !== "string" || !turnId || typeof delta !== "string" || !delta) return;
    setStreams((prev) => {
      const cur = prev[turnId];
      const now = Date.now();
      const text = ((cur?.text ?? "") + delta).slice(-STREAM_TEXT_MAX);
      const next: Record<string, StreamBuf> = {
        ...prev,
        [turnId]: { text, chars: (cur?.chars ?? 0) + delta.length, updatedAt: now, firstAt: cur?.firstAt ?? now },
      };
      const keys = Object.keys(next);
      if (keys.length > STREAM_TURNS_MAX) {
        keys.sort((a, b) => next[a].updatedAt - next[b].updatedAt);
        for (const k of keys.slice(0, keys.length - STREAM_TURNS_MAX)) delete next[k];
      }
      return next;
    });
  }, []);

  const primeEvents = useCallback((list: unknown[]) => {
    // History load uses the same path as live events (normEvent handles both
    // raw MeshEvents and timeline entries) so search/drawers keep full fidelity.
    for (const raw of list || []) ingestEvent(raw);
  }, [ingestEvent]);

  const livePatch = useCallback(() => {
    // Nothing is on screen to patch. The events still land in the buffer; it
    // is the derived fetches (status, steps) that would be N requests a second
    // across N idle tabs for a view nobody is looking at.
    if (backgroundRef.current) return;
    void refreshStatus();
    if (viewRef.current === "steps") void refreshSteps(false);
    if (viewRef.current === "overview" && Date.now() - stepsAt.current > 5000) {
      clientRef.current.api("GET", "/steps?limit=6").then(({ json }) => {
        if (Array.isArray(json)) {
          setSteps(json);
          stepsAt.current = Date.now();
        }
      }).catch(() => undefined);
    }
  }, [refreshStatus, refreshSteps]);

  // Frames arrive from ProjectsProvider's single multiplexed connection rather
  // than a socket of this store's own. Registering is what puts this project in
  // the stream's project set; unregistering on unmount is what stops a switched
  // -away project from streaming forever.
  useEffect(() => {
    if (!subscribe || !projectId) return;
    const sink: ProjectSink = {
      event: (raw) => {
        if (livePausedRef.current) return;
        ingestEvent(raw);
        livePatch();
      },
      stream: (_type, raw) => ingestToken(raw),
      resync: () => {
        // Continuity is gone. Refetch instead of carrying on: the alternative
        // is a timeline that silently misses everything the gap swallowed.
        seqSeen.current.clear();
        void refreshStatus();
        void refreshSteps(true);
        clientRef.current.api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 }).then(({ json }) => {
          if (Array.isArray(json)) for (const raw of json) ingestEvent(raw);
        }).catch(() => undefined);
      },
      cursor: () => lastSeqRef.current,
    };
    return subscribe(projectId, sink);
  }, [subscribe, projectId, ingestEvent, ingestToken, livePatch, refreshStatus, refreshSteps]);

  // Coming back into focus: the buffer was capped while backgrounded, so
  // whatever fell off has to come from `/events` rather than be assumed
  // present. Refetching unconditionally would re-download 400 events every
  // time the operator flicked between two idle tabs.
  useEffect(() => {
    if (background || !projectId) return;
    void refreshStatus();
    if (!droppedRef.current) return;
    droppedRef.current = false;
    let dead = false;
    clientRef.current
      .api("GET", `/events?limit=${retainCap(false)}`, undefined, { timeoutMs: 30000 })
      .then(({ json }) => {
        if (dead || !Array.isArray(json)) return;
        // seqSeen dedupes against what survived the cap, so the refill merges
        // rather than duplicating the tail.
        for (const raw of json) ingestEvent(raw);
      })
      .catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [background, projectId, ingestEvent, refreshStatus]);

  useEffect(() => {
    const saved = localStorage.getItem("mesh-theme");
    if (saved) document.documentElement.dataset.theme = saved;
    let dead = false;
    (async () => {
      try {
        const { json } = await clientRef.current.api("GET", "/config/vocabulary");
        if (!dead && json) {
          setVocab(json);
          vocabRef.current = json;
        }
      } catch {
        /* the stream falls back to a builtin type list */
      }
      try {
        await refreshStatus();
      } catch {
        toast("mesh", "server unreachable — retrying…", "bad");
      }
    })();
    const iv = setInterval(() => {
      if (backgroundRef.current) return;
      void refreshStatus().catch(() => undefined);
    }, 4000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<MeshState>(
    () => ({
      projectId, client,
      view, setView, status, events, lastSeq, serverDown, sseState, livePaused, setLivePaused,
      steps, stepsLoaded, stepFilter, setStepFilter, stepSearch, setStepSearch, vocab, goalId,
      toasts, toast, drawer, drawerDepth, openDrawer, closeDrawer, refreshStatus, refreshSteps, setSteps, setStepLimit, stepLimit, primeEvents, evSearch, setEvSearch, evFilter, setEvFilter,
      streams, detail, openDetail, closeDetail,
    }),
    [projectId, client, view, setView, status, events, lastSeq, serverDown, sseState, livePaused, steps, stepsLoaded, setSteps, stepFilter, stepSearch, vocab, goalId, toasts, toast, drawer, drawerDepth, openDrawer, closeDrawer, refreshStatus, refreshSteps, setStepLimit, stepLimit, primeEvents, evSearch, evFilter, streams, detail, openDetail, closeDetail],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
