import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";
import { USAGE, main, type Io } from "../../apps/cloud-server/src/index";
import {
  describeEgress,
  isPublicAddress,
  loadEgressConfig,
  nameAllowed,
  parseTarget,
  startEgress,
  type EgressConfig,
  type EgressLogRecord,
  type EgressOptions,
  type RunningEgress,
} from "../../apps/cloud-server/src/egress";

// ---- the configuration ----

const valid = (): Record<string, unknown> => ({
  listen: { host: "10.213.0.1", port: 3128 },
  allow_from: ["10.213.0.0/24"],
  ports: [443],
  hosts: ["registry.npmjs.org", "github.com", "*.githubusercontent.com"],
});

/** A file holding `raw` for as long as `run` takes, which may be a promise: the file is not removed from under it. */
function withFile<T>(raw: unknown, run: (file: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "egress-config-"));
  const file = path.join(dir, "egress.yaml");
  fs.writeFileSync(file, typeof raw === "string" ? raw : stringify(raw));
  const remove = (): void => fs.rmSync(dir, { recursive: true, force: true });
  let result: T;
  try {
    result = run(file);
  } catch (err) {
    remove();
    throw err;
  }
  if (result instanceof Promise) return result.finally(remove) as T;
  remove();
  return result;
}

const refusal = (raw: unknown): string => withFile(raw, (file) => {
  try {
    loadEgressConfig(file);
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("the configuration was accepted");
});

test("a configuration names where the proxy listens, who may use it, the ports and the hosts, and what it allows is what it says", () => {
  withFile(valid(), (file) => {
    const c = loadEgressConfig(file);
    assert.deepEqual(c.listen, { host: "10.213.0.1", port: 3128 });
    assert.deepEqual(c.allowFrom, ["10.213.0.0/24"]);
    assert.deepEqual(c.ports, [443]);
    assert.deepEqual(c.hosts, [{ kind: "exact", name: "registry.npmjs.org" }, { kind: "exact", name: "github.com" }, { kind: "below", name: "githubusercontent.com" }]);
    assert.deepEqual(c.limits, { maxConnections: 512, perSource: 64, connectMs: 10_000, idleMs: 300_000, lifeMs: 3_600_000 });
    assert.deepEqual(c.warnings, []);
    const shown = describeEgress(c).join("\n");
    assert.match(shown, /^listening on 10\.213\.0\.1:3128, for connections from 10\.213\.0\.0\/24 and no other$/m);
    assert.match(shown, /^tunnels \(CONNECT\) to port 443 only, and only to: registry\.npmjs\.org, github\.com, \*\.githubusercontent\.com$/m);
    assert.match(shown, /an address given as digits is never allowed/);
  });
  withFile({ ...valid(), hosts: [" GitHub.com "], ports: [443, 80], limits: { max_connections: 10, per_source: 2, connect_seconds: 3, idle_seconds: 30, life_seconds: 60 } }, (file) => {
    const c = loadEgressConfig(file);
    assert.deepEqual(c.hosts, [{ kind: "exact", name: "github.com" }], "a name is read as lower case, without the spaces around it");
    assert.deepEqual([c.ports, c.limits], [[443, 80], { maxConnections: 10, perSource: 2, connectMs: 3000, idleMs: 30_000, lifeMs: 60_000 }]);
  });
});

test("every problem in the configuration is reported at once, and a proxy that would be open to the wrong network is refused", () => {
  const m = refusal({ listen: { host: "proxy.local", port: 0 }, allow_from: ["10.0.0.0/8", "nonsense"], ports: [0, "x"], hosts: ["https://github.com", "github.com:443", "com", "*.com", "10.0.0.5", "a b"], limits: { per_source: 9, max_connections: 3, idle_seconds: 0 } });
  for (const part of [
    /listen\.host must be an address, like 10\.213\.0\.1 \(got "proxy\.local"\)/,
    /listen\.port must be a whole number from 1 to 65535 \(got 0\)/,
    /allow_from '10\.0\.0\.0\/8' is larger than a \/16: it is the workspaces' network, and nothing wider/,
    /allow_from 'nonsense' is not an IPv4 network like 10\.213\.0\.0\/24/,
    /ports must be a list of port numbers, like \[443\]/,
    /hosts 'https:\/\/github\.com' is not a name/,
    /hosts 'github\.com:443' is not a name/,
    /hosts 'com' is not a name/,
    /hosts '\*\.com' is not a name/,
    /hosts '10\.0\.0\.5' is not a name/,
    /hosts 'a b' is not a name/,
    /limits\.idle_seconds must be a whole number from 1 to 86400 \(got 0\)/,
    /limits\.per_source is more than limits\.max_connections: one workspace could use them all/,
  ]) assert.match(m, part);
  assert.match(refusal({ ...valid(), listen: { host: "0.0.0.0", port: 3128 } }), /listen\.host 0\.0\.0\.0 is every address of the machine, and a proxy there is reachable from every network it is on/);
  assert.match(refusal({ ...valid(), listen: { host: "::", port: 3128 } }), /listen\.host :: is every address/);
  assert.match(refusal({ ...valid(), allow_from: [] }), /allow_from must list the networks a connection may come from/);
  assert.match(refusal({ ...valid(), hosts: [] }), /hosts must list the names a workspace may reach/);
  assert.match(refusal({ ...valid(), listen: undefined }), /listen must be a mapping with host and port/);
  assert.match(refusal("- just\n- a list\n"), /expected a mapping with listen, allow_from, ports and hosts/);
  assert.match(refusal("a: [unclosed"), /cannot read the egress configuration/);
});

test("a port that carries mail or a shell is allowed, and said; a family that looks like a whole registry is allowed, and said", () => {
  withFile({ ...valid(), ports: [443, 22, 25] }, (file) => assert.match(loadEgressConfig(file).warnings.join("\n"), /ports allows 22 and 25: a workspace could send mail or open a shell on any host on the list/));
  withFile({ ...valid(), hosts: ["*.co.uk", "*.com.au"] }, (file) => {
    const w = loadEgressConfig(file).warnings.join("\n");
    assert.match(w, /hosts \*\.co\.uk looks like a public suffix, which is every site under it, and not one operator's/);
    assert.match(w, /hosts \*\.com\.au looks like a public suffix/);
  });
  withFile({ ...valid(), hosts: ["*.github.com", "*.example.co.uk", "files.co.uk"] }, (file) => assert.deepEqual(loadEgressConfig(file).warnings, [], "a family under one operator's name, and one name, are not every site under a registry"));
});

// ---- what is a name on the list, and what is a public address ----

test("a name is on the list when it is written there, or is below a family; a family is not its own apex, and a name that only looks like one is not on it", () => {
  const rules = [{ kind: "exact", name: "github.com" }, { kind: "below", name: "githubusercontent.com" }] as const;
  const allowed = (h: string): boolean => nameAllowed(h, [...rules]);
  assert.deepEqual(["github.com", "raw.githubusercontent.com", "a.b.githubusercontent.com"].map(allowed), [true, true, true]);
  assert.deepEqual(["githubusercontent.com", "api.github.com", "github.com.evil.example", "evilgithub.com", "evilgithubusercontent.com", "notgithub.com", "github.co", ""].map(allowed), Array(8).fill(false));
});

test("a target is a name and a port, and anything that is a way round the list is not one", () => {
  assert.deepEqual(parseTarget("Registry.NPMJS.org:443"), { host: "registry.npmjs.org", port: 443 });
  assert.deepEqual(parseTarget("github.com.:443"), { host: "github.com", port: 443 }, "the dot that ends a name is not a different name");
  for (const target of ["10.213.0.1:443", "127.0.0.1:443", "169.254.169.254:80", "[::1]:443", "::1:443", "0x7f000001:443", "0x7f.1:443", "127.1:443", "2130706433:443", "1.2.3.4.:443", "1.2.3.4.5:443", "github.com", "github.com:", ":443", "github.com:0", "github.com:65536", "github.com:443/path", "user@github.com:443", "git hub.com:443", "-bad.com:443", "a..b.com:443", "", "github.com:99999"]) {
    const r = parseTarget(target);
    assert.ok("refusal" in r, `${JSON.stringify(target)} was taken for a name and a port: ${JSON.stringify(r)}`);
  }
});

test("only an address on the public internet is one a workspace may be sent to, and an address in disguise is judged as the one it is", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "140.82.112.3", "104.16.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"]) assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    "0.0.0.0", "127.0.0.1", "127.255.255.255", "10.0.0.1", "10.213.0.1", "100.64.0.1", "100.127.255.255", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.1", "203.0.113.1", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "2001::1", "2002:7f00:1::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "64:ff9b::1.2.3.4", "3fff::1",
    "", "github.com", "999.1.1.1", "1.2.3", "not an address",
  ]) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress("172.15.255.255"), true, "the range ends where it ends");
  assert.equal(isPublicAddress("172.32.0.0"), true);
  assert.equal(isPublicAddress("100.63.255.255"), true);
  assert.equal(isPublicAddress("100.128.0.0"), true);
});

