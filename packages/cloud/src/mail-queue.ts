/**
 * Mail that waits for delivery: it is on disk before the caller is told it is sent, and it stays until a service has taken it.
 *
 * The control plane sends mail while it answers a person: a sign-up, a reset. If that waited on a mail provider, a provider
 * that is slow or down would make sign-up slow or fail, and a restart at the wrong moment would lose a confirmation link. So
 * `send` only writes the message to a file and returns; a worker delivers it, and tries again if the service does not take it.
 *
 * The spool is a folder:
 *
 *   queue/<id>.json    a message waiting. Written whole to a temporary name and renamed, so a crash leaves it complete or absent.
 *   failed/<id>.json   a message set aside, with the reason. Nothing reads it again; it is for the operator.
 *   sent.jsonl         a line for each message that was delivered or set aside: when, to whom, what for. Never the text.
 *
 * A message holds a link that signs someone in, so it is kept no longer than it is needed: a delivered message's file is removed
 * and the log holds no text. Files are readable by their owner alone.
 *
 * It promises that a message is delivered at least once. One that was being sent when the process ended is sent again at the
 * next start and can arrive twice; one that was queued is not lost. It does not promise order.
 *
 * When it tries again:
 *   - the service refuses this message for good (the recipient does not exist): the message is set aside at once;
 *   - trouble in reaching or using the service (it is down, the sign-in failed, the sender is refused): nothing is tried for a
 *     while, for any message, and the wait doubles with each failure up to a limit, so one probe goes to a service that is down
 *     and not one for every message that is waiting;
 *   - any other refusal: this message is tried again after a wait that doubles.
 *   A message not delivered after a day is set aside: the link in it has expired.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DeliveryError, type Mail, type Mailer } from "./mailer";

export interface QueuedMailerOptions {
  /** What delivers one message now, or throws. */
  transport: Mailer;
  /** The folder mail waits in. It is made if it is not there. */
  dir: string;
  clock?: () => Date;
  /** The wait after the first failure; it doubles after each. Default 30 seconds. */
  firstDelayMs?: number;
  /** The longest wait. Default 15 minutes. */
  maxDelayMs?: number;
  /** How long a message is tried for before it is set aside. Default 24 hours. */
  giveUpMs?: number;
  /** How long the oldest message may wait before the queue is called stuck. Default one hour. */
  stuckAfterMs?: number;
  /** What happened to a message. Never the text, and never the address. */
  log?: (record: { level: "info" | "warn" | "error"; msg: string; [field: string]: unknown }) => void;
}

export interface MailStats {
  /** Messages waiting for delivery. */
  queued: number;
  /** Messages set aside, in the folder `failed/`, that nobody has removed. */
  failed: number;
  oldestQueuedAt?: string;
  /** What the last failed try said, until a delivery works. */
  lastError?: { at: string; error: string };
  /** The oldest message has waited longer than `stuckAfterMs`: mail is not getting out. */
  stuck: boolean;
}

interface Item {
  id: string;
  mail: Mail;
  queuedAt: number;
  attempts: number;
  /** When it may be tried next, in ms. */
  nextAt: number;
}

const MINUTE = 60_000;
const DEFAULT_FIRST_DELAY_MS = 30_000;
const DEFAULT_MAX_DELAY_MS = 15 * MINUTE;
const DEFAULT_GIVE_UP_MS = 24 * 60 * MINUTE;
const DEFAULT_STUCK_AFTER_MS = 60 * MINUTE;

/** A length of time in words a person can use: `24 hours`, `90 minutes`, `45 seconds`. */
const since = (ms: number): string => {
  const hours = Math.round(ms / (60 * MINUTE));
  if (ms >= 2 * 60 * MINUTE) return `${hours} hours`;
  const minutes = Math.round(ms / MINUTE);
  return ms >= 2 * MINUTE ? `${minutes} minutes` : `${Math.round(ms / 1_000)} seconds`;
};

const isMail = (m: unknown): m is Mail => {
  const r = m as Record<string, unknown> | null;
  return r !== null && typeof r === "object" && typeof r.to === "string" && typeof r.subject === "string" && typeof r.text === "string" && typeof r.kind === "string";
};

async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await fs.promises.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not every platform can sync a directory; the file itself was synced.
  }
}

