import { useMesh } from "./store";
import { useProjectsOptional } from "./projects";
import { describeMission, factsFromStatus, type MissionFacts, type MissionState } from "./mission";
import { tabStatus } from "./tabmodel";

/**
 * The mission's state, read the way the whole console reads it. The top bar, the Overview and the window title all call
 * this, so what the bar says and what the page says cannot differ: mission.ts holds the precedence, this holds the wiring.
 *
 * `hasHistory` answers "Start" against "Continue": a project that has turns in it, or a log that has grown past its
 * startup events, has been run before.
 */
export function useMission(): { facts: MissionFacts; state: MissionState } {
  const { status, serverDown, steps } = useMesh();
  const projects = useProjectsOptional();
  // The registry's word on the project this store follows. A crashed, locked or unopenable project has no mission to read: say
  // what is wrong with the project, in the words its tab uses, rather than "Starting" or a goal that is not there.
  const mine = projects?.projects.find((p) => p.id === projects.activeId);
  const stopped = mine && ["crashed", "locked", "error", "closed"].includes(mine.status) ? { ...tabStatus(mine), status: mine.status } : null;
  const facts = factsFromStatus(status, {
    serverDown,
    projectDown: stopped ? { label: stopped.label, hint: stopped.hint, severe: stopped.status !== "closed" } : null,
    hostCeilingTripped: projects?.hostSpend?.ceilingTripped === true,
    runningSteps: (steps || []).filter((s: { status?: string }) => s.status === "running").length,
    hasHistory: (steps?.length ?? 0) > 0 || (status?.eventCount ?? 0) > 15,
  });
  return { facts, state: describeMission(facts) };
}
