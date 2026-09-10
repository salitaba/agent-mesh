import * as fs from "fs";
import * as path from "path";
import { ConfigError, resolveConfig } from "../../config/src/index";
import { meshHome, projectsFilePath, readProjectsFile, withRegistryLock, writeProjectsFile } from "./store";
import {
  InertSupervisor,
  ProjectError,
  type ProjectHandle,
  type ProjectRef,
  type ProjectRegistry,
  type ProjectStatus,
  type ProjectSupervisor,
} from "./types";

export const MESH_CONFIG_FILENAME = "mesh.yaml";

export interface FileProjectRegistryOptions {
  /** Defaults to `MESH_HOME` or `~/.agent-mesh`. */
  home?: string;
  /** Step 3 supplies the child-spawning supervisor; until then nothing boots. */
  supervisor?: ProjectSupervisor;
}

/** Accepts a folder or a direct path to a mesh.yaml, and normalizes to both. */
function locateConfig(input: string): { root: string; configPath: string } {
  const abs = path.resolve(input);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    throw new ProjectError("missing", `no such path: ${abs}`);
  }
  if (stat.isFile()) {
    const root = realpath(path.dirname(abs));
    return { root, configPath: path.join(root, path.basename(abs)) };
  }
  const root = realpath(abs);
  const configPath = path.join(root, MESH_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    throw new ProjectError("missing", `no ${MESH_CONFIG_FILENAME} in ${root}`);
  }
  return { root, configPath };
}

/**
 * Identity is the real path: a symlink and its target are one project, and one
 * folder reached twice must not become two entries racing for one state lock.
 */
function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The registry of local projects, backed by `<MESH_HOME>/projects.json`.
 *
 * It is a pointer list with runtime status layered on top: `list()` and `add()`
 * touch only disk, while `open()`/`close()` delegate the actual process work to
 * a `ProjectSupervisor`. Nothing here spawns anything.
 */
export class FileProjectRegistry implements ProjectRegistry {
  readonly home: string;
  readonly file: string;
  private readonly supervisor: ProjectSupervisor;
  private refs: ProjectRef[] = [];
  private handles = new Map<string, ProjectHandle>();

  constructor(opts: FileProjectRegistryOptions = {}) {
    this.home = opts.home ? path.resolve(opts.home) : meshHome();
    this.file = projectsFilePath(this.home);
    this.supervisor = opts.supervisor ?? new InertSupervisor();
    this.reload();
  }

  /** Re-read from disk. Another host may have added a project since. */
  reload(): void {
    this.refs = readProjectsFile(this.file);
    for (const id of [...this.handles.keys()]) {
      if (!this.refs.some((r) => r.id === id)) this.handles.delete(id);
    }
  }

  list(): ProjectRef[] {
    return this.refs.map((r) => ({ ...r }));
  }

