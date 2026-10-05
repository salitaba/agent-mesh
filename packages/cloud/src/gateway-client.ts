/**
 * How the control plane talks to the model gateway: the admin API, as a typed client.
 *
 * Two implementations behind one interface. `HttpGatewayAdmin` is the real one: the gateway is its own process with its own
 * secrets, and the control plane reaches it over the network with the admin token. `InProcessGatewayAdmin` calls the same
 * handlers directly, for a development setup that runs both in one process; it exists so the two can be tested against each
 * other, and it is not a way to run the service, because the point of the gateway is that provider credentials live in a
 * process that holds nothing else.
 */
import type { AdminApi } from "../../ai-gateway/src/index";

export class GatewayAdminError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = "GatewayAdminError";
  }
}

export interface GatewayKey {
  keyId: string;
  accountId: string;
  workspaceId?: string;
  token: string;
}

export interface GrantInput {
  id: string;
  accountId: string;
  bucket: "included" | "purchased";
  mode?: "add" | "set";
  amountMicros: number;
  reason: string;
  reference?: string;
}

export interface AccountBalance {
  included: number;
  purchased: number;
  total: number;
  held: number;
  available: number;
}

export interface UsageGroup {
  group: string;
  calls: number;
  failed: number;
  aborted: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costMicros: number;
  chargeMicros: number;
  marginMicros: number;
}

export interface GatewayAdmin {
  createKey(input: { accountId: string; workspaceId?: string; label?: string; models?: string[]; limits?: Record<string, number> }): Promise<GatewayKey>;
  revokeKey(keyId: string, reason?: string): Promise<void>;
  grant(input: GrantInput): Promise<"recorded" | "duplicate">;
  account(accountId: string): Promise<{ balance: AccountBalance; charged: number; cost: number; currency: string }>;
  report(query: { groupBy?: string; accountId?: string; workspaceId?: string; from?: string; to?: string }): Promise<{ currency: string; groups: UsageGroup[]; total: UsageGroup }>;
}

type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

function client(call: Call): GatewayAdmin {
  const ok = async (method: string, path: string, body?: unknown): Promise<any> => {
    const res = await call(method, path, body);
    if (res.status >= 400) throw new GatewayAdminError(res.status, String(res.body?.error?.type ?? "error"), String(res.body?.error?.message ?? `the gateway answered ${res.status}`));
    return res.body;
  };
  const query = (q: Record<string, string | undefined>): string => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined) p.set(k, v);
    const s = p.toString();
    return s === "" ? "" : `?${s}`;
  };
  return {
    async createKey(input) {
      const b = await ok("POST", "/admin/keys", input);
      return { keyId: b.keyId, accountId: b.accountId, ...(b.workspaceId !== undefined ? { workspaceId: b.workspaceId } : {}), token: b.token };
    },
    async revokeKey(keyId, reason) {
      const res = await call("POST", `/admin/keys/${encodeURIComponent(keyId)}/revoke`, reason !== undefined ? { reason } : {});
      // A key that is already gone is what was wanted.
      if (res.status >= 400 && res.status !== 404) throw new GatewayAdminError(res.status, String(res.body?.error?.type ?? "error"), String(res.body?.error?.message ?? ""));
    },
    async grant(input) {
      const b = await ok("POST", "/admin/grants", input);
      return b.status;
    },
    async account(accountId) {
      const b = await ok("GET", `/admin/accounts/${encodeURIComponent(accountId)}`);
      return { balance: b.balance, charged: b.charged, cost: b.cost, currency: b.currency };
    },
    async report(q) {
      return ok("GET", `/admin/report${query({ groupBy: q.groupBy, accountId: q.accountId, workspaceId: q.workspaceId, from: q.from, to: q.to })}`);
    },
  };
}

export class HttpGatewayAdmin implements GatewayAdmin {
  private readonly api: GatewayAdmin;

  constructor(options: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    const base = options.baseUrl.replace(/\/+$/, "");
    const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.api = client(async (method, path, body) => {
      let res: Response;
      try {
        res = await doFetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new GatewayAdminError(0, "unreachable", `the model gateway could not be reached (${(err as Error).message})`);
      }
      const text = await res.text();
      let parsed: unknown = {};
      try {
        parsed = text === "" ? {} : JSON.parse(text);
      } catch {
        throw new GatewayAdminError(res.status, "invalid_response", "the model gateway answered with something that is not JSON");
      }
      return { status: res.status, body: parsed };
    });
  }

  createKey: GatewayAdmin["createKey"] = (i) => this.api.createKey(i);
  revokeKey: GatewayAdmin["revokeKey"] = (k, r) => this.api.revokeKey(k, r);
  grant: GatewayAdmin["grant"] = (i) => this.api.grant(i);
  account: GatewayAdmin["account"] = (a) => this.api.account(a);
  report: GatewayAdmin["report"] = (q) => this.api.report(q);
}

export class InProcessGatewayAdmin implements GatewayAdmin {
  private readonly api: GatewayAdmin;

  constructor(admin: AdminApi) {
    this.api = client(async (method, path, body) => {
      const out = await admin.handle(method, new URL(path, "http://gateway.invalid"), body);
      return { status: out.status, body: out.body };
    });
  }

  createKey: GatewayAdmin["createKey"] = (i) => this.api.createKey(i);
  revokeKey: GatewayAdmin["revokeKey"] = (k, r) => this.api.revokeKey(k, r);
  grant: GatewayAdmin["grant"] = (i) => this.api.grant(i);
  account: GatewayAdmin["account"] = (a) => this.api.account(a);
  report: GatewayAdmin["report"] = (q) => this.api.report(q);
}
