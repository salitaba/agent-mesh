import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import type { Duplex } from "node:stream";

/** A message the fake server accepted. `data` is what was sent after DATA, with the dots un-stuffed and the closing line removed. */
export interface Accepted {
  from: string;
  to: string[];
  data: string;
  encrypted: boolean;
  user?: string;
}

export interface FakeOptions {
  /** The port to listen on, when it is one a test has already given out. Default: any free one. */
  port?: number;
  /** The first line the server says. `hang` says nothing; `close` hangs up. Default `220 fake.test ESMTP`. */
  greeting?: string;
  /** What EHLO lists besides STARTTLS: `AUTH PLAIN LOGIN`, `PIPELINING`. */
  features?: string[];
  /** What EHLO lists only while the connection is plain. */
  featuresBeforeTls?: string[];
  /** What EHLO lists once the connection is encrypted. */
  featuresAfterTls?: string[];
  /** `real`: STARTTLS is offered and done with TLS, using `tls`. `pretend`: it is offered and answered 220, and the conversation goes on in plain text. */
  starttls?: "real" | "pretend";
  tls?: { key: string; cert: string };
  /** The connection is TLS from the first byte. */
  implicitTls?: boolean;
  credentials?: { user: string; password: string };
  /**
   * Replace what the server says to a command (`EHLO`, `MAIL`, `RCPT`, `DATA`, `AUTH`, `QUIT`, and `BODY` for the end of the message).
   * Return `hang` to say nothing, `close` to hang up and `reset` to cut the connection. A reply that starts 220, 235, 250 or 354 is acted on as the real one would be.
   */
  answer?: (verb: string, line: string, session: { encrypted: boolean; commands: string[] }) => string | undefined;
  /** Say each reply a byte at a time. */
  trickle?: boolean;
  /** Hang up as soon as the message is accepted, without waiting for QUIT. */
  closeAfterBody?: boolean;
}

export class FakeSmtp {
  readonly accepted: Accepted[] = [];
  /** For each connection, the lines the client sent. */
  readonly transcripts: string[][] = [];
  /** How many connections have ended. */
  closed = 0;
  private readonly sockets = new Set<Duplex>();

  private constructor(
    private readonly o: FakeOptions,
    readonly server: net.Server,
  ) {}

