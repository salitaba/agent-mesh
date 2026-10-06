/**
 * `curule-cloud preflight`: what can be proved about a deployment before a customer is let in, said as a list.
 *
 * `control --check` reads a configuration and says whether it is consistent. This goes one step further and looks at what the
 * configuration points at: the model gateway (does it answer, does it accept the admin token, does it have the tiers the plans
 * promise), the container engine (is it there, is the image, is the workspace network internal), the folders the service writes,
 * the names customers will use, the mail server. Every check is independent, so one that fails does not hide the ones after it,
 * and every answer is one of three: `ok`, a `warning` (allowed, and worth reading), or a `problem` (the service would fail a
 * customer). The exit status is 1 when there is a problem.
 *
 * It sends nothing to a customer and changes nothing that matters: it asks the gateway for its health, asks the engine to inspect,
 * and makes and removes one empty file in each folder. It sends a message only when it is given an address to send it to.
 */
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ProcessRunner, loadControlConfig, mailbox, smtpTransportFor, type CommandRunner, type ControlConfig, type SmtpError } from "../../../packages/cloud/src/index";

export type Level = "ok" | "warning" | "problem";

export interface Finding {
  level: Level;
  text: string;
}

export interface PreflightDeps {
  fetch?: typeof fetch;
  /** Runs the container engine. */
  runner?: CommandRunner;
  /** The addresses a name resolves to; rejects when it resolves to none. */
  lookup?: (host: string) => Promise<string[]>;
  /** Whether a TCP connection to a host and port can be made, now. Rejects with the reason when it cannot. */
  connect?: (host: string, port: number, timeoutMs: number) => Promise<void>;
  /** Whether something can listen on an address, now. Rejects with the reason when it cannot. */
  listen?: (host: string, port: number) => Promise<void>;
}

export interface PreflightOptions {
  /** Send one message through the mail server to this address, to prove it. */
  mailTo?: string;
  /** The public keys the build trusts licences from. For tests; the default is the build's own. */
  publicKeys?: Record<string, string>;
}

/** The addresses a name resolves to, by the system's resolver. */
export const defaultLookup = async (host: string): Promise<string[]> => (await dns.promises.lookup(host, { all: true })).map((a) => a.address);

/** Whether a connection can be made to a host and port within a time: it is made and ended at once, and nothing is said. */
export const defaultConnect = (host: string, port: number, timeoutMs: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => socket.destroy(new Error(`no answer in ${timeoutMs / 1000} seconds`)), timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

/** Whether an address can be listened on: it is listened on and let go at once. */
export const defaultListen = (host: string, port: number): Promise<void> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => server.close(() => resolve()));
  });

const isLocalName = (host: string): boolean => host === "localhost" || host.endsWith(".localhost");

/** The nearest folder that exists, going up from a path: where a folder that is not made yet would be made. */
function nearestExisting(target: string): string {
  let at = path.resolve(target);
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return at;
}

