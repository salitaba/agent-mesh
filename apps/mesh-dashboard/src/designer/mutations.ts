/* Staged-mutation presentation for the designer's review card.
 *
 * One handler per StagedMutation kind: a label, a human summary, whether it
 * earns a typed confirmation, and — the load-bearing field — which of the two
 * apply paths it belongs to. The protocol is explicit that those paths are not
 * interchangeable: `config.replace` rewrites the operator's CLIENT-SIDE draft
 * and still needs a separate Save, while every other kind applies SERVER-SIDE
 * to the live run immediately. Routing a server kind through the draft path is
 * how a live-run change would ship as an unreviewed config edit, which is the
 * thing the server's own refusal of `config.replace` exists to prevent.
 *
 * Pure and DOM-free on purpose, like ./model and ../plan: tests/dashboard
 * compiles this under the ROOT tsconfig (lib ES2022, no DOM), so nothing here
 * may touch a browser global or import a module that does — which is why the
 * summarizer context is structural rather than storage.ts's DraftState.
 *
 * MUTATION_HANDLERS is a Record over StagedMutation["kind"]: a kind added in
 * @mesh/protocol fails this file's typecheck instead of silently rendering no
 * card at all. */

import { parse as parseYaml } from "yaml";
import type { StagedMutation, StagedProposal } from "@mesh/protocol";
import { summarizeDiff } from "./model";

/** Where an applied mutation actually lands. See the file header: these are
 *  not interchangeable, and the UI must keep them visibly distinct. */
export type MutationTarget = "draft" | "server";

/** What a summarizer may consult. Structural rather than importing DraftState:
 *  storage.ts is localStorage-backed, and a type-only import of it would still
 *  drag the DOM lib into this module's node:test build. */
export interface MutationContext {
  /** The draft's parsed model, or null when there is no draft to diff against. */
  model: any | null;
}

export interface MutationHandler<K extends StagedMutation["kind"] = StagedMutation["kind"]> {
  /** Card heading for this one change, in the operator's language. */
  label: string;
  /** Itemized lines describing the change. Never includes `reason`; that is
   *  appended once by summarizeMutation so every kind renders it the same way. */
  summarize(m: Extract<StagedMutation, { kind: K }>, ctx: MutationContext): string[];
  destructive: boolean;
  target: MutationTarget;
}

type HandlerTable = { [K in StagedMutation["kind"]]: MutationHandler<K> };

const MAX_TEXT = 120;
function clip(s: string): string {
  const one = String(s ?? "").replace(/\s+/g, " ").trim();
  return one.length > MAX_TEXT ? `${one.slice(0, MAX_TEXT - 1)}…` : one;
}
function num(n: number | undefined): string {
  return n === undefined ? "unchanged" : String(n);
}

