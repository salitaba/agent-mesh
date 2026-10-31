import { useEffect } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { fmt, mandatoryProgress, plural } from "./format";
import { useMesh, type View } from "./store";
import { MessageDrawer, ApprovalDrawer, StepDrawer, AgentDrawer } from "./drawers";
// The shell keeps its own stack-aware trap (drawer over drawer), but it must
// agree with every other dialog about what "focusable" means.
import { Banner, Button, DrawerHead, EmptyState, ErrorState, IconButton, Kbd, Menu, PageHeader, ToastCard, Wordmark, focusables, isTopTrap, pushTrap, type MenuItem } from "./components";
import { Icon, type IconName } from "./icons";
import { barActionIsHere, documentTitle, type MissionAction } from "./mission";
import { useMission } from "./useMission";
import { useMissionActions } from "./useMissionActions";
import { useToolRequests } from "./inbox";
import { register, setPendingAgent, unregister, type Command } from "./commands";
import { CommandPalette } from "./commandpalette";
import { budgetTone } from "./cost";
import { ratioOf } from "./ui/chart-model";
import { ViewLoading } from "./viewboundary";
import { HostEmptyState, ProjectTabs } from "./tabs";
import { useProjectsOptional } from "./projects";
import { holdsForProject, isHostView, registryPhase, serverKind, showsSection } from "./navmodel";
import ChatDock, { ChatDockButton } from "./designer/ChatDock";
import { useAuthOptional } from "./auth";
import { LicenseBanner } from "./license";
import { AttentionEffects } from "./attentioneffects";
import { useNotify } from "./notifycontrol";

// Single source of truth for nav order, sidebar key hints and the 1-9 key map: the badge and the keydown handler are
// both derived from this list, so they cannot drift apart. Four groups, in the order a person asks the questions: how is
// it going and what does it need from me; what did it make; who is on the team; what is this host.
interface NavItem { view: View; icon: IconName; label: string; title: string }
const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: "Mission",
    items: [
      { view: "overview", icon: "overview", label: "Overview", title: "Is the mission healthy? What needs you right now?" },
      { view: "escalations", icon: "inbox", label: "Needs you", title: "Decisions the mesh is waiting on, and what each one holds up." },
      { view: "agents", icon: "agents", label: "Agents", title: "Who is working, stuck, or idle. Wake, suspend, or inspect one." },
      { view: "steps", icon: "steps", label: "Steps", title: "Every agent turn, newest first: what each turn did, rather than each event it emitted." },
      { view: "events", icon: "events", label: "Events", title: "The live console: everything the mesh is doing, as it happens. Watch here while a run is going." },
    ],
  },
  {
    section: "Results",
    items: [
      { view: "artifacts", icon: "files", label: "Files", title: "Files and documents agents produced, with versions." },
      { view: "product", icon: "product", label: "Product", title: "The delivered codebase: browse files, build, test, run scenarios, open the playground." },
      { view: "playground", icon: "code", label: "Playground", title: "Type a command and run it in the delivered product's own checkout, then read what it prints." },
      { view: "cost", icon: "cost", label: "Cost", title: "Token spend and budgets." },
    ],
  },
  {
    section: "Team",
    items: [
      { view: "graph", icon: "graph", label: "Graph", title: "Who talks to whom." },
      { view: "designer", icon: "designer", label: "Designer", title: "Create or edit a mesh, then run it." },
      { view: "gates", icon: "lock", label: "Tool gates", title: "Seats holding a capability they may not use until you unlock the tool." },
    ],
  },
  {
    section: "Host",
    items: [
      { view: "projects", icon: "folder", label: "Projects", title: "Every project on this host: open, close, restart or remove one." },
      { view: "hostsettings", icon: "sliders", label: "Host settings", title: "Limits that apply to every project on this host: the spend ceiling, the turn cap, prices." },
    ],
  },
];
const NAV_ITEMS: NavItem[] = NAV.flatMap((g) => g.items);

/**
 * The five places the work lives, drawn as a row at the bottom of the frame wherever the navigation is a drawer (800 px and below):
 * the brief, the product, what it made, what it says, and what it wants. They are the owner's own path — "open the console" to
 * "I am using my product" — and on a phone the top-left menu is the far corner of a one-handed screen. Everything else stays one
 * press further in, behind the menu, which is where a reader goes for the pages of a single question.
 *
 * The row is the same five at every width it is drawn at, so muscle memory survives a rotation and there is no second, shorter list
 * to learn. It is not drawn beside a sidebar (the five are already there) and not on the Designer, whose own save bar owns the
 * bottom of the screen.
 */
const DOCK_VIEWS: readonly View[] = ["overview", "product", "artifacts", "events", "escalations"];

// Order matters twice over: it is the digit each view answers to, and the digit is shown beside the view in the sidebar.
// Derived from NAV, so a sidebar numbered 1, 5, 2, 3, 4 cannot happen.
const KEY_VIEWS: View[] = NAV_ITEMS.map((n) => n.view);
/**
 * Only the first nine positions have a key an operator can actually press: the
 * keydown handler matches a single `ev.key`, so position ten would have to be
 * typed "1" then "0" and never fires. Past nine the hint is omitted rather than
 * printed as a digit that does nothing.
 */
const viewKey = (v: View): string => {
  const i = KEY_VIEWS.indexOf(v);
  return i >= 0 && i < 9 ? String(i + 1) : "";
};

// Mirrors the `@media (max-width: 800px)` rule in styles.css that turns the
// sidebar into an off-canvas drawer. Below it the sidebar is translated out of
// view but still in the tab order unless we mark it inert, so a keyboard user
// tabs through ten invisible nav buttons before reaching the page.
const NARROW = "(max-width: 800px)";
/* Below this the topbar stops being a bar. Measured at 390px the four mission
   actions plus the telemetry strip wrapped the header to four rows (138px) and
   pushed the document into horizontal scroll; 620 is the widest point at which
   the collapsed layout is still the better one, so tablets keep today's shape. */
