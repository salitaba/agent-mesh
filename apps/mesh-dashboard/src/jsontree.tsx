import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CopyButton } from "./components";
import { Icon } from "./icons";
import { defaultOpen, isContainer, jsonString, morePage, navigate, scalarText, toggled, treeRows, type TreeRow } from "./jsonrows";

/**
 * A payload you can read and walk with the keyboard.
 *
 * The rows come from jsonrows.ts (tested). This draws them as the WAI-ARIA tree pattern: one tab stop for the whole tree, Up and
 * Down to walk, Right and Left to open and close or step in and out, Enter to open a long string or draw more of a long list.
 * Before, every container was a tab stop of its own, so a payload with thirty branches was thirty presses of Tab.
 */

type View = "tree" | "raw";

/** The row's own text, set apart from its key. A collapsed container reads as a summary; a long string says how long it is. */
function Value({ r }: { r: TreeRow }): React.JSX.Element | null {
  if (r.kind === "more") return <span className="jt-more">{r.text}</span>;
  if (r.kind === "object" || r.kind === "array") return r.text ? <span className={`jt-val ${r.expandable ? "jt-count" : "jt-empty"}`}>{r.text}</span> : null;
  return (
    <>
      <span className={`jt-val jt-${r.kind}`}>{r.text}</span>
      {r.kind === "string" && r.expandable && !r.expanded ? <span className="jt-count">{r.size.toLocaleString("en-US")} characters</span> : null}
    </>
  );
}

export function JsonTree({ value, label = "Payload" }: { value: unknown; label?: string }): React.JSX.Element {
  const [view, setView] = useState<View>("tree");
  const [open, setOpen] = useState<ReadonlySet<string>>(() => defaultOpen(value));
  const [limits, setLimits] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [active, setActive] = useState<string | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const focusAfter = useRef<string | null>(null);

  const rows = useMemo(() => treeRows(value, open, limits), [value, open, limits]);
  // Stringified once, for the raw view and for copy: not per render of either.
  const text = useMemo(() => jsonString(value), [value]);
  const stop = active !== null && rows.some((r) => r.id === active) ? active : rows[0]?.id ?? null;

  const focusRow = useCallback((id: string): void => {
    const el = Array.from(root.current?.querySelectorAll<HTMLElement>("[data-tid]") ?? []).find((n) => n.dataset.tid === id);
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
    }
  }, []);
  // A row that was drawn by this very key press (a new page) cannot be focused until it exists.
  useEffect(() => {
    if (focusAfter.current) {
      focusRow(focusAfter.current);
      focusAfter.current = null;
    }
  });

  const activate = (id: string): void => {
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    if (r.kind === "more") {
      const i = rows.indexOf(r);
      const next = morePage(rows, id, limits);
      if (next) setLimits(next);
      // The row before it is still there afterwards; the "show more" row may not be.
      focusAfter.current = rows[i - 1]?.id ?? null;
      return;
    }
    if (r.expandable) setOpen((o) => toggled(o, id));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const current = (e.target as HTMLElement).closest<HTMLElement>("[data-tid]")?.dataset.tid ?? null;
    const r = navigate(rows, current, e.key);
    if (!r) return;
    e.preventDefault();
    if (r.focus) focusRow(r.focus);
    if (r.expand) setOpen((o) => new Set(o).add(r.expand!));
    if (r.collapse) setOpen((o) => toggled(o, r.collapse!));
    if (r.activate) activate(r.activate);
  };

  const empty = isContainer(value) ? rows.length === 0 : value === undefined || value === null;

  return (
    <section className="jt" aria-label={label}>
      <header className="jt-head">
        <h4>{label}</h4>
        <span className="jt-actions">
          <span className="seg" role="group" aria-label={`${label} view`}>
            <button type="button" aria-pressed={view === "tree"} onClick={() => setView("tree")}>Tree</button>
            <button type="button" aria-pressed={view === "raw"} onClick={() => setView("raw")}>Raw</button>
          </span>
          <CopyButton text={text} what={label.toLowerCase()} />
        </span>
      </header>
      {empty ? (
        <p className="jt-none">No payload.</p>
      ) : view === "raw" ? (
        <pre className="jt-block jt-raw" tabIndex={0}>{text}</pre>
      ) : !isContainer(value) ? (
        <div className="jt-body"><div className="jt-row"><span className={`jt-val jt-${typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string"}`}>{scalarText(value)}</span></div></div>
      ) : (
        <div className="jt-body" role="tree" aria-label={label} ref={root} onKeyDown={onKeyDown}>
          {rows.map((r) => (
            <div
              key={r.id}
              role="treeitem"
              aria-level={r.depth}
              aria-posinset={r.posInSet}
              aria-setsize={r.setSize}
              aria-expanded={r.expandable ? r.expanded : undefined}
              tabIndex={r.id === stop ? 0 : -1}
              data-tid={r.id}
              data-depth={Math.min(r.depth, 8)}
              className={`jt-row${r.expandable || r.kind === "more" ? " can" : ""}`}
              onFocus={() => setActive(r.id)}
              onClick={() => activate(r.id)}
            >
              <span className="jt-caret" aria-hidden="true">{r.expandable ? <Icon name="chevron-right" size={12} className={r.expanded ? "caret turned" : "caret"} /> : null}</span>
              {r.label ? <span className="jt-key">{r.label}</span> : null}
              <Value r={r} />
              {r.expanded && r.full !== undefined ? <pre className="jt-block">{r.full}</pre> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
