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
 *      ./chrome.tsx (page chrome), ./Topology.tsx (canvas), ./CrewRail.tsx,
 *      ./Inspector.tsx and ./panels/*. This component only owns the model
 *      lifecycle: load → edit → validate → save.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fmt } from "../format";
import { useMesh } from "../store";
import "./designer.css";
import { AdvisoryList, CheckSection, HealthStrip, ImportCard, ReviewCard, SavedCard, SourceStateLine, YamlCard } from "./chrome";
import CrewRail from "./CrewRail";
import { CX, CY } from "./geom";
import Inspector from "./Inspector";
import { clamp, deepCopy, densure, sourceState, summarizeDiff, tabOfError, TEMPLATES } from "./model";
import { clearStored, draft, loadLayout, readStored, ringLayout, saveLayout, storeDraft } from "./storage";
import Topology from "./Topology";
import { Button, Input } from "../components";
import { register, takePendingAgent, unregister, getVersion, subscribe } from "../commands";
import { useFocusMode, useMedia } from "../shell";
import type { Advice, DCtx, Pos, SaveTarget, Tab } from "./types";

/** Debounced after each edit: re-validate, persist draft + node layout. */
const SAVE_DELAY_MS = 550;

/** WS8: the Designer's own collapse point, same value as the CSS media query. */
const COMPACT = "(max-width: 1240px)";

/** WS10: handlers the palette commands call; swapped to no-ops on unmount. */
interface DesignerCommands {
  addAgent: (preset?: any) => void;
  validate: () => Promise<void>;
  pickAgent: (id: string) => void;
  gotoTab: (t: Tab) => void;
}
const NO_COMMANDS: DesignerCommands = {
  addAgent: () => {},
  validate: async () => {},
  pickAgent: () => {},
  gotoTab: () => {},
};

/** Lexically resolve `.`/`..` and duplicate slashes the way the server's path.resolve would. */
function normalizeSavePath(p: string): string {
  const raw = p.trim().replace(/\\/g, "/");
  const abs = raw.startsWith("/");
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push(part);
    } else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** Last path segment — the save hint names the file it will actually write. */
function baseName(p: string): string {
  const parts = normalizeSavePath(p).split("/");
  return parts[parts.length - 1] || p;
}

/**
 * True when saving to `target` would land on the running file. Mirrors the server:
 * relative paths resolve against the running file's directory (config.dir is
 * dirname(filePath)) and a directory target gets mesh.yaml appended. Symlinks and a
 * server restarted with a different config are beyond what the client can see.
 */
function saveLandsOnRunning(target: string, running: string): boolean {
  const r = normalizeSavePath(running);
  const raw = target.trim();
  const dir = r.slice(0, Math.max(0, r.lastIndexOf("/"))) || "/";
  const t = raw.startsWith("/") ? normalizeSavePath(raw) : normalizeSavePath(`${dir}/${raw}`);
  return t === r || `${t}/mesh.yaml` === r;
}

