import type { ReactNode } from "react";
import "./overview.css";

/**
 * A headed section. The heading names it and the actions sit beside the heading rather than inside it: `Card` puts them in the
 * <h3>, where a screen reader reads "All steps" as part of the section's name.
 */
export function Panel({ id, title, meta, actions, className, children }: {
  id: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode;
}): React.JSX.Element {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-labelledby={`${id}-h`}>
      <div className="panel-head">
        <h3 id={`${id}-h`}>{title}</h3>
        {meta ? <span className="panel-meta">{meta}</span> : null}
        {actions ? <div className="panel-acts">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
