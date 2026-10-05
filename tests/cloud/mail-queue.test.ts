import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DeliveryError, QueuedMailer, type Mail, type Mailer, type QueuedMailerOptions } from "../../packages/cloud/src/index";

const T0 = Date.parse("2026-10-05T12:00:00.000Z");
const mail = (n: number | string = 1): Mail => ({ to: `person${n}@example.com`, kind: "verify", subject: `Confirm your email address (${n})`, text: `Open https://app.example.com/verify?token=secret-token-${n}` });

/** A transport that does what a test says on each try, and keeps what it was given and what it took. */
class Scripted implements Mailer {
  readonly attempts: Mail[] = [];
  readonly sent: Mail[] = [];
  constructor(private behave: (mail: Mail, attempt: number) => void | Promise<void> = () => undefined) {}
  async send(m: Mail): Promise<void> {
    this.attempts.push(m);
    await this.behave(m, this.attempts.length);
    this.sent.push(m);
  }
}

const REFUSED_FOR_GOOD = (): never => {
  throw new DeliveryError("the server answered 550 5.1.1 no such user (to the recipient)", true, false);
};
const TRY_AGAIN = (): never => {
  throw new DeliveryError("the server answered 452 4.2.2 mailbox full (to the recipient)", false, false);
};
const SERVICE_DOWN = (): never => {
  throw new DeliveryError("could not connect to smtp.example.com:587: connection refused", false, true);
};

interface Rig {
  dir: string;
  transport: Scripted;
  clock: () => Date;
  advance(ms: number): void;
  logs: Array<{ level: string; msg: string; [k: string]: unknown }>;
  open(over?: Partial<QueuedMailerOptions>): Promise<QueuedMailer>;
  files(sub: string): string[];
}

async function rig(run: (r: Rig) => Promise<void>, behave?: (m: Mail, n: number) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mailq-"));
  let t = T0;
  const transport = new Scripted(behave);
  const logs: Rig["logs"] = [];
  const clock = (): Date => new Date(t);
  const r: Rig = {
    dir,
    transport,
    clock,
    advance: (ms) => void (t += ms),
    logs,
    open: (over = {}) => QueuedMailer.open({ transport, dir, clock, firstDelayMs: 1_000, maxDelayMs: 5_000, giveUpMs: 60_000, stuckAfterMs: 10_000, log: (rec) => logs.push(rec), ...over }),
    files: (sub) => (fs.existsSync(path.join(dir, sub)) ? fs.readdirSync(path.join(dir, sub)).sort() : []),
  };
  try {
    await run(r);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const until = async (ok: () => boolean, ms = 3_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(ok(), "it did not come to pass in time");
};

test("a message is on disk, whole, readable by its owner alone, before send returns; and nothing has been sent", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    const names = r.files("queue");
    assert.equal(names.length, 1);
    assert.match(names[0]!, /^20261005T120000000Z-[0-9a-f]{8}\.json$/);
    const file = path.join(r.dir, "queue", names[0]!);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { v: 1, queuedAt: "2026-10-05T12:00:00.000Z", mail: mail(1) });
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.join(r.dir, "queue")).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(r.dir, "failed")).mode & 0o777, 0o700);
    }
    assert.deepEqual(
      fs.readdirSync(path.join(r.dir, "queue")).filter((n) => n.endsWith(".tmp")),
      [],
      "no half-written file is left",
    );
    assert.equal(r.transport.attempts.length, 0, "a queue that was not started does not deliver");
    assert.deepEqual(q.stats(), { queued: 1, failed: 0, oldestQueuedAt: "2026-10-05T12:00:00.000Z", stuck: false });
  });
});

