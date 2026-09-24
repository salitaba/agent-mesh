import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `wake.mail` end to end: config → resolved definition → bundle → the string the
 * runtime is handed.
 *
 * The unit tests in `tests/core/context-inbox-order.test.ts` drive
 * `renderContextInstructions` with a hand-built bundle, which proves the
 * renderer. They cannot prove the *seam*, and a seam is exactly what this repo
 * keeps finding dead: a key that loads, resolves, validates, documents and then
 * reaches nothing. What sits between the config and the model is
 * `buildAgentContext` reading `config.agents[id].wake.mail` and the supervisor
 * handing the rendered result to the runtime — and the second half has a fork
 * in it, because a prompt over the soft cap is re-rendered from a bundle rebuilt
 * at a smaller tier (`supervisor.ts` `fitToSoftCap`). That rebuild goes through
 * the same builder, so it cannot drop the field by construction; but which of
 * the two bundles the runtime ends up holding is not something a test that
 * builds its own bundle can observe.
 *
 * So these assert on `input.instructions` — the string a real runtime turns into
 * a system prompt — captured from a live mesh, whichever route assembled it.
 */

/** A mesh whose `dev` seat has the claims mode on or off, and nothing else different. */
function mesh(mail: "full" | "claims" | undefined) {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      {
        id: "dev",
        role: "developer",
        capabilities: ["repository.write"],
        interests: [],
        ...(mail ? { wake: { mail } } : {}),
      },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
  });
}

/**
 * The prompts the seat was actually shown, in order.
 *
 * Captured from the stub script because `StubRuntime` keeps the contexts its
 * `start` received and not the inputs its `send` received — and it is the input
 * that carries `instructions`.
 */
function capturePrompts(m: Awaited<ReturnType<typeof mesh>>, agentId: string): string[] {
  const prompts: string[] = [];
  stub(m).setScript(agentId, async (input) => {
    prompts.push(input.instructions);
    return { operations: [{ op: "wait" } as MeshOp] };
  });
  return prompts;
}

test("wake.mail: the claim a seat is configured for is what the runtime is handed", async () => {
  const m = await mesh("claims");
  try {
    const prompts = capturePrompts(m, "dev");
    await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "the freeze starts friday" },
      payload: { heads_up: "the freeze starts friday", window_hours: 48 },
    });

    await waitFor("dev was woken for the FYI", () => prompts.length > 0);
    const prompt = prompts[0]!;

    assert.match(prompt, /Unread mail/, "the turn showed the mailbox at all");
    assert.match(prompt, /body withheld/, "the configured mode reached the prompt, not just the bundle");
    assert.match(prompt, /the freeze starts friday/, "as a claim: the subject still names the conversation");
    assert.doesNotMatch(prompt, /window_hours/, "and the body is not in the prompt the model received");
    // The fetch has to be named in the same prompt, or the seat is told a body
    // exists with no way to reach it.
    assert.match(prompt, /mesh_inbox/);
  } finally {
    await m.cleanup();
  }
});

test("wake.mail: an unconfigured seat on the same fixture is handed the body", async () => {
  // The control for the test above, and the reason it is a separate mesh rather
  // than a second assertion: `full` is what every mesh written before this key
  // gets, so if the claim rendering leaked into the default the suite would
  // still be green without this.
  const m = await mesh(undefined);
  try {
    const prompts = capturePrompts(m, "dev");
    await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "the freeze starts friday" },
      payload: { heads_up: "the freeze starts friday", window_hours: 48 },
    });

    await waitFor("dev was woken for the FYI", () => prompts.length > 0);
    const prompt = prompts[0]!;
    assert.match(prompt, /window_hours/, "the default seat sees the body");
    assert.doesNotMatch(prompt, /body withheld/, "and nothing was deferred for it");
  } finally {
    await m.cleanup();
  }
});

test("wake.mail: an ask is inlined even on a claims seat, in the prompt the model received", async () => {
  const m = await mesh("claims");
  try {
    const prompts = capturePrompts(m, "dev");
    await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "REQUEST_REVIEW",
      newThread: { subject: "the retry policy" },
      payload: { question: "does this hold under a partial outage?" },
      note: "the question is the whole ask",
    });

    await waitFor("dev was woken for the ask", () => prompts.length > 0);
    const prompt = prompts[0]!;

    // The obligation exemption has to hold at the same depth as the claim mode
    // itself. `message.delivered` is emitted once the turn ends, so a claim in
    // place of this body would mean a seat marked answered on an ask it was
    // never shown — in production, not in a fixture.
    assert.match(prompt, /does this hold under a partial outage\?/, "an ask keeps its body in claims mode");
    assert.match(prompt, /ANSWER OWED/);
    assert.match(prompt, /contract: none/, "and the contract line that tells the debtor how to decline");
    assert.doesNotMatch(prompt, /body withheld/, "nothing about an ask is deferred");
  } finally {
    await m.cleanup();
  }
});
