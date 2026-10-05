/**
 * A host that is told where its models are, instead of being given a key for a model vendor.
 *
 * On the hosted service every workspace's host starts with three settings: `CURULE_GATEWAY_URL`, the address of the service's
 * model gateway (up to and including `/v1`); `CURULE_GATEWAY_KEY`, a virtual key that works at that gateway and nowhere else;
 * and optionally `CURULE_GATEWAY_MODEL`, the tier a team uses unless a seat says otherwise. A host with both the address and the
 * key is a managed one. A project made on it runs on the native runtime through one provider, `curule`, so the person who
 * opens the workspace brings no key and sets nothing.
 *
 * The key is never written into mesh.yaml. The file names the variable it is read from, as every provider's does, and the host
 * reads it when it starts a project. The address is written, because it is not a secret and a mesh.yaml should say where its
 * models are.
 */
import { isMap, parseDocument } from "yaml";

export const GATEWAY_URL_ENV = "CURULE_GATEWAY_URL";
export const GATEWAY_KEY_ENV = "CURULE_GATEWAY_KEY";
export const GATEWAY_MODEL_ENV = "CURULE_GATEWAY_MODEL";

/** The name the gateway goes by in a mesh's providers, and so the first half of the model every seat uses: `curule/balanced`. */
export const MANAGED_PROVIDER = "curule";
export const DEFAULT_TIER = "balanced";

export interface ManagedModels {
  /** The gateway, up to and including its version segment. */
  baseUrl: string;
  /** The variable the key is read from. The value is not here. */
  keyEnv: string;
  /** The tier a seat uses when it names no model. */
  tier: string;
}

/** The managed models this host was given, or undefined when it holds both the address and the key of none. */
export function managedModels(env: NodeJS.ProcessEnv = process.env): ManagedModels | undefined {
  const url = (env[GATEWAY_URL_ENV] ?? "").trim();
  const key = (env[GATEWAY_KEY_ENV] ?? "").trim();
  if (url === "" || key === "") return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const tier = (env[GATEWAY_MODEL_ENV] ?? "").trim();
  return { baseUrl: url.replace(/\/+$/, ""), keyEnv: GATEWAY_KEY_ENV, tier: /^[A-Za-z0-9._-]{1,64}$/.test(tier) ? tier : DEFAULT_TIER };
}

/**
 * A mesh.yaml whose seats are on the Claude runtime, written to run on the managed models instead: the default runtime and each
 * seat that names Claude go to `native`, a Claude model hint a seat carried is dropped (it cannot be placed on another
 * provider), and the gateway is named as the one provider. Comments and everything else are kept. A mesh that has no seat on
 * the Claude runtime (the shipped demo is on the stub runtime) is returned as it was, because it needs no models.
 */
export function rewriteForManagedModels(text: string, managed: ManagedModels): { text: string; changed: boolean } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { text, changed: false };
  const defaultRuntime = doc.getIn(["mesh", "runtime", "default"]);
  const inherits = defaultRuntime === undefined || defaultRuntime === "claude";
  let claude = false;
  const agents = doc.get("agents");
  if (isMap(agents)) {
    for (const pair of agents.items) {
      const agent = pair.value;
      if (!isMap(agent)) continue;
      const runtime = agent.get("runtime");
      if (runtime === "claude" || (runtime === undefined && inherits)) {
        claude = true;
        if (runtime === "claude") agent.set("runtime", "native");
        agent.delete("model");
      }
    }
  }
  if (!claude) return { text, changed: false };
  if (inherits) doc.setIn(["mesh", "runtime", "default"], "native");
  doc.setIn(["mesh", "runtime", "model"], `${MANAGED_PROVIDER}/${managed.tier}`);
  doc.setIn(["mesh", "runtime", "designer"], "native");
  doc.setIn(["mesh", "runtime", "providers"], doc.createNode({ [MANAGED_PROVIDER]: { kind: "openai-compatible", base_url: managed.baseUrl, api_key_env: managed.keyEnv } }));
  return { text: String(doc), changed: true };
}
