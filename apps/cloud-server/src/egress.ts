/**
 * `curule-cloud egress`: the one way out of a workspace's network.
 *
 * A workspace's container sits on an internal network with no route out of its own, and is told to send everything it sends out of
 * it to this proxy (`HTTPS_PROXY`). The proxy decides, by the name the workspace asks for, whether the connection is made at all.
 * What it allows is a list the operator writes (the package registries and the git hosts that agents need), and nothing else:
 *
 *   - Only `CONNECT`, which is how HTTPS is tunnelled. A plain `http://` request is refused, so nothing is read or changed in
 *     passing, and nothing travels in the clear.
 *   - Only a name that is on the list, and only on a port that is. A name is matched as written (`github.com`), or as a family
 *     (`*.github.com`, which is every name below it and not `github.com` itself). An address given as digits is never allowed:
 *     the list is of names, and an address is a way around it.
 *   - The proxy looks the name up itself, and refuses it when ANY address it gets is not a public one (loopback, private, shared,
 *     link-local, the cloud metadata address, multicast, and the ranges that embed another address). A name on the list that
 *     points at the machine's own services is the same attack as a name that is not. It then connects to the address it checked,
 *     not to the name again, so the answer cannot change between the check and the connection.
 *   - Only from where the operator says (`allow_from`), whatever the address it listens on: a proxy that is reachable from the
 *     wrong network is an open one.
 *   - Not without limit: connections in all and from each source, a time to connect, a time without a byte, and a longest life.
 *
 * It sees the name and the port of each tunnel and never what goes through it. What it writes down is that: when, who asked (the
 * workspace's address), for which name and port, and what it did.
 */
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { parse as parseYaml } from "yaml";

export interface EgressLogRecord {
  level: "info" | "warn";
  msg: string;
  [field: string]: unknown;
}

/** One entry of the list: a name as written, or every name below one. */
export interface HostRule {
  kind: "exact" | "below";
  name: string;
}

export interface EgressConfig {
  listen: { host: string; port: number };
  /** Where a connection may come from, as the networks the operator named. */
  allowFrom: string[];
  /** The ports a tunnel may be made to. */
  ports: number[];
  hosts: HostRule[];
  limits: { maxConnections: number; perSource: number; connectMs: number; idleMs: number; lifeMs: number };
  warnings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
/** The last label of a name starts with a letter, as every top-level domain does: that is what keeps `10.0.0.5`, `0x7f.1` and `1.2.3.4.5`, which a resolver reads as addresses, from being names. */
const TLD = "[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?";
const NAME = new RegExp(`^(?:${LABEL}\\.)+${TLD}$`);

// ---- which addresses are the public internet ----

const special4 = new net.BlockList();
for (const [net4, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  special4.addSubnet(net4, bits, "ipv4");
}
/** Everything that is not global unicast: only 2000::/3 is, and inside it these are for documentation, tunnelling and translation. */
const global6 = new net.BlockList();
global6.addSubnet("2000::", 3, "ipv6");
const special6 = new net.BlockList();
for (const [net6, bits] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
] as const) {
  special6.addSubnet(net6, bits, "ipv6");
}

/** Whether an address is one on the public internet: the only kind a workspace may be sent to. Anything that is not an address is not. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return !special4.check(address, "ipv4");
  if (family === 6) {
    // An IPv4 address written as IPv6 is judged as the address it is, and written so it is not a way past the list above.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^::ffff:/i.test(address)) return false;
    return global6.check(address, "ipv6") && !special6.check(address, "ipv6");
  }
  return false;
}

// ---- the configuration ----

/** `egress.yaml`: read and checked as the other configurations are, every problem at once. */
export function loadEgressConfig(file: string): EgressConfig {
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the egress configuration ${file}: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`${file}: expected a mapping with listen, allow_from, ports and hosts`);
  const problems: string[] = [];
  const warnings: string[] = [];

