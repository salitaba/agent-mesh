/**
 * `curule-cloud trial`: the hosted service, whole, on one machine, with nothing real behind it.
 *
 * Everything the service is made of runs in this process or as its child: the model gateway, the control plane with its public
 * and owner listeners and its account pages, and a real Curule host for each workspace a person makes. It is how the service is
 * tried before anything is paid for or any account is made anywhere, and how it is shown to someone else. What stands in for what
 * would cost money or need an account is said by what this prints and by the pages:
 *
 *   - The model is a stand-in that answers every call with one sentence and uses no tool. Calls go through the real gateway, so
 *     keys, balance and usage behave as they would, and a mission will not get far: the point is the wiring, not the answer.
 *   - The payment page is the trial's own. Nothing is charged and no card is asked for; its button applies the payment as a
 *     provider's message would.
 *   - Mail is not sent. It is printed as it is written, and kept in the outbox file.
 *   - Workspaces are processes of this one, started by the local-process provisioner. That is not a boundary between customers,
 *     and the control plane refuses to use it in production.
 *
 * `hostingOnly` is the service as the owner sells it: plans with `byok`, no gateway, no balance and no top-ups, and a customer who brings
 * their own model key. A key is for a provider at a public https address, so the trial hands out one that no one owns
 * ({@link TRIAL_MODEL_ADDRESS}), and a workspace's host is told (a preload, {@link ./trial-reroute}) to send the calls made to it to a
 * stand-in on this machine. The stand-in answers as the other one does: one sentence, no tool, and any key will do.
 *
 * The figures in the plans and in the stand-in's prices are the trial's own. No figure in the product is an offer.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";
import { loadGatewayConfig, startGateway, type LogRecord as GatewayLogRecord, type RunningGateway } from "../../../packages/ai-gateway/src/index";
import {
  BillingUnsupportedError,
  BillingWebhookError,
  LocalProcessProvisioner,
  loadControlConfig,
  startControl,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type ControlLogRecord,
  type ControlPlane,
  type ProvisionedWorkspace,
  type Provisioner,
  type RunningControl,
  type WorkspaceRuntimeStatus,
  type WorkspaceSpec,
} from "../../../packages/cloud/src/index";
import { estimateTokens, type ChatMessage, type LlmProvider, type ModelEvent, type ModelRequest } from "../../../packages/llm/src/index";

/** What the stand-in says to every call. */
export const STAND_IN_SENTENCE = "This is the trial's stand-in model. It answers every call with this sentence, uses no tool, and is not a real model.";

