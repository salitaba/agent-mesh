/* Seat inspector: everything about one seat — who it is, what it may use and decide, who it may message, what wakes it, what it may spend.
 * Mutates `ctx.m` in place and calls `ctx.touch()` after each change.
 *
 * What changed from the old crew panel, and why:
 *  - Authority is a grid over the protocol's catalogue, not a text box that accepts a typo and grants nothing.
 *  - "May be contacted by" is an additive grant (the runtime allows a contact when either side names the other), so it is a second chip
 *    list with a sentence that says so, not a box whose hint ("blank = anyone wired to it") described a filter that does not exist.
 *  - A seat's own time limit and event limit are accepted by the config and enforced by nothing (docs/configuration.md); they are shown
 *    only when a file already sets them, with that said, instead of offered as controls.
 *  - Typing a space in the role no longer deletes it (the old handler trimmed on every keystroke, so "tech lead" could not be typed). */

import { useState } from "react";
import { AUTHORITY, CAPS, fmtNum, groupCaps } from "../model";
import { seatIdProblem, type IdProblem } from "../edits";
import { AuthorityGrid, ChipPick, CommaAdder, CustomChips, Field, Num, Section } from "../ui";
import { AgentAvatar, agentColor, Button, ErrorState, Input, Select, TextArea } from "../../components";
import { useModelCatalogue, variantsFor } from "../modelCatalogue";
import { useMesh } from "../../store";
import type { DCtx } from "../types";

const ID_PROBLEM: Record<IdProblem, string> = {
  empty: "A seat needs an id.",
  taken: "Another seat already has that id.",
  shape: "Use lowercase letters, digits and hyphens, starting with a letter or digit.",
};

/** The seat's id, editable. Renaming rewrites every place the old id is named, so it commits on Enter or when the field loses focus, not on each key. */
function SeatIdField({ ctx, id }: { ctx: DCtx; id: string }): React.JSX.Element {
  const [draft, setDraft] = useState(id);
  const [problem, setProblem] = useState<IdProblem | null>(null);
  const commit = (): void => {
    const next = draft.trim();
    if (next === id) { setProblem(null); setDraft(id); return; }
    const p = seatIdProblem(ctx.m, id, next);
    setProblem(p);
    if (p) return;
    ctx.renameSeat(id, next);
  };
  return (
    <Field label="Seat id" name="id" hint="Gates, wires and budgets refer to this id. Renaming updates them." error={problem ? ID_PROBLEM[problem] : undefined}>
      <Input
        mono value={draft} spellCheck={false}
        onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape" && draft !== id) { e.preventDefault(); setDraft(id); setProblem(null); } }}
      />
    </Field>
  );
}

