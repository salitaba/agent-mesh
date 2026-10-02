/**
 * The product was called Agent Mesh before it was called Curule, and four of the names that changed are ones a running
 * deployment depends on. A rename that is only a search-and-replace costs an existing deployment its upgrade (a Helm
 * Deployment's selector cannot change) or the sight of its data (a Compose volume is named after the project). These
 * checks pin what keeps both from happening, and that the runbook and the changelog say so where an operator looks.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

/** The body of a named template in the chart's helpers. */
function template(name: string): string {
  const body = new RegExp(`\\{\\{-? define "${name}" -?\\}\\}([\\s\\S]*?)\\{\\{-? end \\}\\}`).exec(read("deploy/helm/curule/templates/_helpers.tpl"))?.[1];
  assert.ok(body, `the chart defines ${name}`);
  return body;
}

test("a release installed from the old chart can keep its selector and its object names with nameOverride", () => {
  assert.match(read("deploy/helm/curule/Chart.yaml"), /^name: curule$/m);

  // The selector (immutable on a live Deployment) is the chart's name, and the chart's name is what `nameOverride`
  // replaces. `--set nameOverride=agent-mesh` therefore reproduces the selector the old chart rendered.
  assert.match(template("curule.name"), /default \.Chart\.Name \.Values\.nameOverride/);
  assert.match(template("curule.selectorLabels"), /app\.kubernetes\.io\/name: \{\{ include "curule\.name" \. \}\}/);
  // The Deployment, the Service and the network policy select by those labels, and the volume claim is named by
  // the full name, which is built from the same override: the same release keeps the same claim.
  assert.match(template("curule.fullname"), /\$name := default \.Chart\.Name \.Values\.nameOverride/);
  for (const file of ["deployment.yaml", "service.yaml", "networkpolicy.yaml"]) {
    assert.match(read(`deploy/helm/curule/templates/${file}`), /include "curule\.selectorLabels"/, `${file} selects by the labels the override controls`);
  }
  assert.match(read("deploy/helm/curule/templates/pvc.yaml"), /name: \{\{ include "curule\.fullname" \. \}\}/);
  assert.match(read("deploy/helm/curule/values.yaml"), /^nameOverride: ""$/m, "and the knob exists");
});

test("a Compose deployment started under the old project name is told how to keep its volume", () => {
  const compose = read("docker-compose.yml");
  assert.match(compose, /^name: curule$/m);
  assert.match(compose, /COMPOSE_PROJECT_NAME=agent-mesh docker compose up -d/, "the file says how to stay in the old project");
  // The reason the note matters: the volume has no name of its own, so it is `<project>_mesh-data`.
  assert.match(compose, /^volumes:\n {2}mesh-data: \{\}$/m, "the volume is named after the project; if it gets a fixed name, this note is obsolete");
});

test("the image, the chart and the release workflow agree on the product's name, not the repository's", () => {
  const release = read(".github/workflows/release.yml");
  assert.match(release, /echo "image=\$\{REGISTRY\}\/\$\{GITHUB_REPOSITORY_OWNER,,\}\/curule"/, "the image is the owner's `curule`, whatever the repository is called");
  assert.ok(!/image=\$\{REGISTRY\}\/\$\{GITHUB_REPOSITORY,,\}/.test(release), "and is not derived from the repository's name");
  assert.match(release, /helm push "curule-\$\{version\}\.tgz"/, "the packaged chart is named after the chart");
  assert.match(release, /helm package deploy\/helm\/curule /);

  const repository = /^ {2}repository: (\S+)$/m.exec(read("deploy/helm/curule/values.yaml"))?.[1];
  assert.equal(repository, "ghcr.io/salitaba/curule", "the chart's default image");
  assert.match(read("docker-compose.yml"), /\$\{MESH_IMAGE:-ghcr\.io\/salitaba\/curule:latest\}/, "the Compose default is the same image");
});

test("the runbook and the changelog say what an upgrade across the rename needs", () => {
  const ops = read("docs/operations.md");
  const log = read("CHANGELOG.md");
  for (const [name, text] of [["docs/operations.md", ops], ["CHANGELOG.md", log]] as const) {
    assert.match(text, /--set nameOverride=agent-mesh/, `${name}: the Helm step`);
    assert.match(text, /COMPOSE_PROJECT_NAME=agent-mesh/, `${name}: the Compose step`);
    assert.match(text, /agent_mesh_\*/, `${name}: the metrics that were renamed`);
  }
  assert.match(ops, /^### Upgrading from a version named Agent Mesh$/m);
  assert.match(log, /\(docs\/operations\.md#upgrading-from-a-version-named-agent-mesh\)/, "the changelog links to it, and the anchor exists");
});
