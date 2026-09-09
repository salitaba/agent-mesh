/* Small shared inputs + color identity helpers for the Mesh Studio. */

import { CSSProperties, useState } from "react";
import { Button, Input } from "../components";

/* ---------------- per-agent identity color ---------------- */

/* Hue palette used by crew rows, avatars and canvas nodes so a name reads the
 * same everywhere. Blue first — the default when nothing matches. */
const HUES = [222, 265, 178, 38, 332, 152, 198, 288, 16, 255, 110, 336];

export function hueFor(id: string): number {
  let s = 0;
  for (let i = 0; i < id.length; i++) s = (s * 31 + id.charCodeAt(i)) >>> 0;
  return HUES[s % HUES.length];
}

export function hueVar(id: string): CSSProperties {
  return { ["--h" as any]: hueFor(id) } as CSSProperties;
}

/* ---------------- form primitives ---------------- */

export function Field({ label, children, span, hint }: { label: string; children: React.ReactNode; span?: boolean; hint?: string }): React.JSX.Element {
  return (
    <div className={`field${span ? " ms-span" : ""}`}>
      <label>{label}</label>
      {children}
      {hint ? <span className="ms-hint">{hint}</span> : null}
    </div>
  );
}

export function Num({ label, value, onSet, step, hint, span }: { label: string; value: any; onSet: (n: number | null) => void; step?: number; hint?: string; span?: boolean }): React.JSX.Element {
  return (
    <Field label={label} span={span} hint={hint && value == null ? hint : undefined}>
      <Input type="number" step={step ?? 1} value={value ?? ""} placeholder={hint || "default"} onChange={(e) => {
        const raw = e.target.value;
        onSet(raw === "" ? null : Number(raw));
      }} />
    </Field>
  );
}

export function ChipPick({ options, values, onToggle }: { options: string[]; values: string[]; onToggle: (v: string) => void }): React.JSX.Element {
  return (
    <div className="chips">
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
        <button key={c} type="button" aria-pressed className="chip-toggle on custom" title="click to remove" onClick={() => onRemove(c)}>{c} ×</button>
      ))}
    </div>
  );
}

/** Comma-text → set toggle with an add button. */
export function CommaAdder({ placeholder, onAdd }: { placeholder: string; onAdd: (v: string) => void }): React.JSX.Element {
  const [v, setV] = useState("");
  return (
    <div className="row">
      <Input style={{ flex: 1 }} placeholder={placeholder} value={v} onChange={(e) => setV(e.target.value)} />
      <Button variant="small" disabled={!v.trim()} onClick={() => { onAdd(v.trim()); setV(""); }}>add</Button>
    </div>
  );
}
