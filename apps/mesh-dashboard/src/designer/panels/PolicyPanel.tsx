/* Policy inspector: gates (transitions), escalation triggers, budgets, and
 * raw policy rules for the policy engine. */

import { useState } from "react";
import { Num, Field } from "../ui";
import { Button, Chip, Input, TextArea } from "../../components";
import { setPath } from "../model";
import type { DCtx } from "../types";

export default function PolicyPanel({ ctx }: { ctx: DCtx }): React.JSX.Element {
  const { m, touch, ids } = ctx;
  const [newGate, setNewGate] = useState("");
  const [rulesText, setRulesText] = useState<string | null>(null);
  const [rulesErr, setRulesErr] = useState("");
  const gates = m.policies.transitions || {};
  const gateNames = Object.keys(gates);
  const granters = (token: string): string[] => ids.filter((id) => (m.agents[id]?.authority || []).includes(token));
  const rawRules: any[] = m.policies.rules || [];
  return (
    <div className="ms-panel">
      <div className="ms-h">Gates — a step holds until every approval lands</div>
      {gateNames.map((g) => (
        <div className="gate-card" key={g}>
          <Input mono value={g} list="d-gnames" aria-label="gate name" onChange={(e) => {
            const old = g;
            const nv = e.target.value.trim();
            if (!nv) return;
            if (nv !== old && !gates[nv]) {
              gates[nv] = gates[old];
              delete gates[old];
            }
            touch();
          }} />
          <Input defaultValue={(gates[g]?.requires || []).join(", ")} key={`${g}-req`} placeholder="approvals required — tech-lead.approve, qa.pass" aria-label={`approvals required by ${g}`}
            onBlur={(e) => { gates[g].requires = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); }} />
          {(gates[g]?.requires || []).length ? (
            <div className="gate-grants">
              {(gates[g].requires || []).map((r: string) => {
                const who = granters(r);
                return <Chip key={r}>{r} → {who.length ? who.map((w) => <Button key={w} variant="linklike" extra="gate-who" onClick={() => ctx.setCur(w)}>{w}</Button>) : <em className="nobody">nobody grants it</em>}</Chip>;
              })}
            </div>
          ) : <span className="muted" style={{ fontSize: 11 }}>no requirements — this gate lets everything through.</span>}
          <Button variant="small" danger style={{ alignSelf: "flex-start" }} onClick={() => { delete gates[g]; touch(); }}>remove gate</Button>
        </div>
      ))}
      <datalist id="d-gnames">{(ctx.vocab?.gateKinds || []).map((g: string) => <option key={g}>{g}</option>)}</datalist>
      <div className="row">
        <Input style={{ flex: 1 }} placeholder="new gate, e.g. patch.merge" value={newGate} onChange={(e) => setNewGate(e.target.value)} />
        <Button variant="small" disabled={!newGate.trim() || !!gates[newGate.trim()]} onClick={() => {
          gates[newGate.trim()] = { requires: [] };
          setNewGate("");
          touch();
        }}>+ gate</Button>
      </div>

      <div className="ms-h">Escalation triggers — when the mesh pauses and calls you</div>
      <div className="grid3">
        <Num label="reply-chain depth" value={m.policies.escalation?.thread?.max_depth ?? 8} onSet={(v) => { setPath(m, "policies.escalation.thread.max_depth", v ?? 0); touch(); }} hint="default 8" />
        <Num label="repeated clashes" value={m.policies.escalation?.repeated_conflict?.threshold ?? 3} onSet={(v) => { setPath(m, "policies.escalation.repeated_conflict.threshold", v ?? 0); touch(); }} hint="default 3" />
        <Num label="re-review rounds" value={m.policies.escalation?.artifact_review_rounds?.max ?? 5} onSet={(v) => { setPath(m, "policies.escalation.artifact_review_rounds.max", v ?? 0); touch(); }} hint="default 5" />
      </div>

      <div className="ms-h">Budgets</div>
      <div className="grid3">
        <Num label="mission tokens" value={m.budgets?.mission?.tokens ?? 2000000} step={100000} onSet={(v) => { setPath(m, "budgets.mission.tokens", v ?? 0); touch(); }} />
        <Num label="mission minutes" value={m.budgets?.mission?.wall_clock_minutes ?? 240} onSet={(v) => { setPath(m, "budgets.mission.wall_clock_minutes", v ?? 0); touch(); }} />
        <Num label="mission events" value={m.budgets?.mission?.max_events ?? 10000} step={500} onSet={(v) => { setPath(m, "budgets.mission.max_events", v ?? 0); touch(); }} />
        <Num label="thread tokens" value={m.budgets?.thread?.tokens ?? 50000} step={5000} onSet={(v) => { setPath(m, "budgets.thread.tokens", v ?? 0); touch(); }} />
        <Num label="task tokens" value={m.budgets?.task?.tokens ?? 100000} step={5000} onSet={(v) => { setPath(m, "budgets.task.tokens", v ?? 0); touch(); }} />
      </div>
      <div className="muted" style={{ fontSize: 11 }}>Per-agent overrides live in each agent’s inspector (Crew tab).</div>

      <details className="ms-adv">
        <summary>expert — raw policy rules (JSON)</summary>
        <p className="muted" style={{ fontSize: 12 }}>Advanced when/requires/deny rules enforced by the policy engine. Edit as JSON; the server validates on check.</p>
        <TextArea mono rows={6} spellCheck={false} aria-label="policy rules JSON"
          defaultValue={rulesText ?? JSON.stringify(rawRules, null, 1)} key={`rules-${JSON.stringify(rawRules).length}`}
          onChange={(e) => setRulesText(e.target.value)} />
        <div className="row" style={{ marginTop: 6 }}>
          <Button variant="small" disabled={rulesText === null} onClick={() => {
            try {
              const parsed = JSON.parse(String(rulesText));
              if (!Array.isArray(parsed)) throw new Error("must be an array");
              m.policies.rules = parsed;
              setRulesText(null);
              setRulesErr("");
              touch();
            } catch (err: any) {
              setRulesErr(String(err?.message || err));
            }
          }}>apply rules</Button>
          {rulesErr ? <span className="verdict bad" style={{ margin: 0, fontSize: 12 }}>{rulesErr}</span> : null}
        </div>
      </details>
    </div>
  );
}