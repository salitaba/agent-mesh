import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmt, fmtBudget } from "../format";
import { isParkedStatus, useGoLive } from "../actions";
import { answerToast, budgetInfoOf, capTarget, compact, holdsOf, type BudgetInfo, type EscalationLike, type Holds } from "../escalation-card";
import type { LoadState } from "../inbox-model";
import { useProjectsOptional } from "../projects";
import { useMesh } from "../store";
import { verdictText } from "../../../../packages/protocol/src/catalog";

/**
 * A half-written answer to a blocking question is expensive to lose: the operator has usually gone off to read code or a log in
 * order to write it, and coming back to an empty box means reconstructing the whole thought. The draft rides alongside in
 * localStorage, so it survives a reload, a tab switch or a stray close. Cleared only on a send the server accepted; a failed
 * send keeps it.
 */
const DRAFT_KEY = "mesh-esc-draft:";
export const draftGet = (id: string): string => {
  try {
    return localStorage.getItem(DRAFT_KEY + id) || "";
  } catch {
    // Private mode or blocked storage: drafts are a convenience, never a precondition for answering.
    return "";
  }
};
export const draftSet = (id: string, v: string): void => {
  try {
    if (v) localStorage.setItem(DRAFT_KEY + id, v);
    else localStorage.removeItem(DRAFT_KEY + id);
  } catch {
    /* ignore */
  }
};
const draftClear = (id: string): void => draftSet(id, "");

export interface Answered {
  id: string;
  title: string;
  /** What the operator sent, or what was done (`raised the budget to 3.0M`). */
  text: string;
  /** What the card held: the page words what the answer did to the mission from this. */
  holds: Holds;
  at: number;
}

/**
 * The decision queue and every way of answering it.
 *
 * One answer is in flight at a time: the question is the gate, and a double-click must not send it twice. Each action reports
 * what it did in words that are true of the project's state (parked or live), and records the answer so the page can say,
 * from the mission's own state, whether the mission moved.
 */
