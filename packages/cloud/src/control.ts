/**
 * The control plane as a process: the one place its parts are put together and started.
 *
 * Everything that varies between deployments is in {@link ControlConfig}; this file only joins what the rest of the package
 * provides: the log, the plans, the billing adapter, the gateway's admin client, the provisioner, the public and owner
 * listeners, and the timer that runs the checks that keep workspaces honest. Nothing here decides anything about money or
 * access.
 */
import type * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { ControlConfig, SmtpSettings } from "./control-config";
import { ControlPlane } from "./control-plane";
import { WorkspaceEdge } from "./edge";
import { HttpGatewayAdmin } from "./gateway-client";
import { HostedCheckoutBilling } from "./hosted-checkout";
import { ManualBilling, type BillingProvider } from "./billing";
import { ModelKeyStore } from "./model-keys";
import { OutboxMailer, type Mailer } from "./mailer";
import { QueuedMailer, type QueuedMailerOptions } from "./mail-queue";
import { OwnerWeb } from "./owner";
import { ContainerProvisioner, ProcessRunner, type CommandRunner } from "./provision-container";
import { LocalProcessProvisioner } from "./provision-local";
import type { Provisioner } from "./provisioner";
import { SmtpTransport } from "./smtp";
import { ControlLog, JsonlControlStore, type ControlStore } from "./store";
import { ControlWeb } from "./web";
import { createOwnerServer, createPublicServer } from "./web-server";
import { WorkspaceAccess } from "./workspace-access";
import type { WorkspacesOptions } from "./workspaces";

export interface ControlLogRecord {
  level: "info" | "warn" | "error";
  msg: string;
  [field: string]: unknown;
}

export interface Listening {
  server: http.Server;
  url: string;
  port: number;
  /** Stop accepting requests, give the ones in flight `graceMs` to finish, and then close what is left. */
  close(graceMs?: number): Promise<void>;
}

export function listenOn(server: http.Server, port: number, host: string): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
        close: (graceMs = 10_000) =>
          new Promise<void>((done) => {
            const timer = setTimeout(() => server.closeAllConnections(), graceMs);
            // `close` ends the connections that are idle and waits for the ones in a request.
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          }),
      });
    });
  });
}

export interface StartOptions {
  log?: (record: ControlLogRecord) => void;
  clock?: () => Date;
  /** How the gateway and the payment provider are reached. For tests. */
  fetch?: typeof fetch;
  /** Where the control log is kept. For tests; the default is the file the configuration names. */
  store?: ControlStore;
  /** What starts workspaces. For tests; the default is the one the configuration names. */
  provisioner?: Provisioner;
  /** The payment provider. For tests and for the trial, whose provider is a page of its own; the default is the one the configuration names. */
  billing?: BillingProvider;
  /** What delivers mail. For tests; the default is the SMTP queue or the outbox file the configuration names. */
  mailer?: Mailer;
  /** How the mail queue waits and gives up, when mail goes over SMTP. For tests; the defaults are 30 seconds doubling to 15 minutes, a day, and an hour. */
  mailQueue?: Pick<QueuedMailerOptions, "firstDelayMs" | "maxDelayMs" | "giveUpMs" | "stuckAfterMs">;
  /** How the container engine is run, when the provisioner is the container one. For tests; the default starts the engine. */
  runner?: CommandRunner;
  waitReady?: WorkspacesOptions["waitReady"];
  /** How often the checks run, in ms. For tests; the default is the configuration's. */
  reconcileMs?: number;
}

export interface RunningControl {
  plane: ControlPlane;
  web: ControlWeb;
  edge: WorkspaceEdge;
  /** The queue mail waits in, when it is delivered over SMTP. */
  mail?: QueuedMailer;
  public: Listening;
  owner: Listening;
  /** Run the checks that keep workspaces honest now, and say what they did. */
  reconcile(): Promise<string[]>;
  /** Stop taking requests, let the ones in flight finish (up to `graceMs`), and close the log. */
  stop(graceMs?: number): Promise<void>;
}

const stderrLog = (record: ControlLogRecord): void => void process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);

