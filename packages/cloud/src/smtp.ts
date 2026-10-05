/**
 * Mail over SMTP, to any provider that offers it, with nothing but the standard library.
 *
 * `SmtpTransport` delivers one message now: it connects, says EHLO, upgrades to TLS where the configuration says to, signs in
 * where it has credentials, sends the message and hangs up. It does not retry and does not queue; a failure is thrown as an
 * {@link SmtpError}, which says whether the message was refused for good (the recipient does not exist) and whether the trouble
 * is in reaching or using the service (it is down, the sign-in failed, the sender is not accepted). `QueuedMailer`
 * (mail-queue.ts) is what makes delivery something that survives a provider being down.
 *
 * What it will not do:
 *   - send a password over a connection that is not encrypted, unless the server is on this machine;
 *   - send anything unencrypted when the configuration asks for TLS: a server that does not offer STARTTLS is an error, and so
 *     is a certificate that does not verify;
 *   - put anything a caller gave it into a header or a command without checking it holds no line break, which is how an address
 *     becomes a way to send other mail.
 */
import { randomBytes } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";
import * as tls from "node:tls";
import { StringDecoder } from "node:string_decoder";
import type { Duplex } from "node:stream";
import { domainToASCII } from "node:url";
import { DeliveryError, type Mail, type Mailer } from "./mailer";

/** `status` is the server's three-digit answer, or 0 when there was none (the connection failed, or went quiet). */
export class SmtpError extends DeliveryError {
  constructor(
    message: string,
    readonly status: number,
    permanent: boolean,
    transport: boolean,
  ) {
    super(message, permanent, transport);
    this.name = "SmtpError";
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  /** `tls`: encrypted from the first byte (port 465). `starttls`: plain, then upgraded before anything private is said (587). `none`: plain throughout, for a relay on a network that is trusted. */
  security: "tls" | "starttls" | "none";
  /** The account to sign in as, when the server asks for one. */
  user?: string;
  password?: string;
  /** The address mail is sent from: `no-reply@example.com`, or `Curule <no-reply@example.com>`. */
  from: string;
  /** What this machine calls itself in EHLO. Default: its host name. */
  hello?: string;
  /** How long a whole delivery may take. Default 30 seconds. */
  timeoutMs?: number;
  clock?: () => Date;
  /** For tests: how a connection is made. The defaults are `net.connect` and `tls.connect`. It gives up when `signal` aborts. */
  connect?: (o: { host: string; port: number; secure: boolean; signal: AbortSignal }) => Promise<Duplex>;
  /** For tests: how a plain connection is upgraded. The default is `tls.connect` over the same socket, verifying the server's name. */
  upgrade?: (socket: Duplex, host: string) => Promise<Duplex>;
}

const refused = (why: string): never => {
  // Not a failure of the service: this message cannot be sent by any means, so it is not tried again.
  throw new SmtpError(why, 0, true, false);
};

const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

const notAnAddress = (address: string, why = ""): never => refused(`'${address.replace(/[\r\n]/g, " ").slice(0, 80)}' is not an address mail can be sent to${why}`);

/**
 * An address that is safe to put in a command: one mailbox, no line break, no angle bracket, and a domain in ASCII (a name
 * such as `bücher.de` becomes `xn--bcher-kva.de`). A local part that is not ASCII needs an extension that this does not use.
 */
export function mailbox(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 1 || address.length > 254) return notAnAddress(address);
  const local = address.slice(0, at);
  const domain = domainToASCII(address.slice(at + 1));
  if (local.length > 64 || !LOCAL_PART.test(local)) return notAnAddress(address, ": its part before the @ is not one that is sent");
  // A top-level name is letters (or an xn-- name), never only digits: `user@1.2.3.4` is an address of a machine, not of a mailbox.
  if (!DOMAIN.test(domain) || /^\d+$/.test(domain.slice(domain.lastIndexOf(".") + 1)) || domain.length - domain.lastIndexOf(".") < 3) return notAnAddress(address, ": its domain is not one");
  return `${local}@${domain}`;
}

/** What is inside the angle brackets of a `From:` value: `Curule <no-reply@example.com>` is `no-reply@example.com`. */
export function addressOf(from: string): string {
  const value = from.trim();
  // A line break anywhere in it is a way to say more than an address, whatever follows the last bracket.
  if (/[\r\n]/.test(value)) return notAnAddress(value);
  const named = /<([^<>]+)>$/.exec(value);
  return mailbox((named ? named[1]! : value).trim());
}

