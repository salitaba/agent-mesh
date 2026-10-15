/**
 * The wiring around the measurement: a browser in the workspace image, the tool on the path the seats
 * run commands from, the fixtures the image build smoke-tests, and the three role prompts that tell the
 * crew to use it.
 *
 * Each of these is one deletion away from silence. A designer told to review a rendered page, with no
 * browser in the image, is a designer who goes back to asserting CSS as text — which is the whole of the
 * failure this exists to fix.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
const exists = (file: string): boolean => fs.existsSync(path.join(ROOT, file));

test("the tool is a command, not a library: shebang, executable, and it loads the compiled checks", () => {
  const tool = read("tools/ux-render.mjs");
  assert.match(tool, /^#!\/usr\/bin\/env node\n/, "it runs as `ux-render`, so it starts with a shebang");
  assert.ok((fs.statSync(path.join(ROOT, "tools/ux-render.mjs")).mode & 0o111) !== 0, "and it is executable in git");
  assert.match(tool, /import\(new URL\("\.\.\/dist\/packages\/ux-report\/src\/index\.js", import\.meta\.url\)\)/, "the driver imports the tested package, so the checks have one implementation");
  assert.match(tool, /--url/, "it renders a served page");
  assert.match(tool, /--file/, "and a file on disk, which is what a developer has");
  assert.match(tool, /--json/, "it answers a machine as well as a reader");
  assert.match(tool, /process\.exitCode = measured\.failures\.length > 0 \? 1 : 0/, "and it fails the run on a failed row");
});

test("the driver stays thin: it collects, and the package decides", () => {
  const tool = read("tools/ux-render.mjs");
  assert.match(tool, /await page\.evaluate\(collectInPage, maxNodes\)/, "one pass over the page, after layout");
  assert.doesNotMatch(tool, /contrastRatio|relativeLuminance|textContrastFloor/, "the maths is not re-implemented here");
  assert.match(tool, /page\.screenshot\(\{ path: screenshot, fullPage: true \}\)/, "a PNG is written for a human");
  assert.doesNotMatch(tool, /toString\("base64"\)|data:image/, "and never inlined into the text a seat reads");
});

test("the workspace image carries a browser, and it is the crew's uid that can run it", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /^ENV PLAYWRIGHT_BROWSERS_PATH=\/opt\/ms-playwright$/m, "the browsers live outside HOME, which is the customer's volume");
  assert.match(dockerfile, /playwright-core\/cli\.js" install --with-deps chromium/, "chromium and its system libraries are installed from the pinned playwright-core");
  assert.match(dockerfile, /^COPY tools \.\/tools$/m, "the build stage takes the tool in");
  assert.match(dockerfile, /^COPY --from=build \/src\/tools \.\/tools$/m, "and the image the customer runs carries it");
  assert.match(dockerfile, /ln -s \/app\/tools\/ux-render\.mjs \/usr\/local\/bin\/ux-render/, "so a seat in a workspace can run `ux-render` from anywhere");
  // The smoke test has to run as the unprivileged uid, or it proves nothing about the seat that uses it.
  const smoke = dockerfile.indexOf("ux-render --file /app/tools/fixtures/ux-good.html");
  const user = dockerfile.indexOf("\nUSER mesh\n");
  assert.ok(smoke > user && user > 0, "the smoke test runs after `USER mesh`");
});

test("the image build renders a page that must pass and one that must fail", () => {
  const dockerfile = read("Dockerfile");
  assert.match(dockerfile, /ux-render --file \/app\/tools\/fixtures\/ux-good\.html --width 390 --quiet/, "a workspace image that cannot render is caught at build time, not by a designer");
  assert.match(dockerfile, /ux-render --file \/app\/tools\/fixtures\/ux-bad\.html --width 390 --quiet; test \$\? -eq 1/, "and a check that stopped finding a bad page fails the build too");
  for (const file of ["tools/fixtures/ux-good.html", "tools/fixtures/ux-bad.html"]) assert.ok(exists(file), `${file} is the page the build renders`);
});

test("playwright-core is a production dependency, because the image installs it with the product", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies["playwright-core"] ?? "", /^\^\d+\.\d+\.\d+$/, "pinned, so the browser the image installs matches the driver that uses it");
  const notices = read("THIRD_PARTY_NOTICES.md");
  assert.match(notices, /\| playwright-core \| /, "and it is in the inventory of what ships");
});

test("the three roles that decide what the interface looks like are told to render it", () => {
  for (const role of ["ui-designer", "ux-designer", "developer"]) {
    const prompt = read(`roles/${role}.md`);
    assert.match(prompt, /ux-render/, `${role} is told about the tool`);
    assert.match(prompt, /--file|--url/, `${role} is told how to call it`);
  }
  const ui = read("roles/ui-designer.md");
  assert.match(ui, /visual direction/, "the ui-designer states a direction before building against it");
  assert.match(ui, /hierarchy .*(size, weight|size, weight and space)/i, "and hierarchy is expressed in size, weight and space");
  assert.match(ui, /rejection|reject/i, "a rendered page that contradicts the direction is a rejection");
  const developer = read("roles/developer.md");
  assert.match(developer, /before (you )?(claim|ask)|before claiming/i, "a developer runs it before claiming the work is done");
});

test("a new mesh inherits one visual direction, and the crew designer says so", () => {
  const server = read("apps/mesh-server/src/index.ts");
  assert.match(server, /one visual direction/i);
  assert.match(server, /gradients/, "the default rules the direction forbids");
  assert.match(server, /accent hue/, "one accent hue");
  assert.match(server, /override/i, "and it is a default a user can override, not a house style");
});
