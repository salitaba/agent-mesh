/* Mesh inspector: whole-mesh settings — identity, goal, workspace, wake-up
 * strategy, done-when checklist, concurrency, triage, timeouts, server. */

import { Num, Field } from "../ui";
import { Button, ErrorState, Input, Select, TextArea } from "../../components";
import { setPath } from "../model";
import { useModelCatalogue } from "../modelCatalogue";
import { useMesh } from "../../store";
import type { DCtx } from "../types";

export default function MeshPanel({ ctx }: { ctx: DCtx }): React.JSX.Element {
  const { m, touch, ids } = ctx;
  const { client } = useMesh();
  const { state: catalogue, reload: reloadModels } = useModelCatalogue(client);
  const crit = (m.mesh.acceptance_criteria ||= []);
  const triage = m.scheduling.triage || { mode: "off" };
  const rules: any[] = (triage.rules ||= []);
  const knownModels = new Set<string>(catalogue.phase === "ready" ? catalogue.catalogue.models : []);
  const savedModel = typeof m.mesh.runtime?.model === "string" ? m.mesh.runtime.model.trim() : "";
  const modelOptions = savedModel && !knownModels.has(savedModel) ? [savedModel, ...knownModels] : [...knownModels];
  return (
    <div className="ms-panel">
      <div className="grid2">
        <Field label="mesh id"><Input value={m.mesh.id} onChange={(e) => { setPath(m, "mesh.id", e.target.value); touch(); }} /></Field>
        <Field label="display name"><Input value={m.mesh.name || ""} onChange={(e) => { setPath(m, "mesh.name", e.target.value); touch(); }} /></Field>
      </div>
      <Field label="goal">
        <TextArea rows={3} value={m.mesh.goal || ""} onChange={(e) => { setPath(m, "mesh.goal", e.target.value); touch(); }} />
      </Field>
      <Field label="workspace path" span><Input value={m.mesh.workspace?.path || "./workspace"} onChange={(e) => { setPath(m, "mesh.workspace.path", e.target.value); touch(); }} /></Field>
      <div className="grid3">
        <Field label="default runtime">
          <Select value={m.mesh.runtime?.default || "stub"} onChange={(e) => { setPath(m, "mesh.runtime.default", e.target.value); touch(); }}>
            <option>opencode</option><option>stub</option><option>http</option>
          </Select>
        </Field>
        <Field label="default model" hint="used by agents with no model of their own">
          {catalogue.phase === "error" ? (
            <ErrorState what="the model list" detail={catalogue.detail} onRetry={reloadModels} />
          ) : (
            <Select
              value={savedModel}
              disabled={catalogue.phase === "loading"}
              aria-label="mesh default model"
              onChange={(e) => {
                const v = e.target.value;
                m.mesh.runtime ||= {};
                if (v) m.mesh.runtime.model = v;
                else delete m.mesh.runtime.model;
                touch();
              }}
            >
              <option value="">{catalogue.phase === "loading" ? "loading models…" : `backend default${catalogue.catalogue.default ? ` (${catalogue.catalogue.default})` : ""}`}</option>
              {/* A model already saved in mesh.yaml but absent from this
                * installation's catalogue still belongs in the list — dropping
                * it would silently rewrite the config on the next save. */}
              {modelOptions.map((id) => (
                <option key={id} value={id}>{id}{knownModels.has(id) ? "" : " — not installed here"}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="how agents wake up">
          <Select value={m.scheduling?.activation?.strategy || "interest"} onChange={(e) => { setPath(m, "scheduling.activation.strategy", e.target.value); touch(); }}>
            <option value="interest">on matching events</option>
            <option value="interest+triage">events + a router pass</option>
          </Select>
        </Field>
      </div>

      <div className="field">
        <label>done-when checklist ({crit.length ? `${crit.length} criteria` : "the five default checks"})</label>
        {crit.map((c: any, i: number) => (
          <div className="row-edit" key={i}>
            <Input value={c.id} aria-label="criterion id" onChange={(e) => { c.id = e.target.value; touch(); }} />
            <Input value={c.description} aria-label="criterion description" onChange={(e) => { c.description = e.target.value; touch(); }} />
            <label className="chk"><input type="checkbox" checked={c.mandatory !== false} onChange={(e) => { c.mandatory = e.target.checked; touch(); }} /> must</label>
            <Button variant="small" danger aria-label="remove criterion" onClick={() => { crit.splice(i, 1); touch(); }}>remove</Button>
          </div>
        ))}
        <Button variant="small" onClick={() => { crit.push({ id: `criterion-${crit.length + 1}`, description: "", mandatory: true }); touch(); }}>+ check</Button>
      </div>

      <div className="ms-h">Concurrency</div>
      <div className="grid3">
        <Num label="peers at once" value={m.scheduling?.concurrency?.max_active_agents ?? 4} onSet={(v) => setPath(m, "scheduling.concurrency.max_active_agents", v ?? 1)} />
        <Num label="services at once" value={m.scheduling?.concurrency?.max_parallel_service_agents} onSet={(v) => {
          m.scheduling.concurrency ||= {};
          if (v === null) delete m.scheduling.concurrency.max_parallel_service_agents; else m.scheduling.concurrency.max_parallel_service_agents = v;
          touch();
        }} hint="default 2" />
        <Num label="total turns at once" value={m.scheduling?.concurrency?.max_total_agents} onSet={(v) => {
          m.scheduling.concurrency ||= {};
          if (v === null) delete m.scheduling.concurrency.max_total_agents; else m.scheduling.concurrency.max_total_agents = v;
          touch();
        }} hint="peers + services" />
      </div>
      <Num label="max activation delay (ms)" value={m.scheduling?.activation?.max_activation_delay_ms} span onSet={(v) => {
        m.scheduling.activation ||= {};
        if (v === null) delete m.scheduling.activation.max_activation_delay_ms; else m.scheduling.activation.max_activation_delay_ms = v;
        touch();
      }} hint="0 = instant" />

      <div className="ms-h">Triage — the cheap pre-filter before waking peers</div>
      <Field label="triage mode">
        <Select value={triage.mode || "off"} onChange={(e) => { setPath(m, "scheduling.triage.mode", e.target.value === "off" ? "off" : "heuristic"); touch(); }}>
          <option value="off">off — every matching event wakes its agent</option>
          <option value="heuristic">heuristic — rules can veto wakes</option>
        </Select>
      </Field>
      {rules.map((r: any, i: number) => (
        <div className="ms-trule" key={i}>
          <div className="row">
            <Select value={r.agent || ""} aria-label="triage rule agent" onChange={(e) => { r.agent = e.target.value; touch(); }}>
              <option value="">(pick agent)…</option>
              {ids.map((id) => <option key={id}>{id}</option>)}
            </Select>
            <Input value={r.event || ""} list="d-etypes" placeholder="event (optional, e.g. dependency.changed)" aria-label="triage rule event" onChange={(e) => { if (e.target.value) r.event = e.target.value; else delete r.event; touch(); }} />
            <Button variant="small" danger aria-label="remove triage rule" onClick={() => { rules.splice(i, 1); touch(); }}>×</Button>
          </div>
          <Input defaultValue={(r.ignore_if_text_matches || []).join(", ")} key={`ign-${i}-${(r.ignore_if_text_matches || []).join(",")}`} placeholder="ignore if text matches (comma-separated)" aria-label="triage ignore patterns"
            onBlur={(e) => { const l = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); if (l.length) r.ignore_if_text_matches = l; else delete r.ignore_if_text_matches; touch(); }} />
          <Input defaultValue={(r.act_if_text_matches || []).join(", ")} key={`act-${i}-${(r.act_if_text_matches || []).join(",")}`} placeholder="act if text matches (comma-separated)" aria-label="triage act patterns"
            onBlur={(e) => { const l = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); if (l.length) r.act_if_text_matches = l; else delete r.act_if_text_matches; touch(); }} />
        </div>
      ))}
      <datalist id="d-etypes">{(ctx.vocab?.eventTypes || []).map((t: string) => <option key={t}>{t}</option>)}</datalist>
      <Button variant="small" onClick={() => { rules.push({ agent: ids[0] || "" }); touch(); }}>+ triage rule</Button>

      <div className="ms-h">Turn timeouts</div>
      <div className="grid2">
        <Num label="turn timeout (ms)" value={m.scheduling?.timeouts?.turn_timeout_ms} onSet={(v) => setTimeoutVal(m, "turn_timeout_ms", v, touch)} hint="600000" />
        <Num label="wait wakeup (ms)" value={m.scheduling?.timeouts?.wait_wakeup_ms} onSet={(v) => setTimeoutVal(m, "wait_wakeup_ms", v, touch)} hint="60000" />
        <Num label="file lease TTL (ms)" value={m.scheduling?.timeouts?.lease_ttl_ms} onSet={(v) => setTimeoutVal(m, "lease_ttl_ms", v, touch)} hint="1800000" />
        <Num label="idle quiet period (ms)" value={m.scheduling?.timeouts?.idle_quiet_period_ms} onSet={(v) => setTimeoutVal(m, "idle_quiet_period_ms", v, touch)} hint="30000" />
      </div>

      <div className="ms-h">Server</div>
      <div className="grid2">
        <Field label="host"><Input value={m.server?.host || ""} placeholder="127.0.0.1" onChange={(e) => { const v = e.target.value.trim(); if (v) setPath(m, "server.host", v); else delete (m.server || {}).host; touch(); }} /></Field>
        <Field label="port"><Input type="number" value={m.server?.port ?? 7420} onChange={(e) => { setPath(m, "server.port", Number(e.target.value) || 0); touch(); }} /></Field>
        <Field label="state dir" span><Input value={m.server?.state_dir || ""} placeholder="workspace/.mesh-state" onChange={(e) => { const v = e.target.value.trim(); if (v) setPath(m, "server.state_dir", v); else delete (m.server || {}).state_dir; touch(); }} /></Field>
      </div>
      <label className="chk"><input type="checkbox" checked={m.server?.dashboard !== false} onChange={(e) => { setPath(m, "server.dashboard", e.target.checked); touch(); }} /> serve this dashboard</label>
    </div>
  );
}

function setTimeoutVal(m: any, key: string, v: number | null, touch: () => void): void {
  m.scheduling ||= {};
  m.scheduling.timeouts ||= {};
  if (v === null) delete m.scheduling.timeouts[key];
  else m.scheduling.timeouts[key] = v;
  touch();
}