// ---- the proxy, on real sockets ----

/** A test that waits on a socket is given a time to finish in: one that is waiting for something that will not happen fails, and does not hold the run. */
const sockety = (name: string, fn: () => Promise<void>): void => void test(name, { timeout: 20_000 }, fn);

/** Every socket a test opened to the proxy: a test that fails must not leave one open, or the run waits for it for ever. */
const opened = new Set<net.Socket>();
/** What a test started and has to end: run after every test, even one that failed or timed out, whose own clean-up never ran. Ending twice is harmless. */
const teardown: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const s of opened) s.destroy();
  opened.clear();
  await Promise.all(teardown.splice(0).map((end) => end().catch(() => undefined)));
});
/** A connection to the proxy that is ended by the time the test is, and is given up on if it is quiet. */
function dial(port: number, from = "127.0.0.1"): net.Socket {
  const socket = net.connect({ host: "127.0.0.1", port, localAddress: from });
  opened.add(socket);
  socket.setTimeout(5_000, () => socket.destroy());
  return socket;
}

/** A server that stands for a host on the public internet: it echoes what it is sent, and counts who connected. */
async function echo(): Promise<{ port: number; connections: () => number; close(): Promise<void> }> {
  let n = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    n++;
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => undefined);
    s.on("data", (d) => s.write(`echo:${d.toString()}`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  teardown.push(close);
  return { port: (server.address() as net.AddressInfo).port, connections: () => n, close };
}

const config = (over: Partial<EgressConfig> = {}): EgressConfig => ({
  listen: { host: "127.0.0.1", port: 0 },
  allowFrom: ["127.0.0.0/16"],
  ports: [443],
  hosts: [{ kind: "exact", name: "registry.example" }, { kind: "below", name: "files.example" }],
  limits: { maxConnections: 512, perSource: 64, connectMs: 2_000, idleMs: 300_000, lifeMs: 3_600_000 },
  warnings: [],
  ...over,
});

interface Proxy {
  p: RunningEgress;
  logs: EgressLogRecord[];
}

async function proxy(c: EgressConfig, o: EgressOptions = {}): Promise<Proxy> {
  const logs: EgressLogRecord[] = [];
  const p = await startEgress(c, { log: (r) => void logs.push(r), ...o });
  teardown.push(() => p.stop(50));
  return { p, logs };
}

/** One CONNECT on a connection of its own: what the proxy said first, and the socket, still open when it said 200. */
function connect(port: number, target: string, extra = "", from = "127.0.0.1"): Promise<{ head: string; status: number; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = dial(port, from);
    let buf = "";
    socket.on("timeout", () => reject(new Error("no answer")));
    socket.on("error", (e) => reject(e));
    socket.on("data", function onData(d) {
      buf += d.toString();
      if (!buf.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      const head = buf.slice(0, buf.indexOf("\r\n\r\n"));
      resolve({ head, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1]), socket });
    });
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`);
  });
}

const send = (socket: net.Socket, text: string): Promise<string> =>
  new Promise((resolve) => {
    socket.once("data", (d) => resolve(d.toString()));
    socket.write(text);
  });

const publicAs = (host: string, address = "127.0.0.1") => async (h: string): Promise<string[]> => {
  if (h === host) return [address];
  throw new Error(`ENOTFOUND ${h}`);
};

sockety("a tunnel is made to a host on the list, and what goes through it goes both ways untouched", async () => {
  const origin = await echo();
  const q = await proxy(config({ ports: [origin.port] }), { resolve: publicAs("registry.example"), allowAddress: () => true });
  try {
    const t = await connect(q.p.port, `registry.example:${origin.port}`);
    assert.equal(t.status, 200);
    assert.equal(t.head, "HTTP/1.1 200 Connection Established");
    assert.equal(await send(t.socket, "hello through the tunnel"), "echo:hello through the tunnel");
    assert.equal(await send(t.socket, "and again"), "echo:and again");
    assert.equal(q.p.open(), 1);
    t.socket.destroy();
    for (let i = 0; i < 100 && q.p.open() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(q.p.open(), 0, "the count is given back when the tunnel ends");
    const written = JSON.stringify(q.logs);
    assert.ok(q.logs.some((l) => l.msg === "a tunnel was opened" && l.host === "registry.example" && l.port === origin.port && l.from === "127.0.0.1"));
    assert.ok(!written.includes("hello through the tunnel"), "what goes through is not written down");
  } finally {
    await q.p.stop(100);
    await origin.close();
  }
});

sockety("a family of names is reached below it, a name that only looks like one is refused, and the answer says why", async () => {
  const origin = await echo();
  const { p } = await proxy(config({ ports: [origin.port] }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  try {
    const below = await connect(p.port, `a.b.files.example:${origin.port}`);
    assert.equal(below.status, 200, "any name below the family");
    below.socket.destroy();
    const refusals: Array<[string, string]> = [
      [`files.example:${origin.port}`, "this host is not on the list"],
      [`evilfiles.example:${origin.port}`, "this host is not on the list"],
      [`files.example.evil.test:${origin.port}`, "this host is not on the list"],
      [`other.example:${origin.port}`, "this host is not on the list"],
      ["registry.example:80", "this port is not on the list"],
    ];
    for (const [target, why] of refusals) {
      const r = await connect(p.port, target);
      assert.equal(r.status, 403, target);
      assert.match(r.head, new RegExp(`X-Curule-Egress: ${why}`), target);
      r.socket.destroy();
    }
    assert.equal(origin.connections(), 1, "only the one tunnel that was allowed reached the host");
  } finally {
    await p.stop(100);
    await origin.close();
  }
});

sockety("an address given as digits, a request that is not a tunnel, and a target that is not a target are refused, and nothing is connected", async () => {
  const origin = await echo();
  const { p } = await proxy(config({ ports: [origin.port], hosts: [{ kind: "exact", name: "registry.example" }] }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  try {
    for (const target of [`127.0.0.1:${origin.port}`, `169.254.169.254:${origin.port}`]) {
      const r = await connect(p.port, target);
      assert.equal(r.status, 403, target);
      assert.match(r.head, /X-Curule-Egress: an address given as digits is not a name on the list/, `${target} is refused for what it is, and not only for not being on the list`);
      r.socket.destroy();
    }
    for (const target of [`[::1]:${origin.port}`, "nonsense", `registry.example:${origin.port}/x`]) {
      const r = await connect(p.port, target);
      assert.equal(r.status, 403, target);
      assert.match(r.head, /X-Curule-Egress: the target is not host:port with a name for the host/, target);
      r.socket.destroy();
    }
    const plain = await new Promise<string>((resolve, reject) => {
      const s = dial(p.port);
      let buf = "";
      s.on("data", (d) => (buf += d.toString()));
      s.on("close", () => resolve(buf));
      s.on("error", reject);
      s.write(`GET http://registry.example:${origin.port}/ HTTP/1.1\r\nHost: registry.example\r\n\r\n`);
    });
    assert.match(plain, /^HTTP\/1\.1 403 /);
    assert.match(plain, /x-curule-egress: https tunnels only/i);
    assert.match(plain, /carries HTTPS tunnels \(CONNECT\) to the hosts it was told of, and nothing else/);
    assert.equal(origin.connections(), 0, "none of it reached a host");
  } finally {
    await p.stop(100);
    await origin.close();
  }
});