/** A model that answers every call with one sentence. It lets the whole path from a seat to the ledger be exercised with nothing behind it. */
export class StandInModel implements LlmProvider {
  readonly kind = "openai-compatible";
  readonly endpoint = "the trial's stand-in model";
  /** How many calls it has answered. */
  calls = 0;

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent, void> {
    if (request.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    this.calls++;
    const prompt = estimateTokens(JSON.stringify([request.system ?? "", request.messages]));
    for (const word of STAND_IN_SENTENCE.split(/(?<=\s)/)) yield { kind: "text", delta: word };
    yield { kind: "end", result: { text: STAND_IN_SENTENCE, toolCalls: [], stopReason: "end_turn", usage: { input: prompt, output: estimateTokens(STAND_IN_SENTENCE), cacheRead: 0, cacheWrite: 0 }, model: "stand-in-1" } };
  }
}

/** The plans of the trial. */
export const TRIAL_PLANS = {
  currency: "USD",
  plans: {
    team: { title: "Team", licence_plan: "team", price_minor: 4_900, period: "month", included_usage: 10, workspaces: 1, tiers: ["fast", "balanced"], default_tier: "balanced", summary: "One workspace. The trial's figures are not an offer." },
    business: { title: "Business", licence_plan: "business", price_minor: 19_900, period: "month", included_usage: 50, workspaces: 3, summary: "Three workspaces, with every tier." },
  },
  topups: { options_minor: [1_000, 2_500, 10_000], minimum_minor: 500, maximum_minor: 100_000, usage_micros_per_minor: 10_000 },
};

/**
 * The plans of a hosting-only trial: the same two, but they sell hosting and nothing else. The customer brings the model key and pays their
 * provider, so there is no included usage, no tier and no top-up, and the control plane needs no gateway.
 */
export const TRIAL_HOSTING_PLANS = {
  currency: "USD",
  plans: {
    team: { title: "Team", licence_plan: "team", price_minor: 4_900, period: "month", workspaces: 1, byok: true, summary: "One workspace, and your own model key. The trial's figures are not an offer." },
    business: { title: "Business", licence_plan: "business", price_minor: 19_900, period: "month", workspaces: 3, byok: true, summary: "Three workspaces, each with a model key of its own." },
  },
};

/** What the stand-in's models cost and what is charged for them. */
export const TRIAL_PRICES = {
  currency: "USD",
  version: "trial",
  default_markup: 1.25,
  models: {
    "stand-in/small": { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 },
    "stand-in/medium": { input: 3, output: 12, cache_read: 0.3, cache_write: 3.75 },
    "stand-in/large": { input: 10, output: 40, cache_read: 1, cache_write: 12.5 },
  },
};

const money = (minor: number, currency: string): string => {
  const format = new Intl.NumberFormat("en", { style: "currency", currency });
  return format.format(minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
};

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---- the trial's own payment page ----

/** A provider that sends a customer to the trial's page, and remembers what they were asked to pay for. */
export class TrialBilling implements BillingProvider {
  readonly name = "trial";
  readonly pending = new Map<string, CheckoutInput>();

  constructor(private readonly payUrl: (ref: string) => string) {}

  async createCheckout(input: CheckoutInput): Promise<{ url: string; ref: string }> {
    const ref = `trial_${randomBytes(9).toString("base64url")}`;
    this.pending.set(ref, input);
    return { url: this.payUrl(ref), ref };
  }

  async openPortal(): Promise<{ url: string }> {
    throw new BillingUnsupportedError("The trial has no billing portal: there is nothing to manage. A plan is changed on the account page, and nothing is charged.");
  }

  parseWebhook(): BillingEvent[] {
    throw new BillingWebhookError("The trial receives no messages from a payment provider.");
  }
}

function payPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 30rem; margin: 12vh auto; padding: 0 20px; }
  h1 { font-size: 1.5rem; line-height: 1.2; margin: 0 0 .5rem; }
  .trial { padding: .6rem .9rem; border: 1px dashed currentColor; border-radius: 10px; margin: 0 0 1.5rem; }
  .what { font-size: 1.25rem; font-weight: 650; margin: 1rem 0; }
  button, a.cancel { font: inherit; padding: .7rem 1.2rem; border-radius: 10px; border: 1px solid currentColor; background: none; color: inherit; cursor: pointer; text-decoration: none; display: inline-block; }
  button { background: #2b5fd9; border-color: #2b5fd9; color: #fff; font-weight: 600; }
  .row { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: 1.5rem; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** A small form, read whole. A body that is larger than one can be is read to its end and thrown away, so the answer can still be sent. */
function readForm(req: http.IncomingMessage): Promise<URLSearchParams | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= 4_096) chunks.push(c);
    });
    req.on("end", () => resolve(size > 4_096 ? undefined : new URLSearchParams(Buffer.concat(chunks).toString("utf8"))));
    req.on("error", reject);
  });
}