export function useDecisions() {
  const { status, client, toast, confirm, refreshStatus, events } = useMesh();
  const { goLive } = useGoLive();
  const parked = isParkedStatus(status);
  // The host's ceiling, if there is a host: false once it has been raised past the spend. A ceiling card does not clear itself then.
  const ceilingTripped = useProjectsOptional()?.hostSpend?.ceilingTripped ?? null;

  const [list, setList] = useState<any[]>([]);
  const [load, setLoad] = useState<LoadState>("loading");
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [raiseBusy, setRaiseBusy] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered[]>([]);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const { json } = await client.api("GET", "/escalations");
      // An error payload is an object: assigning it would make every filter below throw.
      if (Array.isArray(json)) setList(json);
    } catch {
      /* keep the last list: the load effect's retry is the visible path */
    }
  }, [client]);

  // Following the event stream: an unanswered escalation is an agent stopped dead, and a list that only fetched on mount showed
  // an empty queue for a question raised while the page was open, which reads as "the mesh is converging on its own".
  // Refetching rather than patching from the payload keeps one source of truth for status, threads and budget deltas.
  const escSeq = useMemo(() => {
    let top = 0;
    for (const e of events) if (e.type.startsWith("escalation.") && e.seq > top) top = e.seq;
    return top;
  }, [events]);
  const handled = useRef(0);
  const latestSeq = useRef(0);
  latestSeq.current = escSeq;

  useEffect(() => {
    let dead = false;
    setLoadErr(null);
    setLoad((s) => (s === "ready" ? s : "loading"));
    (async () => {
      const [{ json, timeout }, stRes] = await Promise.all([
        client.api("GET", "/escalations"),
        client.api("GET", "/status").catch(() => ({ json: null })),
      ]);
      if (dead) return;
      if (timeout || !Array.isArray(json)) {
        setLoadErr(timeout ? "The request timed out. The server may be busy." : String(json?.error ?? "The server sent something other than a list."));
        setLoad((s) => (s === "ready" ? s : "error"));
        return;
      }
      setList(json);
      setLoad("ready");
      handled.current = Math.max(handled.current, latestSeq.current);
      if (stRes.json) await refreshStatus();
    })().catch((e: unknown) => {
      if (dead) return;
      setLoadErr(e instanceof Error ? e.message : String(e));
      setLoad((s) => (s === "ready" ? s : "error"));
    });
    return () => {
      dead = true;
    };
  }, [attempt, client, refreshStatus]);

  useEffect(() => {
    if (load !== "ready" || escSeq <= handled.current) return;
    handled.current = escSeq;
    void reload();
  }, [escSeq, load, reload]);

  // The artifact index behind the evidence chips. Refetched when an artifact event lands, so a file written after this page
  // opened is still openable; a failure leaves the refs as plain names.
  const [artIndex, setArtIndex] = useState<any[]>([]);
  const artSeq = useMemo(() => {
    let top = 0;
    for (const e of events) if (e.type.startsWith("artifact.") && e.seq > top) top = e.seq;
    return top;
  }, [events]);
  useEffect(() => {
    let dead = false;
    client.api("GET", "/artifacts").then(({ json }) => {
      if (!dead && Array.isArray(json)) setArtIndex(json);
    }).catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [attempt, artSeq, client]);

  // The request each stuck-request card is about, so the card can say what was asked instead of pointing at an id.
  const [msgs, setMsgs] = useState<Map<string, any>>(new Map());
  useEffect(() => {
    let dead = false;
    (async () => {
      const ids = new Set<string>();
      const byId = new Map<string, any>();
      for (const e of list) if (e?.id) byId.set(e.id, e);
      for (const e of list) {
        const d = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
        if (e.reason === "stalemate:unanswered_request") {
          if (typeof d.requestMessageId === "string") ids.add(d.requestMessageId);
        } else if (e.reason === "stalemate") {
          // A derived summary: load the requests it summarises too, so the card can name each one.
          for (const o of Array.isArray(d.openDeadlockEscalations) ? d.openDeadlockEscalations : []) {
            const rid = (o?.id ? byId.get(o.id) : undefined)?.detail?.requestMessageId;
            if (typeof rid === "string") ids.add(rid);
          }
        }
      }
      const next = new Map<string, any>();
      await Promise.all([...ids].slice(0, 20).map(async (id) => {
        try {
          const { status: st, json } = await client.api("GET", `/messages/${encodeURIComponent(id)}`);
          if (st === 200 && json?.id) next.set(id, json);
        } catch {
          /* the card renders without the preview */
        }
      }));
      if (!dead && next.size > 0) setMsgs(next);
    })().catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [list, client]);

  const finish = async (): Promise<void> => {
    await reload();
    void refreshStatus();
  };
  const remember = (e: EscalationLike, title: string, text: string): void => {
    const id = String(e.id);
    setAnswered((prev) => [{ id, title, text, holds: holdsOf(e), at: Date.now() }, ...prev.filter((a) => a.id !== id)]);
  };

  /** Record a decision. Resumes the mission when the project is live; a parked project records it and waits. */
  const respond = async (e: EscalationLike, title: string, text: string): Promise<boolean> => {
    const id = String(e.id);
    const body = text.trim();
    if (!body || busy) return false;
    setBusy(id);
    let ok = false;
    try {
      const r = await client.post(`/escalations/${encodeURIComponent(id)}/respond`, { response: body });
      if (r.status !== 200) {
        toast("Could not send the response", String(r.json?.reason ?? "Try again."), "bad");
      } else {
        ok = true;
        draftClear(id);
        const t = answerToast({ parked, holds: holdsOf(e) });
        toast(t.title, typeof r.json?.reason === "string" ? r.json.reason : t.msg, "ok");
        remember(e, title, body);
      }
    } catch {
      toast("Could not send the response", "The server did not answer.", "bad");
    } finally {
      setBusy(null);
    }
    await finish();
    return ok;
  };

  /** Answer a request an agent is waiting on, and resolve its card in one call. A parked project then asks whether to start. */
  const answer = async (e: EscalationLike, title: string, text: string): Promise<boolean> => {
    const id = String(e.id);
    const body = text.trim();
    if (!body || busy) return false;
    setBusy(id);
    let ok = false;
    try {
      const { status: st, json } = await client.post(`/escalations/${encodeURIComponent(id)}/answer`, { text: body, response: body });
      if (st !== 200) {
        toast("Could not send the answer", String(json?.reason ?? "Try again."), "bad");
      } else {
        ok = true;
        draftClear(id);
        const t = answerToast({ parked, holds: holdsOf(e), what: "Answer" });
        toast(t.title, t.msg, "ok");
        remember(e, title, body);
      }
    } catch {
      toast("Could not send the answer", "The server did not answer.", "bad");
    } finally {
      setBusy(null);
    }
    // One click used to send the answer and then need a second "Continue" on a parked project. Folded in: the answer goes, then
    // the question about starting the mission follows at once.
    if (ok && parked) await goLive().catch(() => undefined);
    await finish();
    return ok;
  };

  /** Drop a request: the waiting agent moves on without an answer and cannot ask again, so the operator says why. */
  const skip = async (e: EscalationLike, title: string, requestLabel: string, why: { label: string; placeholder: string }): Promise<boolean> => {
    const id = String(e.id);
    const reason = await confirm({
      title: "Skip this request?",
      body: [requestLabel, "The waiting agent moves on without an answer and cannot ask again."],
      danger: true,
      confirmLabel: "Skip it",
      require: { kind: "text", label: why.label, placeholder: why.placeholder },
    });
    if (reason === null || busy) return false;
    setBusy(id);
    let ok = false;
    try {
      const { status: st, json } = await client.post(`/escalations/${encodeURIComponent(id)}/drop`, { reason: `dropped by operator: ${reason}`, response: `skipped: ${reason}` });
      if (st !== 200) {
        toast("Could not skip the request", String(json?.reason ?? "Try again."), "bad");
      } else {
        ok = true;
        toast("Request skipped", answerToast({ parked, holds: holdsOf(e) }).msg, "ok");
        remember(e, title, `Skipped: ${reason}`);
      }
    } catch {
      toast("Could not skip the request", "The server did not answer.", "bad");
    } finally {
      setBusy(null);
    }
    if (ok && parked) await goLive().catch(() => undefined);
    await finish();
    return ok;
  };

  /** Raise a token budget, then record the decision. The raise is the part that moves the mission; the note is for the agents. */
  const raise = async (e: EscalationLike, title: string, key: string, newLimit: number, note: string, ask: boolean): Promise<boolean> => {
    const id = String(e.id);
    if (ask) {
      const sure = await confirm({
        title: `Raise the budget to ${fmt(newLimit)}?`,
        body: [parked
          ? "The new limit takes effect at once. The project is parked, so nothing runs until you start the mission."
          : "This wakes the blocked agents and resumes spend against the new limit."],
        confirmLabel: parked ? "Raise the budget" : "Raise and resume",
      });
      if (sure === null) return false;
    }
    const response = note.trim() || `raised budget to ${fmt(newLimit)}; continue with smaller steps`;
    setRaiseBusy(id + key);
    let ok = false;
    try {
      const { status: st, json } = await client.post("/budgets/raise", { key, limit: newLimit });
      if (st !== 200 || !json?.ok) {
        toast("Could not raise the budget", String(json?.reason || `The server answered ${st}.`), "bad");
        return false;
      }
      const r2 = await client.post(`/escalations/${encodeURIComponent(id)}/respond`, { response });
      if (r2.status !== 200) {
        toast("Budget raised, but the response was not recorded", "The card is still open: answer it to clear it.", "warn");
      } else {
        ok = true;
        draftClear(id);
        toast(`Budget raised to ${fmtBudget(newLimit, "tokens")}`, answerToast({ parked, holds: holdsOf(e) }).msg, "ok");
        remember(e, title, `Raised the budget to ${fmtBudget(newLimit, "tokens")}`);
      }
    } catch {
      toast("Could not raise the budget", "The server did not answer.", "bad");
    } finally {
      setRaiseBusy(null);
    }
    await finish();
    return ok;
  };

  /** Raise the event cap or the time limit to double, write it to mesh.yaml so a restart keeps it, and record the decision. */
  const raiseCap = async (e: EscalationLike, title: string, budget: BudgetInfo): Promise<boolean> => {
    const id = String(e.id);
    const kind = budget.configCap === "time" ? "time" : "events";
    const target = capTarget(kind, budget, status);
    setRaiseBusy(id + kind);
    let ok = false;
    try {
      const patch = kind === "events" ? { maxEvents: target } : { wallClockMinutes: target };
      const r = await client.post("/mission/limits", patch);
      if (!r.json?.ok) {
        toast("Could not raise the cap", String(r.json?.reason || `The server answered ${r.status}.`), "bad");
        return false;
      }
      let yamlNote = "";
      try {
        const { json: cfg } = await client.api("GET", "/config");
        if (cfg?.raw && cfg?.filePath) {
          const raw = JSON.parse(JSON.stringify(cfg.raw));
          raw.budgets = raw.budgets || {};
          raw.budgets.mission = raw.budgets.mission || {};
          if (kind === "events") raw.budgets.mission.max_events = target;
          else raw.budgets.mission.wall_clock_minutes = target;
          const saved = await client.post("/config/save", { config: raw, path: cfg.filePath });
          yamlNote = saved.status === 200 ? " mesh.yaml was updated." : " mesh.yaml was left unchanged.";
        }
      } catch {
        yamlNote = " mesh.yaml was left unchanged.";
      }
      const label = kind === "events" ? `event cap to ${compact(target)}` : `time limit to ${target} ${target === 1 ? "minute" : "minutes"}`;
      const r2 = await client.post(`/escalations/${encodeURIComponent(id)}/respond`, { response: `raised ${label}; resuming` });
      if (r2.status !== 200) {
        toast("Cap raised, but the response was not recorded", `The card is still open: answer it to clear it.${yamlNote}`, "warn");
      } else {
        ok = true;
        toast(`Raised the ${label}`, `${answerToast({ parked, holds: holdsOf(e) }).msg}${yamlNote}`, "ok");
        remember(e, title, `Raised the ${label}`);
      }
    } catch {
      toast("Could not raise the cap", "The server did not answer.", "bad");
    } finally {
      setRaiseBusy(null);
    }
    await finish();
    return ok;
  };

  const copyId = async (id: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(id);
      toast("Copied", id, "ok");
    } catch {
      toast("Could not copy", id, "warn");
    }
  };

  return {
    parked, ceilingTripped, list, load, loadErr, retry: () => setAttempt((n) => n + 1),
    msgs, artIndex, busy, raiseBusy, answered, dismissAnswered: (id: string) => setAnswered((p) => p.filter((a) => a.id !== id)),
    respond, answer, skip, raise, raiseCap, copyId, phrase: verdictText, budgetOf: (e: EscalationLike) => budgetInfoOf(e, status, verdictText),
  };
}

export type Decisions = ReturnType<typeof useDecisions>;