export const MUTATION_HANDLERS: HandlerTable = {
  "config.replace": {
    label: "Replace the whole config",
    destructive: true,
    target: "draft",
    summarize: (m, ctx) => {
      let parsed: any;
      try {
        parsed = parseYaml(m.yaml);
      } catch (err) {
        /* An unparseable proposal is worth showing rather than hiding: the
         * operator should see that applying it puts broken YAML in the draft. */
        return [`proposed YAML does not parse — ${err instanceof Error ? err.message : String(err)}`];
      }
      const diff = summarizeDiff(parsed, ctx.model);
      /* summarizeDiff returns [] both for "no draft to compare" and for "no
       * itemized change"; only the first is worth a different sentence. */
      if (!ctx.model) return ["replaces the whole draft config (no current draft to compare against)"];
      return diff.length ? diff : ["no itemized differences from the current draft"];
    },
  },
  "goal.description": {
    label: "Reword the goal",
    destructive: false,
    target: "server",
    summarize: (m) => [`goal → “${clip(m.description)}”`],
  },
  "criteria.add": {
    label: "Add acceptance criteria",
    destructive: false,
    target: "server",
    summarize: (m) => m.criteria.map((c) => `criterion +${clip(c.description)}${c.mandatory ? " (mandatory)" : ""}`),
  },
  "criteria.edit": {
    label: "Edit an acceptance criterion",
    destructive: false,
    target: "server",
    summarize: (m) => {
      const out: string[] = [];
      if (m.description !== undefined) out.push(`criterion ~${m.criterionId} → “${clip(m.description)}”`);
      if (m.mandatory !== undefined) out.push(`criterion ~${m.criterionId} → ${m.mandatory ? "mandatory" : "optional"}`);
      return out.length ? out : [`criterion ~${m.criterionId} (no field changed)`];
    },
  },
  "criteria.delete": {
    /* Destructive because it shrinks the denominator completion is measured
     * over, which can flip a live run to COMPLETED — the protocol requires a
     * reason on this kind alone for exactly that reason. */
    label: "Delete an acceptance criterion",
    destructive: true,
    target: "server",
    summarize: (m) => [`criterion −${m.criterionId}`],
  },
  "seat.spawn": {
    label: "Add a seat",
    destructive: false,
    target: "server",
    summarize: (m) => [`seat +${m.agent.id} (${m.agent.role}, ${m.agent.runtime})`],
  },
  "seat.retire": {
    label: "Retire a seat",
    destructive: true,
    target: "server",
    summarize: (m) => [`seat −${m.agentId}`],
  },
  "seat.suspend": {
    label: "Suspend a seat",
    destructive: false,
    target: "server",
    summarize: (m) => [`seat ~${m.agentId} suspended`],
  },
  "seat.resume": {
    label: "Resume a seat",
    destructive: false,
    target: "server",
    summarize: (m) => [`seat ~${m.agentId} resumed`],
  },
  "seat.wake": {
    label: "Wake a seat",
    destructive: false,
    target: "server",
    summarize: (m) => [`seat ~${m.agentId} woken`],
  },
  "run.pause": {
    label: "Pause the run",
    destructive: false,
    target: "server",
    summarize: () => ["run paused — no new turns are scheduled"],
  },
  "run.resume": {
    label: "Resume the run",
    destructive: false,
    target: "server",
    summarize: () => ["run resumed"],
  },
  "run.budget": {
    label: "Adjust the run budget",
    destructive: false,
    target: "server",
    summarize: (m) => [`budget → ${num(m.budget.maxEvents)} events / ${num(m.budget.wallClockMinutes)} min`],
  },
  "run.reopen": {
    /* Destructive because reopening invalidates already-accepted evidence. */
    label: "Reopen the mission",
    destructive: true,
    target: "server",
    summarize: (m) => {
      const ids = m.criteria ?? [];
      return [ids.length ? `reopen ${ids.length} criteri${ids.length === 1 ? "on" : "a"}: ${ids.join(", ")}` : "reopen every satisfied criterion"];
    },
  },
  "mission.reset": {
    label: "Reset the mission",
    destructive: true,
    target: "server",
    summarize: () => ["mission reset — progress and accepted evidence are discarded"],
  },
};

/** Itemized lines for one mutation, with its `reason` appended uniformly. */
export function summarizeMutation(m: StagedMutation, ctx: MutationContext): string[] {
  const handler = MUTATION_HANDLERS[m.kind] as MutationHandler;
  const lines = handler.summarize(m as never, ctx);
  return m.reason ? [...lines, `reason: ${clip(m.reason)}`] : lines;
}

export function labelFor(m: StagedMutation): string {
  return MUTATION_HANDLERS[m.kind].label;
}

export function targetOf(m: StagedMutation): MutationTarget {
  return MUTATION_HANDLERS[m.kind].target;
}

export function isDestructive(m: StagedMutation): boolean {
  return MUTATION_HANDLERS[m.kind].destructive;
}

/** The two apply paths, kept apart at the data layer so no render-time branch
 *  can accidentally hand a server mutation to the draft path. */
export function splitByTarget(mutations: StagedMutation[]): { draft: StagedMutation[]; server: StagedMutation[] } {
  const draft: StagedMutation[] = [];
  const server: StagedMutation[] = [];
  for (const m of mutations) (targetOf(m) === "draft" ? draft : server).push(m);
  return { draft, server };
}

/** Destructive kinds present in a set, for the typed-confirm prompt. Scoped by
 *  the caller to the server card: a draft `config.replace` is undoable and
 *  still needs a Save, so it keeps its one-click review-then-apply flow. */
