import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { makeMesh } from "../helpers";
import { parseMeshSource, resolveBusVocabulary, writeDefaultMeshYaml } from "../../packages/config/src/index";
import { MESSAGE_TYPES, shortHash, validateMeshConfig } from "../../packages/protocol/src/index";

/**
 * `bus.vocabulary: "contracts"` -- the collapsed comms manifest (Move 1).
 *
 * Stage 4 shipped contracts and removed nothing, so a seat was shown
 * `mesh_call` AND `mesh_send` AND its 24-name `MessageType` enum, and went on
 * guessing. This mode removes the guess from the SURFACE: under it the comms
 * tools are `mesh_contracts`, `mesh_call`, `mesh_reply`, `mesh_discharge`,
 * `mesh_announce` and `mesh_collab`/`_close`, and not one of them has a field
 * a message type could be typed into.
 *
 * The payoff is not tokens (the measured saving was -96 a turn, and saying
 * otherwise would be a lie this file is in a position to tell). It is that
 * `op-aliases.ts` -- 56 name aliases and 31 type aliases papering over a
 * vocabulary nobody could learn -- stops being load-bearing. So the tests
 * here defend the two things that has to rest on:
 *
 *   1. a mesh that did not ask for this behaves EXACTLY as it did before, and
 *   2. collapsing the surface takes no capability away, because hiding a tool
 *      is an advertisement decision and `callTool` still resolves it.
 *
 * Deliberately not asserted: the size of the tool list. Pinning a count would
 * make every new tool arrive as a failure here and teach the next author to
 * edit the number rather than read what it claims.
 */

// -------------------------------------------------------------- the config

test("no vocabulary key is no collapse: an upgraded mesh must not lose its manifest", () => {
  assert.equal(resolveBusVocabulary(undefined), undefined);
  // "typed" is the same answer spelled out loud. It folds to absent so there
  // is exactly ONE representation of "not opted in" -- a consumer asking
  // `=== "contracts"` can never be wrong, and no site has to remember to
  // treat the string and the absence alike.
  assert.equal(resolveBusVocabulary("typed"), undefined);
  assert.equal(resolveBusVocabulary("contracts"), "contracts");
});

test("mesh init scaffolds the collapsed vocabulary, and the scaffold validates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-vocab-init-"));
  try {
    const written = writeDefaultMeshYaml(dir, "vocab-demo");
    const raw = parseMeshSource(fs.readFileSync(written, "utf8"));
    // The published schema has to know the key, or `mesh init` writes a
    // config its own contract rejects.
    const v = validateMeshConfig(raw);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    // The default lives HERE and nowhere else: new meshes get the collapsed
    // surface, existing ones are untouched because they have no key at all.
    assert.equal(raw.bus?.vocabulary, "contracts");
    assert.equal(resolveBusVocabulary(raw.bus?.vocabulary), "contracts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the mesh schema closes the vocabulary enum", () => {
  const base = {
    version: 1,
    mesh: { id: "m", goal: "g" },
    agents: { dev: { role: "developer" } },
  };
  assert.equal(validateMeshConfig({ ...base, bus: { vocabulary: "contracts" } }).valid, true);
  assert.equal(validateMeshConfig({ ...base, bus: { vocabulary: "typed" } }).valid, true);
  // A near-miss must fail loudly. Silently ignoring it would leave an
  // operator who asked for the collapsed manifest looking at the full one and
  // reading the tool list as proof the mode does not work.
  assert.equal(validateMeshConfig({ ...base, bus: { vocabulary: "contract" } }).valid, false);
  assert.equal(validateMeshConfig({ ...base, bus: { vocabulary: true } }).valid, false);
  // Independent of `transport`: one governs whether prose ops execute, the
  // other what the manifest advertises, and a mesh may set either alone.
  assert.equal(validateMeshConfig({ ...base, bus: { vocabulary: "contracts", transport: "mixed" } }).valid, true);
});

// ------------------------------------------------------------ the manifest

/**
 * A three-seat mesh at the given vocabulary, or at whatever a mesh that never
 * named one gets.
 *
 * `vocabulary` goes through the shared builder rather than being spliced into
 * its output, so what these tests exercise is the same `bus:` emitter every
 * other suite uses -- and, more to the point, the resolver reading a file an
 * operator could have written. `undefined` omits the key entirely, which is
 * the third case under test and is NOT the same as writing `typed`.
 */
function pair(vocabulary?: "typed" | "contracts") {
  return makeMesh({
    // Parked: these tests read manifests and call tools directly, and never
    // want the scheduler taking turns underneath them.
    mode: "parked",
    bus: { vocabulary },
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], dev: ["architect", "qa"], qa: ["architect", "dev"] },
  });
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

