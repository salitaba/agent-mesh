/**
 * Ask a provider whether the model a customer named is one it actually serves, before a workspace is remade around it.
 *
 * `checkModelKeyInput` can only judge the *shape* of a model id, and shape is not existence: `deepseek-4.1-flash`
 * looks exactly as reasonable as `deepseek-v4.1-flash`, and a workspace built on the first one gets a 400 on every
 * turn — seats that never run, a progress bar that never moves, and nothing in the customer's view that says why.
 * So while the key is in hand, and only then, the provider's own catalogue is read and the name is checked against
 * it. A name that is missing is refused with the closest ones beside it, which is the entire repair for the operator.
 *
 * This never blocks a save on a provider that cannot answer. Only a catalogue that arrived and does not list the
 * model is a refusal. A timeout, a 5xx, an endpoint that does not implement `/models`, a body this cannot read — all
 * let the key through: turning "your provider is unusual" into "your key is wrong" would lock a customer out of a
 * workspace that works, which is worse than the mistake this exists to catch.
 */
import type { ModelKeyInput } from "./model-keys";

/** How a provider lists its models it is asked for them. */
export interface CatalogueReadOptions {
  /** For tests, and so an operator can point this at their own provider's probe. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Where a provider's model list lives, and how it is authenticated. The key is used here and nowhere else in this
 * file: nothing that comes back is echoed, and no address but the provider's own is ever called.
 */
function catalogueRequest(input: ModelKeyInput): { url: string; headers: Record<string, string> } {
  if (input.provider === "anthropic") {
    // Anthropic keeps its own address (checkModelKeyInput refuses a baseUrl for it), and its model list is at /v1/models.
    return { url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "x-api-key": input.key, "anthropic-version": "2023-06-01" } };
  }
  const base = (input.baseUrl ?? "").replace(/\/+$/, "");
  return { url: `${base}/models`, headers: { authorization: `Bearer ${input.key}` } };
}

/**
 * Whether a string out of a body could be a model id. A body that is not a catalogue — a plain-text error page, a
 * "forbidden" string — puts text in here, and taking that for a model list would let it refuse a key that works.
 */
function looksLikeModelId(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 && /^[A-Za-z0-9._:@+[\]/-]+$/.test(trimmed);
}

/** Every model id in a body, whatever shape the provider chose. An unreadable body yields nothing, not an error. */
export function modelIdsIn(body: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (depth > 4) return;
    if (typeof node === "string") {
      // The top level has to be a container: a body that is one bare string is a message, not a catalogue.
      if (depth > 0 && looksLikeModelId(node)) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        // `data` and `models` are the containers the OpenAI-compatible and Gemini-shaped answers use; `id` and `name`
        // are the leaves. Anything else (pagination, owner, created) is skipped rather than mined for strings.
        if (k === "id" || k === "name" || k === "model") {
          if (typeof v === "string" && looksLikeModelId(v)) out.push(v);
        } else if (k === "data" || k === "models" || k === "items") {
          visit(v, depth + 1);
        }
      }
    }
  };
  visit(body, 0);
  return [...new Set(out.map((s) => s.trim()).filter((s) => s !== ""))];
}

/** The bare name of a model id: what follows the last `/`, so `opencode-go/deepseek-v4.1-flash` and `deepseek-v4.1-flash` are compared as the same model. */
function bareName(id: string): string {
  const trimmed = id.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash === -1 ? trimmed : trimmed.slice(slash + 1);
}

/** Plain Levenshtein distance, capped: only used to order a short suggestion list by how close it is. */
function distance(a: string, b: string): number {
  const s = a.toLowerCase();
  const t = b.toLowerCase();
  const prev = new Array<number>(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    let diagonal = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const above = prev[j]!;
      prev[j] = Math.min(above + 1, prev[j - 1]! + 1, diagonal + (s[i - 1] === t[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return prev[t.length]!;
}

/**
 * The refusal a customer should see for a model the provider does not serve, or null when the name is there (or the
 * provider cannot be asked). The closest ids are listed when they are close enough to be recognisable, because the
 * usual cause is a typo and the usual fix is seeing the right spelling.
 */
export function nameNotFoundMessage(model: string, ids: string[]): string {
  const wanted = bareName(model);
  const scored = ids
    .map((id) => ({ id, score: distance(wanted, bareName(id)) }))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  const close = scored.filter((s) => s.score <= Math.max(2, Math.floor(wanted.length / 3))).slice(0, 3).map((s) => s.id);
  const count = `that address lists ${ids.length} model${ids.length === 1 ? "" : "s"}`;
  if (close.length === 0) {
    return `No model named '${model}' there: ${count}, and none is close to that name. Copy the id from your provider's model list.`;
  }
  const suggestion = close.length === 1 ? `the closest is '${close[0]}'` : `the closest are ${close.map((c) => `'${c}'`).join(", ")}`;
  return `No model named '${model}' there: ${count}, and ${suggestion}. Use the id the provider names, exactly.`;
}

/**
 * Check a model id against the provider's live catalogue. Returns a message to refuse the save with, or null to let
 * it through. Never throws: a provider that cannot be reached is not the customer's mistake.
 */
export async function checkModelAgainstCatalogue(input: ModelKeyInput, options: CatalogueReadOptions = {}): Promise<string | null> {
  const doFetch = options.fetchImpl ?? fetch;
  const { url, headers } = catalogueRequest(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const res = await doFetch(url, { headers, signal: controller.signal });
    if (!res.ok) return null; // 401/403/404/5xx: this cannot tell "wrong model" from "wrong request", so it says nothing.
    const ids = modelIdsIn(await res.json().catch(() => null));
    if (ids.length === 0) return null; // an answer with no list in it is not evidence about the customer's id.
    const wanted = bareName(input.model);
    if (ids.some((id) => bareName(id) === wanted)) return null;
    return nameNotFoundMessage(input.model, ids);
  } catch {
    return null; // offline, DNS, TLS, a body that is not JSON, a provider that never answers: all let the key through.
  } finally {
    clearTimeout(timeout);
  }
}
