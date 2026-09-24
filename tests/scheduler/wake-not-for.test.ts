import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * `wake.not_for` — the half of a seat's mail that `interests` never reached.
 *
 * A seat's `interests` list gates BROADCASTS: `candidatesFor` consults it and
 * nothing else does. Mail addressed to a seat BY NAME has always woken it, and
 * the only thing the seat could say about that was `defer_non_obliging` — all
 * of its chatter or none of it. A tech-lead that wants status reports batched
 * and the commits it reviews against delivered has to choose, and what it
 * chooses is to leave the switch off and keep paying for both.
 *
 * What these tests mostly pin is not that the mute works. It is the ORDER. The
 * three escapes in `defersMail` — an ask this seat owes, operator mail, and a
 * message carrying this seat's next piece of work — are checked first and
 * cannot be overridden from here. A seat that could name `HANDOFF` and stop
 * being woken for its own work would have turned a batching preference into an
 * authority boundary, and a mesh where a seat quietly opts out of its debts is
 * not a mesh.
 *
 * Every mesh below runs WITHOUT a `bus.delivery` block, on purpose: with
 * delivery classes on, `accrue` is dropped before `defersMail` is reached, so
 * that is the one regime in which this gate is not the thing under test.
 */

const acts = (m: MeshInstance, id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;
const unread = (m: MeshInstance, id: string) => m.kernel.state.unread.get(id)?.length ?? 0;

function quiet(m: MeshInstance, ids: string[]): void {
  const s = stub(m);
  for (const id of ids) s.setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
}

async function mesh(notFor?: string[]) {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "tech-lead", role: "tech-lead", interests: [], ...(notFor ? { wake: { notFor } } : {}) },
    ],
    mayContact: { dev: ["tech-lead"] },
    waitWakeupMs: 200,
  });
  quiet(m, ["dev", "tech-lead"]);
  return m;
}

async function tell(m: MeshInstance, type: string, payload: Record<string, unknown>) {
  const sent = await m.supervisor.sendMessage({
    from: "dev",
    to: ["tech-lead"],
    type: type as never,
    newThread: { subject: `${type} to the lead` },
    payload,
  });
  assert.equal(sent.accepted, true, sent.reason);
  return sent.messageId!;
}

/** Well past the wake window: if anything were going to wake the lead, it has. */
const settled = () => new Promise((r) => setTimeout(r, 800));

test("a named type stops waking the seat, and is still delivered", async () => {
  const m = await mesh(["INFORM"]);
  try {
    const before = acts(m, "tech-lead");
    await tell(m, "INFORM", { note: "for the record" });
    await settled();

    assert.equal(acts(m, "tech-lead") - before, 0, "a muted type must not buy a turn");
    // The guarantee that makes this safe as a WAKE policy rather than a
    // send-time refusal: nothing is suppressed, only the wake is. The mail is
    // in the box and is read on the seat's next natural activation.
    assert.equal(unread(m, "tech-lead"), 1, "and it is waiting in the box, not dropped");
  } finally {
    await m.cleanup();
  }
});