/** One seat's view of the bus: the tools it is shown and the calls it can make. */
function bus(m: Mesh, agentId: string) {
  const mcp = createMcpToolset(m.supervisor);
  const tok = `${m.config.meshId}:${agentId}:${shortHash(m.kernel.state.activeGoalId!)}`;
  return {
    async tools(): Promise<Array<{ name: string; inputSchema: any }>> {
      const list = (await mcp.handle(agentId, tok, mcpReq("tools/list", {}))) as {
        result: { tools: Array<{ name: string; inputSchema: any }> };
      };
      return list.result.tools;
    },
    async names(): Promise<string[]> {
      return (await this.tools()).map((t) => t.name);
    },
    async call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
      const res = (await mcp.handle(agentId, tok, mcpReq("tools/call", { name, arguments: args }))) as {
        error?: { code: number; message: string };
        result?: { isError: boolean; content: Array<{ text: string }> };
      };
      assert.equal(res.error, undefined, `${name}: ${res.error?.message}`);
      return JSON.parse(res.result!.content[0].text);
    },
  };
}

const COLLAPSED = ["mesh_contracts", "mesh_call", "mesh_reply", "mesh_discharge", "mesh_announce", "mesh_collab", "mesh_collab_close"];
const TYPED = ["mesh_send", "mesh_broadcast", "mesh_respond", "mesh_request", "mesh_request_review", "mesh_research_request", "mesh_escalate"];

test("manifest: a mesh with no vocabulary key is advertised exactly what it always was", async () => {
  const m = await pair();
  try {
    const names = await bus(m, "architect").names();
    for (const name of TYPED) assert.ok(names.includes(name), `${name} must still be advertised to an unconfigured mesh`);
    // The two tools that exist only to carry the collapsed vocabulary are
    // registered in every mesh so they RESOLVE, but advertising them here
    // would be exactly the silent upgrade the absent-by-default key exists to
    // prevent: every existing mesh's manifest would change on deploy.
    assert.ok(!names.includes("mesh_reply"), "mesh_reply must not appear in a manifest nobody asked to collapse");
    assert.ok(!names.includes("mesh_announce"), "mesh_announce must not appear either");
  } finally {
    await m.cleanup();
  }
});

test("manifest: an explicit typed vocabulary is the same manifest as no key at all", async () => {
  const absent = await pair();
  const typed = await pair("typed");
  try {
    assert.deepEqual(
      (await bus(typed, "architect").names()).sort(),
      (await bus(absent, "architect").names()).sort(),
      "writing the default out loud must not change a single tool",
    );
  } finally {
    await absent.cleanup();
    await typed.cleanup();
  }
});

