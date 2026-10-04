/**
 * The project strip.
 *
 * Markup only: every decision it makes (tone, shape, word, order, which tab takes focus when one closes, what a person
 * reads) lives in `tabmodel.ts` and `projectsmodel.ts`, which are DOM-free and therefore actually tested. This file reads
 * `useProjects()` directly and puts nothing into `MeshState`: a project map inside the per-project store is the one shape
 * the spec rules out.
 *
 * Left to right: a button to the Projects page (carrying the count of projects that need a person), the tabs (which scroll
 * sideways when there are too many, fading where there is more), and the New project button, which stays put. Under the
 * strip, in the flow so the console moves down rather than being covered: why the project in front is broken, that the host
 * is not answering, or that the host refused something.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import "./projects.css";
import { Banner, Button } from "./components";
import { Icon } from "./icons";
import { useProjects, type ProjectSummary } from "./projects";
import { useMesh } from "./store";
import { hashFor, isHostView, parseHash } from "./route";
import { formatRss, moveTab, orderTabs, reorderTabs, tabStatus } from "./tabmodel";
import { attentionCount, cardActions, cardState, displayNames, failureDetail, landAfterClose, problemTitle, tabLook } from "./projectsmodel";
import { NewProjectDialog, Welcome } from "./newproject";
import { register, unregister } from "./commands";

const ORDER_KEY = "mesh-tab-order";

/** The order the person arranged the tabs in (and so the Projects page lists them in, inside each group). */
export const readOrder = (): string[] => {
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

/**
 * The host's own account of why a project is broken. It is long (a parse error carries the file and the offending line, a
 * lock carries the holder and two paths) and useful to one reader in ten, so it is there to open and not in the way of the
 * sentence above it.
 */
export function WhatTheHostSaid({ text }: { text: string }): React.JSX.Element {
  return (
    <details className="pj-why">
      <summary>What the host said</summary>
      <pre>{text}</pre>
    </details>
  );
}

/** The notice for the project in front when it is broken: what killed it, in the host's words, and the one button that brings it back. */
function CrashBanner({ project, name }: { project: ProjectSummary; name: string }): React.JSX.Element {
  const { restartProject } = useProjects();
  const [busy, setBusy] = useState(false);
  const card = cardState(project);
  const detail = failureDetail(project);
  return (
    <Banner
      tone="bad"
      className="ptabs-notice"
      title={problemTitle(name, card.key)}
      actions={
        <Button
          variant="banner-act"
          icon="refresh"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              // A refusal is posted to the notice under the strip by the provider; nothing more to say here.
              await restartProject(project.id);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Restarting…" : "Restart project"}
        </Button>
      }
    >
      {card.sentence}
      {detail ? <WhatTheHostSaid text={detail} /> : null}
    </Banner>
  );
}

/** Said when the registry cannot be reached: without it a cold page with no host behind it is simply blank. */
function HostDownBanner({ loaded }: { loaded: boolean }): React.JSX.Element {
  const { refreshProjects } = useProjects();
  const [busy, setBusy] = useState(false);
  return (
    <Banner
      tone="bad"
      className="ptabs-notice"
      title="The host is not answering."
      actions={
        <Button
          variant="banner-act"
          icon="refresh"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await refreshProjects();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Asking…" : "Retry now"}
        </Button>
      }
    >
      {loaded ? "Showing the last list it sent, which may be out of date." : "Nothing can be shown until it answers."} This page asks again every 5 seconds.
    </Banner>
  );
}

/**
 * One tab. Middle-click and the close button close it; drag reorders; Ctrl/Cmd+arrows move it without a mouse, because a
 * reorder a keyboard user cannot perform is a feature only half the operators have.
 */
function Tab({ project, label, active, missionParked, onPick, onClose, onDragStart, onDrop, onMove }: {
  project: ProjectSummary;
  label: string;
  active: boolean;
  missionParked: boolean;
  onPick: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onMove: (delta: number) => void;
}): React.JSX.Element {
  // The word, the shape, the tone and the sentence in the tooltip all come from the same model as the project's card, so a tab
  // and its card cannot say different things.
  const card = cardState(project, { missionParked });
  const look = tabLook(card);
  const rss = formatRss(project.health?.rss);
  const [over, setOver] = useState(false);
  // The same rule as the project's card: only a project with a process has one to close. A broken one is restarted (the
  // notice under the strip, or its card) or forgotten (its card), and a closed one is already closed.
  const canClose = cardActions(card.key).close;
  return (
    <li
      className={`ptab${active ? " on" : ""}${over ? " drop" : ""}`}
      data-tone={look.tone}
      data-state={card.key}
      draggable
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); onDrop(); }}
      onDragEnd={() => setOver(false)}
      onAuxClick={(e) => { if (e.button === 1 && canClose) { e.preventDefault(); onClose(); } }}
    >
      <button
        type="button"
        className="ptab-main"
        aria-current={active ? "page" : undefined}
        title={`${label}: ${card.sentence}${rss ? ` Memory ${rss}.` : ""} Ctrl+Left and Ctrl+Right move this tab.`}
        onClick={onPick}
        onKeyDown={(e) => {
          if (!(e.metaKey || e.ctrlKey)) return;
          if (e.key === "ArrowLeft") { e.preventDefault(); onMove(-1); }
          else if (e.key === "ArrowRight") { e.preventDefault(); onMove(1); }
        }}
      >
        <span className="ptab-ico"><Icon name={look.icon} size={14} /></span>
        <span className="ptab-name">{label}</span>
        <span className="ptab-meta">
          <span className="ptab-state">{look.word}</span>
          {rss ? <span className="ptab-rss">{rss}</span> : null}
        </span>
      </button>
      {/* The tab itself stays when its project is closed: it is closed, not removed (see Projects). */}
      {canClose ? (
        <button type="button" className="ptab-x" aria-label={`Close ${label}`} title="Close this project: its process stops. The tab and its files stay." onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </li>
  );
}

