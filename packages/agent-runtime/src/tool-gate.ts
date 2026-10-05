/**
 * What a seat's tools may do, decided from its capabilities.
 *
 * Every runtime that gives a seat tools enforces the same rules, because the rules belong to the mesh, not to a backend:
 * reading is always allowed, writing needs a write capability, a shell needs `shell.execute` or `test.execute` (or
 * `git.commit` for the commit path alone), the network needs `network.request`, an operator may gate any of them behind
 * an approval, and no seat may land work on the product branch from a shell or write into the product checkout.
 * The Claude adapter and the native runtime both call {@link buildPermissionGate}, and the operator surface describes the
 * same decision through {@link describeToolPermissions}, so what a seat is shown and what it is refused cannot drift.
 *
 * Tool names are the vocabulary the models and the mesh already share (`Read`, `Edit`, `Write`, `Bash`, `WebFetch`, the
 * `mesh_*` bus tools). A tool nobody mapped is a tool nobody authorized, and fails closed.
 */
import { EDIT_CAPABILITIES, normalizeCapability } from "../../protocol/src/index";
import { landingDenial, productWriteDenial } from "./landing-gate";

/** What a gate says about one tool call. `updatedInput` is the call's input, unchanged: a gate never rewrites a call. */
export type ToolDecision = { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string };

/**
 * A seat's tool gate: asked before every call, answering allow or deny.
 *
 * The third argument is whatever the caller's backend wants to pass along (the Claude SDK hands each check an abort signal
 * and the call's id). The gate decides from the tool and its input alone and ignores it, which is what keeps this type
 * assignable to the SDK's own permission callback.
 */
export type ToolGate = (toolName: string, toolInput: Record<string, unknown>, context?: unknown) => Promise<ToolDecision>;

/** Tools that write to the repository. Gated on a write-ish capability. */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
/** Tools that execute arbitrary commands. Gated on shell/test execution. */
const EXEC_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
/** Tools that reach the network. Gated on network.request. */
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
/**
 * Read-only inspection, always allowed — mirrors `read: "allow"` in the
 * opencode permission block. An agent that cannot read its own workspace
 * cannot do useful work under any capability set.
 */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite"]);

/**
 * Prefix of the MCP bridge back into the mesh bus, as the Claude CLI names it, and the bare name a runtime that speaks the
 * bridge itself uses (`mesh_send`). Never gated: a seat that could not reach the bus would not be a seat.
 */
const MESH_MCP_PREFIX = "mcp__mesh";
const MESH_BARE_PREFIX = "mesh_";

/**
 * git subcommands a seat needs to stage and land a commit. Deliberately short:
 * anything outside it is reachable by granting `shell.execute`, which is the
 * capability that exists to say so. `push` and `merge` are absent because
 * `git.merge` is its own capability.
 */
const COMMIT_SUBCOMMANDS = new Set(["add", "commit", "status", "diff", "log", "show", "rev-parse", "ls-files"]);

/**
 * True when `command` is one git invocation carrying no shell control flow.
 *
 * Quoting is the whole difficulty. This repo writes conventional subjects
 * ("fix(designer): ..."), so a scan that rejected parentheses outright would
 * reject the exact command this capability exists to permit. So: track quote
 * state, reject only what can start a second command, and keep rejecting `$(`
 * and backticks inside double quotes, where they still substitute.
 */
function isBareGitCommand(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") { i++; continue; }
      if (c === '"') { quote = null; continue; }
      if (c === "`") return false;
      if (c === "$" && command[i + 1] === "(") return false;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "`" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">" || c === "\n") return false;
    if (c === "$" && command[i + 1] === "(") return false;
  }
  return quote === null;
}

/** Why a commit-only seat may not run this Bash call, or null if it may. */
function commitScopeDenial(toolInput: Record<string, unknown>): string | null {
  const raw = toolInput.command;
  const command = typeof raw === "string" ? raw.trim() : "";
  if (!command) return "a commit-only seat may run git commands, and this call carries no command string";
  if (!isBareGitCommand(command)) {
    return "a commit-only seat may run a single git command, with no chaining, redirection, or substitution";
  }
  const named = /^git\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/.exec(command);
  if (!named) return "a commit-only seat may run git commands only";
  if (!COMMIT_SUBCOMMANDS.has(named[1])) {
    return `'git ${named[1]}' is outside the commit path — grant shell.execute if this seat needs it`;
  }
  return null;
}

