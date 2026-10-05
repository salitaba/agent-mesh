import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, type Duplex } from "node:stream";
import { DeliveryError, SmtpError, SmtpTransport, addressOf, formatMessage, fromHeader, headerValue, mailbox, quotedPrintable, type SmtpOptions } from "../../packages/cloud/src/index";
import { FakeSmtp, decodeBody, decodeWords, hasOpenssl, headersOf, selfSigned, type FakeOptions } from "./smtp-support";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const mail = { to: "ada@example.com", kind: "verify", subject: "Confirm your email address", text: "Open this link to confirm your address:\n\nhttps://app.example.com/verify?token=abc123\n\nIt works once." };

function refusal(fn: () => unknown): SmtpError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof SmtpError, `a SmtpError, not ${String(err)}`);
    return err;
  }
  return assert.fail("it was accepted");
}

async function failure(promise: Promise<unknown>): Promise<SmtpError> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof SmtpError, `a SmtpError, not ${String(err)}`);
    return err;
  }
  return assert.fail("it was delivered");
}

async function withServer<T>(o: FakeOptions, run: (smtp: FakeSmtp) => Promise<T>): Promise<T> {
  const smtp = await FakeSmtp.start(o);
  try {
    return await run(smtp);
  } finally {
    await smtp.stop();
  }
}

const dial = (smtp: FakeSmtp): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(smtp.port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });

const options = (smtp: FakeSmtp, over: Partial<SmtpOptions> = {}): SmtpOptions => ({ host: "127.0.0.1", port: smtp.port, security: "none", from: "Curule <no-reply@example.com>", hello: "curule.example.com", clock: () => NOW, ...over });

/** The bytes a client sent as the answer to a quoted-printable body, as text. */
const unqp = (encoded: string): string => decodeBody(`X: y\r\n\r\n${encoded}`);

// ---- addresses

test("an address that is one mailbox is accepted, with its domain in ASCII", () => {
  assert.equal(mailbox("ada@example.com"), "ada@example.com");
  assert.equal(mailbox("first.last+tag@mail.example.co.uk"), "first.last+tag@mail.example.co.uk");
  assert.equal(mailbox("o'brien@example.com"), "o'brien@example.com");
  assert.equal(mailbox("Ada@Example.COM"), "Ada@example.com", "the part before the @ is as it was written, and a domain is not case-sensitive");
  assert.equal(mailbox("ada@bücher.de"), "ada@xn--bcher-kva.de");
  assert.equal(mailbox("ada@xn--bcher-kva.de"), "ada@xn--bcher-kva.de");
});

test("an address that could carry a command, a second recipient or a header is refused for good, and what is said about it holds no line break", () => {
  const bad = [
    "ada@example.com\r\nRCPT TO:<eve@example.net>",
    "ada@example.com>\r\nDATA",
    "ada@example.com\nBcc: eve@example.net",
    "<ada@example.com>",
    "ada lovelace@example.com",
    "ada,eve@example.com",
    "ada@example.com,eve@example.net",
    "ada@example.com;eve@example.net",
    '"ada"@example.com',
    "ada@@example.com",
    "@example.com",
    "ada@",
    "ada",
    "ada@example",
    "ada@.example.com",
    "ada@example..com",
    "ada@-example.com",
    "ada@example-.com",
    "ada@exa mple.com",
    "ada@1.2.3.4",
    "ada@example.c",
    "ada@example.123",
    "ádá@example.com",
    ".ada@example.com",
    "ada.@example.com",
    "ada..lovelace@example.com",
    `${"a".repeat(65)}@example.com`,
    `ada@${"a".repeat(64)}.example.com`,
    `ada@${"a.".repeat(130)}com`,
  ];
  for (const address of bad) {
    const e = refusal(() => mailbox(address));
    assert.equal(e.permanent, true, address);
    assert.equal(e.transport, false, address);
    assert.equal(e.status, 0, address);
    assert.doesNotMatch(e.message, /[\r\n]/, "what is said holds no line break");
    assert.match(e.message, /is not an address mail can be sent to/, address);
  }
  assert.equal(mailbox(`${"a".repeat(64)}@example.com`), `${"a".repeat(64)}@example.com`, "the longest part before the @ that is allowed");
  assert.equal(mailbox(`ada@${"a".repeat(63)}.example.com`), `ada@${"a".repeat(63)}.example.com`, "and the longest label");
});

test("the address in a From value is the one in the angle brackets, or the whole value when there are none", () => {
  assert.equal(addressOf("no-reply@example.com"), "no-reply@example.com");
  assert.equal(addressOf("Curule <no-reply@example.com>"), "no-reply@example.com");
  assert.equal(addressOf('"Curule, Inc." <no-reply@example.com>  '), "no-reply@example.com");
  assert.equal(addressOf("  no-reply@example.com "), "no-reply@example.com");
  assert.equal(addressOf("Curule < no-reply@example.com >"), "no-reply@example.com", "white space inside the brackets is not part of the address");
  for (const bad of ["Curule <no-reply@example.com> more", "Curule <no-reply@example.com", "Curule <>", "no-reply@example.com>\r\nRCPT TO:<eve@example.net>", "Curule <\r\nBcc: eve@example.net\r\n no-reply@example.com>", "Curule <no-reply@example.com\r\n>", "no-reply@example.com\r\n.\r\nMAIL FROM:<eve@example.net>"]) {
    refusal(() => addressOf(bad));
  }
});

// ---- headers and body

test("a header is plain ASCII as it was, or RFC 2047 words that are short enough and are cut between characters", () => {
  assert.equal(headerValue("Confirm your email address"), "Confirm your email address");
  assert.equal(headerValue(""), "");
  assert.equal(headerValue("Café"), "=?UTF-8?B?Q2Fmw6k=?=");
  const persian = "تأیید نشانی ایمیل شما در سرویس";
  const long = `${persian} ${"é".repeat(60)} 😀😀😀 ${persian}`;
  const folded = headerValue(long);
  const words = folded.split("\r\n ");
  assert.ok(words.length > 4, "a long text is several words");
  for (const w of words) {
    assert.ok(w.length <= 75, `a word of ${w.length} characters`);
    assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    assert.doesNotMatch(Buffer.from(w.slice("=?UTF-8?B?".length, -2), "base64").toString("utf8"), /�/, "no character is cut between two words");
  }
  assert.equal(decodeWords(folded), long, "read back, the words say what was said");
});

test("a header that holds a line break, or is longer than a line can be, is refused for good", () => {
  for (const bad of ["Hi\r\nBcc: eve@example.net", "Hi\nBcc: eve@example.net", "Hi\rthere", "é\r\nBcc: eve@example.net", "x".repeat(901)]) {
    const e = refusal(() => headerValue(bad));
    assert.equal(e.permanent, true);
    assert.equal(e.transport, false);
  }
  assert.equal(headerValue("x".repeat(900)), "x".repeat(900));
});

