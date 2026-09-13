import { useEffect } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fmt, mandatoryProgress, RUNNING } from "./format";
import { useMesh, type View } from "./store";
import { CloseX, MessageDrawer, ApprovalDrawer, StepDrawer, AgentDrawer } from "./drawers";
// The shell keeps its own stack-aware trap (drawer over drawer), but it must
// agree with every other dialog about what "focusable" means.
import { Button, Menu, focusables, isTopTrap, pushTrap, type MenuItem } from "./components";
import { confirmResume } from "./actions";
import { list, register, setPendingAgent, unregister, getVersion, subscribe, type Command } from "./commands";
import { HostEmptyState, ProjectTabs } from "./tabs";
import { useProjectsOptional } from "./projects";
import ChatDock from "./designer/ChatDock";

// Single source of truth for nav order, sidebar kbd hints, and the 1-9 key
// map — the badge and the keydown handler can never drift apart again.
const NAV: Array<{ section?: string; view?: View; icon?: string; label?: string; title?: string }> = [
  { section: "Run" },
  { view: "overview", icon: "◧", label: "Overview", title: "Is the mission healthy? What needs you right now?" },
  { view: "steps", icon: "▶", label: "Steps", title: "Every agent turn, newest first. Start here to see what agents actually did." },
  { view: "agents", icon: "◉", label: "Agents", title: "Who is working, stuck, or idle. Wake, suspend, or inspect one." },
  { view: "escalations", icon: "⚑", label: "Needs you", title: "Only when the mesh is paused and needs your decision." },
  { section: "Inspect" },
  { view: "events", icon: "≋", label: "Events", title: "Append-only log of everything. Use search when Steps isn't enough." },
  { view: "graph", icon: "◈", label: "Graph", title: "Who talks to whom." },
  { view: "artifacts", icon: "▤", label: "Files", title: "Files and documents agents produced, with versions." },
  { view: "product", icon: "◫", label: "Product", title: "The delivered codebase — browse files, build, test, run scenarios, open the playground." },
  { view: "cost", icon: "¤", label: "Cost", title: "Token spend and budgets." },
  { section: "Build" },
  { view: "designer", icon: "⚒", label: "Designer", title: "Create or edit a mesh, then run it." },
];

