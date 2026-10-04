/* Saving, and what saving leaves to do.
 *
 * The old bar said "SAVE TO [running | copy] <path>", "7 differences from the running config - review", and "writes mesh.yaml - restart to
 * apply", and the click that followed opened a card below the fold, then another, then a third. "Running" meant the file, "differences
 * from the running config" meant differences from the file, and "restart to apply" was said whether or not it was true: a mission reads
 * mesh.yaml once, when it boots, so a save writes the file and changes nothing live. Some of what a save changes CAN reach a running
 * mission without a restart (the goal, the done-when checks, new seats, retiring a seat, the event and time caps), and some cannot be
 * carried live at all (a changed seat definition needs a restart, the token cap needs the mission controls).
 *
 * One bar says what file is written and where the draft stands. One sheet above it walks the whole thing in order: review what will
 * change in the file, save, then what is left for the running mission, with the button for each (apply now, restart) and the words the
 * server used. Nothing in it claims an effect that did not happen. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Input } from "../components";
import { Icon } from "../icons";
import { CloseButton, PathLabel } from "./ui";
import { diffMesh, sameMesh, savePayload, type Change } from "./diff";
import { baseName, deepCopy, saveLandsOnRunning } from "./model";
import { confirmationFor, confirmationSatisfied, summarizeMutation } from "./mutations";
import { classifyDrift, isScriptedDemo, lagSentence, readApply, remainingAfter, shortPath, type ApplyOutcome, type Drift, type DraftStatus, type FollowUp, type Lag, type Saved } from "./save";
import { locateIssue, whereLabel, type Where } from "./locate";
import { useMesh } from "../store";
import { useMission } from "../useMission";
import { useProjectsOptional } from "../projects";
import type { StagedMutation } from "@mesh/protocol";

/** `after` reopens the follow-up to a save to the running file, so closing the sheet does not lose what is left to do for the mission. */
export type SheetMode = "file" | "copy" | "after";

/* The follow-up to a save, kept per project for as long as the page lives, so a visit to another view does not forget that the mission is behind the file.
   It is memory, not storage: a reload forgets it, because the server only works out the difference at the moment of a save. */
const FOLLOW_UPS = new Map<string, FollowUp>();
export const rememberedFollowUp = (project: string): FollowUp | null => FOLLOW_UPS.get(project) ?? null;
export function rememberFollowUp(project: string, f: FollowUp | null): void {
  if (f) FOLLOW_UPS.set(project, f);
  else FOLLOW_UPS.delete(project);
}

/* ---------------------------------------------------------------- the bar */

export interface SaveBarProps {
  /** The file "Save changes" writes: the project's mesh.yaml, or the copy path when there is no file yet. */
  path: string;
  hasFile: boolean;
  status: DraftStatus;
  checking: boolean;
  valid: boolean;
  offline: boolean;
  errors: number;
  open: SheetMode | null;
  onOpen: (mode: SheetMode) => void;
  onShowErrors: () => void;
  /** How far the running mission is behind the file that was saved, when it is; the bar says so until it is not. */
  lag: Lag | null;
  lagAt: number | null;
  onShowLag: () => void;
  onDismissLag: () => void;
  /** The sheet, which hangs above the bar. */
  children?: React.ReactNode;
}

