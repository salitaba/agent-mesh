import test from "node:test";
import assert from "node:assert/strict";

import {
  FILE_GROUPS,
  LINE_WINDOW,
  NO_FILTER,
  countLabel,
  distinctVersions,
  downloadName,
  emptyCopy,
  fileModes,
  filterFiles,
  fmtSize,
  groupCounts,
  groupFiles,
  groupOf,
  latestArtifactSeq,
  latestPerName,
  lineWindow,
  matchesQuery,
  modeLabel,
  nextIndex,
  pathFromRef,
  previousVersion,
  readAs,
  trailWords,
  typeCounts,
  type Art,
  type ArtRecord,
} from "../../apps/mesh-dashboard/src/files";

/**
 * The Files page's decisions, away from the DOM. The history test uses the shape a real finished mission returned from
 * GET /artifacts/:id/versions, because that shape is the reason the module exists: one record per status change, so a file
 * at version 2 arrives as seven records that all say version 2.
 */

const art = (over: Partial<Art> & { name: string }): Art => ({
  id: `art-${over.name}`,
  type: "RequirementsDoc",
  status: "DRAFT",
  owner: "pm",
  version: 1,
  createdAt: "2026-10-04T19:16:30.000Z",
  ...over,
});

test("a status lands in the group that says whether the file is finished, and an unknown one is kept, not dropped", () => {
  const id = (s: string): string => groupOf(s).id;
  for (const s of ["MERGED", "ACCEPTED", "FINAL", "MERGEABLE", "VERIFIED", "APPROVED"]) assert.equal(id(s), "done", s);
  // Passed QA but not security: still waiting on someone, so not "approved and merged".
  for (const s of ["READY_FOR_REVIEW", "UNDER_REVIEW", "IMPLEMENTED", "QA_VERIFIED", "SECURITY_VERIFIED"]) assert.equal(id(s), "review", s);
  assert.equal(id("REJECTED"), "rework");
  for (const s of ["DRAFT", "PROPOSED"]) assert.equal(id(s), "draft", s);
  assert.equal(id("ARCHIVED"), "archived");
  assert.equal(id("SOMETHING_NEW"), "other");
  assert.equal(id(""), "other");
});

test("every artifact status the protocol defines belongs to exactly one group", () => {
  // Mirrors ARTIFACT_STATUSES in packages/protocol/src/catalog.ts: a status added there must be placed here on purpose.
  const protocol = ["DRAFT", "READY_FOR_REVIEW", "UNDER_REVIEW", "REJECTED", "APPROVED", "VERIFIED", "MERGEABLE", "MERGED", "PROPOSED", "IMPLEMENTED", "QA_VERIFIED", "SECURITY_VERIFIED", "ACCEPTED", "FINAL", "ARCHIVED"];
  for (const s of protocol) {
    const homes = FILE_GROUPS.filter((g) => g.statuses.includes(s));
    assert.equal(homes.length, 1, `${s} is in ${homes.length} groups`);
  }
});

test("groups come in reading order, empty ones are left out, and a file keeps its place within its group", () => {
  const list = [
    art({ name: "d1", status: "DRAFT" }),
    art({ name: "m1", status: "MERGED" }),
    art({ name: "r1", status: "READY_FOR_REVIEW" }),
    art({ name: "x1", status: "BRAND_NEW" }),
    art({ name: "m2", status: "APPROVED" }),
  ];
  const groups = groupFiles(list);
  assert.deepEqual(groups.map((g) => g.id), ["done", "review", "draft", "other"]);
  assert.deepEqual(groups[0]!.items.map((a) => a.name), ["m1", "m2"]);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), list.length, "nothing is lost");
  assert.deepEqual(groupFiles([]), []);
  assert.deepEqual(groupCounts(list), { done: 2, review: 1, rework: 0, draft: 1, archived: 0, other: 1 });
});

test("two artifacts with one name and type collapse to the higher version, then the newer", () => {
  const a = art({ name: "plan", version: 1, createdAt: "2026-10-04T10:00:00Z" });
  const b = art({ id: "art-plan-b", name: "plan", version: 3, createdAt: "2026-10-04T09:00:00Z" });
  const c = art({ id: "art-plan-c", name: "plan", version: 3, createdAt: "2026-10-04T11:00:00Z" });
  const other = art({ name: "plan", type: "ReleasePlan" });
  const kept = latestPerName([a, b, c, other]);
  assert.deepEqual(kept.map((x) => x.id).sort(), ["art-plan", "art-plan-c"].sort());
  assert.equal(kept.length, 2, "the same name under another type is a different file");
});

