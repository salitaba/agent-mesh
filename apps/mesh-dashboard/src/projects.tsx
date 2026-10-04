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
import { readRegistryAnswer } from "./projectsmodel";

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
  /** The scheduler mode its process last reported (carried on the registry entry). Only meaningful while it is open. */
  lastMode?: "parked" | "live";
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
  /** An out-of-band frame (`turn.token`, `turn.tool`): no seq, never replayed. */
  stream: (type: string, raw: any) => void;
  /** The stream lost continuity — refetch rather than assume it. */
  resync: (reason: string) => void;
  /** Highest seq held, read at connect time to build the resume cursor. */
  cursor: () => number;
}

/**
 * Out-of-band frame types, listened for by name. They carry no seq and are
 * never replayed, so they are routed to `sink.stream` rather than the timeline;
 * `es.onmessage` never sees them because each arrives under its own event name.
 */
const LIVE_FRAME_TYPES = ["turn.token", "turn.tool"] as const;

type SseState = "connecting" | "open" | "reconnecting";

/**
 * Something the host refused that the person should be told, and keep being told until they dismiss it. It lives here, above
 * every project's console, because the console switches when a project is opened and anything held below it goes with it.
 */
export interface HostNotice {
  id: number;
  title: string;
  text: string;
}

/** What opening, closing or restarting came to. `status` is 0 when the host did not answer at all. */
export type Lifecycle = { ok: true; project: ProjectSummary } | { ok: false; status: number; reason: string };

/** What adding a project came to. `status` is 0 when the host did not answer at all. */
export interface AddResult {
  ok: boolean;
  status: number;
  /** The host's own refusal, and the one sentence it wrote for a person to read (`reason`). */
  error?: string;
  reason?: string;
  code?: string;
  project?: ProjectSummary;
  scaffolded?: boolean;
  /** The folder holds no mesh.yaml: the picker uses this to offer an explicit "create one here" instead of writing unasked. */
  missing?: boolean;
}

interface ProjectsState {
  projects: ProjectSummary[];
  activeId: string | null;
  setActive: (id: string) => void;
  refreshProjects: () => Promise<ProjectSummary[]>;
  /**
   * `opts.init` asks the host to scaffold the default team when the folder has no mesh.yaml.
   * Without it a mesh-less folder still fails with `missing`, which the picker
   * uses to offer an explicit "create mesh here" instead of writing unasked.
   * `opts.template` makes the project from a starting point the host offers (`GET /api/templates`): the host writes
   * it into `root` and refuses a folder that already holds a mesh.yaml.
   */
  addProject: (root: string, opts?: { init?: boolean; template?: string }) => Promise<AddResult>;
  /**
   * Each answers with the project as the host now reports it, or with why the host refused (the plan allows one open
   * project at a time, the host did not answer). A project that fails to come up is NOT a refusal: the request worked and
   * the project's `status` is the outcome.
   */
  openProject: (id: string) => Promise<Lifecycle>;
  closeProject: (id: string) => Promise<Lifecycle>;
  restartProject: (id: string) => Promise<Lifecycle>;
  /** Forget a project. Its files are untouched. When it was the one in front, another takes its place. */
  removeProject: (id: string) => Promise<boolean>;
  /** When the last registry answer landed (ms since the epoch); null before the first. A list older than a poll or two is stale. */
  lastSyncAt: number | null;
  /** The last thing the host refused (a plan that allows one open project, a host that did not answer). Cleared by the next success. */
  notice: HostNotice | null;
  dismissNotice: () => void;
  /** Registers a project's frame sink. Returns an unsubscribe. */
  subscribe: (projectId: string, sink: ProjectSink) => () => void;
  sseState: SseState;
  /** False until the first `/api/projects` response lands. */
  loaded: boolean;
  /** Set when the host itself is unreachable, as opposed to having no projects. */
  hostDown: boolean;
  /**
   * Whether this server has a project registry at all — `null` until the first
   * answer lands. `curule console` serves exactly one mesh and has no `/api/projects`
   * route; `curule host` does. Without this the two were indistinguishable (both
   * "no projects"), so the console grew a tab strip it can never fill and a
   * "+ Add a project" button whose POST 404s too.
   */
  hasRegistry: boolean | null;
  /**
   * Host-wide spend, or `null` before the first answer and on a server with no
   * registry. `ceilingTripped` is the field that changes what the operator
   * should *do*: the host parks every running project once total spend crosses
   * `spendCeilingUsd` (`mesh-server/src/host.ts:449`) and re-parks them on the
   * next child heartbeat. So a mesh parked this way cannot be restarted by
   * clicking Continue — it goes live, activates its startup seats, and is
   * parked again seconds later. The ceiling has to move first.
   *
   * This was already on the wire and already typed; nothing rendered it, which
   * is why that loop was invisible.
   */
  hostSpend: HostSpend | null;
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
  "escalation.requested", "escalation.responded", "plan.updated", "plan.gate_rejected",
];

