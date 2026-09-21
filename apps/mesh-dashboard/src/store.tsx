import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, clientFor, setApiNotifier, onServerDownChange, type ProjectClient } from "./api";
import { VIEWS, hashFor, parseHash, type HashRoute, type View } from "./route";
import { useProjectsOptional, type ProjectSink } from "./projects";
import { retainCap, trimRetained } from "./tabmodel";
import { foldToolEvent, type ToolLive } from "./streams";
import { ConfirmDialog, type ConfirmFn, type ConfirmRequest } from "./components";

/** Derived from the route rather than restated, so the two cannot drift apart. */
export type DetailKind = NonNullable<HashRoute["detail"]>["kind"];

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
  /**
   * The split behind `tokens` — fresh input, output, and transcript replayed
   * from cache. Absent when the backend reported none; mirrored from the server
   * step (`packages/observability/src/steps.ts`), which is the authority.
   */
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
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
  /** Tool frames seen — the only throughput a file-writing turn produces. */
  toolFrames?: number;
  errorDetail?: import("./vitals").TurnError;
  opTimings?: import("./vitals").OpTiming[];
}

export interface Toast {
  id: number;
  title: string;
  msg: string;
  kind: string;
  /**
   * An optional one-click follow-up, for the case where the notice is the only
   * chance to act — undoing a delete, retrying a failed save. A toast carrying
   * one stays up longer, because an affordance that disappears before it can be
   * read is worse than none at all.
   */
  action?: { label: string; run: () => void };
}

/** Live token buffer for one running turn (out-of-band, never in the log). */
export interface StreamBuf {
  text: string;
  chars: number;
  updatedAt: number;
  /** When the first delta landed — client-side TTFT when the server has no marks. */
  firstAt: number;
  /**
   * Tool calls seen live on this turn (`turn.tool`). Absent until one arrives,
   * and absent for the whole turn on backends that stream text only.
   */
  tools?: ToolLive[];
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
  stepLimit: number;
  setStepLimit: (n: number) => void;
  stepFilter: string;
  setStepFilter: (s: string) => void;
  stepSearch: string;
  setStepSearch: (s: string) => void;
  vocab: any;
  goalId: string | null;
  toasts: Toast[];
  toast: (title: string, msg: string, kind?: string, action?: Toast["action"]) => void;
  /**
   * Ask before something irreversible. Resolves to the typed text on confirm
   * (`""` when the dialog asked for none) and `null` on cancel — awaited, so
   * unlike window.confirm() it does not freeze the tab and stall the SSE
   * stream behind a browser-drawn modal.
   */
  confirm: ConfirmFn;
  drawer: ReactNode;
  drawerDepth: number;
  openDrawer: (node: ReactNode) => void;
  closeDrawer: () => void;
  /** Deep-linked detail (step/agent/event) reflected in the URL hash. */
  detail: HashRoute["detail"] | null;
  /**
   * `view` opens a detail that lives on a different page — the Overview
   * mini-feed sending an event to the console. Writing the hash is the whole
   * navigation: the `hashchange` listener syncs the view back out of it.
   */
  openDetail: (kind: DetailKind, id: string, view?: View) => void;
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

const StreamsCtx = createContext<{ streams: Record<string, StreamBuf> }>({ streams: {} });
export const useMeshStreams = (): { streams: Record<string, StreamBuf> } => useContext(StreamsCtx);

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
  const [stepLimit, setStepLimitState] = useState(60);
  // refreshSteps reads the limit through a ref: a plain dep made "load older
  // turns" rebuild the subscription effect and reconnect the shared SSE
  // stream twice on every click.
  const stepLimitRef = useRef(stepLimit);
  const setStepLimit = useCallback((n: number) => {
    stepLimitRef.current = n;
    setStepLimitState(n);
  }, []);
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
  const livePausedRef = useRef(livePaused);
  const vocabRef = useRef(vocab);
  const lastSeqRef = useRef(0);
  const stepsAt = useRef(0);
  const statusInflight = useRef<Promise<void> | null>(null);

  // Every call this store makes is bound to its own project, so two mounted
  // providers can never answer each other's requests.
  const client = useMemo<ProjectClient>(() => clientFor(projectId), [projectId]);
  const clientRef = useRef(client);
  const projectIdRef = useRef(projectId);
  const backgroundRef = useRef(background);
  // Refs are synced after commit, not during render, so a discarded concurrent
  // render cannot leak its values into handlers or the SSE sink. Declared
  // before every consumer effect, so they all read fresh values.
  useEffect(() => {
    viewRef.current = view;
    livePausedRef.current = livePaused;
    vocabRef.current = vocab;
    clientRef.current = client;
    projectIdRef.current = projectId;
    backgroundRef.current = background;
  });
  /** Set while backgrounded and cleared on focus: what tells the refill it has
   *  a gap to close rather than a full buffer it can trust. */
  const droppedRef = useRef(false);

