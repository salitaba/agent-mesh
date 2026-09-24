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
 * Artifacts are kept OUT of the assembled prompt by reference, but a read used
 * to put the whole document back with no ceiling — the one path by which an
 * agent could flood its own window from inside a turn.
 *
 * The property under test is not merely "it is capped". A silent cap is worse
 * than none: an agent that cannot distinguish a partial document from a whole
 * one reasons confidently over the half it received. Truncation has to arrive
 * as data, with a way to ask for the rest.
 */

/**
 * Publishes through `fromPath`, not `content`: the bodies these tests need are
 * far over the inline ceiling, which is exactly the case `fromPath` exists for.
 * A 150k document is still a document — the cap refuses to have it TYPED, not
 * to have it published.
 */
async function meshWithArtifact(content: string) {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
  });
  const ws = await m.supervisor.agentWorkspace("dev");
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, "big-doc.md"), content, "utf8");
  const pub = await m.supervisor.executeOp(
    "dev",
    { op: "publish_artifact", name: "BigDoc", type: "RequirementsDoc", fromPath: "big-doc.md" },
    fakeTurn("dev"),
  );
  assert.equal(pub.ok, true, pub.reason);
  return { m, id: pub.artifactId! };
}

test("a small artifact reads whole, with no truncation flag", async () => {
  const { m, id } = await meshWithArtifact("short content");
  const rd = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: id }, fakeTurn("dev"));

  assert.equal(rd.ok, true);
  assert.equal(rd.reason, "short content");
  assert.equal(rd.truncated, undefined, "a complete read must not look partial");
  assert.equal(rd.totalChars, "short content".length);
});

test("an oversized artifact is sliced and says so, with an offset to continue from", async () => {
  const body = "A".repeat(150_000);
  const { m, id } = await meshWithArtifact(body);

  const first = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: id }, fakeTurn("dev"));
  assert.equal(first.ok, true);
  assert.equal(first.truncated, true, "an agent must be able to tell it got a slice");
  assert.equal(first.totalChars, body.length);
  assert.ok(first.reason!.length < body.length, "content was not actually capped");
  assert.equal(first.nextOffset, first.reason!.length);
});

test("paging with the returned offset walks the whole document and terminates", async () => {
  const body = "B".repeat(150_000);
  const { m, id } = await meshWithArtifact(body);

  let offset = 0;
  let assembled = "";
  for (let guard = 0; guard < 20; guard++) {
    const page: { ok: boolean; reason?: string; truncated?: boolean; nextOffset?: number } =
      await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: id, offset }, fakeTurn("dev"));
    assert.equal(page.ok, true);
    assembled += page.reason ?? "";
    if (!page.truncated) break;
    offset = page.nextOffset!;
  }

  assert.equal(assembled, body, "paging must reconstruct the document exactly, with no gap or overlap");
});

test("an offset past the end returns empty rather than looping forever", async () => {
  const { m, id } = await meshWithArtifact("tiny");
  const rd = await m.supervisor.executeOp(
    "dev",
    { op: "read_artifact", artifactRef: id, offset: 9999 },
    fakeTurn("dev"),
  );
  assert.equal(rd.ok, true);
  assert.equal(rd.reason, "");
  assert.equal(rd.truncated, undefined, "past-the-end must terminate, not invite another page");
});
