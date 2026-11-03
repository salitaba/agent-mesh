import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";

/**
 * L2 memory has two kinds now: `fact` (state of the work) and `procedure` (how
 * this team does something). A playbook line is a deliberate, stable
 * instruction, so it is admitted to the brief before facts and turn exhaust and
 * rendered under its own heading — otherwise a busy mission would evict the one
 * note a seat most needs to keep.
 */

const note = (agentId: string, key: string, value: string, kind?: "fact" | "procedure") => ({
  agentId,
  note: { agentId, key, value, ...(kind ? { kind } : {}), updatedAt: new Date().toISOString(), eventId: "" },
});

test("a procedure note renders as the seat's playbook, ahead of its facts", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: [], interests: [] }] });
  try {
    await m.kernel.emit("memory.updated", note("dev", "review-style", "always approve with a comment", "procedure"), { actorId: "dev" });
    await m.kernel.emit("memory.updated", note("dev", "api-version", "the API is v17"), { actorId: "dev" });

    assert.equal(m.kernel.state.memory.get("dev")?.get("review-style")?.kind, "procedure");
    assert.equal(m.kernel.state.memory.get("dev")?.get("api-version")?.kind, undefined, "a plain note stays a fact");

    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    assert.match(text, /## Your playbook \(L2 — how this team does things\)/);
    assert.match(text, /- review-style: always approve with a comment/);
    assert.match(text, /## Your memory \(L2\)/);
    assert.match(text, /- api-version: the API is v17/);
    assert.ok(text.indexOf("## Your playbook") < text.indexOf("## Your memory"), "the playbook is rendered first");
    assert.ok(text.indexOf("review-style") < text.indexOf("api-version"), "and its lines come before the facts");
  } finally {
    await m.cleanup();
  }
});

test("a note with no kind is a fact, and a playbook-only seat gets no empty memory heading", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: [], interests: [] }] });
  try {
    await m.kernel.emit("memory.updated", note("dev", "house-rule", "run the full suite before a merge", "procedure"), { actorId: "dev" });
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    assert.match(text, /run the full suite before a merge/);
    assert.doesNotMatch(text, /## Your memory \(L2\)/, "no facts, no empty section");
  } finally {
    await m.cleanup();
  }
});