test("a message that is delivered is removed from disk, and what is kept of it says when, to whom and what for, and not what it said", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    r.advance(250);
    assert.deepEqual(await q.deliverDue(), { delivered: 1, setAside: 0, retrying: 0 });
    assert.deepEqual(r.transport.sent, [mail(1)]);
    assert.deepEqual(r.files("queue"), []);
    const lines = fs.readFileSync(path.join(r.dir, "sent.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.match(entry.id, /^20261005T120000000Z-[0-9a-f]{8}$/);
    assert.deepEqual({ ...entry, id: undefined }, { at: "2026-10-05T12:00:00.250Z", id: undefined, to: "person1@example.com", kind: "verify", outcome: "delivered", attempts: 1 });
    // The link in the message signed someone in: nothing on disk keeps it once it has been delivered.
    const everything = [...fs.readdirSync(r.dir, { recursive: true, encoding: "utf8" })].map((rel) => path.join(r.dir, rel)).filter((f) => fs.statSync(f).isFile());
    for (const f of everything) assert.ok(!fs.readFileSync(f, "utf8").includes("secret-token-1"), `${f} holds the link`);
    assert.deepEqual(q.stats(), { queued: 0, failed: 0, stuck: false });
  });
});

test("messages are delivered oldest first, whatever order the files are read in", async () => {
  await rig(async (r) => {
    const q = await r.open();
    for (const n of [3, 1, 2]) {
      await q.send(mail(n));
      r.advance(10);
    }
    await q.deliverDue();
    assert.deepEqual(
      r.transport.sent.map((m) => m.to),
      ["person3@example.com", "person1@example.com", "person2@example.com"],
    );
  });
});

test("two messages queued in the same millisecond are both kept, and every one of many sent at once is delivered once", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await Promise.all(Array.from({ length: 25 }, (_, i) => q.send(mail(i))));
    assert.equal(new Set(r.files("queue")).size, 25);
    await q.deliverDue();
    assert.equal(r.transport.sent.length, 25);
    assert.equal(new Set(r.transport.sent.map((m) => m.to)).size, 25);
    assert.deepEqual(r.files("queue"), []);
  });
});

test("a message the service will take later is tried again after a wait that doubles to a limit, and not before", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    // Waits after each failure: 1 s, 2 s, 4 s, then no more than 5 s.
    for (const wait of [1_000, 2_000, 4_000, 5_000, 5_000]) {
      const before = r.transport.attempts.length;
      assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 1 }, `try ${before + 1}`);
      assert.equal(r.transport.attempts.length, before + 1);
      r.advance(wait - 1);
      assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 0 }, "a moment too soon");
      assert.equal(r.transport.attempts.length, before + 1);
      r.advance(1);
    }
    assert.equal(q.stats().queued, 1);
    assert.equal(r.files("failed").length, 0);
  }, TRY_AGAIN);
});

test("a message that fails for its own reasons does not hold back the ones behind it", async () => {
  await rig(
    async (r) => {
      const q = await r.open();
      for (const n of [1, 2, 3]) {
        await q.send(mail(n));
        r.advance(1);
      }
      assert.deepEqual(await q.deliverDue(), { delivered: 2, setAside: 0, retrying: 1 });
      assert.deepEqual(
        r.transport.sent.map((m) => m.to),
        ["person2@example.com", "person3@example.com"],
      );
      assert.equal(q.stats().queued, 1);
    },
    (m) => {
      if (m.to === "person1@example.com") TRY_AGAIN();
    },
  );
});