  const l = isObject(raw.listen) ? raw.listen : undefined;
  let host = "";
  let port = 0;
  if (!l) problems.push("listen must be a mapping with host and port: the address on the workspaces' network that the proxy is reached at");
  else {
    if (typeof l.host !== "string" || net.isIP(l.host) === 0) problems.push(`listen.host must be an address, like 10.213.0.1 (got ${JSON.stringify(l.host)}): the proxy listens on the workspaces' network and on no other`);
    else if (l.host === "0.0.0.0" || l.host === "::") problems.push(`listen.host ${l.host} is every address of the machine, and a proxy there is reachable from every network it is on: name the one address of the workspaces' network`);
    else host = l.host;
    if (typeof l.port !== "number" || !Number.isInteger(l.port) || l.port < 1 || l.port > 65_535) problems.push(`listen.port must be a whole number from 1 to 65535 (got ${JSON.stringify(l.port)})`);
    else port = l.port;
  }

  const allowFrom: string[] = [];
  if (!Array.isArray(raw.allow_from) || raw.allow_from.length === 0) problems.push("allow_from must list the networks a connection may come from, like [10.213.0.0/24]");
  else {
    for (const entry of raw.allow_from) {
      const m = typeof entry === "string" ? /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(entry) : null;
      if (!m || net.isIPv4(m[1]!) === false || Number(m[2]) > 32) problems.push(`allow_from '${String(entry)}' is not an IPv4 network like 10.213.0.0/24`);
      else if (Number(m[2]) < 16) problems.push(`allow_from '${String(entry)}' is larger than a /16: it is the workspaces' network, and nothing wider`);
      else allowFrom.push(entry as string);
    }
  }

  let ports = [443];
  if (raw.ports !== undefined) {
    if (!Array.isArray(raw.ports) || raw.ports.length === 0 || raw.ports.some((p) => typeof p !== "number" || !Number.isInteger(p) || p < 1 || p > 65_535)) problems.push("ports must be a list of port numbers, like [443]");
    else ports = raw.ports as number[];
  }
  if (ports.includes(22) || ports.includes(25)) warnings.push(`ports allows ${ports.filter((p) => p === 22 || p === 25).join(" and ")}: a workspace could send mail or open a shell on any host on the list`);

  const hosts: HostRule[] = [];
  if (!Array.isArray(raw.hosts) || raw.hosts.length === 0) problems.push("hosts must list the names a workspace may reach, like registry.npmjs.org or *.github.com");
  else {
    for (const entry of raw.hosts) {
      const text = typeof entry === "string" ? entry.trim().toLowerCase() : "";
      const wild = text.startsWith("*.");
      const name = wild ? text.slice(2) : text;
      // A name has at least two parts, so `*.com` is not one: a family is never a whole top-level domain. And an address is not a name.
      if (!NAME.test(name)) problems.push(`hosts '${String(entry)}' is not a name like registry.npmjs.org, or a family like *.github.com (no scheme, no port, no path, no address given as digits, and a name has at least two parts)`);
      else hosts.push({ kind: wild ? "below" : "exact", name });
    }
    for (const h of hosts) if (h.kind === "below" && h.name.split(".").length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(h.name.split(".")[0]!)) warnings.push(`hosts *.${h.name} looks like a public suffix, which is every site under it, and not one operator's`);
  }