/** Whether files can be made in a folder, or in the nearest one above it that exists: one empty file is made and removed. */
function canWriteIn(dir: string): { ok: true; at: string } | { ok: false; at: string; reason: string } {
  const at = nearestExisting(dir);
  const probe = path.join(at, `.curule-preflight-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "");
    fs.unlinkSync(probe);
    return { ok: true, at };
  } catch (err) {
    return { ok: false, at, reason: (err as NodeJS.ErrnoException).code ?? (err as Error).message };
  }
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function preflight(file: string, env: NodeJS.ProcessEnv, options: PreflightOptions = {}, deps: PreflightDeps = {}): Promise<Finding[]> {
  const out: Finding[] = [];
  const say = (level: Level, text: string): void => void out.push({ level, text });
  const doFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const lookup = deps.lookup ?? defaultLookup;
  const connect = deps.connect ?? defaultConnect;
  const listenOn = deps.listen ?? defaultListen;

  let config: ControlConfig;
  try {
    config = loadControlConfig(file, env, options.publicKeys ? { publicKeys: options.publicKeys } : {});
  } catch (err) {
    for (const line of reasonOf(err).split("\n")) say("problem", line);
    say("problem", "the configuration is not valid, so nothing else was looked at");
    return out;
  }
  say("ok", `the configuration is valid${config.production ? " (production: served over TLS)" : " (a trial: served over http)"}`);
  for (const w of config.warnings) say("warning", w);

  // ---- what the service writes
  const folders: Array<[string, string]> = [["the control log", path.dirname(config.logPath)], ["the folder customers' model keys are kept in", path.dirname(config.modelKeysPath)]];
  if (config.smtp) folders.push(["the mail spool", config.smtp.spoolDir]);
  else if (config.outboxPath !== "") folders.push(["the mail outbox", path.dirname(config.outboxPath)]);
  if (config.provisioner.kind === "local") folders.push(["the workspaces' folder", config.provisioner.baseDir]);
  for (const [what, dir] of folders) {
    const w = canWriteIn(dir);
    if (w.ok) say("ok", `${what} can be written: ${dir}${w.at === path.resolve(dir) ? "" : ` (it is made at the first start, in ${w.at})`}`);
    else say("problem", `${what} cannot be written: ${w.at} refuses a new file (${w.reason}), and the service needs ${dir}`);
  }

  // ---- the model gateway
  if (config.gateway) await gateway(config, config.gateway, doFetch, connect, say);
  else say("ok", "no model gateway is configured, and none is needed: every plan is hosting only, and a workspace is given its customer's own model key");

  // ---- where workspaces run
  if (config.provisioner.kind === "container") await containers(config, deps.runner ?? new ProcessRunner(30_000), connect, say);
  else say("warning", "workspaces run as child processes of this one: that is for a trial, and is not a boundary between customers");

  // ---- the names customers use
  if (isLocalName(config.appHost)) say("ok", `the app is at ${config.appHost}, a name of this machine: it needs no record`);
  else {
    await lookup(config.appHost).then(
      (a) => say("ok", `${config.appHost} resolves, to ${a.join(", ")}`),
      (err: unknown) => say("warning", `${config.appHost} does not resolve (${reasonOf(err)}): customers cannot reach the app until it does`),
    );
  }
  const sample = `preflight-check.${config.workspaces.domain}`;
  if (isLocalName(config.workspaces.domain)) say("ok", `workspaces are served at <name>.${config.workspaces.domain}, which this machine resolves by itself`);
  else {
    await lookup(sample).then(
      (a) => say("ok", `a name under ${config.workspaces.domain} resolves (${sample} is ${a.join(", ")}): the wildcard record is there`),
      (err: unknown) => say("warning", `${sample} does not resolve (${reasonOf(err)}): a workspace is served at <name>.${config.workspaces.domain}, so that domain needs a wildcard record and a wildcard certificate`),
    );
  }

  // ---- the listeners
  for (const [what, l] of [["the public listener", config.public], ["the owner listener", config.owner]] as const) {
    if (l.port === 0) continue;
    await listenOn(l.host, l.port).then(
      () => say("ok", `${what} can listen on ${l.host}:${l.port}`),
      (err: unknown) => say("warning", `${what} could not listen on ${l.host}:${l.port} (${reasonOf(err)}): fine if the service is already running there, and a problem if something else is`),
    );
  }

  // ---- mail
  await mail(config, options.mailTo, say);

  // ---- money
  say(
    "ok",
    config.billing.provider === "manual"
      ? `payments are by invoice or transfer: customers are sent to ${config.billing.payUrl.replace("{ref}", "<reference>")} and the operator records what arrives with the owner API`
      : `payments are by a hosted checkout: the provider is to send its messages to ${config.appUrl}/webhooks/billing, and the signing secret it gives for them is the one in the environment variable that billing.webhook_secret_env names`,
  );
  // What a missing or untrusted key means is already said by the configuration, as a warning or a problem.
  if (config.licence) say("ok", `workspace licences are signed with key ${config.licence.kid}, and this build trusts it`);
  return out;
}

async function gateway(config: ControlConfig, gw: NonNullable<ControlConfig["gateway"]>, doFetch: typeof fetch, connect: NonNullable<PreflightDeps["connect"]>, say: (level: Level, text: string) => void): Promise<void> {
  const where = gw.adminUrl;
  let res: Response;
  try {
    res = await doFetch(`${where}/admin/health`, { headers: { authorization: `Bearer ${gw.adminToken}` }, signal: AbortSignal.timeout(8_000) });
  } catch (err) {
    say("problem", `the model gateway's admin API at ${where} could not be reached (${reasonOf(err)}): no workspace can be given a key until it can`);
    return;
  }
  if (res.status === 401 || res.status === 403) {
    say("problem", `the model gateway at ${where} refuses the admin token (it answered ${res.status}): the token in the environment variable named by gateway.admin_token_env is not the one the gateway was started with`);
    return;
  }
  let health: { ok?: unknown; writable?: unknown; currency?: unknown; tiers?: unknown } = {};
  try {
    health = (await res.json()) as typeof health;
  } catch {
    // Handled by what is missing from it.
  }
  if (res.status !== 200) {
    say("problem", `the model gateway at ${where} answered ${res.status} to its health check: ${res.status === 404 ? "this is not the gateway's admin API, or it is an older one" : "it is not well"}`);
    return;
  }
  if (health.ok !== true) say("problem", `the model gateway at ${where} says it is not well${health.writable === false ? ": it cannot write its ledger, and so cannot let a call through" : ""}`);
  else say("ok", `the model gateway at ${where} answered, accepts the admin token, and can write its ledger`);
  const tiers = Array.isArray(health.tiers) ? (health.tiers as unknown[]).filter((t): t is string => typeof t === "string") : [];
  if (tiers.length === 0) {
    // A plan that names no tier may use any, and with none there is nothing to use: it is the gateway that is not ready.
    say("problem", `the model gateway at ${where} lists no tiers: no workspace could be given a model`);
  } else {
    let missing = false;
    for (const plan of config.catalogue.plans()) {
      for (const tier of plan.tiers ?? []) {
        if (tiers.includes(tier)) continue;
        missing = true;
        say("problem", `the plan '${plan.id}' lets a workspace use the tier '${tier}', and the gateway has no such tier (it has: ${tiers.join(", ")}): a workspace on that plan could not be given a key`);
      }
    }
    if (!missing) say("ok", `every tier a plan names is one the gateway has (${tiers.join(", ")})`);
  }
  if (typeof health.currency === "string" && health.currency !== config.catalogue.currency) {
    say("warning", `the gateway keeps its ledger in ${health.currency} and the plans are sold in ${config.catalogue.currency}: the usage a plan includes is granted in the gateway's currency, and the two are not converted`);
  }
  const tenant = new URL(gw.tenantUrl);
  const port = tenant.port !== "" ? Number(tenant.port) : tenant.protocol === "https:" ? 443 : 80;
  await connect(tenant.hostname, port, 5_000).then(
    () => say("ok", `the address workspaces call for models, ${tenant.host}, accepts a connection from here`),
    (err: unknown) => say("warning", `${tenant.host}, the address workspaces call for models, did not accept a connection from here (${reasonOf(err)}): a workspace reaches it from its own network, so this is only a problem if it is the same one`),
  );
}

