/**
 * The container provisioner: one container per workspace, started with the restrictions that make it a boundary.
 *
 * The command is built here and run by an injected runner, so what it asks the container engine to do can be read and tested
 * without an engine. Three things are decided in this file because they are what keeps one customer from another and from the
 * service:
 *
 *   - Secrets are passed by name (`-e NAME`), and their values go in the environment of the command that is run, never in its
 *     arguments, which any process on the machine can read.
 *   - The container runs as an unprivileged user with every capability dropped, a read-only root, no new privileges, and
 *     memory, CPU and process limits. Its only writable places are its state volume and a temporary directory.
 *   - It joins one named network and nothing else. That network is the operator's to make: with no route out except through
 *     an egress proxy that allows the gateway, the package registries and git hosts, and with no route to the control plane or
 *     to other workspaces' containers. This file points a workspace at that network and at its proxy; it cannot build the
 *     network, and docs/cloud-control-plane.md says what it must look like.
 */
import { spawn } from "node:child_process";
import { ProvisionError, type ProvisionedWorkspace, type Provisioner, type WorkspaceRuntimeStatus, type WorkspaceSpec } from "./provisioner";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Run a command. `env` is added to the environment of that command and of nothing else. */
  run(command: string, args: string[], options?: { env?: Record<string, string> }): Promise<CommandResult>;
}

/** The real runner: a child process with a bounded wait. */
export class ProcessRunner implements CommandRunner {
  constructor(private readonly timeoutMs = 120_000) {}

  run(command: string, args: string[], options: { env?: Record<string, string> } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
      const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new ProvisionError(`could not run ${command}: ${err.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}

export interface ContainerProvisionerOptions {
  runner: CommandRunner;
  /** `docker` or `podman`. */
  engine?: string;
  /** The Curule image. */
  image: string;
  /** The network workspaces join: internal, with its egress proxy. */
  network: string;
  /** The port the host listens on inside the container. */
  port?: number;
  /** Names are `<namePrefix><workspaceId>`. */
  namePrefix?: string;
  /** The user the container runs as. Default 10001, the image's own. */
  uid?: number;
  /** An egress proxy on the workspace network, as a URL. Sets HTTP(S)_PROXY and tells Node to use it. */
  egressProxy?: string;
  /** Hosts that must not go through the proxy (the gateway, the host itself). */
  noProxy?: string[];
  /** How long to wait for the engine to stop a container before killing it, in seconds. */
  stopTimeoutSeconds?: number;
  /** The domain the workspaces are served under, for the host's allowed-host check. */
  apexDomain?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export class ContainerProvisioner implements Provisioner {
  readonly kind = "container";
  private readonly engine: string;
  private readonly port: number;
  private readonly prefix: string;

  constructor(private readonly o: ContainerProvisionerOptions) {
    this.engine = o.engine ?? "docker";
    this.port = o.port ?? 7420;
    this.prefix = o.namePrefix ?? "curule-ws-";
  }

  private nameOf(workspaceId: string): string {
    if (!ID.test(workspaceId)) throw new ProvisionError(`'${workspaceId}' is not a workspace id the container engine can name`);
    return `${this.prefix}${workspaceId}`;
  }

  private async engineRun(args: string[], env?: Record<string, string>, tolerate: RegExp | null = null): Promise<CommandResult> {
    const res = await this.o.runner.run(this.engine, args, env ? { env } : undefined);
    if (res.code !== 0 && !(tolerate && tolerate.test(res.stderr))) {
      throw new ProvisionError(`${this.engine} ${args[0]} failed (${res.code}): ${res.stderr.trim().slice(0, 300) || "no message"}`);
    }
    return res;
  }

  /** The `run` arguments for a workspace: every restriction, and no secret. Exposed so a test can read exactly what is asked. */
  runArguments(spec: WorkspaceSpec): { args: string[]; env: Record<string, string> } {
    const name = this.nameOf(spec.workspaceId);
    const l = spec.limits;
    if (!(l.cpus > 0) || !(l.memoryMb >= 128) || !(l.pids >= 32)) throw new ProvisionError("a workspace needs at least 0.1 of a CPU, 128 MB of memory and 32 processes");
    // The operator's own additions come first: they cannot replace the credentials this workspace was made with.
    const env: Record<string, string> = {
      ...spec.env,
      MESH_API_TOKEN: spec.operatorToken,
      CURULE_GATEWAY_KEY: spec.gateway.key,
      ...(spec.licence ? { MESH_LICENSE: spec.licence } : {}),
    };
    const plain: string[] = [
      `MESH_PORT=${this.port}`,
      "MESH_BIND=0.0.0.0",
      "MESH_TRUST_PROXY=1",
      "MESH_COOKIE_SECURE=1",
      "MESH_LICENSE_ENFORCEMENT=enforce",
      `CURULE_GATEWAY_URL=${spec.gateway.baseUrl}`,
      ...(this.o.apexDomain ? [`MESH_ALLOWED_HOSTS=${spec.slug}.${this.o.apexDomain}`, `MESH_ALLOWED_ORIGINS=https://${spec.slug}.${this.o.apexDomain}`] : []),
    ];
    if (this.o.egressProxy) {
      const noProxy = [...(this.o.noProxy ?? []), "localhost", "127.0.0.1"].join(",");
      plain.push(`HTTP_PROXY=${this.o.egressProxy}`, `HTTPS_PROXY=${this.o.egressProxy}`, `http_proxy=${this.o.egressProxy}`, `https_proxy=${this.o.egressProxy}`, `NO_PROXY=${noProxy}`, `no_proxy=${noProxy}`, "NODE_USE_ENV_PROXY=1");
    }
    const args = [
      "run",
      "--detach",
      "--name",
      name,
      "--hostname",
      name,
      "--network",
      this.o.network,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,size=512m",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${this.o.uid ?? 10001}:${this.o.uid ?? 10001}`,
      "--pids-limit",
      String(l.pids),
      "--memory",
      `${l.memoryMb}m`,
      "--memory-swap",
      `${l.memoryMb}m`,
      "--cpus",
      String(l.cpus),
      "--stop-timeout",
      String(this.o.stopTimeoutSeconds ?? 20),
      "--restart",
      "unless-stopped",
      "--volume",
      `${name}:/data`,
      "--label",
      `curule.workspace=${spec.workspaceId}`,
      "--label",
      `curule.account=${spec.accountId}`,
      ...plain.flatMap((p) => ["--env", p]),
      ...Object.keys(env).flatMap((k) => ["--env", k]),
      this.o.image,
      "host",
    ];
    return { args, env };
  }

