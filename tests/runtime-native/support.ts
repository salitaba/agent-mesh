import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolContext } from "../../packages/runtime-native/src/index";

/** A seat's workspace and the product checkout beside it, as real directories. */
export interface Workspace {
  /** The temp directory holding both. */
  base: string;
  /** The seat's own directory. */
  cwd: string;
  /** The product checkout: readable to the seat, never writable. */
  product: string;
  ctx: ToolContext;
  abort: AbortController;
  put(rel: string, content: string | Buffer): string;
  cleanup(): void;
}

export function workspace(files: Record<string, string> = {}): Workspace {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-tools-")));
  const cwd = path.join(base, "ws");
  const product = path.join(base, "main");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(product, { recursive: true });
  const abort = new AbortController();
  const put = (rel: string, content: string | Buffer): string => {
    const file = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  };
  for (const [rel, content] of Object.entries(files)) put(rel, content);
  return {
    base,
    cwd,
    product,
    abort,
    put,
    ctx: {
      cwd,
      readRoots: [cwd, product],
      writeRoots: [cwd],
      shellEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base, TERM: "dumb" },
      signal: abort.signal,
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** Run a tool and return its text, throwing what the runtime would turn into a failed call. */
export async function run(tool: { run(args: Record<string, unknown>, ctx: ToolContext): Promise<{ text: string; isError?: boolean }> }, args: Record<string, unknown>, ws: Workspace) {
  return tool.run(args as never, ws.ctx);
}
