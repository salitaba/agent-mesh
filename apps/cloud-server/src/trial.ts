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
  loadControlConfig,
  startControl,
  type BillingEvent,
  type BillingProvider,
  type CheckoutInput,
  type ControlLogRecord,
  type ControlPlane,
  type RunningControl,
} from "../../../packages/cloud/src/index";
import { estimateTokens, type LlmProvider, type ModelEvent, type ModelRequest } from "../../../packages/llm/src/index";

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
}

export interface RunningTrial {
  appUrl: string;
  ownerUrl: string;
  ownerToken: string;
  payUrl: string;
  gatewayUrl: string;
  dir: string;
  outboxPath: string;
  control: RunningControl;
  gateway: RunningGateway;
  standIn: StandInModel;
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
}

/** Secrets for a trial, made once and kept with it, so that workspaces made earlier can still be reached. */
function secretsIn(dir: string): Saved {
  const file = path.join(dir, "trial.json");
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as Saved;
  const made: Saved = { secret: randomBytes(24).toString("hex"), ownerToken: randomBytes(18).toString("hex"), gatewayAdminToken: randomBytes(18).toString("hex") };
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

export async function startTrial(options: TrialOptions = {}): Promise<RunningTrial> {
  const out = options.out ?? (() => undefined);
  const made = options.dir === undefined;
  const dir = options.dir ? path.resolve(options.dir) : fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "curule-trial-"));
  fs.mkdirSync(path.join(dir, "gateway"), { recursive: true });
  fs.mkdirSync(path.join(dir, "control"), { recursive: true });
  const ports = options.ports ?? trialPorts(DEFAULT_TRIAL_PORT);
  const secrets = secretsIn(dir);
  const env: NodeJS.ProcessEnv = { CURULE_TRIAL_SECRET: secrets.secret, CURULE_TRIAL_OWNER_TOKEN: secrets.ownerToken, CURULE_TRIAL_GATEWAY_ADMIN_TOKEN: secrets.gatewayAdminToken };

  const quiet = (who: string) => (r: GatewayLogRecord | ControlLogRecord): void => {
    if (r.level === "warn" || r.level === "error") out(`${who}: ${r.msg}${"error" in r && r.error ? ` (${String(r.error)})` : ""}`);
  };

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
  const standIn = new StandInModel();
  const gateway = await startGateway(loadGatewayConfig(path.join(dir, "gateway", "gateway.yaml"), env), { log: quiet("gateway"), providerFactory: () => standIn });

  // The control plane, in trial form, with the trial's payment page in place of a provider's.
  fs.writeFileSync(path.join(dir, "control", "plans.yaml"), stringify(TRIAL_PLANS));
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
      gateway: { admin_url: gateway.admin.url, admin_token_env: "CURULE_TRIAL_GATEWAY_ADMIN_TOKEN", tenant_url: `${gateway.tenant.url}/v1` },
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
    await gateway.stop(0);
    throw err;
  }

  const billing = new TrialBilling((ref) => `${payUrl}/pay?ref=${encodeURIComponent(ref)}`);
  let control: RunningControl | undefined;
  const payServer = createPayServer(billing, () => control!.plane);
  try {
    await new Promise<void>((resolve, reject) => {
      payServer.once("error", reject);
      payServer.listen(ports.pay, "127.0.0.1", () => {
        payServer.off("error", reject);
        resolve();
      });
    });
    control = await startControl(config, { billing, log: quiet("control"), ...(options.reconcileMs !== undefined ? { reconcileMs: options.reconcileMs } : {}) });
  } catch (err) {
    await new Promise<void>((resolve) => (payServer.listening ? payServer.close(() => resolve()) : resolve()));
    await gateway.stop(0);
    throw err;
  }
  const stopWatching = watchOutbox(outboxPath, out);
  const running = control;

  return {
    appUrl,
    ownerUrl: running.owner.url,
    ownerToken: secrets.ownerToken,
    payUrl,
    gatewayUrl: gateway.tenant.url,
    dir,
    outboxPath,
    control: running,
    gateway,
    standIn,
    notes: config.warnings,
    async stop(graceMs = 10_000) {
      stopWatching();
      await new Promise<void>((resolve) => {
        payServer.close(() => resolve());
        payServer.closeAllConnections();
      });
      await running.stop(graceMs);
      await gateway.stop(graceMs);
      if (made) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** What a person is told when the trial is up: where to go, and what is not real. */
export function describeTrial(t: RunningTrial, ports: TrialPorts, kept: boolean): string[] {
  return [
    "Curule Cloud, on this machine. A trial: nothing here is real.",
    "",
    `  the app           ${t.appUrl}`,
    `  a workspace       http://<its name>.localhost:${ports.app} (opened from the account page; a browser finds *.localhost on this machine by itself)`,
    `  payment           ${t.payUrl}, a page of the trial's own: nothing is charged and no card is asked for`,
    `  mail              printed here as it is written, and kept in ${t.outboxPath}`,
    "  models            a stand-in that answers every call with one sentence and uses no tool. The calls go through the real gateway, so keys,",
    "                    balance and usage are real, and a mission will not get far",
    `  the owner's API   ${t.ownerUrl}, with the token ${t.ownerToken}`,
    `  the gateway       ${t.gatewayUrl}/v1 for workspaces`,
    `  everything is in  ${t.dir}${kept ? " (kept: start the trial on it again and the accounts and workspaces are there)" : " (removed when the trial stops)"}`,
    ...(t.notes.length > 0 ? ["", ...t.notes.map((n) => `  note: ${n}`)] : []),
    "",
    "Open the app, create an account and follow the link that is printed here. Ctrl+C stops it, and the workspaces it started.",
  ];
}