/** A header value: text that is not plain ASCII becomes RFC 2047 words, at most 75 characters each, folded onto lines that begin with a space. */
export function headerValue(text: string): string {
  if (/[\r\n]/.test(text)) return refused("a header holds a line break");
  if (/^[\x20-\x7e]*$/.test(text)) {
    if (text.length > 900) return refused("a header is longer than a line can be");
    return text;
  }
  const words: string[] = [];
  let word = "";
  // By character, so that no character is cut between two words.
  for (const ch of text) {
    if (Buffer.byteLength(word + ch, "utf8") > 45) {
      words.push(word);
      word = "";
    }
    word += ch;
  }
  if (word !== "") words.push(word);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** Quoted-printable (RFC 2045): the body as bytes any server passes, in lines of at most 76 characters. */
export function quotedPrintable(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    let encoded = "";
    const bytes = Buffer.from(line, "utf8");
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      // A space or tab at the end of a line would be lost in transit, so it is written as an escape.
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      encoded += plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    // Break long lines with a soft break, never inside an escape.
    while (encoded.length > 76) {
      let cut = 75;
      if (encoded[cut - 1] === "=") cut -= 1;
      else if (encoded[cut - 2] === "=") cut -= 2;
      out.push(`${encoded.slice(0, cut)}=`);
      encoded = encoded.slice(cut);
    }
    out.push(encoded);
  }
  return out.join("\r\n");
}