  // The live connection belongs to ProjectsProvider — one socket for every
  // project, not one per store. Its state is surfaced here unchanged so the
  // shell's connection indicator keeps working.
  const projectsCtx = useProjectsOptional();
  const sseState = projectsCtx?.sseState ?? "connecting";
  /**
   * Whether there is a mesh behind this server to talk to *yet*. Three states
   * collapse into it:
   *   - no projects provider at all  → single mesh, always ready
   *   - registry answered 404        → `mesh console`, one mesh, ready
   *   - registry answered with rows  → host with a project open, ready
   *   - registry unknown or empty    → hold
   * Every mesh-scoped route answers 409 ("no project is open") in the hold
   * state, and firing them anyway is how the dashboard used to paint a full
   * Overview of zeros out of five failed requests.
   */
  const meshReady = !projectsCtx
    ? true
    : projectsCtx.hasRegistry === false || (projectsCtx.loaded && projectsCtx.projects.length > 0);
  // A ref because the 4s poll reads it from inside a long-lived interval that
  // must not be rebuilt every time the project list changes.
  const holdMeshRef = useRef(!meshReady);
  holdMeshRef.current = !meshReady;
  const subscribe = projectsCtx?.subscribe;

  const toast = useCallback((title: string, msg: string, kind = "", action?: Toast["action"]) => {
    const id = toastId++;
    const dismiss = () => setToasts((t) => t.filter((x) => x.id !== id));
    const wrapped = action ? { ...action, run: () => { dismiss(); action.run(); } } : undefined;
    setToasts((t) => [...t.slice(-3), { id, title, msg, kind, action: wrapped }]);
    // 4.8s is enough to read a confirmation but not to notice, aim at and press
    // an Undo button — so an actionable toast gets roughly twice the window.
    setTimeout(dismiss, action ? 10000 : kind === "bad" ? 7600 : 4800);
  }, []);

  useEffect(() => {
    // Only the foreground store may own the notifier: a background provider
    // renders no Shell, so its toasts would land in state nothing shows, and
    // registering from both means whichever mounted last wins.
    if (!background) setApiNotifier((t, m, k) => toast(t, m, k));
    return onServerDownChange(setServerDown);
  }, [toast, background]);

  const setView = useCallback((v: View) => {
    window.location.hash = hashFor(projectIdRef.current, v);
    setViewState(v);
    setDetail(null);
  }, []);