test("trouble in reaching the service holds every message back, one probe at a time, with a wait that doubles; and it is over when one gets through", async () => {
  let up = false;
  await rig(
    async (r) => {
      const q = await r.open();
      for (const n of [1, 2, 3]) {
        await q.send(mail(n));
        r.advance(1);
      }
      // First probe: only the oldest is tried, and the others are not.
      assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 1 });
      assert.deepEqual(
        r.transport.attempts.map((m) => m.to),
        ["person1@example.com"],
      );
      // Nothing is tried while the hold lasts, however often it is asked.
      r.advance(999);
      assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 0 });
      assert.equal(r.transport.attempts.length, 1);
      // Then one more probe, and the wait is doubled.
      r.advance(1);
      assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 1 });
      assert.equal(r.transport.attempts.length, 2);
      r.advance(1_999);
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, 2, "two seconds this time");
      r.advance(1);
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, 3);
      // The service is back: the oldest goes, and the rest follow in the same pass.
      up = true;
      r.advance(4_000);
      assert.deepEqual(await q.deliverDue(), { delivered: 3, setAside: 0, retrying: 0 });
      assert.deepEqual(
        r.transport.sent.map((m) => m.to),
        ["person1@example.com", "person2@example.com", "person3@example.com"],
      );
      // And the next trouble starts from the short wait again.
      up = false;
      await q.send(mail(4));
      await q.deliverDue();
      const tried = r.transport.attempts.length;
      r.advance(1_000);
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, tried + 1, "after the first wait, not the longest one");
    },
    () => {
      if (!up) SERVICE_DOWN();
    },
  );
});

test("the wait during trouble does not grow beyond its limit", async () => {
  await rig(async (r) => {
    const q = await r.open({ giveUpMs: 10 * 60_000 });
    await q.send(mail(1));
    const waits = [1_000, 2_000, 4_000, 5_000, 5_000, 5_000];
    for (const wait of waits) {
      const before = r.transport.attempts.length;
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, before + 1);
      r.advance(wait - 1);
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, before + 1, `still waiting after ${wait - 1} ms`);
      r.advance(1);
    }
  }, SERVICE_DOWN);
});

test("a recipient that does not exist is set aside at once, with the reason, and is not tried again", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    const [name] = r.files("queue");
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 1, retrying: 0 });
    assert.deepEqual(r.files("queue"), []);
    assert.deepEqual(r.files("failed"), [name]);
    const kept = JSON.parse(fs.readFileSync(path.join(r.dir, "failed", name!), "utf8"));
    assert.deepEqual(kept, { v: 1, queuedAt: "2026-10-05T12:00:00.000Z", failedAt: "2026-10-05T12:00:00.000Z", reason: "the server answered 550 5.1.1 no such user (to the recipient)", attempts: 1, mail: mail(1) });
    const entry = JSON.parse(fs.readFileSync(path.join(r.dir, "sent.jsonl"), "utf8").trim());
    assert.equal(entry.outcome, "failed");
    assert.equal(entry.reason, "the server answered 550 5.1.1 no such user (to the recipient)");
    assert.ok(!JSON.stringify(entry).includes("secret-token"));
    r.advance(10 * 60_000);
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 0 });
    assert.equal(r.transport.attempts.length, 1);
    assert.deepEqual(q.stats(), { queued: 0, failed: 1, lastError: { at: "2026-10-05T12:00:00.000Z", error: "the server answered 550 5.1.1 no such user (to the recipient)" }, stuck: false });
  }, REFUSED_FOR_GOOD);
});

test("a message that has not been delivered after the time allowed is set aside, and says how long it was tried for", async () => {
  await rig(async (r) => {
    const q = await r.open({ giveUpMs: 3 * 60 * 60_000, maxDelayMs: 60 * 60_000 });
    await q.send(mail(1));
    await q.deliverDue();
    r.advance(2 * 60 * 60_000 + 59 * 60_000);
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 1 }, "not yet");
    r.advance(61 * 60_000);
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 1, retrying: 0 });
    const kept = JSON.parse(fs.readFileSync(path.join(r.dir, "failed", r.files("failed")[0]!), "utf8"));
    assert.equal(kept.reason, "not delivered after 4 hours: the server answered 452 4.2.2 mailbox full (to the recipient)");
    assert.equal(kept.attempts, 3);
  }, TRY_AGAIN);
});

