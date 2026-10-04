import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Button, ZoneNote, rowKey } from "./components";
import { hhmmss, plainEvent, snippetDiff, zoneLabel, type SnippetLine } from "./format";
import { storageClips, type StorageClip } from "./ledger";
import { renderMarkdown } from "./markdown";
import { evClass, evSeverity } from "./events";
import { CopyBtn, bareToolName, salientArg, textStats, toolFailure, toolGroupOf, type ToolCall, type SandboxPerms } from "./stepdetail";
// The rows are built in ledger.ts and composed with the pieces below by
// drawers.tsx.
import type { OpRow } from "./ledger";
import type { TimelineEvent } from "./store";

/* Step view: the wide, single-scroll replacement for the tabbed step drawer.
   The old surface split four reader jobs — follow the reasoning, debug the
   failure, audit the tool calls, move between turns — across five mutually
   exclusive tabs, so at most one job was served per viewport. Everything here
   is on one scroll, ordered by urgency, with a sticky inspector column that
   takes the place of the drill-down drawers that used to *replace* this panel
   (shell.tsx builds the panel as `drawer ?? detailNode`, so a nested drawer
   unmounted the step and lost the reader's position entirely). */

/** What the inspector column is currently showing. */
export type Sel =
  | { kind: "tool"; idx: number }
  | { kind: "op"; idx: number }
  | { kind: "event"; seq: number }
  | null;

export interface Section { id: string; label: string; n?: number }

/* ---------- section jump nav, with scroll spy ---------- */

/** Below this width the side column stacks under the page (see styles.css),
 *  so the inspector opens inline under the row that was picked instead. */
export const STEP_NARROW = "(max-width: 1100px)";

/** Match a media query and re-render when it flips. A local copy: the shell's
 *  `useMedia` lives in shell.tsx, which imports drawers.tsx, which imports this. */
export function useStepMedia(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = (e: MediaQueryListEvent): void => setMatch(e.matches);
    mq.addEventListener("change", on);
    setMatch(mq.matches);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/**
 * Sticky in-header nav. The drawer is the scroll container, so the spy reads
 * positions against it. The active section is the last one whose top has
 * passed the header's bottom edge — not the one with the largest visible
 * share, which let a short section peeking in beat a tall one filling the
 * screen. The header's height is measured, never assumed: it wraps.
 */
export function StepJump({ sections, scroller }: { sections: Section[]; scroller: HTMLElement | null }): React.JSX.Element {
  const [active, setActive] = useState<string>(sections[0]?.id ?? "");
  // A clicked pill wins until its smooth scroll settles: a section too close
  // to the bottom to reach the top line would otherwise hand the pill to the
  // one above it the moment the scroll finished.
  const pinned = useRef<{ id: string; until: number } | null>(null);
  // Keyed on the ids, not the array: the drawer rebuilds `sections` on every
  // render, which on a live turn is every poll and every token frame.
  const ids = sections.map((x) => x.id).join(" ");
  useEffect(() => {
    if (!scroller) return;
    const list = ids.split(" ").filter(Boolean);
    let raf = 0;
    const measure = (): void => {
      raf = 0;
      const pin = pinned.current;
      if (pin && Date.now() < pin.until) return;
      pinned.current = null;
      const top = scroller.getBoundingClientRect().top;
      const head = (scroller.querySelector(".sv-head") as HTMLElement | null)?.offsetHeight ?? 0;
      const line = top + head + 32;
      let best = list[0] ?? "";
      for (const id of list) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= line) best = id;
      }
      // At the very bottom the last sections can never reach the line; the
      // reader is looking at the end of the page, so say so.
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        const last = list[list.length - 1];
        const el = last ? document.getElementById(last) : null;
        if (el && el.getBoundingClientRect().top < top + scroller.clientHeight) best = last!;
      }
      setActive(best);
    };
    const on = (): void => { if (!raf) raf = requestAnimationFrame(measure); };
    on();
    scroller.addEventListener("scroll", on, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ids, scroller]);
  const go = (id: string): void => {
    const el = document.getElementById(id);
    // Raw and Brief are nothing but folds; landing on a row of closed
    // summaries made the jump look like it had missed.
    const fold = el?.querySelector("details");
    if (fold && !el?.querySelector("details[open]")) fold.open = true;
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
    pinned.current = { id, until: Date.now() + 900 };
    setActive(id);
  };
  return (
    <nav className="sv-jump" aria-label="step sections">
      {sections.map((x) => (
        <button
          type="button"
          key={x.id}
          className={`sv-jump-b${active === x.id ? " on" : ""}`}
          aria-current={active === x.id ? "true" : undefined}
          onClick={() => go(x.id)}
        >
          {x.label}
          {x.n != null ? <span className="sv-jump-n mono">{x.n}</span> : null}
        </button>
      ))}
    </nav>
  );
}

