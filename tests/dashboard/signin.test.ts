import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_WAIT_SECONDS,
  SESSION_ENDED,
  TOKEN_FIRST,
  TOKEN_SOURCES,
  classifyLogin,
  connectionWarning,
  normalizeToken,
  piecesText,
  readGate,
  secondsLeft,
  splitSentence,
  waitPhrase,
} from "../../apps/mesh-dashboard/src/signin";

test("the gate reads the server's answer: sign in only when it says a token is held and this browser has no session", () => {
  assert.deepEqual(readGate({ status: 200, body: { required: true, authenticated: false } }), { kind: "login" });
  assert.deepEqual(readGate({ status: 200, body: { required: true, authenticated: true } }), { kind: "open" });
  assert.deepEqual(readGate({ status: 200, body: { required: false, authenticated: true } }), { kind: "open" }, "no token held: nothing to sign in to");
  assert.deepEqual(readGate({ status: 200, body: { required: false } }), { kind: "open" });
});

test("a host that does not answer is not an open console: a failed request and a 5xx say so", () => {
  assert.deepEqual(readGate(null), { kind: "unreachable" });
  for (const status of [500, 501, 502, 503, 504]) assert.deepEqual(readGate({ status, body: null }), { kind: "unreachable" }, String(status));
});

test("an older server with no sign-in route, or an answer that is not the shape asked for, leaves the console open as it always was", () => {
  for (const status of [404, 405]) assert.deepEqual(readGate({ status, body: { error: "no route" } }), { kind: "open" }, String(status));
  assert.deepEqual(readGate({ status: 200, body: null }), { kind: "open" });
  assert.deepEqual(readGate({ status: 200, body: { required: "yes" } }), { kind: "open" });
  assert.deepEqual(readGate({ status: 200, body: "<html>" }), { kind: "open" });
});

test("a wrong token says what to do, and is not the same as the host being down", () => {
  const wrong = classifyLogin({ status: 401, retryAfter: null, body: { error: "that token was not accepted" } });
  assert.equal(wrong.kind, "wrong-token");
  assert.match((wrong as { message: string }).message, /not accepted/);
  assert.match((wrong as { message: string }).message, /Copy it again/);
  assert.deepEqual(classifyLogin({ status: 200, retryAfter: null, body: { ok: true } }), { kind: "signed-in" });
});

test("too many wrong tokens holds the button for exactly as long as the server says, from the header first, then the body", () => {
  const fromHeader = classifyLogin({ status: 429, retryAfter: "42", body: { retryAfterSec: 7 } });
  assert.equal(fromHeader.kind, "rate-limited");
  assert.equal((fromHeader as { seconds: number }).seconds, 42);
  assert.equal((fromHeader as { estimated: boolean }).estimated, false);
  assert.match((fromHeader as { message: string }).message, /Wait 42 seconds before trying again/);

  const fromBody = classifyLogin({ status: 429, retryAfter: null, body: { retryAfterSec: 9 } });
  assert.equal((fromBody as { seconds: number }).seconds, 9);
  assert.equal((fromBody as { estimated: boolean }).estimated, false);

  assert.equal((classifyLogin({ status: 429, retryAfter: "1", body: null }) as { message: string }).message, "Too many wrong tokens from this address. Wait 1 second before trying again.");
  assert.equal((classifyLogin({ status: 429, retryAfter: "2.2", body: null }) as { seconds: number }).seconds, 3, "rounded up: never freed early");
});

test("when a 429 names no wait the page guesses, and says it is a guess", () => {
  for (const retryAfter of [null, "", "soon", "0", "-5"]) {
    const o = classifyLogin({ status: 429, retryAfter, body: {} });
    assert.equal(o.kind, "rate-limited", String(retryAfter));
    assert.equal((o as { seconds: number }).seconds, FALLBACK_WAIT_SECONDS);
    assert.equal((o as { estimated: boolean }).estimated, true);
    assert.match((o as { message: string }).message, /Wait about 30 seconds/);
  }
});

test("a host that cannot be reached, one that errs, and one that refuses the request are three different messages", () => {
  const down = classifyLogin(null);
  assert.equal(down.kind, "unreachable");
  assert.match((down as { message: string }).message, /Could not reach the host/);
  assert.match((down as { message: string }).message, /try again/);

  const broken = classifyLogin({ status: 502, retryAfter: null, body: null });
  assert.equal(broken.kind, "server-error");
  assert.match((broken as { message: string }).message, /answered 502.*may be restarting/);

  const refused = classifyLogin({ status: 421, retryAfter: null, body: { error: "host 'x' is not one this server answers to. Add it to MESH_ALLOWED_HOSTS." } });
  assert.equal(refused.kind, "refused");
  assert.match((refused as { message: string }).message, /MESH_ALLOWED_HOSTS/, "the server's own words name the setting");
  assert.equal((classifyLogin({ status: 403, retryAfter: null, body: null }) as { message: string }).message, "The host refused this request (403).");
  assert.ok((classifyLogin({ status: 403, retryAfter: null, body: { error: "x".repeat(1000) } }) as { message: string }).message.length < 300, "a long refusal is cut");
});

