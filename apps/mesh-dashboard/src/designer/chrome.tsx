/* Page chrome for the workbench: health strip (crew/boots/gates/advice
 * summary with one-click navigation), advisory notes, validation verdict,
 * review/saved/import/YAML sections. Pure presentational — all state flows in
 * via props from the Designer. */

import { tabOfError } from "./model";
import { confirmationFor, confirmationSatisfied, summarizeMutation } from "./mutations";
import { Button, Input, TextArea } from "../components";
import type { StagedMutation } from "@mesh/protocol";
import type { SourceState } from "./model";
import type { Advice, Tab } from "./types";

/* ---------------- health strip ---------------- */

export interface HealthStripProps {
  onGoto: (t: Tab) => void;
  startupCount: number;
  gates: number;
  advice: Advice[];
  undoLabel: string | null;
  onUndo: () => void;
  redoLabel: string | null;
  onRedo: () => void;
}

/* crew count and goal live in the Designer header's canonical state line /
 * workspace line now, so they are not repeated here. */
export function HealthStrip({ onGoto, startupCount, gates, advice, undoLabel, onUndo, redoLabel, onRedo }: HealthStripProps): React.JSX.Element {
  const tiles: Array<{ label: string; value: string; warn?: boolean; tab: Tab; title?: string }> = [
    { label: "boots", value: startupCount ? String(startupCount) : "nobody", warn: !startupCount, tab: "crew", title: "agents that start when the mesh goes live" },
    { label: "gates", value: String(gates), tab: "policy", title: "approval gates that pause steps" },
  ];
  return (
    <div className="ms-checks" role="toolbar" aria-label="mesh readiness">
      {tiles.map((t) => (
        <button key={t.label} className={`hstat${t.warn ? " warn" : ""}`} onClick={() => onGoto(t.tab)} title={t.title}>
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
      {undoLabel ? <button className="hstat undo" onClick={onUndo} title="undo the last structural change (Ctrl/Cmd+Z)">↩ undo “{undoLabel}”</button> : null}
      {/* Redo only appears once there is something to redo, so the strip does
          not carry a permanently dead control. */}
      {redoLabel ? <button className="hstat undo" onClick={onRedo} title="redo what you just undid (Ctrl/Cmd+Shift+Z)">↪ redo “{redoLabel}”</button> : null}
    </div>
  );
}

/* ---------------- source-of-truth state line ---------------- */

export interface SourceStateLineProps {
  state: SourceState;
  reviewOpen: boolean;
  onToggleReview: () => void;
}

/** One line for the draft ↔ running-file ↔ process story. WS4 consumes the
 *  `SourceState` props from here; it must not mutate them. */
export function SourceStateLine({ state, reviewOpen, onToggleReview }: SourceStateLineProps): React.JSX.Element {
  let body: React.JSX.Element;
  switch (state.kind) {
    case "RESTORED_DRAFT":
      body = state.hasRunning
        ? <span className="muted">local draft differs from the running file — keep or discard it above.</span>
        : <span className="muted">local draft restored — no running file is loaded.</span>;
      break;
    case "NEW":
      body = <span className="muted">new mesh — nothing running to overwrite.</span>;
      break;
    case "COPY_SAVED":
      body = <span className="muted">copy target — saving writes a new file; runtime unchanged.</span>;
      break;
    case "DIFFERS":
      body = (
        <Button variant="linklike" onClick={onToggleReview}>
          {state.n ? `${state.n} difference${state.n === 1 ? "" : "s"} from the running config` : "differs from the running config"} — {reviewOpen ? "hide" : "review"}
        </Button>
      );
      break;
    case "MATCHES_RUNNING_FILE":
      body = <span className="muted">matches the saved running config — restart the mesh to apply.</span>;
      break;
  }
  const unsaved = state.dirty && state.kind !== "DIFFERS" ? <span className="muted"> · unsaved edits</span> : null;
  return <span className="ms-src" role="status">{body}{unsaved}</span>;
}

/* ---------------- advisory notes ---------------- */

export function AdvisoryList({ advice, onGoto }: { advice: Advice[]; onGoto: (t: Tab) => void }): React.JSX.Element | null {
  if (!advice.length) return null;
  const decisions = advice.filter((a) => a.level === "warn").length;
  const suggestions = advice.length - decisions;
  return (
    <details className="ms-advice" open={false}>
      <summary>
        <span className={`adv-ico ${decisions ? "warn" : ""}`}>!</span>
        {decisions ? <b>{decisions} decision{decisions === 1 ? "" : "s"} required</b> : null}
        {decisions && suggestions ? " · " : null}
        {suggestions ? `${suggestions} suggestion${suggestions === 1 ? "" : "s"}` : null}
      </summary>
      {advice.map((a) => (
        <div key={`${a.tab}-${a.msg}`} className={`adv ${a.level}`}>
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
        {errors.map((e) => (
          <li key={e}><Button variant="linklike" extra="err-inline" onClick={() => onGoto(tabOfError(String(e)))}>{e}</Button></li>
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
  /** SourceState says the draft differs but `diff` did not itemize it. */
  differs?: boolean;
  /** Saving would land on the running file even though the target is "copy". */
  targetConflict?: boolean;
  runningStale: boolean;
  blocked: boolean;
  saving: boolean;
  errors: number;
  onSave: () => void;
  onClose: () => void;
}

export function ReviewCard({ targetPath, savingRunning, diff, differs, targetConflict, runningStale, blocked, saving, errors, onSave, onClose }: ReviewCardProps): React.JSX.Element {
  return (
    <section className="card save-review" id="d-review" aria-label="review before saving">
      <div className="wb-sec-head"><h3>Review before saving</h3></div>
      <div className="mono muted tx-value" style={{ overflowWrap: "anywhere" }}>→ {targetPath || "(no path)"}</div>
      {runningStale ? <div className="verdict warn">The running file changed since you opened the Designer (another tab may have saved). Your edits are intact — check the list below carefully.</div> : null}
      {diff.length && savingRunning ? (
        <ul className="diff-list">{diff.map((d) => <li key={d}>{d}</li>)}</ul>
      ) : savingRunning ? (
        <div className="muted tx-meta">{differs ? "differences here aren’t itemized — saving still overwrites the running file." : "no differences from the running file."}</div>
      ) : <div className="muted tx-meta">writes a new file — the running mesh keeps working untouched.</div>}
      {blocked ? <div className="verdict bad">Still {errors} error{errors === 1 ? "" : "s"} — saving is blocked until they’re fixed.</div> : null}
      {targetConflict ? <div className="verdict bad">that path is the running config — select the running target or choose a different copy path.</div> : null}
      <div className="muted tx-meta">{savingRunning ? "Overwrites the running file. The live mesh keeps working; restart the mesh to apply." : "Writes a new file. The running mesh keeps working untouched."}</div>
      <div className="row" style={{ marginTop: 8 }}>
        <Button variant="primary" disabled={blocked || !targetPath || targetConflict || saving} onClick={onSave}>{saving ? "saving…" : savingRunning ? "Overwrite running file" : "Save copy"}</Button>
        <Button variant="ghost" onClick={onClose}>cancel</Button>
      </div>
    </section>
  );
}

/* ---------------- saved confirmation ---------------- */

/**
 * The post-save card. `warnings` is the SAVE-ONLY subset (mesh-server
 * `/config/save` → `saveWarnings`), not the whole response: everything else in
 * that response is config-time and already on the health strip, because the
 * debounced validate resolved the same bytes against the same baseDir. What
 * arrives here is what only a write can learn — today, a prompt ref that is
 * still dangling in the directory this save just wrote into. It belongs on this
 * card rather than the strip because this card clears with the next write, which
 * is the only event that can change the answer. */
export function SavedCard({ path, warnings, isRunning, syncOffered, onYaml, onHome }: { path: string; warnings?: string[]; isRunning: boolean; syncOffered?: boolean; onYaml: () => void; onHome: () => void }): React.JSX.Element {
  /* "Restart the mesh to run it" is true of seats and budgets, which boot
   * reconciles from the file every time, and NOT of the goal, which boot mints
   * only when it is not resuming. When the sync card below is offering to close
   * that gap, it owns the sentence; repeating a restart line here would send the
   * operator off to do the one thing that will not move their mission. */
  return (
    <section className="card save-done" role="status" aria-label="saved">
      <b>Saved to {path}.</b>
      <span className="muted">{syncOffered ? "" : isRunning ? " Restart the mesh to run it." : " Run it any time."}</span>
      {warnings && warnings.length ? (
        <div style={{ marginTop: 6 }}>
          <b>
            {warnings.length} prompt file{warnings.length === 1 ? " is" : "s are"} missing next to this save.
          </b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {warnings.map((w) => <li key={w} className="mono">{w}</li>)}
          </ul>
          {/* Register move 3, and the one this card owed: re-saving does not help,
           * because the lookup is relative to the file just written. Without it a
           * warning next to a green "Saved" reads as a flaky save. */}
          <span className="muted">
            Re-saving will not fix {warnings.length === 1 ? "it" : "them"} — the path is resolved against the
            directory this save wrote into, not against your unsent draft. Create
            {warnings.length === 1 ? " the file" : " those files"}, or point the agent&rsquo;s <span className="mono">prompt</span> at
            a path inside that directory. Your config saved fine; only the agent&rsquo;s prompt is unreadable.
          </span>
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 6 }}>
        <Button variant="small" onClick={onYaml}>Review YAML</Button>
        <Button variant="small" onClick={onHome}>Back to Overview</Button>
      </div>
    </section>
  );
}

/* ---------------- sync the running mission ---------------- */

/**
 * Offered after a Save that overwrote the RUNNING config, because mesh.yaml is
 * a seed and not a mirror: the file moves, the live mission does not. The
 * server computes the proposal (it needs fully-resolved AgentDefinitions — see
 * mesh-server/src/config-drift.ts) and applying it goes back through the
 * ordinary staged-apply route, so every Supervisor refusal reaches the operator
 * verbatim instead of being re-implemented here.
 *
 * `problems` is rendered as prominently as the changes: it is what the sync
 * CANNOT carry (a live seat whose definition changed, a retired seat, the token
 * budget), and hiding it would let a partial sync read as a complete one.
 */
export interface SyncCardProps {
  mutations: StagedMutation[];
  problems: string[];
  busy: boolean;
  /** Outcome of the last apply: the server's own sentences, never an HTTP code. */
  result: { ok: boolean; msg: string } | null;
  confirmText: string;
  setConfirmText: (s: string) => void;
  /** This mesh's id, for the kinds whose confirmation is the id itself. */
  meshId: string;
  onApply: () => void;
  onDismiss: () => void;
}

export function SyncCard({ mutations, problems, busy, result, confirmText, setConfirmText, meshId, onApply, onDismiss }: SyncCardProps): React.JSX.Element {
  const lines = mutations.flatMap((m) => summarizeMutation(m, { model: null }));
  const confirmation = confirmationFor(mutations, meshId);
  const confirmed = confirmationSatisfied(confirmation, confirmText);
  return (
    <section className="card save-sync" aria-label="bring the running mission in line">
      <div className="wb-sec-head"><h3>The running mission still differs</h3></div>
      <div className="verdict warn">Saved to the file. The running mission still has what it booted with.</div>
      {mutations.length ? (
        <ul className="diff-list">{lines.map((d, k) => <li key={`y${k}-${d}`}>{d}</li>)}</ul>
      ) : (
        <div className="muted tx-meta">Nothing in this save has a live counterpart to apply.</div>
      )}
      {problems.length ? (
        <>
          <div className="muted tx-meta">{problems.length === 1 ? "One thing cannot be synced:" : `${problems.length} things cannot be synced:`}</div>
          <ul className="diff-list">{problems.map((t) => <li key={t}>{t}</li>)}</ul>
        </>
      ) : null}
      {confirmation ? (
        <div className="ms-chat-confirm">
          <div className="verdict bad">{confirmation.prompt}</div>
          <Input
            value={confirmText}
            onChange={(ev) => setConfirmText(ev.target.value)}
            placeholder={confirmation.word}
            aria-label={`type ${confirmation.word} to confirm a destructive change`}
          />
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 8 }}>
        <Button variant="primary" disabled={busy || !mutations.length || !confirmed || result?.ok === true} onClick={onApply}>
          {busy ? "applying…" : "apply to the running mission"}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>{result?.ok ? "close" : "leave it"}</Button>
      </div>
      {result && !busy ? <div className={`verdict ${result.ok ? "ok" : "bad"}`}>{result.msg}</div> : null}
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
        <span className="muted mono tx-value" style={{ overflowWrap: "anywhere" }}>{targetPath}</span>
        <Button variant="small" onClick={onCopy} style={{ marginLeft: "auto" }}>copy</Button>
      </div>
      {invalid || stale ? <div className="verdict warn" style={{ marginTop: 0 }}>{invalid ? "invalid — showing the last valid version" : "couldn’t re-check — may be stale"}</div> : null}
      <pre className="yaml-pane">{yaml ?? "…"}</pre>
    </section>
  );
}