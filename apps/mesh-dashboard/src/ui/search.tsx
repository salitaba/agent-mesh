import type { InputHTMLAttributes } from "react";
import { Icon } from "../icons";
import { Kbd } from "./kbd";

/**
 * A search box: the console's text field with a magnifier at its start, the key that focuses it at its end while it is empty, and a
 * button that empties it once it is not. It is one control for a screen reader (a search field, named by `label`); the magnifier and
 * the key are drawn, not read. `hint` is the key as a person would press it ("/"), shown only while the field is empty and unfocused.
 * Give it the `id` the page's key handler looks for. States: default, hover, focus (the field's own ring), filled (the clear button).
 */
export function SearchField({ label, hint, onClear, extra, value, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "type" | "aria-label"> & {
  label: string; hint?: string; onClear: () => void; extra?: string; value: string;
}): React.JSX.Element {
  return (
    <span className={`srch${value ? " filled" : ""}${extra ? ` ${extra}` : ""}`}>
      <Icon name="search" size={16} />
      <input className="search" type="search" aria-label={label} value={value} autoComplete="off" spellCheck={false} {...rest} />
      {value ? (
        <button type="button" className="srch-clear" aria-label="Clear the search" onClick={onClear}><Icon name="x" size={14} /></button>
      ) : hint ? <span className="srch-hint" aria-hidden="true"><Kbd>{hint}</Kbd></span> : null}
    </span>
  );
}
