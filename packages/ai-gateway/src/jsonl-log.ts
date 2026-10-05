/**
 * An append-only file of JSON lines that nothing may be lost from: the ledger of money, and the control plane's log.
 *
 * Each batch is written and synced before the calls that made it are told, appends that arrive together share one sync,
 * a last line cut short by a crash is dropped when the file opens, an unreadable line anywhere else stops the open rather
 * than be skipped (a record of money, or of who was given what, is not skipped), one process writes a file at a time, and a
 * failed write stops the log for good: memory and the file may no longer agree, and only a restart replays the file.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

/** Files this process holds a lock on. A lock file naming our own pid that is not in here was left by an earlier life of this pid. */
const heldLocks = new Set<string>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class JsonlLog<T> {
  failure: Error | undefined;
  /** Bytes of a cut-off last line that were dropped when the file was opened. */
  truncatedTailBytes = 0;
  private handle: fs.promises.FileHandle | undefined;
  private pending: Array<{ line: string; resolve: () => void; reject: (err: unknown) => void }> = [];
  private writing: Promise<void> | undefined;
  private readonly lockFile: string;
  protected readonly file: string;

  /**
   * `what` names the file in messages ("the ledger", "the control log") and `records` what is in it, for the sentence that says
   * why a damaged line stops the open.
   */
  constructor(
    file: string,
    private readonly what = "the ledger",
    private readonly records = "a record of money",
  ) {
    this.file = path.resolve(file);
    this.lockFile = `${this.file}.lock`;
  }

  async load(): Promise<T[]> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.acquireLock();
    try {
      const entries = this.read();
      this.handle = await fs.promises.open(this.file, "a");
      return entries;
    } catch (err) {
      this.releaseLock();
      throw err;
    }
  }

  private read(): T[] {
    if (!fs.existsSync(this.file)) return [];
    const raw = fs.readFileSync(this.file, "utf8");
    const lines = raw.split("\n");
    // Whatever follows the last newline is an append that was cut short, or nothing.
    const tail = lines.pop() ?? "";
    const entries: T[] = [];
    lines.forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        entries.push(JSON.parse(line) as T);
      } catch {
        // Not a torn write (those are only ever last): a record is not skipped, so the process does not start.
        throw new Error(`${this.what} ${this.file} has an unreadable line (line ${i + 1}); refusing to start rather than skip ${this.records}. Restore the file from a backup, or repair that line`);
      }
    });
    if (tail.trim() !== "") {
      try {
        // Cut after the closing brace, before the newline: the entry is whole, so keep it and finish the line.
        entries.push(JSON.parse(tail) as T);
        fs.appendFileSync(this.file, "\n");
      } catch {
        // Cut mid-entry. It was never acknowledged to anyone; drop it so the next append starts on a clean line.
        this.truncatedTailBytes = Buffer.byteLength(tail);
        fs.truncateSync(this.file, Buffer.byteLength(raw) - this.truncatedTailBytes);
      }
    }
    return entries;
  }

  private acquireLock(): void {
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, "wx");
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        heldLocks.add(this.lockFile);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const pid = Number(fs.readFileSync(this.lockFile, "utf8").trim());
      const ours = pid === process.pid && heldLocks.has(this.lockFile);
      if (ours || (Number.isInteger(pid) && pid !== process.pid && isAlive(pid))) {
        throw new Error(`${this.what} ${this.file} is in use by process ${pid}; one process writes it at a time (if none is running, delete ${this.lockFile})`);
      }
      // Its owner is gone: a crash left it.
      fs.rmSync(this.lockFile, { force: true });
    }
  }

  private releaseLock(): void {
    if (!heldLocks.delete(this.lockFile)) return;
    fs.rmSync(this.lockFile, { force: true });
  }

  /** Resolves when the entry is durable. */
  append(entry: T): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    if (!this.handle) return Promise.reject(new Error(`${this.what} is not open`));
    return new Promise<void>((resolve, reject) => {
      this.pending.push({ line: `${JSON.stringify(entry)}\n`, resolve, reject });
      this.writing ??= this.drain();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0);
        try {
          await this.handle!.appendFile(batch.map((b) => b.line).join(""), "utf8");
          await this.handle!.sync();
          for (const b of batch) b.resolve();
        } catch (err) {
          this.failure = err instanceof Error ? err : new Error(String(err));
          for (const b of batch) b.reject(this.failure);
          for (const b of this.pending.splice(0)) b.reject(this.failure);
        }
      }
    } finally {
      this.writing = undefined;
    }
  }

  /** Every entry, in order, including what was appended a moment ago. */
  async *scan(): AsyncGenerator<T, void> {
    await this.writing;
    if (!fs.existsSync(this.file)) return;
    const lines = readline.createInterface({ input: fs.createReadStream(this.file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.trim() === "") continue;
      try {
        yield JSON.parse(line) as T;
      } catch {
        // The cut-off tail of a write still in flight; everything before it has been yielded.
        return;
      }
    }
  }

  async close(): Promise<void> {
    await this.writing;
    const handle = this.handle;
    this.handle = undefined;
    await handle?.close();
    this.releaseLock();
  }
}
