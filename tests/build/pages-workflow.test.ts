import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

/**
 * `.github/workflows/pages.yml` puts `site/` on the internet, and the page names a domain, an address and a company that are
 * the owner's to supply. What keeps a placeholder off the internet is that the workflow is started by hand, checks first, and
 * has nothing else able to start it. These cases pin that: a change that makes it run on a push, lets the check be skipped, or
 * hands it more than it needs fails here and not in a published page.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SOURCE = fs.readFileSync(path.join(ROOT, ".github", "workflows", "pages.yml"), "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "continue-on-error"?: boolean;
  with?: Record<string, string>;
  id?: string;
}
interface Workflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, { environment?: { name: string }; "continue-on-error"?: boolean; if?: string; steps: Step[] }>;
}
const workflow = parseYaml(SOURCE) as Workflow;
const job = workflow.jobs["publish"]!;

test("the site is published by hand: nothing but a manual run starts the workflow", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"], "not a push, a schedule, a pull request or a release");
  assert.deepEqual(Object.keys(workflow.jobs), ["publish"]);
});

test("it asks for what publishing a page takes and no more, and uses no secret", () => {
  assert.deepEqual(workflow.permissions, { contents: "read", pages: "write", "id-token": "write" });
  assert.ok(!/\bsecrets\./.test(SOURCE), "a static page needs no credential of the owner's");
  assert.equal(job.environment?.name, "github-pages");
  assert.equal(workflow.concurrency.group, "pages");
  assert.equal(workflow.concurrency["cancel-in-progress"], false, "a deployment that has started is finished, not cancelled by the next");
});

test("the check comes first and cannot be skipped, and only site/ is uploaded", () => {
  const steps = job.steps;
  const gate = steps.findIndex((s) => s.run?.trim() === "npm run site:check");
  const upload = steps.findIndex((s) => s.uses?.startsWith("actions/upload-pages-artifact@"));
  const deploy = steps.findIndex((s) => s.uses?.startsWith("actions/deploy-pages@"));
  assert.ok(gate >= 0 && upload >= 0 && deploy >= 0, "the check, the upload and the deployment are all there");
  assert.ok(gate < upload && upload < deploy, "check, then upload, then deploy");
  assert.equal(steps[gate]!["continue-on-error"], undefined, "a failed check stops the run");
  assert.equal(steps[gate]!.if, undefined, "and no condition lets it be skipped");
  assert.equal(job["continue-on-error"], undefined);
  assert.equal(job.if, undefined);
  assert.equal(steps[upload]!.with?.path, "site", "the page and its files, not the repository");
});

test("the check is the script's own: it fails while anything is marked and while a file is not written", () => {
  const scripts = (JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  assert.equal(scripts["site:check"], "node scripts/set-domain.mjs --check");
  assert.equal(scripts["site:domain"], "node scripts/set-domain.mjs");
  assert.ok(fs.existsSync(path.join(ROOT, "scripts", "set-domain.mjs")));
});

test("every action it runs is GitHub's own, pinned to a major version", () => {
  const uses = job.steps.map((s) => s.uses).filter((u): u is string => typeof u === "string");
  assert.ok(uses.length >= 4);
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@v\d+$/, `${u}: a third party's action would run with the right to publish the site`);
});
