/**
 * What the Host settings form decides, with no DOM in it: the four limits and where each one lives, what a typed value means,
 * what a save would change (so the form can show it before it is sent), which of those changes the host asks to confirm or
 * needs a restart for, and how the server's refusals map back onto fields.
 *
 * The rules are the host's, not this screen's. packages/projects/src/host-config.ts decides what is valid (a positive number, or
 * null where null is allowed) and when an edit lands (`HOST_CONFIG_EFFECTS`), and host.ts decides that raising or removing the
 * ceiling needs a confirmation. This module mirrors the first so a typo is caught where it is typed, never sends what the host
 * would refuse, and asks the host's answer for the rest. tests/dashboard/hostsettings.test.ts reads those sources and the real
 * validator, so a rule that moves there fails here.
 *
 * It is stricter than the host in one place, on purpose: a count of turns and a number of megabytes are whole numbers. The host
 * would accept 2.5 for either, and a memory cap is handed to each project process as a command-line flag at its next start.
 */

export type Field = "spendCeilingUsd" | "maxConcurrentTurns" | "defaultUsdPerMtok" | "projectMemoryMb";
export type GroupId = "spend" | "prices" | "memory";

export interface FieldSpec {
  field: Field;
  /** The key as written in host.yaml, which is also how the host's `explicit` and `effects` name it. */
  yaml: string;
  group: GroupId;
  label: string;
  prefix?: string;
  suffix?: string;
  /** May be blank, which saves `null`: no limit. */
  nullable: boolean;
  /** Whole numbers only. */
  integer: boolean;
  /** An example in the error message, so "enter a number" shows one. */
  example: string;
  /** The built-in default in force when host.yaml does not say; null is "no limit". */
  fallback: number | null;
  /** What it does when it bites, which is the half a settings form usually leaves out. */
  what: string;
  /** What a blank box means, as a fragment that follows "Blank means"; null where a blank is refused. */
  blank: string | null;
  /** Why a blank is refused, for the one field that refuses it. */
  required?: string;
}

export const FIELDS: readonly FieldSpec[] = [
  {
    field: "spendCeilingUsd",
    yaml: "spend_ceiling_usd",
    group: "spend",
    label: "Spend ceiling",
    prefix: "$",
    suffix: "estimated, all projects",
    nullable: true,
    integer: false,
    example: "50",
    fallback: 50,
    what: "When estimated spend across every open project reaches this, the host parks all of them.",
    blank: "no ceiling, so nothing stops a run on cost",
  },
  {
    field: "maxConcurrentTurns",
    yaml: "max_concurrent_turns",
    group: "spend",
    label: "Concurrent turns",
    suffix: "turns at once",
    nullable: true,
    integer: true,
    example: "4",
    fallback: null,
    what: "The most agent turns that may run at once across every project. Past it, the host parks the newest projects and keeps the oldest running.",
    blank: "no cap on turns in flight",
  },
  {
    field: "defaultUsdPerMtok",
    yaml: "default_usd_per_mtok",
    group: "prices",
    label: "Default price",
    prefix: "$",
    suffix: "per million tokens",
    nullable: false,
    integer: false,
    example: "3",
    fallback: 3,
    what: "What a model with no price of yours and no Anthropic list price is billed at. The spend ceiling counts it.",
    blank: null,
    required: "Required: a model with no price would be billed at nothing and never reach the ceiling.",
  },
  {
    field: "projectMemoryMb",
    yaml: "project_memory_mb",
    group: "memory",
    label: "Project memory",
    suffix: "MB per project",
    nullable: true,
    integer: true,
    example: "2048",
    fallback: null,
    what: "The memory cap handed to each project process when it starts.",
    blank: "no memory cap",
  },
];

export const GROUPS: ReadonlyArray<{ id: GroupId; title: string }> = [
  { id: "spend", title: "Spend and turns" },
  { id: "prices", title: "Prices" },
  { id: "memory", title: "Memory" },
];

export const specOf = (field: Field): FieldSpec => FIELDS.find((f) => f.field === field)!;

/** The configuration as `GET /api/host/config` reports it. */
export interface HostConfigValues {
  projectMemoryMb: number | null;
  maxConcurrentTurns: number | null;
  spendCeilingUsd: number | null;
  defaultUsdPerMtok: number;
}

export type Drafts = Partial<Record<Field, string>>;

