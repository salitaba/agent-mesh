/**
 * Starting a project: the welcome on a fresh host, and the same three ways in from the "New project" button.
 *
 *   Try the demo          a scripted team on the stub runtime: no API key, no model calls. One click.
 *   Create a new mesh     the default team on the Claude runtime, in a folder the person picks.
 *   Add an existing folder  a folder that already holds a mesh.yaml. Nothing is written.
 *
 * Each says what it needs, what it costs and which files it writes where, from facts the host read out of its own files
 * (`GET /api/templates`), so no name or count here can drift from what the host does. Nothing is written until a button is
 * pressed, and a folder that already holds a mesh.yaml is never replaced.
 *
 * Every sentence and every "may this button be pressed" decision is in firstrun.ts, where a test holds it.
 */
import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "./firstrun.css";
import { Button, IconButton, PageHeader, useDismissable } from "./components";
import { Icon, type IconName } from "./icons";
import { api } from "./api";
import { useProjects } from "./projects";
import { hashFor } from "./route";
import { FolderPickerModal } from "./folderpicker";
import {
  failureText,
  folderVerdict,
  landingView,
  looksAbsolute,
  parseTemplates,
  pickDefault,
  pickDemo,
  readBrowse,
  whatHappensNext,
  whatItCosts,
  whatItIs,
  whatItNeeds,
  whatItTakes,
  writesWhat,
  type FolderFacts,
  type FolderVerdict,
  type Intent,
  type TemplatesAnswer,
} from "./firstrun";

type TemplatesState =
  | { phase: "loading" }
  | { phase: "ready"; answer: TemplatesAnswer }
  /** The host has no `/api/templates`: an older host. Adding a folder that holds a mesh.yaml still works. */
  | { phase: "unsupported" }
  | { phase: "error"; message: string };

function useTemplates(): { state: TemplatesState; reload: () => void } {
  const [state, setState] = useState<TemplatesState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    void (async () => {
      let res: Awaited<ReturnType<typeof api>> | null;
      try {
        res = await api("GET", "/api/templates");
      } catch {
        res = null;
      }
      if (!alive) return;
      if (res === null || res.status === 0) return setState({ phase: "error", message: failureText(null) });
      if (res.status === 404) return setState({ phase: "unsupported" });
      const answer = res.status === 200 ? parseTemplates(res.json) : null;
      setState(answer ? { phase: "ready", answer } : { phase: "error", message: `The host answered ${res.status} and offered nothing to start from.` });
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);
  return { state, reload: useCallback(() => setAttempt((n) => n + 1), []) };
}

/**
 * Asks the host about the folder in a field once the person stops typing, and judges it for what the card does. Facts about
 * an earlier path are never read as facts about this one.
 */
function useFolderVerdict(path: string, intent: "create" | "add"): { verdict: FolderVerdict; checking: boolean } {
  const [facts, setFacts] = useState<FolderFacts | null>(null);
  const [about, setAbout] = useState("");
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const p = path.trim();
    if (!p || !looksAbsolute(p)) {
      setFacts(null);
      setAbout(p);
      setChecking(false);
      return;
    }
    setChecking(true);
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        let res: Awaited<ReturnType<typeof api>> | null;
        try {
          res = await api("GET", `/api/browse?path=${encodeURIComponent(p)}`);
        } catch {
          res = null;
        }
        if (!alive) return;
        setFacts(res && res.status !== 0 ? readBrowse(res.status, res.json) : null);
        setAbout(p);
        setChecking(false);
      })();
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [path]);
  return { verdict: folderVerdict(intent, path, about === path.trim() ? facts : null), checking };
}

/**
 * Makes or registers the project, brings its process up, and takes the person where that way of starting leads. The host
 * is asked to open it BEFORE the console switches to it, so the first thing on screen is a project that is answering and
 * not a stream of refusals from one that is still starting. A project that fails to come up is shown as what it is.
 */
