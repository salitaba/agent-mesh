/**
 * What the Files page decides, with no DOM in it: which group a file belongs to, which files a search keeps, how a file's
 * history reads as versions, and how much of a long file is drawn at once. The page and the reader call these, and
 * tests/dashboard/files.test.ts pins them, because each one is a claim the operator reads as fact ("3 in review", "v2 of 2").
 *
 * The one thing worth knowing about the data: `GET /artifacts/:id/versions` returns one record per *change*, not one per
 * version. A file that went draft, ready for review, in review, approved and merged at version 2 has five records that all
 * say `version: 2`. Drawn as a chip each they read as "v2 v2 v2 v2 v2". `distinctVersions` folds them back into versions
 * and keeps the status trail each one walked, which is the thing the records were really recording.
 */
import { plainArtifact } from "./format";

export interface Art {
  id: string;
  name: string;
  type: string;
  status: string;
  owner: string;
  version: number;
  createdAt: string;
  goalId?: string;
  contentRef?: string;
  digest?: string;
  metadata?: Record<string, unknown>;
}

/** One record from an artifact's history: a version at one status. */
export interface ArtRecord {
  version: number;
  status: string;
  createdAt: string;
  digest?: string;
  createdBy?: string;
  contentRef?: string;
}

/** One version of a file, folded from its records. */
export interface ArtVersion {
  version: number;
  /** Where this version stands now: the status of its last record. */
  status: string;
  createdAt: string;
  digest?: string;
  createdBy?: string;
  /** Where this version's bytes are stored on the host. */
  contentRef?: string;
  /** The statuses this version walked, in order, with a repeat collapsed. */
  trail: string[];
}

export type FileGroupId = "done" | "review" | "rework" | "draft" | "archived" | "other";

export interface FileGroupDef {
  id: FileGroupId;
  label: string;
  /** The same in a word or two, for a button in a row of them ("Approved", not "Approved and merged"). */
  short: string;
  statuses: readonly string[];
}

/**
 * Work state, not colour: the groups answer "is this file finished?". A release artifact that QA has passed and security has
 * not is still waiting on someone, so it sits in review beside the documents that are; it is not "approved and merged".
 * The order is the order a person reads the page in: the result first, then what is waiting, then what went back.
 */
export const FILE_GROUPS: readonly FileGroupDef[] = [
  { id: "done", label: "Approved and merged", short: "Approved", statuses: ["MERGED", "ACCEPTED", "FINAL", "MERGEABLE", "VERIFIED", "APPROVED"] },
  { id: "review", label: "In review", short: "In review", statuses: ["READY_FOR_REVIEW", "UNDER_REVIEW", "IMPLEMENTED", "QA_VERIFIED", "SECURITY_VERIFIED"] },
  { id: "rework", label: "Needs rework", short: "Rework", statuses: ["REJECTED"] },
  { id: "draft", label: "Drafts and proposals", short: "Drafts", statuses: ["DRAFT", "PROPOSED"] },
  { id: "archived", label: "Archived", short: "Archived", statuses: ["ARCHIVED"] },
];

const OTHER: FileGroupDef = { id: "other", label: "Other", short: "Other", statuses: [] };

export function groupOf(status: string): FileGroupDef {
  return FILE_GROUPS.find((g) => g.statuses.includes(String(status))) ?? OTHER;
}

/** Newest first, ties broken by name so the order does not shuffle between two refreshes of the same data. */
export function byNewest(a: Pick<Art, "createdAt" | "name">, b: Pick<Art, "createdAt" | "name">): number {
  const t = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (Number.isFinite(t) && t !== 0) return t;
  return a.name.localeCompare(b.name);
}

/**
 * When two artifacts share a name and type (an agent published the same file again), keep the one with the higher version,
 * and the newer one of equal versions. Nothing is deleted: the older copy is still in the manifest and the reader.
 */
export function latestPerName<T extends Pick<Art, "name" | "type" | "version" | "createdAt">>(list: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const a of list) {
    const key = `${a.type}/${a.name}`;
    const prev = best.get(key);
    if (!prev || a.version > prev.version || (a.version === prev.version && Date.parse(a.createdAt) > Date.parse(prev.createdAt))) best.set(key, a);
  }
  return [...best.values()];
}

export interface FileFilter {
  query: string;
  type: string;
  group: FileGroupId | "";
  latestOnly: boolean;
}

export const NO_FILTER: FileFilter = { query: "", type: "", group: "", latestOnly: true };

