import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { TOOL_PAGE_CHARS, fitRows, jsonSize } from "../../apps/mesh-server/src/pagination";
import { mintSeatToken } from "../../packages/core/src/seat-token";

/**
 * The bound on a read tool's result, and the cursor that makes it safe.
 *
 * Measured over the live seats, the five read tools returned pages of 47,462
 * (`mesh_inbox`), 44,611 (`mesh_query_events`) and 43,701
 * (`mesh_artifact_read`) characters. `limit` was the only control and it is a
 * ROW count, so it never bounded anything: a page that size rides every later
 * call of the turn and every later turn of the session, because nothing in the
 * client clips a tool result.
 *
 * The bound now lives in the MCP server, and these tests drive the real
 * `tools/call` path with the arguments a seat actually passes. Each one
 * asserts three things, in this order: the page is under the budget, the page
 * SAYS how to get the rest, and the rest is genuinely reachable — every row of
 * the live-sized fixture comes back across the pages, none twice.
 *
 * A `TOOL_PAGE_CHARS`-sized string is not built anywhere here; the fixture is
 * sized in ROWS of realistic prose, so the test measures the real serializer
 * on the real payload.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function caller(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<any> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    const text = res.result.content[0]!.text;
    assert.equal(res.result.isError, false, text);
    const payload = JSON.parse(text) as any;
    // Every page here is the JSON the model is shown, so the budget is checked
    // against exactly what it pays for.
    assert.ok(jsonSize(payload) <= TOOL_PAGE_CHARS + 400, `${name} returned ${jsonSize(payload)} chars: ${text.slice(0, 200)}`);
    return payload;
  };
}

/** A body of the size the live run produced: one long prose field per row. */
const PROSE = (n: number, seed: string) => `${seed} `.repeat(Math.ceil(n / (seed.length + 1))).slice(0, n);

function parked(): Promise<Mesh> {
  return makeMesh({
    mode: "parked",
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
}

// --------------------------------------------------------------- mesh_inbox

test("a mailbox of live size comes back in pages, and every message is reachable", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    // 25 messages of ~1.9k prose is the 47,462-character result the live run
    // produced — the size the old row-count bound let through.
    const total = 25;
    for (let i = 0; i < total; i++) {
      const sent = await m.supervisor.sendMessage({
        from: "qa",
        to: ["dev"],
        type: "INFORM",
        newThread: { subject: `subject-${i}` },
        payload: { index: i },
        note: PROSE(1900, `body-${i}`),
      });
      assert.equal(sent.accepted, true);
    }

    const seen = new Set<string>();
    let offset: number | undefined;
    let pages = 0;
    for (;;) {
      const page = await call("dev", "mesh_inbox", offset === undefined ? {} : { offset });
      assert.equal(page.total, total);
      assert.ok(page.returned > 0, "a page is never empty while rows remain");
      for (const msg of page.messages) seen.add(msg.id);
      pages++;
      assert.ok(pages <= total + 1, "paging terminates");
      if (!page.truncated) {
        assert.equal(page.nextOffset, null, "the last page names no cursor");
        break;
      }
      assert.equal(typeof page.nextOffset, "number", "a truncated page names how to continue");
      assert.match(page.note, /mesh_inbox: showing \d+ of \d+/);
      assert.match(page.note, /offset=\d+/, "the note carries the argument that gets the rest");
      offset = page.nextOffset;
    }
    assert.ok(pages > 1, `a ${total}-message mailbox took ${pages} page(s); it must not fit one`);
    assert.equal(seen.size, total, "every message is reachable across the pages, none lost");
  } finally {
    await m.cleanup();
  }
});

// --------------------------------------------------------- mesh_query_events

