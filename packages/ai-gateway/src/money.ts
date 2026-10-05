/**
 * Money, as whole micro-units.
 *
 * A balance is an integer count of millionths of the ledger's currency, never a float: a float sum of ten thousand small
 * calls drifts, and a ledger that drifts cannot be audited. Prices are written the way providers publish them (currency
 * units per million tokens) and kept as integer micro-units per million tokens, so the cost of a call is one exact integer
 * product that is rounded up once, to the next micro-unit, never per term.
 */
import type { ModelUsage } from "../../llm/src/index";

/** An integer count of millionths of the ledger's currency. */
export type Micros = number;

/** Micro-units of currency per million tokens, one rate per kind of token a provider bills. */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const MILLION = 1_000_000n;
const BPS = 10_000n;

/** Round-up integer division of non-negative integers. */
function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

const count = (n: number | undefined): bigint => (typeof n === "number" && Number.isFinite(n) && n > 0 ? BigInt(Math.floor(n)) : 0n);

/** Tokens times rate, summed over the four kinds. Divide by a million for micro-units. */
function numerator(usage: ModelUsage, rates: Rates): bigint {
  return count(usage.input) * BigInt(rates.input) + count(usage.output) * BigInt(rates.output) + count(usage.cacheRead) * BigInt(rates.cacheRead) + count(usage.cacheWrite) * BigInt(rates.cacheWrite);
}

function toNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${what} does not fit in a safe integer`);
  return Number(value);
}

/** What the provider charges the service for these tokens. */
export function costMicros(usage: ModelUsage, rates: Rates): Micros {
  return toNumber(ceilDiv(numerator(usage, rates), MILLION), "cost");
}

/** What the customer's balance is debited: the cost times the markup, rounded up once. */
export function chargeMicros(usage: ModelUsage, rates: Rates, markupBps: number): Micros {
  return toNumber(ceilDiv(numerator(usage, rates) * BigInt(markupBps), MILLION * BPS), "charge");
}

/**
 * A price written in currency units per million tokens (`0.15`, `"3"`), as micro-units per million tokens.
 * At most six decimal places, because anything finer is not a price anyone published and is more likely a typo.
 */
export function parseRate(value: unknown, what: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(\.\d{1,6})?$/.test(text)) {
    throw new Error(`${what} must be a number of currency units per million tokens with at most six decimals (got ${JSON.stringify(value)})`);
  }
  const [whole, fraction = ""] = text.split(".");
  return toNumber(BigInt(whole) * MILLION + BigInt(fraction.padEnd(6, "0")), what);
}

/** A markup factor (`1.25`) as basis points (12500). At most four decimals. */
export function parseMarkup(value: unknown, what: string): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(\.\d{1,4})?$/.test(text)) throw new Error(`${what} must be a factor such as 1.25 with at most four decimals (got ${JSON.stringify(value)})`);
  const [whole, fraction = ""] = text.split(".");
  return toNumber(BigInt(whole) * BPS + BigInt(fraction.padEnd(4, "0")), what);
}

/**
 * An amount for people: `USD 0.12`. Two decimals, except that an amount under one cent keeps two significant digits, so
 * 4,200 micro-units reads `USD 0.0042` and not `USD 0.00`.
 */
export function formatMoney(micros: Micros, currency: string): string {
  const abs = Math.abs(Math.trunc(micros));
  const whole = Math.floor(abs / 1_000_000);
  const fraction = String(abs % 1_000_000).padStart(6, "0");
  let digits = 2;
  if (whole === 0 && abs > 0 && abs < 10_000) digits = Math.min(6, fraction.search(/[1-9]/) + 2);
  return `${currency} ${micros < 0 ? "-" : ""}${whole}.${fraction.slice(0, digits)}`;
}
