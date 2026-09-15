import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";

const ROLE_PROSE = [
  "# Builder",
  "",
  "You own the implementation seat. Read the acceptance criteria before writing any code,",
  "and publish finished work as an artifact rather than describing it in a message.",
].join("\n");

/**
 * Guards the seat-configuration path end to end: a `prompt:` ref in mesh.yaml
 * has to survive resolution and arrive as the system prompt the runtime starts
 * the agent with.
 *
 * The regression this locks down is silent by construction. `prompt.text` is
 * set only for the two hardcoded seats, so every YAML-configured agent carries
 * `prompt.file` — and a seat handed an empty system prompt still answers, just
 * without knowing who it is. Nothing fails; the mission simply goes worse.
 */
test("a file-configured seat reaches runtime.start with its role prompt", async () => {
  const m = await makeMesh({
    agents: [{ id: "builder", role: "builder", prompt: ROLE_PROSE }],
    startup: ["builder"],
  });
  try {
    await waitFor("builder to be started", () => stub(m).lastStartContext("builder") !== undefined);

    const ctx = stub(m).lastStartContext("builder");
    assert.ok(ctx, "runtime.start never ran for builder");
    assert.ok(ctx.rolePromptText.trim().length > 0, "builder started with an empty role prompt");
    // Non-empty alone is not evidence: loadRolePrompt synthesizes a role
    // one-liner for an unconfigured seat, so that assertion passes even when
    // the configured file is never read. Equality is what proves the ref
    // resolved.
    assert.equal(ctx.rolePromptText, ROLE_PROSE);
  } finally {
    await m.cleanup();
  }
});
