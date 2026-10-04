import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ago, localTime, opsSummary, outcomeOf, plainEvent, plainLifecycle, plainReason, pillCls, zoneLabel, OUTCOME_META, STEP_PLAIN, type OutcomeInput } from "./format";
import { evClass, evSeverity, EventSummary } from "./events";
import { Icon, type IconName } from "./icons";
import type { TimelineEvent, TurnStep } from "./store";

/**
 * The Curule logo: the name drawn as strokes, its first letter the mark (a ring held open, with one seat filled at the end of the arc). The letters take the
 * text colour of where it is placed and the seat takes the theme's accent. The geometry is brand/curule-logo.svg, which
 * tests/build/brand-assets.test.ts keeps equal to this one.
 */
export function Wordmark({ height = 22 }: { height?: number }): React.JSX.Element {
  return (
    <svg className="wordmark" viewBox="0 0 221.54 60" width={(height * 221.54) / 60} height={height} role="img" aria-label="Curule">
      <path d="M31.04 27.74A16.5 16.5 0 1 0 31.04 52.26" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" />
      <circle cx="31.04" cy="27.74" r="6" fill="var(--accent)" />
      <path d="M45.54 23.5V40A16.5 16.5 0 0 0 78.54 40M78.54 23.5V56.5M92.54 56.5V23.5M92.54 40A16.5 16.5 0 0 1 109.04 23.5M122.04 23.5V40A16.5 16.5 0 0 0 155.04 40M155.04 23.5V56.5M171.04 3.5V56.5M185.04 40H218.04A16.5 16.5 0 1 0 213.8 51.04" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Only what a keyboard user can actually reach: `offsetParent === null` drops
// anything a parent hid with display:none, which is how the drawers collapse
// their inactive tab panels.
export function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

/**
 * Which overlay currently owns Tab.
 *
 * Two independent document-CAPTURE Tab traps used to be able to run on the same
 * event: the shell's drawer trap and a dialog's own. The shell registers first,
 * so on every Tab it saw focus outside #drawer, preventDefault'd and pulled
 * focus back to the drawer's first control -- then the dialog's trap ran on the
 * same event and pulled it to the dialog's first control. Forward Tab therefore
 * pinned on the first item forever and every control between first and last was
 * unreachable. In the "Reset to zero" confirm (match-text input, Cancel,
 * Confirm) that left Cancel with no keyboard route at all, reachable via the
 * global `r` shortcut over an open drawer.
 *
 * A trap only acts when it is the innermost one. Order is push order, so the
 * most recently opened layer wins, which is what "topmost" means here.
 */
const trapStack: HTMLElement[] = [];

export function pushTrap(el: HTMLElement): () => void {
  trapStack.push(el);
  return () => {
    const i = trapStack.lastIndexOf(el);
    if (i >= 0) trapStack.splice(i, 1);
  };
}

export const isTopTrap = (el: HTMLElement | null): boolean => !!el && trapStack[trapStack.length - 1] === el;

/**
 * The three things every modal owes a keyboard user: focus moves in when it
 * opens, Tab cannot escape it, Esc closes it, and focus returns to whatever
 * opened it. The shell implements a stack-aware version for its drawer; this is
 * the single-layer case, for dialogs that are simply open or closed.
 *
 * Attach the returned ref to the dialog root.
 */
export function useDismissable<T extends HTMLElement>(open: boolean, onClose: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Callers write `onClose={() => setOpen(false)}`, a fresh identity every
  // render. Depending on it directly would re-run the effect on each parent
  // re-render — re-stealing focus mid-typing and forgetting the real opener.
  const close = useRef(onClose);
  close.current = onClose;
  // Where focus goes on close depends on how the user closed it, and the only
  // moment that is knowable is during the interaction itself: this cleanup runs
  // BEFORE mousedown's default focus action, so reading document.activeElement
  // here reports stale state, and calling focus() unconditionally merely races
  // that default (measured: the call ran, then the browser overrode it).
  //
  // Suppress the restore only when the press landed on something the browser
  // will focus -- yanking focus off a control the user just clicked is the one
  // harmful case. A scrim (ConfirmDialog, the project picker) and inert canvas
  // are not focusable, so those still restore to the opener rather than
  // stranding focus on <body>, where the next Tab restarts at the document top.
  const viaPointer = useRef(false);
  useEffect(() => {
    if (!open) return;
    viaPointer.current = false;
    const from = document.activeElement;
    opener.current = from instanceof HTMLElement && from !== document.body ? from : null;
    const root = ref.current;
    if (root) (focusables(root)[0] ?? root).focus();
    const pop = root ? pushTrap(root) : () => {};
    const onKey = (ev: KeyboardEvent) => {
      // Last interaction wins: a stray earlier click must not disarm the
      // restore for a close the user then drives from the keyboard.
      viaPointer.current = false;
      if (ev.key === "Escape") {
        // Only the innermost layer closes. Every open dialog has its own listener on the document, and with one opened over
        // another (a picker over a form) they all ran, so one Escape closed both and lost whatever the outer one held.
        const top = ref.current;
        if (top && !isTopTrap(top)) return;
        ev.stopPropagation();
        close.current();
        return;
      }
      if (ev.key !== "Tab") return;
      const el = ref.current;
      if (!el) return;
      // Only the innermost open overlay may move focus; otherwise this trap and
      // the shell's drawer trap both fire on the same Tab and fight.
      if (!isTopTrap(el)) return;
      const items = focusables(el);
      if (!items.length) {
        ev.preventDefault();
        el.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const act = document.activeElement;
      if (!(act instanceof HTMLElement) || !el.contains(act)) {
        ev.preventDefault();
        (ev.shiftKey ? last : first).focus();
      } else if (ev.shiftKey && act === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && act === last) {
        ev.preventDefault();
        first.focus();
      }
    };
    const onDown = (ev: PointerEvent) => {
      const el = ref.current;
      const t = ev.target;
      viaPointer.current =
        !!el && t instanceof Element && !el.contains(t) && !!t.closest(FOCUSABLE);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      pop();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      const back = opener.current;
      if (!viaPointer.current && back && back.isConnected) back.focus();
    };
  }, [open]);
  return ref;
}

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

/* ------------------------------- clock --------------------------------- */

/** One shared ticking clock per view, so live durations move in step instead
    of each row running its own interval. Lives here rather than in a view
    because both the step ledger and the events console need the same one. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(iv);
  }, [ms]);
  return now;
}

/**
 * The compact event line used by the Overview mini-feed. The events console
 * has its own row — it carries selection, folding and a seq gutter that would
 * be noise here.
 *
 * Severity rides along anyway, because a feed of eight events that renders a
 * crash identically to a budget reservation is the miniature version of the
 * problem the console was rebuilt to fix.
 */
export function EventRow({ e, onOpen }: { e: TimelineEvent; onOpen: (seq: number) => void }): React.JSX.Element {
  const open = () => onOpen(e.seq);
  return (
    <div className={`ev sev-${evSeverity(e)}`} data-seq={e.seq} role="button" tabIndex={0} onClick={open} onKeyDown={rowKey(open)}>
      <time title={e.timestamp}>{localTime(e.timestamp)}</time>
      <span className={`type ${evClass(e.type)}`}>{plainEvent(e.type)}</span>
      <span className="summary"><EventSummary e={e} /></span>
    </div>
  );
}

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
type BtnBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { icon?: IconName };
type BtnProps =
  | (BtnBase & { variant: "soft" | "small"; danger?: boolean; extra?: string })
  | (BtnBase & { variant: "primary" | "ghost" | "linklike" | "banner-act"; danger?: never; extra?: string });

/** `icon` draws a leading glyph from the console's icon set; the label still carries the name, so the icon is decoration. */
export function Button({ variant, danger, extra, type, icon, children, ...rest }: BtnProps): React.JSX.Element {
  const cls = `${variant}${danger ? " danger" : ""}${extra ? ` ${extra}` : ""}`;
  return (
    <button type={type ?? "button"} className={cls} {...rest}>
      {icon ? <Icon name={icon} size={variant === "small" || variant === "banner-act" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/** A square, icon-only button. The icon is decoration and `label` is the name, so the control is announced for what it
 *  does. `pressed` is for a toggle (theme). 36px square: a full pointer target where a labelled button would not fit. */
export function IconButton({ icon, label, pressed, onClick, id, title }: {
  icon: IconName; label: string; pressed?: boolean; onClick: () => void; id?: string; title?: string;
}): React.JSX.Element {
  return (
    <button type="button" id={id} className="icon-btn" aria-label={label} title={title ?? label} aria-pressed={pressed} onClick={onClick}>
      <Icon name={icon} size={18} />
    </button>
  );
}

/** Menu button, for a bar that has run out of width. The topbar carries four
 *  mission actions; measured at 390px those wrapped the header to four rows,
 *  138px tall, and pushed the document into horizontal scroll. The secondary
 *  ones collapse in here while the one that is asking for an answer stays out.
 *
 *  It lives here rather than in the shell because it is chrome, not mission
 *  logic — the next toolbar to run out of width should reuse it. Items are
 *  data rather than children on purpose: that is what keeps role="menuitem",
 *  the arrow keys and the focus return correct no matter who calls it.
 *  Follows the ARIA menu-button pattern (styles.css .menu-wrap). */
export type MenuItem = {
  id?: string; label: ReactNode; title?: string; danger?: boolean; onClick: () => void;
  /** A leading glyph. The label still names the action. */
  icon?: IconName;
  /** Draw a divider above this row: a destructive action is set apart from the ordinary ones. */
  separated?: boolean;
};

export function Menu({ id, label, title, items, align = "right", placement = "bottom", extra }: {
  id?: string; label: ReactNode; title?: string; items: MenuItem[]; align?: "left" | "right";
  /** Which side of the trigger the panel opens on. A trigger at the foot of the screen opens upward. */
  placement?: "bottom" | "top";
  extra?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);

  // pointerdown, not click: the panel is gone before whatever is underneath
  // reacts, and the outside target still gets its own event.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // A menu you have to tab into is a menu the keyboard cannot use.
  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const close = (restore: boolean) => { setOpen(false); if (restore) btn.current?.focus(); };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.stopPropagation(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const list = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])];
    if (!list.length) return;
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0
      : e.key === "End" ? list.length - 1
      : e.key === "ArrowDown" ? (i + 1) % list.length
      : i <= 0 ? list.length - 1 : i - 1;
    list[next]?.focus();
  };

  // Tab moves focus out of an open panel without ever crossing the outside
  // pointerdown handler, which left the menu hanging open behind whatever the
  // user had tabbed to. Close on focus leaving the wrapper — but do not pull
  // focus back, because the user moved it on purpose. relatedTarget is null
  // when focus lands on nothing, which should also close.
  const onBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!wrap.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKeyDown} onBlur={onBlur}>
      <button ref={btn} id={id} type="button" className={`soft menu-btn${extra ? ` ${extra}` : ""}`} title={title} aria-label={title}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open ? (
        <div className={`menu-panel ${align} ${placement}`} role="menu">
          {items.map((it, i) => (
            /* Focus goes back to the trigger before the action runs, so a item
               that opens a drawer records the trigger as its return target. */
            <button key={it.id ?? i} id={it.id} type="button" role="menuitem"
              className={`menu-item${it.danger ? " danger" : ""}${it.separated ? " separated" : ""}`} title={it.title}
              onClick={() => { close(true); it.onClick(); }}>
              {it.icon ? <Icon name={it.icon} /> : null}
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
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

/** .chip (styles.css:183) + .chip.hot (184) / .chip.mono (288) / .chip.warn.
 *  Renders a <button> when clickable so keyboard users get it for free. */
export function Chip({ hot, mono, warn, onClick, title, style, children }: {
  hot?: boolean; mono?: boolean; warn?: boolean; onClick?: () => void; title?: string;
  style?: React.CSSProperties; children: ReactNode;
}): React.JSX.Element {
  const cls = `chip${hot ? " hot" : ""}${mono ? " mono" : ""}${warn ? " warn" : ""}`;
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
    <div className="empty bad" role="alert">
      <span className="empty-icon"><Icon name="alert" size={22} /></span>
      <b className="empty-title">Could not load {what}</b>
      <p className="empty-body">{detail ?? "The mesh server did not answer. It may be restarting."}</p>
      {onRetry ? <Button variant="small" icon="refresh" onClick={onRetry}>Try again</Button> : null}
    </div>
  );
}

/**
 * The one empty state. It names what is missing and, when there is one, offers the next move, instead of announcing absence.
 * `tone="bad"` is for a state that is a fault (ErrorState), not for a list that is simply empty.
 */
export function EmptyState({ icon, title, children, action, tone }: {
  icon?: IconName; title: ReactNode; children?: ReactNode; action?: ReactNode; tone?: "bad";
}): React.JSX.Element {
  return (
    <div className={`empty${tone ? ` ${tone}` : ""}`}>
      {icon ? <span className="empty-icon"><Icon name={icon} size={22} /></span> : null}
      <b className="empty-title">{title}</b>
      {children ? <p className="empty-body">{children}</p> : null}
      {action ? <div className="empty-acts">{action}</div> : null}
    </div>
  );
}

/**
 * The title row every view opens with: the name of the page, an optional status chip beside it, the page's actions at the
 * end, and one line under it saying what the page is for. A page that explains itself in a paragraph has the wrong title.
 */
export function PageHeader({ title, status, lede, actions }: { title: ReactNode; status?: ReactNode; lede?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <header className="page-head">
      <div className="view-title">
        <h2>{title}</h2>
        {status}
        {actions ? <div className="page-actions">{actions}</div> : null}
      </div>
      {lede ? <p className="view-sub">{lede}</p> : null}
    </header>
  );
}

export type BannerTone = "ok" | "warn" | "bad" | "info";
const BANNER_ICON: Record<BannerTone, IconName> = { ok: "check", warn: "alert", bad: "alert", info: "info" };

/**
 * One notice, in one shape: an icon, a sentence in bold that says what is true, optional detail in the same colour as body
 * text, and the actions that answer it at the end. Tone is the only decision a caller makes; `bad` is announced to
 * assistive technology at once (role="alert"), the rest politely (role="status").
 */
export function Banner({ tone = "info", icon, title, children, actions, id, className }: {
  tone?: BannerTone; icon?: IconName; title: ReactNode; children?: ReactNode; actions?: ReactNode; id?: string; className?: string;
}): React.JSX.Element {
  return (
    <div className={`banner has-icon ${tone}${className ? ` ${className}` : ""}`} role={tone === "bad" ? "alert" : "status"} id={id}>
      <span className="banner-icon"><Icon name={icon ?? BANNER_ICON[tone]} /></span>
      <div className="banner-body"><b>{title}</b>{children ? <span className="banner-text"> {children}</span> : null}</div>
      {actions ? <div className="banner-acts">{actions}</div> : null}
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

/**
 * What a native confirm() cannot do: say which mesh it is about, show the list
 * of agents it is about to wake, mark a destructive action as destructive, or
 * be styled, focus-trapped and dismissed like the rest of the console. It also
 * blocks the whole tab while it is up, which on a live SSE view means the
 * stream backs up behind a modal the browser drew.
 *
 * One dialog covers all three guards the console actually uses:
 *   - plain yes/no                (`require` omitted)
 *   - type-the-name to arm        (`require.kind === "match"`)
 *   - give a reason to proceed    (`require.kind === "text"`)
 * so a caller picks a shape rather than hand-rolling a modal.
 */
export interface ConfirmRequest {
  title: string;
  /** Each string is its own paragraph — consequences read better as a list than as one wall. */
  body?: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the confirm button as destructive and holds it until `require` is satisfied. */
  danger?: boolean;
  require?:
    | { kind: "match"; value: string; label: string }
    | { kind: "text"; label: string; placeholder?: string };
}

/**
 * Resolves with the typed text on confirm (`""` when nothing was required), or
 * `null` on cancel — so `if ((await confirm(…)) === null) return;` reads the
 * same way the old `if (!window.confirm(…)) return;` did.
 */
export type ConfirmFn = (req: ConfirmRequest) => Promise<string | null>;

export function ConfirmDialog({ req, onResolve }: { req: ConfirmRequest; onResolve: (v: string | null) => void }): React.JSX.Element {
  const [text, setText] = useState("");
  const cancel = useCallback(() => onResolve(null), [onResolve]);
  const ref = useDismissable<HTMLDivElement>(true, cancel);
  const need = req.require;
  // A `match` guard is the point of the dialog, so it is checked exactly: no
  // case folding, only the surrounding whitespace a copy-paste drags along.
  const armed = !need ? true : need.kind === "match" ? text.trim() === need.value : text.trim().length > 0;
  const descId = "confirm-body";
  return (
    <>
      <div className="confirm-scrim" onClick={cancel} />
      <div className="confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby={req.body?.length ? descId : undefined} ref={ref}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (armed) onResolve(text.trim());
          }}
        >
          <h2 id="confirm-title">{req.title}</h2>
          {req.body?.length ? (
            <div id={descId} className="confirm-body">
              {req.body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          ) : null}
          {need ? (
            <label className="confirm-field">
              <span>{need.label}</span>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={need.kind === "match" ? need.value : need.placeholder}
                /* The guard is the whole point — never let a password manager or
                   the browser's own history pre-arm it. */
                autoComplete="off"
                spellCheck={false}
                aria-describedby={need.kind === "match" ? "confirm-hint" : undefined}
              />
              {need.kind === "match" ? (
                <small id="confirm-hint" className="muted">
                  {/* Says what is still missing rather than only greying the button:
                      a disabled control with no reason given is a dead end. */}
                  {armed ? "matches — the action is armed" : `type ${need.value} exactly to continue`}
                </small>
              ) : null}
            </label>
          ) : null}
          <div className="confirm-acts">
            <Button variant="soft" onClick={cancel}>
              {req.cancelLabel ?? "Cancel"}
            </Button>
            {/* Split rather than a computed `variant`: `danger` is only legal on
                the soft/small arms of BtnProps, and a ternary defeats that check. */}
            {req.danger ? (
              <Button variant="soft" danger type="submit" disabled={!armed}>
                {req.confirmLabel ?? "Confirm"}
              </Button>
            ) : (
              <Button variant="primary" type="submit" disabled={!armed}>
                {req.confirmLabel ?? "Confirm"}
              </Button>
            )}
          </div>
        </form>
      </div>
    </>
  );
}

/* ------------------------------ copy and ids ------------------------------ */
// Imports sit with the code they serve so the shared primitives above stay as other work packages left them.
import "./live.css";
import { copyText } from "./clipboard";
export { copyText };
import { middleClip } from "./text";

/**
 * A button that copies `text`, and says what happened: the icon turns to a tick and the label to "Copied" for two seconds, and a
 * hidden status line says the same to a screen reader. `compact` is the icon-only form for a row that has no room for a word;
 * `what` then carries the name ("Copy event id"), because an icon alone names nothing.
 *
 * It copies through `copyText`, which falls back to the selection route on an http origin that has no clipboard API, so the
 * button works on a self-hosted console and not only on localhost.
 */
export function CopyButton({ text, label = "Copy", what, compact, title }: { text: string; label?: string; what?: string; compact?: boolean; title?: string }): React.JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "fail">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const go = async (): Promise<void> => {
    const ok = await copyText(text);
    setState(ok ? "done" : "fail");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const name = what ? `${label} ${what}` : label;
  const icon: IconName = state === "done" ? "check" : state === "fail" ? "alert" : "copy";
  const shown = state === "done" ? "Copied" : state === "fail" ? "Can't copy" : label;
  return (
    <>
      <button
        type="button"
        className={compact ? "copy-btn compact" : "small copy-btn"}
        onClick={() => void go()}
        aria-label={state === "idle" && (compact || what) ? name : undefined}
        title={state === "fail" ? "The browser would not allow copying here. Select the text and copy it by hand." : title ?? (compact ? name : undefined)}
      >
        <Icon name={icon} size={14} />
        {compact ? null : <span>{shown}</span>}
      </button>
      <span className="sr-only" role="status">{state === "done" ? "Copied" : state === "fail" ? "Could not copy" : ""}</span>
    </>
  );
}

/**
 * An identifier short enough for a row, with a way to get the whole thing. The ends are kept (a prefix says what it is, a
 * suffix tells two apart) and the full id is the tooltip and what the copy button takes. Long ids used to be cut by a stylesheet
 * ellipsis that removed exactly the part that differs.
 */
export function IdChip({ value, label, max = 24 }: { value: string; label: string; max?: number }): React.JSX.Element {
  return (
    <span className="idchip">
      <code title={value}>{middleClip(value, max)}</code>
      <CopyButton text={value} what={label} compact />
    </span>
  );
}

/**
 * "Times in CEST": the zone, said once above a run of local times so no row has to repeat it. Put it beside the heading of the
 * list, not inside a row.
 */
export function ZoneNote(): React.JSX.Element {
  // The leading space keeps the heading and the note two words for a screen reader; the margin is only for the eye.
  return <span className="zone-note"> Times in {zoneLabel()}</span>;
}