/** The page a customer is sent to to pay, and what pressing its button does: apply the payment as a provider's message would. */
export function createPayServer(billing: TrialBilling, plane: () => ControlPlane, clock: () => Date = () => new Date()): http.Server {
  const send = (res: http.ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", ...headers });
    res.end(html);
  };
  const unknown = (res: http.ServerResponse): void => send(res, 404, payPage("Not a payment of this trial", `<h1>Not a payment of this trial</h1><p>This link is not one the trial made. It may be from an earlier run. Go back to the account page and start again.</p>`));

  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/pay") return send(res, 404, payPage("Not found", "<h1>Not found</h1>"));
      if (req.method === "GET") {
        const input = billing.pending.get(url.searchParams.get("ref") ?? "");
        if (!input) return unknown(res);
        const what = input.purpose === "subscription" && input.plan ? `${input.plan.title}, ${money(input.plan.priceMinor, input.currency)} a ${input.plan.period}` : `Credit, ${money(input.amountMinor ?? 0, input.currency)}`;
        const ref = url.searchParams.get("ref")!;
        return send(
          res,
          200,
          payPage(
            "Pay: a trial",
            `<h1>Pay</h1>
<p class="trial">This is the trial's own payment page. Nothing is charged and no card is asked for.</p>
<p>Paying as ${escapeHtml(input.email)}.</p>
<p class="what">${escapeHtml(what)}</p>
<form method="post" action="/pay">
<input type="hidden" name="ref" value="${escapeHtml(ref)}">
<div class="row"><button type="submit">Pay, and charge nothing</button><a class="cancel" href="${escapeHtml(input.cancelUrl)}">Cancel</a></div>
</form>`,
          ),
        );
      }
      if (req.method === "POST") {
        const form = await readForm(req).catch(() => undefined);
        if (form === undefined) return send(res, 413, payPage("Too large", "<h1>Too large</h1><p>That request is larger than a payment is.</p>"));
        const ref = form.get("ref") ?? "";
        const input = billing.pending.get(ref);
        if (!input) return unknown(res);
        const amountMinor = input.purpose === "subscription" && input.plan ? input.plan.priceMinor : (input.amountMinor ?? 0);
        // The same reference is the same payment: pressing the button twice, or going back and pressing it again, pays once.
        await plane().billing.apply({
          type: "payment.succeeded",
          ref,
          purpose: input.purpose,
          ...(input.plan ? { plan: input.plan.id } : {}),
          accountId: input.accountId,
          amountMinor,
          currency: input.currency,
          at: clock().toISOString(),
        });
        res.writeHead(303, { location: input.successUrl, "cache-control": "no-store" });
        return void res.end();
      }
      res.writeHead(405, { allow: "GET, POST" });
      res.end();
    })().catch((err: unknown) => {
      if (!res.headersSent) send(res, 500, payPage("The trial could not apply this payment", `<h1>That did not work</h1><p>${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`));
      else res.end();
    });
  });
}

// ---- the stand-in model, as a provider: where a hosting-only trial's customers' keys point ----

/**
 * The address a customer gives the key form in a hosting-only trial. It is a public https address, so the control plane and the host take
 * it, and no one owns it (`.example` never resolves): a trial host is sent to the stand-in instead. See `trial-reroute.ts`.
 */
export const TRIAL_MODEL_ADDRESS = "https://stand-in.example/v1";

/** The most a request to the stand-in may carry. A conversation is sent whole every turn, and a long one is large. */
const MAX_MODEL_BODY = 16 * 1024 * 1024;

type Body = { ok: true; value: Record<string, unknown> } | { ok: false; status: number; message: string };

/** A request body that is a JSON object, or why it is not. One that is too large is read to its end and thrown away, so the answer can still be sent. */
function readJsonBody(req: http.IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= MAX_MODEL_BODY) chunks.push(c);
    });
    req.on("end", () => {
      if (size > MAX_MODEL_BODY) return resolve({ ok: false, status: 413, message: "That request is larger than the stand-in model takes." });
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return resolve({ ok: true, value: parsed as Record<string, unknown> });
      } catch {
        // Said below, as it is for a body that parsed to something that is not an object.
      }
      resolve({ ok: false, status: 400, message: "The request body must be a JSON object." });
    });
    req.on("error", reject);
  });
}