test("a From value keeps its address, and has its name quoted or encoded as it needs", () => {
  assert.equal(fromHeader("no-reply@example.com"), "no-reply@example.com");
  assert.equal(fromHeader("Curule <no-reply@example.com>"), "Curule <no-reply@example.com>");
  assert.equal(fromHeader('"Curule" <no-reply@example.com>'), "Curule <no-reply@example.com>");
  assert.equal(fromHeader("Curule, Inc. <no-reply@example.com>"), '"Curule, Inc." <no-reply@example.com>');
  assert.equal(fromHeader('Say "hi" <no-reply@example.com>'), '"Say \\"hi\\"" <no-reply@example.com>');
  assert.equal(fromHeader("<no-reply@example.com>"), "<no-reply@example.com>");
  assert.equal(fromHeader("Café <no-reply@example.com>"), "=?UTF-8?B?Q2Fmw6k=?= <no-reply@example.com>");
  assert.equal(fromHeader("Curule <no-reply@bücher.de>"), "Curule <no-reply@xn--bcher-kva.de>");
  for (const bad of ["Curule\r\nBcc: eve@example.net <no-reply@example.com>", "not an address", "Curule <not an address>", "no-reply@example.com\r\nBcc: eve@example.net"]) refusal(() => fromHeader(bad));
});

test("quoted-printable keeps ASCII, escapes what would be misread, and breaks a long line without cutting an escape", () => {
  assert.equal(quotedPrintable("Open https://app.example.com/verify?token=abc"), "Open https://app.example.com/verify?token=3Dabc");
  assert.equal(quotedPrintable("a=b"), "a=3Db");
  assert.equal(quotedPrintable("trailing space \nnext\ttab\t\nend"), "trailing space=20\r\nnext\ttab=09\r\nend");
  assert.equal(quotedPrintable("é"), "=C3=A9");
  assert.equal(quotedPrintable("😀"), "=F0=9F=98=80");
  assert.equal(quotedPrintable("one\n\ntwo"), "one\r\n\r\ntwo");
  assert.equal(quotedPrintable("a\r\nb"), "a\r\nb");
  assert.equal(quotedPrintable(""), "");
  assert.deepEqual(
    quotedPrintable("x".repeat(200))
      .split("\r\n")
      .map((l) => l.length),
    [76, 76, 50],
    "a soft break after 75 characters, which makes 76 with its =",
  );
  // An escape is three characters, and the break comes before it whichever of them the limit would have fallen on.
  for (const lead of [72, 73, 74, 75]) {
    const text = `${"x".repeat(lead)}é${"y".repeat(10)}`;
    const lines = quotedPrintable(text).split("\r\n");
    for (const line of lines) assert.ok(line.length <= 76, `${lead}: ${line.length}`);
    for (const line of lines.slice(0, -1)) {
      assert.ok(line.endsWith("="), "a line that is not the last ends in a soft break");
      // A decoder that reads a line at a time must find every escape whole on its line: a soft break is never inside one.
      assert.doesNotMatch(line.slice(0, -1), /=(?![0-9A-F]{2})/, `${lead}: an escape was cut by the break in ${JSON.stringify(line)}`);
    }
    assert.equal(unqp(lines.join("\r\n")), text, `lead ${lead}`);
  }
});

test("quoted-printable and the reading of it agree for text of every kind, in lines of at most 76 characters that do not end in a space", () => {
  let seed = 20_261_005;
  const next = (n: number): number => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed % n;
  };
  const pool = ["a", "b", "=", " ", "\t", "\n", ".", "é", "ü", "😀", "ت", "x".repeat(30), "= ", " =", "\r\n", "==", "=3D"];
  for (let i = 0; i < 400; i++) {
    let text = "";
    for (let j = next(90); j > 0; j--) text += pool[next(pool.length)];
    const encoded = quotedPrintable(text);
    for (const line of encoded.split("\r\n")) {
      assert.ok(line.length <= 76, `a line of ${line.length}`);
      assert.doesNotMatch(line, /[ \t]$/, "a line does not end in a space or a tab");
    }
    assert.equal(unqp(encoded), text.replace(/\r\n/g, "\n"));
  }
});

