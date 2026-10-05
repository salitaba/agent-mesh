/**
 * Passwords: hashed with scrypt, compared in constant time, and checked against the few rules that matter.
 *
 * The hash is stored as `scrypt$N$r$p$salt$hash` so the parameters travel with it and can be raised later without a migration:
 * a stored hash is verified with the parameters it was made with. `verifyPassword` takes the same time for a stored hash that
 * is malformed as for one that is wrong, and a caller with no account to check against uses `burnPasswordTime`, so the time a
 * sign-in takes does not say whether an email has an account.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 32_768;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const MAX_MEMORY = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, n: number, r: number, p: number, length: number): Promise<Buffer> {
  const options: ScryptOptions = { N: n, r, p, maxmem: MAX_MEMORY };
  return new Promise((resolve, reject) => scrypt(password.normalize("NFKC"), salt, length, options, (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P, KEY_LENGTH);
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Does `password` match the stored hash? False for a hash it cannot read, after the same work as for a wrong password. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  const [scheme, n, r, p, salt, hash] = parts;
  const params = [n, r, p].map(Number);
  const readable = parts.length === 6 && scheme === "scrypt" && params.every((v) => Number.isInteger(v) && v > 0 && v <= 1 << 20) && !!salt && !!hash;
  if (!readable) {
    await derive(password, Buffer.alloc(16), N, R, P, KEY_LENGTH);
    return false;
  }
  const expected = Buffer.from(hash!, "base64url");
  let actual: Buffer;
  try {
    actual = await derive(password, Buffer.from(salt!, "base64url"), params[0]!, params[1]!, params[2]!, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** The work of a check, for a sign-in that has no account to check against. */
export async function burnPasswordTime(password: string): Promise<void> {
  await derive(password, Buffer.alloc(16), N, R, P, KEY_LENGTH);
}

const COMMON = new Set([
  "password",
  "password1",
  "password12",
  "password123",
  "passw0rd123",
  "qwertyuiop",
  "1234567890",
  "12345678910",
  "0123456789",
  "iloveyou12",
  "letmein1234",
  "welcome1234",
  "admin12345",
  "changeme123",
  "qwerty12345",
  "abcdefghij",
  "1q2w3e4r5t",
  "trustno1234",
]);

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 200;

/** What is wrong with a password, in words for the person choosing it, or undefined when nothing is. */
export function passwordProblem(password: string, email = ""): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return "That password is one of the most common ones. Choose another.";
  if (new Set(password).size < 4) return "That password repeats too few characters. Choose another.";
  if (email !== "" && (lower === email.toLowerCase() || lower === email.split("@")[0]!.toLowerCase())) return "The password must not be your email address.";
  return undefined;
}