function useStart(onDone?: () => void) {
  const { addProject, openProject, setActive } = useProjects();
  const [busy, setBusy] = useState<Intent | null>(null);
  const [phase, setPhase] = useState<"adding" | "opening">("adding");
  const [errors, setErrors] = useState<Partial<Record<Intent, string>>>({});
  const run = useCallback(
    async (intent: Intent, root: string, opts: { template?: string }) => {
      setBusy(intent);
      setPhase("adding");
      setErrors({});
      const res = await addProject(root, opts);
      if (!res.ok || !res.project) {
        setBusy(null);
        setErrors({ [intent]: failureText(res) });
        return;
      }
      setPhase("opening");
      const id = res.project.id;
      // If the host refuses to open it (the plan allows one open project at a time), the refusal is posted to the notice under
      // the strip, which outlives this page; the project is made and registered either way, so the person goes to it.
      await openProject(id);
      setActive(id);
      window.location.hash = hashFor(id, landingView(intent));
      setBusy(null);
      onDone?.();
    },
    [addProject, openProject, setActive, onDone],
  );
  return { busy, phase, errors, run };
}

function VerdictLine({ verdict, checking, id }: { verdict: FolderVerdict; checking: boolean; id: string }): React.JSX.Element {
  const icon: IconName = verdict.tone === "ok" ? "check" : verdict.tone === "neutral" ? "info" : "alert";
  return (
    <p id={id} className={`fr-verdict ${verdict.tone}`} role="status" aria-live="polite">
      {verdict.message ? (
        <>
          <Icon name={icon} size={14} />
          <span>{verdict.message}</span>
        </>
      ) : checking ? (
        <span className="muted">Checking the folder…</span>
      ) : null}
    </p>
  );
}

/**
 * A path you can type, a way to browse, and one line saying what the host found there. `caption` is the sentence above it
 * that says what is about to be written in this folder; the field is named by `label` and described by both.
 */
function FolderField({ id, label, caption, value, onChange, onBrowse, verdict, checking, placeholder, disabled }: {
  id: string;
  label: string;
  /** When given, it is shown instead of the label, which then only names the field for a screen reader. */
  caption?: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
  verdict: FolderVerdict;
  checking: boolean;
  placeholder?: string;
  disabled?: boolean;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // A folder is told apart by the end of its path, and a field shows the start. Unless the person is typing in it, it is
  // scrolled to the end, so a chosen or suggested folder reads as its name.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  }, [value]);
  return (
    <div className="fr-folder">
      <label htmlFor={id} className={caption ? "sr-only" : undefined}>{label}</label>
      {caption ? <p id={`${id}-caption`} className="fr-caption">{caption}</p> : null}
      <div className="fr-folder-row">
        <input
          id={id}
          ref={inputRef}
          className="txt mono"
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          aria-describedby={`${caption ? `${id}-caption ` : ""}${id}-verdict`}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => {
            e.currentTarget.scrollLeft = e.currentTarget.scrollWidth;
          }}
        />
        <Button variant="soft" icon="folder" disabled={disabled} onClick={onBrowse}>Browse</Button>
      </div>
      <VerdictLine id={`${id}-verdict`} verdict={verdict} checking={checking} />
    </div>
  );
}

function Fact({ label, tone, children }: { label: string; tone?: "ok" | "warn"; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="fr-fact">
      <dt>{label}</dt>
      {/* A sentence the person has to act on carries a mark as well as words; the words stay in the ordinary colour. */}
      <dd>{tone === "warn" ? <Icon name="alert" size={14} className="fr-warn-mark" /> : null}{children}</dd>
    </div>
  );
}

function Card({ icon, title, tag, tagTone, lead, children, actions, id }: {
  icon: IconName;
  title: string;
  tag?: string;
  tagTone?: "ok" | "warn";
  lead: React.ReactNode;
  children?: React.ReactNode;
  actions: React.ReactNode;
  id: string;
}): React.JSX.Element {
  return (
    <section className="fr-card" aria-labelledby={id}>
      <header className="fr-card-head">
        <span className="fr-card-icon" aria-hidden="true"><Icon name={icon} size={18} /></span>
        <div className="fr-card-title">
          <h3 id={id}>{title}</h3>
          {tag ? <span className={`fr-tag${tagTone ? ` ${tagTone}` : ""}`}>{tag}</span> : null}
        </div>
      </header>
      <p className="fr-lead">{lead}</p>
      {children}
      <div className="fr-card-acts">{actions}</div>
    </section>
  );
}

