/* What changed between two versions of a mesh config, in sentences, and what a save should write.
 *
 * Two jobs that share one idea: the Designer edits a PADDED copy of the file (model.ts `densure` fills every optional section so
 * the panels can read and write blindly), and a padded copy is not the file.
 *
 *  - `diffMesh` says what differs. It pads both sides the same way, so a draft the person has not touched differs from the file
 *    by nothing. It used to compare a padded draft with the raw file, which reported "7 differences" on a mesh with 7 seats and no
 *    edits (every seat gained an empty budget, session and delegation block), and it said "wiring changed" for any wire.
 *  - `savePayload` is the config to validate, preview and write. It is the file plus the person's edits, and none of the padding.
 *    Without it the first save of a scaffold wrote `server.port`, a thread budget and `runtime: stub` into a file whose author never
 *    chose them; a missing `mesh.runtime` became a stub mesh.
 *
 * DOM-free, so tests/dashboard can pin both. */

import { densure } from "./model";
import { seatIds, wiresOf } from "./edits";

type Json = any;

export type ChangeArea = "mesh" | "goal" | "seat" | "wire" | "start" | "gate" | "budget" | "policy" | "other";
export type ChangeOp = "add" | "remove" | "change";

export interface Change {
  area: ChangeArea;
  op: ChangeOp;
  /** A sentence that stands alone. */
  text: string;
  /** The seat it is about, when there is one: what the review jumps to. */
  seat?: string;
}

/* ---------------------------------------------------------------- helpers */

const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Object keys in order, recursively: two objects are equal when their canonical JSON is. */
function sortKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}
const same = (a: Json, b: Json): boolean => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/** Drop `undefined`, empty objects and empty arrays, and sort lists of plain values: absent and empty mean the same to the runtime. */
export function canonical(v: Json): Json {
  if (Array.isArray(v)) {
    const items = v.map(canonical).filter((x) => x !== undefined);
    return items.every((x) => typeof x !== "object" || x === null) ? [...items].sort() : items;
  }
  if (isObj(v)) {
    const out: Record<string, Json> = {};
    for (const k of Object.keys(v).sort()) {
      const c = canonical(v[k]);
      if (c === undefined || (Array.isArray(c) && c.length === 0) || (isObj(c) && Object.keys(c).length === 0)) continue;
      out[k] = c;
    }
    return out;
  }
  return v;
}

/** Whether two configs mean the same thing: padding, key order, empty blocks and list order do not count. */
export function sameMesh(a: Json, b: Json): boolean {
  return same(canonical(padded(a)), canonical(padded(b)));
}

function padded(raw: Json): Json {
  const c = clone(raw ?? {});
  densure(c);
  return c;
}

const clip = (s: string, n = 60): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const q = (s: unknown): string => `“${clip(String(s ?? ""))}”`;
const num = (n: number): string => n.toLocaleString("en-US");

/** A value as a person would read it in a sentence. */
function show(v: Json): string {
  if (v === undefined || v === null) return "not set";
  if (typeof v === "string") return v === "" ? "empty" : q(v);
  if (typeof v === "number") return num(v);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ") : "none";
  return clip(JSON.stringify(sortKeys(v)), 80);
}

const names = (xs: string[]): string => (xs.length ? xs.join(", ") : "none");
const strs = (v: Json): string[] => (Array.isArray(v) ? v.map(String) : []);
const added = (before: string[], after: string[]): string[] => after.filter((x) => !before.includes(x));

/** "added x; removed y" for two lists treated as sets. */
function setChange(before: string[], after: string[]): string {
  const a = added(before, after);
  const r = added(after, before);
  return [a.length ? `added ${names(a)}` : "", r.length ? `removed ${names(r)}` : ""].filter(Boolean).join("; ");
}

/* ---------------------------------------------------------------- the diff */

/** What the seat's own fields are called on screen, so a line reads like the inspector does. */
const SEAT_FIELD: Record<string, string> = {
  role: "role", model: "model", runtime: "runtime", variant: "thinking variant", mode: "mode", prompt: "prompt file",
  context_window: "context window",
};
const SEAT_LIST: Record<string, string> = { capabilities: "tools", authority: "authority", interests: "wake events" };
const SEAT_BUDGET: Record<string, string> = {
  tokens: "token budget", max_activations: "activation limit", wall_clock_minutes: "time limit in minutes", max_events: "event limit",
};
const MISSION_KEY: Record<string, string> = { tokens: "tokens", wall_clock_minutes: "minutes", max_events: "events" };
const ESCALATION: Record<string, string> = {
  "thread.max_depth": "reply-chain depth", "repeated_conflict.threshold": "repeated clashes", "artifact_review_rounds.max": "re-review rounds",
};