test("a message has the headers a mail client and a filter look for, CRLF line ends, and every line that begins with a dot given another", () => {
  const wire = formatMessage({ ...mail, text: "first\n.\n..\n.hidden\nlast" }, { from: "Curule <no-reply@example.com>", hello: "curule.example.com", now: NOW });
  const headers = headersOf(wire);
  assert.equal(headers.get("from"), "Curule <no-reply@example.com>");
  assert.equal(headers.get("to"), "ada@example.com");
  assert.equal(headers.get("subject"), "Confirm your email address");
  assert.equal(headers.get("date"), "Mon, 05 Oct 2026 12:00:00 +0000");
  assert.match(headers.get("message-id")!, /^<[0-9a-f]{24}@curule\.example\.com>$/);
  assert.equal(headers.get("mime-version"), "1.0");
  assert.equal(headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(headers.get("content-transfer-encoding"), "quoted-printable");
  assert.equal(headers.get("auto-submitted"), "auto-generated");
  assert.doesNotMatch(wire, /(^|[^\r])\n/, "every line ends in CRLF");
  assert.deepEqual(wire.split("\r\n").slice(-5), ["first", "..", "...", "..hidden", "last"]);
  assert.notEqual(headersOf(formatMessage(mail, { from: "no-reply@example.com", hello: "h", now: NOW })).get("message-id"), headers.get("message-id"), "each message has an identity of its own");
});

// ---- delivery

test("a message is delivered: the server is greeted, told who it is from and for, given the message, and said goodbye to", async () => {
  await withServer({}, async (smtp) => {
    await new SmtpTransport(options(smtp)).send(mail);
    await smtp.untilClosed(1);
    const said = smtp.transcripts[0]!;
    assert.deepEqual(said.slice(0, 4), ["EHLO curule.example.com", "MAIL FROM:<no-reply@example.com>", "RCPT TO:<ada@example.com>", "DATA"]);
    assert.match(said[4]!, /^<\d+ characters of message>$/);
    assert.equal(said[5], "QUIT");
    assert.equal(said.length, 6);
    assert.equal(smtp.accepted.length, 1);
    const got = smtp.accepted[0]!;
    assert.equal(got.from, "no-reply@example.com");
    assert.deepEqual(got.to, ["ada@example.com"]);
    assert.equal(got.encrypted, false);
    const headers = headersOf(got.data);
    assert.equal(headers.get("from"), "Curule <no-reply@example.com>");
    assert.equal(headers.get("to"), "ada@example.com");
    assert.equal(headers.get("subject"), mail.subject);
    assert.equal(headers.get("date"), "Mon, 05 Oct 2026 12:00:00 +0000");
    assert.equal(decodeBody(got.data), mail.text);
  });
});

test("text in any script, with the characters quoted-printable has to escape, arrives as it was written, in the subject, the name and the body", async () => {
  await withServer({}, async (smtp) => {
    const text = "سلام، این پیوند را باز کنید:\n\nhttps://app.example.com/verify?token=a=b&x=é\n\nline with trailing space \nTab\tinside\n😀 and = signs ==\n\n";
    const subject = "تأیید نشانی ایمیل — Confirm 😀";
    await new SmtpTransport(options(smtp, { from: "سرویس Curule <no-reply@example.com>" })).send({ ...mail, subject, text });
    const got = smtp.accepted[0]!;
    const headers = headersOf(got.data);
    assert.equal(decodeWords(headers.get("subject")!), subject);
    assert.equal(decodeWords(headers.get("from")!), "سرویس Curule <no-reply@example.com>");
    assert.equal(decodeBody(got.data), text);
  });
});

test("a line that is only a dot, and one that begins with dots, do not end the message early or lose a dot on the way", async () => {
  await withServer({}, async (smtp) => {
    for (const text of ["before\n.\nafter", "before\n..\n...\n.dotted\nafter", ".", "a\n.", ".\nb", "...\n"]) {
      await new SmtpTransport(options(smtp)).send({ ...mail, text });
      assert.equal(decodeBody(smtp.accepted.at(-1)!.data), text, JSON.stringify(text));
    }
    assert.equal(smtp.accepted.length, 6);
  });
});

test("a long message is delivered whole", async () => {
  await withServer({}, async (smtp) => {
    const text = Array.from({ length: 3_000 }, (_, i) => `line ${i}: ${"word ".repeat(18)}é=`).join("\n");
    await new SmtpTransport(options(smtp)).send({ ...mail, text });
    assert.equal(decodeBody(smtp.accepted[0]!.data), text);
  });
});

test("a recipient whose domain is not ASCII is sent to under its ASCII name", async () => {
  await withServer({}, async (smtp) => {
    await new SmtpTransport(options(smtp)).send({ ...mail, to: "ada@bücher.de" });
    assert.deepEqual(smtp.accepted[0]!.to, ["ada@xn--bcher-kva.de"]);
    assert.equal(headersOf(smtp.accepted[0]!.data).get("to"), "ada@xn--bcher-kva.de");
  });
});

test("what a machine calls itself is made safe to put in a command, and is its host name when nothing is said", async () => {
  await withServer({}, async (smtp) => {
    await new SmtpTransport(options(smtp, { hello: "evil.test\r\nMAIL FROM:<eve@example.net>" })).send(mail);
    assert.equal(smtp.transcripts[0]![0], "EHLO evil.testMAILFROMeveexample.net");
    assert.equal(smtp.transcripts[0]!.filter((l) => l.startsWith("MAIL")).length, 1, "the one command that was meant");
    const { hello: _hello, ...rest } = options(smtp);
    await new SmtpTransport(rest).send(mail);
    assert.equal(smtp.transcripts[1]![0], `EHLO ${os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost"}`);
  });
});

test("an address, a subject or a sender that holds a line break is refused before any connection is made", async () => {
  await withServer({}, async (smtp) => {
    const cases: Array<[typeof mail, Partial<SmtpOptions>]> = [
      [{ ...mail, to: "ada@example.com\r\nRCPT TO:<eve@example.net>" }, {}],
      [{ ...mail, to: "ada@example.com>\r\nDATA" }, {}],
      [{ ...mail, subject: "Hi\r\nBcc: eve@example.net" }, {}],
      [mail, { from: "no-reply@example.com>\r\nRCPT TO:<eve@example.net>" }],
      [mail, { from: "Curule\r\nBcc: eve@example.net <no-reply@example.com>" }],
    ];
    for (const [m, over] of cases) {
      const e = await failure(new SmtpTransport(options(smtp, over)).send(m));
      assert.equal(e.permanent, true);
      assert.equal(e.transport, false);
    }
    assert.equal(smtp.transcripts.length, 0, "the server was never spoken to");
  });
});

// ---- sign-in

const credentials = { user: "mailer", password: "p@ss:wörd é" };

test("sign-in is AUTH PLAIN when the server offers it, with the account and password it was given, between EHLO and MAIL", async () => {
  await withServer({ features: ["AUTH PLAIN LOGIN"], credentials }, async (smtp) => {
    await new SmtpTransport(options(smtp, credentials)).send(mail);
    const said = smtp.transcripts[0]!;
    const auth = said.find((l) => l.startsWith("AUTH"))!;
    assert.equal(auth.split(" ")[1], "PLAIN");
    assert.equal(Buffer.from(auth.split(" ")[2]!, "base64").toString("utf8"), "\0mailer\0p@ss:wörd é");
    assert.ok(!said.includes("AUTH LOGIN"));
    assert.ok(said.findIndex((l) => l.startsWith("EHLO")) < said.indexOf(auth) && said.indexOf(auth) < said.findIndex((l) => l.startsWith("MAIL")));
    assert.equal(smtp.accepted[0]!.user, "mailer");
  });
});

test("sign-in is AUTH LOGIN when that is all the server offers, and the older AUTH= form is read too", async () => {
  for (const features of [["AUTH LOGIN"], ["AUTH=LOGIN"], ["AUTH CRAM-MD5 LOGIN XOAUTH2"], ["PIPELINING", "AUTH=CRAM-MD5 LOGIN"]]) {
    await withServer({ features, credentials }, async (smtp) => {
      await new SmtpTransport(options(smtp, credentials)).send(mail);
      const said = smtp.transcripts[0]!;
      const at = said.indexOf("AUTH LOGIN");
      assert.ok(at > 0, features.join(" "));
      assert.equal(Buffer.from(said[at + 1]!, "base64").toString("utf8"), "mailer");
      assert.equal(Buffer.from(said[at + 2]!, "base64").toString("utf8"), "p@ss:wörd é");
      assert.equal(smtp.accepted[0]!.user, "mailer");
    });
  }
});

test("a server that offers no sign-in this can use is an error, found before anything is said about the message", async () => {
  for (const [features, offered] of [
    [["AUTH XOAUTH2 CRAM-MD5"], "XOAUTH2, CRAM-MD5"],
    [["PIPELINING"], "none"],
  ] as const) {
    await withServer({ features: [...features], credentials }, async (smtp) => {
      const e = await failure(new SmtpTransport(options(smtp, credentials)).send(mail));
      assert.match(e.message, new RegExp(`offers no sign-in this can use \\(it offers: ${offered}\\)`));
      assert.equal(e.transport, true);
      assert.equal(e.permanent, false);
      assert.ok(!smtp.transcripts[0]!.some((l) => l.startsWith("MAIL")));
    });
  }
});

test("a password the server refuses is trouble with the service, which holds mail back and is not the message's fault", async () => {
  for (const features of [["AUTH PLAIN"], ["AUTH LOGIN"]]) {
    await withServer({ features, credentials }, async (smtp) => {
      const e = await failure(new SmtpTransport(options(smtp, { user: "mailer", password: "wrong" })).send(mail));
      assert.equal(e.status, 535);
      assert.equal(e.transport, true);
      assert.equal(e.permanent, false);
      assert.match(e.message, /535 5\.7\.8 credentials rejected \(to the sign-in\)/);
      assert.ok(!smtp.transcripts[0]!.some((l) => l.startsWith("MAIL")));
    });
  }
});

test("without credentials there is no sign-in, even when the server offers one", async () => {
  await withServer({ features: ["AUTH PLAIN LOGIN"], credentials }, async (smtp) => {
    await new SmtpTransport(options(smtp)).send(mail);
    assert.ok(!smtp.transcripts[0]!.some((l) => l.startsWith("AUTH")));
    assert.equal(smtp.accepted.length, 1);
  });
});

test("a user name or password that cannot be put in a sign-in is an error, and nothing is sent", async () => {
  await withServer({ features: ["AUTH PLAIN"], credentials }, async (smtp) => {
    for (const bad of [{ user: "mailer\0root", password: "x" }, { user: "mailer", password: "a\r\nMAIL FROM:<eve@example.net>" }, { user: "a\nb", password: "x" }]) {
      const e = await failure(new SmtpTransport(options(smtp, bad)).send(mail));
      assert.match(e.message, /cannot be sent in a sign-in/);
    }
    assert.ok(smtp.transcripts.every((t) => !t.some((l) => l.startsWith("AUTH") || l.startsWith("MAIL"))));
  });
});

test("a password is not sent over a connection that is not encrypted, unless the server is on this machine", async () => {
  await withServer({ features: ["AUTH PLAIN"], credentials }, async (smtp) => {
    const here = ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"];
    for (const host of here) await new SmtpTransport(options(smtp, { host, connect: () => dial(smtp), ...credentials })).send(mail);
    assert.equal(smtp.accepted.length, here.length, "each of the addresses of this machine was signed in to");
    const elsewhere = ["mail.example.test", "127.example.com", "localhost.example.com", "10.0.0.5", "::ffff:127.0.0.1", "0.0.0.0", "128.0.0.1"];
    for (const host of elsewhere) {
      const e = await failure(new SmtpTransport(options(smtp, { host, connect: () => dial(smtp), ...credentials })).send(mail));
      assert.match(e.message, new RegExp(`refusing to send a password to ${host.replace(/[.:[\]]/g, "\\$&")} over a connection that is not encrypted`));
      assert.equal(e.transport, true);
      assert.equal(e.permanent, false);
    }
    assert.equal(smtp.accepted.length, here.length, "and none of the others");
    assert.ok(smtp.transcripts.slice(here.length).every((t) => !t.some((l) => l.startsWith("AUTH"))));
  });
});

test("a relay that asks for no sign-in is used over a plain connection from anywhere", async () => {
  await withServer({}, async (smtp) => {
    await new SmtpTransport(options(smtp, { host: "relay.example.test", connect: () => dial(smtp) })).send(mail);
    assert.equal(smtp.accepted.length, 1);
  });
});

// ---- encryption

test("a connection is asked for as encrypted from the first byte only when the configuration says tls", async () => {
  await withServer({ starttls: "pretend" }, async (smtp) => {
    const seen: Array<{ host: string; port: number; secure: boolean; signal: unknown }> = [];
    const connect = async (o: { host: string; port: number; secure: boolean; signal: AbortSignal }): Promise<Duplex> => {
      seen.push(o);
      return dial(smtp);
    };
    for (const [security, port] of [
      ["tls", 465],
      ["starttls", 587],
      ["none", 25],
    ] as const) {
      await new SmtpTransport(options(smtp, { host: "mail.example.test", port, security, connect, upgrade: async (s) => s })).send(mail);
    }
    assert.deepEqual(
      seen.map((s) => [s.host, s.port, s.secure]),
      [
        ["mail.example.test", 465, true],
        ["mail.example.test", 587, false],
        ["mail.example.test", 25, false],
      ],
    );
    assert.ok(seen.every((s) => s.signal instanceof AbortSignal));
    assert.ok(!smtp.transcripts[0]!.includes("STARTTLS"), "an encrypted connection is not asked to start TLS again");
    assert.ok(smtp.transcripts[1]!.includes("STARTTLS"));
    assert.ok(!smtp.transcripts[2]!.includes("STARTTLS"), "a plain connection that was asked for plain is left plain");
  });
});

test("STARTTLS: the server is asked to encrypt, EHLO is said again over the encrypted connection, and sign-in comes after", async () => {
  await withServer({ starttls: "pretend", featuresAfterTls: ["AUTH PLAIN"], credentials }, async (smtp) => {
    let upgraded = 0;
    await new SmtpTransport(options(smtp, { security: "starttls", ...credentials, upgrade: async (s) => (upgraded++, s) })).send(mail);
    const said = smtp.transcripts[0]!;
    assert.deepEqual(said.slice(0, 3), ["EHLO curule.example.com", "STARTTLS", "EHLO curule.example.com"]);
    assert.ok(said[3]!.startsWith("AUTH PLAIN "));
    assert.equal(upgraded, 1);
    assert.equal(smtp.accepted[0]!.encrypted, true);
    assert.equal(smtp.accepted[0]!.user, "mailer");
  });
});

test("what a server listed before it was encrypted is not relied on after", async () => {
  await withServer({ starttls: "pretend", featuresBeforeTls: ["AUTH PLAIN"], credentials }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp, { security: "starttls", ...credentials, upgrade: async (s) => s })).send(mail));
    assert.match(e.message, /offers no sign-in this can use \(it offers: none\)/);
    assert.ok(!smtp.transcripts[0]!.some((l) => l.startsWith("AUTH") || l.startsWith("MAIL")));
  });
});

