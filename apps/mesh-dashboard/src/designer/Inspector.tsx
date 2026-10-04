/* Inspector column: tab bar (Seat / Mesh / Policy) + active panel.
 * Error counts per tab come from validation routing. */

import CrewPanel from "./panels/CrewPanel";
import MeshPanel from "./panels/MeshPanel";
import PolicyPanel from "./panels/PolicyPanel";
import { TabPanel, Tabs, type TabDef } from "../components";
import type { DCtx, Tab } from "./types";
import "./inspector.css";

export interface InspectorProps {
  ctx: DCtx;
  tab: Tab;
  setTab: (t: Tab) => void;
  errTabs: Record<Tab, number>;
}

const TABS: Array<[Tab, string, string]> = [
  ["crew", "Seat", "The selected seat: its role, tools, wires and budget"],
  ["mesh", "Mesh", "The goal, the done-when checks, the runtime and the scheduler"],
  ["policy", "Policy", "Gates, escalation and the mission budget"],
];

export default function Inspector({ ctx, tab, setTab, errTabs }: InspectorProps): React.JSX.Element {
  const tabs: TabDef[] = TABS.map(([id, label, hint]) => ({ id, label, hint, badge: errTabs[id] || undefined, badgeHot: errTabs[id] > 0 }));
  return (
    <aside className="card ms-insp" aria-label="Inspector">
      <Tabs idPrefix="insp" label="Inspector" tabs={tabs} value={tab} onChange={(id) => setTab(id as Tab)} />
      <TabPanel idPrefix="insp" id={tab}>
        {tab === "crew" ? <CrewPanel ctx={ctx} /> : tab === "mesh" ? <MeshPanel ctx={ctx} /> : <PolicyPanel ctx={ctx} />}
      </TabPanel>
    </aside>
  );
}
