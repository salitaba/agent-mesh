/* ---------------------------------------------------------------------- *
 * Live work widgets — what a running turn is doing while it does it.
 *
 *   NowLine        — the call in flight (or the last one), and how long ago
 *   DeadlineBar    — elapsed against the stop time, the hard stop, extensions
 *   AdvisoryList   — deadline warnings the mesh sent the seat mid-turn
 *   LiveToolList   — recent tool calls, newest first, failures with their error
 *   FilesTouched   — what the seat asked to write, collapsible
 *   CheckpointNote — where a stopped turn's uncommitted work was saved
 *
 * All the wording and arithmetic is in livework.ts (tested); these only draw.
 * ---------------------------------------------------------------------- */

import { useState } from "react";
import { dur } from "./format";
import { useTick } from "./observability";
import { CopyBtn } from "./stepdetail";
import { Button, ZoneNote } from "./components";
import { Icon, type IconName } from "./icons";
import {
  advisoryLine, ageText, bareToolName, currentToolOf, deadlineOf, deadlineText, firstDeadline, hardStopText, nowParts,
  type CurrentTool, type DeadlineInput, type LiveToolCall, type LiveWork, type TurnAdvisory, type TurnCheckpoint,
} from "./livework";

/** "Edit · packages/core/src/domain/model.ts · 4s ago" — one line, ticking. */
export function NowLine({ tool }: { tool?: CurrentTool }): React.JSX.Element | null {
  useTick(1000, Boolean(tool));
  if (!tool) return null;
  const p = nowParts(tool, Date.now());
  return (
    <div className={`lw-now${p.running ? " run" : ""}${p.failed ? " fail" : ""}`} role="status" aria-live="off">
      <span className="lw-now-k" title={p.running ? "the tool call in flight" : "the most recent tool call — nothing is running this second"}>
        {p.running ? "now" : "last"}
      </span>
      <b className="lw-now-n mono">{p.name}</b>
      {p.target ? <span className="lw-now-t mono" title={p.target}>{p.target}</span> : null}
      <span className="lw-now-w">{p.when}</span>
    </div>
  );
}

/**
 * Elapsed against the stop time. The track runs from the runtime call (the
 * deadline's own origin) to the later of the deadline and the hard stop, so
 * the fill reaching the first tick means "stopped unless extended".
 */
export function DeadlineBar({ turnId, phases }: { turnId: string; phases?: DeadlineInput }): React.JSX.Element | null {
  const on = typeof phases?.deadlineAt === "number";
  useTick(1000, on);
  const first = firstDeadline(turnId, phases?.deadlineAt);
  const d = deadlineOf(phases, Date.now(), first);
  if (!d) return null;
  const hard = hardStopText(d);
  return (
    <div className={`lw-dl lw-${d.tone}`}>
      <div className="lw-dl-head">
        <span className="lw-dl-left">{deadlineText(d)}</span>
        {d.extended ? (
          <span className="lw-dl-ext" title="the deadline moved later while this page watched — the seat claimed a task or kept producing frames">extended</span>
        ) : null}
        {hard ? <span className="lw-dl-hard" title="no extension passes this">{hard}</span> : null}
        <span className="lw-dl-el muted">{ageText(d.elapsedMs)} in</span>
      </div>
      <div
        className="lw-dl-track"
        role="progressbar"
        aria-label="time used against the turn's deadline"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(d.elapsedPct)}
      >
        <span className="lw-dl-fill" style={{ width: `${d.elapsedPct}%` }} />
        <span className="lw-dl-mark" style={{ left: `${d.deadlinePct}%` }} title={d.atCeiling ? "deadline — also the hard stop" : "current deadline"} />
        {d.ceilingPct !== undefined && !d.atCeiling
          ? <span className="lw-dl-mark ceil" style={{ left: `${d.ceilingPct}%` }} title="hard stop" />
          : null}
      </div>
    </div>
  );
}

