import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A task nobody it is given to can claim is refused when it is filed, and a refused claim says who can.
 *
 * The seventh cronlite run's pm filed three implementation tasks for the developer, each listing
 * [repository.write, git.commit, test.write, test.execute]. The developer holds all but `test.write`; only
 * qa does, and no seat holds it beside `repository.write`. `delegate` refuses that ("dev lacks required
 * capabilities ..."), but `create_task` with `assignedTo` made no such check: the tasks were filed, the
 * developer's claim was refused, it spent a 23k-token turn asking the tech-lead, whose "you can proceed
 * ... claim the tasks" could not work (nothing waives a requirement), and the three tasks stayed OPEN for
 * the rest of the run, since no op withdraws a task.
 */

const AGENTS = [
  { id: "pm", role: "product-manager", capabilities: ["repository.read", "task.assign"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit", "test.execute"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
];
const COMM = { pm: ["dev", "qa"], dev: ["pm"], qa: ["pm"] };

/** What the pm wrote, three times. */
const INCIDENT = ["repository.write", "git.commit", "test.write", "test.execute"];

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

const mesh = (agents: unknown[] = AGENTS) => makeMesh({ agents, mayContact: COMM, mode: "parked" } as never);
type Mesh = Awaited<ReturnType<typeof mesh>>;

const createTask = (m: Mesh, by: string, extra: Record<string, unknown>) =>
  m.supervisor.executeOp(by, { op: "create_task", title: "Implement: library core", description: "src/index.js", ...extra } as unknown as MeshOp, turnFor(by));

const delegateTo = (m: Mesh, by: string, to: string, requiredCapabilities: string[]) =>
  m.supervisor.executeOp(by, { op: "delegate", to, title: "Delegated: library core", description: "src/index.js", requiredCapabilities } as unknown as MeshOp, turnFor(by));

const sentTo = async (m: Mesh, seat: string) =>
  (await m.store.read({ types: ["message.sent"] })).filter((e) => ((e.payload as { message: { to: string[] } }).message.to ?? []).includes(seat)).length;

test("the pm's tasks of the live run are refused at creation: dev lacks test.write, which qa holds", async () => {
  const m = await mesh();
  try {
    const before = m.kernel.state.tasks.size;
    const res = await createTask(m, "pm", { assignedTo: "dev", requiredCapabilities: INCIDENT });
    assert.equal(res.ok, false);
    assert.equal(
      res.reason,
      "dev lacks required capabilities test.write (held by: qa). A task is claimed only by a seat that holds every capability it lists, so this one would sit open, and no seat holds all of repository.write, git.commit, test.write, test.execute: take test.write out of requiredCapabilities if the claimant does not need it",
    );
    assert.equal(res.taskId, undefined);
    assert.equal(m.kernel.state.tasks.size, before, "no task is filed for work nobody can claim");
    assert.equal(await sentTo(m, "dev"), 0, "and the assignee is not handed a DELEGATE for it");
  } finally {
    await m.cleanup();
  }
});

test("the list the pm would write next is filed, handed to dev, and dev can claim it", async () => {
  const m = await mesh();
  try {
    const res = await createTask(m, "pm", { assignedTo: "dev", requiredCapabilities: ["repository.write", "git.commit", "test.execute"] });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.reason, undefined, "nothing to caveat");
    assert.equal(await sentTo(m, "dev"), 1);
    assert.equal((await m.supervisor.claimTask("dev", res.taskId!)).ok, true);
  } finally {
    await m.cleanup();
  }
});

test("a capability no seat holds is said to be held by none, and delegate says exactly what create_task does", async () => {
  const m = await mesh();
  try {
    const viaCreate = await createTask(m, "pm", { assignedTo: "dev", requiredCapabilities: ["repository.write", "security.scan"] });
    assert.equal(viaCreate.ok, false);
    assert.match(viaCreate.reason ?? "", /^dev lacks required capabilities security\.scan \(no seat holds it\)\. /);
    assert.match(viaCreate.reason ?? "", /no seat holds all of repository\.write, security\.scan: take security\.scan out of requiredCapabilities if the claimant does not need it$/);

    const viaDelegate = await delegateTo(m, "pm", "dev", ["repository.write", "security.scan"]);
    assert.equal(viaDelegate.ok, false);
    assert.equal(viaDelegate.reason, viaCreate.reason, "one check, two ops: they read alike");
  } finally {
    await m.cleanup();
  }
});

test("when a seat holds all of the list, the refusal names it as the route", async () => {
  const full = { id: "lead", role: "tech-lead", capabilities: ["repository.read", "repository.write", "git.commit", "test.execute", "test.write"], interests: [] };
  const m = await makeMesh({ agents: [...AGENTS, full], mayContact: { ...COMM, pm: ["dev", "qa", "lead"], lead: ["pm"] }, mode: "parked" } as never);
  try {
    const res = await createTask(m, "pm", { assignedTo: "dev", requiredCapabilities: INCIDENT });
    assert.equal(res.ok, false);
    assert.equal(
      res.reason,
      "dev lacks required capabilities test.write (held by: qa, lead). A task is claimed only by a seat that holds every capability it lists, so this one would sit open: give it to lead, who holds all of them, or take test.write out of requiredCapabilities if the claimant does not need it",
    );
    const ok = await createTask(m, "pm", { assignedTo: "lead", requiredCapabilities: INCIDENT });
    assert.equal(ok.ok, true, ok.reason);
  } finally {
    await m.cleanup();
  }
});

test("several missing capabilities are each named with their holders", async () => {
  const m = await mesh();
  try {
    const res = await createTask(m, "pm", { assignedTo: "qa", requiredCapabilities: ["repository.write", "git.commit", "test.write"] });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^qa lacks required capabilities repository\.write \(held by: dev\), git\.commit \(held by: dev\)\. /);
    assert.match(res.reason ?? "", /take repository\.write, git\.commit out of requiredCapabilities if the claimant does not need them$/);
  } finally {
    await m.cleanup();
  }
});

test("the implementation.gate marker is not a capability: neither op holds it against the assignee", async () => {
  const m = await mesh();
  try {
    const created = await createTask(m, "pm", { assignedTo: "dev", requiredCapabilities: ["implementation.gate", "repository.write"] });
    assert.equal(created.ok, true, created.reason);
    const delegated = await delegateTo(m, "pm", "dev", ["implementation.gate"]);
    assert.equal(delegated.ok, true, `delegate refused the marker as a capability dev lacks: ${delegated.reason ?? ""}`);
  } finally {
    await m.cleanup();
  }
});

test("an unassigned task nobody can claim is filed with a caveat naming the closest seats", async () => {
  const m = await mesh();
  try {
    const res = await createTask(m, "pm", { requiredCapabilities: INCIDENT });
    assert.equal(res.ok, true, res.reason);
    assert.equal(res.caveat, true);
    assert.equal(
      res.reason,
      "task filed, but no seat holds all of repository.write, git.commit, test.write, test.execute (dev lacks test.write; qa lacks repository.write, git.commit), so nobody can claim it and no op withdraws it: take out what the claimant does not need and file it again",
    );
    assert.ok(m.kernel.state.tasks.has(res.taskId!), "it is filed: the author may mean it");
  } finally {
    await m.cleanup();
  }
});

test("an unassigned task some seat can claim carries no caveat, and neither does one with no capabilities", async () => {
  const m = await mesh();
  try {
    const some = await createTask(m, "pm", { requiredCapabilities: ["repository.write", "git.commit"] });
    assert.equal(some.ok, true);
    assert.equal(some.reason, undefined);
    assert.equal(some.caveat, undefined);
    const none = await createTask(m, "pm", { title: "Write the README", requiredCapabilities: [] });
    assert.equal(none.reason, undefined);
    const absent = await createTask(m, "pm", { title: "Tidy the notes" });
    assert.equal(absent.reason, undefined);
  } finally {
    await m.cleanup();
  }
});

test("a refused claim names who holds the capability and who to ask, since nothing waives a requirement", async () => {
  const m = await mesh();
  try {
    const t = await createTask(m, "pm", { requiredCapabilities: ["test.write"] });
    assert.equal(t.ok, true, t.reason);
    const refused = await m.supervisor.claimTask("dev", t.taskId!);
    assert.equal(refused.ok, false);
    assert.equal(
      refused.reason,
      "missing capability test.write: agent dev does not hold capability 'test.write' — held by: qa. A task's required capabilities are fixed when it is filed and nothing waives them: ask pm, who filed it, for a task without test.write, or for one given to a seat that holds every capability it lists",
    );
    assert.equal((await m.supervisor.claimTask("qa", t.taskId!)).ok, true, "the seat that holds it claims as before");
  } finally {
    await m.cleanup();
  }
});

test("a refused claim on a capability no seat holds says so, and a claimant who filed the task is told to file it again", async () => {
  const m = await mesh();
  try {
    const t = await createTask(m, "dev", { requiredCapabilities: ["security.scan"] });
    assert.equal(t.ok, true, t.reason);
    assert.equal(t.caveat, true, "filed with the caveat, since nobody can claim it");
    const refused = await m.supervisor.claimTask("dev", t.taskId!);
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /^missing capability security\.scan: agent dev does not hold capability 'security\.scan' — no seat holds it\. /);
    assert.match(refused.reason ?? "", /file it again without security\.scan, or have it given to a seat that holds every capability it lists$/);
  } finally {
    await m.cleanup();
  }
});

