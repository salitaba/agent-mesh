/* Line diff for artifact versions and workspace files.
 *
 * Pure TypeScript, no git and no dependency: artifact versions live in the
 * content store as loose blobs, not as commits, so `git diff` cannot see
 * them. Emits a structured hunk list (not a unified-diff string) because the
 * dashboard renders rows, and re-parsing text we just formatted would be
 * silly. */

export type DiffOp = "eq" | "add" | "del";

export interface DiffLine {
  op: DiffOp;
  /** 1-based line number on the left side, null for added lines. */
  a: number | null;
  /** 1-based line number on the right side, null for deleted lines. */
  b: number | null;
  text: string;
}

export interface DiffHunk {
  aStart: number;
  bStart: number;
  lines: DiffLine[];
}

export interface DiffResult {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /** True when the inputs were too large to diff exactly. */
  truncated: boolean;
  identical: boolean;
}

const MAX_LINES = 6000;

function splitLines(s: string): string[] {
  if (s === "") return [];
  return s.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
}

/* Myers-style LCS via dynamic programming. Bounded by MAX_LINES on each side
 * so a pathological pair of files cannot allocate an unbounded matrix. */
function lcsTable(a: string[], b: string[]): Uint32Array {
  const w = b.length + 1;
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * w + j] = a[i] === b[j]
        ? table[(i + 1) * w + (j + 1)] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }
  return table;
}

function walk(a: string[], b: string[]): DiffLine[] {
  const table = lcsTable(a, b);
  const w = b.length + 1;
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: "eq", a: i + 1, b: j + 1, text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
      out.push({ op: "del", a: i + 1, b: null, text: a[i] });
      i++;
    } else {
      out.push({ op: "add", a: null, b: j + 1, text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ op: "del", a: i + 1, b: null, text: a[i++] });
  while (j < b.length) out.push({ op: "add", a: null, b: j + 1, text: b[j++] });
  return out;
}

/** Collapse runs of unchanged lines, keeping `context` lines around changes. */
function toHunks(lines: DiffLine[], context: number): DiffHunk[] {
  const changed = lines.map((l) => l.op !== "eq");
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (!changed[i]) continue;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  }
  const hunks: DiffHunk[] = [];
  let cur: DiffHunk | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!keep[i]) {
      cur = null;
      continue;
    }
    const line = lines[i];
    if (!cur) {
      cur = { aStart: line.a ?? 0, bStart: line.b ?? 0, lines: [] };
      hunks.push(cur);
    }
    cur.lines.push(line);
  }
  return hunks;
}

export function diffText(before: string, after: string, context = 3): DiffResult {
  const rawA = splitLines(before);
  const rawB = splitLines(after);
  const truncated = rawA.length > MAX_LINES || rawB.length > MAX_LINES;
  const a = truncated ? rawA.slice(0, MAX_LINES) : rawA;
  const b = truncated ? rawB.slice(0, MAX_LINES) : rawB;
  const lines = walk(a, b);
  const added = lines.reduce((n, l) => n + (l.op === "add" ? 1 : 0), 0);
  const removed = lines.reduce((n, l) => n + (l.op === "del" ? 1 : 0), 0);
  return {
    hunks: toHunks(lines, context),
    added,
    removed,
    truncated,
    identical: added === 0 && removed === 0 && !truncated,
  };
}