test("a message that cannot be delivered because the service is down is set aside at the same limit, and the others wait on the service as before", async () => {
  await rig(async (r) => {
    const q = await r.open({ giveUpMs: 60 * 60_000, maxDelayMs: 30 * 60_000 });
    await q.send(mail(1));
    r.advance(1);
    await q.send(mail(2));
    await q.deliverDue();
    r.advance(61 * 60_000);
    // The oldest has been waiting longer than the limit: it is set aside, and the service being down still holds back the next.
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 1, retrying: 0 });
    assert.equal(r.transport.attempts.length, 2);
    assert.match(fs.readFileSync(path.join(r.dir, "failed", r.files("failed")[0]!), "utf8"), /not delivered after 1 hours?|not delivered after 61 minutes/);
    assert.equal(q.stats().queued, 1);
  }, SERVICE_DOWN);
});

test("an error that is not a delivery error is taken to be trouble with the service", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    await q.send(mail(2));
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 1 });
    assert.equal(r.transport.attempts.length, 1, "and the other message is not tried on top of it");
    assert.equal(q.stats().lastError?.error, "the mail transport fell over");
  }, () => {
    throw new Error("the mail transport fell over");
  });
});

test("what is waiting when the process ends is waiting when it starts again, and a message is not lost to a crash", async () => {
  await rig(async (r) => {
    const first = await r.open();
    for (const n of [1, 2]) {
      await first.send(mail(n));
      r.advance(5);
    }
    // The process ends here. A new one opens the same folder.
    const second = await r.open();
    assert.equal(second.stats().queued, 2);
    assert.equal(second.stats().oldestQueuedAt, "2026-10-05T12:00:00.000Z", "it keeps the time the message was queued, not the time it was read");
    assert.deepEqual(await second.deliverDue(), { delivered: 2, setAside: 0, retrying: 0 });
    assert.deepEqual(
      r.transport.sent.map((m) => m.to),
      ["person1@example.com", "person2@example.com"],
    );
    assert.ok(r.logs.some((l) => l.msg === "mail was waiting from before the last stop" && l.queued === 2));
  });
});

test("a message that was being sent when the process ended is sent again at the next start: at least once, never zero", async () => {
  await rig(async (r) => {
    let release: (() => void) | undefined;
    const stuck = new Scripted(() => new Promise<void>((resolve) => (release = resolve)));
    const first = await r.open({ transport: stuck });
    await first.send(mail(1));
    const pass = first.deliverDue();
    await until(() => stuck.attempts.length === 1);
    // The first process is gone: what it was sending is still on disk, and a new process sends it.
    const second = await r.open();
    assert.deepEqual(await second.deliverDue(), { delivered: 1, setAside: 0, retrying: 0 });
    assert.deepEqual(r.transport.sent, [mail(1)]);
    release?.();
    await pass;
  });
});

test("what a crash left behind is dealt with: a half-written file goes, a file that cannot be read is set aside, and one already set aside is not sent", async () => {
  await rig(async (r) => {
    const q0 = await r.open();
    for (const n of [1, 2, 3]) {
      await q0.send(mail(n));
      r.advance(1);
    }
    const [a, b, c] = r.files("queue");
    const kept = JSON.parse(fs.readFileSync(path.join(r.dir, "queue", c!), "utf8")).mail as Mail;
    fs.writeFileSync(path.join(r.dir, "queue", ".20261005T120000000Z-deadbeef.json.tmp"), '{"v":1,"queued');
    fs.writeFileSync(path.join(r.dir, "queue", a!), "{ this is not json");
    fs.writeFileSync(path.join(r.dir, "queue", "notes.txt"), "an operator's note");
    fs.copyFileSync(path.join(r.dir, "queue", b!), path.join(r.dir, "failed", b!));
    const q = await r.open();
    assert.deepEqual(r.files("queue"), [c!, "notes.txt"].sort(), "the half-written file is gone, the unreadable one moved, the one already set aside removed, and the operator's note left alone");
    assert.deepEqual(r.files("failed"), [a!, b!].sort());
    assert.ok(r.logs.some((l) => l.level === "error" && /could not be read/.test(l.msg)));
    assert.deepEqual(await q.deliverDue(), { delivered: 1, setAside: 0, retrying: 0 });
    assert.deepEqual(r.transport.sent, [kept]);
    assert.equal(q.stats().failed, 2);
  });
});