/**
 * What a file is, in four words a person sorts a list by: a patch to review, a release plan, a report that says how something
 * went, or a document. It decides the glyph in front of the name, so the list can be run down by shape before it is read. The
 * protocol's own machines say the first two (a CodePatch has the code states, a ReleasePlan the release ones); the rest of
 * what an agent writes to report a result is named here, and everything it does not know is a document, never dropped.
 */
export type FileKindId = "patch" | "release" | "report" | "document";

const REPORT_TYPES = new Set(["TestReport", "SecurityReport", "ResearchReport", "BenchmarkResult", "DisagreementRecord"]);

export function fileKind(type: string): FileKindId {
  if (type === "CodePatch") return "patch";
  if (type === "ReleasePlan") return "release";
  return REPORT_TYPES.has(type) ? "report" : "document";
}

/** The kind as a person would say it: for the tooltip on the glyph and for a screen reader. */
export const FILE_KIND_LABEL: Record<FileKindId, string> = { patch: "Code patch", release: "Release plan", report: "Report", document: "Document" };

/** The repo path a code artifact names, if it does. */
export const repoPathOf = (a: Pick<Art, "metadata">): string => {
  const p = a.metadata?.path ?? a.metadata?.file;
  return typeof p === "string" ? p : "";
};

/**
 * Every word of the query must appear somewhere in the file's name, type, owner, status (as written and as read), or path,
 * so "pm requirements" finds `payment-requirements` by its owner as well as its name. Case does not matter.
 */
export function matchesQuery(a: Art, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [a.name, a.type, a.owner, a.status, plainArtifact(a.status), repoPathOf(a), a.id].join("\n").toLowerCase();
  return words.every((w) => hay.includes(w));
}

/** The files a filter keeps, newest first. `latestOnly` is applied before the other filters, so a hidden older copy never matches. */
export function filterFiles(arts: readonly Art[], f: FileFilter): Art[] {
  const pool = f.latestOnly ? latestPerName(arts) : [...arts];
  return pool
    .filter((a) => (!f.type || a.type === f.type) && (!f.group || groupOf(a.status).id === f.group) && matchesQuery(a, f.query))
    .sort(byNewest);
}

export interface FileGroup {
  id: FileGroupId;
  label: string;
  items: Art[];
}

/** The non-empty groups, in reading order. A status the page has never heard of lands in "Other", last, never dropped. */
export function groupFiles(arts: readonly Art[]): FileGroup[] {
  const out: FileGroup[] = [];
  for (const def of [...FILE_GROUPS, OTHER]) {
    const items = arts.filter((a) => groupOf(a.status).id === def.id);
    if (items.length) out.push({ id: def.id, label: def.label, items });
  }
  return out;
}

/** How many files each group holds, for the status filter. */
export function groupCounts(arts: readonly Art[]): Record<FileGroupId, number> {
  const c: Record<FileGroupId, number> = { done: 0, review: 0, rework: 0, draft: 0, archived: 0, other: 0 };
  for (const a of arts) c[groupOf(a.status).id]++;
  return c;
}

/** The distinct types, sorted, with how many files each holds. */
export function typeCounts(arts: readonly Art[]): Array<{ type: string; n: number }> {
  const m = new Map<string, number>();
  for (const a of arts) m.set(a.type, (m.get(a.type) ?? 0) + 1);
  return [...m.entries()].map(([type, n]) => ({ type, n })).sort((a, b) => a.type.localeCompare(b.type));
}

/** "9 files", "1 file", or "4 of 9 files" when a filter hides some. */
export function countLabel(shown: number, total: number): string {
  const noun = (n: number): string => (n === 1 ? "file" : "files");
  return shown === total ? `${total} ${noun(total)}` : `${shown} of ${total} ${noun(total)}`;
}

/**
 * Fold an artifact's history (one record per change) into one entry per version, ascending. A version's status is the one its
 * last record carries; its trail is every status it walked, a repeat collapsed (a transition recorded twice reads once).
 * Records that do not name a version are ignored rather than guessed at.
 */
export function distinctVersions(history: readonly ArtRecord[]): ArtVersion[] {
  const by = new Map<number, ArtVersion>();
  for (const r of history) {
    if (typeof r?.version !== "number" || !Number.isFinite(r.version)) continue;
    const seen = by.get(r.version);
    if (!seen) {
      by.set(r.version, { version: r.version, status: r.status, createdAt: r.createdAt, digest: r.digest, createdBy: r.createdBy, contentRef: r.contentRef, trail: [r.status] });
      continue;
    }
    seen.status = r.status;
    if (r.digest) seen.digest = r.digest;
    if (r.contentRef) seen.contentRef = r.contentRef;
    if (seen.trail[seen.trail.length - 1] !== r.status) seen.trail.push(r.status);
  }
  return [...by.values()].sort((a, b) => a.version - b.version);
}

