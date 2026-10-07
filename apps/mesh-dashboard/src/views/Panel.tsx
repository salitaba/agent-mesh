import type { ReactNode } from "react";
import "./overview.css";

/**
 * A headed section: the card's header pattern (styles.css "surfaces") with a hairline under it, and a region the heading names. The
 * actions sit beside the heading, not inside it, so a screen reader does not read "All steps" as part of the section's name.
 */
export function Panel({ id, title, meta, actions, className, children }: {
  id: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode;
}): React.JSX.Element {
  return (
    <section className={`card${className ? ` ${className}` : ""}`} aria-labelledby={`${id}-h`}>
      <div className="card-head ruled">
        <h3 id={`${id}-h`}>{title}</h3>
        {meta ? <span className="card-meta">{meta}</span> : null}
        {actions ? <div className="card-acts">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
