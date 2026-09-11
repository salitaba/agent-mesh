/* Crew inspector: everything about one agent — identity, capabilities,
 * wake events, wiring, budgets, session/delegation. Mutates `ctx.m` in
 * place and calls `ctx.touch()` after each change. */

import { useState } from "react";
import { CAPS, fmtNum, groupCaps } from "../model";
import { ChipPick, CommaAdder, CustomChips, Field, Num, hueVar } from "../ui";
import { Button, ErrorState, Input, Pill, Select, TextArea } from "../../components";
import { useModelCatalogue } from "../modelCatalogue";
import { useMesh } from "../../store";
import type { DCtx } from "../types";

/* Disclosure state lives at module scope so it survives tab switches, which
 * unmount the panel. Defaults: everything but Permissions/Advanced is open. */
const GROUP_OPEN: Record<string, boolean> = {
  general: true,
  behavior: true,
  permissions: false,
  communication: true,
  budget: true,
  advanced: false,
};

function Group({ id, summary, children }: { id: string; summary: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(GROUP_OPEN[id] ?? true);
  return (
    <details className="ms-group" open={open} onToggle={(e) => {
      const next = e.currentTarget.open;
      GROUP_OPEN[id] = next;
      setOpen(next);
    }}>
      <summary>{summary}</summary>
      <div className="ms-group-body">{children}</div>
    </details>
  );
}

export default function CrewPanel({ ctx }: { ctx: DCtx }): React.JSX.Element {
  const { m, cur, ids, vocab, ints, touch, startupSet } = ctx;
  const { client } = useMesh();
  const [intFilter, setIntFilter] = useState("");
  const [bulkCaps, setBulkCaps] = useState(false);
  const [bulkInts, setBulkInts] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [newCap, setNewCap] = useState("");
  const { state: models, reload: reloadModels } = useModelCatalogue(client);
  if (!cur || !m.agents[cur]) {
    return (
      <div className="ms-nosel">
        <p className="muted">Pick an agent on the canvas or the crew list to edit it — or hire a new one.</p>
        <Button variant="small" onClick={() => ctx.addAgent()}>+ hire agent</Button>
      </div>
    );
  }
  const a = m.agents[cur];
  const set = (k: string, v: any) => {
    if (v === "" || v === null || v === undefined) delete a[k];
    else a[k] = v;
    touch();
  };
  const setBudget = (k: string, v: number | null) => {
    a.budget ||= {};
    if (v === null || !Number.isFinite(v)) delete a.budget[k];
    else a.budget[k] = v;
    touch();
  };
  const toggleCap = (c: string) => {
    const l = new Set(a.capabilities || []);
    if (l.has(c)) l.delete(c); else l.add(c);
    a.capabilities = [...l];
    touch();
  };
  const contacts = new Set<string>(((m.policies.communication[cur] || {}).may_contact || []) as string[]);
  const incoming = ((m.policies.communication[cur] || {}).may_be_contacted_by || []) as string[];
  const customCaps = (a.capabilities || []).filter((c: string) => !CAPS.includes(c));
  const capBuckets = groupCaps([...CAPS, ...customCaps]);
  const knownModels = new Set<string>(models.phase === "ready" ? models.catalogue.models : []);
  const saved = typeof a.model === "string" ? a.model.trim() : "";
  const modelOptions = saved && !knownModels.has(saved) ? [saved, ...knownModels] : [...knownModels];
  const modelHint = models.phase === "ready" && saved && !knownModels.has(saved)
    ? "this model is not installed here — turns will fail until it is"
    : "blank = mesh default";
  const renameClean = renameValue.trim();
  const renameOk = !!renameClean && renameClean !== cur && !m.agents[renameClean];

  return (
    <div className="ms-panel">
      <div className="wb-insp-head">
        <span className="crew-av" style={hueVar(cur)}>{(cur[0] || "?").toUpperCase()}</span>
        <b className="mono">{cur}</b>
        {startupSet.has(cur) ? <Pill tone="awakened">boots</Pill> : null}
        {a.mode === "service" ? <Pill tone="completed">service</Pill> : null}
        <span className="page-actions">
          <Button variant="small" onClick={() => { setRenameValue(cur); setRenameOpen(!renameOpen); }}>rename…</Button>
          <Button variant="small" onClick={() => ctx.duplicateAgent()}>duplicate</Button>
          <Button variant="small" danger onClick={() => ctx.deleteAgent()}>delete</Button>
        </span>
      </div>
      {renameOpen ? (
        <div className="rename-box">
          <Input value={renameValue} aria-label="new agent id" placeholder="new id…" onChange={(e) => setRenameValue(e.target.value)} autoFocus />
          <div className="muted tx-meta">Rewires contacts, startup, budgets and triage rules to the new id.</div>
          <div className="row">
            <Button variant="small" disabled={!renameOk} onClick={() => { if (ctx.renameAgent(cur, renameClean)) setRenameOpen(false); }}>rename to “{renameClean || "…"}”</Button>
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>cancel</Button>
          </div>
        </div>
      ) : null}

      <Group id="general" summary="General">
        <div className="grid2">
          <Field label="role"><Input id="d-role" value={a.role || ""} onChange={(e) => set("role", e.target.value.trim())} /></Field>
          <Field label="model" hint={modelHint}>
            {models.phase === "error" ? (
              <ErrorState what="the model list" detail={models.detail} onRetry={reloadModels} />
            ) : (
              <Select value={a.model || ""} disabled={models.phase === "loading"} aria-label="model" onChange={(e) => set("model", e.target.value)}>
                <option value="">{models.phase === "loading" ? "loading models…" : `mesh default${models.catalogue.default ? ` (${models.catalogue.default})` : ""}`}</option>
                {/* A model already saved in mesh.yaml but absent from this
                  * installation's catalogue still belongs in the list — dropping it
                  * would silently rewrite the config on the next save. */}
                {modelOptions.map((id) => (
                  <option key={id} value={id}>{id}{knownModels.has(id) ? "" : " — not installed here"}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="runtime" hint="blank = mesh default"><Input value={a.runtime || ""} placeholder={m.mesh.runtime?.default || "opencode"} onChange={(e) => set("runtime", e.target.value.trim())} /></Field>
          <Field label="mode">
            <Select value={a.mode === "service" ? "service" : "peer"} onChange={(e) => set("mode", e.target.value === "service" ? "service" : "")}>
              <option value="peer">peer — wakes on events</option>
              <option value="service">service — always on</option>
            </Select>
          </Field>
        </div>
      </Group>

      <Group id="behavior" summary="Behavior">
        <Field label="prompt file" hint="blank = built-in role prompts"><Input value={a.prompt || ""} placeholder="../../roles/architect.md" onChange={(e) => set("prompt", e.target.value.trim())} /></Field>
        <label className="chk ms-boot"><input type="checkbox" checked={startupSet.has(cur)} onChange={() => ctx.toggleStartup(cur)} /> boots at startup</label>
        <div className="field">
          <label>wakes up for ({(a.interests || []).length})</label>
          <Input placeholder="filter the list…" style={{ marginBottom: 4 }} aria-label="Filter wake-up events" value={intFilter} onChange={(e) => setIntFilter(e.target.value)} />
          <div style={{ maxHeight: 140, overflow: "auto" }}>
            <ChipPick options={ints.filter((c: string) => c.toLowerCase().includes(intFilter.toLowerCase()))} values={a.interests || []} onToggle={(c) => {
              const l = new Set(a.interests || []);
              if (l.has(c)) l.delete(c); else l.add(c);
              a.interests = [...l];
              touch();
            }} />
          </div>
          <Button variant="linklike" onClick={() => setBulkInts(!bulkInts)}>{bulkInts ? "hide bulk edit" : "bulk edit as text…"}</Button>
          {bulkInts ? (
            <TextArea rows={2} aria-label="interests bulk edit" defaultValue={(a.interests || []).join(", ")} key={`ints-${cur}-${(a.interests || []).join(",")}`} onBlur={(e) => { a.interests = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); }} />
          ) : null}
        </div>
      </Group>

      <Group id="permissions" summary={`Permissions · ${(a.capabilities || []).length} enabled`}>
        {capBuckets.map(({ group, caps }) => {
          const known = caps.filter((c) => CAPS.includes(c));
          const custom = caps.filter((c) => !CAPS.includes(c));
          return (
            <div className="field" key={group}>
              <label>{group}</label>
              {known.length ? <ChipPick options={known} values={a.capabilities || []} onToggle={toggleCap} /> : null}
              {custom.length ? <CustomChips values={custom} onRemove={(c) => { a.capabilities = (a.capabilities || []).filter((x: string) => x !== c); touch(); }} /> : null}
            </div>
          );
        })}
        <CommaAdder placeholder="custom capability, e.g. k8s.deploy…" onAdd={(v) => { a.capabilities = [...new Set([...(a.capabilities || []), v])]; touch(); }} />
        <Button variant="linklike" onClick={() => setBulkCaps(!bulkCaps)}>{bulkCaps ? "hide bulk edit" : "bulk edit as text…"}</Button>
        {bulkCaps ? (
          <TextArea rows={2} aria-label="capabilities bulk edit" defaultValue={(a.capabilities || []).join(", ")} key={`caps-${cur}-${(a.capabilities || []).join(",")}`} onBlur={(e) => { a.capabilities = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); }} />
        ) : null}
        <Field label="can decide alone" hint="e.g. architecture.approve unlocks a gate">
          <Input defaultValue={(a.authority || []).join(", ")} key={`auth-${cur}-${(a.authority || []).join(",")}`} placeholder="architecture.approve, quality.block…"
            onBlur={(e) => { a.authority = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); touch(); }} />
        </Field>
      </Group>

      <Group id="communication" summary="Communication">
        <div className="field">
          <label>may message — who this agent can start threads with</label>
          {ids.filter((t) => t !== cur).length ? (
            <ChipPick options={ids.filter((t) => t !== cur)} values={[...contacts]} onToggle={(t) => ctx.toggleWire(cur, t)} />
          ) : <span className="muted tx-meta">no other agents yet.</span>}
        </div>
        <Field label="may be contacted by" hint="blank = anyone wired to it">
          <Input defaultValue={incoming.join(", ")} key={`inb-${cur}-${incoming.join(",")}`} placeholder="blank, or comma-separated agent ids"
            onBlur={(e) => {
              m.policies.communication[cur] ||= {};
              const l = e.target.value.split(",").map((x) => x.trim()).filter(Boolean);
              if (l.length) m.policies.communication[cur].may_be_contacted_by = l;
              else delete m.policies.communication[cur].may_be_contacted_by;
              touch();
            }} />
        </Field>
      </Group>

      <Group id="budget" summary="Budget">
        <div className="grid2">
          <Field label="token budget">
            <Input type="number" step={10000} value={a.budget?.tokens ?? 200000} onChange={(e) => setBudget("tokens", Number(e.target.value) || 0)} />
          </Field>
          <Num label="team budget override (budgets.agent)" value={m.budgets?.agent?.[cur]} onSet={(v) => {
            m.budgets.agent ||= {};
            if (v === null) delete m.budgets.agent[cur];
            else m.budgets.agent[cur] = v;
            touch();
          }} step={10000} hint="wins over the token budget left" />
          <Num label="agent time limit (min)" value={a.budget?.wall_clock_minutes} onSet={(v) => setBudget("wall_clock_minutes", v)} hint="default: mission cap" />
          <Num label="agent max events" value={a.budget?.max_events} onSet={(v) => setBudget("max_events", v)} hint="no limit" />
          <Num label="agent max activations" value={a.budget?.max_activations} onSet={(v) => setBudget("max_activations", v)} hint="no limit" />
        </div>
        {m.budgets?.agent?.[cur] !== undefined && a.budget?.tokens !== undefined && m.budgets.agent[cur] !== a.budget.tokens ? (
          <div className="verdict warn tx-value">both budgets are set — the override ({fmtNum(m.budgets.agent[cur])}) is what the runtime uses.</div>
        ) : null}
      </Group>

      <Group id="advanced" summary="Advanced">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="chk"><input type="checkbox" checked={a.session?.persistent !== false} onChange={(e) => { a.session = { ...(a.session || {}), persistent: e.target.checked }; touch(); }} /> remembers between turns</label>
          <label className="chk"><input type="checkbox" checked={!!a.delegation?.allow} onChange={(e) => { a.delegation = { ...(a.delegation || {}), allow: e.target.checked }; touch(); }} /> may spawn helpers</label>
        </div>
        <div className="grid2">
          <Num label="session max context tokens" value={a.session?.max_context_tokens} onSet={(v) => {
            a.session ||= {};
            if (v === null) delete a.session.max_context_tokens; else a.session.max_context_tokens = Math.round(v);
            touch();
          }} step={1000} hint="runtime default" />
          <Num label="helper workers ≤" value={a.delegation?.max_workers ?? 0} onSet={(v) => { a.delegation = { ...(a.delegation || {}), max_workers: v ?? 0 }; touch(); }} />
          <Num label="helper depth ≤" value={a.delegation?.max_depth ?? 0} onSet={(v) => { a.delegation = { ...(a.delegation || {}), max_depth: v ?? 0 }; touch(); }} />
          <Num label="helper budget tokens" value={a.delegation?.worker_budget_tokens} onSet={(v) => {
            a.delegation ||= {};
            if (v === null) delete a.delegation.worker_budget_tokens; else a.delegation.worker_budget_tokens = Math.round(v);
            touch();
          }} step={10000} hint="same as parent" />
        </div>
      </Group>
    </div>
  );
}