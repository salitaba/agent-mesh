import { useEffect } from "react";
import { useCallback, useState } from "react";
import { fmt } from "./format";
import { RUNNING } from "./format";
import { post } from "./api";
import { useMesh, type View } from "./store";
import { MessageDrawer, ApprovalDrawer, StepDrawer, AgentDrawer } from "./drawers";
import { Button } from "./components";
import { confirmResume } from "./actions";

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

function Help(): React.JSX.Element {
  return (
    <div className="help">
      <h2>How to read this console</h2>
      <p className="muted"><b>Overview</b> → is it healthy? <b>Steps</b> → what did each agent do? <b>Agents</b> → who needs help? <b>Needs you</b> → only when paused and waiting on you. Everything else is detail.</p>
      <h2>Keyboard</h2>
      <table>
        <tbody>
          <tr><td><kbd>1</kbd>…<kbd>9</kbd></td><td>switch view</td></tr>
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

export function Shell({ viewNode }: { viewNode: React.ReactNode }): React.JSX.Element {
  const mesh = useMesh();
  const { view, setView, status, goalId, toasts, drawer, drawerDepth, openDrawer, closeDrawer, toast, refreshStatus, serverDown, sseState, detail, closeDetail, steps } = mesh;
  const goal = status?.goal || {};
  const crit = goal.acceptanceCriteria || [];
  const done = crit.filter((c: any) => c.status !== "UNSATISFIED").length;
  const statusWord =
    ({ ACTIVE: "running", PAUSED: "paused", ESCALATED: "needs you", COMPLETED: "done", FAILED: "failed" } as Record<string, string>)[goal.status] ||
    (goal.status || "").toLowerCase();
  const mission = (status?.budgets || []).find((b: any) => b.key.startsWith("mission:") && b.limitKind === "tokens");
  const active = (status?.agents || []).filter((a: any) => RUNNING.has(a.lifecycle)).length;
  const escOpen = (status?.openEscalations || []).length;
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
  const [isLight, setIsLight] = useState(() => document.documentElement.dataset.theme === "light");
  const toggleTheme = useCallback(() => {
    const cur = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = cur;
    localStorage.setItem("mesh-theme", cur);
    setIsLight(cur === "light");
  }, []);
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      const t = ev.target as HTMLElement;
      if (t.matches("input, textarea, select")) {
        if (ev.key === "Escape") t.blur();
        return;
      }
      const map: Record<string, View> = Object.fromEntries(KEY_VIEWS.map((v, i) => [String(i + 1), v]));
      if (map[ev.key]) return setView(map[ev.key]);
      // Esc unwinds one layer at a time: pushed drawers first, then the
      // deep-linked detail (which also pops it off the URL).
      if (ev.key === "Escape") return drawerDepth > 0 ? closeDrawer() : closeDetail();
      if (ev.key === "?") return openDrawer(<><Help /><button className="close-x" style={{ position: "absolute", top: 16, right: 18 }} onClick={closeDrawer}>×</button></>);
      if (ev.key === "t") toggleTheme();
      if (ev.key === "p" && goalId) void post(`/goals/${goalId}/pause`).then(() => { toast("mission paused", "agents stopped — nothing lost", "warn"); refreshStatus(); });
      if (ev.key === "r" && goalId) {
        if (!confirmResume(status, "Resume")) return;
        void post(`/goals/${goalId}/resume`).then(() => { toast("mission resumed", "agents are running", "ok"); refreshStatus(); });
      }
      if (ev.key === "/") {
        ev.preventDefault();
        const s = document.getElementById("ev-search") || document.getElementById("step-search");
        if (s) s.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView, closeDrawer, closeDetail, drawerDepth, openDrawer, goalId, refreshStatus, status, toast, toggleTheme]);

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

  const closeMenu = () => setMenuOpen(false);
  return (
    <div id="app">
      <aside id="sidebar" className={menuOpen ? "open" : ""}>
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
          <Button id="btn-help" variant="ghost" title="keyboard shortcuts" onClick={() => openDrawer(<><Help /><button className="close-x" style={{ position: "absolute", top: 16, right: 18 }} onClick={closeDrawer}>×</button></>)}>? help</Button>
        </div>
      </aside>

      <header id="topbar">
        <Button id="btn-menu" variant="ghost" aria-expanded={menuOpen} aria-label={menuOpen ? "Close navigation" : "Open navigation"} onClick={() => setMenuOpen(!menuOpen)}>☰</Button>
        <div id="goal-strip">
          <span className={`pulse-dot${liveState === "live" ? " on" : liveState === "offline" ? " off" : ` ${liveState}`}`} id="live-dot" title={liveTitle[liveState]} aria-hidden="true" />
          <span className={`live-label live-${liveState}`} role="status">{liveState === "connecting" ? "connecting…" : liveState === "reconnecting" ? "reconnecting…" : liveState}</span>
          <div className="goal-text">
            <strong id="top-goal">{status ? (goal.description || "no goal").split("\n")[0].slice(0, 70) : "connecting…"}</strong>
            <span id="top-criteria" className="muted">{goal.status ? `· ${statusWord} · ${done}/${crit.length} checks done` : ""}</span>
          </div>
        </div>
        <div id="top-stats" aria-label="mission stats">
          <div className="stat" title="Tokens spent out of mission budget"><b>{fmt(mission?.consumed ?? 0)}<span className="muted">/{fmt(mission?.limit ?? 0)}</span></b><span>spent</span></div>
          <div className="stat" title="Agents currently working"><b>{active}</b><span>working</span></div>
          <div className="stat" title="Paused items waiting on your decision"><b style={escOpen ? { color: "var(--bad)" } : undefined}>{escOpen}</b><span>need you</span></div>
        </div>
        <div className="top-actions">
          {!paused ? (
            <Button id="btn-pause" variant="soft" title="Pause the mission — agents stop, nothing is lost" onClick={async () => {
              if (goalId) { await post(`/goals/${goalId}/pause`); toast("mission paused", "agents stopped — nothing lost", "warn"); void refreshStatus(); }
            }}>❚❚ pause</Button>
          ) : goal.status === "PAUSED" ? (
            <Button id="btn-resume" variant="soft" title="Resume the mission" onClick={async () => {
              if (!goalId) return;
              if (!confirmResume(status, "Resume")) return;
              await post(`/goals/${goalId}/resume`); toast("mission resumed", "agents are running", "ok"); void refreshStatus();
            }}>▶ resume</Button>
          ) : null}
          <Button id="btn-message" variant="soft" title="Send a message as the human — highest priority" onClick={() => openDrawer(<MessageDrawer />)}>✉ message</Button>
          <Button id="btn-approval" variant="soft" title="Approve or reject something (release, design, quality…)" onClick={() => openDrawer(<ApprovalDrawer />)}>✓ decide</Button>
        </div>
      </header>

      <main id="view" tabIndex={-1}>
        {serverDown ? (
          <div className="banner bad server-banner" role="alert">
            <b>Server not responding.</b> <span className="muted">Showing the last known state — it may be stale. Is the mesh process still running?</span>
            <Button variant="banner-act" onClick={() => void refreshStatus()}>Retry now</Button>
          </div>
        ) : null}
        {viewNode}
      </main>

      {panel !== null && (
        <>
          <div id="drawer" className="drawer" role="dialog" aria-modal="false">
            {panelDepth > 1 ? <Button variant="ghost" extra="drawer-back" onClick={popPanel} title="Back to the previous panel (Esc)">← back</Button> : null}
            <div id="drawer-body">{panel}</div>
          </div>
          <div id="scrim" onClick={popPanel} />
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