/**
 * The four tool families a seat's capabilities decide, named as an operator
 * reads them. Mesh bus tools are not a family: they are never gated, and a seat
 * that could not reach them would not be a seat.
 */
export type ToolFamily = "read" | "edit" | "shell" | "web";

/**
 * - `allow`    — the seat may use every tool in the family.
 * - `deny`     — no capability it holds reaches the family.
 * - `approval` — it holds one, but `requires_approval` gates it: every call is
 *                refused until the operator unlocks that tool for the session.
 * - `scoped`   — commit-only shell: `git.commit` without `shell.execute`, so
 *                `Bash` runs only a bare git command on the commit path.
 */
export type ToolPermissionLevel = "allow" | "deny" | "approval" | "scoped";

export interface ToolPermission {
  level: ToolPermissionLevel;
  /** The capability that decided it, or what is missing ("needs repository.write"). */
  via: string;
}

export type ToolPermissions = Record<ToolFamily, ToolPermission>;

/**
 * Capability tokens that authorize each gated family, in the order a denial or
 * a hold names them. `edit` is EDIT_CAPABILITIES itself rather than a copy: the
 * supervisor gives a seat a worktree on the same list, and a seat with a
 * worktree and no write tool (or the reverse) is exactly the drift to avoid.
 */
const FAMILY_TOKENS: Record<Exclude<ToolFamily, "read">, readonly string[]> = {
  edit: EDIT_CAPABILITIES,
  shell: ["shell.execute", "test.execute", "git.commit"],
  web: ["network.request"],
};

/** Shell tokens that buy UNSCOPED exec; `git.commit` alone buys the commit path. */
const FULL_EXEC_TOKENS = new Set(["shell.execute", "test.execute"]);

/** Which family a tool belongs to; `mesh` for the bus, null for a tool nobody mapped. */
function toolFamily(toolName: string): ToolFamily | "mesh" | null {
  if (toolName.startsWith(MESH_MCP_PREFIX) || toolName.startsWith(MESH_BARE_PREFIX)) return "mesh";
  if (READ_TOOLS.has(toolName)) return "read";
  if (EDIT_TOOLS.has(toolName)) return "edit";
  if (EXEC_TOOLS.has(toolName)) return "shell";
  if (NETWORK_TOOLS.has(toolName)) return "web";
  return null;
}

/**
 * One family's verdict for a seat BEFORE any operator grant — the single
 * decision both {@link buildPermissionGate} and {@link describeToolPermissions}
 * read, so what the operator is shown and what the seat is refused cannot drift.
 * The gate applies only what a static description cannot know: which tools the
 * operator has since unlocked, and the command a commit-only `Bash` carries.
 */
interface FamilyVerdict extends ToolPermission {
  /**
   * The seat's own tokens in this family that `requires_approval` gates.
   * Filtered against the seat's grants on purpose: `requires_approval` narrows a
   * grant and must never widen one, so a token the seat does not hold can
   * neither gate nor unlock anything.
   */
  gated: string[];
  /** Shell only: the seat holds `git.commit` but no full-exec token. */
  commitOnly: boolean;
}

