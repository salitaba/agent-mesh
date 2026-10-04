/**
 * Designer: the workbench where a person describes their organization.
 *
 * Topology-first: drag, wire and inspect a live org chart instead of filling forms. The same schema contract and server-side validation
 * as the running mesh; drafts survive view switches (module singleton) and reloads (localStorage).
 *
 * This component owns the draft's life: load, edit, check, save. What it does not own lives next to it, so each part can be read (and, where
 * it carries a claim, tested) alone: ./edits (what an edit to a seat or a wire does), ./diff (what differs, what a save writes), ./history
 * (undo), ./topology (canvas arithmetic), ./locate (where a message is about), ./save (what a save leaves to do), ./SavePanel (the bar and
 * the sheet), ./Topology and ./SeatList (the canvas and the phone's list), ./Inspector and ./panels (the forms).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { fmt } from "../format";
import { useMesh } from "../store";
import { Banner, Button, ErrorState, PageHeader, useDismissable, type MenuItem, Menu } from "../components";
import { Icon } from "../icons";
import { list as listCommands, register, takePendingAgent, takePendingProposal, unregister, getVersion, subscribe } from "../commands";
import { useFocusMode, useMedia } from "../shell";
import { ChecksButton, ChecksPanel, DraftChip, ImportDialog, TemplateDialog, YamlSlide } from "./chrome";
import { SetupGuide, needsGuide } from "./Guide";
import Inspector from "./Inspector";
import SeatList from "./SeatList";
import Topology, { type ConnectResult } from "./Topology";
import { rememberFollowUp, rememberedFollowUp, SaveBar, SaveSheet, type SheetMode } from "./SavePanel";
import { ToolButton, CloseButton } from "./ui";
import { diffMesh, savePayload } from "./diff";
import { addSeat, duplicateSeat, hasWire, isPlaceholderRole, removeSeat, renameSeat, seatIds, setWire, toggleContact, toggleGrant, toggleStart, wiresOf } from "./edits";
import { labels as historyLabels, record, redo as redoStep, undo as undoStep, emptyHistory } from "./history";
import { locateIssue, type Where } from "./locate";
import { deepCopy, densure, goalIsPlaceholder, TEMPLATES, type Template } from "./model";
import { draftStatus, lagOf, type FollowUp } from "./save";
import { clearStored, commitDraft, getDraftSnapshot, guideHidden, loadLayout, readStored, ringLayout, saveLayout, setGuideHidden, storeDraft, useDraft, type DraftState } from "./storage";
import { cardFor, freeSpot, stageHeight } from "./topology";
import type { Advice, DCtx, Pos, Reveal, Tab } from "./types";
import "./designer.css";

/** Debounced after each edit: re-validate, persist draft + node layout. */
const SAVE_DELAY_MS = 550;

/** The Designer's own collapse points, the same values as the CSS media queries (the breakpoint ladder: 1280 and 760). */
const COMPACT = "(max-width: 1280px)";
const PHONE = "(max-width: 760px)";

/** The size the stage is assumed to be when a new seat is placed before the canvas has said what size it really is. */
const NOMINAL_STAGE = { w: 760, h: stageHeight(760) };

interface DesignerCommands {
  addSeat: () => void;
  undo: () => void;
  redo: () => void;
  validate: () => Promise<void>;
  openSeat: (id: string) => void;
  go: (w: Where) => void;
  save: () => void;
  applyProposal: (model: unknown) => void;
}
const NO_COMMANDS: DesignerCommands = {
  addSeat: () => {}, undo: () => {}, redo: () => {}, validate: async () => {}, openSeat: () => {}, go: () => {}, save: () => {}, applyProposal: () => {},
};

