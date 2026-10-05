import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, isPublicAddress, webFetchTool, ToolFailure, MAX_FETCH_CHARS } from "../../packages/runtime-native/src/index";
import { fakeServer, json } from "../llm/fake-server";
import { run, workspace } from "./support";

/**
 * WebFetch reaches the public web and nothing behind it. The address is judged, not the name, on every hop, and the
 * connection goes to the address that was judged.
 */

test("addresses a seat may and may not connect to", () => {
  const public_ = ["8.8.8.8", "93.184.216.34", "1.1.1.1", "2606:4700:4700::1111", "172.32.0.1", "100.63.255.255", "2001:4860:4860::8888"];
  const private_ = [
    "127.0.0.1", "127.255.255.254", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "64:ff9b::10.0.0.1", "not-an-address",
  ];
  for (const a of public_) assert.equal(isPublicAddress(a), true, a);
  for (const a of private_) assert.equal(isPublicAddress(a), false, a);
});

test("a page is reduced to its text: scripts, styles and tags go, entities decode, blocks break lines", () => {
  const html = `<html><head><title>T</title><style>p{color:red}</style><script>alert(1)</script></head>
    <body><h1>Heading</h1><p>One &amp; two &lt;three&gt; &#65;&#x42; &nbsp;done</p><!-- hidden --><ul><li>a</li><li>b</li></ul><noscript>no</noscript></body></html>`;
  assert.equal(htmlToText(html), "T\nHeading\nOne & two <three> AB done\na\nb");
});

/** A fetch policy for tests: everything resolves to the local server, and the judgement is ours to script. */
const policy = (isPublic: (a: string) => boolean = () => true, lookup?: (h: string) => Promise<Array<{ address: string; family: number }>>) => ({
  isPublic,
  lookup: lookup ?? (async () => [{ address: "127.0.0.1", family: 4 }]),
});

const fetchOf = async (ws: ReturnType<typeof workspace>, args: Record<string, unknown>, network = policy()) => {
  ws.ctx.network = network;
  return run(webFetchTool, args, ws);
};

const fails = async (p: Promise<unknown>, pattern: RegExp) => assert.rejects(p, (e: unknown) => e instanceof ToolFailure && pattern.test(e.message), String(pattern));

test("a page is fetched and read as text; JSON comes back as it is", async () => {
  const s = await fakeServer((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body><h1>Hello</h1><p>World</p><script>x()</script></body></html>");
    } else if (req.url === "/data") json(res, 200, { a: 1 });
    else json(res, 404, {});
  });
  const ws = workspace();
  try {
    const port = new URL(s.url).port;
    assert.equal((await fetchOf(ws, { url: `http://pub.test:${port}/page` })).text, "Hello\nWorld");
    assert.equal((await fetchOf(ws, { url: `http://pub.test:${port}/data` })).text, '{"a":1}');
    const missing = await fetchOf(ws, { url: `http://pub.test:${port}/missing` });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /^404 /);
  } finally {
    ws.cleanup();
    await s.close();
  }
});

test("a name that resolves to a private address, even among public ones, is not fetched, and nothing connects", async () => {
  const s = await fakeServer((_req, res) => res.end("secret"));
  const ws = workspace();
  try {
    const port = new URL(s.url).port;
    const net = policy(
      (a) => a !== "10.0.0.5" && a !== "127.0.0.1",
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
    );
    await fails(fetchOf(ws, { url: `http://rebind.test:${port}/` }, net), /resolves to 10\.0\.0\.5, which is not a public address/);
    assert.equal(s.seen.length, 0);
  } finally {
    ws.cleanup();
    await s.close();
  }
});

test("an IP literal is judged before any lookup, in the forms a URL allows", async () => {
  const ws = workspace();
  try {
    for (const url of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:1/", "http://[::1]:1/", "http://[::ffff:169.254.169.254]/", "http://2130706433/", "http://0x7f.1/", "http://localhost./"]) {
      ws.ctx.network = { lookup: async () => [{ address: "127.0.0.1", family: 4 }] };
      await assert.rejects(run(webFetchTool, { url }, ws), (e: unknown) => e instanceof ToolFailure && /not a public address/.test(e.message), url);
    }
  } finally {
    ws.cleanup();
  }
});

