import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { MeshProvider, useMesh } from "./store";
import { ProjectsProvider, useProjects } from "./projects";
import { Shell } from "./shell";
import Overview from "./views/Overview";
import Steps from "./views/Steps";
import Agents from "./views/Agents";
import Graph from "./views/Graph";
import Events from "./views/Events";
import Artifacts from "./views/Artifacts";
import Cost from "./views/Cost";
import Product from "./views/Product";
import Escalations from "./views/Escalations";
import Designer from "./views/Designer";

function ViewSwitch(): React.JSX.Element {
  const { view } = useMesh();
  switch (view) {
    case "overview":
      return <Overview />;
    case "steps":
      return <Steps />;
    case "agents":
      return <Agents />;
    case "graph":
      return <Graph />;
    case "events":
      return <Events />;
    case "artifacts":
      return <Artifacts />;
    case "cost":
      return <Cost />;
    case "product":
      return <Product />;
    case "escalations":
      return <Escalations />;
    case "designer":
      return <Designer />;
    default:
      return <div className="empty">unknown view</div>;
  }
}

/**
 * One `MeshProvider` per *open* project, not per visible one.
 *
 * A background provider renders no children — it exists to keep ingesting its
 * project's frames so switching back is instant rather than a cold reload. It
 * costs a capped event buffer and no polling (see `background` in store.tsx).
 * Closed projects get no provider at all: there is nothing to stream.
 */
function Projects({ activeId }: { activeId: string | null }): React.JSX.Element {
  const { projects } = useProjects();
  const live = projects.filter((p) => p.status === "open" || p.status === "booting").map((p) => p.id);
  // The active project always gets a store, even before the registry agrees it
  // is open — otherwise the console is blank for the whole boot.
  const mounted = activeId && !live.includes(activeId) ? [activeId, ...live] : live;
  return (
    <>
      {mounted.map((id) => (
        // `key` is load-bearing: a project must never inherit another
        // mission's events, steps and drawers under a different name.
        <MeshProvider key={id} projectId={id} background={id !== activeId}>
          {id === activeId ? <Shell viewNode={<ViewSwitch />} /> : null}
        </MeshProvider>
      ))}
      {/* No project at all: the shell still has to render, because the
          Designer is how an operator creates the first mesh. */}
      {!activeId ? (
        <MeshProvider key="none" projectId={null}>
          <Shell viewNode={<ViewSwitch />} />
        </MeshProvider>
      ) : null}
    </>
  );
}

function App(): React.JSX.Element {
  return (
    <ProjectsProvider>
      {(activeId) => <Projects activeId={activeId} />}
    </ProjectsProvider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
