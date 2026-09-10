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

/**
 * Project identity slug. Must match `project.id` in mesh.schema.json:
 * `^[a-z0-9][a-z0-9-]{1,62}$` — 2..63 chars, lowercase alphanumerics and
 * hyphens, not hyphen-initial. Git-committable and stable across folder moves,
 * so it is the registry's key rather than a path.
 */
export const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

/**
 * Derive a valid project id from arbitrary text (in practice a directory
 * name). Total: every input yields a usable id, because the fallback path
 * exists precisely for `mesh.yaml` files that predate `project.id` and must
 * still boot.
 */
export function toProjectId(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    // Slicing can re-expose a trailing hyphen.
    .replace(/-+$/g, "");
  // "", "." and "_" all slug to empty; a single char fails the 2-char minimum.
  // Hash rather than a constant so two unnameable folders do not collide.
  if (slug.length < 2) return `project-${shortHash(input).slice(0, 8)}`;
  return slug;
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
