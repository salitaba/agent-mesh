import * as dns from "dns";
import * as net from "net";
import { Agent, fetch as undiciFetch } from "undici";
import { ToolFailure, stringArg, type NativeTool, type NetworkPolicy, type ToolContext } from "./types";

/**
 * WebFetch: read a web page, without letting a seat reach what it was never meant to.
 *
 * A seat that can fetch a URL can be told to, by text in a repository or a page it already read, and a server that fetches
 * on a stranger's behalf is the textbook way to reach the machine's own metadata service (`169.254.169.254`, which hands out
 * cloud credentials), its loopback services and the private network behind it. So the address is judged, not the name: every
 * address a host name resolves to must be public, and the connection is made to the address that was judged (the lookup is
 * the one the HTTP client connects with, so a name that answers differently the second time cannot move it). Redirects go
 * through the same check on every hop, and an IP literal is judged before any lookup, since a literal has none.
 */

export const MAX_FETCH_BYTES = 2 * 1024 * 1024;
export const MAX_FETCH_CHARS = 40_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

const blocked = new net.BlockList();
for (const [net4, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net4, bits, "ipv4");
}
for (const [net6, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["100::", 64],
] as const) {
  blocked.addSubnet(net6, bits, "ipv6");
}

/** Is this address one a seat may connect to: public, unicast, and not a way back to the machine or its network? */
export function isPublicAddress(address: string): boolean {
  // An IPv4-mapped IPv6 address (::ffff:127.0.0.1) is matched against the IPv4 ranges by the block list itself. NAT64 is not:
  // it carries an IPv4 address inside, and that is the one to judge.
  const nat64 = /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (nat64) return isPublicAddress(nat64[1]!);
  const family = net.isIP(address);
  if (family === 0) return false;
  return !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type LookupResult = Array<{ address: string; family: number }>;

async function resolveHost(host: string, policy: NetworkPolicy | undefined): Promise<LookupResult> {
  if (policy?.lookup) return policy.lookup(host);
  return dns.promises.lookup(host, { all: true, verbatim: true });
}

async function judge(host: string, policy: NetworkPolicy | undefined): Promise<LookupResult> {
  const bare = host.replace(/^\[|\]$/g, "");
  const isPublic = policy?.isPublic ?? isPublicAddress;
  if (net.isIP(bare) !== 0) {
    if (!policy?.allowPrivate && !isPublic(bare)) throw new ToolFailure(`${host} is not a public address, and this seat may not fetch from it.`);
    return [{ address: bare, family: net.isIP(bare) }];
  }
  const found = await resolveHost(bare, policy);
  if (found.length === 0) throw new ToolFailure(`${host} did not resolve to an address.`);
  if (!policy?.allowPrivate) {
    const bad = found.find((a) => !isPublic(a.address));
    if (bad) throw new ToolFailure(`${host} resolves to ${bad.address}, which is not a public address, and this seat may not fetch from it.`);
  }
  return found;
}

/** An HTTP agent whose every connection goes to an address `judge` has just approved. */
function guardedAgent(policy: NetworkPolicy | undefined): Agent {
  const lookup: net.LookupFunction = (host, options, callback) => {
    judge(host, policy).then(
      (found) => {
        if (options.all) callback(null, found.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, found[0]!.address, found[0]!.family);
      },
      (err: Error) => callback(err, "", 0),
    );
  };
  return new Agent({ connect: { lookup } });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A page as text: scripts, styles and tags gone, block boundaries kept as line breaks. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(?:p|div|section|article|header|footer|main|nav|ul|ol|li|tr|table|h[1-6]|pre|blockquote|br|hr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
      }
      return ENTITIES[body.toLowerCase()] ?? whole;
    })
    .replace(/[ \t\f\v]+/g, " ")
    // One line break between blocks, no blank lines: the reader is a model, and a blank line is a token that says nothing.
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}

const TEXTUAL = /^(?:text\/|application\/(?:json|xml|xhtml\+xml|javascript|x-javascript|ld\+json|yaml|x-yaml)|[a-z]+\/[a-z.+-]*\+(?:json|xml))/i;

export const webFetchTool: NativeTool = {
  spec: {
    name: "WebFetch",
    description:
      "Fetch a web page or text resource over http or https and return its text (HTML is reduced to its readable text). " +
      "Only public addresses can be fetched. At most 40,000 characters are returned. The prompt, if given, is a reminder of what you are looking for; it does not change what is returned.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The http or https URL." },
        prompt: { type: "string", description: "What you are looking for in the page." },
      },
      required: ["url"],
    },
  },
  async run(args, ctx: ToolContext) {
    const raw = stringArg(args, "url", { required: true })!;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ToolFailure(`${raw} is not a valid URL.`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolFailure("only http and https URLs can be fetched.");
    if (url.username || url.password) throw new ToolFailure("a URL with credentials in it cannot be fetched.");
    // An IP literal has no lookup, so it is judged here, before the connection.
    await judge(url.hostname, ctx.network);

    const dispatcher = guardedAgent(ctx.network);
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const signal = AbortSignal.any([timeout, ctx.signal]);
    try {
      let current = url;
      for (let hop = 0; ; hop++) {
        const res = await undiciFetch(current, {
          dispatcher,
          signal,
          redirect: "manual",
          headers: { "user-agent": "curule-agent/1 (+https://curule.dev)", accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5" },
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          if (hop >= MAX_REDIRECTS) throw new ToolFailure(`too many redirects fetching ${raw}.`);
          current = new URL(location, current);
          if (current.protocol !== "http:" && current.protocol !== "https:") throw new ToolFailure("a redirect led to a URL that is not http or https.");
          await judge(current.hostname, ctx.network);
          await res.body?.cancel();
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          return { text: `${res.status} ${res.statusText} fetching ${current.href}`, isError: true };
        }
        const type = res.headers.get("content-type") ?? "";
        if (type !== "" && !TEXTUAL.test(type)) {
          await res.body?.cancel();
          throw new ToolFailure(`${current.href} is ${type}, which is not text; only text, HTML, JSON and XML can be fetched.`);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let cut = false;
        if (res.body) {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            size += chunk.byteLength;
            chunks.push(Buffer.from(chunk));
            if (size > MAX_FETCH_BYTES) {
              // Leaving the loop cancels the stream, and with it the download.
              cut = true;
              break;
            }
          }
        }
        const body = Buffer.concat(chunks).toString("utf8");
        let text = /html/i.test(type) || /^\s*<(?:!doctype html|html)/i.test(body) ? htmlToText(body) : body;
        const notes: string[] = [];
        if (cut) notes.push(`the response was cut at ${MAX_FETCH_BYTES} bytes`);
        if (text.length > MAX_FETCH_CHARS) {
          notes.push(`${text.length - MAX_FETCH_CHARS} more characters not shown`);
          text = text.slice(0, MAX_FETCH_CHARS);
        }
        const via = current.href === url.href ? "" : ` (redirected to ${current.href})`;
        return { text: `${text}${notes.length > 0 ? `\n[${notes.join("; ")}]` : ""}${via ? `\n[${via.trim()}]` : ""}` };
      }
    } catch (err) {
      if (err instanceof ToolFailure) throw err;
      if (ctx.signal.aborted) throw err;
      if (timeout.aborted) throw new ToolFailure(`fetching ${raw} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
      const cause = (err as { cause?: Error }).cause;
      if (cause instanceof ToolFailure) throw cause;
      throw new ToolFailure(`could not fetch ${raw}: ${cause?.message ?? (err as Error).message}`);
    } finally {
      void dispatcher.close();
    }
  },
};
