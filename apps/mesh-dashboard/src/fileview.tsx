/* One renderer for every file the console shows.
 *
 * Artifacts and workspace files used to render as two different raw <pre>
 * blocks, one of them silently truncated at 8k. This module is the single
 * surface: line numbers, markdown, images, diffs, copy and download. The
 * Files reader, the artifact drawer and the Product page all mount it, so a
 * fix here fixes all three.
 *
 * Its props are additive: `diff`, `maxHeight` and `toolbar` still work as the
 * drawer calls them. The Files reader uses `changes` (a comparison it fetches
 * on demand) and `mode` (so it knows when the person asks for one). */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import "./views/files.css";
import { Button, CopyButton } from "./components";
import { Icon, type IconName } from "./icons";
import { LINE_WINDOW, fileKind, fileModes, fmtSize, lineWindow, looksLikePatch, modeLabel, patchKinds, type FileKind, type FileKindId, type FileViewMode } from "./files";
import { renderMarkdown } from "./markdown";
import { plural } from "./format";

export type { FileKind, FileViewMode } from "./files";

export interface DiffLine {
  op: "eq" | "add" | "del";
  a: number | null;
  b: number | null;
  text: string;
}

export interface DiffHunk {
  aStart: number;
  bStart: number;
  lines: DiffLine[];
}

export interface DiffPayload {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  truncated: boolean;
  identical: boolean;
  from?: number | string | null;
  to?: number | string | null;
}

const KIND_ICON: Record<FileKindId, IconName> = { patch: "code", release: "product", report: "report", document: "files" };

/**
 * What a file is, as a glyph in a tile: a patch, a release plan, a report or a document (files.ts `fileKind`). The list can be run
 * down by shape before it is read; the type is written beside it, so the tile is decoration and says nothing to a screen reader.
 */
export function FileTile({ type, size }: { type: string; size?: "lg" }): React.JSX.Element {
  const kind = fileKind(type);
  return <span className={`file-tile${size ? ` ${size}` : ""}`} data-kind={kind} aria-hidden="true"><Icon name={KIND_ICON[kind]} size={size === "lg" ? 20 : 18} /></span>;
}

function download(name: string, content: string, mime = "text/plain"): void {
  const url = content.startsWith("data:") ? content : URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.replace(/\s*\(v\d+\)$/, "").split("/").pop() || "file.txt";
  a.click();
  if (!content.startsWith("data:")) URL.revokeObjectURL(url);
}

/** A button that reveals the next window of a long file or diff, and says how much is left. */
function MoreLines({ remaining, step, onMore, onAll, what }: { remaining: number; step: number; onMore: () => void; onAll: () => void; what: string }): React.JSX.Element {
  const n = Math.min(step, remaining);
  return (
    <div className="fv-more">
      <span className="muted">{remaining.toLocaleString("en-GB")} more {what} not drawn yet.</span>
      <Button variant="small" onClick={onMore}>Show {n.toLocaleString("en-GB")} more</Button>
      {remaining > step ? <Button variant="small" onClick={onAll}>Show all</Button> : null}
    </div>
  );
}