  const lim = isObject(raw.limits) ? raw.limits : {};
  const whole = (value: unknown, what: string, min: number, max: number, fallback: number): number => {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`limits.${what} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);
      return fallback;
    }
    return value;
  };
  const limits = {
    maxConnections: whole(lim.max_connections, "max_connections", 1, 100_000, 512),
    perSource: whole(lim.per_source, "per_source", 1, 100_000, 64),
    connectMs: whole(lim.connect_seconds, "connect_seconds", 1, 120, 10) * 1000,
    idleMs: whole(lim.idle_seconds, "idle_seconds", 1, 86_400, 300) * 1000,
    lifeMs: whole(lim.life_seconds, "life_seconds", 1, 604_800, 3_600) * 1000,
  };
  if (limits.perSource > limits.maxConnections) problems.push("limits.per_source is more than limits.max_connections: one workspace could use them all");

  if (problems.length > 0) throw new Error(problems.map((p) => `${file}: ${p}`).join("\n"));
  return { listen: { host, port }, allowFrom, ports, hosts, limits, warnings };
}

/** What the proxy would do, for a person to check against what they meant. */
export function describeEgress(c: EgressConfig): string[] {
  return [
    `listening on ${c.listen.host}:${c.listen.port}, for connections from ${c.allowFrom.join(", ")} and no other`,
    `tunnels (CONNECT) to port ${c.ports.join(", ")} only, and only to: ${c.hosts.map((h) => (h.kind === "below" ? `*.${h.name}` : h.name)).join(", ")}`,
    "a name that resolves to an address that is not public is refused, whatever the list says; an address given as digits is never allowed",
    `at most ${c.limits.maxConnections} tunnels, ${c.limits.perSource} from one workspace; ${c.limits.connectMs / 1000}s to connect, ${c.limits.idleMs / 1000}s with no byte, ${c.limits.lifeMs / 1000}s at the most`,
    ...c.warnings.map((w) => `WARNING: ${w}`),
  ];
}

// ---- the proxy ----

export interface EgressOptions {
  log?: (record: EgressLogRecord) => void;
  /** The addresses a name has. For tests; the default is the system's resolver. */
  resolve?: (host: string) => Promise<string[]>;
  /** Whether an address may be connected to. For tests, which have only the machine's own address to connect to; the default is {@link isPublicAddress}. */
  allowAddress?: (address: string) => boolean;
}

export interface RunningEgress {
  server: http.Server;
  host: string;
  port: number;
  /** Tunnels open now. */
  open(): number;
  stop(graceMs?: number): Promise<void>;
}

const stderrLog = (record: EgressLogRecord): void => void process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);

const defaultResolve = async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/** A promise that gives up: a name server that does not answer must not hold a tunnel's place for as long as the resolver would wait. */
function answeredIn(promise: Promise<string[]>, ms: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the name server did not answer in time")), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e)),
    );
  });
}

/** Whether an address is in a network written `a.b.c.d/n`. */
function within(address: string, networks: net.BlockList): boolean {
  const a = address.replace(/^::ffff:/i, "");
  return net.isIPv4(a) && networks.check(a, "ipv4");
}

/** `host:port` of a CONNECT target, or what is wrong with it. A name only: digits and brackets are refused here, before anything is looked up. */
export function parseTarget(target: string): { host: string; port: number } | { refusal: string } {
  const m = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(target);
  if (!m) return { refusal: "the target is not host:port with a name for the host" };
  const host = m[1]!.toLowerCase().replace(/\.$/, "");
  const port = Number(m[2]);
  if (net.isIP(host) !== 0 || /^[0-9.]+$/.test(host)) return { refusal: "an address given as digits is not a name on the list" };
  if (!NAME.test(host)) return { refusal: "the host is not a name" };
  if (port < 1 || port > 65_535) return { refusal: "the port is not a port" };
  return { host, port };
}

export function nameAllowed(host: string, rules: HostRule[]): boolean {
  return rules.some((r) => (r.kind === "exact" ? host === r.name : host.endsWith(`.${r.name}`)));
}

export async function startEgress(config: EgressConfig, options: EgressOptions = {}): Promise<RunningEgress> {
  const log = options.log ?? stderrLog;
  const resolve = options.resolve ?? defaultResolve;
  const allowAddress = options.allowAddress ?? isPublicAddress;
  const sources = new net.BlockList();
  for (const n of config.allowFrom) {
    const [base, bits] = n.split("/") as [string, string];
    sources.addSubnet(base, Number(bits), "ipv4");
  }
  const L = config.limits;
  let open = 0;
  const perSource = new Map<string, number>();
  const sockets = new Set<net.Socket>();

  const refuse = (socket: net.Socket, status: number, reason: string): void => {
    if (socket.destroyed) return;
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : status === 504 ? "Gateway Timeout" : "Bad Gateway"}\r\nX-Curule-Egress: ${reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
  };

  const server = http.createServer((_req, res) => {
    // A request that is not a tunnel is a plain http one, which is not carried.
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "x-curule-egress": "https tunnels only", connection: "close" });
    res.end("This proxy carries HTTPS tunnels (CONNECT) to the hosts it was told of, and nothing else.\n");
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxHeadersCount = 64;
  server.on("clientError", (_err, socket) => void socket.destroy());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    // A connection from where the proxy was not told to serve is not answered at all.
    if (!within(socket.remoteAddress ?? "", sources)) {
      log({ level: "warn", msg: "a connection from outside allow_from was dropped", from: socket.remoteAddress ?? "" });
      socket.destroy();
    }
  });

  server.on("connect", (req: http.IncomingMessage, socket, head: Buffer) => {
    const client = socket as net.Socket;
    const from = (client.remoteAddress ?? "").replace(/^::ffff:/i, "");
    client.on("error", () => undefined);
    const target = parseTarget(req.url ?? "");
    if ("refusal" in target) {
      log({ level: "warn", msg: "a tunnel was refused", from, target: String(req.url ?? "").slice(0, 100), reason: target.refusal });
      return refuse(client, 403, target.refusal);
    }
    const { host, port } = target;
    const deny = (status: number, reason: string): void => {
      log({ level: "warn", msg: "a tunnel was refused", from, host, port, reason });
      refuse(client, status, reason);
    };
    if (!nameAllowed(host, config.hosts)) return deny(403, "this host is not on the list");
    if (!config.ports.includes(port)) return deny(403, "this port is not on the list");
    if (open >= L.maxConnections || (perSource.get(from) ?? 0) >= L.perSource) return deny(429, "too many tunnels are open");

    open++;
    perSource.set(from, (perSource.get(from) ?? 0) + 1);
    let released = false;
    let upstream: net.Socket | undefined;
    let life: NodeJS.Timeout | undefined;
    // The count is given back once, when the tunnel is over or was never made. A refusal is sent first and the socket is left to close
    // after it, so that the workspace is told why and not reset; what a workspace that never closes does is ended by the idle time.
    const release = (): void => {
      if (released) return;
      released = true;
      open--;
      const n = (perSource.get(from) ?? 1) - 1;
      if (n <= 0) perSource.delete(from);
      else perSource.set(from, n);
      if (life) clearTimeout(life);
      upstream?.destroy();
      client.destroy();
    };
    client.once("close", release);
    client.setTimeout(L.idleMs, release);

    void (async () => {
      let answers: string[];
      try {
        answers = await answeredIn(resolve(host), L.connectMs);
      } catch {
        return deny(502, "the name did not resolve");
      }
      if (answers.length === 0 || !answers.every(allowAddress)) {
        // One address that is not public is enough: the name is not one a workspace may be sent to, and nothing is connected.
        return deny(403, "the name resolves to an address that is not public");
      }
      const connected = await new Promise<net.Socket | undefined>((done) => {
        let i = 0;
        const next = (): void => {
          if (client.destroyed || i >= answers.length) return done(undefined);
          const s = net.connect({ host: answers[i++]!, port });
          const timer = setTimeout(() => s.destroy(new Error("timed out")), L.connectMs);
          const fail = (): void => {
            clearTimeout(timer);
            s.destroy();
            next();
          };
          s.once("connect", () => {
            clearTimeout(timer);
            s.off("error", fail);
            done(s);
          });
          s.once("error", fail);
        };
        next();
      });
      if (!connected) return client.destroyed ? release() : deny(504, "the host did not accept a connection");
      upstream = connected;
      if (client.destroyed) return release();
      upstream.on("error", release);
      upstream.once("close", release);
      upstream.setTimeout(L.idleMs, release);
      life = setTimeout(release, L.lifeMs);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      client.pipe(upstream);
      upstream.pipe(client);
      log({ level: "info", msg: "a tunnel was opened", from, host, port });
    })().catch((err: unknown) => {
      log({ level: "warn", msg: "a tunnel failed in a way that was not expected", from, host, port, error: err instanceof Error ? err.message : String(err) });
      release();
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as net.AddressInfo;
  log({ level: "info", msg: "the egress proxy is listening", host: config.listen.host, port: address.port, hosts: config.hosts.length, ports: config.ports });
  return {
    server,
    host: config.listen.host,
    port: address.port,
    open: () => open,
    stop: (graceMs = 5_000) =>
      new Promise<void>((done) => {
        const timer = setTimeout(() => {
          for (const s of sockets) s.destroy();
        }, graceMs);
        server.close(() => {
          clearTimeout(timer);
          done();
        });
        server.closeIdleConnections();
      }),
  };
}