test("a server that does not offer STARTTLS, when it is asked for, is an error and nothing is sent unencrypted", async () => {
  await withServer({ features: ["AUTH PLAIN"], credentials }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp, { security: "starttls", ...credentials })).send(mail));
    assert.match(e.message, /127\.0\.0\.1 does not offer STARTTLS, and the configuration asks for it: mail is not sent unencrypted/);
    assert.equal(e.transport, true, "the operator's to put right, and every message waits for it");
    assert.equal(e.permanent, false);
    assert.deepEqual(smtp.transcripts[0], ["EHLO curule.example.com"]);
    assert.equal(smtp.accepted.length, 0);
  });
});

test("STARTTLS refused, or a handshake that fails, ends the delivery with nothing private said", async () => {
  await withServer({ starttls: "pretend", features: ["AUTH PLAIN"], credentials, answer: (verb) => (verb === "STARTTLS" ? "454 4.7.0 TLS not available" : undefined) }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp, { security: "starttls", ...credentials })).send(mail));
    assert.equal(e.status, 454);
    assert.equal(e.transport, true);
    assert.match(e.message, /454 4\.7\.0 TLS not available \(to STARTTLS\)/);
    assert.deepEqual(smtp.transcripts[0], ["EHLO curule.example.com", "STARTTLS"]);
  });
  await withServer({ starttls: "pretend", features: ["AUTH PLAIN"], credentials }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp, { security: "starttls", ...credentials, upgrade: async () => Promise.reject(new Error("handshake refused")) })).send(mail));
    assert.match(e.message, /the TLS handshake with 127\.0\.0\.1 failed: handshake refused/);
    assert.equal(e.transport, true);
    assert.deepEqual(smtp.transcripts[0], ["EHLO curule.example.com", "STARTTLS"]);
  });
});