/** What the control that has focus is called, so a step in the undo list can say what it was ("Edited role"), and a burst of typing in one field is one step. */
function describeEdit(el: Element | null): { label: string; key?: string } {
  if (!(el instanceof HTMLElement)) return { label: "Edited the draft" };
  const labelled = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.labels?.[0]?.textContent : null;
  const name = (el.getAttribute("aria-label") || labelled || el.closest("[role=group]")?.getAttribute("aria-label") || el.dataset.field || "").replace(/\s+/g, " ").trim().toLowerCase();
  const typing = (el instanceof HTMLInputElement && /^(text|number|search|)$/.test(el.type)) || el instanceof HTMLTextAreaElement;
  return { label: name ? `Edited ${name}` : "Edited the draft", key: typing ? el.id || name || "field" : undefined };
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "mesh";

export default function Designer(): React.JSX.Element {
  const { vocab, toast, setView, client, status: meshStatus, confirm, projectId } = useMesh();
  // Shell-owned: this component only paints the mode onto its regions.
  const { focusMode } = useFocusMode();
  const draft = useDraft();
  const { model: m, cur, layout, runningPath, runningRaw, copyPath, loaded, history } = draft;
  const ready = loaded && !!m;
  const compact = useMedia(COMPACT);
  const listMode = useMedia(PHONE);

  const [tab, setTab] = useState<Tab>("crew");
  const [rev, setRev] = useState(0);
  const [result, setResult] = useState<{ status: number; json: any } | null>(null);
  const [checking, setChecking] = useState(true);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lastYaml, setLastYaml] = useState<string | null>(null);
  const [checksOpen, setChecksOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importError, setImportError] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  // The last save to the running file and what has been done about the running mission since. The sheet that shows it can be closed, and the bar
  // goes on saying the mission is behind the file until it is not; it is kept per project across visits to other views.
  const projectKey = String(projectId ?? "");
  const [followUp, setFollowUpState] = useState<FollowUp | null>(() => rememberedFollowUp(projectKey));
  const setFollowUp = useCallback((f: FollowUp | null) => { rememberFollowUp(projectKey, f); setFollowUpState(f); }, [projectKey]);
  const lag = lagOf(followUp);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [starter, setStarter] = useState<string | null>(null);
  const [guideOff, setGuideOff] = useState(guideHidden);
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadTick, setLoadTick] = useState(0);

  const checksBtnRef = useRef<HTMLButtonElement | null>(null);
  const checksAnchor = useRef<HTMLDivElement | null>(null);
  const popRef = useDismissable<HTMLDivElement>(checksOpen, () => setChecksOpen(false));
  const inspRef = useRef<HTMLDivElement | null>(null);
  const inspReturn = useRef<HTMLElement | null>(null);
  const inspWasOpen = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const validateSeq = useRef(0);
  // The draft as it was before the current edit: what an undo step restores, since the panels change the model and then say so.
  const before = useRef<{ model: any; cur: string | null } | null>(null);
  const cmdRef = useRef<DesignerCommands>(NO_COMMANDS);
  const cmdVersion = useSyncExternalStore(subscribe, getVersion);

  /* ---------------- the inspector: a column on a wide screen, a drawer below it ---------------- */

  const openInspector = useCallback(() => {
    setCtxOpen(true);
    if (!compact) return;
    const opener = document.activeElement;
    // Never record an opener inside the drawer: links in the panels switch the selection and would strand focus on a hidden element on close.
    if (opener instanceof HTMLElement && opener !== document.body && !inspRef.current?.contains(opener)) inspReturn.current = opener;
  }, [compact]);
  useEffect(() => {
    if (!compact) return;
    if (ctxOpen && !inspWasOpen.current) {
      const panel = inspRef.current?.querySelector<HTMLElement>(".ms-insp") ?? inspRef.current;
      (panel?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea, button, a[href]") ?? panel)?.focus();
    } else if (!ctxOpen && inspWasOpen.current) {
      inspReturn.current?.focus();
      inspReturn.current = null;
    }
    inspWasOpen.current = ctxOpen;
  }, [ctxOpen, compact]);

  // Entering focus mode hides the inspector. If focus was inside it, rehome it on the toggle instead of stranding it in a hidden subtree.
  useEffect(() => {
    if (!focusMode) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".ms-side, .ms-bar")) document.getElementById("ms-focus-toggle")?.focus();
  }, [focusMode]);

  /* ---------------- validation, and what is written ---------------- */

  const validate = useCallback(async () => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    const seq = ++validateSeq.current;
    setChecking(true);
    try {
      // The server checks, and renders, what a save would write: the file plus the edits, never the padding the panels need.
      const { status, json } = await client.post("/config/validate", { config: savePayload(d.model, d.runningRaw) });
      if (seq !== validateSeq.current) return;
      setResult({ status, json });
      setCheckFailed(false);
      if (status === 200 && json?.yaml) setLastYaml(json.yaml);
    } catch {
      if (seq === validateSeq.current) setCheckFailed(true);
    } finally {
      if (seq === validateSeq.current) setChecking(false);
    }
  }, [client]);

  const persistLayout = useCallback(() => {
    const d = getDraftSnapshot();
    if (d.model) saveLayout(d.model.mesh?.id || "", d.layout, seatIds(d.model));
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void validate();
      storeDraft();
      persistLayout();
    }, SAVE_DELAY_MS);
  }, [validate, persistLayout]);

  /**
   * Call after any change to the draft. `label` names a step that is not a keystroke; without one the step is named for the control that
   * has focus, and typing in one field is one step however long it takes.
   */
  const touch = useCallback((label?: string) => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    const named = label ? { label, key: undefined } : describeEdit(document.activeElement);
    const was = before.current;
    if (was) commitDraft((p) => ({ history: record(p.history, { label: named.label, model: was.model, cur: was.cur }, { key: named.key }) }));
    before.current = { model: deepCopy(d.model), cur: d.cur };
    commitDraft({});
    setRev((n) => n + 1);
    schedule();
  }, [schedule]);

  /** Put a snapshot back as the draft, as undo and redo do. */
  const restore = useCallback((snap: { model: any; cur: string | null }) => {
    commitDraft({ model: deepCopy(snap.model), cur: snap.cur });
    before.current = { model: deepCopy(snap.model), cur: snap.cur };
    setRev((n) => n + 1);
    schedule();
  }, [schedule]);

  const doUndo = useCallback(() => {
    const d = getDraftSnapshot();
    const step = d.model ? undoStep(d.history, { model: d.model, cur: d.cur }) : null;
    if (!step) return;
    commitDraft({ history: step.history });
    restore(step.restore);
    toast("Undone", step.restore.label, "ok", { label: "Redo", run: () => cmdRef.current.redo() });
  }, [restore, toast]);
  const doRedo = useCallback(() => {
    const d = getDraftSnapshot();
    const step = d.model ? redoStep(d.history, { model: d.model, cur: d.cur }) : null;
    if (!step) return;
    commitDraft({ history: step.history });
    restore(step.restore);
    toast("Redone", step.restore.label, "ok");
  }, [restore, toast]);

  /* ---------------- first visit: browser draft > the file > a starter template ---------------- */

  useEffect(() => {
    let dead = false;
    void (async () => {
      if (getDraftSnapshot().loaded && getDraftSnapshot().model) {
        // A draft that outlived a visit to another view: this mount has not checked it, and without a check the page stays on "Checking" and cannot save.
        void validate();
        return;
      }
      setLoadError(null);
      const applyModel = (raw: any, filePath: string | null) => {
        const model = deepCopy(raw);
        densure(model);
        const prev = getDraftSnapshot();
        const patch: Partial<DraftState> = {
          model,
          cur: prev.cur && model.agents[prev.cur] ? prev.cur : Object.keys(model.agents)[0] || null,
          layout: loadLayout(model.mesh?.id || "", Object.keys(model.agents)),
          history: emptyHistory(),
        };
        if (filePath !== null) patch.runningPath = filePath;
        commitDraft(patch);
      };
      let file: any = null;
      let filePath = "";
      let failed: string | null = null;
      try {
        const { json, timeout } = await client.api("GET", "/config");
        if (timeout) failed = "The server did not answer in time.";
        else if (json?.raw) { file = json.raw; filePath = json.filePath || ""; }
      } catch (err) {
        failed = err instanceof Error && err.message ? err.message : "The server did not answer.";
      }
      if (dead) return;
      if (failed) { setLoadError(failed); return; }
      const stored = readStored();
      // A browser draft beats the file only when it differs from it.
      if (stored && file && diffMesh(stored.model, file).length > 0) {
        applyModel(stored.model, filePath || null);
        commitDraft({ runningRaw: deepCopy(file), copyPath: stored.copyPath?.trim() || "" });
        setRestoredAt(stored.ts || Date.now());
      } else if (file) {
        applyModel(file, filePath);
        commitDraft({ runningRaw: deepCopy(file) });
        clearStored();
      } else if (stored) {
        // No file to compare with (a new mesh): the browser draft is all there is.
        applyModel(stored.model, null);
        commitDraft({ runningRaw: null, runningPath: "", copyPath: stored.copyPath?.trim() || "" });
        setRestoredAt(stored.ts || Date.now());
      } else {
        applyModel(TEMPLATES[1]!.make(), null);
        commitDraft({ runningRaw: null, runningPath: "" });
        setStarter(TEMPLATES[1]!.name);
      }
      commitDraft({ loaded: true });
      const d = getDraftSnapshot();
      before.current = { model: deepCopy(d.model), cur: d.cur };
      setRev((n) => n + 1);
      void validate();
    })();
    return () => {
      dead = true;
      if (timer.current) clearTimeout(timer.current);
      // A stale closure must not run commands against an unmounted workbench.
      cmdRef.current = NO_COMMANDS;
    };
  }, [client, validate, loadTick]);

  // A draft that survived a visit to another view is the baseline for the next edit's undo step.
  useEffect(() => {
    if (ready && !before.current) before.current = { model: deepCopy(m), cur };
  }, [ready, m, cur]);

  /* ---------------- derived ---------------- */

  // The draft is edited in place, so its identity does not change when it does: `rev` is what says it is time to read it again.
  const ids = useMemo(() => { void rev; return m ? seatIds(m) : []; }, [m, rev]);
  const current = ids.includes(cur ?? "") ? cur : null;
  const wires = useMemo(() => { void rev; return m ? wiresOf(m) : []; }, [m, rev]);
  const starts = useMemo(() => { void rev; return new Set<string>((m?.startup?.activate || []) as string[]); }, [m, rev]);
  const changes = useMemo(() => {
    void rev;
    return m && runningRaw ? diffMesh(savePayload(m, runningRaw), runningRaw) : [];
  }, [m, runningRaw, rev]);
  const status = draftStatus({ changes: changes.length, hasFile: !!runningRaw, restored: restoredAt !== null });
  const valid = result?.status === 200;
  const errors: string[] = useMemo(() => (result && result.status !== 200 ? (result.json?.errors || ["The server refused the draft."]).map(String) : []), [result]);
  const errTabs = useMemo(() => {
    const counts: Record<Tab, number> = { crew: 0, mesh: 0, policy: 0 };
    for (const e of errors) counts[locateIssue(e, ids).tab]++;
    return counts;
  }, [errors, ids]);
  const seatsWithErrors = useMemo(() => new Set(errors.map((e) => locateIssue(e, ids).seat).filter((s): s is string => !!s)), [errors, ids]);
  const problems = useCallback((id: string) => seatsWithErrors.has(id), [seatsWithErrors]);

  // Soft checks the server will not raise, and the server's own config-time warnings.
  const notes = useMemo(() => {
    void rev;
    const list: Advice[] = [];
    if (!m) return list;
    const serverWarnings: string[] = result && result.status === 200 && Array.isArray(result.json?.warnings) ? result.json.warnings : [];
    for (const w of serverWarnings) if (typeof w === "string") list.push({ level: "warn", tab: locateIssue(w, ids).tab, msg: w });
    // Gate satisfiability is not re-derived here: the server owns it (validateTransitionGates) and says it in `warnings`.
    if (goalIsPlaceholder(m.mesh?.goal)) list.push({ level: "warn", tab: "mesh", msg: "The goal is still the placeholder. Write what the team should deliver: every seat reads it on every turn." });
    for (const id of ids) {
      const role = String(m.agents[id]?.role ?? "").trim();
      if (isPlaceholderRole(role)) list.push({ level: "warn", tab: "crew", msg: `Seat '${id}' still has the placeholder role '${role}'. Say what it is for: a gate or a policy rule can name a role.` });
    }
    const sum = ids.reduce((n, id) => n + (m.budgets?.agent?.[id] ?? m.agents[id]?.budget?.tokens ?? 200000), 0);
    const cap = m.budgets?.mission?.tokens ?? 2000000;
    if (sum > cap) list.push({ level: "info", tab: "policy", msg: `Seat budgets add up to ${fmt(sum)} tokens, more than the ${fmt(cap)} mission cap. That is allowed. The mission cap is reached first, and then the mission stops and asks you to raise it.` });
    return list;
  }, [m, rev, result, ids]);

  /* ---------------- selecting, jumping ---------------- */

  const openSeat = useCallback((id: string) => {
    commitDraft({ cur: id });
    setTab("crew");
    openInspector();
  }, [openInspector]);
  // A pick on the canvas selects. On a wide screen the inspector is already there; below that it opens as a drawer.
  const selectSeat = useCallback((id: string) => {
    commitDraft({ cur: id });
    setTab("crew");
    if (compact) openInspector();
  }, [compact, openInspector]);

  const go = useCallback((w: Where) => {
    setChecksOpen(false);
    const d = getDraftSnapshot();
    if (w.seat && d.model?.agents?.[w.seat]) commitDraft({ cur: w.seat });
    else if (w.tab === "crew" && (!d.cur || !d.model?.agents?.[d.cur])) commitDraft({ cur: Object.keys(d.model?.agents || {})[0] || null });
    setTab(w.tab);
    openInspector();
    setReveal({ section: w.section, field: w.field, nonce: Date.now() });
  }, [openInspector]);

  /* ---------------- structural edits (each is one undo step) ---------------- */

  const placeSeat = (id: string, near?: Pos): void => {
    const d = getDraftSnapshot();
    const count = Object.keys(d.model?.agents || {}).length;
    const pos = freeSpot(d.layout, NOMINAL_STAGE, cardFor(count, NOMINAL_STAGE.w), near);
    commitDraft({ layout: { ...d.layout, [id]: pos } });
  };

  const doAddSeat = (): void => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    const id = addSeat(d.model);
    densure(d.model);
    placeSeat(id);
    commitDraft({ cur: id });
    setTab("crew");
    touch(`Added ${id}`);
    openInspector();
    setReveal({ section: "general", field: "role", nonce: Date.now(), select: true });
  };

  const doDuplicateSeat = (): void => {
    const d = getDraftSnapshot();
    if (!d.model || !current) return;
    const nid = duplicateSeat(d.model, current);
    if (!nid) return;
    const at = d.layout[current] ?? { x: 500, y: 300 };
    placeSeat(nid, { x: at.x + 60, y: at.y + 70 });
    commitDraft({ cur: nid });
    touch(`Copied ${current} as ${nid}`);
  };

  const doDeleteSeat = (): void => {
    const d = getDraftSnapshot();
    const id = current;
    if (!d.model || !id) return;
    const left = removeSeat(d.model, id);
    commitDraft({ cur: Object.keys(d.model.agents)[0] || null });
    touch(`Deleted ${id}`);
    const rules = left.rules + left.triage;
    // A delete cascades through wires, the start list, budgets, rules and triage. The undo is in the page header, which is not where the eye
    // is after a delete, so the confirmation carries the way back.
    toast("Seat deleted", `${id} and its wires were removed.${rules ? ` ${rules} policy or triage ${rules === 1 ? "rule still names" : "rules still name"} it: fix ${rules === 1 ? "it" : "them"} in the checks.` : ""}`, "warn", { label: `Undo: bring back ${id}`, run: () => cmdRef.current.undo() });
  };

  const doRenameSeat = (old: string, next: string): boolean => {
    const d = getDraftSnapshot();
    if (!d.model || !renameSeat(d.model, old, next)) return false;
    const to = next.trim();
    const L = { ...d.layout };
    if (L[old]) { L[to] = L[old]!; delete L[old]; }
    commitDraft({ layout: L, cur: to });
    touch(`Renamed ${old} to ${to}`);
    return true;
  };

  const doToggleStart = (id: string): void => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    const on = toggleStart(d.model, id);
    touch(`${id} ${on ? "now starts" : "no longer starts"} with the mission`);
  };

  const doToggleContact = (src: string, tgt: string): void => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    const on = toggleContact(d.model, src, tgt);
    touch(`${src} ${on ? "may now" : "may no longer"} message ${tgt}`);
  };
  const doToggleGrant = (id: string, sender: string): void => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    const on = toggleGrant(d.model, id, sender);
    touch(`${sender} ${on ? "may now" : "may no longer"} reach ${id}`);
  };

  const doConnect = (src: string, tgt: string): ConnectResult => {
    const d = getDraftSnapshot();
    if (!d.model || src === tgt || !d.model.agents[src] || !d.model.agents[tgt]) return "refused";
    if (hasWire(d.model, src, tgt)) return "exists";
    setWire(d.model, src, tgt, true);
    touch(`${src} may now message ${tgt}`);
    return "added";
  };
  const doCut = (cuts: Array<[string, string]>): void => {
    const d = getDraftSnapshot();
    if (!d.model) return;
    let n = 0;
    for (const [s, t] of cuts) if (setWire(d.model, s, t, false)) n++;
    if (n) touch(cuts.length === 1 ? `Cut ${cuts[0]![0]} to ${cuts[0]![1]}` : `Cut the wire between ${cuts[0]![0]} and ${cuts[0]![1]}`);
  };

  const setLayout = useCallback((next: SetStateAction<Record<string, Pos>>) => {
    commitDraft((prev) => ({ layout: typeof next === "function" ? next(prev.layout) : next }));
  }, []);
  const arrange = (): void => {
    commitDraft({ layout: ringLayout(ids) });
    persistLayout();
  };

  /* ---------------- replacing the whole draft: a template, an import, the file, an assistant proposal ---------------- */

  const unsavedNow = (): number => {
    const d = getDraftSnapshot();
    return d.model && d.runningRaw ? diffMesh(savePayload(d.model, d.runningRaw), d.runningRaw).length : 0;
  };

  /** Ask before a replacement throws away unsaved changes. The answer is a dialog, not a toast: it is the one irreversible-looking step in the page (it is undoable, and says so). */
  const okToReplace = async (what: string): Promise<boolean> => {
    const n = unsavedNow();
    if (!n) return true;
    const typed = await confirm({
      title: `Replace your draft with ${what}?`,
      body: [`You have ${n} unsaved ${n === 1 ? "change" : "changes"}. They are replaced, and nothing is written to mesh.yaml.`, "You can undo the replacement right after."],
      confirmLabel: "Replace the draft",
      danger: true,
    });
    return typed !== null;
  };

  const replaceDraft = useCallback((next: any, label: string, opts: { file?: { raw: any; path: string } } = {}): void => {
    const d = getDraftSnapshot();
    const model = deepCopy(next);
    densure(model);
    const nextIds = Object.keys(model.agents || {});
    commitDraft({
      history: d.model ? record(d.history, { label, model: deepCopy(d.model), cur: d.cur }) : d.history,
      model,
      cur: nextIds[0] ?? null,
      layout: loadLayout(model.mesh?.id || "", nextIds),
      ...(opts.file ? { runningRaw: deepCopy(opts.file.raw), runningPath: opts.file.path || d.runningPath } : {}),
    });
    before.current = { model: deepCopy(model), cur: nextIds[0] ?? null };
    setRestoredAt(null);
    setStarter(null);
    setRev((n) => n + 1);
    schedule();
  }, [schedule]);

  const startFromTemplate = async (t: Template): Promise<void> => {
    setTemplatesOpen(false);
    if (!(await okToReplace(`the ${t.name} template`))) return;
    replaceDraft(t.make(), `Started from the ${t.name} template`);
    toast("Template loaded", `${t.name}. Nothing is saved yet.`, "ok", { label: "Undo", run: () => cmdRef.current.undo() });
  };

  const reloadFromFile = async (): Promise<void> => {
    try {
      const { json } = await client.api("GET", "/config");
      if (!json?.raw) { toast("Nothing to reload", "The server did not return a mesh.yaml.", "bad"); return; }
      if (!(await okToReplace("mesh.yaml as it is on disk"))) return;
      replaceDraft(json.raw, "Reloaded mesh.yaml", { file: { raw: json.raw, path: json.filePath || "" } });
      clearStored();
      toast("Draft discarded", "The draft is mesh.yaml as it is on disk.", "ok", { label: "Undo", run: () => cmdRef.current.undo() });
    } catch (err) {
      toast("Could not reload", err instanceof Error ? err.message : "The server did not answer.", "bad");
    }
  };

  const importApply = async (): Promise<void> => {
    setImportBusy(true);
    setImportError("");
    try {
      const { status, json } = await client.post("/config/parse", { yaml: importText });
      if (status !== 200) { setImportError(((json?.errors || []) as string[]).join(" ").slice(0, 400) || "The server could not read that YAML."); return; }
      if (!(await okToReplace("the imported YAML"))) return;
      replaceDraft(json.config, "Imported YAML");
      setImportOpen(false);
      setImportText("");
      toast("YAML imported", "Nothing is saved yet. Undo is in the page header.", "ok", { label: "Undo", run: () => cmdRef.current.undo() });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "The server did not answer.");
    } finally {
      setImportBusy(false);
    }
  };

  /** A proposal from the assistant lands here as a whole config. It is one undo step, and nothing is saved. */
  const applyProposal = useCallback((model: unknown): void => {
    replaceDraft(model, "Applied the designer's proposal");
    toast("Draft updated", "The designer's proposal is in your draft. Nothing is saved yet.", "ok", { label: "Undo", run: () => cmdRef.current.undo() });
  }, [replaceDraft, toast]);

  /* ---------------- palette, keyboard ---------------- */

  const openYaml = useCallback(() => { setChecksOpen(false); setYamlOpen(true); }, []);
  const openSheet = useCallback((mode: SheetMode) => {
    setChecksOpen(false);
    setSheet(mode);
    if (mode === "copy" && !getDraftSnapshot().copyPath.trim()) {
      commitDraft({ copyPath: `copies/${slug(String(getDraftSnapshot().model?.mesh?.id || "mesh"))}/mesh.yaml` });
    }
  }, []);

  useEffect(() => {
    cmdRef.current = ready && m
      ? { addSeat: doAddSeat, undo: doUndo, redo: doRedo, validate, openSeat, go, save: () => openSheet(runningRaw ? "file" : "copy"), applyProposal }
      : NO_COMMANDS;
  });

  // A palette "jump to seat", or a proposal from the assistant, leaves a one-shot request in commands.ts. Take it as soon as this view can act on it.
  useEffect(() => {
    if (!ready) return;
    const current0 = getDraftSnapshot();
    if (!current0.model) return;
    const proposal = takePendingProposal();
    if (proposal) { cmdRef.current.applyProposal(proposal); return; }
    const id = takePendingAgent();
    if (!id || !current0.model.agents[id]) return;
    commitDraft({ cur: id });
    setTab("crew");
    openInspector();
  }, [ready, cmdVersion, openInspector]);

  useEffect(() => {
    if (!ready || !m) return;
    const hasErrors = errors.length > 0;
    register("designer", [
      { id: "designer.add-seat", label: "Add a seat", keywords: "hire new agent crew member", scope: "designer", run: () => cmdRef.current.addSeat() },
      { id: "designer.validate", label: "Run the checks", keywords: "validate verify config yaml", scope: "designer", run: () => void cmdRef.current.validate() },
      { id: "designer.undo", label: "Undo the last change to the draft", keywords: "revert", scope: "designer", run: () => cmdRef.current.undo() },
      { id: "designer.redo", label: "Redo", keywords: "revert", scope: "designer", run: () => cmdRef.current.redo() },
      { id: "designer.save", label: "Save changes", keywords: "write mesh.yaml review", scope: "designer", run: () => cmdRef.current.save() },
      ...(current ? [{ id: `designer.open-seat.${current}`, label: `Open the seat ${current}`, keywords: `inspect seat agent ${current}`, scope: "designer", run: () => cmdRef.current.openSeat(current) }] : []),
      ...(hasErrors ? [{ id: "designer.show-errors", label: `Show the errors (${errors.length})`, keywords: "problems invalid validation", scope: "designer", run: () => setChecksOpen(true) }] : []),
    ]);
    return () => unregister("designer");
  }, [ready, m, current, errors.length]);

  // Esc unwinds the topmost local layer first: the inspector drawer. The shell runs first and marks what it consumed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Undo and redo are the one pair every editor is expected to answer.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.defaultPrevented) {
        const el = document.activeElement;
        // Never steal it from a text field: there it means "undo my typing", which the browser already does better.
        if (el instanceof HTMLElement && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
        e.preventDefault();
        if (e.shiftKey) cmdRef.current.redo(); else cmdRef.current.undo();
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (compact && ctxOpen) { e.preventDefault(); setCtxOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxOpen, compact]);

  // Any click outside the checks popover closes it too.
  useEffect(() => {
    if (!checksOpen) return;
    const onDown = (e: PointerEvent) => { if (!checksAnchor.current?.contains(e.target as Node)) setChecksOpen(false); };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [checksOpen]);

  useEffect(() => {
    if (!changes.length) return;
    const warn = (e: BeforeUnloadEvent) => { storeDraft(); e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changes.length]);

  // Seats that arrived without a place on the canvas (an undo that brought one back, a proposal) are given one.
  useEffect(() => {
    if (!ready) return;
    const d = getDraftSnapshot();
    const missing = ids.filter((id) => !d.layout[id]);
    if (!missing.length) return;
    let next = { ...d.layout };
    const card = cardFor(ids.length, NOMINAL_STAGE.w);
    for (const id of missing) next = { ...next, [id]: freeSpot(next, NOMINAL_STAGE, card) };
    commitDraft({ layout: next });
  }, [ready, ids]);

  /* ---------------- loading and error states ---------------- */

  if (loadError) {
    return (
      <div className="ms">
        <PageHeader title="Designer" lede="Design the team: seats, who may message whom, tools, budgets and policy." />
        <ErrorState what="mesh.yaml" detail={`${loadError} Your unsaved draft, if you had one, is kept in this browser.`} onRetry={() => setLoadTick((n) => n + 1)} />
      </div>
    );
  }
  if (!ready || !m) {
    return (
      <div className="ms">
        <PageHeader title="Designer" lede="Design the team: seats, who may message whom, tools, budgets and policy." />
        <div className="empty" role="status"><b className="empty-title">Reading mesh.yaml</b></div>
      </div>
    );
  }

  /* ---------------- the page ---------------- */

  const ints = [...new Set([...(vocab?.eventTypes || ["patch.ready", "architecture.approved", "goal.escalated"]), ...(vocab?.eventTypes || []).map((t: string) => `${t.split(".")[0]}.*`)])];
  const meshName = String(m.mesh?.name || "").trim() || String(m.mesh?.id || "").trim() || "this mesh";
  const showGuide = !guideOff && needsGuide(m.mesh?.goal, ids.length, wires.length);
  const hasFile = !!runningRaw;
  const labelsNow = historyLabels(history);

  const ctx: DCtx = {
    m, cur: current, ids, vocab, ints, touch, starts, toggleStart: doToggleStart, addSeat: doAddSeat, duplicateSeat: doDuplicateSeat,
    deleteSeat: doDeleteSeat, renameSeat: doRenameSeat, toggleContact: doToggleContact, toggleGrant: doToggleGrant, openSeat, wires, reveal,
  };

  const moreItems: MenuItem[] = [
    { id: "ms-mi-yaml", icon: "files", label: "View YAML", title: "The file Save changes would write", onClick: openYaml },
    { id: "ms-mi-templates", icon: "agents", label: "Start from a template…", title: "Replace the draft with a small team to edit", onClick: () => setTemplatesOpen(true) },
    { id: "ms-mi-import", icon: "files", label: "Import YAML…", title: "Replace the draft with a pasted mesh.yaml", onClick: () => setImportOpen(true) },
    ...(guideOff && needsGuide(m.mesh?.goal, ids.length, wires.length) ? [{ id: "ms-mi-guide", icon: "info" as const, label: "Show the setup guide", onClick: () => { setGuideHidden(false); setGuideOff(false); } }] : []),
    ...(runningPath ? [{ id: "ms-mi-reload", icon: "refresh" as const, label: "Discard the draft and reload mesh.yaml", title: "Replace the draft with the file as it is on disk", danger: true, separated: true, onClick: () => void reloadFromFile() }] : []),
  ];

  return (
    <div className={`ms${focusMode ? " focus" : ""}`}>
      <PageHeader
        title="Designer"
        status={<DraftChip status={status} />}
        lede={<>The seats, wires, tools and budgets of <b>{meshName}</b>. Nothing is saved until you save.</>}
        actions={(
          <>
            <ToolButton icon="undo" label={labelsNow.undo ? `Undo: ${labelsNow.undo}` : "Undo"} disabled={!labelsNow.undo} onClick={doUndo} title={labelsNow.undo ? `Undo: ${labelsNow.undo} (Ctrl or Cmd Z)` : "Nothing to undo"} />
            <ToolButton icon="redo" label={labelsNow.redo ? `Redo: ${labelsNow.redo}` : "Redo"} disabled={!labelsNow.redo} onClick={doRedo} title={labelsNow.redo ? `Redo: ${labelsNow.redo} (Shift Ctrl or Cmd Z)` : "Nothing to redo"} />
            <div className="ms-checks-anchor" ref={checksAnchor}>
              <ChecksButton
                checking={checking && !result} valid={valid} offline={checkFailed && !result} errors={errors.length} notes={notes.length}
                open={checksOpen} onToggle={() => setChecksOpen((v) => !v)} btnRef={checksBtnRef}
              />
              {checksOpen ? (
                <ChecksPanel
                  checking={checking && !result} valid={valid} offline={checkFailed} errors={errors} notes={notes} seats={ids}
                  onGo={go} onYaml={openYaml} onClose={() => setChecksOpen(false)} rootRef={popRef}
                />
              ) : null}
            </div>
            {compact ? <ToolButton icon="sliders" label="Inspector" text pressed={ctxOpen} controls="ms-inspector" id="ms-insp-toggle" onClick={() => (ctxOpen ? setCtxOpen(false) : openInspector())} /> : null}
            <Menu id="ms-more" label={<Icon name="more" size={18} />} title="More actions" items={moreItems} />
          </>
        )}
      />

      {starter ? (
        <Banner tone="info" title={`No mesh.yaml was found, so this opened on the ${starter} template.`}
          actions={<Button variant="banner-act" onClick={() => setTemplatesOpen(true)}>Choose another</Button>}>
          Edit it, or start from a different shape. Saving writes a new file.
        </Banner>
      ) : null}
      {restoredAt && changes.length > 0 ? (
        <Banner tone="warn" title="Your unsaved draft was restored."
          actions={(
            <>
              <Button variant="banner-act" onClick={() => setRestoredAt(null)}>Keep editing</Button>
              <Button variant="banner-act" onClick={() => void reloadFromFile()}>Discard it</Button>
            </>
          )}>
          It is from {new Date(restoredAt).toLocaleString()} and differs from mesh.yaml by {changes.length} {changes.length === 1 ? "change" : "changes"}. Discarding replaces it with the file, and you can undo that.
        </Banner>
      ) : null}

      {showGuide ? (
        <SetupGuide
          goal={String(m.mesh?.goal || "")}
          onGoal={(g) => { m.mesh.goal = g; touch(); }}
          seats={ids.length} wires={wires.length}
          onAddSeat={doAddSeat} onAsk={askDesigner} onHide={() => { setGuideHidden(true); setGuideOff(true); }}
        />
      ) : null}

      <div className="ms-body">
        {listMode ? (
          <SeatList seats={m.agents} ids={ids} current={current} starts={starts} problems={problems} wires={wires} onSelect={selectSeat} onAddSeat={doAddSeat} onTemplate={(t) => void startFromTemplate(t)} onAsk={askDesigner} />
        ) : (
          <Topology
            seats={m.agents} ids={ids} layout={layout} setLayout={setLayout} persistLayout={persistLayout} current={current} starts={starts}
            problems={problems} wires={wires} onSelect={selectSeat} onConnect={doConnect} onCut={doCut} onToggleStart={doToggleStart}
            onArrange={arrange} onAddSeat={doAddSeat} onTemplate={(t) => void startFromTemplate(t)} onAsk={askDesigner}
          />
        )}
        <div id="ms-inspector" className={`ms-side${ctxOpen ? " open" : ""}`} ref={inspRef}>
          {compact ? (
            <div className="ms-side-head">
              <b>Inspector</b>
              <CloseButton label="Close the inspector" onClick={() => setCtxOpen(false)} />
            </div>
          ) : null}
          <Inspector ctx={ctx} tab={tab} setTab={setTab} errTabs={errTabs} />
        </div>
      </div>

      <SaveBar
        path={runningPath || copyPath} hasFile={hasFile} status={status}
        checking={checking && !result} valid={valid} offline={checkFailed && !result} errors={errors.length} open={sheet}
        onOpen={openSheet} onShowErrors={() => setChecksOpen(true)}
        lag={lag} lagAt={followUp?.at ?? null} onShowLag={() => openSheet("after")}
        onDismissLag={() => { if (followUp) setFollowUp({ ...followUp, dismissed: true }); }}
      >
        {sheet ? (
          <SaveSheet
            key={sheet} mode={sheet} model={m} followUp={followUp} setFollowUp={setFollowUp} rev={rev} baseline={runningRaw} runningPath={runningPath}
            copyPath={copyPath} setCopyPath={(p) => commitDraft({ copyPath: p })}
            checking={checking} valid={valid} offline={checkFailed} errors={errors} seats={ids}
            onGo={go}
            onSaved={({ path, running, payload }) => {
              if (running) {
                commitDraft({ runningRaw: payload, runningPath: path });
                clearStored();
                setRestoredAt(null);
                setStarter(null);
              } else commitDraft({ copyPath: path });
              void validate();
            }}
            onClose={() => setSheet(null)} onYaml={openYaml} onHome={() => { setSheet(null); setView("overview"); }}
          />
        ) : null}
      </SaveBar>

      {yamlOpen ? (
        <YamlSlide
          yaml={lastYaml} path={runningPath || copyPath} invalid={result !== null && result.status !== 200} stale={checkFailed}
          onCopy={() => { void navigator.clipboard?.writeText(lastYaml || "").then(() => toast("YAML copied", "The text is on the clipboard.", "ok"), () => toast("Copy blocked", "Select the text and copy it by hand.", "warn")); }}
          onClose={() => setYamlOpen(false)}
        />
      ) : null}
      {importOpen ? <ImportDialog text={importText} setText={setImportText} error={importError} busy={importBusy} onApply={() => void importApply()} onCancel={() => { setImportOpen(false); setImportError(""); }} /> : null}
      {templatesOpen ? <TemplateDialog unsaved={unsavedNow()} onPick={(t) => void startFromTemplate(t)} onCancel={() => setTemplatesOpen(false)} /> : null}
    </div>
  );
}

/** Open the assistant. The shell owns it and registers "Ask the designer" with the palette; the Designer asks through that same door. */
function askDesigner(): void {
  listCommands().find((c) => c.id === "chat.ask")?.run();
}
