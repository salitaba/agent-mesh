/* Model catalogue: what this installation can actually reach, from GET /models.
 * Shared by the crew panel (per-agent model) and the mesh panel (mesh default).
 * One module-level cache per project client: both tabs share the fetch, and the
 * in-flight promise is deduped so mounting two panels never doubles the call. */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { type ProjectClient } from "../api";

export interface ModelCatalogue {
  models: string[];
  /** The mesh-wide fallback used when an agent leaves `model` blank. */
  default?: string;
}

export type CatalogueState =
  | { phase: "loading" }
  | { phase: "ready"; catalogue: ModelCatalogue }
  | { phase: "error"; detail: string };

const TTL_MS = 5 * 60_000;

interface Cache {
  state: CatalogueState;
  loadedAt: number;
  inflight: Promise<void> | null;
  listeners: Set<() => void>;
}

const caches = new WeakMap<ProjectClient, Cache>();

function cacheFor(client: ProjectClient): Cache {
  let cache = caches.get(client);
  if (!cache) {
    cache = { state: { phase: "loading" }, loadedAt: 0, inflight: null, listeners: new Set() };
    caches.set(client, cache);
  }
  return cache;
}

function publish(cache: Cache, next: CatalogueState): void {
  cache.state = next;
  for (const l of cache.listeners) l();
}

function load(cache: Cache, client: ProjectClient, refresh: boolean): Promise<void> {
  if (cache.inflight) return cache.inflight;
  if (!refresh && cache.state.phase === "ready" && Date.now() - cache.loadedAt < TTL_MS) return Promise.resolve();
  publish(cache, { phase: "loading" });
  // `refresh=1` on an explicit retry bypasses the server's catalogue cache —
  // the usual reason to retry is "I just configured a provider".
  const p = client.api("GET", refresh ? "/models?refresh=1" : "/models")
    .then(({ status, json, timeout }) => {
      if (timeout) return publish(cache, { phase: "error", detail: "the request timed out" });
      if (status !== 200 || !json || !Array.isArray(json.models)) {
        return publish(cache, { phase: "error", detail: json?.error || `the server answered ${status}` });
      }
      publish(cache, { phase: "ready", catalogue: { models: json.models, default: json.default } });
      cache.loadedAt = Date.now();
    })
    .catch((err: unknown) => {
      publish(cache, { phase: "error", detail: (err as Error)?.message ?? String(err) });
    })
    .finally(() => {
      if (cache.inflight === p) cache.inflight = null;
    });
  cache.inflight = p;
  return p;
}

/**
 * The models this installation can actually reach, from GET /models.
 *
 * Deliberately NOT collapsed into `models: string[]` with `[]` on failure: an
 * empty dropdown reads as "no models exist" when the truth is "the console
 * never heard back", and the picker would silently discard a model already
 * written in mesh.yaml.
 */
export function useModelCatalogue(client: ProjectClient): { state: CatalogueState; reload: () => void } {
  const subscribe = useCallback((listener: () => void) => {
    const cache = cacheFor(client);
    cache.listeners.add(listener);
    return () => { cache.listeners.delete(listener); };
  }, [client]);
  const getSnapshot = useCallback(() => cacheFor(client).state, [client]);
  const state = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => { void load(cacheFor(client), client, false); }, [client]);
  const reload = useCallback(() => { void load(cacheFor(client), client, true); }, [client]);
  return { state, reload };
}