const KEY_VIEWS: View[] = ["overview", "steps", "agents", "escalations", "events", "graph", "artifacts", "product", "cost", "designer"];
const viewKey = (v: View): string => String(KEY_VIEWS.indexOf(v) + 1);

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
      <p className="muted"><b>Overview</b> → is it healthy? <b>Steps</b> → what did each agent do? <b>Agents</b> → who needs help? <b>Needs you</b> → only when paused and waiting on you. Everything else is detail.</p>
      <h2>Keyboard</h2>
      <table>
        <tbody>
          <tr><td><kbd>1</kbd>…<kbd>9</kbd></td><td>switch view</td></tr>
          <tr><td><kbd>⌘K</kbd> / <kbd>Ctrl K</kbd></td><td>command palette (commands + agents)</td></tr>
          <tr><td><kbd>/</kbd></td><td>focus search (events / steps)</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>back one level / close panel</td></tr>
          <tr><td><kbd>p</kbd> / <kbd>r</kbd></td><td>pause / resume mission</td></tr>
          <tr><td><kbd>t</kbd></td><td>toggle theme</td></tr>
          <tr><td><kbd>?</kbd></td><td>this help</td></tr>
        </tbody>
      </table>
      <h2>About</h2>
      <p className="muted">Every screen is a projection of the append-only event log.
        The ✉ / ✓ controls act as the <code>human</code> seat; the designer validates
        configs server-side with the same engine as <code>mesh validate</code>.
        Tip: <code>mesh console &lt;file&gt;</code> opens this console parked (nothing runs on its own — wake to step, ▶ to go live).</p>
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
  const needle = q.trim().toLowerCase();
  const all = list();
  const matches = needle ? all.filter((c) => `${c.label} ${c.keywords ?? ""} ${c.id}`.toLowerCase().includes(needle)) : all;
  const active = Math.min(sel, Math.max(0, matches.length - 1));
  const choose = (c: Command | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    document.getElementById(`palette-opt-${matches[active]?.id ?? ""}`)?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);
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
        aria-activedescendant={matches[active] ? `palette-opt-${matches[active].id}` : undefined}
        placeholder="Type a command or agent…" value={q}
        onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey} />
      <ul id="palette-list" className="palette-list" role="listbox" aria-label="commands">
        {matches.map((c, i) => (
          <li key={c.id} id={`palette-opt-${c.id}`} role="option" aria-selected={i === active}
            className={`palette-item${i === active ? " on" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => choose(c)}>
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
  // Single-process `mesh serve` / `mesh console` has one mesh and no registry,
  // and must not gain an empty tab strip. "Is the provider mounted" did not
  // answer that — the provider mounts in both modes — so ask the server, and
  // show the strip only once it confirms a registry exists.
  const projectsCtx = useProjectsOptional();
  const hasProjects = projectsCtx?.hasRegistry === true;
  // A registry that has answered and holds nothing is first-run, not "a mission
  // reading zero". Every mesh-scoped request 409s in that state, so rendering
  // the views paints a dashboard out of failures.
  const noProjects = hasProjects && projectsCtx.loaded && projectsCtx.projects.length === 0;
  // Until the registry answers we do not know which of the two servers this is,
  // and the views must not fetch on the guess. It is one local request, so this
  // holds the content area for a few milliseconds rather than showing a
  // skeleton — the chrome around it is already painted.
  const registryPending = projectsCtx != null && projectsCtx.hasRegistry === null;
  const goal = status?.goal || {};
  // Mandatory-only, matching Overview and the termination gate. The header used
  // to score every criterion including optional ones, so the two screens
  // disagreed about the same mission.
  const { done, total: critTotal } = mandatoryProgress(goal.acceptanceCriteria);
  const statusWord =
    ({ ACTIVE: "running", PAUSED: "paused", ESCALATED: "needs you", COMPLETED: "done", FAILED: "failed" } as Record<string, string>)[goal.status] ||
    (goal.status || "").toLowerCase();
  const mission = (status?.budgets || []).find((b: any) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  const active = (status?.agents || []).filter((a: any) => RUNNING.has(a.lifecycle)).length;
  const escOpen = (status?.openEscalations || []).length;
  const decisionHint = escOpen ? `${escOpen} open decision${escOpen === 1 ? "" : "s"} — review in Needs you` : "No decisions waiting on you";
  const paused = goal.status === "PAUSED" || ["COMPLETED", "FAILED"].includes(goal.status);
  const parked = Boolean(status?.uiOnly) || status?.mode === "parked";
  // The console's own connection to the truth: live, parked, reconnecting, or dead.
  const liveState = serverDown ? "offline" : sseState === "reconnecting" ? "reconnecting" : parked ? "parked" : sseState === "open" ? "live" : "connecting";
  const liveTitle: Record<string, string> = {
    live: "Live — events are streaming",
    parked: "Parked — nothing runs on its own by design",
    connecting: "Connecting to the event stream…",
    reconnecting: "Connection lost — reconnecting…",
    offline: "Server not responding — showing the last known state, which may be stale",
  };

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

  // Global palette commands: every view, help, and one "jump to agent" per
  // agent. Picking an agent only leaves a pending id in commands.ts and asks
  // the Designer to open; it never touches Designer state from here.
  useEffect(() => {
    register("global", [
      ...KEY_VIEWS.map((v, i) => {
        const nav = NAV.find((n) => n.view === v);
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
  }, [setView, openHelp, status]);

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
    if (drawerDepth > 0 || detail) {
      if (ev.key === "Escape") {
        ev.preventDefault();
        if (drawerDepth > 0) closeDrawer();
        else closeDetail();
      }
      return;
    }
    const map: Record<string, View> = Object.fromEntries(KEY_VIEWS.map((v, i) => [String(i + 1), v]));
    if (map[ev.key]) return setView(map[ev.key]);
    // Esc unwinds exactly one layer. A modal panel is innermost and claims it
    // in the guard above; below that the order is focus mode, then the
    // off-canvas menu. Local handlers (Designer menu/inspector, wire cancel)
    // run only when none of those claimed the key.
    if (ev.key === "Escape") {
      if (focusOn) { ev.preventDefault(); setFocusMode(false); return; }
      if (menuOpen) { ev.preventDefault(); setMenuOpen(false); return; }
      // drawer/detail are handled by the modal guard above, which returns
      // before this branch whenever either is open.
      return;
    }
    if (ev.key === "?") return openHelp();
    if (ev.key === "t") toggleTheme();
    if (ev.key === "p" && goalId) {
      void client.post(`/goals/${goalId}/pause`)
        .then(() => { toast("mission paused", "agents stopped — nothing lost", "warn"); refreshStatus(); })
        .catch(() => toast("pause failed", "the server did not answer", "bad"));
    }
    if (ev.key === "r" && goalId) {
      // The guard is a real dialog now, so the shortcut has to wait for it;
      // the rest of the key router must not.
      void (async () => {
        if (!(await confirmResume(confirm, status, "Resume"))) return;
        try {
          await client.post(`/goals/${goalId}/resume`);
          toast("mission resumed", "agents are running", "ok");
          refreshStatus();
        } catch {
          toast("resume failed", "the server did not answer", "bad");
        }
      })();
    }
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
  const detailNode = detail
    ? detail.kind === "step"
      ? <StepDrawer turnId={detail.id} steps={steps || []} />
      : <AgentDrawer id={detail.id} />
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

  /* One definition per action, rendered either as a button in the bar or as a
     row in the ⋯ menu. Written out here rather than inline so the two places
     cannot drift into doing different things under the same label. */
  const secondaryActions: Array<{ id: string; glyph: string; short: string; title: string; onClick: () => void }> = [];
  if (!paused) {
    secondaryActions.push({
      id: "btn-pause", glyph: "❚❚", short: "pause",
      title: "Pause the mission — agents stop, nothing is lost",
      onClick: () => void (async () => {
        if (!goalId) return;
        try {
          await client.post(`/goals/${goalId}/pause`);
          toast("mission paused", "agents stopped — nothing lost", "warn");
        } catch {
          toast("pause failed", "the server did not answer", "bad");
        }
        void refreshStatus();
      })(),
    });
  } else if (goal.status === "PAUSED") {
    secondaryActions.push({
      id: "btn-resume", glyph: "▶", short: "resume", title: "Resume the mission",
      onClick: () => void (async () => {
        if (!goalId) return;
        if (!(await confirmResume(confirm, status, "Resume"))) return;
        try {
          await client.post(`/goals/${goalId}/resume`);
          toast("mission resumed", "agents are running", "ok");
        } catch {
          toast("resume failed", "the server did not answer", "bad");
        }
        void refreshStatus();
      })(),
    });
  }
  secondaryActions.push(
    { id: "btn-message", glyph: "✉", short: "message", title: "Send a message as the human — highest priority", onClick: () => openDrawer(<MessageDrawer />) },
    { id: "btn-approval", glyph: "✓", short: "approvals", title: "Approve or reject something (release, design, quality…)", onClick: () => openDrawer(<ApprovalDrawer />) },
  );

  return (
    <div id="app" className={`${focusOn ? "focus-mode" : ""}${hasProjects ? " with-tabs" : ""}`}>
      {/* WCAG 2.4.1. Roughly 20 chrome tab stops -- the project strip, 10 nav
          buttons, 3 sidebar footer buttons, the topbar -- sit ahead of the
          content on every single view, with no way past them.

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
          project switch. Rendered only under a ProjectsProvider: `mesh serve`
          runs one mesh with no registry and has no tabs to show. */}
      {hasProjects ? <ProjectTabs parked={parked} parkedId={mesh.projectId} /> : null}
      <aside id="sidebar" className={menuOpen ? "open" : ""} inert={sidebarHidden} aria-hidden={sidebarHidden || undefined}>
        <div className="brand">
          <svg viewBox="0 0 32 32" width="26" height="26"><circle cx="16" cy="16" r="5" fill="var(--accent)" /><circle cx="27" cy="9" r="3" fill="var(--ok)" /><circle cx="5" cy="9" r="3" fill="var(--warn)" /><circle cx="8" cy="26" r="3" fill="var(--bad)" /><path d="M16 16 27 9M16 16 5 9M16 16 8 26" stroke="var(--line-strong)" strokeWidth="1.4" /></svg>
          <div><b>Agent&nbsp;Mesh</b><span id="mesh-id" className="sub">{goal.id ? `goal ${goal.id.slice(0, 14)}` : ""}</span></div>
        </div>
        <nav id="nav" aria-label="views">
          {NAV.map((n, i) =>
            n.section ? (
              <div className="nav-label" key={`s${i}`}>{n.section}</div>
            ) : (
              <button key={n.view} data-view={n.view} className={`tab${view === n.view ? " active" : ""}`} aria-current={view === n.view ? "page" : undefined} title={n.title} onClick={() => { setView(n.view as View); closeMenu(); }}>
                <i>{n.icon}</i>{n.label}
                {n.view === "escalations" && escOpen ? <em className="kbd esc-kbd" id="esc-badge" title={`${escOpen} open decisions`}>{escOpen}</em> : null}
                <em className="kbd">{viewKey(n.view as View)}</em>
              </button>
            ),
          )}
        </nav>
        <div className="side-foot">
          {/* The palette was ⌘K-only: the fastest route to every view, agent and
              action in the product, discoverable solely by already knowing it
              existed. It lives beside help because that is the persistent
              chrome — the topbar is already at its width budget. */}
          <Button id="btn-palette" variant="ghost" title="Search views, agents and actions (⌘K / Ctrl K)" aria-keyshortcuts="Meta+K Control+K" onClick={togglePalette}>⌕ commands<em className="kbd">⌘K</em></Button>
          <Button id="btn-theme" variant="ghost" title="toggle theme" aria-pressed={isLight} onClick={toggleTheme}>◐ theme</Button>
          <Button id="btn-help" variant="ghost" title="keyboard shortcuts" onClick={openHelp}>? help</Button>
        </div>
      </aside>

      <header id="topbar">
        <Button id="btn-menu" variant="ghost" aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen(!menuOpen)}>☰</Button>
        <div id="goal-strip">
          <span className={`pulse-dot${liveState === "live" ? " on" : liveState === "offline" ? " off" : ` ${liveState}`}`} id="live-dot" title={liveTitle[liveState]} aria-hidden="true" />
          <span className={`live-label live-${liveState}`} role="status">{liveState === "connecting" ? "connecting…" : liveState === "reconnecting" ? "reconnecting…" : liveState}</span>
          <div className="goal-text">
            <strong id="top-goal">{status ? (goal.description || "no goal").split("\n")[0].slice(0, 70) : "connecting…"}</strong>
            <span id="top-criteria" className="muted">{goal.status ? `${done}/${critTotal} checks done` : ""}</span>
          </div>
        </div>
        <div className="bar-strip" role="group" aria-label="mission telemetry">
          <div className="bar-strip-stat" title="Mission status"><b>{goal.status ? statusWord : "—"}</b><span>status</span></div>
          <div className="bar-strip-stat agents" title="Agents currently working"><b>{active}</b><span>agents</span></div>
          <button type="button" className={`bar-strip-stat decisions${escOpen ? " hot" : ""}`} aria-label={decisionHint} title={decisionHint} onClick={() => setView("escalations")}>
            <b>{escOpen}</b><span>decisions</span>
          </button>
          <div className="bar-strip-stat secondary" title="Tokens spent out of mission budget"><b>{fmt(mission?.consumed ?? 0)}<span className="muted">/{fmt(mission?.limit ?? 0)}</span></b><span>spent</span></div>
        </div>
        <div className="top-actions">
          {/* Inline on anything wider than a phone; the same three actions,
              same ids and same handlers, move into the ⋯ menu below 620 where
              they no longer fit. Decisions never collapses — it is the one
              asking for something, and its count is the reason to look here. */}
          {phone ? null : secondaryActions.map((a) => (
            <Button key={a.id} id={a.id} variant="soft" title={a.title} onClick={a.onClick}>
              {a.glyph} <span className="act-lbl">{a.short}</span>
            </Button>
          ))}
          <Button id="btn-decisions" variant={escOpen ? "primary" : "ghost"} aria-label={`Review decisions — ${escOpen} open`} title="Open the Needs you view" onClick={() => setView("escalations")}><span className="dec-lbl">Review decisions · </span>{escOpen}</Button>
          {phone && secondaryActions.length > 0 ? (
            <Menu id="btn-more" label="⋯" title="More mission actions" items={secondaryActions.map((a): MenuItem => ({ id: a.id, title: a.title, label: `${a.glyph}  ${a.short}`, onClick: a.onClick }))} />
          ) : null}
        </div>
      </header>

      {/* Focus mode is shell-owned state; the view tree reads it through this seam. */}
      <FocusCtx.Provider value={focusValue}>
        <main id="view" tabIndex={-1}>
          {/* Every view renders its own <h2> title, so without this the document
              outline started at h2 and had no root. There is no brand element in
              the topbar to promote -- the bar is already at its width budget --
              so the h1 is offscreen: it anchors the outline for a screen reader
              without adding chrome nobody asked for. */}
          <h1 className="sr-only">Agent Mesh console</h1>
          {serverDown ? (
            <div className="banner bad server-banner" role="alert">
              <b>Server not responding.</b> <span className="muted">Showing the last known state — it may be stale. Is the mesh process still running?</span>
              <Button variant="banner-act" onClick={() => void refreshStatus()}>Retry now</Button>
            </div>
          ) : null}
          {registryPending ? null : noProjects ? <HostEmptyState /> : viewNode}
        </main>
      </FocusCtx.Provider>

      {panel !== null && (
        <>
          <div id="drawer" className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" aria-label="Details panel" tabIndex={-1} ref={drawerRef}>
            {panelDepth > 1 ? <Button variant="ghost" extra="drawer-back" onClick={popPanel} title="Back to the previous panel (Esc)">← back</Button> : null}
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
      <ChatDock open={chatOpen} onOpen={() => setChatOpen(true)} onClose={() => setChatOpen(false)} />
      <div id="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <b>{t.title}</b>
            <span className="toast-msg">{t.msg}</span>
            {t.action ? <button type="button" className="toast-act" onClick={t.action.run}>{t.action.label}</button> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
