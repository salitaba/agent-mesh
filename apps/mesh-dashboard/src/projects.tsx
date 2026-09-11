/**
 * Project registry + the one live connection.
 *
 * ```
 * <ProjectsProvider>                                 // registry, active id, one SSE
 *   <MeshProvider key={projectId} projectId={...} />  // one instance per project
 * ```
 *
 * Two things live here and nowhere else:
 *
 *  1. **The single multiplexed EventSource.** One socket carries every project;
 *     frames route by `projectId` to whichever `MeshProvider` registered for it.
 *     Opening a project must not drop the connection, so a reconnect always
 *     carries the full project set plus per-project cursors — the cursors are
 *     what make an open lossless.
 *  2. **The registry**, which is host-level state (`/api/projects`) and has no
 *     business inside a per-project store.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, post } from "./api";
import { parseHash, pickActiveProject, streamUrl } from "./route";

const LAST_PROJECT_KEY = "mesh-last-project";

/** Mirrors `ProjectSummary` from apps/mesh-server/src/host.ts. */
export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  configPath: string;
  addedAt: string;
  lastOpenedAt?: string;
  status: "closed" | "booting" | "open" | "crashed" | "locked" | "error" | "unknown";
  pid?: number;
  health?: { rss: number; lastHeartbeat: string; restarts: number };
  error?: { reason: string; detail?: string };
  restartInMs?: number;
  tripped: boolean;
  spend?: { tokens: number; usd: number; runningTurns: number };
}

/** Mirrors `HostSpend` from apps/mesh-server/src/host.ts. */
export interface HostSpend {
  usd: number;
  tokens: number;
  runningTurns: number;
  ceilingUsd: number | null;
  maxConcurrentTurns: number | null;
  ceilingTripped: boolean;
  parked: string[];
}

/** What a `MeshProvider` hands up so its project's frames reach it. */
export interface ProjectSink {
  /** A kernel event, already unwrapped from its `{projectId, seq, event}` frame. */
  event: (raw: unknown) => void;
  /** An out-of-band frame (`turn.token`): no seq, never replayed. */
  stream: (type: string, raw: any) => void;
  /** The stream lost continuity — refetch rather than assume it. */
  resync: (reason: string) => void;
  /** Highest seq held, read at connect time to build the resume cursor. */
  cursor: () => number;
}

type SseState = "connecting" | "open" | "reconnecting";

interface ProjectsState {
  projects: ProjectSummary[];
  activeId: string | null;
  setActive: (id: string) => void;
  refreshProjects: () => Promise<ProjectSummary[]>;
  /**
   * `opts.init` asks the host to scaffold a mesh.yaml when the folder has none.
   * Without it a mesh-less folder still fails with `missing`, which the picker
   * uses to offer an explicit "create mesh here" instead of writing unasked.
   */
  addProject: (
    root: string,
    opts?: { init?: boolean },
  ) => Promise<{ ok: boolean; error?: string; project?: ProjectSummary; scaffolded?: boolean; missing?: boolean }>;
  openProject: (id: string) => Promise<ProjectSummary | null>;
  closeProject: (id: string) => Promise<ProjectSummary | null>;
  restartProject: (id: string) => Promise<ProjectSummary | null>;
  removeProject: (id: string) => Promise<boolean>;
  /** Registers a project's frame sink. Returns an unsubscribe. */
  subscribe: (projectId: string, sink: ProjectSink) => () => void;
  sseState: SseState;
  /** False until the first `/api/projects` response lands. */
  loaded: boolean;
  /** Set when the host itself is unreachable, as opposed to having no projects. */
  hostDown: boolean;
}

const Ctx = createContext<ProjectsState | null>(null);

export const useProjects = (): ProjectsState => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useProjects outside provider");
  return v;
};

/**
 * Optional form for code that may render outside a ProjectsProvider (tests,
 * and the designer, which is reachable before any project is open).
 */
export const useProjectsOptional = (): ProjectsState | null => useContext(Ctx);

const FALLBACK_TYPES = [
  "goal.created", "goal.status_changed", "goal.paused", "goal.resumed", "goal.progress",
  "goal.completed", "goal.escalated", "goal.failed", "agent.awakened", "agent.state_changed",
  "agent.failed", "message.sent", "message.delivered", "message.rejected", "artifact.created",
  "artifact.versioned", "artifact.transition", "task.created", "task.claimed", "task.completed",
  "review.requested", "review.approved", "review.rejected", "budget.consumed", "budget.exceeded",
  "escalation.requested", "escalation.responded",
];

const RECONNECT_MS = 1500;
const SSE_FAILS_BEFORE_RECONNECT = 3;

const asSummary = (json: any): ProjectSummary | null =>
  json && typeof json === "object" && typeof json.id === "string" ? (json as ProjectSummary) : null;

