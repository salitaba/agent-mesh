/**
 * What the Product page reads out of the checkout and out of a script run, with no DOM in it: which lines of a log say
 * something failed, how the run ended, what a script button runs, what a change code means, and whether the product ships a
 * playground.
 *
 * The runner (apps/mesh-server/src/index.ts, `runScripts` and `startRun`) is small and the page must not say more than it
 * does. A button runs `npm run <name>` in the product checkout (or, for the bundled simulator's `headless-hairpin`, one fixed
 * node command), one run at a time, with the host's `MESH_*` variables and model API keys left out of the environment. The log
 * is the last 60,000 characters. The host forgets a run when it restarts. A run killed by a signal has no exit code.
 */

/** The script names the console will run, as the server lists them. A product's other scripts are not offered. */
export const RUN_SCRIPT_NAMES = ["build", "test", "typecheck", "dev", "start", "serve", "preview", "lint"] as const;

/** The server keeps this much of a log, from the end. */
export const LOG_CAP = 60_000;

export interface RunLine {
  /** One-based, in the log as the server sent it. */
  n: number;
  text: string;
}

/** A line the log shows as a failure, in the shapes the common tools use. Uppercase FAIL on purpose: "0 failed" is good news. */
const FAIL_SIGNALS: readonly RegExp[] = [
  /\berror TS\d+/, // tsc
  /^\s*(not ok|FAIL|FAILED)\b/, // TAP, jest, pytest, go
  /^\s*(✗|✖|✕|×)\s/, // test runners that draw a cross
  /^\s*(#|ℹ)\s*fail [1-9]\d*/, // the TAP and node:test summary: "fail 2" (but not "fail 0")
  /^\s*●.*›/, // jest's name of a failing test
  /^\s*--- FAIL:/, // go test
  /\b(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError)\b/,
  /^\s*(Error|Uncaught \w*Error):/,
  /^\s*error(\[E\d+\])?:/, // rustc, eslint-style "error:"
  /\bpanicked at\b/,
  /^\s*\[ERROR\]/, // maven, gradle
  /^\s*E {3,}\S/, // pytest's assertion detail
  /\b[1-9]\d* (failed|failing|errors?|failures?)\b/, // a summary that counts some
  /^npm (ERR!|error) (Missing script|enoent)/i, // the runner could not start the script
];

/** Lines that look like a failure but are the runner's own boilerplate after one. */
const NOISE: readonly RegExp[] = [/\b0 (errors?|failed|failing|failures?)\b/i, /A complete log of this run/, /^npm (ERR!|error) (code|errno|path|syscall|command failed|Failed at)\b/i];

/**
 * The lines to show before the full log of a run that failed: the first `max` that say so, in log order, with how many more
 * there are. A stack frame is context for the line above it and is not listed; the full log is one scroll away.
 */
export function failureLines(log: string, max = 12): { lines: RunLine[]; total: number } {
  const lines: RunLine[] = [];
  let total = 0;
  const all = log.replace(/\r/g, "").split("\n");
  for (let i = 0; i < all.length; i++) {
    const text = all[i]!;
    if (!text.trim() || NOISE.some((r) => r.test(text))) continue;
    if (!FAIL_SIGNALS.some((r) => r.test(text))) continue;
    total++;
    if (lines.length < max) lines.push({ n: i + 1, text: text.trimEnd() });
  }
  return { lines, total };
}

/** The last non-empty lines of a log, for a run that passed: the summary a runner prints at its end. */
export function lastLines(log: string, count = 3): RunLine[] {
  const all = log.replace(/\r/g, "").split("\n");
  const out: RunLine[] = [];
  for (let i = all.length - 1; i >= 0 && out.length < count; i--) {
    if (all[i]!.trim()) out.unshift({ n: i + 1, text: all[i]!.trimEnd() });
  }
  return out;
}

export type RunOutcome = "running" | "passed" | "failed" | "stopped" | "lost";

/**
 * How a run ended. `lost` is the host no longer knowing the run (it restarted: runs live in its memory), which is not a
 * failure of the script and must not be shown as one. A run that was killed by a signal has no exit code at all, so "exit ?"
 * is not a state; it is "stopped".
 */
export function runOutcome(run: { done: boolean; exitCode: number | null }, lost = false): RunOutcome {
  if (lost) return "lost";
  if (!run.done) return "running";
  if (run.exitCode === 0) return "passed";
  return run.exitCode === null ? "stopped" : "failed";
}

/** The server kept the end of a longer log. */
export const isCapped = (log: string): boolean => log.length >= LOG_CAP - 100;

/** `scripts` out of a package.json's text, strings only; null when it does not parse or has none. */
export function parseScripts(text: string): Record<string, string> | null {
  try {
    const pkg = JSON.parse(text) as { scripts?: unknown };
    if (!pkg || typeof pkg.scripts !== "object" || pkg.scripts === null) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
    return out;
  } catch {
    return null;
  }
}

export type PackageState = "unknown" | "missing" | "invalid" | "ok";

/** A package.json's text, read: whether it is JSON at all, and the scripts it has when it is. */
export function readPackage(text: string): { state: PackageState; scripts: Record<string, string> | null } {
  try {
    JSON.parse(text);
  } catch {
    return { state: "invalid", scripts: null };
  }
  return { state: "ok", scripts: parseScripts(text) };
}

export interface ScriptInfo {
  name: string;
  /** What is run: `npm run build`, or the fixed node command. */
  command: string;
  /** What the product's package.json says the script does, when the page could read it. */
  body: string | null;
  /** Scripts of these names usually serve something and do not exit by themselves. */
  usuallyStays: boolean;
  label: string;
}

const HEADLESS = "node tools/headless/dist/main.js --scenario demos/hairpin.scenario.json --out .mesh-state/run/hairpin-trace.json --ticks 6600";

export function describeScript(name: string, bodies: Record<string, string> | null): ScriptInfo {
  const headless = name === "headless-hairpin";
  return {
    name,
    command: headless ? HEADLESS : `npm run ${name}`,
    body: headless ? null : bodies?.[name] ?? null,
    usuallyStays: ["dev", "start", "serve", "preview"].includes(name),
    label: headless ? "Hairpin scenario" : name.charAt(0).toUpperCase() + name.slice(1),
  };
}

export interface ChangeKind {
  /** The git code, as one mark to draw. */
  mark: string;
  /** The same in a word, so the mark is never the only signal. */
  word: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}

/** What `git status --porcelain` meant by a two-character code. The mark is drawn, the word is read. */
export function changeKind(status: string): ChangeKind {
  const s = status.trim();
  if (s === "??") return { mark: "N", word: "new, not tracked", tone: "ok" };
  if (/U|^AA$|^DD$/.test(s)) return { mark: "C", word: "in conflict", tone: "bad" };
  if (s.includes("D")) return { mark: "D", word: "deleted", tone: "bad" };
  if (s.includes("A")) return { mark: "A", word: "added", tone: "ok" };
  if (s.includes("R")) return { mark: "R", word: "renamed", tone: "neutral" };
  if (s.includes("M")) return { mark: "M", word: "modified", tone: "warn" };
  return { mark: "?", word: "changed", tone: "neutral" };
}

/** `git log --oneline` as lines to draw: a short hash and its subject. A line that is not in that shape is kept whole. */
export function parseCommits(log: string | undefined): Array<{ hash: string; subject: string }> {
  return (log ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = /^([0-9a-f]{6,40})\s+(.*)$/.exec(l);
      return m ? { hash: m[1]!, subject: m[2]! } : { hash: "", subject: l };
    });
}

