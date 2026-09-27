import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";

/**
 * The git-backed tests skip on a machine without git, which is right for a
 * laptop and wrong for CI: a runner image that lost git reported ~40 tests as
 * skipped and the suite as green, having tested no merge, reset or restore.
 *
 * So the skip is only granted where git is optional. Under `CI` (set by every
 * mainstream runner) or `MESH_REQUIRE_GIT=1`, a missing git is a failure,
 * reported once per file by the test registered below, and the git tests
 * themselves still skip so the one failure names the cause instead of forty
 * ENOENTs burying it.
 */
export const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** True when the environment demands the git tests actually run. */
export function gitRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const ci = env.CI;
  return (ci !== undefined && ci !== "" && ci !== "0" && ci.toLowerCase() !== "false") || env.MESH_REQUIRE_GIT === "1";
}

/** The `skip` option for a git-backed test: false when git is present. */
export const gitSkip: false | string = hasGit ? false : "git unavailable";

if (!hasGit && gitRequired()) {
  test("git is available (required under CI / MESH_REQUIRE_GIT=1)", () => {
    assert.fail("git is not on PATH, but CI or MESH_REQUIRE_GIT=1 requires the git-backed tests to run instead of skipping");
  });
}
