/**
 * The Files reader: one file, the versions it has had, what changed between any two of them, and where it lives.
 *
 * It sits beside the list on a wide screen and in the details panel on a narrow one; the content is the same either way, so
 * it is one component with a heading that is an h3 in the page and the dialog's title in the panel.
 *
 * What it does that the panel it replaces did not: it draws each *version* once (the history is one record per status
 * change, so a merged patch used to show as "v2 v2 v2 v2 v2 v2 v2"), says where a version stands and how it got there,
 * compares any version with any earlier one, renders documents as documents, and offers the path to copy.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import "./views/files.css";
import { ago, artifactCls, localDateTime, plainArtifact } from "./format";
import { CopyButton, ErrorState, IconButton, Pill, Select, type PillTone } from "./components";
import { Icon } from "./icons";
import { FileView, type DiffPayload, type FileViewMode } from "./fileview";
import { distinctVersions, downloadName, pathFromRef, previousVersion, readAs, repoPathOf, trailWords, type Art, type ArtRecord, type ArtVersion } from "./files";
import { useMesh } from "./store";

type Meta =
  | { kind: "loading" }
  | { kind: "ready"; art: Art; history: ArtRecord[] }
  /** The server answered 404: the file is not in the manifest. */
  | { kind: "missing" }
  /** The server did not answer, or answered something unreadable. Worth retrying. */
  | { kind: "error"; message: string };

type Body = { version: number; text: string } | { version: number; error: string };
type Compared = { key: string; diff: DiffPayload } | { key: string; error: string };

const enc = encodeURIComponent;