/** The page draws this many entries of a folder, then offers the rest: a folder of 5,000 files is 5,000 buttons otherwise. */
export const TREE_WINDOW = 300;

/**
 * Whether the checkout ships the page the playground opens. The server serves `apps/playground/index.html` and nothing else
 * as a playground, so a product without that file has none, and a button that opens "not built" is worse than no button.
 */
export function hasPlayground(entries: ReadonlyArray<{ name: string; type: string }> | null): boolean {
  return Array.isArray(entries) && entries.some((e) => e.name === "index.html" && e.type === "file");
}

const OFFERED = "build, test, typecheck, lint, dev, start, serve and preview";

/** What the Run card says when there is nothing to run: why, and what would make buttons appear. */
export function noScriptsCopy(pkg: PackageState): { title: string; body: string } {
  switch (pkg) {
    case "missing":
      return { title: "Nothing to run yet", body: "This checkout has no package.json. When the team adds one with a build or test script, its buttons appear here." };
    case "invalid":
      return { title: "Nothing to run", body: "This checkout's package.json is not valid JSON, so the console cannot see its scripts." };
    default:
      return { title: "Nothing to run", body: `This product's package.json has no script the console runs. It offers ${OFFERED} when the product defines them.` };
  }
}

/** The scripts to offer, in the order a person runs them: build, test, typecheck, lint, then the ones that serve. */
export function orderScripts(names: readonly string[]): string[] {
  const rank = (n: string): number => {
    const i = ["build", "test", "typecheck", "lint", "dev", "start", "serve", "preview", "headless-hairpin"].indexOf(n);
    return i === -1 ? 99 : i;
  };
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
