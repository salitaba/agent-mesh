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
      `This wipes the whole mission: every event, agent session, budget and step goes away and the goal restarts from zero.\n\n` +
        `The old state is archived on disk (.mesh-state.bak-<timestamp>) but the console cannot restore it.\n\n` +
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
