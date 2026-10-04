import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import "./product.css";
import { dur } from "../format";
import { projectPath } from "../route";
import { useMesh } from "../store";
import { Button, CopyButton, ErrorState, Input, PageHeader, Pill, useNow, type PillTone } from "../components";
import { Icon } from "../icons";
import { FileView, type DiffPayload, type FileKind } from "../fileview";
import { fmtSize } from "../files";
import { useMedia, WIDE } from "../useMedia";
import {
  TREE_WINDOW,
  changeKind,
  describeScript,
  failureLines,
  hasManifest,
  hasPlayground,
  isCapped,
  lastLines,
  noScriptsCopy,
  orderScripts,
  parseCommits,
  readPackage,
  runOutcome,
  type PackageState,
  type ScriptInfo,
} from "../product";

/* The delivered codebase: where it is, what is in it, and whether it works.
 *
 * "Does it work?" is answered by running the product's own scripts, so the page says exactly what each button runs and
 * where (the host runs `npm run <name>` in this checkout, one script at a time; see apps/mesh-server/src/index.ts), shows
 * the output in a labelled panel that leads with the lines that failed, and remembers a run you walked away from: the host
 * keeps running it, and coming back used to show idle buttons that answered 409. */

interface TreeEntry { name: string; path: string; type: "dir" | "file"; size: number }
interface OpenFile { path: string; content?: string; kind: FileKind; dataUrl?: string; size?: number }
interface SearchHit { path: string; line: number; text: string; kind: "name" | "content" }
interface Change { path: string; status: string }
interface WorkspaceInfo { path: string; gitRepo: string; gitBranch: string; gitHead: string; gitClean: string; gitLog: string; scripts: string[] }

interface RunState {
  id: string;
  script: string;
  command: string;
  done: boolean;
  exitCode: number | null;
  log: string;
  /** The browser's clock. The host's `startedAt` is on its own, and two clocks are not a duration. */
  startedAt: number;
  endedAt?: number;
  /** The person pressed Stop in this page. */
  stopped?: boolean;
  /** The host answered "unknown run": it restarted, and runs live in its memory. */
  lost?: boolean;
}

const runKey = (projectId: string | null): string => `mesh-run:${projectId ?? "-"}`;
function recall(projectId: string | null): Pick<RunState, "id" | "script" | "command" | "startedAt"> | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(runKey(projectId)) ?? "null") as Partial<RunState> | null;
    return t && typeof t.id === "string" && typeof t.script === "string" ? { id: t.id, script: t.script, command: String(t.command ?? ""), startedAt: Number(t.startedAt) || Date.now() } : null;
  } catch {
    return null;
  }
}
function remember(projectId: string | null, r: Pick<RunState, "id" | "script" | "command" | "startedAt"> | null): void {
  try {
    if (r) sessionStorage.setItem(runKey(projectId), JSON.stringify(r));
    else sessionStorage.removeItem(runKey(projectId));
  } catch {
    /* a private window: the run is simply not remembered */
  }
}

function Elapsed({ since }: { since: number }): React.JSX.Element {
  const now = useNow(1000);
  return <>{dur(Math.max(0, now - since))}</>;
}

function RunChip({ run }: { run: RunState }): React.JSX.Element {
  const outcome = runOutcome(run, run.lost);
  const stopping = run.stopped && !run.done;
  const took = run.endedAt ? ` in about ${dur(run.endedAt - run.startedAt)}` : "";
  if (stopping) return <span className="run-chip warn" role="status"><Icon name="stop" size={14} />Stopping</span>;
  switch (outcome) {
    case "running": return <span className="run-chip live" role="status"><i className="dot" aria-hidden="true" />Running <Elapsed since={run.startedAt} /></span>;
    case "passed": return <span className="run-chip ok" role="status"><Icon name="check" size={14} />Passed{took}</span>;
    case "failed": return <span className="run-chip bad" role="status"><Icon name="x" size={14} />Failed, exit code {run.exitCode}{took}</span>;
    case "stopped": return <span className="run-chip warn" role="status"><Icon name="stop" size={14} />{run.stopped ? "Stopped" : "Ended by a signal"}{took ? ` after about ${dur(run.endedAt! - run.startedAt)}` : ""}</span>;
    default: return <span className="run-chip warn" role="status"><Icon name="alert" size={14} />Output lost</span>;
  }
}

