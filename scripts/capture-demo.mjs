#!/usr/bin/env node
/*
 * Regenerates the README demo GIF from the scripted demo-stub journey.
 *
 * Usage: npm run demo:capture [-- --port 7421 --out docs/assets/demo-stub.gif --keep-frames --mp4]
 * Requires: built repo (npm run build), a local Chrome/Chromium (or CHROME=/path), ffmpeg on PATH.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { WebSocket } from "undici";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const PORT = Number(opt("port", 7421));
const MESH = opt("mesh", "examples/demo-stub/mesh.yaml");
const OUT = resolve(root, opt("out", "docs/assets/demo-stub.gif"));
const MP4 = flag("mp4") ? OUT.replace(/\.gif$/i, ".mp4") : null;
const KEEP_FRAMES = flag("keep-frames");
const W = 1280, H = 720;
const T_START = 2500, T_EVENTS = 4600, T_GRAPH = 8200, T_END = 12800;
const FRAMES_DIR = join(tmpdir(), "agent-mesh-demo-capture");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];
const die = (msg, code = 1) => { for (const c of children) c.kill("SIGTERM"); console.error(`\ncapture-demo: ${msg}`); process.exit(code); };

const cli = join(root, "dist/apps/mesh-cli/src/index.js");
if (!existsSync(cli)) die("dist/ not built — run `npm run build` first");
if (spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status !== 0) die("ffmpeg not found on PATH");
const chromeBin = [process.env.CHROME, "google-chrome", "chromium", "chromium-browser"].filter(Boolean)
  .find((b) => spawnSync(b, ["--version"], { stdio: "ignore" }).status === 0);
if (!chromeBin) die("Chrome/Chromium not found — set CHROME=/path/to/chrome");

const run = (cmd, argv) => {
  const r = spawnSync(cmd, argv, { stdio: "inherit" });
  if (r.status !== 0) die(`${cmd} exited with ${r.status}`);
};

const server = spawn(process.execPath, [cli, "console", MESH, "--fresh", "--port", String(PORT)], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
children.push(server);
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));
server.on("exit", (code) => { if (code && code !== 0) console.error(`mesh server exited with ${code}`); });

const wait = Date.now() + 30000;
let up = false;
while (Date.now() < wait) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/`)).status === 200) { up = true; break; } } catch {}
  await sleep(250);
}
if (!up) die(`dashboard never came up on :${PORT}\n${serverLog.join("")}`);
console.log(`mesh console up on :${PORT}`);

rmSync(FRAMES_DIR, { recursive: true, force: true });
mkdirSync(FRAMES_DIR, { recursive: true });

const cdpPort = PORT + 2000;
const chrome = spawn(chromeBin, [
  "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--hide-scrollbars",
  "--force-device-scale-factor=1", "--disable-lcd-text",
  `--window-size=${W},${H}`, `--user-data-dir=${join(FRAMES_DIR, "chrome-profile")}`,
  `--remote-debugging-port=${cdpPort}`, "about:blank",
], { stdio: "ignore" });
children.push(chrome);

let ws;
const cleanup = async () => {
  try { ws?.close(); } catch {}
  chrome.kill("SIGTERM");
  server.kill("SIGTERM");
  await sleep(500);
};
process.on("SIGINT", async () => { await cleanup(); process.exit(130); });

let ver;
for (let i = 0; i < 60; i++) { try { ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; } catch { await sleep(200); } }
if (!ver) die("chrome did not expose CDP");

const created = await (await fetch(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/#/overview`)}`, { method: "PUT" })).json();
ws = new WebSocket(created.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0; const pending = new Map();
let frameIdx = 0; const frameMeta = []; let t0 = 0;
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Page.screencastFrame") {
    const file = `f${String(frameIdx).padStart(5, "0")}.jpg`;
    writeFileSync(join(FRAMES_DIR, file), Buffer.from(m.params.data, "base64"));
    frameMeta.push({ file, t: Date.now() - t0 });
    frameIdx++;
    send("Page.screencastFrameAck", { sessionId: m.params.sessionId });
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });

let ready = false;
for (let i = 0; i < 60; i++) { ready = await evalJs(`!!document.querySelector('nav#nav')`); if (ready) break; await sleep(300); }
if (!ready) die("dashboard nav never rendered");
await sleep(1200);

const banner = await evalJs(`(() => {
  const t = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /No projects yet/.test(e.textContent));
  if (!t) return "none";
  let n = t, best = null;
  for (let i = 0; i < 5 && n; i++) { const r = n.getBoundingClientRect(); if (r.width > 900 && r.height < 90) { best = n; break; } n = n.parentElement; }
  if (!best) return "none";
  best.style.display = "none";
  return "hidden";
})()`);
console.log(`host banner: ${banner}`);

const scrollMain = (dy, ms) => evalJs(`(() => {
  const els = [...document.querySelectorAll('div, main, section, ul, ol')].filter((d) => {
    const oy = getComputedStyle(d).overflowY;
    return d.clientHeight > 200 && d.scrollHeight > d.clientHeight + 40 && (oy === 'auto' || oy === 'scroll' || d.scrollHeight > d.clientHeight + 200);
  });
  if (!els.length) return null;
  els.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
  const el = els[0];
  const target = Math.min(el.scrollTop + ${dy}, el.scrollHeight - el.clientHeight);
  const from = el.scrollTop, dt = ${ms}, start = performance.now();
  const tick = (t) => { const k = Math.min(1, (t - start) / dt); el.scrollTop = from + (target - from) * k; if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`);

t0 = Date.now();
await send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
console.log("recording...");

const steps = [
  [T_START, async () => { const s = await evalJs(`fetch('/mission/start',{method:'POST'}).then(r=>r.status).catch(e=>String(e))`); console.log(`mission/start -> ${s}`); }],
  [T_EVENTS, () => evalJs(`location.hash='#/events'`)],
  [6000, () => scrollMain(150, 1700)],
  [T_GRAPH, () => evalJs(`location.hash='#/graph'`)],
  [10200, () => scrollMain(240, 1800)],
];
for (const [at, fn] of steps) {
  const waitMs = t0 + at - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  await fn();
}
await sleep(Math.max(0, t0 + T_END - Date.now()));
await send("Page.stopScreencast");
if (!frameMeta.length) die("no frames captured");
console.log(`${frameMeta.length} frames, ${(frameMeta.at(-1).t / 1000).toFixed(1)}s`);

await cleanup();

const concat = [];
for (let i = 0; i < frameMeta.length; i++) {
  concat.push(`file '${join(FRAMES_DIR, frameMeta[i].file)}'`);
  const dur = i + 1 < frameMeta.length ? (frameMeta[i + 1].t - frameMeta[i].t) / 1000 : 1.5;
  concat.push(`duration ${dur.toFixed(4)}`);
}
concat.push(`file '${join(FRAMES_DIR, frameMeta[frameMeta.length - 1].file)}'`);
writeFileSync(join(FRAMES_DIR, "concat.txt"), concat.join("\n") + "\n");

console.log("encoding mp4...");
const mp4Tmp = join(FRAMES_DIR, "demo.mp4");
run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(FRAMES_DIR, "concat.txt"),
  "-vf", `fps=20,scale=${W}:${H}:flags=lanczos`, "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", "-pix_fmt", "yuv420p", mp4Tmp]);

console.log("encoding gif...");
mkdirSync(dirname(OUT), { recursive: true });
run("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4Tmp,
  "-vf", `fps=18,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, "-loop", "0", OUT]);
if (MP4) run("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4Tmp, "-c", "copy", MP4]);

if (!KEEP_FRAMES) rmSync(FRAMES_DIR, { recursive: true, force: true });
const size = statSync(OUT).size;
console.log(`\nwrote ${OUT} (${(size / 1024 / 1024).toFixed(2)} MB)`);
if (MP4) console.log(`wrote ${MP4}`);
if (size > 10 * 1024 * 1024) console.warn("warning: GIF is over 10 MB — GitHub serves it slowly; consider fewer colors or frames");
process.exit(0);
