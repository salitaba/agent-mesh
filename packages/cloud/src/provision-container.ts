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
  /**
   * Give each workspace a fixed address of its own on the network, and reach it there. Without this a workspace is reached by its
   * container's name, which only a process on the same network can resolve (the engine's name server is not reachable from the host).
   * A control plane that runs on the host, and not in a container on the network, needs this.
   */
  addresses?: ContainerAddresses;
}

/** The addresses a workspace may be given: a subnet the network was made with, and which host numbers in it are for workspaces. */
export interface ContainerAddresses {
  /** The network's IPv4 subnet, as the engine was told it: `10.213.0.0/24`. A prefix from /16 to /29. */
  subnet: string;
  /** The first and the last host number a workspace may be given (the 10 in 10.213.0.10). Default: 10, and the last usable address. */
  first?: number;
  last?: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** What a network is called when its name goes into the engine's template language: nothing that could end the template or start another. */
const NETWORK_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const toNumber = (address: string): number | undefined => {
  const m = IPV4.exec(address);
  if (!m) return undefined;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  return parts.every((p) => p <= 255) ? ((parts[0]! * 256 + parts[1]!) * 256 + parts[2]!) * 256 + parts[3]! : undefined;
};
const toAddress = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** The numbers a workspace may be given, as addresses, in order. Throws what is wrong with the subnet or the range. */
export function workspaceAddresses(a: ContainerAddresses): string[] {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(a.subnet);
  const base = m ? toNumber(m[1]!) : undefined;
  const bits = m ? Number(m[2]) : Number.NaN;
  if (base === undefined || !Number.isInteger(bits) || bits < 16 || bits > 29) throw new ProvisionError(`'${a.subnet}' is not an IPv4 subnet from /16 to /29, like 10.213.0.0/24`);
  const size = 2 ** (32 - bits);
  if (base % size !== 0) throw new ProvisionError(`'${a.subnet}' is not the start of a /${bits}: did you mean ${toAddress(base - (base % size))}/${bits}?`);
  const last = a.last ?? size - 2;
  const first = a.first ?? Math.min(10, last);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 2 || last > size - 2 || first > last) throw new ProvisionError(`the workspaces' addresses must run from 2 to ${size - 2} in ${a.subnet}, with the first not after the last (got ${String(a.first)} to ${String(a.last)})`);
  return Array.from({ length: last - first + 1 }, (_, i) => toAddress(base + first + i));
}

export class ContainerProvisioner implements Provisioner {
  readonly kind = "container";
  private readonly engine: string;
  private readonly port: number;
  private readonly prefix: string;
  private readonly pool: string[] | undefined;
  /** Allocations are made one at a time: two that read the same free address would both ask for it. */
  private allocating: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: ContainerProvisionerOptions) {
    this.engine = o.engine ?? "docker";
    this.port = o.port ?? 7420;
    this.prefix = o.namePrefix ?? "curule-ws-";
    if (o.addresses) {
      if (!NETWORK_NAME.test(o.network)) throw new ProvisionError(`the network '${o.network}' cannot be looked up by its addresses: a name is letters, digits and . _ -`);
      this.pool = workspaceAddresses(o.addresses);
    }
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

  /** The `run` arguments for a workspace: every restriction, and no secret. Exposed so a test can read exactly what is asked. `address` is the fixed address the workspace is given, when the operator has said which are for workspaces. */
  runArguments(spec: WorkspaceSpec, address?: string): { args: string[]; env: Record<string, string> } {
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
      ...(address !== undefined ? ["--ip", address] : []),
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

  /** Run `work` after every allocation that was asked for before it has finished, and whatever happened to those. */
  private alone<T>(work: () => Promise<T>): Promise<T> {
    const turn = this.allocating.then(work, work);
    this.allocating = turn.catch(() => undefined);
    return turn;
  }

  /**
   * The addresses that workspaces' containers hold on the network, running or stopped: a stopped container keeps the address it was made
   * with, and gives it up only when it is removed. `inspect` answers once for every container it finds, and an empty line for one that has none.
   */
  private async takenAddresses(): Promise<Set<string>> {
    const listed = await this.engineRun(["ps", "--all", "--filter", "label=curule.workspace", "--format", "{{.Names}}"]);
    const names = listed.stdout.split("\n").map((n) => n.trim()).filter((n) => n.startsWith(this.prefix) && ID.test(n));
    if (names.length === 0) return new Set();
    // A container that was removed since it was listed is not a failure: its address is free.
    const found = await this.engineRun(["inspect", "--format", `{{with index .NetworkSettings.Networks "${this.o.network}"}}{{with .IPAMConfig}}{{.IPv4Address}}{{end}}{{end}}`, ...names], undefined, /No such (container|object)/i);
    return new Set(found.stdout.split("\n").map((a) => a.trim()).filter((a) => a !== ""));
  }

  /** The address a started workspace's container has on the network. */
  private async addressOf(name: string): Promise<string> {
    const res = await this.engineRun(["inspect", "--format", `{{with index .NetworkSettings.Networks "${this.o.network}"}}{{.IPAddress}}{{end}}`, name]);
    const address = res.stdout.trim();
    if (toNumber(address) === undefined) throw new ProvisionError(`${name} has no address on the network ${this.o.network}`);
    return address;
  }

  async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    const name = this.nameOf(spec.workspaceId);
    // What the engine could not be asked for is refused before anything is run.
    const plain = this.runArguments(spec);
    await this.engineRun(["volume", "create", "--label", `curule.workspace=${spec.workspaceId}`, name]);
    let asked = false;
    try {
      const pool = this.pool;
      if (!pool) {
        asked = true;
        await this.engineRun(plain.args, plain.env);
        return { handle: name, upstream: { host: name, port: this.port } };
      }
      const address = await this.alone(async () => {
        const taken = await this.takenAddresses();
        const free = pool.find((a) => !taken.has(a));
        if (free === undefined) throw new ProvisionError(`no address is left for a workspace: ${pool.length} are for workspaces in ${this.o.addresses!.subnet}, and all are in use`);
        const { args, env } = this.runArguments(spec, free);
        asked = true;
        await this.engineRun(args, env);
        return free;
      });
      return { handle: name, upstream: { host: address, port: this.port } };
    } catch (err) {
      // A container that was made and did not start is still there, in the state "created", and holds its address: it goes first, and then
      // the volume made for it, which is not worth keeping either.
      if (asked) await this.engineRun(["rm", "--force", name], undefined, /No such (container|object)/i).catch(() => undefined);
      await this.engineRun(["volume", "rm", "--force", name]).catch(() => undefined);
      throw err;
    }
  }

  async suspend(handle: string): Promise<void> {
    await this.engineRun(["stop", handle], undefined, /No such (container|object)/i);
  }

  async resume(handle: string): Promise<ProvisionedWorkspace> {
    await this.engineRun(["start", handle]);
    return { handle, upstream: { host: this.pool ? await this.addressOf(handle) : handle, port: this.port } };
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