test("a file that holds something else than a message is set aside, not delivered", async () => {
  await rig(async (r) => {
    const q0 = await r.open();
    fs.writeFileSync(path.join(r.dir, "queue", "a.json"), JSON.stringify({ v: 1, queuedAt: "x", mail: { to: "a@example.com" } }));
    fs.writeFileSync(path.join(r.dir, "queue", "b.json"), JSON.stringify({ v: 1, queuedAt: "x", mail: { to: 1, subject: "s", text: "t", kind: "k" } }));
    fs.writeFileSync(path.join(r.dir, "queue", "c.json"), "null");
    fs.writeFileSync(path.join(r.dir, "queue", "d.json"), JSON.stringify({ v: 1, mail: mail(4) }));
    const q = await r.open();
    void q0;
    assert.deepEqual(r.files("queue"), ["d.json"]);
    assert.deepEqual(r.files("failed"), ["a.json", "b.json", "c.json"]);
    assert.equal(q.stats().oldestQueuedAt, "2026-10-05T12:00:00.000Z", "a message with no time is taken to have been queued when it was found");
    await q.deliverDue();
    assert.deepEqual(r.transport.sent, [mail(4)]);
  });
});

test("started, the queue delivers by itself as messages come, and tries again by itself after a failure", async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "mailq-real-"));
  try {
    const transport = new Scripted((_m, n) => {
      if (n <= 2) TRY_AGAIN();
    });
    const q = await QueuedMailer.open({ transport, dir: real, firstDelayMs: 20, maxDelayMs: 40 });
    q.start();
    await q.send(mail(1));
    await until(() => transport.sent.length === 1);
    assert.equal(transport.attempts.length, 3, "two refusals and then it was taken");
    await until(() => fs.readdirSync(path.join(real, "queue")).length === 0);
    await q.send(mail(2));
    await until(() => transport.sent.length === 2);
    await q.stop();
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("started, the queue delivers what was waiting from before, and stopped, it queues without delivering until it is started again", async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "mailq-real-"));
  try {
    const transport = new Scripted();
    const before = await QueuedMailer.open({ transport: new Scripted(), dir: real });
    await before.send(mail(1));
    const q = await QueuedMailer.open({ transport, dir: real, firstDelayMs: 20, maxDelayMs: 40 });
    q.start();
    await until(() => transport.sent.length === 1);
    await q.stop();
    await q.send(mail(2));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(transport.attempts.length, 1, "stopped, nothing is tried");
    assert.equal(fs.readdirSync(path.join(real, "queue")).length, 1, "but the message is kept");
    q.start();
    await until(() => transport.sent.length === 2);
    await q.stop();
    assert.deepEqual(q.stats().queued, 0);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("stopping waits for a try in progress only as long as it is told to", async () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "mailq-real-"));
  try {
    const transport = new Scripted(() => new Promise<void>(() => undefined));
    const q = await QueuedMailer.open({ transport, dir: real });
    q.start();
    await q.send(mail(1));
    await until(() => transport.attempts.length === 1);
    const started = Date.now();
    await q.stop(60);
    const took = Date.now() - started;
    assert.ok(took >= 50 && took < 1_000, `stopped after ${took} ms`);
    assert.equal(fs.readdirSync(path.join(real, "queue")).length, 1, "what was being sent stays, to be sent at the next start");
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("the numbers an operator watches: what is waiting, what was set aside, how long the oldest has waited, what the last failure said", async () => {
  let fail = true;
  await rig(
    async (r) => {
      const q = await r.open({ stuckAfterMs: 10_000 });
      assert.deepEqual(q.stats(), { queued: 0, failed: 0, stuck: false });
      await q.send(mail(1));
      r.advance(5_000);
      await q.send(mail(2));
      await q.deliverDue();
      r.advance(4_000);
      assert.deepEqual(q.stats(), { queued: 2, failed: 0, oldestQueuedAt: "2026-10-05T12:00:00.000Z", lastError: { at: "2026-10-05T12:00:05.000Z", error: "could not connect to smtp.example.com:587: connection refused" }, stuck: false });
      r.advance(1_001);
      assert.equal(q.stats().stuck, true, "the oldest has waited longer than 10 seconds");
      r.advance(-1);
      assert.equal(q.stats().stuck, false, "and exactly 10 seconds is not yet");
      r.advance(1);
      // It goes through: the failure is forgotten.
      fail = false;
      r.advance(5_000);
      await q.deliverDue();
      assert.deepEqual(q.stats(), { queued: 0, failed: 0, stuck: false });
    },
    () => {
      if (fail) SERVICE_DOWN();
    },
  );
});

test("the process log says what happened to a message by its name and kind, and never by its address or its words", async () => {
  let n = 0;
  await rig(
    async (r) => {
      const q = await r.open();
      await q.send(mail(1));
      await q.deliverDue();
      r.advance(10_000);
      await q.deliverDue();
      r.advance(10_000);
      await q.deliverDue();
      const text = JSON.stringify(r.logs);
      assert.ok(r.logs.length >= 3);
      assert.ok(!text.includes("person1@example.com") && !text.includes("secret-token") && !text.includes("Confirm your email"), text);
      assert.ok(r.logs.every((l) => typeof l.id === "string" || l.msg === "mail was waiting from before the last stop"));
      assert.deepEqual(
        r.logs.map((l) => [l.level, l.msg]),
        [
          ["warn", "mail could not be delivered, and nothing is tried until the service answers"],
          ["warn", "mail could not be delivered, and nothing is tried until the service answers"],
          ["info", "mail delivered"],
        ],
      );
      assert.ok(r.logs.every((l) => l.kind === "verify"));
    },
    () => {
      if (++n <= 2) SERVICE_DOWN();
    },
  );
});

test("a message whose file cannot be removed after delivery is not sent again in this run", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    const file = path.join(r.dir, "queue", r.files("queue")[0]!);
    // A directory where the file was: removing it fails.
    fs.rmSync(file);
    fs.mkdirSync(file);
    assert.deepEqual(await q.deliverDue(), { delivered: 1, setAside: 0, retrying: 0 });
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 0 });
    assert.equal(r.transport.attempts.length, 1);
    assert.ok(r.logs.some((l) => l.level === "error" && /could not be removed; it will be sent again at the next start/.test(l.msg)));
    assert.equal(q.stats().queued, 0);
  });
});

