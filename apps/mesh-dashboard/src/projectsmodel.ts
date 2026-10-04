/**
 * What the Projects page and the tab strip say about each project, and which actions apply to it.
 *
 * DOM-free for the reason route.ts and tabmodel.ts are: every sentence and every "which button" here is a claim about the
 * host's state, and a claim that lives in a component is a claim nothing checks. The components are markup over these
 * functions. The registry's own words (`status`, `tripped`, `restartInMs`, `lastMode`) go in; what a person reads comes out.
 *
 * The icon names are plain strings, because this file is compiled with the server's tsconfig and cannot import icons.tsx;
 * the components assign them to `IconName`, so a name that is not in the set fails their typecheck.
 */
import { nextActive, orderTabs } from "./tabmodel";

/** The slice of the registry's `ProjectSummary` read here. */
export interface ProjectView {
  id: string;
  name: string;
  root: string;
  addedAt?: string;
  lastOpenedAt?: string;
  status: string;
  tripped?: boolean;
  restartInMs?: number;
  /** The scheduler mode its process last reported. Only meaningful while the process is open. */
  lastMode?: "parked" | "live";
  error?: { reason: string; detail?: string };
  health?: { rss: number; lastHeartbeat: string; restarts: number };
  spend?: { tokens: number; usd: number; runningTurns: number };
}

export type StateKey = "open" | "host-parked" | "starting" | "closed" | "crashed" | "crash-loop" | "locked" | "cannot-open" | "unknown";
export type StateTone = "ok" | "warn" | "bad" | "neutral";
/** Shape carries the state as well as colour: a solid dot runs, a ring is closed, a triangle is broken. */
export type StateIcon = "dot" | "ring" | "pause" | "refresh" | "alert" | "lock" | "help";

export interface CardState {
  key: StateKey;
  tone: StateTone;
  /** One or two words, for a chip. */
  label: string;
  icon: StateIcon;
  /** What is true, as a sentence a person can act on. */
  sentence: string;
  /** For a running process: whether its mission is live or parked. Null when it is not running, or has not said. */
  mode: "live" | "parked" | null;
  /** A process is open and has turns in flight: work is being done now, not only possible. A parked mission can still have turns finishing. */
  working: boolean;
}