/**
 * A fresh host used to render the whole Overview against a server answering 409 "no project is open": GOAL PROGRESS 0%,
 * "0 of 0 checks done", "SPENT 0/0". Every figure looked like a measurement and none of them meant anything, the worst
 * kind of empty state, one indistinguishable from a healthy idle mission. An empty registry is a first run, and the first
 * run is a welcome: three ways to start, each saying what it needs, what it costs and which files it writes where.
 */
export function HostEmptyState(): React.JSX.Element {
  return <Welcome />;
}

export function ProjectTabs({ parked, parkedId }: { parked?: boolean; parkedId?: string | null }): React.JSX.Element | null {
  const { projects, activeId, setActive, openProject, closeProject, loaded, hostDown, notice, dismissNotice } = useProjects();
  const { view } = useMesh();
  const [order, setOrder] = useState<string[]>(readOrder);
  const [adding, setAdding] = useState(false);
  const dragRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLUListElement | null>(null);
  const fadeRef = useRef<HTMLDivElement | null>(null);

  const ordered = orderTabs(projects, order);
  const orderedIds = ordered.map((p) => p.id);
  const names = displayNames(ordered);
  const onProjectsPage = view === "projects";
  const attention = attentionCount(projects);

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

  // Too many tabs to fit scroll sideways; the edges fade where there is more. The fades are driven from the scroll position
  // and the width, written straight to the wrapper so scrolling does not re-render the strip.
  const updateFades = useCallback(() => {
    const el = scrollRef.current;
    const wrap = fadeRef.current;
    if (!el || !wrap) return;
    wrap.dataset.fadeStart = String(el.scrollLeft > 1);
    wrap.dataset.fadeEnd = String(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateFades();
    el.addEventListener("scroll", updateFades, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateFades);
    ro?.observe(el);
    // A mouse wheel moves a row of tabs the way it moves a browser's: sideways, only when there is somewhere to go.
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("scroll", updateFades);
      el.removeEventListener("wheel", onWheel);
      ro?.disconnect();
    };
  }, [updateFades, ordered.length]);
  // Switching to a tab that is scrolled out of sight brings it into view: the whole tab, with its close button, not only its
  // name. A tab grows when its state words arrive, so it is brought into view again when the active project's state changes.
  const activeProject = ordered.find((p) => p.id === activeId);
  const activeLook = activeProject ? `${activeProject.status}/${activeProject.lastMode ?? ""}/${activeProject.health ? "h" : ""}` : "";
  useEffect(() => {
    scrollRef.current?.querySelector(".ptab.on")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, onProjectsPage, activeLook]);

  // Keyboard routes to the Projects page and the New project dialog, from the command palette.
  useEffect(() => {
    register("host", [
      { id: "go.projects", label: "Go to Projects", keywords: "projects folders host manage open close remove", scope: "host", run: () => { window.location.hash = hashFor(activeId, "projects"); } },
      { id: "projects.new", label: "New project", keywords: "add create demo folder mesh start", scope: "host", run: () => setAdding(true) },
    ]);
    return () => unregister("host");
  }, [activeId]);

  const pick = useCallback((id: string) => {
    const ref = projects.find((p) => p.id === id);
    setActive(id);
    // The address follows the tab, so a link copied now opens this project; a host page has no project, and a project tab
    // from there opens its Overview. The page is read from the address by whoever arrives (ProjectsProvider).
    const current = parseHash(window.location.hash).view;
    window.location.hash = hashFor(id, isHostView(current) ? "overview" : current);
    // Picking a closed project is asking to work in it, also when it is already the one in front. A broken one is not
    // started again by a click: the notice under the strip offers that. (One request at a time per project: the
    // address changing under this click does not ask twice.)
    if (ref?.status === "closed") void openProject(id);
  }, [openProject, projects, setActive]);

  const close = useCallback(async (id: string) => {
    const landing = landAfterClose(ordered, id, activeId);
    // Move before the close lands: the closing project's store unsubscribes on unmount, and leaving it mounted over a dead
    // child means one more in-flight fetch with nothing to answer it.
    if (landing.kind === "project") {
      setActive(landing.id);
      const current = parseHash(window.location.hash).view;
      window.location.hash = hashFor(landing.id, isHostView(current) ? "overview" : current);
    }
    const result = await closeProject(id);
    if (result.ok && landing.kind === "projects") window.location.hash = hashFor(null, "projects");
  }, [activeId, closeProject, ordered, setActive]);

  const crashed = activeId ? ordered.find((p) => p.id === activeId && tabStatus(p).restartable) : undefined;

  if (!loaded && !hostDown) return null;

  return (
    <div id="ptabs-bar">
      {/* A nav landmark: "a list of places you can go", the same semantic as the sidebar. Not a tablist: role="tablist"
          promises the APG tabs contract (bare Left/Right moves selection, one tab stop for the strip, an owned tabpanel),
          and none of that exists here. The only arrow handler needs Ctrl/Meta and REORDERS, each project has two tab stops,
          and wiring selection to a bare arrow would boot a child process per keypress. */}
      <nav className="ptabs-nav" aria-label="Projects">
        <button
          type="button"
          className="pj-home"
          aria-current={onProjectsPage ? "page" : undefined}
          title="Every project on this host: open, close or remove them"
          onClick={() => { window.location.hash = hashFor(activeId, "projects"); }}
        >
          <Icon name="folder" size={16} />
          <span className="pj-home-label">Projects</span>
          {attention > 0 ? (
            <span className="pj-count" title={`${attention} ${attention === 1 ? "project needs" : "projects need"} attention`}>
              <span aria-hidden="true">{attention}</span>
              <span className="sr-only"> {attention === 1 ? "project needs" : "projects need"} attention</span>
            </span>
          ) : null}
        </button>
        <div className="ptabs-scroll" ref={fadeRef}>
          <ul className="ptabs" role="list" ref={scrollRef}>
            {ordered.map((p) => {
              const isParked = p.id === parkedId ? Boolean(parked) : p.lastMode === "parked";
              return (
                <Tab
                  key={p.id}
                  project={p}
                  label={names.get(p.id) ?? p.name}
                  active={p.id === activeId && !onProjectsPage}
                  missionParked={isParked}
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
              );
            })}
          </ul>
          {!ordered.length ? <span className="muted ptabs-empty">No projects yet.</span> : null}
        </div>
        <button type="button" className="ptab-add" title="New project: try the demo, create a mesh or add a folder" aria-label="New project" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} />
        </button>
      </nav>
      {hostDown ? <HostDownBanner loaded={loaded} /> : null}
      {!hostDown && crashed ? <CrashBanner project={crashed} name={names.get(crashed.id) ?? crashed.name} /> : null}
      {notice ? (
        <Banner tone="warn" className="ptabs-notice" title={notice.title} actions={<Button variant="banner-act" onClick={dismissNotice}>Dismiss</Button>}>
          {notice.text}
        </Banner>
      ) : null}
      {adding ? <NewProjectDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
