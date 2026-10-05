import * as fs from "fs";
import * as path from "path";
import { confine, touchesGitDir, realPath, isInside } from "./confine";
import { ToolFailure, boolArg, intArg, stringArg, type NativeTool, type ToolContext, type ToolResult } from "./types";

/**
 * Read, Write and Edit: the three file tools, with the names and the failure wording models already know.
 */

export const MAX_READ_LINES = 2000;
export const MAX_LINE_CHARS = 2000;
export const MAX_READ_CHARS = 60_000;
/** A file past this is read in ranges only. */
export const MAX_WHOLE_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_WRITE_BYTES = 5 * 1024 * 1024;

const looksBinary = (head: Buffer): boolean => head.includes(0);

function statOrFail(file: string, shown: string): fs.Stats {
  try {
    return fs.statSync(file);
  } catch {
    throw new ToolFailure(`File does not exist: ${shown}`);
  }
}

export const readTool: NativeTool = {
  spec: {
    name: "Read",
    description:
      "Read a text file. The result is the file's lines, each prefixed with its line number. " +
      "Reads at most 2000 lines and 60,000 characters at a time: for a larger file pass offset (the line to start at, 1-based) and limit (how many lines), " +
      "or locate what you need with Grep first and read only that range. Directories and binary files cannot be read.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file to read: absolute, or relative to your workspace." },
        offset: { type: "integer", description: "The line to start at, counting from 1." },
        limit: { type: "integer", description: "How many lines to read." },
      },
      required: ["file_path"],
    },
  },
  async run(args, ctx) {
    const shown = stringArg(args, "file_path", { required: true })!;
    const file = confine(shown, ctx.cwd, ctx.readRoots, "read");
    const stat = statOrFail(file, shown);
    if (stat.isDirectory()) throw new ToolFailure(`${shown} is a directory, not a file. List it with Glob or Bash.`);
    const offset = intArg(args, "offset", { min: 1 }) ?? 1;
    const limit = intArg(args, "limit", { min: 1 });
    if (stat.size > MAX_WHOLE_FILE_BYTES && limit === undefined && offset === 1) {
      throw new ToolFailure(`${shown} is ${stat.size} bytes, too large to read whole. Pass offset and limit, or find the lines with Grep.`);
    }
    const buffer = fs.readFileSync(file);
    if (looksBinary(buffer.subarray(0, 8192))) throw new ToolFailure(`${shown} is a binary file (${stat.size} bytes) and cannot be read as text.`);
    const lines = buffer.toString("utf8").split("\n");
    // A trailing newline ends the last line; it does not start another.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length === 0) return { text: `(${shown} is empty)` };
    if (offset > lines.length) throw new ToolFailure(`${shown} has ${lines.length} line(s); offset ${offset} is past the end.`);
    const wanted = Math.min(limit ?? MAX_READ_LINES, MAX_READ_LINES);
    const out: string[] = [];
    let chars = 0;
    let last = offset - 1;
    for (let i = offset - 1; i < lines.length && out.length < wanted; i++) {
      let line = lines[i]!;
      if (line.length > MAX_LINE_CHARS) line = `${line.slice(0, MAX_LINE_CHARS)}… (+${line.length - MAX_LINE_CHARS} chars)`;
      const row = `${String(i + 1).padStart(6)}\t${line}`;
      if (chars + row.length > MAX_READ_CHARS && out.length > 0) break;
      out.push(row);
      chars += row.length + 1;
      last = i + 1;
    }
    const remaining = lines.length - last;
    const note = remaining > 0 ? `\n[${shown}: lines ${offset}-${last} of ${lines.length}. ${remaining} more line(s): call Read again with offset ${last + 1}.]` : "";
    return { text: out.join("\n") + note };
  },
};

function writable(shown: string, ctx: ToolContext): string {
  const file = confine(shown, ctx.cwd, ctx.writeRoots, "write");
  const root = ctx.writeRoots.find((r) => isInside(file, realPath(r)));
  if (root !== undefined && touchesGitDir(file, root)) {
    throw new ToolFailure(`${shown} is inside .git. A repository's own files are changed with git commands, not written.`);
  }
  return file;
}

export const writeTool: NativeTool = {
  spec: {
    name: "Write",
    description:
      "Write a file, creating it and any missing directories, or replacing it whole. To change part of an existing file use Edit, which sends only the change. " +
      "Files are written inside your own workspace.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file to write: absolute, or relative to your workspace." },
        content: { type: "string", description: "The whole content of the file." },
      },
      required: ["file_path", "content"],
    },
  },
  async run(args, ctx) {
    const shown = stringArg(args, "file_path", { required: true })!;
    const content = stringArg(args, "content", { required: true, allowEmpty: true })!;
    if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new ToolFailure(`content is larger than ${MAX_WRITE_BYTES} bytes; write the file in parts.`);
    const file = writable(shown, ctx);
    let existed = false;
    try {
      const stat = fs.statSync(file);
      if (stat.isDirectory()) throw new ToolFailure(`${shown} is a directory.`);
      existed = true;
    } catch (err) {
      if (err instanceof ToolFailure) throw err;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    return { text: `${existed ? "Replaced" : "Created"} ${shown} (${Buffer.byteLength(content, "utf8")} bytes, ${content === "" ? 0 : content.split("\n").length} lines).` };
  },
};

export const editTool: NativeTool = {
  spec: {
    name: "Edit",
    description:
      "Replace text in an existing file. old_string must match the file exactly, including whitespace, and must occur once unless replace_all is true: " +
      "include enough surrounding lines to make it unique. Read the file first so old_string is what is really there.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "The file to edit." },
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: { type: "string", description: "The text to put in its place. Must differ from old_string." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  async run(args, ctx) {
    const shown = stringArg(args, "file_path", { required: true })!;
    const oldString = stringArg(args, "old_string", { required: true })!;
    const newString = stringArg(args, "new_string", { required: true, allowEmpty: true })!;
    const all = boolArg(args, "replace_all") === true;
    if (oldString === newString) throw new ToolFailure("No changes to make: old_string and new_string are exactly the same.");
    const file = writable(shown, ctx);
    const stat = statOrFail(file, shown);
    if (stat.isDirectory()) throw new ToolFailure(`${shown} is a directory.`);
    if (stat.size > MAX_WRITE_BYTES) throw new ToolFailure(`${shown} is too large to edit (${stat.size} bytes).`);
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("\0")) throw new ToolFailure(`${shown} is a binary file and cannot be edited as text.`);
    let count = 0;
    for (let at = text.indexOf(oldString); at !== -1; at = text.indexOf(oldString, at + oldString.length)) count++;
    if (count === 0) throw new ToolFailure(`String to replace not found in file. Read ${shown} again and copy the text exactly, whitespace included.`);
    if (count > 1 && !all) {
      throw new ToolFailure(
        `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, provide more surrounding context to identify the instance.`,
      );
    }
    // A function replacer, so `$&` and `$1` in new_string are the text they look like and not a substitution.
    const next = all ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
    fs.writeFileSync(file, next, "utf8");
    return { text: `Edited ${shown}: replaced ${all ? count : 1} occurrence${(all ? count : 1) === 1 ? "" : "s"}.` } satisfies ToolResult;
  },
};