test("mesh_task_create says what requiredCapabilities means: what the claimant must hold, all of it", async () => {
  const m = await mesh();
  try {
    const mcp = createMcpToolset(m.supervisor);
    const token = mintSeatToken(m.config.meshId, "pm", m.kernel.state.activeGoalId);
    const res = (await mcp.handle("pm", token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as {
      result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { description?: string }> } }> };
    };
    const tool = res.result.tools.find((t) => t.name === "mesh_task_create");
    assert.ok(tool, "the pm has the tool");
    const text = tool.inputSchema.properties.requiredCapabilities?.description ?? "";
    assert.match(text, /capabilities the seat that claims this task must hold/);
    assert.match(text, /only a seat that holds ALL of them can claim it, and assignedTo must be one/);
    assert.match(text, /leave it out unless the work needs one of its claimant/);
  } finally {
    await m.cleanup();
  }
});

test("an alias is read as the capability it names: a delegate or a task for the seat holding the canonical token is not refused", async () => {
  // dev2 declares the aliases; config load normalizes them to repository.write and test.execute.
  const alias = { id: "dev2", role: "developer", capabilities: ["api.write", "test.run"], interests: [] };
  const m = await makeMesh({ agents: [...AGENTS, alias], mayContact: { ...COMM, pm: ["dev", "qa", "dev2"], dev2: ["pm"] }, mode: "parked" } as never);
  try {
    const assigned = await createTask(m, "pm", { assignedTo: "dev2", requiredCapabilities: ["code.write", "test.run"] });
    assert.equal(assigned.ok, true, `refused as lacking a capability dev2 holds under its canonical name: ${assigned.reason ?? ""}`);
    assert.equal(assigned.reason, undefined);
    const unassigned = await createTask(m, "pm", { title: "Run the suite", requiredCapabilities: ["test.run"] });
    assert.equal(unassigned.ok, true);
    assert.equal(unassigned.reason, undefined, "and no seat is said to be missing for it");
  } finally {
    await m.cleanup();
  }
});