/**
 * The stand-in model, spoken as a provider speaks: an OpenAI-compatible `POST /v1/chat/completions` (streamed, as the host asks, or not)
 * and `GET /v1/models`. It answers every call with the stand-in's sentence and uses no tool, and it takes any key, or none: what a key is
 * for is something this answer has no use for. It listens on this machine only.
 */
export function createModelServer(standIn: StandInModel): http.Server {
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
    res.end(JSON.stringify(body));
  };
  const refuse = (res: http.ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void =>
    send(res, status, { error: { message, type: "invalid_request_error", param: null, code: null } }, headers);
  const usageOf = (u: { input: number; output: number } | undefined) => (u ? { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } : undefined);
  let sequence = 0;

  async function complete(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    if (!body.ok) return refuse(res, body.status, body.message);
    const asked = body.value;
    if (!Array.isArray(asked.messages)) return refuse(res, 400, "messages must be a list.");
    const said = (m: unknown): string => {
      const content = (m as { content?: unknown } | null)?.content;
      return typeof content === "string" ? content : JSON.stringify(content ?? "");
    };
    const system = asked.messages.filter((m) => (m as { role?: unknown } | null)?.role === "system").map(said).join("\n");
    const rest = asked.messages.filter((m) => (m as { role?: unknown } | null)?.role !== "system") as ChatMessage[];
    const model = typeof asked.model === "string" && asked.model.trim() !== "" ? asked.model.trim().slice(0, 128) : "stand-in-1";
    const hangUp = new AbortController();
    res.on("close", () => hangUp.abort());
    const events = standIn.stream({ model, ...(system !== "" ? { system } : {}), messages: rest, signal: hangUp.signal });
    const id = `chatcmpl-trial-${++sequence}`;
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] });

    if (asked.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      const write = (data: unknown): void => void res.write(`data: ${JSON.stringify(data)}\n\n`);
      write(chunk({ role: "assistant", content: "" }, null));
      let usage;
      for await (const e of events) {
        if (e.kind === "text") write(chunk({ content: e.delta }, null));
        else if (e.kind === "end") usage = e.result.usage;
      }
      write(chunk({}, "stop"));
      const wantsUsage = (asked.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
      if (wantsUsage && usage) write({ id, object: "chat.completion.chunk", created, model, choices: [], usage: usageOf(usage) });
      res.end("data: [DONE]\n\n");
      return;
    }
    let text = "";
    let usage;
    for await (const e of events) {
      if (e.kind === "text") text += e.delta;
      else if (e.kind === "end") usage = e.result.usage;
    }
    send(res, 200, { id, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: usageOf(usage) });
  }

  return http.createServer((req, res) => {
    void (async () => {
      const at = new URL(req.url ?? "/", "http://localhost").pathname.replace(/\/+$/, "") || "/";
      if (at === "/v1/models") {
        if (req.method !== "GET") return refuse(res, 405, "Use GET for /v1/models.", { allow: "GET" });
        return send(res, 200, { object: "list", data: [{ id: "stand-in-1", object: "model", created: 0, owned_by: "the trial" }] });
      }
      if (at === "/v1/chat/completions") {
        if (req.method !== "POST") return refuse(res, 405, "Use POST for /v1/chat/completions.", { allow: "POST" });
        return complete(req, res);
      }
      return refuse(res, 404, `There is nothing at ${at}. This stand-in model answers POST /v1/chat/completions and GET /v1/models.`);
    })().catch(() => {
      // A caller that hung up has nobody to be answered; any other failure is said, unless the answer has begun.
      if (res.headersSent) return void res.end();
      refuse(res, 500, "The stand-in model could not answer that.");
    });
  });
}

