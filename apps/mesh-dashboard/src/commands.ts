/**
 * WS10 command registry — the one seam between the shell palette and the
 * commands a mounted view contributes.
 *
 * The registry lists whatever is registered right now: the shell registers
 * the global commands, a view registers its own while mounted and unregisters
 * on unmount, so a stale command can never act on a view that is off screen.
 * Deliberately tiny — a Map of scopes plus a version counter, nothing else.
 */

export interface Command {
  id: string;
  label: string;
  /** Extra lowercase terms the palette matches besides label and id. */
  keywords?: string;
  /** Scope the command was registered under (shown as a badge, "global" omitted). */
  scope: string;
  run: () => void;
}

const byScope = new Map<string, Command[]>();
let version = 0;
const listeners = new Set<() => void>();
function bump(): void {
  version++;
  for (const l of listeners) l();
}

/** External-store subscribe/getVersion so the palette and the Designer can
 *  re-render when scopes register/unregister or a jump is requested. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function getVersion(): number {
  return version;
}

/** Replace everything registered under `scope`; re-running on each render is safe. */
export function register(scope: string, commands: Command[]): void {
  byScope.set(scope, commands);
  bump();
}

/** Drop a scope entirely — call from the registering component's cleanup. */
export function unregister(scope: string): void {
  if (byScope.delete(scope)) bump();
}

/** Snapshot in registration order: global first, then the mounted view's scopes. */
export function list(): Command[] {
  return [...byScope.values()].flat();
}

/**
 * "Jump to agent" hand-off: the palette records one agent id and navigates to
 * the Designer, which takes it once it can select the agent. A module-level
 * value — not a bus, not localStorage, nothing that survives a view visit.
 */
let pendingAgent: string | null = null;
export function setPendingAgent(id: string): void {
  pendingAgent = id;
  bump();
}
export function takePendingAgent(): string | null {
  const id = pendingAgent;
  pendingAgent = null;
  return id;
}
