/**
 * A mission that is started on the Overview and finishes in front of the person said "No files are recorded for this goal" at the
 * moment of delivery, the one time the answer matters, and kept saying it until a reload: the page read the file list once, when it
 * opened. The page is React with effects, which these tests cannot run, so they pin the two lines the fix rests on and leave the
 * behaviour to the browser check named in the commit that added them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { latestArtifactSeq } from "../../apps/mesh-dashboard/src/files";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const overview = fs.readFileSync(path.join(SRC, "views", "Overview.tsx"), "utf8");

test("the Overview watches the newest artifact event, the signal that a file was published or changed", () => {
  assert.match(overview, /latestArtifactSeq\(events\)/);
  assert.equal(
    latestArtifactSeq([
      { seq: 3, type: "message.sent" },
      { seq: 9, type: "artifact.created" },
      { seq: 12, type: "artifact.transition" },
      { seq: 14, type: "agent.turn" },
    ]),
    12,
    "only artifact events move it",
  );
});

test("and reads the file list again when that signal moves, not only when the page opens", () => {
  const files = overview.indexOf('client.api("GET", "/artifacts")');
  assert.ok(files > 0, "the page still reads the file list");
  const deps = overview.slice(files).match(/\}, \[([^\]]*)\]\);/);
  assert.ok(deps, "the effect that reads the files has a dependency list");
  assert.match(deps[1]!, /\bartSeq\b/, "artSeq is a dependency, so a new artifact event reads the files again");
});
