/* Small shared inputs and buttons for the Designer. */

import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from "react";
import { Button, Input, Select, TextArea } from "../components";
import { Icon, type IconName } from "../icons";
import { shortPath } from "./save";
import type { Reveal } from "./types";

/* ---------------- form primitives ---------------- */

/**
 * Visible label form row. The label is tied to the wrapped control through
 * htmlFor/useId (or the control's own id when it already has one); a control
 * that cannot take an id (e.g. an error state) is left alone.
 *
 * `name` marks the control for the validation jump (`data-field`): a message that points at
 * the role of a seat lands focus on the role input, not on the top of the panel.
 */
const ID_CONTROLS = new Set<unknown>([Input, TextArea, Select]);

export function Field({ label, children, span, hint, error, id: idProp, name }: { label: string; children: React.ReactNode; span?: boolean; hint?: string; error?: string; id?: string; name?: string }): React.JSX.Element {
  const autoId = useId();
  const noteId = useId();
  const child = isValidElement<{ id?: string; "aria-describedby"?: string }>(children) ? children : null;
  const acceptsId = child !== null && (typeof child.type === "string" || ID_CONTROLS.has(child.type));
  const childId = acceptsId ? child.props.id : undefined;
  const id = idProp ?? childId ?? autoId;
  const note = error ?? hint;
  const extra: Record<string, string | boolean> = {};
  if (!childId) extra.id = id;
  if (name) extra["data-field"] = name;
  if (note && !child?.props["aria-describedby"]) extra["aria-describedby"] = noteId;
  if (error) extra["aria-invalid"] = true;
  const control = child !== null && acceptsId && Object.keys(extra).length ? cloneElement(child, extra) : children;
  return (
    <div className={`field${span ? " ms-span" : ""}`}>
      <label htmlFor={acceptsId ? id : undefined}>{label}</label>
      {control}
      {note ? <span className={`ms-hint${error ? " bad" : ""}`} id={noteId} role={error ? "alert" : undefined}>{note}</span> : null}
    </div>
  );
}

export function Num({ label, value, onSet, step, hint, span, name }: { label: string; value: any; onSet: (n: number | null) => void; step?: number; hint?: string; span?: boolean; name?: string }): React.JSX.Element {
  return (
    <Field label={label} span={span} name={name} hint={hint && value == null ? hint : undefined}>
      <Input type="number" step={step ?? 1} value={value ?? ""} placeholder={hint || "default"} onChange={(e) => {
        const raw = e.target.value;
        onSet(raw === "" ? null : Number(raw));
      }} />
    </Field>
  );
}

export function ChipPick({ options, values, onToggle, label }: { options: string[]; values: string[]; onToggle: (v: string) => void; label?: string }): React.JSX.Element {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((c) => {
        const on = values.includes(c);
        return <button key={c} type="button" aria-pressed={on} className={`chip-toggle ${on ? "on" : ""}`} onClick={() => onToggle(c)}>{c}</button>;
      })}
    </div>
  );
}

/** Inline list of removable chips for custom values (capabilities & co). */
export function CustomChips({ values, onRemove }: { values: string[]; onRemove: (v: string) => void }): React.JSX.Element | null {
  if (!values.length) return null;
  return (
    <div className="chips">
      {values.map((c) => (
        <button key={c} type="button" aria-label={`Remove ${c}`} className="chip-toggle on custom" title="Remove" onClick={() => onRemove(c)}>{c}<Icon name="x" size={12} /></button>
      ))}
    </div>
  );
}

/** Comma-text to set toggle with an add button. */
export function CommaAdder({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState("");
  const add = (): void => {
    if (!v.trim()) return;
    onAdd(v.trim());
    setV("");
  };
  return (
    <div className="row ms-adder">
      <Input aria-label={placeholder} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }} />
      <Button variant="small" icon="plus" disabled={!v.trim()} onClick={add}>Add</Button>
    </div>
  );
}

/* ---------------- sections ---------------- */

/** Which sections are open, kept at module scope so a tab switch (which unmounts the panel) does not close what the person opened. */
const OPEN = new Map<string, boolean>();

/**
 * A collapsible part of the inspector. `reveal` is the validation jump: a request naming this section opens it, scrolls to the control
 * the message is about and puts focus there, so "Open pm: Tools" lands on the tools and not on the top of a long form.
 */