  static async start(o: FakeOptions = {}): Promise<FakeSmtp> {
    let fake: FakeSmtp | undefined;
    const handler = (socket: net.Socket): void => fake!.serve(socket, o.implicitTls === true);
    const server = o.implicitTls ? tls.createServer({ key: o.tls!.key, cert: o.tls!.cert }, handler) : net.createServer(handler);
    fake = new FakeSmtp(o, server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(o.port ?? 0, "127.0.0.1", () => resolve());
    });
    return fake;
  }

  get port(): number {
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Wait until `n` connections have ended, or `ms` have passed. */
  async untilClosed(n: number, ms = 3_000): Promise<void> {
    const until = Date.now() + ms;
    while (this.closed < n && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
  }

  private serve(first: Duplex, secure: boolean): void {
    const o = this.o;
    let socket: Duplex = first;
    let encrypted = secure;
    const commands: string[] = [];
    this.transcripts.push(commands);
    let buffer = "";
    let mode: "command" | "data" | "user" | "password" = "command";
    let from = "";
    let to: string[] = [];
    let pendingUser = "";
    let user: string | undefined;
    let ended = false;

    const say = (text: string): void => {
      const wire = `${text.split("\n").join("\r\n")}\r\n`;
      if (!o.trickle) {
        socket.write(wire);
        return;
      }
      let i = 0;
      const next = (): void => {
        if (i >= wire.length || socket.destroyed) return;
        socket.write(wire[i++]!);
        setImmediate(next);
      };
      next();
    };

    const decide = (verb: string, line: string, fallback: string): string | undefined => {
      const custom = o.answer?.(verb, line, { encrypted, commands });
      if (custom === "hang") return undefined;
      if (custom === "close") {
        socket.destroy();
        return undefined;
      }
      if (custom === "reset") {
        // A connection that is cut, as a network does it, and not ended: the other side hears an error and not a close.
        (socket as net.Socket).resetAndDestroy();
        return undefined;
      }
      return custom ?? fallback;
    };

    const handle = (line: string): void => {
      commands.push(line);
      if (mode === "user") {
        pendingUser = Buffer.from(line, "base64").toString("utf8");
        mode = "password";
        say("334 UGFzc3dvcmQ6");
        return;
      }
      if (mode === "password") {
        mode = "command";
        const password = Buffer.from(line, "base64").toString("utf8");
        const good = o.credentials !== undefined && pendingUser === o.credentials.user && password === o.credentials.password;
        const text = decide("AUTH", line, good ? "235 2.7.0 welcome" : "535 5.7.8 credentials rejected");
        if (text !== undefined) say(text);
        if (text?.startsWith("235")) user = pendingUser;
        return;
      }
      const verb = line.split(" ")[0]!.toUpperCase();
      switch (verb) {
        case "EHLO":
        case "HELO": {
          const lines = ["fake.test greets you", ...(o.features ?? []), ...(encrypted ? (o.featuresAfterTls ?? []) : (o.featuresBeforeTls ?? [])), ...(!encrypted && o.starttls ? ["STARTTLS"] : [])];
          const text = decide("EHLO", line, lines.map((l, i) => `250${i === lines.length - 1 ? " " : "-"}${l}`).join("\n"));
          if (text !== undefined) say(text);
          return;
        }
        case "STARTTLS": {
          const text = decide("STARTTLS", line, o.starttls ? "220 2.0.0 ready to start TLS" : "502 5.5.1 not implemented");
          if (text === undefined) return;
          say(text);
          if (text.startsWith("220") && o.starttls) {
            buffer = "";
            if (o.starttls === "real") {
              const raw = socket;
              raw.removeListener("data", onData);
              const secured = new tls.TLSSocket(raw as net.Socket, { isServer: true, secureContext: tls.createSecureContext({ key: o.tls!.key, cert: o.tls!.cert }) });
              socket = secured;
              attach(secured);
            }
            encrypted = true;
          }
          return;
        }
        case "AUTH": {
          if (!o.credentials) {
            const text = decide("AUTH", line, "503 5.5.1 no sign-in here");
            if (text !== undefined) say(text);
            return;
          }
          const [, mechanism, initial] = line.split(" ");
          if ((mechanism ?? "").toUpperCase() === "PLAIN" && initial) {
            const [, name, password] = Buffer.from(initial, "base64").toString("utf8").split("\0");
            const good = name === o.credentials.user && password === o.credentials.password;
            const text = decide("AUTH", line, good ? "235 2.7.0 welcome" : "535 5.7.8 credentials rejected");
            if (text !== undefined) say(text);
            if (text?.startsWith("235")) user = name;
          } else if ((mechanism ?? "").toUpperCase() === "LOGIN") {
            mode = "user";
            say("334 VXNlcm5hbWU6");
          } else say("504 5.5.4 mechanism not supported");
          return;
        }
        case "MAIL": {
          const text = decide("MAIL", line, "250 2.1.0 sender ok");
          if (text === undefined) return;
          say(text);
          if (text.startsWith("250")) from = /<([^>]*)>/.exec(line)?.[1] ?? "";
          return;
        }
        case "RCPT": {
          const text = decide("RCPT", line, "250 2.1.5 recipient ok");
          if (text === undefined) return;
          say(text);
          if (text.startsWith("250")) to.push(/<([^>]*)>/.exec(line)?.[1] ?? "");
          return;
        }
        case "DATA": {
          const text = decide("DATA", line, "354 go ahead");
          if (text === undefined) return;
          say(text);
          if (text.startsWith("354")) mode = "data";
          return;
        }
        case "QUIT": {
          const text = decide("QUIT", line, "221 2.0.0 bye");
          if (text !== undefined) {
            say(text);
            socket.end();
          }
          return;
        }
        case "RSET":
        case "NOOP":
          say("250 2.0.0 ok");
          return;
        default:
          say("502 5.5.2 command not recognised");
      }
    };

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      for (;;) {
        if (mode === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          const data = buffer.slice(0, end).replace(/^\.\./gm, ".");
          buffer = buffer.slice(end + 5);
          mode = "command";
          commands.push(`<${data.length} characters of message>`);
          const text = decide("BODY", data, "250 2.0.0 queued as 1234");
          if (text !== undefined) say(text);
          if (text?.startsWith("250")) this.accepted.push({ from, to, data, encrypted, ...(user !== undefined ? { user } : {}) });
          from = "";
          to = [];
          if (o.closeAfterBody) socket.destroy();
          continue;
        }
        const at = buffer.indexOf("\r\n");
        if (at < 0) return;
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        handle(line);
      }
    };

    const attach = (s: Duplex): void => {
      this.sockets.add(s);
      s.on("data", onData);
      s.on("error", () => undefined);
      s.on("close", () => {
        this.sockets.delete(s);
        if (!ended && s === socket) {
          ended = true;
          this.closed += 1;
        }
      });
    };
    attach(first);

    if (o.greeting === "hang") return;
    if (o.greeting === "close") {
      first.destroy();
      return;
    }
    say(o.greeting ?? "220 fake.test ESMTP");
  }
}

/** What a client sent as the body of a message, decoded: quoted-printable bytes as UTF-8 text, soft line breaks joined. */
export function decodeBody(data: string): string {
  const body = data.slice(data.indexOf("\r\n\r\n") + 4);
  const joined = body.replace(/=\r\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    if (joined[i] === "=" && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(joined[i]!, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8").replace(/\r\n/g, "\n");
}

/** The headers of a message as a map of lower-case name to value (folded lines joined). */
export function headersOf(data: string): Map<string, string> {
  const head = data.slice(0, data.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ");
  const map = new Map<string, string>();
  for (const line of head.split("\r\n")) {
    const at = line.indexOf(":");
    map.set(line.slice(0, at).toLowerCase(), line.slice(at + 1).trim());
  }
  return map;
}

/** An RFC 2047 header value read back: every `=?UTF-8?B?…?=` word decoded. */
export function decodeWords(value: string): string {
  // White space between two encoded words is not part of the text; white space between a word and plain text is.
  return value.replace(/(\?=)\s+(?==\?UTF-8\?B\?)/g, "$1").replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/g, (_, b64: string) => Buffer.from(b64, "base64").toString("utf8"));
}

export function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A self-signed certificate and key for the names given, made with the openssl command, in a folder of its own. */
export function selfSigned(names: string[]): { key: string; cert: string; certFile: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smtp-cert-"));
  const alt = names.map((n) => (net.isIP(n) ? `IP:${n}` : `DNS:${n}`)).join(",");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"), "-days", "2", "-subj", `/CN=${names[0]}`, "-addext", `subjectAltName=${alt}`], { stdio: "ignore" });
  return { key: fs.readFileSync(path.join(dir, "key.pem"), "utf8"), cert: fs.readFileSync(path.join(dir, "cert.pem"), "utf8"), certFile: path.join(dir, "cert.pem"), dir };
}
