import { useEffect } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fmt, mandatoryProgress, plural } from "./format";
import { useMesh, type View } from "./store";
import { CloseX, MessageDrawer, ApprovalDrawer, StepDrawer, AgentDrawer } from "./drawers";
// The shell keeps its own stack-aware trap (drawer over drawer), but it must
// agree with every other dialog about what "focusable" means.
import { Banner, Button, EmptyState, IconButton, Menu, Wordmark, focusables, isTopTrap, pushTrap, type MenuItem } from "./components";
import { Icon, type IconName } from "./icons";
import { documentTitle, type MissionAction } from "./mission";
import { useMission } from "./useMission";
import { useMissionActions } from "./useMissionActions";
import { useToolRequests } from "./inbox";
import { list, register, setPendingAgent, unregister, getVersion, subscribe, type Command } from "./commands";
import { paletteMatches, pointerMoved } from "./palette";
import { ViewLoading } from "./viewboundary";
import { HostEmptyState, ProjectTabs } from "./tabs";
import { useProjectsOptional } from "./projects";
import { holdsForProject, isHostView, serverKind, showsSection } from "./navmodel";
import ChatDock, { ChatDockButton } from "./designer/ChatDock";
import { useAuthOptional } from "./auth";
import { LicenseBanner } from "./license";

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

/** ⌘K/Ctrl+K palette. Lists whatever `commands.ts` holds right now, so the
 *  Designer's commands appear only while it is mounted. The input keeps the
 *  focus (Tab is trapped) and the shell owns Escape for everything that routes
 *  through handleKey, so one dispatch order closes palette → focus → panel.
 *  The exception is any overlay built on useDismissable (the Designer's checks
 *  popover): it listens on document in the CAPTURE phase and stops Escape
 *  before the shell's window listener sees it. That is deliberate — the
 *  innermost open layer should claim the key. */
