import { test } from "node:test";
import assert from "node:assert/strict";
import { bearerToken, hashSecret, KEY_PREFIX, mintKey, parseToken, secretMatches } from "../../packages/ai-gateway/src/index";

test("a minted key has a recognisable prefix, an id that is safe to show and a secret of 256 bits", () => {
  const k = mintKey();
  assert.match(k.token, /^curule_vk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.ok(k.token.startsWith(KEY_PREFIX));
  assert.equal(k.token.slice(KEY_PREFIX.length, KEY_PREFIX.length + 12), k.keyId);
  assert.equal(mintKey().token === k.token, false);
  assert.equal(mintKey().keyId === k.keyId, false);
});

test("what is stored cannot be spent: the hash is not the token and does not contain the secret", () => {
  const k = mintKey();
  const parsed = parseToken(k.token)!;
  assert.equal(k.secretHash, hashSecret(parsed.secret));
  assert.match(k.secretHash, /^[0-9a-f]{64}$/);
  assert.ok(!k.secretHash.includes(parsed.secret));
  assert.ok(!k.secretHash.includes(k.token));
});

test("a token is read back into its id and secret", () => {
  const k = mintKey();
  const parsed = parseToken(k.token);
  assert.equal(parsed?.keyId, k.keyId);
  assert.ok(secretMatches(parsed!.secret, k.secretHash));
});

test("a string that is not shaped like a token is not read as one", () => {
  const k = mintKey();
  const secret = parseToken(k.token)!.secret;
  for (const bad of [
    "",
    k.token + "x",
    " " + k.token,
    k.token + "\n",
    k.token.replace("curule_vk_", "other_vk_"),
    k.token.slice(0, -1),
    `${KEY_PREFIX}ABCDEF012345_${secret}`,
    `${KEY_PREFIX}${k.keyId.slice(1)}_${secret}`,
    `${KEY_PREFIX}${k.keyId}-${secret}`,
    `${KEY_PREFIX}${k.keyId}_${secret.slice(0, 42)}!`,
  ]) {
    assert.equal(parseToken(bad), undefined, JSON.stringify(bad));
  }
});

test("a secret matches only its own hash", () => {
  const a = mintKey();
  const b = mintKey();
  const secretA = parseToken(a.token)!.secret;
  assert.equal(secretMatches(secretA, a.secretHash), true);
  assert.equal(secretMatches(secretA, b.secretHash), false);
  assert.equal(secretMatches(secretA + "x", a.secretHash), false);
  assert.equal(secretMatches("", a.secretHash), false);
  // A stored value of the wrong length is a mismatch, not an exception.
  assert.equal(secretMatches(secretA, "abcd"), false);
  assert.equal(secretMatches(secretA, ""), false);
});

test("the token is taken from a Bearer header and from nothing else", () => {
  assert.equal(bearerToken("Bearer abc"), "abc");
  assert.equal(bearerToken("bearer abc"), "abc");
  assert.equal(bearerToken("Bearer   abc  "), "abc");
  assert.equal(bearerToken(["Bearer first", "Bearer second"]), "first");
  for (const bad of [undefined, "", "Bearer", "Bearer ", "Basic abc", "Bearer a b", "abc", "Bearerabc", [] as string[]]) assert.equal(bearerToken(bad), undefined, JSON.stringify(bad));
});
