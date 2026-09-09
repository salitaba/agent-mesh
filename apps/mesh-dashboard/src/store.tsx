import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, setApiNotifier, onServerDownChange } from "./api";

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

export const VIEWS = ["overview", "steps", "agents", "graph", "events", "artifacts", "cost", "product", "escalations", "designer"] as const;
export type View = (typeof VIEWS)[number];

const FALLBACK_TYPES = [
  "goal.created", "goal.status_changed", "goal.paused", "goal.resumed", "goal.progress",
  "goal.completed", "goal.escalated", "goal.failed", "agent.awakened", "agent.state_changed",
  "agent.failed", "message.sent", "message.delivered", "message.rejected", "artifact.created",
  "artifact.versioned", "artifact.transition", "task.created", "task.claimed", "task.completed",
  "review.requested", "review.approved", "review.rejected", "budget.consumed", "budget.exceeded",
  "escalation.requested", "escalation.responded",
];

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

/**
 * The hash carries two independent things: which page is shown, and which
 * detail is open on top of it — `#/steps/step/turn-ab12`. Keeping the detail
 * in the URL is what makes a step or agent shareable and survive a refresh;
 * the drawer stack alone lost both.
 */
export interface HashRoute {
  view: View;
  detail?: { kind: "step" | "agent"; id: string };
}

