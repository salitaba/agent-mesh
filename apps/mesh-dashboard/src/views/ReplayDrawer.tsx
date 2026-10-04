import { useEffect, useState } from "react";
import { fmt } from "../format";
import { Button, ErrorState } from "../components";
import { CloseX } from "../drawers";
import { plainGoal } from "../format";
import { useMesh } from "../store";
import "./overview.css";

type Replay =
  | { phase: "loading" }
  | { phase: "error"; why: string }
  | { phase: "ready"; data: any };

/**
 * The mission rebuilt from its event log with no model calls: what the log alone says happened. It opens at once and loads
 * inside, because rebuilding a long log can take most of a minute and a click that shows nothing for that long reads as
 * broken. The raw replay is behind a disclosure for anyone who wants to diff it.
 */
export function ReplayDrawer({ goalId }: { goalId: string }): React.JSX.Element {
  const { client } = useMesh();
  const [state, setState] = useState<Replay>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let dead = false;
    setState({ phase: "loading" });
    client.api("GET", `/goals/${encodeURIComponent(goalId)}/replay`, undefined, { timeoutMs: 60000 })
      .then((r) => {
        if (dead) return;
        if (r.status === 200 && r.json) setState({ phase: "ready", data: r.json });
        else setState({ phase: "error", why: r.timeout ? "The server took too long to rebuild the log." : `The server answered ${r.status || "nothing"}.` });
      })
      .catch(() => { if (!dead) setState({ phase: "error", why: "The server did not answer." }); });
    return () => { dead = true; };
  }, [client, goalId, attempt]);

  const d = state.phase === "ready" ? state.data : null;
  const agents: any[] = (d?.agents ?? []).filter((a: any) => a.agentId !== "human");
  const mission = (d?.budgets ?? []).find((b: any) => String(b.key).startsWith("mission:"));
  return (
    <div className="replay">
      <h2 id="drawer-title">Replay <CloseX /></h2>
      {state.phase === "loading" ? <p className="muted" role="status">Rebuilding the mission from its event log. This can take a while on a long run.</p> : null}
      {state.phase === "error" ? <ErrorState what="the replay" detail={state.why} onRetry={() => setAttempt((n) => n + 1)} /> : null}
      {d ? (
        <>
          <p>
            The mission rebuilt from <b>{fmt(d.eventCount ?? 0)} events</b>, with no model calls. Its status is <b>{plainGoal(d.goal?.status)}</b>.
            This is what the log alone says, not a copy of what the server holds now.
          </p>
          <h3 className="group-h">Agents</h3>
          {agents.length ? (
            <table className="tbl">
              <thead><tr><th scope="col">Agent</th><th scope="col">Final state</th><th scope="col">Turns</th><th scope="col">Tokens</th></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agentId}>
                    <td className="mono">{a.agentId}</td>
                    <td>{String(a.lifecycle ?? "").toLowerCase()}</td>
                    <td className="mono">{a.activations ?? 0}</td>
                    <td className="mono">{fmt(a.tokensConsumed ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">The log records no agents.</p>}
          <h3 className="group-h">Spend and files</h3>
          <p>
            {mission ? <>Mission tokens: <b>{fmt(mission.consumed ?? 0)}</b>{mission.limit ? <> of {fmt(mission.limit)}</> : null}. </> : null}
            Files recorded: <b>{typeof d.artifacts === "number" ? d.artifacts : Array.isArray(d.artifacts) ? d.artifacts.length : 0}</b>.
          </p>
          <details className="esc-raw">
            <summary>Raw replay</summary>
            <pre>{JSON.stringify({ goal: d.goal?.status, agents: agents.map((a) => [a.agentId, a.lifecycle]), artifacts: d.artifacts, budgets: d.budgets }, null, 1)}</pre>
          </details>
          <p><Button variant="small" icon="refresh" onClick={() => setAttempt((n) => n + 1)}>Rebuild again</Button></p>
        </>
      ) : null}
    </div>
  );
}