// ---- what a server can answer, and where

const CASES: Array<{ name: string; fake: FakeOptions; status: number; permanent: boolean; transport: boolean; at: RegExp }> = [
  { name: "a greeting that is not 220", fake: { greeting: "554 5.3.2 no SMTP service here" }, status: 554, permanent: false, transport: true, at: /when it was connected to/ },
  { name: "a greeting of 421", fake: { greeting: "421 4.3.2 shutting down" }, status: 421, permanent: false, transport: true, at: /when it was connected to/ },
  { name: "an EHLO that is refused", fake: { answer: (v) => (v === "EHLO" ? "550 5.5.0 not today" : undefined) }, status: 550, permanent: false, transport: true, at: /to EHLO/ },
  { name: "a sender that is refused", fake: { answer: (v) => (v === "MAIL" ? "550 5.7.1 sender not allowed" : undefined) }, status: 550, permanent: false, transport: true, at: /to the sender/ },
  { name: "a sender answered 421", fake: { answer: (v) => (v === "MAIL" ? "421 4.3.2 closing" : undefined) }, status: 421, permanent: false, transport: true, at: /to the sender/ },
  { name: "a recipient that does not exist", fake: { answer: (v) => (v === "RCPT" ? "550 5.1.1 no such user" : undefined) }, status: 550, permanent: true, transport: false, at: /to the recipient/ },
  { name: "a recipient the server will not relay to", fake: { answer: (v) => (v === "RCPT" ? "554 5.7.1 relay access denied" : undefined) }, status: 554, permanent: true, transport: false, at: /to the recipient/ },
  { name: "a recipient answered 551", fake: { answer: (v) => (v === "RCPT" ? "551 user not local" : undefined) }, status: 551, permanent: true, transport: false, at: /to the recipient/ },
  { name: "a mailbox that is full", fake: { answer: (v) => (v === "RCPT" ? "452 4.2.2 mailbox full" : undefined) }, status: 452, permanent: false, transport: false, at: /to the recipient/ },
  { name: "a recipient that is greylisted", fake: { answer: (v) => (v === "RCPT" ? "450 4.2.0 try again later" : undefined) }, status: 450, permanent: false, transport: false, at: /to the recipient/ },
  { name: "a recipient answered 421", fake: { answer: (v) => (v === "RCPT" ? "421 4.3.2 closing" : undefined) }, status: 421, permanent: false, transport: true, at: /to the recipient/ },
  { name: "a DATA that is refused", fake: { answer: (v) => (v === "DATA" ? "554 5.5.1 no valid recipients" : undefined) }, status: 554, permanent: false, transport: false, at: /to DATA/ },
  { name: "a DATA answered 421", fake: { answer: (v) => (v === "DATA" ? "421 4.3.2 closing" : undefined) }, status: 421, permanent: false, transport: true, at: /to DATA/ },
  { name: "a message refused as spam", fake: { answer: (v) => (v === "BODY" ? "554 5.7.1 rejected as spam" : undefined) }, status: 554, permanent: false, transport: false, at: /to the message/ },
  { name: "a message that is too large", fake: { answer: (v) => (v === "BODY" ? "552 5.3.4 message too large" : undefined) }, status: 552, permanent: false, transport: false, at: /to the message/ },
  { name: "a message answered with a try-again", fake: { answer: (v) => (v === "BODY" ? "451 4.3.0 try again" : undefined) }, status: 451, permanent: false, transport: false, at: /to the message/ },
  { name: "a message answered 421", fake: { answer: (v) => (v === "BODY" ? "421 4.3.2 closing" : undefined) }, status: 421, permanent: false, transport: true, at: /to the message/ },
];

for (const c of CASES) {
  test(`${c.name} is an error that says what the server said, where, and what is worth doing next`, async () => {
    await withServer(c.fake, async (smtp) => {
      const e = await failure(new SmtpTransport(options(smtp)).send(mail));
      assert.equal(e.status, c.status);
      assert.equal(e.permanent, c.permanent, "refused for good");
      assert.equal(e.transport, c.transport, "trouble with the service");
      assert.match(e.message, new RegExp(`^the server answered ${c.status} `));
      assert.match(e.message, c.at);
      assert.equal(smtp.accepted.length, 0);
    });
  });
}

test("a server that hangs up in the middle is trouble with the service, and so is a server that is not there", async () => {
  await withServer({ answer: (v) => (v === "RCPT" ? "close" : undefined) }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp)).send(mail));
    assert.match(e.message, /the server closed the connection/);
    assert.equal(e.status, 0);
    assert.equal(e.transport, true);
    assert.equal(e.permanent, false);
  });
  await withServer({ greeting: "close" }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp)).send(mail));
    assert.equal(e.transport, true);
  });
  const closed = await FakeSmtp.start({});
  const port = closed.port;
  await closed.stop();
  const e = await failure(new SmtpTransport({ host: "127.0.0.1", port, security: "none", from: "no-reply@example.com", hello: "h" }).send(mail));
  assert.match(e.message, new RegExp(`could not connect to 127\\.0\\.0\\.1:${port}: `));
  assert.equal(e.transport, true);
  assert.equal(e.permanent, false);
});

test("a server that goes quiet ends the delivery at the time limit, and the connection is closed", async () => {
  for (const fake of [{ greeting: "hang" }, { answer: (v: string) => (v === "DATA" ? "hang" : undefined) }, { answer: (v: string) => (v === "BODY" ? "hang" : undefined) }] as FakeOptions[]) {
    await withServer(fake, async (smtp) => {
      const started = Date.now();
      const e = await failure(new SmtpTransport(options(smtp, { timeoutMs: 150 })).send(mail));
      assert.match(e.message, /the server did not finish within 0\.15 seconds/);
      assert.equal(e.transport, true);
      assert.equal(e.permanent, false);
      assert.ok(Date.now() - started < 1_500, "it did not wait for more than the limit");
      await smtp.untilClosed(1);
      assert.equal(smtp.closed, 1, "the connection was closed");
      assert.equal(smtp.accepted.length, 0);
    });
  }
});

