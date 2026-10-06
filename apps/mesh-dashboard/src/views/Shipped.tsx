import { useMemo } from "react";
import { artifactCls, plainArtifact } from "../format";
import { Button } from "../components";
import { repoPathOf } from "../files";
import type { LoadState } from "../inbox-model";
import { filesByStatus, sortFiles, workspaceOf } from "../overview-model";
import { Panel } from "./Panel";
import "./overview.css";

/** How many files the result shows before it sends the reader to Files. Nine is a small mission; ninety is not a card. */
const SHOWN = 6;

/**
 * What the team made, for a mission that is over. The files come first, settled work before drafts, each one opening in the
 * reader; the evidence for each mandatory check lives with the check, in the goal card, so it is said once.
 *
 * A card shows a path only when the file is in the product's repository (a patch's `src/tx/Pipeline.java`), as the Files list
 * does. Every card used to print where the mesh stores the file's content (`.mesh-state/artifacts/artifacts/art-…/v1.txt`):
 * the mesh's own store, not anything a person ships or opens, and the same on every card.
 */
export function Shipped({ arts, state, onRetry, openArt, onOpenFiles }: {
  arts: any[]; state: LoadState; onRetry: () => void; openArt: (a: any) => void; onOpenFiles: () => void;
}): React.JSX.Element {
  const files = useMemo(() => sortFiles(arts), [arts]);
  const summary = useMemo(() => filesByStatus(arts), [arts]);
  const ws = useMemo(() => workspaceOf(arts), [arts]);
  const shown = files.slice(0, SHOWN);
  return (
    <Panel id="ov-shipped" title="What shipped">
      {state === "loading" ? <p className="ov-empty">Loading the files.</p> : null}
      {state === "error" ? (
        <div className="ov-retry">Could not load the files this mission made. <Button variant="small" icon="refresh" onClick={onRetry}>Try again</Button></div>
      ) : null}
      {state === "ready" && !files.length ? <p className="ov-empty">No files are recorded for this goal.</p> : null}
      {files.length ? (
        <>
          <p className="ov-shipped-sum">
            <b>{summary.total} {summary.total === 1 ? "file" : "files"}</b>: {summary.groups.map((g) => `${g.count} ${g.label}`).join(", ")}.
          </p>
          <ul className="ov-files">
            {shown.map((a) => {
              const path = repoPathOf(a);
              return (
                <li key={a.id}>
                  <button type="button" className="ov-file" onClick={() => openArt(a)} title={`Read ${a.name}`}>
                    <span className={`pill ${artifactCls(a.status)}`}>{plainArtifact(a.status)}</span>
                    <b>{a.name}</b>
                    <span className="meta">{a.type} · v{a.version} · by {a.owner}</span>
                    {path ? <span className="path" title={path}>{path}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {files.length > shown.length ? (
            <p className="ov-more">and {files.length - shown.length} more. <Button variant="linklike" onClick={onOpenFiles}>Open the files</Button></p>
          ) : null}
          {ws ? <p className="ov-foot">Delivered into <span className="mono">{ws}</span></p> : null}
        </>
      ) : null}
    </Panel>
  );
}
