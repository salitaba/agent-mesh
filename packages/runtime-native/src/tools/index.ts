import { describeToolPermissions } from "../../../agent-runtime/src/index";
import { bashTool } from "./bash";
import { editTool, readTool, writeTool } from "./files";
import { globTool, grepTool } from "./search";
import type { NativeTool } from "./types";
import { webFetchTool } from "./web";

export * from "./types";
export * from "./confine";
export * from "./files";
export * from "./search";
export * from "./bash";
export * from "./web";
export * from "./shell-env";

/** Every tool the runtime implements itself, by the name the model calls it. */
export const NATIVE_TOOLS: ReadonlyMap<string, NativeTool> = new Map(
  [readTool, globTool, grepTool, writeTool, editTool, bashTool, webFetchTool].map((t) => [t.spec.name, t]),
);

/**
 * The tools a seat is offered: reading always, and a family only if some capability the seat holds reaches it.
 *
 * Offering a tool the gate will refuse costs tokens on every call and invites the failed attempt, so the list is cut to
 * what the seat can use. The gate still decides every call: a seat holds a tool because it holds a capability, but an
 * operator's approval gate, the commit-only shell scope and the product-checkout rules apply at the call, not here.
 */
export function toolsOffered(capabilities: string[], requiresApproval: string[] = []): NativeTool[] {
  const p = describeToolPermissions(capabilities, requiresApproval);
  return [...NATIVE_TOOLS.values()].filter((t) => {
    switch (t.spec.name) {
      case "Write":
      case "Edit":
        return p.edit.level !== "deny";
      case "Bash":
        return p.shell.level !== "deny";
      case "WebFetch":
        return p.web.level !== "deny";
      default:
        return true;
    }
  });
}
