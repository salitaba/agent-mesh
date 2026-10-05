import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { USAGE, main, type Io } from "../../apps/cloud-server/src/index";
import { ENV, workdir } from "./control-support";
import { FakeSmtp, decodeBody, headersOf, type FakeOptions } from "./smtp-support";

function io(): Io & { stdout: string[]; stderr: string[]; signals: EventEmitter } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => void stdout.push(l), err: (l) => void stderr.push(l), signals: new EventEmitter() };
}

const SERVER: FakeOptions = { features: ["AUTH PLAIN"], credentials: { user: ENV.SMTP_USER, password: ENV.SMTP_PASSWORD } };

const toServer =
  (port: number, over: Record<string, unknown> = {}) =>
  (raw: Record<string, any>): void => {
    raw.mail = { smtp: { host: "127.0.0.1", port, security: "none", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD", from: "Curule <no-reply@curule.example>", ...over } };
  };

async function check(server: FakeOptions, args: string[] = ["--to", "ada@example.com"], env: NodeJS.ProcessEnv = ENV, over: Record<string, unknown> = {}) {
  const smtp = await FakeSmtp.start(server);
  const port = smtp.port;
  const w = workdir(toServer(port, over));
  try {
    const out = io();
    const code = await main(["mail-check", "--config", w.file, ...args], env, out);
    return { code, out, smtp, port };
  } finally {
    w.done();
    await smtp.stop();
  }
}

test("the usage names the mail check", () => {
  assert.match(USAGE, /mail-check --config <control\.yaml> --to <address>\s+send one message through the configured mail server/);
});

test("a message is sent through the mail server the configuration names, now, and the command says how, and what to look for when it arrives", async () => {
  const { code, out, smtp, port } = await check(SERVER);
  assert.equal(code, 0);
  assert.equal(out.stderr.length, 0);
  assert.equal(out.stdout.length, 2);
  assert.match(out.stdout[0]!, new RegExp(`^sending one message to ada@example\\.com through 127\\.0\\.0\\.1:${port} \\(not encrypted, signed in\\), from Curule <no-reply@curule\\.example>$`));
  assert.match(out.stdout[1]!, /^the mail server accepted the message\. Look for it in the inbox of ada@example\.com, and in its spam folder: .*SPF and DKIM/);
  assert.equal(smtp.accepted.length, 1);
  const got = smtp.accepted[0]!;
  assert.equal(got.user, ENV.SMTP_USER);
  assert.deepEqual(got.to, ["ada@example.com"]);
  assert.equal(headersOf(got.data).get("subject"), "Curule Cloud mail check");
  assert.match(decodeBody(got.data), /sent by `curule-cloud mail-check` to find out whether the control plane's mail reaches ada@example\.com/);
  for (const secret of [ENV.SMTP_PASSWORD, ENV.SMTP_USER]) assert.ok(!out.stdout.join("\n").includes(secret), "no credential is shown");
});

test("only the mail is read: a service that is not ready for customers in any other way can still have its mail proved", async () => {
  const smtp = await FakeSmtp.start(SERVER);
  const w = workdir(toServer(smtp.port));
  try {
    fs.writeFileSync(path.join(w.dir, "pages", "terms.html"), "<p>TODO(owner): the terms</p>\n");
    const whole = io();
    assert.equal(await main(["control", "--config", w.file, "--check"], ENV, whole), 1, "the whole configuration is refused: a production licence key this build does not trust, and a page still to be written");
    const out = io();
    assert.equal(await main(["mail-check", "--config", w.file, "--to", "ada@example.com"], ENV, out), 0);
    assert.equal(smtp.accepted.length, 1);
  } finally {
    w.done();
    await smtp.stop();
  }
});

test("a mail server that refuses the sign-in is reported as trouble with the server, in its own words, with nothing sent", async () => {
  const { code, out, smtp } = await check(SERVER, undefined, { ...ENV, SMTP_PASSWORD: "not-the-password" });
  assert.equal(code, 1);
  assert.equal(out.stderr.length, 2);
  assert.match(out.stderr[0]!, /^the mail server did not take the message: the server answered 535 5\.7\.8 credentials rejected \(to the sign-in\)$/);
  assert.match(out.stderr[1]!, /^This is about reaching or using the mail server \(its address, how the connection is encrypted, the account\), not about the message\. Nothing was sent\.$/);
  assert.equal(smtp.accepted.length, 0);
  assert.ok(!out.stderr.join("\n").includes("not-the-password"));
});

test("a recipient the server will not take, and a message it will not take, are each said apart from trouble with the server", async () => {
  const noUser = await check({ ...SERVER, answer: (v) => (v === "RCPT" ? "550 5.1.1 no such user" : undefined) });
  assert.equal(noUser.code, 1);
  assert.match(noUser.out.stderr[0]!, /the server answered 550 5\.1\.1 no such user \(to the recipient\)/);
  assert.equal(noUser.out.stderr[1], "The server says this recipient cannot be sent to: try another address.");
  const spam = await check({ ...SERVER, answer: (v) => (v === "BODY" ? "554 5.7.1 rejected as spam" : undefined) });
  assert.equal(spam.code, 1);
  assert.match(spam.out.stderr[0]!, /the server answered 554 5\.7\.1 rejected as spam \(to the message\)/);
  assert.equal(spam.out.stderr[1], "The server refused this message, and its answer is above. It may take another.");
});

test("a mail server that is not there is reported as one that could not be reached", async () => {
  const gone = await FakeSmtp.start();
  const port = gone.port;
  await gone.stop();
  const w = workdir(toServer(port));
  try {
    const out = io();
    assert.equal(await main(["mail-check", "--config", w.file, "--to", "ada@example.com"], ENV, out), 1);
    assert.match(out.stderr[0]!, new RegExp(`the mail server did not take the message: could not connect to 127\\.0\\.0\\.1:${port}`));
    assert.match(out.stderr[1]!, /^This is about reaching or using the mail server/);
  } finally {
    w.done();
  }
});

test("an address that mail cannot be sent to is refused before the server is spoken to", async () => {
  const { code, out, smtp } = await check(SERVER, ["--to", "ada@example.com\r\nRCPT TO:<eve@example.net>"]);
  assert.equal(code, 1);
  assert.match(out.stderr.join("\n"), /^curule-cloud mail-check: 'ada@example\.com {2}RCPT TO:<eve@example\.net>' is not an address mail can be sent to/);
  assert.equal(smtp.transcripts.length, 0);
});

test("a configuration that writes mail to a file says that there is nothing to check", async () => {
  const w = workdir((raw) => (raw.mail = { outbox: "./data/outbox.jsonl" }));
  try {
    const out = io();
    assert.equal(await main(["mail-check", "--config", w.file, "--to", "ada@example.com"], ENV, out), 1);
    assert.match(out.stderr.join("\n"), /writes mail to a file \(mail\.outbox\) and sends none\. Set mail\.smtp to deliver it, and check again/);
  } finally {
    w.done();
  }
});

test("a mistake in the mail settings is said with the file it is in, and warnings of a mail server that is not encrypted are shown", async () => {
  const w = workdir((raw) => (raw.mail = { smtp: { host: "smtp.mail.example", security: "none", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD", from: "nobody" } }));
  try {
    const out = io();
    assert.equal(await main(["mail-check", "--config", w.file, "--to", "ada@example.com"], ENV, out), 1);
    const text = out.stderr.join("\n");
    assert.match(text, /mail\.smtp\.from 'nobody' is not an address/);
    assert.match(text, /mail\.smtp\.security is none and the mail server 'smtp\.mail\.example' is not on this machine/);
    assert.ok(text.split("\n").every((l) => l.startsWith(w.file)));
    assert.equal(out.stdout.length, 0);
  } finally {
    w.done();
  }
  const quiet = workdir((raw) => (raw.mail = { smtp: { host: "127.0.0.1", port: 1, security: "none", from: "no-reply@curule.example" } }));
  const loud = workdir((raw) => (raw.mail = { smtp: { host: "smtp.mail.example", port: 1, security: "none", from: "no-reply@curule.example" } }));
  try {
    const out = io();
    await main(["mail-check", "--config", loud.file, "--to", "ada@example.com"], ENV, out);
    assert.match(out.stderr[0]!, /^WARNING: mail\.smtp\.security is none for 'smtp\.mail\.example'/);
    const none = io();
    await main(["mail-check", "--config", quiet.file, "--to", "ada@example.com"], ENV, none);
    assert.ok(!none.stderr.some((l) => l.startsWith("WARNING")), "a server on this machine is not warned of");
  } finally {
    quiet.done();
    loud.done();
  }
});

test("a command line that cannot be run says why and shows the usage", async () => {
  const a = io();
  assert.equal(await main(["mail-check", "--to", "ada@example.com"], ENV, a), 1);
  assert.equal(a.stderr.join("\n"), `curule-cloud mail-check: --config is required\n${USAGE}`);
  const b = io();
  assert.equal(await main(["mail-check", "--config", "x.yaml"], ENV, b), 1);
  assert.equal(b.stderr.join("\n"), `curule-cloud mail-check: --to is required\n${USAGE}`);
  const c = io();
  assert.equal(await main(["mail-check", "--config", "x.yaml", "--to", "a@example.com", "--check"], ENV, c), 1);
  assert.equal(c.stderr.join("\n"), `curule-cloud mail-check: unknown option '--check'\n${USAGE}`);
  const d = io();
  assert.equal(await main(["mail-check", "--config=x.yaml", "--to=a@example.com"], ENV, d), 1);
  assert.match(d.stderr.join("\n"), /cannot read the control-plane configuration x\.yaml/, "--config=<file> and --to=<address> are the same as with a space");
});
