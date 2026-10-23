/* The seats as a list: what the Designer shows instead of the canvas on a phone.
 *
 * A 1000 by 620 canvas drawn into 350 pixels is a diagram nobody can read or hit: cards the size of a fingertip, wires between them
 * that cannot be told apart. On a phone the work is the same (name a seat, set its role, say who it may message), and a list does it
 * with targets a thumb can hit. Wiring is done in the seat's own inspector, under Communication, which is the same control the
 * keyboard uses on a wide screen.
 *
 * The list is the roster, so it is also the one place a name must never be cut: the name has its own line and wraps, while the flags
 * and the wire counts sit under it. Measured at 360px before that, "frontend-developer" needed 151px and had 88, and six of nine
 * seats read as "frontend-…", "ux-desig…" and so on. */

import { AgentAvatar, agentColor, Button } from "../components";
import { Icon } from "../icons";
import { EmptySeats } from "./Guide";
import type { Wire } from "./edits";
import type { Template } from "./model";
import "./topology.css";

export interface SeatListProps {
  seats: Record<string, any>;
  ids: string[];
  current: string | null;
  starts: Set<string>;
  problems: (id: string) => boolean;
  wires: Wire[];
  onSelect: (id: string) => void;
  onAddSeat: () => void;
  onTemplate: (t: Template) => void;
  onAsk: () => void;
}

export default function SeatList({ seats, ids, current, starts, problems, wires, onSelect, onAddSeat, onTemplate, onAsk }: SeatListProps): React.JSX.Element {
  if (!ids.length) {
    return <section className="card ms-seats" aria-label="Team"><EmptySeats onAddSeat={onAddSeat} onTemplate={onTemplate} onAsk={onAsk} /></section>;
  }
  const outgoing = new Map<string, number>();
  const incoming = new Map<string, number>();
  for (const w of wires) {
    outgoing.set(w.src, (outgoing.get(w.src) ?? 0) + 1);
    incoming.set(w.tgt, (incoming.get(w.tgt) ?? 0) + 1);
  }
  const starter = ids.find((id) => starts.has(id));
  return (
    <section className="card ms-seats" aria-label="Team">
      <div className="ms-seats-head">
        <div className="ms-seats-title">
          <h3>Team</h3>
          <p className="ms-seats-count">
            {ids.length} {ids.length === 1 ? "seat" : "seats"} · {wires.length} {wires.length === 1 ? "wire" : "wires"}
            {starter ? <> · starts with <b>{starter}</b></> : " · no seat starts"}
          </p>
        </div>
        <Button variant="small" icon="plus" onClick={onAddSeat}>Add seat</Button>
      </div>
      <ul className="ms-seatlist">
        {ids.map((id) => {
          const ag = seats[id] || {};
          const role = String(ag.role || "").trim();
          const out = outgoing.get(id) ?? 0;
          const into = incoming.get(id) ?? 0;
          const bad = problems(id);
          const starting = starts.has(id);
          const service = ag.mode === "service";
          // The role is only worth a line when it says something the name does not. Six of the nine demo seats had the same word twice.
          const shownRole = role && role !== id ? role : "";
          const hasFlags = bad || starting || service;
          const message = out
            ? `May message ${out} ${out === 1 ? "seat" : "seats"}${into ? ` · ${into} ${into === 1 ? "seat" : "seats"} may message it` : ""}`
            : into
              ? `May message nobody · ${into} ${into === 1 ? "seat" : "seats"} may message it`
              : "No wires yet";
          return (
            <li key={id}>
              <button type="button" className={`ms-seatrow${id === current ? " sel" : ""}${bad ? " err" : ""}`} aria-current={id === current ? "true" : undefined} onClick={() => onSelect(id)}>
                <AgentAvatar id={id} color={agentColor(role)} />
                <span className="ms-seatrow-text">
                  <span className="nm">{id}</span>
                  {shownRole || hasFlags ? (
                    <span className="ms-seatrow-sub">
                      {shownRole ? <span className="rl">{shownRole}</span> : null}
                      {bad ? <span className="ms-flag bad"><Icon name="alert" size={12} />Problem</span> : null}
                      {starting ? <span className="ms-flag"><Icon name="play" size={10} />Starts</span> : null}
                      {service ? <span className="ms-flag">Service</span> : null}
                    </span>
                  ) : null}
                  <span className="ms-seatrow-meta">{message}</span>
                </span>
                <Icon name="chevron-right" size={16} className="ms-seatrow-go" />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="ms-seats-note">The drawing needs a wider screen. Tap a seat to change its role, tools and who it may message.</p>
    </section>
  );
}
