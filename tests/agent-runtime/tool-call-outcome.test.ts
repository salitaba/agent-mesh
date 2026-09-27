import { test } from "node:test";
import assert from "node:assert/strict";
import { collectAgentOutput } from "../../packages/agent-runtime/src/index";
import type { AgentEvent } from "../../packages/protocol/src/index";

/**
 * A tool call's OUTCOME survives the fold.
 *
 * `collectAgentOutput` used to copy `{ name, args, resultDigest }` and drop the
 * update frame's `status`, so a call the permission gate refused and a call
 * that ran were the same record in every trace downstream — the digest is a
 * hash, and a denial hashes as readily as a file. These pin that the status is
 * kept, that the refusal text rides with a failure only, and that a call whose
 * result never arrived stays UNKNOWN rather than being painted a success.
 */

const END: AgentEvent = { kind: "turn_end", stopReason: "end_turn", text: "", operations: [], tokensUsed: { input: 0, output: 0, total: 0 } };

async function fold(frames: AgentEvent[]) {
  async function* gen(): AsyncGenerator<AgentEvent> {
    for (const f of frames) yield f;
  }
  return collectAgentOutput(gen(), {});
}

test("a failed call keeps its status and error; a completed one carries no error", async () => {
  const out = await fold([
    { kind: "tool_call", toolCallId: "a", name: "Bash", args: { command: "npm test" } },
    { kind: "tool_call", toolCallId: "b", name: "Read", args: { file_path: "a.ts" } },
    { kind: "tool_call_update", toolCallId: "a", status: "failed", resultDigest: "dgx-a", error: "Bash denied: no shell.execute" },
    { kind: "tool_call_update", toolCallId: "b", status: "completed", resultDigest: "dgx-b" },
    END,
  ]);
  assert.deepEqual(out.toolCalls, [
    { name: "Bash", args: { command: "npm test" }, resultDigest: "dgx-a", status: "failed", error: "Bash denied: no shell.execute" },
    { name: "Read", args: { file_path: "a.ts" }, resultDigest: "dgx-b", status: "completed" },
  ]);
});

test("a call whose result never arrived has no status at all — unknown, not completed", async () => {
  const out = await fold([{ kind: "tool_call", toolCallId: "a", name: "Bash", args: {}, resultDigest: "dgx-args" }, END]);
  const [call] = out.toolCalls ?? [];
  assert.equal(call?.status, undefined);
  assert.equal(call?.error, undefined);
  assert.equal(call?.resultDigest, "dgx-args", "the call-time digest still stands in");
});

test("an error is never carried by a completed update, even one that names it", async () => {
  // A producer bug must not paint a success red: `error` is meaningful only
  // beside `failed`, and a later `completed` for the same id clears an earlier one.
  const out = await fold([
    { kind: "tool_call", toolCallId: "a", name: "Bash", args: {} },
    { kind: "tool_call_update", toolCallId: "a", status: "failed", error: "first attempt refused" },
    { kind: "tool_call_update", toolCallId: "a", status: "completed", error: "stale" },
    END,
  ]);
  const [call] = out.toolCalls ?? [];
  assert.equal(call?.status, "completed");
  assert.equal("error" in (call ?? {}), false);
});