  get(id: string): ProjectHandle | undefined {
    const existing = this.handles.get(id);
    if (existing) return { ...existing, ref: { ...existing.ref } };
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) return undefined;
    return { ref: { ...ref }, status: "closed" };
  }

  openIds(): string[] {
    return [...this.handles.entries()]
      .filter(([, h]) => h.status === "open" || h.status === "booting")
      .map(([id]) => id);
  }

  /** Look up by folder, so callers can turn a picker result into a focus. */
  findByRoot(root: string): ProjectRef | undefined {
    const resolved = realpath(path.resolve(root));
    const found = this.refs.find((r) => r.root === resolved);
    return found ? { ...found } : undefined;
  }

  /**
   * Register a folder. Does not boot it — `open()` does that.
   *
   * Re-adding a folder already in the registry is a focus no-op returning the
   * existing entry, matched on realpath. A *different* folder declaring an id
   * that is already taken is rejected: two entries with one id means two
   * processes racing for one state dir, so the user renames or overrides.
   */
  async add(root: string): Promise<ProjectRef> {
    const located = locateConfig(root);
    const config = this.loadConfig(located.configPath);

    return withRegistryLock(this.file, () => {
      this.refs = readProjectsFile(this.file);
      const sameRoot = this.refs.find((r) => r.root === located.root);
      if (sameRoot) return { ...sameRoot };

      const clash = this.refs.find((r) => r.id === config.projectId);
      if (clash) {
        throw new ProjectError(
          "duplicate_id",
          `project id '${config.projectId}' is already registered for ${clash.root}`,
          `Rename project.id in ${located.configPath}, or remove the existing entry first. ` +
            `Two entries with one id means two processes racing for one state directory.`,
        );
      }

      const ref: ProjectRef = {
        id: config.projectId,
        name: config.projectName,
        root: located.root,
        configPath: located.configPath,
        addedAt: new Date().toISOString(),
      };
      this.refs = [...this.refs, ref];
      writeProjectsFile(this.file, this.refs);
      return { ...ref };
    });
  }

  /** Closes the project first. Only the pointer is dropped; user files stay. */
  async remove(id: string): Promise<void> {
    await this.close(id);
    await withRegistryLock(this.file, () => {
      const current = readProjectsFile(this.file);
      const next = current.filter((r) => r.id !== id);
      if (next.length !== current.length) writeProjectsFile(this.file, next);
      this.refs = next;
    });
    this.handles.delete(id);
  }

  async open(id: string): Promise<ProjectHandle> {
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) throw new ProjectError("unknown_project", `no project '${id}' in the registry`);

    const already = this.handles.get(id);
    if (already && (already.status === "open" || already.status === "booting")) {
      return { ...already, ref: { ...already.ref } };
    }

    // A folder that moved or was deleted must surface as an error the user can
    // act on, with the entry kept so it can be re-pointed. Never silently drop.
    if (!fs.existsSync(ref.configPath)) {
      return this.fail(ref, "missing", `${ref.configPath} no longer exists`);
    }
    let name = ref.name;
    try {
      const config = resolveConfig(ref.configPath);
      name = config.projectName;
    } catch (err) {
      const detail = err instanceof ConfigError ? err.errors.join("; ") : (err as Error).message;
      return this.fail(ref, "invalid_config", detail);
    }

    this.setHandle({ ref: { ...ref, name }, status: "booting" });
    const result = await this.supervisor.launch({ ...ref, name });
    const openedAt = new Date().toISOString();
    const handle: ProjectHandle = { ref: { ...ref, name, lastOpenedAt: openedAt }, status: result.status };
    if (result.endpoint) handle.endpoint = result.endpoint;
    if (typeof result.pid === "number") handle.pid = result.pid;
    if (result.error) handle.error = result.error;
    this.setHandle(handle);

    if (result.status === "open") await this.touch(id, { name, lastOpenedAt: openedAt });
    return { ...handle, ref: { ...handle.ref } };
  }

  /** Idempotent: closing an unknown or already-closed project is not an error. */
  async close(id: string): Promise<void> {
    const handle = this.handles.get(id);
    if (!handle) return;
    await this.supervisor.stop(handle.ref);
    this.setHandle({ ref: handle.ref, status: "closed" });
  }

  async restart(id: string): Promise<ProjectHandle> {
    await this.close(id);
    return this.open(id);
  }

  private loadConfig(configPath: string): { projectId: string; projectName: string } {
    try {
      const resolved = resolveConfig(configPath);
      return { projectId: resolved.projectId, projectName: resolved.projectName };
    } catch (err) {
      const detail = err instanceof ConfigError ? err.errors.join("; ") : (err as Error).message;
      throw new ProjectError("invalid_config", `cannot read ${configPath}`, detail);
    }
  }

  private fail(ref: ProjectRef, reason: string, detail: string): ProjectHandle {
    const handle: ProjectHandle = {
      ref: { ...ref },
      status: "error" satisfies ProjectStatus,
      error: { reason, detail },
    };
    this.setHandle(handle);
    return { ...handle, ref: { ...handle.ref } };
  }

  private setHandle(handle: ProjectHandle): void {
    this.handles.set(handle.ref.id, handle);
  }

  /** Persist fields that change as a side effect of opening. */
  private async touch(id: string, patch: Partial<ProjectRef>): Promise<void> {
    await withRegistryLock(this.file, () => {
      const current = readProjectsFile(this.file);
      const idx = current.findIndex((r) => r.id === id);
      if (idx < 0) return;
      current[idx] = { ...current[idx], ...patch };
      writeProjectsFile(this.file, current);
      this.refs = current;
    });
  }
}
