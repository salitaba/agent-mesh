import * as path from "path";

/**
 * File materialization for non-git meshes.
 *
 * With git, merging a worktree IS the materialization: the product repo gets
 * the files. Without git there is no worktree, so a CodePatch must carry its
 * own files. Agents describe them in artifact content in one of two shapes:
 *
 *   ## File: web/playground.html      (single file, level >= 2, "File:" label)
 *   ### src/playground/core.mjs       (bundle member, level >= 3, bare path)
 *
 * Bodies are raw (no code fence required); a heading of the same or higher
 * level ends the section, so trailing prose like "## How to run" is never
 * mistaken for file content.
 */

export interface PatchFile {
  path: string;
  content: string;
}

/** Bare filenames that are files despite having no extension. */
const EXTENSIONLESS_FILES = new Set(["Dockerfile", "Makefile", "LICENSE"]);

function isLikelyFilePath(candidate: string): boolean {
  if (!candidate || /\s/.test(candidate)) return false;
  if (!/^[A-Za-z0-9._@/-]+$/.test(candidate)) return false;
  if (candidate.endsWith("/")) return false;
  const segments = candidate.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return false;
  return candidate.includes(".") || candidate.includes("/") || EXTENSIONLESS_FILES.has(candidate);
}

interface Heading {
  line: number;
  level: number;
  filePath?: string;
}

function parseHeadings(lines: string[]): Heading[] {
  const out: Heading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const level = m[1]!.length;
    const text = m[2]!.trim();
    const labelled = /^File:\s*(.+)$/.exec(text);
    const candidate = labelled ? labelled[1]!.trim() : level >= 3 ? text : "";
    const filePath = (labelled ? level >= 2 : level >= 3) && isLikelyFilePath(candidate) ? candidate : undefined;
    out.push(filePath === undefined ? { line: i, level } : { line: i, level, filePath });
  }
  return out;
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim() === "") start++;
  while (end > start && lines[end - 1]!.trim() === "") end--;
  return lines.slice(start, end);
}

function stripWrappingFence(lines: string[]): string[] {
  if (lines.length >= 2 && lines[0]!.startsWith("```") && lines[lines.length - 1]!.startsWith("```")) {
    return trimBlankEdges(lines.slice(1, -1));
  }
  return lines;
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

function sectionContent(lines: string[], headings: Heading[], index: number): string {
  const heading = headings[index]!;
  let stop = lines.length;
  for (let i = index + 1; i < headings.length; i++) {
    if (headings[i]!.level <= heading.level) {
      stop = headings[i]!.line;
      break;
    }
  }
  return stripWrappingFence(trimBlankEdges(lines.slice(heading.line + 1, stop))).join("\n");
}

/**
 * Pull file sections out of artifact content.
 *
 * - no `metadataPath`: every file section, in document order.
 * - `metadataPath` + matching section: just that file.
 * - `metadataPath` + zero sections at all: the content is a single raw file body.
 * - `metadataPath` + sections but no match: nothing (a bundle must name its files).
 */
export function extractPatchFiles(content: string, metadataPath?: string): PatchFile[] {
  const lines = content.split(/\r?\n/);
  const headings = parseHeadings(lines);
  const files: PatchFile[] = [];
  headings.forEach((h, index) => {
    if (h.filePath !== undefined) files.push({ path: h.filePath, content: sectionContent(lines, headings, index) });
  });
  if (!metadataPath) return files;
  const wanted = normalizePath(metadataPath);
  const match = files.find((f) => normalizePath(f.path) === wanted);
  if (match) return [match];
  if (files.length === 0) return [{ path: metadataPath, content }];
  return [];
}

/**
 * Resolve `rel` under `root`, or null when the result is not a plain file path
 * inside the root (absolute, empty, or escaping via `..`).
 */
export function safeProductPath(root: string, rel: string): string | null {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel)) return null;
  const rootAbs = path.resolve(root);
  const resolved = path.resolve(rootAbs, rel);
  const relative = path.relative(rootAbs, resolved);
  if (!relative || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  if (segments.some((s) => s === "" || s === "." || s === "..")) return null;
  return resolved;
}