test("a message that cannot be set aside stays where it was for the next start, and is not tried again in this run", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    fs.rmSync(path.join(r.dir, "failed"), { recursive: true });
    fs.writeFileSync(path.join(r.dir, "failed"), "in the way");
    await q.deliverDue();
    assert.equal(r.files("queue").length, 1, "its file is still in the queue");
    assert.ok(r.logs.some((l) => l.level === "error" && /could not be set aside/.test(l.msg)));
    r.advance(60_000);
    await q.deliverDue();
    assert.equal(r.transport.attempts.length, 1);
    assert.equal(q.stats().failed, 0);
  }, REFUSED_FOR_GOOD);
});

test("send fails, and keeps nothing in memory, when the message cannot be written", async () => {
  await rig(async (r) => {
    const q = await r.open();
    fs.rmSync(path.join(r.dir, "queue"), { recursive: true });
    fs.writeFileSync(path.join(r.dir, "queue"), "in the way");
    await assert.rejects(() => q.send(mail(1)));
    assert.equal(q.stats().queued, 0);
    assert.deepEqual(
      fs.readdirSync(r.dir).filter((n) => n.endsWith(".tmp")),
      [],
    );
  });
});

test("the mail log is only a record: failing to write it does not fail a delivery", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    fs.mkdirSync(path.join(r.dir, "sent.jsonl"));
    assert.deepEqual(await q.deliverDue(), { delivered: 1, setAside: 0, retrying: 0 });
    assert.ok(r.logs.some((l) => l.level === "warn" && /the mail log could not be written/.test(l.msg)));
    assert.deepEqual(r.files("queue"), []);
  });
});

