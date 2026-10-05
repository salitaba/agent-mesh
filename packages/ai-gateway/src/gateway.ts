/**
 * The gateway: one call from a workspace, from its key to the provider and back, and what it cost.
 *
 * Order matters here, and each step is placed where a failure costs the least:
 *
 *   key, then limits (cheap, and they stop a flood before it is parsed), then the request, then the balance. The balance is
 *   checked and held BEFORE the provider is asked, from the worst the call could cost, and settled AFTER from the usage the
 *   provider reports, so one call cannot overdraw an account by more than its own cost.
 *
 *   The provider is asked down a chain of candidates. A candidate that fails before it has produced anything is passed over
 *   for the next; once an answer has begun to go to the caller there is no passing over, because the caller has already
 *   seen part of it.
 *
 *   The spend is written, and made durable, before the end of the stream is sent. A caller never gets the last frame of a
 *   call the ledger has not yet recorded.
 *
 * What the caller is told when a provider fails is the same for every provider and says nothing about which one it was or
 * what its account looks like. What the operator is told, in the log, is everything.
 */
import { ProviderError, ProviderTimeoutError, type JsonObject, type LlmProvider, type ModelEvent, type ModelResult, type ModelUsage } from "../../llm/src/index";
import { Ledger, type KeyRecord, type SpendOutcome } from "./ledger";
import { ConcurrencyLimiter, RateLimiter } from "./limits";
import { bearerToken, parseToken, secretMatches } from "./keys";
import { chargeMicros, formatMoney } from "./money";
import {
  DEFAULT_WIRE_LIMITS,
  WireError,
  chunk,
  completionBody,
  errorBody,
  finishReason,
  newRequestId,
  parseChatRequest,
  toolCallDelta,
  usageChunk,
  type ParsedChat,
  type WireLimits,
} from "./openai-wire";
import type { PriceTable } from "./prices";
import type { Candidate, Router } from "./routes";

export interface LogRecord {
  level: "info" | "warn" | "error";
  msg: string;
  [field: string]: unknown;
}

/** Where a call's answer goes. The HTTP server implements it over a response; a test implements it over an array. */
export interface ChatOutput {
  /** A refusal, before anything was written. */
  reject(status: number, body: JsonObject, headers?: Record<string, string>): void;
  /** Commit to a stream: the status and headers go out now. */
  open(headers: Record<string, string>): void;
  /** One event of the stream. May wait, when the reader is slower than the writer. */
  frame(data: JsonObject | "[DONE]"): void | Promise<void>;
  /** A line the reader ignores, to keep a quiet connection open. */
  comment(text: string): void;
  /** A whole answer, for a caller that did not ask for a stream. */
  json(status: number, body: JsonObject, headers?: Record<string, string>): void;
  /** End the stream. */
  close(): void;
  /** Fires when the caller goes away. */
  readonly aborted: AbortSignal;
}

export interface GatewayOptions {
  ledger: Ledger;
  prices: PriceTable;
  router: Router;
  /** The adapters, by the provider name the tiers use. */
  providers: ReadonlyMap<string, LlmProvider>;
  /** Calls a minute a key gets unless its own limits say otherwise. */
  defaultRpm?: number;
  /** Calls open at once a key gets unless its own limits say otherwise. */
  defaultConcurrent?: number;
  /** The most one call holds back from the balance before it runs, in micro-units. */
  reserveCapMicros?: number;
  /** How long to wait for a provider's first word before committing to a stream anyway, in ms. */
  commitMs?: number;
  /** How often a committed stream with nothing to say sends a comment, in ms. */
  keepAliveMs?: number;
  /** The longest one call may take, in ms. */
  deadlineMs?: number;
  /** Put the provider's name for the model in the answer. When false, the caller sees the tier it asked for. */
  exposeUpstreamModel?: boolean;
  wireLimits?: WireLimits;
  log?: (record: LogRecord) => void;
  clock?: () => number;
  rate?: RateLimiter;
  concurrency?: ConcurrencyLimiter;
  requestId?: () => string;
}

const invalidKey = (): WireError => new WireError(401, "invalid_api_key", "The API key is not valid.");

/** Roughly three characters to a token: errs towards more tokens than there are, which is the safe side for a hold. */
function estimateInput(request: ParsedChat["request"]): number {
  return Math.ceil(JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }).length / 3);
}

/** What a failed or abandoned call used, when nothing better is known: the prompt as estimated and the answer as far as it got. */
function estimatedUsage(input: number, outputChars: number): ModelUsage {
  return { input, output: Math.ceil(outputChars / 4), cacheRead: 0, cacheWrite: 0 };
}

