import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, waitFor } from "../helpers";

/**
 * The product's own UI, live.
 *
 * A playground page is a file the console frames; a product that *serves* its UI is something else, and framing a file
 * cannot show it. A live mesh's product printed `listening on http://127.0.0.1:41839/?t=…`, bound loopback, and its page
 * addressed its API root-absolutely (`fetch("/api/action")`) — the way a page written for its own origin does, and
 * exactly what breaks when you serve it from somewhere else. Its owner asked for the feature, so the console runs the
 * command and proxies the port: the port and the token come from the product's own output, never from a guess, and the
 * sandboxed page loads every byte through the console.
 *
 * The fixture below is that product in miniature: an ephemeral port, a printed token, a refusal without it, and a page
 * whose API path is root-absolute.
 */
const PRODUCT_UI = [
  'import http from "http";',
  'const TOKEN = "testtoken1234";',
  "const server = http.createServer((req, res) => {",
  '  const u = new URL(req.url ?? "/", "http://127.0.0.1");',
  '  const cookie = String(req.headers.cookie ?? "");',
  '  const handed = /(^|;\\s*)sid=testtoken1234(;|$)/.test(cookie);',
  "  // The handshake the live mesh's product uses: the tokenized URL answers 302 with a cookie, and then the cookie is",
  "  // what authenticates. A sandboxed page keeps no cookies, so the console has to hold this session for it.",
  // Exactly the live product's shape: a tokenized request is answered with the handshake even when a session is
  // already held. A proxy that appends the token to every request loops for ever here — which is how this was found.
  '  if (u.searchParams.has("t")) {',
  '    res.writeHead(302, { "set-cookie": `sid=${TOKEN}; HttpOnly; Path=/`, location: "/" });',
  '    return res.end();',
  "  }",
  // And the page it serves carries the product's own CSP, written for being top-level on its own origin: the live
  // product's page really does say `frame-ancestors 'none'`. Forwarded verbatim through the proxy it forbids the
  // console's own frame, which is the bug this fixture is shaped after.
  `  res.setHeader("content-security-policy", "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'");`,
  '  res.setHeader("x-frame-options", "DENY");',
  '  if (!handed) { res.writeHead(403, { "content-type": "text/plain" }); return res.end("no session"); }',
  '  if (u.pathname === "/") {',
  '    res.writeHead(200, { "content-type": "text/html" });',
  `    return res.end('<!doctype html><link rel="stylesheet" href="/style.css"><p id="out"></p><script>fetch("/api/action").then((r) => r.text()).then((t) => { document.getElementById("out").textContent = t; });</script>');`,
  "  }",
  '  if (u.pathname === "/style.css") { res.writeHead(200, { "content-type": "text/css" }); return res.end("body{color:red}"); }',
  '  if (u.pathname === "/api/action") {',
  '    res.writeHead(200, { "content-type": "application/json" });',
  '    return res.end(JSON.stringify({ ran: "upstream", via: cookie }));',
  "  }",
  '  res.writeHead(404, { "content-type": "text/plain" });',
  '  res.end("nothing there");',
  "});",
  'server.listen(0, "127.0.0.1", () => {',
  '  console.log(`listening on http://127.0.0.1:${server.address().port}/?t=${TOKEN}`);',
  "});",
].join("\n");