export function ArtifactReader({ id, as, stamp }: {
  id: string;
  as: "pane" | "drawer";
  /** Changes when the list sees this file change (a new version, a new status), so the reader reads it again. */
  stamp?: string;
}): React.JSX.Element {
  const { client, closeDrawer } = useMesh();
  const [meta, setMeta] = useState<Meta>({ kind: "loading" });
  const [metaTry, setMetaTry] = useState(0);
  const [pick, setPick] = useState<number | null>(null);
  const [mode, setMode] = useState<FileViewMode>("rendered");
  const [compareFrom, setCompareFrom] = useState<number | null>(null);
  const [body, setBody] = useState<Body | null>(null);
  const [bodyTry, setBodyTry] = useState(0);
  const [compared, setCompared] = useState<Compared | null>(null);
  const [compareTry, setCompareTry] = useState(0);
  // Versions are immutable, so what was read once need not be asked for again: stepping between v1 and v2 is instant.
  const texts = useRef(new Map<number, string>());
  const diffs = useRef(new Map<string, DiffPayload>());

  useEffect(() => {
    let dead = false;
    void (async () => {
      const [a, v] = await Promise.all([client.api("GET", `/artifacts/${enc(id)}`), client.api("GET", `/artifacts/${enc(id)}/versions`)]);
      if (dead) return;
      if (a.status === 404) {
        setMeta({ kind: "missing" });
        return;
      }
      if (a.timeout || a.status !== 200 || !a.json || a.json.error) {
        setMeta({ kind: "error", message: a.timeout ? "The request timed out. The server may be busy." : String(a.json?.error ?? "The server did not answer.") });
        return;
      }
      setMeta({ kind: "ready", art: a.json as Art, history: Array.isArray(v.json) && v.json.length ? (v.json as ArtRecord[]) : [a.json as ArtRecord] });
    })().catch((e: unknown) => {
      if (!dead) setMeta({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      dead = true;
    };
  }, [id, client, metaTry, stamp]);

  const art = meta.kind === "ready" ? meta.art : null;
  const versions: ArtVersion[] = useMemo(() => (meta.kind === "ready" ? distinctVersions(meta.history) : []), [meta]);
  const latest = versions.length ? versions[versions.length - 1]!.version : art?.version ?? null;
  const shown = pick !== null && versions.some((v) => v.version === pick) ? pick : latest;
  const viewed = versions.find((v) => v.version === shown) ?? null;
  const before = shown === null ? null : previousVersion(versions, shown);
  // A comparison base the person chose holds only while it is still an earlier version than the one on screen.
  const base = compareFrom !== null && shown !== null && compareFrom < shown && versions.some((v) => v.version === compareFrom) ? compareFrom : before;
  const canCompare = base !== null && shown !== null;

  useEffect(() => {
    if (shown === null) return;
    const hit = texts.current.get(shown);
    if (hit !== undefined) {
      setBody({ version: shown, text: hit });
      return;
    }
    let dead = false;
    void (async () => {
      const text = await client.getText(`/artifacts/${enc(id)}/content?version=${shown}`);
      if (dead) return;
      if (text === null) {
        // getText collapses every failure to null, so ask again for the reason: a 503 says the stored bytes are unreadable,
        // which is a storage fault and not an empty file.
        const { json } = await client.api("GET", `/artifacts/${enc(id)}/content?version=${shown}`);
        if (dead) return;
        setBody({ version: shown, error: typeof json?.error === "string" ? json.error : "The file's contents could not be fetched." });
        return;
      }
      texts.current.set(shown, text);
      setBody({ version: shown, text });
    })().catch((e: unknown) => {
      if (!dead) setBody({ version: shown, error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      dead = true;
    };
  }, [id, shown, client, bodyTry]);

  const wantsChanges = mode === "changes" && canCompare;
  useEffect(() => {
    if (!wantsChanges || base === null || shown === null) return;
    const key = `${base}>${shown}`;
    const hit = diffs.current.get(key);
    if (hit) {
      setCompared({ key, diff: hit });
      return;
    }
    let dead = false;
    void (async () => {
      const { status, json } = await client.api("GET", `/artifacts/${enc(id)}/diff?from=${base}&to=${shown}`);
      if (dead) return;
      if (status !== 200 || !json || json.error) {
        setCompared({ key, error: typeof json?.error === "string" ? json.error : "The comparison could not be fetched." });
        return;
      }
      diffs.current.set(key, json as DiffPayload);
      setCompared({ key, diff: json as DiffPayload });
    })().catch((e: unknown) => {
      if (!dead) setCompared({ key, error: e instanceof Error ? e.message : String(e) });
    });
    return () => {
      dead = true;
    };
  }, [wantsChanges, base, shown, id, client, compareTry]);

  const retryMeta = (): void => {
    setMeta({ kind: "loading" });
    setMetaTry((n) => n + 1);
  };

  const heading = (name: string, tone?: PillTone, label?: string): React.JSX.Element => {
    const H = as === "drawer" ? "h2" : "h3";
    return (
      <div className="reader-title">
        <H id={as === "drawer" ? "drawer-title" : undefined} className="reader-name" title={name}>{name}</H>
        {tone && label ? <Pill tone={tone}>{label}</Pill> : null}
        {as === "drawer" ? <span className="reader-close"><IconButton icon="x" label="Close panel" title="Close (Esc)" onClick={closeDrawer} /></span> : null}
      </div>
    );
  };

  if (meta.kind === "loading") {
    return (
      <div className={`reader ${as}`} aria-busy="true">
        {heading("Loading the file…")}
        <div className="reader-skel" role="status"><span className="sr-only">Loading the file</span><i /><i /><i /></div>
      </div>
    );
  }
  if (meta.kind === "missing") {
    return (
      <div className={`reader ${as}`}>
        {heading("File not found")}
        <ErrorState what="this file" detail="It is not in the manifest. It may have been removed, or the list is out of date." onRetry={retryMeta} />
      </div>
    );
  }
  if (meta.kind === "error" || !art) {
    return (
      <div className={`reader ${as}`}>
        {heading("File")}
        <ErrorState what="this file" detail={meta.kind === "error" ? meta.message : undefined} onRetry={retryMeta} />
      </div>
    );
  }

  const status = viewed?.status ?? art.status;
  const repoPath = repoPathOf(art);
  const storedAt = pathFromRef(viewed?.contentRef ?? art.contentRef);
  const shownPath = repoPath || storedAt;
  const readable = body && body.version === shown ? body : null;
  const kind = readAs(art);
  const older = shown !== null && latest !== null && shown !== latest;
  const diffFor = wantsChanges && compared && compared.key === `${base}>${shown}` ? compared : null;

  const compareControls = canCompare ? (
    <label className="reader-field">
      <span>Compare with</span>
      <Select value={String(base)} aria-label="Version to compare with" onChange={(e) => setCompareFrom(Number(e.target.value))}>
        {versions.filter((v) => shown !== null && v.version < shown).reverse().map((v) => (
          <option key={v.version} value={v.version}>v{v.version} · {plainArtifact(v.status)}</option>
        ))}
      </Select>
      <span className="muted">to v{shown}</span>
    </label>
  ) : null;

  return (
    <div className={`reader ${as}`}>
      {/* A div, not a header: inside the details panel a header would be a second banner landmark. */}
      <div className="reader-head">
        {heading(art.name, artifactCls(status) as PillTone, plainArtifact(status))}
        <p className="reader-facts">
          <span>{art.type}</span>
          <span>by {art.owner}</span>
          <span title={viewed ? localDateTime(viewed.createdAt) : undefined}>{ago(viewed?.createdAt ?? art.createdAt)}</span>
        </p>
        {shownPath ? (
          <div className="reader-path">
            <span className="reader-path-l">{repoPath ? "Repo path" : "Stored at"}</span>
            <span className="pathline mono" title={shownPath}><bdi>{shownPath}</bdi></span>
            <CopyButton text={shownPath} label="Copy path" title={repoPath ? "Copy the path of this file in the product" : "Copy where this version is stored on the host"} />
          </div>
        ) : null}
        <div className="reader-versions">
          {versions.length > 1 ? (
            <label className="reader-field">
              <span>Version</span>
              <Select value={String(shown)} aria-label="Version to read" onChange={(e) => setPick(Number(e.target.value))}>
                {[...versions].reverse().map((v) => (
                  <option key={v.version} value={v.version}>v{v.version} · {plainArtifact(v.status)}{v.version === latest ? " (latest)" : ""}</option>
                ))}
              </Select>
              <span className="muted">of {versions.length}</span>
            </label>
          ) : (
            <span className="muted">Version {shown}, the only one.</span>
          )}
          {older ? <button type="button" className="reader-link" onClick={() => setPick(null)}>Show the latest (v{latest})</button> : null}
        </div>
        {viewed && viewed.trail.length > 1 ? (
          <ol className="trail" aria-label={`How version ${viewed.version} got to ${plainArtifact(viewed.status)}`}>
            {trailWords(viewed.trail).map((w, i, all) => (
              <li key={`${w}-${i}`} aria-current={i === all.length - 1 ? "step" : undefined}>
                {w}
                {i < all.length - 1 ? <Icon name="chevron-right" size={12} /> : null}
              </li>
            ))}
          </ol>
        ) : null}
      </div>

      {readable && "error" in readable ? (
        <ErrorState what={`v${shown} of this file`} detail={readable.error} onRetry={() => { setBody(null); setBodyTry((n) => n + 1); }} />
      ) : readable ? (
        <FileView
          path={downloadName(art)}
          showPath={false}
          content={readable.text}
          kind={kind}
          size={readable.text.length}
          mode={mode}
          onModeChange={setMode}
          maxHeight={undefined}
          changes={{
            available: canCompare,
            diff: diffFor && "diff" in diffFor ? diffFor.diff : null,
            loading: wantsChanges && !diffFor,
            error: diffFor && "error" in diffFor ? diffFor.error : null,
            label: base !== null ? `v${base} to v${shown}` : undefined,
            onRetry: () => { setCompared(null); setCompareTry((n) => n + 1); },
            controls: compareControls,
          }}
        />
      ) : (
        <div className="reader-skel" role="status"><span className="sr-only">Loading version {shown}</span><i /><i /><i /></div>
      )}

      <details className="reader-details">
        <summary>Details</summary>
        <dl>
          <dt>Artifact id</dt>
          <dd><span className="mono">{art.id}</span> <CopyButton text={art.id} label="Copy id" /></dd>
          {viewed?.digest ? (<><dt>Digest</dt><dd className="mono">{viewed.digest}</dd></>) : null}
          {typeof art.metadata?.commit === "string" ? (<><dt>Commit</dt><dd className="mono">{art.metadata.commit}</dd></>) : null}
          {repoPath && storedAt ? (<><dt>Stored at</dt><dd><span className="pathline mono" title={storedAt}><bdi>{storedAt}</bdi></span> <CopyButton text={storedAt} label="Copy stored path" /></dd></>) : null}
          {art.goalId ? (<><dt>Goal</dt><dd className="mono">{art.goalId}</dd></>) : null}
        </dl>
      </details>
    </div>
  );
}
