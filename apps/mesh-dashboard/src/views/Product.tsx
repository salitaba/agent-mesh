import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMesh } from "../store";
import { Button, Card, Chip, Pill } from "../components";

interface TreeEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
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
  const [file, setFile] = useState<{ path: string; content: string } | null>(null);
  const [run, setRun] = useState<any>(null);
  const [runTicker, setRunTicker] = useState(0);
  const [pg, setPg] = useState(false);
  const [pgErr, setPgErr] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    api("GET", "/workspace/info").then(({ json }) => setInfo(json)).catch(() => undefined);
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
    if (json && typeof json.content === "string") {
      setFile({ path: json.path, content: json.content });
      setPgErr(false);
    } else if (json?.error) {
      toast("cannot open", String(json.error), "warn");
    }
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
      <div className="grid two" style={{ marginBottom: 12 }}>
        <Card style={{ minHeight: 320 }} title="Files" actions={dir ? <Button variant="small" onClick={up}>up</Button> : null}>
          <div className="crumb">{crumb.length ? <Chip mono onClick={() => setDir("")}>root</Chip> : <Chip mono>root</Chip>}{crumb.map((c, i) => <Chip key={i} mono onClick={() => setDir(crumb.slice(0, i + 1).join("/"))}>{c}</Chip>)}</div>
          <div className="ptree">{tree.map((e) => (
            <button key={e.path} className="ptree-row" onClick={() => (e.type === "dir" ? setDir(e.path) : openFile(e.path))}>
              <span className="icon">{e.type === "dir" ? "▸" : "·"}</span><b>{e.name}</b>{e.type === "file" ? <span className="muted mono">{fmtSize(e.size)}</span> : null}
            </button>
          )) || <div className="muted" style={{ padding: 12 }}>empty directory</div>}</div>
        </Card>
        <Card style={{ minHeight: 320 }} title={file ? <span className="mono" style={{ fontSize: 11, textTransform: "none", letterSpacing: 0, color: "var(--text)" }}>{file.path}</span> : "File preview"}>
          {file ? <pre className="run-log" style={{ maxHeight: 420 }}>{file.content}</pre> : <div className="muted" style={{ padding: 12 }}>Click a file on the left to read it.</div>}
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