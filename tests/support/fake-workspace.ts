import type { WorkspacePort, WorktreeState } from "../../packages/core/src/ports";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * The one `WorkspacePort` double.
 *
 * Every suite that needed the git arm used to hand-roll an object literal with
 * whichever two methods it happened to call and cast it `as never`. That is the
 * mechanism by which new port methods stayed untested: `worktreeState` and the
 * 4th `commit` argument of `mergeWorktree` were made optional precisely so
 * those literals kept compiling, and so no double ever exercised either arm.
 * This class is typed against the port with no cast, so a port change breaks
 * it here, once, instead of silently in fifteen places.
 *
 * It records every call and can be told, per operation, to behave abnormally.
 * What it deliberately does NOT do is model git: it holds no files and no
 * history. A test that needs the real thing boots `makeMesh({ git: true })`.
 */

export type FakeCall =
  | { method: "ensureRepo" }
  | { method: "ensureWorktree"; agentId: string }
  | { method: "commitWorktree"; agentId: string; message: string; files?: string[] }
  | { method: "mergeWorktree"; artifactId: string; agentId: string; message: string; commit: string | undefined }
  | { method: "removeWorktree"; agentId: string }
  | { method: "worktreeState"; agentId: string };

type MergeResult = Awaited<ReturnType<WorkspacePort["mergeWorktree"]>>;
type CommitResult = Awaited<ReturnType<WorkspacePort["commitWorktree"]>>;

/**
 * Per-operation behaviour. Each key takes a named abnormal mode or a function
 * that receives the call and answers (or throws) itself. Absent means "works".
 */
export interface FakeWorkspaceBehaviour {
  ensureRepo?: "ok" | "fail" | (() => Promise<void>);
  ensureWorktree?: "ok" | "fail" | ((agentId: string) => Promise<string>);
  /**
   * - `fail`: rejects like `git commit` on a broken index / hook failure.
   * - `nothing`: `nothing to commit` — resolves with the unchanged HEAD sha and
   *   an EMPTY diff, which is what `GitWorkspace.commitWorktree` returns then.
   */
  commit?: "ok" | "fail" | "nothing" | ((agentId: string, message: string, files?: string[]) => Promise<CommitResult>);
  /**
   * - `conflict`: rejects with `git merge`'s real conflict output via execFile.
   * - `alreadyUpToDate`: resolves with the unchanged HEAD and `alreadyUpToDate: true`.
   * - `unknownCommit`: rejects the way a sha pruned by a reset does.
   * - `fail`: rejects with a bare non-conflict git failure.
   */
  merge?:
    | "ok"
    | "conflict"
    | "alreadyUpToDate"
    | "unknownCommit"
    | "fail"
    | ((artifactId: string, agentId: string, message: string, commit: string | undefined) => Promise<MergeResult>);
  /** Reported as `leftBehind` on a successful merge. */
  leftBehind?: string[];
  removeWorktree?: "ok" | "fail";
  /**
   * What `worktreeState` answers, per agent. Absent agent → `null` (no worktree).
   * A function answers for every agent. See `untrackedState` for the common case.
   */
  worktreeState?: Record<string, WorktreeState | null> | ((agentId: string) => Promise<WorktreeState | null>);
  /** Diff every successful commit reports. Default: a one-file patch. */
  diff?: string;
}

/** A worktree holding `files` untracked — work no commit-by-name would pick up. */
export function untrackedState(agentId: string, files: string[], unmergedCommits: string[] = []): WorktreeState {
  return { agentId, dirty: [...files], untracked: files.length, unmergedCommits };
}

export class FakeWorkspace implements WorkspacePort {
  readonly mainPath: string;
  readonly calls: FakeCall[] = [];
  behaviour: FakeWorkspaceBehaviour;
  private seq = 0;
  /** Sha the product branch is at; moved by every successful merge. */
  head = `00000000${"a".repeat(32)}`;

  constructor(opts: { mainPath?: string; behaviour?: FakeWorkspaceBehaviour } = {}) {
    this.mainPath = opts.mainPath ?? "/tmp/fake-workspace/main";
    this.behaviour = opts.behaviour ?? {};
  }

  /** Merge more behaviour in; returns `this` so it chains off the constructor. */
  set(b: FakeWorkspaceBehaviour): this {
    this.behaviour = { ...this.behaviour, ...b };
    return this;
  }