export function SaveBar({ path, hasFile, status, checking, valid, offline, errors, open, onOpen, onShowErrors, lag, lagAt, onShowLag, onDismissLag, children }: SaveBarProps): React.JSX.Element {
  const blocked = !checking && !offline && !valid;
  const showLag = !!lag && status.kind === "clean";
  const barRef = useRef<HTMLDivElement | null>(null);
  // The bar is pinned to the bottom of the page, where the toasts are. Its height is published so they can sit above it (designer.css) and
  // not on the Save buttons, which a toast with an Undo button used to cover for as long as it stayed.
  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const root = document.documentElement;
    const publish = (): void => { root.style.setProperty("--ms-bar-h", `${Math.round(el.getBoundingClientRect().height)}px`); };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => { ro.disconnect(); root.style.removeProperty("--ms-bar-h"); };
  }, []);
  return (
    <div className="ms-bar" role="region" aria-label="Save" ref={barRef}>
      {children}
      <div className="ms-bar-in">
        <div className="ms-bar-file">
          {path ? <PathLabel path={path} /> : <span className="ms-path muted">No file yet</span>}
          <span className="ms-bar-state" role="status">
            {blocked ? (
              <>
                <b className="bad">{errors} {errors === 1 ? "error blocks" : "errors block"} saving.</b>{" "}
                <Button variant="linklike" onClick={onShowErrors}>Show the {errors === 1 ? "error" : "errors"}</Button>
              </>
            ) : showLag && lag ? (
              <>
                {lagSentence(lag, new Date(lagAt ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}{" "}
                <Button variant="linklike" aria-expanded={open === "after"} onClick={onShowLag}>What&rsquo;s left</Button>{" "}
                <Button variant="linklike" onClick={onDismissLag}>Dismiss</Button>
              </>
            ) : checking ? "Checking the draft." : offline ? "Could not reach the server to check the draft." : status.detail}
          </span>
        </div>
        <div className="ms-bar-acts">
          {hasFile ? <Button variant="soft" aria-expanded={open === "copy"} onClick={() => onOpen("copy")}>Save a copy</Button> : null}
          <Button
            variant="primary" aria-expanded={open === "file"} icon="check"
            disabled={hasFile && status.kind === "clean"}
            title={hasFile && status.kind === "clean" ? "There is nothing to save: the draft matches mesh.yaml." : undefined}
            onClick={() => onOpen(hasFile ? "file" : "copy")}
          >
            {hasFile ? "Save changes" : "Save to a file"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- the changes */

const OP_ICON = { add: "plus", remove: "x", change: "arrow-right" } as const;
const OP_WORD = { add: "Added", remove: "Removed", change: "Changed" } as const;
const FOLD_AT = 8;

/** What will differ in the file, one sentence each. Long lists fold after a few, because the point is the first look. */
export function ChangeList({ changes, label }: { changes: Change[]; label: string }): React.JSX.Element {
  const [all, setAll] = useState(false);
  const shown = all ? changes : changes.slice(0, FOLD_AT);
  return (
    <div className="ms-changes-wrap">
      <ul className="ms-changes" aria-label={label}>
        {shown.map((c, i) => (
          <li key={`${i}-${c.text}`} className={`ms-chg ${c.op}`}>
            <span className="ms-chg-op" aria-hidden="true"><Icon name={OP_ICON[c.op]} size={12} /></span>
            <span><span className="sr-only">{OP_WORD[c.op]}: </span>{c.text}</span>
          </li>
        ))}
      </ul>
      {changes.length > FOLD_AT ? (
        <Button variant="linklike" onClick={() => setAll(!all)}>{all ? "Show fewer" : `Show all ${changes.length}`}</Button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- the sheet */

export interface SaveSheetProps {
  mode: SheetMode;
  /** The draft, padded for editing. It is edited in place, so `rev` says when it changed. */
  model: any;
  rev: number;
  /** The file as the Designer last read it. */
  baseline: any | null;
  runningPath: string;
  copyPath: string;
  setCopyPath: (p: string) => void;
  checking: boolean;
  valid: boolean;
  offline: boolean;
  errors: string[];
  seats: string[];
  onGo: (w: Where) => void;
  /** Called once the server has written the file. */
  onSaved: (info: { path: string; running: boolean; payload: any }) => void;
  /** The follow-up to the last save to the running file, kept by the Designer, and how the sheet changes it. */
  followUp: FollowUp | null;
  setFollowUp: (f: FollowUp | null) => void;
  onClose: () => void;
  onYaml: () => void;
  onHome: () => void;
}

export function SaveSheet(props: SaveSheetProps): React.JSX.Element {
  const { mode, model, rev, baseline, runningPath, copyPath, setCopyPath, checking, valid, offline, errors, seats, onGo, onSaved, followUp, setFollowUp, onClose, onYaml, onHome } = props;
  const { client, status: meshStatus, confirm, refreshStatus, projectId } = useMesh();
  const { facts } = useMission();
  const projects = useProjectsOptional();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  const reopened = mode === "after" && !!followUp;
  const [phase, setPhase] = useState<"review" | "saving" | "saved">(reopened ? "saved" : "review");
  const [fresh, setFresh] = useState<{ state: "loading" | "ok" | "failed"; raw: any | null }>({ state: mode === "file" ? "loading" : "ok", raw: null });
  const [failure, setFailure] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState<Saved | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [restartBusy, setRestartBusy] = useState(false);
  const [restartFailure, setRestartFailure] = useState<string | null>(null);
  // What was saved: this sheet's own save, or, reopened, the follow-up the Designer kept. What was done about the mission since lives in the follow-up.
  const saved: Saved | null = mode === "after" ? followUp?.saved ?? null : justSaved;
  const applied: ApplyOutcome | null = saved?.running ? followUp?.applied ?? null : null;
  const restarted = saved?.running ? followUp?.restarted === true : false;

  // Focus moves into the sheet when it opens and back to the button that opened it when it closes: keyboard users are not left behind it.
  useEffect(() => {
    const from = document.activeElement;
    opener.current = from instanceof HTMLElement && from !== document.body ? from : null;
    rootRef.current?.focus();
    return () => { if (opener.current?.isConnected) opener.current.focus(); };
  }, []);

  // The file as it is on disk right now, so the review says what a save would really change and whether someone else changed it meanwhile.
  useEffect(() => {
    if (mode !== "file") return;
    let dead = false;
    void (async () => {
      try {
        const { json } = await client.api("GET", "/config");
        if (!dead) setFresh(json?.raw ? { state: "ok", raw: json.raw } : { state: "failed", raw: null });
      } catch {
        if (!dead) setFresh({ state: "failed", raw: null });
      }
    })();
    return () => { dead = true; };
  }, [mode, client]);

  const reference = mode === "file" ? (fresh.state === "ok" ? fresh.raw : baseline) : baseline;
  // The draft is edited in place, so identity does not change when it does: `rev` is what says it is time to look again.
  const payload = useMemo(() => {
    void rev;
    return savePayload(model, baseline);
  }, [model, baseline, rev]);
  const changes = useMemo(() => diffMesh(payload, reference), [payload, reference]);
  const outsideChanges = useMemo(() => (mode === "file" && fresh.state === "ok" && baseline && !sameMesh(fresh.raw, baseline) ? diffMesh(fresh.raw, baseline) : []), [mode, fresh, baseline]);
  const stale = outsideChanges.length > 0;

  const target = mode === "file" ? runningPath : copyPath.trim();
  const landsOnRunning = mode === "copy" && !!runningPath && !!target && saveLandsOnRunning(target, runningPath);
  const projectDir = runningPath ? shortPath(runningPath.slice(0, Math.max(0, runningPath.lastIndexOf("/")) || 1), 3).text : "";

  const save = async (): Promise<void> => {
    if (phase === "saving") return;
    setPhase("saving");
    setFailure(null);
    try {
      const { status, json } = await client.post("/config/save", { config: payload, path: target });
      if (status !== 200) {
        const why = (json?.errors || [json?.error, "The server refused the save."]).filter(Boolean).join(" ");
        setFailure(String(why).slice(0, 400));
        setPhase("review");
        return;
      }
      const running = mode === "file" || (!!runningPath && String(json.savedTo) === runningPath);
      const d = json.drift;
      const driftKnown = running && !!d && typeof d === "object";
      const drift: Drift | null = driftKnown ? { mutations: d.mutations ?? [], problems: d.problems ?? [] } : null;
      const result: Saved = { path: String(json.savedTo), archived: json.archived ?? null, warnings: Array.isArray(json.saveWarnings) ? json.saveWarnings : [], running, drift, driftKnown, payload: deepCopy(payload) };
      setJustSaved(result);
      if (running) setFollowUp({ saved: result, applied: null, restarted: false, at: Date.now(), dismissed: false });
      setPhase("saved");
      onSaved({ path: String(json.savedTo), running, payload: deepCopy(payload) });
    } catch (err) {
      // api() rethrows transport failures; without this a dead server made the button look like a no-op.
      setFailure(err instanceof Error ? err.message : "The server did not answer.");
      setPhase("review");
    }
  };

  const report = useMemo(() => classifyDrift(saved?.drift ?? null), [saved]);
  const meshId = String(meshStatus?.meshId ?? "");
  const confirmation = useMemo(() => (report.apply.length ? confirmationFor(report.apply, meshId) : null), [report.apply, meshId]);
  const confirmed = confirmationSatisfied(confirmation, confirmText);

  const apply = async (): Promise<void> => {
    if (!report.apply.length || applyBusy) return;
    setApplyBusy(true);
    try {
      const { status, json } = await client.post("/designer/staged/apply", { mutations: report.apply, confirmId: confirmText });
      const outcome = readApply(status, json, report.apply.length);
      if (followUp) setFollowUp({ ...followUp, applied: outcome });
      void refreshStatus();
    } catch (err) {
      const outcome: ApplyOutcome = { ok: false, applied: 0, total: report.apply.length, lines: [], summary: `${err instanceof Error ? err.message : "The server did not answer."} Nothing was applied.` };
      if (followUp) setFollowUp({ ...followUp, applied: outcome });
    } finally {
      setApplyBusy(false);
    }
  };

  const canRestart = !!projects && projects.hasRegistry !== false && !!(projectId ?? projects.activeId);
  const demo = isScriptedDemo(saved?.payload);
  const restart = async (): Promise<void> => {
    const id = projectId ?? projects?.activeId;
    if (!projects || !id || restartBusy) return;
    const mode0 = facts.parked ? "parked" : "live";
    const n = facts.working;
    const turns = n === 0
      ? "No seat is in the middle of a turn."
      // The server's own words for it (packages/core supervisor): a turn the restart interrupts is ended as "interrupted", and its spend is billed by the model
      // provider whether or not the mission's ledger recorded it. Nothing here says the turn is run again: whether the seat is woken again is the mission's decision.
      : `${n} ${n === 1 ? "seat is" : "seats are"} in the middle of a turn. ${n === 1 ? "That turn is" : "Those turns are"} stopped before ${n === 1 ? "it finishes" : "they finish"}${demo ? "." : ", so whatever was not yet done is not done. The tokens already used are still charged by the model provider."}`;
    const answer = await confirm({
      title: "Restart this project?",
      body: [
        "The project process stops and starts again, and reads mesh.yaml.",
        demo
          ? "This is the scripted demo, which the product starts again from nothing every time. Its progress so far is cleared, and it reads the goal and the done-when checks from the file."
          : "Seats and budgets are picked up from the file. The mission keeps its history and its goal.",
        turns,
        ...(demo ? [] : [`It comes back ${mode0}, as it is now.`]),
      ],
      confirmLabel: "Restart the project",
    });
    if (answer === null) return;
    setRestartBusy(true);
    setRestartFailure(null);
    try {
      // The host's answer: refused outright (`ok: false`, with its own reason), or the project's summary after the restart.
      const res = await projects.restartProject(id);
      const down = res.ok && (res.project.status === "crashed" || res.project.status === "locked" || res.project.status === "error");
      if (!res.ok) {
        setRestartFailure(res.reason || "The host refused the restart.");
      } else if (down) {
        setRestartFailure(res.project.error?.detail ?? "The project did not come back. Check its tab in the strip above.");
      } else {
        if (followUp) setFollowUp({ ...followUp, restarted: true });
        void refreshStatus();
      }
    } catch {
      setRestartFailure("The host did not answer the restart request.");
    } finally {
      setRestartBusy(false);
    }
  };

  // What is still to do for the running mission, given the apply and the restart so far (save.ts says how each one changes it).
  const remaining = saved ? remainingAfter(saved, { applied: applied?.ok === true, restarted }) : null;
  const stillToApply = remaining?.offered ?? [];
  const restartItems = remaining?.restart ?? [];

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };

  const fileName = baseName((phase === "saved" && saved?.path) || target || "mesh.yaml");
  const title = phase === "saved" ? (saved?.running ? `Saved to ${fileName}` : "Saved a copy") : mode === "file" ? `Save changes to ${fileName}` : "Save a copy";
  const canSave = valid && !checking && !offline && phase !== "saving" && !!target && !landsOnRunning && (mode === "copy" || changes.length > 0);

  return (
    <div className="ms-sheet" role="dialog" aria-modal="false" aria-labelledby="ms-sheet-title" ref={rootRef} tabIndex={-1} onKeyDown={onKey}>
      <div className="ms-sheet-head">
        <h3 id="ms-sheet-title">{phase === "saved" ? <Icon name="check" size={16} className="ms-ok" /> : null}{title}</h3>
        <CloseButton label={phase === "saved" ? "Close" : "Close without saving"} onClick={onClose} />
      </div>

      {phase !== "saved" ? (
        <div className="ms-sheet-body">
          {mode === "copy" ? (
            <div className="field">
              <label htmlFor="ms-copy-path">Save the copy as</label>
              <Input id="ms-copy-path" mono value={copyPath} placeholder="copies/my-mesh/mesh.yaml" aria-invalid={landsOnRunning || !target ? true : undefined} onChange={(e) => setCopyPath(e.target.value)} />
              <span className={`ms-hint${landsOnRunning ? " bad" : ""}`} role={landsOnRunning ? "alert" : undefined}>
                {landsOnRunning
                  ? "That is the project's own mesh.yaml. Use Save changes to write it."
                  : <>Relative to the project folder{projectDir ? <> (<span className="mono">{projectDir}</span>)</> : ""}. It is created if it does not exist. Role prompts the seats refer to are created beside it when missing.</>}
              </span>
            </div>
          ) : (
            <p className="ms-file-line"><PathLabel path={runningPath} /></p>
          )}

          {mode === "file" && stale ? (
            <div className="ms-note warn" role="alert">
              <b>mesh.yaml changed since you opened the Designer.</b> Another tab or an editor saved it. Saving now replaces those changes with your draft. They are:
              <ChangeList changes={outsideChanges} label="Changes made to the file elsewhere" />
            </div>
          ) : null}
          {mode === "file" && fresh.state === "failed" ? <p className="ms-note warn">Could not read mesh.yaml again just now, so this compares with the version you opened.</p> : null}

          {!valid && !checking && !offline ? (
            <div className="ms-note bad" role="alert">
              <b>{errors.length} {errors.length === 1 ? "error blocks" : "errors block"} saving.</b> Fix {errors.length === 1 ? "it" : "them"} first.
              <ul className="ms-issues">
                {errors.slice(0, 4).map((e) => {
                  const w = locateIssue(e, seats);
                  return (
                    <li key={e} className="ms-issue error">
                      <Icon name="alert" size={16} />
                      <span className="ms-issue-text">{e}</span>
                      {w.editable ? <Button variant="small" onClick={() => { onGo(w); onClose(); }}>{whereLabel(w)}</Button> : null}
                    </li>
                  );
                })}
              </ul>
              {errors.length > 4 ? <span className="ms-hint">and {errors.length - 4} more, in the checks.</span> : null}
            </div>
          ) : null}
          {offline ? <p className="ms-note warn">Could not reach the server to check the draft, so saving is paused.</p> : null}

          {mode === "file" || changes.length ? (
            <section aria-label="What will change in the file">
              <h4>{mode === "file" ? "What changes in the file" : "How the copy differs from mesh.yaml"}</h4>
              {changes.length ? <ChangeList changes={changes} label="Changes to the file" /> : <p className="ms-hint">{mode === "file" ? "Nothing: the draft matches mesh.yaml." : "It is the same as mesh.yaml."}</p>}
            </section>
          ) : null}

          <section aria-label="What saving does">
            <h4>What saving does</h4>
            <ul className="ms-facts">
              {mode === "file" ? (
                <>
                  <li>It rewrites the whole file from the draft. Comments in the file are not kept.</li>
                  <li>The file it replaces is kept first, in <span className="mono">.mesh-versions</span> beside it.</li>
                </>
              ) : (
                <>
                  <li>It writes a whole new file from the draft. Comments in mesh.yaml are not carried over.</li>
                  <li>If a file is already there, it is kept first, in <span className="mono">.mesh-versions</span> beside it.</li>
                </>
              )}
              {mode === "file"
                ? <li><b>It does not change the running mission.</b> The mission read mesh.yaml when it started. After the save, this sheet says what can change live and what needs a restart.</li>
                : <li><b>It does not change mesh.yaml or the running mission.</b> The copy is a new file.</li>}
            </ul>
          </section>

          {failure ? <p className="ms-note bad" role="alert"><b>The save failed.</b> {failure}</p> : null}

          <div className="ms-sheet-acts">
            <Button variant="primary" icon="check" disabled={!canSave} onClick={() => void save()}>
              {phase === "saving" ? "Saving…" : mode === "file" ? `Save to ${fileName}` : "Save the copy"}
            </Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            {mode === "file" && changes.length === 0 && valid ? <span className="ms-hint">Nothing to save.</span> : null}
          </div>
        </div>
      ) : saved ? (
        <div className="ms-sheet-body">
          <p className="sr-only" role="status">{saved.running ? `Saved to ${fileName}.` : `Saved a copy at ${shortPath(saved.path, 3).text}.`}</p>
          <p className="ms-file-line">
            <PathLabel path={saved.path} />
            {saved.archived ? <span className="ms-hint">The previous file is kept as <span className="mono" title={saved.archived}>{shortPath(saved.archived, 2).text}</span>.</span> : null}
          </p>

          {saved.warnings.length ? (
            <div className="ms-note warn" role="status">
              <b>{saved.warnings.length} prompt {saved.warnings.length === 1 ? "file is" : "files are"} missing next to this save.</b>
              <ul>{saved.warnings.map((w) => <li key={w} className="mono">{w}</li>)}</ul>
              <span>Saving again will not fix {saved.warnings.length === 1 ? "it" : "them"}: the path is read from the folder this save wrote into. Create the file, or point the seat&rsquo;s prompt at a path inside that folder. The config itself saved fine.</span>
            </div>
          ) : null}

          {!saved.running ? (
            <CopyNext path={saved.path} />
          ) : (
            <MissionNext
              saved={saved} report={report} stillToApply={stillToApply} restartItems={restartItems} restarted={restarted}
              confirmation={confirmation} confirmText={confirmText} setConfirmText={setConfirmText} confirmed={confirmed}
              applyBusy={applyBusy} applied={applied} onApply={() => void apply()}
              canRestart={canRestart} restartBusy={restartBusy} restartFailure={restartFailure} onRestart={() => void restart()}
              demo={demo} mutationsCtx={{ model }}
            />
          )}

          <div className="ms-sheet-acts">
            <Button variant="soft" icon="files" onClick={onYaml}>View YAML</Button>
            {saved.running ? <Button variant="soft" onClick={onHome}>Go to the Overview</Button> : null}
            <Button variant="ghost" onClick={onClose}>Done</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- after a save to a copy */

function CopyNext({ path }: { path: string }): React.JSX.Element {
  const { toast } = useMesh();
  const cmd = `curule run ${path}`;
  return (
    <section aria-label="What to do with the copy">
      <p><b>mesh.yaml and the running mission are unchanged.</b> The copy is a file of its own.</p>
      <p className="ms-hint">To run it, start it from a terminal, or add its folder as a project with the plus beside the project tabs.</p>
      <div className="ms-cmd">
        <code>{cmd}</code>
        <Button variant="small" icon="copy" onClick={() => { void navigator.clipboard?.writeText(cmd).then(() => toast("Copied", cmd, "ok"), () => toast("Copy blocked", "Select the command and copy it by hand.", "warn")); }}>Copy</Button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- after a save to the running file */

function MissionNext({
  saved, report, stillToApply, restartItems, restarted, confirmation, confirmText, setConfirmText, confirmed, applyBusy, applied, onApply,
  canRestart, restartBusy, restartFailure, onRestart, demo, mutationsCtx,
}: {
  saved: Saved;
  report: ReturnType<typeof classifyDrift>;
  stillToApply: StagedMutation[];
  restartItems: string[];
  restarted: boolean;
  confirmation: ReturnType<typeof confirmationFor>;
  confirmText: string;
  setConfirmText: (s: string) => void;
  confirmed: boolean;
  applyBusy: boolean;
  applied: ApplyOutcome | null;
  onApply: () => void;
  canRestart: boolean;
  restartBusy: boolean;
  restartFailure: string | null;
  onRestart: () => void;
  /** The scripted demo, which starts again from nothing on a restart rather than resuming. */
  demo: boolean;
  mutationsCtx: { model: any };
}): React.JSX.Element {
  const lines = stillToApply.flatMap((m) => summarizeMutation(m, mutationsCtx));
  const done = applied?.ok === true;
  // Once an apply has landed or the project has restarted, "has not changed yet" is no longer true, and what remains is only what is listed.
  const acted = done || restarted;
  const remaining = (done ? 0 : stillToApply.length) + restartItems.length + report.notes.length;

  if (!saved.driftKnown) {
    return (
      <section aria-label="The running mission">
        <p><b>The server did not compare the running mission with the file.</b> The file is saved. A restart reads it again.</p>
        {canRestart ? (
          <div className="ms-sheet-acts">
            <Button variant="soft" icon="refresh" disabled={restartBusy} onClick={onRestart}>{restartBusy ? "Restarting…" : "Restart the project"}</Button>
          </div>
        ) : null}
        {restartFailure ? <p className="ms-note bad" role="alert"><b>The restart did not finish.</b> {restartFailure}</p> : null}
      </section>
    );
  }
  if (report.noMission) {
    return (
      <section aria-label="The running mission">
        <p><b>No mission is running.</b> The next start reads this file.</p>
      </section>
    );
  }
  return (
    <section className="ms-next" aria-label="The running mission">
      {acted ? null : <p><b>The running mission has not changed yet.</b> It read mesh.yaml when it started. What is left:</p>}

      {stillToApply.length ? (
        <div className="ms-block">
          <h4>{done ? "Applied" : "Apply now"}: {stillToApply.length} {stillToApply.length === 1 ? "change" : "changes"}</h4>
          <p className="ms-hint">These can change a running mission without a restart. They go through the same route as the designer&rsquo;s live changes, and the mission can refuse one.</p>
          <ul className="ms-changes">{lines.map((l, i) => <li key={`${i}-${l}`} className="ms-chg change"><span className="ms-chg-op" aria-hidden="true"><Icon name="arrow-right" size={12} /></span><span>{l}</span></li>)}</ul>
          {confirmation && !done ? (
            <div className="ms-confirm">
              <p className="ms-note bad">{confirmation.prompt}</p>
              <Input aria-label={`Type ${confirmation.word} to confirm`} placeholder={confirmation.word} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} />
            </div>
          ) : null}
          <div className="ms-sheet-acts">
            <Button variant="primary" disabled={applyBusy || done || !confirmed} onClick={onApply}>
              {applyBusy ? "Applying…" : done ? "Applied" : `Apply ${stillToApply.length} ${stillToApply.length === 1 ? "change" : "changes"} to the mission`}
            </Button>
          </div>
          {applied ? (
            <div className={`ms-note ${applied.ok ? "ok" : "bad"}`} role={applied.ok ? "status" : "alert"}>
              <b>{applied.summary}</b>
              {applied.lines.length ? (
                <ul className="ms-results">
                  {applied.lines.map((l, i) => (
                    <li key={`${i}-${l.kind}`} className={l.ok ? "ok" : "bad"}>
                      <Icon name={l.ok ? "check" : "alert"} size={14} />
                      <span><b>{l.kind}</b> {l.detail}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {!applied.ok ? <span>The changes that did apply stay applied. Fix the refused one in the draft and save again, or leave the mission as it is.</span> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {restartItems.length ? (
        <div className="ms-block">
          <h4>Needs a restart: {restartItems.length} {restartItems.length === 1 ? "thing" : "things"}</h4>
          <ul className="ms-changes">{restartItems.map((t) => <li key={t} className="ms-chg change"><span className="ms-chg-op" aria-hidden="true"><Icon name="refresh" size={12} /></span><span>{t}</span></li>)}</ul>
          {canRestart ? (
            <>
              <p className="ms-hint with-icon">
                <Icon name="host" size={14} />
                <span>
                  The host restarts this project alone and the others keep running. A restart reads mesh.yaml again, so it picks up seat definitions and budgets.{" "}
                  {demo
                    ? "The scripted demo starts again from nothing, so its progress is cleared and it reads the goal and the done-when checks from the file too."
                    : "A resumed mission keeps its goal and its done-when checks: change those with Apply now."}
                </span>
              </p>
              <div className="ms-sheet-acts">
                <Button variant="soft" icon="refresh" disabled={restartBusy} onClick={onRestart}>{restartBusy ? "Restarting…" : "Restart the project"}</Button>
              </div>
              {restartFailure ? <p className="ms-note bad" role="alert"><b>The restart did not finish.</b> {restartFailure}</p> : null}
            </>
          ) : (
            <p className="ms-hint">This console runs one mesh on its own, so it cannot restart itself. Stop it and start it again with <span className="mono">curule console</span> or <span className="mono">curule run</span> on this file.</p>
          )}
        </div>
      ) : null}

      {restarted ? (
        <p className="ms-note ok" role="status">
          <b>The project restarted and read mesh.yaml.</b>{" "}
          {demo ? "The scripted demo began again from nothing, so everything in it is the file\u2019s." : "Its seats and budgets are the file\u2019s."}
        </p>
      ) : null}

      {report.notes.length ? (
        <div className="ms-block">
          <h4>Not carried to the running mission</h4>
          <ul className="ms-changes">{report.notes.map((t) => <li key={t} className="ms-chg change"><span className="ms-chg-op" aria-hidden="true"><Icon name="info" size={12} /></span><span>{t}</span></li>)}</ul>
        </div>
      ) : null}

      {remaining === 0 ? (
        <p><b>The running mission {acted ? "now matches" : "matches"} the file.</b></p>
      ) : null}
    </section>
  );
}