const fmtNum = (n: number): string => n.toLocaleString("en-GB", { maximumFractionDigits: 6 });

/** A value as the form's own sentences say it: "$50", "no ceiling", "2,048 MB". */
export function fmtValue(spec: FieldSpec, v: number | null): string {
  switch (spec.field) {
    case "spendCeilingUsd": return v === null ? "no ceiling" : `$${fmtNum(v)}`;
    case "maxConcurrentTurns": return v === null ? "no cap" : fmtNum(v);
    case "defaultUsdPerMtok": return v === null ? "none" : `$${fmtNum(v)} per million tokens`;
    case "projectMemoryMb": return v === null ? "no cap" : `${fmtNum(v)} MB`;
  }
}

/** What goes in the box for a value in force: nothing for "no limit", so the placeholder can say so. */
export const draftOf = (v: number | null): string => (v === null ? "" : String(v));

export type Parsed = { ok: true; value: number | null } | { ok: false; message: string };

const PLAIN_NUMBER = /^(\d+(\.\d*)?|\.\d+)$/;

/** What a typed value means. Never sends what the host's own validator would refuse. */
export function parseDraft(spec: FieldSpec, raw: string): Parsed {
  const t = raw.trim();
  if (t === "") return spec.nullable ? { ok: true, value: null } : { ok: false, message: spec.required ?? "Required." };
  const shape = spec.integer ? `Enter a whole number, like ${spec.example}.` : `Enter a number, like ${spec.example}.`;
  if (!PLAIN_NUMBER.test(t)) return { ok: false, message: shape };
  const n = Number(t);
  if (!Number.isFinite(n)) return { ok: false, message: shape };
  if (n <= 0) return { ok: false, message: spec.nullable ? "Must be above zero. Leave it blank for no limit." : "Must be above zero." };
  if (spec.integer && !Number.isInteger(n)) return { ok: false, message: shape };
  return { ok: true, value: n };
}

export type Confirm = "raise" | "remove" | null;

/**
 * The host asks before it lets the ceiling go up or away (host.ts: `from !== null && (to === null || to > from)`), and never when
 * lowering it. Mirrored here only so the form can say so before Save is pressed; the host's 409 is still what decides.
 */
export function needsConfirm(from: number | null, to: number | null): Confirm {
  if (from === null) return null;
  if (to === null) return "remove";
  return to > from ? "raise" : null;
}

export interface Change {
  field: Field;
  label: string;
  from: string;
  to: string;
  /** What is sent: a positive number, or null for "no limit". */
  value: number | null;
  /** The host will ask first. */
  confirm: Confirm;
  /** Written to host.yaml now, in force only after the host restarts. Anything the host does not call live counts. */
  restart: boolean;
}

export interface Problem { field: Field; message: string }

/**
 * What saving would do: the edits that differ from what is in force, in the form's order, and the edits that cannot be saved.
 * A box left as it was, or retyped to the same number ("50.0" for 50), is not a change.
 */
export function planSave(current: HostConfigValues, drafts: Drafts, effects: Record<string, string>): { changes: Change[]; problems: Problem[] } {
  const changes: Change[] = [];
  const problems: Problem[] = [];
  for (const spec of FIELDS) {
    const raw = drafts[spec.field];
    if (raw === undefined) continue;
    const now = current[spec.field];
    const parsed = parseDraft(spec, raw);
    if (!parsed.ok) {
      // A box that still holds what is in force is not a problem even when what is in force would not parse (a blank default price).
      if (raw.trim() !== draftOf(now)) problems.push({ field: spec.field, message: parsed.message });
      continue;
    }
    if (parsed.value === now) continue;
    changes.push({
      field: spec.field,
      label: spec.label,
      from: fmtValue(spec, now),
      to: fmtValue(spec, parsed.value),
      value: parsed.value,
      confirm: spec.field === "spendCeilingUsd" ? needsConfirm(now, parsed.value) : null,
      restart: effects[spec.yaml] !== "live",
    });
  }
  return { changes, problems };
}

/** The body of the one PUT: every changed setting, so the host takes all of them or none. */
export function savePayload(changes: readonly Change[]): Record<string, number | null> {
  const body: Record<string, number | null> = {};
  for (const c of changes) body[c.field] = c.value;
  return body;
}

