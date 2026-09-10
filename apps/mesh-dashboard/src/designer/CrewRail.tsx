/* Crew rail: the selectable roster on the left of the workbench. Below the
 * 1240 breakpoint the heading turns into a disclosure so the graph keeps width;
 * one roster instance is toggled by class, never rendered twice. */

import { hueVar } from "./ui";
import { Button } from "../components";

export interface CrewRailProps {
  agents: Record<string, any>;
  ids: string[];
  current: string | null;
  startup: Set<string>;
  hasError: (id: string) => boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (id: string) => void;
  onHire: () => void;
}

export default function CrewRail({ agents, ids, current, startup, hasError, open, onToggle, onPick, onHire }: CrewRailProps): React.JSX.Element {
  return (
    <aside className={`card ms-rail${open ? " open" : ""}`} aria-label="crew">
      <div className="ms-rail-head"><b>CREW · {ids.length} agents</b></div>
      <button type="button" className="ms-rail-toggle" aria-expanded={open} aria-controls="ms-rail-body" onClick={onToggle}>
        <span className="ms-rail-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <b>CREW · {ids.length} agents</b>
      </button>
      <div className="ms-rail-body" id="ms-rail-body">
        <div className="ms-crew-list">
          {ids.map((id) => {
            const ag = agents[id] || {};
            const boot = startup.has(id);
            const sel = id === current;
            return (
              <button key={id} className={`crew${sel ? " sel" : ""}`} onClick={() => onPick(id)} aria-pressed={sel} style={hueVar(id)}>
                <span className={`crew-av${boot ? " boot" : ""}`}>{(id[0] || "?").toUpperCase()}</span>
                <span className="crew-nm">
                  <b>{id}</b>
                  <small>{ag.role || "no role"}{ag.mode === "service" ? " · svc" : ""}</small>
                </span>
                {hasError(id) ? <span className="crew-err" title="this agent has a validation error">!</span> : null}
              </button>
            );
          })}
          {!ids.length ? <div className="muted ms-rail-empty">no crew yet — hire the first agent</div> : null}
        </div>
        <Button variant="small" extra="ms-hire" onClick={onHire}>+ hire agent</Button>
        <div className="ms-rail-legend">
          <span><i className="lg lg-boot" /> boots at startup</span>
          <span><i className="lg lg-svc" /> service (always on)</span>
          <span><i className="lg lg-edge" /> may message →</span>
        </div>
      </div>
    </aside>
  );
}