/** The file holds all of `text` on disk, or it is not there: written to another name, synced, and renamed into place. */
async function writeWhole(file: string, text: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.tmp`);
  try {
    const handle = await fs.promises.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.promises.rename(temporary, file);
  } catch (err) {
    await fs.promises.unlink(temporary).catch(() => undefined);
    throw err;
  }
  await syncDirectory(path.dirname(file));
}

export class QueuedMailer implements Mailer {
  private readonly queueDir: string;
  private readonly failedDir: string;
  private readonly sentLog: string;
  private readonly items = new Map<string, Item>();
  private failed = 0;
  private lastError: { at: number; error: string } | undefined;
  /** Nothing is tried before this, in ms: the service is in trouble. */
  private hold = 0;
  private troubles = 0;
  private running: Promise<void> | undefined;
  private again = false;
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;

  private constructor(private readonly o: QueuedMailerOptions) {
    this.queueDir = path.join(o.dir, "queue");
    this.failedDir = path.join(o.dir, "failed");
    this.sentLog = path.join(o.dir, "sent.jsonl");
  }

  /** Open the spool and read what is waiting in it. */
  static async open(o: QueuedMailerOptions): Promise<QueuedMailer> {
    const queue = new QueuedMailer(o);
    await queue.load();
    return queue;
  }

  private now(): number {
    return (this.o.clock ?? (() => new Date()))().getTime();
  }

  private log(level: "info" | "warn" | "error", msg: string, fields: Record<string, unknown> = {}): void {
    this.o.log?.({ level, msg, ...fields });
  }

  private async load(): Promise<void> {
    await fs.promises.mkdir(this.queueDir, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.failedDir, { recursive: true, mode: 0o700 });
    for (const name of (await fs.promises.readdir(this.queueDir)).sort()) {
      const file = path.join(this.queueDir, name);
      // A write that was cut short by the end of the process: the message was never promised to anyone.
      if (name.endsWith(".tmp")) {
        await fs.promises.unlink(file).catch(() => undefined);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        // Set aside already, and not yet removed from the queue: the process ended between the two.
        if (fs.existsSync(path.join(this.failedDir, name))) {
          await fs.promises.unlink(file);
          continue;
        }
        const record = JSON.parse(await fs.promises.readFile(file, "utf8")) as { queuedAt?: unknown; mail?: unknown };
        if (!isMail(record.mail)) throw new Error("it holds no message");
        const queuedAt = typeof record.queuedAt === "string" && Number.isFinite(Date.parse(record.queuedAt)) ? Date.parse(record.queuedAt) : this.now();
        this.items.set(id, { id, mail: record.mail, queuedAt, attempts: 0, nextAt: 0 });
      } catch (err) {
        this.log("error", "a file in the mail queue could not be read, and is set aside", { id, error: (err as Error).message });
        await fs.promises.rename(file, path.join(this.failedDir, name)).catch(() => undefined);
      }
    }
    this.failed = (await fs.promises.readdir(this.failedDir)).filter((n) => n.endsWith(".json")).length;
    if (this.items.size > 0) this.log("info", "mail was waiting from before the last stop", { queued: this.items.size });
  }

  /** The message is on disk when this returns. It is delivered as soon as the service takes it, which is not before this returns. */
  async send(mail: Mail): Promise<void> {
    const at = new Date(this.now());
    const id = `${at.toISOString().replace(/[-:.]/g, "")}-${randomBytes(4).toString("hex")}`;
    await writeWhole(path.join(this.queueDir, `${id}.json`), `${JSON.stringify({ v: 1, queuedAt: at.toISOString(), mail: { to: mail.to, subject: mail.subject, text: mail.text, kind: mail.kind } })}\n`);
    this.items.set(id, { id, mail: { ...mail }, queuedAt: at.getTime(), attempts: 0, nextAt: 0 });
    if (this.started && !this.stopped) void this.pass();
  }

  /** Begin delivering what is waiting, now and as time passes. */
  start(): void {
    if (this.started && !this.stopped) return;
    this.started = true;
    this.stopped = false;
    void this.pass();
  }

  /** Stop trying. What is waiting stays in its files and is tried at the next start. A try in progress is given `graceMs` to end. */
  async stop(graceMs = 2_000): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([this.running ?? Promise.resolve(), new Promise<void>((resolve) => (timeout = setTimeout(resolve, graceMs)))]);
    clearTimeout(timeout);
  }

  /** Resolves when no delivery is in progress. */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  stats(): MailStats {
    const oldest = Math.min(...[...this.items.values()].map((i) => i.queuedAt));
    const waiting = this.items.size > 0;
    return {
      queued: this.items.size,
      failed: this.failed,
      ...(waiting ? { oldestQueuedAt: new Date(oldest).toISOString() } : {}),
      ...(this.lastError ? { lastError: { at: new Date(this.lastError.at).toISOString(), error: this.lastError.error } } : {}),
      stuck: waiting && this.now() - oldest > (this.o.stuckAfterMs ?? DEFAULT_STUCK_AFTER_MS),
    };
  }

  /** A pass over what is due, run now or by the timer, never two at once. It does not throw. */
  private pass(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.deliverDue();
        } while (this.again && !this.stopped);
      } catch (err) {
        this.log("error", "the mail queue could not run a pass", { error: err instanceof Error ? err.message : String(err) });
      } finally {
        this.running = undefined;
        this.arm();
      }
    })();
    return this.running;
  }

  /** Try each message that is due, oldest first, until the service is in trouble. Returns how many were delivered, set aside and left to be tried again. */
  async deliverDue(): Promise<{ delivered: number; setAside: number; retrying: number }> {
    const result = { delivered: 0, setAside: 0, retrying: 0 };
    if (this.now() < this.hold) return result;
    const due = [...this.items.values()].filter((i) => i.nextAt <= this.now()).sort((a, b) => a.queuedAt - b.queuedAt || a.id.localeCompare(b.id));
    for (const item of due) {
      if (this.stopped) break;
      const outcome = await this.attempt(item);
      result[outcome === "delivered" ? "delivered" : outcome === "set aside" ? "setAside" : "retrying"] += 1;
      // The service is in trouble: what is left is not tried on top of it.
      if (this.now() < this.hold) break;
    }
    return result;
  }

  private delayFor(failures: number): number {
    return Math.min(this.o.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, (this.o.firstDelayMs ?? DEFAULT_FIRST_DELAY_MS) * 2 ** Math.min(Math.max(failures - 1, 0), 30));
  }

  private async attempt(item: Item): Promise<"delivered" | "set aside" | "retrying"> {
    item.attempts += 1;
    try {
      await this.o.transport.send(item.mail);
    } catch (err) {
      const e = err instanceof DeliveryError ? err : new DeliveryError(err instanceof Error ? err.message : String(err), false, true);
      const now = this.now();
      this.lastError = { at: now, error: e.message };
      const age = now - item.queuedAt;
      if (e.transport) {
        // Whatever the message, the service is what is wrong: every message waits, and the wait grows while it stays wrong.
        this.troubles += 1;
        this.hold = now + this.delayFor(this.troubles);
        this.log("warn", "mail could not be delivered, and nothing is tried until the service answers", { id: item.id, kind: item.mail.kind, error: e.message, retryAt: new Date(this.hold).toISOString() });
      } else item.nextAt = now + this.delayFor(item.attempts);
      if (e.permanent) await this.setAside(item, e.message);
      else if (age >= (this.o.giveUpMs ?? DEFAULT_GIVE_UP_MS)) await this.setAside(item, `not delivered after ${since(age)}: ${e.message}`);
      else {
        if (!e.transport) this.log("warn", "mail was refused, and is tried again later", { id: item.id, kind: item.mail.kind, attempts: item.attempts, error: e.message, retryAt: new Date(item.nextAt).toISOString() });
        return "retrying";
      }
      return "set aside";
    }
    // The service has it. From here nothing may bring it back: the file goes first, and the log is only a record.
    this.items.delete(item.id);
    this.troubles = 0;
    this.hold = 0;
    this.lastError = undefined;
    await fs.promises.unlink(path.join(this.queueDir, `${item.id}.json`)).catch((err: Error) => this.log("error", "a delivered message's file could not be removed; it will be sent again at the next start", { id: item.id, error: err.message }));
    await this.record({ id: item.id, to: item.mail.to, kind: item.mail.kind, outcome: "delivered", attempts: item.attempts });
    this.log("info", "mail delivered", { id: item.id, kind: item.mail.kind, attempts: item.attempts });
    return "delivered";
  }

  private async setAside(item: Item, reason: string): Promise<void> {
    this.items.delete(item.id);
    const name = `${item.id}.json`;
    try {
      await writeWhole(path.join(this.failedDir, name), `${JSON.stringify({ v: 1, queuedAt: new Date(item.queuedAt).toISOString(), failedAt: new Date(this.now()).toISOString(), reason, attempts: item.attempts, mail: item.mail })}\n`);
      await fs.promises.unlink(path.join(this.queueDir, name));
      this.failed += 1;
    } catch (err) {
      // It stays where it was, and is tried once more at the next start. It is not tried again in this run.
      this.log("error", "a message could not be set aside", { id: item.id, error: (err as Error).message });
    }
    await this.record({ id: item.id, to: item.mail.to, kind: item.mail.kind, outcome: "failed", attempts: item.attempts, reason });
    this.log("error", "mail was set aside, and will not be tried again", { id: item.id, kind: item.mail.kind, attempts: item.attempts, reason });
  }

  private async record(entry: Record<string, unknown>): Promise<void> {
    try {
      await fs.promises.appendFile(this.sentLog, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch (err) {
      this.log("warn", "the mail log could not be written", { error: (err as Error).message });
    }
  }

  /** Set the timer for the next time something is due. */
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.stopped || this.items.size === 0) return;
    const next = Math.min(...[...this.items.values()].map((i) => Math.max(i.nextAt, this.hold)));
    // Never sooner than a moment, so that nothing that goes wrong can become a loop that spins; never later than a timer can count.
    const wait = Math.min(Math.max(next - this.now(), 50), 2 ** 31 - 1);
    this.timer = setTimeout(() => void this.pass(), wait);
    this.timer.unref();
  }
}
