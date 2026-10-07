import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import "./files.css";
import { ago, artifactCls, localDateTime, localTime, plainArtifact } from "../format";
import { useMesh } from "../store";
import { useMedia, WIDE } from "../useMedia";
import { useMission } from "../useMission";
import { useMissionActions } from "../useMissionActions";
import { Banner, Button, EmptyState, ErrorState, PageHeader, SearchField, Segmented, Select, Skeleton, Switch } from "../components";
import { ArtifactReader } from "../artifactreader";
import { FileTile } from "../fileview";
import {
  FILE_GROUPS,
  NO_FILTER,
  countLabel,
  emptyCopy,
  filterFiles,
  groupCounts,
  groupFiles,
  latestArtifactSeq,
  nextIndex,
  repoPathOf,
  typeCounts,
  type Art,
  type FileFilter,
} from "../files";

/* What the team made. A list grouped by where each file stands (approved and merged first, then what is in review, then what
 * went back, then drafts), and beside it, on a wide screen, the reader: the file, its versions, what changed, its path.
 * On a narrow screen the list is the page and a file opens in the details panel, because two columns do not fit.
 *
 * The list refreshes itself when an agent publishes or a status changes (it used to be read once, on arrival, and then go
 * stale for the whole run). If a refresh fails after a good load, the page keeps what it has and says so. */