test("the product's UI: started on request, port and token learned from what it prints, and proxied to the sandbox", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (p: string, body: unknown) =>
    fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const product = ((await (await fetch(`${base}/playground/commands`)).json()) as { productRoot: string }).productRoot;
    fs.mkdirSync(product, { recursive: true });
    fs.writeFileSync(path.join(product, "ui.mjs"), PRODUCT_UI, "utf8");

    assert.equal((await post("/ui/start", { command: "   " })).status, 400, "an empty command is refused");
    assert.equal((await fetch(`${base}/ui`)).status, 200);
    assert.equal(((await (await fetch(`${base}/ui`)).json()) as { running: boolean }).running, false, "nothing runs until asked");

    const started = await post("/ui/start", { command: "node ui.mjs" });
    assert.equal(started.status, 201);
    assert.equal((await post("/ui/start", { command: "node ui.mjs" })).status, 409, "one UI at a time");

    let state: { running: boolean; port: number | null; livePath: string | null; log: string } = { running: false, port: null, livePath: null, log: "" };
    await waitFor("the product to print its port", async () => {
      state = (await (await fetch(`${base}/ui`)).json()) as typeof state;
      return state.running && state.livePath !== null;
    }, 15_000);
    assert.ok(state.port && state.port > 0, `the port came from the product's own line: ${state.log}`);
    assert.equal(state.log.includes("listening on"), true, "and the owner can read what it printed");

    // The product answers its tokenized URL with a redirect and a cookie. The page cannot hold the cookie, so this is
    // the check that the console held it: the redirected request comes back 200 instead of another 403.
    const page = await fetch(`${base}${state.livePath!}`);
    assert.equal(page.status, 200, "the sandboxed page loads through the console after the product's own handshake");
    // The whole point of the pane is that the page is *seen*, and a browser refuses to display a document that says it
    // may not be framed. Two headers said so: the console's own API policy (every /api answer is unframeable) and the
    // product's CSP, forwarded verbatim — and the live product's really does carry `frame-ancestors 'none'`. Neither
    // survives on a page the console frames on purpose, and what applies instead is the policy the console gives every
    // agent-written page: an opaque origin this server may frame.
    assert.equal(page.headers.get("x-frame-options"), "SAMEORIGIN", "the console frames it, and nobody else does");
    const csp = String(page.headers.get("content-security-policy"));
    assert.match(csp, /^sandbox /, "in an opaque origin, so it can reach neither the console nor its API");
    assert.doesNotMatch(csp, /allow-same-origin/);
    assert.match(csp, /allow-scripts/, "and it still runs");
    assert.doesNotMatch(csp, /frame-ancestors 'none'/, "the product cannot forbid the frame it is being shown in");
    assert.doesNotMatch(csp, /script-src 'self'/, "nor impose a policy written for an origin this page does not have");
    assert.equal((await fetch(`${base}${state.livePath!}style.css`)).status, 200, "and the file it links, likewise");
    const html = await page.text();
    assert.match(html, /href="\.\/style\.css"/, "a path written for the product's root is made relative to the page");
    assert.match(html, /fetch\("\.\/api\/action"\)/, "including one inside its script, which is how this product's page asks for data");

    const api = await fetch(`${base}${state.livePath!}api/action`);
    assert.equal(api.status, 200, "the page's own fetch reaches the product's API through the proxy");
    const answer = (await api.json()) as { ran: string; via: string };
    assert.equal(answer.ran, "upstream", "and it is the product answering, not the console");
    assert.match(answer.via, /sid=testtoken1234/, "carrying the session cookie the product handed out, which the page could not keep");
    assert.equal(api.headers.get("access-control-allow-origin"), "*", "readable from an opaque origin, or the data would never arrive");

    assert.equal((await post("/ui/stop", {})).status, 200);
    const after = (await (await fetch(`${base}/ui`)).json()) as { running: boolean; command: string | null };
    assert.equal(after.running, false, "stopped means stopped");
    assert.equal(after.command, "node ui.mjs", "and the command is remembered, so starting it again is one press");
    assert.equal((await fetch(`${base}${state.livePath!}`)).status, 409, "a stale link cannot open what is not running");
  } finally {
    server.close();
  }
});


/**
 * The framed UI is served *ahead of operator auth*, and that is not a detail.
 *
 * A sandboxed frame carries neither cookie nor bearer — that is what makes it safe — so the only proof it can present is
 * the capability in its path. With the proxy registered in the session-protected part of the router, "Start it" worked
 * and the page then answered 401 to the frame: its owner reported exactly that ("i can click it and it work but i can not
 * open the page"). No behavioural test can catch this, because the test server requires no session at all — so the
 * ordering in the source is what is pinned here, alongside the playground page's, which had it right from the start.
 */
test("the product's UI is served ahead of operator auth, and the operator's own actions stay behind it", () => {
  const src = fs.readFileSync(path.join(process.cwd(), "apps/mesh-server/src/index.ts"), "utf8");
  const capability = src.indexOf("liveUiLinks.verify(parts[1])");
  const playground = src.indexOf("previews.verify(parts[1])");
  const authGate = src.indexOf("missing mesh token");
  assert.ok(capability > 0 && playground > 0 && authGate > 0, "all three are present");
  assert.ok(
    capability < authGate,
    "the framed UI is registered before the first auth gate: the frame cannot present a session",
  );
  assert.ok(playground < authGate, "and so is the playground page (this was already true)");
  for (const action of ['parts[0] === "ui" && parts[1] === "start"', 'parts[0] === "ui" && parts[1] === "stop"']) {
    assert.ok(
      src.indexOf(action) > authGate,
      `starting and stopping the product's UI stays behind operator auth (${action})`,
    );
  }
});
