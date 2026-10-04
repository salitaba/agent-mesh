import "./overview.css";

/**
 * A labelled progress bar: how much of something is used. Tone is the only decision a caller makes, and it says whether the
 * figure is fine (default), worth a look (`warn`), a fault (`bad`) or complete (`ok`). The label is the accessible name; the
 * figure beside it says the same thing in words, so the bar is never the only signal.
 */
export function Bar({ value, max, label, tone }: { value: number; max: number; label: string; tone?: "ok" | "warn" | "bad" }): React.JSX.Element {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className={`ov-bar${tone ? ` ${tone}` : ""}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)} style={{ "--p": ratio } as React.CSSProperties}>
      <i />
    </div>
  );
}
