import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, evidenceContent } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A mission that waits only on an acceptance, with the proof in hand, is not left to the full idle window.
 *
 * The ninth and tenth cronlite runs. QA published its test report, passed it and told the pm; the pm is the only seat that can
 * close the contract criteria, and nothing woke it: progress events do not wake a seat (they cost a turn to say "noted") and
 * QA's note was an INFORM. The stall watchdog's idle window (three minutes) was the only wake there was, so the mission sat
 * 3 min 23 s in the ninth run's second round and 3 min 22 s in the tenth run's first, a quarter of the round, and the pm
 * accepted both criteria within 18 s of waking.
 *
 * Now, when every criterion still open closes only by an acceptance, a seat that may accept exists and a verification report an
 * acceptance could cite has been submitted, the watchdog nudges that seat after a twelfth of the idle window (15 s of the default
 * 180 s). Everything else keeps the full window: a mission with nothing to cite, with work still to do on a criterion the mesh
 * evidences itself, or with only some other document in it.
 */

const IDLE = 6000; // the grace is a twelfth: 500 ms, and the watchdog ticks every IDLE / 3 = 2 s
const FAST = { stallIdleMs: IDLE, stallCooldownMs: 400, waitWakeupMs: 50 };

const PM = { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] };
const QA = { id: "qa", role: "qa", authority: ["quality.block", "quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function mesh(): Promise<Mesh> {
  const m = await makeMesh({
    agents: [PM, QA],
    mayContact: { pm: ["qa"], qa: ["pm"] },
    criteria: [
      { id: "quality-verified", description: "the tests pass", mandatory: true },
      { id: "contract-met", description: "the product does what the goal says, shown by a QA report", mandatory: true },
    ],
    mode: "live",
    ...FAST,
  } as never);
  stub(m).setScript("pm", async () => ({ operations: [{ op: "done" }] as MeshOp[] }));
  return m;
}

async function publish(m: Mesh, owner: string, name: string, type: string, submit: boolean): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: type as never, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  if (submit) {
    const moved = await m.supervisor.transitionArtifact(owner, created.artifact.id, { to: "READY_FOR_REVIEW" });
    assert.equal(moved.ok, true, String(moved.reason));
  }
  return created.artifact.id;
}

const nudgesTo = async (m: Mesh, agent: string) =>
  (await m.store.read({ types: ["agent.awakened"] })).filter((e) => {
    const p = e.payload as { agentId?: string; reason?: { note?: string } };
    return p.agentId === agent && String(p.reason?.note ?? "").includes("stall watchdog");
  });

const WINDOW = 3000; // longer than the grace and a tick, shorter than the idle window

test("QA's report is submitted and passed, and only the pm's acceptance is left: the pm is nudged within the grace, not after the idle window", async () => {
  const m = await mesh();
  try {
    const report = await publish(m, "qa", "QA Report", "TestReport", false);
    const passed = await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31");
    assert.equal(passed.ok, true, passed.reason);
    assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.acceptanceCriteria.find((c) => c.id === "quality-verified")?.status, "EVIDENCED", "fixture: the mesh's own criterion is closed");

    await waitFor("the pm is nudged", async () => (await nudgesTo(m, "pm")).length > 0, IDLE - 1500);
    const note = String(((await nudgesTo(m, "pm"))[0]!.payload as { reason?: { note?: string } }).reason?.note ?? "");
    assert.match(note, /contract-met/, "told what is open");
    assert.match(note, /Submitted and citable: TestReport "QA Report"/, "and the report it may cite");
  } finally {
    await m.cleanup();
  }
});

test("with nothing submitted to cite there is no early nudge: a draft report is not proof", async () => {
  const m = await mesh();
  try {
    // quality-verified is closed by a pass that names nothing, so only the acceptance is open and nothing is citable. The report is
    // written after the pass: a draft that exists at the pass is submitted with it (a pass submits its giver's own report), and
    // that would make it citable. One written afterwards stays a draft, which is what this case needs.
    const passed = await m.supervisor.recordDecision("qa", "pass", "quality", undefined, "ran the suite: 31/31");
    assert.equal(passed.ok, true, passed.reason);
    const draft = await publish(m, "qa", "QA Report", "TestReport", false);
    assert.equal(m.kernel.state.artifacts.get(draft)?.status, "DRAFT", "fixture: nothing submitted");
    await new Promise((r) => setTimeout(r, WINDOW));
    assert.equal((await nudgesTo(m, "pm")).length, 0, "the full window applies");
  } finally {
    await m.cleanup();
  }
});

test("with work still to do on a criterion the mesh evidences itself there is no early nudge", async () => {
  const m = await mesh();
  try {
    await publish(m, "qa", "QA Report", "TestReport", true);
    // Submitted, but never passed: quality-verified is open, and who must act on it is QA, not the pm.
    await new Promise((r) => setTimeout(r, WINDOW));
    assert.equal((await nudgesTo(m, "pm")).length, 0);
  } finally {
    await m.cleanup();
  }
});

test("a submitted document that is not a verification report is not what the grace waits for", async () => {
  const m = await mesh();
  try {
    await publish(m, "qa", "Decision notes", "ADR", true);
    const passed = await m.supervisor.recordDecision("qa", "pass", "quality", undefined, "ran the suite: 31/31");
    assert.equal(passed.ok, true, passed.reason);
    await new Promise((r) => setTimeout(r, WINDOW));
    assert.equal((await nudgesTo(m, "pm")).length, 0, "the full window applies");
  } finally {
    await m.cleanup();
  }
});

test("a mesh with no seat that may accept has nobody to nudge early", async () => {
  const m = await makeMesh({
    agents: [QA],
    mayContact: { qa: [] },
    criteria: [
      { id: "quality-verified", description: "the tests pass", mandatory: true },
      { id: "contract-met", description: "shown by a QA report", mandatory: true },
    ],
    mode: "live",
    ...FAST,
  } as never);
  try {
    const report = await publish(m, "qa", "QA Report", "TestReport", false);
    await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31");
    await new Promise((r) => setTimeout(r, WINDOW));
    assert.equal((await nudgesTo(m, "qa")).length, 0, "nothing in this mesh can accept, so a nudge to QA would buy nothing");
  } finally {
    await m.cleanup();
  }
});
