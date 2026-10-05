import * as net from "node:net";
import type { JsonObject, LlmProvider, ModelEvent, ModelRequest, ModelResult, ModelUsage, ToolCall } from "../../packages/llm/src/index";
import {
  Gateway,
  Ledger,
  MemoryLedgerStore,
  PriceTable,
  Router,
  parsePriceTable,
  type ChatOutput,
  type GatewayOptions,
  type KeyRecord,
  type LogRecord,
} from "../../packages/ai-gateway/src/index";

/**
 * A promise that rejects as an aborted fetch does: when the signal fires, and at once if it already has. A provider that never
 * answers is a provider that stops when it is told to; waiting on an event that has already happened would wait for ever.
 */
export function untilAborted(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const abort = (): void => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export const zeroUsage: ModelUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Two providers and three models, priced so that arithmetic in a test can be done by hand. */
export const PRICES = {
  currency: "USD",
  version: "test-1",
  default_markup: 1.5,
  models: {
    // 1 unit per million tokens in, 4 out, cache reads 0.1, cache writes 1.25.
    "alpha/small": { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 },
    "alpha/large": { input: 10, output: 40, cache_read: 1, cache_write: 12.5, markup: 2 },
    "beta/other": { input: 2, output: 8, cache_read: 0.2, cache_write: 0 },
  },
};

export const priceTable = (): PriceTable => parsePriceTable(PRICES);

export function result(over: Partial<ModelResult> = {}): ModelResult {
  return { text: "", toolCalls: [], stopReason: "end_turn", usage: { ...zeroUsage, input: 100, output: 20 }, model: "small-snapshot", ...over };
}

export type Script = (request: ModelRequest, call: number) => AsyncGenerator<ModelEvent, void> | Promise<AsyncGenerator<ModelEvent, void>>;

/** A provider that does what the test says. `requests` is every request it was asked to make. */
export class ScriptedProvider implements LlmProvider {
  readonly kind = "openai-compatible";
  readonly requests: ModelRequest[] = [];
  constructor(
    readonly endpoint: string,
    private readonly script: Script,
  ) {}
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent, void> {
    const n = this.requests.push(request) - 1;
    yield* await this.script(request, n);
  }
}

/** The events of a normal answer: some text, calls to tools, and the end. */
export function answer(text: string, opts: { calls?: ToolCall[]; usage?: Partial<ModelUsage>; model?: string; stop?: ModelResult["stopReason"]; reasoning?: string } = {}): Script {
  return async function* () {
    if (opts.reasoning) yield { kind: "reasoning", delta: opts.reasoning };
    for (const word of text.split(/(?<=\s)/).filter((w) => w !== "")) yield { kind: "text", delta: word };
    for (const call of opts.calls ?? []) yield { kind: "tool_call", call };
    yield {
      kind: "end",
      result: result({
        text,
        toolCalls: opts.calls ?? [],
        stopReason: opts.stop ?? ((opts.calls?.length ?? 0) > 0 ? "tool_use" : "end_turn"),
        usage: { ...zeroUsage, input: 100, output: 20, ...opts.usage },
        model: opts.model ?? "small-snapshot",
      }),
    };
  };
}

/** What a caller of the gateway sees, recorded. */
export class FakeOut implements ChatOutput {
  readonly events: Array<{ kind: "reject"; status: number; body: any; headers: Record<string, string> } | { kind: "open"; headers: Record<string, string> } | { kind: "frame"; data: any } | { kind: "comment"; text: string } | { kind: "json"; status: number; body: any; headers: Record<string, string> } | { kind: "close" }> = [];
  private readonly controller = new AbortController();
  readonly aborted: AbortSignal = this.controller.signal;

  /** The caller goes away. */
  hangUp(): void {
    this.controller.abort();
  }
  reject(status: number, body: JsonObject, headers: Record<string, string> = {}): void {
    this.events.push({ kind: "reject", status, body, headers });
  }
  open(headers: Record<string, string>): void {
    this.events.push({ kind: "open", headers });
  }
  frame(data: JsonObject | "[DONE]"): void {
    if (this.aborted.aborted) return;
    this.events.push({ kind: "frame", data });
  }
  comment(text: string): void {
    this.events.push({ kind: "comment", text });
  }
  json(status: number, body: JsonObject, headers: Record<string, string> = {}): void {
    this.events.push({ kind: "json", status, body, headers });
  }
  close(): void {
    this.events.push({ kind: "close" });
  }

  get frames(): any[] {
    return this.events.flatMap((e) => (e.kind === "frame" ? [e.data] : []));
  }
  /** The text the caller was streamed. */
  get text(): string {
    return this.frames.map((f) => (typeof f === "object" ? (f.choices?.[0]?.delta?.content ?? "") : "")).join("");
  }
  get rejection(): { status: number; body: any; headers: Record<string, string> } | undefined {
    const e = this.events.find((x) => x.kind === "reject");
    return e && e.kind === "reject" ? e : undefined;
  }
  get completion(): { status: number; body: any; headers: Record<string, string> } | undefined {
    const e = this.events.find((x) => x.kind === "json");
    return e && e.kind === "json" ? e : undefined;
  }
  get kinds(): string[] {
    return this.events.map((e) => e.kind);
  }
}

export interface Rig {
  gateway: Gateway;
  ledger: Ledger;
  store: MemoryLedgerStore;
  prices: PriceTable;
  alpha: ScriptedProvider;
  beta: ScriptedProvider;
  logs: LogRecord[];
  key: KeyRecord;
  token: string;
  clock: { now: number; set(iso: string): void };
  /** A call from `key`, answered into a fresh output. */
  call(body: unknown, key?: KeyRecord): Promise<FakeOut>;
  /** Add an account with a key and credit. */
  account(accountId: string, credit?: number, keyOptions?: Parameters<Ledger["createKey"]>[0] extends infer T ? Partial<T> : never): Promise<{ key: KeyRecord; token: string }>;
}

export interface RigOptions {
  alpha?: Script;
  beta?: Script;
  /** In micro-units. Default is plenty. */
  credit?: number;
  tiers?: Array<{ name: string; models: string[]; max?: number }>;
  gateway?: Partial<GatewayOptions>;
  keyOptions?: Partial<Parameters<Ledger["createKey"]>[0]>;
  start?: string;
}

export const chatBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: "balanced",
  stream: true,
  messages: [
    { role: "system", content: "You are a seat." },
    { role: "user", content: "Write hello.txt." },
  ],
  ...over,
});

