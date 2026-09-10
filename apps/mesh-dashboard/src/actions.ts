import { useState } from "react";
import { post } from "./api";
import { useMesh } from "./store";

export const isParkedStatus = (status: any): boolean => Boolean(status?.uiOnly) || status?.mode === "parked";

export function agentsToWake(status: any): string[] {
  return (status?.agents || []).filter((a: any) => a.id !== "human" && ["WAITING", "SUSPENDED", "IDLE"].includes(a.lifecycle)).map((a: any) => a.id).slice(0, 4);
}

export function confirmResume(status: any, action = "resume"): boolean {
  const names = agentsToWake(status);
  if (!names.length) return true;
  return window.confirm(`${action} wakes ${names.join(", ")} and resumes spend. Continue?`);
}

/**
 * Reset is irreversible from the console's point of view (the archive is only
 * recoverable from a shell), so a plain confirm() is not enough — the operator
 * types the mesh name, the same guard pattern used for deleting a repo.
 */
export function useResetMission(): { busy: boolean; resetMission: () => Promise<void> } {
  const { status, toast, refreshStatus } = useMesh();
  const [busy, setBusy] = useState(false);
  const resetMission = async () => {
    const name = status?.meshId || status?.mesh?.id || "mesh";
    const typed = window.prompt(
      `This wipes the whole mission: every event, agent session, budget and step goes away, every git worktree from the old run is deleted, and the goal restarts from zero.\n\n` +
        `The old state is archived outside the agent workspace (.mesh-backups/<mesh-id>/) — the console cannot restore it, but it stays on disk for manual recovery.\n\n` +
        `Type the mesh id "${name}" to confirm:`,
    );
    if (typed === null) return;
    if (typed.trim() !== name) {
      toast("reset cancelled", "the id did not match — nothing was changed", "warn");
      return;
    }
    setBusy(true);
    try {
      const { status: code, json } = await post("/mission/reset", { confirm: true });
      toast(
        code === 200 ? "mission reset to zero" : "could not reset",
        json?.note ?? json?.error ?? "",
        code === 200 ? "ok" : "bad",
      );
    } finally {
      setBusy(false);
    }
    await refreshStatus();
  };
  return { busy, resetMission };
}

/**
 * "I don't accept this result." Unlike reset, nothing is destroyed: the goal
 * verdict is withdrawn, the mandatory criteria go back to UNSATISFIED and the
 * agents that completed with the mission are revived. The prompt doubles as
 * the rejection note the agents read on their next turn, so the operator does
 * not have to reopen and THEN send a message explaining why.
 */
export function useReopenMission(): { busy: boolean; reopenMission: () => Promise<void> } {
  const { toast, refreshStatus } = useMesh();
  const [busy, setBusy] = useState(false);
  const reopenMission = async () => {
    const reason = window.prompt(
      "Reopen the mission and put the agents back to work.\n\n" +
        "Nothing is deleted — every artifact and step is kept, but the mandatory acceptance criteria go back to UNSATISFIED so the run does not instantly close again.\n\n" +
        "What was wrong with the result?",
    );
    if (reason === null) return;
    if (!reason.trim()) {
      toast("reopen cancelled", "a reason is required — the agents read it as their new brief", "warn");
      return;
    }
    setBusy(true);
    try {
      const { status: code, json } = await post("/mission/reopen", { reason: reason.trim() });
      toast(
        code === 200 ? "mission reopened" : "could not reopen",
        json?.note ?? json?.reason ?? json?.error ?? "",
        code === 200 ? "ok" : "bad",
      );
    } finally {
      setBusy(false);
    }
    await refreshStatus();
  };
  return { busy, reopenMission };
}

export function useGoLive(): { busy: boolean; goLive: () => Promise<void> } {
  const { toast, refreshStatus } = useMesh();
  const [busy, setBusy] = useState(false);
  const goLive = async () => {
    setBusy(true);
    try {
      const { status, json } = await post("/mission/start");
      const already = json?.started === false;
      toast(status === 200 ? (already ? "already live" : "mission continuing — agents are running") : "could not go live", json?.note ?? json?.error ?? "scheduler live", status === 200 ? "ok" : "bad");
    } finally {
      setBusy(false);
    }
    await refreshStatus();
  };
  return { busy, goLive };
}