export function Section({ id, title, meta, defaultOpen = true, reveal, children }: {
  id: string; title: string; meta?: React.ReactNode; defaultOpen?: boolean; reveal?: Reveal | null; children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(() => OPEN.get(id) ?? defaultOpen);
  const ref = useRef<HTMLDetailsElement | null>(null);
  const mine = reveal?.section === id;
  const nonce = reveal?.nonce;
  const field = reveal?.field;
  const select = reveal?.select;
  useEffect(() => {
    if (!mine) return;
    OPEN.set(id, true);
    setOpen(true);
    // The body is not laid out until the section has opened, so the move waits a frame.
    const frame = requestAnimationFrame(() => {
      const root = ref.current;
      if (!root) return;
      const FOCUSABLE = "input:not([type=hidden]), select, textarea, button";
      const named = field ? [...root.querySelectorAll<HTMLElement>("[data-field]")].find((e) => e.dataset.field === field) : undefined;
      // A chip list or a grid is marked as a whole; focus goes to the first control inside it.
      const target = named ? (named.matches(FOCUSABLE) ? named : named.querySelector<HTMLElement>(FOCUSABLE) ?? named) : root.querySelector<HTMLElement>(FOCUSABLE);
      target?.scrollIntoView({ block: "center", behavior: "auto" });
      target?.focus({ preventScroll: true });
      if (select && target instanceof HTMLInputElement && /^(text|search|)$/.test(target.type)) target.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [mine, nonce, id, field, select]);
  return (
    <details
      id={`ins-sec-${id}`} ref={ref} className="ms-sec" open={open}
      onToggle={(e) => { const next = e.currentTarget.open; OPEN.set(id, next); setOpen(next); }}
    >
      <summary><span className="ms-sec-title">{title}</span>{meta != null && meta !== "" ? <span className="ms-sec-meta">{meta}</span> : null}</summary>
      <div className="ms-sec-body">{children}</div>
    </details>
  );
}

/* ---------------- authority ---------------- */

const PLAIN_VERB: Record<string, string> = { approve: "approve", reject: "reject", accept: "accept", block: "block", veto: "veto", pass: "pass" };

/**
 * Authority as a grid of switches over the protocol's own catalogue (six domains by six verbs), instead of a text box.
 * A token typed by hand that is not in the catalogue parses, validates and then grants nothing, with no symptom but a mission that
 * will not converge; here it cannot be typed, and a token already in the file that is not in the catalogue is shown as one, with a way out.
 */
export function AuthorityGrid({ values, known, domains, verbs, onToggle, onRemove }: {
  values: string[]; known: string[]; domains: readonly string[]; verbs: readonly string[]; onToggle: (token: string) => void; onRemove: (token: string) => void;
}): React.JSX.Element {
  const shown = verbs;
  const inGrid = new Set(domains.flatMap((d) => shown.map((v) => `${d}.${v}`)));
  // Held but not a switch in the grid: the wildcard forms, which the runtime knows, and anything it does not.
  const extras = values.filter((v) => !inGrid.has(v));
  const unknown = extras.filter((v) => !known.includes(v));
  const wildcards = extras.filter((v) => known.includes(v));
  return (
    <div className="ms-auth">
      <table>
        <caption className="sr-only">Authority: what this seat may decide alone. A gate that requires an approval waits for a seat that holds it.</caption>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Domain</span></th>
            {shown.map((v) => <th scope="col" key={v}>{PLAIN_VERB[v] ?? v}</th>)}
          </tr>
        </thead>
        <tbody>
          {domains.map((d) => (
            <tr key={d}>
              <th scope="row">{d}</th>
              {shown.map((v) => {
                const token = `${d}.${v}`;
                const on = values.includes(token);
                return (
                  <td key={v}>
                    <input type="checkbox" checked={on} aria-label={`${d} ${v}`} title={token} onChange={() => onToggle(token)} />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {wildcards.length ? (
        <div className="ms-auth-extra">
          <span className="ms-hint">Also holds, as a wildcard:</span>
          <div className="chips">
            {wildcards.map((t) => (
              <button key={t} type="button" className="chip-toggle on" aria-label={`Remove ${t}`} title="Remove" onClick={() => onRemove(t)}>{t}<Icon name="x" size={12} /></button>
            ))}
          </div>
        </div>
      ) : null}
      {unknown.length ? (
        <div className="ms-auth-extra">
          <span className="ms-hint">The runtime does not know these, so they grant nothing:</span>
          <div className="chips">
            {unknown.map((t) => (
              <button key={t} type="button" className="chip-toggle bad" aria-label={`Remove ${t}`} title="Remove" onClick={() => onRemove(t)}>{t}<Icon name="x" size={12} /></button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------------- buttons ---------------- */

/**
 * A toolbar button: an icon with a visible label (`text`) or alone, named by `label`. It is the Designer's own
 * shape because the shared IconButton is 36px square and stretches in a flex row.
 */
export function ToolButton({ icon, label, onClick, disabled, pressed, title, text, id, expanded, controls, haspopup }: {
  icon: IconName; label: string; onClick?: () => void; disabled?: boolean; pressed?: boolean; title?: string; text?: boolean; id?: string;
  expanded?: boolean; controls?: string; haspopup?: "dialog" | "menu";
}): React.JSX.Element {
  return (
    <button
      type="button" id={id} className={`ms-tool${text ? " has-text" : ""}`}
      aria-label={text ? undefined : label} aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} aria-haspopup={haspopup}
      title={title ?? label} disabled={disabled} onClick={onClick}
    >
      <Icon name={icon} size={16} />
      {text ? <span>{label}</span> : null}
    </button>
  );
}

/** The close button every panel in the Designer carries: a real target, named for what it closes. */
export function CloseButton({ label, onClick }: { label: string; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" className="ms-close" aria-label={label} title={label} onClick={onClick}>
      <Icon name="x" size={16} />
    </button>
  );
}

/** A file path that has to fit: the folder is cut from the left and the file name never is. The whole path is the tooltip. */
export function PathLabel({ path, className }: { path: string; className?: string }): React.JSX.Element {
  const { dir, file } = shortPath(path);
  return (
    <span className={`ms-path${className ? ` ${className}` : ""}`} title={path}>
      <Icon name="files" size={14} />
      <span className="ms-path-text"><span className="ms-path-dir">{dir}</span><b>{file}</b></span>
    </span>
  );
}
