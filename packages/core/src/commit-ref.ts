/**
 * What a CodePatch's `metadata.commit` may hold: something `git` can resolve to
 * a commit, and nothing else.
 *
 * The value is handed to git verbatim at merge time (`WorkspacePort.mergeWorktree`
 * runs `git cat-file -e <value>^{commit}`, then `git merge <value>`), and until
 * this check nothing on the publish path looked at it. Seen live: a seat
 * published `"b83c898 (on mesh/frontend; 6ea2614 -> f14529c -> d08dc73 -> b83c898)"`,
 * the merge error quoted its first twelve characters (`b83c898 (on `), and the
 * seats read that as a template with an empty branch name and escalated it three
 * times as a runtime defect. The merge stayed blocked for about four hours.
 *
 * Deliberately stricter than `git check-ref-format`: a merge reference has no
 * business containing parentheses, semicolons or commas even where git would
 * allow them, and refusing them is what catches prose.
 */

/** A hex object name, abbreviated (7+) or full (40). */
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Longest value quoted back in a refusal. A 10k-char paste is still refused, just not echoed in full. */
const MAX_QUOTED_CHARS = 300;

/** Longest ref name accepted. Git's own limit is the filesystem's; nothing a seat names legitimately comes near this. */
const MAX_REF_CHARS = 255;

/** Is `value` a hex commit sha (7-40 characters)? Says nothing about whether the repository has it. */
export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_RE.test(value);
}

/**
 * Why `value` is not a conservative git ref name, or null when it is one.
 * `git check-ref-format`'s rules, plus the extra characters above.
 */
function refNameProblem(value: string): string | null {
  if (value.length === 0) return "it is empty";
  if (value.length > MAX_REF_CHARS) return `it is ${value.length} characters long`;
  if (/\s/.test(value)) return "it contains whitespace";
  if (/[\x00-\x1f\x7f]/.test(value)) return "it contains a control character";
  const bad = value.match(/[~^:?*[\\(),;]/);
  if (bad) return `it contains ${JSON.stringify(bad[0])}`;
  if (value.includes("..")) return 'it contains ".."';
  if (value.includes("@{")) return 'it contains "@{"';
  if (value === "@") return 'it is "@"';
  if (value.startsWith("-")) return 'it starts with "-"';
  if (value.startsWith("/")) return 'it starts with "/"';
  if (value.endsWith("/")) return 'it ends with "/"';
  if (value.endsWith(".")) return 'it ends with "."';
  if (value.includes("//")) return 'it contains "//"';
  for (const part of value.split("/")) {
    if (part.startsWith(".")) return `a path component starts with "." (${JSON.stringify(part)})`;
    if (part.endsWith(".lock")) return `a path component ends with ".lock" (${JSON.stringify(part)})`;
  }
  return null;
}

/** `value` as a refusal quotes it: JSON-quoted, whole unless it is enormous. */
export function quoteCommitRef(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return JSON.stringify(text.length > MAX_QUOTED_CHARS ? `${text.slice(0, MAX_QUOTED_CHARS)}…` : text);
}

/**
 * Null when `value` can name a commit (a hex sha, or a branch/ref name git
 * would accept); otherwise the sentence that refuses it, naming the value.
 *
 * Syntax only. Whether the repository actually HAS that commit is a separate
 * question, asked by the supervisor when the mesh has a git workspace.
 */
export function commitRefError(value: unknown): string | null {
  const head = "metadata.commit must be a git commit sha or branch name";
  if (typeof value !== "string") {
    return `${head} (got ${value === null ? "null" : `a ${typeof value}`}: ${quoteCommitRef(value)}) — pass the bare sha as a string, or omit it and record one with the \`commit\` op`;
  }
  if (isCommitSha(value)) return null;
  const why = refNameProblem(value);
  if (!why) return null;
  return `${head} (got ${quoteCommitRef(value)} — ${why}) — pass the bare sha and nothing else, or omit it and record one with the \`commit\` op`;
}
