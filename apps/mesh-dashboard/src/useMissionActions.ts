import { useCallback } from "react";
import { useMesh, type View } from "./store";
import { confirmResume, useGoLive, useReopenMission, useResetMission } from "./actions";
import type { MissionAction } from "./mission";

/**
 * The mission's controls, in one place. The top bar, the Overview and the keyboard all call these, so a button and a key
 * cannot do different things under one label.
 *
 * Starting asks first (`useGoLive` names the agents about to spend). Pausing does not, because it is safe, and says so with an
 * Undo instead of a question. Resuming asks only when it would wake someone. Reopen and reset keep their own dialogs.
 */
export interface MissionActions {
  /** Run the action `describeMission` offered. `inboxView` is where "review" goes: tool requests live in Tool gates. */
  run: (action: MissionAction, opts?: { inboxView?: View }) => void;
  pause: () => Promise<void>;
  resume: (ask: boolean) => Promise<void>;
  reset: () => Promise<void>;
}

export function useMissionActions(): MissionActions {
  const { goalId, client, status, confirm, toast, refreshStatus, setView } = useMesh();
  const { goLive } = useGoLive();
  const { reopenMission } = useReopenMission();
  const { resetMission } = useResetMission();

  const resume = useCallback(async (ask: boolean): Promise<void> => {
    if (!goalId) return;
    if (ask && !(await confirmResume(confirm, status, "Resume"))) return;
    try {
      await client.post(`/goals/${goalId}/resume`);
      toast("Mission resumed", "Agents are running.", "ok");
    } catch {
      toast("Resume failed", "The server did not answer.", "bad");
    }
    void refreshStatus();
  }, [goalId, confirm, status, client, toast, refreshStatus]);

  const pause = useCallback(async (): Promise<void> => {
    if (!goalId) return;
    try {
      await client.post(`/goals/${goalId}/pause`);
      toast("Mission paused", "Agents stopped. Nothing is lost.", "warn", { label: "Undo", run: () => void resume(false) });
    } catch {
      toast("Pause failed", "The server did not answer.", "bad");
    }
    void refreshStatus();
  }, [goalId, client, toast, refreshStatus, resume]);

  const run = useCallback((action: MissionAction, opts?: { inboxView?: View }): void => {
    switch (action) {
      case "start": void goLive(); break;
      case "pause": void pause(); break;
      case "resume": void resume(true); break;
      case "reopen": void reopenMission(); break;
      case "review": setView(opts?.inboxView ?? "escalations"); break;
      case "settings": setView("hostsettings"); break;
      case "agents": setView("agents"); break;
      case "designer": setView("designer"); break;
    }
  }, [goLive, pause, resume, reopenMission, setView]);

  return { run, pause, resume, reset: resetMission };
}
