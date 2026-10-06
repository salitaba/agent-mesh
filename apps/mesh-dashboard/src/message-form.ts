/**
 * The Message drawer's form without the DOM: who a message goes to, and what each kind of message is called. DOM-free, so the
 * rules can be tested.
 *
 * "To" stays one text field, so a person who knows the names, and the scripts that drive the drawer, can type "pm, qa". The chips
 * under it add and take out a seat's name in that same text, and show which seats the text names, however it was written.
 */
import { MESSAGE_PLAIN } from "./format";

/** The seat a typed name means: the seat with that id, or, when exactly one seat has it in another case, that one. */
function seatNamed(name: string, seats: readonly string[]): string | undefined {
  if (seats.includes(name)) return name;
  const folded = seats.filter((s) => s.toLowerCase() === name.toLowerCase());
  return folded.length === 1 ? folded[0] : undefined;
}

/**
 * The recipients a comma list names, in the order written, each once. A seat's name is its id whatever case it was typed in (the
 * server knows "pm", not "PM"); a name that is no seat's is kept as typed, so the server can say it does not know it.
 */
export function recipientsOf(text: string, seats: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(",")) {
    const name = part.trim();
    if (!name) continue;
    const seat = seatNamed(name, seats);
    const key = seat ?? name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(seat ?? name);
  }
  return out;
}

/** The field's text with a seat added at the end, or taken out when it is there; everything else typed is kept, tidied. */
export function toggleRecipient(text: string, seat: string, seats: readonly string[]): string {
  const now = recipientsOf(text, seats);
  return (now.includes(seat) ? now.filter((n) => n !== seat) : [...now, seat]).join(", ");
}

/**
 * What a kind of message is called in the drawer's list, the way the console names it everywhere else (ledger.ts `msgKind`): the
 * plain words, with the protocol's own name left to the option's title. It used to lead with both: "update (INFORM)".
 */
export function messageTypeLabel(type: string): string {
  return MESSAGE_PLAIN[type] ?? type.replace(/[_.]+/g, " ").trim().toLowerCase();
}