test("a capability written under two names is listed once", async () => {
  const m = await mesh();
  try {
    const res = await createTask(m, "pm", { assignedTo: "qa", requiredCapabilities: ["repository.write", "code.write", "api.write"] });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^qa lacks required capabilities repository\.write \(held by: dev\)\. /);
    assert.match(res.reason ?? "", /take repository\.write out of requiredCapabilities if the claimant does not need it$/);
  } finally {
    await m.cleanup();
  }
});

test("an assignee that is not a seat, or is the operator, is not what this check is for: the task is filed as before", async () => {
  const m = await mesh();
  try {
    for (const assignedTo of ["human", "ghost"]) {
      const res = await createTask(m, "pm", { title: `for ${assignedTo}`, assignedTo, requiredCapabilities: INCIDENT });
      assert.equal(res.ok, true, `${assignedTo}: ${res.reason ?? ""}`);
      assert.equal(res.reason, undefined);
    }
  } finally {
    await m.cleanup();
  }
});

test("the closest seats come first, whatever the roster's order, and no more than three are named", async () => {
  const seat = (id: string, capabilities: string[]) => ({ id, role: "developer", capabilities: ["repository.read", ...capabilities], interests: [] });
  const roster = [
    { id: "pm", role: "product-manager", capabilities: ["repository.read", "task.assign"], interests: [] },
    seat("s4", ["test.write", "test.execute"]), // lacks two
    seat("s5", ["git.commit"]), // lacks three
    seat("s3", ["repository.write", "git.commit"]), // lacks two
    seat("s1", ["repository.write", "git.commit", "test.write"]), // lacks one
    seat("s2", ["repository.write", "git.commit", "test.execute"]), // lacks one
  ];
  const m = await makeMesh({ agents: roster, mayContact: { pm: ["s1", "s2", "s3", "s4", "s5"] }, mode: "parked" } as never);
  try {
    const res = await createTask(m, "pm", { requiredCapabilities: INCIDENT });
    assert.equal(res.ok, true, res.reason);
    assert.equal(
      res.reason,
      "task filed, but no seat holds all of repository.write, git.commit, test.write, test.execute (s1 lacks test.execute; s2 lacks test.write; s4 lacks repository.write, git.commit), so nobody can claim it and no op withdraws it: take out what the claimant does not need and file it again",
      "fewest missing first (s1, s2), then roster order among equals (s4 before s3); s5 and the rest are left out",
    );
  } finally {
    await m.cleanup();
  }
});