function FileRow({ a, current, tabbable, onOpen, onKey, hold }: {
  a: Art;
  current: boolean;
  tabbable: boolean;
  onOpen: () => void;
  onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
  hold: (el: HTMLButtonElement | null) => void;
}): React.JSX.Element {
  const path = repoPathOf(a);
  return (
    <li>
      <button
        type="button"
        ref={hold}
        className="file-row"
        data-art={a.id}
        tabIndex={tabbable ? 0 : -1}
        aria-current={current ? "true" : undefined}
        onClick={onOpen}
        onKeyDown={onKey}
      >
        <FileTile type={a.type} />
        <span className="file-main">
          <span className="file-name" title={a.name}>{a.name}</span>
          <span className="file-sub">
            <span>{a.type}</span>
            <span>v{a.version}</span>
            <span>{a.owner}</span>
            <span title={localDateTime(a.createdAt)}>{ago(a.createdAt)}</span>
          </span>
          {path ? <span className="file-path mono" title={path}><bdi>{path}</bdi></span> : null}
        </span>
        <span className="file-state" data-tone={artifactCls(a.status)}>{plainArtifact(a.status)}</span>
      </button>
    </li>
  );
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className="files-group" role="status">
      <span className="sr-only">Loading files</span>
      <ul className="file-rows" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="file-skel">
            <Skeleton w={32} h={32} />
            <span className="file-main"><Skeleton w={`${30 + (i % 3) * 10}%`} h={14} /><Skeleton w={`${48 + (i % 2) * 16}%`} h={12} /></span>
            <Skeleton w={72} h={12} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Artifacts(): React.JSX.Element {
  const { client, events, openDrawer } = useMesh();
  const { facts, state } = useMission();
  const actions = useMissionActions();
  const split = useMedia(WIDE);

  const [arts, setArts] = useState<Art[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A refresh that failed after a good load: the list is kept, and the page says how old it is.
  const [stale, setStale] = useState<{ at: string; why: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<FileFilter>(NO_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  const loadedOnce = useRef(false);
  const rows = useRef(new Map<string, HTMLButtonElement>());

  const seq = useMemo(() => latestArtifactSeq(events), [events]);

  useEffect(() => {
    let dead = false;
    const fail = (why: string): void => {
      if (loadedOnce.current) setStale({ at: new Date().toISOString(), why });
      else setErr(why);
    };
    const run = async (): Promise<void> => {
      try {
        const { json, timeout } = await client.api("GET", "/artifacts");
        if (dead) return;
        const list: unknown = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : null;
        if (timeout || !Array.isArray(list)) {
          fail(timeout ? "The request timed out. The server may be busy." : typeof json?.error === "string" ? json.error : "The server sent something this page could not read.");
          return;
        }
        loadedOnce.current = true;
        setArts(list as Art[]);
        setLoaded(true);
        setErr(null);
        setStale(null);
      } catch (e: unknown) {
        if (!dead) fail(e instanceof Error ? e.message : String(e));
      }
    };
    // The first read is immediate; one prompted by an event waits a beat, so a burst of publishes is one read.
    const t = setTimeout(() => void run(), loadedOnce.current ? 350 : 0);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [attempt, client, seq]);

  const visible = useMemo(() => filterFiles(arts, filter), [arts, filter]);
  const groups = useMemo(() => groupFiles(visible), [visible]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const types = useMemo(() => typeCounts(arts), [arts]);
  const counts = useMemo(() => groupCounts(filterFiles(arts, { ...filter, group: "" })), [arts, filter]);
  const total = useMemo(() => Object.values(counts).reduce((n, c) => n + c, 0), [counts]);

  // The reader follows the person's choice while that file is still in the list; when it is not, or nothing is chosen,
  // it shows the first file, so the right half of the page is never an empty box.
  const active = split && flat.length ? (selected && flat.some((a) => a.id === selected) ? selected : flat[0]!.id) : null;
  const activeArt = active ? flat.find((a) => a.id === active) : undefined;
  const activeIndex = Math.max(0, flat.findIndex((a) => a.id === (selected ?? active)));

  const open = (a: Art): void => {
    setSelected(a.id);
    if (!split) openDrawer(<ArtifactReader id={a.id} as="drawer" />);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (!["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const to = nextIndex(e.key, index, flat.length);
    const target = to >= 0 ? flat[to] : undefined;
    if (target) rows.current.get(target.id)?.focus();
  };

  const filtering = filter.query.trim() !== "" || filter.type !== "" || filter.group !== "";
  const copy = emptyCopy(state.phase, facts.hasHistory);
  const startable = copy.start && state.primary && (state.primary.action === "start" || state.primary.action === "resume");

  let index = -1;
  return (
    <>
      <PageHeader
        title="Files"
        status={loaded ? <span className="count-note" role="status">{countLabel(visible.length, arts.length)}</span> : null}
        lede="What the team made. Read a file, compare its versions, copy its path."
        actions={loaded && arts.length > 0 ? (
          <span title="When two files share a name and type, show only the newest. Older ones stay in the manifest.">
            <Switch label="Latest of each name" checked={filter.latestOnly} onChange={() => setFilter({ ...filter, latestOnly: !filter.latestOnly })} />
          </span>
        ) : null}
      />

      {stale ? (
        <Banner tone="warn" title="This list may be out of date." actions={<Button variant="banner-act" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Refresh now</Button>}>
          The last refresh failed at {localTime(stale.at)} ({stale.why.replace(/\.$/, "")}). It shows what the server last sent.
        </Banner>
      ) : null}

      {err && !loaded ? (
        <ErrorState what="the file list" detail={err} onRetry={() => { setErr(null); setAttempt((n) => n + 1); }} />
      ) : !loaded ? (
        <ListSkeleton />
      ) : arts.length === 0 ? (
        <EmptyState
          icon="files"
          title={copy.title}
          action={startable && state.primary ? <Button variant="primary" onClick={() => actions.run(state.primary!.action)}>{state.primary.label}</Button> : null}
        >
          {copy.body}
        </EmptyState>
      ) : (
        <>
          <div className="files-bar" role="search">
            <SearchField
              label="Search files"
              placeholder="Name, owner, type or path"
              value={filter.query}
              onChange={(e) => setFilter({ ...filter, query: e.target.value })}
              onClear={() => setFilter({ ...filter, query: "" })}
            />
            <Select aria-label="Type" value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
              <option value="">All types</option>
              {types.map((t) => <option key={t.type} value={t.type}>{t.type} ({t.n})</option>)}
            </Select>
            <Segmented
              label="Status"
              value={filter.group}
              onChange={(id) => setFilter({ ...filter, group: id })}
              options={[
                { id: "" as FileFilter["group"], label: <>All<span className="seg-n">{total}</span></> },
                ...FILE_GROUPS.filter((g) => counts[g.id] > 0 || filter.group === g.id).map((g) => ({ id: g.id as FileFilter["group"], label: <>{g.short}<span className="seg-n">{counts[g.id]}</span></>, hint: g.label })),
              ]}
            />
          </div>

          <div className={`files-layout${split ? " split" : ""}`}>
            <div className="files-list">
              {visible.length === 0 ? (
                <EmptyState
                  icon="search"
                  title="No file matches"
                  action={<Button variant="small" onClick={() => setFilter({ ...NO_FILTER, latestOnly: filter.latestOnly })}>Clear the filters</Button>}
                >
                  {filtering ? `${arts.length} ${arts.length === 1 ? "file is" : "files are"} hidden by the search and filters above.` : "Every file is hidden."}
                </EmptyState>
              ) : (
                groups.map((g) => (
                  <section className="files-group" key={g.id} aria-labelledby={`fg-${g.id}`}>
                    <h3 className="files-group-h" id={`fg-${g.id}`}>{g.label}<span className="files-group-n">{g.items.length}</span></h3>
                    <ul className="file-rows">
                      {g.items.map((a) => {
                        index += 1;
                        const i = index;
                        return (
                          <FileRow
                            key={a.id}
                            a={a}
                            current={split && a.id === active}
                            tabbable={i === activeIndex}
                            onOpen={() => open(a)}
                            onKey={(e) => onKey(e, i)}
                            hold={(el) => { if (el) rows.current.set(a.id, el); else rows.current.delete(a.id); }}
                          />
                        );
                      })}
                    </ul>
                  </section>
                ))
              )}
            </div>
            {split ? (
              <aside className="files-reader" aria-label="File reader">
                {active ? <ArtifactReader key={active} id={active} as="pane" stamp={activeArt ? `${activeArt.version}:${activeArt.status}` : undefined} /> : <p className="fv-empty">Select a file to read it.</p>}
              </aside>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
