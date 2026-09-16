/**
 * Designer — Mesh Studio.
 *
 * Topology-first workbench: drag, wire and inspect a live org-chart instead
 * of filling forms. Same schema contract and server-side validation as the
 * running mesh; drafts survive view switches (module singleton) and reloads
 * (localStorage).
 *
 * Layout of this file:
 *   1. Everything below the `Designer()` return is extracted into
 *      ./chrome.tsx (page chrome), ./Topology.tsx (canvas), ./Inspector.tsx
 *      and ./panels/*. This component only owns the model lifecycle:
 *      load → edit → validate → save.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type SetStateAction } from "react";
import { fmt } from "../format";
import { useMesh } from "../store";
import { AdvisoryList, CheckSection, HealthStrip, ImportCard, ReviewCard, SavedCard, SourceStateLine, SyncCard, YamlCard } from "./chrome";
import { CX, CY } from "./geom";
import Inspector from "./Inspector";
import { hueVar } from "./ui";
import { baseName, clamp, deepCopy, densure, saveLandsOnRunning, sourceState, summarizeDiff, tabOfError, TEMPLATES, type SourceStateKind } from "./model";
import { clearStored, commitDraft, getDraftSnapshot, loadLayout, readStored, ringLayout, saveLayout, storeDraft, useDraft, type DraftState } from "./storage";
import Topology from "./Topology";
import { Button, Input, useDismissable } from "../components";
import { register, takePendingAgent, takePendingProposal, unregister, getVersion, subscribe } from "../commands";
import { useFocusMode, useMedia } from "../shell";
import type { Advice, DCtx, Pos, SaveTarget, Tab } from "./types";
import type { StagedMutation } from "@mesh/protocol";

/** Debounced after each edit: re-validate, persist draft + node layout. */
const SAVE_DELAY_MS = 550;

/** WS8: the Designer's own collapse point, same value as the CSS media query. */
const COMPACT = "(max-width: 1240px)";

/** WS10: handlers the palette commands call; swapped to no-ops on unmount. */
interface DesignerCommands {
  addAgent: (preset?: unknown) => void;
  undo: () => void;
  redo: () => void;
  validate: () => Promise<void>;
  pickAgent: (id: string) => void;
  gotoTab: (t: Tab) => void;
  applyProposal: (model: unknown) => void;
}
const NO_COMMANDS: DesignerCommands = {
  addAgent: () => {},
  undo: () => {},
  redo: () => {},
  validate: async () => {},
  pickAgent: () => {},
  gotoTab: () => {},
  applyProposal: () => {},
};

/** Compact text for the header's draft/source chip; the sticky bar keeps the full sentence. */
function sourceChipText(kind: SourceStateKind, n: number): string {
  if (kind === "DIFFERS") return n ? `${n} difference${n === 1 ? "" : "s"}` : "differs";
  if (kind === "RESTORED_DRAFT") return "local draft";
  if (kind === "COPY_SAVED") return "copy target";
  if (kind === "MATCHES_RUNNING_FILE") return "matches running";
  return "new mesh";
}