/** What stands where a card's facts would be, when the host has not said or cannot. */
function Unavailable({ state, reload, what }: { state: TemplatesState; reload: () => void; what: string }): React.JSX.Element {
  if (state.phase === "loading") return <p className="fr-quiet" role="status">Asking this host what it can offer…</p>;
  if (state.phase === "unsupported") {
    return <p className="fr-quiet">This host cannot make projects from the dashboard. From a shell: <code>curule init &lt;folder&gt;</code>, then add the folder here.</p>;
  }
  if (state.phase === "error") {
    return (
      <div className="fr-quiet" role="alert">
        <p>Could not load what this host offers. {state.message}</p>
        <Button variant="small" icon="refresh" onClick={reload}>Try again</Button>
      </div>
    );
  }
  return <p className="fr-quiet">This install does not include {what}.</p>;
}

export function NewProject({ layout, onDone, onPickerChange }: {
  layout: "row" | "stack";
  /** Called once a project is made and the console has moved to it. */
  onDone?: () => void;
  /** Told when the folder picker opens or closes, so a dialog around this can leave Escape to the picker. */
  onPickerChange?: (open: boolean) => void;
}): React.JSX.Element {
  const ids = useId();
  const { state, reload } = useTemplates();
  const { hostSpend } = useProjects();
  const start = useStart(onDone);
  const answer = state.phase === "ready" ? state.answer : null;
  const demo = answer ? pickDemo(answer) : null;
  const dflt = answer ? pickDefault(answer) : null;
  const ceiling = hostSpend?.ceilingUsd ?? null;
  const busy = start.busy !== null;

  // `null` means "the folder the host suggested": it is shown, and used, until the person changes it.
  const [demoFolder, setDemoFolder] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [existing, setExisting] = useState("");
  const [picker, setPicker] = useState<{ intent: Intent; initial: string } | null>(null);
  const openPicker = (intent: Intent, initial: string): void => {
    setPicker({ intent, initial });
    onPickerChange?.(true);
  };
  const closePicker = (): void => {
    setPicker(null);
    onPickerChange?.(false);
  };

  const demoPath = demoFolder ?? demo?.suggestedRoot ?? "";
  const newPath = newFolder ?? dflt?.suggestedRoot ?? "";
  // A folder the host chose is free by construction; only one the person typed needs asking about.
  const demoCheck = useFolderVerdict(demoFolder ?? "", "create");
  const newCheck = useFolderVerdict(newPath, "create");
  const existingCheck = useFolderVerdict(existing, "add");

  const demoNeeds = demo && answer ? whatItNeeds(demo, answer.modelAccess, answer.managed) : null;
  const newNeeds = dflt && answer ? whatItNeeds(dflt, answer.modelAccess, answer.managed) : null;
  const takes = demo ? whatItTakes(demo) : null;
  const working = (intent: Intent, idle: string): string => (start.busy === intent ? (start.phase === "adding" ? "Creating…" : "Opening…") : idle);

  return (
    <div className={`fr-paths ${layout}`} aria-busy={busy}>
      {/* ------------------------------------------------------------------------------------------ the demo */}
      <Card
        id={`${ids}-demo`}
        icon="play"
        title="Try the demo"
        tag={demo && !demo.needsApiKey ? "No API key needed" : undefined}
        tagTone="ok"
        lead={demo ? whatItIs(demo) : "A scripted team that runs with no API key."}
        actions={
          <>
            <Button
              variant="primary"
              icon="play"
              extra="fr-go"
              disabled={!demo || busy || (demoFolder !== null && !demoCheck.verdict.canProceed)}
              onClick={() => demo && void start.run("demo", demoPath, { template: demo.id })}
            >
              {working("demo", "Create the demo")}
            </Button>
            {start.errors.demo ? <p className="fr-error" role="alert"><Icon name="alert" size={14} /><span>{start.errors.demo}</span></p> : null}
            {demo ? <p className="fr-after">{whatHappensNext("demo")}</p> : null}
          </>
        }
      >
        {demo && demoNeeds ? (
          <>
            <dl className="fr-facts">
              <Fact label="Needs" tone={demoNeeds.tone}>{demoNeeds.text}</Fact>
              <Fact label="Costs">{whatItCosts(demo, ceiling, answer?.managed)}</Fact>
              {takes ? <Fact label="Takes">{takes}</Fact> : null}
            </dl>
            {demoFolder === null ? (
              <div className="fr-folder">
                <p className="fr-caption">Writes {writesWhat(demo)} in:</p>
                <div className="fr-path-row">
                  <span className="fr-path path-start mono" title={demoPath}><bdi>{demoPath}</bdi></span>
                  <Button variant="small" disabled={busy} onClick={() => setDemoFolder(demoPath)}>Change folder</Button>
                </div>
              </div>
            ) : (
              <FolderField
                id={`${ids}-demo-folder`}
                label="Folder"
                caption={`Writes ${writesWhat(demo)} in:`}
                value={demoFolder}
                onChange={setDemoFolder}
                onBrowse={() => openPicker("demo", demoFolder)}
                verdict={demoCheck.verdict}
                checking={demoCheck.checking}
                disabled={busy}
              />
            )}
          </>
        ) : (
          <Unavailable state={state} reload={reload} what="the demo" />
        )}
      </Card>

      {/* ------------------------------------------------------------------------------------ a new mesh */}
      <Card
        id={`${ids}-new`}
        icon="plus"
        title="Create a new mesh"
        tag={dflt?.needsApiKey ? (answer?.managed ? "Models supplied" : answer && answer.modelAccess.length > 0 ? "Model access found" : "Needs model access") : undefined}
        tagTone={dflt?.needsApiKey ? (answer?.managed || (answer && answer.modelAccess.length > 0) ? "ok" : "warn") : undefined}
        lead={dflt ? whatItIs(dflt) : "The default team, in a folder you choose."}
        actions={
          <>
            <Button
              variant="soft"
              icon="plus"
              extra="fr-go"
              disabled={!dflt || busy || !newCheck.verdict.canProceed}
              onClick={() => dflt && void start.run("new", newPath, { template: dflt.id })}
            >
              {working("new", "Create the mesh")}
            </Button>
            {start.errors.new ? <p className="fr-error" role="alert"><Icon name="alert" size={14} /><span>{start.errors.new}</span></p> : null}
            {dflt ? <p className="fr-after">{whatHappensNext("new")}</p> : null}
          </>
        }
      >
        {dflt && newNeeds ? (
          <>
            <dl className="fr-facts">
              <Fact label="Needs" tone={newNeeds.tone}>{newNeeds.text}</Fact>
              <Fact label="Costs">{whatItCosts(dflt, ceiling, answer?.managed)}</Fact>
            </dl>
            <FolderField
              id={`${ids}-new-folder`}
              label="Folder"
              caption={`Writes ${writesWhat(dflt)} in this folder. Its name becomes the project's name.`}
              value={newPath}
              onChange={setNewFolder}
              onBrowse={() => openPicker("new", newPath)}
              verdict={newCheck.verdict}
              checking={newCheck.checking}
              disabled={busy}
            />
          </>
        ) : (
          <Unavailable state={state} reload={reload} what="the default team" />
        )}
      </Card>

      {/* ------------------------------------------------------------------------- an existing folder */}
      <Card
        id={`${ids}-existing`}
        icon="folder"
        title="Add an existing folder"
        tag="Needs a mesh.yaml"
        lead="Register a folder that already holds a mesh.yaml. Adding it changes nothing in the folder."
        actions={
          <>
            <Button
              variant="soft"
              icon="check"
              extra="fr-go"
              disabled={busy || !existingCheck.verdict.canProceed}
              onClick={() => void start.run("existing", existing.trim(), {})}
            >
              {working("existing", "Add the folder")}
            </Button>
            {start.errors.existing ? <p className="fr-error" role="alert"><Icon name="alert" size={14} /><span>{start.errors.existing}</span></p> : null}
            <p className="fr-after">{whatHappensNext("existing")}</p>
          </>
        }
      >
        <FolderField
          id={`${ids}-existing-folder`}
          label="Folder"
          value={existing}
          placeholder="/path/to/project"
          onChange={setExisting}
          onBrowse={() => openPicker("existing", existing)}
          verdict={existingCheck.verdict}
          checking={existingCheck.checking}
          disabled={busy}
        />
        {existingCheck.verdict.offerCreate && dflt ? (
          <div className="fr-offer">
            <p>You can make a mesh in this folder instead. That writes {writesWhat(dflt)} here, and nothing else.</p>
            <Button variant="small" icon="plus" disabled={busy} onClick={() => void start.run("new", existing.trim(), { template: dflt.id })}>
              Create a new mesh here
            </Button>
          </div>
        ) : null}
      </Card>

      {picker ? (
        <FolderPickerModal
          initialPath={picker.initial}
          title={picker.intent === "existing" ? "Choose the folder that holds a mesh.yaml" : "Choose a folder"}
          onClose={closePicker}
          onChoose={(path) => {
            if (picker.intent === "demo") setDemoFolder(path);
            else if (picker.intent === "new") setNewFolder(path);
            else setExisting(path);
            closePicker();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * What every project adds once it runs, whichever card made it. The cards say what they write; this says what running writes,
 * because "nothing is written" about a folder that then grows a .mesh and a workspace would not be the whole truth.
 */
function RunWrites(): React.JSX.Element {
  return (
    <p>
      Once a project runs, it also keeps a <code>.mesh</code> folder (its process id and logs) and a <code>workspace</code> folder (the team's files and
      the event log) inside its own folder.
    </p>
  );
}

/**
 * The page a fresh host opens on. It replaces "No project open" and a button: three ways to start, each saying what it
 * needs, what it costs and which files it writes where. The shell shows it in place of every project page while the
 * registry is empty.
 */
export function Welcome(): React.JSX.Element {
  return (
    <div className="fr-welcome">
      <PageHeader
        title="Welcome to Curule"
        lede="This host has no project yet. A project is a folder with a mesh.yaml: a team of agents and the goal they work on. Choose how to start."
      />
      <NewProject layout="row" />
      <div className="fr-aside">
        <RunWrites />
        <p>
          From a shell, the same steps are <code>curule init &lt;folder&gt;</code> and <code>curule project add &lt;folder&gt;</code>.
        </p>
      </div>
    </div>
  );
}

/** The same three ways, over whatever page is open, from the New project button. */
export function NewProjectDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  // The folder picker opens above this dialog, and both listen for Escape. While the picker is up, Escape is its.
  const pickerOpen = useRef(false);
  const ref = useDismissable<HTMLDivElement>(true, () => {
    if (!pickerOpen.current) onClose();
  });
  return (
    <>
      <div className="pj-scrim" aria-hidden="true" onClick={onClose} />
      <div className="np-dialog" role="dialog" aria-modal="true" aria-labelledby="np-title" ref={ref}>
        {/* A div, not a header: a header outside a section is the page's banner landmark, and a dialog is not the page. */}
        <div className="np-head">
          <div>
            <h2 id="np-title">New project</h2>
            <p className="muted">A project is a folder with a mesh.yaml. Choose how to start.</p>
          </div>
          <IconButton icon="x" label="Close" onClick={onClose} />
        </div>
        <NewProject layout="stack" onDone={onClose} onPickerChange={(open) => { pickerOpen.current = open; }} />
        <div className="fr-aside">
          <RunWrites />
        </div>
      </div>
    </>
  );
}
