/**
 * Workspaces: a customer's host, from the moment it is asked for to the moment its data is deleted.
 *
 * What the service owes a customer is in this file. A workspace is made only for an account that is in good standing and
 * under its plan's limit. Everything it needs is made for it alone: a model key that works at the gateway and nowhere else (or, on
 * a hosting-only plan, the customer's own key, kept for that workspace alone), a licence for the plan, a credential the proxy uses
 * and the browser never sees. If any step fails, what was made is taken
 * away again, so a failed start leaves no key, no container and no charge behind. When an account stops paying its workspaces
 * are stopped, not deleted, until the retention period ends; and deleting one deletes its data.
 *
 * The operator credential is not stored. It is derived from the service's secret and the workspace's id, so the proxy can
 * present it after a restart and nothing in the log can be used to reach a workspace.
 */
import { createHmac, randomBytes } from "node:crypto";
import { defaultTierOf, type Catalogue } from "./catalogue";
import { ServiceError } from "./errors";
import type { GatewayAdmin } from "./gateway-client";
import type { ModelKeyInput, ModelKeyStore } from "./model-keys";
import { mintWorkspaceLicence, type LicenceSigner } from "./licences";
import type { Mailer } from "./mailer";
import { ProvisionError, waitUntilReady, type Provisioner } from "./provisioner";
import type { Account, ControlLog, Workspace } from "./store";

export interface WorkspacesOptions {
  log: ControlLog;
  catalogue: Catalogue;
  /** The model gateway, for plans that sell model usage. Absent when every plan is `byok`: a workspace is then given the customer's own key. */
  gateway?: GatewayAdmin;
  /** Where customers' own model keys are kept. Required for a `byok` plan to give a workspace any models. */
  modelKeys?: ModelKeyStore;
  provisioner: Provisioner;
  mailer: Mailer;
  /** The service's secret: at least 32 characters. Workspace credentials are derived from it. */
  secret: string;
  /** Workspaces are served at `<slug>.<workspaceDomain>`. */
  workspaceDomain: string;
  /** Where a workspace reaches the gateway, up to and including `/v1`. Absent with no gateway. */
  gatewayUrl?: string;
  signer?: LicenceSigner;
  clock?: () => Date;
  limits?: { cpus: number; memoryMb: number; pids: number };
  /** Environment given to every workspace's host (an egress proxy, for instance). */
  workspaceEnv?: Record<string, string>;
  /** The address of the app. A workspace's host is told where the account page is (`CURULE_ACCOUNT_URL`), so its console can send a person there to add a model key. */
  appUrl?: string;
  /** How a host is waited for. For tests. */
  waitReady?: (upstream: { host: string; port: number }) => Promise<void>;
  /** A workspace that has been starting this long without finishing is given up on, in ms. */
  provisionTimeoutMs?: number;
  graceDays?: number;
  retentionDays?: number;
  periodGraceDays?: number;
}

const LIVE = new Set(["requested", "provisioning", "running", "suspended"]);

/** How long workspaces keep running after a payment fails, and how long they are kept after a subscription ends, unless the operator says otherwise. */
export const DEFAULT_GRACE_DAYS = 3;
export const DEFAULT_RETENTION_DAYS = 30;

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 160);

/** The address a workspace's host is told its account page is at: under the app, however many slashes the configured address ends in. */
export function accountPageUrl(appUrl: string): string {
  return `${appUrl.replace(/\/+$/, "")}/account`;
}

