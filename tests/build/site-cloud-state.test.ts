import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { SITE, loadScript } from "./site-pages";

/**
 * Which half of a page a visitor is shown (software you run, or Curule Cloud) is written into the markup by
 * scripts/site-cloud-state.mjs, so that the page a browser first paints already says it, and a page read with no script does too.
 * These cases hold the rule itself, on small pieces of markup: what it shows and hides, that it can be taken back exactly, and
 * that it touches nothing it was not asked to. That the committed pages are in the state their script says, and that the script
 * does the same thing in a browser, are in site-cloud.test.ts.
 */

interface Config {
  url: string;
  paths: Record<string, string>;
}
interface Module {
  cloudConfigOf(script: string): Config;
  cloudState(html: string, config: Config): string;
}

const load = (): Promise<Module> => loadScript<Module>("site-cloud-state.mjs");
const PATHS = { home: "/", login: "/login", signup: "/signup", terms: "/terms", privacy: "/privacy" };
const OPEN: Config = { url: "https://app.curule.dev", paths: PATHS };
const CLOSED: Config = { url: "", paths: PATHS };

/** A piece of a page as it is written while Curule Cloud is not open, in the shapes the pages use. */
const CLOSED_MARKUP = [
  '<a class="signin" href="#" data-cloud="login" hidden>Sign in</a>',
  '<a class="btn btn-primary" href="#" data-cloud="signup" hidden>Get started</a>',
  '<a class="btn btn-primary" href="#try" data-selfhost-only>Try the demo</a>',
  '<p class="lede" data-selfhost-only>Curule is software you run.</p>',
  '<p class="lede" data-cloud-only hidden>Curule is also run for you. <a href="#" data-cloud="home" hidden>Curule Cloud</a></p>',
  '<details data-cloud-only hidden><summary>Can you host it for us?</summary></details>',
  '<p class="plain">Nothing here depends on it.</p>',
].join("\n");

const OPEN_MARKUP = [
  '<a class="signin" href="https://app.curule.dev/login" data-cloud="login">Sign in</a>',
  '<a class="btn btn-primary" href="https://app.curule.dev/signup" data-cloud="signup">Get started</a>',
  '<a class="btn btn-primary" href="#try" data-selfhost-only hidden>Try the demo</a>',
  '<p class="lede" data-selfhost-only hidden>Curule is software you run.</p>',
  '<p class="lede" data-cloud-only>Curule is also run for you. <a href="https://app.curule.dev/" data-cloud="home">Curule Cloud</a></p>',
  '<details data-cloud-only><summary>Can you host it for us?</summary></details>',
  '<p class="plain">Nothing here depends on it.</p>',
].join("\n");

test("opening Curule Cloud shows what is for it, hides what says it is not there, and gives its links their addresses", async () => {
  const { cloudState } = await load();
  assert.equal(cloudState(CLOSED_MARKUP, OPEN), OPEN_MARKUP);
  assert.equal(cloudState(CLOSED_MARKUP, { url: "https://app.curule.dev///", paths: PATHS }), OPEN_MARKUP, "an address that ends in slashes gives the same links");
});

test("closing it again gives back exactly what was there, and either state applied twice is the state applied once", async () => {
  const { cloudState } = await load();
  assert.equal(cloudState(OPEN_MARKUP, CLOSED), CLOSED_MARKUP, "the way back is exact: no page is left a little different for having been opened");
  assert.equal(cloudState(cloudState(CLOSED_MARKUP, OPEN), OPEN), OPEN_MARKUP);
  assert.equal(cloudState(CLOSED_MARKUP, CLOSED), CLOSED_MARKUP, "a page that is already closed is not touched");
});

test("only the switched elements change: the words in text, comments, scripts and other attributes' values are not a switch", async () => {
  const { cloudState } = await load();
  const inert = [
    "<!-- <p data-cloud-only hidden>a comment about the switch</p> -->",
    '<p>The attribute data-cloud-only is what the pages call it. <code>data-selfhost-only</code></p>',
    '<img src="a.jpg" alt="shows data-cloud-only and data-selfhost-only in its words" title="a > b" width="1" height="1">',
    '<a href="#try" title="the hidden one, data-cloud">Try</a>',
    '<script type="application/json" id="plans-data">{"a":"<p data-cloud-only hidden>"}</script>',
  ].join("\n");
  for (const config of [OPEN, CLOSED]) assert.equal(cloudState(inert, config), inert);
  // A quoted value that holds a ">" does not end its tag early, so the attributes after it are still read.
  const tricky = '<a href="#" title="a > b" data-cloud="signup" hidden>Get started</a>';
  assert.equal(cloudState(tricky, OPEN), '<a href="https://app.curule.dev/signup" title="a > b" data-cloud="signup">Get started</a>');
});

test("a link of a kind the script does not know is left as it is, and `hidden` is taken off wherever it was written and put back last", async () => {
  const { cloudState } = await load();
  const unknown = '<a id="typo" href="#" data-cloud="sigin" hidden>Sign in</a>';
  assert.equal(cloudState(unknown, OPEN), unknown, "not shown, and given no address: the script leaves it too");
  const first = '<section hidden class="cta" data-cloud-only>Open a workspace</section>';
  assert.equal(cloudState(first, OPEN), '<section class="cta" data-cloud-only>Open a workspace</section>');
  assert.equal(cloudState('<section class="cta" data-cloud-only>Open a workspace</section>', CLOSED), '<section class="cta" data-cloud-only hidden>Open a workspace</section>');
  assert.equal(cloudState('<a href="#" data-cloud="login">Sign in</a>', CLOSED), '<a href="#" data-cloud="login" hidden>Sign in</a>', "a link with no address given gets none, and is hidden");
  assert.equal(cloudState('<a data-cloud="login" hidden>Sign in</a>', OPEN), '<a data-cloud="login" href="https://app.curule.dev/login">Sign in</a>', "and one with no href at all gets one");
});

test("the settings are read from the script: its address, and the page of the account pages each kind of link goes to", async () => {
  const { cloudConfigOf } = await load();
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  const real = cloudConfigOf(script);
  assert.deepEqual(real.paths, PATHS, "the kinds the pages use, and where each goes");
  assert.match(real.url, /^(|https:\/\/[^\s"]+)$/);
  assert.deepEqual(cloudConfigOf('var CLOUD_URL = "";\n'), { url: "", paths: {} }, "closed, there is nothing to point a link at, and nothing is asked for");
  assert.deepEqual(cloudConfigOf('var CLOUD_URL = "https://app.example.com"; // x\n  var CLOUD_PATH = { home: "/", signup: "/start" };'), { url: "https://app.example.com", paths: { home: "/", signup: "/start" } });
  assert.deepEqual(cloudConfigOf("// no setting at all\n"), { url: "", paths: {} }, "a script that has none is not open");
  assert.throws(() => cloudConfigOf('var CLOUD_URL = "https://app.example.com";\n'), /CLOUD_URL and no CLOUD_PATH/, "open, and nowhere to send a link");
});