/** One line per leaf that differs between two trees nothing else described: `path: before to after`. */
function leaves(before: Json, after: Json, path: string[], out: Array<{ path: string[]; from: Json; to: Json }>): void {
  // A block that exists on one side only is walked too, so "session was added" is reported as the setting inside it.
  if ((isObj(before) || isObj(after)) && (isObj(before) || before === undefined) && (isObj(after) || after === undefined)) {
    const b = isObj(before) ? before : {};
    const a = isObj(after) ? after : {};
    for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) leaves(b[k], a[k], [...path, k], out);
    return;
  }
  if (!same(before, after)) out.push({ path, from: before, to: after });
}

/**
 * Every difference between `base` (the file) and `cur` (the draft), grouped the way the review reads: the mesh and its goal, the
 * seats, who may message whom, what starts, the gates, the budgets, the policy, and anything else. Empty when there is no `base`:
 * a mesh with no file has nothing to differ from.
 */
export function diffMesh(cur: Json, base: Json | null): Change[] {
  if (!base) return [];
  const a = canonical(padded(base)) as Json;
  const b = canonical(padded(cur)) as Json;
  const out: Change[] = [];
  const push = (area: ChangeArea, op: ChangeOp, text: string, seat?: string): void => { out.push({ area, op, text, ...(seat ? { seat } : {}) }); };
  // Each section takes what it describes out of these copies; whatever is left is described generically at the end.
  const ra = clone(a);
  const rb = clone(b);

  /* ---- the mesh itself ---- */
  const ma = a.mesh ?? {};
  const mb = b.mesh ?? {};
  if (ma.id !== mb.id) push("mesh", "change", `Mesh id changed from ${q(ma.id)} to ${q(mb.id)}.`);
  if (ma.name !== mb.name) push("mesh", "change", `Name changed from ${show(ma.name)} to ${show(mb.name)}.`);
  if (ma.goal !== mb.goal) push("goal", "change", `Goal changed from ${show(ma.goal)} to ${show(mb.goal)}.`);
  const critA = new Map<string, Json>((ma.acceptance_criteria ?? []).map((c: Json) => [String(c.id), c]));
  const critB = new Map<string, Json>((mb.acceptance_criteria ?? []).map((c: Json) => [String(c.id), c]));
  for (const [id, c] of critB) {
    const was = critA.get(id);
    if (!was) push("goal", "add", `Added the done-when check ${id}: ${show(c.description)}.`);
    else if (!same(was, c)) push("goal", "change", `Changed the done-when check ${id}.`);
  }
  for (const id of critA.keys()) if (!critB.has(id)) push("goal", "remove", `Removed the done-when check ${id}.`);
  for (const k of ["id", "name", "goal", "acceptance_criteria"]) { delete ra.mesh?.[k]; delete rb.mesh?.[k]; }

  /* ---- seats ---- */
  const sa: Record<string, Json> = a.agents ?? {};
  const sb: Record<string, Json> = b.agents ?? {};
  for (const id of Object.keys(sb)) if (!sa[id]) push("seat", "add", `Added seat ${id} (${sb[id].role ?? "no role"}).`, id);
  for (const id of Object.keys(sa)) if (!sb[id]) push("seat", "remove", `Removed seat ${id}.`, id);
  for (const id of Object.keys(sb).filter((x) => sa[x])) {
    const x = sa[id];
    const y = sb[id];
    for (const [k, label] of Object.entries(SEAT_FIELD)) {
      if (x[k] !== y[k]) { push("seat", "change", `${id}: ${label} changed from ${show(x[k])} to ${show(y[k])}.`, id); }
    }
    for (const [k, label] of Object.entries(SEAT_LIST)) {
      if (!same(x[k], y[k])) push("seat", "change", `${id}: ${label} ${setChange(strs(x[k]), strs(y[k]))}.`, id);
    }
    for (const [k, label] of Object.entries(SEAT_BUDGET)) {
      if (x.budget?.[k] !== y.budget?.[k]) push("seat", "change", `${id}: ${label} changed from ${show(x.budget?.[k])} to ${show(y.budget?.[k])}.`, id);
    }
    for (const k of [...Object.keys(SEAT_FIELD), ...Object.keys(SEAT_LIST)]) { delete ra.agents?.[id]?.[k]; delete rb.agents?.[id]?.[k]; }
    if (ra.agents?.[id]) for (const k of Object.keys(SEAT_BUDGET)) { delete ra.agents[id].budget?.[k]; delete rb.agents?.[id]?.budget?.[k]; }
  }
  for (const id of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    if (!sa[id] || !sb[id]) { delete ra.agents?.[id]; delete rb.agents?.[id]; }
  }

  /* ---- wires: one line per sender, counting both the sender's list and a recipient's grant ---- */
  const wa = wiresOf(padded(base));
  const wb = wiresOf(padded(cur));
  const key = (w: { src: string; tgt: string }): string => `${w.src}\u0000${w.tgt}`;
  const had = new Set(wa.map(key));
  const has = new Set(wb.map(key));
  // A removed seat takes its own wires with it: those are part of "Removed seat", not a second sentence.
  const gone = new Set(Object.keys(sa).filter((x) => !sb[x]));
  const senders = [...new Set([...wa, ...wb].map((w) => w.src))].filter((s) => !gone.has(s));
  for (const src of senders) {
    const on = wb.filter((w) => w.src === src && !had.has(key(w))).map((w) => w.tgt);
    const off = wa.filter((w) => w.src === src && !has.has(key(w)) && !gone.has(w.tgt)).map((w) => w.tgt);
    if (on.length) push("wire", "add", `${src} may now message ${names(on)}.`, src);
    if (off.length) push("wire", "remove", `${src} may no longer message ${names(off)}.`, src);
  }
  // Grants and lists are described as wires; keep whatever else lives under communication for the generic pass.
  for (const tree of [ra, rb]) {
    for (const p of Object.values(tree.policies?.communication ?? {}) as Json[]) { delete p.may_contact; delete p.may_be_contacted_by; }
  }
  for (const tree of [ra, rb]) if (tree.policies?.communication && !Object.keys(tree.policies.communication).length) delete tree.policies.communication;

  /* ---- what starts with the mission ---- */
  const startA = strs(a.startup?.activate);
  const startB = strs(b.startup?.activate);
  const startOn = added(startA, startB);
  const startOff = added(startB, startA).filter((x) => !gone.has(x));
  if (startOn.length) push("start", "add", `${names(startOn)} now ${startOn.length === 1 ? "starts" : "start"} with the mission.`, startOn[0]);
  if (startOff.length) push("start", "remove", `${names(startOff)} no longer ${startOff.length === 1 ? "starts" : "start"} with the mission.`, startOff[0]);
  delete ra.startup?.activate; delete rb.startup?.activate;

  /* ---- gates ---- */
  const ga: Record<string, Json> = a.policies?.transitions ?? {};
  const gb: Record<string, Json> = b.policies?.transitions ?? {};
  for (const g of Object.keys(gb)) {
    if (!ga[g]) push("gate", "add", `Added the gate ${g}, which requires ${names(strs(gb[g]?.requires))}.`);
    else if (!same(ga[g], gb[g])) push("gate", "change", `The gate ${g} now requires ${names(strs(gb[g]?.requires))} (it required ${names(strs(ga[g]?.requires))}).`);
  }
  for (const g of Object.keys(ga)) if (!gb[g]) push("gate", "remove", `Removed the gate ${g}.`);
  delete ra.policies?.transitions; delete rb.policies?.transitions;

  /* ---- budgets ---- */
  for (const k of Object.keys(MISSION_KEY)) {
    const x = a.budgets?.mission?.[k];
    const y = b.budgets?.mission?.[k];
    if (x !== y) push("budget", "change", `Mission budget: ${MISSION_KEY[k]} changed from ${show(x)} to ${show(y)}.`);
    delete ra.budgets?.mission?.[k]; delete rb.budgets?.mission?.[k];
  }
  for (const scope of ["thread", "task"] as const) {
    if (a.budgets?.[scope]?.tokens !== b.budgets?.[scope]?.tokens) {
      push("budget", "change", `${scope === "thread" ? "Thread" : "Task"} budget: tokens changed from ${show(a.budgets?.[scope]?.tokens)} to ${show(b.budgets?.[scope]?.tokens)}.`);
    }
    delete ra.budgets?.[scope]?.tokens; delete rb.budgets?.[scope]?.tokens;
  }
  const capA: Record<string, number> = a.budgets?.agent ?? {};
  const capB: Record<string, number> = b.budgets?.agent ?? {};
  for (const id of new Set([...Object.keys(capA), ...Object.keys(capB)])) {
    if (gone.has(id) || capA[id] === capB[id]) continue;
    push("budget", "change", `${id}: budget cap changed from ${show(capA[id])} to ${show(capB[id])}.`, sb[id] ? id : undefined);
  }
  delete ra.budgets?.agent; delete rb.budgets?.agent;

  /* ---- policy ---- */
  for (const [path, label] of Object.entries(ESCALATION)) {
    const [g, k] = path.split(".") as [string, string];
    const x = a.policies?.escalation?.[g]?.[k];
    const y = b.policies?.escalation?.[g]?.[k];
    if (x !== y) push("policy", "change", `Escalation: ${label} changed from ${show(x)} to ${show(y)}.`);
    delete ra.policies?.escalation?.[g]?.[k]; delete rb.policies?.escalation?.[g]?.[k];
  }
  const ruleA = new Map<string, Json>((a.policies?.rules ?? []).map((r: Json, i: number) => [String(r.id ?? `#${i + 1}`), r]));
  const ruleB = new Map<string, Json>((b.policies?.rules ?? []).map((r: Json, i: number) => [String(r.id ?? `#${i + 1}`), r]));
  for (const [id, r] of ruleB) {
    if (!ruleA.has(id)) push("policy", "add", `Added the policy rule ${id}.`);
    else if (!same(ruleA.get(id), r)) push("policy", "change", `Changed the policy rule ${id}.`);
  }
  for (const id of ruleA.keys()) if (!ruleB.has(id)) push("policy", "remove", `Removed the policy rule ${id}.`);
  delete ra.policies?.rules; delete rb.policies?.rules;

  /* ---- everything else, by path, so nothing a person changed goes unmentioned ---- */
  const rest: Array<{ path: string[]; from: Json; to: Json }> = [];
  leaves(canonical(ra), canonical(rb), [], rest);
  const byTop = new Map<string, typeof rest>();
  for (const l of rest) byTop.set(l.path[0] ?? "", [...(byTop.get(l.path[0] ?? "") ?? []), l]);
  for (const [top, ls] of byTop) {
    if (ls.length > 4) { push("other", "change", `${top}: ${ls.length} settings changed.`); continue; }
    for (const l of ls) {
      const op: ChangeOp = l.from === undefined ? "add" : l.to === undefined ? "remove" : "change";
      const seat = l.path[0] === "agents" && l.path[1] && seatIds(b).includes(l.path[1]) ? l.path[1] : undefined;
      const where = seat ? `${seat}: ${l.path.slice(2).join(".")}` : l.path.join(".");
      const text = op === "add" ? `${where} is now ${show(l.to)}.` : op === "remove" ? `${where} was cleared (it was ${show(l.from)}).` : `${where} changed from ${show(l.from)} to ${show(l.to)}.`;
      push(l.path[0] === "agents" ? "seat" : "other", op, text, seat);
    }
  }
  return out;
}

