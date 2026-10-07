import { cloneElement, useId } from "react";
import type { InputHTMLAttributes, ReactElement, ReactNode } from "react";
import { Icon } from "../icons";

/**
 * Checkbox, Radio and Switch: a native input drawn by the stylesheet (styles.css "Checkbox, radio and switch"), inside a label
 * that is the hit area, so the whole row is pressed and the control is still the one that is focused and read. The label says what
 * turning it on does; the hint under it, when there is one, says what it costs or when it applies.
 *
 * States: unchecked, checked, hover, focus-visible (a ring), disabled (half), invalid (`aria-invalid`), and for a Checkbox
 * `indeterminate` (set it on the element: it is a property, not an attribute). 24px tall, 44 on a phone.
 */
type ChoiceProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className" | "children"> & { label: ReactNode; hint?: ReactNode };

function Choice({ kind, label, hint, ...rest }: ChoiceProps & { kind: "checkbox" | "radio" | "switch" }): React.JSX.Element {
  return (
    <label className={`chk${hint ? " has-hint" : ""}`}>
      <input type={kind === "radio" ? "radio" : "checkbox"} role={kind === "switch" ? "switch" : undefined} {...rest} />
      <span>{label}{hint ? <small className="chk-hint">{hint}</small> : null}</span>
    </label>
  );
}
export function Checkbox(props: ChoiceProps): React.JSX.Element { return <Choice kind="checkbox" {...props} />; }
export function Radio(props: ChoiceProps): React.JSX.Element { return <Choice kind="radio" {...props} />; }
export function Switch(props: ChoiceProps): React.JSX.Element { return <Choice kind="switch" {...props} />; }

/**
 * A control with its label above, its hint below, and, when it is wrong, the sentence that says what to do about it. It wires
 * the three together for assistive technology (`htmlFor`, `aria-describedby`, `aria-invalid`) so a call site cannot forget one:
 * pass the Input, Select or TextArea as the child and do not give it an id of its own.
 */
export function Field({ label, hint, error, children }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }> }): React.JSX.Element {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const described = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, { id, "aria-describedby": described, "aria-invalid": error ? true : undefined })}
      {hint ? <span className="hint" id={hintId}>{hint}</span> : null}
      {error ? <span className="err" id={errId} role="alert"><Icon name="alert" size={14} />{error}</span> : null}
    </div>
  );
}