function RunOutput({ run, onStop, onClear }: { run: RunState; onStop: () => void; onClear: () => void }): React.JSX.Element {
  const logRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  // Follow the end of the log while the person has not scrolled up to read something.
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [run.log]);
  const outcome = run.stopped && run.done ? "stopped" : runOutcome(run, run.lost);
  const fails = outcome === "failed" ? failureLines(run.log) : null;
  const tail = outcome === "failed" && fails && fails.total === 0 ? lastLines(run.log, 8) : outcome === "passed" ? lastLines(run.log, 3) : [];
  return (
    <section className="card prod-out" id="run-out" aria-labelledby="run-out-h" tabIndex={-1}>
      <div className="prod-h">
        <h3 id="run-out-h">Output of <code>{run.command}</code></h3>
        <RunChip run={run} />
        <span className="grow" />
        {!run.done && !run.lost ? <Button variant="small" icon="stop" disabled={run.stopped} onClick={onStop}>{run.stopped ? "Stopping…" : "Stop"}</Button> : null}
        {run.log ? <CopyButton text={run.log} label="Copy output" /> : null}
        {run.done || run.lost ? <Button variant="small" icon="x" onClick={onClear}>Dismiss</Button> : null}
      </div>
      {run.lost ? (
        <p className="prod-note">The host no longer has this run. It restarted, and a host keeps its runs in memory. Run the script again to see its output.</p>
      ) : (
        <>
          {fails && fails.total > 0 ? (
            <div className="run-fails" role="group" aria-label="The lines that say what failed">
              <div className="run-fails-h">What failed <span>{fails.total === 1 ? "1 line" : `${fails.total} lines`}</span></div>
              <ol>
                {fails.lines.map((l) => (
                  <li key={l.n}><span className="run-ln" title={`Line ${l.n} of the output`}>{l.n}</span><code>{l.text}</code></li>
                ))}
              </ol>
              {fails.total > fails.lines.length ? <div className="run-fails-more">and {fails.total - fails.lines.length} more in the full output below</div> : null}
            </div>
          ) : null}
          {outcome === "failed" && fails && fails.total === 0 ? (
            <p className="prod-note">The script exited with code {run.exitCode} and printed no line this page recognises as an error. Its last lines are below.</p>
          ) : null}
          {tail.length ? (
            <div className="run-tail" role="group" aria-label={outcome === "passed" ? "The end of the output" : "The last lines of the output"}>
              <div className="run-tail-h" aria-hidden="true">{outcome === "passed" ? "The end of the output" : "The last lines of the output"}</div>
              {tail.map((l) => <div key={l.n}><span className="run-ln">{l.n}</span><code>{l.text}</code></div>)}
            </div>
          ) : null}
          {outcome === "stopped" ? (
            <p className="prod-note">
              {run.stopped ? "You stopped this run." : "The run ended without an exit code, which means a signal ended it."} The output so far is below.
              {/* The host signals the npm process only. A server that npm started in turn can outlive it, and saying "stopped" without this would be a flattering half-truth. */}
              {describeScript(run.script, null).usuallyStays ? " The host stops the npm process only: a server the script started may still be running. If its port stays busy, stop it from a shell on the host." : ""}
            </p>
          ) : null}
          <div className="run-full-h">Full output{isCapped(run.log) ? <span> (the host keeps the last 60,000 characters; earlier output was dropped)</span> : null}</div>
          <pre
            ref={logRef}
            className="run-log"
            role="region"
            aria-label={`Full output of ${run.command}`}
            tabIndex={0}
            onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
          >{run.log || "No output yet."}</pre>
        </>
      )}
    </section>
  );
}