function familyVerdict(family: ToolFamily, caps: ReadonlySet<string>, requires: ReadonlySet<string>): FamilyVerdict {
  if (family === "read") return { level: "allow", via: "always allowed", gated: [], commitOnly: false };
  const tokens = FAMILY_TOKENS[family];
  const held = tokens.filter((t) => caps.has(t));
  if (held.length === 0) {
    const [first, ...rest] = family === "shell" ? tokens.filter((t) => FULL_EXEC_TOKENS.has(t)) : tokens;
    return {
      level: "deny",
      via: `needs ${first}${rest.length ? ` (or ${rest.join(", ")})` : ""}`,
      gated: [],
      commitOnly: false,
    };
  }
  // `git.commit` once bought blanket exec: opencode rendered it as bash:"ask",
  // nothing on a mesh turn could answer that prompt, and a pending one would
  // stall the slot to its timeout — so the seat got exec instead. That backend
  // is gone and the widening outlived its reason: a seat granted git.commit and
  // deliberately *not* granted shell.execute was still getting arbitrary bash.
  // It now buys the commit path only.
  const commitOnly = family === "shell" && !held.some((t) => FULL_EXEC_TOKENS.has(t));
  const granting = family === "shell" && !commitOnly ? held.filter((t) => FULL_EXEC_TOKENS.has(t)) : held;
  const gated = held.filter((t) => requires.has(t));
  if (gated.length > 0) {
    return {
      level: "approval",
      via: `${gated.join(", ")} (requires_approval)${commitOnly ? "; commit path only once granted" : ""}`,
      gated,
      commitOnly,
    };
  }
  if (commitOnly) return { level: "scoped", via: "git.commit (commit path only)", gated, commitOnly };
  return { level: "allow", via: granting.join(", "), gated, commitOnly };
}

function familyVerdicts(caps: ReadonlySet<string>, requires: ReadonlySet<string>): Record<ToolFamily, FamilyVerdict> {
  return {
    read: familyVerdict("read", caps, requires),
    edit: familyVerdict("edit", caps, requires),
    shell: familyVerdict("shell", caps, requires),
    web: familyVerdict("web", caps, requires),
  };
}

/**
 * What a seat may do with each tool family, as the permission gate would decide
 * it — for the operator surface, which until now could only show the raw
 * capability list and leave the reader to work out that `git.commit` does not
 * mean "has a shell".
 *
 * Pure, and built on the same verdict the gate uses. It describes the seat as
 * configured: an `approval` family stays `approval` here after the operator
 * unlocks one of its tools, because grants are per tool and per session, and
 * this is a statement about the seat, not about one session of it.
 */
export function describeToolPermissions(capabilities: string[], requiresApproval: string[] = []): ToolPermissions {
  const caps = new Set(capabilities.map(normalizeCapability));
  const requires = new Set(requiresApproval.map(normalizeCapability));
  const v = familyVerdicts(caps, requires);
  const strip = ({ level, via }: FamilyVerdict): ToolPermission => ({ level, via });
  return { read: strip(v.read), edit: strip(v.edit), shell: strip(v.shell), web: strip(v.web) };
}

/** Operator-approval half of {@link buildPermissionGate}. */
export interface ApprovalGate {
  /** Capability tokens whose tools need a grant. Normalized by the caller. */
  requires: readonly string[];
  /** Tool names the operator has unlocked for this session. */
  granted: ReadonlySet<string>;
  /**
   * Record a tool refused for want of a grant. Called at most once per call.
   *
   * Optional: the denial already tells the model, and the operator surface
   * lists gated seats from config. A caller that wants a live "blocked on"
   * queue supplies this; nothing in the mesh requires one yet.
   */
  onRequest?(toolName: string): void;
}

/**
 * Capability-to-tool gate. The removed opencode adapter expressed this as a
 * static permission block in a generated config; the SDK offers a callback
 * instead, which is a closer fit — the decision is computed from the same
 * capability set, but an unknown or newly added tool fails closed here instead
 * of falling through whatever the config file happened not to mention.
 *
 * `approval` layers an operator gate over that: a capability the seat holds,
 * whose tools stay denied until the operator unlocks them.
 *
 * The denial IS the mechanism — this gate never blocks waiting for a human,
 * even though it could (the callback is async). `interruptSilentTurns` kills
 * any turn that goes quiet for `turnSilenceMs`, resolved to 60-120s, which is
 * well inside human response latency: a blocking hold would be destroyed by
 * the supervisor's own stall detector before most operators answered. So the
 * gate refuses, records the request, and lets the turn end WAITING; the
 * operator grants over HTTP and the agent is re-activated.
 *
 * That shape also settles what a grant can honestly mean. A refused call
 * cannot be replayed — the model re-decides on its next turn — so the operator
 * unlocks the TOOL for the rest of the session, never one invocation of it.
 */
