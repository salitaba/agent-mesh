/**
 * Tab-strip logic — deliberately DOM-free.
 *
 * Same reason as `route.ts`: everything here is arithmetic over plain values
 * (status → tone, id list → order, retained-event caps), and the repo has no
 * browser test harness. Keeping it out of `.tsx` is what lets `node:test`
 * cover it; the components in `tabs.tsx` are then just markup over these
 * functions. Pulled into the root tsconfig through `files`, not `include`.
 */

/** What a tab can look like. Mirrors `ProjectStatus` plus the two states the
 *  registry cannot see on its own: `parked` (per-mesh, read off the active
 *  project's `/status`) and `unknown` (a project the host never heard of). */
export type TabTone =
  | "running"
  | "parked"
  | "booting"
  | "crashed"
  | "locked"
  | "error"
  | "closed"
  | "unknown";

export interface TabStatus {
  tone: TabTone;
  /** Short word under the tab. */
  label: string;
  /** Title text: the one sentence that explains this state. */
  hint: string;
  /** A restart button is worth showing. */
  restartable: boolean;
}

/** The subset of `ProjectSummary` the strip actually reads. */
export interface TabInput {
  id: string;
  status: string;
  tripped?: boolean;
  restartInMs?: number;
  error?: { reason: string; detail?: string };
  health?: { rss: number; lastHeartbeat: string; restarts: number };
}

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * The tone a tab should show.
 *
 * `parked` is passed in rather than read from the summary: whether a mesh is
 * parked is per-mission state that lives behind the child's `/status`, and the
 * registry deliberately knows nothing about mesh state. Only the project whose
 * store is mounted can answer it, so only that tab gets it.
 */
export function tabStatus(p: TabInput, parked = false): TabStatus {
  const restarts = p.health?.restarts ?? 0;
  switch (p.status) {
    case "open":
      return parked
        ? { tone: "parked", label: "parked", hint: "Parked — nothing runs on its own by design. Go live to start it.", restartable: false }
        : { tone: "running", label: "running", hint: "Running — the project is open and streaming events.", restartable: false };
    case "booting":
      return { tone: "booting", label: "starting", hint: "Starting the project process…", restartable: false };
    case "crashed":
      return {
        tone: "crashed",
        label: "crashed",
        hint: crashHint(p, restarts),
        // A tripped breaker means automatic restarts have stopped, so the
        // button is the only way back; an armed retry still offers it because
        // an operator asking now beats waiting out the backoff.
        restartable: true,
      };
    case "locked":
      return {
        tone: "locked",
        label: "locked",
        hint: "Locked — another process holds this project's state directory. Close it there, then restart.",
        restartable: true,
      };
    case "error":
      return {
        tone: "error",
        label: "error",
        hint: p.error?.reason ? `Cannot open: ${p.error.reason}` : "Cannot open this project — its config or folder is unusable.",
        restartable: true,
      };
    case "closed":
      return { tone: "closed", label: "closed", hint: "Closed — no process is running for this project.", restartable: false };
    default:
      return { tone: "unknown", label: "unknown", hint: "The host does not recognise this project.", restartable: false };
  }
}

function crashHint(p: TabInput, restarts: number): string {
  const reason = p.error?.reason ? `Crashed: ${p.error.reason}.` : "The project process exited unexpectedly.";
  const history = restarts > 0 ? ` Restarted ${restarts}×.` : "";
  if (p.tripped) return `${reason}${history} Restarting automatically has been given up on — restart by hand once you know why.`;
  if (typeof p.restartInMs === "number") return `${reason}${history} Retrying in ${seconds(p.restartInMs)}.`;
  return `${reason}${history}`;
}

/** RSS for a tab. Bytes in, one significant place out; "" when unmeasured —
 *  a project with no heartbeat should show nothing rather than a fake 0. */
export function formatRss(bytes?: number): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return "";
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return "<1 MB";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/**
 * Retained events per project.
 *
 * A background project keeps ingesting — that is what makes switching back
 * instant — but at a fraction of the foreground buffer. Ten idle tabs at the
 * foreground cap is an unbounded leak in the browser, and the events a
 * background tab drops are exactly the ones `/events` can refill on focus.
 */
export const RETAIN_ACTIVE = 800;
export const RETAIN_BACKGROUND = 150;

export const retainCap = (background: boolean): number => (background ? RETAIN_BACKGROUND : RETAIN_ACTIVE);

/**
 * Newest `cap` entries. Returns the *same array* when nothing is over the cap:
 * the caller stores this in React state, and a fresh array every ingest would
 * re-render every consumer for no change.
 */
export function trimRetained<T>(list: T[], cap: number): T[] {
  if (cap <= 0 || list.length <= cap) return list;
  return list.slice(list.length - cap);
}

/**
 * Tabs in the operator's order.
 *
 * `order` is a remembered id list and is allowed to be stale in both
 * directions: ids it does not know are appended in arrival order (a project
 * added elsewhere still shows up), and ids that no longer exist are ignored
 * (a removed project must not leave a hole).
 */
export function orderTabs<T extends { id: string }>(items: readonly T[], order: readonly string[]): T[] {
  const rank = new Map<string, number>();
  order.forEach((id, i) => rank.set(id, i));
  return items
    .map((item, i) => ({ item, at: rank.has(item.id) ? (rank.get(item.id) as number) : order.length + i }))
    .sort((a, b) => a.at - b.at)
    .map((x) => x.item);
}

/** Order after a drag: `dragId` lands where `beforeId` is. A drop on itself,
 *  or on an id the order does not carry, is a no-op rather than a reshuffle. */
export function reorderTabs(order: readonly string[], dragId: string, beforeId: string): string[] {
  if (dragId === beforeId) return [...order];
  const from = order.indexOf(dragId);
  const to = order.indexOf(beforeId);
  if (from < 0 || to < 0) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(next.indexOf(beforeId) + (from < to ? 1 : 0), 0, dragId);
  return next;
}

/** Order after a keyboard move (`delta` of ±1). Clamped at the ends. */
export function moveTab(order: readonly string[], id: string, delta: number): string[] {
  const from = order.indexOf(id);
  if (from < 0) return [...order];
  const to = from + delta;
  if (to < 0 || to >= order.length) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * Which tab takes focus when the active one closes: the next tab to the right,
 * else the one to the left, else nothing. Closing a background tab must not
 * move focus at all — that would yank the operator out of what they were
 * reading because something unrelated shut down.
 */
export function nextActive(orderedIds: readonly string[], closingId: string, activeId: string | null): string | null {
  if (activeId !== closingId) return activeId;
  const at = orderedIds.indexOf(closingId);
  if (at < 0) return orderedIds[0] ?? null;
  const rest = orderedIds.filter((id) => id !== closingId);
  if (!rest.length) return null;
  return rest[Math.min(at, rest.length - 1)] ?? null;
}
