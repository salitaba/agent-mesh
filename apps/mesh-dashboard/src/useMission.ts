import { useMesh } from "./store";
import { useProjectsOptional } from "./projects";
import { describeMission, factsFromStatus, type MissionFacts, type MissionState } from "./mission";

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
  const facts = factsFromStatus(status, {
    serverDown,
    hostCeilingTripped: projects?.hostSpend?.ceilingTripped === true,
    runningSteps: (steps || []).filter((s: { status?: string }) => s.status === "running").length,
    hasHistory: (steps?.length ?? 0) > 0 || (status?.eventCount ?? 0) > 15,
  });
  return { facts, state: describeMission(facts) };
}