sockety("a name on the list that points at an address that is not public is refused, however many of its addresses are fine, and the address that was checked is the one connected to", async () => {
  const origin = await echo();
  const hosts = [{ kind: "exact" as const, name: "registry.example" }];
  const answers: Record<string, string[]> = {
    "loopback only": ["127.0.0.1"],
    "metadata address": ["169.254.169.254"],
    "private range": ["10.213.0.1"],
    "one good address and one that is not": ["93.184.216.34", "127.0.0.1"],
    "the bad one first": ["10.0.0.1", "93.184.216.34"],
    "an IPv4 address written as IPv6": ["::ffff:127.0.0.1"],
    "no address at all": [],
  };
  for (const [what, addresses] of Object.entries(answers)) {
    const { p, logs } = await proxy(config({ ports: [origin.port], hosts }), { resolve: async () => addresses });
    try {
      const r = await connect(p.port, `registry.example:${origin.port}`);
      assert.equal(r.status, 403, what);
      assert.match(r.head, /X-Curule-Egress: the name resolves to an address that is not public/, what);
      assert.ok(logs.some((l) => l.msg === "a tunnel was refused" && l.reason === "the name resolves to an address that is not public"), what);
      r.socket.destroy();
      assert.equal(origin.connections(), 0, `${what}: nothing was connected`);
    } finally {
      await p.stop(100);
    }
  }
  // The name is looked up once, and the connection is to what was found: the name is not looked up again for the connection.
  let lookups = 0;
  const { p } = await proxy(config({ ports: [origin.port], hosts }), { resolve: async () => (lookups++, ["127.0.0.1"]), allowAddress: () => true });
  try {
    const r = await connect(p.port, `registry.example:${origin.port}`);
    assert.equal(r.status, 200);
    assert.equal(lookups, 1);
    r.socket.destroy();
  } finally {
    await p.stop(100);
    await origin.close();
  }
});