export default function Designer(): React.JSX.Element {
  const { vocab, toast, setView, client } = useMesh();
  // Shell-owned (WS9): this component only paints the mode onto its regions.
  const { focusMode } = useFocusMode();
  const [, setVersion] = useState(0);
  const [cur, setCurState] = useState<string | null>(draft.cur);
  const [layout, setLayoutState] = useState<Record<string, Pos>>(draft.layout);
  const [tab, setTab] = useState<Tab>("crew");
  const [saveMode, setSaveMode] = useState<SaveTarget>(draft.saveMode);
  const [copyPath, setCopyPath] = useState(draft.copyPath);
  const [ready, setReady] = useState(draft.loaded && !!draft.model);
  const [baseline, setBaseline] = useState<string | null>(draft.model ? JSON.stringify(draft.model) : null);
  const [editCount, setEditCount] = useState(0);
  const [result, setResult] = useState<{ status: number; json: any } | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lastYaml, setLastYaml] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [tplOpen, setTplOpen] = useState(false);
  const tplRef = useRef<HTMLDivElement | null>(null);
  const [undo, setUndo] = useState<{ label: string; model: any; cur: string | null } | null>(null);
  const [confirmReplace, setConfirmReplace] = useState<null | { kind: "load" | "template" | "import"; json?: any; model?: any }>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [runningStale, setRunningStale] = useState(false);
  const [savedInfo, setSavedInfo] = useState<{ path: string } | null>(null);
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  /* Bumped whenever `draft.runningRaw` is replaced (load/save). `draft` is a
   * module singleton, so useMemo on it alone would go stale after save. */
  const [runningRev, setRunningRev] = useState(0);
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
  const [railOpen, setRailOpen] = useState(false);
  const [inspOpen, setInspOpen] = useState(false);
  const inspRef = useRef<HTMLDivElement | null>(null);
  const inspReturn = useRef<HTMLElement | null>(null);
  const inspWasOpen = useRef(false);
  // Drawer is local and non-modal: no scrim, no focus trap, no global slot.
  const openInspector = () => {
    if (!compact) return;
    const opener = document.activeElement;
    // Never record an opener inside the drawer: links in the panels switch the
    // selection and would otherwise strand focus on a hidden element on close.
    if (opener instanceof HTMLElement && opener !== document.body && !inspRef.current?.contains(opener)) inspReturn.current = opener;
    setInspOpen(true);
  };
  useEffect(() => {
    if (!compact) return;
    if (inspOpen && !inspWasOpen.current) {
      const root = inspRef.current;
      (root?.querySelector<HTMLElement>("button, a[href], input, select, textarea, [tabindex]") ?? root)?.focus();
    } else if (!inspOpen && inspWasOpen.current) {
      inspReturn.current?.focus();
      inspReturn.current = null;
    }
    inspWasOpen.current = inspOpen;
  }, [inspOpen, compact]);

  // Entering focus hides whole regions (rail/inspector/output) on the same DOM.
  // If focus was inside one of them — palette/Esc entry in WS10, or a click that
  // moved nothing — rehome it on the toggle instead of stranding it in a
  // display:none subtree.
  useEffect(() => {
    if (!focusMode) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(".ms-rail, .ms-insp-wrap, .ms-out")) {
      document.getElementById("ms-focus-toggle")?.focus();
    }
  }, [focusMode]);

  // WS10: a palette "jump to agent" leaves a pending id in commands.ts. Take
  // it as soon as this view can act on it — no bus, no storage, nothing that
  // survives to the next visit if the user never got here.
  useEffect(() => {
    if (!ready || !draft.model) return;
    const id = takePendingAgent();
    if (!id || !draft.model.agents[id]) return;
    draft.cur = id;
    setCurState(id);
    setTab("crew");
    openInspector();
  }, [ready, cmdVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  /* -------- edit plumbing -------- */

  const validate = async () => {
    if (!draft.model) return;
    setChecking(true);
    try {
      const { status, json } = await client.post("/config/validate", { config: draft.model });
      setResult({ status, json });
      setCheckFailed(false);
      if (status === 200 && json?.yaml) setLastYaml(json.yaml);
    } catch {
      setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  };

  /** Call after any mutation of draft.model: re-render + fire the debounce. */
  const touch = () => {
    setVersion((v) => v + 1);
    setEditCount((n) => n + 1);
    setSavedInfo(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void validate();
      storeDraft();
      if (draft.model) saveLayout(draft.model.mesh?.id || "", draft.layout);
    }, SAVE_DELAY_MS);
  };

  const setLayout = (l: Record<string, Pos>) => {
    draft.layout = l;
    setLayoutState(l);
  };

  /* -------- first visit: browser draft > running mesh > starter template -------- */

  useEffect(() => {
    let dead = false;
    (async () => {
      if (draft.loaded && draft.model) {
        setCurState(draft.cur);
        setLayoutState(draft.layout);
        setSaveMode(draft.saveMode);
        setCopyPath(draft.copyPath);
        setBaseline(JSON.stringify(draft.model));
        setReady(true);
        return;
      }
      const applyModel = (raw: any, filePath: string | null, mode: SaveTarget) => {
        draft.model = deepCopy(raw);
        densure(draft.model);
        if (filePath !== null) draft.runningPath = filePath;
        if (mode === "running") {
          draft.runningRaw = deepCopy(raw);
          setRunningRev((v) => v + 1);
        }
        draft.saveMode = mode;
        draft.cur = draft.cur && draft.model.agents[draft.cur] ? draft.cur : Object.keys(draft.model.agents)[0] || null;
        draft.layout = loadLayout(draft.model.mesh?.id || "", Object.keys(draft.model.agents));
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
        draft.saveMode = sm;
        if (stored.copyPath?.trim()) draft.copyPath = stored.copyPath;
        applyModel(stored.model, runningPath || null, runningRaw ? sm : "copy");
        if (runningRaw) {
          /* applyModel marks the restored draft as "running"; the running FILE
           * must stay the diff/stale reference, not the draft itself. */
          draft.runningRaw = deepCopy(runningRaw);
          setRunningRev((v) => v + 1);
        }
        setRestoredAt(stored.ts || Date.now());
      } else if (runningRaw) {
        applyModel(runningRaw, runningPath, "running");
        clearStored();
      } else {
        applyModel(TEMPLATES[1].make(), null, "copy"); // triad starter
      }
      draft.loaded = true;
      setCurState(draft.cur);
      setLayout(draft.layout);
      setSaveMode(draft.saveMode);
      setCopyPath(draft.copyPath);
      setBaseline(JSON.stringify(draft.model));
      setEditCount(0);
      setReady(true);
      void validate();
    })();
    return () => {
      dead = true;
      if (timer.current) clearTimeout(timer.current);
      // A stale closure must not run commands against an unmounted workbench.
      cmdRef.current = NO_COMMANDS;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc closes the local inspector drawer first, then floating menus. The
  // shell runs first and marks what it consumed; only an unconsumed Esc reaches
  // these local layers, and consuming marks the event for the ones below.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (compact && inspOpen) {
        e.preventDefault();
        setInspOpen(false);
      } else if (tplOpen) {
        e.preventDefault();
        setTplOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inspOpen, compact, tplOpen]);

  // A floating menu that only closes on Esc traps the pointer: any click outside
  // the template popover dismisses it too.
  useEffect(() => {
    if (!tplOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!tplRef.current?.contains(e.target as Node)) setTplOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [tplOpen]);

  const m = draft.model;
  const curJson = m ? JSON.stringify(m) : "";
  const dirty = baseline !== null && m !== null && curJson !== baseline;
  const targetPath = saveMode === "running" && draft.runningPath ? draft.runningPath : copyPath.trim();
  const savingRunning = saveMode === "running" && !!draft.runningPath && targetPath === draft.runningPath;
  // copy-target that resolves to the running file would silently overwrite it while
  // reporting "copy": refuse the save and make the user pick the running target.
  const copyTargetsRunning = saveMode === "copy" && !!draft.runningPath && !!targetPath && saveLandsOnRunning(targetPath, draft.runningPath);
  const diff = useMemo(() => (m ? summarizeDiff(m, draft.runningRaw) : []), [curJson, runningRev]); // eslint-disable-line react-hooks/exhaustive-deps
  const src = sourceState({ dirty, diff, runningRaw: draft.runningRaw, saveMode, restoredAt });
  const errors: string[] = result && result.status !== 200 ? (result.json?.errors || ["invalid"]) : [];
  const errTabs = useMemo(() => {
    const counts: Record<Tab, number> = { crew: 0, mesh: 0, policy: 0 };
    for (const e of errors) counts[tabOfError(String(e))]++;
    return counts;
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps
  const agentErr = (id: string): boolean => errors.some((e) => String(e).includes(`'${id}'`));

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /* -------- advisors: soft checks the server won't flag -------- */

  const advisors = useMemo(() => {
    const list: Advice[] = [];
    const mm = m;
    if (!mm) return list;
    const ag = Object.keys(mm.agents || {});
    if (ag.length > 1) {
      for (const id of ag) {
        const outN = ((mm.policies.communication[id] || {}).may_contact || []).filter((t: string) => mm.agents[t] && t !== id).length;
        const inN = ag.filter((o) => o !== id && ((mm.policies.communication[o] || {}).may_contact || []).includes(id)).length;
        if (!outN && !inN) list.push({ level: "warn", tab: "crew", msg: `“${id}” is wired to nobody — it can’t ask for help or be asked.` });
      }
    }
    for (const [g, t] of Object.entries(mm.policies.transitions || {}) as Array<[string, any]>) {
      for (const req of t.requires || []) {
        if (!ag.some((id) => (mm.agents[id]?.authority || []).includes(req))) {
          list.push({ level: "warn", tab: "policy", msg: `gate “${g}” waits for “${req}” but no agent can decide that.` });
        }
      }
    }
    if (ag.length && !(mm.startup?.activate || []).length) list.push({ level: "info", tab: "crew", msg: "nobody boots — going live starts an idle mesh; wake an agent by hand." });
    const sum = ag.reduce((n, id) => n + (mm.budgets?.agent?.[id] ?? mm.agents[id]?.budget?.tokens ?? 200000), 0);
    if (sum > (mm.budgets?.mission?.tokens ?? 2000000)) list.push({ level: "info", tab: "policy", msg: `crew budgets add up to ${fmt(sum)} — more than the ${fmt(mm.budgets?.mission?.tokens)} mission cap. Fine, just know someone stops early.` });
    if (!mm.mesh?.goal?.trim()) list.push({ level: "warn", tab: "mesh", msg: "the mission has no goal — agents will drift." });
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curJson]);

  // WS10: Designer-scoped palette commands, registered only while this view is
  // mounted. The run bodies go through cmdRef because the handlers live below
  // the loading gate; the list re-registers when the selection or the
  // validation result changes so the labels stay true.
  const cmdAgent = m && cur && m.agents[cur] ? cur : null;
  useEffect(() => {
    if (!ready || !m) return;
    register("designer", [
      { id: "designer.add-agent", label: "Add agent", keywords: "hire new crew member", scope: "designer", run: () => cmdRef.current.addAgent() },
      { id: "designer.validate", label: "Run validation", keywords: "check verify config yaml", scope: "designer", run: () => void cmdRef.current.validate() },
      ...(cmdAgent ? [{ id: `designer.open-agent.${cmdAgent}`, label: `Inspect agent “${cmdAgent}”`, keywords: `open agent ${cmdAgent}`, scope: "designer", run: () => cmdRef.current.pickAgent(cmdAgent) }] : []),
      ...(errors.length ? [{ id: "designer.show-errors", label: `Show errors (${errors.length})`, keywords: "problems invalid validation", scope: "designer", run: () => cmdRef.current.gotoTab(tabOfError(String(errors[0]))) }] : []),
    ]);
    return () => unregister("designer");
  }, [ready, m, cmdAgent, result]);

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

  const setCurrent = (id: string | null) => {
    draft.cur = id;
    setCurState(id);
  };
  const commitBaseline = () => {
    setBaseline(JSON.stringify(draft.model));
    setEditCount(0);
  };
  const pushUndo = (label: string) => {
    setUndo({ label, model: deepCopy(draft.model), cur: draft.cur });
  };
  const doUndo = () => {
    if (!undo) return;
    draft.model = deepCopy(undo.model);
    draft.cur = undo.cur;
    setCurState(undo.cur);
    setReviewOpen(false);
    setUndo(null);
    toast("undone", undo.label, "ok");
    touch();
  };
  const syncSaveMode = (mode: SaveTarget, cp: string) => {
    draft.saveMode = mode;
    draft.copyPath = cp;
    setSaveMode(mode);
    setCopyPath(cp);
  };

  const addAgent = (preset?: any) => {
    pushUndo("Added agent");
    let i = 1;
    while (m.agents[`agent-${i}`]) i++;
    const id = `agent-${i}`;
    m.agents[id] = preset ? deepCopy(preset) : { role: `role-${i}`, capabilities: [], authority: [], interests: [] };
    densure(m);
    setCurrent(id);
    setTab("crew");
    setLayout({ ...draft.layout, [id]: { x: CX + ((ids.length % 5) - 2) * 60, y: CY + (Math.floor(ids.length / 5) - 1) * 60 } });
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
    const src = draft.layout[current] || { x: CX, y: CY };
    setLayout({ ...draft.layout, [nid]: { x: clamp(src.x + 48, 40, 960), y: clamp(src.y + 48, 40, 580) } });
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
    const L = { ...draft.layout };
    delete L[c];
    setLayout(L);
    setCurrent(Object.keys(m.agents)[0] || null);
    touch();
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
    const L = { ...draft.layout };
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
  const toggleWire = (src: string, tgt: string) => {
    if (src === tgt) return;
    m.policies.communication[src] ||= { may_contact: [] };
    const l = new Set(m.policies.communication[src].may_contact || []);
    const had = l.has(tgt);
    pushUndo(had ? `Unwired ${src} → ${tgt}` : `Wired ${src} → ${tgt}`);
    if (had) l.delete(tgt); else l.add(tgt);
    m.policies.communication[src].may_contact = [...l];
    touch();
  };
  const autoArrange = () => {
    setLayout(ringLayout(ids));
    touch();
  };

  const applyReplaceModel = (model: any, nextCur: string | null, label: string) => {
    pushUndo(label);
    draft.model = model;
    densure(draft.model);
    draft.cur = nextCur;
    setCurState(nextCur);
    draft.layout = loadLayout(draft.model.mesh?.id || "", Object.keys(draft.model.agents));
    setLayout(draft.layout);
    setReviewOpen(false);
    setConfirmReplace(null);
    setRestoredAt(null);
    commitBaseline();
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
    setTplOpen(false);
  };
  const confirmReplaceDo = () => {
    const c = confirmReplace;
    if (!c) return;
    if (c.kind === "load" && c.json?.raw) {
      draft.runningPath = c.json.filePath || draft.runningPath;
      draft.runningRaw = deepCopy(c.json.raw);
      setRunningRev((v) => v + 1);
      draft.saveMode = "running";
      setSaveMode("running");
      applyReplaceModel(deepCopy(c.json.raw), Object.keys(c.json.raw.agents || {})[0] || null, "Loaded running mesh");
      toast("designer", "editing running mesh — your unsent edits were discarded", "warn");
    } else if (c.kind === "template") {
      applyReplaceModel(c.json, Object.keys(c.json.agents || {})[0] || null, "Loaded template");
    } else if (c.kind === "import" && c.json) {
      applyReplaceModel(c.json, Object.keys(c.json.agents || {})[0] || null, "Imported YAML");
    }
  };

  const loadRunningClick = async () => {
    const { json } = await client.api("GET", "/config");
    if (!json?.raw) return toast("designer", "no running config", "bad");
    if (!dirty) {
      draft.runningPath = json.filePath || draft.runningPath;
      draft.runningRaw = deepCopy(json.raw);
      setRunningRev((v) => v + 1);
      draft.saveMode = "running";
      setSaveMode("running");
      applyReplaceModel(deepCopy(json.raw), Object.keys(json.raw.agents || {})[0] || null, "Loaded running mesh");
      toast("designer", `editing running mesh: ${draft.runningPath}`, "ok");
    } else {
      setConfirmReplace({ kind: "load", json });
    }
  };

  const importApply = async () => {
    const { status, json } = await client.post("/config/parse", { yaml: importText });
    if (status !== 200) return toast("parse failed", (json.errors || []).join("; ").slice(0, 200), "bad");
    setImportOpen(false);
    requestReplace("import", json.config);
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
        if (json?.raw && JSON.stringify(json.raw) !== JSON.stringify(draft.runningRaw)) setRunningStale(true);
      } catch {
        /* offline: review still shows the diff */
      }
    }
    setReviewOpen(true);
    window.setTimeout(() => document.getElementById("d-review")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  };
  const doSave = async () => {
    if (copyTargetsRunning) return toast("save failed", RUNNING_PATH_CONFLICT, "bad");
    const { status, json } = await client.post("/config/save", { config: draft.model, path: targetPath });
    if (status === 200) {
      if (savingRunning) {
        draft.runningRaw = deepCopy(draft.model);
        setRunningRev((v) => v + 1);
      }
      setReviewOpen(false);
      setRunningStale(false);
      commitBaseline();
      setUndo(null);
      setRestoredAt(null);
      clearStored();
      setSavedInfo({ path: json.savedTo });
      toast("saved", json.savedTo, "ok");
    } else toast("save failed", (json?.errors || ["invalid"]).join("; ").slice(0, 240), "bad");
  };

  /* -------- derived header state -------- */

  const valid = result?.status === 200;
  const verdictState = checking ? "checking…" : result ? (valid ? "valid" : `${errors.length} errors`) : checkFailed ? "check failed" : "checking…";
  const verdictTone = !result ? (checkFailed ? "warn" : "") : valid ? "ok" : "bad";
  const saveLabel = !draft.runningPath ? "Save mesh" : savingRunning ? "Save running config" : "Save copy";
  const gotoTab = (t: Tab) => {
    setTab(t);
    if (t === "crew" && !current && ids[0]) setCurrent(ids[0]);
    openInspector();
    document.querySelector(".ms-body")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Picking an agent (rail, node or gate link) reveals its inspector on compact.
  const pickAgent = (id: string) => {
    setCurrent(id);
    setTab("crew");
    openInspector();
  };

  const ctx: DCtx = {
    m, cur: current, ids, vocab, ints, touch, pushUndo,
    startupSet, toggleStartup, addAgent, duplicateAgent, deleteAgent, renameAgent, toggleWire,
    setCur: pickAgent,
  };
  cmdRef.current = { addAgent, validate, pickAgent, gotoTab };

  return (
    <div className={`ms${focusMode ? " focus" : ""}`}>
      <header className="ms-head">
        <div className="view-title">
          <h2>Mesh Designer</h2>
          <Button variant="small" extra="ms-insp-toggle" id="ms-insp-toggle" aria-expanded={inspOpen} aria-controls="ms-inspector" onClick={() => (inspOpen ? setInspOpen(false) : openInspector())}>
            {inspOpen ? "close inspector" : "inspect agent"}
          </Button>
        </div>
        <div className="ms-workspace">
          <b>{m.mesh?.name?.trim() || "Untitled mesh"}</b>
          {m.mesh?.id ? <span className="mono muted">{m.mesh.id}</span> : null}
          {m.mesh?.goal?.trim() ? <span className="ms-goal">— {m.mesh.goal.trim()}</span> : <span className="muted">— no goal yet</span>}
        </div>
        <div className="ms-state" role="status">
          <b>{ids.length}</b> agent{ids.length === 1 ? "" : "s"}
          <span aria-hidden="true">·</span>
          <b>{links.length}</b> wire{links.length === 1 ? "" : "s"}
          <span aria-hidden="true">·</span>
          <span className={`ms-verdict ${verdictTone}`}>{verdictState}</span>
        </div>
        <div className="view-sub">
          Editing <b>{targetPath || "…"}</b>
          {draft.runningPath
            ? savingRunning
              ? " — the running file. Saving writes it; restart the mesh to apply."
              : " — a new file. Saving writes it; the running mesh keeps working untouched."
            : "."}
        </div>
      </header>

      <HealthStrip
        onGoto={gotoTab}
        startupCount={startupSet.size}
        gates={Object.keys(m.policies.transitions || {}).length}
        advice={advisors}
        undoLabel={undo ? undo.label : null}
        onUndo={doUndo}
      />
      <AdvisoryList advice={advisors} onGoto={gotoTab} />

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

      <div className={`ms-body${railOpen ? " rail-open" : ""}`}>
        <CrewRail
          agents={m.agents}
          ids={ids}
          current={current}
          startup={startupSet}
          hasError={agentErr}
          open={railOpen}
          onToggle={() => setRailOpen((v) => !v)}
          onPick={pickAgent}
          onHire={() => addAgent()}
        />
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
          onSelect={pickAgent}
          onWire={toggleWire}
          onCut={toggleWire}
          onBoot={toggleStartup}
          onArrange={autoArrange}
          onTemplate={(model) => requestReplace("template", model)}
          onAddAgent={() => addAgent()}
        />
        <div id="ms-inspector" className={`ms-insp-wrap${inspOpen ? " open" : ""}`} ref={inspRef}>
          <button type="button" className="ms-insp-close" aria-label="close inspector" onClick={() => setInspOpen(false)}>×</button>
          <Inspector ctx={ctx} tab={tab} setTab={setTab} errTabs={errTabs} />
        </div>
      </div>

      <div className="ms-out">
        {reviewOpen ? (
          <ReviewCard
            targetPath={targetPath}
            savingRunning={savingRunning}
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
            isRunning={savingRunning || savedInfo.path === draft.runningPath}
            onYaml={() => document.getElementById("d-yaml")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            onHome={() => setView("overview")}
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
        <div className="ms-out-grid">
          <CheckSection
            checking={checking}
            valid={valid}
            errors={errors}
            offline={checkFailed}
            onGoto={gotoTab}
          />
          <YamlCard
            yaml={lastYaml}
            targetPath={targetPath}
            invalid={result?.status !== 200}
            stale={checkFailed}
            onCopy={() => { void navigator.clipboard?.writeText(lastYaml || "").then(() => toast("yaml", "copied", "ok"), () => toast("yaml", "clipboard blocked", "warn")); }}
          />
        </div>
      </div>

      {/* sticky action bar: the one place that saves */}
      <div className="wb-bar" role="toolbar" aria-label="designer actions">
        <div className="wb-bar-target">
          <span className="wb-bar-label" id="d-save-to">save to</span>
          <div className="wb-seg" role="radiogroup" aria-labelledby="d-save-to">
            <label className="wb-seg-opt" title={draft.runningPath ? `overwrite the running file: ${draft.runningPath}` : "no running file is loaded"}>
              <input type="radio" name="d-save-target" checked={saveMode === "running" && !!draft.runningPath} disabled={!draft.runningPath} onChange={() => syncSaveMode("running", copyPath)} />
              <span>running</span>
            </label>
            <label className="wb-seg-opt" title="write a new file; the running mesh is untouched">
              <input type="radio" name="d-save-target" checked={saveMode === "copy" || !draft.runningPath} onChange={() => syncSaveMode("copy", copyPath)} />
              <span>copy</span>
            </label>
          </div>
          {(saveMode === "copy" || !draft.runningPath) ? (
            <Input extra="wb-bar-path" value={copyPath} aria-label="copy save path" placeholder="examples/my-mesh/mesh.yaml" onChange={(e) => syncSaveMode("copy", e.target.value)} />
          ) : <span className="mono muted wb-bar-path" title={draft.runningPath} dir="rtl">{draft.runningPath}</span>}
        </div>
        <div className="wb-bar-mid">
          <SourceStateLine state={src} reviewOpen={reviewOpen} onToggleReview={() => setReviewOpen(!reviewOpen)} />
        </div>
        <div className="wb-bar-actions">
          <Button variant="small" danger onClick={() => requestReplace("template", TEMPLATES[1].make())}>reset…</Button>
          <span className="wb-bar-sep" aria-hidden="true" />
          <div className="ms-tpl" ref={tplRef}>
            <Button variant="small" aria-expanded={tplOpen} aria-haspopup="menu" onClick={() => setTplOpen(!tplOpen)}>template ▾</Button>
            {tplOpen ? (
              <div className="ms-tpl-menu" role="menu">
                {TEMPLATES.map((t) => (
                  <button key={t.key} role="menuitem" onClick={() => requestReplace("template", t.make())}>
                    <b>{t.name}</b> <span className="muted">{t.desc}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <Button variant="small" disabled={!draft.runningPath} onClick={() => void loadRunningClick()}>reload running</Button>
          <Button variant="small" onClick={() => setImportOpen(!importOpen)}>import</Button>
          <span className="wb-bar-sep" aria-hidden="true" />
          <div className="wb-bar-save">
            <Button variant="primary" aria-describedby="d-save-caveat" disabled={!targetPath || checking} onClick={() => void openReview()}>{saveLabel}</Button>
            <span className="wb-bar-hint" id="d-save-caveat">
              {targetPath ? <>writes <b className="mono">{baseName(targetPath)}</b> · restart to apply</> : "pick a save target"}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}