test("a redirect is judged like a first request, on every hop", async () => {
  const s = await fakeServer((req, res) => {
    if (req.url === "/start") (res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }), res.end());
    else if (req.url === "/ok") (res.writeHead(302, { location: "/final" }), res.end());
    else if (req.url === "/final") (res.writeHead(200, { "content-type": "text/plain" }), res.end("arrived"));
    else if (req.url === "/loop") (res.writeHead(302, { location: "/loop" }), res.end());
    else if (req.url === "/ftp") (res.writeHead(302, { location: "ftp://example.com/x" }), res.end());
  });
  const ws = workspace();
  try {
    const port = new URL(s.url).port;
    const net = policy((a) => a === "127.0.0.1");
    await fails(fetchOf(ws, { url: `http://pub.test:${port}/start` }, net), /169\.254\.169\.254 is not a public address/);
    const ok = await fetchOf(ws, { url: `http://pub.test:${port}/ok` }, net);
    assert.match(ok.text, /^arrived\n\[\(?redirected to http:\/\/pub\.test:\d+\/final\)?\]$/);
    await fails(fetchOf(ws, { url: `http://pub.test:${port}/loop` }, net), /too many redirects/);
    await fails(fetchOf(ws, { url: `http://pub.test:${port}/ftp` }, net), /not http or https/);
  } finally {
    ws.cleanup();
    await s.close();
  }
});

test("only http and https, no credentials in the URL, and a URL that parses", async () => {
  const ws = workspace();
  try {
    await fails(fetchOf(ws, { url: "file:///etc/passwd" }), /only http and https/);
    await fails(fetchOf(ws, { url: "ftp://example.com/x" }), /only http and https/);
    await fails(fetchOf(ws, { url: "http://user:pw@example.com/" }), /^a URL with credentials in it cannot be fetched\.$/);
    await fails(fetchOf(ws, { url: "not a url" }), /not a valid URL/);
    await fails(fetchOf(ws, {}), /url is required/);
  } finally {
    ws.cleanup();
  }
});

test("a response that is not text is refused, and a long one is cut and says so", async () => {
  const s = await fakeServer((req, res) => {
    if (req.url === "/img") (res.writeHead(200, { "content-type": "image/png" }), res.end(Buffer.from([1, 2, 3])));
    else if (req.url === "/long") (res.writeHead(200, { "content-type": "text/plain" }), res.end("x".repeat(MAX_FETCH_CHARS + 500)));
    else {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = "y".repeat(64 * 1024);
      let sent = 0;
      const write = (): void => {
        while (sent < 4 * 1024 * 1024) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", write);
        }
        res.end();
      };
      write();
    }
  });
  const ws = workspace();
  try {
    const port = new URL(s.url).port;
    await fails(fetchOf(ws, { url: `http://pub.test:${port}/img` }), /image\/png, which is not text/);
    const long = await fetchOf(ws, { url: `http://pub.test:${port}/long` });
    assert.equal(long.text.length, MAX_FETCH_CHARS + "\n[500 more characters not shown]".length);
    assert.match(long.text, /\[500 more characters not shown\]$/);
    const huge = await fetchOf(ws, { url: `http://pub.test:${port}/huge` });
    assert.match(huge.text, /the response was cut at 2097152 bytes/);
  } finally {
    ws.cleanup();
    await s.close();
  }
});

test("the mesh ending the turn abandons a fetch that is waiting", async () => {
  const s = await fakeServer(() => undefined);
  const ws = workspace();
  try {
    const port = new URL(s.url).port;
    ws.ctx.network = policy();
    const pending = run(webFetchTool, { url: `http://pub.test:${port}/never` }, ws);
    setTimeout(() => ws.abort.abort(), 100);
    await assert.rejects(pending, (e: unknown) => !(e instanceof ToolFailure));
  } finally {
    ws.cleanup();
    await s.close();
  }
});