test("capabilities no seat holds at all are said to be held by none, one or several", async () => {
  const m = await mesh();
  try {
    const several = await createTask(m, "pm", { requiredCapabilities: ["security.scan", "security.review"] });
    assert.equal(several.reason, "task filed, but no seat holds any of security.scan, security.review, so nobody can claim it and no op withdraws it: take out what the claimant does not need and file it again");
    const one = await createTask(m, "pm", { title: "Scan it", requiredCapabilities: ["security.scan"] });
    assert.equal(one.reason, "task filed, but no seat holds security.scan, so nobody can claim it and no op withdraws it: take out what the claimant does not need and file it again");
  } finally {
    await m.cleanup();
  }
});

test("a task that is unclaimable and was cut from a version that has moved on says both", async () => {
  const arch = { id: "arch", role: "architect", capabilities: ["repository.read", "architecture.write"], interests: [] };
  const m = await makeMesh({ agents: [...AGENTS, arch], mayContact: { ...COMM, pm: ["dev", "qa", "arch"], arch: ["pm"] }, mode: "parked" } as never);
  try {
    const v1 = await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "architecture", type: "ArchitectureDocument", content: "# v1 plan" } as MeshOp, turnFor("arch"));
    await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "architecture", type: "ArchitectureDocument", content: "# v2 plan", asVersionOf: v1.artifactId } as MeshOp, turnFor("arch"));

    const stale = await createTask(m, "pm", { title: "From the plan", requiredCapabilities: ["repository.write"], artifactRefs: [{ uri: v1.artifactUri }] });
    assert.equal(stale.ok, true, stale.reason);
    assert.equal(stale.caveat, true);
    assert.equal(stale.reason, "task filed, but it cites ArchitectureDocument/architecture v1 → v2 — the newer version may change what this task should say", "the stale-pin note alone reads as it always did");

    const both = await createTask(m, "pm", { title: "From the plan, again", requiredCapabilities: INCIDENT, artifactRefs: [{ uri: v1.artifactUri }] });
    assert.equal(both.ok, true, both.reason);
    assert.equal(both.caveat, true);
    assert.equal(
      both.reason,
      "task filed, but no seat holds all of repository.write, git.commit, test.write, test.execute (dev lacks test.write; qa lacks repository.write, git.commit), so nobody can claim it and no op withdraws it: take out what the claimant does not need and file it again; and it cites ArchitectureDocument/architecture v1 → v2 — the newer version may change what this task should say",
    );
  } finally {
    await m.cleanup();
  }
});

test("a claim refused by a policy rule, not by a missing capability, gets no 'held by' route", async () => {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    mode: "parked",
    rules: [{ id: "no-qa-test-writing", when: { actor_role: "qa" }, deny: { capabilities: ["test.write"] } }],
  } as never);
  try {
    const t = await createTask(m, "pm", { requiredCapabilities: ["test.write"] });
    assert.equal(t.ok, true, t.reason);
    const refused = await m.supervisor.claimTask("qa", t.taskId!);
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "missing capability test.write: capability 'test.write' denied by rule 'no-qa-test-writing'", "qa does hold the capability; saying 'held by: qa' to qa would be absurd");
  } finally {
    await m.cleanup();
  }
});

test("an invented capability is the unknown-token refusal with the known list, from delegate as from create_task; only a real one reaches the claim check", async () => {
  const m = await mesh();
  try {
    const viaCreate = await createTask(m, "pm", { assignedTo: "dev", requiredCapabilities: ["test.exec"] });
    const viaDelegate = await delegateTo(m, "pm", "dev", ["test.exec"]);
    for (const res of [viaCreate, viaDelegate]) {
      assert.equal(res.ok, false);
      assert.match(res.reason ?? "", /^task requires capability the runtime can never match: test\.exec \(known: /, "it is not a gap in dev's holdings, it is a word that names nothing");
    }
    assert.equal(viaDelegate.reason, viaCreate.reason);
  } finally {
    await m.cleanup();
  }
});
