/**
 * `control.yaml`: what the operator writes to run the control plane, and what is checked before anything listens.
 *
 * Credentials are never in the file. Each names the environment variable it is read from, and a variable that is missing or
 * too short stops the service from starting, so a mistake is found at deploy time and not by the first customer. Every
 * problem is reported at once.
 *
 * Three mistakes are caught here because they cannot be seen from outside once the service is running:
 *
 *   - Workspaces served from the app's own registrable domain. A workspace runs a customer's code, and a page on a sibling
 *     address can set cookies for the whole domain, including the app's. The workspace domain must be a domain of its own,
 *     unless the operator writes `workspaces.allow_same_site: true`, which says in the file that they know, and is warned of.
 *   - A licence key the build does not trust. Every workspace would read its licence as an unknown key and run on the
 *     Community plan, whatever was paid for.
 *   - The local provisioner in production. It is not a boundary between customers.
 *   - Pages that still carry a place marked `TODO(owner)`: the terms and the privacy notice are the operator's to write, and the
 *     service must not take a payment from a person who agreed to a placeholder.
 *   - Mail that is configured to cross a network unencrypted with a password in it.
 */
import { createPrivateKey } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { LICENSE_PUBLIC_KEYS, signLicense, verifyLicense, type PublicKeySet } from "../../licensing/src/index";
import { loadCatalogue, type Catalogue } from "./catalogue";
import { workspaceAddresses } from "./provision-container";
import { SmtpError, addressOf, fromHeader } from "./smtp";

export interface ControlConfig {
  /** The address customers reach the app at, as an origin: `https://app.example.com`. */
  appUrl: string;
  /** Its host, lower-case and without a port. */
  appHost: string;
  workspaces: {
    /** Workspaces are served at `<slug>.<domain>`. */
    domain: string;
    scheme: "https" | "http";
    /** The port they are reached on, when it is not the scheme's own. */
    port?: number;
    /** The operator has accepted, in the file, that the domain shares its registrable domain with the app. */
    allowSameSite?: true;
  };
  /** True when the service is behind TLS. The local provisioner is refused then. */
  production: boolean;
  public: { host: string; port: number; trustProxyHops: number };
  owner: { host: string; port: number; token: string };
  pagesDir?: string;
  logPath: string;
  /** Where mail is written when it is not sent. Empty when `smtp` is set. */
  outboxPath: string;
  /** Mail is delivered over SMTP, through a queue kept in `spoolDir`. When it is absent, mail is written to `outboxPath`. */
  smtp?: SmtpSettings;
  plansPath: string;
  catalogue: Catalogue;
  secret: string;
  gateway: { adminUrl: string; adminToken: string; tenantUrl: string };
  licence?: { kid: string; privateKey: string };
  provisioner:
    | { kind: "container"; engine: string; image: string; network: string; subnet?: string; egressProxy?: string; noProxy: string[]; limits: WorkspaceLimits }
    | { kind: "local"; baseDir: string; hostCommand: string[]; limits: WorkspaceLimits };
  billing: { provider: "manual"; payUrl: string } | { provider: "hosted-checkout"; apiKey: string; webhookSecret: string; baseUrl?: string };
  reconcileMinutes: number;
  /** Things that are allowed and that the operator should know about. */
  warnings: string[];
}

export interface SmtpSettings {
  host: string;
  port: number;
  security: "tls" | "starttls" | "none";
  /** The account and password to sign in with, both or neither. */
  user?: string;
  password?: string;
  /** The address mail is sent from, with a name if it has one. */
  from: string;
  /** What this machine calls itself in EHLO, when it is not its host name. */
  hello?: string;
  /** The folder mail waits in until a service has taken it. */
  spoolDir: string;
}

export interface WorkspaceLimits {
  cpus: number;
  memoryMb: number;
  pids: number;
}

export interface LoadOptions {
  /** The public keys the build trusts licences from. For tests; the default is the build's own. */
  publicKeys?: PublicKeySet;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The places in a folder of pages that are marked for the operator, as `file:line`, in a stable order. */
export function markersIn(dir: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (/\.(html|js|css|txt|svg|json)$/.test(entry.name)) {
        fs.readFileSync(path.join(dir, next), "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (line.includes("TODO(owner)")) found.push(`${next.split(path.sep).join("/")}:${i + 1}`);
          });
      }
    }
  };
  walk("");
  return found;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function wholeNumber(value: unknown, what: string, min: number, max: number, fallback: number, problems: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${what} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);
    return fallback;
  }
  return value;
}

