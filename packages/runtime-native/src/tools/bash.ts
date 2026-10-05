import { spawn, type ChildProcess } from "child_process";
import { ToolFailure, intArg, stringArg, type NativeTool } from "./types";

/**
 * Bash: run a command in the seat's workspace and report what it printed and how it ended.
 *
 * What a seat can do here is what its operating-system user can do; the capability gate decides WHETHER a seat gets a shell
 * (and, for a commit-only seat, which command), and the container around a hosted workspace decides what the shell can
 * reach. This file's job is to make the call safe to make: bounded in time, bounded in output, and unable to leave a process
 * behind.
 */

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
const HEAD_CHARS = 20_000;
const TAIL_CHARS = 10_000;
/** How long a command that was told to stop is given before it is killed outright. */
const KILL_GRACE_MS = 2_000;
/** How long to wait for output still in the pipe after the command has exited. */
const DRAIN_MS = 250;

/** The first and last part of a command's output, and how much was dropped between them. Memory stays bounded however much it prints. */
class Capture {
  private head = "";
  private tail = "";
  omitted = 0;

  push(text: string): void {
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (text === "") return;
    this.tail += text;
    if (this.tail.length > TAIL_CHARS) {
      this.omitted += this.tail.length - TAIL_CHARS;
      this.tail = this.tail.slice(this.tail.length - TAIL_CHARS);
    }
  }

  toString(): string {
    return this.omitted > 0 ? `${this.head}\n[... ${this.omitted} characters omitted ...]\n${this.tail}` : this.head + this.tail;
  }
}

export interface ShellOutcome {
  output: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

export function runShell(command: string, opts: { cwd: string; env: Record<string, string>; timeoutMs: number; signal: AbortSignal }): Promise<ShellOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-c", command], { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const capture = new Capture();
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let escalate: NodeJS.Timeout | undefined;

    const stop = (): void => {
      killGroup(child, "SIGTERM");
      escalate ??= setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, opts.timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      opts.signal.removeEventListener("abort", onAbort);
      // Whatever the command left running (a server it started, a background job) dies with it.
      killGroup(child, "SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ output: capture.toString(), code, signal, timedOut, aborted });
    };

    child.stdout?.setEncoding("utf8").on("data", (d: string) => capture.push(d));
    child.stderr?.setEncoding("utf8").on("data", (d: string) => capture.push(d));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalate) clearTimeout(escalate);
      opts.signal.removeEventListener("abort", onAbort);
      reject(new ToolFailure(`could not start a shell: ${err.message}`));
    });
    child.on("exit", (code, signal) => {
      // Output written just before exit may still be in the pipe; give it a moment, then stop waiting for a backgrounded
      // child that holds the pipe open.
      const drain = setTimeout(() => finish(code, signal), DRAIN_MS);
      child.on("close", () => {
        clearTimeout(drain);
        finish(code, signal);
      });
    });
  });
}

export const bashTool: NativeTool = {
  spec: {
    name: "Bash",
    description:
      "Run a shell command in your workspace and get its output (stdout and stderr together) and exit code. " +
      "Each call is a fresh shell: a cd or an exported variable does not carry to the next call, so chain what belongs together with &&. " +
      "There is no terminal and no stdin: a command that waits for input gets none. The default timeout is 120 seconds, the longest 600. " +
      "Anything the command leaves running is killed when it returns. Long output is cut in the middle: pipe through head, tail or grep to see what you need.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout: { type: "integer", description: "Milliseconds before the command is killed. At most 600000." },
        description: { type: "string", description: "A few words on what the command is for." },
      },
      required: ["command"],
    },
  },
  async run(args, ctx) {
    if (process.platform === "win32") throw new ToolFailure("Bash is not available on Windows.");
    const command = stringArg(args, "command", { required: true })!;
    const timeoutMs = intArg(args, "timeout", { min: 1, max: MAX_TIMEOUT_MS }) ?? DEFAULT_TIMEOUT_MS;
    const r = await runShell(command, { cwd: ctx.cwd, env: ctx.shellEnv, timeoutMs, signal: ctx.signal });
    const notes: string[] = [];
    if (r.timedOut) notes.push(`[timed out after ${Math.round(timeoutMs / 1000)}s and was killed]`);
    else if (r.aborted) notes.push("[stopped: the mesh ended this turn]");
    else if (r.signal) notes.push(`[killed by ${r.signal}]`);
    else if (r.code !== 0) notes.push(`[exit code: ${r.code}]`);
    const body = r.output === "" && notes.length === 0 ? "(no output)" : r.output;
    const lead = notes.length > 0 && body !== "" && !body.endsWith("\n") ? `${body}\n` : body;
    // A command that ran and failed has still checked something (that is what a failing test is); only one that did not
    // run to its end is a failed call.
    return { text: lead + notes.join("\n"), isError: r.timedOut || r.aborted };
  },
};
