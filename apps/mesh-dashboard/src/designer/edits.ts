/* Seat and wire edits on the draft model, as plain functions.
 *
 * These used to live inside the Designer component as closures over React state, which made the one thing in this file that
 * carries a correctness claim untestable: a seat is referred to from many places (wires, the start list, budgets, policy
 * rules, triage rules), and an edit that forgets one of them saves a mesh that will not boot. Rename once saved a config whose
 * policy rule still named the old seat, and config load refuses a rule whose actor does not exist.
 *
 * Every function mutates the model it is given, in place, because that is how the draft is held (storage.ts commits a new
 * wrapper around the same object). The caller owns the undo snapshot and the re-render. DOM-free so tests/dashboard can pin
 * the cascades. */

type Model = any;

/**
 * One directed wire: `src` may start a thread with `tgt`.
 *
 * The runtime allows a contact when EITHER side names the other (policy-engine `communicationAllows`): the sender lists the
 * recipient in `may_contact`, or the recipient lists the sender in `may_be_contacted_by`. The second is a grant that adds a
 * route and never removes one. The canvas draws both, because a wire that exists and is not drawn is a wire nobody can find.
 */
export interface Wire {
  src: string;
  tgt: string;
  /** Named in the sender's `may_contact`. */
  declared: boolean;
  /** Named in the recipient's `may_be_contacted_by`. */
  granted: boolean;
}

/** What a delete left behind that the person has to look at: references that name the seat and were blanked, not removed. */
export interface Dangling { rules: number; triage: number }

export const seatIds = (m: Model): string[] => Object.keys(m?.agents ?? {});

const list = (m: Model, id: string, key: "may_contact" | "may_be_contacted_by"): string[] =>
  (m.policies?.communication?.[id]?.[key] ?? []) as string[];

/** Every directed wire, once, between seats that exist. */
export function wiresOf(m: Model): Wire[] {
  const byKey = new Map<string, Wire>();
  const note = (src: string, tgt: string, how: "declared" | "granted"): void => {
    if (src === tgt || !m.agents?.[src] || !m.agents?.[tgt]) return;
    const key = `${src}\u0000${tgt}`;
    const w = byKey.get(key) ?? { src, tgt, declared: false, granted: false };
    w[how] = true;
    byKey.set(key, w);
  };
  for (const id of seatIds(m)) {
    for (const tgt of list(m, id, "may_contact")) note(id, tgt, "declared");
    for (const src of list(m, id, "may_be_contacted_by")) note(src, id, "granted");
  }
  return [...byKey.values()];
}

/** Whether `src` may start a thread with `tgt`, by either route. */
export function hasWire(m: Model, src: string, tgt: string): boolean {
  return list(m, src, "may_contact").includes(tgt) || list(m, tgt, "may_be_contacted_by").includes(src);
}

/**
 * Set one wire on or off. Returns whether the model changed. A seat cannot message itself.
 *
 * On adds the sender's `may_contact` entry. Off removes the wire by both routes, so a cut wire is gone and not merely hidden
 * behind a grant the person never saw.
 */
export function setWire(m: Model, src: string, tgt: string, on: boolean): boolean {
  if (src === tgt || !m.agents?.[src] || !m.agents?.[tgt]) return false;
  if (hasWire(m, src, tgt) === on) return false;
  m.policies ||= {};
  m.policies.communication ||= {};
  if (on) {
    m.policies.communication[src] ||= { may_contact: [] };
    m.policies.communication[src].may_contact = [...new Set([...list(m, src, "may_contact"), tgt])];
    return true;
  }
  if (m.policies.communication[src]?.may_contact) {
    m.policies.communication[src].may_contact = list(m, src, "may_contact").filter((x) => x !== tgt);
  }
  if (m.policies.communication[tgt]?.may_be_contacted_by) {
    const left = list(m, tgt, "may_be_contacted_by").filter((x) => x !== src);
    if (left.length) m.policies.communication[tgt].may_be_contacted_by = left;
    else delete m.policies.communication[tgt].may_be_contacted_by;
  }
  return true;
}

