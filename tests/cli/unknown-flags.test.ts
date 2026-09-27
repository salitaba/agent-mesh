import { test } from "node:test";
import assert from "node:assert/strict";
import { unknownFlagWarnings, parseArgs } from "../../apps/mesh-cli/src/index";

/**
 * A flag the CLI does not read should say so.
 *
 * `parseArgs` collects every `--x` into a bag and each command reads the keys it
 * knows, so anything else is dropped in silence: `mesh status --json` printed the
 * human format and said nothing, and `mesh init --dir /tmp/x` scaffolded into the
 * cwd because the directory is positional. Both looked accepted.
 *
 * The check is deliberately narrow — launch commands only, whose flag list is
 * parsed in that same file and can be kept exact. A table guessed for the bus
 * commands would warn on valid invocations, which teaches operators to read past
 * warnings and is a worse failure than the one being fixed.
 */

test("an unknown flag on a launch command is named, with the accepted set", () => {
  const out = unknownFlagWarnings("run", { nonsense: true, port: "7421" });
  assert.equal(out.length, 1);
  assert.match(out[0]!, /--nonsense is not a flag `mesh run` reads/);
  assert.match(out[0]!, /ignored rather than refused/);
  assert.match(out[0]!, /--port/, "names what IS accepted, so the remedy is in the message");
});

test("every real launch flag is silent", () => {
  // The exact set the launch case parses: resolveLaunchMode, gitModeFromFlags,
  // and the launchMesh call. If one of these ever warns, the table has drifted
  // from the parser and the warning is lying.
  const flags = {
    port: "7430",
    tui: true,
    "no-tui": true,
    git: true,
    "no-git": true,
    fresh: true,
    resume: true,
    live: true,
    parked: true,
    "ui-only": true,
    "no-demo": true,
  };
  for (const command of ["run", "serve", "up", "console", "ui"]) {
    assert.deepEqual(unknownFlagWarnings(command, flags), [], `${command} rejected a flag it actually reads`);
  }
});

test("commands outside the launch set are not policed", () => {
  // Their flags are wider and scattered across call sites; a guessed table would
  // produce false warnings, so they are deliberately unchecked.
  assert.deepEqual(unknownFlagWarnings("status", { json: true, bus: "http://x" }), []);
  assert.deepEqual(unknownFlagWarnings("init", { dir: "/tmp/x" }), []);
});

test("several unknown flags are reported together, in one line", () => {
  const out = unknownFlagWarnings("console", { alpha: true, beta: "2" });
  assert.equal(out.length, 1, "one warning per command, not one per flag");
  assert.match(out[0]!, /--alpha, --beta are not flags/);
});

test("it reads the flags parseArgs actually produces", () => {
  // Guards the seam: `--nonsense` followed by a positional must land as a boolean
  // flag, not swallow the path as its value.
  const args = parseArgs(["run", "mesh.yaml", "--nonsense", "--port", "7421"]);
  assert.deepEqual(args.positional, ["mesh.yaml"]);
  assert.equal(args.flags.nonsense, true);
  assert.equal(args.flags.port, "7421");
  assert.equal(unknownFlagWarnings(args.command, args.flags).length, 1);
});
