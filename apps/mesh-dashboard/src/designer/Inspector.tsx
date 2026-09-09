/* Inspector column: tab bar (Crew / Mesh / Policy & budget) + active panel.
 * Error counts per tab come from validation routing. */

import CrewPanel from "./panels/CrewPanel";
import MeshPanel from "./panels/MeshPanel";
import PolicyPanel from "./panels/PolicyPanel";
import type { DCtx, Tab } from "./types";

export interface InspectorProps {
  ctx: DCtx;
  tab: Tab;
  setTab: (t: Tab) => void;
  errTabs: Record<Tab, number>;
}

const TABS: Array<[Tab, string]> = [["crew", "Crew"], ["mesh", "Mesh"], ["policy", "Policy & budget"]];

export default function Inspector({ ctx, tab, setTab, errTabs }: InspectorProps): React.JSX.Element {
  return (
    <aside className="card ms-insp" aria-label="inspector">
      <div className="insp-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {label}{errTabs[k] ? <span className="sec-badge">{errTabs[k]}</span> : null}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {tab === "crew" ? <CrewPanel ctx={ctx} /> : tab === "mesh" ? <MeshPanel ctx={ctx} /> : <PolicyPanel ctx={ctx} />}
      </div>
    </aside>
  );
}