export default function Product(): React.JSX.Element {
  const { toast, goalId, client, projectId } = useMesh();
  const wide = useMedia(WIDE);
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [wsErr, setWsErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [changes, setChanges] = useState<Change[]>([]);
  const [showAllChanges, setShowAllChanges] = useState(false);
  const [pkg, setPkg] = useState<{ state: PackageState; scripts: Record<string, string> | null }>({ state: "unknown", scripts: null });
  const [dir, setDir] = useState("");
  const [tree, setTree] = useState<TreeEntry[] | null>(null);
  const [treeErr, setTreeErr] = useState<string | null>(null);
  const [treeLimit, setTreeLimit] = useState(TREE_WINDOW);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [fileDiff, setFileDiff] = useState<DiffPayload | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const [builtCheck, setBuiltCheck] = useState(0);
  const [playground, setPlayground] = useState<"checking" | "ready" | "missing">("checking");
  const [pg, setPg] = useState(false);
  const [pgErr, setPgErr] = useState(false);
  // The playground is agent-written, so it is framed by a signed link and in a sandbox (see apps/mesh-server/src/preview.ts),
  // never by a path this page could be tricked into sharing its credentials with.
  const [pgSrc, setPgSrc] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const fileReq = useRef(0);
  const searchReq = useRef(0);

  // A new goal id means the mission was reset (or a fresh goal opened): the old checkout is gone, so the remembered run goes
  // with it. Only a change counts: arriving on the page is not a reset, and that is exactly when a run is picked up again.
  const goalSeen = useRef(goalId);
  useEffect(() => {
    if (goalSeen.current && goalSeen.current !== goalId) {
      setRun(null);
      remember(projectId, null);
    }
    goalSeen.current = goalId;
  }, [goalId, projectId]);

  // The disk is read again whenever the goal changes or the person retries; the preview and the search belong to the old read.
  useEffect(() => {
    let dead = false;
    setFile(null);
    setFileDiff(null);
    setHits(null);
    setQ("");
    setDir("");
    setWsErr(null);
    client.api("GET", "/workspace/info").then(({ json, timeout }) => {
      if (dead) return;
      if (timeout || !json || json.error) {
        setWsErr(timeout ? "The request timed out. The server may be busy." : String(json?.error ?? "The mesh server did not answer."));
        return;
      }
      setInfo(json as WorkspaceInfo);
    }).catch((e: unknown) => { if (!dead) setWsErr(e instanceof Error ? e.message : String(e)); });
    client.api("GET", "/workspace/changes").then(({ json }) => {
      if (!dead && Array.isArray(json)) setChanges(json as Change[]);
    }).catch(() => { if (!dead) setChanges([]); });
    // What the scripts do is in the product's own package.json; reading it is how a button can say so without guessing.
    // The root listing says first whether there is one to read; a listing that does not come back falls through to reading the file.
    client.api("GET", "/workspace/tree?path=").then(async ({ json: root }) => {
      if (Array.isArray(root) && !hasManifest(root as TreeEntry[])) {
        if (!dead) setPkg({ state: "missing", scripts: null });
        return;
      }
      const { status, json } = await client.api("GET", "/workspace/file?path=package.json");
      if (dead) return;
      if (status === 404) setPkg({ state: "missing", scripts: null });
      else setPkg(typeof json?.content === "string" ? readPackage(json.content) : { state: "unknown", scripts: null });
    }).catch(() => { if (!dead) setPkg({ state: "unknown", scripts: null }); });
    return () => { dead = true; };
  }, [goalId, attempt, client, projectId]);

  useEffect(() => {
    let dead = false;
    setTreeErr(null);
    setTreeLimit(TREE_WINDOW);
    client.api("GET", `/workspace/tree?path=${encodeURIComponent(dir)}`).then(({ json, timeout }) => {
      if (dead) return;
      if (Array.isArray(json)) {
        setTree(json as TreeEntry[]);
        return;
      }
      setTree([]);
      setTreeErr(timeout ? "The request timed out." : String(json?.error ?? "This folder could not be listed."));
    }).catch((e: unknown) => {
      if (!dead) { setTree([]); setTreeErr(e instanceof Error ? e.message : String(e)); }
    });
    return () => { dead = true; };
  }, [dir, goalId, attempt, client]);

  // Whether the product ships a playground, asked of the checkout rather than found out by clicking: the server opens
  // apps/playground/index.html and nothing else. A build that has just passed may have written it, so it is asked again.
  useEffect(() => {
    let dead = false;
    client.api("GET", "/workspace/tree?path=apps%2Fplayground").then(({ json }) => {
      if (!dead) setPlayground(hasPlayground(Array.isArray(json) ? (json as TreeEntry[]) : null) ? "ready" : "missing");
    }).catch(() => { if (!dead) setPlayground("missing"); });
    return () => { dead = true; };
  }, [goalId, attempt, client, builtCheck]);

  // A run the person walked away from is still running on the host. Pick it up again, or find out it is gone.
  useEffect(() => {
    const mine = recall(projectId);
    if (!mine) return;
    let dead = false;
    client.api("GET", `/workspace/run/${encodeURIComponent(mine.id)}`).then(({ json }) => {
      if (dead) return;
      if (!json || json.error) {
        remember(projectId, null);
        return;
      }
      setRun({ ...mine, done: Boolean(json.done), exitCode: json.exitCode ?? null, log: String(json.log ?? "") });
    }).catch(() => undefined);
    return () => { dead = true; };
  }, [projectId, client]);

  const runId = run && !run.done && !run.lost ? run.id : null;
  useEffect(() => {
    if (!runId) return;
    let dead = false;
    const poll = async (): Promise<void> => {
      try {
        const { json } = await client.api("GET", `/workspace/run/${encodeURIComponent(runId)}`);
        if (dead) return;
        if (json?.error) {
          setRun((r) => (r && r.id === runId ? { ...r, lost: true } : r));
          remember(projectId, null);
          return;
        }
        if (json && json.id === runId) {
          const done = Boolean(json.done);
          setRun((r) => (r && r.id === runId ? { ...r, done, exitCode: json.exitCode ?? null, log: String(json.log ?? ""), endedAt: done ? r.endedAt ?? Date.now() : undefined } : r));
          if (done && json.exitCode === 0) setBuiltCheck((n) => n + 1);
        }
      } catch {
        /* the host may be restarting: keep what is on screen, and ask again on the next beat */
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), 1500);
    return () => { dead = true; clearInterval(iv); };
  }, [runId, client, projectId]);

  const openFile = async (p: string): Promise<void> => {
    const req = ++fileReq.current;
    const { json } = await client.api("GET", `/workspace/file?path=${encodeURIComponent(p)}`);
    if (req !== fileReq.current) return;
    if (!json || json.error) {
      toast("Could not open the file", String(json?.error ?? "The server did not answer."), "warn");
      return;
    }
    setFile({
      path: json.path,
      content: typeof json.content === "string" ? json.content : undefined,
      kind: (json.kind as FileKind) ?? "text",
      dataUrl: json.dataUrl,
      size: json.size,
    });
    // Below two columns the preview is under the list, out of sight: bring it to the person.
    if (!wide) requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: "start" }));
    // The uncommitted delta for this exact file, so a reviewer sees what changed without leaving for a terminal.
    setFileDiff(null);
    const { json: d } = await client.api("GET", `/workspace/diff?path=${encodeURIComponent(p)}`);
    if (req !== fileReq.current) return;
    if (d && !d.error && !d.identical) setFileDiff(d as DiffPayload);
  };

  const runSearch = async (term: string): Promise<void> => {
    const t = term.trim();
    if (t.length < 2) {
      setHits(null);
      return;
    }
    const req = ++searchReq.current;
    setSearching(true);
    const { json } = await client.api("GET", `/workspace/search?q=${encodeURIComponent(t)}`, undefined, { timeoutMs: 30000 });
    if (req !== searchReq.current) return;
    setSearching(false);
    setHits(json && Array.isArray(json.results) ? (json.results as SearchHit[]) : []);
  };

  // A run the person just started brings its output into view and takes focus: the button they pressed is disabled the moment
  // the run begins, which drops a keyboard user's place, and on a phone the output is below five stacked buttons.
  const justStarted = useRef(false);
  useEffect(() => {
    if (!run || !justStarted.current) return;
    justStarted.current = false;
    const panel = document.getElementById("run-out");
    panel?.focus({ preventScroll: true });
    panel?.scrollIntoView({ block: "nearest" });
  }, [run]);

  const start = async (s: ScriptInfo): Promise<void> => {
    const { status, json } = await client.api("POST", "/workspace/run", { script: s.name });
    if (json?.runId) {
      const next = { id: String(json.runId), script: s.name, command: s.command, startedAt: Date.now() };
      remember(projectId, next);
      justStarted.current = true;
      setRun({ ...next, done: false, exitCode: null, log: `$ ${s.command}\n` });
    } else if (status === 409) {
      toast("Another run is in progress", "The host runs one script at a time, and one is already going, started from another tab or window. Wait for it to finish.", "warn");
    } else {
      toast("The run did not start", String(json?.error ?? "The server did not answer."), "warn");
    }
  };

  const stop = async (): Promise<void> => {
    if (!run) return;
    setRun({ ...run, stopped: true });
    // The host's route is /workspace/run/kill/<id>. The console used to call /workspace/run/<id>/kill, which the host
    // answers 404, so Stop never stopped anything and said nothing about it.
    const { json } = await client.api("POST", `/workspace/run/kill/${encodeURIComponent(run.id)}`);
    if (!json?.ok) {
      setRun((r) => (r && r.id === run.id ? { ...r, stopped: false } : r));
      toast("Could not stop the run", String(json?.error ?? "The host did not answer."), "warn");
    }
  };

  const clearRun = (): void => {
    setRun(null);
    remember(projectId, null);
    // The Dismiss button is gone with the panel; the first script is where a person goes next.
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".run-btn:not(:disabled)")?.focus());
  };

  const openPg = (): void => {
    if (pg) {
      setPg(false);
      return;
    }
    setPgSrc(null);
    client.api("GET", "/playground/").then(async ({ status, timeout }) => {
      if (timeout || status >= 400) { setPgErr(true); setPg(true); return; }
      const minted = await client.api("POST", "/playground/session", {});
      const link = typeof minted.json?.path === "string" ? (minted.json.path as string) : null;
      if (minted.status >= 400 || !link) { setPgErr(true); setPg(true); return; }
      // The link is relative to the project, like every other path this view calls.
      setPgSrc(projectPath(projectId, link));
      setPgErr(false);
      setPg(true);
    }).catch(() => { setPgErr(true); setPg(true); });
  };

  const running = Boolean(run && !run.done && !run.lost);
  const scripts: ScriptInfo[] = useMemo(() => orderScripts(info?.scripts ?? []).map((n) => describeScript(n, pkg.scripts)), [info, pkg.scripts]);
  const crumb = dir ? dir.split("/") : [];
  const commits = parseCommits(info?.gitLog);
  const noRepo = info?.gitRepo === "false";
  const dirty = info?.gitClean === "false";
  const treeTone: PillTone = wsErr || noRepo ? "failed" : dirty ? "waiting" : "completed";
  const empty = noScriptsCopy(pkg.state);
  const listedChanges = showAllChanges ? changes : changes.slice(0, 40);
  const entries = tree ?? [];

  return (
    <>
      <PageHeader
        title="Product"
        status={info || wsErr ? <Pill tone={treeTone}>{wsErr ? "No workspace" : noRepo ? "No repository" : info?.gitBranch || "No branch"}</Pill> : null}
        lede="The code the team delivered. Read it, run its scripts, open it."
      />

      {wsErr ? (
        <ErrorState what="the workspace" detail={wsErr} onRetry={() => { setWsErr(null); setAttempt((n) => n + 1); }} />
      ) : (
        <div className="prod-stack">
          <section className="card prod-facts-card" aria-label="The checkout">
            {!info ? (
              <div className="prod-skel" role="status"><span className="sr-only">Reading the checkout</span><i /><i /></div>
            ) : (
              <>
                <dl className="prod-facts">
                  <div><dt>Branch</dt><dd>{noRepo ? "none" : info.gitBranch || "none"}</dd></div>
                  <div><dt>Head</dt><dd>{noRepo ? "none" : info.gitHead || "none"}</dd></div>
                  <div>
                    <dt>Tree</dt>
                    <dd className={dirty ? "warn" : ""}>
                      {noRepo ? "not a git repository" : dirty ? (changes.length ? `${changes.length} uncommitted ${changes.length === 1 ? "change" : "changes"}` : "uncommitted changes") : info.gitClean === "true" ? "clean" : "unknown"}
                    </dd>
                  </div>
                </dl>
                <div className="prod-where">
                  <span className="prod-where-l">Checkout</span>
                  <span className="pathline mono" title={info.path}><bdi>{info.path}</bdi></span>
                  <CopyButton text={info.path} label="Copy path" title="Copy the checkout's path on the host" />
                </div>
                {commits.length ? (
                  <details className="prod-commits">
                    <summary>Recent commits ({commits.length})</summary>
                    <ol>{commits.map((c, i) => <li key={i}>{c.hash ? <span className="mono">{c.hash}</span> : null}<span>{c.subject}</span></li>)}</ol>
                  </details>
                ) : null}
              </>
            )}
          </section>

          <section className="card prod-run" aria-labelledby="run-h">
            <div className="prod-h"><h3 id="run-h">Run a script</h3></div>
            {!info ? (
              <div className="prod-skel" role="status"><span className="sr-only">Reading the scripts</span><i /><i /></div>
            ) : scripts.length === 0 ? (
              <div className="prod-none"><b>{empty.title}</b><p>{empty.body}</p></div>
            ) : (
              <>
                <p className="prod-note">
                  Each button runs the product&apos;s own script of that name, in the checkout above, on the host. One script runs at a time.
                  Variables that start with <code>MESH_</code> and the model API keys are withheld from it.
                </p>
                <div className="run-grid">
                  {scripts.map((s) => (
                    <button
                      key={s.name}
                      type="button"
                      className="run-btn"
                      disabled={running}
                      title={`${s.command}${s.body ? `, which runs: ${s.body}` : ""}`}
                      onClick={() => void start(s)}
                    >
                      <span className="run-name"><Icon name="play" size={14} />{s.label}</span>
                      <span className="run-cmd mono">{s.command}</span>
                      {s.body ? <span className="run-body mono">{s.body}</span> : null}
                      {s.usuallyStays ? <span className="run-note">Usually keeps running. Stop it when you are done.</span> : null}
                    </button>
                  ))}
                </div>
                {running ? <p className="prod-note">A script is running, so the others wait. Stop it below to run something else.</p> : null}
              </>
            )}
          </section>

          {run ? <RunOutput run={run} onStop={() => void stop()} onClear={clearRun} /> : null}

          <section className="card prod-pg" aria-labelledby="pg-h">
            <div className="prod-h">
              <h3 id="pg-h">Playground</h3>
              <span className="grow" />
              {playground === "ready" ? <Button variant="small" onClick={openPg}>{pg ? "Close the playground" : "Open the playground"}</Button> : null}
            </div>
            <p className="prod-note">
              {playground === "ready"
                ? "The page this product built at apps/playground/index.html, shown in a sandbox: its scripts run, but they cannot reach this console or its API."
                : playground === "checking"
                  ? "Looking for the page this product builds."
                  : `A playground shows the page at apps/playground/index.html, in a sandbox. This checkout has none.${scripts.some((s) => s.name === "build") ? " If the product's build writes one, run build and the button appears here." : ""}`}
            </p>
            {pg ? (
              pgErr ? (
                <p className="prod-note">The playground could not be opened. The host did not serve apps/playground/index.html; run the product&apos;s build, then open it again.</p>
              ) : pgSrc ? (
                // `sandbox` without allow-same-origin gives the page an opaque origin: its scripts run,
                // but they cannot call this server's API with the operator's session or read what it answers.
                <iframe title="Playground" src={pgSrc} sandbox="allow-scripts allow-forms allow-popups allow-modals" className="playframe" onError={() => setPgErr(true)} />
              ) : (
                <p className="prod-note" role="status">Opening the playground…</p>
              )
            ) : null}
          </section>

          {changes.length ? (
            <section className="card" aria-labelledby="chg-h">
              <div className="prod-h"><h3 id="chg-h">Uncommitted changes in the checkout <span className="prod-count">{changes.length}</span></h3></div>
              <ul className="chg-list">
                {listedChanges.map((c) => {
                  const k = changeKind(c.status);
                  // Git lists an untracked folder as one entry ending in a slash: that opens the folder, not a file.
                  const folder = c.path.endsWith("/");
                  return (
                    <li key={c.path}>
                      <button
                        type="button"
                        className="chg-row"
                        title={`${c.path} is ${k.word}. ${folder ? "Open the folder." : "Open it to see the change."}`}
                        onClick={() => {
                          if (!folder) { void openFile(c.path); return; }
                          setHits(null);
                          setDir(c.path.replace(/\/+$/, ""));
                        }}
                      >
                        <span className={`chg-mark ${k.tone}`} aria-hidden="true">{k.mark}</span>
                        <span className="sr-only">{k.word}: </span>
                        <span className="chg-path mono"><bdi>{c.path}</bdi></span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              {changes.length > listedChanges.length ? (
                <div className="prod-more"><Button variant="small" onClick={() => setShowAllChanges(true)}>Show all {changes.length}</Button></div>
              ) : null}
            </section>
          ) : null}

          <div className="prod-split">
            <section className="card" aria-labelledby="tree-h">
              <div className="prod-h"><h3 id="tree-h">Files</h3></div>
              <form className="fv-search" role="search" onSubmit={(e: FormEvent) => { e.preventDefault(); void runSearch(q); }}>
                <Input
                  search
                  mono
                  aria-label="Search the whole workspace"
                  placeholder="Search names and contents"
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    if (!e.target.value.trim()) setHits(null);
                  }}
                />
                <Button variant="small" type="submit" icon="search">{searching ? "Searching…" : "Search"}</Button>
                {hits ? <Button variant="small" onClick={() => { setHits(null); setQ(""); }}>Clear</Button> : null}
              </form>
              {q.trim().length === 1 ? <p className="prod-note" role="status">Type at least two characters to search.</p> : null}
              {hits ? (
                <div className="ptree">
                  <div className="prod-note ptree-count" role="status">{hits.length} {hits.length === 1 ? "match" : "matches"}{hits.length >= 200 ? ", the most the server returns" : ""}</div>
                  {hits.map((h, i) => (
                    <button key={`${h.path}:${h.line}:${i}`} type="button" className="ptree-row hit" onClick={() => void openFile(h.path)} title={h.path}>
                      <Icon name="files" size={14} />
                      <span className="ptree-name"><bdi>{h.path}</bdi></span>
                      {h.line ? <span className="muted mono">:{h.line}</span> : <span className="muted">name</span>}
                      {h.kind === "content" ? <span className="hit-text" title={h.text.trim()}>{h.text.trim().slice(0, 80)}</span> : null}
                    </button>
                  ))}
                  {hits.length === 0 ? <p className="prod-note">Nothing in the workspace matched &ldquo;{q.trim()}&rdquo;.</p> : null}
                </div>
              ) : (
                <>
                  <nav className="crumb" aria-label="Folder">
                    <ol>
                      <li>{crumb.length ? <button type="button" className="crumb-btn" onClick={() => setDir("")}>root</button> : <span aria-current="page">root</span>}</li>
                      {crumb.map((c, i) => (
                        <li key={i}>
                          <Icon name="chevron-right" size={12} />
                          {i < crumb.length - 1 ? <button type="button" className="crumb-btn" onClick={() => setDir(crumb.slice(0, i + 1).join("/"))}>{c}</button> : <span aria-current="page">{c}</span>}
                        </li>
                      ))}
                    </ol>
                  </nav>
                  <div className="ptree">
                    {tree === null ? (
                      <div className="prod-skel" role="status"><span className="sr-only">Reading the folder</span><i /><i /><i /></div>
                    ) : treeErr ? (
                      <ErrorState what={dir ? `the folder ${dir}` : "the workspace files"} detail={treeErr} onRetry={() => setAttempt((n) => n + 1)} />
                    ) : entries.length ? (
                      <>
                        {entries.slice(0, treeLimit).map((e) => (
                          <button key={e.path} type="button" className="ptree-row" title={e.path} onClick={() => (e.type === "dir" ? setDir(e.path) : void openFile(e.path))}>
                            <Icon name={e.type === "dir" ? "folder" : "files"} size={14} />
                            <span className="ptree-name">{e.name}{e.type === "dir" ? "/" : ""}</span>
                            {e.type === "file" ? <span className="muted mono">{fmtSize(e.size)}</span> : null}
                          </button>
                        ))}
                        {entries.length > treeLimit ? (
                          <div className="prod-more">
                            <span className="muted">{(entries.length - treeLimit).toLocaleString("en-GB")} more in this folder.</span>
                            <Button variant="small" onClick={() => setTreeLimit(treeLimit + TREE_WINDOW)}>Show {Math.min(TREE_WINDOW, entries.length - treeLimit).toLocaleString("en-GB")} more</Button>
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <p className="prod-note">{dir ? "This folder is empty." : "The checkout has no files yet."}</p>
                    )}
                  </div>
                </>
              )}
            </section>
            <section className="card" aria-labelledby="preview-h" ref={previewRef}>
              <div className="prod-h"><h3 id="preview-h">File preview</h3></div>
              {file ? (
                <FileView
                  path={file.path}
                  content={file.content}
                  kind={file.kind}
                  dataUrl={file.dataUrl}
                  size={file.size}
                  changes={fileDiff ? { available: true, diff: fileDiff, label: "the last commit to the working tree" } : undefined}
                  toolbar={<CopyButton text={file.path} label="Copy path" title="Copy this file's path in the checkout" />}
                  maxHeight={wide ? 520 : 420}
                />
              ) : (
                <p className="prod-note">Choose a file to read it here: code, documents and images are shown as they are.</p>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