test("a search needs every word to match somewhere: name, owner, type, path or status", () => {
  const a = art({ name: "payment-requirements", owner: "pm", type: "RequirementsDoc", status: "READY_FOR_REVIEW" });
  const patch = art({ name: "patch-1", owner: "developer", type: "CodePatch", metadata: { path: "src/tx/Pipeline.java" } });
  assert.ok(matchesQuery(a, "pm requirements"), "owner and name together");
  assert.ok(matchesQuery(a, "READY for review"), "the status as it is read, in any case");
  assert.ok(matchesQuery(a, "ready_for_review"), "and as it is stored");
  assert.ok(matchesQuery(patch, "pipeline.java codepatch"), "a repo path and a type");
  assert.ok(!matchesQuery(a, "pm architect"), "one word with no home rejects the file");
  assert.ok(matchesQuery(a, "   "), "a blank query keeps everything");
});

test("filters combine, and a copy hidden by 'latest of each name' never matches a search", () => {
  const old = art({ id: "art-old", name: "spec", version: 1, status: "DRAFT", createdAt: "2026-10-04T08:00:00Z" });
  const fresh = art({ id: "art-new", name: "spec", version: 2, status: "APPROVED", createdAt: "2026-10-04T09:00:00Z" });
  const code = art({ id: "art-code", name: "patch", type: "CodePatch", status: "MERGED", createdAt: "2026-10-04T10:00:00Z" });
  const all = [old, fresh, code];
  assert.deepEqual(filterFiles(all, NO_FILTER).map((a) => a.id), ["art-code", "art-new"], "newest first, older copy hidden");
  assert.deepEqual(filterFiles(all, { ...NO_FILTER, latestOnly: false }).map((a) => a.id), ["art-code", "art-new", "art-old"]);
  assert.deepEqual(filterFiles(all, { ...NO_FILTER, type: "CodePatch" }).map((a) => a.id), ["art-code"]);
  assert.deepEqual(filterFiles(all, { ...NO_FILTER, group: "done" }).map((a) => a.id), ["art-code", "art-new"]);
  assert.deepEqual(filterFiles(all, { ...NO_FILTER, group: "draft" }), [], "the hidden draft copy is not found by its group");
  assert.deepEqual(filterFiles(all, { ...NO_FILTER, group: "draft", latestOnly: false }).map((a) => a.id), ["art-old"]);
});

test("equal times keep a stable order, so a refresh of the same data does not shuffle the list", () => {
  const t = "2026-10-04T10:00:00Z";
  const list = ["c", "a", "b"].map((n) => art({ name: n, createdAt: t }));
  assert.deepEqual(filterFiles(list, NO_FILTER).map((a) => a.name), ["a", "b", "c"]);
});

test("500 files filter and group without losing or repeating one", () => {
  const statuses = ["MERGED", "APPROVED", "READY_FOR_REVIEW", "DRAFT", "REJECTED", "ARCHIVED"];
  const list = Array.from({ length: 500 }, (_, i) =>
    art({ id: `art-${i}`, name: `file-${i}`, status: statuses[i % statuses.length]!, createdAt: new Date(Date.UTC(2026, 9, 4, 0, 0, i)).toISOString() }));
  const kept = filterFiles(list, NO_FILTER);
  assert.equal(kept.length, 500);
  assert.equal(new Set(kept.map((a) => a.id)).size, 500);
  assert.equal(kept[0]!.name, "file-499", "newest first");
  const groups = groupFiles(kept);
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), 500);
  assert.deepEqual(groups.map((g) => g.id), ["done", "review", "rework", "draft", "archived"]);
});

test("the type list is sorted and counted", () => {
  const list = [art({ name: "a", type: "ReleasePlan" }), art({ name: "b", type: "CodePatch" }), art({ name: "c", type: "CodePatch" })];
  assert.deepEqual(typeCounts(list), [{ type: "CodePatch", n: 2 }, { type: "ReleasePlan", n: 1 }]);
});

test("the count says how many files, and how many of the whole when a filter hides some", () => {
  assert.equal(countLabel(9, 9), "9 files");
  assert.equal(countLabel(1, 1), "1 file");
  assert.equal(countLabel(0, 0), "0 files");
  assert.equal(countLabel(4, 9), "4 of 9 files");
  assert.equal(countLabel(1, 9), "1 of 9 files");
});

