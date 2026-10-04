/**
 * Host settings: the cross-project limits, on their own screen.
 *
 * Its own screen and not a section of Overview because these keys are host-wide: the same ceiling parks every project, so editing
 * it from inside one mission's console would misreport whose limit it is.
 *
 * One form. Edits collect in the boxes, a list of exactly what will change appears before anything is sent, and one Save sends it as
 * one request, so the host takes all of it or none. Two rules from the incident that prompted this screen (a $50 ceiling nobody
 * set, in a file that did not exist) still hold:
 *
 *   1. Say whether a human chose each value. A default and a deliberate setting look the same as a number, so each row says which it
 *      is, quietly, under the box.
 *   2. Say when an edit lands. The host states it per key (`effects`); the form says it once, and a row repeats it only where it
 *      differs. The host has no restart route, so a setting that needs one is saved, and the command to restart is shown.
 *
 * The rules live in hostsettings.ts (mirroring packages/projects/host-config, which the CLI and server boot share): a typo is caught
 * where it is typed, and whatever the host still refuses is shown on the field it names.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import "./settings.css";
import { api } from "../api";
import { localTime } from "../format";
import { useMesh } from "../store";
import { Banner, Button, CopyButton, ErrorState, Input, PageHeader } from "../components";
import { Icon } from "../icons";
import { LicenseCard } from "../license";
import { LIST_PRICES_AS_OF, longDate } from "../cost";
import {
  FIELDS,
  GROUPS,
  RESTART_COMMANDS,
  RESTART_COST,
  confirmCopy,
  defaultHint,
  draftOf,
  fmtValue,
  legend,
  parseDraft,
  planSave,
  priceLines,
  savePayload,
  serverProblems,
  type Drafts,
  type Field,
  type FieldSpec,
  type HostConfigValues,
} from "../hostsettings";

interface HostConfigView {
  path: string;
  config: HostConfigValues & { modelPrices: Record<string, unknown> };
  explicit: string[];
  effects: Record<string, string>;
  warnings: string[];
}

interface FieldProblems { byField: Partial<Record<Field, string>>; form: string[] }
const NO_PROBLEMS: FieldProblems = { byField: {}, form: [] };

export default function HostSettings(): React.JSX.Element {
  const { confirm } = useMesh();
  const [data, setData] = useState<HostConfigView | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  // What the host refused on the last save, shown on the fields it names until they are edited.
  const [refused, setRefused] = useState<FieldProblems>(NO_PROBLEMS);
  // What the last save did, until the next edit.
  const [saved, setSaved] = useState<{ at: number; live: string[]; restart: string[] } | null>(null);
  // Saved to host.yaml but not yet in force: stays until the page is read again, because a restart is what clears it.
  const [pending, setPending] = useState<Field[]>([]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      const res = await api("GET", "/api/host/config");
      if (dead) return;
      if (res.status !== 200) {
        setLoadErr(res.json?.error || `The host answered with status ${res.status}.`);
        return;
      }
      setLoadErr(null);
      setData(res.json as HostConfigView);
      setDrafts({});
    })().catch((e: unknown) => {
      if (!dead) setLoadErr(e instanceof Error ? e.message : String(e));
    });
    return () => {
      dead = true;
    };
  }, [attempt]);

  const plan = useMemo(() => (data ? planSave(data.config, drafts, data.effects) : { changes: [], problems: [] }), [data, drafts]);
  const note = useMemo(() => (data ? legend(data.effects) : { text: "", restart: [] as Field[] }), [data]);
  const problemOf = (field: Field): string | undefined => plan.problems.find((p) => p.field === field)?.message ?? refused.byField[field];
  const blocked = plan.problems.length > 0 || Object.keys(refused.byField).length > 0;

  const edit = (field: Field, value: string): void => {
    setDrafts((d) => ({ ...d, [field]: value }));
    setRefused((r) => {
      if (!(field in r.byField) && r.form.length === 0) return r;
      const { [field]: _gone, ...rest } = r.byField;
      return { byField: rest, form: [] };
    });
    setSaved(null);
  };

  const discard = (): void => {
    setDrafts({});
    setRefused(NO_PROBLEMS);
    setSaved(null);
  };

  const save = useCallback(async (): Promise<void> => {
    if (!data || saving || plan.changes.length === 0 || plan.problems.length > 0) return;
    const { changes } = plan;
    const body = savePayload(changes);
    setSaving(true);
    setRefused(NO_PROBLEMS);
    setSaved(null);
    try {
      let res = await api("PUT", "/api/host/config", body);

      // The host, not this form, decides that raising or removing the ceiling needs asking. It answers 409 and we ask, so the rule holds
      // for the CLI and any other client too.
      if (res.status === 409 && res.json?.needsConfirm) {
        const ceiling = changes.find((c) => c.field === "spendCeilingUsd");
        const copy = ceiling && ceiling.confirm
          ? confirmCopy(ceiling)
          : { title: "Save this change?", body: [String(res.json.error)], confirmLabel: "Save it" };
        const answer = await confirm({ title: copy.title, body: copy.body, danger: true, confirmLabel: copy.confirmLabel });
        if (answer === null) return;
        res = await api("PUT", "/api/host/config", { ...body, confirm: true });
      }

      if (res.status === 400) {
        const errors: string[] = Array.isArray(res.json?.errors) ? (res.json.errors as unknown[]).map(String) : [String(res.json?.error ?? "The host refused the change.")];
        const { byField, other } = serverProblems(errors);
        setRefused({ byField: Object.fromEntries(byField.map((p) => [p.field, p.message])) as Partial<Record<Field, string>>, form: other });
        return;
      }
      if (res.status !== 200) {
        setRefused({ byField: {}, form: [String(res.json?.error ?? `The host answered with status ${res.status}.`)] });
        return;
      }

      setData(res.json as HostConfigView);
      setDrafts({});
      setSaved({ at: Date.now(), live: changes.filter((c) => !c.restart).map((c) => c.label), restart: changes.filter((c) => c.restart).map((c) => c.label) });
      const needRestart = changes.filter((c) => c.restart).map((c) => c.field);
      if (needRestart.length) setPending((p) => [...new Set([...p, ...needRestart])]);
    } catch (e: unknown) {
      setRefused({ byField: {}, form: [`The host did not answer, so the change may not have been saved: ${e instanceof Error ? e.message : String(e)}`] });
    } finally {
      setSaving(false);
    }
  }, [confirm, data, plan, saving]);

  if (loadErr !== null) {
    return (
      <>
        <PageHeader title="Host settings" lede="Limits that apply to every project on this host." />
        <ErrorState what="the host settings" detail={loadErr} onRetry={() => { setLoadErr(null); setAttempt((a) => a + 1); }} />
      </>
    );
  }
  if (data === null) {
    return (
      <>
        <PageHeader title="Host settings" lede="Limits that apply to every project on this host." />
        <div className="hs-skel" role="status"><span className="sr-only">Loading the host settings</span><i /><i /><i /></div>
      </>
    );
  }

  const listed = priceLines(data.config.modelPrices);
  const pendingLabels = pending.map((f) => FIELDS.find((s) => s.field === f)!.label);

  const row = (spec: FieldSpec): React.JSX.Element => {
    const raw = drafts[spec.field];
    const shown = raw ?? draftOf(data.config[spec.field]);
    const problem = problemOf(spec.field);
    const edited = plan.changes.some((c) => c.field === spec.field);
    const parsed = parseDraft(spec, shown);
    const differs = !parsed.ok || parsed.value !== spec.fallback;
    const id = `hs-${spec.yaml}`;
    return (
      <div key={spec.field} className={`hs-row${edited ? " dirty" : ""}${problem ? " invalid" : ""}`}>
        <div className="hs-label">
          <label htmlFor={id}>{spec.label}</label>
          {note.restart.includes(spec.field) ? <span className="hs-tag restart">Needs a host restart</span> : null}
          {edited ? <span className="hs-tag edited">Edited</span> : null}
          <p className="hs-what" id={`${id}-what`}>{spec.what}</p>
        </div>
        <div className="hs-control">
          <div className="hs-input">
            {spec.prefix ? <span className="hs-pre" aria-hidden="true">{spec.prefix}</span> : null}
            <Input
              id={id}
              mono
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              value={shown}
              placeholder={spec.blank ? "No limit" : "Required"}
              aria-invalid={problem ? true : undefined}
              aria-describedby={`${id}-what ${id}-hint${problem ? ` ${id}-err` : ""}`}
              onChange={(e) => edit(spec.field, e.target.value)}
            />
            {spec.suffix ? <span className="hs-suf">{spec.suffix}</span> : null}
          </div>
          <p className="hs-hint" id={`${id}-hint`}>
            {spec.blank ? `Blank means ${spec.blank}. ` : ""}
            {defaultHint(spec, data.explicit.includes(spec.yaml))}
            {differs ? <button type="button" className="hs-link" aria-label={`Use the default for ${spec.label}`} onClick={() => edit(spec.field, draftOf(spec.fallback))}>Use the default</button> : null}
          </p>
          {problem ? <p className="hs-err" id={`${id}-err`}><Icon name="alert" size={14} />{problem}</p> : null}
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title="Host settings"
        lede={<>Limits that apply to every project on this host, not only this one. They live in <code>{data.path}</code>.</>}
        actions={<CopyButton text={data.path} label="Copy path" title="Copy the path of host.yaml" />}
      />

      <div className="hs-stack">
      <form
        className="hs-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {data.warnings.length > 0 ? (
          <Banner tone="warn" title="host.yaml has problems.">
            These keys were ignored and the default is in force: {data.warnings.join(" · ")}
          </Banner>
        ) : null}

        <p className="hs-legend">{note.text}</p>

        {GROUPS.map((g) => (
          <section key={g.id} className="card" aria-labelledby={`hs-g-${g.id}`}>
            <h3 id={`hs-g-${g.id}`} className="hs-h">{g.title}</h3>
            {FIELDS.filter((f) => f.group === g.id).map(row)}
            {g.id === "prices" ? (
              <>
                <h4 className="hs-h2">Model prices</h4>
                {listed.lines.length ? (
                  <ul className="hs-prices">
                    {listed.lines.map((l) => <li key={l.model}><code>{l.model}</code><span>{l.text}</span></li>)}
                    {listed.more ? <li className="muted">and {listed.more} more in host.yaml</li> : null}
                  </ul>
                ) : (
                  <p className="hs-note">None set. Anthropic&apos;s models are priced at its list prices (as of {longDate(LIST_PRICES_AS_OF)}), and any other model at the default price above.</p>
                )}
                <p className="hs-note">
                  Prices per model are changed in <code>model_prices</code> in host.yaml by hand, not here. The host reads the file again the next time you save on this page, or when it restarts.
                </p>
              </>
            ) : null}
          </section>
        ))}

        <section className="card" aria-labelledby="hs-save-h">
          <h3 id="hs-save-h" className="hs-h">Changes{plan.changes.length ? <span className="hs-n">{plan.changes.length}</span> : null}</h3>
          {plan.changes.length ? (
            <ul className="hs-changes">
              {plan.changes.map((c) => (
                <li key={c.field}>
                  <span className="hs-change">
                    <b>{c.label}</b>
                    <span className="hs-from">{c.from}</span>
                    <span aria-hidden="true">→</span><span className="sr-only"> becomes </span>
                    <span className="hs-to">{c.to}</span>
                  </span>
                  <span className="hs-then">
                    {c.restart ? "Written now; takes effect when the host restarts." : "Takes effect as soon as you save."}
                    {c.confirm === "raise" ? " Raising the ceiling asks you to confirm." : c.confirm === "remove" ? " Removing the ceiling asks you to confirm." : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="hs-note">Nothing to save. Edit a value above and exactly what will change is listed here before anything is sent.</p>
          )}
          {plan.problems.length ? <p className="hs-err"><Icon name="alert" size={14} />Fix {plan.problems.length === 1 ? "the value marked above" : `the ${plan.problems.length} values marked above`} before saving.</p> : null}
          {refused.form.map((m) => <p key={m} className="hs-err" role="alert"><Icon name="alert" size={14} />{m}</p>)}
          <div className="hs-acts">
            <Button variant="primary" type="submit" disabled={plan.changes.length === 0 || blocked || saving}>{saving ? "Saving…" : "Save changes"}</Button>
            <Button variant="soft" disabled={(Object.keys(drafts).length === 0 && !blocked) || saving} onClick={discard}>Discard changes</Button>
            <span className={`hs-status${saved ? " ok" : ""}`} role="status">
              {saved
                ? `Saved at ${localTime(new Date(saved.at).toISOString())}.${saved.live.length ? ` ${saved.live.join(" and ")} ${saved.live.length === 1 ? "is" : "are"} in force now.` : ""}${saved.restart.length ? ` ${saved.restart.join(" and ")} will apply when the host restarts.` : ""}`
                : ""}
            </span>
          </div>
        </section>
      </form>

      {pending.length ? (
        <section className="card hs-restart" aria-labelledby="hs-restart-h">
          <h3 id="hs-restart-h" className="hs-h lead">Restart the host to apply {pendingLabels.join(" and ")}</h3>
          <p className="hs-note">
            {pendingLabels.join(" and ")} {pending.length === 1 ? "is" : "are"} saved in host.yaml, and the running host keeps the old {pending.length === 1 ? "value" : "values"} until it restarts.
            This console cannot restart the host: it has no restart route, so it is done where the host runs.
          </p>
          <ul className="hs-cmds">
            {RESTART_COMMANDS.map((r) => (
              <li key={r.where}><span>{r.where}</span><code>{r.command}</code><CopyButton text={r.command} label="Copy" title={`Copy the ${r.where} command`} /></li>
            ))}
            <li><span>Started by hand</span><code>Stop curule host, wait for it to drain, then start it again</code><span /></li>
          </ul>
          <p className="hs-note">{RESTART_COST}</p>
        </section>
      ) : null}

      <LicenseCard />
      </div>
    </>
  );
}