export function parseHash(hash = window.location.hash): HashRoute {
  const raw = hash.replace(/^#\/?/, "");
  const [v, kind, ...rest] = raw.split("/");
  const view = (VIEWS as readonly string[]).includes(v) ? (v as View) : "overview";
  const id = rest.join("/");
  if ((kind === "step" || kind === "agent") && id) {
    return { view, detail: { kind, id: decodeURIComponent(id) } };
  }
  return { view };
}

export const hashFor = (view: View, detail?: HashRoute["detail"]): string =>
  detail ? `#/${view}/${detail.kind}/${encodeURIComponent(detail.id)}` : `#/${view}`;

function viewFromHash(): View {
  return parseHash().view;
}

interface MeshState {
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

export function MeshProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [view, setViewState] = useState<View>(viewFromHash);
  const [detail, setDetail] = useState<HashRoute["detail"] | null>(() => parseHash().detail ?? null);
  const [status, setStatus] = useState<any>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [lastSeq, setLastSeq] = useState(0);
  const [serverDown, setServerDown] = useState(false);
  const [livePaused, setLivePaused] = useState(false);
  const [steps, setStepsState] = useState<TurnStep[]>([]);
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
  const sseRef = useRef<EventSource | null>(null);
  const sseFails = useRef(0);
  const sseStateRef = useRef<"connecting" | "open" | "reconnecting">("connecting");
  const [sseState, setSseState] = useState<"connecting" | "open" | "reconnecting">("connecting");
  const statusInflight = useRef<Promise<void> | null>(null);

  const setSse = useCallback((s: "connecting" | "open" | "reconnecting") => {
    sseStateRef.current = s;
    setSseState(s);
  }, []);

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
    window.location.hash = hashFor(v);
    setViewState(v);
    setDetail(null);
  }, []);

  // Detail lives in the URL so a step or agent can be refreshed, shared and
  // reached with the browser Back button. The drawer stack stays for the
  // deeper drill-downs (event → artifact) that have no stable identity worth
  // a URL of their own.
  const openDetail = useCallback((kind: "step" | "agent", id: string) => {
    setDetail({ kind, id });
    window.location.hash = hashFor(viewRef.current, { kind, id });
  }, []);

  const closeDetail = useCallback(() => {
    setDetail(null);
    window.location.hash = hashFor(viewRef.current);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const r = parseHash();
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
      const { json } = await api("GET", "/status");
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
    stepsAt.current = Date.now();
  }, []);

  const refreshSteps = useCallback(async (force = false) => {
    if (viewRef.current !== "steps" && !force) return;
    if (Date.now() - stepsAt.current < 1800 && !force) return;
    try {
      const { json } = await api("GET", `/steps?limit=${stepLimit}`);
      if (Array.isArray(json)) {
        setStepsState(json);
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
      const next = [...prev, e];
      if (next.length > 800) {
        for (const d of next.splice(0, next.length - 800)) if (d.id) eventById.current.delete(d.id);
      }
      return next;
    });
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
    void refreshStatus();
    if (viewRef.current === "steps") void refreshSteps(false);
    if (viewRef.current === "overview" && Date.now() - stepsAt.current > 5000) {
      api("GET", "/steps?limit=6").then(({ json }) => {
        if (Array.isArray(json)) {
          setSteps(json);
          stepsAt.current = Date.now();
        }
      }).catch(() => undefined);
    }
  }, [refreshStatus, refreshSteps]);

  const connectSse = useCallback(() => {
    try {
      sseRef.current?.close();
    } catch {
      /* noop */
    }
    const since = lastSeqRef.current ? `?sinceSeq=${lastSeqRef.current}` : "";
    // EventSource is the live wire: the server emits `event: <type>` + `id:`
    // for every event, so subscribe to the full vocabulary, not a subset.
    const es = new EventSource(`/events/stream${since}`);
    sseRef.current = es;
    setSse("connecting");
    const onData = (m: MessageEvent) => {
      if (livePausedRef.current) return;
      try {
        const raw = JSON.parse(m.data);
        ingestEvent(raw);
      } catch {
        /* ignore */
      }
      livePatch();
    };
    es.onopen = () => {
      sseFails.current = 0;
      setSse("open");
    };
    es.onerror = () => {
      sseFails.current++;
      if (sseFails.current >= 3) {
        sseFails.current = 0;
        setSse("reconnecting");
        try {
          es.close();
        } catch {
          /* noop */
        }
        setTimeout(connectSse, 1500);
      }
    };
    es.onmessage = onData;
    // Live token frames ride the same SSE connection but are NOT log events:
    // dedicated listener straight into the stream buffers.
    try {
      es.addEventListener("turn.token", ((m: MessageEvent) => {
        try {
          ingestToken(JSON.parse(m.data));
        } catch {
          /* ignore */
        }
      }) as EventListener);
    } catch {
      /* noop */
    }
    const types: string[] = (vocabRef.current && vocabRef.current.eventTypes) || FALLBACK_TYPES;
    for (const t of types) {
      try {
        es.addEventListener(t, onData as EventListener);
      } catch {
        /* noop */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingestEvent, ingestToken, livePatch, setSse]);

  useEffect(() => {
    const saved = localStorage.getItem("mesh-theme");
    if (saved) document.documentElement.dataset.theme = saved;
    let dead = false;
    (async () => {
      try {
        const { json } = await api("GET", "/config/vocabulary");
        if (!dead && json) {
          setVocab(json);
          vocabRef.current = json;
        }
      } catch {
        /* SSE falls back to a builtin type list */
      }
      try {
        await refreshStatus();
      } catch {
        toast("mesh", "server unreachable — retrying…", "bad");
      }
      if (dead) return;
      connectSse();
    })();
    const iv = setInterval(() => {
      void refreshStatus().catch(() => undefined);
    }, 4000);
    return () => {
      dead = true;
      clearInterval(iv);
      try {
        sseRef.current?.close();
      } catch {
        /* noop */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<MeshState>(
    () => ({
      view, setView, status, events, lastSeq, serverDown, sseState, livePaused, setLivePaused,
      steps, stepFilter, setStepFilter, stepSearch, setStepSearch, vocab, goalId,
      toasts, toast, drawer, drawerDepth, openDrawer, closeDrawer, refreshStatus, refreshSteps, setSteps, setStepLimit, stepLimit, primeEvents, evSearch, setEvSearch, evFilter, setEvFilter,
      streams, detail, openDetail, closeDetail,
    }),
    [view, setView, status, events, lastSeq, serverDown, sseState, livePaused, steps, setSteps, stepFilter, stepSearch, vocab, goalId, toasts, toast, drawer, drawerDepth, openDrawer, closeDrawer, refreshStatus, refreshSteps, setStepLimit, stepLimit, primeEvents, evSearch, evFilter, streams, detail, openDetail, closeDetail],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