function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Re-list when a scope registers/unregisters: a view can unmount while the
  // palette is open (browser Back), and its commands must vanish with it.
  // Re-render on every registry change; `list()` is a cheap pure read of the
  // module registry, so the snapshot is taken directly at render time.
  useSyncExternalStore(subscribe, getVersion);
  const matches = paletteMatches(list(), q);
  const active = Math.min(sel, Math.max(0, matches.length - 1));
  const activeId = matches[active]?.id;
  // Where the mouse was last seen over the list: a row takes the selection only when the mouse has moved (palette.ts).
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const choose = (c: Command | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  // Keyed on the selection and the query, not the list: the registry is rebuilt on every status poll, and scrolling on each one
  // pulled a list the person had scrolled with the wheel back to the selected row every few seconds.
  useEffect(() => {
    if (activeId) document.getElementById(`palette-opt-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, q]);
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[active]);
    }
  };
  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette"
      onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
      <input ref={inputRef} className="palette-input" role="combobox" aria-label="Search commands" aria-autocomplete="list"
        aria-expanded="true" aria-controls="palette-list"
        aria-activedescendant={activeId ? `palette-opt-${activeId}` : undefined}
        placeholder="Type a command or agent…" value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey} />
      <ul id="palette-list" className="palette-list" role="listbox" aria-label="commands">
        {matches.map((c, i) => (
          <li key={c.id} id={`palette-opt-${c.id}`} role="option" aria-selected={i === active}
            className={`palette-item${i === active ? " on" : ""}`}
            onMouseMove={(e) => {
              const at = { x: e.clientX, y: e.clientY };
              if (pointerMoved(pointer.current, at)) setSel(i);
              pointer.current = at;
            }}
            onClick={() => choose(c)}>
            <span className="palette-label">{c.label}</span>
            {c.scope !== "global" ? <span className="palette-scope">{c.scope}</span> : null}
          </li>
        ))}
        {!matches.length ? <li className="palette-none">No matching commands.</li> : null}
      </ul>
      <div className="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> navigate <kbd>↵</kbd> run <kbd>esc</kbd> close</div>
    </div>
  );
}

export function Shell({ viewNode }: { viewNode: React.ReactNode }): React.JSX.Element {
  const mesh = useMesh();
  const { view, setView, status, goalId, toasts, drawer, drawerDepth, openDrawer, closeDrawer, toast, refreshStatus, serverDown, sseState, detail, closeDetail, steps, client, confirm } = mesh;
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
  const registryPending = projectsCtx != null && projectsCtx.hasRegistry === null;
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
  const toolRequests = useToolRequests(client, !serverDown && !noProjects && !registryPending && !holdView);
  const inbox = decisions + toolRequests;
  // The connection is a separate fact from the mission. A mission that is running over a dropped connection is not "running".
  const reconnecting = !serverDown && sseState === "reconnecting";
  const chipTone = reconnecting ? "warn" : state.tone;
  const chipLabel = reconnecting ? "Reconnecting" : state.label;
  const chipTitle = reconnecting ? "Connection lost: reconnecting. What you see may be stale." : state.headline;

  // A mission waiting on you is the one thing worth a glance at a background tab, so the count leads the title.
  useEffect(() => {
    document.title = hostLevel
      ? documentTitle({ phaseLabel: noProjects ? null : "Projects", decisions: 0, project: null })
      : documentTitle({ phaseLabel: status ? chipLabel : null, decisions: inbox, project: projectName });
  }, [hostLevel, noProjects, status, chipLabel, inbox, projectName]);

  const [menuOpen, setMenuOpen] = useState(false);
  const narrow = useNarrow();
  const phone = useMedia(PHONE);
  // Hidden off-canvas, so it must leave the tab order and the a11y tree too.
  const sidebarHidden = narrow && !menuOpen;
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
    setIsLight(cur === "light");
  }, []);
  const openHelp = useCallback(() => openDrawer(
    <><Help /><CloseX extra="close-x-float" /></>,
  ), [openDrawer]);

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
      document.querySelector<HTMLElement>("#sidebar .tab")?.focus();
    } else if (menuWasOpen.current && document.activeElement === document.body) {
      menuWasOpen.current = false;
      document.getElementById("btn-menu")?.focus();
    }
  }, [menuOpen, narrow]);

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
  const moreItems: MenuItem[] = [];
  if (phone) moreItems.push({ id: "mi-message", icon: "message", label: "Message an agent", title: "Send a message as the human: highest priority", onClick: openMessage });
  moreItems.push({ id: "btn-approval", icon: "approve", label: "Approve or reject…", title: "Approve or reject something (release, design, quality…)", onClick: () => openDrawer(<ApprovalDrawer />) });
  for (const c of state.secondary) {
    moreItems.push({ id: `mi-${c.action}`, icon: ACTION_ICON[c.action], label: c.label, title: c.hint, onClick: () => runAction(c.action) });
  }
  if (phone) moreItems.push({ id: "mi-designer", icon: "spark", label: "Ask the designer", onClick: () => setChatOpen(true) });
  if (goalId) {
    moreItems.push({ id: "btn-reset", icon: "trash", label: "Reset mission to zero…", title: "Wipe all mission data and restart the goal from zero", danger: true, separated: true, onClick: () => void missionActions.reset() });
  }
  const primary = state.primary;
  const spentRatio = mission?.limit ? Math.min(1, (mission.consumed ?? 0) / mission.limit) : 0;
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
      <button type="button" className="skip-link" onClick={() => document.getElementById("view")?.focus()}>
        Skip to content
      </button>
      {/* Host-level, so it sits above the per-project chrome and survives every
          project switch. Rendered only under a ProjectsProvider: `curule serve`
          runs one mesh with no registry and has no tabs to show. */}
      {hasProjects ? <ProjectTabs parked={parked} parkedId={mesh.projectId} /> : null}
      <aside id="sidebar" className={menuOpen ? "open" : ""} inert={sidebarHidden} aria-hidden={sidebarHidden || undefined}>
        <div className="brand">
          <Wordmark height={22} />
          <span id="mesh-id" className="sub">{goal.id ? `goal ${goal.id.slice(0, 14)}` : ""}</span>
        </div>
        {/* The palette was chord-only: the fastest route to every view, agent and action in the product, discoverable
            solely by already knowing it existed. */}
        <button id="btn-palette" type="button" className="side-search" title="Search views, agents and actions (⌘K / Ctrl K)" aria-keyshortcuts="Meta+K Control+K" onClick={togglePalette}>
          <Icon name="search" /><span>Search</span><kbd>⌘K</kbd>
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
          <IconButton id="btn-theme" icon={isLight ? "moon" : "sun"} label={isLight ? "Switch to the dark theme" : "Switch to the light theme"} onClick={toggleTheme} />
          <IconButton id="btn-help" icon="help" label="Keyboard shortcuts and help" title="Keyboard shortcuts and help (?)" onClick={openHelp} />
          {auth?.required ? <IconButton id="btn-signout" icon="sign-out" label="Sign out" title="End this browser's session on the server" onClick={auth.signOut} /> : null}
        </div>
      </aside>

      <header id="topbar" className={hostLevel ? "bare" : undefined}>
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
            <div className="bar-strip-stat agents" title="Agents mid-turn right now"><b>{facts.working}</b><span>working</span></div>
            <div className="bar-strip-stat spent" title="Tokens spent out of the mission budget">
              <b>{fmt(mission?.consumed ?? 0)}<span className="muted">/{fmt(mission?.limit ?? 0)}</span></b>
              <span>tokens</span>
              <i className={`meter${spentRatio >= 0.95 ? " bad" : spentRatio >= 0.8 ? " warn" : ""}`} style={{ "--p": spentRatio } as React.CSSProperties} aria-hidden="true" />
            </div>
          </div>
          <div className="top-actions">
            {/* The Overview's hero carries this same action, so the bar does not repeat it there. */}
            {primary && view !== "overview" ? (
              <Button id={`btn-${primary.action}`} variant={primary.action === "pause" ? "soft" : "primary"} icon={ACTION_ICON[primary.action]} title={primary.hint} onClick={() => runAction(primary.action)}>
                {primary.label}
              </Button>
            ) : null}
            {/* Anything waiting on the operator stays one click away from every page, whatever the mission is doing. When the
                primary action is already "review" it is that button, so this one stands down. */}
            {inbox > 0 && primary?.action !== "review" ? (
              <Button id="btn-inbox" variant="soft" icon="inbox" title={`${inbox} waiting on you`} onClick={() => setView(inboxView)}>
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
        <main id="view" tabIndex={-1}>
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
          {registryPending ? <ViewLoading /> : noProjects && view !== "hostsettings" ? <HostEmptyState /> : holdView ? <ProjectStarting name={projectName} /> : viewNode}
        </main>
      </FocusCtx.Provider>

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
          <CommandPalette onClose={closePalette} />
        </>
      )}
      <ChatDock open={chatOpen} onClose={() => setChatOpen(false)} />
      <div id="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <b>{t.title}{t.count && t.count > 1 ? <span className="toast-n">×{t.count}</span> : null}</b>
            <span className="toast-msg">{t.msg}</span>
            {t.action ? <button type="button" className="toast-act" onClick={t.action.run}>{t.action.label}</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
