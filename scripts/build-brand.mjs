#!/usr/bin/env node
/*
 * Writes the Ordane brand files from one description of the mark: brand/*.svg, brand/tokens.css and the HTML the
 * social card is rendered from.
 *
 *   node scripts/build-brand.mjs            write the files
 *   node scripts/build-brand.mjs --check    write nothing; exit 1 if a checked-in file differs (npm run brand:check)
 *   node scripts/build-brand.mjs --png      also rasterise brand/apple-touch-icon.png, icon-512.png and social-card.png
 *                                           with headless Chrome or Chromium (CHROME=/path/to/chrome, else one on PATH)
 *
 * Every variant of the logo is derived here, so none can be edited by hand and left disagreeing with the others.
 * The PNGs are not byte-reproducible across Chrome versions and are not checked for drift; tests/build/brand-assets.test.ts
 * checks that they exist and have the sizes the pages promise.
 *
 * The mark is a ring (the organisation) with one seat filled (the bead on its rim): "ordain" is to appoint someone to
 * a role. The wordmark is lowercase, monoline and geometric, drawn as strokes with round caps; its first "o" is the
 * mark, so the name and the sign are one thing. The letters are paths, so the logo does not depend on a font.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { WebSocket } from "undici";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "brand");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const PNG = args.includes("--png");

// ------------------------------------------------------------------------------------------------ the palette
// The site's own `:root` and `.brand` colours are these values (tests/build/brand-assets.test.ts keeps them equal).
export const PALETTE = {
  light: { paper: "#fbfaf8", panel: "#ffffff", ink: "#1c1b1a", muted: "#5d5a55", line: "#e4e0d9", blue: "#2b5fd9", onBlue: "#ffffff" },
  dark: { paper: "#131211", panel: "#1b1a18", ink: "#efece6", muted: "#aaa59c", line: "#302e2a", blue: "#7ba0ff", onBlue: "#0e1220" },
};
export const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
export const TAGLINE = "A team of AI agents, run like an organization.";
export const SUBLINE = "Roles, authority and an audit trail, enforced by the runtime.";

const n = (x) => String(Math.round(x * 100) / 100);

// ------------------------------------------------------------------------------------------------ the mark
// A 64 x 64 box. The ring's outer edge is 5.4 from each side, which is what a favicon wants.
const MARK = { box: 64, c: 32, r: 22, stroke: 9.2, bead: 8, at: -45 };

function onCircle(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function markParts(colors) {
  const [bx, by] = onCircle(MARK.c, MARK.c, MARK.r, MARK.at);
  return (
    `<circle ${colors.ring} cx="${MARK.c}" cy="${MARK.c}" r="${MARK.r}" fill="none" stroke-width="${MARK.stroke}"/>` +
    `<circle ${colors.seat} cx="${n(bx)}" cy="${n(by)}" r="${MARK.bead}"/>`
  );
}

// ------------------------------------------------------------------------------------------------ the wordmark
// Letters are drawn on an x-height band 40 tall (outer edge to outer edge), 60 from ascender to baseline.
const T = { s: 7, r: 16.5, xTop: 20, xMid: 40, xBot: 60, asc: 0, bead: 6, at: -45 };
const TOP = T.xTop + T.s / 2;
const BOT = T.xBot - T.s / 2;
const ASC = T.asc + T.s / 2;
// Space between letters, outer edge to outer edge, tuned by eye: stem to stem needs more than round to stem.
const GAPS = { or: 8, rd: 5, da: 7, an: 10, ne: 7 };

function bowl(cx) {
  const { r, xMid } = T;
  return `M${n(cx - r)} ${xMid}A${r} ${r} 0 1 1 ${n(cx + r)} ${xMid}A${r} ${r} 0 1 1 ${n(cx - r)} ${xMid}Z`;
}

const LETTERS = {
  r: (x) => {
    const a = x + T.s / 2;
    return { d: `M${n(a)} ${BOT}V${TOP}M${n(a)} ${T.xMid}A${T.r} ${T.r} 0 0 1 ${n(a + T.r)} ${TOP}`, end: a + T.r + T.s / 2 };
  },
  d: (x) => {
    const cx = x + T.s / 2 + T.r;
    return { d: `${bowl(cx)}M${n(cx + T.r)} ${ASC}V${BOT}`, end: cx + T.r + T.s / 2 };
  },
  a: (x) => {
    const cx = x + T.s / 2 + T.r;
    return { d: `${bowl(cx)}M${n(cx + T.r)} ${TOP}V${BOT}`, end: cx + T.r + T.s / 2 };
  },
  n: (x) => {
    const a = x + T.s / 2;
    return { d: `M${n(a)} ${BOT}V${TOP}M${n(a)} ${T.xMid}A${T.r} ${T.r} 0 0 1 ${n(a + 2 * T.r)} ${T.xMid}V${BOT}`, end: a + 2 * T.r + T.s / 2 };
  },
  e: (x) => {
    const cx = x + T.s / 2 + T.r;
    const t = (42 * Math.PI) / 180;
    return {
      d: `M${n(cx - T.r)} ${T.xMid}H${n(cx + T.r)}A${T.r} ${T.r} 0 1 0 ${n(cx + T.r * Math.cos(t))} ${n(T.xMid + T.r * Math.sin(t))}`,
      end: cx + T.r + T.s / 2,
    };
  },
};

function wordmarkGeometry() {
  // The first "o" is the mark: a ring with a bead on its rim.
  const cx = T.s / 2 + T.r;
  const [bx, by] = onCircle(cx, T.xMid, T.r, T.at);
  let x = cx + T.r + T.s / 2;
  let d = "";
  let prev = "o";
  for (const ch of "rdane") {
    x += GAPS[prev + ch];
    const letter = LETTERS[ch](x);
    d += letter.d;
    x = letter.end;
    prev = ch;
  }
  return { width: x, ring: { cx, cy: T.xMid, r: T.r }, bead: [bx, by, T.bead], d };
}

function wordmarkParts(colors) {
  const g = wordmarkGeometry();
  return {
    width: g.width,
    body:
      `<circle ${colors.ring} cx="${n(g.ring.cx)}" cy="${g.ring.cy}" r="${g.ring.r}" fill="none" stroke-width="${T.s}"/>` +
      `<circle ${colors.seat} cx="${n(g.bead[0])}" cy="${n(g.bead[1])}" r="${g.bead[2]}"/>` +
      `<path ${colors.ring} d="${g.d}" fill="none" stroke-width="${T.s}" stroke-linecap="round" stroke-linejoin="round"/>`,
  };
}

// ------------------------------------------------------------------------------------------------ colour schemes
const fixed = (p) => ({ ring: `stroke="${p.ink}"`, seat: `fill="${p.blue}"` });
const SCHEMES = {
  adaptive: { colors: { ring: 'class="ink"', seat: 'class="seat"' }, style: true },
  light: { colors: fixed(PALETTE.light) },
  dark: { colors: fixed(PALETTE.dark) },
  mono: { colors: { ring: 'stroke="currentColor"', seat: 'fill="currentColor"' } },
};

const ADAPTIVE_STYLE =
  `<style>.ink{stroke:${PALETTE.light.ink}}.seat{fill:${PALETTE.light.blue}}` +
  `@media (prefers-color-scheme:dark){.ink{stroke:${PALETTE.dark.ink}}.seat{fill:${PALETTE.dark.blue}}}</style>`;

function svg({ viewBox, body, scheme, label = "Ordane", extra = "" }) {
  const s = SCHEMES[scheme];
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" role="img" aria-label="${label}"${extra}>` +
    `<title>${label}</title>${s.style ? ADAPTIVE_STYLE : ""}${body}</svg>\n`
  );
}

function markFile(scheme) {
  return svg({ viewBox: `0 0 ${MARK.box} ${MARK.box}`, body: markParts(SCHEMES[scheme].colors), scheme });
}

function logoFile(scheme) {
  const { width, body } = wordmarkParts(SCHEMES[scheme].colors);
  return svg({ viewBox: `0 0 ${n(width)} 60`, body, scheme });
}

/** The mark on an ink tile, the source of the app icons. Square and full-bleed: the platform rounds it. */
function appIconFile() {
  const s = 0.62;
  const colors = { ring: `stroke="${PALETTE.dark.ink}"`, seat: `fill="${PALETTE.dark.blue}"` };
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Ordane">` +
    `<title>Ordane</title><rect width="64" height="64" fill="${PALETTE.light.ink}"/>` +
    `<g transform="translate(32 32) scale(${s}) translate(-32 -32)">${markParts(colors)}</g></svg>\n`
  );
}

