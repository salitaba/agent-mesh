/**
 * What this host says about itself (`GET /api/templates`): what a new project can be made from, whether it is a Curule Cloud workspace, and
 * whether a team made here could reach a model. The welcome reads it to say the right thing to a laptop's owner or a customer; the Designer
 * and the Start dialog read it to say that a hosted team has no model key yet, and where to add one.
 *
 * Kept out of newproject.tsx because three places ask and none of them is a page about starting a project.
 */
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { failureText, parseTemplates, type TemplatesAnswer } from "./firstrun";
import { useProjectsOptional } from "./projects";

export type TemplatesState =
  | { phase: "loading" }
  | { phase: "ready"; answer: TemplatesAnswer }
  /** The host has no `/api/templates`: an older host. Adding a folder that holds a mesh.yaml still works. */
  | { phase: "unsupported" }
  | { phase: "error"; message: string };

/** One ask, settled: the state a page shows, never a thrown error. */
export async function fetchTemplates(): Promise<Exclude<TemplatesState, { phase: "loading" }>> {
  let res: Awaited<ReturnType<typeof api>> | null;
  try {
    res = await api("GET", "/api/templates");
  } catch {
    res = null;
  }
  if (res === null || res.status === 0) return { phase: "error", message: failureText(null) };
  if (res.status === 404) return { phase: "unsupported" };
  const answer = res.status === 200 ? parseTemplates(res.json) : null;
  return answer ? { phase: "ready", answer } : { phase: "error", message: `The host answered ${res.status} and offered nothing to start from.` };
}

/**
 * The host's answer, and a way to ask again. With `keepFresh` it also asks again, quietly, when the page is shown after being away, and
 * every few seconds while `watchWhile` holds for the answer it has (the person has gone to add a model key in another tab: the host is
 * made again with it, and this page should notice without being told). A quiet ask that fails keeps what the page already has: a host
 * that is restarting is not a new answer.
 */
export function useTemplates(opts: { keepFresh?: boolean; watchWhile?: (answer: TemplatesAnswer) => boolean; enabled?: boolean } = {}): { state: TemplatesState; reload: () => void } {
  const { keepFresh = false, watchWhile, enabled = true } = opts;
  const [state, setState] = useState<TemplatesState>({ phase: "loading" });
  const watching = state.phase === "ready" && watchWhile !== undefined && watchWhile(state.answer);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState({ phase: "loading" });
    void fetchTemplates().then((next) => {
      if (alive) setState(next);
    });
    return () => {
      alive = false;
    };
  }, [attempt, enabled]);

  const quietly = useCallback(async (): Promise<void> => {
    const next = await fetchTemplates();
    setState((prev) => (next.phase === "error" && prev.phase === "ready" ? prev : next));
  }, []);
  useEffect(() => {
    if (!keepFresh || !enabled) return;
    const onShow = (): void => {
      if (document.visibilityState === "visible") void quietly();
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    const timer = watching ? setInterval(onShow, 6000) : undefined;
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      if (timer !== undefined) clearInterval(timer);
    };
  }, [keepFresh, watching, enabled, quietly]);
  return { state, reload: useCallback(() => setAttempt((n) => n + 1), []) };
}

/**
 * The host's answer, once it has one, for a page that only needs the facts (the Designer): null until then, and on a host that does not say.
 * A server with no registry (`curule console`, one mesh) has no such route, and is not asked.
 */
export function useHostFacts(): TemplatesAnswer | null {
  const projects = useProjectsOptional();
  const { state } = useTemplates({ keepFresh: true, enabled: projects?.hasRegistry === true });
  return state.phase === "ready" ? state.answer : null;
}
