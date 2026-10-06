import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceError, hashToken, type Mail } from "../../packages/cloud/src/index";
import { linkIn, plane, type Plane } from "./support";

const PASSWORD = "correct horse battery staple";
const tokenOf = (mail: Mail): string => new URL(linkIn(mail.text)).searchParams.get("token")!;
const mailTo = (p: Plane, email: string, kind: string): Mail[] => p.mailer.sent.filter((m) => m.to === email && m.kind === kind);
const refusal = async (promise: Promise<unknown>): Promise<ServiceError> => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return err;
  }
  throw new Error("it was accepted");
};
const DAY = 86_400_000;

test("signing up makes an account that cannot be used yet and sends a link, to the address as the person typed it, tidied", async () => {
  const p = await plane();
  assert.equal(await p.plane.accounts.signup("  Ada.Lovelace@Example.COM ", PASSWORD), undefined);
  const account = [...p.log.state.accounts.values()][0]!;
  assert.match(account.accountId, /^acct_[0-9a-f]{20}$/);
  assert.equal(account.email, "ada.lovelace@example.com");
  assert.equal(account.verifiedAt, undefined);
  assert.notEqual(account.passwordHash, PASSWORD);
  assert.ok(account.passwordHash.startsWith("scrypt$"));
  const [mail] = p.mailer.sent;
  assert.equal(p.mailer.sent.length, 1);
  assert.equal(mail!.to, "ada.lovelace@example.com");
  assert.equal(mail!.kind, "verify");
  assert.equal(mail!.subject, "Confirm your Curule account");
  assert.match(mail!.text, /^Confirm your email address to finish creating your account:\n\nhttps:\/\/app\.example\.com\/verify\?token=[A-Za-z0-9_-]{43}\n\nThe link works once and expires in 24 hours\. If you did not sign up, ignore this message: nothing happens unless the link is opened\.$/);
});