test("manifest: contracts collapses the comms surface to the named asks", async () => {
  const before = await pair();
  const after = await pair("contracts");
  try {
    const was = await bus(before, "architect").names();
    const now = await bus(after, "architect").names();

    for (const name of TYPED) {
      assert.ok(was.includes(name), `${name} is advertised today`);
      assert.ok(!now.includes(name), `${name} names a message type or is contract-covered and must leave the manifest`);
    }
    for (const name of COLLAPSED) assert.ok(now.includes(name), `${name} is the replacement and must be advertised`);

    // Nothing outside comms moves. The mode is about what a seat says, not
    // about what it can do, so artifacts, tasks, plans and observability are
    // untouched -- a regression here would strand a mission for a reason that
    // has nothing to do with vocabulary.
    for (const name of was) {
      if (TYPED.includes(name)) continue;
      assert.ok(now.includes(name), `${name} is not a comms tool and must survive the collapse`);
    }
  } finally {
    await before.cleanup();
    await after.cleanup();
  }
});

/**
 * Every enum anywhere in a tool's input schema, with the field path that
 * carries it. Recursive because the vocabulary could come back nested --
 * `mesh_plan` already declares one inside an array's `items`.
 */
function enumsIn(schema: any, at = ""): Array<{ at: string; values: unknown[] }> {
  if (!schema || typeof schema !== "object") return [];
  const found: Array<{ at: string; values: unknown[] }> = [];
  if (Array.isArray(schema.enum)) found.push({ at: at || "(root)", values: schema.enum });
  for (const [key, child] of Object.entries(schema.properties ?? {})) found.push(...enumsIn(child, at ? `${at}.${key}` : key));
  if (schema.items) found.push(...enumsIn(schema.items, `${at}[]`));
  return found;
}

/**
 * Does this enum ask a seat to CHOOSE a message type?
 *
 * Two, not one, and the reason is a genuine collision rather than a hedge:
 * `DONE` is a `MessageType` AND a plan-step status, so a rule of one would
 * fail on `mesh_plan_step.status` -- a field that has nothing to do with
 * speech acts and would teach the next author to special-case tool names
 * here. Choosing needs alternatives, so two overlapping values is the
 * smallest thing that is actually a vocabulary.
 */
function offersMessageTypes(values: unknown[]): string[] {
  const catalogue = new Set<string>(MESSAGE_TYPES);
  const hits = values.filter((v): v is string => typeof v === "string" && catalogue.has(v));
  return hits.length >= 2 ? hits : [];
}

test("manifest: under contracts no advertised tool offers a message type to pick", async () => {
  const typed = await pair();
  const collapsed = await pair("contracts");
  try {
    // The positive control, in the same test so it cannot rot apart from it:
    // today's manifest DOES hand the seat the catalogue, on more than one
    // tool. Without this the assertion below would keep passing if
    // `offersMessageTypes` ever stopped finding anything at all.
    const offered = (await bus(typed, "architect").tools()).flatMap((t) =>
      enumsIn(t.inputSchema).filter((e) => offersMessageTypes(e.values).length > 0).map((e) => `${t.name}.${e.at}`),
    );
    assert.ok(offered.length >= 2, `the typed manifest is supposed to offer the catalogue; found ${JSON.stringify(offered)}`);

    for (const tool of await bus(collapsed, "architect").tools()) {
      for (const { at, values } of enumsIn(tool.inputSchema)) {
        // This is the whole claim of the mode, stated structurally rather
        // than as a list of tool names: a seat cannot invent `RESULT` if the
        // manifest offers nowhere to type it. An enum drawn from the message
        // catalogue anywhere in the advertised surface reintroduces the
        // vocabulary wholesale, whichever tool it rides on.
        assert.deepEqual(
          offersMessageTypes(values),
          [],
          `${tool.name}.${at} still offers message types: ${JSON.stringify(values)}`,
        );
      }
    }
  } finally {
    await typed.cleanup();
    await collapsed.cleanup();
  }
});

