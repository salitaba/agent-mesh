import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { faviconHref, faviconSvg, type FaviconKind } from "../../apps/mesh-dashboard/src/favicon";
import { DASHBOARD_CSP } from "../../apps/mesh-server/src/web-security";

/**
 * The tab icon is the one thing a person sees of a mission they are not looking at. These pin what it draws in each state, that
 * the states cannot be told apart by colour alone, and that the policy the host serves the console under lets it show.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
const KINDS: FaviconKind[] = ["plain", "needs-you", "delivered", "stopped"];
const BADGED: FaviconKind[] = ["needs-you", "delivered", "stopped"];

/** The drawing's elements that are not the ring and its seat: the badge, with its halo. */
const badgeOf = (svg: string): string => svg.slice(svg.indexOf("<circle class='seat'")).replace(/^<circle class='seat'[^>]*\/>/, "").replace(/<\/svg>$/, "");
/** The mark drawn inside the badge (the bar, the tick or the cross). */
const markOf = (svg: string): string => /<path class='mark' d='([^']+)'/.exec(svg)?.[1] ?? "";

test("the plain icon is the one index.html paints before any script has run", () => {
  const html = read("apps/mesh-dashboard/index.html");
  const href = /<link rel="icon" href="([^"]+)"/.exec(html)?.[1];
  assert.ok(href, "index.html names an icon");
  assert.equal(decodeURIComponent(href.replace(/^data:image\/svg\+xml,/, "")), faviconSvg("plain"));
});

test("every state draws the brand's ring and seat untouched, and a badge only where there is news", () => {
  const ring = "<path class='ink' d='M48.72 15.65A22 22 0 1 0 48.72 48.35' fill='none' stroke-width='9.2' stroke-linecap='round'/>";
  const seat = "<circle class='seat' cx='48.72' cy='15.65' r='8'/>";
  assert.ok(read("brand/favicon.svg").includes('d="M48.72 15.65A22 22 0 1 0 48.72 48.35"'), "the ring is the brand file's");
  for (const kind of KINDS) {
    const svg = faviconSvg(kind);
    assert.ok(svg.includes(ring) && svg.includes(seat), `${kind} keeps the ring and its seat`);
    assert.equal(badgeOf(svg) === "", kind === "plain", `${kind}: a badge exactly when there is something to tell`);
  }
});

test("the three badges differ in the mark inside them and in shape, so colour is never the only cue", () => {
  const marks = BADGED.map((k) => markOf(faviconSvg(k)));
  assert.equal(new Set(marks).size, 3, "a bar, a tick and a cross are three different drawings");
  const shape = (k: FaviconKind): string => (faviconSvg(k).includes("<rect class='bad'") ? "square" : "disc");
  assert.equal(shape("needs-you"), "disc");
  assert.equal(shape("delivered"), "disc");
  assert.equal(shape("stopped"), "square");
  // The two discs differ in colour as well as in mark; the stop differs from both in shape.
  assert.ok(faviconSvg("needs-you").includes("<circle class='bad'"));
  assert.ok(faviconSvg("delivered").includes("<circle class='ok'"));
});

test("a needs-you badge says so with a bar and a dot, a delivered one with a tick, a stopped one with a cross", () => {
  assert.match(faviconSvg("needs-you"), /class='mark' d='M46\.5 39\.5v7\.4'\/><circle class='dot'/);
  assert.match(faviconSvg("delivered"), /class='mark' d='M39\.8 46\.8l4\.7 4\.7 8\.9-9\.7'/);
  assert.match(faviconSvg("stopped"), /class='mark' d='M41 41l11 11M52 41l-11 11'/);
});

test("each icon is a well-formed document the browser can draw from a link", () => {
  for (const kind of KINDS) {
    const svg = faviconSvg(kind);
    const stack: string[] = [];
    for (const m of svg.matchAll(/<(\/?)([a-z]+)\b[^>]*?(\/?)>/g)) {
      const [, closing, tag, selfClosing] = m;
      if (selfClosing) continue;
      if (closing) assert.equal(stack.pop(), tag, `${kind}: </${tag}> closes what was opened`);
      else stack.push(tag!);
    }
    assert.deepEqual(stack, [], `${kind}: every tag is closed`);
    assert.match(svg, /^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' viewBox='0 0 64 64'>/);
    const href = faviconHref(kind);
    assert.ok(href.startsWith("data:image/svg+xml,"));
    assert.equal(decodeURIComponent(href.slice("data:image/svg+xml,".length)), svg);
    assert.ok(href.length < 3000, `${kind}: a favicon stays small (${href.length} characters)`);
  }
});

test("the badge colours are the console's own status colours, light and dark, so they move with its palette", () => {
  const css = read("apps/mesh-dashboard/src/styles.css");
  const root = css.slice(css.indexOf(":root {"), css.indexOf("[data-theme=\"light\"] {"));
  const light = css.slice(css.indexOf("[data-theme=\"light\"] {"), css.indexOf("* { box-sizing"));
  const token = (block: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)?.[1]?.toLowerCase() ?? "";
  const svg = faviconSvg("needs-you");
  const [lightRules, darkRules] = [svg.slice(svg.indexOf("<style>"), svg.indexOf("@media")), svg.slice(svg.indexOf("@media"), svg.indexOf("</style>"))];
  assert.ok(lightRules.includes(`.bad{fill:${token(light, "--bad")}}`), "light red is --bad");
  assert.ok(lightRules.includes(`.ok{fill:${token(light, "--ok")}}`), "light green is --ok");
  assert.ok(lightRules.includes(`stroke:${token(light, "--text-on-hot")}`), "light mark is the text laid over a hot fill");
  assert.ok(darkRules.includes(`.bad{fill:${token(root, "--bad")}}`), "dark red is --bad");
  assert.ok(darkRules.includes(`.ok{fill:${token(root, "--ok")}}`), "dark green is --ok");
  assert.ok(darkRules.includes(`.mark{stroke:${token(root, "--text-on-hot")}}`), "dark mark is the text laid over a hot fill");
});

test("the host serves the console under a policy that admits a data: icon", () => {
  const img = DASHBOARD_CSP.split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));
  assert.ok(img, "the policy names img-src");
  assert.ok(img.split(/\s+/).includes("data:"), `img-src admits data: (${img}); if it is tightened, ship the icons as same-origin files instead`);
});