test("the log holds nothing that can be used: a token is kept only as its hash, and so is a session's", async () => {
  const p = await plane();
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  const verifyToken = tokenOf(p.mailer.sent[0]!);
  const session = await p.plane.accounts.verify(verifyToken);
  const everything = JSON.stringify(p.store.entries);
  assert.ok(!everything.includes(verifyToken), "the verification token is not in the log");
  assert.ok(!everything.includes(session.sessionToken), "the session token is not in the log");
  assert.ok(!everything.includes(PASSWORD));
  assert.ok(everything.includes(hashToken(verifyToken)));
  assert.ok(everything.includes(hashToken(session.sessionToken)));
  assert.match(session.sessionToken, /^s_[A-Za-z0-9_-]{43}$/);
  assert.equal(hashToken("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("an address has to look like one, and a password has to be a good one, or nothing is made and nothing is sent", async () => {
  const p = await plane();
  const bad = ["", "ada", "ada@", "@example.com", "ada@example", "ada@example.c", "ada @example.com", "ada@@example.com", "ada@exa mple.com", `${"a".repeat(65)}@example.com`, `ada@${"b".repeat(250)}.com`, 42, null, undefined, { email: "x" }];
  for (const email of bad) assert.equal((await refusal(p.plane.accounts.signup(email, PASSWORD))).code, "invalid_email", String(email));
  assert.doesNotThrow(() => p.plane.accounts.normaliseEmail(`${"a".repeat(64)}@example.com`));
  assert.doesNotThrow(() => p.plane.accounts.normaliseEmail("ada@example.co"));
  const short = await refusal(p.plane.accounts.signup("ada@example.com", "short"));
  assert.deepEqual([short.status, short.code, short.message], [400, "weak_password", "Use at least 10 characters."]);
  assert.equal((await refusal(p.plane.accounts.signup("ada@example.com", "password123"))).code, "weak_password");
  assert.equal((await refusal(p.plane.accounts.signup("ada@example.com", undefined))).message, "Choose a password.");
  assert.equal((await refusal(p.plane.accounts.signup("ada.lovelace@example.com", "Ada.Lovelace"))).message, "The password must not be your email address.");
  assert.equal(p.log.state.accounts.size, 0);
  assert.equal(p.mailer.sent.length, 0);
});

test("signing up again with an address that has an account is answered the same way, and the difference is in the mail the owner of the address reads", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const before = p.log.state.accounts.size;
  assert.equal(await p.plane.accounts.signup("ADA@example.com", "another good password"), undefined);
  assert.equal(p.log.state.accounts.size, before, "no second account");
  const [mail] = mailTo(p, "ada@example.com", "signup-existing");
  assert.equal(mail!.subject, "You already have a Curule account");
  assert.match(mail!.text, /^Someone, probably you, tried to create an account with this address, and you already have one, so no new one was made\.\n\nSign in: https:\/\/app\.example\.com\/login\nForgotten your password\? https:\/\/app\.example\.com\/forgot\n\nIf it was not you, ignore this message\.$/);
  assert.ok(!/token=/.test(mail!.text) && [...mail!.text.matchAll(/https?:\/\/\S+/g)].every((m) => /^https:\/\/app\.example\.com\/(login|forgot)$/.test(m[0])), "no link that would let a stranger in: only the pages to sign in or to ask for a reset, carrying no token");
  assert.equal(p.log.state.accounts.get(ada.accountId)!.passwordHash.startsWith("scrypt$"), true);
  assert.equal((await p.plane.accounts.login("ada@example.com", PASSWORD)).account.accountId, ada.accountId, "the old password still works: signing up again changed nothing");
});

test("signing up again before the first link was used sends a fresh link, and does not make a second account", async () => {
  const p = await plane();
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  await p.plane.accounts.signup("ada@example.com", "another good password");
  assert.equal(p.log.state.accounts.size, 1);
  const links = mailTo(p, "ada@example.com", "verify");
  assert.equal(links.length, 2);
  assert.notEqual(tokenOf(links[0]!), tokenOf(links[1]!));
  const session = await p.plane.accounts.verify(tokenOf(links[1]!));
  assert.equal(session.account.email, "ada@example.com");
  assert.equal((await p.plane.accounts.login("ada@example.com", PASSWORD)).account.accountId, session.account.accountId, "the password is the first one chosen");
});

test("a link from mail confirms the address and signs the person in, once", async () => {
  const p = await plane();
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  const token = tokenOf(p.mailer.sent[0]!);
  const session = await p.plane.accounts.verify(token, { ip: "203.0.113.9", userAgent: "x".repeat(300) });
  assert.equal(session.account.verifiedAt, new Date(p.clock.now).toISOString());
  assert.equal(session.expiresAt, new Date(p.clock.now + 30 * DAY).toISOString());
  assert.equal(p.plane.accounts.authenticate(session.sessionToken)!.email, "ada@example.com");
  const record = [...p.log.state.sessions.values()][0]!;
  assert.equal(record.accountId, session.account.accountId);
  const entry = p.store.entries.find((e) => e.type === "session.created") as Extract<(typeof p.store.entries)[number], { type: "session.created" }>;
  assert.equal(entry.ip, "203.0.113.9");
  assert.equal(entry.userAgent!.length, 200, "what a browser says about itself is kept short");
  const again = await refusal(p.plane.accounts.verify(token));
  assert.deepEqual([again.status, again.code], [400, "invalid_token"]);
});

test("a link that is wrong, old, for another purpose, empty, or for an account that has been stopped, is the same refusal", async () => {
  const p = await plane();
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  const token = tokenOf(p.mailer.sent[0]!);
  const messages = new Set<string>();
  for (const bad of ["", "nope", undefined, null, 42, token + "x", token.slice(1)]) {
    const e = await refusal(p.plane.accounts.verify(bad));
    assert.equal(e.code, "invalid_token");
    messages.add(e.message);
  }
  assert.deepEqual([...messages], ["That link is not valid, or it has expired. Ask for a new one."]);
  p.clock.advance(24 * 3_600_000);
  assert.equal((await refusal(p.plane.accounts.verify(token))).code, "invalid_token", "twenty-four hours is the end of it");
  p.clock.advance(-1);
  const last = await p.plane.accounts.verify(token);
  assert.ok(last.sessionToken, "one millisecond before the end it still works");

  const q = await plane();
  const bob = await q.account("bob@example.com");
  await q.plane.accounts.requestReset("bob@example.com");
  const resetToken = tokenOf(mailTo(q, "bob@example.com", "reset")[0]!);
  assert.equal((await refusal(q.plane.accounts.verify(resetToken))).code, "invalid_token", "a reset link does not sign anyone in");
  await q.plane.disableAccount(bob.accountId, "test");
  await q.plane.accounts.signup("carol@example.com", PASSWORD);
  const carol = tokenOf(mailTo(q, "carol@example.com", "verify")[0]!);
  await q.log.append({ type: "account.disabled", accountId: [...q.log.state.accounts.values()].find((a) => a.email === "carol@example.com")!.accountId, reason: "test" });
  assert.equal((await refusal(q.plane.accounts.verify(carol))).code, "invalid_token", "an account that has been stopped is not signed in by a link");
});

test("how long a verification link lasts, and how it says so, follow the options", async () => {
  const p = await plane({ accounts: { verificationHours: 1, resetHours: 5 } });
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  assert.match(p.mailer.sent[0]!.text, /The link works once and expires in 1 hour\./);
  const token = tokenOf(p.mailer.sent[0]!);
  p.clock.advance(3_600_000);
  assert.equal((await refusal(p.plane.accounts.verify(token))).code, "invalid_token");
  const q = await plane({ accounts: { resetHours: 5 } });
  await q.account("ada@example.com");
  await q.plane.accounts.requestReset("ada@example.com");
  assert.match(mailTo(q, "ada@example.com", "reset")[0]!.text, /expires in 5 hours\./);
});

test("signing in gives the same refusal, in the same words, whatever was wrong", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const bob = await p.account("bob@example.com");
  await p.plane.disableAccount(bob.accountId, "abuse");
  const failures = await Promise.all([
    refusal(p.plane.accounts.login("ada@example.com", "the wrong password")),
    refusal(p.plane.accounts.login("nobody@example.com", PASSWORD)),
    refusal(p.plane.accounts.login("not an email", PASSWORD)),
    refusal(p.plane.accounts.login("ada@example.com", undefined)),
    refusal(p.plane.accounts.login(undefined, undefined)),
    refusal(p.plane.accounts.login("bob@example.com", PASSWORD)),
  ]);
  for (const f of failures) assert.deepEqual([f.status, f.code, f.message], [401, "invalid_credentials", "That email and password do not match an account."]);
  const ok = await p.plane.accounts.login(" ADA@example.com ", PASSWORD, { ip: "198.51.100.1" });
  assert.equal(ok.account.accountId, ada.accountId);
  assert.equal(p.plane.accounts.authenticate(ok.sessionToken)!.accountId, ada.accountId);
  assert.notEqual(ok.sessionToken, ada.sessionToken, "each sign-in is a session of its own");
});

