#!/usr/bin/env node
/**
 * ux-render — render a page in a real browser and describe it in text.
 *
 * The crew of a mesh is made of language models: they write CSS as text and, before this existed, they
 * asserted it as text, because nothing in the workspace could paint a pixel and none of them can look at
 * an image anyway. So the useful artefact is not the PNG (this writes one, for a human) but the measured
 * description of the page *after layout*: the box of every element, the type it ended up with, the
 * colours and their contrast ratios, the tap targets, the overflow, and a census of the type and space a
 * page is actually made of.
 *
 * Usage:
 *   ux-render --file public/index.html [--width 390] [--json]
 *   ux-render --url http://127.0.0.1:3000/ [--scheme dark] [--out /tmp/shots]
 *
 * What it writes:
 *   - a PNG screenshot (path printed in the report, never inlined), and
 *   - the report on stdout: a compact human summary, or `--json` for the whole measurement.
 *
 * Exit codes: 0 nothing failed, 1 a measured row failed (a tap target under 44×44, a page that scrolls
 * sideways, a text or boundary pair under its WCAG floor), 2 it could not render the page at all.
 *
 * This file is the thin part: it drives the browser and hands the measurements to `@mesh/ux-report`,
 * where every check lives as a pure function with unit tests. The image build smoke-tests this driver so
 * a workspace image that cannot render is caught at build time instead of by a designer.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE = `ux-render — render a page and print a measured, textual report of it

  --file <path>        an HTML file to render
  --url <url>          a page to fetch and render
  --width <px>         viewport width (default 390)
  --height <px>        viewport height (default 844, or 900 above 500px wide)
  --scheme <s>         light | dark — the prefers-color-scheme the page sees (default light)
  --out <dir>          where to write the PNG (default $TMPDIR/curule-ux-render)
  --settle <ms>        how long to let the page settle after load (default 400)
  --max-nodes <n>      stop after this many elements (default 4000)
  --chrome <path>      the browser executable (default: playwright's chromium, or $CHROME)
  --sandbox            keep the browser sandbox on (off by default: a workspace container has no user namespaces)
  --json               print the whole measurement as JSON instead of the report
  --quiet              print only the one-line verdict
  -h, --help           this
`;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("help") || process.argv.length <= 2) {
  console.log(USAGE);
  process.exit(process.argv.length <= 2 ? 2 : 0);
}

const width = Number(arg("width", "390"));
const height = Number(arg("height", width < 500 ? "844" : "900"));
const scheme = arg("scheme", "light");
const settle = Number(arg("settle", "400"));
const maxNodes = Number(arg("max-nodes", "4000"));
const outDir = resolve(arg("out", join(tmpdir(), "curule-ux-render")));
const json = flag("json");
const quiet = flag("quiet");
const file = arg("file", "");
const url = arg("url", "");

if (!file && !url) {
  console.error("ux-render: pass --file <path> or --url <url>\n");
  console.error(USAGE);
  process.exit(2);
}
if (!Number.isFinite(width) || width < 1 || !Number.isFinite(height) || height < 1) {
  console.error("ux-render: --width and --height must be positive numbers");
  process.exit(2);
}
if (scheme !== "light" && scheme !== "dark") {
  console.error("ux-render: --scheme takes light or dark");
  process.exit(2);
}

const target = url || pathToFileURL(resolve(file)).href;
const source = file ? `file ${resolve(file)}` : `url ${url}`;

/** The published package, compiled: this tool is the only part that needs a browser. */
let report;
try {
  report = await import(new URL("../dist/packages/ux-report/src/index.js", import.meta.url));
} catch (cause) {
  console.error(`ux-render: cannot load the report module (${cause.message}). Run \`npm run build\` first.`);
  process.exit(2);
}

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("ux-render: playwright-core is not installed. It ships with the workspace image; on a checkout run `npm install`.");
  process.exit(2);
}

/* ------------------------------------------------------------------ the collector */

/**
 * Runs *inside the page*, after layout. It answers the questions a stylesheet cannot: what the browser
 * computed, where everything ended up, and what is behind it. It returns plain data — the whole judgement
 * happens in Node, in the tested package.
 */