test("when time runs out while the connection is still being made, it is closed when it arrives and nothing is sent on it", async () => {
  const late = new PassThrough();
  const written: string[] = [];
  const write = late.write.bind(late);
  late.write = ((chunk: unknown, ...rest: unknown[]) => (written.push(String(chunk)), (write as (...a: unknown[]) => boolean)(chunk, ...rest))) as typeof late.write;
  let signal: AbortSignal | undefined;
  const connect = (o: { signal: AbortSignal }): Promise<Duplex> => {
    signal = o.signal;
    return new Promise((resolve) => setTimeout(() => resolve(late), 250));
  };
  const e = await failure(new SmtpTransport({ host: "mail.example.test", port: 587, security: "starttls", from: "no-reply@example.com", timeoutMs: 50, connect }).send(mail));
  assert.match(e.message, /did not finish within 0\.05 seconds/);
  assert.equal(signal!.aborted, true, "the attempt to connect was told to stop");
  await new Promise((r) => setTimeout(r, 450));
  assert.equal(late.destroyed, true);
  assert.deepEqual(written, []);
});

test("once the server has accepted the message the delivery has worked, whatever it does about goodbye", async () => {
  await withServer({ answer: (v) => (v === "QUIT" ? "hang" : undefined) }, async (smtp) => {
    const started = Date.now();
    await new SmtpTransport(options(smtp, { timeoutMs: 5_000 })).send(mail);
    assert.ok(Date.now() - started < 900, "it did not wait for an answer to QUIT");
    assert.equal(smtp.accepted.length, 1);
    await smtp.untilClosed(1, 2_500);
    assert.equal(smtp.closed, 1, "and it hung up on its own");
  });
  await withServer({ closeAfterBody: true }, async (smtp) => {
    await new SmtpTransport(options(smtp)).send(mail);
    assert.equal(smtp.accepted.length, 1, "a server that hangs up as soon as it has the message has still taken it");
  });
  await withServer({ answer: (v) => (v === "BODY" ? "250 2.0.0 ok" : v === "QUIT" ? "close" : undefined) }, async (smtp) => {
    await new SmtpTransport(options(smtp, { timeoutMs: 5_000 })).send(mail);
    assert.equal(smtp.accepted.length, 1);
  });
});

test("replies that arrive in pieces, one byte at a time, are put together", async () => {
  await withServer({ trickle: true, features: ["AUTH PLAIN LOGIN", "PIPELINING", "8BITMIME"], credentials }, async (smtp) => {
    await new SmtpTransport(options(smtp, credentials)).send(mail);
    assert.equal(smtp.accepted.length, 1);
    assert.equal(smtp.accepted[0]!.user, "mailer");
  });
});

test("a reply that is far longer than any server's, or a line that never ends, is not SMTP and ends the delivery", async () => {
  await withServer({ greeting: `220-${"x".repeat(100_000)}` }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp)).send(mail));
    assert.match(e.message, /too long to be SMTP/);
    assert.equal(e.transport, true);
  });
  const open = new Set<net.Socket>();
  const flood = net.createServer((socket) => {
    open.add(socket);
    socket.on("error", () => undefined);
    const timer = setInterval(() => socket.write("x".repeat(20_000)), 5);
    socket.on("close", () => {
      clearInterval(timer);
      open.delete(socket);
    });
  });
  await new Promise<void>((resolve) => flood.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (flood.address() as net.AddressInfo).port;
    const e = await failure(new SmtpTransport({ host: "127.0.0.1", port, security: "none", from: "no-reply@example.com", hello: "h", timeoutMs: 10_000 }).send(mail));
    assert.match(e.message, /too long to be SMTP/);
  } finally {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => flood.close(() => resolve()));
  }
});

// ---- real TLS, with the certificate checked by Node itself

const CHILD = `
const { SmtpTransport } = require(process.env.SMTP_MODULE);
new SmtpTransport(JSON.parse(process.env.SMTP_OPTIONS)).send(JSON.parse(process.env.SMTP_MAIL)).then(
  () => console.log(JSON.stringify({ ok: true })),
  (e) => console.log(JSON.stringify({ ok: false, name: e.name, message: e.message, permanent: e.permanent, transport: e.transport, status: e.status })),
);
`;

/** Send in a process of its own, with the one extra certificate authority it should trust, so that the default connection and the default upgrade are what is run. */
function sendInChild(smtpOptions: Record<string, unknown>, trust?: string): Promise<{ ok: boolean; message?: string; permanent?: boolean; transport?: boolean; status?: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env, SMTP_MODULE: path.resolve(__dirname, "../../packages/cloud/src/smtp.js"), SMTP_OPTIONS: JSON.stringify(smtpOptions), SMTP_MAIL: JSON.stringify(mail) };
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.SSL_CERT_FILE;
  if (trust) env.NODE_EXTRA_CA_CERTS = trust;
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ["-e", CHILD], { env, timeout: 30_000 }, (err, stdout, stderr) => {
      const last = stdout.trim().split("\n").at(-1) ?? "";
      try {
        resolve(JSON.parse(last));
      } catch {
        reject(new Error(`the child said nothing that can be read: ${stdout} ${stderr} ${err?.message ?? ""}`));
      }
    });
  });
}

const openssl = hasOpenssl() ? undefined : "openssl is not installed";
const baseTls = { host: "127.0.0.1", from: "no-reply@example.com", hello: "curule.example.com", timeoutMs: 20_000 };

test("TLS from the first byte: a certificate that verifies is trusted, and one that does not is refused before anything is said", { skip: openssl }, async () => {
  const cert = selfSigned(["localhost", "127.0.0.1"]);
  try {
    await withServer({ implicitTls: true, tls: cert }, async (smtp) => {
      assert.deepEqual(await sendInChild({ ...baseTls, port: smtp.port, security: "tls" }, cert.certFile), { ok: true });
      assert.equal(smtp.accepted.length, 1);
      assert.equal(smtp.accepted[0]!.encrypted, true);
      assert.equal(decodeBody(smtp.accepted[0]!.data), mail.text);
      const refused = await sendInChild({ ...baseTls, port: smtp.port, security: "tls" });
      assert.equal(refused.ok, false);
      assert.match(refused.message!, /could not connect to 127\.0\.0\.1:\d+: .*certificate/i);
      assert.equal(refused.transport, true);
      assert.equal(refused.permanent, false);
      assert.equal(smtp.accepted.length, 1, "nothing more was accepted");
      assert.equal(smtp.transcripts.length, 1, "and the server heard nothing from the second");
    });
  } finally {
    fs.rmSync(cert.dir, { recursive: true, force: true });
  }
});