// ---- what it does when nothing is said: the waits, the day, the hour, and how a time is put in words ----

test("with nothing said the first wait is 30 seconds, each is twice the one before, and none is longer than 15 minutes", async () => {
  await rig(async (r) => {
    const q = await r.open({ firstDelayMs: undefined, maxDelayMs: undefined, giveUpMs: undefined, stuckAfterMs: undefined });
    await q.send(mail(1));
    for (const wait of [30, 60, 120, 240, 480, 900, 900]) {
      const before = r.transport.attempts.length;
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, before + 1);
      r.advance(wait * 1_000 - 1);
      await q.deliverDue();
      assert.equal(r.transport.attempts.length, before + 1, `still waiting after ${wait} seconds less a millisecond`);
      r.advance(1);
    }
  }, TRY_AGAIN);
});

test("with nothing said a message is set aside when it is a day old, and mail is stuck when the oldest has waited more than an hour", async () => {
  const day = 24 * 60 * 60_000;
  await rig(async (r) => {
    const q = await r.open({ firstDelayMs: undefined, maxDelayMs: undefined, giveUpMs: undefined, stuckAfterMs: undefined });
    await q.send(mail(1));
    r.advance(day - 1);
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 0, retrying: 1 }, "a millisecond short of a day it is still tried");
    assert.equal(q.stats().stuck, true);
  }, TRY_AGAIN);
  await rig(async (r) => {
    const q = await r.open({ firstDelayMs: undefined, maxDelayMs: undefined, giveUpMs: undefined, stuckAfterMs: undefined });
    await q.send(mail(1));
    r.advance(day);
    assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 1, retrying: 0 }, "and at a day it is set aside");
  }, TRY_AGAIN);
  await rig(async (r) => {
    const q = await r.open({ firstDelayMs: undefined, maxDelayMs: undefined, giveUpMs: undefined, stuckAfterMs: undefined });
    await q.send(mail(1));
    r.advance(60 * 60_000);
    assert.equal(q.stats().stuck, false, "an hour is not more than an hour");
    r.advance(1);
    assert.equal(q.stats().stuck, true);
  });
});

test("the time a message was tried for is said in words that fit it: seconds, minutes or hours, with the change at two of the next unit", async () => {
  const MIN = 60_000;
  const cases: Array<[number, string]> = [
    [90_000, "90 seconds"],
    [119_000, "119 seconds"],
    [2 * MIN, "2 minutes"],
    [5 * MIN, "5 minutes"],
    [90 * MIN, "90 minutes"],
    [119 * MIN, "119 minutes"],
    [120 * MIN, "2 hours"],
    [24 * 60 * MIN, "24 hours"],
  ];
  for (const [ms, words] of cases) {
    await rig(async (r) => {
      const q = await r.open({ giveUpMs: ms, maxDelayMs: ms });
      await q.send(mail(1));
      r.advance(ms);
      assert.deepEqual(await q.deliverDue(), { delivered: 0, setAside: 1, retrying: 0 });
      const kept = JSON.parse(fs.readFileSync(path.join(r.dir, "failed", r.files("failed")[0]!), "utf8"));
      assert.equal(kept.reason, `not delivered after ${words}: the server answered 452 4.2.2 mailbox full (to the recipient)`);
    }, TRY_AGAIN);
  }
});

// ---- the rest of what it says, and the order of those that came together ----