  // Detail lives in the URL so a step, agent or event can be refreshed, shared
  // and reached with the browser Back button. The drawer stack stays for the
  // deeper drill-downs (artifact bodies, token streams) that have no stable
  // identity worth a URL of their own.
  //
  // `setDetail` runs even though the hash write below will fire `hashchange`
  // and set it again: the listener is async relative to the click, and the
  // extra pass is a no-op because it compares kind+id before replacing.
  const openDetail = useCallback((kind: DetailKind, id: string, view?: View) => {
    setDetail({ kind, id });
    window.location.hash = hashFor(projectIdRef.current, view ?? viewRef.current, { kind, id });
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
    })()
      // A status poll must never reject: it is fired from keyboard handlers,
      // the interval and livePatch, none of which can present a failure.
      .catch(() => undefined)
      .finally(() => {
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
      const { json } = await clientRef.current.api("GET", `/steps?limit=${stepLimitRef.current}`);
      if (Array.isArray(json)) {
        setStepsState(json);
        setStepsLoaded(true);
        stepsAt.current = Date.now();
      }
    } catch {
      /* keep stale */
    }
  }, []);

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
        [turnId]: { text, chars: (cur?.chars ?? 0) + delta.length, updatedAt: now, firstAt: cur?.firstAt ?? now, tools: cur?.tools },
      };
      const keys = Object.keys(next);
      if (keys.length > STREAM_TURNS_MAX) {
        keys.sort((a, b) => next[a].updatedAt - next[b].updatedAt);
        for (const k of keys.slice(0, keys.length - STREAM_TURNS_MAX)) delete next[k];
      }
      return next;
    });
  }, []);

  const ingestToolEvent = useCallback((raw: any) => {
    // `turn.tool` nests its event: {type, turnId, agentId, tool, at}. Same
    // out-of-band path as turn.token — no seq, no log, drawer buffers only.
    const turnId = raw?.turnId;
    if (typeof turnId !== "string" || !turnId) return;
    setStreams((prev) => {
      const cur = prev[turnId];
      const now = Date.now();
      const tools = foldToolEvent(cur?.tools, raw?.tool, now);
      // Nothing usable in the frame: re-rendering every open drawer for it
      // would be pure cost.
      if (!tools) return prev;
      const next: Record<string, StreamBuf> = {
        ...prev,
        [turnId]: { text: cur?.text ?? "", chars: cur?.chars ?? 0, updatedAt: now, firstAt: cur?.firstAt ?? now, tools },
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
  }, [refreshStatus, refreshSteps, setSteps]);

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
      stream: (type, raw) => {
        if (type === "turn.tool") ingestToolEvent(raw);
        else ingestToken(raw);
      },
      resync: () => {
        // Continuity is gone. Refetch instead of carrying on: the alternative
        // is a timeline that silently misses everything the gap swallowed.
        // The dedupe set is kept on purpose — ingestEvent drops events already
        // seen by seq/id, so the refill merges instead of duplicating the tail.
        void refreshStatus();
        void refreshSteps(true);
        clientRef.current.api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 }).then(({ json }) => {
          if (Array.isArray(json)) for (const raw of json) ingestEvent(raw);
        }).catch(() => undefined);
      },
      cursor: () => lastSeqRef.current,
    };
    return subscribe(projectId, sink);
  }, [subscribe, projectId, ingestEvent, ingestToken, ingestToolEvent, livePatch, refreshStatus, refreshSteps]);

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
        // Mesh-scoped like the rest: 409s on a host with nothing open.
        if (holdMeshRef.current) throw new Error("no mesh yet");
        const { json } = await clientRef.current.api("GET", "/config/vocabulary");
        if (!dead && json) {
          setVocab(json);
          vocabRef.current = json;
        }
      } catch {
        /* the stream falls back to a builtin type list */
      }
      try {
        if (!holdMeshRef.current) await refreshStatus();
      } catch {
        toast("mesh", "server unreachable — retrying…", "bad");
      }
    })();
    const iv = setInterval(() => {
      if (backgroundRef.current) return;
      // Nothing to ask about yet; the effect below picks it up the moment a
      // project opens, so this does not need to keep knocking.
      if (holdMeshRef.current) return;
      void refreshStatus().catch(() => undefined);
    }, 4000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [refreshStatus, toast]);

  // The poll above idles until a mesh exists; the registry answering, or the
  // first project opening, has to wake it — otherwise the dashboard sits blank
  // until the next reload.
  useEffect(() => {
    if (!meshReady) return;
    void refreshStatus().catch(() => undefined);
  }, [meshReady, refreshStatus]);

  // One dialog instance per provider, driven by whichever call is awaiting it.
  // Holding the resolver here (rather than inside the component) keeps the
  // promise and the unmount in one place: closing always settles the await.
  const [confirmReq, setConfirmReq] = useState<{ req: ConfirmRequest; resolve: (v: string | null) => void } | null>(null);
  // That covered the *dialog's* unmount, not the provider's. A provider can be
  // torn down with an ask still open — a project dropping out of `mounted` in
  // main.tsx mid-question — and the resolver dies with it, leaving the caller
  // awaiting a promise nobody will ever settle. `useGoLive` behind the parked
  // banner's Continue is the one that bit: no toast, no busy state, no error,
  // just a click that did nothing, forever. Mirror the resolver so the
  // provider's own teardown can settle it the way a cancel would.
  const pendingConfirm = useRef<{ resolve: (v: string | null) => void } | null>(null);
  useEffect(() => {
    pendingConfirm.current = confirmReq;
  }, [confirmReq]);
  useEffect(
    () => () => {
      pendingConfirm.current?.resolve(null);
    },
    [],
  );
  const confirm = useCallback<ConfirmFn>(
    (req) =>
      new Promise((resolve) => {
        // A second ask while one is already open would strand the first
        // caller's promise forever, so the older one resolves as cancelled.
        setConfirmReq((prev) => {
          if (prev) prev.resolve(null);
          return { req, resolve };
        });
      }),
    [],
  );

  const value = useMemo<MeshState>(
    () => ({
      projectId, client,
      view, setView, status, events, lastSeq, serverDown, sseState, livePaused, setLivePaused,
      steps, stepsLoaded, stepFilter, setStepFilter, stepSearch, setStepSearch, vocab, goalId,
      toasts, toast, confirm, drawer, drawerDepth, openDrawer, closeDrawer, refreshStatus, refreshSteps, setSteps, setStepLimit, stepLimit, primeEvents, evSearch, setEvSearch, evFilter, setEvFilter,
      detail, openDetail, closeDetail,
    }),
    [projectId, client, view, setView, status, events, lastSeq, serverDown, sseState, livePaused, steps, stepsLoaded, setSteps, stepFilter, stepSearch, vocab, goalId, toasts, toast, confirm, drawer, drawerDepth, openDrawer, closeDrawer, refreshStatus, refreshSteps, setStepLimit, stepLimit, primeEvents, evSearch, evFilter, detail, openDetail, closeDetail],
  );
  // Token deltas replace this object up to dozens of times a second; in its own
  // context only the live-stream consumers re-render per token.
  const streamsValue = useMemo(() => ({ streams }), [streams]);

  return (
    <Ctx.Provider value={value}>
      <StreamsCtx.Provider value={streamsValue}>{children}</StreamsCtx.Provider>
      {confirmReq ? (
        <ConfirmDialog
          req={confirmReq.req}
          onResolve={(v) => {
            confirmReq.resolve(v);
            setConfirmReq(null);
          }}
        />
      ) : null}
    </Ctx.Provider>
  );
}