test("a type the seat did NOT name still wakes it", async () => {
  const m = await mesh(["INFORM"]);
  try {
    const before = acts(m, "tech-lead");
    await tell(m, "COMMIT", { sha: "deadbeef", summary: "landed" });
    await waitFor("lead woken by a type it never muted", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("naming an OBLIGING type mutes nothing", async () => {
  const m = await mesh(["REQUEST_REVIEW"]);
  try {
    const before = acts(m, "tech-lead");
    await tell(m, "REQUEST_REVIEW", { question: "does this hold?" });
    // A seat cannot opt out of an ask it owes an answer to. It is the first
    // line of `defersMail` and this list is several lines below it.
    await waitFor("lead woken for an ask it owes", () => acts(m, "tech-lead") > before);
    assert.equal(m.kernel.state.pendingRequests.size, 1, "and the debt it owes is real");
  } finally {
    await m.cleanup();
  }
});

test("naming a type that carries the seat's next piece of work mutes nothing", async () => {
  const m = await mesh(["HANDOFF", "PATCH_READY"]);
  try {
    const before = acts(m, "tech-lead");
    await tell(m, "HANDOFF", { what: "the work is ready for you" });
    // A handoff is not chatter, it is this seat's next piece of work, and
    // deferring it leaves the work sitting with nobody awake to do it.
    await waitFor("lead woken for work handed to it", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("a FAILED verdict wakes the seat even when its type is muted", async () => {
  const m = await mesh(["TEST_RESULT"]);
  try {
    const before = acts(m, "tech-lead");
    // The consequence, not the type name. A PASSED `TEST_RESULT` is a report
    // and a FAILED one hands work back, and they arrive under the same word.
    // A mute that read the word alone would swallow the red build.
    await tell(m, "TEST_RESULT", { result: "FAILED", summary: "3 auth tests red" });
    await waitFor("lead woken by a muted type carrying an adverse verdict", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("a PASSED verdict of that same muted type does not", async () => {
  const m = await mesh(["TEST_RESULT"]);
  try {
    const before = acts(m, "tech-lead");
    await tell(m, "TEST_RESULT", { result: "PASSED", summary: "all green" });
    await settled();
    // Which is what makes the test above about the verdict rather than about
    // `TEST_RESULT` being exempt from muting.
    assert.equal(acts(m, "tech-lead") - before, 0, "a report is still a report, and still mutable");
    assert.equal(unread(m, "tech-lead"), 1);
  } finally {
    await m.cleanup();
  }
});

test("operator mail is never muted", async () => {
  const m = await mesh(["INFORM"]);
  try {
    const before = acts(m, "tech-lead");
    const sent = await m.supervisor.sendMessage({
      from: "human",
      to: ["tech-lead"],
      type: "INFORM",
      newThread: { subject: "from the operator" },
      payload: { note: "ship it today" },
    });
    assert.equal(sent.accepted, true, sent.reason);
    // A seat able to mute its operator would be unreachable by the only human
    // in the mesh, through a key meant to batch its FYIs.
    await waitFor("lead woken by the operator despite muting INFORM", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("`deferNonObliging` still means what it meant, and the two compose", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "tech-lead", role: "tech-lead", interests: [], wake: { deferNonObliging: true, notFor: ["INFORM"] } },
    ],
    mayContact: { dev: ["tech-lead"] },
    waitWakeupMs: 200,
  });
  try {
    quiet(m, ["dev", "tech-lead"]);
    const before = acts(m, "tech-lead");
    await tell(m, "COMMIT", { sha: "deadbeef", summary: "landed" });
    await tell(m, "INFORM", { note: "for the record" });
    await settled();
    // The broad switch already held both. Naming a type under it subtracts
    // nothing and adds nothing, which is the only sane reading of a narrower
    // rule written beside a wider one.
    assert.equal(acts(m, "tech-lead") - before, 0);
    assert.equal(unread(m, "tech-lead"), 2, "both held, neither lost");

    await tell(m, "HANDOFF", { what: "the work is ready for you" });
    await waitFor("and work still gets through both", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("a seat that names nothing behaves exactly as it always did", async () => {
  const m = await mesh();
  try {
    assert.equal(m.kernel.state.agents.get("tech-lead")!.definition.wake, undefined, "an absent block stays absent");
    const before = acts(m, "tech-lead");
    await tell(m, "INFORM", { note: "for the record" });
    await waitFor("an unmuted seat is woken by its chatter, as before", () => acts(m, "tech-lead") > before);
  } finally {
    await m.cleanup();
  }
});

test("an empty list is not carried into the resolved definition", async () => {
  // An empty list and an absent one mute the same nothing, and materialising
  // `notFor: []` would change every resolved agent definition a fixture
  // deep-equals.
  const m = await mesh([]);
  try {
    const wake = m.kernel.state.agents.get("tech-lead")!.definition.wake;
    assert.equal(wake?.deferNonObliging, false, "the block itself is still there");
    assert.equal(wake?.notFor, undefined, "and the empty list is not");
  } finally {
    await m.cleanup();
  }
});

test("a type that does not exist is a config ERROR, not a word that matches nothing", async () => {
  // Pinned to the `MessageType` enum in the schema. This is the whole reason
  // the key takes exact names rather than the glob syntax `interests` uses:
  // message types are flat UPPER_SNAKE words, `interestMatches("*", ...)` is
  // false against every one of them, and a glob surface here would have looked
  // like it worked while muting nothing at all.
  await assert.rejects(() => mesh(["STATUS_UPDATE"]), /not_for/);
});