export class Workspaces {
  private readonly clock: () => Date;
  /** Provisioning in progress, by workspace id: awaited by tests and by shutdown. */
  readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly o: WorkspacesOptions) {
    if (o.secret.length < 32) throw new Error("the service secret must be at least 32 characters");
    this.clock = o.clock ?? (() => new Date());
  }

  private get state() {
    return this.o.log.state;
  }

  /** The credential the proxy presents to a workspace's host. Derived, never stored. */
  operatorToken(workspaceId: string): string {
    return createHmac("sha256", this.o.secret).update(`workspace-operator:${workspaceId}`).digest("base64url");
  }

  /** What the pages tell a customer about a payment that fails and a subscription that ends, so they say what this service does. */
  get policy(): { graceDays: number; retentionDays: number } {
    return { graceDays: this.o.graceDays ?? DEFAULT_GRACE_DAYS, retentionDays: this.o.retentionDays ?? DEFAULT_RETENTION_DAYS };
  }

  hostOf(slug: string): string {
    return `${slug}.${this.o.workspaceDomain}`;
  }

  forAccount(accountId: string): Workspace[] {
    return [...this.state.workspaces.values()].filter((w) => w.accountId === accountId && w.status !== "destroyed").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** The workspace a request for this host is for, if it is one that can be served. */
  byHost(host: string): Workspace | undefined {
    const suffix = `.${this.o.workspaceDomain}`;
    const h = host.toLowerCase().replace(/:\d+$/, "");
    if (!h.endsWith(suffix)) return undefined;
    const id = this.state.bySlug.get(h.slice(0, -suffix.length));
    const w = id ? this.state.workspaces.get(id) : undefined;
    return w && w.status !== "destroyed" ? w : undefined;
  }

  private slugFor(name: string): string {
    const base = name
      .normalize("NFKD")
      .replace(/[^\x00-\x7f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24)
      .replace(/-+$/g, "");
    for (;;) {
      const slug = `${base === "" ? "workspace" : base}-${randomBytes(3).toString("hex")}`;
      if (!this.state.bySlug.has(slug)) return slug;
    }
  }

  private standing(account: Account): "active" | "past_due" | "none" {
    const s = account.subscription;
    if (!s || s.status === "ended") return "none";
    return s.status;
  }

  /** Ask for a workspace. Returns at once with it in `provisioning`; `inFlight` has the rest. */
  async create(accountId: string, rawName: unknown): Promise<Workspace> {
    const account = this.state.accounts.get(accountId);
    if (!account || account.disabledAt !== undefined || account.verifiedAt === undefined) throw new ServiceError(403, "not_allowed", "This account cannot create workspaces.");
    const standing = this.standing(account);
    if (standing === "none") throw new ServiceError(402, "no_subscription", "Choose a plan before creating a workspace.");
    if (standing === "past_due") throw new ServiceError(402, "payment_overdue", "The last payment did not go through. Update your payment details to create a workspace.");
    const plan = this.o.catalogue.plan(account.subscription!.plan);
    if (!plan) throw new ServiceError(409, "plan_unknown", "Your plan is no longer offered. Contact the operator.");
    const live = this.forAccount(accountId).filter((w) => LIVE.has(w.status));
    if (live.length >= plan.workspaces) throw new ServiceError(403, "workspace_limit", `Your plan allows ${plan.workspaces} workspace${plan.workspaces === 1 ? "" : "s"}.`);
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name.length < 1 || name.length > 60 || /[\x00-\x1f\x7f]/.test(name)) throw new ServiceError(400, "invalid_name", "Give the workspace a name of 1 to 60 characters.");
    const workspaceId = `ws_${randomBytes(6).toString("hex")}`;
    const slug = this.slugFor(name);
    await this.o.log.append({ type: "workspace.requested", workspaceId, accountId, name, slug, plan: plan.id });
    await this.o.log.append({ type: "workspace.status", workspaceId, status: "provisioning" });
    const run = this.provision(workspaceId).finally(() => this.inFlight.delete(workspaceId));
    this.inFlight.set(workspaceId, run);
    return this.state.workspaces.get(workspaceId)!;
  }

  /** What a host is started with. `key` is the gateway's virtual key for a plan that sells usage; a hosting-only plan has none and is given the customer's own. */
  private async specFor(w: Workspace, key: { token: string } | undefined): Promise<Parameters<Provisioner["create"]>[0]> {
    const plan = this.o.catalogue.plan(w.plan);
    const own = plan?.byok ? this.o.modelKeys?.read(w.workspaceId) : undefined;
    const tier = plan && !plan.byok ? defaultTierOf(plan) : undefined;
    // After the operator's own additions, so they cannot point a customer's console somewhere else.
    const env = { ...this.o.workspaceEnv, ...(this.o.appUrl ? { CURULE_ACCOUNT_URL: accountPageUrl(this.o.appUrl) } : {}), ...(tier ? { CURULE_GATEWAY_MODEL: tier } : {}) };
    return {
      workspaceId: w.workspaceId,
      accountId: w.accountId,
      slug: w.slug,
      plan: w.plan,
      ...(this.o.signer && plan ? { licence: mintWorkspaceLicence({ signer: this.o.signer, plan: plan.licencePlan, accountId: w.accountId, workspaceId: w.workspaceId, now: this.clock() }).token } : {}),
      operatorToken: this.operatorToken(w.workspaceId),
      ...(key && this.o.gatewayUrl ? { gateway: { baseUrl: this.o.gatewayUrl, key: key.token } } : {}),
      ...(own ? { model: { provider: own.provider, name: own.model, ...(own.baseUrl ? { baseUrl: own.baseUrl } : {}), key: own.key } } : {}),
      limits: this.o.limits ?? { cpus: 1, memoryMb: 2048, pids: 512 },
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  }

  /** A gateway key for a workspace of a plan that sells usage; none for one that does not. A plan that sells usage with no gateway is a configuration mistake and is said as one. */
  private async gatewayKeyFor(w: Workspace, plan: ReturnType<Catalogue["plan"]>): Promise<{ keyId: string; token: string } | undefined> {
    if (plan?.byok) return undefined;
    if (!this.o.gateway) throw new ProvisionError("this plan sells model usage and the service has no gateway configured");
    return this.o.gateway.createKey({ accountId: w.accountId, workspaceId: w.workspaceId, label: `workspace ${w.slug}`, ...(plan?.tiers ? { models: plan.tiers } : {}) });
  }

  private async provision(workspaceId: string): Promise<void> {
    const w = this.state.workspaces.get(workspaceId)!;
    const plan = this.o.catalogue.plan(w.plan);
    let keyId: string | undefined;
    let handle: string | undefined;
    try {
      const key = await this.gatewayKeyFor(w, plan);
      keyId = key?.keyId;
      const made = await this.o.provisioner.create(await this.specFor(w, key));
      handle = made.handle;
      await this.o.log.append({ type: "workspace.provisioned", workspaceId, handle: made.handle, upstream: made.upstream, ...(key ? { gatewayKeyId: key.keyId } : {}) });
      await (this.o.waitReady ?? ((u) => waitUntilReady(u)))(made.upstream);
      await this.o.log.append({ type: "workspace.status", workspaceId, status: "running" });
    } catch (err) {
      // Take away whatever was made, so a failed start leaves nothing behind.
      if (keyId) await this.o.gateway?.revokeKey(keyId, "workspace could not be started").catch(() => undefined);
      if (handle) await this.o.provisioner.destroy(handle).catch(() => undefined);
      await this.o.log.append({ type: "workspace.status", workspaceId, status: "failed", reason: err instanceof ProvisionError ? err.message.slice(0, 200) : "the workspace could not be started" }).catch(() => undefined);
    }
  }

  private get(accountId: string | undefined, workspaceId: string): Workspace {
    const w = this.state.workspaces.get(workspaceId);
    if (!w || w.status === "destroyed" || (accountId !== undefined && w.accountId !== accountId)) throw new ServiceError(404, "not_found", "There is no such workspace.");
    return w;
  }

  /** Stop a workspace, keeping its data. `accountId` is checked when a customer asks, and omitted when the service does. */
  async suspend(workspaceId: string, reason: string, accountId?: string): Promise<void> {
    const w = this.get(accountId, workspaceId);
    if (w.status === "suspended") return;
    if (w.status !== "running" || !w.handle) throw new ServiceError(409, "not_running", "That workspace is not running.");
    await this.o.provisioner.suspend(w.handle);
    await this.o.log.append({ type: "workspace.status", workspaceId, status: "suspended", reason });
  }

  async resume(workspaceId: string, accountId?: string): Promise<void> {
    const w = this.get(accountId, workspaceId);
    if (w.status === "running") return;
    if (w.status !== "suspended" || !w.handle) throw new ServiceError(409, "not_suspended", "That workspace is not stopped.");
    const account = this.state.accounts.get(w.accountId);
    if (!account || account.disabledAt !== undefined) throw new ServiceError(403, "not_allowed", "This account cannot run workspaces.");
    if (this.standing(account) !== "active") throw new ServiceError(402, "payment_overdue", "Payment is needed before this workspace can run.");
    const made = await this.o.provisioner.resume(w.handle);
    await this.o.log.append({ type: "workspace.provisioned", workspaceId, handle: made.handle, upstream: made.upstream });
    await (this.o.waitReady ?? ((u) => waitUntilReady(u)))(made.upstream);
    await this.o.log.append({ type: "workspace.status", workspaceId, status: "running" });
  }

  /** Delete a workspace and its data. Its model key stops working first, so nothing can spend after the decision. */
  async destroy(workspaceId: string, accountId?: string): Promise<void> {
    const w = this.get(accountId, workspaceId);
    if (w.gatewayKeyId) await this.o.gateway?.revokeKey(w.gatewayKeyId, "workspace deleted");
    if (w.handle) await this.o.provisioner.destroy(w.handle);
    // The customer's own key goes with the workspace: nothing of it is kept once the host that used it is gone.
    if (this.o.modelKeys?.has(workspaceId)) await this.o.modelKeys.remove(workspaceId);
    await this.o.log.append({ type: "workspace.status", workspaceId, status: "destroyed", reason: accountId === undefined ? "removed by the service" : "deleted by its owner" });
  }

  /** Make the host again with the plan it is now on, keeping its data: a new licence and a new model key. */
  async reprovision(workspaceId: string, plan: string): Promise<void> {
    const w = this.get(undefined, workspaceId);
    if (w.status !== "running" && w.status !== "suspended") return;
    await this.o.log.append({ type: "workspace.plan_changed", workspaceId, plan });
    // A key brought for a plan that is hosting only is not kept for one that is not: the workspace then runs on the gateway.
    if (!this.o.catalogue.plan(plan)?.byok && this.o.modelKeys?.has(workspaceId)) {
      await this.o.modelKeys.remove(workspaceId);
      await this.o.log.append({ type: "workspace.model_key_removed", workspaceId });
    }
    await this.remake(workspaceId);
  }

  /** Stop the host and start it again with what it should now have (a plan, a model key), keeping its data. A suspended workspace is left suspended. */
  private async remake(workspaceId: string): Promise<void> {
    const old = this.get(undefined, workspaceId);
    const wasSuspended = old.status === "suspended";
    const planDef = this.o.catalogue.plan(old.plan);
    const key = await this.gatewayKeyFor(old, planDef);
    if (old.handle) await this.o.provisioner.destroy(old.handle, { keepData: true });
    const made = await this.o.provisioner.create(await this.specFor(old, key));
    if (old.gatewayKeyId) await this.o.gateway?.revokeKey(old.gatewayKeyId, "workspace moved to a new plan or model key").catch(() => undefined);
    await this.o.log.append({ type: "workspace.provisioned", workspaceId, handle: made.handle, upstream: made.upstream, gatewayKeyId: key?.keyId ?? "" });
    await (this.o.waitReady ?? ((u) => waitUntilReady(u)))(made.upstream);
    if (wasSuspended) {
      await this.o.provisioner.suspend(made.handle);
      await this.o.log.append({ type: "workspace.status", workspaceId, status: "suspended", reason: old.statusReason ?? "stopped" });
    } else await this.o.log.append({ type: "workspace.status", workspaceId, status: "running" });
  }

  /**
   * Store, replace or delete the customer's own model key for a workspace of a hosting-only plan, and start the host again with it (its
   * data is kept; a turn in progress is interrupted). The key is validated, kept sealed, and never appears in the log, in a response, or
   * in a seat's shell. `accountId` is the customer who asks: another account's workspace is not found.
   */
  async setModelKey(accountId: string, workspaceId: string, input: ModelKeyInput | null): Promise<void> {
    const w = this.get(accountId, workspaceId);
    const plan = this.o.catalogue.plan(w.plan);
    if (!plan?.byok) throw new ServiceError(409, "not_byok", "This workspace's plan supplies its models: there is no key of yours to keep.");
    const store = this.o.modelKeys;
    if (!store) throw new ServiceError(503, "keys_unavailable", "Model keys cannot be kept just now. Contact the operator.");
    if (w.status !== "running" && w.status !== "suspended") throw new ServiceError(409, "not_ready", "Wait until the workspace has started, and then set its key.");
    if (input === null) {
      if (!store.has(workspaceId)) return;
      await store.remove(workspaceId);
      await this.o.log.append({ type: "workspace.model_key_removed", workspaceId });
    } else {
      await store.set(workspaceId, input);
      await this.o.log.append({ type: "workspace.model_key_set", workspaceId, provider: input.provider, model: input.model, ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}) });
    }
    await this.remake(workspaceId);
  }

  /** What the service does about accounts that have stopped paying, and about starts that never finished. */
  async reconcile(): Promise<string[]> {
    const now = this.clock().getTime();
    const day = 86_400_000;
    const actions: string[] = [];
    for (const w of [...this.state.workspaces.values()]) {
      if (w.status === "provisioning" && !this.inFlight.has(w.workspaceId) && now - Date.parse(w.statusAt) > (this.o.provisionTimeoutMs ?? 300_000)) {
        if (w.gatewayKeyId) await this.o.gateway?.revokeKey(w.gatewayKeyId, "workspace never finished starting").catch(() => undefined);
        if (w.handle) await this.o.provisioner.destroy(w.handle).catch(() => undefined);
        await this.o.log.append({ type: "workspace.status", workspaceId: w.workspaceId, status: "failed", reason: "the service restarted while it was starting" });
        actions.push(`${w.workspaceId}: failed, it never finished starting`);
      }
    }
    for (const account of this.state.accounts.values()) {
      const sub = account.subscription;
      if (!sub) continue;
      // A period that ended with no payment recorded: the provider's message may have been lost, or the payment did not come.
      if (sub.status === "active" && sub.periodEnd && now > Date.parse(sub.periodEnd) + (this.o.periodGraceDays ?? 3) * day) {
        await this.o.log.append({ type: "subscription.changed", accountId: account.accountId, status: "past_due", reason: "no payment was recorded for the period that ended" });
        actions.push(`${account.accountId}: past due, no payment recorded for the period that ended`);
      }
      const current = this.state.accounts.get(account.accountId)!.subscription!;
      const overdue = current.status === "past_due" && current.pastDueSince !== undefined && now - Date.parse(current.pastDueSince) > (this.o.graceDays ?? DEFAULT_GRACE_DAYS) * day;
      const ended = current.status === "ended";
      if (overdue || ended) {
        for (const w of this.forAccount(account.accountId)) {
          if (w.status !== "running") continue;
          const why = ended ? "the subscription ended" : "payment is overdue";
          // One workspace that cannot be stopped is not a reason to leave the others running: it is said, and tried again next time.
          await this.suspend(w.workspaceId, why).then(
            () => actions.push(`${w.workspaceId}: stopped, ${why}`),
            (err: unknown) => actions.push(`${w.workspaceId}: could not be stopped (${reasonOf(err)}), ${why}; it is tried again at the next check`),
          );
        }
      }
      if (ended && current.endedAt && now - Date.parse(current.endedAt) > (this.o.retentionDays ?? DEFAULT_RETENTION_DAYS) * day) {
        for (const w of this.forAccount(account.accountId)) {
          await this.destroy(w.workspaceId).then(
            () => actions.push(`${w.workspaceId}: deleted, the retention period after the subscription ended is over`),
            (err: unknown) => actions.push(`${w.workspaceId}: could not be deleted (${reasonOf(err)}), the retention period after the subscription ended is over; it is tried again at the next check`),
          );
        }
      }
    }
    // A workspace the log calls running whose host is not. A host that is gone for good is a failure and is said to be. One that has
    // stopped (a container that crashed, a machine that was restarted, a control plane restarted over hosts that were its children)
    // is started again, and what stops it from starting is said and tried again at the next check.
    for (const w of this.state.workspaces.values()) {
      if (w.status !== "running" || !w.handle) continue;
      const seen = await this.o.provisioner.status(w.handle).catch(() => "running" as const);
      if (seen === "missing") {
        await this.o.log.append({ type: "workspace.status", workspaceId: w.workspaceId, status: "failed", reason: "the host disappeared" });
        actions.push(`${w.workspaceId}: failed, the host disappeared`);
      } else if (seen === "stopped") {
        try {
          const made = await this.o.provisioner.resume(w.handle);
          await this.o.log.append({ type: "workspace.provisioned", workspaceId: w.workspaceId, handle: made.handle, upstream: made.upstream });
          await (this.o.waitReady ?? ((u) => waitUntilReady(u)))(made.upstream);
          actions.push(`${w.workspaceId}: started again, its host had stopped`);
        } catch (err) {
          actions.push(`${w.workspaceId}: its host had stopped and could not be started (${reasonOf(err)}); it is tried again at the next check`);
        }
      }
    }
    return actions;
  }

  /** Wait for every start that is in progress. */
  async idle(): Promise<void> {
    await Promise.all([...this.inFlight.values()]);
  }
}
