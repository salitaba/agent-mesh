import type { ReactNode } from "react";

/**
 * A labelled figure: the label in small capitals, the figure in the sans at 650 and tabular, what it is out of (`unit`: "of 2.0M") in
 * the quiet ink beside it, `sub` the line of detail under it, and `children` (a Progress) between them. `size` is `lg` (30) or `sm`
 * (16); `tone` colours the figure when the figure itself is the news (a count over its limit). Several in a row are `.stats`.
 * The same classes (.stat, .stat-k, .stat-v) can sit on a dt and a dd where the markup is a definition list.
 */
export function Stat({ label, value, unit, sub, size, tone, children }: {
  label: ReactNode; value: ReactNode; unit?: ReactNode; sub?: ReactNode; size?: "sm" | "lg"; tone?: "ok" | "warn" | "bad"; children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`stat${size ? ` ${size}` : ""}${tone ? ` ${tone}` : ""}`}>
      <span className="stat-k">{label}</span>
      <b className="stat-v">{value}{unit ? <span className="stat-u"> {unit}</span> : null}</b>
      {children}
      {sub ? <span className="stat-s">{sub}</span> : null}
    </div>
  );
}
