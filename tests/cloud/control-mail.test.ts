import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { MemoryControlStore, startControl } from "../../packages/cloud/src/index";
import { ENV } from "./control-support";
import { APP_HOST, stack } from "./control-stack";
import { FakeProvisioner } from "./support";
import { FakeSmtp, decodeBody, headersOf } from "./smtp-support";
import { PASSWORD, tokenIn } from "./web-support";
import { linkIn } from "./support";

/** The mail settings that reach a fake server on this machine, signing in with the account the tests' environment holds. */
const toServer =
  (port: number) =>
  (raw: Record<string, any>): void => {
    raw.mail = { smtp: { host: "127.0.0.1", port, security: "none", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD", from: "Curule <no-reply@curule.example>" } };
  };

const SERVER = { features: ["AUTH PLAIN"], credentials: { user: ENV.SMTP_USER, password: ENV.SMTP_PASSWORD } };
const ORIGIN = { origin: `https://${APP_HOST}` };

/** A port that nothing listens on: it was a server's, and the server is gone. */
async function closedPort(): Promise<number> {
  const s = await FakeSmtp.start();
  const port = s.port;
  await s.stop();
  return port;
}

const until = async (ok: () => boolean, ms = 4_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
  assert.ok(ok(), "it did not come to pass in time");
};

test("with a mail server configured, a sign-up is answered at once, its confirmation link reaches the server signed in with the account, and the link works", async () => {
  const smtp = await FakeSmtp.start(SERVER);
  const s = await stack({ change: toServer(smtp.port), start: { mailer: undefined } });
  try {
    assert.ok(s.running.mail, "mail goes through a queue");
    const signup = await s.app({ method: "POST", path: "/api/signup", json: { email: "ada@example.com", password: PASSWORD }, headers: ORIGIN });
    assert.equal(signup.status, 202);
    await until(() => smtp.accepted.length === 1);
    const got = smtp.accepted[0]!;
    assert.equal(got.user, ENV.SMTP_USER);
    assert.deepEqual(got.to, ["ada@example.com"]);
    assert.equal(got.from, "no-reply@curule.example");
    const headers = headersOf(got.data);
    assert.equal(headers.get("from"), "Curule <no-reply@curule.example>");
    assert.equal(headers.get("subject"), "Confirm your Curule account");
    const text = decodeBody(got.data);
    assert.match(linkIn(text), /^https:\/\/app\.curule\.example\/verify\?token=/);
    const verified = await s.app({ method: "POST", path: "/api/verify", json: { token: tokenIn(text) }, headers: ORIGIN });
    assert.equal(verified.status, 200, "the link that went by mail is the one the service accepts");
    await until(() => s.running.mail!.stats().queued === 0);
    assert.equal(s.running.mail!.stats().failed, 0);
    assert.equal(fs.readdirSync(path.join(path.dirname(s.config.logPath), "mail", "queue")).length, 0, "nothing is kept of a message that was taken");
  } finally {
    await s.close();
    await smtp.stop();
  }
});

test("a mail server that is down does not make a sign-up fail or wait; the owner is told, and the link is sent when the server is back", async () => {
  const port = await closedPort();
  const s = await stack({ change: toServer(port), start: { mailer: undefined, mailQueue: { firstDelayMs: 40, maxDelayMs: 80, stuckAfterMs: 1_000 } } });
  let smtp: FakeSmtp | undefined;
  try {
    const started = Date.now();
    const signup = await s.app({ method: "POST", path: "/api/signup", json: { email: "ada@example.com", password: PASSWORD }, headers: ORIGIN });
    assert.equal(signup.status, 202, "the sign-up is answered whether or not the mail can be delivered");
    assert.ok(Date.now() - started < 3_000);
    await until(() => s.running.mail!.stats().lastError !== undefined);
    const waiting = await s.owner({ path: "/owner/health" });
    assert.equal(waiting.status, 200);
    assert.equal(waiting.json.mail.queued, 1);
    assert.equal(waiting.json.mail.failed, 0);
    assert.match(waiting.json.mail.lastError.error, new RegExp(`could not connect to 127\\.0\\.0\\.1:${port}`));
    assert.equal(waiting.json.mail.stuck, false);
    assert.equal(waiting.json.ok, true, "a mail server that has been down for a moment is not an alarm");
    // An hour later and the mail is still not out: it is.
    s.clock.now += 61 * 60_000;
    const stuck = await s.owner({ path: "/owner/health" });
    assert.equal(stuck.json.mail.stuck, true);
    assert.equal(stuck.json.ok, false, "the health says it, with the rest of what the operator watches");
    // The server comes back, on the address it was configured with: the link is sent without anything being asked.
    smtp = await FakeSmtp.start({ ...SERVER, port });
    await until(() => smtp!.accepted.length === 1);
    assert.deepEqual(smtp.accepted[0]!.to, ["ada@example.com"]);
    await until(() => s.running.mail!.stats().queued === 0);
    const healed = await s.owner({ path: "/owner/health" });
    assert.deepEqual([healed.json.ok, healed.json.mail.queued, healed.json.mail.stuck, "lastError" in healed.json.mail], [true, 0, false, false]);
  } finally {
    await s.close();
    await smtp?.stop();
  }
});

test("mail that was waiting when the service stopped is sent when it starts again", async () => {
  const port = await closedPort();
  const s = await stack({ change: toServer(port), start: { mailer: undefined, mailQueue: { firstDelayMs: 40, maxDelayMs: 80 } } });
  let smtp: FakeSmtp | undefined;
  let second: Awaited<ReturnType<typeof startControl>> | undefined;
  try {
    assert.equal((await s.app({ method: "POST", path: "/api/signup", json: { email: "ada@example.com", password: PASSWORD }, headers: ORIGIN })).status, 202);
    assert.equal(s.running.mail!.stats().queued, 1);
    await s.running.stop(0);
    assert.equal(fs.readdirSync(path.join(path.dirname(s.config.logPath), "mail", "queue")).length, 1, "the message is on disk");
    smtp = await FakeSmtp.start({ ...SERVER, port });
    second = await startControl(s.config, { store: new MemoryControlStore(), provisioner: new FakeProvisioner(), waitReady: async () => undefined, log: () => undefined, mailQueue: { firstDelayMs: 40, maxDelayMs: 80 } });
    assert.equal(second.mail!.stats().queued >= 0, true);
    await until(() => smtp!.accepted.length === 1);
    assert.deepEqual(smtp.accepted[0]!.to, ["ada@example.com"]);
  } finally {
    await second?.stop(0);
    await s.close();
    await smtp?.stop();
  }
});

test("a stopped control plane has stopped its queue: what is queued after the stop is kept and not sent", async () => {
  const smtp = await FakeSmtp.start(SERVER);
  const s = await stack({ change: toServer(smtp.port), start: { mailer: undefined } });
  try {
    await s.running.stop(0);
    await s.running.mail!.send({ to: "late@example.com", kind: "verify", subject: "Late", text: "after the stop" });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(smtp.accepted.length, 0);
    assert.equal(s.running.mail!.stats().queued, 1);
  } finally {
    await s.close();
    await smtp.stop();
  }
});

test("without a mail server in the configuration, mail is written to the outbox file as before, and there is no queue and no mail in the health", async () => {
  const s = await stack({
    change: (raw) => {
      raw.mail = { outbox: "./data/outbox.jsonl" };
    },
    start: { mailer: undefined },
  });
  try {
    assert.equal(s.running.mail, undefined);
    assert.equal((await s.app({ method: "POST", path: "/api/signup", json: { email: "ada@example.com", password: PASSWORD }, headers: ORIGIN })).status, 202);
    const written = fs.readFileSync(s.config.outboxPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(written.map((m) => [m.to, m.kind]), [["ada@example.com", "verify"]]);
    const health = await s.owner({ path: "/owner/health" });
    assert.equal(health.json.ok, true);
    assert.ok(!("mail" in health.json));
  } finally {
    await s.close();
  }
});

test("a mail folder that cannot be used stops the start with the reason, before anything listens", async () => {
  const port = await closedPort();
  const s = await stack({ change: toServer(port), start: { mailer: undefined } });
  try {
    await s.running.stop(0);
    const spool = s.config.smtp!.spoolDir;
    fs.rmSync(spool, { recursive: true, force: true });
    fs.writeFileSync(spool, "in the way");
    await assert.rejects(() => startControl(s.config, { store: new MemoryControlStore(), provisioner: new FakeProvisioner(), waitReady: async () => undefined, log: () => undefined }), /ENOTDIR|EEXIST|not a directory/i);
  } finally {
    await s.close();
  }
});
