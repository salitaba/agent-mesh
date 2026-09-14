import { useCallback, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ago, opsSummary, outcomeOf, plainEvent, plainLifecycle, plainReason, pillCls, OUTCOME_META, STEP_PLAIN, type OutcomeInput } from "./format";
import { evClass, evSeverity, EventSummary } from "./events";
import type { TimelineEvent, TurnStep } from "./store";

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
      <time title={e.timestamp}>{new Date(e.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</time>
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
type BtnBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;
type BtnProps =
  | (BtnBase & { variant: "soft" | "small"; danger?: boolean; extra?: string })
  | (BtnBase & { variant: "primary" | "ghost" | "linklike" | "banner-act"; danger?: never; extra?: string });

export function Button({ variant, danger, extra, type, ...rest }: BtnProps): React.JSX.Element {
  const cls = `${variant}${danger ? " danger" : ""}${extra ? ` ${extra}` : ""}`;
  return <button type={type ?? "button"} className={cls} {...rest} />;
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
export type MenuItem = { id?: string; label: ReactNode; title?: string; danger?: boolean; onClick: () => void };

export function Menu({ id, label, title, items, align = "right" }: {
  id?: string; label: ReactNode; title?: string; items: MenuItem[]; align?: "left" | "right";
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
      <button ref={btn} id={id} type="button" className="soft menu-btn" title={title} aria-label={title}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
      {open ? (
        <div className={`menu-panel ${align}`} role="menu">
          {items.map((it, i) => (
            /* Focus goes back to the trigger before the action runs, so a item
               that opens a drawer records the trigger as its return target. */
            <button key={it.id ?? i} id={it.id} type="button" role="menuitem"
              className={`menu-item${it.danger ? " danger" : ""}`} title={it.title}
              onClick={() => { close(true); it.onClick(); }}>{it.label}</button>
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
