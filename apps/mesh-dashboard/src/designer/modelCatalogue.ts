/* Model catalogue: what this installation can actually reach, from GET /models.
 * Shared by the crew panel (per-agent model) and the mesh panel (mesh default). */

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

export interface ModelCatalogue {
  models: string[];
  /** The mesh-wide fallback used when an agent leaves `model` blank. */
  default?: string;
}

export type CatalogueState =
  | { phase: "loading" }
  | { phase: "ready"; catalogue: ModelCatalogue }
  | { phase: "error"; detail: string };

/**
 * The models this installation can actually reach, from GET /models.
 *
 * Deliberately NOT collapsed into `models: string[]` with `[]` on failure: an
 * empty dropdown reads as "no models exist" when the truth is "the console
 * never heard back", and the picker would silently discard a model already
 * written in mesh.yaml.
 */
export function useModelCatalogue(): { state: CatalogueState; reload: () => void } {
  const [state, setState] = useState<CatalogueState>({ phase: "loading" });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ phase: "loading" });
    // `refresh=1` on an explicit retry bypasses the server's catalogue cache —
    // the usual reason to retry is "I just configured a provider".
    api("GET", nonce > 0 ? "/models?refresh=1" : "/models")
      .then(({ status, json, timeout }) => {
        if (!live) return;
        if (timeout) return setState({ phase: "error", detail: "the request timed out" });
        if (status !== 200 || !json || !Array.isArray(json.models)) {
          return setState({ phase: "error", detail: json?.error || `the server answered ${status}` });
        }
        setState({ phase: "ready", catalogue: { models: json.models, default: json.default } });
      })
      .catch((err: unknown) => {
        if (live) setState({ phase: "error", detail: (err as Error)?.message ?? String(err) });
      });
    return () => {
      live = false;
    };
  }, [nonce]);
  return { state, reload: useCallback(() => setNonce((n) => n + 1), []) };
}
