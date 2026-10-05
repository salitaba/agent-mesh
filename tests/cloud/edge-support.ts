import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { WorkspaceEdge, createPublicServer, type EdgeLog, type EdgeOptions } from "../../packages/cloud/src/index";
import { ask, listen, type Ask } from "./net-support";
import { running, type PlaneOptions } from "./support";
import { APP, site } from "./web-support";

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export type HostBehaviour = (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void | Promise<void>;

/** Poll until something is so. A test waits for what it is told will happen; it does not guess how long that takes. */
export async function waitFor(what: string, condition: () => boolean, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > until) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A workspace's host as the edge sees it: a server that records what it was asked, answers as the test says, and notes when a caller went away. */
export async function fakeHost(initial?: HostBehaviour) {
  const requests: Seen[] = [];
  const abandoned: string[] = [];
  let behaviour = initial;
  const server = http.createServer((req, res) => {
    res.on("close", () => {
      if (!res.writableFinished) abandoned.push(req.url ?? "");
    });
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const seen: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(seen);
      Promise.resolve((behaviour ?? ((_req, r) => { r.writeHead(200, { "content-type": "application/json" }); r.end(JSON.stringify({ ok: true })); }))(req, res, seen)).catch(() => res.destroy());
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    requests,
    abandoned,
    behave(next: HostBehaviour): void {
      behaviour = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export interface Fixture extends Awaited<ReturnType<typeof running>> {
  s: ReturnType<typeof site>;
  host: Awaited<ReturnType<typeof fakeHost>>;
  edge: WorkspaceEdge;
  /** The address the workspace is served at. */
  name: string;
  port: number;
  logs: EdgeLog[];
  grant: { accountId: string; workspaceId: string; sessionId: string };
  /** Open the workspace as its owner does, and return the cookie a browser then holds for it. */
  cookie(): Promise<string>;
  get(path: string, extra?: Partial<Ask>): Promise<Awaited<ReturnType<typeof ask>>>;
  close(): Promise<void>;
}

/** An account with a running workspace whose host is a fake one, behind the edge, behind the public server. */
export async function fixture(options: { edge?: Partial<EdgeOptions>; plane?: PlaneOptions; behaviour?: HostBehaviour; trustProxyHops?: number } = {}): Promise<Fixture> {
  const host = await fakeHost(options.behaviour);
  const r = await running(options.plane);
  Object.assign(r.workspace(), { upstream: { host: "127.0.0.1", port: host.port } });
  const s = site(r.p);
  const logs: EdgeLog[] = [];
  const edge = new WorkspaceEdge({ plane: r.p.plane, access: s.access, appUrl: APP, log: (l) => logs.push(l), ...options.edge });
  const server = createPublicServer({ web: s.web, edge, appHost: "app.example.com", workspaceDomain: "ws.example.com", ...(options.trustProxyHops ? { trustProxyHops: options.trustProxyHops } : {}) });
  const l = await listen(server);
  const name = r.p.plane.view(r.p.log.state.accounts.get(r.ada.accountId)!).workspaces[0]!.host;
  const grant = { accountId: r.ada.accountId, workspaceId: r.workspaceId, sessionId: r.p.plane.accounts.identify(r.ada.sessionToken)!.sessionId };
  const f: Fixture = {
    ...r,
    s,
    host,
    edge,
    name,
    port: l.port,
    logs,
    grant,
    async cookie() {
      const code = s.access.issueCode(grant);
      const entered = await ask(l.port, { host: name, path: `/__enter?code=${encodeURIComponent(code)}` });
      const set = entered.headers["set-cookie"];
      if (entered.status !== 302 || !set?.[0]) throw new Error(`could not open the workspace: ${entered.status} ${entered.body}`);
      return set[0].split(";")[0]!;
    },
    get(path, extra = {}) {
      return ask(l.port, { host: name, path, ...extra });
    },
    async close() {
      await l.close();
      await host.close();
    },
  };
  return f;
}

/** A request whose response is read as it arrives. Resolves at the response's headers. */
export function open(port: number, a: Ask): Promise<{ req: http.ClientRequest; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: a.method ?? "GET", path: a.path ?? "/", headers: { ...(a.host ? { host: a.host } : {}), ...a.headers }, agent: false }, (res) => resolve({ req, res }));
    req.on("error", reject);
    req.end();
  });
}

/** The next chunk of a response, as text. */
export function nextChunk(res: http.IncomingMessage, ms = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no data arrived")), ms);
    res.once("data", (c: Buffer) => {
      clearTimeout(timer);
      resolve(c.toString("utf8"));
    });
  });
}
