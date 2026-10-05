import {
  AdminApi,
  type Gateway,
} from "../../packages/ai-gateway/src/index";
import {
  ControlLog,
  ControlPlane,
  InProcessGatewayAdmin,
  MemoryControlStore,
  MemoryMailer,
  ManualBilling,
  parseCatalogue,
  type BillingEvent,
  type BillingProvider,
  type Catalogue,
  type CheckoutInput,
  type ControlPlaneOptions,
  type GatewayAdmin,
  type ProvisionedWorkspace,
  type Provisioner,
  type WorkspaceRuntimeStatus,
  type WorkspaceSpec,
} from "../../packages/cloud/src/index";
import { generateLicenseKeyPair } from "../../packages/licensing/src/index";
import { rig as gatewayRig, type Rig as GatewayRig } from "../ai-gateway/support";

export const SECRET = "a-service-secret-of-at-least-thirty-two-characters";

export const CATALOGUE = {
  currency: "USD",
  plans: {
    team: { title: "Team", licence_plan: "team", price_minor: 14_900, period: "month", included_usage: 20, workspaces: 1, provider_price_id: "price_team", tiers: ["fast", "balanced"] },
    business: { title: "Business", licence_plan: "business", price_minor: 59_900, period: "month", included_usage: 100, workspaces: 3 },
    yearly: { title: "Team, yearly", licence_plan: "team", price_minor: 148_800, period: "year", included_usage: 20, workspaces: 1 },
  },
  topups: { options_minor: [1_000, 2_500, 10_000], minimum_minor: 500, maximum_minor: 100_000, usage_micros_per_minor: 10_000 },
};

export const catalogue = (): Catalogue => parseCatalogue(CATALOGUE);

/** A provisioner that does what the test says and remembers everything it was asked. */
export class FakeProvisioner implements Provisioner {
  readonly kind = "fake";
  readonly calls: Array<{ op: string; handle?: string; spec?: WorkspaceSpec; options?: unknown }> = [];
  readonly state = new Map<string, WorkspaceRuntimeStatus>();
  failNext: Array<"create" | "suspend" | "resume" | "destroy"> = [];
  /** While set, a create waits for it: a workspace stays in `provisioning` for as long as a test wants to look at it. */
  hold: Promise<void> | undefined;
  private n = 0;

  private maybeFail(op: "create" | "suspend" | "resume" | "destroy"): void {
    const i = this.failNext.indexOf(op);
    if (i >= 0) {
      this.failNext.splice(i, 1);
      throw new Error(`the ${op} failed`);
    }
  }

  async create(spec: WorkspaceSpec): Promise<ProvisionedWorkspace> {
    this.calls.push({ op: "create", spec });
    if (this.hold) await this.hold;
    this.maybeFail("create");
    const handle = `fake-${spec.workspaceId}-${++this.n}`;
    this.state.set(handle, "running");
    return { handle, upstream: { host: handle, port: 7420 } };
  }
  async suspend(handle: string): Promise<void> {
    this.calls.push({ op: "suspend", handle });
    this.maybeFail("suspend");
    this.state.set(handle, "stopped");
  }
  async resume(handle: string): Promise<ProvisionedWorkspace> {
    this.calls.push({ op: "resume", handle });
    this.maybeFail("resume");
    this.state.set(handle, "running");
    return { handle, upstream: { host: handle, port: 7420 } };
  }
  async destroy(handle: string, options?: { keepData?: boolean }): Promise<void> {
    this.calls.push({ op: "destroy", handle, options });
    this.maybeFail("destroy");
    this.state.delete(handle);
  }
  async status(handle: string): Promise<WorkspaceRuntimeStatus> {
    return this.state.get(handle) ?? "missing";
  }
  ops(op: string): typeof this.calls {
    return this.calls.filter((c) => c.op === op);
  }
}

/** A provider that remembers what it was asked and answers as the test says. */
export class RecordingBilling implements BillingProvider {
  readonly name = "recording";
  readonly checkouts: CheckoutInput[] = [];
  readonly portals: Array<{ accountId: string; customerRef?: string; returnUrl: string }> = [];
  failWith: Error | undefined;
  async createCheckout(input: CheckoutInput): Promise<{ url: string; ref: string }> {
    this.checkouts.push(input);
    if (this.failWith) throw this.failWith;
    return { url: `https://pay.example/c/${input.idempotencyKey}`, ref: `ref_${input.idempotencyKey}` };
  }
  async openPortal(input: { accountId: string; customerRef?: string; returnUrl: string }): Promise<{ url: string }> {
    this.portals.push(input);
    if (this.failWith) throw this.failWith;
    return { url: "https://pay.example/portal" };
  }
  parseWebhook(): BillingEvent[] {
    return [];
  }
}

