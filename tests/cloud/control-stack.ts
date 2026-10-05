import assert from "node:assert/strict";
import { AdminApi, createAdminServer, listen as listenGateway } from "../../packages/ai-gateway/src/index";
import { MemoryControlStore, MemoryMailer, loadControlConfig, startControl, type ControlLogRecord, type StartOptions } from "../../packages/cloud/src/index";
import { rig as gatewayRig } from "../ai-gateway/support";
import { ask, type Ask } from "./net-support";
import { ENV, workdir } from "./control-support";
import { FakeProvisioner } from "./support";
import { PASSWORD, tokenIn } from "./web-support";

export const APP_HOST = "app.curule.example";
export const OWNER_AUTH = { authorization: `Bearer ${ENV.CONTROL_OWNER_TOKEN}` };

export type Stack = Awaited<ReturnType<typeof stack>>;

/** A real gateway admin server, a control plane configured to talk to it, and a clock a test can move. */
export async function stack(options: { change?: (raw: Record<string, any>) => void; catalogue?: Record<string, any>; env?: NodeJS.ProcessEnv; start?: Partial<StartOptions> } = {}) {
  const g = await gatewayRig({ credit: 0 });
  const admin = await listenGateway(createAdminServer(new AdminApi(g.gateway), g.gateway, { token: ENV.GATEWAY_ADMIN_TOKEN }), 0, "127.0.0.1");
  const w = workdir((raw) => {
    raw.gateway.admin_url = admin.url;
    options.change?.(raw);
  }, options.catalogue);
  const env = options.env ?? ENV;
  const config = loadControlConfig(w.file, env, { publicKeys: { k1: w.publicKey } });
  const store = new MemoryControlStore();
  const provisioner = new FakeProvisioner();
  const mailer = new MemoryMailer();
  const clock = { now: Date.parse("2026-10-05T12:00:00.000Z") };
  const logs: ControlLogRecord[] = [];
  const running = await startControl(config, { store, provisioner, mailer, clock: () => new Date(clock.now), log: (r) => logs.push(r), waitReady: async () => undefined, ...options.start });
  return {
    g,
    admin,
    w,
    config,
    store,
    provisioner,
    clock,
    logs,
    running,
    app: (a: Ask = {}) => ask(running.public.port, { host: APP_HOST, ...a }),
    owner: (a: Ask = {}) => ask(running.owner.port, { ...a, headers: { ...OWNER_AUTH, ...a.headers } }),
    /** The mail the service has sent, in order. */
    outbox: (): Array<{ to: string; kind: string; text: string }> => mailer.sent,
    async close() {
      await running.stop(0).catch(() => undefined);
      await admin.close(0);
      w.done();
    },
  };
}

/** Sign up and confirm through the public API, and return the cookie. */
export async function signedUp(s: Stack, email = "ada@example.com") {
  const post = (p: string, json: unknown, headers: Record<string, string> = {}) => s.app({ method: "POST", path: p, json, headers: { origin: `https://${APP_HOST}`, ...headers } });
  assert.equal((await post("/api/signup", { email, password: PASSWORD })).status, 202);
  const mail = s.outbox().filter((m) => m.to === email && m.kind === "verify").at(-1)!;
  const verified = await post("/api/verify", { token: tokenIn(mail.text) });
  assert.equal(verified.status, 200);
  const cookie = String(verified.headers["set-cookie"]![0]).split(";")[0]!;
  return { cookie, accountId: verified.json.account.accountId as string, post: (p: string, json?: unknown) => post(p, json ?? {}, { cookie }), get: (p: string) => s.app({ path: p, headers: { cookie } }) };
}