async function containers(config: ControlConfig, runner: CommandRunner, connect: NonNullable<PreflightDeps["connect"]>, say: (level: Level, text: string) => void): Promise<void> {
  const p = config.provisioner;
  if (p.kind !== "container") return;
  const engine = p.engine;
  const run = async (args: string[]): Promise<{ code: number; stdout: string; stderr: string } | undefined> => runner.run(engine, args).catch(() => undefined);
  const version = await run(["version", "--format", "{{.Server.Version}}"]);
  if (!version || version.code !== 0) {
    say("problem", `${engine} could not be run${version ? ` (${version.stderr.trim().slice(0, 200) || `exit ${version.code}`})` : ""}: the control plane starts a workspace by running it, as the user it runs as`);
    return;
  }
  say("ok", `${engine} answered (server ${version.stdout.trim() || "of an unknown version"})`);

  const image = await run(["image", "inspect", "--format", "{{.Id}}", p.image]);
  if (image && image.code === 0) say("ok", `the image ${p.image} is here`);
  else say("warning", `the image ${p.image} is not here: it is pulled when the first workspace starts, which makes that start slow, and fails if the registry wants a sign-in`);

  const network = await run(["network", "inspect", "--format", "{{.Internal}}", p.network]);
  if (!network || network.code !== 0) say("problem", `the network ${p.network} does not exist: make it with \`${engine} network create --internal ${p.network}\`, and put the egress proxy and the gateway on it`);
  else if (network.stdout.trim() === "true") say("ok", `the network ${p.network} is internal: a workspace on it has no route out of its own`);
  else say("problem", `the network ${p.network} is not internal: a workspace on it can reach any address this machine can, which is the one thing the network is there to prevent. Make it with \`--internal\``);

  // A workspace is given an address in the subnet the operator named, and the engine refuses one that is not in the network's own.
  if (p.subnet && network && network.code === 0) {
    const subnets = await run(["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", p.network]);
    const has = (subnets?.stdout ?? "").split(/\s+/).filter((s) => s !== "");
    if (!subnets || subnets.code !== 0) say("warning", `the subnet of the network ${p.network} could not be read, so it was not compared with provisioner.subnet ${p.subnet}`);
    else if (has.includes(p.subnet)) say("ok", `the network ${p.network} has the subnet ${p.subnet}: a workspace is given an address in it`);
    else say("problem", `the network ${p.network} has the subnet ${has.join(", ") || "(none)"} and provisioner.subnet says ${p.subnet}: the engine would refuse the address of every workspace`);
  }

  if (p.egressProxy) {
    const proxy = new URL(p.egressProxy);
    const port = proxy.port !== "" ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80;
    await connect(proxy.hostname, port, 5_000).then(
      () => say("ok", `the egress proxy ${proxy.host} accepts a connection from here`),
      (err: unknown) => say("warning", `the egress proxy ${proxy.host} did not accept a connection from here (${reasonOf(err)}): a workspace reaches it on the network ${p.network}, so this is only a problem if this machine is on that network`),
    );
  } else say("warning", "no egress proxy: a workspace can reach any address its network allows");
}