/** The version before `version`, or null when it is the first. The default thing a reviewer compares against. */
export function previousVersion(versions: readonly Pick<ArtVersion, "version">[], version: number): number | null {
  let best: number | null = null;
  for (const v of versions) if (v.version < version && (best === null || v.version > best)) best = v.version;
  return best;
}

/** The status trail as words: "draft, ready for review, merged". */
export const trailWords = (trail: readonly string[]): string[] => trail.map((s) => plainArtifact(s));

/**
 * Which row takes focus after an arrow key in the list. The list has one tab stop, so the arrows are how a keyboard reaches
 * the other rows; it stops at the ends rather than wrapping, because wrapping a list of 500 lands you somewhere you did not mean.
 */
export function nextIndex(key: string, current: number, count: number, page = 10): number {
  if (count <= 0) return -1;
  const at = Math.min(Math.max(current, 0), count - 1);
  switch (key) {
    case "ArrowDown": return Math.min(count - 1, at + 1);
    case "ArrowUp": return Math.max(0, at - 1);
    case "PageDown": return Math.min(count - 1, at + page);
    case "PageUp": return Math.max(0, at - page);
    case "Home": return 0;
    case "End": return count - 1;
    default: return at;
  }
}

/** Lines drawn when a file opens, and how many more each "show more" adds. A file of 40,000 lines is 120,000 nodes if drawn at once. */
export const LINE_WINDOW = 1500;

export interface LineWindow {
  shown: number;
  remaining: number;
  /** The next window size if the reader asks for more. */
  next: number;
}

export function lineWindow(total: number, limit: number = LINE_WINDOW): LineWindow {
  const shown = Math.max(0, Math.min(total, limit));
  return { shown, remaining: total - shown, next: Math.min(total, limit + LINE_WINDOW) };
}

/**
 * Whether a body of text is a unified diff, as `git diff` or a patch file writes it. A patch is read by its colours (what it adds,
 * what it takes away), and a document that merely has a list in it ("- one", "+ two") must not be painted as one: so the test is the
 * headers a diff has and a list does not, in the first lines.
 */
export function looksLikePatch(text: string): boolean {
  const head = text.slice(0, 6000).split("\n", 80);
  if (head.some((l) => l.startsWith("diff --git ") || /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(l))) return true;
  return head.some((l) => l.startsWith("--- ")) && head.some((l) => l.startsWith("+++ "));
}

export type PatchLine = "meta" | "hunk" | "add" | "del" | "ctx";

/**
 * What each line of a patch is. Before the first hunk header a line is part of the file's header (`--- a/x`, `+++ b/x`, `index ..`),
 * and inside a hunk a line that starts with `-` took something away even when what it took away began with `--` (a SQL comment is
 * `--- comment` in a diff). A `diff --git` line starts the next file. `\ No newline at end of file` is a note, not a line.
 */
export function patchKinds(lines: readonly string[]): PatchLine[] {
  let inHunk = false;
  return lines.map((l) => {
    if (l.startsWith("diff --git ")) {
      inHunk = false;
      return "meta";
    }
    if (l.startsWith("@@")) {
      inHunk = true;
      return "hunk";
    }
    if (!inHunk) return "meta";
    if (l.startsWith("\\")) return "meta";
    if (l.startsWith("+")) return "add";
    if (l.startsWith("-")) return "del";
    return "ctx";
  });
}