test("manifest: collapsing the vocabulary takes nothing away -- hidden tools still work", async () => {
  const m = await pair("contracts");
  try {
    const architect = bus(m, "architect");
    // Filtering is advertisement-only: `callTool` resolves against the
    // unfiltered map. That is what makes this a prompt decision rather than a
    // capability change -- a model that remembers `mesh_send` from another
    // mesh, or an op parsed out of prose, still lands.
    const sent = await architect.call("mesh_send", { type: "INFORM", to: ["dev"], payload: { note: "still here" } });
    assert.equal(sent.ok, true, sent.error);
    assert.ok(sent.messageId, "a hidden tool must still do its job, not just resolve");

    const announced = await architect.call("mesh_broadcast", { type: "INFORM", payload: { note: "also still here" } });
    assert.equal(announced.ok, true, announced.error);
  } finally {
    await m.cleanup();
  }
});

test("mesh_reply settles the ask it names, with no type for the seat to get wrong", async () => {
  const m = await pair("contracts");
  try {
    const architect = bus(m, "architect");
    const dev = bus(m, "dev");

    const asked = await architect.call("mesh_call", {
      contract: "info.question",
      request: { question: "which index are we sharding on?" },
      to: ["dev"],
    });
    assert.equal(asked.ok, true, asked.error);
    assert.equal(m.kernel.state.pendingRequests.size, 1, "the ask is on the ledger");

    const replied = await dev.call("mesh_reply", { messageId: asked.messageId, response: { answer: "tenant id" } });
    assert.equal(replied.ok, true, replied.error);

    // What discharges is `replyTo`, which the respond op sets from
    // `messageId` -- not the type. Hard-coding INFORM is therefore not a
    // shortcut that costs the seat anything: the ask settles, and the
    // contract's response schema is still checked against the answer.
    assert.equal(m.kernel.state.pendingRequests.size, 0, "the reply must discharge the ask it answered");
    const record = m.kernel.state.discharged.at(-1);
    assert.equal(record?.messageId, asked.messageId);
    assert.equal(record?.reason, "reply");
    assert.equal(record?.by, "dev");
    assert.notEqual(record?.responseValid, false, "an answer carrying the contract's field must not be marked unanswered");

    const message = m.kernel.state.messages.get(replied.messageId);
    assert.equal(message?.type, "INFORM", "the wire type survives for rendering and telemetry; the seat just never typed it");
    assert.equal(message?.replyTo, asked.messageId);
  } finally {
    await m.cleanup();
  }
});

test("mesh_announce is one act over two ops: everyone, or the seats you name", async () => {
  const m = await pair("contracts");
  try {
    const architect = bus(m, "architect");

    const toAll = await architect.call("mesh_announce", { payload: { note: "standup moved" } });
    assert.equal(toAll.ok, true, toAll.error);
    const broadcast = m.kernel.state.messages.get(toAll.messageId);
    assert.equal(broadcast?.control?.mode, "broadcast", "no recipients means the broadcast op, which obliges nobody");

    const toOne = await architect.call("mesh_announce", { to: ["dev"], payload: { note: "your branch is merged" } });
    assert.equal(toOne.ok, true, toOne.error);
    const direct = m.kernel.state.messages.get(toOne.messageId);
    assert.deepEqual(direct?.to, ["dev"], "naming seats must reach only those seats");
    assert.notEqual(direct?.control?.mode, "broadcast");

    // Neither lands on the ledger. That is the line the tool is drawn on --
    // telling somebody something is not asking them for anything, and a mesh
    // that recorded a debt here would nudge for an answer nobody owes.
    assert.equal(m.kernel.state.pendingRequests.size, 0, "an announcement puts nobody in debt");

    // A single string is shape, not vocabulary: `op-aliases` widens `to` the
    // same way for the prose channel, and getting it wrong here would send a
    // targeted note to the entire mesh.
    const coerced = await architect.call("mesh_announce", { to: "qa" as unknown as string[], payload: { note: "rerun the suite" } });
    assert.deepEqual(m.kernel.state.messages.get(coerced.messageId)?.to, ["qa"]);
  } finally {
    await m.cleanup();
  }
});
