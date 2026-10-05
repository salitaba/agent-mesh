/**
 * The provisioner: the one thing that starts, stops and removes a customer's host.
 *
 * A workspace is an ordinary Curule host with its own state, projects and event log. A provisioner creates one for a workspace
 * spec, stops it when the account stops paying, starts it again, and removes it with its data. Two implementations sit behind
 * the interface: a local process, for development and for a single customer on a machine they own, and a container, for the
 * service. A stronger boundary (a microVM per workspace) fits behind the same interface.
 *
 * The local-process provisioner refuses to run when the service is configured as production. An agent's shell is only as
 * isolated as its process, and that is not isolation between customers.
 */

export interface WorkspaceSpec {
  workspaceId: string;
  accountId: string;
  /** The DNS label the workspace is served under. */
  slug: string;
  plan: string;
  /** The signed licence the host runs with, or none (the host then runs with the Community plan's limits). */
  licence?: string;
  /** The credential the proxy presents to the host. Known to the control plane and the proxy, never to the browser. */
  operatorToken: string;
  gateway: {
    /** Where the workspace reaches the gateway, up to and including `/v1`. */
    baseUrl: string;
    /** The virtual key. */
    key: string;
  };
  limits: { cpus: number; memoryMb: number; pids: number };
  /** Extra environment for the host, such as an egress proxy. Never holds a provider's key. */
  env?: Record<string, string>;
}

export interface ProvisionedWorkspace {
  /** What the provisioner calls it (a container name, a process id). Opaque to everyone else. */
  handle: string;
  /** Where the proxy reaches the host. */
  upstream: { host: string; port: number };
}

export type WorkspaceRuntimeStatus = "running" | "stopped" | "missing";

export interface Provisioner {
  readonly kind: string;
  /** Create the host and start it. Resolves when it has been started, not when it is ready. */
  create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace>;
  /** Stop it, keeping its data. */
  suspend(handle: string): Promise<void>;
  /** Start a stopped host again. Its address may have changed. */
  resume(handle: string): Promise<ProvisionedWorkspace>;
  /** Remove it and, unless told otherwise, its data. */
  destroy(handle: string, options?: { keepData?: boolean }): Promise<void>;
  status(handle: string): Promise<WorkspaceRuntimeStatus>;
}

export class ProvisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvisionError";
  }
}

/** Wait for a host to answer its health check, or throw. `fetch` is injectable for tests. */
export async function waitUntilReady(upstream: { host: string; port: number }, options: { timeoutMs?: number; intervalMs?: number; fetch?: typeof fetch } = {}): Promise<void> {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const end = Date.now() + (options.timeoutMs ?? 60_000);
  let last = "no answer yet";
  while (Date.now() < end) {
    try {
      const res = await doFetch(`http://${upstream.host}:${upstream.port}/healthz`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) return;
      last = `status ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 500));
  }
  throw new ProvisionError(`the workspace did not become ready: ${last}`);
}
