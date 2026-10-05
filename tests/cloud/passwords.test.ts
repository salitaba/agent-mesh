import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, scryptSync } from "node:crypto";
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, burnPasswordTime, hashPassword, passwordProblem, verifyPassword } from "../../packages/cloud/src/index";

test("a password is stored as its parameters, a salt and a hash, and a second hash of the same password is not the same string", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");
  const [scheme, n, r, p, salt, hash] = a.split("$");
  assert.equal(scheme, "scrypt");
  assert.deepEqual([n, r, p], ["32768", "8", "1"]);
  assert.equal(Buffer.from(salt!, "base64url").length, 16);
  assert.equal(Buffer.from(hash!, "base64url").length, 64);
  assert.notEqual(a, b, "each hash has a salt of its own");
  assert.ok(!a.includes("correct horse"), "nothing of the password is in what is stored");
});

test("the right password verifies and a wrong one, or one with a character changed, does not", async () => {
  const stored = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", stored), true);
  assert.equal(await verifyPassword("correct horse battery stapl", stored), false);
  assert.equal(await verifyPassword("Correct horse battery staple", stored), false);
  assert.equal(await verifyPassword("", stored), false);
});

test("passwords are compared in a normal form, so a ligature or a full-width letter does not make the same password a different one", async () => {
  const stored = await hashPassword("ﬁnest-password-here");
  assert.equal(await verifyPassword("finest-password-here", stored), true);
  assert.equal(await verifyPassword("ｆｉｎｅｓｔ-password-here", stored), true);
  assert.equal(await verifyPassword("ﬁnest-password-here", stored), true);
  assert.equal(await verifyPassword("finest-passw0rd-here", stored), false, "a different password is still a different password");
});

test("a hash is verified with the parameters it was made with, so the parameters can be raised later without a migration", async () => {
  const salt = randomBytes(16);
  const key = scryptSync("older-and-cheaper-password", salt, 32, { N: 1024, r: 8, p: 1 });
  const stored = ["scrypt", 1024, 8, 1, salt.toString("base64url"), key.toString("base64url")].join("$");
  assert.equal(await verifyPassword("older-and-cheaper-password", stored), true);
  assert.equal(await verifyPassword("something else entirely", stored), false);
});

test("a stored value that cannot be read is a wrong password and never an exception", async () => {
  const good = await hashPassword("correct horse battery staple");
  const [, , , , salt, hash] = good.split("$");
  const unreadable = [
    "",
    "x",
    "scrypt$32768$8$1",
    `bcrypt$32768$8$1$${salt}$${hash}`,
    `scrypt$abc$8$1$${salt}$${hash}`,
    `scrypt$32768$0$1$${salt}$${hash}`,
    `scrypt$32768$8$-1$${salt}$${hash}`,
    `scrypt$32768.5$8$1$${salt}$${hash}`,
    `scrypt$${(1 << 20) + 1}$8$1$${salt}$${hash}`,
    `scrypt$32768$8$1$$${hash}`,
    `scrypt$32768$8$1$${salt}$`,
    `scrypt$32768$8$1$${salt}$${hash}$extra`,
  ];
  for (const stored of unreadable) assert.equal(await verifyPassword("correct horse battery staple", stored), false, JSON.stringify(stored));
});

test("a stored hash whose cost is more than the service will spend is refused as a wrong password, not run", async () => {
  const salt = randomBytes(16).toString("base64url");
  const stored = `scrypt$${1 << 20}$8$1$${salt}$${randomBytes(64).toString("base64url")}`;
  assert.equal(await verifyPassword("correct horse battery staple", stored), false);
});

test("a sign-in with no account to check against can spend the time of one", async () => {
  await assert.doesNotReject(() => burnPasswordTime("anything at all"));
});

test("a password has to be long enough and not too long, and says in words what is wrong", () => {
  assert.equal(MIN_PASSWORD_LENGTH, 10);
  assert.equal(MAX_PASSWORD_LENGTH, 200);
  assert.equal(passwordProblem("abcde1234"), "Use at least 10 characters.");
  assert.equal(passwordProblem(""), "Use at least 10 characters.");
  assert.equal(passwordProblem("abcde12345"), undefined, "ten characters is enough");
  const long = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");
  assert.equal(passwordProblem(long), undefined, "two hundred is not too many");
  assert.equal(passwordProblem(long + "a"), "Use at most 200 characters.");
});

test("the commonest passwords are refused whatever their case, and so are ones that are mostly one character", () => {
  for (const common of ["password123", "PassWord123", "1234567890", "qwertyuiop", "Admin12345", "changeme123"]) {
    assert.match(passwordProblem(common)!, /most common/, common);
  }
  assert.match(passwordProblem("aaaaaaaaaaaa")!, /repeats too few characters/);
  assert.match(passwordProblem("ababababababab")!, /repeats too few characters/);
  assert.match(passwordProblem("abcabcabcabc")!, /repeats too few characters/, "three different characters are too few");
  assert.equal(passwordProblem("abcdabcdabcd"), undefined, "four different characters are enough");
});

test("a password is not the person's email address or the first part of it, in any case", () => {
  assert.equal(passwordProblem("someone.long@example.com", "someone.long@example.com"), "The password must not be your email address.");
  assert.equal(passwordProblem("SOMEONE.LONG@Example.com", "someone.long@example.com"), "The password must not be your email address.");
  assert.equal(passwordProblem("Someone.Long", "someone.long@example.com"), "The password must not be your email address.");
  assert.equal(passwordProblem("someone.long@example.com"), undefined, "with no email given there is nothing to compare with");
  assert.equal(passwordProblem("someone.long.and.more", "someone.long@example.com"), undefined);
});

test("an ordinary passphrase has nothing wrong with it", () => {
  assert.equal(passwordProblem("correct horse battery staple", "ada@example.com"), undefined);
});

test("a hash that cannot be read, and a sign-in with no account to check, each cost the time of a real check, so the time says nothing", async () => {
  const time = async (work: () => Promise<unknown>): Promise<number> => {
    const start = performance.now();
    await work();
    return performance.now() - start;
  };
  assert.ok((await time(() => burnPasswordTime("anything"))) > 5, "a check with nothing to check against did no work");
  assert.ok((await time(() => verifyPassword("anything", "not a hash"))) > 5, "a hash that cannot be read was refused without the work");
  assert.ok((await time(() => verifyPassword("anything", ""))) > 5);
});

test("an email in capitals is compared with the password in any case too", () => {
  assert.equal(passwordProblem("someone.long@example.com", "Someone.Long@Example.com"), "The password must not be your email address.");
  assert.equal(passwordProblem("someone.long", "Someone.Long@Example.com"), "The password must not be your email address.");
});
