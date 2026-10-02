import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveConfig } from "../../packages/config/src/index";
import { canReviewArtifactType, REVIEW_CAPABILITIES, validateTransitionGates } from "../../packages/policy-engine/src/index";
import { AUTHORITY_DOMAINS, AUTO_EVIDENCED_CRITERIA, DEFAULT_CRITERIA } from "../../packages/protocol/src/index";
import type { AgentDefinition } from "../../packages/protocol/src/index";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * Every shipped example must be able to FINISH, not just parse.
 *
 * `gate-satisfiability.test.ts` parses each example and checks its gates, and
 * `journey.test.ts` boots `demo-stub` alone. Nothing else ever booted the other
 * examples, and nothing asked whether each one's mandatory acceptance criteria
 * have anyone who can close them — which is how `greenfield` and `spring-boot`
 * both shipped with a mandatory criterion no seat could ever evidence.
 *
 * Discovered dynamically: a new example is covered the moment its `mesh.yaml`
 * lands, with no list to forget to update.
 *
 * Paths resolve against `process.cwd()` (as `journey.test.ts` does), which is
 * the repo root under `npm test` and the build root under the isolated build
 * script — both carry `examples/` and `roles/`.
 */

const EXAMPLES = path.resolve(process.cwd(), "examples");
const ROLES = path.resolve(process.cwd(), "roles");
const CLI = path.resolve(__dirname, "..", "..", "apps", "mesh-cli", "src", "index.js");
const HUMAN = "human";

const examples = fs
  .readdirSync(EXAMPLES)
  .filter((d) => fs.existsSync(path.join(EXAMPLES, d, "mesh.yaml")))
  .sort();

/**
 * Rows that are known to fail, keyed `<example>` / `<example>:<criterion>` /
 * `<example>:gate:<gate>:<token>`, each value a `BUG: …` todo reason. Empty
 * because every shipped example currently passes; a regression turns a row red,
 * and the fix is either the config or an entry here with the defect named.
 */
const KNOWN_BUGS: Record<string, string> = {};

/**
 * Copy an example into a scratch tree so that booting it writes nothing into
 * the repo, with every seat moved onto the stub runtime so that booting it
 * spawns no model. `roles/` is linked beside it because the examples reference
 * their prompts as `../../roles/<seat>.md`.
 */