function collectInPage(limit) {
  const round = (n) => Math.round(n * 100) / 100;
  const px = (value) => {
    const n = parseFloat(value);
    return Number.isFinite(n) ? round(n) : 0;
  };
  const edges = (cs, kind) => ({ top: px(cs[`${kind}Top`]), right: px(cs[`${kind}Right`]), bottom: px(cs[`${kind}Bottom`]), left: px(cs[`${kind}Left`]) });
  const parse = (value) => {
    const text = String(value || "").trim().toLowerCase();
    if (!text || text === "transparent") return null;
    const fn = /^rgba?\(([^)]*)\)$/.exec(text);
    if (fn) {
      const parts = fn[1].split(/[,\s/]+/).filter(Boolean);
      if (parts.length < 3) return null;
      const chan = (t) => (t.endsWith("%") ? Math.round((parseFloat(t) / 100) * 255) : Math.round(parseFloat(t)));
      return { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]), a: parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]) };
    }
    if (text.startsWith("#")) {
      const h = text.slice(1);
      const hex = (s) => parseInt(s, 16);
      if (h.length === 3 || h.length === 4) return { r: hex(h[0] + h[0]), g: hex(h[1] + h[1]), b: hex(h[2] + h[2]), a: h.length === 4 ? hex(h[3] + h[3]) / 255 : 1 };
      if (h.length === 6 || h.length === 8) return { r: hex(h.slice(0, 2)), g: hex(h.slice(2, 4)), b: hex(h.slice(4, 6)), a: h.length === 8 ? hex(h.slice(6, 8)) / 255 : 1 };
    }
    return null;
  };
  const over = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  /** What a background stack resolves to: this element's own over its ancestors' over the page's white. */
  const behind = (from) => {
    const stack = [];
    for (let node = from; node && node.nodeType === 1; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) stack.push(c);
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return `rgb(${Math.round(base.r)}, ${Math.round(base.g)}, ${Math.round(base.b)})`;
  };
  const seg = (el) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + (el.classList.length ? `.${el.classList[0]}` : "");
  const pathOf = (el) => {
    const parts = [];
    for (let node = el, depth = 0; node && node.nodeType === 1 && node !== document.documentElement && depth < 3; node = node.parentElement, depth++) parts.unshift(seg(node));
    return parts.join(" > ");
  };
  const ownText = (el) => {
    let text = "";
    for (const child of el.childNodes) if (child.nodeType === 3) text += child.nodeValue;
    return text.replace(/\s+/g, " ").trim().slice(0, 80);
  };
  const IMPLICIT = {
    a: (el) => (el.hasAttribute("href") ? "link" : ""),
    button: () => "button",
    summary: () => "button",
    select: () => "combobox",
    textarea: () => "textbox",
    nav: () => "navigation",
    main: () => "main",
    header: () => "banner",
    footer: () => "contentinfo",
    aside: () => "complementary",
    form: () => "form",
    table: () => "table",
    ul: () => "list",
    ol: () => "list",
    li: () => "listitem",
    h1: () => "heading",
    h2: () => "heading",
    h3: () => "heading",
    img: (el) => (el.getAttribute("alt") === "" ? "presentation" : "img"),
    input: (el) => ({ checkbox: "checkbox", radio: "radio", range: "slider", submit: "button", button: "button", reset: "button" })[el.type] || "textbox",
  };
  const CONTROLS = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=switch], [tabindex]:not([tabindex='-1'])";
  const SKIP = new Set(["script", "style", "noscript", "template", "meta", "link", "title", "head", "html"]);

  /** The nearest ancestor that decides what happens to content wider than itself. */
  const scrollAncestor = (el) => {
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const ox = getComputedStyle(node).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return ox;
    }
    return undefined;
  };

  const nodes = [];
  let truncatedAt;
  for (const el of document.querySelectorAll("*")) {
    if (SKIP.has(el.tagName.toLowerCase())) continue;
    if (nodes.length >= limit) {
      truncatedAt = limit;
      break;
    }
    if (el.getClientRects().length === 0) continue; // not rendered: display:none, a detached subtree, a collapsed box
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.opacity === "0") continue;

    const rect = el.getBoundingClientRect();
    const fontSize = px(cs.fontSize);
    const role = el.getAttribute("role") || (IMPLICIT[el.tagName.toLowerCase()] ? IMPLICIT[el.tagName.toLowerCase()](el) : "");
    const interactive = el.matches(CONTROLS) && !el.disabled && el.getAttribute("aria-hidden") !== "true";
    const text = ownText(el);
    const name = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || el.getAttribute("title") || text;

    const borders = [];
    for (const side of ["Top", "Right", "Bottom", "Left"]) {
      const w = px(cs[`border${side}Width`]);
      const style = cs[`border${side}Style`];
      if (w > 0 && style !== "none" && style !== "hidden") borders.push({ side: side.toLowerCase(), width: w, style, color: cs[`border${side}Color`] });
    }

    // The page is scrolled to the top before this runs, so `left` is already the distance from the
    // viewport's left edge (does it fit?) and `top` is turned into the document's (where is it?).
    const inProse = /^inline/.test(cs.display) && el.parentElement && [...el.parentElement.childNodes].some((child) => child.nodeType === 3 && child.nodeValue.trim().length > 0);

    const node = {
      path: pathOf(el),
      tag: el.tagName.toLowerCase(),
      role: role || undefined,
      name: name ? name.replace(/\s+/g, " ").trim().slice(0, 60) : undefined,
      box: { x: round(rect.left), y: round(rect.top + window.scrollY), width: round(rect.width), height: round(rect.height) },
      fontFamily: cs.fontFamily,
      fontSize,
      fontWeight: parseInt(cs.fontWeight, 10) || 400,
      lineHeight: cs.lineHeight === "normal" ? round(fontSize * 1.2) : px(cs.lineHeight),
      color: cs.color,
      background: cs.backgroundColor,
      backgroundBehind: behind(el),
      backgroundOutside: behind(el.parentElement),
      radius: { topLeft: px(cs.borderTopLeftRadius), topRight: px(cs.borderTopRightRadius), bottomRight: px(cs.borderBottomRightRadius), bottomLeft: px(cs.borderBottomLeftRadius) },
      padding: edges(cs, "padding"),
      margin: edges(cs, "margin"),
      borders,
      text: text || undefined,
      interactive,
      inProse: interactive && inProse ? true : undefined,
      scrollAncestor: scrollAncestor(el),
      focusRing: null,
    };

    // Last, because focusing changes the computed style of the element it lands on.
    if (interactive) {
      try {
        el.focus({ preventScroll: true });
        const fcs = getComputedStyle(el);
        const ow = px(fcs.outlineWidth);
        if (fcs.outlineStyle !== "none" && ow > 0) node.focusRing = { width: ow, color: fcs.outlineColor, from: "outline" };
        else if (fcs.boxShadow && fcs.boxShadow !== "none") node.focusRing = { width: 0, color: "", from: "box-shadow" };
      } catch {
        /* an element that refuses focus is reported as having no ring */
      }
    }
    nodes.push(node);
  }
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();

  const main = document.querySelector("main[aria-label], [role=main][aria-label], main, [role=main]");
  const heading = document.querySelector("h1");
  return {
    url: location.href,
    title: document.title || "",
    part: (main && (main.getAttribute("aria-label") || "")) || (heading ? heading.textContent.replace(/\s+/g, " ").trim().slice(0, 80) : ""),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    nodes,
    truncatedAt,
  };
}