/* ---------- prose ---------- */

/**
 * Narrative text at a reading measure. The old drawer pushed reasoning,
 * summaries and instructions all through `<pre class="token-stream">`, so the
 * one genuinely prose-shaped thing on the page was set in monospace at full
 * drawer width. Mono is reserved here for payloads and identifiers.
 */
export function Prose({ children, dim }: { children: React.ReactNode; dim?: boolean }): React.JSX.Element {
  return <p className={`sv-prose${dim ? " dim" : ""}`}>{children}</p>;
}

/**
 * The model's own words, rendered as the markdown it wrote. Set as plain text
 * the narration read as `**Orientation.**` and a table of raw pipes; models
 * write markdown whether or not anything renders it. The renderer escapes
 * before it marks anything up (markdown.ts), so the model's text cannot
 * become markup of its own. Kernel notices, the brief and the raw output stay
 * plain text: they are records, not prose.
 */
export function MarkdownProse({ text }: { text: string }): React.JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div className="sv-prose sv-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Characters of narration shown before "show all": a full reply can run to
 *  screens, and it sits above Outcome, which is what most readers came for. */
const PROSE_CLIP = 1200;

/**
 * Prose that folds past `PROSE_CLIP`, cut at a line or word boundary. With
 * `markdown` the cut is made in the source and the kept part rendered, so the
 * fold never splits a tag; the ellipsis gets a paragraph of its own, since
 * appended to a table row it would be a cell the table then drops.
 */
export function ClampedProse({ text, markdown }: { text: string; markdown?: boolean }): React.JSX.Element {
  const [all, setAll] = useState(false);
  const body = (t: string): React.JSX.Element => (markdown ? <MarkdownProse text={t} /> : <Prose>{t}</Prose>);
  if (text.length <= PROSE_CLIP) return body(text);
  let cut = text.lastIndexOf("\n", PROSE_CLIP);
  if (cut < PROSE_CLIP * 0.6) cut = text.lastIndexOf(" ", PROSE_CLIP);
  if (cut < PROSE_CLIP * 0.6) cut = PROSE_CLIP;
  const kept = text.slice(0, cut).trimEnd();
  return (
    <>
      {body(all ? text : markdown ? `${kept}\n\n…` : `${kept} …`)}
      <Button variant="linklike" onClick={() => setAll((a) => !a)}>
        {all ? "show less" : `show all ${Math.round(text.length / 100) / 10}k chars`}
      </Button>
    </>
  );
}

/* ---------- op ledger ---------- */

/** Terse badge copy; the full sentence lives in the tooltip. Three lowercase
 *  words tracked uppercase at 9.5px competed with the row's actual content. */
type FxKind = "ok" | "guess" | "miss" | "missguess" | "na" | "refused";
const FX: Record<FxKind, { label: string; hint: string }> = {
  refused: { label: "refused", hint: "the kernel refused this action — nothing it asked for happened" },
  ok: { label: "recorded", hint: "an event naming this action's target was found in the log" },
  guess: {
    label: "probably recorded",
    hint: "an event of the right kind was found, but several actions of this kind compete for it and nothing in it names this one's target — the pairing is a best guess",
  },
  miss: { label: "not recorded", hint: "no matching event was found — this action may not have landed" },
  missguess: {
    label: "not recorded?",
    hint: "fewer events than actions of this kind were found, and the pairing between them is a best guess — this may be the one that did not land, or another may be",
  },
  na: { label: "n/a", hint: "this action produces nothing observable in the event log" },
};

