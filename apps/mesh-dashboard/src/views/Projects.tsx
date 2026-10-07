/**
 * Projects: every project registered on this host, with what each is doing and what can be done to it.
 *
 * The tab strip answers "which one am I in"; this answers "what is on this host, what is broken, what is running and
 * costing, and what do I want to close or forget". It is a host page (`#/projects`): it names no project, so it reads
 * the same whichever one is in front. Every state word, shape and "which button applies" comes from projectsmodel.ts.
 */
import React, { useState } from "react";
import "../projects.css";
import { Button, CopyButton, ErrorState, IconTile, PageHeader, Pill, Progress, Skeleton, Stat, useNow } from "../components";
import { fmt, localDateTime } from "../format";
import { Icon } from "../icons";
import { NewProjectDialog, Welcome } from "../newproject";
import { useProjects, type ProjectSummary } from "../projects";
import { hashFor } from "../route";
import { useMesh } from "../store";
import { WhatTheHostSaid, readOrder } from "../tabs";
import { formatRss } from "../tabmodel";
import { budgetTone } from "../cost";
import { cardActions, cardState, displayNames, failureDetail, groupProjects, hostSummary, lastOpened, usd, type GroupKey } from "../projectsmodel";

type Doing = "opening" | "closing" | "restarting" | "removing";
const DOING_LABEL: Record<Doing, string> = { opening: "Opening…", closing: "Closing…", restarting: "Restarting…", removing: "Removing…" };

