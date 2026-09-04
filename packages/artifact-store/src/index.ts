import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import type { ArtifactContentStore, WorkspacePort } from "../../core/src/ports";

const execFileAsync = promisify(execFile);

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
  private baseBranch = "main";

  constructor(basePath: string) {
    this.baseDir = path.resolve(basePath);
    this.mainDir = path.join(this.baseDir, "main");
    this.worktreesDir = path.join(this.baseDir, "worktrees");
  }

  get mainPath(): string {
    return this.mainDir;
  }

  worktreePath(agentId: string): string {
    return path.join(this.worktreesDir, agentId.replace(/[#/]/g, "-"));
  }

  private async git(args: string[], cwd?: string): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: cwd ?? this.mainDir, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  }

  async ensureRepo(): Promise<void> {
    if (this.initialized) return;
    fs.mkdirSync(this.mainDir, { recursive: true });
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    try {
      await this.git(["rev-parse", "--git-dir"]);
    } catch {
      await this.git(["init", "-b", this.baseBranch], this.mainDir);
      await this.git(["config", "user.email", "mesh@localhost"], this.mainDir);
      await this.git(["config", "user.name", "Mesh Supervisor"], this.mainDir);
      fs.writeFileSync(path.join(this.mainDir, "README.md"), "# Mesh workspace\n\nManaged by agent-mesh git worktrees.\n", "utf8");
      await this.git(["add", "-A"], this.mainDir);
      await this.git(["commit", "-m", "mesh: initialize workspace"], this.mainDir);
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
    if (fs.existsSync(path.join(target, ".git"))) return target;
    const branch = `mesh/${agentId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    fs.mkdirSync(this.worktreesDir, { recursive: true });
    try {
      await this.git(["rev-parse", "--verify", branch]);
      await this.git(["worktree", "add", target, branch]);
    } catch {
      await this.git(["worktree", "add", "-b", branch, target, this.baseBranch]);
    }
    await this.git(["config", "user.email", "mesh@localhost"], target);
    await this.git(["config", "user.name", `Mesh Agent ${agentId}`], target);
    return target;
  }

  async commitWorktree(agentId: string, message: string, files?: string[]): Promise<{ commit: string; diffDigest: string; diff: string }> {
    const target = await this.ensureWorktree(agentId);
    if (files && files.length > 0) {
      await this.git(["add", "--", ...files], target);
    } else {
      await this.git(["add", "-A"], target);
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

  async mergeWorktree(artifactId: string, agentId: string, message: string): Promise<{ commit: string }> {
    await this.ensureRepo();
    const branch = `mesh/${agentId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
    void artifactId;
    await this.git(["merge", "--no-edit", "-m", message, branch], this.mainDir);
    const sha = await this.git(["rev-parse", "HEAD"], this.mainDir);
    return { commit: sha };
  }

  async removeWorktree(agentId: string): Promise<void> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(target)) return;
    await this.git(["worktree", "remove", "--force", target]).catch(() => undefined);
  }

  async fileStates(agentId: string): Promise<string> {
    const target = this.worktreePath(agentId);
    if (!fs.existsSync(target)) return "(no worktree)";
    const status = await this.git(["status", "--porcelain"], target);
    const log = await this.git(["log", "--oneline", `${this.baseBranch}..HEAD`], target).catch(() => "");
    return `${status}\n${log}`;
  }
}
