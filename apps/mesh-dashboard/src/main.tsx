import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { MeshProvider, useMesh } from "./store";
import { ProjectsProvider } from "./projects";
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

function App(): React.JSX.Element {
  return (
    <ProjectsProvider>
      {(activeId) => (
        // `key` is load-bearing: switching projects must give the new one a
        // fresh store rather than leave the previous mission's events, steps
        // and drawers on screen under a different project's name.
        <MeshProvider key={activeId ?? "none"} projectId={activeId}>
          <Shell viewNode={<ViewSwitch />} />
        </MeshProvider>
      )}
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
