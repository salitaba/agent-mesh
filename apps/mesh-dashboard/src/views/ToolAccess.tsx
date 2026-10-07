import { useState } from "react";
import { AgentAvatar, Button, Chip, EmptyState, ErrorState, Input, agentColor } from "../components";
import { Icon } from "../icons";
import type { LoadState, ToolSeat } from "../inbox-model";
import { useMesh } from "../store";
import { Panel } from "./Panel";
import "./gates.css";

/**
 * Seats the approval gate is holding, what each has asked for, and what an operator has unlocked on each.
 *
 * `GET /tool-approvals` reports only seats whose config names a `requires_approval` family, so an empty list means "nothing is
 * gated", not "the endpoint had nothing to say". A grant covers one tool for the rest of the session: not one call, because a
 * refused call cannot be replayed (the model decides again on its next turn), and not the whole capability. Granting does not
 * wake the seat, deliberately, so an operator clearing several requests wakes it once. The toast that follows a grant carries
 * the Wake button for exactly that reason.
 */
export function ToolAccess({ seats, state, reload }: { seats: ToolSeat[]; state: LoadState; reload: () => Promise<void> }): React.JSX.Element {
  const { client, toast, refreshStatus } = useMesh();
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const wake = async (agentId: string): Promise<void> => {
    try {
      const { status, json } = await client.post(`/agents/${encodeURIComponent(agentId)}/wake`);
      if (status === 200) toast("Woken", `${agentId} runs one step now.`, "ok");
      else toast("Could not wake", `${agentId}: ${String(json?.reason ?? "denied")}`, "warn");
    } catch {
      toast("Could not wake", `${agentId}: the server did not answer.`, "bad");
    }
    setTimeout(() => void refreshStatus(), 400);
  };

  /** Grant or withdraw one tool. Returns whether the server accepted it. */
  const decide = async (agentId: string, tool: string, revoke: boolean, quiet = false): Promise<boolean> => {
    const t = tool.trim();
    if (!t) return false;
    setBusy(`${agentId}:${t}`);
    try {
      const r = await client.post("/tool-approvals", { agentId, tool: t, revoke });
      if (r.status === 200) {
        if (!quiet) {
          toast(
            revoke ? "Grant withdrawn" : `${t} unlocked`,
            revoke ? `${agentId} is gated on ${t} again from its next turn.` : `${agentId} can use it from its next turn.`,
            "ok",
            revoke ? undefined : { label: `Wake ${agentId}`, run: () => void wake(agentId) },
          );
        }
        setDraft((d) => ({ ...d, [agentId]: "" }));
        await reload();
        return true;
      }
      // The route tells "you left a field out" (400) from "that seat or grant does not exist" (404) in `reason`; its own words
      // beat a generic failure the operator has to go and diagnose.
      toast("Could not update the grant", String((r.json as { reason?: string } | null)?.reason ?? `The server answered ${r.status}.`), "bad");
      return false;
    } catch {
      toast("Could not update the grant", "The server did not answer.", "bad");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const unlockAll = async (seat: ToolSeat): Promise<void> => {
    let n = 0;
    for (const tool of seat.requested) if (await decide(seat.agentId, tool, false, true)) n++;
    if (n > 0) toast(`${n} ${n === 1 ? "tool" : "tools"} unlocked on ${seat.agentId}`, `${seat.agentId} can use them from its next turn.`, "ok", { label: `Wake ${seat.agentId}`, run: () => void wake(seat.agentId) });
  };

  if (state === "loading") return <p className="tga-quiet" role="status">Loading the tool gates.</p>;
  if (state === "error") return <ErrorState what="the tool gates" detail="The server did not answer. It may be restarting." onRetry={() => void reload()} />;

  if (seats.length === 0) {
    return (
      <EmptyState icon="lock" title="No gated seats">
        No agent in this mesh sets <code>requires_approval</code>, so no tool is being held. To hold one, set it on a seat in <code>mesh.yaml</code>.
      </EmptyState>
    );
  }

  const asking = seats.filter((s) => s.requested.length > 0);
  const total = asking.reduce((n, s) => n + s.requested.length, 0);
  return (
    <>
      <p className="tga-lede">A grant covers one tool for the rest of the session, not one call and not the whole capability. Granting does not wake the seat: wake it once you have cleared everything it needs.</p>

      <Panel id="tg-requests" title="Requests" meta={total ? `${total} waiting` : undefined}>
        {asking.length === 0 ? (
          <div className="tga-none">
            <span className="tga-none-ic" aria-hidden="true"><Icon name="check" size={16} /></span>
            <p>No tool requests are waiting. A seat asks when it reaches for a tool its gate holds back.</p>
          </div>
        ) : (
          <ul className="tga-list">
            {asking.map((s) => (
              <li key={s.agentId} className="tga-req" data-seat={s.agentId}>
                <div className="tga-who">
                  <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} size="sm" />
                  <b>{s.agentId}</b>
                  <span className="muted">asked for {s.requested.length === 1 ? "a tool" : `${s.requested.length} tools`}</span>
                  <span className="tga-grow" />
                  <Button variant="soft" icon="play" title="Run one step now, so the seat picks up what you just unlocked" onClick={() => void wake(s.agentId)}>Wake {s.agentId}</Button>
                </div>
                <ul className="tga-tools">
                  {s.requested.map((tool) => (
                    <li key={tool}>
                      <Icon name="lock" size={14} />
                      <code>{tool}</code>
                      <span className="tga-grow" />
                      <Button
                        variant={s.requested.length > 1 ? "small" : "primary"} icon="key" disabled={busy === `${s.agentId}:${tool}`}
                        title={`Unlock ${tool} for the rest of the session. It takes effect on ${s.agentId}'s next turn.`}
                        onClick={() => void decide(s.agentId, tool, false)}
                      >
                        Unlock<span className="sr-only"> {tool}</span>
                      </Button>
                    </li>
                  ))}
                </ul>
                {s.requested.length > 1 ? (
                  <div className="tga-foot">
                    <Button variant="primary" icon="key" disabled={busy !== null} onClick={() => void unlockAll(s)}>Unlock all {s.requested.length}</Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel id="tg-seats" title="Gated seats" meta={`${seats.length} ${seats.length === 1 ? "seat" : "seats"}`}>
        <ul className="tga-list">
          {seats.map((s) => {
            const typed = (draft[s.agentId] ?? "").trim();
            return (
              <li key={s.agentId} className="tga-seat">
                <div className="tga-who">
                  <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} size="sm" />
                  <b>{s.agentId}</b>
                  <span className="muted">gated on</span>
                  {s.requiresApproval.map((c) => <Chip key={c} mono>{c}</Chip>)}
                </div>
                <div className="tga-grants">
                  <span className="tga-k">Unlocked</span>
                  {s.granted.length === 0 ? <span className="muted">nothing yet</span> : s.granted.map((tool) => (
                    <button
                      key={tool} type="button" className="chip-toggle on" aria-label={`Withdraw ${tool} from ${s.agentId}`} disabled={busy === `${s.agentId}:${tool}`}
                      title={`Withdraw ${tool}. ${s.agentId} is gated on it again from its next turn.`} onClick={() => void decide(s.agentId, tool, true)}
                    >
                      {tool}<Icon name="x" size={12} />
                    </button>
                  ))}
                </div>
                <form className="tga-manual" onSubmit={(ev) => { ev.preventDefault(); void decide(s.agentId, typed, false); }}>
                  <label className="tga-k" htmlFor={`tg-${s.agentId}-tool`}>Unlock a tool ahead of a request</label>
                  <div className="tga-row">
                    <Input id={`tg-${s.agentId}-tool`} mono value={draft[s.agentId] ?? ""} placeholder="Tool name, exactly: Edit, Write, Bash" onChange={(ev) => setDraft((d) => ({ ...d, [s.agentId]: ev.target.value }))} />
                    <Button variant="small" type="submit" disabled={!typed || busy === `${s.agentId}:${typed}`}>Unlock</Button>
                  </div>
                </form>
              </li>
            );
          })}
        </ul>
        <p className="tga-note">Match the runtime's spelling: a grant for "edit" is recorded and never matches the "Edit" the gate checks.</p>
      </Panel>
    </>
  );
}
