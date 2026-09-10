import type { ButtonHTMLAttributes, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ago, opsSummary, outcomeOf, plainEvent, plainLifecycle, plainReason, pillCls, OUTCOME_META, STEP_PLAIN, type OutcomeInput } from "./format";
import { evClass, evSummary } from "./events";
import type { TimelineEvent, TurnStep } from "./store";

/* Shared keyboard activation for clickable rows/cards (the Artifacts table
   proved the pattern: tabIndex + Enter/Space). Guards against double-firing
   when focus is on an inner control like the agent-card wake button. */
export function rowKey<T extends Element = HTMLElement>(open: () => void): (e: ReactKeyboardEvent<T>) => void {
  return (e) => {
    const t = e.target as Element;
    if (t !== e.currentTarget && t.closest("button, a, input, select, textarea")) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

export function StatusPill({ status, pulse }: { status: string; pulse?: boolean }): React.JSX.Element {
  const map: Record<string, string> = { running: "awakened", ok: "completed", waiting: "waiting", blocked: "failed", failed: "failed" };
  return (
    <span className={`pill ${map[status] || "idle"}${pulse || status === "running" ? " running-pulse" : ""}`}>
      {(STEP_PLAIN[status] || status)}
    </span>
  );
}

/* Outcome-shaped badge for turns. Prefer this over StatusPill anywhere a
   TurnStep is shown: it says whether the turn produced anything instead of
   surfacing the raw "waiting" lifecycle, which readers mistake for "stuck". */
export function OutcomePill({ step }: { step: OutcomeInput }): React.JSX.Element {
  const oc = outcomeOf(step);
  const meta = OUTCOME_META[oc];
  return <span className={`otag ${meta.cls}`} title={meta.hint}>{meta.label}</span>;
}

export function LifecyclePill({ lifecycle, pulse }: { lifecycle: string; pulse?: boolean }): React.JSX.Element {
  return (
    <span className={`pill ${pillCls(lifecycle)}${pulse ? " running-pulse" : ""}`}>
      {(plainLifecycle(lifecycle))}
    </span>
  );
}

export function EventRow({ e, onOpen }: { e: TimelineEvent; onOpen: (seq: number) => void }): React.JSX.Element {
  const open = () => onOpen(e.seq);
  return (
    <div className="ev" data-seq={e.seq} role="button" tabIndex={0} onClick={open} onKeyDown={rowKey(open)}>
      <time title={e.timestamp}>{new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time>
      <span className={`type ${evClass(e.type)}`}>{plainEvent(e.type)}</span>
      <span className="summary" dangerouslySetInnerHTML={{ __html: evSummary(e) }} />
    </div>
  );
}

// EventRow shows the human label; the raw type lives in the drawer.

export function StepMini({ s, onOpen }: { s: TurnStep; onOpen: (turnId: string) => void }): React.JSX.Element {
  const open = () => onOpen(s.turnId);
  return (
    <div className={`step-mini ${OUTCOME_META[outcomeOf(s)].cls}`} data-turn={s.turnId} role="button" tabIndex={0} onClick={open} onKeyDown={rowKey(open)}>
      <AgentAvatar id={s.agentId} size="sm" />
      <div style={{ minWidth: 0, flex: 1 }}>
        <b>{(s.agentId)}</b> <span className="muted">· {(plainReason(s.reasonKind))}</span>
        <div className="muted" style={{ fontSize: 11 }}>{(ago(s.startedAt))} · {opsSummary(s)}</div>
      </div>
      <OutcomePill step={s} />
    </div>
  );
}

/** The one avatar primitive. `color` is a CSS color or token reference; the
 *  tint is derived in CSS (color-mix) so token refs work and both themes flip. */
export function AgentAvatar({ id, color, size }: { id: string; color?: string; size?: "sm" }): React.JSX.Element {
  const cls = `avatar${size === "sm" ? " sm" : ""}${color ? " tinted" : ""}`;
  return (
    <span className={cls} style={color ? ({ "--tint": color } as React.CSSProperties) : undefined}>
      {((id || "?")[0].toUpperCase())}
    </span>
  );
}

/* ---------------- layout & control primitives ----------------
   Every variant below maps to a rule that already exists in styles.css or
   designer/designer.css; the line refs are load-bearing, keep them honest.
   The CSS is element-scoped (button.small, input.txt), so these MUST render
   the real element — a styled <div role="button"> would render unstyled. */

/** button.primary (styles.css:449) · button.soft (129) · button.small (451)
 *  · button.ghost (103) · .banner-act (469) · linklike (designer.css:189).
 *  `danger` only has rules paired with soft/small (131, 453), so the type
 *  forbids it elsewhere rather than silently rendering an inert class. */
type BtnBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;
type BtnProps =
  | (BtnBase & { variant: "soft" | "small"; danger?: boolean; extra?: string })
  | (BtnBase & { variant: "primary" | "ghost" | "linklike" | "banner-act"; danger?: never; extra?: string });

export function Button({ variant, danger, extra, type, ...rest }: BtnProps): React.JSX.Element {
  const cls = `${variant}${danger ? " danger" : ""}${extra ? ` ${extra}` : ""}`;
  return <button type={type ?? "button"} className={cls} {...rest} />;
}

/** .card (styles.css:155) with its `.card h3` header (156). `variant` is a
 *  free-form append for the card-scoped rules that already exist — kpi (157),
 *  graph-wrap (213), esc-raw (275), pulse (330) and the ms-* cards in
 *  designer.css. Grep before inventing one. */
export function Card({ title, actions, variant, style, children }: {
  title?: ReactNode; actions?: ReactNode; variant?: string;
  style?: React.CSSProperties; children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`card${variant ? ` ${variant}` : ""}`} style={style}>
      {title != null ? <h3>{title}{actions ? <span className="page-actions">{actions}</span> : null}</h3> : null}
      {children}
    </div>
  );
}

/** input.txt / input.search (styles.css:235,239). `mono` is the shared
 *  font utility at 191, not a form-specific class. */
export function Input({ search, mono, extra, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & { search?: boolean; mono?: boolean; extra?: string }): React.JSX.Element {
  return <input className={`${search ? "search" : "txt"}${mono ? " mono" : ""}${extra ? ` ${extra}` : ""}`} {...rest} />;
}

/** textarea.txt (styles.css:235). */
export function TextArea({ mono, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { mono?: boolean }): React.JSX.Element {
  return <textarea className={`txt${mono ? " mono" : ""}`} {...rest} />;
}

/** select.sel (styles.css:235). */
export function Select(props: Omit<SelectHTMLAttributes<HTMLSelectElement>, "className">): React.JSX.Element {
  return <select className="sel" {...props} />;
}

/** The literal set of .pill tone rules (styles.css:167-179). Anything outside
 *  it renders an unstyled pill, so the union is the guard. */
export type PillTone =
  | "idle" | "thinking" | "working" | "awakened" | "observing" | "requesting"
  | "reviewing" | "waiting" | "blocked" | "failed" | "suspended" | "completed" | "starting";

/** Raw-tone pill. Prefer StatusPill / LifecyclePill / OutcomePill when the
 *  tone is derived from domain state — this is for the literal call sites. */
export function Pill({ tone, pulse, children }: { tone: PillTone; pulse?: boolean; children: ReactNode }): React.JSX.Element {
  return <span className={`pill ${tone}${pulse ? " running-pulse" : ""}`}>{children}</span>;
}

/** .chip (styles.css:183) + .chip.hot (184) / .chip.mono (288). Renders a
 *  <button> when clickable so keyboard users get it for free. */
export function Chip({ hot, mono, onClick, title, style, children }: {
  hot?: boolean; mono?: boolean; onClick?: () => void; title?: string;
  style?: React.CSSProperties; children: ReactNode;
}): React.JSX.Element {
  const cls = `chip${hot ? " hot" : ""}${mono ? " mono" : ""}`;
  if (onClick) return <button type="button" className={cls} title={title} style={style} onClick={onClick}>{children}</button>;
  return <span className={cls} title={title} style={style}>{children}</span>;
}

/** .tabs / .tab-btn / .tab-n (styles.css:579-586). One tab vocabulary for every
 *  drawer: roving tabindex + arrow keys, so the strip behaves like a real
 *  tablist instead of a row of buttons that happen to carry role="tab". */
export interface TabDef {
  id: string;
  label: string;
  hint?: string;
  badge?: ReactNode;
  badgeHot?: boolean;
}

export function Tabs({ tabs, value, onChange, idPrefix, label }: {
  tabs: TabDef[]; value: string; onChange: (id: string) => void; idPrefix: string; label?: string;
}): React.JSX.Element {
  const move = (delta: number) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = tabs[(i + delta + tabs.length) % tabs.length];
    if (next) {
      onChange(next.id);
      document.getElementById(`${idPrefix}-tab-${next.id}`)?.focus();
    }
  };
  const onKey = (e: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === "ArrowRight") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
    else if (e.key === "Home") { e.preventDefault(); onChange(tabs[0].id); }
    else if (e.key === "End") { e.preventDefault(); onChange(tabs[tabs.length - 1].id); }
  };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className={`tab-btn${t.id === value ? " on" : ""}`}
          title={t.hint}
          onClick={() => onChange(t.id)}
          onKeyDown={onKey}
        >
          {t.label}
          {t.badge != null ? <em className={`tab-n${t.badgeHot ? " hot" : ""}`}>{t.badge}</em> : null}
        </button>
      ))}
    </div>
  );
}