function listenSpec(raw: unknown, what: string, defaults: { host: string; port: number }, problems: string[]): { host: string; port: number } {
  if (raw === undefined || raw === null) return defaults;
  if (!isObject(raw)) {
    problems.push(`${what} must be a mapping with host and port`);
    return defaults;
  }
  const host = raw.host === undefined ? defaults.host : typeof raw.host === "string" && raw.host !== "" ? raw.host : (problems.push(`${what}.host must be an address`), defaults.host);
  const port = wholeNumber(raw.port, `${what}.port`, 0, 65_535, defaults.port, problems);
  return { host, port };
}

/** The last two labels of a host: its registrable domain, as far as can be told without the public suffix list. */
const siteOf = (host: string): string => host.split(".").slice(-2).join(".");

const isLocal = (host: string): boolean => host === "localhost" || host.endsWith(".localhost");

/** The readers a configuration is checked with: a path from the file, a secret from the environment, an http address. Each says what is wrong in `problems` and carries on. */
function readers(dir: string, env: NodeJS.ProcessEnv, problems: string[]) {
  const at = (p: unknown, what: string, required = true): string => {
    if (typeof p !== "string" || p.trim() === "") {
      if (required) problems.push(`${what} is required`);
      return "";
    }
    return path.resolve(dir, p);
  };
  /** A secret from the environment variable the file names. `key` is where it was named, `noun` what it is. */
  const fromEnv = (name: unknown, key: string, noun: string, minLength: number): string => {
    if (typeof name !== "string" || name === "") {
      problems.push(`${key} must name the environment variable that holds ${noun}`);
      return "";
    }
    const value = env[name] ?? "";
    if (value.trim().length < minLength) {
      problems.push(minLength > 1 ? `the environment variable ${name} must hold ${noun} of at least ${minLength} characters` : `the environment variable ${name} is not set, so there is no ${noun.replace(/^(the|an?) /, "")}`);
      return "";
    }
    return value;
  };
  const url = (value: unknown, what: string): URL | undefined => {
    if (typeof value !== "string" || value.trim() === "") {
      problems.push(`${what} is required`);
      return undefined;
    }
    try {
      const u = new URL(value);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http");
      return u;
    } catch {
      problems.push(`${what} '${value}' is not an http or https address`);
      return undefined;
    }
  };
  return { at, fromEnv, url };
}

const MAIL_PORTS = { tls: 465, starttls: 587, none: 25 } as const;