/** A `From:` value: a name that is not plain ASCII is encoded and a name with punctuation is quoted, and the address is left as it is. */
export function fromHeader(from: string): string {
  const named = /^(.*?)\s*<([^<>]+)>\s*$/.exec(from);
  if (!named) return mailbox(from.trim());
  const name = named[1]!.trim().replace(/^"(.*)"$/, "$1");
  const address = mailbox(named[2]!.trim());
  if (name === "") return `<${address}>`;
  const ascii = /^[\x20-\x7e]*$/.test(name);
  const shown = ascii && /[",;<>()[\]:@\\]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : headerValue(name);
  return `${shown} <${address}>`;
}

/** The message as it goes on the wire after DATA: headers, a blank line, the body, and every line that begins with a dot given another. */
export function formatMessage(mail: Mail, o: { from: string; hello: string; now: Date }): string {
  const to = mailbox(mail.to);
  const id = `<${randomBytes(12).toString("hex")}@${o.hello.replace(/[^A-Za-z0-9.-]/g, "") || "localhost"}>`;
  const headers = [
    `From: ${fromHeader(o.from)}`,
    `To: ${to}`,
    `Subject: ${headerValue(mail.subject)}`,
    `Date: ${o.now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: ${id}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    // The mail is the service answering something a person did, which is what this header says, and what keeps an out-of-office reply from answering it.
    "Auto-Submitted: auto-generated",
  ];
  const message = `${headers.join("\r\n")}\r\n\r\n${quotedPrintable(mail.text)}`;
  return message.replace(/^\./gm, "..");
}

/** A server's answer: its code and its lines of text. */
interface Reply {
  status: number;
  lines: string[];
}

/** The longest reply that is read: a server that sends more without ending a line is not speaking SMTP. */
const MAX_REPLY = 65_536;

class Session {
  private buffer = "";
  private waiting: { resolve(r: Reply): void; reject(e: Error): void } | undefined;
  private pending: Reply[] = [];
  private failure: Error | undefined;
  private partial: string[] = [];
  private partialBytes = 0;
  private off: (() => void) | undefined;
  private decoder = new StringDecoder("utf8");

  constructor(private socket: Duplex) {
    this.attach(socket);
  }

  private attach(socket: Duplex): void {
    const fail = (err: Error): void => {
      this.failure ??= err;
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w.reject(err);
      }
    };
    const onData = (chunk: Buffer | string): void => {
      this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
      for (;;) {
        const at = this.buffer.indexOf("\r\n");
        if (at < 0) break;
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 2);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        this.partial.push(m[3]!);
        this.partialBytes += line.length;
        if (m[2] === " ") {
          const reply: Reply = { status: Number(m[1]), lines: this.partial };
          this.partial = [];
          this.partialBytes = 0;
          if (this.waiting) {
            const w = this.waiting;
            this.waiting = undefined;
            w.resolve(reply);
          } else this.pending.push(reply);
        }
      }
      if (this.buffer.length > MAX_REPLY || this.partialBytes > MAX_REPLY) {
        fail(new SmtpError("the server sent a reply that is too long to be SMTP", 0, false, true));
        socket.destroy();
      }
    };
    const onError = (err: Error): void => fail(new SmtpError(`the connection failed: ${err.message}`, 0, false, true));
    const onClose = (): void => fail(new SmtpError("the server closed the connection", 0, false, true));
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    this.off = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
  }

  /** Stop listening to this socket, as it is about to be wrapped in TLS: what comes from it next is not for this session to read. */
  detach(): void {
    this.off?.();
    this.off = undefined;
    // The wrapped socket reports what goes wrong with it; an error on this one is no longer anybody's to handle, and must not end the process.
    this.socket.on("error", () => undefined);
  }

  /** Go on over the encrypted socket. What was read before it is not what it says. */
  upgrade(socket: Duplex): void {
    this.socket = socket;
    this.buffer = "";
    this.partial = [];
    this.partialBytes = 0;
    this.pending = [];
    this.failure = undefined;
    this.decoder = new StringDecoder("utf8");
    this.attach(socket);
  }

  reply(): Promise<Reply> {
    const ready = this.pending.shift();
    if (ready) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise<Reply>((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  write(text: string): void {
    this.socket.write(text);
  }

  /** Say goodbye and hang up. The message is already accepted, so nothing that goes wrong here may fail it. */
  close(): void {
    const socket = this.socket;
    socket.on("error", () => undefined);
    try {
      socket.end("QUIT\r\n");
    } catch {
      // The connection is already gone.
    }
    setTimeout(() => socket.destroy(), 1_000).unref();
  }

  destroy(): void {
    this.socket.on("error", () => undefined);
    this.socket.destroy();
  }
}

/** Where in the conversation an answer came: what a refusal means depends on it. */
type Stage = "greeting" | "EHLO" | "STARTTLS" | "sign-in" | "sender" | "recipient" | "DATA" | "message";

const AT_STAGE: Record<Stage, string> = {
  greeting: "when it was connected to",
  EHLO: "to EHLO",
  STARTTLS: "to STARTTLS",
  "sign-in": "to the sign-in",
  sender: "to the sender",
  recipient: "to the recipient",
  DATA: "to DATA",
  message: "to the message",
};

function expect(reply: Reply, stage: Stage, ...codes: number[]): Reply {
  if (codes.includes(reply.status)) return reply;
  // Only the recipient is refused for good: a server that will not take this address will not take it later. A refusal of the
  // sender or of the sign-in is a mistake in the configuration, which is the operator's to put right, and it holds back every
  // message; a refusal of the message itself is tried again, because it may be the sender's standing and not the words.
  const aboutTheMessage = stage === "recipient" || stage === "DATA" || stage === "message";
  const permanent = stage === "recipient" && reply.status >= 500;
  const transport = !aboutTheMessage || reply.status === 421;
  const said = reply.lines.join(" ").trim();
  throw new SmtpError(`the server answered ${reply.status}${said === "" ? "" : ` ${said}`} (${AT_STAGE[stage]})`, reply.status, permanent, transport);
}

/** This machine, by name or by address. `127.example.com` is a name somebody else may own, so only an address that is one counts. */
const isLoopback = (host: string): boolean => host === "localhost" || host === "::1" || host === "[::1]" || (net.isIPv4(host) && host.startsWith("127."));

/** Delivers a message over SMTP, now, or throws an {@link SmtpError}. */
export class SmtpTransport implements Mailer {
  constructor(private readonly o: SmtpOptions) {}

  async send(mail: Mail): Promise<void> {
    const from = addressOf(this.o.from);
    const to = mailbox(mail.to);
    const now = (this.o.clock ?? (() => new Date()))();
    const hello = (this.o.hello ?? os.hostname()).replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    const body = formatMessage(mail, { from: this.o.from, hello, now });
    const timeoutMs = this.o.timeoutMs ?? 30_000;
    const held: { session?: Session } = {};
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        held.session?.destroy();
        reject(new SmtpError(`the server did not finish within ${timeoutMs / 1000} seconds`, 0, false, true));
      }, timeoutMs);
    });
    try {
      await Promise.race([this.deliver(held, abort.signal, from, to, body, hello), deadline]);
    } catch (err) {
      abort.abort();
      held.session?.destroy();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    // What the server said after it accepted the message is not part of the delivery, and cannot undo it.
    held.session?.close();
  }

  private async deliver(held: { session?: Session }, signal: AbortSignal, from: string, to: string, body: string, hello: string): Promise<void> {
    const o = this.o;
    const connect = o.connect ?? defaultConnect;
    let socket: Duplex;
    try {
      socket = await connect({ host: o.host, port: o.port, secure: o.security === "tls", signal });
    } catch (err) {
      throw new SmtpError(`could not connect to ${o.host}:${o.port}: ${(err as Error).message}`, 0, false, true);
    }
    // The time ran out while the connection was being made: it is not used, and nothing is sent on it.
    if (signal.aborted) {
      socket.destroy();
      throw new SmtpError("the delivery was given up before the connection was made", 0, false, true);
    }
    const session = new Session(socket);
    held.session = session;
    expect(await session.reply(), "greeting", 220);
    const ehlo = async (): Promise<string[]> => {
      session.write(`EHLO ${hello}\r\n`);
      return expect(await session.reply(), "EHLO", 250).lines.map((l) => l.toUpperCase());
    };
    let features = await ehlo();
    let encrypted = o.security === "tls";
    if (o.security === "starttls") {
      if (!features.some((f) => f.startsWith("STARTTLS"))) throw new SmtpError(`${o.host} does not offer STARTTLS, and the configuration asks for it: mail is not sent unencrypted`, 0, false, true);
      session.write("STARTTLS\r\n");
      expect(await session.reply(), "STARTTLS", 220);
      session.detach();
      session.upgrade(
        await (o.upgrade ?? defaultUpgrade)(socket, o.host).catch((err: Error) => {
          throw new SmtpError(`the TLS handshake with ${o.host} failed: ${err.message}`, 0, false, true);
        }),
      );
      encrypted = true;
      // What the server said before it was encrypted is not to be relied on.
      features = await ehlo();
    }
    if (o.user !== undefined && o.password !== undefined) {
      if (!encrypted && !isLoopback(o.host)) throw new SmtpError(`refusing to send a password to ${o.host} over a connection that is not encrypted`, 0, false, true);
      if (/[\0\r\n]/.test(o.user) || /[\0\r\n]/.test(o.password)) throw new SmtpError("the user name or the password holds a character that cannot be sent in a sign-in", 0, false, true);
      // Some servers also say it in the older form, `AUTH=PLAIN LOGIN`.
      const mechanisms = [...new Set(features.filter((f) => f.startsWith("AUTH")).flatMap((f) => f.replace(/^AUTH=/, "AUTH ").split(/\s+/).slice(1)))];
      if (mechanisms.includes("PLAIN")) {
        session.write(`AUTH PLAIN ${Buffer.from(`\0${o.user}\0${o.password}`, "utf8").toString("base64")}\r\n`);
        expect(await session.reply(), "sign-in", 235);
      } else if (mechanisms.includes("LOGIN")) {
        session.write("AUTH LOGIN\r\n");
        expect(await session.reply(), "sign-in", 334);
        session.write(`${Buffer.from(o.user, "utf8").toString("base64")}\r\n`);
        expect(await session.reply(), "sign-in", 334);
        session.write(`${Buffer.from(o.password, "utf8").toString("base64")}\r\n`);
        expect(await session.reply(), "sign-in", 235);
      } else {
        throw new SmtpError(`${o.host} offers no sign-in this can use (it offers: ${mechanisms.join(", ") || "none"})`, 0, false, true);
      }
    }
    session.write(`MAIL FROM:<${from}>\r\n`);
    expect(await session.reply(), "sender", 250);
    session.write(`RCPT TO:<${to}>\r\n`);
    expect(await session.reply(), "recipient", 250, 251);
    session.write("DATA\r\n");
    expect(await session.reply(), "DATA", 354);
    session.write(`${body}\r\n.\r\n`);
    expect(await session.reply(), "message", 250);
  }
}

function defaultConnect(o: { host: string; port: number; secure: boolean; signal: AbortSignal }): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const socket = o.secure ? tls.connect({ host: o.host, port: o.port, servername: net.isIP(o.host) ? undefined : o.host }) : net.connect({ host: o.host, port: o.port });
    const abort = (): void => void socket.destroy(new Error("given up"));
    o.signal.addEventListener("abort", abort, { once: true });
    socket.once(o.secure ? "secureConnect" : "connect", () => {
      o.signal.removeEventListener("abort", abort);
      resolve(socket);
    });
    socket.once("error", (err) => {
      o.signal.removeEventListener("abort", abort);
      reject(err);
    });
  });
}

function defaultUpgrade(socket: Duplex, host: string): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    const secured = tls.connect({ socket: socket as net.Socket, servername: net.isIP(host) ? undefined : host });
    secured.once("secureConnect", () => resolve(secured));
    secured.once("error", reject);
  });
}
