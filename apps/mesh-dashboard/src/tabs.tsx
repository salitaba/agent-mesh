/**
 * The project tab strip.
 *
 * Markup only: every decision it makes — tone, order, RSS, which tab takes
 * focus when one closes — lives in `tabmodel.ts`, which is DOM-free and
 * therefore actually tested. This file reads `useProjects()` directly and puts
 * nothing into `MeshState`: a project map inside the per-project store is the
 * one shape the spec rules out.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "./components";
import { useProjects, type ProjectSummary } from "./projects";
import { api, post } from "./api";
import { hashFor } from "./route";
import { formatRss, moveTab, nextActive, orderTabs, reorderTabs, tabStatus } from "./tabmodel";

const ORDER_KEY = "mesh-tab-order";

const readOrder = (): string[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const writeOrder = (order: string[]): void => {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* private mode: the order is a convenience, not a requirement */
  }
};

interface BrowseEntry {
  name: string;
  path: string;
  hasMesh: boolean;
}

/**
 * Folder picker.
 *
 * A browser `<input type=file webkitdirectory>` hands back a sandboxed name,
 * never the real path the registry has to stat — so the *host* lists
 * directories and this walks them. Typing a path stays available because an
 * operator who knows where the project is should not have to click there.
 */
function AddProject({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { addProject, openProject, setActive } = useProjects();
  const [dir, setDir] = useState<{ path: string; parent: string | null; hasMesh: boolean; entries: BrowseEntry[]; error?: string } | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** Set when an add failed purely because the folder holds no mesh.yaml. */
  const [offerInit, setOfferInit] = useState("");
  const deadRef = useRef(false);

  const browse = useCallback(async (path?: string | null) => {
    const q = path ? `?path=${encodeURIComponent(path)}` : "";
    const { json } = await api("GET", `/api/browse${q}`);
    // The picker can be dismissed while this is in flight; a setState after
    // that is the same leak class that has bitten every step of this spec.
    if (deadRef.current || !json || typeof json.path !== "string") return;
    setDir({
      path: json.path,
      parent: json.parent ?? null,
      hasMesh: json.hasMesh === true,
      entries: Array.isArray(json.entries) ? json.entries : [],
      error: json.error,
    });
    setTyped(json.path);
    setOfferInit("");
  }, []);

  useEffect(() => {
    deadRef.current = false;
    void browse(null);
    return () => {
      deadRef.current = true;
    };
  }, [browse]);

  const add = useCallback(async (root: string, init = false) => {
    setBusy(true);
    setError("");
    setOfferInit("");
    try {
      const res = await addProject(root, init ? { init: true } : undefined);
      if (deadRef.current) return;
      setBusy(false);
      if (!res.ok) {
        setError(res.error ?? "could not add that folder");
        // The listing said nothing about this path (the operator typed it), so
        // the host is the first to know it has no mesh. Offer the scaffold as a
        // second, explicit click rather than writing files behind their back.
        if (res.missing) setOfferInit(root);
        return;
      }
      // Adding without opening leaves a tab that does nothing, which reads as a
      // failure. The operator picked this folder to work in it.
      if (res.project) {
        setActive(res.project.id);
        void openProject(res.project.id);
        // A freshly scaffolded mesh is a placeholder goal and one agent: the
        // Designer is the only view where that is worth looking at.
        if (res.scaffolded) window.location.hash = hashFor(res.project.id, "designer");
      }
      onClose();
    } catch {
      if (deadRef.current) return;
      setBusy(false);
      setError("the host did not answer — is the mesh process running?");
    }
  }, [addProject, onClose, openProject, setActive]);

  // The typed path drifts from the listed one as soon as the operator edits the
  // input without pressing "go", and a stale answer here would scaffold into the
  // wrong folder. Null means "unknown", which stays on the safe non-init path.
  const listedHasMesh: boolean | null = dir && dir.path === typed ? dir.hasMesh : null;
  const confirmLabel = listedHasMesh === false ? "create mesh here" : "add this folder";

  return (
    <div className="proj-picker" role="dialog" aria-label="Add a project">
      <div className="proj-picker-head">
        <b>Add a project</b>
        <span className="muted">Pick the folder that holds its <code>mesh.yaml</code>.</span>
      </div>
      <div className="proj-picker-path">
        <input
          className="txt mono"
          aria-label="Project folder path"
          value={typed}
          spellCheck={false}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void browse(typed); }
          }}
        />
        <Button variant="ghost" title="List this folder" onClick={() => void browse(typed)}>go</Button>
      </div>
      {dir?.error ? <div className="proj-picker-err">{dir.error}</div> : null}
      <ul className="proj-picker-list">
        {dir?.parent ? (
          <li>
            <button type="button" className="proj-picker-row" onClick={() => void browse(dir.parent)}>
              <span className="proj-picker-ico">↰</span>..
            </button>
          </li>
        ) : null}
        {(dir?.entries ?? []).map((e) => (
          <li key={e.path}>
            <button type="button" className={`proj-picker-row${e.hasMesh ? " has-mesh" : ""}`} onClick={() => void browse(e.path)}>
              <span className="proj-picker-ico">{e.hasMesh ? "◧" : "▸"}</span>
              {e.name}
              {e.hasMesh ? <em>mesh.yaml</em> : null}
            </button>
          </li>
        ))}
        {dir && !dir.entries.length && !dir.error ? <li className="muted proj-picker-empty">No sub-folders here.</li> : null}
      </ul>
      {error ? <div className="proj-picker-err" role="alert">{error}</div> : null}
      <div className="proj-picker-foot">
        <span className="muted mono">{dir?.path ?? "…"}</span>
        <div className="proj-picker-acts">
          <Button variant="ghost" onClick={onClose}>cancel</Button>
          {offerInit ? (
            <Button variant="primary" disabled={busy} onClick={() => void add(offerInit, true)}>
              {busy ? "creating…" : "create mesh here"}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={busy || !typed}
              onClick={() => void add(typed, listedHasMesh === false)}
            >
              {busy ? (listedHasMesh === false ? "creating…" : "adding…") : confirmLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The crash panel: what killed it, and the one button that brings it back. */
function CrashBanner({ project }: { project: ProjectSummary }): React.JSX.Element {
  const { restartProject } = useProjects();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const st = tabStatus(project);
  return (
    <div className="banner bad proj-crash" role="alert">
      <b>{project.name} {st.label}.</b>
      <span className="muted">{st.hint}</span>
      {project.error?.detail ? <code className="proj-crash-detail">{project.error.detail}</code> : null}
      {err ? <code className="proj-crash-detail">{err}</code> : null}
      <Button
        variant="banner-act"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          try {
            await restartProject(project.id);
          } catch {
            setErr("restart request failed — is the host still running?");
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "restarting…" : "Restart project"}
      </Button>
    </div>
  );
}

/**
 * One tab. Middle-click and the × close it; drag reorders; ⌘/Ctrl+arrows move
 * it without a mouse, because a reorder a keyboard user cannot perform is a
 * feature only half the operators have.
 */
function Tab({ project, active, parked, onPick, onClose, onDragStart, onDrop, onMove }: {
  project: ProjectSummary;
  active: boolean;
  parked: boolean;
  onPick: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (delta: number) => void;
}): React.JSX.Element {
  const st = tabStatus(project, parked);
  const rss = formatRss(project.health?.rss);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`ptab tone-${st.tone}${active ? " on" : ""}${over ? " drop" : ""}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(); }}
      onDragEnd={() => setOver(false)}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onClose(); } }}
    >
      <button
        type="button"
        className="ptab-main"
        aria-current={active ? "page" : undefined}
        title={`${project.name} — ${st.hint}${rss ? ` (${rss})` : ""}`}
        onClick={onPick}
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          if (e.key === "ArrowLeft") { e.preventDefault(); onMove(-1); }
          else if (e.key === "ArrowRight") { e.preventDefault(); onMove(1); }
        }}
      >
        <span className={`ptab-dot ${st.tone}`} aria-hidden="true" />
        <span className="ptab-name">{project.name}</span>
        <span className="ptab-meta">
          <span className="ptab-state">{st.label}</span>
          {rss ? <span className="ptab-rss">{rss}</span> : null}
        </span>
      </button>
      <button type="button" className="ptab-x" aria-label={`Close ${project.name}`} title="Close this project (its files are untouched)" onClick={onClose}>×</button>
    </div>
  );
}

/**
 * The strip itself.
 *
 * `parkedId`/`parked` come from the mounted store rather than the registry:
 * whether a mesh is parked is mission state behind the child's `/status`, and
 * only the active project has a store to read it from. Every other tab shows
 * the registry's view, which is all the host can honestly say about it.
 */
export function ProjectTabs({ parked, parkedId }: { parked?: boolean; parkedId?: string | null }): React.JSX.Element | null {
  const { projects, activeId, setActive, openProject, closeProject, loaded, hostDown } = useProjects();
  const [order, setOrder] = useState<string[]>(readOrder);
  const [adding, setAdding] = useState(false);
  const dragRef = useRef<string | null>(null);

  const ordered = orderTabs(projects, order);
  const orderedIds = ordered.map((p) => p.id);

  // The remembered order is only ever the ids that still exist, so a project
  // removed on another machine does not accumulate in localStorage forever.
  useEffect(() => {
    if (!loaded) return;
    const live = orderedIds;
    if (order.length === live.length && order.every((id, i) => id === live[i])) return;
    setOrder(live);
    writeOrder(live);
    // `orderedIds` is derived from `projects`; depending on the array itself
    // would re-run this on every 5s poll that changed nothing. `order` is read
    // for comparison only — this effect exists to reconcile it with the ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, orderedIds.join(",")]);

  const commit = useCallback((next: string[]) => {
    setOrder(next);
    writeOrder(next);
  }, []);

  const pick = useCallback((id: string) => {
    setActive(id);
    const ref = projects.find((p) => p.id === id);
    // Switching to a closed tab is a request to work in it. A tripped breaker
    // is the exception: reopening on click would restart the crash loop the
    // breaker exists to stop.
    if (ref && ref.status !== "open" && ref.status !== "booting" && !ref.tripped) void openProject(id);
  }, [openProject, projects, setActive]);

  const close = useCallback(async (id: string) => {
    const next = nextActive(orderedIds, id, activeId);
    // Move the active tab *before* the close lands: the closing project's
    // store unsubscribes on unmount, and leaving it mounted over a dead child
    // means one more in-flight fetch with nothing to answer it.
    if (next !== activeId && next) setActive(next);
    await closeProject(id);
  }, [activeId, closeProject, orderedIds, setActive]);

  const crashed = activeId ? ordered.find((p) => p.id === activeId && tabStatus(p).restartable) : undefined;

  if (!loaded && !hostDown) return null;

  return (
    <div id="ptabs-bar">
      <div className="ptabs" role="tablist" aria-label="open projects">
        {ordered.map((p) => (
          <Tab
            key={p.id}
            project={p}
            active={p.id === activeId}
            parked={Boolean(parked) && p.id === parkedId}
            onPick={() => pick(p.id)}
            onClose={() => void close(p.id)}
            onDragStart={() => { dragRef.current = p.id; }}
            onDrop={() => {
              const from = dragRef.current;
              dragRef.current = null;
              if (from) commit(reorderTabs(orderedIds, from, p.id));
            }}
            onMove={(delta) => commit(moveTab(orderedIds, p.id, delta))}
          />
        ))}
        <button type="button" className="ptab-add" title="Add a project folder" aria-label="Add a project" onClick={() => setAdding(true)}>+</button>
        {!ordered.length ? <span className="muted ptabs-empty">No projects yet — add the folder that holds a mesh.yaml.</span> : null}
      </div>
      {adding ? (
        <>
          <div id="palette-scrim" aria-hidden="true" onClick={() => setAdding(false)} />
          <AddProject onClose={() => setAdding(false)} />
        </>
      ) : null}
      {crashed ? <CrashBanner project={crashed} /> : null}
    </div>
  );
}

/** Removes a project from the registry. Exposed for the tab context menu; the
 *  registry call is host-level, so it is deliberately a bare path. */
export const forgetProject = (id: string): Promise<{ status: number; json: any }> =>
  post(`/api/projects/${encodeURIComponent(id)}/close`).then(() => api("DELETE", `/api/projects/${encodeURIComponent(id)}`));