/** `mail.smtp`: where mail is delivered, checked as the rest of the file is, with every problem reported and the secrets read from the environment. */
function smtpSettings(
  raw: unknown,
  spool: unknown,
  logPath: string,
  dir: string,
  fromEnv: (name: unknown, key: string, noun: string, minLength: number) => string,
  problems: string[],
  warnings: string[],
): SmtpSettings | undefined {
  if (!isObject(raw)) {
    problems.push("mail.smtp must be a mapping with host and from, and user_env and password_env for a server that asks for a sign-in");
    return undefined;
  }
  const before = problems.length;
  const host = typeof raw.host === "string" ? raw.host.trim().toLowerCase() : "";
  if (host === "") problems.push("mail.smtp.host is required: the mail server, as a name or an address, without a port");
  else if (!HOSTNAME.test(host) && !net.isIP(host)) problems.push(`mail.smtp.host '${String(raw.host)}' is not a host name or an address (the port is mail.smtp.port, and there is no scheme)`);
  const port = raw.port === undefined || raw.port === null ? undefined : wholeNumber(raw.port, "mail.smtp.port", 1, 65_535, 0, problems);
  let security: SmtpSettings["security"] | undefined;
  if (raw.security === undefined || raw.security === null) security = port === 465 ? "tls" : "starttls";
  else if (raw.security === "tls" || raw.security === "starttls" || raw.security === "none") security = raw.security;
  else problems.push(`mail.smtp.security must be tls, starttls or none (got ${JSON.stringify(raw.security)})`);
  const from = typeof raw.from === "string" ? raw.from.trim() : "";
  if (from === "") problems.push("mail.smtp.from is required: the address mail is sent from, like no-reply@example.com or Curule <no-reply@example.com>");
  else {
    try {
      addressOf(from);
      fromHeader(from);
    } catch (err) {
      problems.push(`mail.smtp.from '${from.replace(/[\r\n]/g, " ")}' is not an address, or a name followed by one in angle brackets: ${err instanceof SmtpError ? err.message : String(err)}`);
    }
  }
  let hello: string | undefined;
  if (raw.hello !== undefined && raw.hello !== null) {
    if (typeof raw.hello === "string" && HOSTNAME.test(raw.hello.trim().toLowerCase())) hello = raw.hello.trim().toLowerCase();
    else problems.push(`mail.smtp.hello '${String(raw.hello)}' is not a host name: it is what this machine calls itself to the mail server`);
  }
  // A sign-in is both halves or neither: one without the other would be sent as no sign-in and fail at the first customer.
  const hasUser = raw.user_env !== undefined && raw.user_env !== null;
  const hasPassword = raw.password_env !== undefined && raw.password_env !== null;
  let user: string | undefined;
  let password: string | undefined;
  if (hasUser !== hasPassword) problems.push("mail.smtp.user_env and mail.smtp.password_env go together: a server that asks for a sign-in needs both, and one that does not needs neither");
  else if (hasUser) {
    user = fromEnv(raw.user_env, "mail.smtp.user_env", "the mail server's user name", 1);
    password = fromEnv(raw.password_env, "mail.smtp.password_env", "the mail server's password", 1);
    if (/[\0\r\n]/.test(user) || /[\0\r\n]/.test(password)) problems.push("the mail server's user name and password must not hold a line break or a NUL: a sign-in cannot carry one");
  }
  const local = host === "localhost" || host === "::1" || (net.isIPv4(host) && host.startsWith("127."));
  if (security === "none" && !local && host !== "") {
    if (user !== undefined) problems.push(`mail.smtp.security is none and the mail server '${host}' is not on this machine: the password would cross the network in the clear. Use starttls or tls`);
    else warnings.push(`mail.smtp.security is none for '${host}': mail, and the links in it that sign a person in, cross the network unencrypted. Use it only on a network that is trusted`);
  }
  let spoolDir = "";
  if (spool !== undefined && spool !== null) {
    if (typeof spool === "string" && spool.trim() !== "") spoolDir = path.resolve(dir, spool);
    else problems.push("mail.spool must be a folder");
  } else if (logPath !== "") spoolDir = path.join(path.dirname(logPath), "mail");
  if (problems.length > before || security === undefined) return undefined;
  return { host, port: port ?? MAIL_PORTS[security], security, ...(user !== undefined ? { user, password: password! } : {}), from, ...(hello ? { hello } : {}), spoolDir };
}

/** `mail`: where mail goes. A server, to deliver it over SMTP; or a file, to write it to for something of the operator's to deliver. */
function mailSettings(
  raw: unknown,
  logPath: string,
  production: boolean,
  read: { at: (p: unknown, what: string, required?: boolean) => string; fromEnv: (name: unknown, key: string, noun: string, minLength: number) => string },
  dir: string,
  problems: string[],
  warnings: string[],
): { smtp?: SmtpSettings; outboxPath: string } {
  const mail = isObject(raw) ? raw : {};
  const named = mail.smtp !== undefined && mail.smtp !== null;
  const smtp = named ? smtpSettings(mail.smtp, mail.spool, logPath, dir, read.fromEnv, problems, warnings) : undefined;
  if (smtp) {
    if (mail.outbox !== undefined) warnings.push("mail.outbox is not used while mail.smtp is set: mail is delivered, and no copy is written to a file");
    return { smtp, outboxPath: "" };
  }
  // A server that was named and is wrong has had its problems said: the file is not asked for as well.
  if (named) return { outboxPath: "" };
  if (typeof mail.outbox !== "string" || mail.outbox.trim() === "") {
    problems.push("mail.outbox is required, or mail.smtp to deliver mail over SMTP");
    return { outboxPath: "" };
  }
  const outboxPath = read.at(mail.outbox, "mail.outbox");
  if (production) warnings.push(`mail is written to ${outboxPath} and is not sent. A person who signs up gets no confirmation link unless something of yours delivers that file. Set mail.smtp to send it`);
  return { outboxPath };
}

