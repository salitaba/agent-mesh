import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMesh, type TimelineEvent } from "../store";
import { AgentAvatar, Banner, Button, EmptyState, ErrorState, PageHeader, SearchField, Select, Skeleton, Switch, agentColor, useNow } from "../components";
import { EventDetail, EventMissing } from "../evdetail";
import { Icon, type IconName } from "../icons";
import { EV_FILTER_GROUPS, EventSummary, SEVERITY_META, SEVERITY_ORDER, SevMark, evSeverity, severityTitle, sevWord, useNameOf } from "../events";
import {
  applySeverity, buildRows, eventHaystack, evGroupOf, facetOne, facetValues, filterBase, parseFacets, setFacet, severityCounts, toggleFacet, topActors,
  type EventFilter, type NameOf, type Severity,
} from "../eventmodel";
import { heldList, newestKey } from "../feed";
import { FeedStatus, HoldBar, PauseButton, useFeedHold } from "../feedstatus";
import { useRoving } from "../rovinglist";
import { titleWhenClipped } from "../domutil";
import { localDateTime, localTime, plainEvent, plural, zoneLabel } from "../format";
import { useMission } from "../useMission";
import { useMissionActions } from "../useMissionActions";
import "./events.css";

/**
 * The events console.
 *
 * This is the page you leave open while a run is live, so every decision here bends toward "can you find the one line that
 * matters, right now": severity ranking so failures are not shaped like bookkeeping, folding so routine runs take one row
 * instead of forty, and a detail pane beside the list rather than a modal over it, because reading an event must not stop you
 * watching the stream that produced it.
 *
 * The decisions themselves (severity, facets, folding, what a hold hides) live in eventmodel.ts and feed.ts, which node:test
 * covers. This file lays them out.
 */

/** Rows built at once. Folding usually keeps the real DOM count far below this. */
const CAP = 300;

const NO_EVENT_FILTER: EventFilter = { search: "", groups: new Set(), actor: null, thread: null };

/* ------------------------------- rows ---------------------------------- */

/** What stands for an event that no agent of the mesh acted in: the kind of thing it is. */
const KIND_ICON: Record<string, IconName> = { message: "message", agent: "agents", work: "files", system: "sliders" };

/**
 * One event as one line of a ledger: when, who (the seat's own avatar, or a mark for the kind of thing when no seat acted), what
 * happened, and what kind of event it was. The mark of an alert is a triangle in a red tile, and of routine bookkeeping an outline: the
 * shape says it as well as the colour. The actor is in the sentence, in bold, so it is not a column of its own.
 */