function billingFor(config: ControlConfig, fetchImpl: typeof fetch | undefined): BillingProvider {
  const b = config.billing;
  if (b.provider === "manual") return new ManualBilling({ payUrl: (ref) => b.payUrl.replace("{ref}", encodeURIComponent(ref)) });
  const planOfPrice = new Map(config.catalogue.plans().flatMap((p) => (p.providerPriceId ? [[p.providerPriceId, p.id] as const] : [])));
  return new HostedCheckoutBilling({ apiKey: b.apiKey, webhookSecret: b.webhookSecret, planOfPrice: (id) => planOfPrice.get(id), ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}), ...(fetchImpl ? { fetch: fetchImpl } : {}) });
}

/** What delivers one message over the SMTP server the configuration names. It signs in, encrypts and checks as `SmtpTransport` does, and does not queue. */
export function smtpTransportFor(smtp: SmtpSettings, clock?: () => Date): SmtpTransport {
  return new SmtpTransport({ host: smtp.host, port: smtp.port, security: smtp.security, from: smtp.from, ...(smtp.user !== undefined ? { user: smtp.user, password: smtp.password! } : {}), ...(smtp.hello ? { hello: smtp.hello } : {}), ...(clock ? { clock } : {}) });
}

/** The outbox file, or the queue in front of an SMTP server. The queue is opened, and what was waiting from before the last stop is delivered once it is started. */
async function mailerFor(config: ControlConfig, clock: () => Date, log: (record: ControlLogRecord) => void, queueOptions: StartOptions["mailQueue"]): Promise<{ mailer: Mailer; queue?: QueuedMailer }> {
  const smtp = config.smtp;
  if (!smtp) return { mailer: new OutboxMailer(config.outboxPath, clock) };
  const queue = await QueuedMailer.open({ transport: smtpTransportFor(smtp, clock), dir: smtp.spoolDir, clock, log: (r) => log(r), ...queueOptions });
  return { mailer: queue, queue };
}

function provisionerFor(config: ControlConfig, runner: CommandRunner | undefined): Provisioner {
  const p = config.provisioner;
  if (p.kind === "local") return new LocalProcessProvisioner({ baseDir: p.baseDir, hostCommand: p.hostCommand, production: config.production });
  // The gateway, when there is one, is ours and on the operator's own network: it is not reached through the proxy that customers' traffic goes out by.
  const gatewayHost = config.gateway ? new URL(config.gateway.tenantUrl).hostname : undefined;
  return new ContainerProvisioner({
    runner: runner ?? new ProcessRunner(),
    engine: p.engine,
    image: p.image,
    network: p.network,
    ...(p.subnet ? { addresses: { subnet: p.subnet } } : {}),
    apexDomain: config.workspaces.domain,
    ...(p.egressProxy ? { egressProxy: p.egressProxy, noProxy: [...new Set([...p.noProxy, ...(gatewayHost ? [gatewayHost] : [])])] } : {}),
  });
}