test("someone who knows the password of an address that was never confirmed gets the link again, and the same refusal", async () => {
  const p = await plane();
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  assert.equal(p.mailer.sent.length, 1);
  const e = await refusal(p.plane.accounts.login("ada@example.com", PASSWORD));
  assert.equal(e.code, "invalid_credentials");
  assert.equal(mailTo(p, "ada@example.com", "verify").length, 2);
  await refusal(p.plane.accounts.login("ada@example.com", "a wrong password"));
  assert.equal(mailTo(p, "ada@example.com", "verify").length, 2, "a wrong password gets no mail");
  const session = await p.plane.accounts.verify(tokenOf(mailTo(p, "ada@example.com", "verify")[1]!));
  assert.ok(session.sessionToken);
});

test("a session is good until it expires, until it has been idle too long, or until it is revoked or its account is stopped", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const token = ada.sessionToken;
  assert.equal(p.plane.accounts.authenticate(token)!.accountId, ada.accountId);
  for (const bad of [undefined, null, "", "s_nope", 42, token + "x"]) assert.equal(p.plane.accounts.authenticate(bad), undefined, String(bad));
  p.clock.advance(14 * DAY);
  assert.ok(p.plane.accounts.authenticate(token), "fourteen days idle is the limit, and it is not yet over");
  p.clock.advance(1);
  assert.equal(p.plane.accounts.authenticate(token), undefined, "idle for longer than that");
  const q = await plane();
  const bob = await q.account("bob@example.com");
  q.clock.advance(13 * DAY);
  await q.plane.accounts.touch(bob.sessionToken);
  q.clock.advance(13 * DAY);
  assert.ok(q.plane.accounts.authenticate(bob.sessionToken), "use keeps a session alive");
  q.clock.advance(4 * DAY);
  assert.equal(q.plane.accounts.authenticate(bob.sessionToken), undefined, "but not for longer than thirty days from the start");
});

test("how long a session lasts, and how long it may be left alone, follow the options", async () => {
  const p = await plane({ accounts: { sessionDays: 2, idleDays: 1 } });
  const ada = await p.account("ada@example.com");
  p.clock.advance(DAY);
  assert.ok(p.plane.accounts.authenticate(ada.sessionToken));
  await p.plane.accounts.touch(ada.sessionToken);
  p.clock.advance(DAY - 1);
  assert.ok(p.plane.accounts.authenticate(ada.sessionToken));
  p.clock.advance(1);
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined, "two days from the start, whatever else");
});

