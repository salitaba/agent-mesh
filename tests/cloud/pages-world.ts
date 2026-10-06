/**
 * The service as the account pages' script sees it, for the tests that run that script on the real page files: a plan list, an account with a
 * subscription and workspaces, the answers to the calls a page makes, and the ones a test changes to see what a page does with them.
 */
import type { Answer, Call, Routes } from "./pages-support";

export const PLANS = {
  currency: "USD",
  plans: [
    { id: "team", title: "Team", priceMinor: 14_900, period: "month", includedUsageMicros: 20_000_000, workspaces: 1, tiers: ["fast", "balanced"] },
    { id: "business", title: "Business", priceMinor: 59_900, period: "month", includedUsageMicros: 100_000_000, workspaces: 3, summary: "For a team that runs several projects." },
  ],
  topups: { optionsMinor: [1_000, 2_500, 10_000], minimumMinor: 500, maximumMinor: 100_000, usageMicrosPerMinor: 10_000 },
  policy: { graceDays: 3, retentionDays: 30, sessionDays: 30, idleDays: 14, verificationHours: 24, resetHours: 2 },
};

export interface WorkspaceView {
  workspaceId: string;
  name: string;
  slug: string;
  plan: string;
  status: string;
  statusReason?: string;
  host: string;
  /** Present on a hosting-only plan's workspace: where its models come from. */
  models?: { source: "own"; key: null | { provider: string; model: string; baseUrl?: string; setAt: string } };
}
export type Subscription = null | { plan: string; title: string; status: string; periodEnd?: string; pastDueSince?: string };

export const workspace = (over: Partial<WorkspaceView> = {}): WorkspaceView => ({ workspaceId: "ws_1", name: "Research", slug: "research-1a2b3c", plan: "team", status: "running", host: "research-1a2b3c.ws.example.com", ...over });
export const ACTIVE: Subscription = { plan: "team", title: "Team", status: "active", periodEnd: "2026-11-05T12:00:00.000Z" };
export const balance = (over: Partial<{ included: number; purchased: number; available: number }> = {}) => {
  const b = { included: 20_000_000, purchased: 0, ...over };
  return { currency: "USD", balance: { included: b.included, purchased: b.purchased, total: b.included + b.purchased, available: over.available ?? b.included + b.purchased }, charged: 0 };
};
export const NO_USAGE = { currency: "USD", byDay: [], byWorkspace: [], total: { calls: 0, failed: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, chargedMicros: 0 } };
export const failure = (status: number, code: string, message: string): Answer => ({ status, json: { error: { code, message } } });

export class World {
  signedIn = true;
  email = "ada@example.com";
  subscription: Subscription = null;
  workspaces: WorkspaceView[] = [];
  balance: ReturnType<typeof balance> | null = balance();
  usage: unknown = NO_USAGE;
  plans: Answer = { json: PLANS };
  /** What the service says to a call, by "METHOD /path", in place of the usual. */
  readonly answers = new Map<string, Answer | ((call: Call) => Answer)>();

  view() {
    return { accountId: "acct_1", email: this.email, createdAt: "2026-10-01T00:00:00.000Z", subscription: this.subscription, workspaces: this.workspaces };
  }
  readonly routes: Routes = (call) => {
    const key = `${call.method} ${call.path}`;
    const said = this.answers.get(key);
    if (said) return typeof said === "function" ? said(call) : said;
    switch (key) {
      case "GET /api/session":
        return { json: { account: this.signedIn ? this.view() : null } };
      case "GET /api/me":
        return this.signedIn ? { json: { account: this.view(), balance: this.balance } } : failure(401, "not_signed_in", "Sign in to continue.");
      case "GET /api/plans":
        return this.plans;
      case "GET /api/usage":
        return { json: this.usage };
      default:
        return undefined;
    }
  };
}

export const world = (change: (w: World) => void = () => undefined): World => {
  const w = new World();
  change(w);
  return w;
};
export const paid = (w: World): void => {
  w.subscription = ACTIVE;
};


export const HOSTING_PLANS = { currency: "USD", plans: [{ id: "hosting", title: "Hosting", priceMinor: 4_900, period: "month", includedUsageMicros: 0, workspaces: 1, byok: true, summary: "One workspace. Bring your own model key." }], topups: null, policy: PLANS.policy };
export const HOSTING_SUB: Subscription = { plan: "hosting", title: "Hosting", status: "active", periodEnd: "2026-11-05T12:00:00.000Z" };
export const SECRET = "sk-ant-api03-typed-into-the-page-0001";
export const NOW = "2026-10-05T12:00:00.000Z";
export const KEPT = { provider: "anthropic", model: "claude-sonnet-4-5", setAt: NOW };

/** A hosting-only service: no balance, no usage, no top-ups, and a workspace whose models are the customer's own key. */
export const hosting = (models: WorkspaceView["models"] = { source: "own", key: null }, over: Partial<WorkspaceView> = {}): World =>
  world((x) => {
    x.subscription = HOSTING_SUB;
    x.plans = { json: HOSTING_PLANS };
    x.balance = null;
    x.workspaces = [workspace({ workspaceId: "ws_1", name: "Research", plan: "hosting", models, ...over })];
  });

