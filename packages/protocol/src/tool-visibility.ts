import type { AgentDefinition } from "./types";

/**
 * Which `mesh_*` tools a seat is shown, and what to tell a seat that reaches for one it is not.
 *
 * This is the one statement of it. The MCP manifest (`apps/mesh-server/src/mcp.ts`) filters its
 * tool list through `toolAdvertised`, and the seat briefing (`packages/core/src/context.ts`)
 * leaves out of its prose whatever `hiddenToolsFor` says the manifest leaves out. They used to
 * be two hands writing the same fact: the manifest hid `mesh_send`, `mesh_respond`,
 * `mesh_broadcast`, `mesh_request_review`, `mesh_escalate`, `mesh_research_request` and, for a
 * seat without `git.merge`, `mesh_merge`, and the briefing went on listing every one of them as
 * a tool the seat could call.
 *
 * Hiding is advertisement-only as far as the SERVER goes: `callTool` resolves against the
 * unfiltered map, so a caller that names a hidden tool on the wire still gets it. That was
 * taken to mean a seat that reaches for one "still gets it". It does not, for any client that
 * checks a name against the list it was handed, and Claude Code is one: it refuses the call
 * before it leaves the machine, with "No such tool available". Across three live runs a seat
 * made 8, 14 and 14 such calls, every one a turn's worth of intent that never reached the mesh
 * (one was a review request, and the seat then waited for a review nobody had been asked for).
 * So what a briefing names has to be what the manifest carries, and that is why this lives
 * where both can read it.
 */

/**
 * Tools whose entire job a named contract now does, mapped to the contract call that replaces
 * them. Under `bus.vocabulary: "contracts"` these are dropped from the advertised manifest: a
 * seat that has `mesh_call` and `mesh_contracts` can raise every one of these asks, and raising
 * it that way is strictly better — the request shape is validated before anyone is woken, the
 * mesh picks a recipient that policy will actually let you reach, and the refusals you may get
 * back are named up front.
 */
export const SUPERSEDED_BY_CONTRACT: Readonly<Record<string, string>> = {
  mesh_request: "`mesh_call work.request` (or `info.question`, `artifact.produce`, `execution.run`)",
  mesh_request_review: "`mesh_call review.artifact`",
  mesh_research_request: "`mesh_call research.question`",
  mesh_escalate: "`mesh_call decision.escalate`",
};

/**
 * The rest of what `bus.vocabulary: "contracts"` hides, with what a seat is shown instead.
 *
 * `SUPERSEDED_BY_CONTRACT` dropped the four tools a contract fully covers and kept every tool
 * that still carried a `MessageType` enum, so a seat still had to learn 24 speech-act names
 * before it could say anything. Under the collapsed vocabulary the comms manifest is eight
 * tools and not one of them asks for a type:
 *
 *   mesh_contracts        what can I ask for
 *   mesh_call             the ask
 *   mesh_reply            the answer
 *   mesh_discharge        the refusal
 *   mesh_withdraw         taking the ask back
 *   mesh_announce         saying something that obliges nobody
 *   mesh_collab/_close    the bounded discussion
 *
 * The payoff is that a seat can no longer invent `RESULT`, because the manifest offers no field
 * to invent it in — which is the entire reason `op-aliases.ts` exists.
 */
export const HIDDEN_BY_CONTRACT_VOCABULARY: Readonly<Record<string, string>> = {
  ...SUPERSEDED_BY_CONTRACT,
  mesh_send: "`mesh_call` to ask, `mesh_reply` to answer, `mesh_announce` to tell",
  mesh_broadcast: "`mesh_announce`",
  mesh_respond: "`mesh_reply`",
};

/**
 * The two tools that exist only to carry the collapsed vocabulary.
 *
 * Registered in every mesh so they always RESOLVE, advertised only under
 * `bus.vocabulary: "contracts"`: adding two tools to every existing mesh's manifest is precisely
 * the silent upgrade the absent-by-default config field is there to prevent.
 */
export const CONTRACT_VOCABULARY_TOOLS: ReadonlySet<string> = new Set(["mesh_reply", "mesh_announce"]);

/**
 * Tools whose own description already names the capability/authority/mode required to use them
 * (git.merge, veto authority, architecture.approve, worker-only). Every seat used to see all of
 * these regardless of whether it held the grant, which cost ~4x the role prompt in tool-slot
 * tokens and told the model nothing about what it could actually call. Keyed by tool name; a
 * tool absent here has no such requirement.
 */
