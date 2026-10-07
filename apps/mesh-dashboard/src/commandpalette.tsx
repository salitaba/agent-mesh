import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Kbd } from "./components";
import { Icon, type IconName } from "./icons";
import { list, subscribe, getVersion, type Command } from "./commands";
import { paletteMatches, pointerMoved } from "./palette";
import { groupCommands, paletteOrder } from "./palette-groups";

/** What a command looks like in the palette: where it is listed when nothing has been typed, its icon, and the key that does the same. */
export interface PaletteLook { group: string; icon: IconName; hint?: string }

/** ⌘K/Ctrl+K palette. Lists whatever `commands.ts` holds right now, so the
 *  Designer's commands appear only while it is mounted. The input keeps the
 *  focus (Tab is trapped) and the shell owns Escape for everything that routes
 *  through handleKey, so one dispatch order closes palette → focus → panel.
 *  The exception is any overlay built on useDismissable (the Designer's checks
 *  popover): it listens on document in the CAPTURE phase and stops Escape
 *  before the shell's window listener sees it. That is deliberate — the
 *  innermost open layer should claim the key.
 *
 *  Nothing typed: the rows are grouped (where to go, which agent, what to do). Typed: one list, best match first (palette.ts),
 *  because a group header must not push the answer down. Either way the keyboard walks the rows in the order they are drawn. */
export function CommandPalette({ onClose, look, groups, autoFocus = true }: { onClose: () => void; look: (c: Command) => PaletteLook; groups: readonly string[]; autoFocus?: boolean }): React.JSX.Element {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Re-list when a scope registers/unregisters: a view can unmount while the
  // palette is open (browser Back), and its commands must vanish with it.
  // Re-render on every registry change; `list()` is a cheap pure read of the
  // module registry, so the snapshot is taken directly at render time.
  useSyncExternalStore(subscribe, getVersion);
  const ranked = paletteMatches(list(), q);
  const grouped = q.trim() === "";
  const matches = grouped ? paletteOrder(ranked, (c) => look(c).group, groups) : ranked;
  const active = Math.min(sel, Math.max(0, matches.length - 1));
  const activeId = matches[active]?.id;
  // Where the mouse was last seen over the list: a row takes the selection only when the mouse has moved (palette.ts).
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const choose = (c: Command | undefined): void => {
    if (!c) return;
    onClose();
    c.run();
  };
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);
  // Keyed on the selection and the query, not the list: the registry is rebuilt on every status poll, and scrolling on each one
  // pulled a list the person had scrolled with the wheel back to the selected row every few seconds.
  useEffect(() => {
    if (activeId) document.getElementById(`palette-opt-${activeId}`)?.scrollIntoView({ block: "nearest" });
  }, [activeId, q]);
  const onKey = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Tab") {
      e.preventDefault();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(matches[active]);
    }
  };
  const row = (c: Command): React.JSX.Element => {
    const i = matches.indexOf(c);
    const l = look(c);
    return (
      <li key={c.id} id={`palette-opt-${c.id}`} role="option" aria-selected={i === active}
        className={`palette-item${i === active ? " on" : ""}`}
        onMouseMove={(e) => {
          const at = { x: e.clientX, y: e.clientY };
          if (pointerMoved(pointer.current, at)) setSel(i);
          pointer.current = at;
        }}
        onClick={() => choose(c)}>
        <Icon name={l.icon} size={18} />
        <span className="palette-label">{c.label}</span>
        {c.scope !== "global" ? <span className="palette-scope">{c.scope}</span> : null}
        {l.hint ? <span className="palette-hint"><Kbd>{l.hint}</Kbd></span> : null}
      </li>
    );
  };
  return (
    <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette"
      onMouseDown={(e) => { if (!(e.target instanceof HTMLInputElement)) e.preventDefault(); }}>
      <div className="palette-search">
        <Icon name="search" size={18} />
        <input ref={inputRef} className="palette-input" role="combobox" aria-label="Search commands" aria-autocomplete="list"
          aria-expanded="true" aria-controls="palette-list"
          aria-activedescendant={activeId ? `palette-opt-${activeId}` : undefined}
          placeholder="Type a command or agent…" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }} onKeyDown={onKey} />
      </div>
      <ul id="palette-list" className="palette-list" role="listbox" aria-label="commands">
        {grouped
          ? groupCommands(matches, (c) => look(c).group, groups).flatMap((g) => [
              <li key={`g-${g.label}`} role="presentation" className="palette-group">{g.label}</li>,
              ...g.items.map(row),
            ])
          : matches.map(row)}
        {!matches.length ? <li role="presentation" className="palette-none">No matching commands. Try the name of a page, an agent or an action.</li> : null}
      </ul>
      <div className="palette-foot" aria-hidden="true">
        <span><Kbd keys="up" /><Kbd keys="down" /> navigate</span>
        <span><Kbd keys="enter" /> run</span>
        <span><Kbd keys="esc" /> close</span>
      </div>
    </div>
  );
}