// The history GET /artifacts/:id/versions returned for a patch that merged in a real run: eight records, two versions.
const REAL_HISTORY: ArtRecord[] = [
  { version: 1, status: "DRAFT", createdAt: "2026-10-04T19:16:33.119Z", digest: "sha256:5d6f", createdBy: "developer" },
  { version: 2, status: "DRAFT", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
  { version: 2, status: "READY_FOR_REVIEW", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
  { version: 2, status: "UNDER_REVIEW", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
  { version: 2, status: "APPROVED", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
  { version: 2, status: "VERIFIED", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
  { version: 2, status: "MERGEABLE", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
  { version: 2, status: "MERGED", createdAt: "2026-10-04T19:16:33.247Z", digest: "sha256:823f", createdBy: "developer" },
];

test("eight history records fold into two versions, each with the status trail it walked", () => {
  const v = distinctVersions(REAL_HISTORY);
  assert.deepEqual(v.map((x) => x.version), [1, 2]);
  assert.equal(v[0]!.status, "DRAFT");
  assert.deepEqual(v[0]!.trail, ["DRAFT"]);
  assert.equal(v[1]!.status, "MERGED", "a version stands at its last record");
  assert.deepEqual(v[1]!.trail, ["DRAFT", "READY_FOR_REVIEW", "UNDER_REVIEW", "APPROVED", "VERIFIED", "MERGEABLE", "MERGED"]);
  assert.deepEqual(trailWords(v[1]!.trail).slice(0, 3), ["draft", "ready for review", "in review"]);
});

test("a repeated status collapses, an out-of-order history still sorts by version, and a record with no version is ignored", () => {
  const v = distinctVersions([
    { version: 3, status: "DRAFT", createdAt: "t3" },
    { version: 1, status: "DRAFT", createdAt: "t1" },
    { version: 1, status: "DRAFT", createdAt: "t1" },
    { version: 1, status: "READY_FOR_REVIEW", createdAt: "t1" },
    { status: "APPROVED", createdAt: "x" } as unknown as ArtRecord,
  ]);
  assert.deepEqual(v.map((x) => x.version), [1, 3]);
  assert.deepEqual(v[0]!.trail, ["DRAFT", "READY_FOR_REVIEW"]);
  assert.deepEqual(distinctVersions([]), []);
});

test("the version a reviewer compares against is the one before, and a first version has none", () => {
  const v = distinctVersions(REAL_HISTORY);
  assert.equal(previousVersion(v, 2), 1);
  assert.equal(previousVersion(v, 1), null);
  assert.equal(previousVersion([{ version: 1 }, { version: 4 }, { version: 7 }], 7), 4, "versions need not be consecutive");
  assert.equal(previousVersion([], 1), null);
});

test("arrow keys move one row, page keys ten, and the list stops at its ends instead of wrapping", () => {
  assert.equal(nextIndex("ArrowDown", 0, 5), 1);
  assert.equal(nextIndex("ArrowDown", 4, 5), 4, "no wrap past the last row");
  assert.equal(nextIndex("ArrowUp", 0, 5), 0, "no wrap past the first row");
  assert.equal(nextIndex("ArrowUp", 3, 5), 2);
  assert.equal(nextIndex("PageDown", 2, 30), 12);
  assert.equal(nextIndex("PageDown", 25, 30), 29);
  assert.equal(nextIndex("PageUp", 4, 30), 0);
  assert.equal(nextIndex("Home", 3, 5), 0);
  assert.equal(nextIndex("End", 0, 5), 4);
  assert.equal(nextIndex("a", 3, 5), 3, "any other key leaves focus where it is");
  assert.equal(nextIndex("ArrowDown", 0, 0), -1, "an empty list has no row to go to");
  assert.equal(nextIndex("ArrowDown", 99, 5), 4, "a stale index is clamped, not trusted");
});

test("a long file is drawn a window at a time, and the window never exceeds the file", () => {
  assert.deepEqual(lineWindow(10), { shown: 10, remaining: 0, next: 10 });
  const w = lineWindow(40_000);
  assert.equal(w.shown, LINE_WINDOW);
  assert.equal(w.remaining, 40_000 - LINE_WINDOW);
  assert.equal(w.next, LINE_WINDOW * 2);
  const asked = lineWindow(40_000, w.next);
  assert.equal(asked.shown, LINE_WINDOW * 2);
  assert.equal(lineWindow(2000, 3000).shown, 2000, "asking for more than there is shows all of it");
  assert.equal(lineWindow(2000, 3000).next, 2000);
  assert.equal(lineWindow(0).shown, 0);
});

test("sizes read in the largest unit that keeps a short number", () => {
  assert.equal(fmtSize(0), "0B");
  assert.equal(fmtSize(512), "512B");
  assert.equal(fmtSize(1536), "1.5kB");
  assert.equal(fmtSize(130_000), "127kB");
  assert.equal(fmtSize(1_572_864), "1.5MB");
});

test("a stored file:// location becomes a plain path a person can paste, and anything else passes through", () => {
  assert.equal(pathFromRef("file:///tmp/p/.mesh-state/artifacts/artifacts/art-1/v2.txt"), "/tmp/p/.mesh-state/artifacts/artifacts/art-1/v2.txt");
  assert.equal(pathFromRef("file:///tmp/a%20b/v1.txt"), "/tmp/a b/v1.txt", "an escaped space is a space");
  assert.equal(pathFromRef("s3://bucket/key"), "s3://bucket/key");
  assert.equal(pathFromRef(undefined), "");
});

test("a document is drawn as a document, and a patch, a schema or a spec is drawn as code", () => {
  // The drawer used to render markdown only for a name ending in .md, and agents never name an artifact that way, so every
  // report arrived as raw `##` and `**`. The other direction matters as much: a unified diff read as markdown turns each
  // removed line (`-x`) into a bullet.
  for (const type of ["RequirementsDoc", "ArchitectureDocument", "ADR", "ReleasePlan", "TestReport", "SecurityReport", "ResearchReport", "Decision", "TaskSpec", "DesignSpec"]) {
    assert.equal(readAs({ name: "payment-requirements", type }), "markdown", type);
  }
  for (const type of ["CodePatch", "ApiSpec", "DatabaseSchema"]) assert.equal(readAs({ name: "thing", type }), "text", type);
  assert.equal(readAs({ name: "notes.md", type: "CodePatch" }), "markdown", "a name that says .md wins");
  assert.equal(readAs({ name: "schema.sql", type: "RequirementsDoc" }), "text", "so does one that says it is code");
});

test("a download is named for what it is: documents end in .md, patches in .patch, the rest in .txt, a real extension is kept", () => {
  assert.equal(downloadName({ name: "payment-requirements", type: "RequirementsDoc" }), "payment-requirements.md");
  assert.equal(downloadName({ name: "patch-tx-pipeline-2", type: "CodePatch" }), "patch-tx-pipeline-2.patch");
  assert.equal(downloadName({ name: "orders", type: "DatabaseSchema" }), "orders.txt");
  assert.equal(downloadName({ name: "Pipeline.java", type: "CodePatch" }), "Pipeline.java");
  assert.equal(downloadName({ name: "README.md", type: "RequirementsDoc" }), "README.md");
});

test("a file offers a switch only when it has two views, and each view has a name", () => {
  assert.deepEqual(fileModes("markdown", true, false), ["rendered", "source"]);
  assert.deepEqual(fileModes("markdown", true, true), ["rendered", "source", "changes"]);
  assert.deepEqual(fileModes("text", true, false), ["source"], "one view: no switch");
  assert.deepEqual(fileModes("text", true, true), ["source", "changes"]);
  assert.deepEqual(fileModes("image", false, false), ["rendered"]);
  assert.deepEqual(fileModes("binary", false, false), ["rendered"]);
  assert.deepEqual(fileModes("markdown", false, false), ["rendered"], "no text yet: nothing to show as source");
  assert.equal(modeLabel("markdown", "rendered"), "Rendered");
  assert.equal(modeLabel("markdown", "source"), "Source");
  assert.equal(modeLabel("text", "source"), "Contents");
  assert.equal(modeLabel("image", "rendered"), "Image");
  assert.equal(modeLabel("text", "changes"), "Changes");
});

test("the list refreshes on an artifact event and on no other", () => {
  const e = (seq: number, type: string) => ({ seq, type });
  assert.equal(latestArtifactSeq([]), 0);
  assert.equal(latestArtifactSeq([e(1, "goal.created"), e(2, "budget.consumed")]), 0, "nothing about files");
  assert.equal(latestArtifactSeq([e(5, "artifact.created"), e(9, "artifact.versioned"), e(12, "artifact.transition"), e(20, "message.sent")]), 12);
  assert.equal(latestArtifactSeq([e(30, "artifact.transition"), e(4, "artifact.created")]), 30, "order does not matter");
  assert.equal(latestArtifactSeq([e(7, "artifactual.thing")]), 0, "a prefix is not a word");
});

test("an empty Files page says what is missing and offers the mission's own next move only where there is one", () => {
  assert.equal(emptyCopy("parked", false).start, true);
  assert.match(emptyCopy("parked", false).body, /Start the mission/);
  assert.match(emptyCopy("parked", true).body, /Continue it/);
  assert.equal(emptyCopy("paused", false).start, true);
  assert.match(emptyCopy("paused", false).body, /Resume/);
  for (const phase of ["running", "quiet", "stalled"]) {
    const c = emptyCopy(phase, true);
    assert.equal(c.start, false, `${phase}: nothing to start`);
    assert.match(c.body, /Nothing has been published/);
  }
  const done = emptyCopy("done", true);
  assert.equal(done.title, "No files were published", "a delivered mission with no files is a fact, not 'no files yet'");
  assert.equal(done.start, false);
  for (const phase of ["needs-you", "ceiling", "failed", "offline", "loading", "no-goal"]) assert.equal(emptyCopy(phase, false).start, false, phase);
});
