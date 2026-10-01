/**
 * The pieces of dashboard sign-in that are decisions rather than wiring: how a session id is kept,
 * when it lapses, how a cookie is read and written, and what a playground capability proves.
 * `sign-in.test.ts` holds the servers to them over a socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type * as http from "http";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SessionStore,
  clearedSessionCookie,
  cookieSecure,
  parseCookies,
  sessionCookie,
} from "../../apps/mesh-server/src/sessions";
import { PREVIEW_PREFIX, PREVIEW_TTL_MS, PreviewCapabilities } from "../../apps/mesh-server/src/preview";

test("a session is valid until it lapses, and revoking it ends it at once", () => {
  let t = 1_000;
  const store = new SessionStore(60_000, () => t);
  const a = store.create();
  assert.equal(a.maxAgeSec, 60);
  assert.equal(store.valid(a.id), true);
  t += 59_999;
  assert.equal(store.valid(a.id), true);
  t += 2;
  assert.equal(store.valid(a.id), false, "past its lifetime");
  const b = store.create();
  store.revoke(b.id);
  assert.equal(store.valid(b.id), false);
  assert.equal(store.size, 0);
});

test("an id nobody minted is not a session, whatever it looks like", () => {
  const store = new SessionStore();
  const real = store.create();
  for (const guess of [undefined, "", "x", real.id.slice(0, -1), `${real.id}x`, real.id.toUpperCase(), "0".repeat(43)]) {
    assert.equal(store.valid(guess), false, JSON.stringify(guess));
  }
  assert.equal(store.valid(real.id), true);
});

test("ids are 256 bits, distinct, and not what the store holds", () => {
  const store = new SessionStore();
  const ids = new Set(Array.from({ length: 50 }, () => store.create().id));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{43}$/, "32 random bytes, base64url");
  // The map is private, but a dump of the object must not contain a usable id.
  const dump = JSON.stringify([...(store as unknown as { live: Map<string, number> }).live.keys()]);
  for (const id of ids) assert.equal(dump.includes(id), false, "only a digest is kept");
});

test("the store stays bounded: past its cap the oldest session is dropped", () => {
  const store = new SessionStore();
  const first = store.create();
  for (let i = 0; i < 300; i++) store.create();
  assert.ok(store.size <= 256, `size ${store.size}`);
  assert.equal(store.valid(first.id), false, "the oldest went first");
});

test("the lifetime is a working day", () => {
  assert.equal(SESSION_TTL_MS, 12 * 60 * 60 * 1000);
});

test("cookies are read by name, and a malformed header never throws", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("a=1; mesh_session=abc; b=two=three"), { a: "1", mesh_session: "abc", b: "two=three" });
  assert.deepEqual(parseCookies(["a=1", "b=2"]), { a: "1", b: "2" });
  assert.deepEqual(parseCookies("novalue; =x; ok=1;;"), { ok: "1" });
  assert.equal(parseCookies("mesh_session=first; mesh_session=second").mesh_session, "first", "the first wins; a later duplicate cannot replace it");
});

test("the cookie cannot be read by script, and is not sent from another site", () => {
  const c = sessionCookie("abc", 3600, false);
  assert.equal(c, `${SESSION_COOKIE}=abc; Path=/; HttpOnly; SameSite=Strict; Max-Age=3600`);
  assert.match(sessionCookie("abc", 3600, true), /; Secure$/);
  assert.match(clearedSessionCookie(false), /Max-Age=0$/);
  assert.match(clearedSessionCookie(true), /Max-Age=0; Secure$/);
});

test("Secure is set when the operator says the page is on https, and not guessed from a header nobody vouches for", () => {
  const req = (proto?: string): http.IncomingMessage => ({ headers: proto ? { "x-forwarded-proto": proto } : {} }) as unknown as http.IncomingMessage;
  assert.equal(cookieSecure(req(), {}), false, "plain http://localhost must be able to sign in");
  assert.equal(cookieSecure(req("https"), {}), false, "an unvouched header is not evidence");
  assert.equal(cookieSecure(req(), { MESH_COOKIE_SECURE: "1" }), true);
  assert.equal(cookieSecure(req("https"), { MESH_TRUST_PROXY: "1" }), true);
  assert.equal(cookieSecure(req("https, http"), { MESH_TRUST_PROXY: "1" }), true, "the first hop is the browser's");
  assert.equal(cookieSecure(req("http"), { MESH_TRUST_PROXY: "1" }), false);
  assert.equal(cookieSecure(req(), { MESH_TRUST_PROXY: "1" }), false);
});

// ------------------------------------------------------------ preview capabilities

test("a playground capability verifies until it expires, and only for the server that minted it", () => {
  let t = 5_000_000;
  const mine = new PreviewCapabilities(() => t);
  const theirs = new PreviewCapabilities(() => t);
  const minted = mine.mint();
  assert.equal(minted.path, `/${PREVIEW_PREFIX}/${minted.capability}/apps/playground/`, "the page, in the product's own layout, so its relative URLs reach its presets");
  assert.equal(minted.expiresAt, t + PREVIEW_TTL_MS);
  assert.equal(mine.verify(minted.capability), true);
  assert.equal(theirs.verify(minted.capability), false, "another server's secret");
  t += PREVIEW_TTL_MS - 1;
  assert.equal(mine.verify(minted.capability), true);
  t += 2;
  assert.equal(mine.verify(minted.capability), false, "lapsed on its own");
});

test("a capability cannot be edited into a longer one or forged from its parts", () => {
  const t = 9_000_000;
  const caps = new PreviewCapabilities(() => t);
  const { capability } = caps.mint();
  const [expiry, sig] = capability.split(".") as [string, string];
  assert.equal(caps.verify(`${Number(expiry) + 1}.${sig}`), false, "a later expiry under the old signature");
  assert.equal(caps.verify(`${expiry}.${sig.slice(0, 5)}${sig[5] === "A" ? "B" : "A"}${sig.slice(6)}`), false);
  for (const bad of [undefined, "", ".", "x", `${expiry}.`, `.${sig}`, `abc.${sig}`, `${expiry}.${sig}.extra`, `-1.${sig}`, `1e99.${sig}`]) {
    assert.equal(caps.verify(bad), false, JSON.stringify(bad));
  }
});
