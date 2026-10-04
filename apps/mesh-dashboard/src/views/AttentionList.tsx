import { Button } from "../components";
import { Icon, type IconName } from "../icons";
import type { AttentionItem, AttentionKind, FixTarget } from "../overview-model";
import "./overview.css";

const ICON: Record<AttentionKind, IconName> = {
  decisions: "inbox", ceiling: "alert", blocks: "alert", tools: "lock", notices: "info", capacity: "info", triage: "info",
};

/**
 * Everything that is true of the mission besides its headline, one line each: an icon whose colour says whether to act, look or
 * only know; what is true; the single fix. The long wording is behind the line, so a mesh with five conditions reads as five
 * lines and not five paragraphs. Renders nothing when there is nothing to say.
 */
export function AttentionList({ items, onFix }: { items: AttentionItem[]; onFix: (target: FixTarget) => void }): React.JSX.Element | null {
  if (!items.length) return null;
  return (
    <section className="ov-attn" aria-labelledby="ov-attn-h">
      <h3 className="ov-attn-head" id="ov-attn-h">Attention <span className="n">{items.length}</span></h3>
      <ul>
        {items.map((it) => {
          const line = (
            <span className="ov-ad-line">
              <b>{it.title}</b>
              {it.context ? <> <span className="ctx">{it.context}</span></> : null}
            </span>
          );
          return (
            <li key={it.kind} data-kind={it.kind}>
              <span className={`ov-ai${it.tone === "info" ? "" : ` ${it.tone}`}`}><Icon name={ICON[it.kind]} size={16} /></span>
              {it.detail.length ? (
                <details className="ov-ad">
                  <summary>
                    <Icon name="chevron-right" size={14} className="chev" />
                    {line}
                  </summary>
                  <div className="ov-ad-body">{it.detail.map((p, i) => <p key={i}>{p}</p>)}</div>
                </details>
              ) : <div className="ov-ad plain">{line}</div>}
              {it.fix ? <Button variant="small" extra="ov-fix" onClick={() => onFix(it.fix!.target)}>{it.fix.label}</Button> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