export default function Designer(): React.JSX.Element {
  const { vocab, toast, setView, client } = useMesh();
  // Shell-owned (WS9): this component only paints the mode onto its regions.
  const { focusMode } = useFocusMode();
  const draft = useDraft();
  const { model: m, cur, layout, runningPath, runningRaw, saveMode, copyPath, loaded } = draft;
  const ready = loaded && !!m;
  const [tab, setTab] = useState<Tab>("crew");
  const [dirty, setDirty] = useState(false);
  const [editCount, setEditCount] = useState(0);
  const [result, setResult] = useState<{ status: number; json: any } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lastYaml, setLastYaml] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [checksOpen, setChecksOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [yamlOpen, setYamlOpen] = useState(false);
  const checksRef = useRef<HTMLDivElement | null>(null);
  // The popover advertised role="dialog" + aria-haspopup="dialog" and had none
  // of the contract: nothing moved focus in, nothing brought it back, Tab was
  // not contained. Esc and outside-click unmounted whatever was focused inside
  // it, dropping focus on <body> so the next Tab restarted at the top of the
  // document. The .ms-more menu beside it already does all of this.
  const popRef = useDismissable<HTMLDivElement>(checksOpen, () => setChecksOpen(false));
  // Opener for the YAML slide-over. openYaml unmounts the "view YAML" button
  // one line after recording it, so document.activeElement would be a detached
  // node by the time the slide-over restores focus -- a silent no-op that drops
  // focus on <body>, the same defect one layer later.
  const checksBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const yamlRef = useRef<HTMLDivElement | null>(null);
  const yamlReturn = useRef<HTMLElement | null>(null);
  const [undo, setUndo] = useState<{ label: string; model: any; cur: string | null } | null>(null);
  /**
   * Undo was a one-way door: it restored the snapshot and cleared itself, so a
   * mis-press was unrecoverable — and worse, field edits made *after* the
   * snapshot (typing only calls `touch()`, never `pushUndo`) were discarded
   * without a word. Keeping the pre-undo state as a redo makes the button safe
   * to press: whatever it rolls back can be rolled forward again.
   */
  const [redo, setRedo] = useState<{ label: string; model: any; cur: string | null } | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<null | { kind: "load" | "template" | "import"; json?: any; model?: any }>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [runningStale, setRunningStale] = useState(false);
  const [savedInfo, setSavedInfo] = useState<{ path: string } | null>(null);
  const [saving, setSaving] = useState(false);
  /* What the last Save left disagreeing between the file and the RUNNING
   * mission. mesh.yaml seeds the mesh at boot and is never re-read, so an
   * overwrite of the running config moves the Config view and leaves the
   * Overview on the mission that actually booted. The server hands back the
   * proposal that closes the gap (mesh-server/src/config-drift.ts); applying
   * it goes through /designer/staged/apply, the same route the chat's live-run
   * changes use, so every Supervisor refusal is re-checked in front of the
   * operator. Null whenever there is nothing to offer. */
  const [drift, setDrift] = useState<{ mutations: StagedMutation[]; problems: string[] } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [syncConfirm, setSyncConfirm] = useState("");
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  // A first visit with no running mesh loads a starter template. It used to do
  // that silently, so the workbench opened on a three-agent org chart the
  // operator never made and had no reason to think was a suggestion — the same
  // failure as a dashboard of zeros: it looks like their data. Say where it
  // came from, and offer the two ways out.
  const [starter, setStarter] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* WS10: the mutation handlers are declared below the loading gate (they close
   * over a loaded model), but the command registration must be a hook above it.
   * The ref forwards the latest handlers into the palette command list. */
  const cmdRef = useRef<DesignerCommands>(NO_COMMANDS);
  // A "jump to agent" request bumps commands.ts even when the view is already
  // Designer, so this component re-renders and the effect below can take it.
  const cmdVersion = useSyncExternalStore(subscribe, getVersion);

  /* -------- WS8 responsive: one instance per region, presentation by CSS -------- */

  const compact = useMedia(COMPACT);
  /* One state for both presentations of the context column: the wide 48px
   * strip / expanded inspector, and the compact right drawer. */
  const [ctxOpen, setCtxOpen] = useState(false);
  const inspRef = useRef<HTMLDivElement | null>(null);
  const inspReturn = useRef<HTMLElement | null>(null);
  const inspWasOpen = useRef(false);
  // Drawer is local and non-modal: no scrim, no focus trap, no global slot.
  const openInspector = useCallback(() => {
    setCtxOpen(true);
    if (!compact) return;
    const opener = document.activeElement;
    // Never record an opener inside the drawer: links in the panels switch the
    // selection and would otherwise strand focus on a hidden element on close.
    if (opener instanceof HTMLElement && opener !== document.body && !inspRef.current?.contains(opener)) inspReturn.current = opener;
  }, [compact]);
  useEffect(() => {
    if (!compact) return;
    if (ctxOpen && !inspWasOpen.current) {
      // Scope to the panel: the compact roster strip is display:none, so a
      // query from the column root could land on an unfocusable hidden avatar.
      const panel = inspRef.current?.querySelector<HTMLElement>(".ms-insp-wrap") ?? inspRef.current;
      (panel?.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]") ?? panel)?.focus();
    } else if (!ctxOpen && inspWasOpen.current) {
      inspReturn.current?.focus();
      inspReturn.current = null;
    }
    inspWasOpen.current = ctxOpen;
  }, [ctxOpen, compact]);

  // Entering focus hides whole regions (rail/inspector/output) on the same DOM.
  // If focus was inside one of them — palette/Esc entry in WS10, or a click that
  // moved nothing — rehome it on the toggle instead of stranding it in a
  // display:none subtree.
  useEffect(() => {
    if (!focusMode) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".ms-ctx, .ms-out")) {
      document.getElementById("ms-focus-toggle")?.focus();
    }
  }, [focusMode]);

  // The palette commands need the latest handlers; writing the ref after every
  // render keeps them fresh without mutating it during render.
  useEffect(() => {
    if (!ready || !m) {
      cmdRef.current = NO_COMMANDS;
      return;
    }
    cmdRef.current = { addAgent, undo: doUndo, redo: doRedo, validate, pickAgent, gotoTab, applyProposal: applyChatProposal };
  });

  // WS10: a palette "jump to agent" leaves a pending id in commands.ts. Take
  // it as soon as this view can act on it — no bus, no storage, nothing that
  // survives to the next visit if the user never got here. A chat proposal
  // from the global assistant arrives through the same one-shot seam.
  useEffect(() => {
    if (!ready) return;
    const current = getDraftSnapshot();
    if (!current.model) return;
    const proposal = takePendingProposal();
    if (proposal) {
      cmdRef.current.applyProposal(proposal);
      return;
    }
    const id = takePendingAgent();
    if (!id || !current.model.agents[id]) return;
    commitDraft({ cur: id });
    setTab("crew");
    openInspector();
  }, [ready, cmdVersion, openInspector]);

  /* -------- edit plumbing -------- */

  const validateSeq = useRef(0);

  const validate = useCallback(async () => {
    const model = getDraftSnapshot().model;
    if (!model) return;
    const seq = ++validateSeq.current;
    setChecking(true);
    try {
      const { status, json } = await client.post("/config/validate", { config: model });
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

  /** Call after any mutation of draft.model: re-render + fire the debounce. */
  const touch = useCallback(() => {
    commitDraft({});
    setDirty(true);
    setEditCount((n) => n + 1);
    setSavedInfo(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void validate();
      storeDraft();
      const d = getDraftSnapshot();
      if (d.model) saveLayout(d.model.mesh?.id || "", d.layout);
    }, SAVE_DELAY_MS);
  }, [validate]);

  const setLayout = useCallback((next: SetStateAction<Record<string, Pos>>) => {
    commitDraft((prev) => ({ layout: typeof next === "function" ? next(prev.layout) : next }));
  }, []);

  /* -------- first visit: browser draft > running mesh > starter template -------- */

  useEffect(() => {
    let dead = false;
    (async () => {
      if (getDraftSnapshot().loaded && getDraftSnapshot().model) return;
      const applyModel = (raw: any, filePath: string | null, mode: SaveTarget) => {
        const model = deepCopy(raw);
        densure(model);
        const prev = getDraftSnapshot();
        const patch: Partial<DraftState> = {
          model,
          saveMode: mode,
          cur: prev.cur && model.agents[prev.cur] ? prev.cur : Object.keys(model.agents)[0] || null,
          layout: loadLayout(model.mesh?.id || "", Object.keys(model.agents)),
        };
        if (filePath !== null) patch.runningPath = filePath;
        if (mode === "running") patch.runningRaw = deepCopy(raw);
        commitDraft(patch);
      };
      let runningRaw: any = null;
      let runningPath = "";
      try {
        const { json } = await client.api("GET", "/config");
        if (json?.raw) {
          runningRaw = json.raw;
          runningPath = json.filePath || "";
        }
      } catch {
        /* offline — draft or template below */
      }
      if (dead) return;
      const stored = readStored();
      if (stored && JSON.stringify(stored.model) !== JSON.stringify(runningRaw)) {
        // Draft beats the running file only when it differs from it.
        const sm: SaveTarget = runningRaw ? (stored.saveMode === "copy" ? "copy" : "running") : "copy";
        applyModel(stored.model, runningPath || null, runningRaw ? sm : "copy");
        if (stored.copyPath?.trim()) commitDraft({ copyPath: stored.copyPath });
        if (runningRaw) {
          /* applyModel marks the restored draft as "running"; the running FILE
           * must stay the diff/stale reference, not the draft itself. */
          commitDraft({ runningRaw: deepCopy(runningRaw) });
        }
        setRestoredAt(stored.ts || Date.now());
      } else if (runningRaw) {
        applyModel(runningRaw, runningPath, "running");
        clearStored();
      } else {
        applyModel(TEMPLATES[1].make(), null, "copy"); // triad starter
        setStarter(TEMPLATES[1].name);
      }
      commitDraft({ loaded: true });
      setEditCount(0);
      void validate();
    })();
    return () => {
      dead = true;
      if (timer.current) clearTimeout(timer.current);
      // A stale closure must not run commands against an unmounted workbench.
      cmdRef.current = NO_COMMANDS;
    };
  }, [client, validate]);

  // Esc unwinds the topmost local layer first: YAML slide-over, overflow menu,
  // then the compact inspector drawer. The shell runs first and marks what it
  // consumed; only an unconsumed Esc reaches these local layers.
  //
  // The checks popover is NOT in this chain: useDismissable listens on document
  // in the capture phase and stopPropagation()s Escape, so it claims the key
  // ahead of every window-bubble listener including the shell's. That is
  // correct topmost-layer-first behaviour for an overlay, and the overlap is
  // near-unreachable anyway -- the popover's own outside-pointerdown closes it
  // the moment you click toward anything else.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Undo/redo are the one pair every editor is expected to answer. The
      // Designer had them on a toolbar button only, so the reflex did nothing.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !e.defaultPrevented) {
        const el = document.activeElement;
        // Never steal it from a text field — there it means "undo my typing",
        // which the browser already does better than we could.
        if (el instanceof HTMLElement && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
        e.preventDefault();
        if (e.shiftKey) cmdRef.current.redo(); else cmdRef.current.undo();
        return;
      }
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (yamlOpen) {
        e.preventDefault();
        setYamlOpen(false);
      } else if (moreOpen) {
        e.preventDefault();
        setMoreOpen(false);
      } else if (compact && ctxOpen) {
        e.preventDefault();
        setCtxOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ctxOpen, compact, checksOpen, moreOpen, yamlOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    moreRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [moreOpen]);

  const onMoreKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(false);
      moreBtnRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = [...(moreRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const n = e.key === "Home" ? 0
      : e.key === "End" ? items.length - 1
      : e.key === "ArrowDown" ? (at + 1) % items.length
      : (at - 1 + items.length) % items.length;
    items[n]?.focus();
  };

  // Floating layers that only close on Esc trap the pointer: any click outside
  // the checks popover or the overflow menu dismisses them too.
  useEffect(() => {
    if (!checksOpen && !moreOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (checksOpen && !checksRef.current?.contains(t)) setChecksOpen(false);
      if (moreOpen && !moreRef.current?.contains(t)) setMoreOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [checksOpen, moreOpen]);

  // YAML slide-over: focus moves to the panel on open and back to its trigger
  // on close, so keyboard users are not stranded behind the overlay.
  useEffect(() => {
    if (!yamlOpen) return;
    const root = yamlRef.current;
    (root?.querySelector<HTMLElement>("button, [tabindex]") ?? root)?.focus();
    return () => {
      const back = yamlReturn.current;
      if (back?.isConnected) back.focus();
      yamlReturn.current = null;
    };
  }, [yamlOpen]);

  const openYaml = () => {
    // On the popover path the active element is the "view YAML" button, which
    // setChecksOpen(false) unmounts on the very next line; focusing a detached
    // node is a silent no-op. Fall back to the chip that owns the popover.
    const from = checksOpen ? checksBtnRef.current : document.activeElement;
    if (from instanceof HTMLElement) yamlReturn.current = from;
    setChecksOpen(false);
    setYamlOpen(true);
  };

  const targetPath = saveMode === "running" && runningPath ? runningPath : copyPath.trim();
  const savingRunning = saveMode === "running" && !!runningPath && targetPath === runningPath;
  // copy-target that resolves to the running file would silently overwrite it while
  // reporting "copy": refuse the save and make the user pick the running target.
  const copyTargetsRunning = saveMode === "copy" && !!runningPath && !!targetPath && saveLandsOnRunning(targetPath, runningPath);
  const diff = useMemo(() => {
    // The model is mutated in place; editCount is the invalidation signal.
    void editCount;
    return m ? summarizeDiff(m, runningRaw) : [];
  }, [m, runningRaw, editCount]);
  const src = sourceState({ dirty, diff, runningRaw, saveMode, restoredAt });
  const errors: string[] = result && result.status !== 200 ? (result.json?.errors || ["invalid"]) : [];
  const errTabs = useMemo(() => {
    const counts: Record<Tab, number> = { crew: 0, mesh: 0, policy: 0 };
    const errs: string[] = result && result.status !== 200 ? (result.json?.errors || ["invalid"]) : [];
    for (const e of errs) counts[tabOfError(String(e))]++;
    return counts;
  }, [result]);
  const agentErr = (id: string): boolean => errors.some((e) => String(e).includes(`'${id}'`));

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { storeDraft(); e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /* -------- advisors: soft checks the server won't flag -------- */

  const advisors = useMemo(() => {
    // The model is mutated in place; editCount is the invalidation signal.
    void editCount;
    const list: Advice[] = [];
    const mm = m;
    if (!mm) return list;
    const ag = Object.keys(mm.agents || {});
    const serverWarnings: string[] =
      result && result.status === 200 && Array.isArray(result.json?.warnings) ? result.json.warnings : [];
    for (const w of serverWarnings) {
      if (typeof w === "string") list.push({ level: "warn", tab: tabOfError(w), msg: w });
    }
    // Gate satisfiability is NOT re-derived here: a gate token is
    // `<actor>.<kind>` matched against recorded approvals by actor id/role, so
    // requiring the literal token in an agent's `authority` list produces
    // false "no agent can decide that" warnings on every correctly-wired mesh.
    // The server owns this check (validateTransitionGates, surfaced as
    // proposal `problems`); keep this list to checks the server won't flag.
    // "wired to nobody" and "nobody boots" used to live here; they moved into
    // packages/config so a CLI or server boot sees them too, and they arrive
    // back through `serverWarnings` above — do not re-add them here.
    const sum = ag.reduce((n, id) => n + (mm.budgets?.agent?.[id] ?? mm.agents[id]?.budget?.tokens ?? 200000), 0);
    if (sum > (mm.budgets?.mission?.tokens ?? 2000000)) list.push({ level: "info", tab: "policy", msg: `crew budgets add up to ${fmt(sum)} — more than the ${fmt(mm.budgets?.mission?.tokens)} mission cap. Fine, just know someone stops early.` });
    if (!mm.mesh?.goal?.trim()) list.push({ level: "warn", tab: "mesh", msg: "the mission has no goal — agents will drift." });
    return list;
  }, [m, editCount, result]);
  // WS10: Designer-scoped palette commands, registered only while this view is
  // mounted. The run bodies go through cmdRef because the handlers live below
  // the loading gate; the list re-registers when the selection or the
  // validation result changes so the labels stay true.
  const cmdAgent = m && cur && m.agents[cur] ? cur : null;
  useEffect(() => {
    if (!ready || !m) return;
    // Derive from `result` inside the effect: `errors` is a fresh array each
    // render, so depending on it would re-register commands every render.
    const errs: string[] = result && result.status !== 200 ? (result.json?.errors || ["invalid"]) : [];
    register("designer", [
      { id: "designer.add-agent", label: "Add agent", keywords: "hire new crew member", scope: "designer", run: () => cmdRef.current.addAgent() },
      { id: "designer.validate", label: "Run validation", keywords: "check verify config yaml", scope: "designer", run: () => void cmdRef.current.validate() },
      ...(cmdAgent ? [{ id: `designer.open-agent.${cmdAgent}`, label: `Inspect agent “${cmdAgent}”`, keywords: `open agent ${cmdAgent}`, scope: "designer", run: () => cmdRef.current.pickAgent(cmdAgent) }] : []),
      ...(errs.length ? [{ id: "designer.show-errors", label: `Show errors (${errs.length})`, keywords: "problems invalid validation", scope: "designer", run: () => cmdRef.current.gotoTab(tabOfError(String(errs[0]))) }] : []),
    ]);
    return () => unregister("designer");
  }, [ready, m, cmdAgent, result]);

  /* -------- stable edit handlers (hooks, so they live above the gate) -------- */

  const setCurrent = useCallback((id: string | null) => {
    commitDraft({ cur: id });
  }, []);
  const commitBaseline = useCallback(() => {
    setDirty(false);
    setEditCount(0);
  }, []);
  const pushUndo = useCallback((label: string) => {
    const d = getDraftSnapshot();
    setUndo({ label, model: deepCopy(d.model), cur: d.cur });
    // A new edit forks the history: the old redo now points at a future that
    // can no longer be reached from here.
    setRedo(null);
  }, []);
  const toggleWire = useCallback((src: string, tgt: string) => {
    if (src === tgt) return;
    const model = getDraftSnapshot().model;
    if (!model) return;
    model.policies.communication[src] ||= { may_contact: [] };
    const l = new Set(model.policies.communication[src].may_contact || []);
    const had = l.has(tgt);
    pushUndo(had ? `Unwired ${src} → ${tgt}` : `Wired ${src} → ${tgt}`);
    if (had) l.delete(tgt); else l.add(tgt);
    model.policies.communication[src].may_contact = [...l];
    touch();
  }, [pushUndo, touch]);
  const gotoTab = useCallback((t: Tab) => {
    setTab(t);
    const d = getDraftSnapshot();
    const id0 = Object.keys(d.model?.agents || {})[0] || null;
    if (t === "crew" && (!d.cur || !d.model?.agents?.[d.cur]) && id0) commitDraft({ cur: id0 });
    openInspector();
    document.querySelector(".ms-body")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [openInspector]);
  // Picking an agent (roster, gate link, palette) reveals the context column.
  const pickAgent = useCallback((id: string) => {
    commitDraft({ cur: id });
    setTab("crew");
    openInspector();
  }, [openInspector]);
  // A canvas pick selects but does not force the wide column open: the avatar
  // strip shows the selection, and the explicit toggle (or compact drawer)
  // reveals the editor when wanted.
  const selectAgent = useCallback((id: string) => {
    commitDraft({ cur: id });
    setTab("crew");
    if (compact) openInspector();
  }, [compact, openInspector]);

  // NOTE: keep every hook above this gate — the render below returns a
  // different tree when loading, so conditional hooks would change count.
  if (!ready || !m) {
    return (
      <>
        <div className="view-title"><h2>Mesh Designer</h2></div>
        <div className="view-sub">Opening the running mesh…</div>
        <div className="empty"><div className="big">…</div><div>loading current mesh config</div></div>
      </>
    );
  }

  const ids = Object.keys(m.agents || {});
  const current = ids.includes(cur || "") ? cur : null;
  const startupSet = new Set<string>((m.startup?.activate || []) as string[]);
  const ints = [...new Set([...(vocab?.eventTypes || ["patch.ready", "architecture.approved", "goal.escalated"]), ...(vocab?.eventTypes || []).map((t: string) => t.split(".")[0] + ".*")])];
  const links: Array<{ src: string; tgt: string }> = [];
  for (const s of ids) for (const t of ((m.policies.communication[s] || {}).may_contact || [])) {
    if (t !== s && m.agents[t] && !links.some((l) => l.src === s && l.tgt === t)) links.push({ src: s, tgt: t });
  }

  /* -------- structural mutations (all undo-able) -------- */

  /** Swap the draft with a saved snapshot, keeping the displaced one to return to. */
  const swapTo = (
    snap: { label: string; model: any; cur: string | null },
    keep: (s: { label: string; model: any; cur: string | null } | null) => void,
    drop: (s: null) => void,
    title: string,
  ) => {
    const d = getDraftSnapshot();
    keep({ label: snap.label, model: deepCopy(d.model), cur: d.cur });
    drop(null);
    commitDraft({ model: deepCopy(snap.model), cur: snap.cur });
    setReviewOpen(false);
    toast(title, snap.label, "ok");
    touch();
  };
  const doUndo = () => { if (undo) swapTo(undo, setRedo, setUndo, "undone"); };
  const doRedo = () => { if (redo) swapTo(redo, setUndo, setRedo, "redone"); };
  const syncSaveMode = (mode: SaveTarget, cp: string) => {
    commitDraft({ saveMode: mode, copyPath: cp });
  };

  const addAgent = (preset?: unknown) => {
    pushUndo("Added agent");
    let i = 1;
    while (m.agents[`agent-${i}`]) i++;
    const id = `agent-${i}`;
    m.agents[id] = preset ? deepCopy(preset) : { role: `role-${i}`, capabilities: [], authority: [], interests: [] };
    densure(m);
    setCurrent(id);
    setTab("crew");
    setLayout({ ...layout, [id]: { x: CX + ((ids.length % 5) - 2) * 60, y: CY + (Math.floor(ids.length / 5) - 1) * 60 } });
    touch();
  };
  const duplicateAgent = () => {
    if (!current) return;
    pushUndo("Duplicated agent");
    let i = 1;
    while (m.agents[`${current}-${i}`]) i++;
    const nid = `${current}-${i}`;
    m.agents[nid] = deepCopy(m.agents[current]);
    if (m.policies.communication[current]) m.policies.communication[nid] = deepCopy(m.policies.communication[current]);
    const src = layout[current] || { x: CX, y: CY };
    setLayout({ ...layout, [nid]: { x: clamp(src.x + 48, 40, 960), y: clamp(src.y + 48, 40, 580) } });
    setCurrent(nid);
    touch();
  };
  const deleteAgent = () => {
    const c = current;
    if (!c) return;
    pushUndo(`Deleted agent ${c}`);
    delete m.agents[c];
    for (const p of Object.values(m.policies.communication) as any[]) {
      p.may_contact = (p.may_contact || []).filter((x: string) => x !== c);
      p.may_be_contacted_by = (p.may_be_contacted_by || []).filter((x: string) => x !== c);
    }
    delete m.policies.communication[c];
    m.startup.activate = (m.startup.activate || []).filter((x: string) => x !== c);
    if (m.budgets?.agent) delete m.budgets.agent[c];
    for (const r of (m.policies.rules || [])) if (r.when?.actor === c) r.when.actor = "";
    for (const t of (m.scheduling?.triage?.rules || [])) if (t.agent === c) t.agent = "";
    const L = { ...layout };
    delete L[c];
    setLayout(L);
    setCurrent(Object.keys(m.agents)[0] || null);
    touch();
    // Deleting an agent cascades through comms, startup, budgets, rules, triage
    // and layout. The Undo button lives in the toolbar, which is not where the
    // eye is after a delete — so the confirmation carries the way back.
    toast("agent deleted", `${c} and its wiring were removed`, "warn", { label: `Undo — restore ${c}`, run: () => cmdRef.current.undo() });
  };
  const renameAgent = (old: string, nn: string): boolean => {
    if (!old || !nn || nn === old || m.agents[nn]) return false;
    pushUndo(`Renamed ${old}`);
    m.agents[nn] = m.agents[old];
    delete m.agents[old];
    for (const [k, p] of Object.entries(m.policies.communication) as Array<[string, any]>) {
      p.may_contact = (p.may_contact || []).map((x: string) => (x === old ? nn : x));
      p.may_be_contacted_by = (p.may_be_contacted_by || []).map((x: string) => (x === old ? nn : x));
      if (k === old) {
        delete m.policies.communication[k];
        m.policies.communication[nn] = p;
      }
    }
    m.startup.activate = (m.startup.activate || []).map((x: string) => (x === old ? nn : x));
    if (m.budgets?.agent?.[old] !== undefined) {
      m.budgets.agent[nn] = m.budgets.agent[old];
      delete m.budgets.agent[old];
    }
    for (const r of (m.scheduling?.triage?.rules || [])) if (r.agent === old) r.agent = nn;
    const L = { ...layout };
    L[nn] = L[old] || { x: CX, y: CY };
    delete L[old];
    setLayout(L);
    setCurrent(nn);
    touch();
    return true;
  };
  const toggleStartup = (id: string) => {
    const l = new Set<string>((m.startup.activate || []) as string[]);
    if (l.has(id)) l.delete(id); else l.add(id);
    m.startup.activate = [...l];
    touch();
  };
  const autoArrange = () => {
    setLayout(ringLayout(ids));
    touch();
  };

  const applyReplaceModel = (model: any, nextCur: string | null, label: string) => {
    pushUndo(label);
    const next = model;
    densure(next);
    commitDraft({
      model: next,
      cur: nextCur,
      layout: loadLayout(next.mesh?.id || "", Object.keys(next.agents)),
    });
    setReviewOpen(false);
    setConfirmReplace(null);
    setRestoredAt(null);
    commitBaseline();
    touch();
    // A freshly loaded model is the baseline, so the touched "dirty" flag is a lie.
    setDirty(false);
  };
  /** A chat proposal replaces the whole model like a template does, but it is
   *  still an unsent draft edit: push undo and touch, never commitBaseline. */
  const applyChatProposal = (model: unknown) => {
    pushUndo("Applied chat proposal");
    const next = deepCopy(model);
    densure(next);
    const prev = getDraftSnapshot();
    commitDraft({
      model: next,
      cur: prev.cur && next.agents[prev.cur] ? prev.cur : Object.keys(next.agents)[0] || null,
      layout: loadLayout(next.mesh?.id || "", Object.keys(next.agents)),
    });
    setReviewOpen(false);
    setConfirmReplace(null);
    setRestoredAt(null);
    touch();
  };
  const requestReplace = (kind: "load" | "template" | "import", json?: any) => {
    if (!dirty) {
      if (kind === "load" && json?.raw) applyReplaceModel(deepCopy(json.raw), Object.keys(json.raw.agents || {})[0] || null, "Loaded running mesh");
      else if (kind === "template") applyReplaceModel(json, Object.keys(json.agents || {})[0] || null, "Loaded template");
      else if (kind === "import" && json) applyReplaceModel(json, Object.keys(json.agents || {})[0] || null, "Imported YAML");
      return;
    }
    setConfirmReplace({ kind, json });
    setMoreOpen(false);
  };
  const confirmReplaceDo = () => {
    const c = confirmReplace;
    if (!c) return;
    if (c.kind === "load" && c.json?.raw) {
      const prev = getDraftSnapshot();
      commitDraft({
        runningPath: c.json.filePath || prev.runningPath,
        runningRaw: deepCopy(c.json.raw),
        saveMode: "running",
      });
      applyReplaceModel(deepCopy(c.json.raw), Object.keys(c.json.raw.agents || {})[0] || null, "Loaded running mesh");
      toast("designer", "editing running mesh — your unsent edits were discarded", "warn");
    } else if (c.kind === "template") {
      applyReplaceModel(c.json, Object.keys(c.json.agents || {})[0] || null, "Loaded template");
    } else if (c.kind === "import" && c.json) {
      applyReplaceModel(c.json, Object.keys(c.json.agents || {})[0] || null, "Imported YAML");
    }
  };

  const loadRunningClick = async () => {
    try {
      const { json } = await client.api("GET", "/config");
      if (!json?.raw) return toast("designer", "no running config", "bad");
      if (!dirty) {
        const prev = getDraftSnapshot();
        const path = json.filePath || prev.runningPath;
        commitDraft({ runningPath: path, runningRaw: deepCopy(json.raw), saveMode: "running" });
        applyReplaceModel(deepCopy(json.raw), Object.keys(json.raw.agents || {})[0] || null, "Loaded running mesh");
        toast("designer", `editing running mesh: ${path}`, "ok");
      } else {
        setConfirmReplace({ kind: "load", json });
      }
    } catch (err) {
      toast("designer", err instanceof Error ? err.message : "the server is unreachable", "bad");
    }
  };

  const importApply = async () => {
    try {
      const { status, json } = await client.post("/config/parse", { yaml: importText });
      if (status !== 200) return toast("parse failed", (json.errors || []).join("; ").slice(0, 200), "bad");
      setImportOpen(false);
      requestReplace("import", json.config);
    } catch (err) {
      toast("import failed", err instanceof Error ? err.message : "the server is unreachable", "bad");
    }
  };

  /* -------- save flow -------- */

  const RUNNING_PATH_CONFLICT = "that path is the running config — select the running target or choose a different copy path";

  const openReview = async () => {
    if (!targetPath) return toast("save failed", "provide a save path", "bad");
    if (copyTargetsRunning) return toast("save failed", RUNNING_PATH_CONFLICT, "bad");
    setRunningStale(false);
    if (savingRunning) {
      try {
        const { json } = await client.api("GET", "/config");
        if (json?.raw && JSON.stringify(json.raw) !== JSON.stringify(runningRaw)) setRunningStale(true);
      } catch {
        /* offline: review still shows the diff */
      }
    }
    setReviewOpen(true);
    window.setTimeout(() => document.getElementById("d-review")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  const doSave = async () => {
    if (saving) return;
    if (copyTargetsRunning) return toast("save failed", RUNNING_PATH_CONFLICT, "bad");
    setSaving(true);
    try {
      const { status, json } = await client.post("/config/save", { config: m, path: targetPath });
      if (status === 200) {
        if (savingRunning) {
          commitDraft({ runningRaw: deepCopy(m) });
        }
        setReviewOpen(false);
        setRunningStale(false);
        commitBaseline();
        setUndo(null);
        setRedo(null);
        setRestoredAt(null);
        clearStored();
        setSavedInfo({ path: json.savedTo });
        /* Only a save onto the running file can produce drift; the server
         * returns null otherwise, and a proposal with neither changes nor
         * problems is nothing to show. */
        const d = json.drift;
        const offer = d && (d.mutations?.length || d.problems?.length)
          ? { mutations: d.mutations ?? [], problems: d.problems ?? [] }
          : null;
        setDrift(offer);
        setSyncResult(null);
        setSyncConfirm("");
        toast("saved", json.archived ? `${json.savedTo} — previous kept in ${json.archived}` : json.savedTo, "ok");
      } else {
        toast("save failed", (json?.errors || [json?.error, "invalid"]).filter(Boolean).join("; ").slice(0, 240), "bad");
      }
    } catch (err) {
      // api() rethrows transport failures; without this catch a dead server
      // made the save button look like a no-op.
      toast("save failed", err instanceof Error ? err.message : "the server is unreachable", "bad");
    } finally {
      setSaving(false);
    }
  };

  /* Push the drift proposal at the live mesh. No new authority: this is the
   * staged-apply route, so the Supervisor's own refusals come back as the
   * sentences shown on the card rather than an HTTP code the operator would
   * have to interpret. A partial apply is reported as partial — the route
   * halts on the first failure and says how far it got. */
  const applySync = async () => {
    if (!drift || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const { status, json } = await client.post("/designer/staged/apply", { mutations: drift.mutations });
      const ok = status === 200 && json?.ok === true;
      const failed: string[] = Array.isArray(json?.results)
        ? json.results.filter((r: any) => r && r.ok === false).map((r: any) => `${r.kind}: ${r.detail}`)
        : [];
      const n = json?.applied ?? 0;
      const msg = ok
        ? `the running mission now matches the file — ${n} change${n === 1 ? "" : "s"} applied`
        : failed.length
          ? `${n} of ${drift.mutations.length} applied — ${failed.join("; ")}`
          : `the server refused this apply (HTTP ${status})`;
      setSyncResult({ ok, msg });
      toast(ok ? "mission updated" : "sync failed", msg, ok ? "ok" : "bad");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "the server is unreachable";
      setSyncResult({ ok: false, msg });
      toast("sync failed", msg, "bad");
    } finally {
      setSyncing(false);
    }
  };

  /* -------- derived header state -------- */

  const valid = result?.status === 200;
  const verdictState = checking ? "checking…" : result ? (valid ? "valid" : `${errors.length} errors`) : checkFailed ? "check failed" : "checking…";
  const verdictTone = !result ? (checkFailed ? "warn" : "") : valid ? "ok" : "bad";
  const saveLabel = !runningPath ? "Save mesh" : savingRunning ? "Save running config" : "Save copy";

  const ctx: DCtx = {
    m, cur: current, ids, vocab, ints, touch, pushUndo,
    startupSet, toggleStartup, addAgent, duplicateAgent, deleteAgent, renameAgent, toggleWire,
    setCur: pickAgent,
  };

  return (
    <div className={`ms${focusMode ? " focus" : ""}`}>
      <header className="ms-head">
        <h2 className="sr-only">Mesh Designer</h2>
        <div className="ms-head-name">
          <b>{m.mesh?.name?.trim() || "Untitled mesh"}</b>
          {m.mesh?.id ? <span className="mono muted">{m.mesh.id}</span> : null}
          {m.mesh?.goal?.trim() ? <span className="ms-goal">— {m.mesh.goal.trim()}</span> : <span className="muted">— no goal yet</span>}
        </div>
        <span className="ms-state" role="status">
          <b>{ids.length}</b> agent{ids.length === 1 ? "" : "s"}
          <span aria-hidden="true">·</span>
          <b>{links.length}</b> wire{links.length === 1 ? "" : "s"}
        </span>
        <div className="ms-checks-anchor" ref={checksRef}>
          <button
            type="button"
            ref={checksBtnRef}
            className={`ms-chip ms-verdict ${verdictTone}`}
            aria-expanded={checksOpen}
            aria-haspopup="dialog"
            title="validation errors and advisors"
            onClick={() => setChecksOpen((v) => !v)}
          >
            {verdictState}
          </button>
          {checksOpen ? (
            <div className="ms-pop" role="dialog" aria-label="mesh checks" ref={popRef} tabIndex={-1}>
              <HealthStrip
                onGoto={gotoTab}
                startupCount={startupSet.size}
                gates={Object.keys(m.policies.transitions || {}).length}
                advice={advisors}
                undoLabel={undo ? undo.label : null}
                onUndo={doUndo}
                redoLabel={redo?.label || null}
                onRedo={doRedo}
              />
              <AdvisoryList advice={advisors} onGoto={gotoTab} />
              <CheckSection
                checking={checking}
                valid={valid}
                errors={errors}
                offline={checkFailed}
                onGoto={gotoTab}
              />
              <div className="ms-pop-foot">
                <Button variant="small" onClick={openYaml}>view YAML</Button>
              </div>
            </div>
          ) : null}
        </div>
        {src.kind === "DIFFERS" ? (
          <button
            type="button"
            className="ms-chip ms-src-chip"
            aria-pressed={reviewOpen}
            title="differences from the running config — review before saving"
            onClick={() => setReviewOpen(!reviewOpen)}
          >
            {sourceChipText(src.kind, src.n)}
          </button>
        ) : (
          <span className={`ms-chip ms-src-chip${src.dirty ? " dirty" : ""}`} role="status" title={`Editing ${targetPath || "…"}`}>
            {sourceChipText(src.kind, src.n)}
          </span>
        )}
        <Button variant="small" extra="ms-insp-toggle" id="ms-insp-toggle" aria-expanded={ctxOpen} aria-controls="ms-inspector" onClick={() => (ctxOpen ? setCtxOpen(false) : openInspector())}>
          {ctxOpen ? "close inspector" : "inspect agent"}
        </Button>
        <div
          className="ms-more"
          ref={moreRef}
          onKeyDown={onMoreKey}
          onBlur={(e) => { if (moreOpen && !moreRef.current?.contains(e.relatedTarget as Node | null)) setMoreOpen(false); }}
        >
          <button
            type="button"
            ref={moreBtnRef}
            className="ms-more-btn"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            aria-label="more mesh actions"
            onClick={() => setMoreOpen((v) => !v)}
          >
            ⋯
          </button>
          {moreOpen ? (
            <div className="ms-menu" role="menu" aria-label="mesh actions">
              <button role="menuitem" tabIndex={-1} disabled={!runningPath} onClick={() => { setMoreOpen(false); void loadRunningClick(); }}>
                Load running mesh
              </button>
              <div className="ms-menu-sep" role="separator" />
              <div className="ms-menu-label">New from template</div>
              {TEMPLATES.map((t) => (
                <button key={t.key} role="menuitem" tabIndex={-1} onClick={() => { setMoreOpen(false); requestReplace("template", t.make()); }}>
                  <b>{t.name}</b>
                  <small>{t.desc}</small>
                </button>
              ))}
              <div className="ms-menu-sep" role="separator" />
              <button role="menuitem" tabIndex={-1} onClick={() => { setMoreOpen(false); setImportOpen(true); }}>
                Import YAML…
              </button>
              <button role="menuitem" tabIndex={-1} className="danger" onClick={() => { setMoreOpen(false); requestReplace("template", TEMPLATES[1].make()); }}>
                Reset to starter…
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {starter && editCount === 0 ? (
        <div className="replace-bar" role="status">
          <span><b>Starter template: {starter}</b> <span className="muted">no mesh.yaml is running, so the workbench opened on an example. Edit it, or start from a different shape.</span></span>
          <span className="row">
            <Button variant="small" onClick={() => setStarter(null)}>Edit this one</Button>
            {TEMPLATES.filter((t) => t.name !== starter).map((t) => (
              <Button key={t.key} variant="ghost" onClick={() => { setStarter(t.name); requestReplace("template", t.make()); }}>{t.name}</Button>
            ))}
          </span>
        </div>
      ) : null}
      {restoredAt ? (
        <div className="replace-bar" role="alert">
          <span><b>Unsaved local changes</b> <span className="muted">your browser draft ({new Date(restoredAt).toLocaleTimeString()}) {src.hasRunning ? "differs from the running file." : "was restored — no running file is loaded."}</span></span>
          <span className="row">
            <Button variant="small" onClick={() => setRestoredAt(null)}>Keep draft</Button>
            {src.hasRunning ? <Button variant="ghost" onClick={() => { setRestoredAt(null); void loadRunningClick(); }}>Discard draft</Button> : null}
          </span>
        </div>
      ) : null}
      {confirmReplace ? (
        <div className="replace-bar" role="alert">
          <span><b>Discard {editCount} unsent edit{editCount === 1 ? "" : "s"}?</b> <span className="muted">“{confirmReplace.kind === "load" ? "Load running" : confirmReplace.kind === "template" ? "Template" : "Import"}” replaces your draft. You can undo it right after.</span></span>
          <span className="row">
            <Button variant="small" extra="danger-solid" onClick={confirmReplaceDo}>Discard edits</Button>
            <Button variant="small" onClick={() => setConfirmReplace(null)}>Keep editing</Button>
          </span>
        </div>
      ) : null}

      <div className="ms-body">
        <Topology
          agents={m.agents}
          ids={ids}
          layout={layout}
          setLayout={setLayout}
          current={current}
          startup={startupSet}
          meshId={m.mesh?.id}
          hasError={agentErr}
          links={links}
          onSelect={selectAgent}
          onWire={toggleWire}
          onCut={toggleWire}
          onBoot={toggleStartup}
          onArrange={autoArrange}
          onTemplate={(model) => requestReplace("template", model)}
          onAddAgent={() => addAgent()}
        />
        <div className={`ms-ctx${ctxOpen ? " open" : ""}`} ref={inspRef}>
          <aside className="card ms-roster" aria-label="crew">
            <button
              type="button"
              className="ms-roster-toggle"
              aria-expanded={ctxOpen}
              aria-controls="ms-inspector"
              aria-label={ctxOpen ? "collapse context panel" : "expand context panel"}
              title={ctxOpen ? "collapse panel" : "expand panel"}
              onClick={() => setCtxOpen((v) => !v)}
            >
              <span aria-hidden="true">{ctxOpen ? "»" : "«"}</span>
            </button>
            <div className="ms-roster-list">
              {ids.map((id) => {
                const ag = m.agents[id] || {};
                const boot = startupSet.has(id);
                const sel = id === current;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`ms-av${sel ? " sel" : ""}${boot ? " boot" : ""}`}
                    style={hueVar(id)}
                    aria-pressed={sel}
                    aria-label={`${id}, ${ag.role || "no role"}${ag.mode === "service" ? ", service" : ""}${boot ? ", boots at startup" : ""}${agentErr(id) ? ", has errors" : ""}`}
                    title={`${id} · ${ag.role || "no role"}${ag.mode === "service" ? " · service" : ""}${boot ? " · boots at startup" : ""}`}
                    onClick={() => pickAgent(id)}
                  >
                    {(id[0] || "?").toUpperCase()}
                    {agentErr(id) ? <span className="ms-av-err" aria-hidden="true">!</span> : null}
                  </button>
                );
              })}
            </div>
            <button type="button" className="ms-roster-hire" aria-label="hire agent" title="hire agent" onClick={() => addAgent()}>+</button>
          </aside>
          <div id="ms-inspector" className="ms-insp-wrap">
            <button type="button" className="ms-insp-close" aria-label="close inspector" onClick={() => setCtxOpen(false)}>×</button>
            <Inspector ctx={ctx} tab={tab} setTab={setTab} errTabs={errTabs} />
          </div>
        </div>
      </div>

      <div className="ms-out">
        {reviewOpen ? (
          <ReviewCard
            targetPath={targetPath}
            savingRunning={savingRunning}
            saving={saving}
            diff={diff}
            differs={src.kind === "DIFFERS"}
            targetConflict={copyTargetsRunning}
            runningStale={runningStale}
            blocked={result?.status !== 200}
            errors={errors.length}
            onSave={() => void doSave()}
            onClose={() => setReviewOpen(false)}
          />
        ) : null}
        {savedInfo ? (
          <SavedCard
            path={savedInfo.path}
            isRunning={savingRunning || savedInfo.path === runningPath}
            syncOffered={drift !== null}
            onYaml={openYaml}
            onHome={() => setView("overview")}
          />
        ) : null}
        {drift ? (
          <SyncCard
            mutations={drift.mutations}
            problems={drift.problems}
            busy={syncing}
            result={syncResult}
            confirmText={syncConfirm}
            setConfirmText={setSyncConfirm}
            onApply={() => void applySync()}
            onDismiss={() => setDrift(null)}
          />
        ) : null}
        {importOpen ? (
          <ImportCard
            text={importText}
            setText={setImportText}
            onApply={() => void importApply()}
            onCancel={() => setImportOpen(false)}
          />
        ) : null}
      </div>

      {/* sticky action bar: the one place that saves */}
      <div className="wb-bar" role="toolbar" aria-label="designer actions">
        <div className="wb-bar-target">
          <span className="wb-bar-label" id="d-save-to">save to</span>
          <div className="wb-seg" role="radiogroup" aria-labelledby="d-save-to">
            <label className="wb-seg-opt" title={runningPath ? `overwrite the running file: ${runningPath}` : "no running file is loaded"}>
              <input type="radio" name="d-save-target" checked={saveMode === "running" && !!runningPath} disabled={!runningPath} onChange={() => syncSaveMode("running", copyPath)} />
              <span>running</span>
            </label>
            <label className="wb-seg-opt" title="write a new file; the running mesh is untouched">
              <input type="radio" name="d-save-target" checked={saveMode === "copy" || !runningPath} onChange={() => syncSaveMode("copy", copyPath)} />
              <span>copy</span>
            </label>
          </div>
          {(saveMode === "copy" || !runningPath) ? (
            <Input extra="wb-bar-path" value={copyPath} aria-label="copy save path" placeholder="examples/my-mesh/mesh.yaml" onChange={(e) => syncSaveMode("copy", e.target.value)} />
          ) : <span className="mono muted wb-bar-path" title={runningPath} dir="rtl">{runningPath}</span>}
        </div>
        <div className="wb-bar-mid">
          <SourceStateLine state={src} reviewOpen={reviewOpen} onToggleReview={() => setReviewOpen(!reviewOpen)} />
        </div>
        <div className="wb-bar-actions">
          <div className="wb-bar-save">
            <Button variant="primary" aria-describedby="d-save-caveat" disabled={!targetPath || checking || saving} onClick={() => void openReview()}>{saveLabel}</Button>
            <span className="wb-bar-hint" id="d-save-caveat">
              {targetPath ? <>writes <b className="mono">{baseName(targetPath)}</b> · restart to apply</> : "pick a save target"}
            </span>
          </div>
        </div>
      </div>

      {yamlOpen ? (
        <div className="ms-slide" role="dialog" aria-label="yaml preview" ref={yamlRef} tabIndex={-1}>
          <button type="button" className="ms-slide-close" aria-label="close yaml preview" onClick={() => setYamlOpen(false)}>×</button>
          <YamlCard
            yaml={lastYaml}
            targetPath={targetPath}
            invalid={result?.status !== 200}
            stale={checkFailed}
            onCopy={() => { void navigator.clipboard?.writeText(lastYaml || "").then(() => toast("yaml", "copied", "ok"), () => toast("yaml", "clipboard blocked", "warn")); }}
          />
        </div>
      ) : null}
    </div>
  );
}