export function destructiveKindsIn(mutations: StagedMutation[]): string[] {
  return [...new Set(mutations.filter(isDestructive).map((m) => m.kind))];
}

/** The word an operator types to confirm a destructive server apply. */
export const CONFIRM_WORD = "apply";

/**
 * For one release the designer's `final` frame carries BOTH a staged proposal
 * and the older text-extracted `proposedConfig`. Rendering both would put two
 * competing whole-config proposals in one reply, so the text one is surfaced
 * only when the staged buffer does not already carry a `config.replace`.
 */
export function showsTextProposal(proposal: StagedProposal | null | undefined): boolean {
  if (!proposal) return true;
  return !proposal.mutations.some((m) => m.kind === "config.replace");
}

/** The running mission, as `/status` reports its goal. Structural for the same
 *  reason as MutationContext: this module must not reach for a browser global. */
export interface LiveMission {
  description: string;
  criteria: Array<{ id: string; description: string }>;
}

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function criteriaDiffer(proposed: any[], live: LiveMission["criteria"]): boolean {
  if (proposed.length !== live.length) return true;
  const byId = new Map(live.map((c) => [String(c.id), norm(c.description)]));
  return proposed.some((c) => {
    const id = String(c?.id ?? "");
    return !byId.has(id) || byId.get(id) !== norm(c?.description);
  });
}

/**
 * mesh.yaml seeds the goal and its criteria exactly ONCE, in `supervisor.boot`.
 * A mission that is already running keeps what it booted with no matter what
 * the file says afterwards — while `GET /config` deliberately re-reads the file
 * on every poll. So a `config.replace` that reworded the goal moves the Config
 * view and leaves the Overview showing the pre-edit mission, and the operator
 * is told the change was saved, because it was: into the file. Nothing
 * downstream can detect this, so say it on the card, and name the kinds that do
 * reach the running mesh.
 *
 * A restart is NOT a dependable fallback for the goal specifically: boot mints a
 * goal only when it is not resuming (`supervisor.boot`), so a resumed mesh keeps
 * the goal it already has and the file is read past. Seats and budgets differ —
 * boot reconciles those from the file every time (`:795-817`) — which is why the
 * generic "restart to apply" line the Designer shows is true of them and not of
 * this.
 *
 * Returns null when there is nothing to warn about: no live mission to compare
 * against, no staged `config.replace`, YAML that does not parse (the itemized
 * summary already reports that), or a proposal that leaves both untouched.
 */
export function goalDriftWarning(mutations: StagedMutation[], mission: LiveMission | null | undefined): string | null {
  if (!mission) return null;
  const replace = mutations.find((m): m is Extract<StagedMutation, { kind: "config.replace" }> => m.kind === "config.replace");
  if (!replace) return null;
  let parsed: any;
  try {
    parsed = parseYaml(replace.yaml);
  } catch {
    return null;
  }
  const goal = norm(parsed?.mesh?.goal);
  const goalMoved = goal.length > 0 && goal !== norm(mission.description);
  /* A file with no `acceptance_criteria` is not a proposal to clear them: it is
   * the ordinary shape of a mesh whose criteria were derived at boot. */
  const proposed = Array.isArray(parsed?.mesh?.acceptance_criteria) ? parsed.mesh.acceptance_criteria : null;
  const criteriaMoved = proposed !== null && criteriaDiffer(proposed, mission.criteria);
  if (!goalMoved && !criteriaMoved) return null;
  const what = goalMoved && criteriaMoved ? "goal and the acceptance criteria" : goalMoved ? "goal" : "acceptance criteria";
  const instead = goalMoved && criteriaMoved
    ? "“Reword the goal” and the criteria edits"
    : goalMoved ? "“Reword the goal”" : "the criteria edits";
  return `This rewrites the ${what} in mesh.yaml, but the running mission keeps what it booted with — saving moves the file and the Config view, not the Overview. Restarting is not a reliable fallback either: a resumed mesh keeps its existing goal. Ask for ${instead} as a live-run change to move the mission that is actually running.`;
}
