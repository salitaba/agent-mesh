/* The seats as a list: what the Designer shows instead of the canvas on a phone.
 *
 * A 1000 by 620 canvas drawn into 350 pixels is a diagram nobody can read or hit: cards the size of a fingertip, wires between them
 * that cannot be told apart. On a phone the work is the same (name a seat, set its role, say who it may message), and a list does it
 * with targets a thumb can hit. Wiring is done in the seat's own inspector, under Communication, which is the same control the
 * keyboard uses on a wide screen. */

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
    return <section className="card ms-seats" aria-label="Seats"><EmptySeats onAddSeat={onAddSeat} onTemplate={onTemplate} onAsk={onAsk} /></section>;
  }
  return (
    <section className="card ms-seats" aria-label="Seats">
      <div className="ms-seats-head">
        <h3>{ids.length} {ids.length === 1 ? "seat" : "seats"}</h3>
        <Button variant="small" icon="plus" onClick={onAddSeat}>Add seat</Button>
      </div>
      <ul className="ms-seatlist">
        {ids.map((id) => {
          const ag = seats[id] || {};
          const role = String(ag.role || "").trim();
          const out = wires.filter((w) => w.src === id).length;
          const bad = problems(id);
          return (
            <li key={id}>
              <button type="button" className={`ms-seatrow${id === current ? " sel" : ""}${bad ? " err" : ""}`} aria-current={id === current ? "true" : undefined} onClick={() => onSelect(id)}>
                <AgentAvatar id={id} color={agentColor(role)} />
                <span className="ms-seatrow-text">
                  <span className="ms-seatrow-top">
                    <span className="nm">{id}</span>
                    {bad ? <span className="ms-flag bad"><Icon name="alert" size={14} />Problem</span> : null}
                    {starts.has(id) ? <span className="ms-flag"><Icon name="play" size={12} />Starts</span> : null}
                    {ag.mode === "service" ? <span className="ms-flag">Service</span> : null}
                  </span>
                  <span className="rl">{role || "no role"}</span>
                </span>
                <span className="ms-seatrow-meta">May message {out}</span>
                <Icon name="chevron-right" size={16} className="ms-seatrow-go" />
              </button>
            </li>
          );
        })}
      </ul>
      <p className="ms-seats-note">The canvas needs a wider screen. Open a seat to change its role and tools, and under Communication to set who it may message.</p>
    </section>
  );
}