/** How a hosting-only trial's hosts reach the stand-in: a preload that sends the calls made to {@link TRIAL_MODEL_ADDRESS} to `modelUrl`. */
export function standInEnvironment(modelUrl: string, inherited: NodeJS.ProcessEnv = process.env, preload: string = path.resolve(here, "trial-reroute.js")): Record<string, string> {
  // A path with a space in it is quoted for NODE_OPTIONS, which splits on spaces.
  const named = /\s/.test(preload) ? JSON.stringify(preload) : preload;
  const kept = (inherited.NODE_OPTIONS ?? "").trim();
  const from = new URL(TRIAL_MODEL_ADDRESS);
  return {
    NODE_OPTIONS: `${kept === "" ? "" : `${kept} `}--require ${named}`,
    CURULE_TRIAL_REROUTE_FROM: `${from.origin}/`,
    CURULE_TRIAL_REROUTE_TO: `${new URL(modelUrl).origin}/`,
  };
}

/** The local-process provisioner, with every host told how to reach the stand-in model. */
export class StandInHosts implements Provisioner {
  readonly kind: string;

  constructor(
    private readonly hosts: Provisioner & { stopAll(): Promise<void> },
    private readonly env: Record<string, string>,
  ) {
    this.kind = hosts.kind;
  }

  create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    return this.hosts.create({ ...spec, env: { ...spec.env, ...this.env } });
  }
  suspend(handle: string): Promise<void> {
    return this.hosts.suspend(handle);
  }
  resume(handle: string): Promise<ProvisionedWorkspace> {
    return this.hosts.resume(handle);
  }
  destroy(handle: string, options?: { keepData?: boolean }): Promise<void> {
    return this.hosts.destroy(handle, options);
  }
  status(handle: string): Promise<WorkspaceRuntimeStatus> {
    return this.hosts.status(handle);
  }
  /** What the control plane calls when it stops: the hosts are its children. */
  stopAll(): Promise<void> {
    return this.hosts.stopAll();
  }
}

// ---- the trial ----

export interface TrialPorts {
  /** The public address of the app. A workspace is at `<name>.localhost` on the same port. */
  app: number;
  /** The operator's API. */
  owner: number;
  /** The payment page. */
  pay: number;
  /** What workspaces call for models, and the gateway's admin API. Fixed, because a workspace is told them once. */
  gatewayTenant: number;
  gatewayAdmin: number;
}

export const DEFAULT_TRIAL_PORT = 7500;

/** The ports a trial uses when it is given the app's: the others sit beside it. */
export function trialPorts(app: number): TrialPorts {
  return { app, owner: app + 1, pay: app + 2, gatewayTenant: app + 10, gatewayAdmin: app + 11 };
}

export interface TrialOptions {
  /** Where everything is kept. Default: a new directory under the system's temporary one, removed when the trial stops. A directory that is named is kept, and a trial started on it again finds its accounts and workspaces. */
  dir?: string;
  ports?: TrialPorts;
  /** The command that starts a host. Default: this build's own `curule host`. */
  hostCommand?: string[];
  /** The folder of account pages. Default: the product's own. */
  pagesDir?: string;
  /** Where the trial says things. Default: nowhere. */
  out?: (line: string) => void;
  /** How often the checks on workspaces run, in ms. Default one minute. */
  reconcileMs?: number;
  /**
   * The service as the owner sells it: plans that sell hosting only (the customer brings a model key), no gateway, and a stand-in model on
   * the port the gateway would have had. A folder that is kept belongs to one kind of trial, and a start of the other kind on it is refused.
   */
  hostingOnly?: boolean;
}

export interface RunningTrial {
  appUrl: string;
  ownerUrl: string;
  ownerToken: string;
  payUrl: string;
  /** The gateway workspaces call, when plans sell usage. Absent when they sell hosting only. */
  gatewayUrl?: string;
  dir: string;
  outboxPath: string;
  control: RunningControl;
  gateway?: RunningGateway;
  standIn: StandInModel;
  /** Whether this is a hosting-only trial. */
  hostingOnly: boolean;
  /** A hosting-only trial's stand-in model, up to and including `/v1`, as it is reached on this machine. */
  modelUrl?: string;
  /** What the configuration warned of, as it was before anything started. */
  notes: string[];
  /** Stop everything, workspaces included, and remove the directory when the trial made it. */
  stop(graceMs?: number): Promise<void>;
}