const EvLine = memo(function EvLine({ e, selected, tab, roster, onOpen, onTab, nameOf }: {
  e: TimelineEvent; selected: boolean; tab: boolean; roster: ReadonlySet<string>; onOpen: (seq: number) => void; onTab: (key: string) => void; nameOf: NameOf;
}): React.JSX.Element {
  const sev = evSeverity(e);
  const seat = e.actorId && roster.has(e.actorId) ? e.actorId : null;
  return (
    <button
      type="button"
      data-rv=""
      data-seq={e.seq}
      tabIndex={tab ? 0 : -1}
      className={`evc-row sev-${sev}${selected ? " on" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen(e.seq)}
      onFocus={() => onTab(String(e.seq))}
    >
      <time dateTime={e.timestamp} title={`${localDateTime(e.timestamp)} (${e.timestamp})`}>{localTime(e.timestamp)}</time>
      <span className={`evc-tile ${sev}`} title={e.actorId ? `Acted by ${e.actorId}` : undefined}>
        {sev === "alert" ? <Icon name="alert" size={14} /> : seat ? <AgentAvatar id={seat} color={agentColor(seat)} size="sm" /> : <Icon name={KIND_ICON[evGroupOf(e.type)] ?? "sliders"} size={14} />}
        <span className="sr-only">{sevWord(sev)}</span>
      </span>
      <span className="evc-sum" onMouseEnter={titleWhenClipped}><EventSummary e={e} nameOf={nameOf} /></span>
      <span className="evc-type" title={e.type} onMouseEnter={titleWhenClipped}>{plainEvent(e.type, e.payload)}</span>
    </button>
  );
});

function Rows(): React.JSX.Element {
  return (
    <div className="evc-skel" aria-busy="true" aria-label="Loading events">
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <div key={i} className="evc-skel-row">
          <Skeleton w={52} h={12} /><Skeleton w={26} h={26} round /><Skeleton w={`${40 + ((i * 17) % 40)}%`} h={12} />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------- view ---------------------------------- */

export default function Events(): React.JSX.Element {
  const { events, evSearch, setEvSearch, evFilter, setEvFilter, primeEvents, client, detail, openDetail, closeDetail, status } = useMesh();
  const { state } = useMission();
  const missionActions = useMissionActions();

  // "No matching events" used to be shown while the first fetch was still in flight and again after it failed, so an empty log,
  // a slow server and a dead one were the same screen. Three states, three answers.
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [foldPref, setFoldPref] = useState(true);
  // On a phone the chips are folded behind a button; on a wide screen they are always there and this does nothing.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const listRef = useRef<HTMLDivElement | null>(null);
  const paneRef = useRef<HTMLElement | null>(null);

  // 15s: fast enough that "2m ago" is never a lie worth noticing, slow enough that a quiet console is not re-rendering a 300-row
  // list every second.
  const now = useNow(15_000);

  useEffect(() => {
    let dead = false;
    if (events.length > 0) return;
    setLoading(true);
    setLoadErr(null);
    client.api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 })
      .then(({ json, timeout }) => {
        if (dead) return;
        if (timeout) setLoadErr("The request timed out. The server may be busy.");
        else primeEvents(json || []);
      })
      .catch((e: unknown) => {
        if (!dead) setLoadErr(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!dead) setLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [events.length, client, primeEvents, attempt]);

  // The log is the authority, and the live stream is not complete: it carries only the event types the console subscribed to by
  // name, so the rest (a seat restarted, a requirement satisfied, a release accepted) used to appear only after a reload. The
  // status poll already says how long the log is. When it is longer than what this console has seen, fetch the difference, a few
  // times at most: an honest "Live" has to mean "nothing is missing", not "nothing has arrived".
  // The newest event this console has seen. It is also the place a hold is marked at, below: a place in the whole stream, not in
  // the filtered list, so a filter changing under a hold must not move it.
  const newest = useMemo(() => newestKey(events, (e) => e.seq), [events]);
  const logLength = status?.eventCount;
  const behind = typeof logLength === "number" && logLength > newest;
  const reconcileTries = useRef(0);
  useEffect(() => {
    if (!behind) {
      reconcileTries.current = 0;
      return;
    }
    if (reconcileTries.current >= 3) return;
    const t = setTimeout(() => {
      reconcileTries.current++;
      client.api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 })
        .then(({ json }) => { if (Array.isArray(json)) primeEvents(json); })
        .catch(() => undefined);
    }, 1500);
    return () => clearTimeout(t);
  }, [behind, logLength, newest, client, primeEvents]);

  /* ----------------------------- facets -------------------------------- */

  const facets = useMemo(() => parseFacets(evFilter), [evFilter]);
  const sevOn = useMemo(() => new Set(facetValues(facets, "sev")), [facets]);
  const grpOn = useMemo(() => new Set(facetValues(facets, "grp")), [facets]);
  const actorOn = facetOne(facets, "actor");
  const threadOn = facetOne(facets, "thread");

  // What the folded button counts: the chips that are on (the agent is in plain sight, the thread has its own bar).
  const chipCount = sevOn.size + grpOn.size;
  const toggle = useCallback((token: string) => setEvFilter(toggleFacet(evFilter, token)), [evFilter, setEvFilter]);
  /** Single-valued facets replace rather than accumulate. */
  const setOne = useCallback((ns: string, value: string | null) => setEvFilter(setFacet(evFilter, ns, value)), [evFilter, setEvFilter]);

  /* ---------------------------- filtering ------------------------------ */

  // The haystack only changes when the buffer does; building it inside the filter re-stringified up to 800 payloads on every
  // keystroke. It holds each row's line, so a file is found by its name on the rows that name it.
  const nameOf = useNameOf(events);
  // The seats of the mesh, as a set that keeps its identity while the roster does: the status is read every few seconds, and a new set
  // each time would draw every row again.
  const seatIds = ((status?.agents ?? []) as { id: string }[]).map((a) => a.id).join("\n");
  const roster = useMemo(() => new Set(seatIds ? seatIds.split("\n") : []), [seatIds]);
  const hay = useMemo(() => events.map((e) => eventHaystack(e, nameOf)), [events, nameOf]);
  const actors = useMemo(() => topActors(events), [events]);

  // Everything except the severity facet. Severity counts are taken from this, so "Alerts 3" means three alerts within what you
  // are already looking at: a count against the whole buffer would send you to an empty list.
  const base = useMemo(
    () => filterBase(events, hay, { ...NO_EVENT_FILTER, search: evSearch.trim().toLowerCase(), groups: grpOn, actor: actorOn, thread: threadOn }),
    [events, hay, evSearch, grpOn, actorOn, threadOn],
  );
  const counts = useMemo(() => severityCounts(base), [base]);
  const matched = useMemo(() => applySeverity(base, sevOn), [base, sevOn]);

  /* ----------------------- holding the list still ---------------------- */

  const hold = useFeedHold(newest);
  const held = useMemo(() => heldList(matched, (e) => e.seq, hold.mark), [matched, hold.mark]);
  const shown = useMemo(() => held.shown.slice(0, CAP), [held.shown]);

  // Folding a list you have explicitly filtered down to routine events would collapse the entire result into one row. Asking for
  // them turns it off.
  const folding = foldPref && !sevOn.has("routine");
  const rows = useMemo(() => buildRows(shown, now, folding), [shown, now, folding]);
  // How many events sit under each time heading, folded ones included: a heading that said nothing of its size made the list read as one run.
  const inBucket = useMemo(() => {
    const n = new Map<string, number>();
    let key = "";
    for (const r of rows) {
      if (r.kind === "bucket") key = r.key;
      else n.set(key, (n.get(key) ?? 0) + (r.kind === "fold" ? r.items.length : 1));
    }
    return n;
  }, [rows]);

  /* ---------------------------- selection ------------------------------ */

  const selectedSeq = detail?.kind === "event" ? Number(detail.id) : null;
  const selected = useMemo(() => (selectedSeq == null ? null : events.find((e) => e.seq === selectedSeq) ?? null), [events, selectedSeq]);
  const open = useCallback((seq: number) => openDetail("event", String(seq)), [openDetail]);

  // Every row the list holds, in order: the roving tab stop is one of these, and arrows walk them.
  const rowKeys = useMemo(
    () => rows.flatMap((r) => (r.kind === "event" ? [String(r.e.seq)] : r.kind === "fold" ? [r.key, ...(openFolds.has(r.key) ? r.items.map((e) => String(e.seq)) : [])] : [])),
    [rows, openFolds],
  );
  const roving = useRoving(rowKeys);

  // Esc closes the pane (the shell owns that), and the row it was opened from is where focus belongs afterwards.
  const returnTo = useRef<number | null>(null);
  useEffect(() => {
    if (selectedSeq !== null) {
      returnTo.current = selectedSeq;
      return;
    }
    const seq = returnTo.current;
    returnTo.current = null;
    if (seq !== null && (document.activeElement === document.body || !document.activeElement)) {
      listRef.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`)?.focus();
    }
  }, [selectedSeq]);
  // On a phone the pane takes the whole area and the list is not on screen: land on the pane, not on nothing.
  useEffect(() => {
    if (selectedSeq !== null && window.matchMedia("(max-width: 900px)").matches) paneRef.current?.focus();
  }, [selectedSeq]);

  const showNewest = useCallback(() => {
    hold.release();
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [hold]);

  const clearAll = useCallback(() => {
    setEvFilter("");
    setEvSearch("");
  }, [setEvFilter, setEvSearch]);

  const firstLoad = !events.length;
  const filtered = facets.size > 0 || evSearch.trim().length > 0;
  const zone = zoneLabel();
  const startable = state.primary && (state.primary.action === "start" || state.primary.action === "resume") ? state.primary : null;

  return (
    <div className="ev-page">
      <PageHeader
        title="Events"
        status={<FeedStatus />}
        actions={<PauseButton paused={hold.paused} onToggle={() => hold.setPaused(!hold.paused)} noun="events" />}
        lede={`Everything the mesh does, newest first. Times are in ${zone}.`}
      />

      <div className="ev-tools" role="search">
        <SearchField id="ev-search" label="Search events" placeholder="Messages, agents, files" hint="/" value={evSearch} onChange={(e) => setEvSearch(e.target.value)} onClear={() => setEvSearch("")} />
        <label className="sr-only" htmlFor="ev-actor">Filter by agent</label>
        <Select id="ev-actor" value={actorOn ?? ""} onChange={(e) => setOne("actor", e.target.value || null)}>
          <option value="">Every agent</option>
          {actors.map((a) => <option key={a} value={a}>{a}</option>)}
        </Select>
        <Button variant="soft" icon="sliders" extra="ev-filters-toggle" aria-expanded={filtersOpen} aria-controls="ev-facets" onClick={() => setFiltersOpen((o) => !o)}>
          Filters{chipCount ? ` (${chipCount})` : ""}
        </Button>
        {filtered ? <Button variant="ghost" icon="x" onClick={clearAll}>Clear filters</Button> : null}
      </div>

      <div className={`ev-facets${filtersOpen ? " open" : ""}`} id="ev-facets">
        <div className="seg ev-facet-group" role="group" aria-label="Filter by importance">
          {SEVERITY_ORDER.map((s: Severity) => (
            <button
              key={s}
              type="button"
              className={`sev-${s}`}
              aria-pressed={sevOn.has(s)}
              title={severityTitle(s)}
              onClick={() => toggle(`sev:${s}`)}
            >
              <SevMark s={s} />
              {SEVERITY_META[s].label}
              <span className="ev-n">{counts[s]}</span>
            </button>
          ))}
        </div>
        <div className="seg ev-facet-group" role="group" aria-label="Filter by kind">
          {EV_FILTER_GROUPS.map((g) => (
            <button key={g.id} type="button" aria-pressed={grpOn.has(g.id)} onClick={() => toggle(`grp:${g.id}`)}>
              <Icon name={KIND_ICON[g.id] ?? "sliders"} size={14} />
              {g.label}
            </button>
          ))}
        </div>
        <span title="Collapse runs of routine bookkeeping into a single row">
          <Switch label="Fold routine events" checked={foldPref} onChange={() => setFoldPref((f) => !f)} />
        </span>
      </div>

      {threadOn ? (
        <Banner tone="info" icon="graph" title="Following one thread." actions={<Button variant="banner-act" onClick={() => setOne("thread", null)}>Show everything</Button>}>
          <code>{threadOn}</code>
        </Banner>
      ) : null}

      <div className={`evc${selectedSeq != null ? " split" : ""}`}>
        <div className="evc-stream">
          {loadErr && firstLoad ? (
            <ErrorState what="the event log" detail={loadErr} onRetry={() => setAttempt((n) => n + 1)} />
          ) : loading && firstLoad ? (
            <Rows />
          ) : !rows.length && !hold.paused && held.fresh === 0 ? (
            events.length ? (
              <EmptyState icon="search" title="No events match" action={<Button variant="small" onClick={clearAll}>Clear filters</Button>}>
                Widen a filter, or clear them all to see every event.
              </EmptyState>
            ) : (
              <EmptyState
                icon="events"
                title="No events yet"
                action={startable ? <Button variant="primary" icon="play" onClick={() => missionActions.run(startable.action)}>{startable.label}</Button> : undefined}
              >
                {startable ? "Events appear as soon as the mesh does something. Nothing is running yet." : "Events appear as soon as an agent takes a turn."}
              </EmptyState>
            )
          ) : (
            <>
              <HoldBar paused={hold.paused} fresh={held.fresh} noun="event" onShow={showNewest} />
              <div className="evc-list" ref={listRef} onKeyDown={roving.onKeyDown} {...hold.listProps}>
                {rows.map((r) => {
                  if (r.kind === "bucket") {
                    return (
                      <h3 key={r.key} className="evc-bucket">
                        <span>{r.label}</span>
                        <span className="evc-bucket-n">{plural(inBucket.get(r.key) ?? 0, "event")}</span>
                      </h3>
                    );
                  }
                  if (r.kind === "event") {
                    return <EvLine key={r.key} e={r.e} selected={r.e.seq === selectedSeq} tab={roving.stop === String(r.e.seq)} roster={roster} onOpen={open} onTab={roving.setLast} nameOf={nameOf} />;
                  }
                  const isOpen = openFolds.has(r.key);
                  const newestItem = r.items[0]!;
                  const oldestItem = r.items[r.items.length - 1]!;
                  return (
                    <div key={r.key} className={`evc-fold${isOpen ? " open" : ""}`}>
                      <button
                        type="button"
                        data-rv=""
                        tabIndex={roving.stop === r.key ? 0 : -1}
                        className="evc-foldbar"
                        aria-expanded={isOpen}
                        onFocus={() => roving.setLast(r.key)}
                        onClick={() => setOpenFolds((cur) => {
                          const next = new Set(cur);
                          if (next.has(r.key)) next.delete(r.key);
                          else next.add(r.key);
                          return next;
                        })}
                      >
                        <Icon name="chevron-right" size={12} className={isOpen ? "caret turned" : "caret"} />
                        <span><b>{r.items.length}</b> routine events</span>
                        <span className="evc-fold-range">{localTime(oldestItem.timestamp)} to {localTime(newestItem.timestamp)}</span>
                      </button>
                      {isOpen ? r.items.map((e) => (
                        <EvLine key={e.seq || e.id} e={e} selected={e.seq === selectedSeq} tab={roving.stop === String(e.seq)} roster={roster} onOpen={open} onTab={roving.setLast} nameOf={nameOf} />
                      )) : null}
                    </div>
                  );
                })}
                {held.shown.length > shown.length ? (
                  <p className="list-more" role="status">
                    Showing the newest <b>{shown.length}</b> of <b>{held.shown.length.toLocaleString("en-US")}</b> matching events. Narrow the search to reach older ones.
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>

        {selectedSeq != null ? (
          <aside className="evc-detail" aria-label="Event detail" ref={paneRef} tabIndex={-1}>
            {selected ? (
              <EventDetail
                e={selected}
                all={events}
                onSelect={open}
                threadOn={!!threadOn && threadOn === selected.correlationId}
                onFollowThread={(cid) => setOne("thread", cid)}
                onOpenStep={(turnId) => openDetail("step", turnId, "steps")}
                onClose={closeDetail}
              />
            ) : (
              <EventMissing seq={selectedSeq} onClose={closeDetail} />
            )}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