/** The same differences as bare sentences, for the places that show a list and nothing else. */
export function summarizeDiff(cur: Json, base: Json | null): string[] {
  return diffMesh(cur, base).map((c) => c.text);
}

/* ---------------------------------------------------------------- the save payload */

/**
 * The config to validate, preview and write: the file plus what the person changed.
 *
 * A key the draft holds exactly as the padded file would is the file's own (or padding, and then it is left out). A key that
 * differs is taken from the draft; a key the draft no longer has is gone. An empty block is dropped only where the file had none:
 * a person who clears a seat's last tool gets `capabilities: []` where the file had a list, and no `budget: {}` where it had no budget.
 * With no file there is nothing to leave alone, and the draft is written as it is.
 */
export function savePayload(cur: Json, base: Json | null): Json {
  if (!base) return clone(cur);
  const pad = padded(base);
  const walk = (c: Json, p: Json, b: Json, hasBase: boolean): Json => {
    if (!isObj(c)) return clone(c);
    const out: Record<string, Json> = {};
    for (const k of Object.keys(c)) {
      const baseHas = hasBase && isObj(b) && k in b;
      const baseVal = baseHas ? b[k] : undefined;
      const padVal = isObj(p) ? p[k] : undefined;
      if (same(c[k], padVal)) {
        if (baseHas) out[k] = clone(baseVal);
        continue;
      }
      if (isObj(c[k])) {
        const next = walk(c[k], padVal, baseVal, baseHas);
        if (!baseHas && Object.keys(next).length === 0) continue;
        out[k] = next;
      } else out[k] = clone(c[k]);
    }
    return out;
  };
  return walk(cur, pad, base, true);
}
