import { useEffect } from "react";
import { api } from "../api";
import { useMesh } from "../store";
import { Button, Card, EventRow, Input } from "../components";
import { EventDrawerBySeq } from "../drawers";
import { EV_FILTER_GROUPS, evGroupOf } from "../events";

export default function Events(): React.JSX.Element {
  const { events, evSearch, setEvSearch, evFilter, setEvFilter, openDrawer, livePaused, setLivePaused, primeEvents } = useMesh();

  useEffect(() => {
    let dead = false;
    if (events.length === 0) {
      api("GET", "/events?limit=400", undefined, { timeoutMs: 30000 }).then(({ json }) => {
        if (!dead) primeEvents(json || []);
      }).catch(() => undefined);
    }
    return () => {
      dead = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const q = evSearch.toLowerCase();
  const rows = events.slice().reverse().filter(
    (e) =>
      (!evFilter || evGroupOf(e.type) === evFilter) &&
      (!q || (e.type + " " + (e.actorId || "") + " " + JSON.stringify(e.payload || {}).slice(0, 600)).toLowerCase().includes(q)),
  ).slice(0, 200);

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
        <div className="ev-list">{rows.map((e) => <EventRow key={e.seq || e.id} e={e} onOpen={(s) => openDrawer(<EventDrawerBySeq seq={s} />)} />) || <div className="muted" style={{ padding: 20 }}>No matching events.<br /><span className="muted">Try a different word, or clear the filter.</span></div>}</div>
      </Card>
    </>
  );
}
