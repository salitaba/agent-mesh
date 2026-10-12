/**
 * The way out of a workspace: the egress proxy, and why the model port does not rely on Node's own
 * environment-proxy support.
 *
 * A workspace container resolves nothing itself — the egress proxy is the only way out, and a call that skips it dies
 * with `getaddrinfo EAI_AGAIN ai.alitaba.me`. Node's `NODE_USE_ENV_PROXY` (which this deployment sets, and which the
 * container's own environment carries) covers that for a plain process in the same container: measured,
 * `node -e 'fetch("https://ai.alitaba.me/v1/models", …)'` answers 200. The mesh's own model call does not, and fails
 * with that same EAI_AGAIN — measured against the live workspace, where the egress proxy logged no tunnel for it at all.
 * Whatever the reason Node's support does not reach this process, nothing here should depend on it.
 *
 * So when the environment names a proxy, the global dispatcher is an `EnvHttpProxyAgent` from the undici package and the
 * call goes through undici's fetch. Measured in the live container: undici's fetch behind that dispatcher answers 200
 * where the platform fetch answers EAI_AGAIN, and undici's fetch with the *dispatcher passed per call* fails with
 * `invalid onRequestStart method` (the package's dispatcher and the platform's fetch are different undici copies), which
 * is why this installs a dispatcher instead of passing one.
 *
 * `setGlobalDispatcher` is process-wide on purpose: the WebFetch tool (`runtime-native/src/tools/web.ts`) calls the same
 * undici fetch, so one install covers the model call and the tool — both verified against the live host at 200.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher, type Dispatcher } from "undici";

/** The proxy the environment names, if any. A workspace has `http_proxy`/`https_proxy` pointing at the egress proxy. */
export function proxyFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

let installed: Dispatcher | undefined;

/**
 * Installs the proxy dispatcher, once per process. Returns whether the process is proxied afterwards: false when the
 * environment names no proxy, in which case nothing is touched.
 */
export function installProxyDispatcher(env: NodeJS.ProcessEnv = process.env): boolean {
  if (proxyFromEnv(env) === undefined) return false;
  if (installed === undefined) {
    installed = new EnvHttpProxyAgent();
    setGlobalDispatcher(installed);
  }
  return true;
}

/**
 * The fetch the model port calls a provider with. With a proxy in the environment it is undici's fetch behind an
 * `EnvHttpProxyAgent`; without one it is the platform's own fetch, exactly as before.
 */
export function providerFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch {
  if (!installProxyDispatcher(env)) return (input, init) => fetch(input, init);
  return ((input: Parameters<typeof undiciFetch>[0], init?: Parameters<typeof undiciFetch>[1]) =>
    undiciFetch(input, init)) as unknown as typeof fetch;
}

/** For tests: forget that this process ever installed one. */
export function resetProxyDispatcher(): void {
  installed = undefined;
}