const here = __dirname;
/** The mesh CLI of this build, which is what starts a workspace's host. */
export const DEFAULT_HOST_COMMAND = [process.execPath, path.resolve(here, "..", "..", "mesh-cli", "src", "index.js")];
/** The product's own account pages, which are in the source tree and not in the build. */
export const DEFAULT_PAGES_DIR = path.resolve(here, "..", "..", "..", "..", "apps", "cloud-server", "pages");

interface Saved {
  secret: string;
  ownerToken: string;
  gatewayAdminToken: string;
  /** Present, and true, when the trial that made the folder was a hosting-only one. */
  hostingOnly?: true;
}

/**
 * Secrets for a trial, made once and kept with it, so that workspaces made earlier can still be reached. The folder also remembers which
 * kind of trial made it: workspaces made on a plan that sells usage have a gateway key, and on one that sells hosting they have none, and
 * a start that mixed them would fail in ways that do not say why.
 */
function secretsIn(dir: string, hostingOnly: boolean): Saved {
  const file = path.join(dir, "trial.json");
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as Saved;
    if ((saved.hostingOnly === true) !== hostingOnly) {
      throw new Error(`${dir} was made by a trial that sells ${saved.hostingOnly === true ? "hosting only" : "model usage"}: start it ${saved.hostingOnly === true ? "with" : "without"} --hosting-only, or use another folder`);
    }
    return saved;
  }
  const made: Saved = { secret: randomBytes(24).toString("hex"), ownerToken: randomBytes(18).toString("hex"), gatewayAdminToken: randomBytes(18).toString("hex"), ...(hostingOnly ? { hostingOnly: true as const } : {}) };
  fs.writeFileSync(file, JSON.stringify(made, null, 2), { mode: 0o600 });
  return made;
}