test("a time of more than two hours is said in hours, rounded to the nearest", async () => {
  const MIN = 60_000;
  for (const [ms, words] of [[149 * MIN, "2 hours"], [150 * MIN, "3 hours"], [26 * 60 * MIN + 29 * MIN, "26 hours"], [26 * 60 * MIN + 30 * MIN, "27 hours"]] as Array<[number, string]>) {
    await rig(async (r) => {
      const q = await r.open({ giveUpMs: ms, maxDelayMs: ms });
      await q.send(mail(1));
      r.advance(ms);
      await q.deliverDue();
      assert.match(JSON.parse(fs.readFileSync(path.join(r.dir, "failed", r.files("failed")[0]!), "utf8")).reason, new RegExp(`^not delivered after ${words}: `), `${ms} ms`);
    }, TRY_AGAIN);
  }
});

test("what is logged of a refusal that will be tried again, a message set aside, and what was waiting at the start, says which and why", async () => {
  await rig(async (r) => {
    const q = await r.open();
    await q.send(mail(1));
    await q.deliverDue();
    const again = r.logs.find((l) => l.msg === "mail was refused, and is tried again later")!;
    assert.deepEqual([again.level, again.kind, again.attempts, again.error, again.retryAt], ["warn", "verify", 1, "the server answered 452 4.2.2 mailbox full (to the recipient)", "2026-10-05T12:00:01.000Z"]);
    assert.match(String(again.id), /^20261005T120000000Z-[0-9a-f]{8}$/);
    await q.send(mail(2));
    r.advance(1_000);
    await q.deliverDue();
  }, (m) => {
    if (m.to === "person1@example.com") TRY_AGAIN();
    if (m.to === "person2@example.com") REFUSED_FOR_GOOD();
  });
  await rig(async (r) => {
    const q0 = await r.open();
    await q0.send(mail(1));
    const q = await r.open();
    const waiting = r.logs.find((l) => l.msg === "mail was waiting from before the last stop");
    assert.deepEqual([waiting?.level, waiting?.queued], ["info", 1], "one message is enough to be said");
    await q.deliverDue();
    const aside = r.logs.find((l) => l.msg === "mail was set aside, and will not be tried again")!;
    assert.deepEqual([aside.level, aside.kind, aside.attempts, aside.reason], ["error", "verify", 1, "the server answered 550 5.1.1 no such user (to the recipient)"]);
  }, REFUSED_FOR_GOOD);
});

test("a file that cannot be read says why in the log, and a message with a time that is not a time is taken to have been queued when it was found", async () => {
  await rig(async (r) => {
    const q0 = await r.open();
    fs.writeFileSync(path.join(r.dir, "queue", "a.json"), "{ not json");
    fs.writeFileSync(path.join(r.dir, "queue", "b.json"), JSON.stringify({ v: 1, queuedAt: "2026", mail: { to: "x@example.com" } }));
    fs.writeFileSync(path.join(r.dir, "queue", "c.json"), JSON.stringify({ v: 1, queuedAt: "not a time at all", mail: mail(3) }));
    const q = await r.open();
    void q0;
    const said = r.logs.filter((l) => l.level === "error" && /could not be read/.test(l.msg)).map((l) => [l.id, l.error]);
    assert.equal(said.length, 2);
    assert.match(String(said.find((s) => s[0] === "a")![1]), /JSON/);
    assert.equal(said.find((s) => s[0] === "b")![1], "it holds no message");
    assert.equal(q.stats().oldestQueuedAt, "2026-10-05T12:00:00.000Z", "found now, and so queued now");
    await q.deliverDue();
    assert.deepEqual(r.transport.sent, [mail(3)]);
  });
});

test("messages that came in the same millisecond are tried in the order of their names, whatever order they were queued in", async () => {
  await rig(async (r) => {
    const q = await r.open();
    for (let i = 0; i < 12; i++) await q.send(mail(i));
    const order = r.files("queue").map((name) => JSON.parse(fs.readFileSync(path.join(r.dir, "queue", name), "utf8")).mail.to);
    await q.deliverDue();
    assert.deepEqual(
      r.transport.attempts.map((m) => m.to),
      order,
    );
  });
});
