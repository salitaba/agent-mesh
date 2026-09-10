/* HTTP client: timeouts, one server-down notice, JSON tolerance. */

export interface ApiResult {
  status: number;
  json: any;
  timeout?: boolean;
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

export async function api(method: string, path: string, body?: unknown, opts: { timeoutMs?: number } = {}): Promise<ApiResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  let res: Response;
  try {
    res = await fetch(path, {
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

export const post = (path: string, body?: unknown): Promise<ApiResult> => api("POST", path, body ?? {});

/** Returns null when the body could not be fetched. It used to return "" on
 *  failure, which made a dead server indistinguishable from a genuinely empty
 *  file — the caller then rendered a blank viewer as if that were the content. */
export const getText = async (path: string): Promise<string | null> => {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
};
