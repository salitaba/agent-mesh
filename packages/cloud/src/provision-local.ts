/**
 * The local-process provisioner: a workspace as a child process of the control plane, for development.
 *
 * It lets the whole hosted service run on one machine, which is how it is tried before anything is paid for. It is not a
 * boundary between customers: an agent's shell runs as the same operating-system user as every other workspace and as the
 * control plane, and can read what they can. So it refuses to create a workspace when the service is configured as production.
 *
 * A stopped workspace's environment (which holds its operator token and gateway key) is kept in a file only its owner can
 * read, outside the workspace's own project directory, so that it can be started again after the control plane restarts.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ProvisionError, type ProvisionedWorkspace, type Provisioner, type WorkspaceRuntimeStatus, type WorkspaceSpec } from "./provisioner";

export interface LocalProvisionerOptions {
  /** Where workspaces live: one directory each. */
  baseDir: string;
  /** The command that starts a host: `[node, cli.js]`. The arguments `host --port N --bind 127.0.0.1` are added. */
  hostCommand: string[];
  /** True when the service is configured as production. The provisioner then refuses. */
  production: boolean;
  /** For tests: how a child is started. */
  spawn?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }) => ChildProcess;
  /** For tests: how a free port is found. */
  freePort?: () => Promise<number>;
}

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

interface Saved {
  env: Record<string, string>;
  port: number;
}

export class LocalProcessProvisioner implements Provisioner {
  readonly kind = "local-process";
  private readonly children = new Map<string, ChildProcess>();

  constructor(private readonly o: LocalProvisionerOptions) {}

  private dir(id: string): string {
    if (!ID.test(id)) throw new ProvisionError(`'${id}' is not a workspace id`);
    return path.join(this.o.baseDir, id);
  }

  private secretsFile(id: string): string {
    // Beside the workspace's directory, not inside its projects root.
    return path.join(this.dir(id), ".provision", "env.json");
  }

  async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    if (this.o.production) {
      throw new ProvisionError("the local-process provisioner is not isolation between customers and will not run in production: use the container provisioner");
    }
    const dir = this.dir(spec.workspaceId);
    fs.mkdirSync(path.join(dir, "home"), { recursive: true });
    fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".provision"), { recursive: true, mode: 0o700 });
    const port = await (this.o.freePort ?? pickFreePort)();
    // The operator's own additions come first: they cannot replace what makes this workspace itself.
    const env: Record<string, string> = {
      ...spec.env,
      MESH_HOME: path.join(dir, "home"),
      HOME: path.join(dir, "home"),
      MESH_PROJECTS_ROOT: path.join(dir, "projects"),
      MESH_API_TOKEN: spec.operatorToken,
      MESH_LICENSE_ENFORCEMENT: "enforce",
      CURULE_GATEWAY_KEY: spec.gateway.key,
      CURULE_GATEWAY_URL: spec.gateway.baseUrl,
      ...(spec.licence ? { MESH_LICENSE: spec.licence } : {}),
    };
    fs.writeFileSync(this.secretsFile(spec.workspaceId), JSON.stringify({ env, port } satisfies Saved), { mode: 0o600 });
    return this.start(spec.workspaceId);
  }

  private start(id: string): ProvisionedWorkspace {
    const saved = JSON.parse(fs.readFileSync(this.secretsFile(id), "utf8")) as Saved;
    const [command, ...base] = this.o.hostCommand;
    if (!command) throw new ProvisionError("no host command is configured");
    const args = [...base, "host", "--port", String(saved.port), "--bind", "127.0.0.1"];
    const child = (this.o.spawn ?? ((c, a, opts) => spawn(c, a, { ...opts, stdio: "ignore", detached: false })))(command, args, { env: { ...process.env, ...saved.env, MESH_PORT: String(saved.port), MESH_BIND: "127.0.0.1" }, cwd: this.dir(id) });
    this.children.set(id, child);
    child.once("exit", () => {
      if (this.children.get(id) === child) this.children.delete(id);
    });
    return { handle: id, upstream: { host: "127.0.0.1", port: saved.port } };
  }

  async suspend(handle: string): Promise<void> {
    const child = this.children.get(handle);
    if (!child) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
    });
  }

  async resume(handle: string): Promise<ProvisionedWorkspace> {
    if (this.o.production) throw new ProvisionError("the local-process provisioner will not run in production");
    if (!fs.existsSync(this.secretsFile(handle))) throw new ProvisionError(`there is no workspace '${handle}' to resume`);
    if (this.children.has(handle)) return { handle, upstream: { host: "127.0.0.1", port: (JSON.parse(fs.readFileSync(this.secretsFile(handle), "utf8")) as Saved).port } };
    return this.start(handle);
  }

  async destroy(handle: string, options: { keepData?: boolean } = {}): Promise<void> {
    await this.suspend(handle);
    const dir = this.dir(handle);
    if (options.keepData) fs.rmSync(path.join(dir, ".provision"), { recursive: true, force: true });
    else fs.rmSync(dir, { recursive: true, force: true });
  }

  async status(handle: string): Promise<WorkspaceRuntimeStatus> {
    if (this.children.has(handle)) return "running";
    return fs.existsSync(this.secretsFile(handle)) ? "stopped" : "missing";
  }
}