/** The panel a Tabs strip controls. Focusable so keyboard users can page it. */
export function TabPanel({ idPrefix, id, children }: { idPrefix: string; id: string; children: ReactNode }): React.JSX.Element {
  return (
    <div id={`${idPrefix}-panel-${id}`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${id}`} tabIndex={0} className="tabpanel">
      {children}
    </div>
  );
}

/** The one failed-to-load state. Views used to swallow fetch errors and then
 *  render their empty state, which reads as "the mesh has nothing" when the
 *  truth is "the console never heard back" — an operator cannot tell a quiet
 *  mesh from a dead one. `.empty` (styles.css:221) is the shared shell. */
export function ErrorState({ what, detail, onRetry }: { what: string; detail?: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div className="empty" role="alert">
      <div className="big">⚠</div>
      <div>could not load {what}</div>
      <div className="muted">{detail ?? "the mesh server did not answer — it may be restarting."}</div>
      {onRetry ? <Button variant="small" onClick={onRetry}>try again</Button> : null}
    </div>
  );
}

export function agentColor(role: string): string {
  return (
    {
      architect: "var(--role-architect)", developer: "var(--role-developer)",
      qa: "var(--role-qa)", security: "var(--role-security)",
      "tech-lead": "var(--role-tech-lead)", pm: "var(--role-pm)",
      explorer: "var(--role-explorer)",
    }[role] || "var(--accent)"
  );
}
