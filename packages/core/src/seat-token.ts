import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";

/**
 * The credential a seat presents on the MCP bridge (`/internal/mcp/:agent`).
 *
 * It used to be `meshId:agentId:shortHash(goalId)` — three values any local
 * process can read off `/health`, the event log or the dashboard — so "a
 * per-agent token the toolset verifies itself" verified nothing a caller could
 * not compute. The tag is now an HMAC keyed by a secret that exists only in
 * this process's memory: the supervisor that mints it and the bridge that
 * checks it share the process, and nothing else ever sees the key.
 *
 * Per process rather than per mesh on purpose: a restart is the one moment the
 * old tokens should stop working, and every turn mints a fresh one anyway.
 * The meshId stays readable in front so a log line still says whose it was.
 */
const SEAT_TOKEN_SECRET = randomBytes(32);

/**
 * Both ends normalise the goal the same way. The old mint hashed `"x"` when no
 * goal was active and the verifier hashed `""`, so a goalless seat's own token
 * was refused; one function on both sides makes that disagreement impossible.
 */
function seatTag(meshId: string, agentId: string, goalId: string | null | undefined): string {
  return createHmac("sha256", SEAT_TOKEN_SECRET).update(`${meshId}\n${agentId}\n${goalId ?? ""}`).digest("hex").slice(0, 32);
}

export function mintSeatToken(meshId: string, agentId: string, goalId: string | null | undefined): string {
  return `${meshId}:${agentId}:${seatTag(meshId, agentId, goalId)}`;
}

export function verifySeatToken(meshId: string, agentId: string, goalId: string | null | undefined, token: string): boolean {
  return secretsEqual(token, mintSeatToken(meshId, agentId, goalId));
}

/**
 * Constant-time string compare. Both sides are hashed to a fixed width first
 * because `timingSafeEqual` throws on a length mismatch, and that throw would
 * itself leak the length.
 */
export function secretsEqual(supplied: string, expected: string): boolean {
  const a = createHash("sha256").update(supplied, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