const RECONNECT_MS = 1500;
const SSE_FAILS_BEFORE_RECONNECT = 3;

const asSummary = (json: any): ProjectSummary | null =>
  json && typeof json === "object" && typeof json.id === "string" ? (json as ProjectSummary) : null;

/** Field-by-field so a poll that changes nothing returns the previous array
 *  reference and React bails out instead of re-rendering the whole tree. */
function sameProject(a: ProjectSummary, b: ProjectSummary): boolean {
  return (
    a.id === b.id && a.name === b.name && a.root === b.root && a.configPath === b.configPath &&
    a.addedAt === b.addedAt && a.lastOpenedAt === b.lastOpenedAt && a.status === b.status && a.lastMode === b.lastMode &&
    a.pid === b.pid && a.tripped === b.tripped && a.restartInMs === b.restartInMs &&
    a.health?.rss === b.health?.rss && a.health?.lastHeartbeat === b.health?.lastHeartbeat && a.health?.restarts === b.health?.restarts &&
    a.error?.reason === b.error?.reason && a.error?.detail === b.error?.detail &&
    a.spend?.tokens === b.spend?.tokens && a.spend?.usd === b.spend?.usd && a.spend?.runningTurns === b.spend?.runningTurns
  );
}

function sameProjects(a: ProjectSummary[], b: ProjectSummary[]): boolean {
  return a.length === b.length && a.every((p, i) => sameProject(p, b[i]));
}