export function DiffView({ diff, label }: { diff: DiffPayload; label?: string }): React.JSX.Element {
  const [limit, setLimit] = useState(LINE_WINDOW);
  if (diff.identical) return <p className="fv-empty">No changes between these versions.</p>;
  if (!diff.hunks.length) return <p className="fv-empty">Nothing to compare.</p>;
  // Hunks are drawn until the window is spent, so a rewrite of 40,000 lines is a screen, not a frozen tab.
  let spent = 0;
  const drawn: DiffHunk[] = [];
  for (const h of diff.hunks) {
    if (spent >= limit) break;
    const room = limit - spent;
    drawn.push(h.lines.length > room ? { ...h, lines: h.lines.slice(0, room) } : h);
    spent += Math.min(h.lines.length, room);
  }
  const total = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
  return (
    <div className="fv-diff" role="group" aria-label={`${label ?? "Changes"}: ${plural(diff.added, "line")} added, ${diff.removed} removed`}>
      {drawn.map((h, hi) => (
        <div className="fv-hunk" key={hi}>
          <div className="fv-hunk-head">Line {h.aStart || h.bStart}</div>
          {h.lines.map((l, li) => (
            <div className={`fv-line ${l.op}`} key={li}>
              <span className="fv-num">{l.a ?? ""}</span>
              <span className="fv-num">{l.b ?? ""}</span>
              <span className="fv-sign">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
              <span className="fv-text">{l.text || " "}</span>
            </div>
          ))}
        </div>
      ))}
      {total > spent ? <MoreLines remaining={total - spent} step={LINE_WINDOW} what="changed lines" onMore={() => setLimit(limit + LINE_WINDOW)} onAll={() => setLimit(total)} /> : null}
      {diff.truncated ? <div className="muted fv-note">The server compared only the first 6,000 lines of this file.</div> : null}
    </div>
  );
}

/** A comparison the Files reader fetches on demand, so a file's own view and its diff are one control. */
export interface FileChanges {
  available: boolean;
  diff: DiffPayload | null;
  loading?: boolean;
  error?: string | null;
  /** "v1 to v2": what the comparison is between, for the label and the screen reader. */
  label?: string;
  onRetry?: () => void;
  /** Controls that belong with the comparison (the version to compare against). */
  controls?: ReactNode;
}

export interface FileViewProps {
  path: string;
  /** Text content. Omitted for images and binaries. */
  content?: string;
  kind?: FileKind;
  /** data: URL for images. */
  dataUrl?: string;
  size?: number;
  /** When present, a "Changes" view appears alongside the content. */
  diff?: DiffPayload | null;
  /** The same, for a comparison fetched on demand. Wins over `diff`. */
  changes?: FileChanges;
  /** Extra controls rendered in the toolbar. */
  toolbar?: ReactNode;
  /** A fixed height cap in px. Left out, the body takes the stylesheet's. */
  maxHeight?: number;
  /** Draw the path above the toolbar. The Files reader draws its own, with a copy button. */
  showPath?: boolean;
  /** Controlled view. Left out, the file remembers its own. */
  mode?: FileViewMode;
  onModeChange?: (mode: FileViewMode) => void;
}