function Card({ project, label, groupKey, now, parkedByHost, doing, locked, heading: Heading, onGo, onOpen, onClose, onRestart, onRemove }: {
  project: ProjectSummary;
  label: string;
  groupKey: GroupKey;
  now: number;
  /** The host parked it to stay inside its spend ceiling or turn cap. */
  parkedByHost: boolean;
  doing: Doing | undefined;
  /** The host is not answering: nothing here can work, and the buttons say so by not pretending to. */
  locked: boolean;
  heading: "h3" | "h4";
  onGo: () => void;
  onOpen: () => void;
  onClose: () => void;
  onRestart: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const state = cardState(project, { parkedByHost });
  const acts = cardActions(state.key);
  const problem = failureDetail(project);
  const rss = formatRss(project.health?.rss);
  const off = locked || doing !== undefined;
  const say = state.tone === "warn" || state.tone === "bad";
  // Twelve cards each have an "Open": the project's name is what a screen reader reads after the button's own.
  const nameId = `pj-n-${project.id}`;
  return (
    <li className="pj-card" data-group={groupKey} data-state={state.key}>
      <div className="pj-head">
        <IconTile icon="folder" tone={state.tone === "ok" ? undefined : state.tone} />
        <Heading className="pj-name" id={nameId} title={label}>{label}</Heading>
        <span title={state.sentence}>
          <Pill tone={state.tone === "neutral" ? "neutral" : state.tone} dot={false}>
            <Icon name={state.icon} size={12} />
            <span data-state={state.key} className="pj-state">{state.label}</span>
          </Pill>
        </span>
      </div>
      <p className="pj-path">
        <span className="path-start mono" title={project.root}><bdi>{project.root}</bdi></span>
        <CopyButton compact text={project.root} what="the folder's path" />
      </p>
      <dl className="pj-facts">
        <div>
          <dt>Last opened</dt>
          <dd title={project.lastOpenedAt ? localDateTime(project.lastOpenedAt) : undefined}>{lastOpened(project.lastOpenedAt, now)}</dd>
        </div>
        {state.mode ? (
          <div>
            <dt>Mission</dt>
            <dd>{state.mode === "parked" ? "Parked: nothing runs until it is started" : "Live"}</dd>
          </div>
        ) : null}
        {project.spend ? (
          <>
            <div>
              <dt>Spend</dt>
              <dd title="Estimated at list prices since this project's process last started. The provider's invoice is the bill.">
                {usd(project.spend.usd)} <small>estimated, {fmt(project.spend.tokens)} tokens</small>
              </dd>
            </div>
            <div>
              <dt>Turns</dt>
              <dd>{project.spend.runningTurns} running</dd>
            </div>
          </>
        ) : null}
        {rss ? (
          <div>
            <dt>Memory</dt>
            <dd>{rss}</dd>
          </div>
        ) : null}
      </dl>
      {say ? <p className="pj-problem">{state.sentence}</p> : null}
      {problem ? <WhatTheHostSaid text={problem} /> : null}
      <div className="pj-acts">
        <div className="pj-acts-main">
          {acts.open ? <Button variant={acts.primary === "open" ? "primary" : "soft"} disabled={off} aria-describedby={nameId} onClick={onOpen}>{doing === "opening" ? DOING_LABEL.opening : "Open"}</Button> : null}
          {acts.goTo ? <Button variant={acts.primary === "goTo" ? "primary" : "soft"} icon="chevron-right" disabled={off} aria-describedby={nameId} onClick={onGo}>Go to project</Button> : null}
          {acts.restart ? <Button variant={acts.primary === "restart" ? "primary" : "soft"} icon="refresh" disabled={off} aria-describedby={nameId} onClick={onRestart}>{doing === "restarting" ? DOING_LABEL.restarting : "Restart"}</Button> : null}
          {acts.close ? <Button variant="soft" icon="x" disabled={off} aria-describedby={nameId} onClick={onClose}>{doing === "closing" ? DOING_LABEL.closing : "Close"}</Button> : null}
        </div>
        {/* Forgetting a project is the one act here that cannot be taken back with a click, so it is a quiet red line and not a button as loud as the others. */}
        <Button variant="linklike" extra="pj-remove" disabled={off} aria-describedby={nameId} title="Forget this project on this host. Its files are not touched." onClick={onRemove}>
          {doing === "removing" ? DOING_LABEL.removing : "Remove from host…"}
        </Button>
      </div>
    </li>
  );
}

function Loading(): React.JSX.Element {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading projects…</span>
      <ul className="pj-grid" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="pj-card">
            <div className="pj-head"><Skeleton w={40} h={40} /><Skeleton w="50%" h={16} /></div>
            <Skeleton w="85%" h={22} />
            <Skeleton w="100%" h={44} />
            <Skeleton w="45%" h={36} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Projects(): React.JSX.Element {
  const { projects, loaded, hostDown, hostSpend, lastSyncAt, refreshProjects, openProject, closeProject, restartProject, removeProject, setActive } = useProjects();
  const { confirm } = useMesh();
  const now = useNow(30_000);
  const [adding, setAdding] = useState(false);
  const [doing, setDoing] = useState<Record<string, Doing>>({});

  const names = displayNames(projects);
  const parkedByHost = new Set(hostSpend?.parked ?? []);
  const { groups, headings } = groupProjects(projects, readOrder(), parkedByHost);
  const summary = hostSummary(projects, hostSpend ? { usd: hostSpend.usd, runningTurns: hostSpend.runningTurns, ceilingUsd: hostSpend.ceilingUsd } : null);

  const go = (id: string): void => {
    setActive(id);
    window.location.hash = hashFor(id, "overview");
  };
  const run = async (id: string, what: Doing, action: () => Promise<boolean>): Promise<boolean> => {
    setDoing((d) => ({ ...d, [id]: what }));
    try {
      return await action();
    } finally {
      setDoing((d) => {
        const next = { ...d };
        delete next[id];
        return next;
      });
    }
  };
  const remove = async (p: ProjectSummary): Promise<void> => {
    const name = names.get(p.id) ?? p.name;
    const live = p.status === "open" || p.status === "booting";
    const said = await confirm({
      title: `Remove ${name} from this host?`,
      body: [
        `Its files stay exactly where they are: nothing in ${p.root} is deleted. Its event log and workspace are in that folder, so adding the folder again brings the mission back as it was.`,
        live ? "Its process stops now, and it leaves the project strip." : "It leaves the project strip.",
      ],
      confirmLabel: "Remove from host",
      cancelLabel: "Keep it",
      danger: true,
    });
    if (said === null) return;
    await run(p.id, "removing", () => removeProject(p.id));
  };

  const stale = hostDown && loaded;
  const lede = stale
    ? `Every project registered on this host. The host is not answering: this is the list it last sent${lastSyncAt ? `, ${Math.max(1, Math.round((now - lastSyncAt) / 1000))} seconds ago` : ""}, and it may be out of date.`
    : "Every project registered on this host. Open one to work in it, close it to stop its process, remove it to forget it. Its files are never touched.";

  return (
    <div className="pj-page">
      {loaded && projects.length === 0 ? (
        <Welcome />
      ) : (
        <>
          <PageHeader
            title="Projects"
            lede={lede}
            actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New project</Button>}
          />
          {!loaded && hostDown ? (
            <ErrorState what="projects" detail="The host is not answering, so the list cannot be shown. This page asks again every 5 seconds." onRetry={() => void refreshProjects()} />
          ) : !loaded ? (
            <Loading />
          ) : (
            <>
              <div className="card stat-strip pj-kpis" role="group" aria-label="This host at a glance">
                <div className="stat-cell"><Stat label="Projects" value={summary.total} /></div>
                <div className="stat-cell"><Stat label="Open" value={summary.open} /></div>
                {summary.attention > 0 ? <div className="stat-cell"><Stat label="Need attention" value={summary.attention} tone="bad" /></div> : null}
                <div className="stat-cell"><Stat label="Turns running" value={summary.runningTurns} /></div>
                <div className="stat-cell pj-spend" title="Open projects only, estimated at list prices since each last started. The provider's invoice is the bill.">
                  {summary.usd === null ? (
                    <Stat label="Estimated spend" value="Not reported" size="sm" />
                  ) : (
                    <Stat label="Estimated spend" value={usd(summary.usd)} unit={summary.ceilingUsd !== null ? `of ${usd(summary.ceilingUsd)} ceiling` : undefined}>
                      {summary.ceilingUsd !== null && summary.ceilingUsd > 0 ? (() => { const r = summary.usd / summary.ceilingUsd; const t = budgetTone(r); return <Progress value={summary.usd} max={summary.ceilingUsd} label="Estimated spend against the host's ceiling" tone={t === "ok" ? undefined : t} valueText={`${usd(summary.usd)} of ${usd(summary.ceilingUsd)}`} />; })() : null}
                    </Stat>
                  )}
                </div>
              </div>
              {groups.map((g) => (
                <section key={g.key} className="pj-group" aria-labelledby={headings ? `pj-g-${g.key}` : undefined}>
                  {headings ? <h3 className="group-h" id={`pj-g-${g.key}`}>{g.label} <Pill tone="neutral" dot={false}>{g.items.length}</Pill></h3> : null}
                  <ul className="pj-grid">
                    {g.items.map((p) => (
                      <Card
                        key={p.id}
                        project={p}
                        label={names.get(p.id) ?? p.name}
                        groupKey={g.key}
                        now={now}
                        parkedByHost={parkedByHost.has(p.id)}
                        doing={doing[p.id]}
                        locked={hostDown}
                        heading={headings ? "h4" : "h3"}
                        onGo={() => go(p.id)}
                        onOpen={() => void run(p.id, "opening", async () => { const r = await openProject(p.id); if (r.ok) go(p.id); return r.ok; })}
                        onClose={() => void run(p.id, "closing", async () => (await closeProject(p.id)).ok)}
                        onRestart={() => void run(p.id, "restarting", async () => (await restartProject(p.id)).ok)}
                        onRemove={() => void remove(p)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </>
          )}
        </>
      )}
      {adding ? <NewProjectDialog onClose={() => setAdding(false)} /> : null}
    </div>
  );
}
