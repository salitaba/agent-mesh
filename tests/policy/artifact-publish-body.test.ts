import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";

function fakeTurn(agentId: string) {
  return {
    turnId: `test-${agentId}-${Date.now()}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

/**
 * A publish has three bodies, and which one a seat uses is the single largest
 * cost decision it makes in a turn.
 *
 * `content` is emitted by the model and billed at the output rate — five times
 * fresh input. On the mission this was measured against, 44 inline publishes
 * carried 1.18M characters, roughly 17% of everything the mission wrote, and
 * most of it was either already a file on disk or a previous version being
 * retyped to change a paragraph. `fromPath` and `edits` are the two ways to
 * publish the same document without paying for it twice.
 *
 * What is under test is the whole contract, not just the happy path: exactly
 * one body, containment for the path, exact-and-unique for the edits, and — the
 * property that matters most — refusals that NAME the cheaper field, because a
 * model that just spent 26k output tokens on a body it could not send needs to
 * be told where those tokens should have gone.
 */

async function devMesh() {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
  });
  const ws = await m.supervisor.agentWorkspace("dev");
  fs.mkdirSync(ws, { recursive: true });
  return { m, ws };
}

const publish = (m: Awaited<ReturnType<typeof devMesh>>["m"], op: Record<string, unknown>) =>
  m.supervisor.executeOp("dev", { op: "publish_artifact", ...op } as never, fakeTurn("dev"));

test("fromPath publishes a file the seat wrote, without the body passing through the model", async () => {
  const { m, ws } = await devMesh();
  const body = "# Design\n\nThe whole document, written with Write, never retyped.\n";
  fs.writeFileSync(path.join(ws, "design.md"), body, "utf8");

  const res = await publish(m, { name: "Design", type: "ArchitectureDocument", fromPath: "design.md" });
  assert.equal(res.ok, true, res.reason);

  const rd = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: res.artifactId! }, fakeTurn("dev"));
  assert.equal(rd.reason, body, "the stored artifact must be the file, byte for byte");
  await m.cleanup();
});

test("fromPath reaches into subdirectories of the workspace but never out of it", async () => {
  const { m, ws } = await devMesh();
  fs.mkdirSync(path.join(ws, "docs", "adr"), { recursive: true });
  fs.writeFileSync(path.join(ws, "docs", "adr", "001.md"), "nested", "utf8");

  const ok = await publish(m, { name: "Nested", type: "ADR", fromPath: "docs/adr/001.md" });
  assert.equal(ok.ok, true, ok.reason);

  // The secret is real and outside the workspace — the containment check is the
  // only thing between a seat and the rest of the filesystem.
  const outside = path.join(path.dirname(ws), "outside.txt");
  fs.writeFileSync(outside, "not yours", "utf8");
  const up = await publish(m, { name: "Escape", type: "ADR", fromPath: "../outside.txt" });
  assert.equal(up.ok, false);
  assert.match(String(up.reason), /outside your workspace/);

  const abs = await publish(m, { name: "Escape2", type: "ADR", fromPath: outside });
  assert.equal(abs.ok, false, "an absolute path is the same escape, spelled differently");

  await m.cleanup();
});

test("a symlink out of the workspace is refused like the ../ it really is", async () => {
  const { m, ws } = await devMesh();
  const outside = path.join(path.dirname(ws), "secret.txt");
  fs.writeFileSync(outside, "not yours", "utf8");
  fs.symlinkSync(outside, path.join(ws, "innocent.txt"));

  const res = await publish(m, { name: "Sym", type: "ADR", fromPath: "innocent.txt" });
  assert.equal(res.ok, false, "containment checked on the string alone would have passed this");
  assert.match(String(res.reason), /outside your workspace/);
  await m.cleanup();
});

test("a missing fromPath says where it looked, rather than publishing nothing", async () => {
  const { m } = await devMesh();
  const res = await publish(m, { name: "Ghost", type: "ADR", fromPath: "never-written.md" });
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /does not exist in your workspace/);
  assert.match(String(res.reason), /looked in/, "a path error the seat cannot locate is a path error it cannot fix");
  await m.cleanup();
});

test("a directory is not a document", async () => {
  const { m, ws } = await devMesh();
  fs.mkdirSync(path.join(ws, "src"), { recursive: true });
  const res = await publish(m, { name: "Dir", type: "ADR", fromPath: "src" });
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /not a file/);
  await m.cleanup();
});

test("an oversized inline body is refused with the name of the field that would have worked", async () => {
  const { m } = await devMesh();
  const res = await publish(m, { name: "Huge", type: "RequirementsDoc", content: "x".repeat(60_000) });

  assert.equal(res.ok, false, "the write side was unbounded while the read side paged at 60k");
  assert.match(String(res.reason), /fromPath/, "refusing without teaching just costs the turn again");
  assert.match(String(res.reason), /edits/);

  // Refused, not truncated: a half-document that still digests, versions and
  // satisfies gates is worse than no document at all.
  assert.equal(m.kernel.state.artifacts.size, 0);
  await m.cleanup();
});

test("edits revise a version without re-sending the document", async () => {
  const { m, ws } = await devMesh();
  fs.writeFileSync(path.join(ws, "spine.md"), "# Spine\n\nstatus: draft\n\nbody stays put\n", "utf8");
  const v1 = await publish(m, { name: "Spine", type: "ArchitectureDocument", fromPath: "spine.md" });
  assert.equal(v1.ok, true, v1.reason);

  const v2 = await publish(m, {
    name: "Spine",
    type: "ArchitectureDocument",
    asVersionOf: v1.artifactId!,
    edits: [{ old: "status: draft", new: "status: settled" }],
  });
  assert.equal(v2.ok, true, v2.reason);
  assert.equal(v2.artifact!.version, 2);

  const rd = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: v2.artifactId! }, fakeTurn("dev"));
  assert.equal(rd.reason, "# Spine\n\nstatus: settled\n\nbody stays put\n", "the untouched text must survive verbatim");
  await m.cleanup();
});

test("an edit that does not match exactly once is refused, and nothing is written", async () => {
  const { m, ws } = await devMesh();
  fs.writeFileSync(path.join(ws, "dup.md"), "alpha\nrepeat\nbeta\nrepeat\n", "utf8");
  const v1 = await publish(m, { name: "Dup", type: "ADR", fromPath: "dup.md" });

  const ambiguous = await publish(m, {
    name: "Dup", type: "ADR", asVersionOf: v1.artifactId!,
    edits: [{ old: "repeat", new: "changed" }],
  });
  assert.equal(ambiguous.ok, false);
  assert.match(String(ambiguous.reason), /more than once/);

  const absent = await publish(m, {
    name: "Dup", type: "ADR", asVersionOf: v1.artifactId!,
    edits: [{ old: "gamma", new: "x" }],
  });
  assert.equal(absent.ok, false);
  assert.match(String(absent.reason), /not found/);

  // All-or-nothing: the second edit is the bad one, and the first must not have
  // landed. An artifact version is immutable and gets cited as evidence, so a
  // half-applied revision is a document that claims something nobody wrote.
  const partial = await publish(m, {
    name: "Dup", type: "ADR", asVersionOf: v1.artifactId!,
    edits: [{ old: "alpha", new: "APPLIED" }, { old: "nowhere", new: "x" }],
  });
  assert.equal(partial.ok, false);

  const still = m.kernel.state.artifacts.get(v1.artifactId!);
  assert.equal(still!.version, 1, "a refused revision must leave the artifact where it was");
  const rd = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: v1.artifactId! }, fakeTurn("dev"));
  assert.match(String(rd.reason), /^alpha/, "the first edit of a refused batch must not have been kept");
  await m.cleanup();
});

test("edits without asVersionOf are refused: a diff needs something to be a diff against", async () => {
  const { m } = await devMesh();
  const res = await publish(m, { name: "Orphan", type: "ADR", edits: [{ old: "a", new: "b" }] });
  assert.equal(res.ok, false);
  assert.match(String(res.reason), /asVersionOf/);
  await m.cleanup();
});

test("two bodies are refused rather than guessed between", async () => {
  const { m, ws } = await devMesh();
  fs.writeFileSync(path.join(ws, "both.md"), "from the file", "utf8");
  const res = await publish(m, { name: "Both", type: "ADR", content: "from the model", fromPath: "both.md" });

  assert.equal(res.ok, false, "silently picking one leaves an immutable version nobody can trace");
  assert.match(String(res.reason), /exactly one/);
  assert.match(String(res.reason), /content and fromPath/);
  await m.cleanup();
});

test("no body at all names all three ways in", async () => {
  const { m } = await devMesh();
  const res = await publish(m, { name: "Empty", type: "ADR" });
  assert.equal(res.ok, false);
  for (const field of ["content", "fromPath", "edits"]) assert.match(String(res.reason), new RegExp(field));
  await m.cleanup();
});

test("an inline body under the ceiling still works, because some documents were never files", async () => {
  const { m } = await devMesh();
  const res = await publish(m, { name: "Note", type: "ResearchReport", content: "a short finding" });
  assert.equal(res.ok, true, res.reason);
  await m.cleanup();
});
