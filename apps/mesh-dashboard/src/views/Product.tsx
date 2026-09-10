import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMesh } from "../store";
import { Button, Card, Chip, Input, Pill } from "../components";
import { FileView, type DiffPayload, type FileKind } from "../fileview";

interface TreeEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

interface OpenFile {
  path: string;
  content?: string;
  kind: FileKind;
  dataUrl?: string;
  size?: number;
}

interface SearchHit {
  path: string;
  line: number;
  text: string;
  kind: "name" | "content";
}

const RUN_LABELS: Record<string, string> = {
  test: "test — run the full test suite (vitest)",
  typecheck: "typecheck — TypeScript typecheck",
  build: "build — packages + playground (tsc -b)",
  "headless-hairpin": "headless — run the hairpin demo scenario (6600 ticks)",
};

const fmtSize = (n: number): string =>
  n >= 1024 ? `${(n / 1024).toFixed(n >= 102400 ? 0 : 1)}kB` : `${n}B`;

export default function Product(): React.JSX.Element {
  const { toast } = useMesh();
  const [info, setInfo] = useState<any>(null);
  const [dir, setDir] = useState("");
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<OpenFile | null>(null);
  const [fileDiff, setFileDiff] = useState<DiffPayload | null>(null);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [changes, setChanges] = useState<Array<{ path: string; status: string }>>([]);
  const [run, setRun] = useState<any>(null);
  const [runTicker, setRunTicker] = useState(0);
  const [pg, setPg] = useState(false);
  const [pgErr, setPgErr] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    api("GET", "/workspace/info").then(({ json }) => setInfo(json)).catch(() => undefined);
    api("GET", "/workspace/changes").then(({ json }) => {
      if (Array.isArray(json)) setChanges(json);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    let dead = false;
    api("GET", `/workspace/tree?path=${encodeURIComponent(dir)}`).then(({ json }) => {
      if (!dead && Array.isArray(json)) setTree(json as TreeEntry[]);
    }).catch(() => undefined);
    return () => {
      dead = true;
    };
  }, [dir]);

  useEffect(() => {
    if (!run || run.done) return;
    const t = setTimeout(() => setRunTicker((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [run, runTicker]);

  useEffect(() => {
    if (!run || run.done || !run.id) return;
    api("GET", `/workspace/run/${encodeURIComponent(run.id)}`).then(({ json }) => {
      if (json && json.id) {
        setRun(json);
        if (json.done && json.exitCode !== 0) toast("run finished", `exit code ${json.exitCode}`, "warn");
      }
    }).catch(() => undefined);
  }, [runTicker]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [run?.log?.length]);

  const openFile = async (p: string): Promise<void> => {
    const { json } = await api("GET", `/workspace/file?path=${encodeURIComponent(p)}`);
    if (!json || json.error) {
      if (json?.error) toast("cannot open", String(json.error), "warn");
      return;
    }
    setFile({
      path: json.path,
      content: typeof json.content === "string" ? json.content : undefined,
      kind: (json.kind as FileKind) ?? "text",
      dataUrl: json.dataUrl,
      size: json.size,
    });
    setPgErr(false);
    // Uncommitted delta for this exact file, so a reviewer can see what an
    // agent changed without leaving the console for a terminal.
    setFileDiff(null);
    const { json: d } = await api("GET", `/workspace/diff?path=${encodeURIComponent(p)}`);
    if (d && !d.error && !d.identical) setFileDiff(d as DiffPayload);
  };

  const runSearch = async (term: string): Promise<void> => {
    const t = term.trim();
    if (t.length < 2) {
      setHits(null);
      return;
    }
    setSearching(true);
    const { json } = await api("GET", `/workspace/search?q=${encodeURIComponent(t)}`, undefined, { timeoutMs: 30000 });
    setSearching(false);
    setHits(json && Array.isArray(json.results) ? (json.results as SearchHit[]) : []);
  };

  const start = async (script: string): Promise<void> => {
    const { json } = await api("POST", "/workspace/run", { script });
    if (json?.runId) {
      setRun({ id: json.runId, done: false, log: `$ ${script}\n`, exitCode: null, startedAt: Date.now() });
      setRunTicker(1);
    } else if (json?.error) {
      toast("run not started", String(json.error), "warn");
    }
  };

  const kill = async (): Promise<void> => {
    if (!run) return;
    const { json } = await api("POST", `/workspace/run/${encodeURIComponent(run.id)}/kill`);
    if (json?.ok) toast("run killed", "stopped the script", "warn");
  };

  const openPg = (): void => {
    if (!pg) {
      api("GET", "/playground/").then(({ json }) => {
        void json;
        setPgErr(false);
      }).catch(() => undefined);
    }
    setPg(!pg);
  };

  const running = Boolean(run && !run.done);
  const scripts = (info?.scripts || []) as string[];
  const crumb = dir ? dir.split("/") : [];
  const up = (): void => setDir(crumb.slice(0, -1).join("/"));

  return (
    <div>
      <div className="view-title"><h2>Product</h2><span className={`pill ${info?.gitClean === "true" ? "completed" : "waiting"}`}>{info?.gitBranch || "…"}</span><span className="page-actions"><Button variant="small" onClick={openPg}>{pg ? "close playground" : "open playground"}</Button></span></div>
      <div className="view-sub">The codebase agents delivered — browse the files, build, test, run scenarios.</div>
      <Card style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
          <div className="kpi"><small>branch</small><b style={{ fontSize: 15 }}>{info?.gitBranch || "…"}</b></div>
          <div className="kpi"><small>head</small><b style={{ fontSize: 15 }}>{info?.gitHead || "…"}</b></div>
          <div className="kpi"><small>tree</small><b style={{ fontSize: 15 }}>{info?.gitClean === "false" ? "dirty" : info?.gitClean === "true" ? "clean" : "…"}</b></div>
          <div className="kpi" style={{ minWidth: 160 }}><small>workspace</small><b style={{ fontSize: 12 }} className="mono">{String(info?.path || "").split("/").slice(-3).join("/")}</b></div>
          <div style={{ flex: 1 }} />
          <div className="chips">
            {scripts.map((s) => <button key={s} className={`chip-toggle${!running ? " on" : ""}`} disabled={running} onClick={() => start(s)} title={RUN_LABELS[s]}>{RUN_LABELS[s].split(" — ")[0]}</button>)}
            {running ? <button className="chip-toggle bad" onClick={kill}>kill</button> : null}
          </div>
        </div>
      </Card>
      {run ? (
        <Card
          style={{ marginBottom: 12 }}
          title={<>Run output {running ? <Pill tone="awakened" pulse>running</Pill> : <Pill tone={run.exitCode === 0 ? "completed" : "failed"}>exit {run.exitCode ?? "?"}</Pill>}</>}
        >
          <pre className="run-log" ref={logRef}>{(run.log || "") || "no output yet…"}</pre>
        </Card>
      ) : null}
      {changes.length ? (
        <Card style={{ marginBottom: 12 }} title={`Uncommitted changes (${changes.length})`}>
          <div className="chips">
            {changes.slice(0, 40).map((c) => (
              <Chip key={c.path} mono title={`${c.status} — click to see the diff`} onClick={() => openFile(c.path)}>
                <span className={`ch-${c.status.toLowerCase()}`}>{c.status}</span> {c.path.split("/").slice(-2).join("/")}
              </Chip>
            ))}
            {changes.length > 40 ? <span className="muted">+{changes.length - 40} more</span> : null}
          </div>
        </Card>
      ) : null}
      <div className="grid two" style={{ marginBottom: 12 }}>
        <Card style={{ minHeight: 320 }} title="Files" actions={dir ? <Button variant="small" onClick={up}>up</Button> : null}>
          <form
            className="fv-search"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch(q);
            }}
          >
            <Input
              search
              mono
              placeholder="search the whole workspace…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                if (!e.target.value.trim()) setHits(null);
              }}
            />
            <Button variant="small" type="submit">{searching ? "…" : "find"}</Button>
            {hits ? <Button variant="small" onClick={() => { setHits(null); setQ(""); }}>clear</Button> : null}
          </form>
          {hits ? (
            <div className="ptree">
              <div className="muted" style={{ padding: "6px 4px", fontSize: 11 }}>{hits.length} match{hits.length === 1 ? "" : "es"}{hits.length >= 200 ? " (capped)" : ""}</div>
              {hits.map((h, i) => (
                <button key={`${h.path}:${h.line}:${i}`} className="ptree-row" onClick={() => openFile(h.path)}>
                  <span className="icon">{h.kind === "name" ? "≡" : "·"}</span>
                  <b>{h.path}</b>
                  {h.line ? <span className="muted mono">:{h.line}</span> : null}
                  {h.kind === "content" ? <span className="muted hit-text">{h.text.trim().slice(0, 60)}</span> : null}
                </button>
              ))}
              {hits.length === 0 ? <div className="muted" style={{ padding: 12 }}>Nothing matched.</div> : null}
            </div>
          ) : (
            <>
              <div className="crumb">{crumb.length ? <Chip mono onClick={() => setDir("")}>root</Chip> : <Chip mono>root</Chip>}{crumb.map((c, i) => <Chip key={i} mono onClick={() => setDir(crumb.slice(0, i + 1).join("/"))}>{c}</Chip>)}</div>
              <div className="ptree">{tree.length ? tree.map((e) => (
                <button key={e.path} className="ptree-row" onClick={() => (e.type === "dir" ? setDir(e.path) : openFile(e.path))}>
                  <span className="icon">{e.type === "dir" ? "▸" : "·"}</span><b>{e.name}</b>{e.type === "file" ? <span className="muted mono">{fmtSize(e.size)}</span> : null}
                </button>
              )) : <div className="muted" style={{ padding: 12 }}>empty directory</div>}</div>
            </>
          )}
        </Card>
        <Card style={{ minHeight: 320 }} title="File preview">
          {file ? (
            <FileView
              path={file.path}
              content={file.content}
              kind={file.kind}
              dataUrl={file.dataUrl}
              size={file.size}
              diff={fileDiff}
              maxHeight={420}
            />
          ) : (
            <div className="muted" style={{ padding: 12 }}>Click a file on the left to read it — code, docs and images all render here.</div>
          )}
        </Card>
      </div>
      {pg ? (
        <Card title={<>Playground {pgErr ? <Pill tone="waiting">not built</Pill> : null}</>}>
          {pgErr ? (
            <div className="muted">Run <b>build</b> above to compile the playground, then reopen it.</div>
          ) : (
            <iframe title="playground" src="/playground/" className="playframe" onError={() => setPgErr(true)} />
          )}
        </Card>
      ) : null}
    </div>
  );
}