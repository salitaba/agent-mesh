import { useEffect, useState } from "react";
import { api } from "../api";
import { fmt, friendlyBudgetKey } from "../format";
import { useMesh } from "../store";
import { Button, Card, Pill } from "../components";

export default function Cost(): React.JSX.Element {
  const { refreshStatus, setView } = useMesh();
  const [budgets, setBudgets] = useState<any>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      const [{ json: b }] = await Promise.all([api("GET", "/budgets")]);
      if (dead) return;
      setBudgets(b);
      await refreshStatus();
    })().catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [refreshStatus]);

  const cost = budgets?.cost || { perAgent: [], missionTokens: 0, missionBudget: 0, models: [] };
  const ranked = (cost.perAgent || []).filter((p: any) => p.agentId !== "human").sort((a: any, b: any) => b.tokens - a.tokens);
  const max = Math.max(1, ...ranked.map((p: any) => p.tokens));
  const pct = cost.missionBudget ? Math.round((cost.missionTokens / cost.missionBudget) * 100) : 0;
  const over = (budgets?.entries || []).filter((b: any) => b.exceeded);
  // Per-model spend was a declared field filled by an empty loop, so the
  // question that actually drives the bill — which model is eating it — had
  // no answer anywhere in the console.
  const models = (cost.models || []) as any[];
  const modelMax = Math.max(1, ...models.map((m: any) => m.tokens));
  const cacheTotal = models.reduce((a: number, m: any) => a + (m.cacheRead || 0), 0);
  return (
    <>
      <div className="view-title"><h2>Cost</h2></div>
      <div className="view-sub">Token spend and remaining budget. Over-budget items appear first.</div>
      {over.length ? <div className="status-strip bad" style={{ marginBottom: 12 }}><div><b>Over budget:</b> <span className="muted">{over.map((b: any) => (friendlyBudgetKey(b.key))).join(", ")}</span> <Button variant="banner-act" onClick={() => setView("escalations")}>Review decisions</Button></div></div> : null}
      <div className="grid kpis" style={{ marginBottom: 12 }}>
        <Card variant="kpi"><small>Spent of budget</small><b>{fmt(cost.missionTokens)}<span className="muted" style={{ fontSize: 13 }}>/{fmt(cost.missionBudget)}</span></b><div className="progress"><div style={{ transform: `scaleX(${Math.min(1, pct / 100)})` }} /></div><div className="delta">{pct}% used</div></Card>
        <Card variant="kpi"><small>Biggest spender</small><b>{(ranked[0]?.agentId || "—")}</b><div className="delta">{fmt(ranked[0]?.tokens || 0)} tokens</div></Card>
        <Card variant="kpi"><small>Priciest model</small><b>{(models[0]?.model || "—")}</b><div className="delta">{models[0] ? `${fmt(models[0].tokens)} tokens · ${Math.round(models[0].share * 100)}% of spend` : "no model spend recorded"}</div></Card>
      </div>
      <Card title="By agent">
        {ranked.map((p: any) => (
          <div key={p.agentId} className="bar-row"><span className="lbl">{(p.agentId)} <span className="muted">· ran {p.activations}× · {fmt(p.perTurn)}/turn</span></span>
            <div className="track"><div style={{ transform: `scaleX(${max ? p.tokens / max : 0})` }} /></div>
            <span className="num">{fmt(p.tokens)}</span></div>
        )) || <div className="muted">No spend yet.</div>}
      </Card>
      <Card title="By model" style={{ marginTop: 12 }}>
        {models.length ? (
          <>
            {models.map((m: any) => (
              <div key={m.model} className="bar-row">
                <span className="lbl mono">{(m.model)} <span className="muted">· {m.turns} turn{m.turns === 1 ? "" : "s"} · {fmt(m.avgPerTurn)}/turn · {(m.agents || []).slice(0, 3).join(", ")}{(m.agents || []).length > 3 ? ` +${m.agents.length - 3}` : ""}</span></span>
                <div className="track"><div style={{ transform: `scaleX(${m.tokens / modelMax})` }} /></div>
                <span className="num">{fmt(m.tokens)}</span>
              </div>
            ))}
            <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
              Bars are billed tokens (in + out).
              {cacheTotal ? ` ${fmt(cacheTotal)} cached transcript tokens were replayed and are not billed.` : ""}
            </div>
          </>
        ) : <div className="muted">No model spend recorded yet — this fills in once agents run turns.</div>}
      </Card>
      <details className="card esc-raw" style={{ marginTop: 12 }}><summary>Budget details (advanced)</summary><table className="tbl"><thead><tr><th>budget</th><th>used</th><th>limit</th><th>state</th></tr></thead><tbody>
        {(budgets?.entries || []).map((b: any) => <tr key={`${b.key}:${b.limitKind}`}><td className="mono">{(friendlyBudgetKey(b.key))}</td><td className="mono">{fmt(b.consumed)}</td><td className="mono">{b.limit === null ? "—" : fmt(b.limit)}</td><td>{b.exceeded ? <Pill tone="failed">over</Pill> : <Pill tone="idle">ok</Pill>}</td></tr>)}
      </tbody></table></details>
    </>
  );
}
