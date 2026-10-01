import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";

/**
 * A seat that cannot merge is told WHICH seat can.
 *
 * "A seat that holds `git.merge`" was written for the sixth cronlite run's developer, and it read
 * it as "someone senior": it asked the architect to merge its MERGEABLE patch, was declined ("I lack
 * git.merge capability"), asked the architect again, and the pm asked it a third time. The tech-lead
 * held the capability and was the one nobody asked; the patch landed 3 min 38 s after the first ask.
 * The briefing is built from the same config the capability is read from, so it names the holders.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const dev = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] };
const lead = { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] };
const architect = { id: "architect", role: "architect", capabilities: ["repository.read", "code.review"], authority: ["architecture.approve"], interests: [] };
const release = { id: "release", role: "release-manager", capabilities: ["repository.read", "git.merge"], interests: [] };

const wire = (...seats: Array<{ id: string }>) => Object.fromEntries(seats.map((s) => [s.id, seats.filter((o) => o.id !== s.id).map((o) => o.id)]));

async function briefing(m: Mesh, id: string): Promise<{ bundle: ReturnType<typeof buildAgentContext>; text: string; line: string }> {
  const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, id);
  const text = renderContextInstructions(bundle);
  const line = text.split("\n").find((l) => l.startsWith("- mesh_commit / mesh_request_commit")) ?? "";
  return { bundle, text, line };
}

test("one holder: the seat that cannot merge is told its name, and not to ask one that cannot", async () => {
  const m = await makeMesh({ agents: [dev, lead, architect], mayContact: wire(dev, lead, architect), mode: "parked" } as never);
  try {
    const d = await briefing(m, "dev");
    assert.deepEqual(d.bundle.mergers, ["lead"]);
    assert.match(d.line, /and then being merged by lead, which holds `git\.merge` — you do not, and have no merge tool: ask lead once the patch is MERGEABLE, not a seat that cannot merge\./);
    assert.doesNotMatch(d.line, /a seat that holds/, "the anonymous wording is gone");
    // The seat that holds no merge and no review of the patch is told the same: it is about who lands.
    const a = await briefing(m, "architect");
    assert.deepEqual(a.bundle.mergers, ["lead"]);
    assert.match(a.line, /ask lead once the patch is MERGEABLE/);
  } finally {
    await m.cleanup();
  }
});

test("two holders: both are named, and the seat is told to ask one of them", async () => {
  const m = await makeMesh({ agents: [dev, lead, release], mayContact: wire(dev, lead, release), mode: "parked" } as never);
  try {
    const d = await briefing(m, "dev");
    assert.deepEqual(d.bundle.mergers, ["lead", "release"]);
    assert.match(d.line, /being merged by lead or release, which hold `git\.merge` — you do not, and have no merge tool: ask one of them once the patch is MERGEABLE/);
  } finally {
    await m.cleanup();
  }
});

test("the seat that can merge is not told whom to ask, and is still told it has the tool", async () => {
  const m = await makeMesh({ agents: [dev, lead, release], mayContact: wire(dev, lead, release), mode: "parked" } as never);
  try {
    const l = await briefing(m, "lead");
    assert.equal(l.bundle.mergers, undefined, "it is the answer, not the asker");
    assert.match(l.line, /mesh_commit \/ mesh_request_commit \/ mesh_merge — version-control moves/);
    assert.match(l.line, /and then `mesh_merge`; approval alone lands nothing/);
    assert.doesNotMatch(l.text, /being merged by/);
  } finally {
    await m.cleanup();
  }
});

test("no holder: the seat is told a peer cannot merge it, rather than to ask 'that seat'", async () => {
  const m = await makeMesh({ agents: [dev, architect], mayContact: wire(dev, architect), mode: "parked" } as never);
  try {
    const d = await briefing(m, "dev");
    assert.equal(d.bundle.mergers, undefined);
    assert.match(d.line, /and then being merged by the operator: no seat in this mesh holds `git\.merge` and you have no merge tool, so a MERGEABLE patch is landed from outside, and asking a peer to merge it can only be declined\./);
    assert.doesNotMatch(d.line, /ask (that seat|lead|architect|one of them)/);
  } finally {
    await m.cleanup();
  }
});

test("the list is what the config says: a seat that gains the capability is named, one that has none is not", async () => {
  const withMerge = { ...architect, capabilities: [...architect.capabilities, "git.merge"] };
  const m = await makeMesh({ agents: [dev, withMerge, lead], mayContact: wire(dev, withMerge, lead), mode: "parked" } as never);
  try {
    const d = await briefing(m, "dev");
    assert.deepEqual([...(d.bundle.mergers ?? [])].sort(), ["architect", "lead"]);
    const a = await briefing(m, "architect");
    assert.equal(a.bundle.mergers, undefined, "it holds the capability itself: it is the answer, not the asker");
  } finally {
    await m.cleanup();
  }
});