sockety("a name that does not resolve is a 502, a host that does not answer is a 504, and the next address is tried when the first refuses", async () => {
  const origin = await echo();
  const dead = await echo();
  const deadPort = dead.port;
  await dead.close();
  const { p } = await proxy(config({ ports: [origin.port, deadPort] }), { resolve: async (h) => (h === "registry.example" ? ["127.0.0.1"] : Promise.reject(new Error("ENOTFOUND"))), allowAddress: () => true });
  try {
    const nx = await connect(p.port, `files.example:${origin.port}`.replace("files.example", "a.files.example"));
    assert.equal(nx.status, 502);
    assert.match(nx.head, /the name did not resolve/);
    nx.socket.destroy();
    const refused = await connect(p.port, `registry.example:${deadPort}`);
    assert.equal(refused.status, 504);
    assert.match(refused.head, /the host did not accept a connection/);
    refused.socket.destroy();
  } finally {
    await p.stop(100);
  }
  // The first address refuses and the second answers.
  const { p: q } = await proxy(config({ ports: [origin.port] }), { resolve: async () => ["127.0.0.2", "127.0.0.1"], allowAddress: () => true });
  try {
    const r = await connect(q.port, `registry.example:${origin.port}`);
    assert.equal(r.status, 200);
    r.socket.destroy();
  } finally {
    await q.stop(100);
    await origin.close();
  }
});