export function AdvisoryList({ items }: { items?: TurnAdvisory[] }): React.JSX.Element | null {
  if (!items?.length) return null;
  return (
    <>
      <p className="zone-line"><ZoneNote /></p>
      <ul className="lw-adv" aria-label="notes the mesh sent the seat during this turn">
        {items.map((a, i) => (
          <li key={i} className={a.delivered ? undefined : "undelivered"}>
            <span>{advisoryLine(a)}</span>
            {!a.delivered ? (
              <span className="lw-adv-x" title="the runtime could not queue this note, so the seat never saw it">not delivered</span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/** A tick and a cross are icons; a call in flight is a dot, drawn in CSS, that pulses. */
const MARK: Record<LiveToolCall["status"], IconName | null> = { running: null, completed: "check", failed: "x" };
/** Rows shown before the fold; the record keeps at most 60. */
const LIVE_ROWS = 12;

/** Recent tool calls, newest first. Running rows tick; failed rows show why. */
export function LiveToolList({ tools, total }: { tools: LiveToolCall[]; total?: number }): React.JSX.Element | null {
  const running = tools.some((t) => t.status === "running");
  useTick(1000, running);
  const [all, setAll] = useState(false);
  if (!tools.length) return null;
  const newest = [...tools].reverse();
  const shown = all ? newest : newest.slice(0, LIVE_ROWS);
  const now = Date.now();
  const count = typeof total === "number" && total > tools.length
    ? `newest ${tools.length} of ${total} calls`
    : `${tools.length} call${tools.length === 1 ? "" : "s"}`;
  return (
    <div className="lw-tools">
      <div className="lw-h">
        <span className="sec-label">Recent tool calls</span>
        <span className="sv-sec-n mono">{count}</span>
      </div>
      {shown.map((t) => {
        const took = t.status === "running" ? `running ${ageText(now - t.startedAt)}` : t.endedAt !== undefined ? dur(t.endedAt - t.startedAt) || "0ms" : "";
        return (
          <div key={t.id} className={`lw-tool lw-${t.status}`}>
            <span className="lw-mark" role="img" aria-label={t.status} title={t.status}>
              {MARK[t.status] ? <Icon name={MARK[t.status] as IconName} size={12} /> : <i className="lw-dot" />}
            </span>
            <span className="lw-tool-n mono" title={t.name}>{bareToolName(t.name)}</span>
            <span className="lw-tool-a mono" title={t.target || undefined}>{t.target || "—"}</span>
            <span className="lw-tool-w mono">{took}</span>
            {t.status === "failed" && t.error ? <div className="lw-tool-err mono">{t.error}</div> : null}
          </div>
        );
      })}
      {newest.length > LIVE_ROWS ? (
        <Button variant="linklike" onClick={() => setAll((a) => !a)}>
          {all ? `show the newest ${LIVE_ROWS} only` : `show all ${newest.length}`}
        </Button>
      ) : null}
    </div>
  );
}

export function FilesTouched({ files }: { files: string[] }): React.JSX.Element | null {
  if (!files.length) return null;
  return (
    <details className="sv-fold lw-files">
      <summary>
        {files.length} file{files.length === 1 ? "" : "s"} touched
        <span className="muted"> — what the seat asked to write, not a diff</span>
      </summary>
      <ul className="lw-file-list mono">
        {files.map((f) => <li key={f} title={f}>{f}</li>)}
      </ul>
    </details>
  );
}

export function CheckpointNote({ cp }: { cp: TurnCheckpoint }): React.JSX.Element {
  const n = cp.files.length;
  return (
    <div className="lw-cp">
      <div className="lw-cp-head">
        <b>Uncommitted work was saved</b>
        <span className="muted"> — {n} file{n === 1 ? "" : "s"} snapshotted when the turn was stopped</span>
      </div>
      <div className="lw-cp-ref">
        <code className="mono" title={cp.commit ? `commit ${cp.commit}` : undefined}>{cp.ref}</code>
        <CopyBtn text={cp.ref} />
      </div>
      {n ? (
        <details className="sv-fold">
          <summary>files in the snapshot</summary>
          <ul className="lw-file-list mono">{cp.files.map((f) => <li key={f} title={f}>{f}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * The live-work block of the step drawer. Running: what it is doing now, how
 * long it has left, what it was told, what it did. Finished: the same record,
 * which is all that is left of a turn that failed — `toolCallsDetail` is only
 * written on success.
 */
export function LiveWork({ turnId, work, tools, phases, running }: {
  turnId: string;
  work: LiveWork;
  /** `work.liveTools`, optionally merged with the SSE stream. */
  tools: LiveToolCall[];
  phases?: DeadlineInput;
  running: boolean;
}): React.JSX.Element | null {
  const anything = tools.length || work.filesTouched.length || work.advisories.length || work.checkpoint || (running && phases?.deadlineAt);
  if (!anything) return null;
  return (
    <div className="lw">
      {running ? <NowLine tool={currentToolOf(tools)} /> : null}
      {running ? <DeadlineBar turnId={turnId} phases={phases} /> : null}
      <AdvisoryList items={work.advisories} />
      {work.checkpoint ? <CheckpointNote cp={work.checkpoint} /> : null}
      <LiveToolList tools={tools} total={work.toolCallCount} />
      <FilesTouched files={work.filesTouched} />
    </div>
  );
}
