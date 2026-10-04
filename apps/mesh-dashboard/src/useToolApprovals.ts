import { useCallback, useEffect, useState } from "react";
import type { ProjectClient } from "./api";
import type { LoadState, ToolSeat } from "./inbox-model";

/**
 * The seats the approval gate holds, and what each has asked for, polled.
 *
 * Grants are session state, not event-sourced, so nothing streams them and a second operator's grant only shows up on the next
 * poll. It runs only while the tab is visible. `state` says whether the list has ever been read: a failure after a good read
 * keeps the list (the shell's banner says when the server is gone), but a list that was never read is `error`, not empty, so a
 * page never reports "no tool requests" about something it could not ask.
 */
export function useToolApprovals(client: ProjectClient, intervalMs: number, enabled = true): { seats: ToolSeat[]; state: LoadState; reload: () => Promise<void> } {
  const [seats, setSeats] = useState<ToolSeat[]>([]);
  const [state, setState] = useState<LoadState>("loading");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const r = await client.api("GET", "/tool-approvals");
      const list = (r.json as { seats?: unknown } | null)?.seats;
      if (r.status === 200 && Array.isArray(list)) {
        setSeats(list.map((s) => {
          const x = s as Partial<ToolSeat>;
          return {
            agentId: String(x.agentId ?? ""),
            requiresApproval: Array.isArray(x.requiresApproval) ? x.requiresApproval : [],
            granted: Array.isArray(x.granted) ? x.granted : [],
            requested: Array.isArray(x.requested) ? x.requested : [],
          };
        }));
        setState("ready");
      } else {
        setState((s) => (s === "ready" ? s : "error"));
      }
    } catch {
      setState((s) => (s === "ready" ? s : "error"));
    }
  }, [client]);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const iv = setInterval(() => {
      if (document.visibilityState !== "hidden") void reload();
    }, intervalMs);
    return () => clearInterval(iv);
  }, [reload, intervalMs, enabled]);

  return { seats, state, reload };
}
