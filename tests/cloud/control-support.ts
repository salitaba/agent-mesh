import { generateLicenseKeyPair } from "../../packages/licensing/src/index";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { stringify } from "yaml";
import { CATALOGUE } from "./support";

export const ENV = {
  CONTROL_SECRET: "a-control-secret-of-at-least-thirty-two-chars",
  CONTROL_OWNER_TOKEN: "an-owner-token-of-at-least-24-chars",
  GATEWAY_ADMIN_TOKEN: "a-gateway-admin-token-of-24-chars",
  SMTP_USER: "mailer@curule.example",
  SMTP_PASSWORD: "an-smtp-password-with-: and é",
};

/** A configuration that is valid, as an object: a test changes what it is about and leaves the rest. */
export function baseConfig(): Record<string, any> {
  return {
    app_url: "https://app.curule.example",
    workspaces: { domain: "curule-ws.example" },
    public: { host: "127.0.0.1", port: 0, trust_proxy_hops: 1 },
    owner: { host: "127.0.0.1", port: 0, token_env: "CONTROL_OWNER_TOKEN" },
    pages: "./pages",
    control_log: "./data/control.jsonl",
    mail: { smtp: { host: "smtp.mail.example", port: 587, security: "starttls", user_env: "SMTP_USER", password_env: "SMTP_PASSWORD", from: "Curule <no-reply@curule.example>" } },
    plans: "./plans.yaml",
    secret_env: "CONTROL_SECRET",
    gateway: { admin_url: "http://gateway.internal:8081", admin_token_env: "GATEWAY_ADMIN_TOKEN", tenant_url: "http://gateway.internal:8080/v1" },
    licence: { kid: "k1", private_key_file: "./secrets/licence-k1.pem" },
    provisioner: { kind: "container", image: "ghcr.io/example/curule:1", network: "curule-workspaces", egress_proxy: "http://egress.curule-workspaces:3128", limits: { cpus: 1, memory_mb: 2048, pids: 512 } },
    billing: { provider: "manual", pay_url: "https://app.curule.example/pay?ref={ref}" },
    reconcile_minutes: 15,
  };
}

/** The change that makes a configuration a trial on one machine: http on localhost, local processes, and no licence key to be trusted. */
export function trial(raw: Record<string, any>): void {
  raw.app_url = "http://localhost:7500";
  raw.workspaces = { domain: "localhost" };
  raw.provisioner = { kind: "local", base_dir: "./workspaces", host_command: ["node", "dist/apps/mesh-cli/src/index.js"] };
  delete raw.licence;
  raw.billing = { provider: "manual", pay_url: "http://localhost:7500/pay?ref={ref}" };
}

/** A catalogue in which every plan has the provider's price id, as hosted checkout needs. */
export function pricedCatalogue(): Record<string, any> {
  const plans = Object.fromEntries(Object.entries(CATALOGUE.plans).map(([id, p]) => [id, { ...p, provider_price_id: `price_${id}` }]));
  return { ...CATALOGUE, plans };
}

export interface Workdir {
  dir: string;
  file: string;
  publicKey: string;
  privateKeyPem: string;
  /** The configuration the file holds, to read from. */
  raw: Record<string, any>;
  rewrite(change: (raw: Record<string, any>) => void): void;
  done(): void;
}

/** A directory with a control.yaml, its plans, a pages directory and a licence key that the build (given `publicKeys`) trusts. */
export function workdir(change: (raw: Record<string, any>) => void = () => undefined, catalogue: Record<string, any> = CATALOGUE): Workdir {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-config-"));
  fs.mkdirSync(path.join(dir, "pages"));
  fs.mkdirSync(path.join(dir, "secrets"));
  const keys = generateLicenseKeyPair();
  fs.writeFileSync(path.join(dir, "secrets", "licence-k1.pem"), keys.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "plans.yaml"), stringify(catalogue));
  const file = path.join(dir, "control.yaml");
  const w: Workdir = {
    dir,
    file,
    publicKey: keys.publicKey,
    privateKeyPem: keys.privateKeyPem,
    raw: baseConfig(),
    rewrite(c) {
      c(w.raw);
      fs.writeFileSync(file, stringify(w.raw));
    },
    done: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  w.rewrite(change);
  return w;
}
