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
  /** Where the workspace's models come from: the service's gateway with a virtual key, or none when the customer brings their own key (see `model`). */
  gateway?: {
    /** Where the workspace reaches the gateway, up to and including `/v1`. */
    baseUrl: string;
    /** The virtual key. */
    key: string;
  };
  /**
   * The customer's own model-provider key, for a plan that sells hosting only. It is given to the host in its environment and, like
   * the gateway's key, is kept out of every seat's shell. The service resells nothing through it.
   */
  model?: {
    provider: "anthropic" | "openai-compatible";
    /** The model teams run on, as the provider names it. */
    name: string;
    baseUrl?: string;
    key: string;
  };
  limits: { cpus: number; memoryMb: number; pids: number };
  /** Extra environment for the host, such as an egress proxy. Never holds a provider's key: a key goes in `gateway` or `model`. */
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

/**
 * What a host is told about its models, as environment: names and values, in one place for both provisioners. The variables that hold a
 * key are in `secret`, so a provisioner can keep their values out of a command's arguments; the rest are in `plain`.
 */
export function modelEnvironment(spec: WorkspaceSpec): { plain: Record<string, string>; secret: Record<string, string> } {
  if (spec.gateway) return { plain: { CURULE_GATEWAY_URL: spec.gateway.baseUrl }, secret: { CURULE_GATEWAY_KEY: spec.gateway.key } };
  if (spec.model) {
    return {
      plain: { CURULE_MODEL_PROVIDER: spec.model.provider, CURULE_MODEL_NAME: spec.model.name, ...(spec.model.baseUrl ? { CURULE_MODEL_BASE_URL: spec.model.baseUrl } : {}) },
      secret: { CURULE_MODEL_KEY: spec.model.key },
    };
  }
  return { plain: {}, secret: {} };
}
