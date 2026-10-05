import { ControlWeb, WorkspaceAccess, type WebLog, type WebOptions } from "../../packages/cloud/src/index";
import { linkIn, SECRET, type Plane } from "./support";

export const APP = "https://app.example.com";
export const PASSWORD = "correct horse battery staple";
export const HOUR = 3_600_000;
export const MINUTE = 60_000;
export const DAY = 86_400_000;

export interface Call {
  /** A JSON body, sent as `application/json`. */
  json?: unknown;
  /** A body as it is, with the content type named in `type` or none. */
  raw?: string;
  type?: string;
  /** A session token, sent as the cookie the service sets. */
  session?: string;
  /** The Origin a browser sends on a POST. Default: the app's own. `null` sends none, as a script would. */
  origin?: string | null;
  /** The caller's address. */
  ip?: string;
  headers?: Record<string, string | string[]>;
}

export interface Reply {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  /** The body read as JSON, when it is an object. */
  json: any;
}

/** The control API over a plane, called as the server would call it, with the logs it wrote. */
export function site(p: Plane, options: Partial<WebOptions> = {}) {
  const logs: WebLog[] = [];
  const access = new WorkspaceAccess({ secret: SECRET, clock: () => new Date(p.clock.now) });
  const web = new ControlWeb({ plane: p.plane, access, appUrl: APP, clock: () => new Date(p.clock.now), log: (r) => logs.push(r), ...options });
  const own = new URL(options.appUrl ?? APP).origin;
  async function call(method: string, path: string, init: Call = {}): Promise<Reply> {
    const headers: Record<string, string | string[]> = {};
    let body = Buffer.alloc(0);
    if (init.json !== undefined) {
      body = Buffer.from(JSON.stringify(init.json));
      headers["content-type"] = "application/json";
    }
    if (init.raw !== undefined) body = Buffer.from(init.raw);
    if (init.type !== undefined) headers["content-type"] = init.type;
    if (init.session !== undefined) headers.cookie = `${web.sessionCookieName}=${init.session}`;
    if (method !== "GET" && init.origin !== null) headers.origin = init.origin ?? own;
    Object.assign(headers, init.headers);
    const q = path.indexOf("?");
    const res = await web.handle({ method, path: q < 0 ? path : path.slice(0, q), query: new URLSearchParams(q < 0 ? "" : path.slice(q + 1)), headers, body, ip: init.ip ?? "203.0.113.7" });
    const text = typeof res.body === "string" ? res.body : res.body.toString("utf8");
    return { status: res.status, headers: res.headers, body: text, json: text.startsWith("{") ? JSON.parse(text) : undefined };
  }
  return { web, access, logs, call };
}

export type Site = ReturnType<typeof site>;

/** The one cookie a reply sets, taken apart. */
export function cookieSet(r: Reply): { name: string; value: string; attrs: string[] } {
  const raw = r.headers["set-cookie"];
  if (typeof raw !== "string") throw new Error(`expected one cookie, got ${JSON.stringify(raw)}`);
  const [pair, ...attrs] = raw.split("; ");
  const eq = pair!.indexOf("=");
  return { name: pair!.slice(0, eq), value: pair!.slice(eq + 1), attrs };
}

/** The token in the link of a mail. */
export const tokenIn = (text: string): string => new URL(linkIn(text)).searchParams.get("token")!;