// ------------------------------------------------------------------------------------------------ the tokens
function tokensFile() {
  const vars = (p) =>
    [
      `--ordane-paper: ${p.paper};`,
      `--ordane-panel: ${p.panel};`,
      `--ordane-ink: ${p.ink};`,
      `--ordane-muted: ${p.muted};`,
      `--ordane-line: ${p.line};`,
      `--ordane-blue: ${p.blue};`,
      `--ordane-on-blue: ${p.onBlue};`,
    ].map((l) => `  ${l}`).join("\n");
  return `/* Ordane brand tokens. Generated by scripts/build-brand.mjs: change the script, not this file.
   Light is the default; the system's dark preference switches it, and an explicit data-theme wins over both. */
:root {
${vars(PALETTE.light)}
  --ordane-font: ${FONT};
  --ordane-mono: ${MONO};
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${vars(PALETTE.dark).replace(/^ {2}/gm, "    ")}
  }
}
:root[data-theme="dark"] {
${vars(PALETTE.dark)}
}
`;
}

// ------------------------------------------------------------------------------------------------ the social card
function cardHtml() {
  const { width, body } = wordmarkParts(SCHEMES.light.colors);
  const logoH = 118;
  const logoW = Math.round((logoH * width) / 60);
  const [bx, by] = onCircle(MARK.c, MARK.c, MARK.r, MARK.at);
  const p = PALETTE.light;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ordane</title>
<style>
html,body{margin:0;padding:0}
body{width:1200px;height:630px;position:relative;overflow:hidden;background:${p.paper};color:${p.ink};font-family:"Liberation Sans","Helvetica Neue",Arial,system-ui,sans-serif}
.sign{position:absolute;left:560px;top:-35px;width:700px;height:700px}
.logo{position:absolute;left:84px;top:150px;width:${logoW}px;height:${logoH}px}
h1{position:absolute;left:84px;top:332px;margin:0;width:760px;font-size:56px;line-height:1.1;font-weight:700;letter-spacing:-.02em}
p{position:absolute;left:84px;top:500px;margin:0;width:760px;font-size:28px;line-height:1.35;color:${p.muted}}
</style></head><body>
<svg class="sign" viewBox="0 0 ${MARK.box} ${MARK.box}" aria-hidden="true"><circle cx="${MARK.c}" cy="${MARK.c}" r="${MARK.r}" fill="none" stroke="#efebe3" stroke-width="${MARK.stroke}"/><circle cx="${n(bx)}" cy="${n(by)}" r="${MARK.bead}" fill="${p.blue}"/></svg>
<svg class="logo" viewBox="0 0 ${n(width)} 60" role="img" aria-label="Ordane">${body}</svg>
<h1>${TAGLINE}</h1>
<p>${SUBLINE}</p>
</body></html>
`;
}

// ------------------------------------------------------------------------------------------------ the files
export function files() {
  return {
    "ordane-mark.svg": markFile("adaptive"),
    "ordane-mark-light.svg": markFile("light"),
    "ordane-mark-dark.svg": markFile("dark"),
    "ordane-mark-mono.svg": markFile("mono"),
    "ordane-logo.svg": logoFile("adaptive"),
    "ordane-logo-light.svg": logoFile("light"),
    "ordane-logo-dark.svg": logoFile("dark"),
    "ordane-logo-mono.svg": logoFile("mono"),
    "favicon.svg": markFile("adaptive"),
    "app-icon.svg": appIconFile(),
    "social-card.html": cardHtml(),
    "tokens.css": tokensFile(),
  };
}

function chromePath() {
  const candidates = [process.env.CHROME, "google-chrome", "chromium", "chromium-browser"].filter(Boolean);
  return candidates.find((c) => spawnSync(c, ["--version"], { stdio: "ignore" }).status === 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * Renders pages to PNG through Chrome's debugging protocol, as scripts/capture-demo.mjs drives the dashboard. The
 * command-line `--screenshot` flag was not used: it sizes the browser window, not the page, and cuts the page short.
 * `shoot(url, width, height, out)` renders the page at exactly width x height.
 */
async function withChrome(chrome, fn) {
  const profile = mkdtempSync(join(tmpdir(), "ordane-brand-"));
  const port = await freePort();
  const proc = spawn(
    chrome,
    ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "about:blank"],
    { stdio: "ignore" },
  );
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      try {
        up = (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
      } catch {
        await sleep(100);
      }
    }
    if (!up) throw new Error("Chrome did not expose its debugging port");
    const shoot = async (url, width, height, out) => {
      const target = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.onopen = res;
        ws.onerror = rej;
      });
      let id = 0;
      const pending = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)(m);
          pending.delete(m.id);
        }
      };
      const send = (method, params = {}) =>
        new Promise((res) => {
          const i = ++id;
          pending.set(i, res);
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      try {
        await send("Page.enable");
        await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        for (let i = 0; i < 100; i++) {
          const r = await send("Runtime.evaluate", { expression: "document.readyState === 'complete' && document.fonts.status === 'loaded'", returnByValue: true });
          if (r.result?.result?.value) break;
          await sleep(100);
        }
        await sleep(150);
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        if (!shot.result?.data) throw new Error(`Chrome returned no image for ${out}`);
        writeFileSync(out, Buffer.from(shot.result.data, "base64"));
      } finally {
        ws.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => {});
      }
    };
    await fn(shoot);
  } finally {
    proc.kill("SIGTERM");
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  }
}

async function main() {
  const want = files();
  if (CHECK) {
    const stale = Object.entries(want).filter(([name, text]) => !existsSync(join(OUT, name)) || readFileSync(join(OUT, name), "utf8") !== text);
    if (stale.length > 0) {
      console.error(`brand files are out of date: ${stale.map(([name]) => name).join(", ")}\nrun \`node scripts/build-brand.mjs\` and commit the result`);
      process.exit(1);
    }
    console.log("brand files are up to date");
    return;
  }
  mkdirSync(OUT, { recursive: true });
  for (const [name, text] of Object.entries(want)) writeFileSync(join(OUT, name), text);
  console.log(`wrote ${Object.keys(want).length} files to brand/`);
  if (!PNG) return;
  const chrome = chromePath();
  if (!chrome) {
    console.error("no Chrome or Chromium found: set CHROME=/path/to/chrome");
    process.exit(2);
  }
  await withChrome(chrome, async (shoot) => {
    const icon = pathToFileURL(join(OUT, "app-icon.svg")).href;
    for (const [out, size] of [["apple-touch-icon.png", 180], ["icon-512.png", 512]]) {
      const page = join(OUT, `.${out}.html`);
      writeFileSync(page, `<!doctype html><meta charset="utf-8"><body style="margin:0"><img src="${icon}" width="${size}" height="${size}" style="display:block">`);
      try {
        await shoot(pathToFileURL(page).href, size, size, join(OUT, out));
      } finally {
        rmSync(page, { force: true });
      }
    }
    await shoot(pathToFileURL(join(OUT, "social-card.html")).href, 1200, 630, join(OUT, "social-card.png"));
  });
  console.log("rendered apple-touch-icon.png, icon-512.png and social-card.png");
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
