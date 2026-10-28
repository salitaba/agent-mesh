import type { ReactNode } from "react";
import { Button } from "../components";
import "./overview.css";

/**
 * A panel that folds on a phone: the section's title, one figure, and Show or Hide in the head row; the body is `hidden` while
 * it is closed, so a screen reader is not read a section it cannot see. The state lives in the page (Overview), so the four rows
 * stay one answer.
 */
export interface Fold {
  open: boolean;
  onToggle: () => void;
  /** One line that says what is inside while it is closed: "9 files", "7 of 7 evidenced". */
  summary: ReactNode;
}

/**
 * A headed section: the card's header pattern (styles.css "surfaces") with a hairline under it, and a region the heading names. The
 * actions sit beside the heading, not inside it, so a screen reader does not read "All steps" as part of the section's name.
 *
 * With `fold` the head carries a Show/Hide control, the body is closed until it says otherwise, and the long `meta` gives way to
 * the one-figure `summary`: a phone can read the section's name and its count in one 44 px row. The desk shape is unchanged.
 *
 * The control is named by the section it opens: four controls reading "Show" one under the other say nothing about what each one
 * opens, and the heading beside them is not part of the name a button is announced with.
 */
export function Panel({ id, title, meta, actions, className, fold, children }: {
  id: string; title: ReactNode; meta?: ReactNode; actions?: ReactNode; className?: string; fold?: Fold; children?: ReactNode;
}): React.JSX.Element {
  // The id is the anchor the Overview's jump row lands on; tabIndex makes the landing take focus, so a keyboard user
  // continues inside the section rather than back at the top of the page. It is not a tab stop.
  const bodyId = `${id}-body`;
  const closed = fold !== undefined && !fold.open;
  // The title is a string on every fold in the console; a node is left to name itself rather than becoming "[object Object]".
  const named = typeof title === "string" ? `${title}: ${fold?.open ? "Hide" : "Show"}` : undefined;
  return (
    <section id={id} tabIndex={-1} className={`card${className ? ` ${className}` : ""}${closed ? " closed" : ""}`} aria-labelledby={`${id}-h`}>
      <div className="card-head ruled">
        <h3 id={`${id}-h`}>{title}</h3>
        {closed ? <span className="card-meta card-fold-sum">{fold.summary}</span> : meta ? <span className="card-meta">{meta}</span> : null}
        {fold || actions ? (
          <div className="card-acts">
            {closed ? null : actions}
            {fold ? (
              <Button variant="small" aria-expanded={fold.open} aria-controls={bodyId} aria-label={named} onClick={fold.onToggle}>
                {fold.open ? "Hide" : "Show"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      {fold ? <div id={bodyId} hidden={!fold.open}>{children}</div> : children}
    </section>
  );
}
