import { useMemo } from "react";
import { artifactCls, plainArtifact } from "../format";
import { Button, IconTile, Pill, Skeleton, type PillTone } from "../components";
import { repoPathOf } from "../files";
import type { LoadState } from "../inbox-model";
import { fileIcon, sortFiles, workspaceOf } from "../overview-model";
import { WIDE, useMedia } from "../useMedia";
import { Panel, type Fold } from "./Panel";
import "./overview.css";

/** How many settled files are drawn as cards before the reader is sent to Files. */
const CARDS = 6;
/** How many files a list group draws. A row is a glance; ninety files are the Files page's job. */
const ROWS = 12;

/**
 * The result is read in the order a person asks about it: what landed, then what has not, then what came back.
 *
 * The panel used to draw every file as the same card under one name, so a merged patch, an approved architecture and six
 * documents still "ready for review" were six equal boxes — and it showed six of nine, with "and 3 more" for the rest. The
 * mission's own answer ("what did I get?") was therefore a wall, and three of the files it made were not on the page.
 *
 * The groups are the artifact's own lifecycle, read through `artifactCls` (the one place the console decides what a status
 * means): a file the tone calls completed is delivered, one it calls waiting is in review, one it calls failed needs rework,
 * and the rest are drafts. `sortFiles` already puts them in this order, so a group keeps the order it arrived in.
 */
type ShipKey = "delivered" | "review" | "draft" | "rework";
const SHIP: ReadonlyArray<{ key: ShipKey; label: string; many: string }> = [
  { key: "delivered", label: "Delivered", many: "delivered" },
  { key: "review", label: "Awaiting review", many: "awaiting review" },
  { key: "draft", label: "Drafts", many: "in draft" },
  { key: "rework", label: "Needs rework", many: "to rework" },
];

const groupOf = (status: unknown): ShipKey => {
  const tone = artifactCls(String(status ?? ""));
  return tone === "completed" ? "delivered" : tone === "waiting" ? "review" : tone === "failed" ? "rework" : "draft";
};

/** The result in one short line, for the phone's closed row: "3 of 9 delivered". It is the honest figure to summarise the
 *  result with: how much of what the team made has actually landed. */
export function shippedLine(arts: readonly { status?: string }[]): string {
  if (!arts.length) return "no files";
  const delivered = arts.filter((a) => groupOf(a.status) === "delivered").length;
  return `${delivered} of ${arts.length} delivered`;
}

/** One settled file: the card the result has always drawn — type, state, name, what it is and where it lives. */
function Card({ a, openArt }: { a: any; openArt: (a: any) => void }): React.JSX.Element {
  const path = repoPathOf(a);
  return (
    <li>
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
}

/**
 * One file that has not landed: a ruled row rather than a card, because it is read as a list ("what is still open?") and a
 * card is the shape for a thing that is the answer. The name, what it is, where it lives when it is in the product, and its
 * state — beside the name on a desk, under it on a phone, so neither the name nor the type is squeezed by a pill.
 */
function Row({ a, openArt }: { a: any; openArt: (a: any) => void }): React.JSX.Element {
  const path = repoPathOf(a);
  return (
    <li>
      <button type="button" className="ship-row" onClick={() => openArt(a)} title={`Read ${a.name}`}>
        <IconTile icon={fileIcon(a.type)} size="sm" />
        <b className="ship-name">{a.name}</b>
        <span className={`ship-state ${artifactCls(a.status)}`}>{plainArtifact(a.status)}</span>
        <span className="ship-meta">
          {a.type} · v{a.version} · by {a.owner}
          {path ? <span className="ship-path" title={path}>{path}</span> : null}
        </span>
      </button>
    </li>
  );
}

export function Shipped({ arts, state, onRetry, openArt, onOpenFiles, fold }: {
  arts: any[]; state: LoadState; onRetry: () => void; openArt: (a: any) => void; onOpenFiles: () => void; fold?: Fold;
}): React.JSX.Element {
  const files = useMemo(() => sortFiles(arts), [arts]);
  const ws = useMemo(() => workspaceOf(arts), [arts]);
  // A desk (the console's 1101 break, `WIDE`) has the width for three delivered files as cards. Below it — a tablet, a phone —
  // the delivered and open files are one ruled ledger under their two captions: three cards in two columns left the third alone
  // under an empty cell, and a card narrower than 280 px wraps a name to three lines to say less than a row does.
  const cards = useMedia(WIDE);
  const groups = useMemo(
    () => SHIP.map((g) => ({ ...g, files: files.filter((a) => groupOf(a.status) === g.key) })).filter((g) => g.files.length > 0),
    [files],
  );
  // "9 files · 3 delivered · 6 awaiting review": the count first, then the split in the order the page draws it.
  const meta = files.length ? (
    <>
      <b>{files.length} {files.length === 1 ? "file" : "files"}</b>
      {groups.map((g) => ` · ${g.files.length} ${g.many}`).join("")}
    </>
  ) : undefined;
  return (
    <Panel id="ov-shipped" title="What shipped" fold={fold} meta={meta}>
      {state === "loading" ? (
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the files.</span>
          {!cards ? (
            <ul className="ship-list" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <li key={i}>
                  <div className="ship-skel-row">
                    <Skeleton w={28} h={28} />
                    <span><Skeleton w={`${52 + (i % 3) * 12}%`} h={14} /><Skeleton w="34%" h={12} /></span>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="ov-files" aria-hidden="true">
              {[0, 1, 2].map((i) => <li key={i} className="card fc fc-skel"><Skeleton w={40} h={40} /><Skeleton w="70%" h={14} /><Skeleton w="50%" h={12} /></li>)}
            </ul>
          )}
        </div>
      ) : null}
      {state === "error" ? (
        <div className="ov-retry">Could not load the files this mission made. <Button variant="small" icon="refresh" onClick={onRetry}>Try again</Button></div>
      ) : null}
      {state === "ready" && !files.length ? <p className="ov-empty">No files are recorded for this goal.</p> : null}
      {files.length ? (
        <>
          {groups.map((g) => {
            const shown = g.key === "delivered" ? g.files.slice(0, CARDS) : g.files.slice(0, ROWS);
            const hidden = g.files.length - shown.length;
            return (
              <div key={g.key} className={`ship-group ${g.key}`}>
                <h4 className="ship-h"><span>{g.label}</span><b className="ship-n">{g.files.length}</b></h4>
                {g.key === "delivered" && cards ? (
                  <ul className="ov-files ship-cards">{shown.map((a) => <Card key={a.id} a={a} openArt={openArt} />)}</ul>
                ) : (
                  <ul className="ship-list">{shown.map((a) => <Row key={a.id} a={a} openArt={openArt} />)}</ul>
                )}
                {hidden > 0 ? (
                  <p className="ov-foot">and {hidden} more {g.many}. <Button variant="linklike" onClick={onOpenFiles}>Open the files</Button></p>
                ) : null}
              </div>
            );
          })}
          {ws ? <p className="ov-foot">Delivered into <span className="mono"><bdi>{ws}</bdi></span></p> : null}
        </>
      ) : null}
    </Panel>
  );
}