export interface Plane {
  plane: ControlPlane;
  log: ControlLog;
  store: MemoryControlStore;
  mailer: MemoryMailer;
  provisioner: FakeProvisioner;
  gatewayRig: GatewayRig;
  gateway: GatewayAdmin;
  gatewayCore: Gateway;
  clock: { now: number; set(iso: string): void; advance(ms: number): void };
  keys: { kid: string; publicKey: string; privateKeyPem: string };
  /** An account that has signed up, verified and signed in. */
  account(email?: string, password?: string): Promise<{ accountId: string; email: string; password: string; sessionToken: string }>;
  /** Make an account paid for a plan, as a payment would. */
  subscribe(accountId: string, plan?: string, ref?: string): Promise<void>;
}

export interface PlaneOptions {
  billing?: BillingProvider;
  workspaces?: Partial<ControlPlaneOptions["workspaces"]>;
  accounts?: ControlPlaneOptions["accounts"];
  start?: string;
  noSigner?: boolean;
}

export async function plane(options: PlaneOptions = {}): Promise<Plane> {
  const clock = { now: Date.parse(options.start ?? "2026-10-05T12:00:00.000Z"), set(iso: string) { this.now = Date.parse(iso); }, advance(ms: number) { this.now += ms; } };
  const store = new MemoryControlStore();
  const log = await ControlLog.open(store, () => new Date(clock.now));
  const mailer = new MemoryMailer();
  const provisioner = new FakeProvisioner();
  const g = await gatewayRig({ credit: 0 });
  g.clock.set(new Date(clock.now).toISOString());
  const gateway = new InProcessGatewayAdmin(new AdminApi(g.gateway));
  const { privateKeyPem, publicKey } = generateLicenseKeyPair();
  const p = new ControlPlane({
    log,
    catalogue: catalogue(),
    billing: options.billing ?? new ManualBilling({ payUrl: (ref) => `https://app.example.com/pay?ref=${ref}` }),
    gateway,
    mailer,
    appUrl: "https://app.example.com",
    workspaces: {
      provisioner,
      secret: SECRET,
      workspaceDomain: "ws.example.com",
      gatewayUrl: "http://gateway.internal:8080/v1",
      ...(options.noSigner ? {} : { signer: { kid: "k1", privateKey: privateKeyPem } }),
      waitReady: async () => undefined,
      ...options.workspaces,
    },
    ...(options.accounts ? { accounts: options.accounts } : {}),
    clock: () => new Date(clock.now),
  });
  const out: Plane = {
    plane: p,
    log,
    store,
    mailer,
    provisioner,
    gatewayRig: g,
    gateway,
    gatewayCore: g.gateway,
    clock,
    keys: { kid: "k1", publicKey, privateKeyPem },
    async account(email = `user${Math.floor(Math.random() * 1e9)}@example.com`, password = "correct horse battery staple") {
      await p.accounts.signup(email, password);
      const mail = mailer.sent.filter((m) => m.to === email && m.kind === "verify").at(-1)!;
      const token = new URL(/https?:\/\/\S+/.exec(mail.text)![0]).searchParams.get("token")!;
      const session = await p.accounts.verify(token);
      return { accountId: session.account.accountId, email, password, sessionToken: session.sessionToken };
    },
    async subscribe(accountId, plan = "team", ref = `inv_${Math.random().toString(36).slice(2)}`) {
      await p.billing.apply({ type: "payment.succeeded", ref, purpose: "subscription", accountId, plan, amountMinor: 14_900, currency: "USD", at: new Date(clock.now).toISOString() });
    },
  };
  return out;
}

export function linkIn(text: string): string {
  return /https?:\/\/\S+/.exec(text)![0];
}

/** A plane with an account on a plan and one workspace that is running. */
export async function running(options: PlaneOptions = {}, plan = "team", email = "ada@example.com") {
  const p = await plane(options);
  const ada = await p.account(email);
  await p.subscribe(ada.accountId, plan);
  const created = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();
  return { p, ada, workspaceId: created.workspaceId, workspace: () => p.log.state.workspaces.get(created.workspaceId)! };
}