test("a message splits into a headline and what follows, at the first full stop that ends a sentence", () => {
  assert.deepEqual(splitSentence("That token was not accepted. Copy it again, then paste it here."), { title: "That token was not accepted.", detail: "Copy it again, then paste it here." });
  assert.deepEqual(splitSentence("Could not reach the host."), { title: "Could not reach the host.", detail: "" });
  assert.deepEqual(splitSentence("no full stop"), { title: "no full stop", detail: "" });
  assert.equal(splitSentence("The host refused this request: host '10.0.0.1:5181' is not one this server answers to. Add it to MESH_ALLOWED_HOSTS.").title, "The host refused this request: host '10.0.0.1:5181' is not one this server answers to.", "a dot inside an address is not a sentence end");
  // Every message the page can show splits into a headline of its own.
  for (const out of [classifyLogin(null), classifyLogin({ status: 401, retryAfter: null, body: null }), classifyLogin({ status: 429, retryAfter: "5", body: null }), classifyLogin({ status: 502, retryAfter: null, body: null })]) {
    const { title, detail } = splitSentence((out as { message: string }).message);
    assert.ok(title.endsWith(".") && detail.length > 0, `${out.kind}: ${title} / ${detail}`);
  }
});

test("the wait counts down to zero, rounded up, and never below", () => {
  assert.equal(secondsLeft(10_000, 0), 10);
  assert.equal(secondsLeft(10_000, 9_001), 1);
  assert.equal(secondsLeft(10_000, 10_000), 0);
  assert.equal(secondsLeft(10_000, 99_000), 0);
  assert.equal(waitPhrase(1), "1 second");
  assert.equal(waitPhrase(12), "12 seconds");
});

test("a pasted token loses what a terminal and a .env file put around it, and nothing inside it", () => {
  assert.equal(normalizeToken("  abc123\n"), "abc123");
  assert.equal(normalizeToken("MESH_API_TOKEN=abc123"), "abc123");
  assert.equal(normalizeToken("export MESH_API_TOKEN=abc123"), "abc123");
  assert.equal(normalizeToken('MESH_API_TOKEN="abc123"'), "abc123");
  assert.equal(normalizeToken("'abc123'"), "abc123");
  assert.equal(normalizeToken("MESH_API_TOKEN = abc123 \r\n"), "abc123");
  assert.equal(normalizeToken("a b c"), "a b c", "inside the token is the token");
  assert.equal(normalizeToken("ab'c"), "ab'c");
  assert.equal(normalizeToken(""), "");
  assert.equal(normalizeToken("   "), "");
  assert.equal(normalizeToken("abc==="), "abc===", "a base64 token keeps its padding");
});

test("a token that would cross a network in the clear gets a warning; a laptop's loopback does not", () => {
  for (const host of ["localhost", "127.0.0.1", "127.8.0.3", "[::1]", "::1", "app.localhost", "LOCALHOST"]) assert.equal(connectionWarning("http:", host), null, host);
  for (const host of ["curule.example.com", "203.0.113.5", "192.168.1.20", "10.0.0.4", "mesh"]) {
    assert.match(connectionWarning("http:", host) ?? "", /plain http.*unencrypted.*HTTPS/, host);
  }
  assert.equal(connectionWarning("https:", "curule.example.com"), null);
  assert.equal(connectionWarning("https:", "203.0.113.5"), null);
  assert.equal(connectionWarning("http:", "127.0.0.1.evil.example"), "This page was loaded over plain http, so the token you type crosses the network unencrypted. Put the host behind HTTPS before you sign in from another machine.", "a name that merely begins like loopback is not loopback");
});

test("every way of running a host says where the token is, by the names the deployment documents use", () => {
  assert.deepEqual(TOKEN_SOURCES.map((s) => s.id), ["process", "docker", "kubernetes"]);
  const text = (id: string): string => {
    const s = TOKEN_SOURCES.find((x) => x.id === id)!;
    return `${piecesText(s.where)} ${s.command ?? ""}`;
  };
  assert.match(text("process"), /MESH_API_TOKEN/);
  assert.match(text("process"), /127\.0\.0\.1/, "and says that a loopback host may have none");
  assert.match(text("docker"), /docker run/);
  assert.match(text("docker"), /docker compose exec mesh printenv MESH_API_TOKEN/);
  assert.match(text("kubernetes"), /auth\.existingSecret/);
  assert.match(text("kubernetes"), /MESH_API_TOKEN/);
  assert.match(text("kubernetes"), /base64 -d/);
  for (const s of TOKEN_SOURCES) assert.ok(s.where.some((p) => typeof p !== "string"), `${s.id}: names are set apart as code`);
});

test("the sentence for a session that ended is the one the brief names", () => {
  assert.equal(SESSION_ENDED, "Your session ended. Sign in again.");
});

test("an empty field is answered with an instruction, not with a button that will not press", () => {
  assert.equal(TOKEN_FIRST, "Paste the access token first.");
  // What the page would send for it is nothing: a field of only whitespace, quotes or the variable's name is empty too.
  for (const raw of ["", "   ", "\n", '""', "''", "MESH_API_TOKEN=", "export MESH_API_TOKEN="]) {
    assert.equal(normalizeToken(raw), "", JSON.stringify(raw));
  }
});
