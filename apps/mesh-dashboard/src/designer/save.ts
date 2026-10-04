/* What a save does, and what it leaves to do. DOM-free, so tests/dashboard can pin every sentence a person is told about it.
 *
 * mesh.yaml is a seed, not a mirror. The mission reads it once, when it boots: seats and budgets are reconciled from it on every
 * boot, the goal is minted only when the mission is not resuming. A save therefore writes the file and does nothing else. The server
 * says what the live mission could be brought in line with (`drift.mutations`, applied through the same route the assistant's live
 * changes use) and what it cannot (`drift.problems`: a changed seat definition, a retired seat, the token cap). This module sorts
 * those into what the person can do about each, and describes the result of applying them, so the page never says a thing happened
 * that did not. */

import type { StagedMutation } from "@mesh/protocol";

export interface Drift {
  mutations: StagedMutation[];
  problems: string[];
}

export interface DriftReport {
  /** Live changes the apply route can make now. */
  apply: StagedMutation[];
  /** What only a restart carries, in the server's own words. */
  restart: string[];
  /** What nothing can carry from here, or only informs: the token cap, a section the file does not declare. */
  notes: string[];
  /** No mission is running, so the file is simply what the next boot reads. */
  noMission: boolean;
  /** Nothing differs: the running mission already matches the file. */
  inLine: boolean;
}

/** Sort the server's drift proposal by what can be done about each part. */
export function classifyDrift(drift: Drift | null | undefined): DriftReport {
  const apply = drift?.mutations ?? [];
  const problems = drift?.problems ?? [];
  const noMission = problems.some((p) => /no active mission/i.test(p));
  const rest = problems.filter((p) => !/no active mission/i.test(p));
  const restart = rest.filter((p) => /restart/i.test(p));
  const notes = rest.filter((p) => !/restart/i.test(p));
  return { apply, restart, notes, noMission, inLine: apply.length === 0 && restart.length === 0 && notes.length === 0 && !noMission };
}

/** A plain reading of one line of the apply route's report. */
/**
 * Whether a mesh file is the shipped scripted demo. The product clears that one mesh's state at every start (apps/mesh-server/src/demo.ts: the id
 * `demo-stub` and every seat on the stub runtime), so restarting it is a new run and not a resumed one: the goal and the done-when checks are read
 * from the file again and the progress so far is gone. Any other mesh resumes, and keeps the goal it has.
 */
export function isScriptedDemo(file: any): boolean {
  const seats = Object.values<any>(file?.agents ?? {});
  const fallback = file?.mesh?.runtime?.default;
  return file?.mesh?.id === "demo-stub" && seats.length > 0 && seats.every((a) => (a?.runtime ?? fallback) === "stub");
}

export interface ApplyLine { kind: string; ok: boolean; detail: string }

export interface ApplyOutcome {
  ok: boolean;
  applied: number;
  total: number;
  lines: ApplyLine[];
  /** The one sentence for a toast or a status line. */
  summary: string;
}

/**
 * Read the apply route's answer. It halts on the first refusal and says how far it got; a partial apply is reported as partial,
 * because the events it did write do not roll back.
 */
export function readApply(status: number, json: any, total: number): ApplyOutcome {
  const lines: ApplyLine[] = Array.isArray(json?.results)
    ? json.results.filter((r: any) => r && typeof r.kind === "string").map((r: any) => ({ kind: String(r.kind), ok: r.ok !== false, detail: String(r.detail ?? "") }))
    : [];
  const applied = typeof json?.applied === "number" ? json.applied : lines.filter((l) => l.ok).length;
  const ok = status === 200 && json?.ok === true;
  const refused = lines.filter((l) => !l.ok);
  const summary = ok
    ? `Applied ${applied} change${applied === 1 ? "" : "s"} to the running mission.`
    : refused.length
      ? `Applied ${applied} of ${total}. The mission refused one: ${refused[0]!.detail || refused[0]!.kind}.`
      : `The server refused the change (HTTP ${status}). Nothing was applied.`;
  return { ok, applied, total, lines, summary };
}

/* ---------------------------------------------------------------- the draft's state */

export type DraftKind = "new" | "clean" | "unsaved" | "restored";

export interface DraftStatus {
  kind: DraftKind;
  /** Short, for the chip beside the page title. */
  label: string;
  /** One sentence, for the save bar. */
  detail: string;
}

/**
 * The one reading of where the draft stands against the file. It is the count of real differences (diff.ts), not a flag that an edit
 * happened: an edit that was put back is not a change, and a draft nobody touched is not one either.
 */
export function draftStatus(input: { changes: number; hasFile: boolean; restored: boolean }): DraftStatus {
  const { changes, hasFile, restored } = input;
  if (!hasFile) {
    return { kind: "new", label: "New mesh", detail: "This mesh has no file yet. Saving writes one." };
  }
  if (restored && changes > 0) {
    return { kind: "restored", label: "Draft restored", detail: `Restored from this browser: ${changes} change${changes === 1 ? "" : "s"} not saved to mesh.yaml.` };
  }
  if (changes > 0) {
    return { kind: "unsaved", label: `${changes} unsaved change${changes === 1 ? "" : "s"}`, detail: `${changes} change${changes === 1 ? "" : "s"} not saved to mesh.yaml.` };
  }
  return { kind: "clean", label: "No unsaved changes", detail: "The draft matches mesh.yaml." };
}

/** Names the file and the folder it is in, for a label that has to fit: `…/demo-stub/mesh.yaml`. */
export function shortPath(path: string, keep = 3): { dir: string; file: string; text: string } {
  const clean = path.replace(/\\/g, "/");
  const parts = clean.split("/").filter(Boolean);
  const file = parts[parts.length - 1] ?? clean;
  const dirParts = parts.slice(Math.max(0, parts.length - keep), -1);
  const cut = parts.length - 1 > dirParts.length;
  const dir = dirParts.length ? `${cut || clean.startsWith("/") ? "…/" : ""}${dirParts.join("/")}/` : "";
  return { dir, file, text: `${dir}${file}` };
}
