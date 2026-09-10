import { useEffect } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fmt } from "./format";
import { RUNNING } from "./format";
import { useMesh, type View } from "./store";
import { MessageDrawer, ApprovalDrawer, StepDrawer, AgentDrawer } from "./drawers";
import { Button } from "./components";
import { confirmResume } from "./actions";
import { list, register, setPendingAgent, unregister, getVersion, subscribe, type Command } from "./commands";

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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Only what a keyboard user can actually reach: `offsetParent === null` drops
// anything a parent hid with display:none, which is how the drawers collapse
// their inactive tab panels.
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

// Mirrors the `@media (max-width: 800px)` rule in styles.css that turns the
// sidebar into an off-canvas drawer. Below it the sidebar is translated out of
// view but still in the tab order unless we mark it inert, so a keyboard user
// tabs through ten invisible nav buttons before reaching the page.
const NARROW = "(max-width: 800px)";
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
 *  focus (Tab is trapped) and the shell owns Escape, so one dispatch order
 *  closes palette → focus → panel. */
function CommandPalette({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Re-list when a scope registers/unregisters: a view can unmount while the
  // palette is open (browser Back), and its commands must vanish with it.
  const cmdVersion = useSyncExternalStore(subscribe, getVersion);
  const needle = q.trim().toLowerCase();
  const all = useMemo(() => list(), [cmdVersion]);
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
  const { view, setView, status, goalId, toasts, drawer, drawerDepth, openDrawer, closeDrawer, toast, refreshStatus, serverDown, sseState, detail, closeDetail, steps, client } = mesh;
  const goal = status?.goal || {};
  const crit = goal.acceptanceCriteria || [];
  const done = crit.filter((c: any) => c.status !== "UNSATISFIED").length;
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
  useEffect(() => {
    setFocusMode(false);
  }, [view]);
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
    <><Help /><button className="close-x" style={{ position: "absolute", top: 16, right: 18 }} onClick={closeDrawer}>×</button></>,
  ), [openDrawer, closeDrawer]);

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
  onKeyRef.current = (ev: KeyboardEvent) => {
    if (ev.defaultPrevented) return;
    // ⌘K/Ctrl+K works from anywhere, including inside an input.
    if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      togglePalette();
      return;
    }
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
    const map: Record<string, View> = Object.fromEntries(KEY_VIEWS.map((v, i) => [String(i + 1), v]));
    if (map[ev.key]) return setView(map[ev.key]);
    // Esc unwinds exactly one layer, in this order: focus mode, off-canvas
    // menu, pushed drawers, then the deep-linked detail. Local handlers
    // (Designer menu/inspector, wire cancel) run only when none of those
    // claimed the key.
    if (ev.key === "Escape") {
      if (focusOn) { ev.preventDefault(); setFocusMode(false); return; }
      if (menuOpen) { ev.preventDefault(); setMenuOpen(false); return; }
      if (drawerDepth > 0) { ev.preventDefault(); closeDrawer(); return; }
      if (detail) { ev.preventDefault(); closeDetail(); return; }
      return;
    }
    if (ev.key === "?") return openHelp();
    if (ev.key === "t") toggleTheme();
    if (ev.key === "p" && goalId) void client.post(`/goals/${goalId}/pause`).then(() => { toast("mission paused", "agents stopped — nothing lost", "warn"); refreshStatus(); });
    if (ev.key === "r" && goalId) {
      if (!confirmResume(status, "Resume")) return;
      void client.post(`/goals/${goalId}/resume`).then(() => { toast("mission resumed", "agents are running", "ok"); refreshStatus(); });
    }
    if (ev.key === "/") {
      ev.preventDefault();
      const s = document.getElementById("ev-search") || document.getElementById("step-search");
      if (s) s.focus();
    }
  };
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => onKeyRef.current(ev);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Opening the off-canvas menu should put the keyboard in it; closing it must
  // hand focus back to ☰ rather than dropping it on <body>.
  useEffect(() => {
    if (!narrow) return;
    if (menuOpen) document.querySelector<HTMLElement>("#sidebar .tab")?.focus();
    else if (document.activeElement === document.body) document.getElementById("btn-menu")?.focus();
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

  // Tab cycles inside the open panel. Without this the next Tab walks into the
  // sidebar behind the scrim, which is visually unreachable.
  useEffect(() => {
    if (panelDepth === 0) return;
    const onTab = (ev: KeyboardEvent) => {
      if (ev.key !== "Tab") return;
      const root = drawerRef.current;
      if (!root) return;
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
  }, [panelDepth]);

  const closeMenu = () => setMenuOpen(false);
  return (
    <div id="app" className={focusOn ? "focus-mode" : ""}>
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
              <button key={n.view} data-view={n.view} className={`tab${view === n.view ? " active" : ""}`} title={n.title} onClick={() => { setView(n.view as View); closeMenu(); }}>
                <i>{n.icon}</i>{n.label}
                {n.view === "escalations" && escOpen ? <em className="kbd esc-kbd" id="esc-badge" title={`${escOpen} open decisions`}>{escOpen}</em> : null}
                <em className="kbd">{viewKey(n.view as View)}</em>
              </button>
            ),
          )}
        </nav>
        <div className="side-foot">
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
            <span id="top-criteria" className="muted">{goal.status ? `${done}/${crit.length} checks done` : ""}</span>
          </div>
        </div>
        <div className="bar-strip" role="group" aria-label="mission telemetry">
          <div className="bar-strip-stat" title="Mission status"><b>{goal.status ? statusWord : "—"}</b><span>status</span></div>
          <div className="bar-strip-stat" title="Agents currently working"><b>{active}</b><span>agents</span></div>
          <button type="button" className={`bar-strip-stat decisions${escOpen ? " hot" : ""}`} aria-label={decisionHint} title={decisionHint} onClick={() => setView("escalations")}>
            <b>{escOpen}</b><span>decisions</span>
          </button>
          <div className="bar-strip-stat secondary" title="Tokens spent out of mission budget"><b>{fmt(mission?.consumed ?? 0)}<span className="muted">/{fmt(mission?.limit ?? 0)}</span></b><span>spent</span></div>
        </div>
        <div className="top-actions">
          {!paused ? (
            <Button id="btn-pause" variant="soft" title="Pause the mission — agents stop, nothing is lost" onClick={async () => {
              if (goalId) { await client.post(`/goals/${goalId}/pause`); toast("mission paused", "agents stopped — nothing lost", "warn"); void refreshStatus(); }
            }}>❚❚ <span className="act-lbl">pause</span></Button>
          ) : goal.status === "PAUSED" ? (
            <Button id="btn-resume" variant="soft" title="Resume the mission" onClick={async () => {
              if (!goalId) return;
              if (!confirmResume(status, "Resume")) return;
              await client.post(`/goals/${goalId}/resume`); toast("mission resumed", "agents are running", "ok"); void refreshStatus();
            }}>▶ <span className="act-lbl">resume</span></Button>
          ) : null}
          <Button id="btn-message" variant="soft" title="Send a message as the human — highest priority" onClick={() => openDrawer(<MessageDrawer />)}>✉ <span className="act-lbl">message</span></Button>
          <Button id="btn-approval" variant="soft" title="Approve or reject something (release, design, quality…)" onClick={() => openDrawer(<ApprovalDrawer />)}>✓ <span className="act-lbl">approvals</span></Button>
          <Button id="btn-decisions" variant={escOpen ? "primary" : "ghost"} title="Open the Needs you view" onClick={() => setView("escalations")}>Review decisions · {escOpen}</Button>
        </div>
      </header>

      {/* Focus mode is shell-owned state; the view tree reads it through this seam. */}
      <FocusCtx.Provider value={focusValue}>
        <main id="view" tabIndex={-1}>
          {serverDown ? (
            <div className="banner bad server-banner" role="alert">
              <b>Server not responding.</b> <span className="muted">Showing the last known state — it may be stale. Is the mesh process still running?</span>
              <Button variant="banner-act" onClick={() => void refreshStatus()}>Retry now</Button>
            </div>
          ) : null}
          {viewNode}
        </main>
      </FocusCtx.Provider>

      {panel !== null && (
        <>
          <div id="drawer" className="drawer" role="dialog" aria-modal="true" aria-label="Details panel" tabIndex={-1} ref={drawerRef}>
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
      <div id="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}><b>{t.title}</b>{t.msg}</div>
        ))}
      </div>
    </div>
  );
}
