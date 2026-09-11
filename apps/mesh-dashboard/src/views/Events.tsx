import { useEffect, useMemo } from "react";
import { useMesh } from "../store";
import { Button, Card, EventRow, Input } from "../components";
import { EventDrawerBySeq } from "../drawers";
import { EV_FILTER_GROUPS, evGroupOf } from "../events";

export default function Events(): React.JSX.Element {
  const { events, evSearch, setEvSearch, evFilter, setEvFilter, openDrawer, livePaused, setLivePaused, primeEvents, client } = useMesh();

  useEffect(() => {
    let dead = false;
    if (events.length === 0) {
      client.api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 }).then(({ json }) => {
        if (!dead) primeEvents(json || []);
      }).catch(() => undefined);
    }
    return () => {
      dead = true;
    };
  }, [events.length, client, primeEvents]);

  // The haystack only changes when the buffer does; building it inside the
  // filter re-stringified up to 800 payloads on every keystroke.
  const hay = useMemo(
    () => events.map((e) => `${e.type} ${e.actorId || ""} ${JSON.stringify(e.payload || {}).slice(0, 600)}`.toLowerCase()),
    [events],
  );
  const rows = useMemo(() => {
    const q = evSearch.toLowerCase();
    const out = [] as typeof events;
    for (let i = events.length - 1; i >= 0 && out.length < 200; i--) {
      const e = events[i];
      if (evFilter && evGroupOf(e.type) !== evFilter) continue;
      if (q && !hay[i].includes(q)) continue;
      out.push(e);
    }
    return out;
  }, [events, hay, evSearch, evFilter]);

  return (
    <>
      <div className="view-title"><h2>Events</h2><span className="muted">{livePaused ? "paused" : "live"}</span>
        <span className="page-actions">
          <Button variant="small" onClick={() => setLivePaused(!livePaused)}>{livePaused ? "▶ resume" : "❚❚ pause"}</Button>
        </span></div>
      <div className="view-sub">Everything that happened, newest first. Start in Steps — come here only to dig.</div>
      <Card>
        <div className="ev-filters">
          <Input search id="ev-search" placeholder="search messages, agents, files… ( / )" value={evSearch} onChange={(e) => setEvSearch(e.target.value)} />
          {EV_FILTER_GROUPS.map((g) => (
            <button key={g.id} className={`fchip ${(evFilter || "") === g.id ? "on" : ""}`} onClick={() => setEvFilter(evFilter === g.id ? "" : g.id)}>{g.label}</button>
          ))}
        </div>
        <div className="ev-list">{rows.length ? rows.map((e) => <EventRow key={e.seq || e.id} e={e} onOpen={(s) => openDrawer(<EventDrawerBySeq seq={s} />)} />) : <div className="muted" style={{ padding: 20 }}>No matching events.<br /><span className="muted">Try a different word, or clear the filter.</span></div>}</div>
      </Card>
    </>
  );
}