test("a revoked session, a stopped account and an account that is not confirmed are not signed in", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const second = await p.plane.accounts.login("ada@example.com", PASSWORD);
  await p.plane.accounts.logout(ada.sessionToken);
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined);
  assert.ok(p.plane.accounts.authenticate(second.sessionToken), "another session of the same account is not affected");
  await p.plane.disableAccount(ada.accountId, "abuse");
  assert.equal(p.plane.accounts.authenticate(second.sessionToken), undefined);
  await p.plane.enableAccount(ada.accountId);
  assert.equal(p.plane.accounts.authenticate(second.sessionToken), undefined, "starting an account again does not bring its old sessions back");
  assert.ok((await p.plane.accounts.login("ada@example.com", PASSWORD)).sessionToken);

  await p.plane.accounts.signup("bob@example.com", PASSWORD);
  const bobId = p.log.state.byEmail.get("bob@example.com")!;
  await p.log.append({ type: "session.created", sessionId: "sess_x", accountId: bobId, tokenHash: hashToken("s_forged"), expiresAt: new Date(p.clock.now + DAY).toISOString() });
  assert.equal(p.plane.accounts.authenticate("s_forged"), undefined, "a session of an account that was never confirmed is not good");
});

test("using a session is written down at most every ten minutes, so a busy page does not write on every request", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const seen = (): number => p.store.entries.filter((e) => e.type === "session.seen").length;
  await p.plane.accounts.touch(ada.sessionToken);
  assert.equal(seen(), 0);
  p.clock.advance(10 * 60_000 - 1);
  await p.plane.accounts.touch(ada.sessionToken);
  assert.equal(seen(), 0, "not yet ten minutes");
  p.clock.advance(1);
  await p.plane.accounts.touch(ada.sessionToken);
  assert.equal(seen(), 1);
  await p.plane.accounts.touch(ada.sessionToken);
  assert.equal(seen(), 1, "and then not again at once");
  await p.plane.accounts.touch("s_unknown");
  await p.plane.accounts.logout(ada.sessionToken);
  p.clock.advance(DAY);
  await p.plane.accounts.touch(ada.sessionToken);
  assert.equal(seen(), 1, "a session that was ended is not kept alive");
});

test("signing out ends the session once, and signing out of nothing is not an error", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.accounts.logout(ada.sessionToken);
  await p.plane.accounts.logout(ada.sessionToken);
  await p.plane.accounts.logout(undefined);
  await p.plane.accounts.logout("s_unknown");
  assert.equal(p.store.entries.filter((e) => e.type === "session.revoked").length, 1);
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined);
});

test("changing a password needs the current one, and a good new one; it ends every other session and keeps the one that asked", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const other = await p.plane.accounts.login("ada@example.com", PASSWORD);
  assert.equal((await refusal(p.plane.accounts.changePassword("acct_nobody", PASSWORD, "another good password"))).status, 404);
  const wrong = await refusal(p.plane.accounts.changePassword(ada.accountId, "not the password", "another good password"));
  assert.deepEqual([wrong.status, wrong.code], [403, "invalid_credentials"]);
  assert.equal((await refusal(p.plane.accounts.changePassword(ada.accountId, undefined, "another good password"))).code, "invalid_credentials");
  assert.equal((await refusal(p.plane.accounts.changePassword(ada.accountId, PASSWORD, "short"))).code, "weak_password");
  assert.equal((await refusal(p.plane.accounts.changePassword(ada.accountId, PASSWORD, undefined))).message, "Choose a password.");
  assert.ok(p.plane.accounts.authenticate(other.sessionToken), "a refused change ends nothing");

  await p.plane.accounts.changePassword(ada.accountId, PASSWORD, "another good password", ada.sessionToken);
  assert.ok(p.plane.accounts.authenticate(ada.sessionToken), "the session that asked stays");
  assert.equal(p.plane.accounts.authenticate(other.sessionToken), undefined, "every other one ends");
  assert.equal((await refusal(p.plane.accounts.login("ada@example.com", PASSWORD))).code, "invalid_credentials");
  assert.ok((await p.plane.accounts.login("ada@example.com", "another good password")).sessionToken);

  await p.plane.accounts.changePassword(ada.accountId, "another good password", "a third good password");
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined, "with no session to keep, none is kept");
});