export function FileView({
  path,
  content,
  kind = "text",
  dataUrl,
  size,
  diff,
  changes,
  toolbar,
  maxHeight,
  showPath = true,
  mode: modeProp,
  onModeChange,
}: FileViewProps): React.JSX.Element {
  const [own, setOwn] = useState<FileViewMode | null>(null);
  const [wrap, setWrap] = useState(false);
  // The window belongs to one body of text: opening another file starts at the top again without an effect to reset it.
  const [cap, setCap] = useState<{ of: string | undefined; n: number }>({ of: content, n: LINE_WINDOW });
  const lines = useMemo(() => (content ?? "").split("\n"), [content]);
  // A patch is read by its colours: what it adds and what it takes away. Anything else is plain lines.
  const patch = useMemo(() => (kind === "text" && content !== undefined && looksLikePatch(content) ? patchKinds(lines) : null), [kind, content, lines]);

  const cmp: FileChanges | null = changes ?? (diff ? { available: true, diff } : null);
  const modes = fileModes(kind, content !== undefined, cmp?.available === true);
  const wanted = modeProp ?? own ?? modes[0]!;
  const mode: FileViewMode = modes.includes(wanted) ? wanted : modes[0]!;
  const choose = (m: FileViewMode): void => {
    setOwn(m);
    onModeChange?.(m);
  };

  const limit = cap.of === content ? cap.n : LINE_WINDOW;
  const win = lineWindow(lines.length, limit);
  const isText = content !== undefined && kind !== "image" && kind !== "binary";
  // Copy is for text. Copying an image would put a megabyte of base64 on the clipboard, which nobody asked for.
  const canCopy = isText && mode !== "changes";
  const canDownload = (content !== undefined || Boolean(dataUrl)) && mode !== "changes";

  const meta: string[] = [];
  if (kind !== "text") meta.push(kind);
  if (typeof size === "number") meta.push(fmtSize(size));
  if (content !== undefined) meta.push(lines.length === 1 ? "1 line" : `${lines.length.toLocaleString("en-GB")} lines`);
  if (mode === "changes" && cmp?.diff && !cmp.diff.identical) meta.push(`+${cmp.diff.added} −${cmp.diff.removed}`);

  return (
    <div className="fv">
      {showPath ? (
        <div className="fv-pathbar">
          <Icon name="files" size={14} />
          <span className="fv-path mono" title={path}><bdi>{path}</bdi></span>
        </div>
      ) : null}
      <div className="fv-bar">
        {modes.length > 1 ? (
          <div className="seg" role="group" aria-label="How to show this file">
            {modes.map((m) => (
              <button key={m} type="button" className="seg-btn" aria-pressed={m === mode} onClick={() => choose(m)}>{modeLabel(kind, m)}</button>
            ))}
          </div>
        ) : null}
        {meta.length ? <span className="fv-meta">{meta.join(" · ")}</span> : null}
        <span className="fv-actions">
          {toolbar}
          {isText && mode !== "changes" && !(kind === "markdown" && mode === "rendered") ? (
            <Button variant="small" aria-pressed={wrap} title="Wrap long lines instead of scrolling sideways" onClick={() => setWrap(!wrap)}>Wrap lines</Button>
          ) : null}
          {canCopy ? <CopyButton text={content ?? ""} label="Copy" title="Copy the file's contents" /> : null}
          {canDownload ? (
            <Button variant="small" icon="download" title="Save the file to this computer" onClick={() => download(path, content ?? dataUrl ?? "")}>Download</Button>
          ) : null}
        </span>
      </div>
      {mode === "changes" && cmp?.controls ? <div className="fv-controls">{cmp.controls}</div> : null}
      {/* It scrolls, so the keyboard has to be able to reach it: Tab lands here and the arrow keys and Page keys scroll. */}
      <div className="fv-body" role="region" aria-label={mode === "changes" ? `Changes in ${path}` : `Contents of ${path}`} tabIndex={0} style={maxHeight ? { maxHeight } : undefined}>
        {mode === "changes" ? (
          cmp?.error ? (
            <div className="fv-empty" role="alert">
              <p>{cmp.error}</p>
              {cmp.onRetry ? <Button variant="small" icon="refresh" onClick={cmp.onRetry}>Try again</Button> : null}
            </div>
          ) : cmp?.loading || !cmp?.diff ? (
            <p className="fv-empty" role="status">Comparing versions…</p>
          ) : (
            <DiffView diff={cmp.diff} label={cmp.label} />
          )
        ) : kind === "image" && dataUrl ? (
          <div className="fv-image"><img src={dataUrl} alt={path} /></div>
        ) : kind === "binary" ? (
          <p className="fv-empty">
            Binary file{typeof size === "number" ? ` (${fmtSize(size)})` : ""}. There is nothing to show here; download it to open it.
          </p>
        ) : content === undefined ? (
          <p className="fv-empty">This file has no content to show.</p>
        ) : kind === "markdown" && mode === "rendered" ? (
          <div className="fv-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        ) : (
          <div className={`fv-code${wrap ? " wrap" : ""}`}>
            {lines.slice(0, win.shown).map((l, i) => (
              <div className={`fv-line${patch ? ` p-${patch[i]}` : ""}`} key={i}>
                <span className="fv-num">{i + 1}</span>
                <span className="fv-text">{l || " "}</span>
              </div>
            ))}
            {win.remaining > 0 ? (
              <MoreLines remaining={win.remaining} step={LINE_WINDOW} what="lines" onMore={() => setCap({ of: content, n: win.next })} onAll={() => setCap({ of: content, n: lines.length })} />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