function readConfigFile(file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the control-plane configuration ${file}: ${(err as Error).message}`);
  }
  if (!isObject(raw)) throw new Error(`${file}: expected a mapping with app_url, workspaces, gateway, plans and billing`);
  return raw;
}

/**
 * Only the mail part of a configuration, read and checked as the whole is, and nothing else: `curule-cloud mail-check` uses it,
 * so that mail can be proved before the rest of the service is ready (the legal pages written, the licence key in the build).
 */
export function loadMailConfig(file: string, env: NodeJS.ProcessEnv = process.env): { smtp?: SmtpSettings; outboxPath: string; warnings: string[] } {
  const raw = readConfigFile(file);
  const dir = path.dirname(path.resolve(file));
  const problems: string[] = [];
  const warnings: string[] = [];
  const read = readers(dir, env, problems);
  const logPath = read.at(raw.control_log, "control_log", false);
  const production = typeof raw.app_url === "string" && /^https:/i.test(raw.app_url.trim());
  const result = mailSettings(raw.mail, logPath, production, read, dir, problems, warnings);
  if (problems.length > 0) throw new Error(problems.map((p) => `${file}: ${p}`).join("\n"));
  return { ...result, warnings };
}

/** Read and check a control-plane configuration. Paths in it are relative to the file. `env` is where secrets are read from. */
export function loadControlConfig(file: string, env: NodeJS.ProcessEnv = process.env, options: LoadOptions = {}): ControlConfig {
  const raw = readConfigFile(file);
  const dir = path.dirname(path.resolve(file));
  const problems: string[] = [];
  /** Problems another file's loader already worded, with that file's name in them. */
  const elsewhere: string[] = [];
  const warnings: string[] = [];

  const { at, fromEnv, url } = readers(dir, env, problems);

  // ---- where the app is, and where workspaces are
  const app = url(raw.app_url, "app_url");
  let appUrl = "";
  let appHost = "";
  let production = true;
  let workspacePort: number | undefined;
  if (app) {
    if ((app.pathname !== "/" && app.pathname !== "") || app.search !== "" || app.hash !== "" || app.username !== "") problems.push(`app_url '${raw.app_url as string}' must be an address with no path, query or credentials, like https://app.example.com`);
    appUrl = app.origin;
    appHost = app.hostname.toLowerCase();
    production = app.protocol === "https:";
    if (app.port !== "") workspacePort = Number(app.port);
  }
  const ws = isObject(raw.workspaces) ? raw.workspaces : undefined;
  if (!ws) problems.push("workspaces must be a mapping with a domain");
  const domain = typeof ws?.domain === "string" ? ws.domain.trim().toLowerCase() : "";
  if (ws && !HOSTNAME.test(domain)) problems.push(`workspaces.domain '${String(ws.domain ?? "")}' is not a domain name`);
  if (ws && ws.allow_same_site !== undefined && typeof ws.allow_same_site !== "boolean") problems.push("workspaces.allow_same_site must be true or false");
  const allowSameSite = ws?.allow_same_site === true;
  let sameSiteAccepted = false;
  if (app && HOSTNAME.test(domain) && !(isLocal(appHost) && isLocal(domain))) {
    if (domain === appHost || appHost.endsWith(`.${domain}`) || domain.endsWith(`.${appHost}`)) problems.push(`workspaces.domain '${domain}' must not be the app's host '${appHost}', or above it or below it: a workspace is served at <slug>.${domain}`);
    else if (siteOf(domain) === siteOf(appHost)) {
      if (allowSameSite) {
        sameSiteAccepted = true;
        warnings.push(
          `workspaces.domain '${domain}' is under the same registrable domain as the app '${appHost}', which workspaces.allow_same_site accepts. A page in a workspace can set cookies for all of ${siteOf(appHost)}, and it is the same site as the app, so SameSite cookies do not hold it back. What stands in its way is that the app's session cookie is host-only and prefixed __Host- (a sibling address can neither set it nor read it) and that every change to the app must name the app's own address as its Origin. A domain of its own removes the risk`,
        );
      } else {
        problems.push(`workspaces.domain '${domain}' is under the same registrable domain as the app '${appHost}'. A workspace runs a customer's code, and a page there could set cookies for the app. Serve workspaces from a domain of their own, or, knowing that, write workspaces.allow_same_site: true`);
      }
    }
  }

  // ---- listeners
  const pub = isObject(raw.public) ? raw.public : {};
  const publicListen = listenSpec(raw.public, "public", { host: "127.0.0.1", port: 7500 }, problems);
  const trustProxyHops = wholeNumber(pub.trust_proxy_hops, "public.trust_proxy_hops", 0, 8, 0, problems);
  const ownerRaw = isObject(raw.owner) ? raw.owner : undefined;
  const ownerListen = listenSpec(ownerRaw ? { host: ownerRaw.host, port: ownerRaw.port } : undefined, "owner", { host: "127.0.0.1", port: 7501 }, problems);
  const ownerToken = ownerRaw ? fromEnv(ownerRaw.token_env, "owner.token_env", "the owner token", 24) : (problems.push("owner must be a mapping with token_env, which names the environment variable that holds the owner token"), "");
  if (publicListen.port !== 0 && publicListen.port === ownerListen.port && publicListen.host === ownerListen.host) problems.push("public and owner must not listen on the same address: the owner API is not for customers");
  if (ownerListen.host === "0.0.0.0" || ownerListen.host === "::") warnings.push(`the owner API listens on every interface (${ownerListen.host}). It can record payments and stop customers: keep it off any network a customer can reach`);
  if (production && trustProxyHops === 0) warnings.push("public.trust_proxy_hops is 0 on a service behind TLS: the caller's address will be the proxy's, and every customer will share one rate limit");

  // ---- files
  const pagesDir = at(raw.pages, "pages", false);
  if (pagesDir !== "" && !(fs.existsSync(pagesDir) && fs.statSync(pagesDir).isDirectory())) problems.push(`pages '${pagesDir}' is not a directory`);
  else if (pagesDir !== "") {
    const marked = markersIn(pagesDir);
    if (marked.length > 0) {
      const shown = marked.slice(0, 4).join(", ");
      const message = `the pages in '${pagesDir}' have ${marked.length} place${marked.length === 1 ? "" : "s"} marked TODO(owner), for the operator to write or confirm (${shown}${marked.length > 4 ? `, and ${marked.length - 4} more` : ""}). The terms and the privacy notice are what a person agrees to when they sign up and pay`;
      (production ? problems : warnings).push(message);
    }
  }
  const logPath = at(raw.control_log, "control_log");
  const { smtp, outboxPath } = mailSettings(raw.mail, logPath, production, { at, fromEnv }, dir, problems, warnings);
  const plansPath = at(raw.plans, "plans");
  let catalogue: Catalogue | undefined;
  if (plansPath !== "") {
    try {
      catalogue = loadCatalogue(plansPath);
    } catch (err) {
      elsewhere.push(...(err as Error).message.split("\n"));
    }
  }
  const secret = fromEnv(raw.secret_env, "secret_env", "the service secret", 32);

  // ---- the gateway
  const gw = isObject(raw.gateway) ? raw.gateway : undefined;
  let adminUrl: URL | undefined;
  let adminToken = "";
  let tenant: URL | undefined;
  if (!gw) problems.push("gateway must be a mapping with admin_url, admin_token_env and tenant_url");
  else {
    adminUrl = url(gw.admin_url, "gateway.admin_url");
    adminToken = fromEnv(gw.admin_token_env, "gateway.admin_token_env", "the gateway's admin token", 24);
    tenant = url(gw.tenant_url, "gateway.tenant_url");
    if (tenant && !/\/v1\/?$/.test(tenant.pathname)) problems.push(`gateway.tenant_url '${gw.tenant_url as string}' must end in /v1: it is the address a workspace's models are called at`);
  }

  // ---- provisioning
  const prov = isObject(raw.provisioner) ? raw.provisioner : undefined;
  const lim = isObject(prov?.limits) ? prov.limits : {};
  let cpus = 1;
  if (lim.cpus !== undefined) {
    if (typeof lim.cpus === "number" && lim.cpus >= 0.1 && lim.cpus <= 64) cpus = lim.cpus;
    else problems.push("provisioner.limits.cpus must be a number from 0.1 to 64");
  }
  const limits: WorkspaceLimits = {
    cpus,
    memoryMb: wholeNumber(lim.memory_mb, "provisioner.limits.memory_mb", 128, 262_144, 2048, problems),
    pids: wholeNumber(lim.pids, "provisioner.limits.pids", 32, 100_000, 512, problems),
  };
  let provisioner: ControlConfig["provisioner"] | undefined;
  if (!prov) problems.push("provisioner must be a mapping with a kind: container or local");
  else if (prov.kind === "container") {
    const image = typeof prov.image === "string" && prov.image.trim() !== "" ? prov.image.trim() : (problems.push("provisioner.image is required: the Curule image a workspace runs"), "");
    const network = typeof prov.network === "string" && prov.network.trim() !== "" ? prov.network.trim() : (problems.push("provisioner.network is required: the internal network workspaces join, with an egress proxy"), "");
    const engine = prov.engine === undefined ? "docker" : prov.engine === "docker" || prov.engine === "podman" ? prov.engine : (problems.push("provisioner.engine must be docker or podman"), "docker");
    let egressProxy: string | undefined;
    if (prov.egress_proxy !== undefined) egressProxy = url(prov.egress_proxy, "provisioner.egress_proxy")?.href;
    else if (production) warnings.push("provisioner.egress_proxy is not set: a workspace can reach any address its network allows, including other workspaces if the network is not internal");
    const noProxy = Array.isArray(prov.no_proxy) && prov.no_proxy.every((h) => typeof h === "string" && h !== "") ? (prov.no_proxy as string[]) : prov.no_proxy === undefined ? [] : (problems.push("provisioner.no_proxy must be a list of hosts"), []);
    // A control plane that runs on the machine and not in a container cannot resolve a container's name, so a workspace is given an address of its own
    // in the network's subnet and is reached there.
    let subnet: string | undefined;
    if (prov.subnet !== undefined) {
      if (typeof prov.subnet !== "string") problems.push("provisioner.subnet must be the network's subnet, like 10.213.0.0/24");
      else {
        try {
          workspaceAddresses({ subnet: prov.subnet });
          subnet = prov.subnet;
        } catch (err) {
          problems.push(`provisioner.subnet: ${(err as Error).message}`);
        }
      }
    }
    provisioner = { kind: "container", engine, image, network, ...(subnet ? { subnet } : {}), ...(egressProxy ? { egressProxy } : {}), noProxy, limits };
  } else if (prov.kind === "local") {
    if (production) problems.push("provisioner.kind local is for trying the service on one machine: an agent's shell runs as the same user as every other workspace and as the control plane. Use container, or serve the app over http:// to say this is a trial");
    const hostCommand = Array.isArray(prov.host_command) && prov.host_command.length > 0 && prov.host_command.every((c) => typeof c === "string" && c !== "") ? (prov.host_command as string[]) : (problems.push("provisioner.host_command must be the command that starts a host, as a list: [node, dist/apps/mesh-cli/src/index.js]"), []);
    provisioner = { kind: "local", baseDir: at(prov.base_dir, "provisioner.base_dir"), hostCommand, limits };
  } else if (prov) problems.push(`provisioner.kind must be container or local (got ${JSON.stringify(prov.kind)})`);

  // ---- the licence workspaces run with
  let licence: ControlConfig["licence"];
  const lic = isObject(raw.licence) ? raw.licence : undefined;
  if (!lic) {
    if (production) problems.push("licence is required: the key workspace licences are signed with (kid, and private_key_file or private_key_env). Without it a workspace runs on the Community plan, whatever was paid for");
    else warnings.push("no licence key: workspaces run on the Community plan's limits");
  } else {
    const kid = typeof lic.kid === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(lic.kid) ? lic.kid : (problems.push("licence.kid must be 1 to 32 characters of letters, digits, _ and -"), "");
    let pem = "";
    if (typeof lic.private_key_file === "string" && lic.private_key_file !== "") {
      try {
        pem = fs.readFileSync(path.resolve(dir, lic.private_key_file), "utf8");
      } catch (err) {
        problems.push(`licence.private_key_file cannot be read: ${(err as Error).message}`);
      }
    } else if (typeof lic.private_key_env === "string" && lic.private_key_env !== "") {
      pem = env[lic.private_key_env] ?? "";
      if (pem.trim() === "") problems.push(`the environment variable ${lic.private_key_env} is not set, so there is no licence key`);
    } else problems.push("licence needs private_key_file or private_key_env");
    if (kid !== "" && pem.trim() !== "") {
      try {
        createPrivateKey(pem);
        const now = new Date();
        const probe = signLicense({ v: 1, id: "lic_check", customer: "check", plan: "team", issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 86_400_000).toISOString() }, kid, pem);
        const verdict = verifyLicense(probe, options.publicKeys ?? LICENSE_PUBLIC_KEYS);
        if (verdict.ok) licence = { kid, privateKey: pem };
        else {
          const why = verdict.reason === "unknown-key" ? `this build trusts no public key '${kid}': add it to packages/licensing/src/keys.ts and rebuild` : verdict.reason === "bad-signature" ? `the private key is not the one whose public half this build holds for '${kid}'` : verdict.detail;
          const message = `the licence key does not verify (${why}). Every workspace would read its licence as invalid and run on the Community plan`;
          if (production) problems.push(message);
          else {
            warnings.push(message);
            licence = { kid, privateKey: pem };
          }
        }
      } catch (err) {
        problems.push(`the licence key is not a private key: ${(err as Error).message}`);
      }
    }
  }

  // ---- money
  const bill = isObject(raw.billing) ? raw.billing : undefined;
  let billing: ControlConfig["billing"] | undefined;
  if (!bill) problems.push("billing must be a mapping with a provider: manual or hosted-checkout");
  else if (bill.provider === "manual") {
    const payUrl = typeof bill.pay_url === "string" && bill.pay_url.includes("{ref}") ? bill.pay_url : (problems.push("billing.pay_url is required for manual billing, and must contain {ref}: where a customer is sent to pay, with the reference to pay under"), "");
    if (payUrl !== "") {
      try {
        new URL(payUrl.replace("{ref}", "x"));
      } catch {
        problems.push(`billing.pay_url '${payUrl}' is not an address`);
      }
    }
    billing = { provider: "manual", payUrl };
  } else if (bill.provider === "hosted-checkout") {
    const apiKey = fromEnv(bill.api_key_env, "billing.api_key_env", "the provider's API key", 1);
    const webhookSecret = fromEnv(bill.webhook_secret_env, "billing.webhook_secret_env", "the signing secret of the provider's messages", 8);
    const base = bill.base_url === undefined ? undefined : url(bill.base_url, "billing.base_url")?.href;
    billing = { provider: "hosted-checkout", apiKey, webhookSecret, ...(base ? { baseUrl: base } : {}) };
    if (catalogue) {
      for (const p of catalogue.plans()) {
        if (!p.providerPriceId) problems.push(`plan '${p.id}' has no provider_price_id, which hosted checkout needs to sell it`);
        // The example says REPLACE where the provider's own id goes. Left there, a checkout is asked for a price that does not exist, and the first customer finds out.
        else if (/REPLACE/i.test(p.providerPriceId)) (production ? problems : warnings).push(`plan '${p.id}' has provider_price_id '${p.providerPriceId}', which is still the example's placeholder: put the provider's own id for this price there`);
      }
    }
  } else if (bill) problems.push(`billing.provider must be manual or hosted-checkout (got ${JSON.stringify(bill.provider)})`);

  const reconcileMinutes = wholeNumber(raw.reconcile_minutes, "reconcile_minutes", 1, 1_440, 15, problems);

  if (problems.length > 0 || elsewhere.length > 0) throw new Error([...problems.map((p) => `${file}: ${p}`), ...elsewhere].join("\n"));
  return {
    appUrl,
    appHost,
    workspaces: { domain, scheme: production ? "https" : "http", ...(workspacePort !== undefined ? { port: workspacePort } : {}), ...(sameSiteAccepted ? { allowSameSite: true as const } : {}) },
    production,
    public: { ...publicListen, trustProxyHops },
    owner: { ...ownerListen, token: ownerToken },
    ...(pagesDir !== "" ? { pagesDir } : {}),
    logPath,
    outboxPath,
    ...(smtp ? { smtp } : {}),
    plansPath,
    catalogue: catalogue!,
    secret,
    gateway: { adminUrl: adminUrl!.href.replace(/\/+$/, ""), adminToken, tenantUrl: tenant!.href.replace(/\/+$/, "") },
    ...(licence ? { licence } : {}),
    provisioner: provisioner!,
    billing: billing!,
    reconcileMinutes,
    warnings,
  };
}