export function ProjectsProvider({ children, eventTypes }: { children: (activeId: string | null) => ReactNode; eventTypes?: string[] }): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sseState, setSseState] = useState<SseState>("connecting");
  const [loaded, setLoaded] = useState(false);
  const [hostDown, setHostDown] = useState(false);
  // Starts unknown rather than optimistic: showing the strip and then pulling
  // it away is worse than letting it arrive a beat late in host mode.
  const [hasRegistry, setHasRegistry] = useState<boolean | null>(null);
  const [hostSpend, setHostSpend] = useState<HostSpend | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<HostNotice | null>(null);
  const noticeSeq = useRef(0);
  const dismissNotice = useCallback(() => setNotice(null), []);
  // The latest list and the project in front, for handlers that outlive a render (the hash listener, a removal).
  const projectsRef = useRef<ProjectSummary[]>([]);
  const activeRef = useRef<string | null>(null);
  projectsRef.current = projects;
  activeRef.current = activeId;
  // Read from inside the 5s poll, which must not be rebuilt when the verdict
  // lands. `curule console` has no /api/projects route and never grows one, so
  // once it has 404ed the poll was asking a question already answered — twelve
  // console errors a minute that read like a bug to anyone opening devtools.
  const noRegistryRef = useRef(false);

  const sinks = useRef(new Map<string, ProjectSink>());
  const esRef = useRef<EventSource | null>(null);
  const failsRef = useRef(0);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Guards every async continuation once the provider is unmounting. */
  const deadRef = useRef(false);
  const typesRef = useRef<string[]>(eventTypes && eventTypes.length ? eventTypes : FALLBACK_TYPES);
  if (eventTypes && eventTypes.length) typesRef.current = eventTypes;

  const refreshProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    if (noRegistryRef.current) return [];
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
    const answer = readRegistryAnswer({ status, timeout });
    if (answer === "down") {
      setHostDown(true);
      return [];
    }
    // A refusal (the sign-in gate handles a 401; a throttled address answers 429) says nothing about what is registered.
    if (answer === "refused") return projectsRef.current;
    setHostDown(false);
    // A 404 is not "a registry holding no projects" — it is a server with no
    // registry route. Only an actual answer settles the question; a transport
    // failure above leaves the previous verdict alone.
    noRegistryRef.current = status === 404;
    setHasRegistry(status !== 404);
    const list: ProjectSummary[] = Array.isArray(json?.projects) ? json.projects : [];
    setProjects((prev) => (sameProjects(prev, list) ? prev : list));
    // The same response has always carried host-wide spend; it used to be
    // dropped here, so `ceilingTripped` could be true on the wire while the
    // console showed a parked mesh and no reason for it.
    setHostSpend((json?.spend as HostSpend | undefined) ?? null);
    setLoaded(true);
    setLastSyncAt(Date.now());
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
    for (const type of LIVE_FRAME_TYPES) {
      try {
        es.addEventListener(type, ((m: MessageEvent) => {
          try {
            const data = JSON.parse(m.data);
            const sink = typeof data?.projectId === "string" ? sinks.current.get(data.projectId) : undefined;
            sink?.stream(type, data);
          } catch {
            /* ignore */
          }
        }) as EventListener);
      } catch {
        /* noop */
      }
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

  const addProject = useCallback(async (root: string, opts?: { init?: boolean; template?: string }): Promise<AddResult> => {
    const body = opts?.template ? { root, template: opts.template } : opts?.init ? { root, init: true } : { root };
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post("/api/projects", body);
    } catch {
      // The request never got an answer; the caller says so, in words, rather than handling a rejected promise.
      return { ok: false, status: 0 };
    }
    const { status, json } = res;
    if (status === 201) {
      const summary = asSummary(json);
      applySummary(summary);
      return { ok: true, status, project: summary ?? undefined, scaffolded: json?.scaffolded === true };
    }
    return {
      ok: false,
      status,
      error: typeof json?.error === "string" ? json.error : `add failed (${status})`,
      reason: typeof json?.reason === "string" ? json.reason : undefined,
      code: typeof json?.code === "string" ? json.code : undefined,
      missing: json?.code === "missing",
    };
  }, [applySummary]);

  // open/close/restart answer 200 even when the child failed to come up: the
  // request succeeded and the status is the outcome. Reading `status` rather
  // than the HTTP code is what lets a crashed project render as a crashed tab.
  const runLifecycle = useCallback(async (id: string, action: "open" | "close" | "restart"): Promise<Lifecycle> => {
    const name = projectsRef.current.find((p) => p.id === id)?.name ?? id;
    const refuse = (status: number, reason: string): Lifecycle => {
      setNotice({ id: ++noticeSeq.current, title: `Could not ${action} ${name}.`, text: reason });
      return { ok: false, status, reason };
    };
    let res: Awaited<ReturnType<typeof post>>;
    try {
      res = await post(`/api/projects/${encodeURIComponent(id)}/${action}`);
    } catch {
      return refuse(0, "The host did not answer. Check that it is still running, then try again.");
    }
    const { status, json } = res;
    const summary = status === 200 ? asSummary(json) : null;
    if (summary) {
      applySummary(summary);
      setNotice(null);
      return { ok: true, project: summary };
    }
    // The host's own words: a plan that allows one open project says so, and what to do about it.
    const said = typeof json?.reason === "string" ? json.reason : typeof json?.error === "string" ? json.error : "";
    return refuse(status, said ? (/[.!?]$/.test(said) ? said : `${said}.`) : `The host answered ${status}. Try again.`);
  }, [applySummary]);

  // One request per project and action at a time: a click and the address changing under it, or a double click, would
  // otherwise ask the host twice for the same process.
  const inflight = useRef(new Map<string, Promise<Lifecycle>>());
  const lifecycle = useCallback((id: string, action: "open" | "close" | "restart"): Promise<Lifecycle> => {
    const key = `${action}:${id}`;
    const running = inflight.current.get(key);
    if (running) return running;
    const started = runLifecycle(id, action).finally(() => inflight.current.delete(key));
    inflight.current.set(key, started);
    return started;
  }, [runLifecycle]);

  const openProject = useCallback((id: string) => lifecycle(id, "open"), [lifecycle]);
  const closeProject = useCallback((id: string) => lifecycle(id, "close"), [lifecycle]);
  const restartProject = useCallback((id: string) => lifecycle(id, "restart"), [lifecycle]);

  const removeProject = useCallback(async (id: string) => {
    const name = projectsRef.current.find((p) => p.id === id)?.name ?? id;
    const refuse = (reason: string): false => {
      setNotice({ id: ++noticeSeq.current, title: `Could not remove ${name}.`, text: reason });
      return false;
    };
    let status: number;
    let json: any;
    try {
      ({ status, json } = await api("DELETE", `/api/projects/${encodeURIComponent(id)}`));
    } catch {
      return refuse("The host did not answer. Check that it is still running, then try again.");
    }
    if (status !== 200) return refuse(typeof json?.reason === "string" ? json.reason : typeof json?.error === "string" ? json.error : `The host answered ${status}. Try again.`);
    setNotice(null);
    // The project in front may be the one that just went. Leaving `activeId` on it (or on nothing, while others exist) would
    // mount a console for a project the host no longer knows, so another takes its place, chosen the way a fresh window
    // chooses: an open one first.
    const remaining = projectsRef.current.filter((p) => p.id !== id);
    setProjects(remaining);
    if (activeRef.current === id) {
      const next = pickActiveProject({
        open: remaining.filter((p) => p.status === "open").map((p) => p.id),
        known: remaining.map((p) => p.id),
      });
      setActiveId(next);
    }
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

  // The address can name a project other than the one in front: the Back button, a link, an edit, a tab. Following it keeps
  // the address and the console saying the same thing. A project the registry does not know is left alone. A closed one is
  // opened on arrival, as it is when the page loads on its link; a broken one is not, because starting a crashed process
  // again is a decision the notice under the strip offers and a page change must not make.
  useEffect(() => {
    const onHash = () => {
      const id = parseHash(window.location.hash).projectId;
      if (!id || id === activeRef.current) return;
      const ref = projectsRef.current.find((p) => p.id === id);
      if (!ref) return;
      setActive(id);
      if (ref.status === "closed") void openProject(id);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [setActive, openProject]);

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
      if (noRegistryRef.current) return;
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
    // Boot-time resolution runs once. Both callbacks are stable, so listing
    // them cannot re-run this on the 5s registry poll.
  }, [refreshProjects, openProject]);

  const value = useMemo<ProjectsState>(
    () => ({
      projects, activeId, setActive, refreshProjects, addProject, openProject, closeProject,
      restartProject, removeProject, lastSyncAt, notice, dismissNotice, subscribe, sseState, loaded, hostDown, hasRegistry, hostSpend,
    }),
    [projects, activeId, setActive, refreshProjects, addProject, openProject, closeProject, restartProject, removeProject, lastSyncAt, notice, dismissNotice, subscribe, sseState, loaded, hostDown, hasRegistry, hostSpend],
  );

  return <Ctx.Provider value={value}>{children(activeId)}</Ctx.Provider>;
}