export default function CrewPanel({ ctx }: { ctx: DCtx }): React.JSX.Element {
  const { m, cur, ids, ints, touch, starts, reveal, wires } = ctx;
  const { client } = useMesh();
  const [intFilter, setIntFilter] = useState("");
  const [bulkCaps, setBulkCaps] = useState(false);
  const [bulkInts, setBulkInts] = useState(false);
  const { state: models, reload: reloadModels } = useModelCatalogue(client);

  if (!cur || !m.agents[cur]) {
    return (
      <div className="ms-nosel">
        <p className="ms-lead">{ids.length ? "Select a seat on the canvas to edit it, or pick one here." : "There are no seats yet."}</p>
        {ids.length ? (
          <ul className="ms-pick">
            {ids.map((id) => (
              <li key={id}>
                <button type="button" onClick={() => ctx.openSeat(id)}>
                  <AgentAvatar id={id} color={agentColor(String(m.agents[id]?.role || ""))} size="sm" />
                  <span className="nm">{id}</span>
                  <span className="muted">{m.agents[id]?.role || "no role"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <Button variant="small" icon="plus" onClick={() => ctx.addSeat()}>Add a seat</Button>
      </div>
    );
  }
  const a = m.agents[cur];
  const set = (k: string, v: any) => {
    if (v === "" || v === null || v === undefined) delete a[k];
    else a[k] = v;
    touch();
  };
  /** Text fields keep what is typed, spaces included, and tidy it when the field is left. */
  const text = (k: string) => ({
    value: a[k] || "",
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value),
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => { if (e.target.value !== e.target.value.trim()) set(k, e.target.value.trim()); },
  });
  const setBudget = (k: string, v: number | null) => {
    a.budget ||= {};
    if (v === null || !Number.isFinite(v)) delete a.budget[k];
    else a.budget[k] = v;
    touch();
  };
  const toggleCap = (c: string) => {
    const l = new Set<string>(a.capabilities || []);
    if (l.has(c)) l.delete(c); else l.add(c);
    a.capabilities = [...l];
    touch("Edited tools");
  };
  const toggleAuthority = (t: string) => {
    const l = new Set<string>(a.authority || []);
    if (l.has(t)) l.delete(t); else l.add(t);
    a.authority = [...l];
    touch("Edited authority");
  };
  const csv = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);

  const others = ids.filter((t) => t !== cur);
  const contacts = (m.policies.communication[cur]?.may_contact || []) as string[];
  const grants = (m.policies.communication[cur]?.may_be_contacted_by || []) as string[];
  const incoming = wires.filter((w) => w.tgt === cur && w.declared).map((w) => w.src);
  const customCaps = (a.capabilities || []).filter((c: string) => !CAPS.includes(c));
  const capBuckets = groupCaps([...CAPS, ...customCaps]);

  const knownModels = new Set<string>(models.phase === "ready" ? models.catalogue.models : []);
  const saved = typeof a.model === "string" ? a.model.trim() : "";
  const modelOptions = saved && !knownModels.has(saved) ? [saved, ...knownModels] : [...knownModels];
  const modelHint = models.phase === "ready" && saved && !knownModels.has(saved)
    ? "This model is not installed here. Turns will fail until it is."
    : "Blank uses the mesh default.";
  const meshModel = typeof m.mesh.runtime?.model === "string" ? m.mesh.runtime.model.trim() : "";
  const meshVariant = typeof m.mesh.runtime?.variant === "string" ? m.mesh.runtime.variant.trim() : "";
  const savedVariant = typeof a.variant === "string" ? a.variant.trim() : "";
  // The variants on offer belong to the model this seat will run: its own, else the mesh default, else the backend default.
  const effectiveModel = saved || meshModel || (models.phase === "ready" ? models.catalogue.default ?? "" : "");
  const modelVariants = models.phase === "ready" ? variantsFor(models.catalogue, effectiveModel) : [];
  const variantOptions = savedVariant && !modelVariants.includes(savedVariant) ? [savedVariant, ...modelVariants] : modelVariants;
  const variantHint = models.phase === "ready" && effectiveModel && modelVariants.length === 0
    ? "This model has no thinking variants."
    : "Blank uses the mesh default.";
  // Mesh-wide defaults this seat inherits when its own key is absent: per-seat, then mesh.defaults, then the runtime's fallback.
  const meshSession = m.mesh?.defaults?.session || {};
  const meshDelegation = m.mesh?.defaults?.delegation || {};
  const inheritedPersistent = meshSession.persistent ?? true;
  const inheritedAllow = meshDelegation.allow ?? false;
  const numHint = (v: unknown, fallback: string) => (typeof v === "number" ? `mesh default (${v})` : fallback);
  const triValue = (v: unknown) => (v === undefined ? "" : v ? "yes" : "no");
  const inertSet = a.budget?.wall_clock_minutes !== undefined || a.budget?.max_events !== undefined;
  const override = m.budgets?.agent?.[cur];

  return (
    <div className="ms-panel">
      <div className="ms-seat-head">
        <AgentAvatar id={cur} color={agentColor(String(a.role || ""))} />
        <div className="ms-seat-id">
          <b className="mono" title={cur}>{cur}</b>
          <span className="muted" title={a.role || undefined}>{a.role || "no role"}</span>
        </div>
        <div className="ms-seat-acts">
          <Button variant="small" icon="copy" onClick={() => ctx.duplicateSeat()}>Duplicate</Button>
          <Button variant="small" danger icon="trash" onClick={() => ctx.deleteSeat()}>Delete</Button>
        </div>
      </div>

      <Section id="general" title="General" reveal={reveal}>
        <SeatIdField key={cur} ctx={ctx} id={cur} />
        <Field label="Role" name="role" hint="What this seat is for. A gate or a policy rule can name a role instead of a seat.">
          <Input {...text("role")} />
        </Field>
        <label className="chk ms-start">
          <input type="checkbox" data-field="start" checked={starts.has(cur)} onChange={() => ctx.toggleStart(cur)} />
          <span>Starts with the mission</span>
        </label>
        <Field label="Mode" name="mode">
          <Select value={a.mode === "service" ? "service" : "peer"} onChange={(e) => set("mode", e.target.value === "service" ? "service" : "")}>
            <option value="peer">Peer: wakes on events</option>
            <option value="service">Service: answers requests</option>
          </Select>
        </Field>
        <div className="grid2">
          <Field label="Runtime" name="runtime" hint="Blank uses the mesh default.">
            <Input {...text("runtime")} placeholder={m.mesh.runtime?.default || "mesh default"} />
          </Field>
          <Field label="Model" name="model" hint={modelHint}>
            {models.phase === "error" ? (
              <ErrorState what="the model list" detail={models.detail} onRetry={reloadModels} />
            ) : (
              <Select value={a.model || ""} disabled={models.phase === "loading"} aria-label="Model" onChange={(e) => set("model", e.target.value)}>
                <option value="">{models.phase === "loading" ? "Loading models…" : `Mesh default${models.catalogue.default ? ` (${models.catalogue.default})` : ""}`}</option>
                {/* A model already saved in mesh.yaml but absent from this installation's catalogue still belongs in the list:
                    dropping it would rewrite the config on the next save. */}
                {modelOptions.map((id) => (
                  <option key={id} value={id}>{id}{knownModels.has(id) ? "" : " (not installed here)"}</option>
                ))}
              </Select>
            )}
          </Field>
          {variantOptions.length ? (
            <Field label="Thinking variant" name="variant" hint={variantHint}>
              <Select value={savedVariant} disabled={models.phase === "loading"} aria-label="Thinking variant" onChange={(e) => set("variant", e.target.value)}>
                <option value="">Mesh default{meshVariant ? ` (${meshVariant})` : ""}</option>
                {variantOptions.map((v) => (
                  <option key={v} value={v}>{v}{modelVariants.includes(v) ? "" : " (not available for this model)"}</option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </Section>

      <Section id="tools" title="Tools and authority" meta={`${(a.capabilities || []).length} tools, ${(a.authority || []).length} authority`} reveal={reveal}>
        <div className="field">
          <span className="ms-flabel" id="ms-tools-label">Tools: what this seat may do in the workspace</span>
          {capBuckets.map(({ group, caps }) => {
            const known = caps.filter((c) => CAPS.includes(c));
            const custom = caps.filter((c) => !CAPS.includes(c));
            return (
              <div className="ms-cap-group" key={group}>
                <span className="ms-cap-name">{group}</span>
                {known.length ? <ChipPick options={known} values={a.capabilities || []} onToggle={toggleCap} label={group} /> : null}
                {custom.length ? <CustomChips values={custom} onRemove={(c) => { a.capabilities = (a.capabilities || []).filter((x: string) => x !== c); touch("Edited tools"); }} /> : null}
              </div>
            );
          })}
          <CommaAdder placeholder="Add a custom tool, for example k8s.deploy" onAdd={(v) => { a.capabilities = [...new Set([...(a.capabilities || []), v])]; touch("Edited tools"); }} />
          <Button variant="linklike" onClick={() => setBulkCaps(!bulkCaps)}>{bulkCaps ? "Hide the text editor" : "Edit as text"}</Button>
          {bulkCaps ? (
            <TextArea rows={2} aria-label="Tools, comma separated" defaultValue={(a.capabilities || []).join(", ")} key={`caps-${cur}-${(a.capabilities || []).join(",")}`} onBlur={(e) => { a.capabilities = csv(e.target.value); touch("Edited tools"); }} />
          ) : null}
        </div>
        <div className="field" data-field="authority">
          <span className="ms-flabel">Authority: what this seat may decide alone</span>
          <span className="ms-hint">A gate that requires an approval waits for a seat that holds it. For example, a merge gate that requires <span className="mono">tech-lead.approve</span> waits for the seat that may approve implementation.</span>
          <AuthorityGrid
            values={a.authority || []} known={AUTHORITY.tokens} domains={AUTHORITY.domains} verbs={AUTHORITY.verbs}
            onToggle={toggleAuthority}
            onRemove={(t) => { a.authority = (a.authority || []).filter((x: string) => x !== t); touch("Edited authority"); }}
          />
        </div>
      </Section>

      <Section id="communication" title="Communication" meta={`may message ${contacts.filter((t) => ids.includes(t)).length}`} reveal={reveal}>
        <div className="field" data-field="may_contact">
          <span className="ms-flabel">May message</span>
          <span className="ms-hint">Seats this one may start a thread with. Replies inside a thread are always allowed.</span>
          {others.length ? <ChipPick options={others} values={contacts} onToggle={(t) => ctx.toggleContact(cur, t)} label="May message" /> : <span className="ms-hint">There are no other seats yet.</span>}
        </div>
        <div className="field" data-field="may_be_contacted_by">
          <span className="ms-flabel">Also reachable by</span>
          <span className="ms-hint">Seats listed here may start a thread with this one even if their own list does not name it. It adds senders; it never blocks one.</span>
          {others.length ? <ChipPick options={others} values={grants} onToggle={(t) => ctx.toggleGrant(cur, t)} label="Also reachable by" /> : null}
        </div>
        <p className="ms-hint">
          {incoming.length ? <>Seats that list this one in their own may-message: <b>{incoming.join(", ")}</b>.</> : "No seat lists this one in its own may-message list."}
        </p>
      </Section>

      <Section id="behavior" title="Behavior" meta={`wakes for ${(a.interests || []).length}`} defaultOpen={false} reveal={reveal}>
        <Field label="Prompt file" name="prompt" hint="Blank uses the built-in prompt for this role.">
          <Input {...text("prompt")} placeholder="../../roles/architect.md" />
        </Field>
        <div className="field" data-field="interests">
          <label htmlFor="ms-int-filter" className="ms-flabel">Wakes for these events ({(a.interests || []).length})</label>
          <span className="ms-hint">A seat wakes when an event it is interested in happens. A pattern such as <span className="mono">architecture.*</span> covers every event under it.</span>
          <Input id="ms-int-filter" search placeholder="Filter the list" value={intFilter} onChange={(e) => setIntFilter(e.target.value)} />
          <div className="ms-scrollbox">
            <ChipPick
              options={ints.filter((c: string) => c.toLowerCase().includes(intFilter.toLowerCase()))} values={a.interests || []} label="Wake events"
              onToggle={(c) => {
                const l = new Set<string>(a.interests || []);
                if (l.has(c)) l.delete(c); else l.add(c);
                a.interests = [...l];
                touch("Edited wake events");
              }}
            />
          </div>
          <Button variant="linklike" onClick={() => setBulkInts(!bulkInts)}>{bulkInts ? "Hide the text editor" : "Edit as text"}</Button>
          {bulkInts ? (
            <TextArea rows={2} aria-label="Wake events, comma separated" defaultValue={(a.interests || []).join(", ")} key={`ints-${cur}-${(a.interests || []).join(",")}`} onBlur={(e) => { a.interests = csv(e.target.value); touch("Edited wake events"); }} />
          ) : null}
        </div>
      </Section>

      <Section id="budget" title="Budget" meta={`${fmtNum(a.budget?.tokens ?? 200000)} tokens`} defaultOpen={false} reveal={reveal}>
        <div className="grid2">
          <Field label="Token budget" name="tokens">
            <Input type="number" step={10000} value={a.budget?.tokens ?? 200000} onChange={(e) => setBudget("tokens", Number(e.target.value) || 0)} />
          </Field>
          <Num
            label="Cap in the mesh budgets" name="cap" value={override} step={10000} hint="Wins over the token budget"
            onSet={(v) => {
              m.budgets.agent ||= {};
              if (v === null) delete m.budgets.agent[cur]; else m.budgets.agent[cur] = v;
              touch();
            }}
          />
          <Num label="Activation limit" name="max_activations" value={a.budget?.max_activations} onSet={(v) => setBudget("max_activations", v)} hint="No limit" />
        </div>
        {override !== undefined && a.budget?.tokens !== undefined && override !== a.budget.tokens ? (
          <p className="ms-note warn">Both are set. The runtime uses the cap in the mesh budgets, {fmtNum(override)}.</p>
        ) : null}
        {inertSet ? (
          <div className="grid2">
            <Num label="Time limit (minutes)" name="wall_clock_minutes" value={a.budget?.wall_clock_minutes} onSet={(v) => setBudget("wall_clock_minutes", v)} hint="Not enforced" />
            <Num label="Event limit" name="max_events" value={a.budget?.max_events} onSet={(v) => setBudget("max_events", v)} hint="Not enforced" />
          </div>
        ) : null}
        {inertSet ? <p className="ms-note warn">A seat&rsquo;s time and event limits are accepted and then ignored. Use the mission budget on the Policy tab.</p> : null}
      </Section>

      <Section id="advanced" title="Advanced" defaultOpen={false} reveal={reveal}>
        <div className="grid2">
          <Field label="Remembers between turns" name="session">
            <Select value={triValue(a.session?.persistent)} onChange={(e) => {
              a.session ||= {};
              if (e.target.value === "") delete a.session.persistent;
              else a.session.persistent = e.target.value === "yes";
              touch();
            }}>
              <option value="">Inherit ({inheritedPersistent ? "yes" : "no"})</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Field label="May spawn helpers" name="delegation">
            <Select value={triValue(a.delegation?.allow)} onChange={(e) => {
              a.delegation ||= {};
              if (e.target.value === "") delete a.delegation.allow;
              else a.delegation.allow = e.target.value === "yes";
              touch();
            }}>
              <option value="">Inherit ({inheritedAllow ? "yes" : "no"})</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </Select>
          </Field>
          <Num label="Session context tokens" value={a.session?.max_context_tokens} onSet={(v) => {
            a.session ||= {};
            if (v === null) delete a.session.max_context_tokens; else a.session.max_context_tokens = Math.round(v);
            touch();
          }} step={1000} hint={numHint(meshSession.max_context_tokens, "Not enforced yet")} />
          <Num label="Helper workers, at most" value={a.delegation?.max_workers} onSet={(v) => {
            a.delegation ||= {};
            if (v === null) delete a.delegation.max_workers; else a.delegation.max_workers = Math.round(v);
            touch();
          }} hint={numHint(meshDelegation.max_workers, "0")} />
          <Num label="Helper depth, at most" value={a.delegation?.max_depth} onSet={(v) => {
            a.delegation ||= {};
            if (v === null) delete a.delegation.max_depth; else a.delegation.max_depth = Math.round(v);
            touch();
          }} hint={numHint(meshDelegation.max_depth, "0")} />
          <Num label="Helper budget tokens" value={a.delegation?.worker_budget_tokens} onSet={(v) => {
            a.delegation ||= {};
            if (v === null) delete a.delegation.worker_budget_tokens; else a.delegation.worker_budget_tokens = Math.round(v);
            touch();
          }} step={10000} hint={numHint(meshDelegation.worker_budget_tokens, "Same as the parent")} />
        </div>
      </Section>
    </div>
  );
}
