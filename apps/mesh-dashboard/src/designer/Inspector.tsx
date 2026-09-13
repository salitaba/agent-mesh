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
        {TABS.map(([k, label], i) => (
          <button
            key={k}
            id={`insp-tab-${k}`}
            role="tab"
            aria-selected={tab === k}
            aria-controls="insp-panel"
            tabIndex={tab === k ? 0 : -1}
            className={tab === k ? "on" : ""}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              const n = e.key === "ArrowRight" ? (i + 1) % TABS.length
                : e.key === "ArrowLeft" ? (i - 1 + TABS.length) % TABS.length
                : e.key === "Home" ? 0
                : e.key === "End" ? TABS.length - 1
                : -1;
              if (n < 0) return;
              e.preventDefault();
              const next = TABS[n][0];
              setTab(next);
              document.getElementById(`insp-tab-${next}`)?.focus();
            }}
          >
            {label}{errTabs[k] ? <span className="sec-badge">{errTabs[k]}</span> : null}
          </button>
        ))}
      </div>
      <div className="insp-body" id="insp-panel" role="tabpanel" tabIndex={0} aria-labelledby={`insp-tab-${tab}`}>
        {tab === "crew" ? <CrewPanel ctx={ctx} /> : tab === "mesh" ? <MeshPanel ctx={ctx} /> : <PolicyPanel ctx={ctx} />}
      </div>
    </aside>
  );
}