/** A provider's words, without anything that looks like a credential, and short enough to log. */
function sanitize(text: string): string {
  return text.replace(/\b(?:sk|pk|rk|key|org|proj|sess)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
}

/** What a caller is told when a provider could not answer. The same words whichever provider it was. */
export function toWireError(err: unknown): WireError {
  if (err instanceof WireError) return err;
  if (err instanceof ProviderTimeoutError) return new WireError(504, "upstream_timeout", "The model did not answer in time. Try again.");
  if (err instanceof ProviderError) {
    switch (err.kind) {
      case "context_overflow":
        return new WireError(400, "context_length_exceeded", "context length exceeded: the prompt is too long for this model. Shorten the conversation.");
      case "invalid_request":
        return new WireError(400, "invalid_request_error", `The model rejected the request: ${sanitize(err.detail)}`);
      case "rate_limited": {
        const seconds = Math.max(1, Math.ceil((err.retryAfterMs ?? 5_000) / 1000));
        return new WireError(429, "rate_limit_exceeded", "The model is busy and is limiting requests. Retry shortly.", undefined, { "retry-after": String(seconds) });
      }
      default:
        // Our credentials or our account at the provider, or the provider being down: not the caller's to know or fix.
        return new WireError(503, "service_unavailable", "The model service is unavailable at the moment. Try again shortly.");
    }
  }
  return new WireError(502, "bad_gateway", "The model service returned something the gateway could not use.");
}

export class Gateway {
  private readonly held = new Map<string, number>();
  readonly rate: RateLimiter;
  readonly concurrency: ConcurrencyLimiter;
  readonly wireLimits: WireLimits;

  constructor(readonly options: GatewayOptions) {
    this.rate = options.rate ?? new RateLimiter();
    this.concurrency = options.concurrency ?? new ConcurrencyLimiter();
    this.wireLimits = options.wireLimits ?? DEFAULT_WIRE_LIMITS;
  }

  clock(): number {
    return (this.options.clock ?? Date.now)();
  }

  log(level: LogRecord["level"], msg: string, fields: Record<string, unknown> = {}): void {
    this.options.log?.({ level, msg, ...fields });
  }

  /** What an account has set aside for calls in flight. */
  heldFor(accountId: string): number {
    return this.held.get(accountId) ?? 0;
  }

  hold(accountId: string, micros: number): void {
    this.held.set(accountId, this.heldFor(accountId) + micros);
  }

  release(accountId: string, micros: number): void {
    const left = this.heldFor(accountId) - micros;
    if (left <= 0) this.held.delete(accountId);
    else this.held.set(accountId, left);
  }

  /** The key a request carries. Every way of being wrong gets the same answer, so a refusal says nothing about which keys exist. */
  authenticate(header: string | string[] | undefined): KeyRecord {
    const token = bearerToken(header);
    if (token === undefined) throw new WireError(401, "missing_api_key", "Send the API key as 'Authorization: Bearer <key>'.");
    const parsed = parseToken(token);
    const key = parsed ? this.options.ledger.state.keys.get(parsed.keyId) : undefined;
    if (!parsed || !key || !secretMatches(parsed.secret, key.secretHash)) throw invalidKey();
    if (key.revokedAt !== undefined) {
      this.log("info", "a revoked key was used", { keyId: key.keyId, accountId: key.accountId });
      throw invalidKey();
    }
    return key;
  }

  /** The tiers a key may name. */
  models(key: KeyRecord): string[] {
    return this.options.router.names(key.models);
  }

  /** One chat completion, from a key that has authenticated. Everything the caller is to see goes through `out`. */
  async chat(key: KeyRecord, body: unknown, out: ChatOutput): Promise<void> {
    await new Call(this, key, body, out).run();
  }
}

/** One call. Held apart from the gateway so that each has its own state: what it holds back, whether it has begun to answer. */
class Call {
  private readonly requestId: string;
  private readonly started: number;
  private readonly ctx: Record<string, unknown>;
  private held = 0;
  private committed = false;
  private responded = false;
  private timedOut = false;
  private keepAlive: NodeJS.Timeout | undefined;
  private readonly upstream = new AbortController();

  constructor(
    private readonly gw: Gateway,
    private readonly key: KeyRecord,
    private readonly body: unknown,
    private readonly out: ChatOutput,
  ) {
    this.requestId = gw.options.requestId?.() ?? newRequestId();
    this.started = gw.clock();
    this.ctx = { requestId: this.requestId, keyId: key.keyId, accountId: key.accountId, ...(key.workspaceId !== undefined ? { workspaceId: key.workspaceId } : {}) };
  }

  private get headers(): Record<string, string> {
    return { "x-request-id": this.requestId };
  }

  /**
   * End the call with an error: a status if nothing has been sent, a frame in the stream if it was already opened. At most
   * once, and never after the call has been answered.
   */
  private async fail(e: WireError): Promise<void> {
    if (this.responded) return;
    this.responded = true;
    this.gw.log(e.status >= 500 ? "error" : "info", this.committed ? "call failed after the stream was opened" : "call refused", { ...this.ctx, status: e.status, type: e.type });
    if (!this.committed) {
      this.out.reject(e.status, errorBody(e), { ...this.headers, ...e.headers });
      return;
    }
    await this.out.frame(errorBody(e, true));
    await this.out.frame("[DONE]");
    this.out.close();
  }

  async run(): Promise<void> {
    const gw = this.gw;
    const { key, out } = this;
    const options = gw.options;

    if (!options.ledger.writable) {
      return this.fail(new WireError(503, "service_unavailable", "The service cannot record usage at the moment and is not taking calls. Try again shortly."));
    }
    const rpm = key.limits.rpm ?? options.defaultRpm ?? 120;
    const take = gw.rate.take(key.keyId, rpm);
    if (!take.ok) {
      const seconds = Math.max(1, Math.ceil(take.retryAfterMs / 1000));
      return this.fail(new WireError(429, "rate_limit_exceeded", `This key is limited to ${rpm} calls a minute. Retry in ${seconds}s.`, undefined, { "retry-after": String(seconds) }));
    }
    const slotLimit = key.limits.concurrent ?? options.defaultConcurrent ?? 16;
    const slot = gw.concurrency.acquire(key.keyId, slotLimit);
    if (!slot) return this.fail(new WireError(429, "too_many_requests", `This key already has ${slotLimit} calls in flight, which is its limit.`, undefined, { "retry-after": "1" }));

    const clientGone = (): void => this.upstream.abort();
    out.aborted.addEventListener("abort", clientGone, { once: true });
    if (out.aborted.aborted) clientGone();
    const deadline = setTimeout(() => {
      this.timedOut = true;
      this.upstream.abort();
    }, options.deadlineMs ?? 600_000);
    try {
      await this.serve();
    } catch (err) {
      gw.log("error", "unexpected failure", { ...this.ctx, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack : undefined });
      // Whatever was not planned for: the caller is told that something went wrong, and nothing about what.
      await this.fail(new WireError(500, "internal_error", "The gateway failed to handle this call. It has been logged."));
    } finally {
      clearTimeout(deadline);
      if (this.keepAlive) clearInterval(this.keepAlive);
      out.aborted.removeEventListener("abort", clientGone);
      slot();
      this.releaseHold();
    }
  }

  /** Give back what the call held. Idempotent: it is done as soon as the spend is recorded, and again when the call ends. */
  private releaseHold(): void {
    if (this.held <= 0) return;
    this.gw.release(this.key.accountId, this.held);
    this.held = 0;
  }

  private async serve(): Promise<void> {
    const gw = this.gw;
    const { key, out } = this;
    const { options } = gw;

    // A caller that has already gone gets nothing, and nothing is asked of a provider on its behalf.
    if (out.aborted.aborted) return;

    let parsed: ParsedChat;
    try {
      parsed = parseChatRequest(this.body, gw.wireLimits);
    } catch (err) {
      if (err instanceof WireError) return this.fail(err);
      throw err;
    }
    const chain = options.router.resolve(parsed.model, key.models);
    if (!chain) {
      return this.fail(new WireError(404, "model_not_found", `The model '${parsed.model}' is not available to this key. Available: ${gw.models(key).join(", ") || "none"}.`, "model"));
    }

    const cap = key.limits.dailyCapMicros;
    if (cap !== undefined) {
      const today = new Date(gw.clock()).toISOString().slice(0, 10);
      const spent = options.ledger.state.daily.get(key.keyId);
      if (spent && spent.day === today && spent.charged >= cap) {
        const midnight = Date.parse(`${today}T00:00:00.000Z`) + 86_400_000;
        const seconds = Math.max(1, Math.ceil((midnight - gw.clock()) / 1000));
        return this.fail(new WireError(429, "daily_limit_reached", `This key has reached its limit of ${formatMoney(cap, options.ledger.currency)} for today (UTC). It resets at midnight UTC.`, undefined, { "retry-after": String(seconds) }));
      }
    }

    // The balance: what the call could cost at worst, held back until it settles.
    const inputEstimate = estimateInput(parsed.request);
    const answerCap = (c: Candidate): number => Math.min(parsed.maxOutputTokens ?? c.maxOutputTokens, c.maxOutputTokens);
    const worst = Math.max(
      ...chain.map((c) => {
        const p = options.prices.get(c.id)!;
        return chargeMicros({ input: inputEstimate, output: answerCap(c), cacheRead: 0, cacheWrite: 0 }, p.rates, p.markupBps);
      }),
    );
    const hold = Math.min(worst, options.reserveCapMicros ?? 2_000_000);
    const balance = options.ledger.balance(key.accountId);
    const available = balance.included + balance.purchased - gw.heldFor(key.accountId);
    if (available < hold) {
      const currency = options.ledger.currency;
      return this.fail(
        new WireError(402, "insufficient_credits", `The balance is too low for this call: it may cost up to ${formatMoney(hold, currency)} and ${formatMoney(Math.max(0, available), currency)} is available. Add credit to continue.`),
      );
    }
    gw.hold(key.accountId, hold);
    this.held = hold;

    // Ask the providers down the chain until one of them starts to answer.
    let served: Candidate | undefined;
    let iterator: AsyncIterator<ModelEvent> | undefined;
    let first: IteratorResult<ModelEvent> | undefined;
    let firstError: unknown;
    for (const [i, candidate] of chain.entries()) {
      const provider = options.providers.get(candidate.provider)!;
      const iter = provider.stream({ ...parsed.request, model: candidate.model, maxOutputTokens: answerCap(candidate), signal: this.upstream.signal })[Symbol.asyncIterator]();
      const commitTimer = parsed.stream ? setTimeout(() => this.commit(), options.commitMs ?? 10_000) : undefined;
      try {
        first = await iter.next();
        clearTimeout(commitTimer);
        served = candidate;
        iterator = iter;
        break;
      } catch (err) {
        clearTimeout(commitTimer);
        await iter.return?.(undefined).catch(() => undefined);
        if (out.aborted.aborted) return void (await this.settle(candidate, "aborted", estimatedUsage(inputEstimate, 0), undefined, true));
        if (this.timedOut) return this.fail(toWireError(new ProviderTimeoutError(candidate.provider, "waiting for the model", options.deadlineMs ?? 600_000)));
        firstError ??= err;
        this.logUpstream(candidate, err, i < chain.length - 1);
      }
    }
    if (!served || !iterator || !first) return this.fail(toWireError(firstError));

    await this.relay(parsed, served, iterator, first, inputEstimate);
  }

  private logUpstream(candidate: Candidate, err: unknown, willTryNext: boolean): void {
    const fields: Record<string, unknown> = { ...this.ctx, provider: candidate.provider, model: candidate.model, tryingNext: willTryNext };
    let level: LogRecord["level"] = "warn";
    if (err instanceof ProviderError) {
      fields.kind = err.kind;
      fields.status = err.status;
      fields.detail = sanitize(err.detail);
      // Our key or our account at the provider: every caller on this route is affected, and someone must act.
      if (err.kind === "auth" || err.kind === "billing") {
        level = "error";
        fields.alert = "the gateway's credentials or account at the provider were refused";
      }
    } else {
      fields.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    this.gw.log(level, "a provider could not answer", fields);
  }

  /** Commit to a stream: from here on a failure is a frame in the stream and not a status. */
  private commit(): void {
    if (this.committed) return;
    this.committed = true;
    this.out.open(this.headers);
    const every = this.gw.options.keepAliveMs ?? 15_000;
    this.keepAlive = setInterval(() => this.out.comment("keep-alive"), every);
  }

  private async relay(parsed: ParsedChat, served: Candidate, iterator: AsyncIterator<ModelEvent>, first: IteratorResult<ModelEvent>, inputEstimate: number): Promise<void> {
    const { out } = this;
    const gw = this.gw;
    const id = `chatcmpl-${this.requestId.replace(/^req_/, "")}`;
    const created = Math.floor(gw.clock() / 1000);
    const shown = (reported: string): string => (gw.options.exposeUpstreamModel === false ? parsed.model : reported);
    let model = shown(served.model);
    let outputChars = 0;
    let toolIndex = 0;
    let result: ModelResult | undefined;
    let failure: unknown;

    try {
      if (parsed.stream) {
        this.commit();
        await out.frame(chunk(id, created, model, { role: "assistant", content: "" }));
      }
      let step = first;
      while (!step.done) {
        const ev = step.value;
        if (ev.kind === "text") {
          outputChars += ev.delta.length;
          if (parsed.stream) await out.frame(chunk(id, created, model, { content: ev.delta }));
        } else if (ev.kind === "reasoning") {
          outputChars += ev.delta.length;
          if (parsed.stream) await out.frame(chunk(id, created, model, { reasoning_content: ev.delta }));
        } else if (ev.kind === "tool_call") {
          outputChars += ev.call.name.length + JSON.stringify(ev.call.args).length;
          if (parsed.stream) await out.frame(chunk(id, created, model, { tool_calls: [toolCallDelta(ev.call, toolIndex)] }));
          toolIndex++;
        } else {
          result = ev.result;
          model = shown(ev.result.model);
        }
        step = await iterator.next();
      }
    } catch (err) {
      failure = err;
    } finally {
      await iterator.return?.(undefined).catch(() => undefined);
    }

    if (failure !== undefined || !result) {
      if (out.aborted.aborted) return void (await this.settle(served, "aborted", estimatedUsage(inputEstimate, outputChars), undefined, true));
      const error = this.timedOut
        ? toWireError(new ProviderTimeoutError(served.provider, "waiting for the model", gw.options.deadlineMs ?? 600_000))
        : toWireError(failure ?? new ProviderError(served.provider, { kind: "unreachable", detail: "the response ended before the model finished" }));
      this.logUpstream(served, failure, false);
      // The customer is not charged for a call the provider failed; what it cost the service is still recorded.
      await this.settle(served, "failed", estimatedUsage(inputEstimate, outputChars), undefined, true);
      return this.fail(error);
    }

    const recorded = await this.settle(served, "ok", result.usage, result.model, result.usage.estimated === true);
    if (!recorded && !parsed.stream) {
      return this.fail(new WireError(503, "service_unavailable", "The service cannot record usage at the moment and is not taking calls. Try again shortly."));
    }
    this.responded = true;
    if (parsed.stream) {
      await out.frame(chunk(id, created, model, {}, finishReason(result.stopReason)));
      await out.frame(usageChunk(id, created, model, result.usage));
      await out.frame("[DONE]");
      out.close();
    } else {
      out.json(200, completionBody(id, created, model, result), this.headers);
    }
  }

  /**
   * Write what the call cost. Each path through a call settles it exactly once: the answer, the caller going away and the
   * provider failing are mutually exclusive. Returns whether the ledger took it: when it did not, the call has been served and cannot
   * be unserved, so the spend is logged in full for the operator to reconcile and the gateway stops taking calls.
   */
  private async settle(candidate: Candidate, outcome: SpendOutcome, usage: ModelUsage, reported: string | undefined, estimated: boolean): Promise<boolean> {
    const gw = this.gw;
    const priced = gw.options.prices.price(candidate.id, usage);
    const spend = {
      requestId: this.requestId,
      accountId: this.key.accountId,
      keyId: this.key.keyId,
      ...(this.key.workspaceId !== undefined ? { workspaceId: this.key.workspaceId } : {}),
      alias: this.requestedName(),
      provider: candidate.provider,
      model: candidate.model,
      ...(reported !== undefined && reported !== candidate.model ? { modelReported: reported } : {}),
      priceVersion: gw.options.prices.version,
      usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}) },
      costMicros: priced.costMicros,
      chargeMicros: outcome === "failed" ? 0 : priced.chargeMicros,
      outcome,
      estimated,
      latencyMs: Math.max(0, gw.clock() - this.started),
    };
    try {
      await gw.options.ledger.recordSpend(spend);
      // The spend now counts against the balance, so the hold for the same call must not count as well.
      this.releaseHold();
      gw.log("info", "call settled", { ...this.ctx, provider: candidate.provider, model: candidate.model, outcome, chargeMicros: spend.chargeMicros, costMicros: spend.costMicros, latencyMs: spend.latencyMs });
      return true;
    } catch (err) {
      gw.log("error", "a spend could not be recorded", { ...this.ctx, spend, error: err instanceof Error ? err.message : String(err), alert: "reconcile this call from the log" });
      return false;
    }
  }

  private requestedName(): string {
    const body = this.body as { model?: unknown } | null;
    return typeof body?.model === "string" ? body.model.trim() : "";
  }
}