sockety("a name server that does not answer does not hold a place for longer than the time to connect", async () => {
  const { p } = await proxy(config({ limits: { ...config().limits, connectMs: 150 } }), { resolve: () => new Promise(() => undefined), allowAddress: () => true });
  try {
    const started = Date.now();
    const r = await connect(p.port, "registry.example:443");
    assert.equal(r.status, 502);
    assert.ok(Date.now() - started < 3_000, "it gave up");
    r.socket.destroy();
  } finally {
    await p.stop(100);
  }
});

sockety("a connection from outside the networks named is dropped without an answer, and the proxy says it did", async () => {
  const { p, logs } = await proxy(config({ allowFrom: ["10.213.0.0/24"] }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  try {
    const ended = await new Promise<string>((resolve) => {
      const s = dial(p.port);
      let buf = "";
      s.on("data", (d) => (buf += d.toString()));
      s.on("close", () => resolve(buf));
      s.on("error", () => resolve(buf));
      s.write("CONNECT registry.example:443 HTTP/1.1\r\nHost: x\r\n\r\n");
    });
    assert.equal(ended, "", "not even a refusal is said to an address that was not meant to be here");
    assert.ok(logs.some((l) => l.level === "warn" && l.msg === "a connection from outside allow_from was dropped" && l.from === "127.0.0.1"));
  } finally {
    await p.stop(100);
  }
});

sockety("one workspace cannot take every tunnel, the proxy as a whole has a limit too, and a place that is given back is a place", async () => {
  const origin = await echo();
  const limits = { ...config().limits, perSource: 2, maxConnections: 3 };
  const { p } = await proxy(config({ ports: [origin.port], limits }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  const target = `registry.example:${origin.port}`;
  try {
    // One workspace: its own limit.
    const a = await connect(p.port, target);
    const b = await connect(p.port, target);
    assert.deepEqual([a.status, b.status], [200, 200]);
    const c = await connect(p.port, target);
    assert.equal(c.status, 429);
    assert.match(c.head, /too many tunnels are open/);
    c.socket.destroy();
    // Another workspace is not held back by it, until the proxy as a whole is full.
    const other = await connect(p.port, target, "", "127.0.0.2");
    assert.equal(other.status, 200, "a second workspace has tunnels of its own");
    assert.equal(p.open(), 3);
    const third = await connect(p.port, target, "", "127.0.0.3");
    assert.equal(third.status, 429, "three are open, which is all the proxy takes, and this workspace has none");
    third.socket.destroy();
    // Giving one back makes room, for the workspace that had none.
    a.socket.destroy();
    for (let i = 0; i < 100 && p.open() > 2; i++) await new Promise((r) => setTimeout(r, 10));
    const d = await connect(p.port, target, "", "127.0.0.3");
    assert.equal(d.status, 200, "a place that was given back is a place");
    // When every tunnel of a workspace has ended, it owes the proxy nothing: it may have its full share again.
    for (const t of [b, other, d]) t.socket.destroy();
    for (let i = 0; i < 100 && p.open() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.open(), 0);
    const again = [await connect(p.port, target), await connect(p.port, target)];
    assert.deepEqual(again.map((t) => t.status), [200, 200], "the first workspace's two tunnels, after all of its earlier ones ended, are both let in");
    for (const t of again) t.socket.destroy();
  } finally {
    await p.stop(100);
    await origin.close();
  }
});

sockety("a tunnel with nothing in it for the idle time is ended, and one that lives too long is ended too", async () => {
  const origin = await echo();
  const idle = await proxy(config({ ports: [origin.port], limits: { ...config().limits, idleMs: 200 } }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  try {
    const t = await connect(idle.p.port, `registry.example:${origin.port}`);
    assert.equal(t.status, 200);
    // The test's own socket gives up after five seconds, so the proxy must have ended the tunnel well before that: a tunnel that is
    // ended by the one who opened it is not one the proxy ended.
    const started = Date.now();
    await new Promise<void>((resolve) => {
      t.socket.on("close", () => resolve());
      t.socket.on("error", () => resolve());
    });
    assert.ok(Date.now() - started < 2_500, `the tunnel lasted ${Date.now() - started} ms with an idle time of 200`);
    for (let i = 0; i < 100 && idle.p.open() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(idle.p.open(), 0);
  } finally {
    await idle.p.stop(100);
  }
  const long = await proxy(config({ ports: [origin.port], limits: { ...config().limits, lifeMs: 250 } }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  try {
    const t = await connect(long.p.port, `registry.example:${origin.port}`);
    const keep = setInterval(() => t.socket.write("x"), 50);
    await new Promise<void>((resolve) => {
      t.socket.on("close", () => resolve());
      t.socket.on("error", () => resolve());
    });
    clearInterval(keep);
    assert.equal(long.p.open(), 0, "a tunnel that is busy is still ended at the last");
  } finally {
    await long.p.stop(100);
    await origin.close();
  }
});

sockety("stopping lets no new tunnel in and ends the open ones after the grace", async () => {
  const origin = await echo();
  const { p } = await proxy(config({ ports: [origin.port] }), { resolve: async () => ["127.0.0.1"], allowAddress: () => true });
  const t = await connect(p.port, `registry.example:${origin.port}`);
  assert.equal(t.status, 200);
  const stopped = p.stop(150);
  const closed = new Promise<void>((resolve) => {
    t.socket.on("close", () => resolve());
    t.socket.on("error", () => resolve());
  });
  await Promise.all([stopped, closed]);
  await assert.rejects(() => connect(p.port, `registry.example:${origin.port}`));
  await origin.close();
});

// ---- the command ----

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}

const never = (async () => {
  throw new Error("this test starts nothing");
}) as unknown as typeof startEgress;

test("the usage names the egress command, --check reads and shows the file and listens on nothing, and a file that is wrong is said and exits 1", async () => {
  assert.match(USAGE, /egress --config <egress\.yaml> \[--check\]\s+the way out of a workspace's network/);
  await withFile(valid(), async (file) => {
    const out = io();
    assert.equal(await main(["egress", "--config", file, "--check"], {}, out, undefined, undefined, undefined, undefined, never), 0);
    assert.match(out.stdout.join("\n"), /listening on 10\.213\.0\.1:3128[\s\S]*\nthe configuration is valid$/);
    assert.equal(out.stderr.length, 0);
  });
  await withFile({ ...valid(), listen: { host: "0.0.0.0", port: 3128 } }, async (file) => {
    const out = io();
    assert.equal(await main(["egress", "--config", file, "--check"], {}, out, undefined, undefined, undefined, undefined, never), 1);
    assert.match(out.stderr.join("\n"), /every address of the machine/);
    assert.equal(out.stdout.length, 0);
  });
  const none = io();
  assert.equal(await main(["egress"], {}, none, undefined, undefined, undefined, undefined, never), 1);
  assert.equal(none.stderr.join("\n"), `curule-cloud egress: --config is required\n${USAGE}`);
  const odd = io();
  assert.equal(await main(["egress", "--config", "x.yaml", "--frobnicate"], {}, odd, undefined, undefined, undefined, undefined, never), 1);
  assert.equal(odd.stderr.join("\n"), `curule-cloud egress: unknown option '--frobnicate'\n${USAGE}`);
});

test("run, it listens until it is told to stop, and a proxy that cannot start is one clear line", async () => {
  await withFile(valid(), async (file) => {
    const running = io();
    let stopped = false;
    const start = (async () => ({ stop: async () => void (stopped = true) })) as unknown as typeof startEgress;
    const done = main(["egress", "--config", file], {}, running, undefined, undefined, undefined, undefined, start);
    for (let i = 0; i < 500 && running.signals.listenerCount("SIGTERM") === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(running.signals.listenerCount("SIGTERM") > 0);
    running.signals.emit("SIGTERM");
    assert.equal(await done, 0);
    assert.equal(stopped, true);
    assert.match(running.stdout.join("\n"), /SIGTERM: no longer taking tunnels; letting the open ones finish/);
    const failing = io();
    const refuses = (async () => {
      throw new Error("listen EADDRNOTAVAIL: address not available 10.213.0.1:3128");
    }) as unknown as typeof startEgress;
    assert.equal(await main(["egress", "--config", file], {}, failing, undefined, undefined, undefined, undefined, refuses), 1);
    assert.equal(failing.stderr.join("\n"), "curule-cloud egress: listen EADDRNOTAVAIL: address not available 10.213.0.1:3128");
  });
});