export const TOOL_REQUIREMENT: Readonly<Record<string, (def: AgentDefinition | undefined) => boolean>> = {
  mesh_merge: (def) => !!def?.capabilities.includes("git.merge"),
  mesh_veto: (def) => !!def?.authority.some((a) => a === "*" || a.endsWith(".veto")),
  mesh_decision_ratify: (def) => !!def?.authority.some((a) => a === "*" || a === "architecture.approve"),
  mesh_submit_result: (def) => def?.mode === "service",
};

/** What a seat that lacks the grant a tool needs is told, per tool of `TOOL_REQUIREMENT`. */
const MISSING_GRANT: Readonly<Record<string, string>> = {
  mesh_merge: "only a seat that holds the `git.merge` capability has it, and you do not: ask that seat once the patch is MERGEABLE",
  mesh_veto: "it needs a veto authority, which you do not hold",
  mesh_decision_ratify: "it needs the `architecture.approve` authority, which you do not hold",
  mesh_submit_result: "it is for delegated workers only",
};

export type CommsVocabulary = "contracts" | undefined;

/**
 * Is `tool` in the manifest `def` is shown? The filter `McpToolset.toolsFor` applies, and the
 * only place the rule is written.
 */
export function toolAdvertised(tool: string, def: AgentDefinition | undefined, vocabulary: CommsVocabulary): boolean {
  const collapsed = vocabulary === "contracts";
  if (!collapsed && CONTRACT_VOCABULARY_TOOLS.has(tool)) return false;
  if (collapsed && HIDDEN_BY_CONTRACT_VOCABULARY[tool]) return false;
  const requirement = TOOL_REQUIREMENT[tool];
  return requirement ? requirement(def) : true;
}

/**
 * The tools a briefing might name that `def`'s manifest does not carry, for the prose to leave
 * out. Only tools this module knows about: it is a list of the ones the prose has a reason to
 * mention, not of every name absent from the manifest. The two vocabulary-only tools are left
 * off because no prose names them outside the section that is rendered only under their
 * vocabulary.
 */
export function hiddenToolsFor(def: AgentDefinition | undefined, vocabulary: CommsVocabulary): string[] {
  const names = new Set([...Object.keys(TOOL_REQUIREMENT), ...(vocabulary === "contracts" ? Object.keys(HIDDEN_BY_CONTRACT_VOCABULARY) : [])]);
  return [...names].filter((t) => !toolAdvertised(t, def, vocabulary));
}

/**
 * What to tell a seat whose call to `tool` was refused because `tool` is not in its list: what
 * to use instead, or why it does not have it. A fragment, for a sentence to carry.
 */
export function toolAlternative(tool: string): string {
  const replaced = HIDDEN_BY_CONTRACT_VOCABULARY[tool];
  if (replaced) return `use ${replaced}`;
  const missing = MISSING_GRANT[tool];
  if (missing) return missing;
  return "it is not one of the tools this mesh gives you";
}

/** The bare tool name in a tool call record (`mcp__mesh__mesh_send` → `mesh_send`), or undefined for a tool that is not the mesh's. */
export function meshToolName(callName: string): string | undefined {
  const bare = callName.startsWith("mcp__mesh__") ? callName.slice("mcp__mesh__".length) : callName;
  return bare.startsWith("mesh_") ? bare : undefined;
}

/**
 * The mesh tools a turn called and was refused for not having.
 *
 * The client's own refusal never reaches the mesh, so no op result records it and nothing the
 * supervisor writes at the end of a turn mentions it: the seat read "No such tool available"
 * in its tool result, moved on, and its next context says it did what it meant to. Matched on
 * the two wordings there are: Claude Code's, and the server's for a client that does reach it.
 */
export function refusedToolCalls(calls: ReadonlyArray<{ name: string; status?: string; error?: string }> | undefined): Array<{ tool: string; times: number }> {
  const counts = new Map<string, number>();
  for (const c of calls ?? []) {
    if (c.status !== "failed" || !c.error || !/No such tool available|unknown tool/i.test(c.error)) continue;
    const tool = meshToolName(c.name);
    if (tool) counts.set(tool, (counts.get(tool) ?? 0) + 1);
  }
  return [...counts].map(([tool, times]) => ({ tool, times }));
}
