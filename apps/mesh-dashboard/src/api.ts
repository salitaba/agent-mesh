/* HTTP client: timeouts, one server-down notice, JSON tolerance. */

import { projectPath } from "./route";

export interface ApiResult {
  status: number;
  json: any;
  timeout?: boolean;
}

export interface ApiOptions {
  timeoutMs?: number;
  /** Routes the call through `/api/p/:id`. Omitted = a host-level call
   *  (`/api/projects`) or a legacy bare path the host resolves itself.
   *  Deliberately explicit: a module-level "current project" would let a
   *  background provider's poll or an open drawer's POST land on whichever
   *  project happened to render last. */
  projectId?: string | null;
}

let down = false;
const downListeners = new Set<(isDown: boolean) => void>();

export function onServerDownChange(fn: (isDown: boolean) => void): () => void {
  downListeners.add(fn);
  return () => downListeners.delete(fn);
}

function setDown(isDown: boolean, path: string, notify: (t: string, m: string, k: string) => void): void {
  if (isDown && !down) {
    down = true;
    downListeners.forEach((fn) => fn(true));
    notify("server not responding", `${path} timed out — is the mesh process still running?`, "bad");
  } else if (!isDown && down) {
    down = false;
    downListeners.forEach((fn) => fn(false));
  }
}

// Only liveness probes decide the global "server not responding" banner. A
// slow heavy view (agent detail, turn trace, replay on a big log) timing out
// must not paint the whole console as down when the server is actually fine.
const LIVENESS_PATHS = ["/health", "/status"];

function isLiveness(path: string): boolean {
  const bare = path.split("?")[0];
  return LIVENESS_PATHS.some((p) => bare === p || bare.startsWith(`${p}/`));
}

// Wired by the store (avoids a React import here).
let notifier: (t: string, m: string, k: string) => void = () => undefined;
export function setApiNotifier(fn: (t: string, m: string, k: string) => void): void {
  notifier = fn;
}

export async function api(method: string, path: string, body?: unknown, opts: ApiOptions = {}): Promise<ApiResult> {
  // The bare path is what decides liveness and what the operator sees in a
  // notice — `/api/p/acme/status timed out` is noise, `/status` is the fact.
  const url = projectPath(opts.projectId, path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") {
      if (isLiveness(path)) {
        setDown(true, path, notifier);
      } else {
        notifier("request timed out", `${path} took too long — the server may be busy; try again`, "warn");
      }
      return { status: 0, json: null, timeout: true };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  if (isLiveness(path)) setDown(false, path, notifier);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-json */
  }
  if (!res.ok && res.status >= 500) notifier("server error", `${path} -> ${res.status}`, "bad");
  return { status: res.status, json };
}

export const post = (path: string, body?: unknown, opts: ApiOptions = {}): Promise<ApiResult> => api("POST", path, body ?? {}, opts);

/** Returns null when the body could not be fetched. It used to return "" on
 *  failure, which made a dead server indistinguishable from a genuinely empty
 *  file — the caller then rendered a blank viewer as if that were the content. */
export const getText = async (path: string, opts: ApiOptions = {}): Promise<string | null> => {
  try {
    const res = await fetch(projectPath(opts.projectId, path));
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
};

/**
 * The same three calls with a project already bound. Components take this off
 * `useMesh()` instead of threading an id through every call, and a non-component
 * helper takes it as one parameter rather than reaching for a global.
 */
export interface ProjectClient {
  api: (method: string, path: string, body?: unknown, opts?: ApiOptions) => Promise<ApiResult>;
  post: (path: string, body?: unknown, opts?: ApiOptions) => Promise<ApiResult>;
  getText: (path: string, opts?: ApiOptions) => Promise<string | null>;
}

export function clientFor(projectId: string | null): ProjectClient {
  return {
    api: (method, path, body, opts = {}) => api(method, path, body, { ...opts, projectId }),
    post: (path, body, opts = {}) => post(path, body, { ...opts, projectId }),
    getText: (path, opts = {}) => getText(path, { ...opts, projectId }),
  };
}
