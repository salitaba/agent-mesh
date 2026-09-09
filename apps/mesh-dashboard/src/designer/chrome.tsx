/* Page chrome for the workbench: health strip (crew/boots/gates/advice
 * summary with one-click navigation), advisory notes, validation verdict,
 * review/saved/import/YAML sections. Pure presentational — all state flows in
 * via props from the Designer. */

import { tabOfError } from "./model";
import { Button, TextArea } from "../components";
import type { Advice, Tab } from "./types";

/* ---------------- health strip ---------------- */

export interface HealthStripProps {
  onGoto: (t: Tab) => void;
  ids: string[];
  startupCount: number;
  goalSet: boolean;
  gates: number;
  advice: Advice[];
  undoLabel: string | null;
  onUndo: () => void;
}

export function HealthStrip({ onGoto, ids, startupCount, goalSet, gates, advice, undoLabel, onUndo }: HealthStripProps): React.JSX.Element {
  const tiles: Array<{ label: string; value: string; bad?: boolean; warn?: boolean; tab: Tab; title?: string }> = [
    { label: "crew", value: String(ids.length), tab: "crew", title: "agents in this mesh" },
    { label: "boots", value: startupCount ? String(startupCount) : "nobody", warn: !startupCount, tab: "crew", title: "agents that start when the mesh goes live" },
    { label: "goal", value: goalSet ? "set" : "missing", bad: !goalSet, tab: "mesh", title: "the mission outcome agents work toward" },
    { label: "gates", value: String(gates), tab: "policy", title: "approval gates that pause steps" },
  ];
  return (
    <div className="ms-checks" role="toolbar" aria-label="mesh readiness">
      {tiles.map((t) => (
        <button key={t.label} className={`hstat${t.bad ? " bad" : t.warn ? " warn" : ""}`} onClick={() => onGoto(t.tab)} title={t.title}>
          <small>{t.label}</small>
          <b>{t.value}</b>
        </button>
      ))}
      {advice.length ? (
        <button className="hstat warn" onClick={() => onGoto(advice[0].tab)} title="non-blocking notes worth a look">
          <small>advice</small>
          <b>{advice.length}</b>
        </button>
      ) : (
        <span className="hstat muted-read" aria-hidden="true"><small>advice</small><b>0</b></span>
      )}
      {undoLabel ? <button className="hstat undo" onClick={onUndo} title="undo the last structural change">↩ undo “{undoLabel}”</button> : null}
    </div>
  );
}

/* ---------------- advisory notes ---------------- */

export function AdvisoryList({ advice, onGoto }: { advice: Advice[]; onGoto: (t: Tab) => void }): React.JSX.Element | null {
  if (!advice.length) return null;
  return (
    <details className="ms-advice" open={false}>
      <summary>
        <span className={`adv-ico ${advice.some((a) => a.level === "warn") ? "warn" : ""}`}>!</span>
        {advice.length} advisory note{advice.length === 1 ? "" : "s"} — not blocking, worth a look
      </summary>
      {advice.map((a, i) => (
        <div key={i} className={`adv ${a.level}`}>
          <Button variant="linklike" onClick={() => onGoto(a.tab)}>{a.msg}</Button>
        </div>
      ))}
    </details>
  );
}

/* ---------------- validation check section ---------------- */

export interface CheckSectionProps {
  checking: boolean;
  valid: boolean;
  errors: string[];
  offline: boolean;
  onGoto: (t: Tab) => void;
}

export function CheckSection({ checking, valid, errors, offline, onGoto }: CheckSectionProps): React.JSX.Element {
  let body: React.JSX.Element;
  if (checking) body = <div className="muted">checking…</div>;
  else if (valid) body = <div className="verdict ok">valid — this mesh passes every rule the server knows.</div>;
  else if (offline) body = <div className="verdict warn">couldn’t reach the server — showing the last result; your edits are intact.</div>;
  else body = (
    <>
      <div className="verdict bad">{errors.length} error{errors.length === 1 ? "" : "s"} — fix them, then save</div>
      <ul className="errs">
        {errors.map((e, i) => (
          <li key={i}><Button variant="linklike" extra="err-inline" onClick={() => onGoto(tabOfError(String(e)))}>{e}</Button></li>
        ))}
      </ul>
    </>
  );
  return (
    <section className="card ms-check-card" id="d-verify" aria-label="verification">
      <div className="wb-sec-head"><h3>Validation</h3><span className="muted live-note">{checking ? "re-checking…" : "re-checks as you type"}</span></div>
      <div role="status" aria-live="polite">{body}</div>
    </section>
  );
}