test("an event query of live size pages backwards, and every event is reachable", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    // ~200 events is the 44,611-character result from the live run.
    const total = 200;
    for (let i = 0; i < total; i++) {
      const sent = await m.supervisor.sendMessage({
        from: "qa",
        to: ["dev"],
        type: "INFORM",
        newThread: { subject: `thread-${i}` },
        payload: { index: i, filler: PROSE(120, `f-${i}`) },
        note: PROSE(600, `n-${i}`),
      });
      assert.equal(sent.accepted, true);
    }

    const seen = new Set<number>();
    let offset: number | undefined;
    let pages = 0;
    let firstPageLastSeq: number | null = null;
    for (;;) {
      const page = await call("dev", "mesh_query_events", offset === undefined ? { type: "message.sent", limit: 200 } : { type: "message.sent", limit: 200, offset });
      assert.ok(Array.isArray(page.events) && page.events.length > 0, "a page is never empty while events remain");
      if (firstPageLastSeq === null) firstPageLastSeq = page.lastSeq;
      for (const e of page.events) seen.add(e.seq);
      pages++;
      assert.ok(pages <= total + 1, "paging terminates");
      if (!page.truncated) break;
      assert.equal(typeof page.nextOffset, "number", "a truncated page names how to continue");
      assert.match(page.note, /offset=\d+/);
      offset = page.nextOffset;
    }
    assert.ok(pages > 1, `a ${total}-event query took ${pages} page(s); it must not fit one`);
    assert.equal(seen.size, total, "every event is reachable across the pages, none lost");
    // `lastSeq` still names the newest match on the first page, which is what
    // a polling seat passes back as `sinceSeq` — the backward cursor must not
    // have moved it.
    const newest = Math.max(...seen);
    assert.equal(firstPageLastSeq, newest, "lastSeq is still the forward poll cursor");
  } finally {
    await m.cleanup();
  }
});

// -------------------------------------------------------- mesh_artifact_read

