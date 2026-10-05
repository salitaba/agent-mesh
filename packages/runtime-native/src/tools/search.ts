import * as fs from "fs";
import * as path from "path";
import { confine } from "./confine";
import { ToolFailure, boolArg, intArg, stringArg, type NativeTool, type ToolContext } from "./types";

/**
 * Glob and Grep, in plain Node: no `find`, no `rg`, so a seat's search tools behave the same on a laptop and in a minimal
 * container, and never depend on a binary the image might not carry.
 */

/** Directories not searched unless the caller points into one or names it in a pattern. */
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const MAX_VISITED = 50_000;
export const MAX_GLOB_RESULTS = 500;
export const DEFAULT_GREP_LIMIT = 250;
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MATCH_LINE_CHARS = 500;

const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * A glob as a regular expression over a `/`-separated path. `*` stays within a path segment, `**` crosses them (`a/**\/b`
 * matches `a/b`), `?` is one character, `[a-z]` and `[!a-z]` are classes, `{a,b}` alternates and nests.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; ) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i += 2;
        if (glob[i] === "/") {
          re += "(?:[^/]+/)*";
          i++;
        } else re += ".*";
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith("!")) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, "\\\\")}]`;
        i = close + 1;
      }
    } else if (c === "{") {
      braces++;
      re += "(?:";
      i++;
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
      i++;
    } else if (c === "," && braces > 0) {
      re += "|";
      i++;
    } else if (c === "\\" && i + 1 < glob.length) {
      re += escapeRe(glob[i + 1]!);
      i += 2;
    } else {
      re += escapeRe(c);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

interface Entry {
  /** Absolute path. */
  file: string;
  /** Path relative to the walk's root, `/`-separated. */
  rel: string;
  mtimeMs: number;
  size: number;
}

/** Every regular file under `root`, depth first. Symlinked directories are not entered, so a loop cannot trap the walk. */
function walk(root: string, includeSkipped: boolean, signal: AbortSignal): { files: Entry[]; truncated: boolean } {
  const files: Entry[] = [];
  let visited = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (signal.aborted) break;
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? 1 : -1)); // popped from the end, so reversed here keeps listings in name order
    for (const e of entries) {
      if (++visited > MAX_VISITED) return { files, truncated: true };
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!includeSkipped && SKIPPED_DIRS.has(e.name)) continue;
        stack.push(abs);
      } else if (e.isFile() || e.isSymbolicLink()) {
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) continue;
          files.push({ file: abs, rel: path.relative(root, abs).split(path.sep).join("/"), mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // A dangling link: nothing to list.
        }
      }
    }
  }
  return { files, truncated: false };
}

/** A path as the model should see it: relative to its workspace when it is inside it. */
export function shownPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function searchRoot(args: Record<string, unknown>, ctx: ToolContext): string {
  const given = stringArg(args, "path");
  const root = given && given !== "" ? confine(given, ctx.cwd, ctx.readRoots, "read") : confine(".", ctx.cwd, ctx.readRoots, "read");
  try {
    fs.statSync(root);
  } catch {
    throw new ToolFailure(`Path does not exist: ${given ?? "."}`);
  }
  return root;
}

export const globTool: NativeTool = {
  spec: {
    name: "Glob",
    description:
      "Find files by name pattern. Supports ** (any depth), * (within a name), ? and {a,b}: **/*.ts, src/**/test_*.py, *.{json,yaml}. " +
      "Returns paths, most recently modified first, at most 500. .git and node_modules are not searched.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob, matched against paths relative to the search directory." },
        path: { type: "string", description: "The directory to search. Defaults to your workspace." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = stringArg(args, "pattern", { required: true })!;
    const root = searchRoot(args, ctx);
    if (fs.statSync(root).isFile()) throw new ToolFailure("path must be a directory");
    const matcher = globToRegExp(pattern.replace(/^\.\//, ""));
    const { files, truncated } = walk(root, pattern.includes("node_modules") || pattern.includes(".git"), ctx.signal);
    const hits = files.filter((f) => matcher.test(f.rel)).sort((a, b) => b.mtimeMs - a.mtimeMs || (a.rel < b.rel ? -1 : 1));
    if (hits.length === 0) return { text: `No files match ${pattern}${truncated ? " (the search stopped after 50,000 entries)" : ""}.` };
    const shown = hits.slice(0, MAX_GLOB_RESULTS).map((f) => shownPath(f.file, ctx.cwd));
    const more = hits.length > MAX_GLOB_RESULTS ? `\n[${hits.length - MAX_GLOB_RESULTS} more not shown: narrow the pattern.]` : truncated ? "\n[The search stopped after 50,000 entries.]" : "";
    return { text: shown.join("\n") + more };
  },
};

const FILE_TYPES: Record<string, string[]> = {
  js: [".js", ".mjs", ".cjs", ".jsx"],
  ts: [".ts", ".tsx", ".mts", ".cts"],
  py: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  c: [".c", ".h"],
  cpp: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".h"],
  md: [".md", ".markdown"],
  json: [".json"],
  yaml: [".yaml", ".yml"],
  html: [".html", ".htm"],
  css: [".css", ".scss"],
  sh: [".sh", ".bash"],
};

export const grepTool: NativeTool = {
  spec: {
    name: "Grep",
    description:
      "Search file contents with a regular expression (JavaScript syntax). output_mode is files_with_matches (default: the paths), content (matching lines, with line numbers) or count. " +
      "Narrow with path, glob (*.ts) or type (ts, js, py, go, rust, java, md, json, yaml). Binary files, files over 2 MB, .git and node_modules are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The regular expression." },
        path: { type: "string", description: "A file or directory. Defaults to your workspace." },
        glob: { type: "string", description: "Only files whose name matches, for example *.ts or src/**/*.py." },
        type: { type: "string", description: "Only files of this type: ts, js, py, go, rust, java, c, cpp, md, json, yaml, html, css, sh." },
        output_mode: { type: "string", enum: ["files_with_matches", "content", "count"] },
        "-i": { type: "boolean", description: "Ignore case." },
        "-n": { type: "boolean", description: "Show line numbers in content mode. On by default." },
        "-A": { type: "integer", description: "Lines of context after each match (content mode)." },
        "-B": { type: "integer", description: "Lines of context before each match (content mode)." },
        "-C": { type: "integer", description: "Lines of context before and after each match (content mode)." },
        multiline: { type: "boolean", description: "Let . match newlines and a pattern span lines." },
        head_limit: { type: "integer", description: "Show at most this many lines or entries. Defaults to 250." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = stringArg(args, "pattern", { required: true })!;
    const mode = stringArg(args, "output_mode") ?? "files_with_matches";
    if (!["files_with_matches", "content", "count"].includes(mode)) throw new ToolFailure("output_mode must be files_with_matches, content or count");
    const multiline = boolArg(args, "multiline") === true;
    const ignoreCase = boolArg(args, "-i") === true;
    const lineNumbers = boolArg(args, "-n") !== false;
    const around = intArg(args, "-C", { min: 0, max: 50 });
    const before = intArg(args, "-B", { min: 0, max: 50 }) ?? around ?? 0;
    const after = intArg(args, "-A", { min: 0, max: 50 }) ?? around ?? 0;
    const limit = intArg(args, "head_limit", { min: 1 }) ?? DEFAULT_GREP_LIMIT;
    const type = stringArg(args, "type");
    if (type !== undefined && !FILE_TYPES[type]) throw new ToolFailure(`type must be one of ${Object.keys(FILE_TYPES).join(", ")}`);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, `${ignoreCase ? "i" : ""}${multiline ? "ms" : ""}g`);
    } catch (err) {
      throw new ToolFailure(`invalid regular expression: ${(err as Error).message}`);
    }
    const root = searchRoot(args, ctx);
    const single = fs.statSync(root).isFile();
    const globText = stringArg(args, "glob");
    // A glob with no slash names a file at any depth, as `rg -g` does; one with a slash is a path from the search root.
    const globRe = globText ? globToRegExp(globText.includes("/") ? globText.replace(/^\.\//, "") : `**/${globText}`) : undefined;

    const candidates: Entry[] = single
      ? [{ file: root, rel: path.basename(root), mtimeMs: 0, size: fs.statSync(root).size }]
      : walk(root, false, ctx.signal).files;
    candidates.sort((a, b) => (a.rel < b.rel ? -1 : 1));

    const out: string[] = [];
    let skipped = 0;
    let capped = false;
    let matchedFiles = 0;
    for (const entry of candidates) {
      if (ctx.signal.aborted) break;
      if (globRe && !globRe.test(entry.rel)) continue;
      if (type && !FILE_TYPES[type]!.includes(path.extname(entry.file).toLowerCase())) continue;
      if (entry.size > MAX_GREP_FILE_BYTES) {
        skipped++;
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(entry.file);
      } catch {
        continue;
      }
      if (buffer.subarray(0, 4096).includes(0)) {
        skipped++;
        continue;
      }
      const text = buffer.toString("utf8");
      const shown = shownPath(entry.file, ctx.cwd);
      const lines = text.split("\n");
      const hitLines = new Set<number>();
      if (multiline) {
        regex.lastIndex = 0;
        for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
          const startLine = text.slice(0, m.index).split("\n").length - 1;
          const span = m[0].split("\n").length - 1;
          for (let l = startLine; l <= startLine + span; l++) hitLines.add(l);
          if (m[0] === "") regex.lastIndex++;
        }
      } else {
        for (let l = 0; l < lines.length; l++) {
          regex.lastIndex = 0;
          if (regex.test(lines[l]!)) hitLines.add(l);
        }
      }
      if (hitLines.size === 0) continue;
      matchedFiles++;
      if (mode === "files_with_matches") out.push(shown);
      else if (mode === "count") out.push(`${shown}:${hitLines.size}`);
      else {
        const sorted = [...hitLines].sort((a, b) => a - b);
        const shownLines = new Set<number>();
        for (const l of sorted) for (let k = Math.max(0, l - before); k <= Math.min(lines.length - 1, l + after); k++) shownLines.add(k);
        let prev = -2;
        for (const l of [...shownLines].sort((a, b) => a - b)) {
          if (prev !== -2 && l !== prev + 1 && (before > 0 || after > 0)) out.push("--");
          const sep = hitLines.has(l) ? ":" : "-";
          let content = lines[l]!.replace(/\r$/, "");
          if (content.length > MAX_MATCH_LINE_CHARS) content = `${content.slice(0, MAX_MATCH_LINE_CHARS)}…`;
          out.push(lineNumbers ? `${shown}${sep}${l + 1}${sep}${content}` : `${shown}${sep}${content}`);
          prev = l;
        }
      }
      if (out.length >= limit * 4) {
        capped = true;
        break;
      }
    }
    if (matchedFiles === 0) return { text: `No matches for ${pattern}${skipped > 0 ? ` (${skipped} file(s) skipped: binary or over 2 MB)` : ""}.` };
    const shownOut = out.slice(0, limit);
    const notes: string[] = [];
    if (out.length > limit || capped) notes.push(`[output cut at ${limit}; narrow the search or raise head_limit]`);
    if (skipped > 0) notes.push(`[${skipped} file(s) skipped: binary or over 2 MB]`);
    return { text: [...shownOut, ...notes].join("\n") };
  },
};
