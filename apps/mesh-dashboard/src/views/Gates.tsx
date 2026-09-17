import { useCallback, useEffect, useState } from "react";
import { useMesh } from "../store";
import { Button, Card, ErrorState, Input } from "../components";
import { agentAction } from "../drawers";

/**
 * Seats the approval gate is holding, and what an operator has unlocked on each.
 *
 * `GET /tool-approvals` reports only seats whose config names a
 * `requires_approval` family, so an empty list means "nothing is gated" rather
 * than "the endpoint had nothing to say" — worth stating, because the two used
 * to be indistinguishable when clearing a seat meant hand-rolling a POST.
 */
interface Seat {
  agentId: string;
  requiresApproval: string[];
  granted: string[];
}

export default function Gates(): React.JSX.Element {
  const { client, toast, serverDown, refreshStatus } = useMesh();
  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await client.api("GET", "/tool-approvals");
    const list = (r.json as { seats?: unknown } | null)?.seats;
    if (r.status === 200 && Array.isArray(list)) {
      setSeats(list as Seat[]);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, [client]);

  // Grants are session state, not event-sourced, so nothing streams them: a
  // second operator's grant only shows up on the next poll.
  useEffect(() => {
    void load();
    const iv = setInterval(() => void load(), 3000);
    return () => clearInterval(iv);
  }, [load]);

  const decide = async (agentId: string, tool: string, revoke: boolean): Promise<void> => {
    const t = tool.trim();
    if (!t) return;
    setBusy(`${agentId}:${t}`);
    const r = await client.post("/tool-approvals", { agentId, tool: t, revoke });
    setBusy(null);
    if (r.status === 200) {
      toast(revoke ? "grant withdrawn" : "tool unlocked", `${t} on ${agentId}`);
      setDraft((d) => ({ ...d, [agentId]: "" }));
      void load();
      return;
    }
    // The route distinguishes "you left a field out" (400) from "that seat or
    // grant does not exist" (404) and says which in `reason`; showing its own
    // words beats a generic failure the operator has to go and diagnose.
    const reason = (r.json as { reason?: string } | null)?.reason;
    toast("could not update the grant", reason ?? `the server answered ${r.status}`, "bad");
  };

  if (seats === null) {
    return failed || serverDown
      ? <ErrorState what="the tool gates" detail="the mesh server stopped answering — it may be restarting." onRetry={() => void load()} />
      : <div className="empty"><div className="big">…</div><div>loading tool gates</div></div>;
  }

  return (
    <>
      <div className="view-title"><h2>Tool gates</h2></div>
      <div className="view-sub">
        Seats that hold a capability but must wait for you before using it. A grant covers
        one <b>tool</b> for the rest of the session — not one call, and not the whole capability.
        Granting does not resume the seat: <b>wake</b> it once you have cleared everything it needs.
      </div>

      {seats.length === 0 ? (
        <Card>
          <div className="empty">
            <div className="big">⊘</div>
            <div>No gated seats.</div>
            <div className="muted">No agent in this mesh sets <code>requires_approval</code>, so nothing is being held.</div>
          </div>
        </Card>
      ) : null}

      {seats.map((s) => (
        <Card key={s.agentId} title={s.agentId} actions={
          <Button variant="small" title="Run one step now, so the seat picks up what you just unlocked" onClick={() => void agentAction(client, s.agentId, "wake", toast, () => void refreshStatus())}>wake</Button>
        }>
          <div className="muted">
            gated: {s.requiresApproval.map((c) => <code key={c}>{c}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ", ", el] : [el]), [])}
          </div>

          <div className="row-actions" style={{ flexWrap: "wrap", margin: "8px 0" }}>
            {s.granted.length === 0
              ? <span className="muted">nothing unlocked yet</span>
              : s.granted.map((tool) => (
                <Button
                  key={tool}
                  variant="small"
                  danger
                  disabled={busy === `${s.agentId}:${tool}`}
                  title={`Withdraw ${tool} — the seat re-gates it from its next turn on`}
                  onClick={() => void decide(s.agentId, tool, true)}
                >
                  {tool} ✕
                </Button>
              ))}
          </div>

          <div className="row-actions">
            <Input
              mono
              value={draft[s.agentId] ?? ""}
              placeholder="tool name, exactly — Edit, Write, Bash"
              onChange={(e) => setDraft((d) => ({ ...d, [s.agentId]: e.target.value }))}
              onKeyDown={(e) => { if (e.key === "Enter") void decide(s.agentId, draft[s.agentId] ?? "", false); }}
            />
            <Button
              variant="small"
              disabled={!((draft[s.agentId] ?? "").trim()) || busy === `${s.agentId}:${(draft[s.agentId] ?? "").trim()}`}
              onClick={() => void decide(s.agentId, draft[s.agentId] ?? "", false)}
            >
              unlock
            </Button>
          </div>
          {/* Tool names are the runtime's own, case included: a grant for "edit"
              is recorded and then never matches the "Edit" the gate checks. */}
          <div className="muted">Match the runtime's spelling — grants are exact, per tool.</div>
        </Card>
      ))}
    </>
  );
}