export function buildPermissionGate(capabilities: string[], approval?: ApprovalGate, shell?: { cwd: string; productPath?: string }): ToolGate {
  // Normalized here as well as at config load: capabilityGrants also arrive
  // from direct AgentDefinition construction (tests, bench harnesses).
  const caps = new Set(capabilities.map(normalizeCapability));
  const requires = new Set((approval?.requires ?? []).map(normalizeCapability));
  const granted = approval?.granted ?? new Set<string>();
  // Decided once, from the same function `describeToolPermissions` reads: caps
  // and `requires` are fixed for the gate's life. `granted` is NOT folded in —
  // it is the caller's live set, refreshed per turn, and is read per call below.
  const verdicts = familyVerdicts(caps, requires);

  const deny = (message: string) => ({ behavior: "deny" as const, message });

  /** Why a family with no authorizing capability refuses this tool. Wording is the gate's contract with the model. */
  const refusal = (family: Exclude<ToolFamily, "read">, toolName: string): string =>
    family === "edit"
      ? `${toolName} denied: this seat holds no write capability (has: ${[...caps].join(", ") || "none"}).`
      : family === "shell"
        ? `${toolName} denied: this seat holds no shell.execute or test.execute capability.`
        : `${toolName} denied: this seat holds no network.request capability.`;

  return async (toolName, toolInput) => {
    const family = toolFamily(toolName);
    if (family === "mesh" || family === "read") return { behavior: "allow", updatedInput: toolInput };
    // Fail closed. A tool nobody mapped is a tool nobody authorized.
    if (family === null) return deny(`${toolName} is not available to curule agents.`);
    const v = verdicts[family];
    if (v.level === "deny") return deny(refusal(family, toolName));
    // Checked before the commit-scope narrowing below: an operator gate is
    // about whether this seat may reach the tool at all, which is a question
    // that comes before what it may pass to it.
    if (v.level === "approval" && !granted.has(toolName)) {
      approval?.onRequest?.(toolName);
      return deny(
        `${toolName} needs operator approval: this seat holds ${v.gated.join(", ")}, which requires_approval gates. ` +
          "The request is recorded on the operator's gate surface — end your turn rather than retrying, " +
          "since a grant cannot unlock a call already in flight.",
      );
    }
    // BashOutput and KillShell address a shell this seat already opened; only
    // Bash opens a new one, so only Bash needs its command scoped. `commitOnly`
    // rather than `level === "scoped"`: an unlocked `approval` seat that holds
    // only git.commit is still commit-only once through the operator gate.
    if (v.commitOnly && toolName === "Bash") {
      const why = commitScopeDenial(toolInput);
      if (why) return deny(`Bash denied: ${why}.`);
    }
    // The file tools may not write into the product checkout either: a seat with a worktree edits
    // there, and what lands in the product checkout lands through `merge`. See `productWriteDenial`.
    if (family === "edit" && shell?.productPath) {
      const target = typeof toolInput.file_path === "string" ? toolInput.file_path : typeof toolInput.notebook_path === "string" ? toolInput.notebook_path : "";
      const why = productWriteDenial(target, { cwd: shell.cwd, productPath: shell.productPath });
      if (why) return deny(`${toolName} denied: ${why}.`);
    }
    // Whatever else a shell may do, it may not land work on the product branch: that
    // is the `merge` op's job, which checks git.merge and the merge gate and records
    // what it landed. See landing-gate.ts.
    if (toolName === "Bash" && shell?.productPath) {
      const command = typeof toolInput.command === "string" ? toolInput.command : "";
      const why = landingDenial(command, { cwd: shell.cwd, productPath: shell.productPath }, { mayPush: caps.has("git.merge") });
      if (why) return deny(`Bash denied: ${why}.`);
    }
    return { behavior: "allow", updatedInput: toolInput };
  };
}