/** `512B`, `1.2kB`, `130kB`, `1.4MB`. */
export const fmtSize = (n: number): string =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(n >= 102_400 ? 0 : 1)}kB` : `${n}B`;

export type FileKind = "text" | "markdown" | "image" | "binary";
export type FileViewMode = "rendered" | "source" | "changes";

/**
 * The views a file offers. A markdown file can be read rendered or as written; any file can show what changed when a
 * comparison exists. A control with one choice is not a control, so the page draws the switch only when there are two.
 */
export function fileModes(kind: FileKind, hasContent: boolean, hasChanges: boolean): FileViewMode[] {
  const out: FileViewMode[] = [];
  if (kind === "markdown" && hasContent) out.push("rendered", "source");
  else if (kind === "image" || kind === "binary" || !hasContent) out.push("rendered");
  else out.push("source");
  if (hasChanges) out.push("changes");
  return out;
}

/** What each view is called on its button. */
export function modeLabel(kind: FileKind, mode: FileViewMode): string {
  if (mode === "changes") return "Changes";
  if (mode === "rendered") return kind === "image" ? "Image" : "Rendered";
  return kind === "markdown" ? "Source" : "Contents";
}

const CODE_TYPES = new Set(["CodePatch", "ApiSpec", "DatabaseSchema"]);
const TEXT_EXT = /\.(java|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|sql|sh|py|go|rs|rb|css|html|xml|toml|ini|diff|patch|txt|log|csv)$/i;

/**
 * How to draw an artifact's body. Agents write their documents in markdown, so a document is drawn rendered; a patch, a
 * schema or a spec is code, and markdown would turn the `-` of a removed line into a bullet. A name that says `.md` wins.
 */
export function readAs(a: Pick<Art, "name" | "type">): "markdown" | "text" {
  if (/\.(md|markdown)$/i.test(a.name)) return "markdown";
  if (CODE_TYPES.has(a.type) || TEXT_EXT.test(a.name)) return "text";
  return "markdown";
}

/**
 * What a downloaded artifact is called. Artifacts are named like `payment-requirements`, with no extension, and a browser
 * saves such a file as an unknown type; so a name with no extension gets the one its content has.
 */
export function downloadName(a: Pick<Art, "name" | "type">): string {
  if (/\.[a-z0-9]{1,8}$/i.test(a.name)) return a.name;
  if (a.type === "CodePatch") return `${a.name}.patch`;
  return `${a.name}${readAs(a) === "markdown" ? ".md" : ".txt"}`;
}

/**
 * The highest event number among the artifact events (`artifact.created`, `artifact.versioned`, `artifact.transition`). The
 * list refetches when this moves, so a file an agent just published appears without a reload and a status change shows.
 */
export function latestArtifactSeq(events: readonly { seq: number; type: string }[]): number {
  let max = 0;
  for (const e of events) if (typeof e.type === "string" && e.type.startsWith("artifact.") && e.seq > max) max = e.seq;
  return max;
}

export interface EmptyCopy {
  title: string;
  body: string;
  /** Offer the mission's own primary action (Start, Continue, Resume) as the next move. */
  start: boolean;
}

/** What an empty Files page says, by the state of the mission: what is missing, and what to do about it. */
export function emptyCopy(phase: string, hasHistory: boolean): EmptyCopy {
  switch (phase) {
    case "parked":
      return {
        title: "No files yet",
        body: hasHistory
          ? "Nothing was published before the mission was parked. Continue it, and the files agents publish appear here."
          : "Nothing has run in this project. Start the mission, and the files agents publish appear here.",
        start: true,
      };
    case "paused":
      return { title: "No files yet", body: "The mission is paused and nothing was published before it stopped. Resume it, and the files agents publish appear here.", start: true };
    case "running":
    case "quiet":
    case "stalled":
      return { title: "No files yet", body: "Agents publish their work here as they finish it: requirements, designs, patches, reports. Nothing has been published so far.", start: false };
    case "done":
      return { title: "No files were published", body: "The mission is delivered, but no agent published a file. Whatever it built is in the Product page.", start: false };
    default:
      return { title: "No files yet", body: "Agents publish their work here: requirements, designs, patches, reports. Nothing has been published so far.", start: false };
  }
}

/** A stored `file://` location as a plain path, for a person to paste into a shell. */
export function pathFromRef(ref: string | undefined): string {
  if (!ref) return "";
  if (!ref.startsWith("file://")) return ref;
  try {
    return decodeURIComponent(new URL(ref).pathname);
  } catch {
    return ref.slice("file://".length);
  }
}

/**
 * The paths a reader shows for a file, and where. A file in the product's repository has a path a person recognises
 * (`src/tx/Pipeline.java`): that is the header's, with a button to copy it. Where the mesh keeps the bytes of a version
 * (`.../.mesh-state/artifacts/artifacts/art-.../v1.txt`) is the mesh's own store: it is what a person who runs the host pastes into
 * a shell, and for everyone else it was the first thing they read before the content. It is under "Details", with its copy button.
 */
export function readerPaths(art: Pick<Art, "metadata">, contentRef: string | undefined): { product: string; stored: string } {
  return { product: repoPathOf(art), stored: pathFromRef(contentRef) };
}
