import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import {
  FIELDS,
  GROUPS,
  RESTART_COMMANDS,
  confirmCopy,
  defaultHint,
  draftOf,
  fmtValue,
  legend,
  needsConfirm,
  parseDraft,
  planSave,
  priceLines,
  savePayload,
  serverProblems,
  specOf,
  type Drafts,
  type HostConfigValues,
} from "../../apps/mesh-dashboard/src/hostsettings";
import { DEFAULT_SPEND_CEILING_USD, DEFAULT_USD_PER_MTOK, HOST_CONFIG_EFFECTS, validateHostConfigUpdate } from "../../packages/projects/src/host-config";

/**
 * What the Host settings form decides. The host owns the rules (what is valid, when an edit lands, when a raise needs asking);
 * these tests read its source and run its own validator, so a rule that moves there fails here instead of in front of an operator.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (...p: string[]): string => fs.readFileSync(path.join(root, ...p), "utf8");

const NOW: HostConfigValues = { spendCeilingUsd: 50, maxConcurrentTurns: null, defaultUsdPerMtok: 3, projectMemoryMb: null };
const LIVE = { spend_ceiling_usd: "live", max_concurrent_turns: "live", default_usd_per_mtok: "live", model_prices: "live", project_memory_mb: "host-restart" };

test("the form's four settings are the host's four editable keys, with the same names and the same rule about blank", () => {
  const src = read("packages", "projects", "src", "host-config.ts");
  const block = /const UPDATE_KEYS[^=]*=\s*\{([\s\S]*?)\n\};/.exec(src);
  assert.ok(block, "the host's editable keys are where this test expects them");
  const host = [...block![1]!.matchAll(/(\w+):\s*\{\s*yaml:\s*"([a-z_]+)",\s*nullable:\s*(true|false)\s*\}/g)].map((m) => ({ field: m[1], yaml: m[2], nullable: m[3] === "true" }));
  assert.equal(host.length, 4);
  const mine = FIELDS.map((f) => ({ field: f.field as string, yaml: f.yaml, nullable: f.nullable })).sort((a, b) => a.field.localeCompare(b.field));
  assert.deepEqual(mine, host.sort((a, b) => a.field!.localeCompare(b.field!)));
});

test("the built-in defaults the form quotes are the host's", () => {
  assert.equal(specOf("spendCeilingUsd").fallback, DEFAULT_SPEND_CEILING_USD);
  assert.equal(specOf("defaultUsdPerMtok").fallback, DEFAULT_USD_PER_MTOK);
  const src = read("packages", "projects", "src", "host-config.ts");
  assert.match(src, /projectMemoryMb: null,/, "memory has no cap by default");
  assert.match(src, /maxConcurrentTurns: null,/, "turns have no cap by default");
  assert.equal(specOf("projectMemoryMb").fallback, null);
  assert.equal(specOf("maxConcurrentTurns").fallback, null);
});

test("every setting the form edits has an answer from the host about when it lands", () => {
  for (const f of FIELDS) assert.ok(["live", "host-restart"].includes(HOST_CONFIG_EFFECTS[f.yaml] ?? ""), `${f.yaml} has an effect`);
  assert.equal(HOST_CONFIG_EFFECTS.project_memory_mb, "host-restart", "the one setting the legend and the restart commands exist for");
});

test("the groups cover every setting once, in the order the page shows them", () => {
  assert.deepEqual(GROUPS.map((g) => g.title), ["Spend and turns", "Prices", "Memory"]);
  assert.deepEqual(FIELDS.map((f) => f.group), ["spend", "spend", "prices", "memory"]);
  for (const g of GROUPS) assert.ok(FIELDS.some((f) => f.group === g.id), `${g.title} has a setting`);
});

test("a typed value means what the host would take it to mean: a positive number, or blank for no limit where blank is allowed", () => {
  const ceiling = specOf("spendCeilingUsd");
  assert.deepEqual(parseDraft(ceiling, "80"), { ok: true, value: 80 });
  assert.deepEqual(parseDraft(ceiling, " 12.5 "), { ok: true, value: 12.5 });
  assert.deepEqual(parseDraft(ceiling, ".5"), { ok: true, value: 0.5 });
  assert.deepEqual(parseDraft(ceiling, ""), { ok: true, value: null });
  assert.deepEqual(parseDraft(ceiling, "   "), { ok: true, value: null }, "blank is blank, spaces and all");
  assert.deepEqual(parseDraft(ceiling, "0"), { ok: false, message: "Must be above zero. Leave it blank for no limit." });
  assert.deepEqual(parseDraft(ceiling, "0.0"), { ok: false, message: "Must be above zero. Leave it blank for no limit." });
  assert.deepEqual(parseDraft(ceiling, "-3"), { ok: false, message: "Enter a number, like 50." }, "a minus sign is not a plain number");
  assert.deepEqual(parseDraft(ceiling, "5o"), { ok: false, message: "Enter a number, like 50." }, "a fat-fingered letter is refused, never read as 5 or as blank");
  assert.deepEqual(parseDraft(ceiling, "1,000"), { ok: false, message: "Enter a number, like 50." });
  assert.deepEqual(parseDraft(ceiling, "1e3"), { ok: false, message: "Enter a number, like 50." });
  assert.deepEqual(parseDraft(ceiling, "Infinity"), { ok: false, message: "Enter a number, like 50." });
  assert.deepEqual(parseDraft(ceiling, "9".repeat(400)), { ok: false, message: "Enter a number, like 50." }, "too large to be a number at all");
  const price = specOf("defaultUsdPerMtok");
  assert.deepEqual(parseDraft(price, ""), { ok: false, message: "Required: a model with no price would be billed at nothing and never reach the ceiling." });
  assert.deepEqual(parseDraft(price, "0"), { ok: false, message: "Must be above zero." }, "no 'leave it blank' where blank is refused");
  assert.deepEqual(parseDraft(price, "2.5"), { ok: true, value: 2.5 });
});

test("counts and megabytes are whole numbers, which is stricter than the host and on purpose", () => {
  const turns = specOf("maxConcurrentTurns");
  const memory = specOf("projectMemoryMb");
  assert.deepEqual(parseDraft(turns, "4"), { ok: true, value: 4 });
  assert.deepEqual(parseDraft(turns, "2.5"), { ok: false, message: "Enter a whole number, like 4." });
  assert.deepEqual(parseDraft(turns, "4."), { ok: true, value: 4 }, "'4.' is the whole number four");
  assert.deepEqual(parseDraft(memory, "2048"), { ok: true, value: 2048 });
  assert.deepEqual(parseDraft(memory, "512.5"), { ok: false, message: "Enter a whole number, like 2048." });
  assert.deepEqual(parseDraft(memory, "abc"), { ok: false, message: "Enter a whole number, like 2048." });
  assert.deepEqual(parseDraft(memory, ""), { ok: true, value: null });
  // The host does take them, which is why this is the form's rule and not the host's.
  assert.deepEqual(validateHostConfigUpdate({ maxConcurrentTurns: 2.5 }).errors, []);
});

test("the form never sends a value the host's own validator refuses", () => {
  const samples = ["", " ", "0", "-1", "1", "5", "2.5", ".5", "5.", "abc", "5o", "1e3", "1,000", "0x10", "Infinity", "NaN", " 7 ", "007", "9".repeat(400)];
  for (const spec of FIELDS) {
    for (const raw of samples) {
      const parsed = parseDraft(spec, raw);
      if (!parsed.ok) continue;
      const { errors } = validateHostConfigUpdate({ [spec.field]: parsed.value });
      assert.deepEqual(errors, [], `${spec.field} ← ${JSON.stringify(raw)} parses to ${parsed.value} and the host refuses it`);
    }
  }
  // And the rule about blank is the host's: a blank is only ever saved as null where the host takes null.
  for (const spec of FIELDS) {
    const blank = parseDraft(spec, "");
    assert.equal(blank.ok, spec.nullable, spec.field);
    assert.equal(validateHostConfigUpdate({ [spec.field]: null }).errors.length === 0, spec.nullable, `the host agrees on ${spec.field}`);
  }
});

test("values read as the form's own sentences", () => {
  const ceiling = specOf("spendCeilingUsd");
  assert.equal(fmtValue(ceiling, 50), "$50");
  assert.equal(fmtValue(ceiling, 1234.5), "$1,234.5");
  assert.equal(fmtValue(ceiling, null), "no ceiling");
  assert.equal(fmtValue(specOf("maxConcurrentTurns"), null), "no cap");
  assert.equal(fmtValue(specOf("maxConcurrentTurns"), 4), "4");
  assert.equal(fmtValue(specOf("defaultUsdPerMtok"), 3), "$3 per million tokens");
  assert.equal(fmtValue(specOf("projectMemoryMb"), 2048), "2,048 MB");
  assert.equal(fmtValue(specOf("projectMemoryMb"), null), "no cap");
  assert.equal(draftOf(null), "");
  assert.equal(draftOf(12.5), "12.5");
});

test("raising or removing the ceiling is asked about, lowering it and setting the first one are not", () => {
  assert.equal(needsConfirm(50, 80), "raise");
  assert.equal(needsConfirm(50, null), "remove");
  assert.equal(needsConfirm(50, 20), null);
  assert.equal(needsConfirm(50, 50), null);
  assert.equal(needsConfirm(null, 20), null, "from no ceiling, any ceiling is lower");
  assert.equal(needsConfirm(null, null), null);
  // The host's own line, so a change there fails here.
  assert.match(read("apps", "mesh-server", "src", "host.ts"), /from !== null && \(to === null \|\| to > from\) && confirm !== true/);
});

test("saving changes only what differs, in the form's order, and says what each change will do", () => {
  const drafts: Drafts = { projectMemoryMb: "2048", spendCeilingUsd: "80", maxConcurrentTurns: "", defaultUsdPerMtok: "3.0" };
  const { changes, problems } = planSave(NOW, drafts, LIVE);
  assert.deepEqual(problems, []);
  assert.deepEqual(changes.map((c) => [c.field, c.from, c.to, c.confirm, c.restart]), [
    ["spendCeilingUsd", "$50", "$80", "raise", false],
    ["projectMemoryMb", "no cap", "2,048 MB", null, true],
  ]);
  assert.deepEqual(savePayload(changes), { spendCeilingUsd: 80, projectMemoryMb: 2048 }, "one request carries everything that changed");
  assert.deepEqual(planSave(NOW, {}, LIVE).changes, [], "nothing touched, nothing to save");
  assert.deepEqual(planSave(NOW, { spendCeilingUsd: "50" }, LIVE).changes, [], "typing back what is in force is not a change");
});

test("clearing the ceiling is a change that asks, and clearing something that was already blank is not", () => {
  const gone = planSave(NOW, { spendCeilingUsd: "  ", projectMemoryMb: "" }, LIVE);
  assert.deepEqual(gone.changes.map((c) => [c.field, c.to, c.value, c.confirm]), [["spendCeilingUsd", "no ceiling", null, "remove"]]);
  const lowered = planSave(NOW, { spendCeilingUsd: "10" }, LIVE);
  assert.equal(lowered.changes[0]!.confirm, null);
  const first = planSave({ ...NOW, spendCeilingUsd: null }, { spendCeilingUsd: "500" }, LIVE);
  assert.equal(first.changes[0]!.confirm, null);
  // Only the ceiling is ever asked about.
  const price = planSave(NOW, { defaultUsdPerMtok: "30" }, LIVE);
  assert.equal(price.changes[0]!.confirm, null);
});

test("what cannot be saved is a problem on its field, and a box left alone is never one", () => {
  const { changes, problems } = planSave(NOW, { spendCeilingUsd: "5o", defaultUsdPerMtok: "", maxConcurrentTurns: "2.5", projectMemoryMb: "4096" }, LIVE);
  assert.deepEqual(problems.map((p) => p.field), ["spendCeilingUsd", "maxConcurrentTurns", "defaultUsdPerMtok"].sort((a, b) => FIELDS.findIndex((f) => f.field === a) - FIELDS.findIndex((f) => f.field === b)));
  assert.deepEqual(changes.map((c) => c.field), ["projectMemoryMb"], "the valid edit is still listed; the form decides whether to hold it back");
  // A default price that is blank in the data would not parse, but a box that still holds exactly that is not an edit.
  assert.deepEqual(planSave({ ...NOW, defaultUsdPerMtok: null as unknown as number }, { defaultUsdPerMtok: "" }, LIVE).problems, []);
});

test("a setting the host does not call live is treated as needing a restart", () => {
  const { changes } = planSave(NOW, { projectMemoryMb: "512", maxConcurrentTurns: "6" }, { max_concurrent_turns: "live" });
  assert.deepEqual(changes.map((c) => [c.field, c.restart]), [["maxConcurrentTurns", false], ["projectMemoryMb", true]]);
  const unknown = planSave(NOW, { maxConcurrentTurns: "6" }, {});
  assert.equal(unknown.changes[0]!.restart, true, "an answer the host did not give must not read as 'applies now'");
});

test("the dialog says raise or remove, whichever is being done", () => {
  const raise = planSave(NOW, { spendCeilingUsd: "80" }, LIVE).changes[0]!;
  const remove = planSave(NOW, { spendCeilingUsd: "" }, LIVE).changes[0]!;
  const a = confirmCopy(raise);
  assert.deepEqual([a.title, a.confirmLabel], ["Raise the spend ceiling?", "Raise it"]);
  assert.match(a.body[0]!, /raises the ceiling from \$50 to \$80/);
  assert.match(a.body[2]!, /Raising the ceiling stops new parks/);
  const b = confirmCopy(remove);
  assert.deepEqual([b.title, b.confirmLabel], ["Remove the spend ceiling?", "Remove it"]);
  assert.match(b.body[0]!, /The ceiling is \$50\. Saving removes it/);
  assert.match(b.body[2]!, /Removing the ceiling stops new parks/);
  for (const text of [...a.body, ...b.body]) assert.ok(!/[!]/.test(text), "no exclamation marks");
});

test("the host's refusals land on the field they name, and the rest are said once", () => {
  const { byField, other } = serverProblems([
    "spend_ceiling_usd must be a positive number or null",
    "default_usd_per_mtok must be a positive number",
    "'colour' is not an editable host setting",
    "host.yaml is not valid YAML",
    "'project_memory_mb_extra' is not an editable host setting",
    "spend_ceiling_usd_x must be a positive number",
  ]);
  assert.deepEqual(byField.map((p) => p.field), ["spendCeilingUsd", "defaultUsdPerMtok"]);
  assert.equal(byField[0]!.message, "spend_ceiling_usd must be a positive number or null");
  assert.deepEqual(other, [
    "'colour' is not an editable host setting",
    "host.yaml is not valid YAML",
    "'project_memory_mb_extra' is not an editable host setting",
    "spend_ceiling_usd_x must be a positive number",
  ], "a message that only mentions a key, or names a longer one, is not that key's");
  // The names are the host's: a real refusal maps.
  const real = validateHostConfigUpdate({ spendCeilingUsd: -1, projectMemoryMb: 0 }).errors;
  assert.deepEqual(serverProblems(real).byField.map((p) => p.field), ["projectMemoryMb", "spendCeilingUsd"].sort((a, b) => real.findIndex((m) => m.startsWith(specOf(a as never).yaml)) - real.findIndex((m) => m.startsWith(specOf(b as never).yaml))));
  assert.deepEqual(serverProblems(real).other, []);
});

test("when a saved value lands is said once for the form, naming only the settings that differ", () => {
  const one = legend(LIVE);
  assert.deepEqual(one.restart, ["projectMemoryMb"]);
  assert.match(one.text, /^Every setting here applies as soon as you save, except Project memory: it is written to host\.yaml now and takes effect when the host restarts\./);
  assert.match(one.text, /This console cannot restart the host, so the command is shown after you save\.$/);
  const none = legend({ ...LIVE, project_memory_mb: "live" });
  assert.deepEqual(none.restart, []);
  assert.equal(none.text, "Every setting here applies as soon as you save: the host enforces it on that request and on every heartbeat after.");
  const two = legend({ ...LIVE, max_concurrent_turns: "host-restart" });
  assert.deepEqual(two.restart, ["maxConcurrentTurns", "projectMemoryMb"]);
  assert.match(two.text, /except Concurrent turns and Project memory: they are written/);
  assert.deepEqual(legend({}).restart, FIELDS.map((f) => f.field), "no answer from the host: every setting is held to the cautious reading");
});

test("a default is a quiet line under the box that says whether anyone set it", () => {
  assert.equal(defaultHint(specOf("spendCeilingUsd"), false), "Not set in host.yaml, so the built-in default is in force: $50.");
  assert.equal(defaultHint(specOf("spendCeilingUsd"), true), "Set in host.yaml. The built-in default is $50.");
  assert.equal(defaultHint(specOf("maxConcurrentTurns"), false), "Not set in host.yaml, so the built-in default is in force: no cap.");
  assert.equal(defaultHint(specOf("defaultUsdPerMtok"), true), "Set in host.yaml. The built-in default is $3 per million tokens.");
});

test("the restart commands are the ones the operations guide gives, and the host has no route that does it", () => {
  assert.deepEqual(RESTART_COMMANDS.map((r) => r.where), ["Docker Compose", "Kubernetes"]);
  const compose = read("docker-compose.yml");
  assert.match(compose, /^services:\s*\n\s+mesh:/m, "the Compose service is called mesh");
  assert.match(RESTART_COMMANDS[0]!.command, /^docker compose restart mesh$/);
  assert.match(read("docs", "commercial", "deployment.md"), /deployment\/mesh-curule/, "the Kubernetes deployment is named as in the deployment guide");
  assert.match(RESTART_COMMANDS[1]!.command, /rollout restart deployment\/mesh-curule$/);
  // No host-wide restart route: the only restart under /api is a project's own.
  const host = read("apps", "mesh-server", "src", "host.ts");
  const restarts = [...host.matchAll(/parts\[(\d)\] === "restart"/g)].map((m) => m[1]);
  assert.deepEqual(restarts, ["3"], "the one restart route is /api/projects/<id>/restart, a project's, not the host's");
});

test("the model prices the operator set are listed, with the cache prices only where they were set, and odd entries are shown rather than dropped", () => {
  assert.deepEqual(priceLines({}), { lines: [], more: 0 });
  assert.deepEqual(priceLines(null), { lines: [], more: 0 });
  const p = priceLines({
    "zeta-model": { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.2, cacheWritePerMtok: 2.5 },
    "alpha-model": { inputPerMtok: 0.5, outputPerMtok: 1.5 },
    "odd-model": "free",
  });
  assert.deepEqual(p.lines, [
    { model: "alpha-model", text: "$0.5 in, $1.5 out" },
    { model: "odd-model", text: "set in host.yaml, in a form this page cannot read" },
    { model: "zeta-model", text: "$2 in, $8 out, $0.2 cache read, $2.5 cache write" },
  ]);
  const many = priceLines(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`m${String(i).padStart(2, "0")}`, { inputPerMtok: 1, outputPerMtok: 2 }])));
  assert.equal(many.lines.length, 20);
  assert.equal(many.more, 5);
});