/* ------------------------------------------------------------------- render it */

let browser;
try {
  browser = await chromium.launch({
    ...(arg("chrome", process.env.CHROME ?? "") ? { executablePath: arg("chrome", process.env.CHROME ?? "") } : {}),
    args: flag("sandbox") ? [] : ["--no-sandbox", "--disable-dev-shm-usage"],
  });
} catch (cause) {
  console.error(`ux-render: could not start a browser (${cause.message.split("\n")[0]}).`);
  console.error("ux-render: a workspace image ships Chromium; on a checkout run `npx playwright-core install --with-deps chromium`.");
  process.exit(2);
}

const errors = [];
try {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion: "reduce" });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`uncaught: ${e.message.split("\n")[0].slice(0, 160)}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 160)}`);
  });
  page.on("requestfailed", (r) => errors.push(`request failed: ${r.url().slice(0, 120)}`));

  await page.goto(target, { waitUntil: "load", timeout: 30_000 });
  if (settle > 0) await page.waitForTimeout(settle);
  await page.evaluate(() => window.scrollTo(0, 0));

  const snapshot = await page.evaluate(collectInPage, maxNodes);
  snapshot.errors = [...new Set(errors)].slice(0, 20);

  mkdirSync(outDir, { recursive: true });
  const slug = (snapshot.part || snapshot.title || "page").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "page";
  const screenshot = join(outDir, `${slug}-${width}x${height}-${scheme}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });

  const measured = report.analyze(snapshot, { source, scheme, screenshot });
  if (json) console.log(JSON.stringify(measured, null, 2));
  else if (quiet) console.log(report.renderSummary(measured));
  else console.log(report.renderReport(measured));
  process.exitCode = measured.failures.length > 0 ? 1 : 0;
} catch (cause) {
  console.error(`ux-render: ${cause.message.split("\n")[0]}`);
  process.exitCode = 2;
} finally {
  await browser.close();
}
