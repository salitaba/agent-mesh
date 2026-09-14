import React, { useMemo, useState } from "react";
import { CopyBtn } from "./stepdetail";

/**
 * A payload viewer, not a JSON pretty-printer.
 *
 * What this replaces was `JSON.stringify(payload, null, 2).slice(0, 3000)`
 * inside a `<details>`. Three things were wrong with it and all three bit at
 * once on exactly the payloads worth reading: depth was invisible, so a nested
 * plan looked the same as a flat one; the 3000-char cut landed mid-token with
 * no indication that anything had been dropped; and copying gave you the
 * truncated text rather than the payload.
 *
 * So: containers collapse, long strings expand in place, and copy always copies
 * the whole value regardless of what is on screen.
 */

type Json = unknown;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isContainer = (v: unknown): boolean => Array.isArray(v) || isObj(v);

/** A container this size or smaller opens on its own; bigger ones wait to be asked. */
const AUTO_ROWS = 12;
/** Below this depth containers auto-open; at or past it they start shut however small. */
const AUTO_DEPTH = 2;
/** Strings longer than this collapse to one line with a character count. */
const LONG_STRING = 140;

function entriesOf(v: Json): [string, Json][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x] as [string, Json]);
  if (isObj(v)) return Object.entries(v);
  return [];
}

/* ------------------------------ scalars -------------------------------- */

function StringValue({ s }: { s: string }): React.JSX.Element {
  const long = s.length > LONG_STRING || s.includes("\n");
  const [open, setOpen] = useState(false);
  if (!long) return <span className="jt-str">{s}</span>;
  if (!open) {
    return (
      <button type="button" className="jt-peek" onClick={() => setOpen(true)} title="Show the whole value">
        <span className="jt-str">{s.slice(0, LONG_STRING).replace(/\s+/g, " ")}</span>
        <span className="jt-count">… {s.length.toLocaleString()} chars</span>
      </button>
    );
  }
  return (
    <span className="jt-full">
      {/* A pre, not a span: payload strings here are diffs, prompts and stack
          traces, and collapsing their whitespace is what made them unreadable. */}
      <pre className="jt-block">{s}</pre>
      <button type="button" className="jt-peek" onClick={() => setOpen(false)}>show less</button>
    </span>
  );
}

function Scalar({ v }: { v: Json }): React.JSX.Element {
  if (v === null) return <span className="jt-null">null</span>;
  if (v === undefined) return <span className="jt-null">—</span>;
  if (typeof v === "string") return <StringValue s={v} />;
  if (typeof v === "number") return <span className="jt-num">{Number.isFinite(v) ? String(v) : "not a number"}</span>;
  if (typeof v === "boolean") return <span className="jt-bool">{String(v)}</span>;
  return <span className="jt-str">{String(v)}</span>;
}

/* ----------------------------- containers ------------------------------ */

/** What a shut container says about itself. Enough to decide whether to open it. */
function preview(v: Json, kids: [string, Json][]): string {
  if (Array.isArray(v)) return kids.length === 1 ? "1 item" : `${kids.length} items`;
  const names = kids.slice(0, 3).map(([k]) => k).join(", ");
  const more = kids.length > 3 ? `, +${kids.length - 3}` : "";
  return `${names}${more}`;
}

function Node({ label, value, depth }: { label: string; value: Json; depth: number }): React.JSX.Element {
  const kids = useMemo(() => entriesOf(value), [value]);
  const container = isContainer(value);
  const [open, setOpen] = useState(() => depth < AUTO_DEPTH && kids.length <= AUTO_ROWS);

  if (!container) {
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 12 }}>
        <span className="jt-key">{label}</span>
        <Scalar v={value} />
      </div>
    );
  }

  if (!kids.length) {
    return (
      <div className="jt-row" style={{ paddingLeft: depth * 12 }}>
        <span className="jt-key">{label}</span>
        <span className="jt-empty">{Array.isArray(value) ? "empty list" : "empty"}</span>
      </div>
    );
  }

  return (
    <div className="jt-node">
      <button
        type="button"
        className="jt-row jt-toggle"
        style={{ paddingLeft: depth * 12 }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="jt-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="jt-key">{label}</span>
        {open ? null : <span className="jt-count">{preview(value, kids)}</span>}
      </button>
      {open ? kids.map(([k, v]) => <Node key={k} label={k} value={v} depth={depth + 1} />) : null}
    </div>
  );
}

/* ------------------------------- root ---------------------------------- */

export function JsonTree({ value, label = "Payload" }: { value: Json; label?: string }): React.JSX.Element {
  const [raw, setRaw] = useState(false);
  // Stringified once for copy and for the raw pane, not per render of either.
  // `catch` covers a payload with a cycle in it; the tree above renders those
  // fine, so the raw toggle failing is not a reason to lose the whole section.
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      return "(this payload cannot be serialised — use the tree above)";
    }
  }, [value]);

  const kids = entriesOf(value);
  const empty = !isContainer(value) ? value === undefined || value === null : !kids.length;

  return (
    <section className="jt">
      <header className="jt-head">
        <h4>{label}</h4>
        <span className="jt-actions">
          <button type="button" className="fchip" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
            {raw ? "tree" : "raw"}
          </button>
          <CopyBtn text={text} />
        </span>
      </header>
      {empty ? (
        <div className="jt-empty jt-none">no payload</div>
      ) : raw ? (
        <pre className="jt-block jt-raw">{text}</pre>
      ) : isContainer(value) ? (
        <div className="jt-body">{kids.map(([k, v]) => <Node key={k} label={k} value={v} depth={0} />)}</div>
      ) : (
        <div className="jt-body"><div className="jt-row"><Scalar v={value} /></div></div>
      )}
    </section>
  );
}
