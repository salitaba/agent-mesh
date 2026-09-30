import * as fs from "fs";
import * as path from "path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { TOOL_PAGE_CHARS, PAGE_ENVELOPE_CHARS } from "../../apps/mesh-server/src/pagination";
import { pageCut } from "../../packages/core/src/text-page";
import { mintSeatToken } from "../../packages/core/src/seat-token";

/**
 * A page of an artifact ends at a line, not at the character budget.
 *
 * The CodePatch in the second cronlite run was cut at character 22,800, between
 * `test('…', (` and `) => {`. The tech-lead read all four pages and rejected the patch as
 * "final test is incomplete. Line ends with `test('…', (` without body" although the
 * stored body was whole (its sha256 matched the event's digest). A rejected artifact cannot
 * be approved again, so a misread seam cost a whole review-merge cycle, about 290k tokens
 * over the stretch that followed.
 */

// ------------------------------------------------------------------ pageCut

test("a text that fits is shown whole", () => {
  assert.equal(pageCut("short\ntext", 100), 10);
  assert.equal(pageCut("", 100), 0);
  assert.equal(pageCut("x".repeat(100), 100), 100, "exactly the budget is not a cut");
});

test("a page ends just after the last newline in its second half", () => {
  const text = "a".repeat(60) + "\n" + "b".repeat(60) + "\n" + "c".repeat(60);
  // budget 100: the window is the first 100 characters; the last newline in it is at 60.
  assert.equal(pageCut(text, 100), 61);
  assert.equal(text.slice(0, pageCut(text, 100)).endsWith("\n"), true);
});

test("with no newline to cut at, the page is cut hard, at the budget", () => {
  assert.equal(pageCut("x".repeat(500), 100), 100, "a minified line has no seam to respect");
  // A newline only in the first half would make a page of ten characters: not worth a line.
  const early = "abcdefghi\n" + "y".repeat(500);
  assert.equal(pageCut(early, 100), 100);
});

test("a hard cut never separates the two halves of a surrogate pair", () => {
  const text = "a".repeat(98) + "\u{1F600}" + "b".repeat(50);
  const cut = pageCut(text, 99);
  assert.equal(cut, 98, "the emoji moves to the next page whole");
  const code = text.charCodeAt(cut - 1);
  assert.equal(code >= 0xd800 && code <= 0xdbff, false);
});

test("whatever the text and the budget, paging by pageCut reaches every character exactly once", () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 60; round++) {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 80) }, () => "x".repeat(Math.floor(rnd() * 150)));
    const text = lines.join(rnd() < 0.5 ? "\n" : "\n\n") + (rnd() < 0.5 ? "\n" : "");
    const budget = 1 + Math.floor(rnd() * 200);
    let offset = 0;
    let assembled = "";
    for (let guard = 0; offset < text.length && guard < text.length + 5; guard++) {
      const window = text.slice(offset);
      const cut = pageCut(window, budget);
      assert.ok(cut >= 1 && cut <= Math.max(budget, 1) || cut === window.length, `cut ${cut} for budget ${budget}`);
      assembled += window.slice(0, cut);
      offset += cut;
    }
    assert.equal(assembled, text);
  }
});

// ------------------------------------------------- through the real tool call

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function caller(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    assert.equal(res.result.isError, false, res.result.content[0]!.text);
    return JSON.parse(res.result.content[0]!.text);
  };
}

/** A document whose naive page boundary falls between `(` and `)` of a test declaration, as in the live run. */
function documentWithSeamInsideACall(budget: number): { body: string; seamAt: number } {
  const call = "test('parse() day of week values include 0 or 7 for Sunday', () => {\n  assert.ok(true);\n});\n";
  const openAt = call.indexOf("', (") + 3; // the index of the `(`
  // The budget-th character of the document is that `(`, so a cut at the budget ends the page on it.
  const filler = "x".repeat(budget - openAt - 2) + "\n";
  const body = filler + call + "// trailing line\n".repeat(200);
  return { body, seamAt: budget };
}

test("an artifact read through mesh_artifact_read never ends a page inside a line, and nothing is lost", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }] });
  try {
    const call = caller(m);
    const budget = TOOL_PAGE_CHARS - PAGE_ENVELOPE_CHARS;
    const { body, seamAt } = documentWithSeamInsideACall(budget);
    assert.equal(body[seamAt - 1], "(", "the fixture's naive seam is exactly where the live run's was");

    const ws = await m.supervisor.agentWorkspace("dev");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "patch.txt"), body, "utf8");
    const published = await call("dev", "mesh_artifact_publish", { name: "patch", type: "CodePatch", fromPath: "patch.txt" });
    assert.equal(published.ok, true, JSON.stringify(published));

    let offset: number | undefined;
    let text = "";
    const pages: string[] = [];
    for (;;) {
      const page = await call("dev", "mesh_artifact_read", offset === undefined ? { artifactRef: published.artifactId } : { artifactRef: published.artifactId, offset });
      pages.push(page.content);
      text += page.content;
      assert.ok(pages.length <= 20, "paging terminates");
      if (!page.truncated) break;
      assert.equal(page.nextOffset, text.length, "the cursor is where this page stopped");
      offset = page.nextOffset;
    }

    assert.ok(pages.length > 1, "the fixture needs more than one page to have a seam");
    for (const p of pages.slice(0, -1)) {
      assert.equal(p.endsWith("\n"), true, `a page ended mid-line: …${JSON.stringify(p.slice(-40))}`);
      assert.doesNotMatch(p, /,\s*\($/, "no page ends on the opening of a call");
    }
    assert.equal(text, body, "the pages are the whole document, with no gap and no overlap");
  } finally {
    await m.cleanup();
  }
});

test("the 60k read op also ends at a line, and its pages still rebuild the document", async () => {
  const m = await makeMesh({ mode: "parked", agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }] });
  try {
    const body = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"z".repeat(i % 90)}`).join("\n") + "\n";
    assert.ok(body.length > 150_000);
    const ws = await m.supervisor.agentWorkspace("dev");
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, "big.txt"), body, "utf8");
    const turn = { turnId: "t-read", agentId: "dev", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never;
    const pub = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "Big", type: "CodePatch", fromPath: "big.txt" }, turn);
    assert.equal(pub.ok, true, pub.reason);

    let offset = 0;
    let assembled = "";
    for (let guard = 0; guard < 20; guard++) {
      const page: { ok: boolean; reason?: string; truncated?: boolean; nextOffset?: number } = await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: pub.artifactId!, offset }, turn);
      assert.equal(page.ok, true);
      assembled += page.reason ?? "";
      if (!page.truncated) break;
      assert.equal((page.reason ?? "").endsWith("\n"), true, "a truncated page ends at a line");
      offset = page.nextOffset!;
    }
    assert.equal(assembled, body);
  } finally {
    await m.cleanup();
  }
});