const PHONE = "(max-width: 620px)";
/** Match a media query and re-render when it flips. Shared with the Designer,
 *  whose workbench changes shape at its own 1240 breakpoint. */
export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent) => setMatch(e.matches);
    mq.addEventListener("change", on);
    setMatch(mq.matches);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}
function useNarrow(): boolean {
  return useMedia(NARROW);
}

/** Shell-owned graph focus mode (WS9): Designer and Topology read it through
 *  this one seam — the sidebar collapse, clear-on-view-change and (WS10) Esc
 *  all live in the shell, so there is no second copy of the boolean. */
export interface FocusMode {
  focusMode: boolean;
  setFocusMode: (on: boolean) => void;
}
const FocusCtx = createContext<FocusMode>({ focusMode: false, setFocusMode: () => {} });
export function useFocusMode(): FocusMode {
  return useContext(FocusCtx);
}

function Help(): React.JSX.Element {
  return (
    <div className="help">
      <h2>How to read this console</h2>
      <p className="muted"><b>Overview</b> → is it healthy? <b>Needs you</b> → the decisions only you can make. <b>Steps</b> → what did each agent do? <b>Agents</b> → who needs help? Everything else is detail.</p>
      <h2>Keyboard</h2>
      <table>
        <tbody>
          <tr><td><kbd>1</kbd>…<kbd>9</kbd></td><td>switch view (the digit shows when you hover a view)</td></tr>
          <tr><td><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd></td><td>search views, agents and actions</td></tr>
          <tr><td><kbd>/</kbd></td><td>focus search (events / steps)</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>back one level / close panel</td></tr>
          <tr><td><kbd>j</kbd> / <kbd>k</kbd></td><td>older / newer step (in a step)</td></tr>
          <tr><td><kbd>p</kbd> / <kbd>r</kbd></td><td>pause / resume the mission (a pause can be undone from its notice)</td></tr>
          <tr><td><kbd>t</kbd></td><td>toggle theme</td></tr>
          <tr><td><kbd>?</kbd></td><td>this help</td></tr>
        </tbody>
      </table>
      <h2>About</h2>
      {/* The buttons named here are the ones the console shows: the parked Overview's is Start mission, and Continue once the
          mission has run (mission.ts); Approve or reject is in the ⋯ menu. */}
      <p className="muted">Every screen is a projection of the append-only event log.
        Message and Approve or reject act as the <code>human</code> seat; the designer validates
        configs server-side with the same engine as <code>curule validate</code>.
        Tip: <code>curule console &lt;mesh.yaml&gt;</code> opens this console parked: nothing runs on its own until you press Start
        mission (Continue, on a mission that has run before).</p>
    </div>
  );
}

/** What the view area says while the project it would show is still starting: the views wait, so none asks for a mission that is not there yet. */
function ProjectStarting({ name }: { name: string | null }): React.JSX.Element {
  return (
    <div role="status" aria-busy="true">
      <EmptyState icon="spark" title={name ? `Starting ${name}` : "Starting the project"}>
        The project&rsquo;s process is starting. Its mission appears as soon as it has read its log.
      </EmptyState>
    </div>
  );
}

/**
 * The host was asked what it holds and has never answered. Without an answer the console cannot tell a one-mesh server from
 * a host, so every view holds — that hold used to be the loading placeholder, for ever, with no sentence and no retry.
 */
function RegistryDown({ page, onRetry }: { page: string; onRetry: () => void }): React.JSX.Element {
  return (
    <>
      <PageHeader title={page} />
      <ErrorState
        what="the projects list"
        detail="The server did not answer the projects list, so the console cannot tell whether this is one mesh or a host, and no page can ask it anything yet. It may be restarting."
        onRetry={onRetry}
      />
    </>
  );
}

/** What a command looks like in the palette: where it is listed when nothing has been typed, its icon, and the key that does the same. */
function lookOf(c: Command): { group: string; icon: IconName; hint?: string } {
  if (c.id.startsWith("go.")) {
    const view = c.id.slice(3) as View;
    const nav = NAV_ITEMS.find((n) => n.view === view);
    const key = viewKey(view);
    return { group: "Go to", icon: nav?.icon ?? "arrow-right", hint: key || undefined };
  }
  if (c.id.startsWith("agent.")) return { group: "Agents", icon: "agents" };
  if (c.id === "help.open") return { group: "Actions", icon: "help", hint: "?" };
  if (c.id === "chat.ask") return { group: "Actions", icon: "spark" };
  if (c.id === "projects.new") return { group: "Actions", icon: "plus" };
  return { group: "Actions", icon: "arrow-right" };
}
const PALETTE_GROUPS = ["Go to", "Agents", "Actions"] as const;

