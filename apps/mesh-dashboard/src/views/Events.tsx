import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMesh, type TimelineEvent } from "../store";
import { Button, ErrorState, Input, useNow } from "../components";
import { EventDetail, EventMissing } from "../evdetail";
import {
  EV_FILTER_GROUPS,
  EventSummary,
  SEVERITY_META,
  SEVERITY_ORDER,
  evClass,
  evGroupOf,
  evSearchText,
  evSeverity,
  type Severity,
} from "../events";
import { hhmmss, plainEvent } from "../format";

/**
 * The events console.
 *
 * This is the page you leave open while a run is live, so every decision here
 * bends toward "can you find the one line that matters, right now": severity
 * ranking so failures are not shaped like bookkeeping, folding so routine runs
 * take one row instead of forty, and a detail pane beside the list rather than
 * a modal over it — because reading an event must not stop you watching the
 * stream that produced it.
 */

/** Rows built at once. Folding usually keeps the real DOM count far below this. */
const CAP = 300;
/** A run of this many consecutive routine events collapses into one row. */
const FOLD_AT = 3;

/* ------------------------------ facets --------------------------------- */

/* One comma-joined, namespaced string holds every facet -- `sev:alert,grp:message`.
   It lives in the store's `evFilter`, which already survives view switches and
   was previously a single group id. Keeping it as one string means no new store
   state for four independent filters, and the whole filter set is one value to
   reset. */

const parseFacets = (s: string): Set<string> => new Set(s.split(",").filter(Boolean));
const pick = (f: Set<string>, ns: string): string[] => [...f].filter((x) => x.startsWith(`${ns}:`)).map((x) => x.slice(ns.length + 1));
const one = (f: Set<string>, ns: string): string | null => pick(f, ns)[0] ?? null;

/* ------------------------------- rows ---------------------------------- */

const BUCKETS: { id: string; label: string; ms: number }[] = [
  { id: "now", label: "Last 5 minutes", ms: 5 * 60_000 },
  { id: "recent", label: "5 to 30 minutes ago", ms: 30 * 60_000 },
  { id: "hour", label: "30 minutes to 2 hours ago", ms: 2 * 3_600_000 },
  { id: "day", label: "2 to 12 hours ago", ms: 12 * 3_600_000 },
  { id: "older", label: "Earlier", ms: Infinity },
];

const bucketOf = (e: TimelineEvent, now: number): { id: string; label: string } => {
  const age = now - Date.parse(e.timestamp);
  return BUCKETS.find((b) => age < b.ms) ?? BUCKETS[BUCKETS.length - 1];
};

type Row =
  | { kind: "bucket"; key: string; label: string }
  | { kind: "event"; key: string; e: TimelineEvent }
  | { kind: "fold"; key: string; items: TimelineEvent[] };

/**
 * Bucket headers and folded runs in one pass.
 *
 * A run is flushed on a non-routine event *and* on a bucket boundary, so a fold
 * never straddles two time headings and claim events happened closer together
 * than they did.
 */
function buildRows(list: TimelineEvent[], now: number, fold: boolean): Row[] {
  const out: Row[] = [];
  let run: TimelineEvent[] = [];
  let bucket = "";

  const flush = (): void => {
    if (run.length >= FOLD_AT) out.push({ kind: "fold", key: `f${run[0].seq}`, items: run });
    else for (const e of run) out.push({ kind: "event", key: String(e.seq || e.id), e });
    run = [];
  };

  for (const e of list) {
    const b = bucketOf(e, now);
    if (b.id !== bucket) {
      flush();
      bucket = b.id;
      out.push({ kind: "bucket", key: `b${b.id}`, label: b.label });
    }
    if (fold && evSeverity(e) === "routine") {
      run.push(e);
      continue;
    }
    flush();
    out.push({ kind: "event", key: String(e.seq || e.id), e });
  }
  flush();
  return out;
}