test("TLS from the first byte: a certificate that verifies but is for another name is refused", { skip: openssl }, async () => {
  const cert = selfSigned(["mail.example.test"]);
  try {
    await withServer({ implicitTls: true, tls: cert }, async (smtp) => {
      const refused = await sendInChild({ ...baseTls, port: smtp.port, security: "tls" }, cert.certFile);
      assert.equal(refused.ok, false);
      assert.match(refused.message!, /could not connect to 127\.0\.0\.1:\d+: .*(altname|not in the cert|does not match)/i);
      assert.equal(smtp.accepted.length, 0);
      assert.equal(smtp.transcripts.length, 0);
    });
  } finally {
    fs.rmSync(cert.dir, { recursive: true, force: true });
  }
});

test("STARTTLS: the connection is upgraded and the password goes only over the encrypted one; a certificate that does not verify stops it before the password", { skip: openssl }, async () => {
  const cert = selfSigned(["localhost", "127.0.0.1"]);
  try {
    await withServer({ starttls: "real", tls: cert, featuresAfterTls: ["AUTH PLAIN"], credentials }, async (smtp) => {
      assert.deepEqual(await sendInChild({ ...baseTls, port: smtp.port, security: "starttls", ...credentials }, cert.certFile), { ok: true });
      const said = smtp.transcripts[0]!;
      assert.deepEqual(said.slice(0, 3), ["EHLO curule.example.com", "STARTTLS", "EHLO curule.example.com"]);
      assert.ok(said[3]!.startsWith("AUTH PLAIN "));
      assert.equal(smtp.accepted[0]!.encrypted, true);
      assert.equal(smtp.accepted[0]!.user, "mailer");

      const refused = await sendInChild({ ...baseTls, port: smtp.port, security: "starttls", ...credentials });
      assert.equal(refused.ok, false);
      assert.match(refused.message!, /the TLS handshake with 127\.0\.0\.1 failed: .*certificate/i);
      assert.equal(refused.transport, true);
      assert.deepEqual(smtp.transcripts[1], ["EHLO curule.example.com", "STARTTLS"], "no sign-in and no message went before the certificate was checked");
      assert.equal(smtp.accepted.length, 1);
    });
  } finally {
    fs.rmSync(cert.dir, { recursive: true, force: true });
  }
});

test("STARTTLS with a certificate that is for another name is refused before the password", { skip: openssl }, async () => {
  const cert = selfSigned(["mail.example.test"]);
  try {
    await withServer({ starttls: "real", tls: cert, featuresAfterTls: ["AUTH PLAIN"], credentials }, async (smtp) => {
      const refused = await sendInChild({ ...baseTls, port: smtp.port, security: "starttls", ...credentials }, cert.certFile);
      assert.equal(refused.ok, false);
      assert.match(refused.message!, /the TLS handshake with 127\.0\.0\.1 failed/);
      assert.deepEqual(smtp.transcripts[0], ["EHLO curule.example.com", "STARTTLS"]);
    });
  } finally {
    fs.rmSync(cert.dir, { recursive: true, force: true });
  }
});

// ---- the edges: how long an address may be, what is escaped, and what each way of failing is called ----

const shape = (e: SmtpError): [number, boolean, boolean] => [e.status, e.permanent, e.transport];

test("an address is at longest 254 characters, and its part before the @ is at least one", () => {
  const address = (tail: number): string => `${"a".repeat(64)}@${"x".repeat(63)}.${"y".repeat(63)}.${"z".repeat(tail)}.com`;
  assert.equal(address(57).length, 254);
  assert.equal(mailbox(address(57)), address(57));
  assert.equal(address(58).length, 255);
  refusal(() => mailbox(address(58)));
  assert.equal(mailbox("a@example.com"), "a@example.com", "one character is a part before the @");
  assert.equal(refusal(() => mailbox("@example.com")).message, "'@example.com' is not an address mail can be sent to", "with nothing before the @ there is nothing more to say about it");
  assert.equal(refusal(() => mailbox(address(58))).message, `'${address(58).slice(0, 80)}' is not an address mail can be sent to`, "and one that is too long is shown by its first 80 characters");
});

test("what is said about an address that is refused says which part of it is wrong", () => {
  assert.equal(refusal(() => mailbox("a b@example.com")).message, "'a b@example.com' is not an address mail can be sent to: its part before the @ is not one that is sent");
  assert.equal(refusal(() => mailbox("ada@example")).message, "'ada@example' is not an address mail can be sent to: its domain is not one");
  assert.equal(refusal(() => headerValue("a\r\nb")).message, "a header holds a line break");
  assert.equal(refusal(() => headerValue("x".repeat(901))).message, "a header is longer than a line can be");
});

test("every way a delivery can fail is an error of the one kind, named for it, and says what is worth doing: its status, whether it is for good, whether it is the service's", async () => {
  const e = refusal(() => mailbox("nope"));
  assert.equal(e.name, "SmtpError");
  assert.ok(e instanceof Error && e instanceof DeliveryError);
  assert.deepEqual(shape(e), [0, true, false]);

  await withServer({ answer: (v) => (v === "RCPT" ? "reset" : undefined) }, async (smtp) => {
    const reset = await failure(new SmtpTransport(options(smtp)).send(mail));
    assert.match(reset.message, /^the connection failed: .*ECONNRESET/);
    assert.deepEqual(shape(reset), [0, false, true]);
  });
  const closed = await FakeSmtp.start({});
  const port = closed.port;
  await closed.stop();
  const refused = await failure(new SmtpTransport({ host: "127.0.0.1", port, security: "none", from: "no-reply@example.com", hello: "h" }).send(mail));
  assert.deepEqual(shape(refused), [0, false, true]);
  await withServer({ greeting: "close" }, async (smtp) => assert.deepEqual(shape(await failure(new SmtpTransport(options(smtp)).send(mail))), [0, false, true]));
  await withServer({ greeting: "hang" }, async (smtp) => assert.deepEqual(shape(await failure(new SmtpTransport(options(smtp, { timeoutMs: 100 })).send(mail))), [0, false, true]));
  await withServer({ starttls: "pretend", features: ["AUTH PLAIN"], credentials }, async (smtp) => {
    const handshake = await failure(new SmtpTransport(options(smtp, { security: "starttls", upgrade: async () => Promise.reject(new Error("no")) })).send(mail));
    assert.deepEqual(shape(handshake), [0, false, true]);
    const clear = await failure(new SmtpTransport(options(smtp, { host: "mail.example.test", security: "none", connect: () => dial(smtp), ...credentials })).send(mail));
    assert.deepEqual(shape(clear), [0, false, true]);
  });
  await withServer({ features: ["AUTH PLAIN"], credentials }, async (smtp) => {
    const odd = await failure(new SmtpTransport(options(smtp, { user: "a\0b", password: "x" })).send(mail));
    assert.deepEqual(shape(odd), [0, false, true]);
    assert.equal(odd.message, "the user name or the password holds a character that cannot be sent in a sign-in");
  });
  await withServer({}, async (smtp) => {
    const noTls = await failure(new SmtpTransport(options(smtp, { security: "starttls" })).send(mail));
    assert.deepEqual(shape(noTls), [0, false, true]);
  });
});