const seconds = (ms: number): string => {
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? "" : "s"}`;
};
const times = (n: number): string => (n === 1 ? "once" : `${n} times`);

/**
 * The state of one project. `parkedByHost` is whether the host parked it to stay inside its spend ceiling or turn cap
 * (`HostSpend.parked`): the registry's `open` cannot say that, and a project the host stopped is not the same as one that
 * is running. `missionParked` overrides what the registry last heard, for the project whose own store knows better.
 *
 * `tripped` means the host has stopped trying. It is set for a crash loop, and also for a project that is `locked` or
 * cannot open (neither is cured by trying again), so it only turns "crashed" into a crash loop: a locked project that
 * reads "crash loop" would send a person to look for a crash that never happened.
 */
export function cardState(p: ProjectView, opts: { parkedByHost?: boolean; missionParked?: boolean } = {}): CardState {
  const restarts = p.health?.restarts ?? 0;
  const base = { mode: null, working: false } as const;
  if (p.status === "crashed" && p.tripped) {
    return {
      ...base, key: "crash-loop", tone: "bad", label: "Crash loop", icon: "alert",
      sentence: `It crashed${restarts > 0 ? ` and was restarted ${times(restarts)}` : ""}, and the host has stopped restarting it. Restart it yourself once you know why.`,
    };
  }
  switch (p.status) {
    case "open": {
      const parked = opts.missionParked ?? p.lastMode === "parked";
      const mode = opts.missionParked === undefined && p.lastMode === undefined ? null : parked ? "parked" : "live";
      if (opts.parkedByHost) {
        return { key: "host-parked", tone: "warn", label: "Parked by host", icon: "pause", mode, working: false, sentence: "The host parked it to stay inside its spend ceiling or turn cap. Nothing runs until you continue it." };
      }
      return {
        key: "open", tone: "ok", label: "Open", icon: "dot", mode, working: (p.spend?.runningTurns ?? 0) > 0,
        sentence: mode === "parked" ? "Its process is running and its mission is parked: nothing runs on its own until it is started." : "Its process is running.",
      };
    }
    case "booting":
      return { ...base, key: "starting", tone: "warn", label: "Starting", icon: "refresh", sentence: "Its process is starting." };
    case "crashed":
      return {
        ...base, key: "crashed", tone: "bad", label: "Crashed", icon: "alert",
        sentence: typeof p.restartInMs === "number" ? `Its process exited. The host is restarting it in ${seconds(p.restartInMs)}.` : "Its process exited.",
      };
    case "locked":
      return { ...base, key: "locked", tone: "warn", label: "Locked", icon: "lock", sentence: "Another process holds this project's state folder. Stop it there, then restart this project." };
    case "error":
      return { ...base, key: "cannot-open", tone: "bad", label: "Cannot open", icon: "alert", sentence: "Its folder or its mesh.yaml is unusable. Fix it, then restart." };
    case "closed":
      return { ...base, key: "closed", tone: "neutral", label: "Closed", icon: "ring", sentence: "No process is running. Opening it starts one." };
    default:
      return { ...base, key: "unknown", tone: "neutral", label: "Unknown", icon: "help", sentence: "The host does not recognise this project." };
  }
}

/**
 * What a tab shows for a project: a word (small capitals in the strip), a shape, a tone. An open process says "running" only
 * when it has turns in flight, and "parked" when its mission is parked, because "open" alone hides the one thing a person
 * looking at a strip of projects wants to know: which of these is actually doing something. A live mission with nothing in
 * flight (no goal yet, or all of it waiting) is open, and the tab does not claim more.
 */
export function tabLook(c: CardState): { word: string; icon: StateIcon; tone: StateTone } {
  if (c.key === "open") {
    if (c.mode === "parked") return { word: "parked", icon: "pause", tone: "warn" };
    return { word: c.working ? "running" : "open", icon: "dot", tone: "ok" };
  }
  if (c.key === "host-parked") return { word: "parked", icon: "pause", tone: "warn" };
  return { word: c.label.toLowerCase(), icon: c.icon, tone: c.tone };
}

/**
 * Where the person goes when a tab is closed. A background tab closing moves nobody. The one in front closing hands them to
 * its neighbour if that is running (as closing a browser tab does), and otherwise to the Projects page: landing on a
 * closed project would show a console with nothing behind it, and the page says what is closed and offers to open it.
 */
export function landAfterClose(
  ordered: readonly ProjectView[],
  closingId: string,
  activeId: string | null,
): { kind: "stay" } | { kind: "project"; id: string } | { kind: "projects" } {
  if (activeId !== closingId) return { kind: "stay" };
  const next = nextActive(ordered.map((p) => p.id), closingId, activeId);
  const target = next ? ordered.find((p) => p.id === next) : undefined;
  return target && (target.status === "open" || target.status === "booting") ? { kind: "project", id: target.id } : { kind: "projects" };
}

/** The headline of the notice under the strip when the project in front is broken. */
export function problemTitle(name: string, key: StateKey): string {
  switch (key) {
    case "crashed": return `${name} crashed.`;
    case "crash-loop": return `${name} keeps crashing.`;
    case "locked": return `${name} is locked.`;
    case "cannot-open": return `${name} cannot open.`;
    default: return `${name} needs attention.`;
  }
}

/** The line under a broken project: why, in the host's own words. Empty when there is nothing to add. */
export function failureDetail(p: ProjectView): string {
  const reason = p.error?.reason?.trim();
  const detail = p.error?.detail?.trim();
  return [reason, detail].filter((s): s is string => !!s).join(": ");
}

export interface CardActions {
  /** Start its process (a closed project). */
  open: boolean;
  /** Bring it to the front (a running one). */
  goTo: boolean;
  close: boolean;
  /** A deliberate restart: for a project that crashed, is locked, or cannot open. */
  restart: boolean;
  /** Always: the registry forgets it, and its files stay. */
  remove: boolean;
  /** The one that should read as primary, if any. */
  primary: "open" | "goTo" | "restart" | null;
}

export function cardActions(key: StateKey): CardActions {
  const running = key === "open" || key === "host-parked" || key === "starting";
  const broken = key === "crashed" || key === "crash-loop" || key === "locked" || key === "cannot-open";
  const closed = key === "closed" || key === "unknown";
  return {
    open: closed,
    goTo: running,
    close: running,
    restart: broken,
    remove: true,
    primary: broken ? "restart" : running ? "goTo" : closed ? "open" : null,
  };
}

export type GroupKey = "attention" | "open" | "closed";
export interface Group<T> {
  key: GroupKey;
  label: string;
  items: T[];
}

const groupOf = (key: StateKey): GroupKey =>
  key === "crashed" || key === "crash-loop" || key === "locked" || key === "cannot-open" ? "attention"
  : key === "open" || key === "host-parked" || key === "starting" ? "open"
  : "closed";

const GROUP_LABEL: Record<GroupKey, string> = { attention: "Needs attention", open: "Open", closed: "Closed" };

/** Below this many projects a heading over each group is noise: three cards are already scannable. */
export const HEADINGS_FROM = 4;

/**
 * The projects in the groups a person scans for: what is broken first, then what is running, then what is closed. Inside a
 * group they keep the order the tab strip has, so a project does not sit in two places. Empty groups are left out, and
 * headings are only called for when there is more than one group and enough projects for them to help.
 */
export function groupProjects<T extends ProjectView>(
  projects: readonly T[],
  order: readonly string[],
  parkedIds: ReadonlySet<string> = new Set(),
): { groups: Group<T>[]; headings: boolean } {
  const buckets: Record<GroupKey, T[]> = { attention: [], open: [], closed: [] };
  for (const p of orderTabs(projects, order)) buckets[groupOf(cardState(p, { parkedByHost: parkedIds.has(p.id) }).key)].push(p);
  const groups = (["attention", "open", "closed"] as const)
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, label: GROUP_LABEL[k], items: buckets[k] }));
  return { groups, headings: groups.length > 1 && projects.length >= HEADINGS_FROM };
}

export type RegistryAnswer = "list" | "no-registry" | "down" | "refused";

/**
 * What an answer to `GET /api/projects` means for the page. Only a 2xx says what the registry holds. A 5xx is a proxy in
 * front of a host that is not there (502, 503 and 504 are what nginx, an ingress and Vite's dev proxy answer), and reading
 * it as "an empty registry" would swap twelve projects for a welcome that offers to make the first one. A refusal (401: the
 * sign-in page's business; 429: a throttled address) says nothing about the registry at all, so the page keeps what it has.
 * A 404 is a server with no registry route: `curule console`, one mesh and no host.
 */
export function readRegistryAnswer(res: { status: number; timeout?: boolean }): RegistryAnswer {
  if (res.timeout || res.status === 0 || res.status >= 500) return "down";
  if (res.status === 404) return "no-registry";
  if (res.status >= 200 && res.status < 300) return "list";
  return "refused";
}

/** The last segment of a folder path, for either separator, ignoring a trailing one. */
export function folderName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? root;
}

/**
 * A name per project that tells them apart. Two projects called "Demo Mesh" (a second copy of the demo has the same title)
 * would be two identical tabs; the folder's name, which cannot repeat under one parent, is added to the ones that clash.
 */
export function displayNames(projects: readonly ProjectView[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const p of projects) seen.set(p.name.toLowerCase(), (seen.get(p.name.toLowerCase()) ?? 0) + 1);
  return new Map(projects.map((p) => [p.id, (seen.get(p.name.toLowerCase()) ?? 0) > 1 ? `${p.name} (${folderName(p.root)})` : p.name]));
}

/** How many projects need a person: broken, locked or unable to open. The Projects button carries it so it is seen from any page. */
export function attentionCount(projects: readonly ProjectView[]): number {
  return projects.filter((p) => groupOf(cardState(p).key) === "attention").length;
}

/** `12 minutes ago`, from an explicit clock so it can be tested; "Never opened" when it never was. */
export function lastOpened(iso: string | undefined, now: number): string {
  if (!iso) return "Never opened";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Never opened";
  const s = (now - t) / 1000;
  if (s < 45) return "Just now";
  const unit = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"} ago`;
  if (s < 3600) return unit(Math.max(1, Math.round(s / 60)), "minute");
  if (s < 48 * 3600) return unit(Math.round(s / 3600), "hour");
  return unit(Math.round(s / 86400), "day");
}

/** Dollars, to the cent; under a cent it says so rather than rounding to zero; thousands grouped. */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

export interface HostSummary {
  total: number;
  open: number;
  attention: number;
  runningTurns: number;
  /** Estimated spend of the open projects since each last started; null when the host has not said. */
  usd: number | null;
  ceilingUsd: number | null;
}

export function hostSummary(
  projects: readonly ProjectView[],
  spend: { usd: number; runningTurns: number; ceilingUsd: number | null } | null,
): HostSummary {
  return {
    total: projects.length,
    open: projects.filter((p) => p.status === "open" || p.status === "booting").length,
    attention: attentionCount(projects),
    runningTurns: spend?.runningTurns ?? projects.reduce((n, p) => n + (p.spend?.runningTurns ?? 0), 0),
    usd: spend ? spend.usd : null,
    ceilingUsd: spend?.ceilingUsd ?? null,
  };
}