test("an artifact of live size is read in parts, and the whole document is reachable", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    const published = await call("dev", "mesh_artifact_publish", {
      name: "big",
      type: "ResearchReport",
      content: PROSE(43_700, "artifact-body"),
    });
    assert.equal(published.ok, true, JSON.stringify(published));

    let offset: number | undefined;
    let text = "";
    let parts = 0;
    for (;;) {
      const page = await call("dev", "mesh_artifact_read", offset === undefined ? { artifactRef: published.artifactId } : { artifactRef: published.artifactId, offset });
      text += page.content;
      parts++;
      assert.ok(parts <= 20, "paging terminates");
      if (!page.truncated) {
        assert.equal(page.totalChars, text.length, "the parts are the whole document");
        break;
      }
      assert.equal(typeof page.nextOffset, "number", "a truncated page names how to continue");
      assert.match(page.note, /offset=\d+/);
      assert.equal(page.nextOffset, (offset ?? 0) + page.content.length, "the cursor is where this part stopped");
      offset = page.nextOffset;
    }
    assert.ok(parts > 1, `a 43.7k artifact took ${parts} part(s); it must not fit one`);
    assert.equal(text, PROSE(43_700, "artifact-body"), "nothing is lost between the parts");
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------- mesh_failures / mesh_run_digest

test("a failure report either fits one page or hands back a readable section index", async () => {
  const m = await parked();
  try {
    const call = caller(m);
    const report = await call("dev", "mesh_failures", { limit: 100 });
    // Both outcomes are honest, and `call` has already asserted the payload is
    // under budget. What must never happen is an over-budget payload with no
    // way onward, so the truncated branch is checked for a usable index.
    if (!report.truncated) {
      assert.ok("denials" in report, "a report that fits keeps its flat shape");
      return;
    }
    assert.ok(report.sections && typeof report.sections === "object", "a truncated report names its sections");
    assert.match(report.note, /section="/);
    const names = Object.keys(report.sections);
    assert.ok(names.length > 0);
    for (const name of names) {
      const section = await call("dev", "mesh_failures", { section: name, limit: 100 });
      assert.equal(section.section, name);
      assert.equal(section.total, report.sections[name], "the index's count is the section's real size");
      assert.ok(Array.isArray(section.rows));
    }
  } finally {
    await m.cleanup();
  }
});

test("the aggregate pager indexes what does not fit, and pages each section it names", () => {
  const mcp = createMcpToolset({} as never) as unknown as {
    pageAggregate: (
      tool: string,
      scalars: Record<string, unknown>,
      sections: Record<string, unknown[]>,
      a: Record<string, unknown>,
      cap: number,
    ) => any;
  };
  const big = Array.from({ length: 60 }, (_, i) => ({ i, reason: "r".repeat(300) }));

  // Under budget: the flat report a caller already knows, unchanged.
  const small = mcp.pageAggregate("mesh_failures", { scanned: 1 }, { denials: big.slice(0, 2) }, {}, 20);
  assert.equal(small.truncated, undefined);
  assert.equal(small.denials.length, 2);

  // Over budget: an index, a note naming the argument, and no rows lost.
  const indexed = mcp.pageAggregate("mesh_failures", { scanned: 1 }, { denials: big, openEscalations: [] }, {}, 60);
  assert.equal(indexed.truncated, true);
  assert.deepEqual(indexed.sections, { denials: 60, openEscalations: 0 });
  assert.match(indexed.note, /section="<name>"/);
  assert.equal(indexed.denials, undefined, "the rows are not also inlined — that is what overflowed");

  // Reading a named section pages it by character, and the cursor reaches all of it.
  const seen: number[] = [];
  let offset: number | undefined;
  for (;;) {
    const page = mcp.pageAggregate("mesh_failures", {}, { denials: big }, offset === undefined ? { section: "denials" } : { section: "denials", offset }, 60);
    assert.ok(page.returned > 0);
    seen.push(...page.rows.map((r: { i: number }) => r.i));
    if (!page.truncated) break;
    assert.match(page.note, /section="denials", offset=\d+/);
    offset = page.nextOffset;
  }
  assert.deepEqual(seen, big.map((r) => r.i), "every row of the section is reachable");

  // An unknown section is refused with the index, not with an empty page.
  const bogus = mcp.pageAggregate("mesh_failures", {}, { denials: big }, { section: "nope" }, 60);
  assert.match(String(bogus.error), /unknown section/);
  assert.deepEqual(bogus.sections, { denials: 60 });
});

// -------------------------------------------------------------- fitRows unit

test("fitRows always yields a page and never loses a row", () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ i, pad: "x".repeat(50) }));
  const sizeOf = jsonSize;
  // A budget that fits three rows.
  const rowSize = sizeOf(rows[0]!) + 1;
  const page = fitRows(rows, { offset: 0, budgetChars: rowSize * 3, sizeOf });
  assert.equal(page.rows.length, 3);
  assert.equal(page.nextOffset, 3);
  assert.equal(page.total, 40);
  // Walking it reaches every row exactly once.
  const seen: number[] = [];
  let offset = 0;
  for (;;) {
    const p = fitRows(rows, { offset, budgetChars: rowSize * 3, sizeOf });
    seen.push(...p.rows.map((r) => r.i));
    if (p.nextOffset === null) break;
    offset = p.nextOffset;
  }
  assert.deepEqual(seen, rows.map((r) => r.i));
  // One row larger than the whole budget is still returned: a page that names
  // its cursor is readable, an empty one is a list that cannot be read.
  const huge = [{ big: "y".repeat(20_000) }];
  const only = fitRows(huge, { offset: 0, budgetChars: 100, sizeOf });
  assert.equal(only.rows.length, 1);
  assert.equal(only.nextOffset, null);
  // An offset past the end is the end, not an error.
  const past = fitRows(rows, { offset: 999, budgetChars: 1000, sizeOf });
  assert.deepEqual(past.rows, []);
  assert.equal(past.nextOffset, null);
});
