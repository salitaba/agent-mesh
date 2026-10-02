import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash, randomUUID } from "crypto";
import type { ArtifactContentStore, WorkspacePort, WorktreeState, WorktreeSync } from "../../core/src/ports";

const execFileAsync = promisify(execFile);

/** Per-call overrides for `GitWorkspace.git`/`gitRaw`; only the checkpoint uses them. */
interface GitRunOptions {
  /** The WHOLE environment for the child, not a delta — callers spread `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Kill the child after this long, so a caller on a failure path cannot hang on git. */
  timeoutMs?: number;
}

/**
 * The paths in `git status --porcelain=v1 -z` output, and how many are untracked.
 *
 * Each record is `XY PATH` with the status in fixed columns, so nothing may trim
 * it (a trimmed ` M README.md` became `EADME.md`), and `-z` keeps paths unquoted
 * and drops the `->` rename syntax -- a rename is `XY NEW\0ORIG\0`, so its
 * second field is skipped.
 */
function parsePorcelainZ(porcelain: string): { paths: string[]; untracked: number } {
  const fields = porcelain.split("\0");
  const paths: string[] = [];
  let untracked = 0;
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    paths.push(rec.slice(3));
    if (xy === "??") untracked++;
    if (/[RC]/.test(xy)) i++;
  }
  return { paths, untracked };
}

/**
 * Paths past which a checkpoint is skipped rather than taken. A worktree
 * reporting more than this with `-uall` is almost always an unignored
 * dependency or build directory, and hashing it on a turn's failure path would
 * cost more than the snapshot is worth.
 */
const CHECKPOINT_MAX_PATHS = 5000;

/** Wall-clock budget for a whole checkpoint, shared across its git calls. */
const CHECKPOINT_TIMEOUT_MS = 30_000;

export class FileSystemArtifactStore implements ArtifactContentStore {
  constructor(private rootDir: string) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  private artifactDir(artifactId: string): string {
    return path.join(this.rootDir, "artifacts", artifactId);
  }

  async writeVersion(artifactId: string, version: number, content: string): Promise<string> {
    const dir = this.artifactDir(artifactId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `v${version}.txt`);
    fs.writeFileSync(file, content, "utf8");
    return `file://${file}`;
  }

  async read(contentRef: string): Promise<string> {
    const resolved = contentRef.startsWith("file://") ? contentRef.slice("file://".length) : contentRef;
    if (!fs.existsSync(resolved)) throw new Error(`artifact content missing: ${resolved}`);
    return fs.readFileSync(resolved, "utf8");
  }

  async exists(contentRef: string): Promise<boolean> {
    const resolved = contentRef.startsWith("file://") ? contentRef.slice("file://".length) : contentRef;
    return fs.existsSync(resolved);
  }
}

export class InMemoryArtifactStore implements ArtifactContentStore {
  private blobs = new Map<string, string>();
  async writeVersion(artifactId: string, version: number, content: string): Promise<string> {
    const ref = `mem://${artifactId}/v${version}`;
    this.blobs.set(ref, content);
    return ref;
  }
  async read(contentRef: string): Promise<string> {
    const v = this.blobs.get(contentRef);
    if (v === undefined) throw new Error(`artifact content missing: ${contentRef}`);
    return v;
  }
  async exists(contentRef: string): Promise<boolean> {
    return this.blobs.has(contentRef);
  }
}

export class GitWorkspace implements WorkspacePort {
  private baseDir: string;
  private mainDir: string;
  private worktreesDir: string;
  private initialized = false;
  /** Seats whose worktree identity is already in place this process. */
  private readonly identitySet = new Set<string>();
  private baseBranch = "main";

  constructor(basePath: string) {
    this.baseDir = path.resolve(basePath);
    this.mainDir = path.join(this.baseDir, "main");
    this.worktreesDir = path.join(this.baseDir, "worktrees");
  }

  get mainPath(): string {
    return this.mainDir;
  }

  /** The directory holding the agent worktrees, one subdirectory per agent. */
  get worktreesPath(): string {
    return this.worktreesDir;
  }

