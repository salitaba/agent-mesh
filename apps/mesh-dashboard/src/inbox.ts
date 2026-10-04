import { useEffect, useState } from "react";
import type { ProjectClient } from "./api";

/**
 * How many tools seats have asked for and been refused, waiting on the operator to unlock them.
 *
 * Decisions arrive on the event stream and ride `/status`; a tool request does not: grants are session state, so nothing
 * streams them and the Tool gates view polls `/tool-approvals`. The sidebar badge counts both, which needs the same poll
 * here. It runs only while the tab is visible and the server answers, at a quarter of the Tool gates view's own rate, and
 * answers 0 until it hears: a badge that reads zero by default is wrong less often than one that reads anything else.
 */
export function useToolRequests(client: ProjectClient, enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setCount(0);
      return;
    }
    let dead = false;
    const load = async (): Promise<void> => {
      if (document.visibilityState === "hidden") return;
      try {
        const r = await client.api("GET", "/tool-approvals");
        const seats = (r.json as { seats?: unknown } | null)?.seats;
        if (dead || r.status !== 200 || !Array.isArray(seats)) return;
        setCount(seats.reduce<number>((n, s) => n + (Array.isArray((s as { requested?: unknown }).requested) ? (s as { requested: unknown[] }).requested.length : 0), 0));
      } catch {
        /* the badge keeps its last value; the views say when the server is gone */
      }
    };
    void load();
    const iv = setInterval(() => void load(), 6000);
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [client, enabled]);
  return count;
}
