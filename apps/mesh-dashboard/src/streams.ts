/**
 * Live turn streams: the DOM-free folds behind the out-of-band SSE frames
 * (`turn.token`, `turn.tool`). Kept out of `store.tsx` so the merge rules are
 * testable without mounting a provider.
 */

import { toolTarget } from "./livework";

/** One tool call in a running turn, as the live stream knows it. */
export interface ToolLive {
  toolCallId: string;
  name: string;
  /**
   * Stringified arguments, truncated. The buffer holds a preview rather than
   * the raw payload because a single `write_file` call can carry a whole file,
   * and this lives in React state for the life of the turn. The authoritative
   * arguments are in the event log.
   */
  argsPreview: string;
  /**
   * The one argument a reader looks at (a path, a command), taken from the raw
   * arguments before they are cut down to `argsPreview` — a preview clipped
   * mid-JSON no longer parses. Correlates with the polled `liveTools` by id.
   */
  target?: string;
  status: "running" | "completed" | "failed";
  resultDigest?: string;
  /** The runtime's error text, when the update said the call failed. */
  error?: string;
  startedAt: number;
  updatedAt: number;
}

/** Client-side caps, in the spirit of STREAM_TEXT_MAX: a chatty turn must not
 *  grow the DOM without bound. */
export const TOOL_ARGS_MAX = 2000;
export const TOOLS_PER_TURN_MAX = 100;

/** `{"cmd":"npm test"}`, capped. Unserializable args degrade to a marker
 *  rather than throwing inside a stream handler. */
export function previewArgs(args: unknown): string {
  if (args === undefined) return "";
  let text: string;
  try {
    text = typeof args === "string" ? args : JSON.stringify(args) ?? String(args);
  } catch {
    // Cyclic or otherwise unserializable: the call still deserves a row.
    return "[unserializable]";
  }
  return text.length > TOOL_ARGS_MAX ? `${text.slice(0, TOOL_ARGS_MAX)}…` : text;
}

/**
 * Merge one `turn.tool` frame's inner event into a turn's tool list.
 *
 * Returns `null` when the frame carries nothing actionable, so the caller can
 * skip the state update entirely rather than re-render on garbage.
 *
 * A `tool_call_update` whose `tool_call` was never seen is dropped: it happens
 * when a reconnect straddles the pair, and a row reading "(unknown) completed"
 * is worse than no row.
 */
export function foldToolEvent(prev: ToolLive[] | undefined, raw: unknown, now: number): ToolLive[] | null {
  const ev = raw as { kind?: unknown; toolCallId?: unknown; name?: unknown; args?: unknown; status?: unknown; resultDigest?: unknown; error?: unknown } | null;
  if (!ev || typeof ev !== "object") return null;
  const id = typeof ev.toolCallId === "string" ? ev.toolCallId : "";
  if (!id) return null;
  const list = prev ?? [];
  const at = list.findIndex((t) => t.toolCallId === id);

  if (ev.kind === "tool_call") {
    const name = typeof ev.name === "string" && ev.name ? ev.name : "tool";
    const digest = typeof ev.resultDigest === "string" ? ev.resultDigest : undefined;
    const target = toolTarget(ev.args) ?? (at >= 0 ? list[at].target : undefined);
    const call: ToolLive = {
      toolCallId: id,
      name,
      argsPreview: previewArgs(ev.args),
      ...(target ? { target } : {}),
      ...(at >= 0 && list[at].error ? { error: list[at].error } : {}),
      // A re-announced call keeps whatever terminal status it already reached:
      // the adapters may repeat a call frame, and downgrading a finished row
      // back to "running" would make the UI flap.
      status: at >= 0 ? list[at].status : "running",
      resultDigest: digest ?? (at >= 0 ? list[at].resultDigest : undefined),
      startedAt: at >= 0 ? list[at].startedAt : now,
      updatedAt: now,
    };
    const next = at >= 0 ? [...list.slice(0, at), call, ...list.slice(at + 1)] : [...list, call];
    return next.length > TOOLS_PER_TURN_MAX ? next.slice(next.length - TOOLS_PER_TURN_MAX) : next;
  }

  if (ev.kind === "tool_call_update") {
    if (at < 0) return null;
    const status = ev.status === "completed" || ev.status === "failed" ? ev.status : list[at].status;
    const digest = typeof ev.resultDigest === "string" ? ev.resultDigest : list[at].resultDigest;
    const merged: ToolLive = { ...list[at], status, resultDigest: digest, updatedAt: now };
    // Same rule as the runtime's own fold: an error belongs to a failure only,
    // so a later "completed" for the same id cannot carry a stale one.
    if (status === "failed" && typeof ev.error === "string" && ev.error) merged.error = ev.error.slice(0, TOOL_ARGS_MAX);
    else if (status !== "failed") delete merged.error;
    return [...list.slice(0, at), merged, ...list.slice(at + 1)];
  }

  return null;
}
