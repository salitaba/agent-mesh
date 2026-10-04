/* Mesh inspector: whole-mesh settings — identity, goal, done-when checks, runtime, seat defaults, concurrency, triage, timeouts, server.
 * Each is a section the validation jump can open. */

import { useRef } from "react";
import { Field, Num, Section } from "../ui";
import { Button, ErrorState, Input, Select, TextArea } from "../../components";
import { GOAL_MAX, goalIsPlaceholder, setPath } from "../model";
import { useModelCatalogue, variantsFor } from "../modelCatalogue";
import { useMesh } from "../../store";
import type { DCtx } from "../types";

/* Runtime adapters the server's composition root registers. Kept in sync by
 * hand: the config layer accepts any string, so a name missing here is not a
 * validation failure — it just becomes unreachable from the designer. */
const RUNTIMES = ["opencode", "claude", "stub", "http"];

export default function MeshPanel({ ctx }: { ctx: DCtx }): React.JSX.Element {
  const { m, touch, ids, reveal } = ctx;
  const { client } = useMesh();
  const { state: catalogue, reload: reloadModels } = useModelCatalogue(client);
  /* Rows are spliceable and their visible fields are edited in place; a stable
   * identity per object keeps React from remounting the row being typed into. */
  const keySeq = useRef(0);
  const rowKeys = useRef(new WeakMap<object, string>());
  const rowKey = (o: object): string => {
    let k = rowKeys.current.get(o);
    if (!k) {
      k = `ms-row-${++keySeq.current}`;
      rowKeys.current.set(o, k);
    }
    return k;
  };
  const crit = (m.mesh.acceptance_criteria ||= []);
  const triage = m.scheduling.triage || { mode: "off" };
  const rules: any[] = (triage.rules ||= []);
  /* A mesh.yaml naming a runtime outside RUNTIMES (a custom adapter) still
   * belongs in the list — dropping it would leave the control with nothing
   * selected and rewrite the config on the next edit. */
  const savedRuntime = typeof m.mesh.runtime?.default === "string" ? m.mesh.runtime.default.trim() : "";
  const runtimeOptions = savedRuntime && !RUNTIMES.includes(savedRuntime) ? [savedRuntime, ...RUNTIMES] : RUNTIMES;
  const knownModels = new Set<string>(catalogue.phase === "ready" ? catalogue.catalogue.models : []);
  const savedModel = typeof m.mesh.runtime?.model === "string" ? m.mesh.runtime.model.trim() : "";
  const modelOptions = savedModel && !knownModels.has(savedModel) ? [savedModel, ...knownModels] : [...knownModels];
  const savedVariant = typeof m.mesh.runtime?.variant === "string" ? m.mesh.runtime.variant.trim() : "";
  /* Variants are a property of the model that will actually run, so when the
   * mesh leaves the model blank they belong to the catalogue's backend default. */
  const effectiveModel = savedModel || (catalogue.phase === "ready" ? catalogue.catalogue.default ?? "" : "");
  const modelVariants = catalogue.phase === "ready" ? variantsFor(catalogue.catalogue, effectiveModel) : [];
  const variantOptions = savedVariant && !modelVariants.includes(savedVariant) ? [savedVariant, ...modelVariants] : modelVariants;
  const variantHint = catalogue.phase === "ready" && effectiveModel && modelVariants.length === 0
    ? "This model has no thinking variants."
    : "Blank uses the model's default.";
  const goal = String(m.mesh.goal || "");

  return (
    <div className="ms-panel">
      <Section id="identity" title="Identity" reveal={reveal}>
        <div className="grid2">
          <Field label="Mesh id" name="id"><Input mono value={m.mesh.id || ""} onChange={(e) => { setPath(m, "mesh.id", e.target.value); touch(); }} /></Field>
          <Field label="Display name" name="name"><Input value={m.mesh.name || ""} onChange={(e) => { setPath(m, "mesh.name", e.target.value); touch(); }} /></Field>
        </div>
        <Field label="Workspace folder" name="workspace" hint="Where the seats write the product, relative to mesh.yaml.">
          <Input mono value={m.mesh.workspace?.path || "./workspace"} onChange={(e) => { setPath(m, "mesh.workspace.path", e.target.value); touch(); }} />
        </Field>
      </Section>

      <Section id="goal" title="Goal" meta={goalIsPlaceholder(goal) ? "not written yet" : undefined} reveal={reveal}>
        <Field
          label="What the team is for" name="goal"
          hint={goalIsPlaceholder(goal) ? "This is still the placeholder. Write what the team should deliver." : `${goal.length.toLocaleString("en-US")} of ${GOAL_MAX.toLocaleString("en-US")} characters.`}
        >
          <TextArea rows={4} maxLength={GOAL_MAX} value={goal} onChange={(e) => { setPath(m, "mesh.goal", e.target.value); touch(); }} />
        </Field>
      </Section>

      <Section id="criteria" title="Done-when checks" meta={crit.length ? `${crit.length}` : "defaults"} reveal={reveal}>
        <p className="ms-hint">The mission is finished when every mandatory check is evidenced. {crit.length ? "" : "With none listed, the five default checks apply."}</p>
        {crit.map((c: any, i: number) => (
          <div className="ms-crit" key={rowKey(c)}>
            <Input mono value={c.id} aria-label="Check id" placeholder="check-id" onChange={(e) => { c.id = e.target.value; touch(); }} />
            <Input value={c.description} aria-label="Check description" placeholder="What has to be true" onChange={(e) => { c.description = e.target.value; touch(); }} />
            <div className="ms-crit-foot">
              <label className="chk"><input type="checkbox" checked={c.mandatory !== false} onChange={(e) => { c.mandatory = e.target.checked; touch(); }} /> Must pass</label>
              <Button variant="small" danger icon="trash" aria-label={`Remove the check ${c.id || ""}`} onClick={() => { crit.splice(i, 1); touch("Removed a check"); }}>Remove</Button>
            </div>
          </div>
        ))}
        <Button variant="small" icon="plus" onClick={() => { crit.push({ id: `check-${crit.length + 1}`, description: "", mandatory: true }); touch("Added a check"); }}>Add a check</Button>
      </Section>

      <Section id="runtime" title="Runtime" meta={savedRuntime || "stub"} defaultOpen={false} reveal={reveal}>
        <div className="grid2">
          <Field label="Default runtime" name="runtime">
            <Select value={savedRuntime || "stub"} onChange={(e) => { setPath(m, "mesh.runtime.default", e.target.value); touch(); }}>
              {runtimeOptions.map((r) => <option key={r} value={r}>{r}</option>)}
            </Select>
          </Field>
          <Field label="Default model" name="model" hint="Used by seats with no model of their own.">
            {catalogue.phase === "error" ? (
              <ErrorState what="the model list" detail={catalogue.detail} onRetry={reloadModels} />
            ) : (
              <Select
                value={savedModel} disabled={catalogue.phase === "loading"} aria-label="Default model"
                onChange={(e) => {
                  const v = e.target.value;
                  m.mesh.runtime ||= {};
                  if (v) m.mesh.runtime.model = v;
                  else delete m.mesh.runtime.model;
                  touch();
                }}
              >
                <option value="">{catalogue.phase === "loading" ? "Loading models…" : `Backend default${catalogue.catalogue.default ? ` (${catalogue.catalogue.default})` : ""}`}</option>
                {/* A model already saved in mesh.yaml but absent from this installation's catalogue still belongs in the list:
                    dropping it would rewrite the config on the next save. */}
                {modelOptions.map((id) => (
                  <option key={id} value={id}>{id}{knownModels.has(id) ? "" : " (not installed here)"}</option>
                ))}
              </Select>
            )}
          </Field>
          {variantOptions.length ? (
            <Field label="Default thinking variant" name="variant" hint={variantHint}>
              <Select
                value={savedVariant} disabled={catalogue.phase === "loading"} aria-label="Default thinking variant"
                onChange={(e) => {
                  const v = e.target.value;
                  m.mesh.runtime ||= {};
                  if (v) m.mesh.runtime.variant = v;
                  else delete m.mesh.runtime.variant;
                  touch();
                }}
              >
                <option value="">Model default</option>
                {/* A variant already saved in mesh.yaml but absent from the selected model still belongs in the list. */}
                {variantOptions.map((v) => (
                  <option key={v} value={v}>{v}{modelVariants.includes(v) ? "" : " (not available for this model)"}</option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </Section>

      <Section id="defaults" title="Seat defaults" defaultOpen={false} reveal={reveal}>
        <p className="ms-hint">Every seat inherits these unless it sets its own.</p>
        <div className="grid2">
          <Field label="Seats remember between turns">
            <Select value={triState(m.mesh.defaults?.session?.persistent)} onChange={(e) => setDefault(m, "session", "persistent", triParse(e.target.value), touch)}>
              <option value="">Runtime default (yes)</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Field label="Seats may spawn helpers">
            <Select value={triState(m.mesh.defaults?.delegation?.allow)} onChange={(e) => setDefault(m, "delegation", "allow", triParse(e.target.value), touch)}>
              <option value="">Runtime default (no)</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Num label="Session context tokens" value={m.mesh.defaults?.session?.max_context_tokens} step={1000} hint="Not enforced yet"
            onSet={(v) => setDefault(m, "session", "max_context_tokens", v === null ? undefined : Math.round(v), touch)} />
          <Num label="Helper workers, at most" value={m.mesh.defaults?.delegation?.max_workers} hint="0"
            onSet={(v) => setDefault(m, "delegation", "max_workers", v === null ? undefined : Math.round(v), touch)} />
          <Num label="Helper depth, at most" value={m.mesh.defaults?.delegation?.max_depth} hint="0"
            onSet={(v) => setDefault(m, "delegation", "max_depth", v === null ? undefined : Math.round(v), touch)} />
          <Num label="Helper budget tokens" value={m.mesh.defaults?.delegation?.worker_budget_tokens} step={10000} hint="Same as the parent"
            onSet={(v) => setDefault(m, "delegation", "worker_budget_tokens", v === null ? undefined : Math.round(v), touch)} />
        </div>
      </Section>

      <Section id="concurrency" title="Concurrency" defaultOpen={false} reveal={reveal}>
        <div className="grid3">
          <Num label="Peers at once" value={m.scheduling?.concurrency?.max_active_agents ?? 4} onSet={(v) => { setPath(m, "scheduling.concurrency.max_active_agents", v ?? 1); touch(); }} />
          <Num label="Services at once" value={m.scheduling?.concurrency?.max_parallel_service_agents} onSet={(v) => {
            m.scheduling.concurrency ||= {};
            if (v === null) delete m.scheduling.concurrency.max_parallel_service_agents; else m.scheduling.concurrency.max_parallel_service_agents = v;
            touch();
          }} hint="Default 2" />
          <Num label="Turns at once, in all" value={m.scheduling?.concurrency?.max_total_agents} onSet={(v) => {
            m.scheduling.concurrency ||= {};
            if (v === null) delete m.scheduling.concurrency.max_total_agents; else m.scheduling.concurrency.max_total_agents = v;
            touch();
          }} hint="Peers plus services" />
        </div>
      </Section>

      <Section id="triage" title="Triage" meta={triage.mode === "heuristic" ? "heuristic" : "off"} defaultOpen={false} reveal={reveal}>
        <p className="ms-hint">A cheap filter that runs before a seat is woken, and can veto the wake.</p>
        <Field label="Triage mode" name="mode">
          <Select value={triage.mode || "off"} onChange={(e) => { setPath(m, "scheduling.triage.mode", e.target.value === "off" ? "off" : "heuristic"); touch(); }}>
            <option value="off">Off: every matching event wakes its seat</option>
            <option value="heuristic">Heuristic: rules can veto a wake</option>
          </Select>
        </Field>
        {rules.map((r: any, i: number) => (
          <div className="ms-trule" key={rowKey(r)}>
            <div className="row">
              <Select value={r.agent || ""} aria-label="Triage rule seat" onChange={(e) => { r.agent = e.target.value; touch(); }}>
                <option value="">Pick a seat</option>
                {ids.map((id) => <option key={id}>{id}</option>)}
              </Select>
              <Button variant="small" danger icon="trash" aria-label="Remove this triage rule" onClick={() => { rules.splice(i, 1); touch("Removed a triage rule"); }}>Remove</Button>
            </div>
            <Input value={r.event || ""} list="d-etypes" placeholder="Event (optional), for example dependency.changed" aria-label="Triage rule event" onChange={(e) => { if (e.target.value) r.event = e.target.value; else delete r.event; touch(); }} />
            <Input defaultValue={(r.ignore_if_text_matches || []).join(", ")} key={`ign-${rowKey(r)}`} placeholder="Ignore if the text matches (comma separated)" aria-label="Triage ignore patterns"
              onBlur={(e) => { const l = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); if (l.length) r.ignore_if_text_matches = l; else delete r.ignore_if_text_matches; touch(); }} />
            <Input defaultValue={(r.act_if_text_matches || []).join(", ")} key={`act-${rowKey(r)}`} placeholder="Act if the text matches (comma separated)" aria-label="Triage act patterns"
              onBlur={(e) => { const l = e.target.value.split(",").map((x) => x.trim()).filter(Boolean); if (l.length) r.act_if_text_matches = l; else delete r.act_if_text_matches; touch(); }} />
          </div>
        ))}
        <datalist id="d-etypes">{(ctx.vocab?.eventTypes || []).map((t: string) => <option key={t}>{t}</option>)}</datalist>
        <Button variant="small" icon="plus" onClick={() => { rules.push({ agent: ids[0] || "" }); touch("Added a triage rule"); }}>Add a triage rule</Button>
      </Section>

      <Section id="timeouts" title="Turn timeouts" defaultOpen={false} reveal={reveal}>
        <div className="grid2">
          <Num label="Turn timeout (ms)" value={m.scheduling?.timeouts?.turn_timeout_ms} onSet={(v) => setTimeoutVal(m, "turn_timeout_ms", v, touch)} hint="600000" />
          <Num label="Wait wake-up (ms)" value={m.scheduling?.timeouts?.wait_wakeup_ms} onSet={(v) => setTimeoutVal(m, "wait_wakeup_ms", v, touch)} hint="60000" />
          <Num label="File lease (ms)" value={m.scheduling?.timeouts?.lease_ttl_ms} onSet={(v) => setTimeoutVal(m, "lease_ttl_ms", v, touch)} hint="1800000" />
          <Num label="Idle quiet period (ms)" value={m.scheduling?.timeouts?.idle_quiet_period_ms} onSet={(v) => setTimeoutVal(m, "idle_quiet_period_ms", v, touch)} hint="30000" />
        </div>
      </Section>

      <Section id="server" title="Server" defaultOpen={false} reveal={reveal}>
        <p className="ms-hint">These apply when the mesh runs on its own (<span className="mono">curule run</span> or <span className="mono">curule console</span>). A host starts each project on a port of its own and ignores them.</p>
        <div className="grid2">
          <Field label="Host"><Input value={m.server?.host || ""} placeholder="127.0.0.1" onChange={(e) => { const v = e.target.value.trim(); if (v) setPath(m, "server.host", v); else delete (m.server || {}).host; touch(); }} /></Field>
          <Field label="Port"><Input type="number" value={m.server?.port ?? 7420} onChange={(e) => { setPath(m, "server.port", Number(e.target.value) || 0); touch(); }} /></Field>
          <Field label="State folder" span><Input mono value={m.server?.state_dir || ""} placeholder="workspace/.mesh-state" onChange={(e) => { const v = e.target.value.trim(); if (v) setPath(m, "server.state_dir", v); else delete (m.server || {}).state_dir; touch(); }} /></Field>
        </div>
        <label className="chk"><input type="checkbox" checked={m.server?.dashboard !== false} onChange={(e) => { setPath(m, "server.dashboard", e.target.checked); touch(); }} /> Serve this dashboard</label>
      </Section>
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

/* mesh.defaults is only written while it still holds something: clearing the
 * last key has to take the empty containers with it, or a mesh that sets no
 * defaults would start saving a block it never had. */
function setDefault(m: any, group: "session" | "delegation", key: string, v: number | boolean | undefined, touch: () => void): void {
  const d = (m.mesh.defaults ||= {});
  const g = (d[group] ||= {});
  if (v === undefined) delete g[key];
  else g[key] = v;
  if (!Object.keys(g).length) delete d[group];
  if (!Object.keys(d).length) delete m.mesh.defaults;
  touch();
}

/* A mesh default is inherited by being ABSENT, so the booleans need a third
 * state the checkbox they replace could not express. */
const triState = (v: unknown): string => (v === true ? "yes" : v === false ? "no" : "");
const triParse = (s: string): boolean | undefined => (s === "yes" ? true : s === "no" ? false : undefined);