/** The dialog the ceiling's confirmation shows, worded for what is being done to it. */
export function confirmCopy(c: Change): { title: string; body: string[]; confirmLabel: string } {
  const remove = c.confirm === "remove";
  return {
    title: remove ? "Remove the spend ceiling?" : "Raise the spend ceiling?",
    body: [
      remove
        ? `The ceiling is ${c.from}. Saving removes it, so nothing will stop a run on cost.`
        : `Saving raises the ceiling from ${c.from} to ${c.to}. That is more room to spend before the host parks every project.`,
      "The ceiling is the backstop against a mesh that is spending with nothing to show for it, and it does not depend on any agent noticing.",
      `Projects the host has already parked stay parked. ${remove ? "Removing" : "Raising"} the ceiling stops new parks; it does not resume anything, so reopen them yourself.`,
    ],
    confirmLabel: remove ? "Remove it" : "Raise it",
  };
}

/** The host's refusals, put back on the fields they name (`spend_ceiling_usd must be a positive number or null`). */
export function serverProblems(errors: readonly string[]): { byField: Problem[]; other: string[] } {
  const byField: Problem[] = [];
  const other: string[] = [];
  for (const message of errors) {
    const spec = FIELDS.find((f) => message.startsWith(`${f.yaml} `));
    if (spec) byField.push({ field: spec.field, message });
    else other.push(message);
  }
  return { byField, other };
}

const joinAnd = (xs: readonly string[]): string => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * The one statement about when a saved value takes effect, which the host states per key (`effects`). Said once for the form, and
 * rows say it again only where they differ. A key the host does not call live is treated as needing a restart: an unknown answer
 * must not read as "applies now".
 */
export function legend(effects: Record<string, string>): { text: string; restart: Field[] } {
  const restart = FIELDS.filter((f) => effects[f.yaml] !== "live");
  if (restart.length === 0) return { text: "Every setting here applies as soon as you save: the host enforces it on that request and on every heartbeat after.", restart: [] };
  const names = joinAnd(restart.map((f) => f.label));
  const lands = restart.length === 1 ? "it is written to host.yaml now and takes effect when the host restarts" : "they are written to host.yaml now and take effect when the host restarts";
  return {
    text: `Every setting here applies as soon as you save, except ${names}: ${lands}. This console cannot restart the host, so the command is shown after you save.`,
    restart: restart.map((f) => f.field),
  };
}

/** The line under a box about the built-in default, which is quiet information and not a warning. */
export function defaultHint(spec: FieldSpec, explicit: boolean): string {
  const fallback = fmtValue(spec, spec.fallback);
  return explicit ? `Set in host.yaml. The built-in default is ${fallback}.` : `Not set in host.yaml, so the built-in default is in force: ${fallback}.`;
}

/** Where a host is restarted. The host has no restart route; these are what the operations guide gives. */
export const RESTART_COMMANDS: ReadonlyArray<{ where: string; command: string }> = [
  { where: "Docker Compose", command: "docker compose restart mesh" },
  { where: "Kubernetes", command: "kubectl -n mesh rollout restart deployment/mesh-curule" },
];

/** What a restart costs, from the operations guide. */
export const RESTART_COST =
  "A restart discards any turn that is running, and the agent takes it again from where its session left off. The tokens that turn spent are still billed, so pause the missions first if you can.";

/** The model prices the operator set in host.yaml, as one line each. Entries that are not what the host writes are shown as unreadable, not dropped. */
export function priceLines(modelPrices: Record<string, unknown> | null | undefined, shown = 20): { lines: Array<{ model: string; text: string }>; more: number } {
  const entries = Object.entries(modelPrices ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const usd = (n: unknown): string | null => (typeof n === "number" && Number.isFinite(n) ? `$${fmtNum(n)}` : null);
  const lines = entries.slice(0, shown).map(([model, p]) => {
    const price = (p ?? {}) as Record<string, unknown>;
    const inn = usd(price.inputPerMtok);
    const out = usd(price.outputPerMtok);
    if (!inn || !out) return { model, text: "set in host.yaml, in a form this page cannot read" };
    const cacheRead = usd(price.cacheReadPerMtok);
    const cacheWrite = usd(price.cacheWritePerMtok);
    return { model, text: `${inn} in, ${out} out${cacheRead ? `, ${cacheRead} cache read` : ""}${cacheWrite ? `, ${cacheWrite} cache write` : ""}` };
  });
  return { lines, more: Math.max(0, entries.length - shown) };
}
