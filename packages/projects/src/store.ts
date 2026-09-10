import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { PROJECTS_FILENAME, PROJECTS_FILE_VERSION, ProjectError, type ProjectRef, type ProjectsFile } from "./types";

/**
 * Root of the host's own state: `~/.agent-mesh`, overridable with `MESH_HOME`.
 * The override exists so tests and parallel hosts never touch a real user's
 * registry — it is read on every call rather than cached, because a process
 * that changes it mid-run means to change it.
 */
export function meshHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MESH_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".agent-mesh");
}

export function projectsFilePath(home: string = meshHome()): string {
  return path.join(home, PROJECTS_FILENAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Entries that do not carry the fields the host needs are dropped rather than
 * failing the whole load: one hand-edited line must not cost the user every
 * other project. A structurally broken *file* is a different matter and does
 * throw, because silently starting from an empty registry looks like data loss.
 */
function coerceRef(value: unknown): ProjectRef | null {
  if (!isRecord(value)) return null;
  const { id, root, configPath, addedAt } = value;
  if (typeof id !== "string" || id === "") return null;
  if (typeof root !== "string" || root === "") return null;
  if (typeof configPath !== "string" || configPath === "") return null;
  const ref: ProjectRef = {
    id,
    name: typeof value.name === "string" && value.name !== "" ? value.name : id,
    root,
    configPath,
    addedAt: typeof addedAt === "string" ? addedAt : new Date(0).toISOString(),
  };
  if (typeof value.lastOpenedAt === "string") ref.lastOpenedAt = value.lastOpenedAt;
  return ref;
}

/** A missing file is an empty registry — the first `add` creates it. */
export function readProjectsFile(file: string): ProjectRef[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  if (text.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ProjectError(
      "registry_corrupt",
      `project registry is not valid JSON: ${file}`,
      (err as Error).message,
    );
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.projects)) {
    throw new ProjectError("registry_corrupt", `project registry has an unexpected shape: ${file}`);
  }
  if (typeof parsed.version === "number" && parsed.version > PROJECTS_FILE_VERSION) {
    throw new ProjectError(
      "registry_corrupt",
      `project registry version ${parsed.version} was written by a newer agent-mesh: ${file}`,
    );
  }
  const refs: ProjectRef[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.projects) {
    const ref = coerceRef(entry);
    // Two entries with one id means two tabs racing for one lock, so a
    // duplicate that reached disk somehow loses to the first occurrence.
    if (ref && !seen.has(ref.id)) {
      seen.add(ref.id);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * Temp file + rename, so a reader never observes a half-written registry and a
 * crash mid-write leaves the previous list intact. The temp name carries pid
 * and a uuid: two hosts writing at the same instant must not share a scratch
 * file and splice each other's bytes together.
 */
export function writeProjectsFile(file: string, projects: ProjectRef[]): void {
  const payload: ProjectsFile = { version: PROJECTS_FILE_VERSION, projects };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

const LOCK_SUFFIX = ".lock";
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize read-modify-write across processes.
 *
 * Atomic rename alone keeps the file well-formed but makes concurrent adds
 * last-writer-wins, which loses entries. Holding this lock for the whole
 * read → mutate → write cycle is what makes N hosts adding N projects end with
 * N projects.
 */
export async function withRegistryLock<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  const lockFile = `${file}${LOCK_SUFFIX}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // A host killed mid-mutation must not wedge every other host forever.
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // released under us; retry immediately
      }
      if (age > LOCK_STALE_MS) {
        fs.rmSync(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new ProjectError("registry_corrupt", `timed out waiting for the project registry lock: ${lockFile}`);
      }
      await sleep(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}
