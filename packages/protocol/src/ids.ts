import { randomBytes, randomUUID, createHash } from "crypto";

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function monotonicId(prefix: string): string {
  const now = BigInt(Date.now()) * 1024n + BigInt(counterTick() % 1024);
  let n = now;
  let enc = "";
  for (let i = 0; i < 10; i++) {
    enc = BASE32[Number(n & 31n)] + enc;
    n >>= 5n;
  }
  const rand = randomBytes(5).toString("hex");
  return `${prefix}-${enc}${rand}`;
}

let last = 0;
let tick = 0;
function counterTick(): number {
  const t = process.hrtime.bigint() % 1000n;
  const v = Number(t);
  if (v === last) {
    tick++;
  } else {
    last = v;
    tick = 0;
  }
  return tick;
}

export function newMessageId(): string {
  return monotonicId("msg");
}
export function newEventId(): string {
  return monotonicId("evt");
}
export function newGoalId(): string {
  return monotonicId("goal");
}
export function newThreadId(): string {
  return monotonicId("thread");
}
export function newArtifactId(): string {
  return monotonicId("art");
}
export function newTaskId(): string {
  return monotonicId("task");
}
export function newDecisionId(): string {
  return monotonicId("decision");
}
export function newEscalationId(): string {
  return monotonicId("esc");
}
export function newLeaseId(): string {
  return monotonicId("lease");
}
export function newAgentSessionId(): string {
  return randomUUID();
}

export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortDeep((value as Record<string, unknown>)[key]);
  }
  return out;
}

export function digestOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}