function fxKind(r: OpRow): FxKind {
  // A refusal outranks any pairing: an event of the right kind found near a
  // refused op belongs to some other op, and "recorded" beside it would lie.
  if (r.refusal) return "refused";
  if (r.fx === undefined) return "na";
  if (r.fx) return r.guess ? "guess" : "ok";
  return r.guess ? "missguess" : "miss";
}

export function OpLedger({ rows, sel, onSelect, detail }: {
  rows: OpRow[];
  sel: Sel;
  onSelect: (s: Sel) => void;
  /** Narrow layout: the inspector, rendered right under the picked row. */
  detail?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="sv-ops">
      {rows.map((r, i) => {
        const on = sel?.kind === "op" && sel.idx === i;
        // `undefined` means the op has no observable effect to look for (done,
        // reads, leases) — that is not a failure and must not be styled as one.
        const kind = fxKind(r);
        const cls = kind === "guess" ? "ok" : kind === "missguess" ? "miss" : kind;
        const pick = (): void => onSelect(on ? null : { kind: "op", idx: i });
        return (
          <Fragment key={i}>
          <div
            className={`sv-op sv-op-${cls}${on ? " on" : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            onClick={pick}
            onKeyDown={rowKey(pick)}
          >
            <span className="sv-op-i mono" aria-hidden="true">{i + 1}</span>
            {/* Title and labelled parameters on the first line, the op's own
                prose on the second — rather than one run-on line where the
                detail was a truncated JSON blob squeezed to nothing. */}
            <div className="sv-op-main">
              <div className="sv-op-r1">
                {/* One line, clipped: "Escalated: <a sentence>" wrapped to a
                    bold second line and outweighed every row around it. */}
                <span className="sv-op-t" title={r.head.title}>{r.head.title}</span>
                {r.head.note ? <span className="sv-op-note" title="its arguments were not captured, and the log cannot tell which of these landed what">{r.head.note}</span> : null}
                {/* The value is its own box so it can ellipsize: as bare text
                    in a nowrap chip it ran past the chip's max-width and
                    scrolled a 390px drawer 171px sideways. */}
                {r.head.facts.map((f) => (
                  <span className="sv-op-f" key={f.k} title={`${f.k}: ${f.v}`}>
                    <b>{f.k}</b><span className="sv-op-fv">{f.v}</span>
                  </span>
                ))}
              </div>
              {/* Why the kernel said no is the one thing a refused row is read
                  for, and it lived only in the badge's tooltip — under a
                  past-tense title ("Merged …") that read as if it had worked. */}
              {kind === "refused" && r.refusal?.reason
                ? <span className="sv-op-why" title={r.refusal.reason}>{r.refusal.reason}</span>
                : null}
              {r.head.detail ? <span className="sv-op-d" title={r.head.detail}>{r.head.detail}</span> : null}
            </div>
            <span className={`sv-op-fx sv-op-fx-${kind}`} title={kind === "refused" ? r.refusal?.reason || FX.refused.hint : FX[kind].hint}>{FX[kind].label}</span>
          </div>
          {on && detail ? detail : null}
          </Fragment>
        );
      })}
    </div>
  );
}

/* ---------- tool calls ---------- */

/** Rows shown before "show all": a 200-call turn otherwise pushed Events a
 *  full screen-height further down for every reader, not just the one auditing. */
const TOOL_ROWS = 40;

/**
 * Flat, dense, one row per call in execution order. The grouped-accordion
 * version buried the sequence: reading it, you could not tell whether the
 * shell call happened before or after the edit it was supposed to verify.
 * Family is kept as a tag; a flag marks a call only when the runtime's own
 * record of it says it failed.
 */
export function ToolRows({ calls, sel, onSelect, detail }: {
  calls: ToolCall[];
  /** Accepted and ignored: configured permissions say what a seat may do,
   *  not what a call did. Reading them here marked every Write "sandbox" on
   *  a seat whose writes had all succeeded. */
  perms?: SandboxPerms;
  sel: Sel;
  onSelect: (s: Sel) => void;
  detail?: React.ReactNode;
}): React.JSX.Element {
  const [all, setAll] = useState(false);
  // A selection past the fold (made before "show first 40 only") must stay
  // on screen, or the inspector describes a row nobody can find.
  const hiddenSel = sel?.kind === "tool" && sel.idx >= TOOL_ROWS;
  const shown = all || hiddenSel ? calls : calls.slice(0, TOOL_ROWS);
  return (
    <div className="sv-tools">
      {shown.map((c, i) => {
        const name = String(c.name ?? "tool");
        const fam = toolGroupOf(name);
        const fail = toolFailure(c);
        const arg = salientArg(name, c.args);
        const on = sel?.kind === "tool" && sel.idx === i;
        const pick = (): void => onSelect(on ? null : { kind: "tool", idx: i });
        return (
          <Fragment key={i}>
          <div
            className={`sv-tool${on ? " on" : ""}${fail ? ` ${fail}` : ""}`}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            onClick={pick}
            onKeyDown={rowKey(pick)}
          >
            {/* The turn's own numbering, not the list's: with calls past the
                caps skipped, row 31 can be the turn's 48th call. */}
            <span className="sv-tool-i mono" aria-hidden="true">{(typeof c.index === "number" ? c.index : i) + 1}</span>
            <span className={`sv-tool-fam sv-fam-${fam}`}>{fam}</span>
            <span className="sv-tool-n mono" title={name}>{bareToolName(name)}</span>
            <span className="sv-tool-a mono" title={arg || undefined}>{arg || "—"}</span>
            {fail ? <span className="sv-tool-x" title={c.error || undefined}>{fail}</span> : null}
          </div>
          {on && detail ? detail : null}
          </Fragment>
        );
      })}
      {calls.length > TOOL_ROWS && !hiddenSel ? (
        <Button variant="linklike" onClick={() => setAll((a) => !a)}>
          {all ? `show the first ${TOOL_ROWS} only` : `show all ${calls.length} calls`}
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- events ---------- */

/** Offset from the turn's start: signed (the event that woke the turn can
 *  predate it), and minutes past a minute rather than "+754.2s". */
export function offsetText(ms: number): string {
  const sign = ms < 0 ? "−" : "+";
  const a = Math.abs(ms);
  if (a < 1000) return `${sign}${Math.round(a)}ms`;
  if (a < 60_000) return `${sign}${(a / 1000).toFixed(1)}s`;
  const m = Math.floor(a / 60_000);
  const sec = Math.floor((a % 60_000) / 1000);
  return `${sign}${m}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Events that record how the turn was run rather than what it did: the budget
 * hold and its settlement, the context build, the session start, lifecycle
 * churn. They are a third of a typical step's timeline, all of it ahead of
 * and after the events a reader came for. The catalog's `routine` severity is
 * the floor (via `evSeverity`, so a move into FAILED or BLOCKED still shows),
 * with two corrections for this view: a session start is bookkeeping here, and
 * `memory.updated` is not — on a step it is the effect of the seat's own
 * `remember` call.
 */
export function isBookkeeping(e: { type?: unknown; payload?: unknown }): boolean {
  const type = String(e.type ?? "");
  if (type === "agent.started") return true;
  if (type === "memory.updated") return false;
  return evSeverity({ type, payload: e.payload } as TimelineEvent) === "routine";
}

export function EventRows({ rows, sel, onSelect, t0, detail }: {
  rows: any[];
  sel: Sel;
  onSelect: (s: Sel) => void;
  t0?: string;
  detail?: React.ReactNode;
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const base = t0 ? Date.parse(t0) : NaN;
  const folded = rows.filter(isBookkeeping).length;
  // The selected event stays on screen even when it is bookkeeping: picked
  // from the causal rail, it would otherwise open an inspector for a row the
  // reader cannot find.
  const shown = showAll ? rows : rows.filter((e) => !isBookkeeping(e) || (sel?.kind === "event" && sel.seq === e.seq));
  const hidden = rows.length - shown.length;
  return (
    <div className="sv-evs">
      {/* With a turn start the rows read as offsets ("+1.2s"); without one they are wall-clock times, and the zone is said here once. */}
      {Number.isNaN(base) && shown.length ? <p className="zone-line"><ZoneNote /></p> : null}
      {shown.map((e) => {
        const on = sel?.kind === "event" && sel.seq === e.seq;
        const pick = (): void => onSelect(on && e.seq != null ? null : { kind: "event", seq: e.seq });
        // Offset from the turn's own start reads better than a wall clock when
        // the question is "how long after it woke did this land?".
        const ms = Number.isNaN(base) ? NaN : Date.parse(e.at) - base;
        const off = Number.isNaN(ms) ? null : offsetText(ms);
        return (
          <Fragment key={e.seq ?? e.id}>
          <div
            className={`sv-ev ${evClass(e.type)}${on ? " on" : ""}${isBookkeeping(e) ? " quiet" : ""}`}
            role={e.seq != null ? "button" : undefined}
            tabIndex={e.seq != null ? 0 : undefined}
            aria-pressed={e.seq != null ? on : undefined}
            onClick={() => e.seq != null && pick()}
            onKeyDown={rowKey(() => { if (e.seq != null) pick(); })}
          >
            <span className="sv-ev-off mono">{off ?? hhmmss(e.at)}</span>
            {/* With the payload: "couldn't wake" and "moved to draft" both
                live there, and the bare type dropped them. */}
            <span className={`sv-ev-t ${evClass(e.type)}`}>{plainEvent(e.type, e.payload)}</span>
            <span className="sv-ev-s" title={e.summary || undefined}>{e.summary}</span>
            <span className="sv-ev-q mono">#{e.seq}</span>
          </div>
          {on && detail ? detail : null}
          </Fragment>
        );
      })}
      {(showAll ? folded : hidden) ? (
        <Button variant="linklike" onClick={() => setShowAll((a) => !a)} aria-expanded={showAll}>
          {showAll
            ? `hide ${folded} bookkeeping event${folded === 1 ? "" : "s"}`
            : `${hidden} bookkeeping event${hidden === 1 ? "" : "s"} hidden · show`}
        </Button>
      ) : null}
    </div>
  );
}

/* ---------- inspector ---------- */

export function jsonText(value: unknown): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    s = String(value);
  }
  return s ?? "";
}

/** A payload, clipped at `max` with a way to see the rest — a truncation the
 *  reader cannot undo sends them to the raw log for the one field they need. */
export function JsonBlock({ value, max = 6000 }: { value: unknown; max?: number }): React.JSX.Element {
  const [all, setAll] = useState(false);
  const s = jsonText(value);
  const clipped = !all && s.length > max;
  return (
    <>
      <pre className="sv-json">{clipped ? s.slice(0, max) : s}{clipped ? "\n…" : ""}</pre>
      {s.length > max ? (
        <Button variant="linklike" onClick={() => setAll((a) => !a)}>
          {all ? "show less" : `show all ${Math.round(s.length / 100) / 10}k chars`}
        </Button>
      ) : null}
    </>
  );
}

/** A file edit's before → after, as lines: a common head and tail kept as
 *  short context around what was cut and what was added. */
export function SnippetDiff({ before, after, max = 6000 }: { before: string; after: string; max?: number }): React.JSX.Element {
  const [all, setAll] = useState(false);
  const lines = snippetDiff(before, after);
  const size = lines.reduce((n, l) => n + l.text.length + 1, 0);
  // Same clip as JsonBlock, counted in characters but cut at a line.
  const shown: SnippetLine[] = [];
  let used = 0;
  for (const l of lines) {
    if (!all && used >= max) break;
    shown.push(l);
    used += l.text.length + 1;
  }
  return (
    <>
      <div className="fv-diff sv-diff">
        {shown.map((l, i) => (
          l.op === "gap"
            ? <div className="sv-diff-gap" key={i}>{l.text}</div>
            : (
              <div className={`fv-line ${l.op}`} key={i}>
                <span className="fv-sign" aria-hidden="true">{l.op === "add" ? "+" : l.op === "del" ? "−" : " "}</span>
                <span className="fv-text">{l.text || " "}</span>
              </div>
            )
        ))}
        {shown.length < lines.length ? <div className="sv-diff-gap">…</div> : null}
      </div>
      {size > max ? (
        <Button variant="linklike" onClick={() => setAll((a) => !a)}>
          {all ? "show less" : `show all ${Math.round(size / 100) / 10}k chars`}
        </Button>
      ) : null}
    </>
  );
}

const count = (n: number): string => n.toLocaleString("en-US");

/**
 * Where the server cut an argument at storage. It keeps only the first few
 * thousand characters of each string in a call's arguments, and the stored
 * start reads as a complete value — "show all" included, since all it can
 * show is what was stored. This note is the only trace of the cut. `diff`
 * adds what the cut does to an edit: the diff ends where storage stopped,
 * not where the edit did.
 */
function ClipNote({ clips, diff }: { clips: StorageClip[]; diff?: boolean }): React.JSX.Element | null {
  if (!clips.length) return null;
  return (
    <p className="sv-clip">
      <b>Clipped at storage.</b>{" "}
      {clips.map((c, i) => (
        <Fragment key={c.path}>
          {i ? "; " : null}
          <span className="mono">{c.path}</span> was {count(c.original)} chars
          {c.stored !== undefined ? `, ${count(c.stored)} kept` : ""}
        </Fragment>
      ))}
      . {diff
        ? "The change below ends where storage cut the text, not where the edit ended."
        : "\u201cshow all\u201d shows only what was kept."}
    </p>
  );
}

/**
 * The inspector body for a call that changes a file: the path, then the text
 * itself — Write's content, Edit's old → new — instead of one escaped JSON
 * string with every newline spelled "\n". Null for any other tool, or for a
 * file tool whose arguments are not the expected shape, which then falls back
 * to the raw JSON. The copy button still takes the full arguments either way.
 * `clipped` is the call's `argsClipped`: each view says which of its strings
 * are only the stored start of what the seat wrote.
 */
function fileChange(name: string, args: unknown, clipped?: unknown): React.ReactNode | null {
  const n = bareToolName(name).toLowerCase();
  if (!["write", "edit", "multiedit", "notebookedit"].includes(n)) return null;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string";
  const pathKey = ["file_path", "notebook_path", "filePath", "path"].find((k) => str(a[k]));
  const used = new Set<string>(pathKey ? [pathKey] : []);
  const clips = (...keys: string[]): StorageClip[] => keys.flatMap((k) => storageClips(a, clipped, k));
  let change: React.ReactNode = null;
  if (n === "write" && str(a.content)) {
    used.add("content");
    const cut = clips("content")[0];
    // A clipped Write's line count is the stored start's; say the size it had.
    const stats = cut ? `${count(cut.original)} chars · first ${count(a.content.length)} kept` : textStats(a.content);
    change = <><h5>content <span className="sv-h5-n">{stats}</span></h5><ClipNote clips={clips("content")} /><JsonBlock value={a.content} /></>;
  } else if (n === "edit" && str(a.old_string) && str(a.new_string)) {
    ["old_string", "new_string", "replace_all"].forEach((k) => used.add(k));
    change = (
      <>
        <h5>change{a.replace_all === true ? " · every occurrence" : ""}</h5>
        <ClipNote clips={clips("old_string", "new_string")} diff />
        <SnippetDiff before={a.old_string} after={a.new_string} />
      </>
    );
  } else if (n === "multiedit" && Array.isArray(a.edits) && a.edits.every((e) => e && str(e.old_string) && str(e.new_string))) {
    used.add("edits");
    const edits = a.edits as { old_string: string; new_string: string; replace_all?: boolean }[];
    change = edits.map((e, i) => (
      <Fragment key={i}>
        <h5>change {i + 1} of {edits.length}{e.replace_all ? " · every occurrence" : ""}</h5>
        <ClipNote clips={clips(`edits.${i}`)} diff />
        <SnippetDiff before={e.old_string} after={e.new_string} />
      </Fragment>
    ));
  } else if (n === "notebookedit" && str(a.new_source)) {
    ["new_source", "cell_id", "edit_mode", "cell_type"].forEach((k) => used.add(k));
    const where = [str(a.cell_id) ? `cell ${a.cell_id}` : "new cell", str(a.edit_mode) ? a.edit_mode : "replace", str(a.cell_type) ? a.cell_type : null].filter(Boolean).join(" · ");
    change = <><h5>{where}</h5><ClipNote clips={clips("new_source")} /><JsonBlock value={a.new_source} /></>;
  } else {
    return null;
  }
  const rest = Object.fromEntries(Object.entries(a).filter(([k]) => !used.has(k)));
  return (
    <>
      <h5>file</h5>
      <p className="sv-insp-path mono">{pathKey ? String(a[pathKey]) : "—"}</p>
      {change}
      {Object.keys(rest).length
        ? <><h5>other arguments</h5><ClipNote clips={clips(...Object.keys(rest))} /><JsonBlock value={rest} /></>
        : null}
    </>
  );
}

/**
 * The right column. Selecting a tool call, op or event fills this instead of
 * pushing a drawer, which is what kept costing the reader their scroll
 * position and forced a refetch of /turns/:id on the way back.
 */
export function Inspector({ sel, toolCalls, opRows, timeline, onClose, onArtifact }: {
  sel: Sel;
  toolCalls: ToolCall[];
  opRows: OpRow[] | null;
  timeline: any[];
  onClose: () => void;
  /** Opening an artifact is the one drill-down still worth leaving for. */
  onArtifact?: (id: string) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // Below the two-column breakpoint the inspector opens inline under the
  // picked row; a tall payload can still push its bottom off screen, so bring
  // it into view. In the sticky side column it is already visible. Read the
  // layout off the parent rather than repeating the breakpoint here; Esc or ×
  // hands focus back to the row.
  useEffect(() => {
    const el = ref.current;
    if (!sel || !el?.parentElement) return;
    if (getComputedStyle(el.parentElement).position === "sticky") return;
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [sel]);
  // The live region is the first child of both trees, so React keeps the one
  // node and a screen reader hears each new selection; focus stays on the row.
  if (!sel) {
    return (
      <div className="sv-insp sv-insp-empty" ref={ref} role="region" aria-label="inspector">
        <p className="sr-only" aria-live="polite" />
        <p className="muted">Select a tool call, an action or an event to inspect its payload here.</p>
      </div>
    );
  }
  let title = "";
  let body: React.ReactNode = null;
  // What the copy button takes: the whole payload, never the clipped view.
  let copy: unknown = null;

  if (sel.kind === "tool") {
    const c = toolCalls[sel.idx];
    const name = String(c?.name ?? "tool call");
    title = bareToolName(name);
    // The copy is only as whole as the record: say which strings were cut.
    copy = {
      name: c?.name, args: c?.args ?? {}, result: c?.resultDigest ?? null,
      ...(c?.argsClipped ? { argsClipped: c.argsClipped } : {}),
      ...(c?.status ? { status: c.status } : {}), ...(c?.error ? { error: c.error } : {}),
    };
    body = (
      <>
        {fileChange(name, c?.args, c?.argsClipped) ?? (
          <>
            <h5>arguments</h5>
            <ClipNote clips={storageClips(c?.args, c?.argsClipped)} />
            <JsonBlock value={c?.args ?? {}} />
          </>
        )}
        <h5>result</h5>
        {/* The runtime's own words for a failed call — a gate denial names the
            capability the seat lacks, which is the fix. */}
        {c?.error ? <p className="sv-tool-err">{c.error}</p> : null}
        {c?.resultDigest
          ? <JsonBlock value={c.resultDigest} />
          : c?.error ? null : <p className="muted">No result captured.</p>}
      </>
    );
  } else if (sel.kind === "op") {
    const r = opRows?.[sel.idx];
    title = r?.head.title ?? "action";
    // An uncaptured row's `op` is just its name; copying `{ op }` as "what
    // was written" would pass the name off as the arguments.
    copy = {
      ...(r?.uncaptured ? { kind: r.kind, written: null, argumentsCaptured: false } : { written: r?.op ?? {} }),
      ...(r?.clipped ? { argsClipped: r.clipped } : {}),
      effect: r?.fx ?? null,
      ...(r?.refusal ? { refusal: r.refusal } : {}),
    };
    body = (
      <>
        {r?.head.detail ? <Prose dim>{r.head.detail}</Prose> : null}
        <h5>written</h5>
        {r?.uncaptured
          ? (
            <p className="muted">
              Its arguments were not captured — the runtime keeps them for only a bounded number of a turn's tool
              calls, so the kernel's record below is all that survives of this one.
              {r.namedFromEffect ? " The title above is read from the event it landed, not from its arguments." : ""}
            </p>
          )
          : (
            <>
              <ClipNote clips={storageClips(r?.op, r?.clipped)} />
              <JsonBlock value={r?.op ?? {}} />
            </>
          )}
        <h5>landed effect</h5>
        {r?.refusal
          ? (
            <p className="sv-refused">
              The kernel refused this action{r.refusal.reason ? ": " : "."}
              {r.refusal.reason ? <b>{r.refusal.reason}</b> : null}
            </p>
          )
          : r?.fx === undefined
          ? <p className="muted">This action produces nothing observable in the event log.</p>
          : r?.fx
            ? (
              <>
                {r.guess
                  ? <p className="muted">{r.uncaptured
                      ? "Best guess: with its arguments not captured, nothing ties this action to one event over another of the same kind — it was paired by order."
                      : "Best guess: several actions of this kind compete for these events, and this one names no target the event carries."}</p>
                  : null}
                <JsonBlock value={{ seq: r.fx.seq, type: r.fx.type, at: r.fx.at, payload: r.fx.payload }} />
                {onArtifact && (r.fx.type === "artifact.created" || r.fx.type === "artifact.versioned") && r.fx.payload?.artifact?.id ? (
                  <Button variant="linklike" onClick={() => onArtifact(r.fx.payload.artifact.id)}>
                    open {r.fx.payload.artifact.name} v{r.fx.payload.artifact.version} →
                  </Button>
                ) : null}
              </>
            )
            : <p className="muted">{r?.guess
                ? "No effect was paired with this action. Fewer events than actions of this kind were found, so another of them may be the one that did not land."
                : "No matching effect was recorded for this action."}</p>}
      </>
    );
  } else {
    const e = timeline.find((x: any) => x.seq === sel.seq);
    title = e ? plainEvent(e.type, e.payload) : `event #${sel.seq}`;
    copy = e ? { seq: e.seq, type: e.type, at: e.at, actor: e.actor, payload: e.payload ?? {} } : null;
    body = e ? (
      <>
        <div className="sv-insp-meta mono">#{e.seq} · {e.type} · {hhmmss(e.at)} {zoneLabel()}{e.actor ? ` · ${e.actor}` : ""}</div>
        {e.summary ? <Prose dim>{e.summary}</Prose> : null}
        <h5>payload</h5>
        <JsonBlock value={e.payload ?? {}} />
      </>
    ) : <p className="muted">That event is no longer in the loaded window.</p>;
  }

  return (
    <div className="sv-insp" ref={ref} role="region" aria-label="inspector">
      <p className="sr-only" aria-live="polite">{`Inspecting ${title}`}</p>
      <div className="sv-insp-head">
        <h4>{title}</h4>
        <span className="sv-insp-tools">
          {copy != null ? <CopyBtn text={jsonText(copy)} /> : null}
          <Button variant="ghost" onClick={onClose} title="Clear selection (Esc)" aria-label="Clear selection">×</Button>
        </span>
      </div>
      <div className="sv-insp-body">{body}</div>
    </div>
  );
}