function EvLine({ e, selected, onOpen }: { e: TimelineEvent; selected: boolean; onOpen: (seq: number) => void }): React.JSX.Element {
  const sev = evSeverity(e);
  return (
    <button
      type="button"
      className={`evc-row sev-${sev}${selected ? " on" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen(e.seq)}
    >
      <span className="evc-glyph" aria-hidden="true">{SEVERITY_META[sev].glyph}</span>
      <time title={e.timestamp}>{hhmmss(e.timestamp)}</time>
      <span className={`type ${evClass(e.type)}`}>{plainEvent(e.type)}</span>
      <span className="summary"><EventSummary e={e} /></span>
      {e.actorId ? <span className="evc-actor">{e.actorId}</span> : null}
    </button>
  );
}

/* ------------------------------- view ---------------------------------- */

export default function Events(): React.JSX.Element {
  const {
    events, evSearch, setEvSearch, evFilter, setEvFilter,
    livePaused, setLivePaused, primeEvents, client, detail, openDetail, closeDetail,
  } = useMesh();

  // "No matching events" used to be shown while the first fetch was still in
  // flight and again after it failed, so an empty log, a slow server and a dead
  // one were the same screen. Three states, three answers.
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [foldPref, setFoldPref] = useState(true);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const [awaySeq, setAwaySeq] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 15s: fast enough that "2m ago" is never a lie worth noticing, slow enough
  // that a quiet console is not re-rendering a 300-row list every second.
  const now = useNow(15_000);

  useEffect(() => {
    let dead = false;
    if (events.length > 0) return;
    setLoading(true);
    setLoadErr(null);
    client.api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 })
      .then(({ json, timeout }) => {
        if (dead) return;
        if (timeout) setLoadErr("the request timed out — the server may be busy.");
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

  /* ----------------------------- facets -------------------------------- */

  const facets = useMemo(() => parseFacets(evFilter), [evFilter]);
  const sevOn = useMemo(() => new Set(pick(facets, "sev")), [facets]);
  const grpOn = useMemo(() => new Set(pick(facets, "grp")), [facets]);
  const actorOn = one(facets, "actor");
  const threadOn = one(facets, "thread");

  const toggle = useCallback((token: string) => {
    setEvFilter([...(() => {
      const next = parseFacets(evFilter);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    })()].join(","));
  }, [evFilter, setEvFilter]);

  /** Single-valued facets replace rather than accumulate. */
  const setOne = useCallback((ns: string, value: string | null) => {
    const next = [...parseFacets(evFilter)].filter((x) => !x.startsWith(`${ns}:`));
    if (value) next.push(`${ns}:${value}`);
    setEvFilter(next.join(","));
  }, [evFilter, setEvFilter]);

  /* ---------------------------- filtering ------------------------------ */

  // The haystack only changes when the buffer does; building it inside the
  // filter re-stringified up to 800 payloads on every keystroke.
  const hay = useMemo(
    () => events.map((e) => `${e.type} ${e.actorId || ""} ${evSearchText(e)} ${JSON.stringify(e.payload || {}).slice(0, 600)}`.toLowerCase()),
    [events],
  );

  const actors = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of events) if (e.actorId) n.set(e.actorId, (n.get(e.actorId) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id]) => id);
  }, [events]);

  // Everything except the severity facet. Severity counts are taken from this,
  // so "Alerts 3" means three alerts *within what you are already looking at* —
  // a count against the whole buffer would send you to an empty list.
  const base = useMemo(() => {
    const q = evSearch.trim().toLowerCase();
    const out: TimelineEvent[] = [];
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (grpOn.size && !grpOn.has(evGroupOf(e.type))) continue;
      if (actorOn && e.actorId !== actorOn) continue;
      if (threadOn && e.correlationId !== threadOn) continue;
      if (q && !hay[i].includes(q)) continue;
      out.push(e);
    }
    return out;
  }, [events, hay, evSearch, grpOn, actorOn, threadOn]);

  const counts = useMemo(() => {
    const c: Record<Severity, number> = { alert: 0, notice: 0, routine: 0 };
    for (const e of base) c[evSeverity(e)]++;
    return c;
  }, [base]);

  const matched = useMemo(() => (sevOn.size ? base.filter((e) => sevOn.has(evSeverity(e))) : base), [base, sevOn]);
  const shown = useMemo(() => matched.slice(0, CAP), [matched]);

  // Folding a list you have explicitly filtered down to routine events would
  // collapse the entire result into one row. Asking for them turns it off.
  const folding = foldPref && !sevOn.has("routine");
  const rows = useMemo(() => buildRows(shown, now, folding), [shown, now, folding]);

  /* ---------------------------- selection ------------------------------ */

  const selectedSeq = detail?.kind === "event" ? Number(detail.id) : null;
  const selected = useMemo(
    () => (selectedSeq == null ? null : events.find((e) => e.seq === selectedSeq) ?? null),
    [events, selectedSeq],
  );
  const open = useCallback((seq: number) => openDetail("event", String(seq)), [openDetail]);

  /* --------------------------- follow tail ----------------------------- */

  /* Newest-first, so following the tail is just being at the top: prepended
     rows do not move the scroll position. All this has to do is notice when
     you have scrolled away and count what arrived while you were reading. */
  const onScroll = useCallback((ev: React.UIEvent<HTMLDivElement>) => {
    const top = ev.currentTarget.scrollTop;
    setAwaySeq((cur) => (top > 24 ? cur ?? (shown[0]?.seq ?? 0) : null));
  }, [shown]);

  const newAbove = awaySeq == null ? 0 : matched.reduce((n, e) => (e.seq > awaySeq ? n + 1 : n), 0);
  const jumpToNewest = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setAwaySeq(null);
  }, []);

  const clearAll = useCallback(() => {
    setEvFilter("");
    setEvSearch("");
  }, [setEvFilter, setEvSearch]);

  const firstLoad = !events.length;
  const filtered = facets.size > 0 || evSearch.trim().length > 0;

  return (
    <>
      <div className="view-title">
        <h2>Events</h2>
        <span className="muted">{livePaused ? "paused" : "live"}</span>
        <span className="page-actions">
          <Button variant="small" aria-pressed={livePaused} onClick={() => setLivePaused(!livePaused)}>
            {livePaused ? "▶ resume" : "❚❚ pause"}
          </Button>
        </span>
      </div>
      <div className="view-sub">
        Everything the mesh is doing, newest first. Filter down to alerts when something breaks;
        open a line to see what caused it.
      </div>

      <div className="evc-filters">
        <Input
          search id="ev-search" aria-label="Search events"
          placeholder="search messages, agents, files… ( / )"
          value={evSearch} onChange={(e) => setEvSearch(e.target.value)}
        />
        <div className="evc-facets" role="group" aria-label="Filter by importance">
          {SEVERITY_ORDER.map((s) => (
            <button
              key={s} type="button" className={`fchip sev-${s} ${sevOn.has(s) ? "on" : ""}`}
              aria-pressed={sevOn.has(s)} title={SEVERITY_META[s].hint}
              onClick={() => toggle(`sev:${s}`)}
            >
              <span aria-hidden="true">{SEVERITY_META[s].glyph}</span> {SEVERITY_META[s].label}
              <span className="evc-n">{counts[s]}</span>
            </button>
          ))}
        </div>
        <div className="evc-facets" role="group" aria-label="Filter by kind">
          {EV_FILTER_GROUPS.map((g) => (
            <button
              key={g.id} type="button" className={`fchip ${grpOn.has(g.id) ? "on" : ""}`}
              aria-pressed={grpOn.has(g.id)} onClick={() => toggle(`grp:${g.id}`)}
            >{g.label}</button>
          ))}
        </div>
        <div className="evc-facets evc-right">
          <select
            className="evc-actor-sel" aria-label="Filter by agent"
            value={actorOn ?? ""} onChange={(e) => setOne("actor", e.target.value || null)}
          >
            <option value="">every agent</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <button
            type="button" className={`fchip ${foldPref ? "on" : ""}`} aria-pressed={foldPref}
            title="Collapse runs of routine bookkeeping into a single row"
            onClick={() => setFoldPref((f) => !f)}
          >fold routine</button>
          {filtered ? <button type="button" className="fchip evc-clear" onClick={clearAll}>clear</button> : null}
        </div>
      </div>

      {threadOn ? (
        <div className="evc-thread-bar" role="status">
          Following one thread — <code>{threadOn}</code>
          <button type="button" className="fchip" onClick={() => setOne("thread", null)}>show everything</button>
        </div>
      ) : null}

      <div className={`evc${selectedSeq != null ? " split" : ""}`}>
        <div className="evc-stream">
          {loadErr && firstLoad ? (
            <ErrorState what="the event log" detail={loadErr} onRetry={() => setAttempt((n) => n + 1)} />
          ) : loading && firstLoad ? (
            <div className="empty"><div className="big">…</div><div>loading events</div></div>
          ) : !rows.length ? (
            <div className="empty">
              <div className="big">{events.length ? "◦" : "·"}</div>
              {events.length ? (
                <div>Nothing matches.<br /><span className="muted">Widen a filter, or <button type="button" className="linky" onClick={clearAll}>clear them all</button>.</span></div>
              ) : (
                <div>No events yet.<br /><span className="muted">They appear the moment an agent takes a turn.</span></div>
              )}
            </div>
          ) : (
            <>
              {newAbove > 0 ? (
                <button type="button" className="evc-new" onClick={jumpToNewest} role="status">
                  {newAbove} new event{newAbove === 1 ? "" : "s"} above — jump to newest
                </button>
              ) : null}
              <div className="evc-list" ref={listRef} onScroll={onScroll}>
                {rows.map((r) => {
                  if (r.kind === "bucket") return <div key={r.key} className="evc-bucket">{r.label}</div>;
                  if (r.kind === "event") {
                    return <EvLine key={r.key} e={r.e} selected={r.e.seq === selectedSeq} onOpen={open} />;
                  }
                  const isOpen = openFolds.has(r.key);
                  return (
                    <div key={r.key} className="evc-fold">
                      <button
                        type="button" className="evc-foldbar" aria-expanded={isOpen}
                        onClick={() => setOpenFolds((cur) => {
                          const next = new Set(cur);
                          if (next.has(r.key)) next.delete(r.key);
                          else next.add(r.key);
                          return next;
                        })}
                      >
                        <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span>
                        {r.items.length} routine events
                        <span className="muted">{hhmmss(r.items[r.items.length - 1].timestamp)}–{hhmmss(r.items[0].timestamp)}</span>
                      </button>
                      {isOpen ? r.items.map((e) => (
                        <EvLine key={e.seq || e.id} e={e} selected={e.seq === selectedSeq} onOpen={open} />
                      )) : null}
                    </div>
                  );
                })}
              </div>
              {matched.length > shown.length ? (
                <div className="list-more" role="status">
                  Showing the newest <b>{shown.length}</b> of <b>{matched.length}</b> matching events.
                  Narrow the search to reach older ones.
                </div>
              ) : null}
            </>
          )}
        </div>

        {selectedSeq != null ? (
          <aside className="evc-detail" aria-label="Event detail">
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
    </>
  );
}
