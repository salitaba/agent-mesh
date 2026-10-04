/* Policy inspector: gates (transitions), escalation triggers, mission budgets, and raw policy rules for the policy engine. */

import { useState } from "react";
import { Field, Num, Section } from "../ui";
import { Button, Input, TextArea } from "../../components";
import { gateHolders } from "../edits";
import { setPath } from "../model";
import type { DCtx } from "../types";

export default function PolicyPanel({ ctx }: { ctx: DCtx }): React.JSX.Element {
  const { m, touch, reveal } = ctx;
  const [newGate, setNewGate] = useState("");
  const [rulesText, setRulesText] = useState<string | null>(null);
  const [rulesErr, setRulesErr] = useState("");
  const gates = m.policies.transitions || {};
  const gateNames = Object.keys(gates);
  const rawRules: any[] = m.policies.rules || [];
  return (
    <div className="ms-panel">
      <Section id="gates" title="Gates" meta={gateNames.length || "none"} reveal={reveal}>
        <p className="ms-hint">A gate holds a step until every approval it requires has been given. Write each as <span className="mono">seat-or-role.approve</span>; join alternatives with <span className="mono">|</span>.</p>
        {gateNames.map((g) => {
          const reqs: string[] = gates[g]?.requires || [];
          return (
            <div className="ms-gate" key={g} data-field={g}>
              {/* Renaming live on every keystroke changed this row's key and remounted the input, dropping focus after one character.
                  The draft stays local and commits on blur or Enter. */}
              <Field label="Gate">
                <Input
                  mono defaultValue={g} list="d-gnames"
                  onBlur={(e) => {
                    const nv = e.target.value.trim();
                    if (nv === g) return;
                    if (!nv || gates[nv]) { e.target.value = g; return; }
                    gates[nv] = gates[g];
                    delete gates[g];
                    touch("Renamed a gate");
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                />
              </Field>
              <Field label="Requires" hint="Comma separated, for example tech-lead.approve, qa.pass">
                <Input
                  defaultValue={reqs.join(", ")} key={`${g}-req`} placeholder="tech-lead.approve, qa.pass"
                  onBlur={(e) => { gates[g].requires = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); }}
                />
              </Field>
              {reqs.length ? (
                <ul className="ms-holders">
                  {reqs.map((r) => (
                    <li key={r}>
                      <span className="mono">{r}</span>
                      <span className="ms-holders-who">
                        {gateHolders(m, r).map((h) => (
                          <span key={h.alternative}>
                            {h.seats.length
                              ? h.seats.map((s) => <Button key={s} variant="linklike" extra="ms-who" onClick={() => ctx.openSeat(s)}>{s}</Button>)
                              : <em className="ms-nobody">no seat has the id or role {h.actor}</em>}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <p className="ms-hint">No requirements. This gate lets everything through.</p>}
              <Button variant="small" danger icon="trash" onClick={() => { delete gates[g]; touch(`Removed the gate ${g}`); }}>Remove the gate</Button>
            </div>
          );
        })}
        <datalist id="d-gnames">{(ctx.vocab?.gateKinds || []).map((g: string) => <option key={g}>{g}</option>)}</datalist>
        <div className="row ms-adder">
          <Input aria-label="New gate name" placeholder="New gate, for example patch.merge" value={newGate} onChange={(e) => setNewGate(e.target.value)} />
          <Button variant="small" icon="plus" disabled={!newGate.trim() || !!gates[newGate.trim()]} onClick={() => {
            gates[newGate.trim()] = { requires: [] };
            setNewGate("");
            touch("Added a gate");
          }}>Add a gate</Button>
        </div>
      </Section>

      <Section id="escalation" title="Escalation" defaultOpen={false} reveal={reveal}>
        <p className="ms-hint">When one of these is reached the mesh pauses and asks you.</p>
        <div className="grid3">
          <Num label="Reply-chain depth" value={m.policies.escalation?.thread?.max_depth ?? 8} onSet={(v) => { setPath(m, "policies.escalation.thread.max_depth", v ?? 0); touch(); }} hint="Default 8" />
          <Num label="Repeated clashes" value={m.policies.escalation?.repeated_conflict?.threshold ?? 3} onSet={(v) => { setPath(m, "policies.escalation.repeated_conflict.threshold", v ?? 0); touch(); }} hint="Default 3" />
          <Num label="Re-review rounds" value={m.policies.escalation?.artifact_review_rounds?.max ?? 5} onSet={(v) => { setPath(m, "policies.escalation.artifact_review_rounds.max", v ?? 0); touch(); }} hint="Default 5" />
        </div>
      </Section>

      <Section id="budgets" title="Budgets" defaultOpen={false} reveal={reveal}>
        <div className="grid3">
          <Num label="Mission tokens" value={m.budgets?.mission?.tokens ?? 2000000} step={100000} onSet={(v) => { setPath(m, "budgets.mission.tokens", v ?? 0); touch(); }} />
          <Num label="Mission minutes" value={m.budgets?.mission?.wall_clock_minutes ?? 240} onSet={(v) => { setPath(m, "budgets.mission.wall_clock_minutes", v ?? 0); touch(); }} />
          <Num label="Mission events" value={m.budgets?.mission?.max_events ?? 10000} step={500} onSet={(v) => { setPath(m, "budgets.mission.max_events", v ?? 0); touch(); }} />
          <Num label="Thread tokens" value={m.budgets?.thread?.tokens ?? 50000} step={5000} onSet={(v) => { setPath(m, "budgets.thread.tokens", v ?? 0); touch(); }} />
          <Num label="Task tokens" value={m.budgets?.task?.tokens ?? 100000} step={5000} onSet={(v) => { setPath(m, "budgets.task.tokens", v ?? 0); touch(); }} />
        </div>
        <p className="ms-hint">The cap on one seat is in that seat&rsquo;s Budget section.</p>
      </Section>

      <Section id="rules" title="Policy rules" meta="expert" defaultOpen={false} reveal={reveal}>
        <p className="ms-hint">Extra <span className="mono">when</span> and <span className="mono">deny</span> rules, as JSON. The server checks them: a rule that names a seat, tool or message type that does not exist is refused at load, not ignored.</p>
        <TextArea
          mono rows={6} spellCheck={false} aria-label="Policy rules, JSON"
          defaultValue={rulesText ?? JSON.stringify(rawRules, null, 1)} key={`rules-${JSON.stringify(rawRules).length}`}
          onChange={(e) => setRulesText(e.target.value)}
        />
        <div className="row">
          <Button variant="small" disabled={rulesText === null} onClick={() => {
            try {
              const parsed = JSON.parse(String(rulesText));
              if (!Array.isArray(parsed)) throw new Error("It must be an array.");
              m.policies.rules = parsed;
              setRulesText(null);
              setRulesErr("");
              touch("Edited policy rules");
            } catch (err: any) {
              setRulesErr(String(err?.message || err));
            }
          }}>Apply the rules</Button>
          {rulesErr ? <span className="ms-hint bad" role="alert">{rulesErr}</span> : null}
        </div>
      </Section>
    </div>
  );
}
