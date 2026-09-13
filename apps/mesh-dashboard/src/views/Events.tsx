import { useEffect, useMemo, useState } from "react";
import { useMesh } from "../store";
import { Button, Card, ErrorState, EventRow, Input } from "../components";
import { EventDrawerBySeq } from "../drawers";
import { EV_FILTER_GROUPS, evGroupOf } from "../events";

/** Rows rendered at once. The log can be far longer; see the notice below the list. */
const CAP = 200;

export default function Events(): React.JSX.Element {
  const { events, evSearch, setEvSearch, evFilter, setEvFilter, openDrawer, livePaused, setLivePaused, primeEvents, client } = useMesh();
  // "No matching events" used to be shown while the first fetch was still in
  // flight and again after it failed, so an empty log, a slow server and a dead
  // one were the same screen. Three states, three answers.
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

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

  // The haystack only changes when the buffer does; building it inside the
  // filter re-stringified up to 800 payloads on every keystroke.
  const hay = useMemo(
    () => events.map((e) => `${e.type} ${e.actorId || ""} ${JSON.stringify(e.payload || {}).slice(0, 600)}`.toLowerCase()),
    [events],
  );
  // Counting every match while rendering only the newest CAP is what lets the
  // list admit it is truncated. The old loop stopped at 200 and could not tell
  // "these are all of them" from "these are the first 200 of 900".
  const { rows, total } = useMemo(() => {
    const q = evSearch.toLowerCase();
    const out = [] as typeof events;
    let n = 0;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (evFilter && evGroupOf(e.type) !== evFilter) continue;
      if (q && !hay[i].includes(q)) continue;
      n++;
      if (out.length < CAP) out.push(e);
    }
    return { rows: out, total: n };
  }, [events, hay, evSearch, evFilter]);

  const firstLoad = !events.length;
  return (
    <>
      <div className="view-title"><h2>Events</h2><span className="muted">{livePaused ? "paused" : "live"}</span>
        <span className="page-actions">
          <Button variant="small" aria-pressed={livePaused} onClick={() => setLivePaused(!livePaused)}>{livePaused ? "▶ resume" : "❚❚ pause"}</Button>
        </span></div>
      <div className="view-sub">Everything that happened, newest first. Start in Steps — come here only to dig.</div>
      <Card>
        <div className="ev-filters">
          <Input search id="ev-search" aria-label="Search events" placeholder="search messages, agents, files… ( / )" value={evSearch} onChange={(e) => setEvSearch(e.target.value)} />
          {EV_FILTER_GROUPS.map((g) => (
            <button
              key={g.id} type="button" className={`fchip ${(evFilter || "") === g.id ? "on" : ""}`}
              aria-pressed={(evFilter || "") === g.id}
              onClick={() => setEvFilter(evFilter === g.id ? "" : g.id)}
            >{g.label}</button>
          ))}
        </div>
        {loadErr && firstLoad ? (
          <ErrorState what="the event log" detail={loadErr} onRetry={() => setAttempt((n) => n + 1)} />
        ) : loading && firstLoad ? (
          <div className="empty"><div className="big">…</div><div>loading events</div></div>
        ) : (
          <>
            <div className="ev-list">{rows.length ? rows.map((e) => <EventRow key={e.seq || e.id} e={e} onOpen={(s) => openDrawer(<EventDrawerBySeq seq={s} />)} />) : <div className="muted" style={{ padding: 20 }}>{events.length ? <>No matching events.<br /><span className="muted">Try a different word, or clear the filter.</span></> : <>No events yet.<br /><span className="muted">They appear here as soon as an agent runs a turn.</span></>}</div>}</div>
            {total > rows.length ? (
              <div className="list-more" role="status">
                Showing the newest <b>{rows.length}</b> of <b>{total}</b> matching events. Search or filter to reach older ones.
              </div>
            ) : null}
          </>
        )}
      </Card>
    </>
  );
}
