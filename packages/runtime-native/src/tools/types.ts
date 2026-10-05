import type { JsonObject, ToolSpec } from "../../../llm/src/index";

/**
 * What a tool needs to know about the seat that is calling it. Built once per session by the runtime from the seat's
 * definition and the operator's settings; a tool reads it and never widens it.
 */
export interface ToolContext {
  /** The seat's directory: where a relative path resolves and where a shell starts. */
  cwd: string;
  /** Directories the file tools may read. Always includes the seat's own. */
  readRoots: readonly string[];
  /** Directories the file tools may write. Narrower than `readRoots`: the product checkout is read-only to a seat. */
  writeRoots: readonly string[];
  /** The environment a shell starts with, already scrubbed of the mesh's and the providers' credentials. */
  shellEnv: Record<string, string>;
  /** Fires when the mesh stops the turn. A tool that waits on anything listens to it. */
  signal: AbortSignal;
  /** Where `WebFetch` may connect; absent means the default policy (public addresses only). */
  network?: NetworkPolicy;
}

export interface NetworkPolicy {
  /** Allow loopback and private addresses. For a test against a local server, never for a hosted seat. */
  allowPrivate?: boolean;
  /** Replaces DNS resolution; for tests. */
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  /** Replaces the judgement of an address; for tests of the wiring (which names and hops are judged), never of the ranges. */
  isPublic?: (address: string) => boolean;
}

export interface ToolResult {
  /** What the model reads. */
  text: string;
  /** The call failed. The model is told so in the protocol's own terms and the turn's record marks the call failed. */
  isError?: boolean;
}

export interface NativeTool {
  spec: ToolSpec;
  run(args: JsonObject, ctx: ToolContext): Promise<ToolResult>;
}

/** A call that cannot succeed as asked (a missing file, a string that is not unique). Its message goes to the model verbatim. */
export class ToolFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolFailure";
  }
}

export function stringArg(args: JsonObject, name: string, opts: { required?: boolean; allowEmpty?: boolean } = {}): string | undefined {
  const v = args[name];
  if (v === undefined || v === null) {
    if (opts.required) throw new ToolFailure(`${name} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolFailure(`${name} must be a string`);
  if (v === "" && !opts.allowEmpty && opts.required) throw new ToolFailure(`${name} must not be empty`);
  return v;
}

export function intArg(args: JsonObject, name: string, opts: { min?: number; max?: number } = {}): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) throw new ToolFailure(`${name} must be a whole number`);
  if (opts.min !== undefined && n < opts.min) throw new ToolFailure(`${name} must be at least ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new ToolFailure(`${name} must be at most ${opts.max}`);
  return n;
}

export function boolArg(args: JsonObject, name: string): boolean | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new ToolFailure(`${name} must be true or false`);
}
