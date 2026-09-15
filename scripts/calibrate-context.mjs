/**
 * Measure the three context constants against a real mission's audit log.
 *
 *   node scripts/calibrate-context.mjs <run-dir-or-turn-audit.jsonl>
 *
 * WHAT THIS IS NOT: validation. Nothing here proves a constant is right. Each
 * of the three was picked by argument and has never been checked against a real
 * run, and this script does not change that — it makes the check possible, and
 * says explicitly which of its own answers are conclusive and which are not.
 *
 * `CHARS_PER_TOKEN` is the interesting case, because the only reality signal in
 * the log is the turn's real `input` token count, which also contains the
 * system prompt, the tool schemas and the accumulated transcript. So:
 *
 *   realInput >= promptTokens
 *     => chars/realInput <= chars/promptTokens
 *
 * Observing chars/realInput ABOVE 3.5 therefore proves chars/promptTokens is
 * above 3.5 too — the estimator over-counts, which is the safe direction for a
 * budget hold. Observing it BELOW 3.5 proves nothing: the shortfall may be
 * entirely the transcript. The script reports both and refuses to call the
 * second case a finding.
 */
import fs from "node:fs";
import path from "node:path";

// Mirrors of the constants under test. Deliberately duplicated rather than
// imported: this script reads a log produced by whatever build was running at
// the time, and importing today's value would quietly re-baseline the question.
const CHARS_PER_TOKEN = 3.5;
const INSTRUCTIONS_SOFT_CAP_TOKENS = 9000;
const SESSION_CONTEXT_ROTATE_TOKENS = 120_000;

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node scripts/calibrate-context.mjs <run-dir | turn-audit.jsonl>");
  process.exit(2);
}
const file = fs.statSync(arg).isDirectory()
  ? [path.join(arg, "turn-audit.jsonl"), path.join(arg, "logs", "turn-audit.jsonl")].find((p) => fs.existsSync(p))
  : arg;
if (!file || !fs.existsSync(file)) {
  console.error(`no turn-audit.jsonl under ${arg}`);
  process.exit(2);
}

const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

/** Audit lines are `<iso> <msg>`; msg is sometimes JSON, sometimes prose. */
const turns = [];
const overCap = [];
const rotations = [];
for (const line of lines) {
  const at = line.indexOf("{");
  if (at !== -1) {
    try {
      const rec = JSON.parse(line.slice(at));
      if (typeof rec.instructionsChars === "number") turns.push(rec);
      continue;
    } catch {
      /* prose line that merely contains a brace */
    }
  }
  const cap = line.match(/instructions ~(\d+) tokens (?:still )?over soft cap (\d+)/);
  if (cap) overCap.push({ before: Number(cap[1]), cap: Number(cap[2]), landed: !line.includes("still over") });
  const rot = line.match(/rotat\w+.*?(\d{4,})/);
  if (rot) rotations.push(Number(rot[1]));
}

const pct = (xs, p) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const n = (x) => x.toLocaleString("en-US");

console.log(`source: ${file}`);
console.log(`turns with a recorded prompt size: ${turns.length}\n`);

if (turns.length === 0) {
  console.log("Nothing to measure. This log has no turn records carrying `instructionsChars`,");
  console.log("which means it predates that field or the run never completed a turn.");
  process.exit(0);
}

// ---- CHARS_PER_TOKEN ------------------------------------------------------
const withInput = turns.filter((t) => Number(t.tokens?.input) > 0);
console.log(`## CHARS_PER_TOKEN (currently ${CHARS_PER_TOKEN})`);
if (withInput.length === 0) {
  console.log("  no turn reported a real input token count — nothing to compare against.\n");
} else {
  const ratios = withInput.map((t) => t.instructionsChars / t.tokens.input);
  const median = pct(ratios, 50);
  console.log(`  turns with real usage: ${withInput.length}`);
  console.log(`  observed chars per REAL input token: p50 ${median.toFixed(2)}, p05 ${pct(ratios, 5).toFixed(2)}, p95 ${pct(ratios, 95).toFixed(2)}`);
  if (median > CHARS_PER_TOKEN) {
    console.log(`  VERDICT: conclusive — ${median.toFixed(2)} > ${CHARS_PER_TOKEN}, so the estimator over-counts the prompt.`);
    console.log("           Over-counting is the safe direction for a hold; the constant is not dangerous.");
    console.log(`           It may be wastefully conservative: holds are ~${((median / CHARS_PER_TOKEN - 1) * 100).toFixed(0)}% larger than the prompt alone needs.`);
  } else {
    console.log(`  VERDICT: inconclusive — ${median.toFixed(2)} <= ${CHARS_PER_TOKEN}, but real input also carries the`);
    console.log("           system prompt, tool schemas and transcript, which are enough to explain the gap.");
    console.log("           To settle it you need a turn whose input is ONLY the instructions.");
  }
  console.log();
}

// ---- INSTRUCTIONS_SOFT_CAP_TOKENS ----------------------------------------
const est = turns.map((t) => Number(t.estInputTokens) || 0);
console.log(`## INSTRUCTIONS_SOFT_CAP_TOKENS (currently ${n(INSTRUCTIONS_SOFT_CAP_TOKENS)})`);
console.log(`  estimated prompt size: p50 ${n(pct(est, 50))}, p95 ${n(pct(est, 95))}, max ${n(Math.max(...est))}`);
console.log(`  turns the cap actually fired on: ${overCap.length}`);
if (overCap.length > 0) {
  const failed = overCap.filter((o) => !o.landed).length;
  console.log(`    largest overshoot: ~${n(Math.max(...overCap.map((o) => o.before)))} tokens`);
  console.log(`    rebuilds that still did not fit: ${failed}`);
}
const headroom = pct(est, 95) / INSTRUCTIONS_SOFT_CAP_TOKENS;
if (overCap.length === 0 && headroom < 0.5) {
  console.log(`  VERDICT: the cap never bound. p95 is ${(headroom * 100).toFixed(0)}% of it, so this run says nothing`);
  console.log("           about whether 9000 is the right number — only that it was never reached.");
} else if (overCap.length > 0) {
  console.log("  VERDICT: the cap bound on real turns. The degradation ladder is load-bearing, not theoretical.");
} else {
  console.log(`  VERDICT: approached but never crossed (p95 is ${(headroom * 100).toFixed(0)}% of the cap).`);
}
console.log();

// ---- SESSION_CONTEXT_ROTATE_TOKENS ---------------------------------------
console.log(`## SESSION_CONTEXT_ROTATE_TOKENS (currently ${n(SESSION_CONTEXT_ROTATE_TOKENS)})`);
if (rotations.length > 0) {
  console.log(`  rotations seen: ${rotations.length}, at context sizes: ${rotations.map(n).join(", ")}`);
} else {
  console.log("  NOT MEASURABLE from this log. The adapter takes an `onRotate` observer");
  console.log("  (packages/runtime-claude/src/index.ts) and nothing subscribes to it, so a");
  console.log("  rotation leaves no trace outside the adapter's own memory. Zero rotations");
  console.log("  here means 'unobserved', NOT 'did not happen' — do not read it as evidence.");
}