/** Flip a seat's own `may_contact` entry for one recipient (the inspector's chip). Returns the new state. */
export function toggleContact(m: Model, src: string, tgt: string): boolean {
  m.policies ||= {};
  m.policies.communication ||= {};
  m.policies.communication[src] ||= { may_contact: [] };
  const l = new Set<string>(list(m, src, "may_contact"));
  const on = !l.has(tgt);
  if (on) l.add(tgt); else l.delete(tgt);
  m.policies.communication[src].may_contact = [...l];
  return on;
}

/** Flip one grant in a seat's `may_be_contacted_by`. Returns the new state; an emptied list is removed, not left as `[]`. */
export function toggleGrant(m: Model, id: string, sender: string): boolean {
  m.policies ||= {};
  m.policies.communication ||= {};
  m.policies.communication[id] ||= {};
  const l = new Set<string>(list(m, id, "may_be_contacted_by"));
  const on = !l.has(sender);
  if (on) l.add(sender); else l.delete(sender);
  if (l.size) m.policies.communication[id].may_be_contacted_by = [...l];
  else delete m.policies.communication[id].may_be_contacted_by;
  return on;
}

/** A seat id that is not taken: `seat-1`, `seat-2`, ... or `<base>-1` for a copy. */
export function freeSeatId(m: Model, base = "seat"): string {
  let i = 1;
  while (m.agents?.[`${base}-${i}`]) i++;
  return `${base}-${i}`;
}

/** What a new id may be: lowercase letters, digits and hyphens. Existing ids are never forced into this shape. */
export const SEAT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export type IdProblem = "empty" | "taken" | "shape";

/** Why `next` cannot be this seat's new id, or null when it can. */
export function seatIdProblem(m: Model, current: string, next: string): IdProblem | null {
  const id = next.trim();
  if (!id) return "empty";
  if (id !== current && m.agents?.[id]) return "taken";
  if (id !== current && !SEAT_ID_PATTERN.test(id)) return "shape";
  return null;
}

/** A seat with nothing in it but a name to change. The role is required by the schema, so it starts as a placeholder. */
export function blankSeat(m: Model): { role: string; capabilities: string[]; authority: string[]; interests: string[] } {
  const n = seatIds(m).length + 1;
  return { role: `role-${n}`, capabilities: [], authority: [], interests: [] };
}

/** Whether a role is still the one `blankSeat` made: valid for the schema, and says nothing about what the seat is for. */
export const isPlaceholderRole = (role: unknown): boolean => /^role-\d+$/.test(String(role ?? "").trim());

/** Add a seat (a blank one unless a preset is given) and return its id. */
export function addSeat(m: Model, preset?: Model): string {
  const id = freeSeatId(m);
  m.agents ||= {};
  m.agents[id] = preset ? JSON.parse(JSON.stringify(preset)) : blankSeat(m);
  return id;
}

/** Copy a seat: its definition and what it may message, not who may message it. Returns the new id. */
export function duplicateSeat(m: Model, id: string): string | null {
  if (!m.agents?.[id]) return null;
  const nid = freeSeatId(m, id);
  m.agents[nid] = JSON.parse(JSON.stringify(m.agents[id]));
  const own = m.policies?.communication?.[id];
  if (own) {
    const copy = JSON.parse(JSON.stringify(own));
    // A grant names who may reach the original; the copy has not been introduced to anyone.
    delete copy.may_be_contacted_by;
    m.policies.communication[nid] = copy;
  }
  return nid;
}

/**
 * Remove a seat and everything that points at it: wires both ways, the start list, its budget line. Policy rules and triage
 * rules that name it are blanked rather than deleted, so validation stops the save and says which rule, instead of the rule
 * quietly disappearing. Gate requirements are left alone: they name an id or a role, and the role usually survives.
 */
export function removeSeat(m: Model, id: string): Dangling {
  const dangling: Dangling = { rules: 0, triage: 0 };
  if (!m.agents?.[id]) return dangling;
  delete m.agents[id];
  for (const p of Object.values(m.policies?.communication ?? {}) as any[]) {
    if (p.may_contact) p.may_contact = p.may_contact.filter((x: string) => x !== id);
    if (p.may_be_contacted_by) {
      p.may_be_contacted_by = p.may_be_contacted_by.filter((x: string) => x !== id);
      if (!p.may_be_contacted_by.length) delete p.may_be_contacted_by;
    }
  }
  if (m.policies?.communication) delete m.policies.communication[id];
  if (m.startup) m.startup.activate = (m.startup.activate || []).filter((x: string) => x !== id);
  if (m.budgets?.agent) delete m.budgets.agent[id];
  for (const r of m.policies?.rules ?? []) if (r.when?.actor === id) { r.when.actor = ""; dangling.rules++; }
  for (const t of m.scheduling?.triage?.rules ?? []) if (t.agent === id) { t.agent = ""; dangling.triage++; }
  return dangling;
}