  async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    const name = this.nameOf(spec.workspaceId);
    const { args, env } = this.runArguments(spec);
    await this.engineRun(["volume", "create", "--label", `curule.workspace=${spec.workspaceId}`, name]);
    try {
      await this.engineRun(args, env);
    } catch (err) {
      // A volume made for a container that never started is not worth keeping.
      await this.engineRun(["volume", "rm", "--force", name]).catch(() => undefined);
      throw err;
    }
    return { handle: name, upstream: { host: name, port: this.port } };
  }

  async suspend(handle: string): Promise<void> {
    await this.engineRun(["stop", handle], undefined, /No such (container|object)/i);
  }

  async resume(handle: string): Promise<ProvisionedWorkspace> {
    await this.engineRun(["start", handle]);
    return { handle, upstream: { host: handle, port: this.port } };
  }

  async destroy(handle: string, options: { keepData?: boolean } = {}): Promise<void> {
    await this.engineRun(["rm", "--force", handle], undefined, /No such (container|object)/i);
    if (!options.keepData) await this.engineRun(["volume", "rm", "--force", handle], undefined, /No such volume/i);
  }

  async status(handle: string): Promise<WorkspaceRuntimeStatus> {
    const res = await this.o.runner.run(this.engine, ["inspect", "--format", "{{.State.Running}}", handle]);
    if (res.code !== 0) {
      if (/No such (container|object)/i.test(res.stderr)) return "missing";
      throw new ProvisionError(`${this.engine} inspect failed: ${res.stderr.trim().slice(0, 200)}`);
    }
    return res.stdout.trim() === "true" ? "running" : "stopped";
  }
}