async function mail(config: ControlConfig, to: string | undefined, say: (level: Level, text: string) => void): Promise<void> {
  const smtp = config.smtp;
  if (!smtp) {
    say("warning", `mail is written to ${config.outboxPath || "a file"} and not sent: nothing delivers it unless something of yours does`);
    return;
  }
  const how = `${smtp.host}:${smtp.port}`;
  if (to === undefined) {
    say("ok", `mail goes over SMTP to ${how}; give --mail-to <address> to send a message through it and prove it`);
    return;
  }
  let recipient: string;
  try {
    recipient = mailbox(to);
  } catch (err) {
    say("problem", (err as SmtpError).message);
    return;
  }
  await smtpTransportFor(smtp)
    .send({ to: recipient, kind: "mail-check", subject: "Curule Cloud preflight", text: `This message was sent by \`curule-cloud preflight\` to find out whether the control plane's mail reaches ${recipient}.\n\nIf you can read it, the mail server accepted it and delivered it to you.` })
    .then(
      () => say("ok", `${how} accepted a message for ${recipient}: look for it in the inbox, and in the spam folder`),
      (err: unknown) => say("problem", `${how} did not take a message for ${recipient}: ${reasonOf(err)}`),
    );
}

/** The findings as lines, and how many of each. */
export function describePreflight(findings: Finding[]): { lines: string[]; problems: number; warnings: number } {
  const label: Record<Level, string> = { ok: "ok     ", warning: "warning", problem: "PROBLEM" };
  const lines = findings.map((f) => `${label[f.level]}  ${f.text}`);
  const problems = findings.filter((f) => f.level === "problem").length;
  const warnings = findings.filter((f) => f.level === "warning").length;
  return { lines, problems, warnings };
}
