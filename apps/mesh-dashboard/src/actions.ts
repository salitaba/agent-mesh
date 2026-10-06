import { useState } from "react";
import { useMesh } from "./store";
import type { ConfirmFn } from "./components";
import { goLiveNotice } from "./golive";
import { REOPEN_DIALOG } from "./reopen";
import { resumeConfirmBody, startConfirmBody } from "./spend";

export const isParkedStatus = (status: any): boolean => Boolean(status?.uiOnly) || status?.mode === "parked";

/**
 * Naming the agents is the whole value of this prompt — "resumes spend" is
 * abstract until you see which four sessions are about to start billing. When
 * nothing is asleep there is nothing to warn about, so it resolves straight
 * through rather than asking a question with one sensible answer. What it says
 * about cost is `spend.ts`'s: a scripted team spends nothing and the dialog says so.
 */
export async function confirmResume(confirm: ConfirmFn, status: any, action = "resume"): Promise<boolean> {
  const body = resumeConfirmBody(status);
  if (!body) return true;
  return (await confirm({ title: `${action} the mission?`, body, confirmLabel: action })) !== null;
}

/**
 * Reset destroys the live mission, so a plain confirm() is not enough — the
 * operator types the mesh name, the same guard pattern used for deleting a repo.
 *
 * The typed id is not only a speed bump in the dialog: it goes to the server as
 * `confirmId` and that is what the route checks. A guard that lives only in the
 * console is a guard against typos, not against anything that can POST.
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
        "Everything the running mission produced goes away: every event, agent session, budget and step, and the goal restarts from zero.",
        "Three things are archived first, together under one stamp in .mesh-backups/<mesh-id>/ — the state directory holding the mission log, the product checkout, and the agent worktrees (their uncommitted files, plus a git bundle of their branches).",
        "This console cannot restore them. Run `curule backups <mesh.yaml>` to list the stamps and `curule restore <mesh.yaml> <stamp>` to put one back.",
      ],
      danger: true,
      confirmLabel: "Reset to zero",
      require: { kind: "match", value: name, label: "Type the mesh id to confirm" },
    });
    if (typed === null) return;
    setBusy(true);
    try {
      const { status: code, json } = await client.post("/mission/reset", { confirm: true, confirmId: name });
      toast(
        code === 200 ? "Mission reset to zero" : "Could not reset the mission",
        json?.note ?? json?.error ?? "",
        code === 200 ? "ok" : "bad",
      );
    } catch {
      toast("Could not reset the mission", "The server did not answer.", "bad");
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
    const reason = await confirm(REOPEN_DIALOG);
    if (reason === null) return;
    setBusy(true);
    try {
      const { status: code, json } = await client.post("/mission/reopen", { reason });
      toast(
        code === 200 ? "Mission reopened" : "Could not reopen the mission",
        json?.note ?? json?.reason ?? json?.error ?? "",
        code === 200 ? "ok" : "bad",
      );
    } catch {
      toast("Could not reopen the mission", "The server did not answer.", "bad");
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
    if ((await confirm({ title: "Start the mission?", body: startConfirmBody(status), confirmLabel: "Start the mission" })) === null) return;
    setBusy(true);
    try {
      const { status, json } = await client.post("/mission/start");
      // What the notice says, and why it is read off the counts and never asserted, is golive.ts's.
      const notice = goLiveNotice(status, json);
      toast(notice.title, notice.msg, notice.kind);
    } catch {
      toast("Could not start the mission", "The server did not answer.", "bad");
    } finally {
      setBusy(false);
    }
    await refreshStatus();
  };
  return { busy, goLive };
}