/**
 * Give a seat a new id everywhere it is named. Returns false, and changes nothing, when the new id is empty, unchanged or
 * taken. A policy rule's `when.actor` is rewritten because a stale one is fatal (config load refuses an actor that does not
 * exist); `when.to` is rewritten too, though a stale one only warns, because a renamed seat is still the seat the author meant.
 */
export function renameSeat(m: Model, old: string, next: string): boolean {
  const nn = next.trim();
  if (!old || !nn || nn === old || !m.agents?.[old] || m.agents[nn]) return false;
  // Rebuild the map so the seat keeps its place in the list instead of jumping to the end.
  const agents: Record<string, any> = {};
  for (const [k, v] of Object.entries(m.agents)) agents[k === old ? nn : k] = v;
  m.agents = agents;
  const comm = m.policies?.communication;
  if (comm) {
    const rebuilt: Record<string, any> = {};
    for (const [k, p] of Object.entries(comm) as Array<[string, any]>) {
      if (p.may_contact) p.may_contact = p.may_contact.map((x: string) => (x === old ? nn : x));
      if (p.may_be_contacted_by) p.may_be_contacted_by = p.may_be_contacted_by.map((x: string) => (x === old ? nn : x));
      rebuilt[k === old ? nn : k] = p;
    }
    m.policies.communication = rebuilt;
  }
  if (m.startup) m.startup.activate = (m.startup.activate || []).map((x: string) => (x === old ? nn : x));
  if (m.budgets?.agent?.[old] !== undefined) {
    m.budgets.agent[nn] = m.budgets.agent[old];
    delete m.budgets.agent[old];
  }
  for (const r of m.policies?.rules ?? []) {
    if (r.when?.actor === old) r.when.actor = nn;
    if (r.when?.to === old) r.when.to = nn;
  }
  for (const r of m.scheduling?.triage?.rules ?? []) if (r.agent === old) r.agent = nn;
  return true;
}

export interface GateHolder {
  /** One `|` alternative of the requirement, as written. */
  alternative: string;
  /** The part before the last dot: a seat id or a role. */
  actor: string;
  /** The seats that answer to that id or role. Empty means nobody can give this approval. */
  seats: string[];
}

/**
 * Who can stand for a gate requirement. A requirement is `<seat-id-or-role>.<kind>` (`tech-lead.approve`), and `a|b` means any one of
 * them will do. The actor is matched against seat ids and roles, which is what the server checks too ("no agent has id or role ...").
 * It is NOT matched against a seat's `authority` list: authority is `<domain>.<verb>` (`implementation.approve`), a different vocabulary,
 * and reading one as the other showed "nobody grants it" in red on every gate that was wired correctly.
 */
export function gateHolders(m: Model, requirement: string): GateHolder[] {
  return requirement.split("|").map((alt) => alternativeOf(m, alt.trim())).filter((h) => h.alternative !== "");
}

function alternativeOf(m: Model, alternative: string): GateHolder {
  const dot = alternative.lastIndexOf(".");
  const actor = dot > 0 ? alternative.slice(0, dot) : alternative;
  const seats = seatIds(m).filter((id) => id === actor || m.agents[id]?.role === actor);
  return { alternative, actor, seats };
}

/** Whether the seat starts with the mission. */
export function startsWithMission(m: Model, id: string): boolean {
  return ((m.startup?.activate ?? []) as string[]).includes(id);
}

/** Flip whether a seat starts with the mission. Returns the new state. */
export function toggleStart(m: Model, id: string): boolean {
  m.startup ||= { activate: [] };
  const l = new Set<string>(m.startup.activate || []);
  const on = !l.has(id);
  if (on) l.add(id); else l.delete(id);
  m.startup.activate = [...l];
  return on;
}