  /** Recorded calls to one method, oldest first. */
  callsTo<M extends FakeCall["method"]>(method: M): Array<Extract<FakeCall, { method: M }>> {
    return this.calls.filter((c): c is Extract<FakeCall, { method: M }> => c.method === method);
  }

  worktreePath(agentId: string): string {
    return `/tmp/fake-workspace/worktrees/${agentId}`;
  }

  private nextSha(): string {
    this.seq += 1;
    return `${this.seq.toString(16).padStart(8, "0")}${"c".repeat(32)}`;
  }

  async ensureRepo(): Promise<void> {
    this.calls.push({ method: "ensureRepo" });
    const b = this.behaviour.ensureRepo;
    if (typeof b === "function") return b();
    if (b === "fail") throw new Error("Command failed: git init -b main\nfatal: cannot mkdir: Permission denied");
  }

  async ensureWorktree(agentId: string): Promise<string> {
    this.calls.push({ method: "ensureWorktree", agentId });
    const b = this.behaviour.ensureWorktree;
    if (typeof b === "function") return b(agentId);
    if (b === "fail") throw new Error(`Command failed: git worktree add\nfatal: '${this.worktreePath(agentId)}' already exists`);
    return this.worktreePath(agentId);
  }

  async commitWorktree(agentId: string, message: string, files?: string[]): Promise<CommitResult> {
    this.calls.push({ method: "commitWorktree", agentId, message, ...(files ? { files: [...files] } : {}) });
    const b = this.behaviour.commit;
    if (typeof b === "function") return b(agentId, message, files);
    if (b === "fail") throw new Error("Command failed: git commit -m\nerror: pre-commit hook failed");
    if (b === "nothing") return { commit: this.head, diffDigest: "sha256:empty", diff: "" };
    const diff = this.behaviour.diff ?? `diff --git a/${files?.[0] ?? "file.txt"} b/${files?.[0] ?? "file.txt"}\n+work\n`;
    return { commit: this.nextSha(), diffDigest: `sha256:fake-${this.seq}`, diff };
  }

  async mergeWorktree(artifactId: string, agentId: string, message: string, commit: string | undefined): Promise<MergeResult> {
    this.calls.push({ method: "mergeWorktree", artifactId, agentId, message, commit });
    const b = this.behaviour.merge;
    if (typeof b === "function") return b(artifactId, agentId, message, commit);
    switch (b) {
      case "conflict":
        // What `git merge` actually produces on a conflict, via execFile.
        throw new Error(
          `Command failed: git merge --no-ff --no-edit -m ${message} ${commit ?? `mesh/${agentId}`}\n` +
            "CONFLICT (content): Merge conflict in src/app.ts\nAutomatic merge failed; fix conflicts and then commit the result.",
        );
      case "unknownCommit":
        throw new Error(`commit ${(commit ?? "").slice(0, 12)} recorded on artifact ${artifactId} is not in this repository`);
      case "fail":
        throw new Error(`Command failed: git merge --no-edit -m ${message} mesh/${agentId}`);
      case "alreadyUpToDate":
        return { commit: this.head, alreadyUpToDate: true };
      default: {
        this.head = this.nextSha();
        const leftBehind = this.behaviour.leftBehind;
        return { commit: this.head, ...(leftBehind?.length ? { leftBehind: [...leftBehind] } : {}) };
      }
    }
  }

  async removeWorktree(agentId: string): Promise<void> {
    this.calls.push({ method: "removeWorktree", agentId });
    if (this.behaviour.removeWorktree === "fail") throw new Error(`Command failed: git worktree remove ${this.worktreePath(agentId)}`);
  }

  async worktreeState(agentId: string): Promise<WorktreeState | null> {
    this.calls.push({ method: "worktreeState", agentId });
    const b = this.behaviour.worktreeState;
    if (typeof b === "function") return b(agentId);
    return b?.[agentId] ?? null;
  }
}

/**
 * Put `ws` on a booted mesh's `deps.workspace` and return the undo.
 *
 * Only for fixtures that need a DOUBLE; `makeMesh({ git: true })` installs a
 * real `GitWorkspace` itself. The in-memory boot leaves the slot undefined,
 * which is why the git arms were unreachable without this.
 */
export function installWorkspace(m: MeshInstance, ws: WorkspacePort): () => void {
  const deps = m.supervisor.deps as { workspace?: WorkspacePort };
  const saved = deps.workspace;
  deps.workspace = ws;
  return () => {
    deps.workspace = saved;
  };
}