  worktreePath(agentId: string): string {
    return path.join(this.worktreesDir, agentId.replace(/[#/]/g, "-"));
  }

  private async git(args: string[], cwd?: string, opts?: GitRunOptions): Promise<string> {
    return (await this.gitRaw(args, cwd, opts)).trim();
  }

  /**
   * `git` without the trim. Anything column-positional must come through here:
   * `git()` trims the WHOLE output, so porcelain's first line ` M README.md`
   * lost its leading space and a `.slice(3)` parser read it as `EADME.md`.
   */
  private async gitRaw(args: string[], cwd?: string, opts?: GitRunOptions): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: cwd ?? this.mainDir,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.timeoutMs !== undefined ? { timeout: Math.max(1, opts.timeoutMs) } : {}),
    });
    return stdout;
  }

  /** True when the product checkout is in the middle of a merge (MERGE_HEAD exists). */
  private async mergeInProgress(): Promise<boolean> {
    return this.git(["rev-parse", "-q", "--verify", "MERGE_HEAD"], this.mainDir).then(
      () => true,
      () => false,
    );
  }

  /**
   * Put the product checkout back where it was before a merge that failed.
   *
   * A conflicted `git merge` exits non-zero but leaves MERGE_HEAD and
   * `<<<<<<<` markers in the checkout, and every later `git merge` then fails
   * with "You have not concluded your merge": one conflict wedged every landing
   * after it. `merge --abort` is the normal way out; `reset --merge` is what it
   * runs underneath and still works when abort refuses. `reset --hard` to the
   * pre-merge HEAD is the last resort, and only while the checkout still shows
   * a merge's leftovers: it discards tracked modifications in the product
   * checkout (untracked files survive), which is acceptable because a checkout
   * git cannot take out of a merge is already unusable for every landing after
   * it. Returns null when the checkout is clean
   * again, otherwise a description of what is still wrong.
   */
  private async restoreAfterFailedMerge(headBefore: string): Promise<string | null> {
    const leftovers = async (): Promise<boolean> => {
      if (await this.mergeInProgress()) return true;
      const unmerged = await this.git(["diff", "--name-only", "--diff-filter=U"], this.mainDir).catch(() => "");
      return unmerged.length > 0;
    };
    await this.git(["merge", "--abort"], this.mainDir).catch(() => undefined);
    if (!(await leftovers())) return null;
    await this.git(["reset", "--merge"], this.mainDir).catch(() => undefined);
    if (!(await leftovers())) return null;
    await this.git(["reset", "--hard", headBefore], this.mainDir).catch(() => undefined);
    if (!(await leftovers())) return null;
    return "the product checkout still holds an unfinished merge (MERGE_HEAD or unmerged paths) after merge --abort, reset --merge and reset --hard";
  }

  /**
   * Run one `git merge` on the product checkout, and on failure clean up before
   * rethrowing. The original error is what the caller sees (its stderr names
   * the conflict); a cleanup that also failed is appended to its message.
   */
  private async runMerge(args: string[], headBefore: string): Promise<void> {
    try {
      await this.git(["merge", ...args], this.mainDir);
    } catch (err) {
      const stuck = await this.restoreAfterFailedMerge(headBefore);
      if (stuck && err instanceof Error) err.message = `${err.message}\n(cleanup failed: ${stuck})`;
      throw err;
    }
  }

  /**
   * Uncommitted changes to tracked files in the product checkout, saved under a ref and removed from the
   * working tree, so the merge that follows lands on a clean checkout. Null when there are none.
   *
   * Nothing legitimate is uncommitted there: work reaches the product checkout through `mergeWorktree`
   * alone, and a seat's own work lives in its worktree. When something is, a seat wrote it directly (the
   * seventh cronlite run's developer edited `src/index.js` by the product checkout's absolute path),
   * it is on no branch, and `git merge` refuses to run over it: "Your local changes to the following
   * files would be overwritten". Every merge after that failed the same way, six times, and no seat
   * could clear it (the merger has no write tool, and the owner of the files sees a clean worktree of
   * its own) until the operator reset the checkout by hand. `restoreAfterFailedMerge` already takes the
   * same position for a checkout a merge has wedged: tracked modifications are discarded, because a
   * checkout that cannot take a merge is unusable for every landing after it.
   *
   * What is discarded is kept first. `git stash create` records the working tree and the index as a
   * commit without touching either, and the commit is pinned under `refs/mesh/product-set-aside/<time>`,
   * so the content is recoverable with `git show <ref>:<path>`. If it cannot be saved, nothing is
   * removed. Untracked files are left alone: they are not what `git merge` trips on unless a landing
   * brings the same path, and deleting a file with no copy anywhere is a different decision.
   */
  async setAsideProductChanges(): Promise<{ files: string[]; ref: string } | null> {
    await this.ensureRepo();
    const status = await this.gitRaw(["status", "--porcelain", "--untracked-files=no"], this.mainDir).catch(() => "");
    const files = status
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).replace(/^.* -> /, ""));
    if (files.length === 0) return null;
    const saved = await this.git(["stash", "create", "mesh: uncommitted changes found in the product checkout"], this.mainDir).catch(() => "");
    if (!saved) return null;
    const ref = `refs/mesh/product-set-aside/${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await this.git(["update-ref", ref, saved], this.mainDir);
    await this.git(["reset", "--hard", "HEAD"], this.mainDir);
    return { files, ref };
  }

  /**
   * Keep the runtime's own `.mesh/` directory out of the product repo.
   *
   * The Claude adapter writes each seat's ROLE.md and MESH_CONTEXT.md to
   * `<workspace>/.mesh/agents/<id>/`, inside the seat's worktree or the product
   * checkout. A seat's `git add -A` (and `commitWorktree`'s) swept them into the
   * patch: the delivered cronlite tree shipped the developer's prompt, committed
   * on `main`, while the PM's and tech lead's sat untracked beside it.
   *
   * `info/exclude` lives in the repository's common git dir, so it covers the
   * main checkout and every linked worktree at once, and unlike a `.gitignore`
   * it is not product content: an adopted repository's own files stay as they
   * were. Appended, never rewritten, and only once.
   */
  private async excludeRuntimeDir(): Promise<void> {
    const rel = await this.git(["rev-parse", "--git-path", "info/exclude"], this.mainDir);
    const file = path.resolve(this.mainDir, rel);
    let current = "";
    try {
      current = fs.readFileSync(file, "utf8");
    } catch {
      current = "";
    }
    if (current.split(/\r?\n/).some((line) => line.trim() === ".mesh/" || line.trim() === ".mesh")) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}# Ordane runtime files (seat prompts): never product content\n.mesh/\n`, "utf8");
  }

  async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    fs.mkdirSync(this.mainDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    // `rev-parse --git-dir` succeeding is not proof that `mainDir` is its own
    // repo: when the product checkout sits at the workspace root, `mainDir` is
    // nested inside that repo and git adopts the ancestor. Worktrees and
    // merges then happen in the root repo while `mainDir` stays an empty
    // phantom — the Product page keeps showing root files that reset never
    // touches. Only an exact toplevel match counts as "this directory is the
    // repository"; anything else (no repo, or an ancestor repo) gets a fresh
    // repo scoped to `mainDir`.
    let toplevel: string | null = null;
    try {
      toplevel = await this.git(["rev-parse", "--show-toplevel"]);
    } catch {
      toplevel = null;
    }
    const ownsRepo =
      toplevel !== null && fs.realpathSync(toplevel) === fs.realpathSync(this.mainDir);
    if (!ownsRepo) {
      await this.git(["init", "-b", this.baseBranch], this.mainDir);
      await this.git(["config", "user.email", "mesh@localhost"], this.mainDir);
      await this.git(["config", "user.name", "Mesh Supervisor"], this.mainDir);
      await this.excludeRuntimeDir();
      fs.writeFileSync(path.join(this.mainDir, "README.md"), "# Mesh workspace\n\nManaged by Ordane git worktrees.\n", "utf8");
      await this.git(["add", "-A"], this.mainDir);
      await this.git(["commit", "-m", "mesh: initialize workspace"], this.mainDir);
    } else {
      await this.excludeRuntimeDir();
    }
    const branchCheck = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], this.mainDir);
    if (branchCheck !== this.baseBranch) {
      try {
        await this.git(["checkout", this.baseBranch], this.mainDir);
      } catch {
        await this.git(["checkout", "-B", this.baseBranch], this.mainDir);
      }
    }
    this.initialized = true;
  }

  async ensureWorktree(agentId: string): Promise<string> {
    await this.ensureRepo();
    const target = this.worktreePath(agentId);
    if (fs.existsSync(path.join(target, ".git"))) {
      await this.ensureWorktreeIdentity(agentId, target);
      return target;
    }
    const branch = `mesh/${agentId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    try {
      await this.git(["rev-parse", "--verify", branch]);
      await this.git(["worktree", "add", target, branch]);
    } catch {
      await this.git(["worktree", "add", "-b", branch, target, this.baseBranch]);
    }
    await this.ensureWorktreeIdentity(agentId, target);
    return target;
  }

  /**
   * Commit as this seat from this worktree — and only this worktree.
   *
   * A plain `git config user.name` run inside a linked worktree writes the
   * repository's SHARED config, so the last worktree created named every seat:
   * frontend's `b03f2b1` was authored "Mesh Agent ui-designer" (live run
   * 2026-09-25). Seats commit through Bash in their own worktree as well as
   * through `commitWorktree`, so the identity has to live in the worktree's own
   * config (`extensions.worktreeConfig` + `--worktree`), which covers both.
   *
   * Also run for a worktree that already exists: repositories created before
   * this fix carry a clobbered shared identity, which is put back to the
   * supervisor's own when it is one of ours. A human-set identity is left alone.
   */
  private async ensureWorktreeIdentity(agentId: string, target: string): Promise<void> {
    if (this.identitySet.has(agentId)) return;
    await this.git(["config", "extensions.worktreeConfig", "true"], this.mainDir);
    let shared = "";
    try {
      shared = await this.git(["config", "--file", path.join(this.mainDir, ".git", "config"), "user.name"]);
    } catch {
      shared = "";
    }
    if (shared.startsWith("Mesh Agent ")) {
      await this.git(["config", "user.name", "Mesh Supervisor"], this.mainDir);
    }
    await this.git(["config", "--worktree", "user.email", "mesh@localhost"], target);
    await this.git(["config", "--worktree", "user.name", `Mesh Agent ${agentId}`], target);
    this.identitySet.add(agentId);
  }

  async commitWorktree(agentId: string, message: string, files?: string[]): Promise<{ commit: string; diffDigest: string; diff: string }> {
    const target = await this.ensureWorktree(agentId);
    if (files && files.length > 0) {
      await this.git(["add", "--", ...files], target);
    } else {
      await this.git(["add", "-A"], target);
      // `.mesh/` is the runtime's, not the patch's. `info/exclude` already keeps
      // it from being added while untracked; this unstages it for a repository
      // that committed it before that existed, where a tracked seat prompt would
      // otherwise ride into every later patch as a modification. (An exclude
      // pathspec on `add` is the obvious spelling, and git refuses it whenever
      // `.mesh` is ignored: "The following paths are ignored", exit 1.)
      await this.git(["reset", "-q", "--", ".mesh"], target);
    }
    let commit = "";
    try {
      commit = await this.git(["commit", "-m", message], target);
    } catch (err) {
      if (!/nothing to commit/i.test(String((err as { stdout?: string }).stdout ?? (err as Error).message))) throw err;
    }
    const sha = await this.git(["rev-parse", "HEAD"], target);
    const diff = await this.git(["diff", `${this.baseBranch}...HEAD`, "--patch"], target);
    const diffDigest = `sha256:${createHash("sha256").update(diff).digest("hex")}`;
    return { commit: sha, diffDigest, diff };
  }

  /**
   * Merge one artifact's commit onto the product branch.
   *
   * `artifactId` used to be discarded with a bare `void artifactId;` and the
   * whole agent branch merged instead. That is not what approving an artifact
   * means: a seat commits several times, one patch is reviewed and approved,
   * and merging its branch tip landed every OTHER commit sitting on that branch
   * too -- unreviewed work carried into the product on someone else's approval.
   *
   * `commit` (the sha `opCommit` stored on the artifact) fixes the scope.
   * `git merge <sha>` lands that commit and its ancestors, which is exactly
   * "this artifact and what it was built on", and leaves later commits behind.
   * Cherry-pick would be wrong here: `commitWorktree` builds the artifact's diff
   * as `main...HEAD`, so its content is already cumulative against main.
   *
   * `--no-ff` is deliberate. A fast-forward would move the product branch with
   * no merge commit, discarding `message` and erasing which artifact landed;
   * with it, `git log --merges` on the product branch IS the ledger of landings.
   */
  async mergeWorktree(
    artifactId: string,
    agentId: string,
    message: string,
    commit?: string,
  ): Promise<{ commit: string; alreadyUpToDate?: boolean; leftBehind?: string[] }> {
    await this.ensureRepo();
    const branch = `mesh/${agentId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const oneline = async (range: string): Promise<string[]> =>
      (await this.git(["log", "--oneline", range], this.mainDir).catch(() => ""))
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    // A merge already in progress here is one a crashed process (or code from
    // before `runMerge` cleaned up) left behind: nothing else writes to the
    // product checkout. Finish backing it out rather than failing on it forever.
    if (await this.mergeInProgress()) {
      const stuck = await this.restoreAfterFailedMerge(await this.git(["rev-parse", "HEAD"], this.mainDir));
      if (stuck) throw new Error(`cannot merge artifact ${artifactId}: ${stuck}`);
    }

    if (!commit) {
      // No sha on the artifact: pre-fix logs, and patches published from a path
      // rather than through `opCommit`. Merging the branch is the old behaviour
      // and stays, because refusing would strand those artifacts -- but say what
      // it swept in, so the over-merge is on the record instead of silent.
      //
      // `git merge <branch>` exits 0 on "Already up to date": a seat that wrote
      // files but never committed has a branch that IS main, and the merge
      // "succeeds" having landed nothing. Whether anything landed is decided by
      // HEAD moving, not by parsing git's English -- the same `alreadyUpToDate`
      // outcome the sha arm reports.
      const headBefore = await this.git(["rev-parse", "HEAD"], this.mainDir);
      const leftBehind = await oneline(`HEAD..${branch}`);
      await this.runMerge(["--no-edit", "-m", message, branch], headBefore);
      const sha = await this.git(["rev-parse", "HEAD"], this.mainDir);
      if (sha === headBefore) return { commit: sha, alreadyUpToDate: true };
      return { commit: sha, ...(leftBehind.length > 1 ? { leftBehind } : {}) };
    }

    // A sha the repository does not have is a broken reference, not a conflict:
    // say which artifact and where the commits went, because `git merge`'s own
    // message ("not something we can merge") names neither.
    //
    // The value is quoted WHOLE. It used to be `commit.slice(0, 12)`, which for
    // a prose value (`b83c898 (on mesh/frontend; 6ea2614 -> …)`) printed
    // `b83c898 (on ` — read by three seats as a template with an empty branch
    // name, and escalated as a runtime defect while the merge sat blocked for
    // hours. The reset hint only fits a real sha: prose was never pruned.
    try {
      await this.git(["cat-file", "-e", `${commit}^{commit}`], this.mainDir);
    } catch {
      throw new Error(
        `commit ${JSON.stringify(commit)} recorded on artifact ${artifactId} is not in this repository — ` +
          (/^[0-9a-f]{7,40}$/i.test(commit)
            ? `it may have been pruned with its branch by a mission reset (recover it from the mesh-branches bundle in .mesh-backups)`
            : `metadata.commit must name a commit here: a bare sha (what the \`commit\` op records) or an existing branch`),
      );
    }
    // Already an ancestor: `git merge` would exit 0 having done nothing, and the
    // caller would record a merge and mark implementation-merged EVIDENCED off a
    // no-op. Report it as its own outcome instead.
    const isAncestor = await this.git(["merge-base", "--is-ancestor", commit, "HEAD"], this.mainDir).then(
      () => true,
      () => false,
    );
    const head = await this.git(["rev-parse", "HEAD"], this.mainDir);
    if (isAncestor) return { commit: head, alreadyUpToDate: true };

    const leftBehind = await oneline(`${commit}..${branch}`);
    await this.runMerge(["--no-ff", "--no-edit", "-m", message, commit], head);
    const sha = await this.git(["rev-parse", "HEAD"], this.mainDir);
    return { commit: sha, ...(leftBehind.length > 0 ? { leftBehind } : {}) };
  }

  /**
   * The full sha `ref` names in the product repository — the one `mergeWorktree`
   * merges in — or null when it names no commit there.
   *
   * Asked when a CodePatch records `metadata.commit`, so a reference the merge
   * could never use is refused at publish rather than hours later at merge.
   * Worktrees share the product repository's objects and refs, so a seat's own
   * commits and `mesh/*` branches resolve here. Throws only when git itself
   * could not answer (`rev-parse --verify --quiet` exits 1, silently, for "no
   * such commit"; anything else is a failure to ask, not an answer).
   *
   * The caller validates `ref`'s syntax first; in particular it cannot start
   * with `-`, so it is never read as an option.
   */
  async resolveCommit(ref: string): Promise<string | null> {
    await this.ensureRepo();
    try {
      const sha = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], this.mainDir);
      return sha || null;
    } catch (err) {
      if ((err as { code?: unknown }).code === 1) return null;
      throw err;
    }
  }

  async removeWorktree(agentId: string): Promise<void> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(target)) return;
    await this.git(["worktree", "remove", "--force", target]).catch(() => undefined);
  }

  /**
   * Remove every agent worktree and its throwaway `mesh/*` branch. Mission
   * reset needs this: archiving the event log is not enough if the next run's
   * agents can still read the previous run's uncommitted files from a stale
   * worktree or its branch. Returns the removed worktree directory names.
   */
  async removeAllWorktrees(): Promise<string[]> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.worktreesDir);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const entry of entries) {
      const target = path.join(this.worktreesDir, entry);
      await this.git(["worktree", "remove", "--force", target]).catch(() => undefined);
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
      removed.push(entry);
    }
    await this.git(["worktree", "prune"]).catch(() => undefined);
    // Same list `bundleWorktreeBranches` packs. Whatever wants these commits to
    // outlive the reset has to have bundled them before this point.
    for (const branch of await this.listWorktreeBranches()) {
      await this.git(["branch", "-D", branch]).catch(() => undefined);
    }
    return removed;
  }

  /**
   * The throwaway `mesh/*` branches currently cut, one per agent worktree.
   * `removeAllWorktrees` deletes these, so anything that wants them to outlive
   * a reset has to read them first.
   */
  async listWorktreeBranches(): Promise<string[]> {
    const out = await this.git(["branch", "--list", "mesh/*", "--format=%(refname:short)"]).catch(() => "");
    return out.split("\n").map((b) => b.trim()).filter(Boolean);
  }

  /**
   * Write every `mesh/*` branch to a git bundle at `destFile` so the commits
   * survive the reset that deletes the branches. Returns null when there is
   * nothing to bundle — `git bundle create` refuses an empty bundle outright,
   * so the check has to happen before the call, not as its error.
   *
   * The bundle is deliberately self-contained (no `--not main`): it packs the
   * full history reachable from those branches, which makes recovery
   * independent of the archived product repo but costs tens of MB on a busy
   * mission. `--branches=mesh/*` also leaves the refs under `refs/heads/`, so
   * `git fetch <bundle> 'refs/heads/*:refs/heads/restored/*'` restores them
   * without a detour through a detached HEAD.
   */
  async bundleWorktreeBranches(destFile: string): Promise<{ path: string; refs: string[] } | null> {
    const refs = await this.listWorktreeBranches();
    if (refs.length === 0) return null;
    fs.mkdirSync(path.dirname(destFile), { recursive: true });
    await this.git(["bundle", "create", destFile, "--branches=mesh/*"]);
    return { path: destFile, refs };
  }

  /**
   * Wipe the product checkout after the caller has archived `mainPath`
   * elsewhere. The next `ensureRepo` re-initializes an empty repository, so a
   * reset mission cannot read the previous mission's merged product.
   */
  removeMain(): void {
    this.initialized = false;
    fs.rmSync(this.mainDir, { recursive: true, force: true });
  }

  /**
   * What a seat has in its worktree that has not reached the product.
   *
   * Replaces a `fileStates` that returned a formatted string and had no callers
   * at all -- so nothing in the runtime ever noticed uncommitted work. A live
   * run on 2026-09-24 ended with 1,847 lines across three source modules and six
   * test files sitting untracked in one seat's worktree: never committed, never
   * merged, and never once reported to the seat that wrote them.
   *
   * Structured rather than pre-formatted because both callers count: the turn
   * advisory needs the numbers for a sentence, and the reset manifest needs them
   * as data.
   */
  async worktreeState(agentId: string): Promise<WorktreeState | null> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(target)) return null;
    // `-uall`, not the default: plain `--porcelain` collapses an untracked
    // directory to one entry, so a seat that wrote `src/core/a.js`,
    // `src/core/b.js` and `test/c.js` reported "2 files" (`src/`, `test/`). The
    // count is the whole point of the warning, and undercounting it by an order
    // of magnitude is how 1,847 uncommitted lines read as nothing much.
    //
    // `-z` and `gitRaw`, not `git()`: see `parsePorcelainZ`.
    const porcelain = await this.gitRaw(["status", "--porcelain=v1", "-z", "-uall"], target).catch(() => "");
    const { paths: dirty, untracked } = parsePorcelainZ(porcelain);
    const unmergedCommits = (await this.git(["log", "--oneline", `${this.baseBranch}..HEAD`], target).catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const head = await this.git(["rev-parse", "--short=12", "HEAD"], target).catch(() => undefined);
    return { agentId, dirty, untracked, unmergedCommits, ...(head ? { head } : {}) };
  }

  /** See `WorkspacePort.containsCommit`. */
  async containsCommit(agentId: string, commit: string): Promise<boolean | null> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(path.join(target, ".git"))) return null;
    // A value git would read as an option is not a commit: the same caution `commitRefError` takes
    // at merge, for a sha that arrives from a seat's own metadata.
    if (!/^[0-9a-fA-F]{4,64}$/.test(commit)) return null;
    try {
      await this.git(["merge-base", "--is-ancestor", commit, "HEAD"], target);
      return true;
    } catch (err) {
      // `--is-ancestor` exits 1 for "not an ancestor" and 128 for an object it cannot find: only the first is an answer.
      return (err as { code?: unknown }).code === 1 ? false : null;
    }
  }

  /**
   * See `WorkspacePort.checkpointWorktree`.
   *
   * Plumbing on a throwaway index, so nothing the seat can see moves:
   * `GIT_INDEX_FILE` points `read-tree`/`add`/`write-tree` at a temp file seeded
   * from HEAD, `commit-tree` makes a commit no branch points at, and `ref` is the
   * only thing written. The real index is never locked or refreshed either
   * (`GIT_OPTIONAL_LOCKS=0` stops `status` rewriting its stat cache): a stopped
   * turn's shell may still be running git in this worktree, and an `index.lock`
   * of ours would fail the seat's own `git add`.
   *
   * A `ref` under `refs/heads/` or outside `refs/` is refused (null):
   * `update-ref` on a branch or on `HEAD` would move exactly what this promises
   * not to touch.
   */
  async checkpointWorktree(agentId: string, ref: string, message: string): Promise<{ commit: string; files: string[] } | null> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(target)) return null;
    if (!ref.startsWith("refs/") || ref.startsWith("refs/heads/")) return null;
    const deadline = Date.now() + CHECKPOINT_TIMEOUT_MS;
    const tmpIndex = path.join(os.tmpdir(), `mesh-checkpoint-${process.pid}-${randomUUID()}.index`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      // `commit-tree` refuses to run without an identity, and neither a repo
      // adopted from an operator nor a worktree whose `--worktree` identity was
      // not written this process is guaranteed one. The seat wrote the files;
      // the mesh took the snapshot.
      GIT_AUTHOR_NAME: `Mesh Agent ${agentId}`,
      GIT_AUTHOR_EMAIL: "mesh@localhost",
      GIT_COMMITTER_NAME: "Mesh Supervisor",
      GIT_COMMITTER_EMAIL: "mesh@localhost",
    };
    const run = (args: string[], index?: string): Promise<string> =>
      this.git(args, target, { env: index ? { ...env, GIT_INDEX_FILE: index } : env, timeoutMs: deadline - Date.now() });
    try {
      const status = await this.gitRaw(["status", "--porcelain=v1", "-z", "-uall"], target, { env, timeoutMs: deadline - Date.now() });
      const { paths } = parsePorcelainZ(status);
      if (paths.length === 0 || paths.length > CHECKPOINT_MAX_PATHS) return null;
      await run(["read-tree", "HEAD"], tmpIndex);
      await run(["add", "-A"], tmpIndex);
      const tree = await run(["write-tree"], tmpIndex);
      // Dirty by status but identical to HEAD by content (an edit reverted, a
      // staged change undone in the file): nothing to keep.
      if (tree === (await run(["rev-parse", "HEAD^{tree}"]))) return null;
      const commit = await run(["commit-tree", tree, "-p", "HEAD", "-m", message]);
      await run(["update-ref", ref, commit]);
      return { commit, files: paths };
    } catch {
      // Best-effort by contract: the caller is on a turn's failure path.
      return null;
    } finally {
      fs.rmSync(tmpIndex, { force: true });
      fs.rmSync(`${tmpIndex}.lock`, { force: true });
    }
  }

  /**
   * See `WorkspacePort.syncWorktree`.
   *
   * Advances only when nothing the seat wrote can be touched: it is on its own branch,
   * holds no commit the product branch lacks, and has no uncommitted change to a
   * tracked file. `--ff-only` then moves it, and git itself still refuses if an
   * untracked file of the seat's would be overwritten, which is reported like the rest
   * as "blocked". Every other case is left exactly as it was and described, so the seat
   * can decide (`git merge main` after committing) with the facts in hand.
   */
  async syncWorktree(agentId: string): Promise<WorktreeSync | null> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(path.join(target, ".git"))) return null;
    const base = this.baseBranch;
    let baseCommit: string;
    let behind: number;
    let ahead: number;
    try {
      baseCommit = await this.git(["rev-parse", "--short=12", base], target);
      behind = Number(await this.git(["rev-list", "--count", `HEAD..${base}`], target));
      ahead = Number(await this.git(["rev-list", "--count", `${base}..HEAD`], target));
    } catch {
      return null;
    }
    const info = { base, baseCommit, behind, ahead };
    if (behind === 0) return { ...info, outcome: "current" };
    const blocked = (why: string): WorktreeSync => ({ ...info, outcome: "blocked", why });
    const own = `mesh/${agentId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    const branch = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], target).catch(() => "");
    if (branch !== own) return blocked(branch === "HEAD" ? `it is on a detached HEAD, not ${own}` : `it is on branch ${branch || "(unknown)"}, not ${own}`);
    if (ahead > 0) return blocked(`your branch holds ${ahead} commit${ahead === 1 ? "" : "s"} that ${base} lacks, so it cannot simply advance`);
    const tracked = await this.gitRaw(["status", "--porcelain=v1", "-z", "--untracked-files=no"], target, { env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).catch(() => "?");
    if (tracked.length > 0) return blocked("it has uncommitted changes to tracked files");
    try {
      await this.git(["merge", "--ff-only", base], target);
    } catch (err) {
      const text = String((err as { stderr?: unknown }).stderr ?? (err as Error).message ?? "").trim();
      const first = text.split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("hint:")) ?? "git refused the fast-forward";
      return blocked(`git refused the fast-forward (${first.slice(0, 160)})`);
    }
    return { ...info, outcome: "advanced" };
  }

  /** Every agent worktree's uncommitted state. Used to record what a reset is about to archive. */
  async worktreeStates(): Promise<WorktreeState[]> {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(this.worktreesDir);
    } catch {
      return [];
    }
    const out: WorktreeState[] = [];
    for (const entry of entries) {
      const state = await this.worktreeState(entry).catch(() => null);
      if (state && (state.dirty.length > 0 || state.unmergedCommits.length > 0)) out.push(state);
    }
    return out;
  }
}
