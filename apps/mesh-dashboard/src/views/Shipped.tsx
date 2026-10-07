import { useMemo } from "react";
import { artifactCls, plainArtifact } from "../format";
import { Button, IconTile, Pill, Skeleton, type PillTone } from "../components";
import { repoPathOf } from "../files";
import type { LoadState } from "../inbox-model";
import { fileIcon, filesByStatus, sortFiles, workspaceOf } from "../overview-model";
import { Panel } from "./Panel";
import "./overview.css";

/** How many files the result shows before it sends the reader to Files. Nine is a small mission; ninety is not a card. */
const SHOWN = 6;

/**
 * What the team made, for a mission that is over. The files come first, settled work before drafts, each one a card that opens it in
 * the reader: what kind of file it is, its name, who made which version, and where it stands. The evidence for each mandatory check
 * lives with the check, in the goal card, so it is said once.
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
    <Panel id="ov-shipped" title="What shipped" meta={files.length ? <><b>{summary.total} {summary.total === 1 ? "file" : "files"}</b>: {summary.groups.map((g) => `${g.count} ${g.label}`).join(", ")}.</> : undefined}>
      {state === "loading" ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the files.</span>
          <ul className="ov-files" aria-hidden="true">
            {[0, 1, 2].map((i) => <li key={i} className="card fc"><Skeleton w={40} h={40} /><Skeleton w="70%" h={14} /><Skeleton w="50%" h={12} /></li>)}
          </ul>
        </div>
      ) : null}
      {state === "error" ? (
        <div className="ov-retry">Could not load the files this mission made. <Button variant="small" icon="refresh" onClick={onRetry}>Try again</Button></div>
      ) : null}
      {state === "ready" && !files.length ? <p className="ov-empty">No files are recorded for this goal.</p> : null}
      {files.length ? (
        <>
          <ul className="ov-files">
            {shown.map((a) => {
              const path = repoPathOf(a);
              return (
                <li key={a.id}>
                  <button type="button" className="card interactive fc" onClick={() => openArt(a)} title={`Read ${a.name}`}>
                    <span className="fc-top">
                      <IconTile icon={fileIcon(a.type)} />
                      <Pill tone={artifactCls(a.status) as PillTone}>{plainArtifact(a.status)}</Pill>
                    </span>
                    <b className="fc-name">{a.name}</b>
                    <span className="fc-meta">{a.type} · v{a.version} · by {a.owner}</span>
                    {path ? <span className="fc-path" title={path}>{path}</span> : null}
                  </button>
                </li>
              );
            })}
          </ul>
          {files.length > shown.length ? <p className="ov-foot">and {files.length - shown.length} more. <Button variant="linklike" onClick={onOpenFiles}>Open the files</Button></p> : null}
          {ws ? <p className="ov-foot">Delivered into <span className="mono">{ws}</span></p> : null}
        </>
      ) : null}
    </Panel>
  );
}