test("a reset link goes only to an address that has a confirmed account that is not stopped, and the answer is the same whether it does or not", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.accounts.signup("unconfirmed@example.com", PASSWORD);
  const bob = await p.account("bob@example.com");
  await p.plane.disableAccount(bob.accountId, "abuse");
  const sentBefore = p.mailer.sent.length;
  for (const email of ["nobody@example.com", "unconfirmed@example.com", "bob@example.com", "not an email", undefined, 7]) assert.equal(await p.plane.accounts.requestReset(email), undefined, String(email));
  assert.equal(p.mailer.sent.length, sentBefore, "no mail for any of those");
  assert.equal(await p.plane.accounts.requestReset(" ADA@example.com"), undefined);
  const [mail] = mailTo(p, "ada@example.com", "reset");
  assert.equal(mail!.subject, "Reset your Curule password");
  assert.match(mail!.text, /^Open this link to choose a new password:\n\nhttps:\/\/app\.example\.com\/reset\?token=[A-Za-z0-9_-]{43}\n\nThe link works once and expires in 2 hours\. If you did not ask for it, ignore this message: your password has not changed\.$/);
  assert.ok(p.plane.accounts.authenticate(ada.sessionToken), "asking for a link ends nothing");
});

test("a reset link sets a new password once, ends every session, and is refused when it is old, used, wrong, for another purpose or for an account that has been stopped", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.accounts.requestReset("ada@example.com");
  const token = tokenOf(mailTo(p, "ada@example.com", "reset")[0]!);
  const weak = await refusal(p.plane.accounts.completeReset(token, "short"));
  assert.equal(weak.code, "weak_password");
  assert.equal((await refusal(p.plane.accounts.completeReset(token, undefined))).message, "Choose a password.");
  assert.ok(p.plane.accounts.authenticate(ada.sessionToken), "a refused reset ends nothing, and the link can be used again");
  await p.plane.accounts.completeReset(token, "a brand new passphrase");
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined);
  assert.equal((await refusal(p.plane.accounts.login("ada@example.com", PASSWORD))).code, "invalid_credentials");
  assert.ok((await p.plane.accounts.login("ada@example.com", "a brand new passphrase")).sessionToken);
  assert.equal((await refusal(p.plane.accounts.completeReset(token, "yet another passphrase"))).code, "invalid_token", "once");
  for (const bad of [undefined, "", "nope", 5]) assert.equal((await refusal(p.plane.accounts.completeReset(bad, "a brand new passphrase"))).code, "invalid_token");

  await p.plane.accounts.requestReset("ada@example.com");
  const second = tokenOf(mailTo(p, "ada@example.com", "reset")[1]!);
  p.clock.advance(2 * 3_600_000);
  assert.equal((await refusal(p.plane.accounts.completeReset(second, "a brand new passphrase"))).code, "invalid_token", "two hours");

  const bob = await p.account("bob@example.com");
  const verifyToken = tokenOf(mailTo(p, "bob@example.com", "verify")[0]!);
  assert.equal((await refusal(p.plane.accounts.completeReset(verifyToken, "a brand new passphrase"))).code, "invalid_token", "a confirmation link does not reset a password");
  await p.plane.accounts.requestReset("bob@example.com");
  const bobReset = tokenOf(mailTo(p, "bob@example.com", "reset")[0]!);
  await p.plane.disableAccount(bob.accountId, "abuse");
  assert.equal((await refusal(p.plane.accounts.completeReset(bobReset, "a brand new passphrase"))).code, "invalid_token");
});

test("a reset may not choose the person's own address as the password", async () => {
  const p = await plane();
  await p.account("ada.lovelace@example.com");
  await p.plane.accounts.requestReset("ada.lovelace@example.com");
  const token = tokenOf(mailTo(p, "ada.lovelace@example.com", "reset")[0]!);
  assert.equal((await refusal(p.plane.accounts.completeReset(token, "ada.lovelace@example.com"))).message, "The password must not be your email address.");
});

test("the time a sign-in or a sign-up takes does not say whether the address has an account: each way of failing does the work of checking a password", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  const time = async (work: () => Promise<unknown>): Promise<number> => {
    const start = performance.now();
    await work().catch(() => undefined);
    return performance.now() - start;
  };
  assert.ok((await time(() => p.plane.accounts.login("nobody@example.com", PASSWORD))) > 5, "an unknown address");
  assert.ok((await time(() => p.plane.accounts.login("not an email", PASSWORD))) > 5, "an address that is not one");
  assert.ok((await time(() => p.plane.accounts.login("ada@example.com", undefined))) > 5, "a password that is not text");
  assert.ok((await time(() => p.plane.accounts.login("ada@example.com", "wrong password here"))) > 5, "a wrong password");
  assert.ok((await time(() => p.plane.accounts.signup("ada@example.com", "another good password"))) > 5, "signing up with an address that has an account");
});
