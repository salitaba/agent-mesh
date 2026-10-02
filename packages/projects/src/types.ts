/**
 * Types for the multi-project host registry.
 *
 * The registry is a pointer list: it names folders the user has added and
 * tracks the runtime status of the ones that are open. No mesh state ever
 * lives here — every project keeps its own event log under its own state dir,
 * and there is no cross-project log by design.
 */

export type ProjectRef = {
  id: string;
  name: string;
  /** Absolute, realpath'd: the same folder reached by two paths is one project. */
  root: string;
  configPath: string;
  addedAt: string;
  lastOpenedAt?: string;
  /**
   * The scheduler mode this project's child was last in, as the child itself
   * reported it on a heartbeat.
   *
   * Persisted — unlike the host's other bookkeeping (the crash breaker, the
   * policy parks), which is deliberately per-process — because this fact
   * outlives the process that learned it. A host that restarts with an empty
   * memory spawns each child in the host's own default, which on a host booted
   * without `--live` is `parked`: a mission the operator had running stops
   * running, and every surface still reads "running".
   *
   * Optional, like `lastOpenedAt`, and for a related reason: a project added
   * and never opened has nothing to restore, and an entry written by a build
   * that predates this field must keep loading.
   */
  lastMode?: "parked" | "live";
};

export type ProjectStatus =
  | "closed"
  | "booting"
  | "open"
  | "crashed" // child exited unexpectedly, restartable
  | "locked" // state dir held by another process
  | "error"; // config invalid or path missing

export type ProjectHandle = {
  ref: ProjectRef;
  status: ProjectStatus;
  endpoint?: { port: number; token: string };
  pid?: number;
  health?: { rss: number; lastHeartbeat: string; restarts: number };
  error?: { reason: string; detail?: string };
};

export interface ProjectRegistry {
  list(): ProjectRef[];
  add(root: string): Promise<ProjectRef>;
  remove(id: string): Promise<void>; // closes first; never deletes user files
  open(id: string): Promise<ProjectHandle>;
  close(id: string): Promise<void>;
  restart(id: string): Promise<ProjectHandle>;
  get(id: string): ProjectHandle | undefined;
  openIds(): string[];
}

/** On-disk shape of `~/.ordane/projects.json`. */
export interface ProjectsFile {
  version: number;
  projects: ProjectRef[];
}

export const PROJECTS_FILE_VERSION = 1;
export const PROJECTS_FILENAME = "projects.json";

export type ProjectErrorCode =
  /** Another entry already claims this id, from a different folder. */
  | "duplicate_id"
  /** No such id in the registry. */
  | "unknown_project"
  /** The folder or its mesh.yaml does not exist. */
  | "missing"
  /** mesh.yaml exists but does not load. */
  | "invalid_config"
  /** The registry file on disk is unreadable or a version we do not understand. */
  | "registry_corrupt";

export class ProjectError extends Error {
  constructor(
    readonly code: ProjectErrorCode,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ProjectError";
  }
}

/**
 * The seam between the registry (which folders exist) and supervision (which
 * child processes are running). Step 2 ships the registry against
 * `InertSupervisor`; step 3 substitutes a real child-spawning implementation
 * without the registry changing.
 */
export interface ProjectSupervisor {
  /**
   * Bring the project up. Returns the runtime facts the registry cannot know:
   * the child's loopback endpoint, its pid, and any failure that is a
   * supervision failure rather than a registry one (`locked`, `crashed`).
   */
  launch(ref: ProjectRef): Promise<{
    status: ProjectStatus;
    endpoint?: { port: number; token: string };
    pid?: number;
    error?: { reason: string; detail?: string };
  }>;
  /** Idempotent: closing an already-closed project is not an error. */
  stop(ref: ProjectRef): Promise<void>;
}

/**
 * No children, no ports. `open()` marks the project open so the registry's own
 * bookkeeping (lastOpenedAt, openIds, remove-closes-first) is exercisable and
 * testable before step 3 exists.
 */
export class InertSupervisor implements ProjectSupervisor {
  async launch(): Promise<{ status: ProjectStatus }> {
    return { status: "open" };
  }

  async stop(): Promise<void> {
    /* nothing to stop */
  }
}