/* ---------------- review before save ---------------- */

export interface ReviewCardProps {
  targetPath: string;
  savingRunning: boolean;
  diff: string[];
  runningStale: boolean;
  blocked: boolean;
  errors: number;
  onSave: () => void;
  onClose: () => void;
}

export function ReviewCard({ targetPath, savingRunning, diff, runningStale, blocked, errors, onSave, onClose }: ReviewCardProps): React.JSX.Element {
  return (
    <section className="card save-review" id="d-review" aria-label="review before saving">
      <div className="wb-sec-head"><h3>Review before saving</h3></div>
      <div className="mono muted" style={{ fontSize: 12, overflowWrap: "anywhere" }}>→ {targetPath || "(no path)"}</div>
      {runningStale ? <div className="verdict warn">The running file changed since you opened the Designer (another tab may have saved). Your edits are intact — check the list below carefully.</div> : null}
      {diff.length && savingRunning ? (
        <ul className="diff-list">{diff.map((d, i) => <li key={i}>{d}</li>)}</ul>
      ) : savingRunning ? <div className="muted" style={{ fontSize: 12 }}>no differences from the running file.</div> : <div className="muted" style={{ fontSize: 12 }}>new copy — the running mesh is untouched.</div>}
      {blocked ? <div className="verdict bad">Still {errors} error{errors === 1 ? "" : "s"} — saving is blocked until they’re fixed.</div> : null}
      <div className="muted" style={{ fontSize: 12 }}>{savingRunning ? "Overwrites the running file. The live mesh keeps working; restart picks changes up." : "Writes a new file. Nothing live changes."}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button variant="primary" disabled={blocked || !targetPath} onClick={onSave}>{savingRunning ? "Overwrite running file" : "Save copy"}</Button>
        <Button variant="ghost" onClick={onClose}>cancel</Button>
      </div>
    </section>
  );
}

/* ---------------- saved confirmation ---------------- */

export function SavedCard({ path, isRunning, onYaml, onHome }: { path: string; isRunning: boolean; onYaml: () => void; onHome: () => void }): React.JSX.Element {
  return (
    <section className="card save-done" role="status" aria-label="saved">
      <b>Saved to {path}.</b>
      <span className="muted">{isRunning ? " Restart the mesh to run it." : " Run it any time."}</span>
      <div className="row" style={{ marginTop: 6 }}>
        <Button variant="small" onClick={onYaml}>Review YAML</Button>
        <Button variant="small" onClick={onHome}>Back to Overview</Button>
      </div>
    </section>
  );
}

/* ---------------- import YAML ---------------- */

export interface ImportCardProps {
  text: string;
  setText: (v: string) => void;
  onApply: () => void;
  onCancel: () => void;
}

export function ImportCard({ text, setText, onApply, onCancel }: ImportCardProps): React.JSX.Element {
  return (
    <section className="card" aria-label="import yaml">
      <div className="wb-sec-head"><h3>Import YAML</h3></div>
      <TextArea rows={8} placeholder="paste mesh.yaml…" style={{ marginTop: 8 }} aria-label="YAML to import" value={text} onChange={(e) => setText(e.target.value)} />
      <div className="row" style={{ marginTop: 8 }}>
        <Button variant="small" onClick={onApply}>apply import</Button>
        <Button variant="ghost" onClick={onCancel}>cancel</Button>
      </div>
    </section>
  );
}

/* ---------------- YAML preview ---------------- */

export interface YamlCardProps {
  yaml: string | null;
  targetPath: string;
  invalid: boolean;
  stale: boolean;
  onCopy: () => void;
}

export function YamlCard({ yaml, targetPath, invalid, stale, onCopy }: YamlCardProps): React.JSX.Element {
  return (
    <section className="card ms-yaml-card" id="d-yaml" aria-label="yaml preview">
      <div className="wb-sec-head">
        <h3>YAML preview</h3>
        <span className="muted mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>{targetPath}</span>
        <Button variant="small" onClick={onCopy} style={{ marginLeft: "auto" }}>copy</Button>
      </div>
      {invalid || stale ? <div className="verdict warn" style={{ marginTop: 0 }}>{invalid ? "invalid — showing the last valid version" : "couldn’t re-check — may be stale"}</div> : null}
      <pre className="yaml-pane">{yaml ?? "…"}</pre>
    </section>
  );
}