export async function rig(options: RigOptions = {}): Promise<Rig> {
  const clock = { now: Date.parse(options.start ?? "2026-10-05T12:00:00.000Z"), set(iso: string) { this.now = Date.parse(iso); } };
  const store = new MemoryLedgerStore();
  const ledger = await Ledger.open(store, { currency: "USD", now: () => new Date(clock.now) });
  const prices = priceTable();
  const alpha = new ScriptedProvider("alpha.example", options.alpha ?? answer("Done."));
  const beta = new ScriptedProvider("beta.example", options.beta ?? answer("Done by beta.", { model: "other-snapshot" }));
  const tiers = (options.tiers ?? [
    { name: "fast", models: ["alpha/small"] },
    { name: "balanced", models: ["alpha/small", "beta/other"] },
    { name: "best", models: ["alpha/large"] },
  ]).map((t) => ({
    name: t.name,
    candidates: t.models.map((id) => ({ id, provider: id.split("/")[0]!, model: id.split("/").slice(1).join("/"), maxOutputTokens: t.max ?? 8192 })),
  }));
  const router = new Router(tiers, prices, ["alpha", "beta"]);
  const logs: LogRecord[] = [];
  const gateway = new Gateway({
    ledger,
    prices,
    router,
    providers: new Map([
      ["alpha", alpha],
      ["beta", beta],
    ]),
    commitMs: 5_000,
    keepAliveMs: 5_000,
    log: (r) => logs.push(r),
    clock: () => clock.now,
    ...options.gateway,
  });

  async function account(accountId: string, credit: number | undefined = options.credit ?? 100_000_000, keyOptions: Partial<Parameters<Ledger["createKey"]>[0]> = {}) {
    if (credit > 0) await ledger.grant({ id: `grant-${accountId}`, accountId, bucket: "purchased", amountMicros: credit, reason: "test" });
    const minted = await ledger.createKey({ accountId, workspaceId: `ws-${accountId}`, ...keyOptions });
    return { key: ledger.state.keys.get(minted.keyId)!, token: minted.token };
  }
  const first = await account("acme", options.credit, options.keyOptions);
  return {
    gateway,
    ledger,
    store,
    prices,
    alpha,
    beta,
    logs,
    key: first.key,
    token: first.token,
    clock: clock as Rig["clock"],
    async call(body, key = first.key) {
      const out = new FakeOut();
      await gateway.chat(key, body, out);
      return out;
    },
    account,
  };
}

export const spends = (store: MemoryLedgerStore) => store.entries.filter((e) => e.type === "spend") as Array<Extract<(typeof store.entries)[number], { type: "spend" }>>;

/**
 * A request written by hand to a socket whose body is not finished: the head says a hundred million bytes are coming and
 * `sent` is all that ever does. Resolves with what the server answered and whether it then closed the connection itself, which
 * is what a server must do with an upload it has refused.
 */
export function rawUpload(url: string, head: string[], sent: string): Promise<{ status: number; closedByServer: boolean }> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), hostname);
    let text = "";
    let status = 0;
    let settled = false;
    const finish = (closedByServer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, closedByServer });
    };
    const timer = setTimeout(() => (status === 0 ? (settled = true, socket.destroy(), reject(new Error("no answer"))) : finish(false)), 2_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${head.join("\r\n")}\r\nContent-Length: 100000000\r\n\r\n${sent}`));
    socket.on("data", (chunk: string) => {
      text += chunk;
      const m = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (m && status === 0) status = Number(m[1]);
    });
    socket.on("close", () => finish(true));
    socket.on("error", () => finish(true));
  });
}
