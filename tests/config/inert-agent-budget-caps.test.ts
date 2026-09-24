import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * A seat's `budget` block accepts four caps and enforces two of them.
 * `tokens` becomes a real ledger line the supervisor reserves against, and
 * `max_activations` is a policy-engine DEFER. `wall_clock_minutes` and
 * `max_events` do not bind: no per-agent wall-clock or event ledger exists,
 * so nothing ever reads them.
 *
 * They stay in the schema because the block is `additionalProperties: false`
 * and removing a property would reject every config that already sets one.
 * What these tests pin is the line between the two halves. The failure this
 * guards against is not a missing warning — it is a warning that grows to
 * cover `tokens` or `max_activations` and starts telling operators that a cap
 * which does bind does not.
 */
function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-agentbudget-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mesh = (budgetBlock: string): string => `version: 1
mesh:
  id: agentbudgettest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
  dev:
    role: developer
    capabilities:
      - repository.write
    authority: []
${budgetBlock}
startup:
  activate: [dev]
`;

const capWarning = (warnings: string[]): string | undefined =>
  warnings.find((w) => w.includes("set but inert") && w.includes("budget"));

test("a per-agent wall clock warns, and the warning names the key that does bind", () => {
  const resolved = resolveRaw(mesh(`    budget:
      wall_clock_minutes: 30`));
  const w = capWarning(resolved.warnings);
  assert.ok(w, "a cap that never binds must not be accepted in silence");
  assert.match(w, /agents\.dev\.budget\.wall_clock_minutes/, "must name the path the author wrote");
  assert.match(w, / is set but inert/, "one path, singular verb");
  assert.match(w, /budgets\.mission\.wall_clock_minutes/, "must point at the cap that is enforced");
  assert.match(w, /budget\.tokens/, "must offer the per-seat remedy too — the mission cap is not per-seat");
});

test("a per-agent event ceiling warns", () => {
  const resolved = resolveRaw(mesh(`    budget:
      max_events: 500`));
  const w = capWarning(resolved.warnings);
  assert.ok(w);
  assert.match(w, /agents\.dev\.budget\.max_events/);
  assert.match(w, /\.max_events, which are enforced/);
});

test("both inert caps are reported in one warning, as one list", () => {
  const resolved = resolveRaw(mesh(`    budget:
      wall_clock_minutes: 30
      max_events: 500`));
  const all = resolved.warnings.filter((w) => w.includes("set but inert") && w.includes("budget"));
  // One sentence, not two: unlike the inert scheduling keys, both of these
  // have the same remedy, so a second warning would repeat it verbatim.
  assert.equal(all.length, 1, "identical remedies belong in one sentence");
  assert.match(all[0]!, /wall_clock_minutes.*max_events/s);
  assert.match(all[0]!, / are set but inert/, "two paths, plural verb");
});

test("the caps that DO bind never warn", () => {
  // The whole point of the check. Both of these bind — `tokens` through the
  // budget ledger, `max_activations` through the policy engine — and telling
  // an operator they are inert would be worse than saying nothing, because
  // they would remove a working cap.
  const resolved = resolveRaw(mesh(`    budget:
      tokens: 200000
      max_activations: 12`));
  assert.equal(capWarning(resolved.warnings), undefined);
});

test("a seat with no budget block is silent", () => {
  const resolved = resolveRaw(mesh(""));
  assert.equal(capWarning(resolved.warnings), undefined, "the default states no cap, so there is nothing to correct");
});

test("every shipped example is silent", async () => {
  // These warnings print on every `mesh run`. An example that trips one would
  // train operators to read past the whole class.
  // process.cwd(), not __dirname: tests run from compiled output under dist/,
  // so a path relative to the test file lands in dist/examples, which is empty.
  const root = path.resolve(process.cwd(), "examples");
  const examples = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.resolve(root, e.name, "mesh.yaml"))
    .filter((p) => fs.existsSync(p));
  assert.ok(examples.length > 0, "found no examples to check — the glob is wrong, not the meshes");
  for (const file of examples) {
    const resolved = resolveConfig(file);
    assert.equal(capWarning(resolved.warnings), undefined, `${file} sets an inert per-agent cap`);
  }
});