/** Print each message the outbox gains, so that a link in a mail can be followed from the terminal. Returns what stops it, after one last look. */
export function watchOutbox(file: string, out: (line: string) => void): () => void {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const look = (): void => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size <= offset) return;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      const whole = buffer.toString("utf8").lastIndexOf("\n") + 1;
      offset += Buffer.byteLength(buffer.toString("utf8").slice(0, whole));
      for (const line of buffer.toString("utf8").slice(0, whole).split("\n").filter(Boolean)) {
        try {
          const mail = JSON.parse(line) as { to: string; subject: string; text: string };
          const link = /https?:\/\/\S+/.exec(mail.text)?.[0];
          out(`mail to ${mail.to}: ${mail.subject}${link ? `\n  ${link}` : ""}`);
        } catch {
          // A line that is not a mail is not ours to print.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  };
  const timer = setInterval(look, 250);
  timer.unref();
  return () => {
    look();
    clearInterval(timer);
  };
}

function listenLocally(server: http.Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeNow(server: http.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!server.listening) return resolve();
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export async function startTrial(options: TrialOptions = {}): Promise<RunningTrial> {
  const out = options.out ?? (() => undefined);
  const hostingOnly = options.hostingOnly === true;
  const made = options.dir === undefined;
  const dir = options.dir ? path.resolve(options.dir) : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "curule-trial-"));
  fs.mkdirSync(path.join(dir, "control"), { recursive: true });
  const ports = options.ports ?? trialPorts(DEFAULT_TRIAL_PORT);
  const secrets = secretsIn(dir, hostingOnly);
  if (!hostingOnly) fs.mkdirSync(path.join(dir, "gateway"), { recursive: true });
  const env: NodeJS.ProcessEnv = { CURULE_TRIAL_SECRET: secrets.secret, CURULE_TRIAL_OWNER_TOKEN: secrets.ownerToken, CURULE_TRIAL_GATEWAY_ADMIN_TOKEN: secrets.gatewayAdminToken };

  const quiet = (who: string) => (r: GatewayLogRecord | ControlLogRecord): void => {
    if (r.level === "warn" || r.level === "error") out(`${who}: ${r.msg}${"error" in r && r.error ? ` (${String(r.error)})` : ""}`);
  };

  const standIn = new StandInModel();
  let gateway: RunningGateway | undefined;
  let modelServer: http.Server | undefined;
  let modelUrl: string | undefined;
  if (hostingOnly) {
    // No gateway sells anything here, so its port is the stand-in's: the one place a workspace's calls for models can go.
    modelServer = createModelServer(standIn);
    await listenLocally(modelServer, ports.gatewayTenant);
    modelUrl = `http://127.0.0.1:${ports.gatewayTenant}/v1`;
  } else {
    // The gateway, with the stand-in in the place of every provider.
    fs.writeFileSync(path.join(dir, "gateway", "prices.yaml"), stringify(TRIAL_PRICES));
    fs.writeFileSync(
      path.join(dir, "gateway", "gateway.yaml"),
      stringify({
        ledger: path.join(dir, "gateway", "ledger.jsonl"),
        prices: path.join(dir, "gateway", "prices.yaml"),
        tenant: { host: "127.0.0.1", port: ports.gatewayTenant },
        admin: { host: "127.0.0.1", port: ports.gatewayAdmin, token_env: "CURULE_TRIAL_GATEWAY_ADMIN_TOKEN" },
        limits: { default_rpm: 600, default_concurrent: 16, reserve_cap: 2, deadline_seconds: 120, commit_seconds: 10 },
        expose_upstream_model: true,
        providers: { "stand-in": { kind: "openai-compatible", base_url: "http://127.0.0.1:9/v1" } },
        tiers: { fast: ["stand-in/small"], balanced: ["stand-in/medium"], best: ["stand-in/large"] },
      }),
    );
    gateway = await startGateway(loadGatewayConfig(path.join(dir, "gateway", "gateway.yaml"), env), { log: quiet("gateway"), providerFactory: () => standIn });
  }
  /** Stop what answers for models: the gateway, or the stand-in on its own. */
  const stopModels = async (graceMs: number): Promise<void> => {
    if (gateway) await gateway.stop(graceMs);
    if (modelServer) await closeNow(modelServer);
  };

  // The control plane, in trial form, with the trial's payment page in place of a provider's.
  fs.writeFileSync(path.join(dir, "control", "plans.yaml"), stringify(hostingOnly ? TRIAL_HOSTING_PLANS : TRIAL_PLANS));
  const appUrl = `http://localhost:${ports.app}`;
  const payUrl = `http://localhost:${ports.pay}`;
  const outboxPath = path.join(dir, "control", "outbox.jsonl");
  fs.writeFileSync(
    path.join(dir, "control", "control.yaml"),
    stringify({
      app_url: appUrl,
      workspaces: { domain: "localhost" },
      public: { host: "127.0.0.1", port: ports.app },
      owner: { host: "127.0.0.1", port: ports.owner, token_env: "CURULE_TRIAL_OWNER_TOKEN" },
      pages: options.pagesDir ?? DEFAULT_PAGES_DIR,
      control_log: path.join(dir, "control", "control.jsonl"),
      mail: { outbox: outboxPath },
      plans: path.join(dir, "control", "plans.yaml"),
      secret_env: "CURULE_TRIAL_SECRET",
      // A service that sells no model usage has no gateway: the file says none, as the owner's does.
      ...(gateway ? { gateway: { admin_url: gateway.admin.url, admin_token_env: "CURULE_TRIAL_GATEWAY_ADMIN_TOKEN", tenant_url: `${gateway.tenant.url}/v1` } } : {}),
      provisioner: { kind: "local", base_dir: path.join(dir, "workspaces"), host_command: options.hostCommand ?? DEFAULT_HOST_COMMAND },
      // Replaced by the trial's own provider below; the file still has to name one.
      billing: { provider: "manual", pay_url: `${payUrl}/pay?ref={ref}` },
      reconcile_minutes: 1,
    }),
  );
  let config;
  try {
    config = loadControlConfig(path.join(dir, "control", "control.yaml"), env);
  } catch (err) {
    await stopModels(0);
    throw err;
  }
  // A hosting-only trial's hosts are told how to reach the stand-in; they are started as the configuration says otherwise.
  const hosts =
    modelUrl !== undefined && config.provisioner.kind === "local"
      ? new StandInHosts(new LocalProcessProvisioner({ baseDir: config.provisioner.baseDir, hostCommand: config.provisioner.hostCommand, production: config.production }), standInEnvironment(modelUrl))
      : undefined;

  const billing = new TrialBilling((ref) => `${payUrl}/pay?ref=${encodeURIComponent(ref)}`);
  let control: RunningControl | undefined;
  const payServer = createPayServer(billing, () => control!.plane);
  try {
    await listenLocally(payServer, ports.pay);
    control = await startControl(config, { billing, log: quiet("control"), ...(hosts ? { provisioner: hosts } : {}), ...(options.reconcileMs !== undefined ? { reconcileMs: options.reconcileMs } : {}) });
  } catch (err) {
    await closeNow(payServer);
    await stopModels(0);
    throw err;
  }
  const stopWatching = watchOutbox(outboxPath, out);
  const running = control;

  return {
    appUrl,
    ownerUrl: running.owner.url,
    ownerToken: secrets.ownerToken,
    payUrl,
    ...(gateway ? { gatewayUrl: gateway.tenant.url, gateway } : {}),
    dir,
    outboxPath,
    control: running,
    standIn,
    hostingOnly,
    ...(modelUrl !== undefined ? { modelUrl } : {}),
    notes: config.warnings,
    async stop(graceMs = 10_000) {
      stopWatching();
      await closeNow(payServer);
      await running.stop(graceMs);
      await stopModels(graceMs);
      if (made) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** What a person is told when the trial is up: where to go, and what is not real. */
export function describeTrial(t: RunningTrial, ports: TrialPorts, kept: boolean): string[] {
  const models = t.hostingOnly
    ? [
        "  models            a stand-in that answers every call with one sentence and uses no tool. There is no gateway: a workspace has no model until its key is",
        `                    set on the account page. Choose OpenAI-compatible, give the address ${TRIAL_MODEL_ADDRESS}, any model name and any key of 8 characters`,
        "                    or more. That address is answered on this machine and no call leaves it; a real provider's address and key work too",
      ]
    : [
        "  models            a stand-in that answers every call with one sentence and uses no tool. The calls go through the real gateway, so keys,",
        "                    balance and usage are real, and a mission will not get far",
      ];
  return [
    "Curule Cloud, on this machine. A trial: nothing here is real.",
    "",
    `  the app           ${t.appUrl}`,
    `  a workspace       http://<its name>.localhost:${ports.app} (opened from the account page; a browser finds *.localhost on this machine by itself)`,
    ...(t.hostingOnly ? ["  the plans         hosting only: the customer brings a model key, and there is no balance, usage or top-up"] : []),
    `  payment           ${t.payUrl}, a page of the trial's own: nothing is charged and no card is asked for`,
    `  mail              printed here as it is written, and kept in ${t.outboxPath}`,
    ...models,
    `  the owner's API   ${t.ownerUrl}, with the token ${t.ownerToken}`,
    ...(t.hostingOnly ? [`  the stand-in      ${t.modelUrl}, on this machine only; it takes any key`] : [`  the gateway       ${t.gatewayUrl}/v1 for workspaces`]),
    `  everything is in  ${t.dir}${kept ? " (kept: start the trial on it again and the accounts and workspaces are there)" : " (removed when the trial stops)"}`,
    ...(t.notes.length > 0 ? ["", ...t.notes.map((n) => `  note: ${n}`)] : []),
    "",
    "Open the app, create an account and follow the link that is printed here. Ctrl+C stops it, and the workspaces it started.",
  ];
}