export function ProjectsProvider({ children, eventTypes }: { children: (activeId: string | null) => ReactNode; eventTypes?: string[] }): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sseState, setSseState] = useState<SseState>("connecting");
  const [loaded, setLoaded] = useState(false);
  const [hostDown, setHostDown] = useState(false);

  const sinks = useRef(new Map<string, ProjectSink>());
  const esRef = useRef<EventSource | null>(null);
  const failsRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards every async continuation once the provider is unmounting. */
  const deadRef = useRef(false);
  const typesRef = useRef<string[]>(eventTypes && eventTypes.length ? eventTypes : FALLBACK_TYPES);
  if (eventTypes && eventTypes.length) typesRef.current = eventTypes;

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    let res: Awaited<ReturnType<typeof api>>;
    try {
      res = await api("GET", "/api/projects");
    } catch {
      // A refused connection is not a timeout: surface it as host-down here so
      // no caller has to deal with a rejected poll.
      setHostDown(true);
      return [];
    }
    const { status, json, timeout } = res;
    if (deadRef.current) return [];
    if (timeout || status === 0) {
      setHostDown(true);
      return [];
    }
    setHostDown(false);
    const list: ProjectSummary[] = Array.isArray(json?.projects) ? json.projects : [];
    setProjects(list);
    setLoaded(true);
    return list;
  }, []);

  // ---------------------------------------------------------------- streaming
  //
  // The set actually worth a socket: every project a store has registered for.
  const followedIds = useCallback((): string[] => [...sinks.current.keys()], []);

  // Connect is deliberately imperative rather than an effect per project: the
  // project set and the cursors both change, and a dependency-driven effect
  // would tear the socket down on every seq bump.
  const connect = useCallback((ids: string[]) => {
    if (deadRef.current) return;
    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    try {
      esRef.current?.close();
    } catch {
      /* noop */
    }
    esRef.current = null;
    if (!ids.length) {
      // Nothing to follow. Not an error state — a fresh install has no
      // projects, and an EventSource on an empty set would just churn.
      setSseState("connecting");
      return;
    }
    const cursors: Array<[string, number]> = ids.map((id) => [id, sinks.current.get(id)?.cursor() ?? 0]);
    const es = new EventSource(streamUrl(ids, cursors));
    esRef.current = es;
    setSseState("connecting");

    const route = (m: MessageEvent) => {
      try {
        const frame = JSON.parse(m.data);
        const pid = frame?.projectId;
        if (typeof pid !== "string") return;
        const sink = sinks.current.get(pid);
        if (!sink) return;
        // Kernel events arrive wrapped as `{projectId, seq, event}`; the inner
        // event is what the store ingests.
        if (frame.event) sink.event(frame.event);
      } catch {
        /* ignore malformed frame */
      }
    };

    es.onmessage = route;
    for (const t of typesRef.current) {
      try {
        es.addEventListener(t, route as EventListener);
      } catch {
        /* noop */
      }
    }

    // Stream frames are merged, not wrapped: `{projectId, ...data}`. Fanning
    // them out with the projectId still attached keeps every field the existing
    // listener reads.
    try {
      es.addEventListener("turn.token", ((m: MessageEvent) => {
        try {
          const data = JSON.parse(m.data);
          const sink = typeof data?.projectId === "string" ? sinks.current.get(data.projectId) : undefined;
          sink?.stream("turn.token", data);
        } catch {
          /* ignore */
        }
      }) as EventListener);
    } catch {
      /* noop */
    }

    // Overflow or gap: continuity is gone, so the affected stores refetch.
    // Assuming continuity here is how a dashboard ends up quietly missing
    // events for the rest of a mission.
    try {
      es.addEventListener("resync", ((m: MessageEvent) => {
        try {
          const signal = JSON.parse(m.data);
          const reason = String(signal?.reason ?? "resync");
          if (typeof signal?.projectId === "string" && signal.projectId) {
            sinks.current.get(signal.projectId)?.resync(reason);
          } else {
            // Client-wide (overflow): every followed project lost its place.
            for (const sink of sinks.current.values()) sink.resync(reason);
          }
        } catch {
          /* ignore */
        }
      }) as EventListener);
    } catch {
      /* noop */
    }

    es.onopen = () => {
      failsRef.current = 0;
      if (!deadRef.current) setSseState("open");
    };
    es.onerror = () => {
      failsRef.current++;
      if (failsRef.current < SSE_FAILS_BEFORE_RECONNECT) return;
      failsRef.current = 0;
      if (!deadRef.current) setSseState("reconnecting");
      try {
        es.close();
      } catch {
        /* noop */
      }
      if (esRef.current === es) esRef.current = null;
      if (deadRef.current) return;
      retryRef.current = setTimeout(() => {
        retryRef.current = null;
        connect(followedIds());
      }, RECONNECT_MS);
    };
  }, [followedIds]);

  const subscribe = useCallback((projectId: string, sink: ProjectSink) => {
    sinks.current.set(projectId, sink);
    // A newly mounted project reconnects with the full set and every cursor, so
    // the projects already streaming resume exactly where they were.
    connect(followedIds());
    return () => {
      sinks.current.delete(projectId);
      if (deadRef.current) return;
      connect(followedIds());
    };
  }, [connect, followedIds]);

  // ---------------------------------------------------------------- registry
  const applySummary = useCallback((summary: ProjectSummary | null) => {
    if (!summary) return;
    setProjects((prev) => {
      const at = prev.findIndex((p) => p.id === summary.id);
      if (at < 0) return [...prev, summary];
      const next = [...prev];
      next[at] = summary;
      return next;
    });
  }, []);

  const addProject = useCallback(async (root: string, opts?: { init?: boolean }) => {
    const { status, json } = await post("/api/projects", opts?.init ? { root, init: true } : { root });
    if (status === 201) {
      const summary = asSummary(json);
      applySummary(summary);
      return { ok: true, project: summary ?? undefined, scaffolded: json?.scaffolded === true };
    }
    return {
      ok: false,
      error: String(json?.error ?? `add failed (${status})`),
      missing: json?.code === "missing",
    };
  }, [applySummary]);

  // open/close/restart answer 200 even when the child failed to come up: the
  // request succeeded and the status is the outcome. Reading `status` rather
  // than the HTTP code is what lets a crashed project render as a crashed tab.
  const lifecycle = useCallback(async (id: string, action: "open" | "close" | "restart") => {
    try {
      const { status, json } = await post(`/api/projects/${encodeURIComponent(id)}/${action}`);
      if (status !== 200) return null;
      const summary = asSummary(json);
      applySummary(summary);
      return summary;
    } catch {
      return null;
    }
  }, [applySummary]);

  const openProject = useCallback((id: string) => lifecycle(id, "open"), [lifecycle]);
  const closeProject = useCallback((id: string) => lifecycle(id, "close"), [lifecycle]);
  const restartProject = useCallback((id: string) => lifecycle(id, "restart"), [lifecycle]);

  const removeProject = useCallback(async (id: string) => {
    let status: number;
    try {
      ({ status } = await api("DELETE", `/api/projects/${encodeURIComponent(id)}`));
    } catch {
      return false;
    }
    if (status !== 200) return false;
    setProjects((prev) => prev.filter((p) => p.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
    return true;
  }, []);

  const setActive = useCallback((id: string) => {
    setActiveId(id);
    try {
      localStorage.setItem(LAST_PROJECT_KEY, id);
    } catch {
      /* private mode: remembering is a convenience, not a requirement */
    }
  }, []);

  useEffect(() => {
    deadRef.current = false;
    void (async () => {
      const list = await refreshProjects();
      if (deadRef.current || !list.length) return;
      let remembered: string | null = null;
      try {
        remembered = localStorage.getItem(LAST_PROJECT_KEY);
      } catch {
        /* noop */
      }
      const chosen = pickActiveProject({
        fromHash: parseHash(window.location.hash).projectId,
        remembered,
        open: list.filter((p) => p.status === "open").map((p) => p.id),
        known: list.map((p) => p.id),
      });
      if (!chosen) return;
      setActiveId(chosen);
      // A deep link into a project that is merely closed is still a valid link:
      // arriving on it opens it rather than showing an empty console.
      const ref = list.find((p) => p.id === chosen);
      if (ref && ref.status !== "open" && ref.status !== "booting" && !ref.tripped) {
        await openProject(chosen);
      }
    })();
    const iv = setInterval(() => {
      void refreshProjects().catch(() => undefined);
    }, 5000);
    return () => {
      // Everything opened here is closed here. A socket left behind by a
      // fast unmount is one leaked connection per project switch.
      deadRef.current = true;
      clearInterval(iv);
      if (retryRef.current) {
        clearTimeout(retryRef.current);
        retryRef.current = null;
      }
      try {
        esRef.current?.close();
      } catch {
        /* noop */
      }
      esRef.current = null;
    };
    // Boot-time resolution runs once; `openProject` is stable and re-running
    // this on every registry poll would fight the operator's tab choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<ProjectsState>(
    () => ({
      projects, activeId, setActive, refreshProjects, addProject, openProject, closeProject,
      restartProject, removeProject, subscribe, sseState, loaded, hostDown,
    }),
    [projects, activeId, setActive, refreshProjects, addProject, openProject, closeProject, restartProject, removeProject, subscribe, sseState, loaded, hostDown],
  );

  return <Ctx.Provider value={value}>{children(activeId)}</Ctx.Provider>;
}