function stageExample(name: string): { root: string; configPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-example-${name}-`));
  fs.symlinkSync(ROLES, path.join(root, "roles"));
  const dir = path.join(root, "examples", name);
  fs.mkdirSync(dir, { recursive: true });
  const raw = parseYaml(fs.readFileSync(path.join(EXAMPLES, name, "mesh.yaml"), "utf8"));
  raw.mesh.runtime = { ...(raw.mesh.runtime ?? {}), default: "stub" };
  for (const agent of Object.values(raw.agents ?? {}) as Array<{ runtime?: string }>) {
    if (agent.runtime) agent.runtime = "stub";
  }
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, stringifyYaml(raw), "utf8");
  return { root, configPath };
}

async function withBootedExample<T>(name: string, fn: (m: MeshInstance) => Promise<T>): Promise<T> {
  const { root, configPath } = stageExample(name);
  const instance = await bootstrapMesh({ configPath, inMemory: true, mode: "parked", uiOnly: true });
  try {
    return await fn(instance);
  } finally {
    await instance.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/** Declared seats only: the human seat holds `*` and would make every check vacuous. */
function seatsOf(m: MeshInstance): AgentDefinition[] {
  return [...m.kernel.state.agents.values()].map((r) => r.definition).filter((d) => d.id !== HUMAN && !d.id.includes("#"));
}

/**
 * Every way the runtime can close a mandatory criterion, asked of the booted
 * mesh's own PolicyEngine rather than re-derived from tokens.
 *
 * - Any criterion: `approve subject:"criterion:<id>"`, which
 *   `Supervisor.recordDecision` allows on `requirements.accept` OR
 *   `requirements.approve`.
 * - The five `AUTO_EVIDENCED_CRITERIA` additionally close from the op that
 *   produces them (`markCriterionEvidence` call sites in supervisor.ts):
 *   `architecture-approved` from an architecture approval or an
 *   ArchitectureDocument/ApiSpec reaching APPROVED; `implementation-merged`
 *   from a merge, which needs the `git.merge` capability; `quality-verified` /
 *   `security-verified` from a `pass` in that domain; `req-analysis` from
 *   publishing a ResearchReport, which no capability gates.
 *
 * The TEST_RESULT / SECURITY_FINDING `PASSED` message route is deliberately not
 * counted: it checks no authority at all, so counting it would make both
 * verification criteria vacuously reachable in every mesh.
 */
function pathsToEvidence(m: MeshInstance, criterionId: string): string[] {
  const policy = m.supervisor.deps.policy;
  const st = m.kernel.state;
  const ctx = { config: m.config, projections: st, goal: st.activeGoalId ? st.goals.get(st.activeGoalId) : undefined };
  const allows = (id: string, subject: string, kind: string) => policy.evaluateAuthority(id, subject, kind, ctx).decision === "ALLOW";
  const paths: string[] = [];
  for (const seat of seatsOf(m)) {
    if (allows(seat.id, "requirements", "accept") || allows(seat.id, "requirements", "approve")) {
      paths.push(`${seat.id}: approve criterion:${criterionId}`);
    }
    if (!AUTO_EVIDENCED_CRITERIA.includes(criterionId)) continue;
    switch (criterionId) {
      case "architecture-approved":
        if (
          allows(seat.id, "architecture", "approve") ||
          canReviewArtifactType(seat, "ArchitectureDocument").ok ||
          canReviewArtifactType(seat, "ApiSpec").ok
        ) {
          paths.push(`${seat.id}: approve architecture`);
        }
        break;
      case "implementation-merged":
        if (policy.evaluateCapability(seat.id, "git.merge", ctx).decision === "ALLOW") paths.push(`${seat.id}: merge`);
        break;
      case "quality-verified":
        if (allows(seat.id, "quality", "pass")) paths.push(`${seat.id}: pass quality`);
        break;
      case "security-verified":
        if (allows(seat.id, "security", "pass")) paths.push(`${seat.id}: pass security`);
        break;
      case "req-analysis":
        paths.push(`${seat.id}: publish ResearchReport`);
        break;
    }
  }
  return paths;
}

/** Which recorded verdict kinds `checkApprovals` accepts for a gate token's kind. */
const SATISFIES: Record<string, string[]> = {
  approve: ["approve", "accept", "merge", "pass"],
  pass: ["pass", "accept", "merge"],
};

function tokenIssuers(m: MeshInstance, token: string): string[] {
  const idx = token.lastIndexOf(".");
  const actor = token.slice(0, idx);
  const kind = token.slice(idx + 1);
  if (actor === HUMAN) return [HUMAN];
  const policy = m.supervisor.deps.policy;
  const st = m.kernel.state;
  const ctx = { config: m.config, projections: st, goal: st.activeGoalId ? st.goals.get(st.activeGoalId) : undefined };
  const kinds = SATISFIES[kind] ?? [kind];
  return seatsOf(m)
    .filter((s) => s.id === actor || s.role === actor)
    .filter(
      (s) =>
        AUTHORITY_DOMAINS.some((d) => kinds.some((k) => policy.evaluateAuthority(s.id, d, k, ctx).decision === "ALLOW")) ||
        // recordDecision's fallback: an `approve` on an artifact is allowed on
        // that artifact type's review capability alone.
        (kind === "approve" && Object.values(REVIEW_CAPABILITIES).some((c) => policy.evaluateCapability(s.id, c, ctx).decision === "ALLOW")),
    )
    .map((s) => s.id);
}

test("examples are discovered", () => {
  assert.ok(examples.length >= 5, `found only [${examples.join(", ")}] under ${EXAMPLES} — discovery is broken, not the examples`);
});

for (const name of examples) {
  const configPath = path.join(EXAMPLES, name, "mesh.yaml");

  test(`example ${name}: loads and validates with zero errors`, { todo: KNOWN_BUGS[`${name}:load`] }, () => {
    // resolveConfig throws ConfigError on any error; warnings are checked below.
    const resolved = resolveConfig(configPath);
    assert.equal(resolved.meshId.length > 0, true);
  });

  test(`example ${name}: boots on the stub runtime`, { todo: KNOWN_BUGS[`${name}:boot`] }, async () => {
    await withBootedExample(name, async (m) => {
      const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!);
      assert.ok(goal, "boot created the mission goal");
      assert.ok(goal.acceptanceCriteria.length > 0, "the goal carries acceptance criteria");
      const declared = Object.keys(m.config.agents).sort();
      assert.deepEqual(seatsOf(m).map((s) => s.id).sort(), declared, "every declared seat registered");
    });
  });

  test(`example ${name}: every mandatory acceptance criterion has a path to EVIDENCED`, async (t) => {
    await withBootedExample(name, async (m) => {
      const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
      // Read the criteria the booted goal actually carries, not the yaml: a mesh
      // declaring none inherits DEFAULT_CRITERIA at boot, and that inherited list
      // is where the unclosable `requirements-documented` came from.
      const expected = (m.config.goalCriteria ?? DEFAULT_CRITERIA).filter((c) => c.mandatory ?? true).map((c) => c.id);
      const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
      assert.deepEqual(mandatory.map((c) => c.id), expected, "the goal's mandatory criteria are the config's (or the defaults)");
      for (const c of mandatory) {
        await t.test(c.id, { todo: KNOWN_BUGS[`${name}:${c.id}`] }, () => {
          const paths = pathsToEvidence(m, c.id);
          assert.ok(
            paths.length > 0,
            `'${c.id}' is mandatory and no declared seat can evidence it — ` +
              (AUTO_EVIDENCED_CRITERIA.includes(c.id) ? "its auto-evidencing op has no holder, and " : "it is not auto-evidenced, and ") +
              "nobody holds requirements.accept / requirements.approve",
          );
        });
      }
    });
  });

  test(`example ${name}: every transition gate is satisfiable by a declared seat`, async (t) => {
    await withBootedExample(name, async (m) => {
      const transitions = m.config.raw.policies?.transitions ?? {};
      assert.deepEqual(validateTransitionGates(transitions, m.config.raw.agents), [], "the policy-engine's own gate check");
      for (const [gate, spec] of Object.entries(transitions)) {
        for (const token of spec?.requires ?? []) {
          await t.test(`${gate}: ${token}`, { todo: KNOWN_BUGS[`${name}:gate:${gate}:${token}`] }, () => {
            assert.ok(tokenIssuers(m, token).length > 0, `no seat named by '${token}' can record a verdict that satisfies it`);
          });
        }
        if (gate === "patch.merge") {
          // Collecting every approval is not enough: the MERGED transition itself
          // needs a `git.merge` holder (`evaluateTransition`).
          const st = m.kernel.state;
          const ctx = { config: m.config, projections: st, goal: undefined };
          const mergers = seatsOf(m).filter((s) => m.supervisor.deps.policy.evaluateCapability(s.id, "git.merge", ctx).decision === "ALLOW");
          assert.ok(mergers.length > 0, "patch.merge is declared but no seat may perform the merge");
        }
      }
    });
  });
}

/**
 * NOTES-test-gaps 7.3: the load-time warnings for 3/4 only help if the command
 * an operator actually types prints them. `ordane run` goes straight to
 * `launchMesh`, never through `ordane validate`, so this drives the real CLI
 * entry point in a child process on a deliberately broken mesh and reads what
 * it printed before the server came up.
 *
 * Headless (`--no-tui`) only. On a TTY `ordane run` defaults to the TUI, whose
 * first frame clears the screen (`tui.ts` writes `\x1b[2J`) and renders no
 * config warnings — that path cannot be driven without a pty.
 */
test("`ordane run` prints the unsatisfiable-criterion and unsatisfiable-gate warnings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-run-warnings-"));
  const configPath = path.join(root, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    `version: 1
mesh:
  id: runwarn
  goal: |
    Ship it.
  acceptance_criteria:
    - { id: ship-it, description: "the thing ships", mandatory: true }
  workspace: { path: ./workspace, git: false }
  runtime: { default: stub }
agents:
  dev:
    role: developer
    runtime: stub
    capabilities: [repository.read, repository.write]
    authority: []
policies:
  transitions:
    patch.merge: { requires: [ghost.approve] }
startup:
  activate: [dev]
`,
    "utf8",
  );
  const expected = resolveConfig(configPath).warnings;
  const criterion = expected.find((w) => w.includes("ship-it") && w.includes("can never be satisfied"));
  const gate = expected.find((w) => w.includes("ghost.approve"));
  assert.ok(criterion && gate, `fixture check: the config layer must warn about both (${expected.join(" | ")})`);

  const child = spawn(process.execPath, [CLI, "run", configPath, "--parked", "--no-tui", "--port", "0"], {
    cwd: root,
    env: { ...process.env, HOME: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (b) => (out += String(b)));
  child.stderr.on("data", (b) => (out += String(b)));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ordane run never came up:\n${out}`)), 30_000);
      const poll = setInterval(() => {
        if (/online at/.test(out)) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 50);
      child.once("exit", (code) => {
        clearTimeout(timer);
        clearInterval(poll);
        if (/online at/.test(out)) resolve();
        else reject(new Error(`ordane run exited ${code} before coming up:\n${out}`));
      });
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise((r) => child.once("close", r));
      child.kill("SIGTERM");
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(out.includes(criterion), `the unsatisfiable-criterion warning never reached \`ordane run\`'s output:\n${out}`);
  assert.ok(out.includes(gate), `the unsatisfiable-gate warning never reached \`ordane run\`'s output:\n${out}`);
});
