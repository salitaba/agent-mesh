import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * Structural unsatisfiability: the mesh provably cannot perform an action its
 * own config commits it to. Sibling of `capability-coverage.test.ts`, which
 * pins the same family for `git.commit`. Everything here resolves through
 * `resolveConfig` rather than calling the check directly, so a check that is
 * written but never wired into the aggregation block still fails the test.
 */

type Agent = { id: string; role: string; caps?: string[] };

function meshYaml(opts: {
  agents: Agent[];
  startup?: string[];
  transitions?: Record<string, string[]>;
  communication?: Record<string, { out?: string[]; in?: string[] }>;
}): string {
  const agents = opts.agents
    .map((a) => {
      const caps = a.caps ?? [];
      const capsYaml = caps.length === 0 ? "    capabilities: []" : `    capabilities:\n${caps.map((c) => `      - ${c}`).join("\n")}`;
      return `  ${a.id}:\n    role: ${a.role}\n${capsYaml}\n    authority: []`;
    })
    .join("\n");
  const blocks: string[] = [];
  if (opts.startup !== undefined) blocks.push(`startup:\n  activate: [${opts.startup.join(", ")}]`);
  const policies: string[] = [];
  if (opts.communication) {
    const entries = Object.entries(opts.communication)
      .map(([id, e]) => `    ${id}:\n      may_contact: [${(e.out ?? []).join(", ")}]\n      may_be_contacted_by: [${(e.in ?? []).join(", ")}]`)
      .join("\n");
    policies.push(`  communication:\n${entries}`);
  }
  if (opts.transitions) {
    const entries = Object.entries(opts.transitions)
      .map(([gate, requires]) => `    ${gate}: { requires: [${requires.join(", ")}] }`)
      .join("\n");
    policies.push(`  transitions:\n${entries}`);
  }
  if (policies.length) blocks.push(`policies:\n${policies.join("\n")}`);
  return `version: 1
mesh:
  id: sattest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
${blocks.join("\n")}
agents:
${agents}
`;
}

function resolve(opts: Parameters<typeof meshYaml>[0]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sat-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), meshYaml(opts), "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Narrow to the unmergeable-GATE warning specifically. `includes("git.merge")`
// was a good-enough proxy until a second git.merge warning existed
// (`warnMergeWithoutRepair`, for a seat that can land a patch but not repair
// one), which this filter then swept up and reported as a gate problem.
const merge = (w: string[]) => w.filter((x) => x.includes("no agent holds 'git.merge'"));
const boots = (w: string[]) => w.filter((x) => x.includes("startup.activate"));
const wired = (w: string[]) => w.filter((x) => x.includes("wired to nobody"));

/* ---------------- A2: a merge gate no seat can satisfy ---------------- */

const lead: Agent = { id: "lead", role: "tech-lead", caps: ["repository.read"] };

