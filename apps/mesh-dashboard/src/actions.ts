import { useState } from "react";
import { useMesh } from "./store";
import type { ConfirmFn } from "./components";

export const isParkedStatus = (status: any): boolean => Boolean(status?.uiOnly) || status?.mode === "parked";

export function agentsToWake(status: any): string[] {
  return (status?.agents || []).filter((a: any) => a.id !== "human" && ["WAITING", "SUSPENDED", "IDLE"].includes(a.lifecycle)).map((a: any) => a.id).slice(0, 4);
}

/**
 * Naming the agents is the whole value of this prompt — "resumes spend" is
 * abstract until you see which four sessions are about to start billing. When
 * nothing is asleep there is nothing to warn about, so it resolves straight
 * through rather than asking a question with one sensible answer.
 */
export async function confirmResume(confirm: ConfirmFn, status: any, action = "resume"): Promise<boolean> {
  const names = agentsToWake(status);
  if (!names.length) return true;
  return (
    (await confirm({
      title: `${action} the mission?`,
      body: [`This wakes ${names.join(", ")} and resumes spend against the mission budget.`],
      confirmLabel: action,
    })) !== null
  );
}

/**
 * Reset is irreversible from the console's point of view (the archive is only
 * recoverable from a shell), so a plain confirm() is not enough — the operator
 * types the mesh name, the same guard pattern used for deleting a repo.
 */
export function useResetMission(): { busy: boolean; resetMission: () => Promise<void> } {
  const { status, toast, refreshStatus, client, confirm } = useMesh();
  const [busy, setBusy] = useState(false);
  const resetMission = async () => {
    const name = status?.meshId || status?.mesh?.id || "mesh";
    // The dialog enforces the match itself and keeps the button disabled until
    // it holds, so a mistyped id can no longer reach the server and come back
    // as a "cancelled" toast the operator has to interpret.
    const typed = await confirm({
      title: "Reset the mission to zero?",
      body: [
        "Every event, agent session, budget and step goes away, every git worktree from the old run is deleted, and the goal restarts from zero.",
        "The old state is archived outside the agent workspace (.mesh-backups/<mesh-id>/) — the console cannot restore it, but it stays on disk for manual recovery.",
      ],
      danger: true,
      confirmLabel: "Reset to zero",
      require: { kind: "match", value: name, label: "Type the mesh id to confirm" },
    });
    if (typed === null) return;
    setBusy(true);
    try {
      const { status: code, json } = await client.post("/mission/reset", { confirm: true });
      toast(
        code === 200 ? "mission reset to zero" : "could not reset",
        json?.note ?? json?.error ?? "",
        code === 200 ? "ok" : "bad",
      );
    } catch {
      toast("could not reset", "the server did not answer", "bad");
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
  const { toast, refreshStatus, client, confirm } = useMesh();
  const [busy, setBusy] = useState(false);
  const reopenMission = async () => {
    // The reason is the agents' new brief, so an empty one is not a valid
    // answer: the dialog holds the button rather than accepting it and then
    // telling the operator off in a toast after the fact.
    const reason = await confirm({
      title: "Reopen the mission?",
      body: [
        "Nothing is deleted — every artifact and step is kept, but the mandatory acceptance criteria go back to UNSATISFIED so the run does not instantly close again.",
      ],
      confirmLabel: "Reopen and brief the agents",
      require: { kind: "text", label: "What was wrong with the result?", placeholder: "the API contract was never implemented" },
    });
    if (reason === null) return;
    setBusy(true);
    try {
      const { status: code, json } = await client.post("/mission/reopen", { reason });
      toast(
        code === 200 ? "mission reopened" : "could not reopen",
        json?.note ?? json?.reason ?? json?.error ?? "",
        code === 200 ? "ok" : "bad",
      );
    } catch {
      toast("could not reopen", "the server did not answer", "bad");
    } finally {
      setBusy(false);
    }
    await refreshStatus();
  };
  return { busy, reopenMission };
}

export function useGoLive(): { busy: boolean; goLive: () => Promise<void> } {
  const { status, toast, refreshStatus, client, confirm } = useMesh();
  const [busy, setBusy] = useState(false);
  const goLive = async () => {
    // Parked is the safe state: going live is the one click that lets agents
    // run and spend. Both call sites (the parked banner's Continue and the
    // auto-resume after an escalation answer) must ask first, or a stray click
    // starts the mission silently.
    const names = agentsToWake(status);
    const body = ["Agents run and spend tokens until you park the mission again."];
    if (names.length) body.unshift(`${names.join(", ")} will be woken.`);
    if ((await confirm({ title: "Start the mission?", body, confirmLabel: "Start the mission" })) === null) return;
    setBusy(true);
    try {
      const { status, json } = await client.post("/mission/start");
      const already = json?.started === false;
      toast(status === 200 ? (already ? "already live" : "mission continuing — agents are running") : "could not go live", json?.note ?? json?.error ?? "scheduler live", status === 200 ? "ok" : "bad");
    } catch {
      toast("could not go live", "the server did not answer", "bad");
    } finally {
      setBusy(false);
    }
    await refreshStatus();
  };
  return { busy, goLive };
}
