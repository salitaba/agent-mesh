/**
 * Sign-in: what a response means and what to tell the person. DOM-free (see route.ts), so every sentence the page can say
 * about a failed sign-in is chosen here, in one place a test can reach, from what the server actually answered.
 *
 * The gate (auth.tsx) asks the server two things: `GET /auth/status` on load and whenever a call comes back 401, and
 * `POST /auth/login` when the person submits. This reads both answers.
 */

/** Said when a session ends under someone who was using the console. Not the same as never having signed in. */
export const SESSION_ENDED = "Your session ended. Sign in again.";

/** Said when Sign in is pressed with nothing in the field. The button stays pressable: a faded one explains nothing. */
export const TOKEN_FIRST = "Paste the access token first.";

/** What `GET /auth/status` came to: the console, the sign-in page, or a host that is not answering. */
export type GateReading = { kind: "open" } | { kind: "login" } | { kind: "unreachable" };

/**
 * `res` is null when the request itself failed (the host is down, the address is wrong). A host that answers 5xx is not
 * answering either: a proxy in front of a stopped host says 502, and showing the console over that is showing a console
 * that cannot work. A route the server does not have (an older server) or a body that is not the shape asked for leaves the
 * console open, as it always did: the server's own 401s are what protect it, and this is how an operator gets in, not
 * what keeps anyone out.
 */
export function readGate(res: { status: number; body: unknown } | null): GateReading {
  if (res === null) return { kind: "unreachable" };
  if (res.status >= 500) return { kind: "unreachable" };
  const body = res.body as { required?: unknown; authenticated?: unknown } | null;
  if (res.status < 200 || res.status >= 300 || typeof body?.required !== "boolean") return { kind: "open" };
  return !body.required || body.authenticated === true ? { kind: "open" } : { kind: "login" };
}

export type SignInOutcome =
  | { kind: "signed-in" }
  | { kind: "wrong-token"; message: string }
  /** `seconds` is how long to wait; `estimated` when the server did not say and this is a guess, which the words admit. */
  | { kind: "rate-limited"; seconds: number; estimated: boolean; message: string }
  | { kind: "unreachable"; message: string }
  /** A refusal that is about this browser's request, not the token (a host name or origin the server does not allow). */
  | { kind: "refused"; status: number; message: string }
  | { kind: "server-error"; status: number; message: string };

/** How long to hold the button when a 429 names no wait. The server's window is a minute at most; this is half of it. */
export const FALLBACK_WAIT_SECONDS = 30;

export const waitPhrase = (seconds: number): string => `${seconds} second${seconds === 1 ? "" : "s"}`;

/** `attempt` is null when the request failed before an answer came. */
export function classifyLogin(attempt: { status: number; retryAfter: string | null; body: unknown } | null): SignInOutcome {
  if (attempt === null) {
    return { kind: "unreachable", message: "Could not reach the host. Check that it is running and that this address is right, then try again." };
  }
  const { status } = attempt;
  const body = (attempt.body ?? {}) as { error?: unknown; retryAfterSec?: unknown };
  if (status >= 200 && status < 300) return { kind: "signed-in" };
  if (status === 401) {
    return { kind: "wrong-token", message: "That token was not accepted. Copy it again from where this host was started, then paste it here." };
  }
  if (status === 429) {
    const header = Number(attempt.retryAfter);
    const fromBody = Number(body.retryAfterSec);
    const told = Number.isFinite(header) && header > 0 ? header : Number.isFinite(fromBody) && fromBody > 0 ? fromBody : 0;
    const seconds = told > 0 ? Math.ceil(told) : FALLBACK_WAIT_SECONDS;
    const estimated = told <= 0;
    return {
      kind: "rate-limited", seconds, estimated,
      message: `Too many wrong tokens from this address. Wait ${estimated ? "about " : ""}${waitPhrase(seconds)} before trying again.`,
    };
  }
  if (status >= 500) {
    return { kind: "server-error", status, message: `The host answered ${status}. It may be restarting. Try again in a moment.` };
  }
  // 403 and 421 come from the host's own checks, and their text names the setting to change: say it as it is.
  const said = typeof body.error === "string" ? body.error.trim().slice(0, 240) : "";
  return { kind: "refused", status, message: said ? `The host refused this request: ${said}` : `The host refused this request (${status}).` };
}

/** A message as a short headline and what follows it, split at the first full stop that is followed by a space. */
export function splitSentence(message: string): { title: string; detail: string } {
  const at = message.search(/\.\s/);
  return at < 0 ? { title: message, detail: "" } : { title: message.slice(0, at + 1), detail: message.slice(at + 2).trim() };
}

/** Seconds left until `untilMs`, rounded up so the last tick reads 1 and the button frees at 0. */
export const secondsLeft = (untilMs: number, nowMs: number): number => Math.max(0, Math.ceil((untilMs - nowMs) / 1000));

/**
 * What a person pasted, made into the token. Whitespace and a newline from a terminal selection are the usual damage; quotes and the variable's
 * own name come along when the line was copied from a shell or a `.env` file. The ends only: a token is whatever the host was started with.
 */
export function normalizeToken(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^export\s+/, "").replace(/^MESH_API_TOKEN\s*=\s*/, "").trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1).trim();
  return t;
}

const isLoopbackName = (hostname: string): boolean => {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
};

/**
 * Said above the form when the token would cross a network in the clear: the page came over plain http from an address
 * that is not this machine. Loopback over http is how a laptop host is reached and is fine.
 */
export function connectionWarning(protocol: string, hostname: string): string | null {
  if (protocol !== "http:" || isLoopbackName(hostname)) return null;
  return "This page was loaded over plain http, so the token you type crosses the network unencrypted. Put the host behind HTTPS before you sign in from another machine.";
}

/** A sentence as pieces: plain text, and the names (variables, commands) the page sets in monospace. */
export type Piece = string | { code: string };

export interface TokenSource {
  id: string;
  /** How the host is run. */
  title: string;
  /** Where the token comes from, as a sentence. */
  where: readonly Piece[];
  /** What to type to read it back, when there is one. */
  command?: string;
}

/**
 * Where the token comes from for each way a host is run, with the names the deployment documents use
 * (docs/operations.md, docs/commercial/deployment.md). Data, not markup, so the page and a test read one list.
 */
export const TOKEN_SOURCES: readonly TokenSource[] = [
  {
    id: "process",
    title: "A host you started yourself (curule host)",
    where: ["It is the value of ", { code: "MESH_API_TOKEN" }, " in the environment the host was started from. A host that listens only on 127.0.0.1 may run without one. Then this page does not appear."],
    command: "echo $MESH_API_TOKEN",
  },
  {
    id: "docker",
    title: "Docker or Docker Compose",
    where: ["It is the ", { code: "MESH_API_TOKEN" }, " you passed: ", { code: "-e MESH_API_TOKEN=..." }, " to ", { code: "docker run" }, ", or the variable exported before ", { code: "docker compose up" }, ". Read it back from the running container:"],
    command: "docker compose exec mesh printenv MESH_API_TOKEN",
  },
  {
    id: "kubernetes",
    title: "Kubernetes (Helm)",
    where: ["It is the ", { code: "MESH_API_TOKEN" }, " key of the Secret named in ", { code: "auth.existingSecret" }, ". Read it back:"],
    command: "kubectl -n <namespace> get secret <secret> -o jsonpath='{.data.MESH_API_TOKEN}' | base64 -d",
  },
];

/** The pieces as plain text, for a test and for anything that cannot style them. */
export const piecesText = (pieces: readonly Piece[]): string => pieces.map((p) => (typeof p === "string" ? p : p.code)).join("");
