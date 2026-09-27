import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { WORK_TURN_TIMEOUT_MULTIPLE } from "../../packages/core/src/index";

/**
 * The Claude adapter's own turn timer must outlive every deadline the
 * supervisor can set, extensions included.
 *
 * It was wired at `turn_timeout_ms + 30s`, so it fired before any extension
 * could take effect: a live seat ~94 native Write/Edit/Bash calls into a turn,
 * last frame 17 s old, was killed at exactly 1,200,000 ms while the supervisor
 * would have let it run. The adapter's own timeout behaviour is covered in
 * tests/integration/claude-live-turn.test.ts; this pins the number the server
 * hands it, which no other test reads — reverting the wiring left all 433
 * integration and server tests green.
 */
test("the server arms the Claude adapter's timer past the supervisor's ceiling, not its base", async () => {
  const base = 1_200_000;
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", capabilities: ["repository.read"], interests: [] }], turnTimeoutMs: base });
  try {
    const adapter = m.supervisor.deps.runtimes.resolve("claude") as unknown as { turnTimeoutMs: number };
    const ceiling = base * WORK_TURN_TIMEOUT_MULTIPLE;
    assert.ok(adapter.turnTimeoutMs > ceiling, `adapter timer ${adapter.turnTimeoutMs}ms must pass the ${ceiling}ms ceiling`);
    // Past the ceiling by more than the supervisor's own post-interrupt grace
    // (2 s), so a supervisor stop always lands first.
    assert.ok(adapter.turnTimeoutMs - ceiling > 2000, "and by more than the stop's grace window");
  } finally {
    await m.cleanup();
  }
});
