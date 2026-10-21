import type { IconName } from "../icons";
import { Icon } from "../icons";
import "./next.css";

/**
 * The quiet end of a page: where to go when this one has given what it has. Every page that can be scrolled to its bottom used
 * to be a dead end: the sidebar was the only way on, and it is not where the person's attention is after reading a list to the
 * end. The links are destinations, not actions, so they are words with a mark, one row, and they lead with the product.
 *
 * Deliberately not a card: a card at the bottom of a page of cards reads as one more thing to read. A ruled line and a short
 * row says "the page ends here, and there are two doors".
 */
export interface NextLink {
  label: string;
  /** What the destination is for. Shown as the tooltip, and read by a title-only pointer. */
  hint: string;
  icon: IconName;
  onGo: () => void;
}

export function NextLinks({ links }: { links: NextLink[] }): React.JSX.Element {
  return (
    <nav className="next-links" aria-label="Where to go next">
      <span className="next-links-h caps">Next</span>
      <div className="next-links-row">
        {links.map((l) => (
          <button key={l.label} type="button" className="next-link" title={l.hint} onClick={l.onGo}>
            <Icon name={l.icon} size={14} />
            <span>{l.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