test("a reply that is too long is an error of the service's, and the connection that sent it is closed", async () => {
  const open = new Set<net.Socket>();
  let closedByUs = 0;
  const flood = net.createServer((socket) => {
    open.add(socket);
    socket.on("error", () => undefined);
    const timer = setInterval(() => socket.write("x".repeat(20_000)), 5);
    socket.on("close", () => {
      clearInterval(timer);
      open.delete(socket);
      closedByUs += 1;
    });
  });
  await new Promise<void>((resolve) => flood.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (flood.address() as net.AddressInfo).port;
    const e = await failure(new SmtpTransport({ host: "127.0.0.1", port, security: "none", from: "no-reply@example.com", hello: "h", timeoutMs: 10_000 }).send(mail));
    assert.deepEqual(shape(e), [0, false, true]);
    const until = Date.now() + 2_000;
    while (closedByUs === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.equal(closedByUs, 1, "the server saw the connection closed: it was not left open");
  } finally {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => flood.close(() => resolve()));
  }
});

test("a word of RFC 2047 holds at most 45 bytes of text: 45 are one word, and a character that would be the 46th starts another", () => {
  const euro = "€";
  assert.equal(Buffer.byteLength(euro.repeat(15)), 45);
  assert.equal(headerValue(euro.repeat(15)).split("\r\n ").length, 1);
  assert.deepEqual(headerValue(euro.repeat(16)).split("\r\n ").map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")), [euro.repeat(15), euro]);
  assert.deepEqual(headerValue(`${"é".repeat(22)}${euro}`).split("\r\n ").map((w) => Buffer.from(w.slice(10, -2), "base64").toString("utf8")), ["é".repeat(22), euro], "44 bytes and a character of three: the third does not fit");
});

test("every visible ASCII character but = is written as it is, and the rest as an escape, including DEL and the edges of the range", () => {
  assert.equal(quotedPrintable("!~}|"), "!~}|");
  assert.equal(quotedPrintable("\x7f"), "=7F");
  assert.equal(quotedPrintable("\x1f \x00"), "=1F =00");
  assert.equal(quotedPrintable("a b"), "a b");
  assert.equal(quotedPrintable("="), "=3D");
});

test("a line of 76 characters is one line, and 77 are two, the first ending in a soft break", () => {
  assert.equal(quotedPrintable("x".repeat(76)), "x".repeat(76));
  assert.equal(quotedPrintable("x".repeat(77)), `${"x".repeat(75)}=\r\n${"x".repeat(2)}`);
  assert.equal(quotedPrintable(`${"x".repeat(75)}é`).split("\r\n").length, 2);
});

test("an answer in any script arrives whole even when the bytes of a letter come in different pieces, and a connection that gives text and not bytes is read the same", async () => {
  await withServer({ trickle: true, answer: (v) => (v === "RCPT" ? "550 5.1.1 pas d'utilisateur à cette adresse — é" : undefined) }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp)).send(mail));
    assert.equal(e.message, "the server answered 550 5.1.1 pas d'utilisateur à cette adresse — é (to the recipient)");
  });
  await withServer({}, async (smtp) => {
    const asText = async (): Promise<Duplex> => {
      const socket = await dial(smtp);
      (socket as net.Socket).setEncoding("utf8");
      return socket;
    };
    await new SmtpTransport(options(smtp, { connect: asText })).send(mail);
    assert.equal(smtp.accepted.length, 1);
  });
});

test("a blank line before a reply is not a reply, and what follows it is read", async () => {
  await withServer({ greeting: "\n220 fake.test ESMTP" }, async (smtp) => {
    await new SmtpTransport(options(smtp, { timeoutMs: 3_000 })).send(mail);
    assert.equal(smtp.accepted.length, 1);
  });
});

test("a name that is nothing but what is taken out of a host name is localhost", async () => {
  await withServer({}, async (smtp) => {
    await new SmtpTransport(options(smtp, { hello: "!!! ???" })).send(mail);
    assert.equal(smtp.transcripts[0]![0], "EHLO localhost");
  });
});

test("a connection that was upgraded is encrypted from then on, which is what lets a password go over it to a server that is not this machine", async () => {
  await withServer({ starttls: "pretend", featuresAfterTls: ["AUTH PLAIN"], credentials }, async (smtp) => {
    await new SmtpTransport(options(smtp, { host: "mail.example.test", security: "starttls", connect: () => dial(smtp), upgrade: async (s) => s, ...credentials })).send(mail);
    assert.equal(smtp.accepted[0]!.user, "mailer");
  });
});

test("an account without a password, or a password without an account, is no sign-in: none is attempted", async () => {
  await withServer({ features: ["AUTH PLAIN LOGIN"], credentials }, async (smtp) => {
    await new SmtpTransport(options(smtp, { user: "mailer" })).send(mail);
    await new SmtpTransport(options(smtp, { password: "p" })).send(mail);
    assert.equal(smtp.accepted.length, 2);
    assert.ok(smtp.transcripts.every((t) => !t.some((l) => l.startsWith("AUTH"))));
  });
});

test("a recipient the server will forward for is taken, and one it cannot vouch for is not", async () => {
  await withServer({ answer: (v) => (v === "RCPT" ? "251 2.1.5 user not local; will forward" : undefined) }, async (smtp) => {
    await new SmtpTransport(options(smtp)).send(mail);
    assert.equal(smtp.accepted.length, 1);
  });
  await withServer({ answer: (v) => (v === "RCPT" ? "252 2.5.2 cannot verify" : undefined) }, async (smtp) => {
    const e = await failure(new SmtpTransport(options(smtp)).send(mail));
    assert.equal(e.status, 252);
    assert.equal(smtp.accepted.length, 0);
  });
});

test("a connection that is still being made when time runs out is closed, and the server sees it go", async () => {
  // A server that accepts and says nothing: for a connection that is encrypted from the first byte, the handshake never begins.
  const open = new Set<net.Socket>();
  let closed = 0;
  const silent = net.createServer((socket) => {
    open.add(socket);
    // Read, so that the end of the other side is noticed: a socket nobody reads from does not say it was closed.
    socket.resume();
    socket.on("error", () => undefined);
    socket.on("close", () => {
      open.delete(socket);
      closed += 1;
    });
  });
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
  try {
    const port = (silent.address() as net.AddressInfo).port;
    const e = await failure(new SmtpTransport({ host: "127.0.0.1", port, security: "tls", from: "no-reply@example.com", hello: "h", timeoutMs: 150 }).send(mail));
    assert.match(e.message, /did not finish within 0\.15 seconds/);
    const until = Date.now() + 2_000;
    while (closed === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    assert.equal(closed, 1, "the connection that was being made was closed, and not left to the end of the process");
  } finally {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => silent.close(() => resolve()));
  }
});