export async function startControl(config: ControlConfig, options: StartOptions = {}): Promise<RunningControl> {
  const log = options.log ?? stderrLog;
  const clock = options.clock ?? (() => new Date());
  const store = options.store ?? new JsonlControlStore(config.logPath);
  const controlLog = await ControlLog.open(store, clock);
  const closeLog = async (): Promise<void> => {
    await (store as { close?: () => Promise<void> }).close?.();
  };
  let queue: QueuedMailer | undefined;
  try {
    const provisioner = options.provisioner ?? provisionerFor(config, options.runner);
    const gateway = config.gateway ? new HttpGatewayAdmin({ baseUrl: config.gateway.adminUrl, token: config.gateway.adminToken, ...(options.fetch ? { fetch: options.fetch } : {}) }) : undefined;
    const modelKeys = new ModelKeyStore({ file: config.modelKeysPath, secret: config.secret, clock });
    const { mailer, queue: opened } = options.mailer ? { mailer: options.mailer, queue: undefined } : await mailerFor(config, clock, log, options.mailQueue);
    queue = opened;
    const plane = new ControlPlane({
      log: controlLog,
      catalogue: config.catalogue,
      billing: options.billing ?? billingFor(config, options.fetch),
      ...(gateway ? { gateway } : {}),
      modelKeys,
      mailer,
      appUrl: config.appUrl,
      workspaces: {
        provisioner,
        secret: config.secret,
        workspaceDomain: config.workspaces.domain,
        ...(config.gateway ? { gatewayUrl: config.gateway.tenantUrl } : {}),
        limits: config.provisioner.limits,
        ...(config.licence ? { signer: { kid: config.licence.kid, privateKey: config.licence.privateKey } } : {}),
        ...(options.waitReady ? { waitReady: options.waitReady } : {}),
      },
      clock,
    });
    const access = new WorkspaceAccess({ secret: config.secret, clock });
    const web = new ControlWeb({
      plane,
      access,
      appUrl: config.appUrl,
      workspaceScheme: config.workspaces.scheme,
      ...(config.workspaces.port !== undefined ? { workspacePort: config.workspaces.port } : {}),
      clock,
      log: (r) => log(r),
    });
    const edge = new WorkspaceEdge({ plane, access, appUrl: config.appUrl, workspaceScheme: config.workspaces.scheme, log: (r) => log(r) });
    const publicServer = createPublicServer({ web, edge, appHost: config.appHost, workspaceDomain: config.workspaces.domain, trustProxyHops: config.public.trustProxyHops, ...(config.pagesDir ? { pagesDir: config.pagesDir } : {}) });
    const ownerServer = createOwnerServer({ owner: new OwnerWeb({ plane, token: config.owner.token, clock, log: (r) => log(r), ...(queue ? { mail: () => queue!.stats() } : {}) }) });

    const pub = await listenOn(publicServer, config.public.port, config.public.host);
    let own: Listening;
    try {
      own = await listenOn(ownerServer, config.owner.port, config.owner.host);
    } catch (err) {
      await pub.close(0);
      throw err;
    }

    // What was waiting from before the last stop is delivered now; from here on a message is delivered as it is queued.
    queue?.start();

    let checking: Promise<string[]> | undefined;
    const reconcile = (): Promise<string[]> => {
      // A check that is still running is not started again on top of itself.
      checking ??= plane.workspaces
        .reconcile()
        .then(
          (actions) => {
            for (const action of actions) log({ level: "info", msg: "a check changed a workspace", action });
            return actions;
          },
          (err: unknown) => {
            log({ level: "error", msg: "the checks on workspaces failed", error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
            return [] as string[];
          },
        )
        .finally(() => {
          checking = undefined;
        });
      return checking;
    };
    const timer = setInterval(() => void reconcile(), options.reconcileMs ?? config.reconcileMinutes * 60_000);
    timer.unref();
    // What was in flight when the last process ended is looked at now, and not after the first interval.
    void reconcile();

    log({ level: "info", msg: "the control plane is listening", public: pub.url, owner: own.url, app: config.appUrl, workspaces: `<slug>.${config.workspaces.domain}`, plans: config.catalogue.plans().map((p) => p.id) });
    return {
      plane,
      web,
      edge,
      ...(queue ? { mail: queue } : {}),
      public: pub,
      owner: own,
      reconcile,
      async stop(graceMs = 10_000) {
        clearInterval(timer);
        await pub.close(graceMs);
        await own.close(1_000);
        // A workspace that is being made is given the rest of the grace to finish, and is looked at again on the next start if it does not.
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([Promise.allSettled([...plane.workspaces.inFlight.values()]), new Promise<void>((resolve) => (timeout = setTimeout(resolve, graceMs)))]);
        clearTimeout(timeout);
        await checking;
        // Hosts that are children of this process (the local provisioner) do not outlive it. A container does, and is looked at again at the next start.
        await (provisioner as { stopAll?: () => Promise<void> }).stopAll?.();
        // A message a check queued while the service stopped is on disk, and goes out at the next start.
        await queue?.stop();
        await closeLog();
      },
    };
  } catch (err) {
    await queue?.stop(0);
    await closeLog();
    throw err;
  }
}

const money = (minor: number, currency: string): string => {
  const f = new Intl.NumberFormat("en", { style: "currency", currency });
  return f.format(minor / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
};

/** What the control plane would run, for a person to check against what they meant. Nothing secret: no token, no key. */
export function describeControl(config: ControlConfig): string[] {
  const c = config;
  const lines = [
    `the app is at ${c.appUrl}; workspaces are at <slug>.${c.workspaces.domain}${c.workspaces.port !== undefined ? `:${c.workspaces.port}` : ""} over ${c.workspaces.scheme}${c.production ? " (cookies are Secure and HSTS is sent)" : " (a trial: no Secure cookies)"}`,
    `public listener ${c.public.host}:${c.public.port}, ${c.public.trustProxyHops === 0 ? "reading no proxy header for the caller's address" : `trusting ${c.public.trustProxyHops} proxy hop${c.public.trustProxyHops === 1 ? "" : "s"} for the caller's address`}${c.pagesDir ? `; pages from ${c.pagesDir}` : "; no pages, the API only"}`,
    `owner API ${c.owner.host}:${c.owner.port}, behind a token`,
    `control log ${c.logPath}; ${c.smtp ? `mail is delivered over SMTP to ${c.smtp.host}:${c.smtp.port} (${c.smtp.security === "tls" ? "TLS from the first byte" : c.smtp.security === "starttls" ? "upgraded with STARTTLS" : "not encrypted"}${c.smtp.user !== undefined ? ", signed in" : ""}) as ${c.smtp.from}, and waits in ${c.smtp.spoolDir} until it is taken` : `mail is written to ${c.outboxPath} and not sent`}`,
    `plans from ${c.plansPath}, sold in ${c.catalogue.currency}:`,
  ];
  for (const p of c.catalogue.plans()) lines.push(`  ${p.id}: ${p.title}, ${money(p.priceMinor, c.catalogue.currency)} a ${p.period}, ${p.workspaces} workspace${p.workspaces === 1 ? "" : "s"}, ${p.byok ? "hosting only: the customer's own model key, no usage sold" : `${p.includedUsageMicros / 1_000_000} ${c.catalogue.currency} of usage included`}, limits of the ${p.licencePlan} plan${p.tiers ? `, tiers ${p.tiers.join(", ")}` : ""}`);
  const t = c.catalogue.topups;
  if (c.catalogue.sellsUsage) lines.push(`  top-ups ${t.optionsMinor.map((o) => money(o, c.catalogue.currency)).join(", ")} (any amount from ${money(t.minimumMinor, c.catalogue.currency)} to ${money(t.maximumMinor, c.catalogue.currency)})`);
  lines.push(c.gateway ? `gateway: admin API at ${c.gateway.adminUrl}; workspaces are told to call ${c.gateway.tenantUrl}` : "no gateway: every plan is hosting only, no model usage is sold and no balance is kept");
  lines.push(`customers' own model keys are kept, encrypted, in ${c.modelKeysPath}`);
  const p = c.provisioner;
  lines.push(
    p.kind === "container"
      ? `workspaces run as ${p.engine} containers of ${p.image} on the network ${p.network}${p.subnet ? ` (each at an address of its own in ${p.subnet})` : ""}, with ${p.limits.cpus} CPU, ${p.limits.memoryMb} MB and ${p.limits.pids} processes each${p.egressProxy ? `, going out through ${new URL(p.egressProxy).host}` : ", with no egress proxy"}`
      : `workspaces run as child processes under ${p.baseDir} (a trial: not a boundary between customers)`,
  );
  lines.push(c.licence ? `workspace licences are signed with key ${c.licence.kid}` : "workspace licences are not signed: workspaces run on the Community plan");
  lines.push(c.billing.provider === "manual" ? `billing is manual: customers are sent to ${c.billing.payUrl.replace("{ref}", "<reference>")}, and the operator records what arrives` : `billing is by a hosted checkout, with messages verified by signature${c.billing.baseUrl ? ` (API at ${c.billing.baseUrl})` : ""}`);
  lines.push(`the checks on workspaces run every ${c.reconcileMinutes} minute${c.reconcileMinutes === 1 ? "" : "s"}`);
  for (const w of c.warnings) lines.push(`WARNING: ${w}`);
  return lines;
}