export function Shell({ viewNode }: { viewNode: React.ReactNode }): React.JSX.Element {
  const mesh = useMesh();
  const { view, setView, status, goalId, toasts, dismissToast, drawer, drawerDepth, openDrawer, closeDrawer, toast, refreshStatus, serverDown, sseState, detail, closeDetail, steps, client, confirm } = mesh;
  // Single-process `curule serve` / `curule console` has one mesh and no registry,
  // and must not gain an empty tab strip. "Is the provider mounted" did not
  // answer that — the provider mounts in both modes — so ask the server, and
  // show the strip only once it confirms a registry exists.
  const projectsCtx = useProjectsOptional();
  const hasProjects = projectsCtx?.hasRegistry === true;
  const kind = serverKind(projectsCtx ? { hasRegistry: projectsCtx.hasRegistry, loaded: projectsCtx.loaded, projectCount: projectsCtx.projects.length } : null);
  const activeProject = projectsCtx?.projects.find((p) => p.id === projectsCtx.activeId) ?? null;
  const projectName = activeProject?.name ?? null;
  // The view area waits while the project it would show is starting (navmodel.ts), and so does everything that asks the project something.
  const holdView = holdsForProject(kind, view, { chosen: mesh.projectId !== null, status: activeProject?.status ?? null });
  const auth = useAuthOptional();
  // A registry that has answered and holds nothing is first-run, not "a mission
  // reading zero". Every mesh-scoped request 409s in that state, so rendering
  // the views paints a dashboard out of failures.
  const noProjects = hasProjects && projectsCtx.loaded && projectsCtx.projects.length === 0;
  // Until the registry answers we do not know which of the two servers this is,
  // and the views must not fetch on the guess. On a laptop that is one local
  // request, but a hosted workspace is a network away, and the content area sat
  // blank under "Connecting…" for as long as it took. It holds the view
  // placeholder instead, which stays invisible for its first moment, so the fast
  // case still paints nothing and the slow one says it is loading.
  const registry = registryPhase(projectsCtx ? { hasRegistry: projectsCtx.hasRegistry, hostDown: projectsCtx.hostDown } : null);
  const registryPending = registry === "waiting";
  // The page the person asked for, so a failed registry still shows a signpost rather than a bare error.
  const askedPage = NAV_ITEMS.find((n) => n.view === view)?.label ?? "The console";
  const goal = status?.goal || {};
  // Mandatory-only, matching Overview and the termination gate. The header used
  // to score every criterion including optional ones, so the two screens
  // disagreed about the same mission.
  const { done, total: critTotal } = mandatoryProgress(goal.acceptanceCriteria);
  const mission = (status?.budgets || []).find((b: any) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  // One reading of the mission, shared by the bar, the Overview and the tab title (mission.ts, useMission.ts): what state it
  // is in and the one thing to do about it. The bar used to say PARKED beside a goal that read "done".
  const { facts, state } = useMission();
  const parked = facts.parked;
  // A host with no project, and the Projects page, belong to the host and not to a mission: no mission chip, goal, numbers or
  // mission actions on them, and with no project at all no project views to go to. They used to show "Connecting", 0 working and
  // 0/0 tokens around the welcome page, and a sidebar of views that led nowhere.
  const hostLevel = noProjects || view === "projects";
  const decisions = facts.blockingDecisions + facts.advisoryDecisions;
  // Tool requests do not ride the event stream, so the badge polls for them (inbox.ts).
  const toolRequests = useToolRequests(client, !serverDown && !noProjects && registry === "known" && !holdView);
  const inbox = decisions + toolRequests;
  // The connection is a separate fact from the mission. A mission that is running over a dropped connection is not "running".
  const reconnecting = !serverDown && sseState === "reconnecting";
  const chipTone = reconnecting ? "warn" : state.tone;
  const chipLabel = reconnecting ? "Reconnecting" : state.label;
  const chipTitle = reconnecting ? "Connection lost: reconnecting. What you see may be stale." : state.headline;

  // A mission waiting on you is the one thing worth a glance at a background tab, so the count leads the title. The page the
  // tab is on follows it, so two tabs of one console do not both read "Delivered · demo-stub — Curule".
  const viewLabel = view === "overview" ? null : NAV_ITEMS.find((n) => n.view === view)?.label ?? null;
  useEffect(() => {
    document.title = hostLevel
      ? documentTitle({ phaseLabel: noProjects ? null : "Projects", decisions: 0, project: null })
      : documentTitle({ phaseLabel: status ? chipLabel : null, decisions: inbox, project: projectName, view: viewLabel });
  }, [hostLevel, noProjects, status, chipLabel, inbox, projectName, viewLabel]);

  const [menuOpen, setMenuOpen] = useState(false);
  const narrow = useNarrow();
  const phone = useMedia(PHONE);
  // Hidden off-canvas, so it must leave the tab order and the a11y tree too.
  const sidebarHidden = narrow && !menuOpen;
  // On a narrow screen the sidebar is not a second column, it is a layer over the page: it owns a scrim, the keyboard and
  // the page behind it goes inert. Before this it was 288px of navigation floating over a page that still tabbed (8 controls
  // behind it at 360), with no scrim, no close button, no aria-modal, and a tap outside did nothing.
  const navModal = narrow && menuOpen;
  /**
   * The row at the thumb exists only where the navigation is a drawer, and only where there is something to navigate to: not while the
   * registry has not said what this server is (every page behind it is a placeholder), not on a host's own pages, and not in the
   * Designer (its save bar is the bottom of that screen).
   */
  const showDock = narrow && !hostLevel && !isHostView(view) && registry === "known" && view !== "designer";
  const [focusMode, setFocusMode] = useState(false);
  // Derived: the frame that paints the next view must not show a collapsed
  // sidebar. The effect below still clears the flag so returning to Designer
  // does not silently re-enter focus.
  const focusOn = focusMode && view === "designer";
  const focusValue = useMemo(() => ({ focusMode: focusOn, setFocusMode }), [focusOn]);
  // Shell outlives view switches; focus belongs to one Designer visit. Leaving
  // the view must not leave the sidebar collapsed behind the next one.
  // Adjusted during render rather than in an effect: no extra commit, no flash.
  const [prevView, setPrevView] = useState(view);
  if (view !== prevView) {
    setPrevView(view);
    if (focusMode) setFocusMode(false);
  }
  // Collapsing the sidebar takes it out of the layout. The menu state goes with
  // it, and keyboard focus must not be stranded inside a hidden element.
  useEffect(() => {
    if (!focusOn) return;
    setMenuOpen(false);
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest("#sidebar")) document.getElementById("view")?.focus();
  }, [focusOn]);
  // Palette (WS10): open state here, commands in commands.ts, markup in
  // CommandPalette. `paletteReturn` restores the pre-palette control on close.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Global designer assistant: Shell owns `open` so the palette can summon it;
  // `ChatDock` owns the button + slide-over and the transcript lives in
  // chatStore, so it survives view switches and refreshes.
  const [chatOpen, setChatOpen] = useState(false);
  const paletteReturn = useRef<HTMLElement | null>(null);
  function togglePalette(): void {
    if (!paletteOpen) {
      const a = document.activeElement;
      paletteReturn.current = a instanceof HTMLElement && a !== document.body ? a : null;
      // The off-canvas menu paints above the palette; it must not stay open.
      setMenuOpen(false);
    }
    setPaletteOpen(!paletteOpen);
  }
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  useEffect(() => {
    if (paletteOpen) return;
    const back = paletteReturn.current;
    paletteReturn.current = null;
    if (back) {
      if (back.isConnected) back.focus();
      else document.getElementById("view")?.focus();
    }
  }, [paletteOpen]);
  const [isLight, setIsLight] = useState(() => document.documentElement.dataset.theme === "light");
  const toggleTheme = useCallback(() => {
    const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("mesh-theme", cur);
    // The browser's own chrome follows the top bar's ground (index.html writes the first one).
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--bg-2").trim());
    setIsLight(cur === "light");
  }, []);
  // The help panel scrolled its own close control off the top (measured at 360: y = -136 after scrolling 400). A real title
  // row, the one every other panel uses, stays at the top of the panel while the text under it moves.
  const openHelp = useCallback(() => openDrawer(
    <><DrawerHead onClose={closeDrawer}>Help</DrawerHead><Help /></>,
  ), [openDrawer, closeDrawer]);

  // The mission's controls (useMissionActions.ts): the bar, the Overview and the keyboard all go through the same functions.
  const missionActions = useMissionActions();
  const inboxView: View = decisions === 0 && toolRequests > 0 ? "gates" : "escalations";
  const runAction = (a: MissionAction): void => missionActions.run(a, { inboxView });
  const ACTION_ICON: Record<MissionAction, IconName> = { start: "play", pause: "pause", resume: "play", reopen: "undo", review: "inbox", settings: "sliders", agents: "agents", designer: "designer" };

  // Global palette commands: every view, help, and one "jump to agent" per
  // agent. Picking an agent only leaves a pending id in commands.ts and asks
  // the Designer to open; it never touches Designer state from here.
  useEffect(() => {
    register("global", [
      ...KEY_VIEWS.filter((v) => (isHostView(v) ? kind === "host" || kind === "empty-host" : kind !== "empty-host")).map((v, i) => {
        const nav = NAV_ITEMS.find((n) => n.view === v);
        return {
          id: `go.${v}`,
          label: `Go to ${nav?.label ?? v}`,
          keywords: `view navigate ${v} ${i + 1}`,
          scope: "global",
          run: () => setView(v),
        };
      }),
      { id: "help.open", label: "Open help", keywords: "keyboard shortcuts keys ?", scope: "global", run: openHelp },
      { id: "chat.ask", label: "Ask the designer", keywords: "chat assistant mesh config propose", scope: "global", run: () => setChatOpen(true) },
      ...(status?.agents || [])
        .filter((a: any) => a.id && a.id !== "human")
        .map((a: any) => ({
          id: `agent.${a.id}`,
          label: `Jump to agent: ${a.id}`,
          keywords: `search agent open ${a.id} ${a.role || ""} ${a.lifecycle || ""}`,
          scope: "global",
          run: () => { setPendingAgent(a.id); setView("designer"); },
        })),
    ]);
    return () => unregister("global");
  }, [setView, openHelp, status, kind]);

  // The authoritative key router. Registered once (empty deps) so it stays
  // ahead of the view-local handlers that mount later; it reads the latest
  // render through a ref. View-local owners bail on `defaultPrevented`, so
  // exactly one layer closes per Esc no matter which listener runs first.
  const onKeyRef = useRef<(ev: KeyboardEvent) => void>(() => {});
  const handleKey = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented) return;
    // ⌘K/Ctrl+K works from anywhere, including inside an input.
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      togglePalette();
      return;
    }
    // Bare letters and digits are shortcuts only without a chord modifier:
    // Ctrl+P / Ctrl+T / Ctrl+1 belong to the browser or the OS. Shift stays
    // available for shifted characters like "?" and "/".
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // The open palette owns every other key: view hotkeys, pause/resume,
    // help and the search slash must not fire behind it. The input handles
    // arrows/Enter/Tab itself.
    if (paletteOpen) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        setPaletteOpen(false);
      }
      return;
    }
    const t = ev.target as HTMLElement;
    if (t.matches("input, textarea, select")) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        t.blur();
      }
      return;
    }
    // An open panel is aria-modal, so it owns the keyboard exactly as the
    // palette does: view digits, theme, pause/resume and the search slash must
    // not reach the page behind the scrim. `/` was the worst of them -- it
    // focuses #ev-search / #step-search, which live in #view, invisible under
    // the scrim and outside the drawer's Tab trap, so keystrokes went into a
    // field the user could not see and the next Tab yanked them back.
    //
    // This sits BELOW the text-input guard on purpose: above it, Esc inside the
    // drawer's own fields (send-to, send-note, appr-comment) would tear down
    // the drawer and discard a half-typed message instead of blurring.
    //
    // An `event` detail is deliberately excluded: it is not modal. The events
    // console renders it in a pane beside a list that keeps scrolling, with
    // nothing over the page. Swallowing every key here for as long as an event
    // stayed selected would be exactly the wrong trade on the one page an
    // operator keeps open while a run is live -- `/` and the view keys have to
    // keep working with a selection up.
    const modalDetail = !!detail && detail.kind !== "event";
    if (drawerDepth > 0 || modalDetail) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (drawerDepth > 0) closeDrawer();
        else closeDetail();
      }
      return;
    }
    // Mirrors `viewKey`: only the reachable nine, so the table cannot claim a
    // binding for a key this handler can never be handed.
    const map: Record<string, View> = Object.fromEntries(KEY_VIEWS.slice(0, 9).map((v, i) => [String(i + 1), v]));
    if (map[ev.key]) return setView(map[ev.key]);
    // Esc unwinds exactly one layer. A modal panel is innermost and claims it
    // in the guard above; below that the order is the non-modal event pane,
    // then focus mode, then the off-canvas menu. Local handlers (Designer
    // menu/inspector, wire cancel) run only when none of those claimed the key.
    if (ev.key === "Escape") {
      // Only an event detail can still be open here -- the modal kinds returned
      // above -- and closing it is what Esc should mean on the console.
      if (detail) { ev.preventDefault(); closeDetail(); return; }
      if (focusOn) { ev.preventDefault(); setFocusMode(false); return; }
      if (menuOpen) { ev.preventDefault(); setMenuOpen(false); return; }
      // A modal drawer/detail is handled by the guard above, which returns
      // before this branch whenever one is open.
      return;
    }
    if (ev.key === "?") return openHelp();
    if (ev.key === "t") toggleTheme();
    // Only when the mission is in a state where the key means something: it used to post a pause to a delivered mission.
    if (ev.key === "p" && !hostLevel && state.primary?.action === "pause") void missionActions.pause();
    if (ev.key === "r" && !hostLevel && state.primary?.action === "resume") void missionActions.resume(true);
    if (ev.key === "/") {
      ev.preventDefault();
      const s = document.getElementById("ev-search") || document.getElementById("step-search");
      if (s) s.focus();
    }
  };
  useEffect(() => {
    onKeyRef.current = handleKey;
  });
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => onKeyRef.current(ev);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening the off-canvas menu should put the keyboard in it; closing it must
  // hand focus back to ☰ rather than dropping it on <body>.
  //
  // The `else` branch cannot fire on first render. It reads "menu is closed and
  // focus is on body", which is also the state of every fresh page load at
  // narrow width -- so it used to steal focus to ☰ before the user had touched
  // anything. That is an unexpected focus change on load, and it lands PAST the
  // skip link in DOM order, putting the one control that exists to bypass the
  // chrome behind the user where no forward Tab can reach it. Only hand focus
  // back after a menu we actually opened has closed.
  const menuWasOpen = useRef(false);
  useEffect(() => {
    if (!narrow) return;
    if (menuOpen) {
      menuWasOpen.current = true;
      // Land on where you are rather than the top of the list; the close control is one Shift+Tab away.
      const root = document.getElementById("sidebar");
      (root?.querySelector<HTMLElement>(".tab.active") ?? root?.querySelector<HTMLElement>(".tab"))?.focus();
    } else if (menuWasOpen.current) {
      menuWasOpen.current = false;
      const active = document.activeElement;
      if (active === document.body || (active instanceof HTMLElement && active.closest("#sidebar"))) {
        document.getElementById("btn-menu")?.focus();
      }
    }
  }, [menuOpen, narrow]);

  // A view change made from inside the page — "All steps", a turn row, the doors under a ledger — removes the control that was
  // pressed, so the browser drops focus on <body> and the next Tab starts at the top of the shell: the person who asked for Steps
  // walks the whole top bar and every sidebar tab again to reach the list they clicked for. When a change lands with nothing
  // focused, focus goes to the new page's own heading, which a screen reader reads out as the page's name. A change made from the
  // sidebar keeps its focus on the tab (and the off-canvas menu hands it back to ☰), so that path is untouched.
  const lastView = useRef(view);
  useEffect(() => {
    if (lastView.current === view) return;
    lastView.current = view;
    if (document.activeElement !== document.body) return;
    const root = document.getElementById("view");
    // The sr-only h1 is not a landing place: the page's own h2 is what a person sees at the top of what they asked for.
    const head = root?.querySelector<HTMLElement>("h2") ?? null;
    if (head?.hasAttribute("tabindex")) head.focus({ preventScroll: true });
    else root?.focus({ preventScroll: true });
  }, [view]);

  // Tab stays inside the navigation sheet. Everything else is inert, so the only way out was the browser's chrome and a
  // focus landing on <body>; a modal layer should cycle its own controls.
  useEffect(() => {
    if (!navModal) return;
    const root = document.getElementById("sidebar");
    if (!root) return;
    const onTab = (ev: KeyboardEvent) => {
      if (ev.key !== "Tab") return;
      const items = focusables(root);
      if (!items.length) return;
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const act = document.activeElement;
      if (!(act instanceof HTMLElement) || act === document.body || !root.contains(act)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
        return;
      }
      if (ev.shiftKey && act === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && act === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onTab, true);
    return () => document.removeEventListener("keydown", onTab, true);
  }, [navModal]);

  // The deep-linked detail is the bottom panel layer; anything the user drills
  // into from there stacks on top of it.
  //
  // Spelled out per kind rather than as a two-branch ternary, because `event`
  // is a detail kind with no drawer at all: the events console reads `detail`
  // itself and renders the event in its own right-hand pane. A trailing `else`
  // here would hand an event seq to <AgentDrawer> and float it over the console.
  const detailNode = !detail
    ? null
    : detail.kind === "step"
      ? <StepDrawer turnId={detail.id} steps={steps || []} routed />
      : detail.kind === "agent"
        ? <AgentDrawer id={detail.id} />
        : null;
  const panel = drawer ?? detailNode;
  const panelDepth = drawerDepth + (detailNode ? 1 : 0);
  const popPanel = (): void => {
    if (drawerDepth > 0) closeDrawer();
    else closeDetail();
  };

  // The panel is a stack, so focus has to be a stack too: every push remembers
  // the control that opened that level, and every pop hands focus straight
  // back to it. Restoring only when the whole stack empties would strand a
  // keyboard user at the top of the page after each Esc.
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const returnStack = useRef<Array<HTMLElement | null>>([]);
  const prevDepth = useRef(0);
  useEffect(() => {
    const prev = prevDepth.current;
    prevDepth.current = panelDepth;
    if (panelDepth > prev) {
      // Focus has not moved yet — the invoking control is still active.
      const opener = document.activeElement;
      const back = opener instanceof HTMLElement && opener !== document.body ? opener : null;
      for (let i = prev; i < panelDepth; i++) returnStack.current.push(back);
      const root = drawerRef.current;
      if (root) (focusables(root)[0] ?? root).focus();
      return;
    }
    if (panelDepth < prev) {
      // Unwind every level that closed; the last one popped is the opener of
      // the shallowest closed level, i.e. where the user actually came from.
      let back: HTMLElement | null = null;
      for (let i = prev; i > panelDepth; i--) back = returnStack.current.pop() ?? null;
      if (panelDepth > 0) {
        // Still inside the stack: land on the panel that is now on top.
        const root = drawerRef.current;
        if (root) (focusables(root)[0] ?? root).focus();
        return;
      }
      if (back && back.isConnected) back.focus();
      else document.getElementById("view")?.focus();
    }
  }, [panelDepth]);

  // Register the panel as a Tab trap for as long as it is open. Keyed on the
  // BOOLEAN, not the depth: a push/pop on every depth change would re-order the
  // stack and hand ownership back to the drawer whenever a nested panel opened
  // over it.
  const panelOpen = panelDepth > 0;
  useEffect(() => {
    const root = drawerRef.current;
    if (!root || !panelOpen) return;
    return pushTrap(root);
  }, [panelOpen]);

  // Tab cycles inside the open panel. Without this the next Tab walks into the
  // sidebar behind the scrim, which is visually unreachable.
  useEffect(() => {
    if (panelDepth === 0 || paletteOpen) return;
    const onTab = (ev: KeyboardEvent) => {
      if (ev.key !== "Tab") return;
      const root = drawerRef.current;
      if (!root) return;
      // A dialog opened OVER the panel (confirm, palette) is the innermost
      // layer and owns Tab; this trap must stand down or the two fight on the
      // same event and focus pins to whichever ran last.
      if (!isTopTrap(root)) return;
      const items = focusables(root);
      if (!items.length) {
        ev.preventDefault();
        root.focus();
        return;
      }
      const first = items[0] as HTMLElement;
      const last = items[items.length - 1] as HTMLElement;
      const act = document.activeElement;
      if (!(act instanceof HTMLElement) || !root.contains(act)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
        return;
      }
      if (ev.shiftKey && act === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && act === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onTab, true);
    return () => document.removeEventListener("keydown", onTab, true);
    // paletteOpen: the command palette does not use useDismissable, so it is
    // not on the trap stack; without bailing on it, Ctrl+K over an open panel
    // leaks every Tab back into the panel behind the palette.
  }, [panelDepth, paletteOpen]);

  const closeMenu = () => setMenuOpen(false);

  /* The overflow menu: what is not worth a permanent button. A phone gets the actions that no longer fit the bar; every
   * screen gets the rare and the dangerous ones, with the destructive one set apart at the end. */
  const openMessage = (): void => openDrawer(<MessageDrawer />);
  const notify = useNotify();
  const primary = state.primary;
  // The bar's one primary action (Continue, Pause, Answer) does not fit a phone's single row beside the menu, the state and
  // what is waiting on you. It moves to the top of this menu rather than out of reach at the foot of the page.
  const barPrimary = !!primary && view !== "overview" && !barActionIsHere(primary.action, view, inboxView);
  const moreItems: MenuItem[] = [];
  if (phone && barPrimary && primary) {
    moreItems.push({ id: `mi-${primary.action}`, icon: ACTION_ICON[primary.action], label: primary.label, title: primary.hint, onClick: () => runAction(primary.action) });
  }
  if (phone) moreItems.push({ id: "mi-message", icon: "message", label: "Message an agent", title: "Send a message as the human: highest priority", onClick: openMessage });
  moreItems.push({ id: "btn-approval", icon: "approve", label: "Approve or reject…", title: "Approve or reject something (release, design, quality…)", onClick: () => openDrawer(<ApprovalDrawer />) });
  for (const c of state.secondary) {
    moreItems.push({ id: `mi-${c.action}`, icon: ACTION_ICON[c.action], label: c.label, title: c.hint, onClick: () => runAction(c.action) });
  }
  // Not offered where it cannot work (no Notification, an http address): the Needs you page says why, and the tab still carries it.
  if (notify.view.press) moreItems.push({ id: "mi-notify", icon: "bell", label: notify.view.label, title: notify.view.hint, onClick: notify.press });
  if (phone) moreItems.push({ id: "mi-designer", icon: "spark", label: "Ask the designer", onClick: () => setChatOpen(true) });
  if (goalId) {
    moreItems.push({ id: "btn-reset", icon: "trash", label: "Reset mission to zero…", title: "Wipe all mission data and restart the goal from zero", danger: true, separated: true, onClick: () => void missionActions.reset() });
  }
  const spentRatio = ratioOf(mission?.consumed ?? 0, mission?.limit ?? 0);
  const spentTone = budgetTone(spentRatio);
  // A mesh must declare a goal, so a status that has none is a project that answered before it finished reading its log:
  // "No goal" here said the mesh had nothing to do, beside a chip that said it was starting. Only a mission on its way is
  // "loading": beside "Closed" or "Offline" the chip says it all, and "Loading the mission…" there was not true.
  const goalTitle = goal.description
    ? goal.description.split("\n")[0].slice(0, 90)
    : state.phase === "loading" ? (status ? "Loading the mission…" : "Connecting…") : "";

  return (
    <div id="app" className={`${focusOn ? "focus-mode" : ""}${hasProjects ? " with-tabs" : ""}`}>
      {/* WCAG 2.4.1. Roughly 20 chrome tab stops -- the project strip, the nav
          buttons, the sidebar footer, the topbar -- sit ahead of the content on
          every single view, with no way past them.

          A fragment href is NOT usable here: #view is not a route, and
          parseHash() would read it as { projectId: null, view: "overview" },
          bouncing the user to Overview and dropping any open detail. Move
          focus directly and leave the hash alone. #view is already
          tabIndex={-1} and already has a :focus-visible ring, so it can
          receive focus and says so when it does. */}
      <button type="button" className="skip-link" inert={navModal || undefined} onClick={() => document.getElementById("view")?.focus()}>
        Skip to content
      </button>
      {/* Host-level, so it sits above the per-project chrome and survives every
          project switch. Rendered only under a ProjectsProvider: `curule serve`
          runs one mesh with no registry and has no tabs to show. */}
      {hasProjects ? <ProjectTabs parked={parked} parkedId={mesh.projectId} inert={navModal} /> : null}
      {navModal ? <div id="nav-scrim" aria-hidden="true" onClick={closeMenu} /> : null}
      {/* A div, not an <aside>: the off-canvas sheet is a modal dialog, and `role="dialog"` on an <aside> is a role ARIA in HTML
          does not allow there (axe: `aria-allowed-role`, one node, every time the phone menu was open). A div carries the same
          two roles honestly — the complementary landmark a wide screen has always shown, and the dialog a phone gets. */}
      <div
        id="sidebar"
        className={menuOpen ? "open" : ""}
        inert={sidebarHidden}
        aria-hidden={sidebarHidden || undefined}
        role={narrow ? "dialog" : "complementary"}
        aria-modal={navModal || undefined}
        aria-label={narrow ? "Navigation" : undefined}
      >
        {narrow ? (
          <div className="side-head">
            <span className="side-head-title">Menu</span>
            <button type="button" className="close-x" aria-label="Close navigation" title="Close (Esc)" onClick={closeMenu}>
              <Icon name="x" size={16} />
            </button>
          </div>
        ) : null}
        <div className="brand">
          <Wordmark height={22} />
          <span id="mesh-id" className="sub" title={goal.id ? `Goal ${goal.id}` : undefined}>{goal.id ? goal.id.slice(0, 14) : ""}</span>
        </div>
        {/* The palette was chord-only: the fastest route to every view, agent and action in the product, discoverable
            solely by already knowing it existed. */}
        <button id="btn-palette" type="button" className="side-search" title="Search views, agents and actions" aria-keyshortcuts="Meta+K Control+K" onClick={togglePalette}>
          <Icon name="search" size={18} /><span>Search</span><Kbd keys="mod+k" />
        </button>
        <nav id="nav" aria-label="views">
          {NAV.filter((g) => showsSection(kind, g.section)).map((group) => (
            <div className="nav-group" role="group" aria-label={group.section} key={group.section}>
              <div className="nav-label" aria-hidden="true">{group.section}</div>
              {group.items.map((n) => {
                const badge = n.view === "escalations" ? decisions : n.view === "gates" ? toolRequests : 0;
                const key = viewKey(n.view);
                return (
                  <button key={n.view} data-view={n.view} className={`tab${view === n.view ? " active" : ""}`} aria-current={view === n.view ? "page" : undefined}
                    title={key ? `${n.title} (key ${key})` : n.title} onClick={() => { setView(n.view); closeMenu(); }}>
                    <Icon name={n.icon} size={18} />
                    <span className="tab-label">{n.label}</span>
                    {badge > 0 ? <em className="nav-badge" id={n.view === "escalations" ? "esc-badge" : undefined} title={`${badge} waiting on you`}>{badge}</em> : null}
                    {key ? <kbd className="tab-key" aria-hidden="true">{key}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <IconButton id="btn-theme" icon={isLight ? "moon" : "sun"} label={isLight ? "Switch to the dark theme" : "Switch to the light theme"} keys="t" onClick={toggleTheme} />
          <IconButton id="btn-help" icon="help" label="Keyboard shortcuts and help" keys="?" onClick={openHelp} />
          {auth?.required ? <IconButton id="btn-signout" icon="sign-out" label="Sign out" title="Sign out: end this browser's session on the server" onClick={auth.signOut} /> : null}
        </div>
      </div>

      <header id="topbar" className={hostLevel ? "bare" : undefined} inert={navModal || undefined}>
        <Button id="btn-menu" variant="ghost" aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" size={18} /></Button>
        {hostLevel ? null : (
          <>
          <span className={`mission-chip ${chipTone}`} role="status" title={chipTitle}>
            <i className={`dot${state.pulse && !reconnecting ? " pulse" : ""}`} aria-hidden="true" />{chipLabel}
          </span>
          <div id="goal-strip">
            <div className="goal-text">
              <strong id="top-goal" title={goal.description || undefined}>{goalTitle}</strong>
              <span id="top-criteria" className="muted">
                {goal.status ? `${done} of ${plural(critTotal, "check")} done` : ""}{parked && state.phase !== "parked" && state.phase !== "ceiling" && state.phase !== "offline" && goal.status ? " · project is parked" : ""}
              </span>
            </div>
          </div>
          <div className="bar-strip" role="group" aria-label="mission telemetry">
            <div className="bar-strip-stat agents" title="Agents mid-turn right now"><span className="k">Working</span><b>{facts.working > 0 ? <i className="live" aria-hidden="true" /> : null}{facts.working}</b></div>
            <div className="bar-strip-stat spent" title="Tokens spent out of the mission budget">
              <span className="k">Tokens</span>
              <b>{fmt(mission?.consumed ?? 0)}{mission?.limit ? <span className="of"> / {fmt(mission.limit)}</span> : null}</b>
              {mission?.limit ? (
                <span className={`meter${spentTone === "ok" ? "" : ` ${spentTone}`}`} style={{ "--p": spentRatio } as React.CSSProperties}
                  role="meter" aria-label="Mission tokens spent" aria-valuemin={0} aria-valuemax={mission.limit} aria-valuenow={Math.min(mission.consumed ?? 0, mission.limit)}
                  aria-valuetext={`${fmt(mission.consumed ?? 0)} of ${fmt(mission.limit)} tokens`} />
              ) : null}
            </div>
          </div>
          <div className="top-actions">
            {/* The Overview's hero carries this same action, so the bar does not repeat it there. */}
            {primary && view !== "overview" && !barActionIsHere(primary.action, view, inboxView) && !phone ? (
              <Button id={`btn-${primary.action}`} variant={primary.action === "pause" ? "soft" : "primary"} icon={ACTION_ICON[primary.action]} title={primary.hint} onClick={() => runAction(primary.action)}>
                {primary.label}
              </Button>
            ) : null}
            {/* Anything waiting on the operator stays one click away from every page, whatever the mission is doing. When the
                primary action is already "review" it is that button, so this one stands down. */}
            {inbox > 0 && primary?.action !== "review" && view !== inboxView ? (
              <Button id="btn-inbox" variant="soft" icon="inbox" title={`${inbox} waiting on you`} aria-label={`Needs you: ${inbox} waiting on you`} onClick={() => setView(inboxView)}>
                <span className="act-lbl">Needs you</span><b className="count">{inbox}</b>
              </Button>
            ) : null}
            {phone ? null : (
              <Button id="btn-message" variant="soft" icon="message" title="Send a message as the human: highest priority" onClick={openMessage}>
                <span className="act-lbl">Message</span>
              </Button>
            )}
            {phone ? null : <ChatDockButton open={chatOpen} onToggle={() => setChatOpen(!chatOpen)} />}
            <Menu id="btn-more" label={<Icon name="more" size={18} />} title="More actions" items={moreItems} />
          </div>
          </>
        )}
      </header>

      {/* Focus mode is shell-owned state; the view tree reads it through this seam. */}
      <FocusCtx.Provider value={focusValue}>
        <main id="view" tabIndex={-1} inert={navModal || undefined}>
          {/* Every view renders its own <h2> title, so without this the document
              outline started at h2 and had no root. There is no brand element in
              the topbar to promote -- the bar is already at its width budget --
              so the h1 is offscreen: it anchors the outline for a screen reader
              without adding chrome nobody asked for. */}
          <h1 className="sr-only">Curule console</h1>
          {serverDown ? (
            <Banner tone="bad" className="server-banner" title="Server not responding."
              actions={<Button variant="banner-act" icon="refresh" onClick={() => void refreshStatus()}>Retry now</Button>}>
              Showing the last known state, which may be stale. Is the mesh process still running?
            </Banner>
          ) : null}
          {hasProjects ? <LicenseBanner onOpen={() => setView("hostsettings")} /> : null}
          {/* Host settings is the one view that outranks the empty state: its
              keys are host-wide, they already have values nobody chose, and an
              operator with no project open is exactly who should be able to set
              a spend ceiling *before* opening one. Every other view really does
              need a project, so they still get the empty state. */}
          {registry === "failed" ? (
            <RegistryDown page={askedPage} onRetry={() => void projectsCtx?.refreshProjects()} />
          ) : registryPending ? <ViewLoading /> : noProjects && view !== "hostsettings" ? <HostEmptyState /> : holdView ? <ProjectStarting name={projectName} /> : viewNode}
        </main>
      </FocusCtx.Provider>

      {/* The thumb's row. It is the same five places at 320 and at 768, each a whole tab (icon, name, count) rather than a glyph to
          learn, and it is inert while the menu is a layer over the page. The menu still holds every page: this row is the route the
          owner takes daily, not a second navigation. */}
      {showDock ? (
        <nav id="dock" aria-label="Where the work lives" inert={navModal || undefined}>
          {DOCK_VIEWS.map((v) => {
            const n = NAV_ITEMS.find((item) => item.view === v)!;
            const here = view === v;
            const waiting = v === "escalations" ? inbox : 0;
            const name = waiting > 0 ? `${n.label}: ${waiting} waiting on you` : n.label;
            return (
              <button key={v} type="button" className={`dock-tab${here ? " active" : ""}`} aria-current={here ? "page" : undefined}
                aria-label={name} title={n.title} data-view={v} onClick={() => setView(v)}>
                <Icon name={n.icon} size={20} />
                <span className="dock-label" aria-hidden="true">{n.label}</span>
                {waiting > 0 ? <em className="dock-badge" aria-hidden="true">{waiting > 99 ? "99+" : waiting}</em> : null}
              </button>
            );
          })}
        </nav>
      ) : null}

      {panel !== null && (
        <>
          <div id="drawer" className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-label="Details panel" tabIndex={-1} ref={drawerRef}>
            {panelDepth > 1 ? <Button variant="ghost" icon="chevron-right" extra="drawer-back" onClick={popPanel} title="Back to the previous panel (Esc)">Back</Button> : null}
            <div id="drawer-body">{panel}</div>
          </div>
          <div id="scrim" aria-hidden="true" onClick={popPanel} />
        </>
      )}
      {paletteOpen && (
        <>
          <div id="palette-scrim" aria-hidden="true" onClick={closePalette} />
          <CommandPalette onClose={closePalette} look={lookOf} groups={PALETTE_GROUPS} />
        </>
      )}
      <ChatDock open={chatOpen} onClose={() => setChatOpen(false)} />
      <AttentionEffects projectId={mesh.projectId} projectName={projectName} />
      <div id="toasts" aria-live="polite" inert={navModal || undefined}>
        {toasts.map((t) => (
          <ToastCard key={t.id} kind={t.kind} title={t.title} msg={t.msg} count={t.count} action={t.action} onDismiss={() => dismissToast(t.id)} />
        ))}
      </div>
    </div>
  );
}