test("a declared merge gate with no git.merge holder is warned about at load", () => {
  const cfg = resolve({ agents: [lead], transitions: { "patch.merge": ["lead.approve"] }, startup: ["lead"] });
  const hits = merge(cfg.warnings);
  assert.equal(hits.length, 1, `expected one merge warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(hits[0], /'patch\.merge'/, "names the gate the operator has to look at");
  assert.match(hits[0], /MERGED/, "says which transition is refused");
});

test("a merge gate covered by a git.merge holder is silent", () => {
  const cfg = resolve({
    agents: [{ id: "lead", role: "tech-lead", caps: ["git.merge"] }],
    transitions: { "patch.merge": ["lead.approve"] },
    startup: ["lead"],
  });
  assert.deepEqual(merge(cfg.warnings), []);
});

test("a mesh that declares no merge gate is never warned about git.merge", () => {
  // The narrowness is the point: a mesh that never merges must stay silent
  // even though nobody holds the capability.
  const cfg = resolve({ agents: [lead], transitions: { "implementation.completed": ["lead.approve"] }, startup: ["lead"] });
  assert.deepEqual(merge(cfg.warnings), []);
});

test("the merge warning does not stop the config from loading", () => {
  const cfg = resolve({ agents: [lead], transitions: { "patch.merge": ["lead.approve"] }, startup: ["lead"] });
  assert.equal(cfg.agents.lead.role, "tech-lead");
  assert.equal(merge(cfg.warnings).length, 1);
});

/* ---------------- B1: nobody boots ---------------- */

test("an empty startup.activate is warned about at load", () => {
  const cfg = resolve({ agents: [lead], startup: [] });
  const hits = boots(cfg.warnings);
  assert.equal(hits.length, 1, `expected one boot warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(hits[0], /idle/, "says what going live actually does");
});

test("an omitted startup block warns the same as an empty one", () => {
  // `raw.startup?.activate ?? []` collapses both, and an operator who left the
  // block out is in exactly the same position as one who emptied it.
  const cfg = resolve({ agents: [lead] });
  assert.equal(boots(cfg.warnings).length, 1);
});

test("a mesh that names a startup agent is silent", () => {
  const cfg = resolve({ agents: [lead], startup: ["lead"] });
  assert.deepEqual(boots(cfg.warnings), []);
});

/* ---------------- C1: an agent wired to nobody ---------------- */

test("an agent with no communication edge in either direction is named", () => {
  const cfg = resolve({
    agents: [lead, { id: "dev", role: "developer" }, { id: "loner", role: "qa" }],
    communication: { lead: { out: ["dev"] }, dev: { out: ["lead"] }, loner: {} },
    startup: ["lead"],
  });
  const hits = wired(cfg.warnings);
  assert.equal(hits.length, 1, `expected one reachability warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(hits[0], /'loner'/);
  assert.doesNotMatch(hits[0], /'lead'/, "a wired seat is not accused");
});

test("an inbound-only edge counts as wired", () => {
  // Declared from the other side only: `may_be_contacted_by` is a real grant,
  // and reading connectivity in one direction would libel a correct mesh.
  const cfg = resolve({
    agents: [lead, { id: "dev", role: "developer" }],
    communication: { lead: { out: ["dev"] }, dev: {} },
    startup: ["lead"],
  });
  assert.deepEqual(wired(cfg.warnings), []);
});

test("a seat wired only through its own may_be_contacted_by counts as wired", () => {
  const cfg = resolve({
    agents: [lead, { id: "dev", role: "developer" }],
    communication: { lead: {}, dev: { in: ["lead"] } },
    startup: ["lead"],
  });
  assert.deepEqual(wired(cfg.warnings), []);
});

test("a single-agent mesh is never accused of being wired to nobody", () => {
  // There is nobody to be wired to; the warning would be noise on the
  // smallest legitimate mesh there is.
  const cfg = resolve({ agents: [lead], startup: ["lead"] });
  assert.deepEqual(wired(cfg.warnings), []);
});

/* ---------------- the human seat is a valid gate actor ---------------- */

const gateActor = (w: string[]) => w.filter((x) => x.startsWith("transition gate '"));

test("a gate requiring the human seat is not called unsatisfiable", () => {
  // `human` is never an agent, so it cannot appear in the id/role set this
  // check builds — but direct human approvals do satisfy gates (see
  // tests/integration/human.test.ts, "humans are a mesh seat not an external
  // oracle"). Warning here is a false alarm on a supported pattern, and it
  // tells the operator a working mesh is deadlocked.
  const cfg = resolve({ agents: [lead], transitions: { "release.accepted": ["human.approve"] }, startup: ["lead"] });
  assert.deepEqual(gateActor(cfg.warnings), []);
});

test("mixing the human seat with an unknown actor still reports the unknown one", () => {
  const cfg = resolve({
    agents: [lead],
    transitions: { "release.accepted": ["human.approve", "ghost.approve"] },
    startup: ["lead"],
  });
  const hits = gateActor(cfg.warnings);
  assert.equal(hits.length, 1, `only the unknown actor is a problem, got ${JSON.stringify(hits)}`);
  assert.match(hits[0], /ghost/, "names the actor that actually cannot play the gate");
  assert.doesNotMatch(hits[0], /human/, "the exempted seat must never be blamed");
});

test("an unknown gate actor is still reported after the exemption", () => {
  // The exemption is one string, not a hole: everything else still checks.
  const cfg = resolve({ agents: [lead], transitions: { "patch.merge": ["ghost.approve"] }, startup: ["lead"] });
  assert.equal(gateActor(cfg.warnings).length, 1, JSON.stringify(cfg.warnings));
});

test("gate-actor warnings keep the prefix the server dedups on", () => {
  // mesh-server's /config/validate seeds its response from resolved.warnings
  // but filters these out, because it runs the policy-engine's stronger gate
  // check and would otherwise show one defect twice in different words. That
  // filter matches on this prefix — reword the message without updating
  // mesh-server/src/index.ts and the duplicate silently comes back.
  const cfg = resolve({ agents: [lead], transitions: { "patch.merge": ["ghost.approve"] }, startup: ["lead"] });
  assert.ok(
    cfg.warnings.some((w) => w.startsWith("transition gate '")),
    `the prefix mesh-server filters on must survive rewording, got ${JSON.stringify(cfg.warnings)}`,
  );
});
