/* One renderer for every file the console shows.
 *
 * Artifacts and workspace files used to render as two different raw <pre>
 * blocks, one of them silently truncated at 8k. This module is the single
 * surface: line numbers, markdown, images, diffs, copy and download. Both
 * the artifact drawer and the Product view mount it, so a fix here fixes
 * both. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip } from "./components";
// Shared with the step view's narration, and DOM-free so its escaping is
// covered by tests/dashboard/markdown.test.ts.
import { renderMarkdown } from "./markdown";

export type FileKind = "text" | "markdown" | "image" | "binary";

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

const fmtSize = (n: number): string =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(n >= 102_400 ? 0 : 1)}kB` : `${n}B`;

function download(name: string, content: string, mime = "text/plain"): void {
  const url = content.startsWith("data:") ? content : URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name.split("/").pop() || "file.txt";
  a.click();
  if (!content.startsWith("data:")) URL.revokeObjectURL(url);
}

export function DiffView({ diff }: { diff: DiffPayload }): React.JSX.Element {
  if (diff.identical) return <div className="muted" style={{ padding: 12 }}>No changes between these versions.</div>;
  if (!diff.hunks.length) return <div className="muted" style={{ padding: 12 }}>Nothing to compare.</div>;
  return (
    <div className="fv-diff">
      {diff.hunks.map((h, hi) => (
        <div className="fv-hunk" key={hi}>
          <div className="fv-hunk-head">@@ line {h.aStart || h.bStart} @@</div>
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
      {diff.truncated ? <div className="muted fv-note">File too large to diff completely — showing the first 6000 lines.</div> : null}
    </div>
  );
}

export interface FileViewProps {
  path: string;
  /** Text content. Omitted for images and binaries. */
  content?: string;
  kind?: FileKind;
  /** data: URL for images. */
  dataUrl?: string;
  size?: number;
  /** When present, a "changes" tab appears alongside the content. */
  diff?: DiffPayload | null;
  /** Extra controls rendered in the toolbar (e.g. a version picker). */
  toolbar?: React.ReactNode;
  maxHeight?: number;
}

export function FileView({
  path,
  content,
  kind = "text",
  dataUrl,
  size,
  diff,
  toolbar,
  maxHeight = 460,
}: FileViewProps): React.JSX.Element {
  const [mode, setMode] = useState<"content" | "diff" | "raw">("content");
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  const lines = useMemo(() => (content ?? "").split("\n"), [content]);
  const effectiveMode = diff && mode === "diff" ? "diff" : mode === "diff" ? "content" : mode;

  const copy = (): void => {
    void navigator.clipboard?.writeText(content ?? dataUrl ?? "").then(() => {
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="fv">
      <div className="fv-bar">
        <span className="fv-path mono" title={path}>{path}</span>
        <span className="fv-meta muted">
          {kind}
          {typeof size === "number" ? ` · ${fmtSize(size)}` : ""}
          {content !== undefined ? ` · ${lines.length} lines` : ""}
          {diff && !diff.identical ? ` · +${diff.added} −${diff.removed}` : ""}
        </span>
        <span className="fv-actions">
          {toolbar}
          {kind === "markdown" ? (
            <Chip hot={effectiveMode === "raw"} onClick={() => setMode(effectiveMode === "raw" ? "content" : "raw")}>
              {effectiveMode === "raw" ? "rendered" : "source"}
            </Chip>
          ) : null}
          {diff ? (
            <Chip hot={effectiveMode === "diff"} onClick={() => setMode(effectiveMode === "diff" ? "content" : "diff")}>
              changes
            </Chip>
          ) : null}
          {content !== undefined ? <Chip hot={wrap} onClick={() => setWrap(!wrap)}>wrap</Chip> : null}
          {content !== undefined || dataUrl ? <Button variant="small" onClick={copy}>{copied ? "copied" : "copy"}</Button> : null}
          {content !== undefined || dataUrl ? (
            <Button variant="small" onClick={() => download(path, content ?? dataUrl ?? "")}>download</Button>
          ) : null}
        </span>
      </div>
      <div className="fv-body" style={{ maxHeight }}>
        {effectiveMode === "diff" && diff ? (
          <DiffView diff={diff} />
        ) : kind === "image" && dataUrl ? (
          <div className="fv-image"><img src={dataUrl} alt={path} /></div>
        ) : kind === "binary" ? (
          <div className="muted" style={{ padding: 16 }}>
            Binary file{typeof size === "number" ? ` (${fmtSize(size)})` : ""} — nothing to show. Download it to inspect.
          </div>
        ) : content === undefined ? (
          <div className="muted" style={{ padding: 16 }}>No content.</div>
        ) : kind === "markdown" && effectiveMode === "content" ? (
          <div className="fv-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        ) : (
          <div className={`fv-code${wrap ? " wrap" : ""}`}>
            {lines.map((l, i) => (
              <div className="fv-line" key={i}>
                <span className="fv-num">{i + 1}</span>
                <span className="fv-text">{l || " "}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
