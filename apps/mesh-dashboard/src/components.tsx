import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes, KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { ago, localTime, opsSummary, outcomeOf, plainEvent, plainLifecycle, plainReason, pillCls, zoneLabel, OUTCOME_META, STEP_PLAIN, type OutcomeInput } from "./format";
import { evClass, evSeverity, EventSummary } from "./events";
import type { NameOf } from "./eventmodel";
import { Icon, type IconName } from "./icons";
import type { TimelineEvent, TurnStep } from "./store";
import { Kbd } from "./ui/kbd";
import { Tooltip } from "./ui/tooltip";
import { useScrolls } from "./ui/scroll-stop";

/* The kit's smaller primitives live in ui/ and are exported from here, so a view imports every primitive from one place and
   the gallery (kit.tsx) and its test read one list. */
export { Kbd, isMac } from "./ui/kbd";
export { Tooltip } from "./ui/tooltip";
export { Checkbox, Radio, Switch, Field } from "./ui/controls";
export { Skeleton, SkeletonText, Progress } from "./ui/feedback";
export { Sparkline, Ring } from "./ui/charts";
export { Stat } from "./ui/stat";
export { SearchField } from "./ui/search";

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

/** A status in words, from the strings the API gives (running, ok, waiting, blocked, failed), as a badge (styles.css "badges"). `running`
 *  pulses its dot; `pulse` makes any other do the same. For a turn use OutcomePill: it says what the turn produced. */
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

/** An agent's lifecycle (IDLE, WORKING, WAITING, ...) in plain words, as a badge; `pulse` is for the one that is live right now. */
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
export function EventRow({ e, onOpen, nameOf }: { e: TimelineEvent; onOpen: (seq: number) => void; nameOf?: NameOf }): React.JSX.Element {
  const open = () => onOpen(e.seq);
  return (
    <div className={`ev sev-${evSeverity(e)}`} data-seq={e.seq} role="button" tabIndex={0} onClick={open} onKeyDown={rowKey(open)}>
      <time title={e.timestamp}>{localTime(e.timestamp)}</time>
      <span className={`type ${evClass(e.type)}`}>{plainEvent(e.type)}</span>
      <span className="summary"><EventSummary e={e} nameOf={nameOf} /></span>
    </div>
  );
}

/** One turn as a row: who, why, when, what it did, and its outcome at the end. The whole row opens the step; Enter and Space do too.
 *  States: default, hover, focus-visible. */
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

/** The one avatar primitive: the seat's letter on its role colour (30px; `sm` 26, `lg` 40). `color` is a CSS color or token
 *  reference; the tint is derived in CSS (color-mix) so token refs work and both themes flip. */
export function AgentAvatar({ id, color, size }: { id: string; color?: string; size?: "sm" | "lg" }): React.JSX.Element {
  const cls = `avatar${size ? ` ${size}` : ""}${color ? " tinted" : ""}`;
  return (
    <span className={cls} style={color ? ({ "--tint": color } as React.CSSProperties) : undefined}>
      {((id || "?")[0].toUpperCase())}
    </span>
  );
}

/** The tones a tile can take: the status colours, and the quiet one. With none it is the selection's own colour (the accent). */
export type TileTone = "ok" | "warn" | "bad" | "info" | "neutral";

/** An icon on the ground of its tone, 40px (`sm` 28, `lg` 48): the mark at the head of a card, a row or an empty state. The selection's
 *  colour by default; `tone` says a status. `live` breathes a ring, for a thing that is running right now. The glyph is decoration: the
 *  words beside it say what it is. States: default, live. */
export function IconTile({ icon, tone, size, live }: { icon: IconName; tone?: TileTone; size?: "sm" | "lg"; live?: boolean }): React.JSX.Element {
  return (
    <span className={`tile${size ? ` ${size}` : ""}${tone ? ` ${tone}` : ""}${live ? " live" : ""}`} aria-hidden="true">
      <Icon name={icon} size={size === "sm" ? 16 : size === "lg" ? 24 : 20} />
    </span>
  );
}

/* ---------------- layout & control primitives ----------------
   Every variant below maps to a rule in styles.css (the sections are named for the primitives). The CSS is element-scoped
   (button.small, input.txt), so these MUST render the real element: a styled <div role="button"> would render unstyled. */

/** The shapes of a button, all real <button>s whose class is the variant (styles.css "buttons"):
 *  primary (the one thing to do) · soft (secondary) · small (a row action) · ghost (no ground until pointed at) ·
 *  banner-act (the action of a Banner) · linklike (a link that does something).
 *  `danger` is a tone: red text on soft and small, the red fill on primary (the confirmation of a destructive act).
 *  `loading` is "working": aria-busy, a spinner in place of the icon, the label stays, and a press does nothing until it ends.
 *  `size="lg"` is the 44px one for a form's one button.
 *  States: default, hover, pressed, focus-visible, disabled, loading. */
type BtnBase = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> & { icon?: IconName; loading?: boolean; size?: "lg" };
type BtnProps =
  | (BtnBase & { variant: "primary" | "soft" | "small"; danger?: boolean; extra?: string })
  | (BtnBase & { variant: "ghost" | "linklike" | "banner-act"; danger?: never; extra?: string });

/** `icon` draws a leading glyph from the console's icon set; the label still carries the name, so the icon is decoration. */
export function Button({ variant, danger, extra, size, loading, type, icon, children, onClick, ...rest }: BtnProps): React.JSX.Element {
  const cls = `${variant}${danger ? " danger" : ""}${size ? ` ${size}` : ""}${extra ? ` ${extra}` : ""}`;
  return (
    <button type={type ?? "button"} className={cls} aria-busy={loading || undefined} onClick={loading ? (e) => e.preventDefault() : onClick} {...rest}>
      {icon ? <Icon name={icon} size={variant === "small" || variant === "banner-act" ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

/** A square, icon-only button. The icon is decoration and `label` is the name, so the control is announced for what it
 *  does; a tooltip says it to the pointer too (`title` is the longer wording when the label is not enough, `keys` the shortcut).
 *  `pressed` is for a toggle (theme). 36px square (28 with `size="sm"`, 44 on a phone): a full pointer target where a labelled
 *  button would not fit. States: default, hover, pressed, focus-visible, selected (`pressed`), disabled. */
export function IconButton({ icon, label, pressed, onClick, id, title, keys, size, disabled, extra, expanded, controls, haspopup }: {
  icon: IconName; label: string; pressed?: boolean; onClick: () => void; id?: string; title?: string; keys?: string; size?: "sm"; disabled?: boolean; extra?: string;
  /** For a button that opens something (a panel, a popover): whether it is open, what it controls and what kind of thing it opens. */
  expanded?: boolean; controls?: string; haspopup?: "dialog" | "menu";
}): React.JSX.Element {
  return (
    <Tooltip content={title ?? label} keys={keys}>
      <button type="button" id={id} className={`icon-btn${size ? ` ${size}` : ""}${extra ? ` ${extra}` : ""}`} aria-label={label} aria-pressed={pressed} aria-expanded={expanded} aria-controls={controls} aria-haspopup={haspopup} disabled={disabled} onClick={onClick}>
        <Icon name={icon} size={size === "sm" ? 16 : 18} />
      </button>
    </Tooltip>
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
  /** The shortcut that does the same thing, as a chord ("mod+k"), drawn as keys at the end of the row. */
  hint?: string;
};

/** A button that opens a panel of actions, drawn at 180ms under (or over, `placement="top"`) its trigger. The panel is `role="menu"` and
 *  the trigger carries `aria-haspopup` and `aria-expanded`. Opened by a person it takes focus on its first item; the arrow keys, Home
 *  and End move, Escape closes and puts focus back on the trigger, and so does choosing a row. Tab leaves it and it closes behind you.
 *  States of a row: default, hover (the quiet ground), keyboard focus and pressed (the selection's ground, with an edge), `danger` (red,
 *  set apart by `separated`). */
export function Menu({ id, label, title, items, align = "right", placement = "bottom", extra, defaultOpen }: {
  id?: string; label: ReactNode; title?: string; items: MenuItem[]; align?: "left" | "right";
  /** Which side of the trigger the panel opens on. A trigger at the foot of the screen opens upward. */
  placement?: "bottom" | "top";
  extra?: string;
  /** Starts open (the gallery draws it so): the keyboard is not pulled into a menu the person did not open. */
  defaultOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(!!defaultOpen);
  const byPerson = useRef(false);
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
    if (open && byPerson.current) wrap.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const close = (restore: boolean) => { setOpen(false); byPerson.current = false; if (restore) btn.current?.focus(); };

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
        aria-haspopup="menu" aria-expanded={open} onClick={() => { byPerson.current = !open; setOpen(!open); }}>{label}</button>
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
              {it.hint ? <Kbd keys={it.hint} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A card (styles.css "surfaces"): the page's rung 1, 14px radius, a hairline and a short shadow. `title` is its heading, `meta` what it is
 *  about or how many at the end of the heading row, `actions` the buttons that belong to it (beside the heading, not inside it, so a
 *  screen reader does not read them as part of its name). `interactive` is a card that can be pressed: rung 2 on hover. `variant` is
 *  a free-form append for the card-scoped rules that already exist (graph-wrap, esc-raw, the ms-* cards); grep before inventing one.
 *  States: default, hover and pressed when interactive, focus-visible when it is a button or a link. */
export function Card({ title, meta, actions, interactive, variant, style, children }: {
  title?: ReactNode; meta?: ReactNode; actions?: ReactNode; interactive?: boolean; variant?: string;
  style?: React.CSSProperties; children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className={`card${interactive ? " interactive" : ""}${variant ? ` ${variant}` : ""}`} style={style}>
      {title != null || actions || meta ? (
        <div className="card-head">
          {title != null ? <h3>{title}</h3> : null}
          {meta ? <span className="card-meta">{meta}</span> : null}
          {actions ? <div className="card-acts">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** input.txt / input.search (styles.css "fields"). A text field's edge is the one that clears 3:1; focus turns it to the accent with a ring;
 *  `aria-invalid` turns it red. `mono` is for an id, a path or a number a person types (13px mono), not for words. Give it a name:
 *  wrap it in a Field (label, hint, error wired for you) or pass an aria-label.
 *  States: default, hover, focus, disabled, invalid. */
export function Input({ search, mono, extra, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "className"> & { search?: boolean; mono?: boolean; extra?: string }): React.JSX.Element {
  return <input className={`${search ? "search" : "txt"}${mono ? " mono" : ""}${extra ? ` ${extra}` : ""}`} {...rest} />;
}

/** textarea.txt (styles.css "fields"): the same states as Input; it grows by dragging its corner, not by itself. */
export function TextArea({ mono, extra, ...rest }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "className"> & { mono?: boolean; extra?: string }): React.JSX.Element {
  return <textarea className={`txt${mono ? " mono" : ""}${extra ? ` ${extra}` : ""}`} {...rest} />;
}

/** select.sel (styles.css "fields"): the native control with the console's own caret; the same states as Input. */
export function Select({ extra, ...rest }: Omit<SelectHTMLAttributes<HTMLSelectElement>, "className"> & { extra?: string }): React.JSX.Element {
  return <select className={`sel${extra ? ` ${extra}` : ""}`} {...rest} />;
}

/** The tones a .pill has a rule for (styles.css "badges"). The first row is a status in words (ok, warn, bad, info), the accent is
 *  the selection's own colour, neutral is the quiet one; the rest are the agent lifecycle's names and fold into those. Anything
 *  outside the set renders an unstyled pill, so the union is the guard. */
export type PillTone =
  | "neutral" | "accent" | "ok" | "warn" | "bad" | "info"
  | "idle" | "thinking" | "working" | "awakened" | "observing" | "requesting"
  | "reviewing" | "waiting" | "blocked" | "failed" | "suspended" | "completed" | "starting";

/** A badge: a word with a state, 22px, a pill, a 6px dot that says "state" in shape as well as colour. `pulse` is for a live one.
 *  Prefer StatusPill / LifecyclePill / OutcomePill when the tone is derived from domain state: this is for the literal call sites.
 *  `dot={false}` drops the dot where the word is enough. */
export function Pill({ tone, pulse, dot = true, children }: { tone: PillTone; pulse?: boolean; dot?: boolean; children: ReactNode }): React.JSX.Element {
  return <span className={`pill ${tone}${pulse ? " running-pulse" : ""}${dot ? "" : " no-dot"}`}>{children}</span>;
}

/** A tag: a capability, a status word, an id, 22px and quiet. `hot` is the selection's colour, `warn` the plan gate's, `mono` for an id or
 *  a path (words are set in the sans). Renders a <button> when clickable so keyboard users get it for free. */
export function Chip({ hot, mono, warn, onClick, title, style, children }: {
  hot?: boolean; mono?: boolean; warn?: boolean; onClick?: () => void; title?: string;
  style?: React.CSSProperties; children: ReactNode;
}): React.JSX.Element {
  const cls = `chip${hot ? " hot" : ""}${mono ? " mono" : ""}${warn ? " warn" : ""}`;
  if (onClick) return <button type="button" className={cls} title={title} style={style} onClick={onClick}>{children}</button>;
  return <span className={cls} title={title} style={style}>{children}</span>;
}

/** Tabs (styles.css "tabs"). One tab vocabulary for every drawer and page: roving tabindex + arrow keys, so the strip behaves like
 *  a real tablist instead of a row of buttons that happen to carry role="tab". A 2px line in the accent slides under the selected
 *  tab (180ms); `variant="segmented"` is a trough with the selected tab raised out of it, the same slide at 120ms.
 *  States: default, hover, selected, focus-visible; a `badge` is a count (`badgeHot` when it is news). */
export interface TabDef {
  id: string;
  label: string;
  hint?: string;
  badge?: ReactNode;
  badgeHot?: boolean;
}

/** Tabs with panels (TabPanel), the selected one underlined by a line that slides to it (`variant="segmented"` is the same as a thumb in
 *  a trough). One tab stop: the arrow keys, Home and End move the selection and the focus together. A count on a tab is measured, so
 *  the line follows it when it widens. Choosing one of a few with no panel is a Segmented. States: default, hover, selected, focus-visible. */
export function Tabs({ tabs, value, onChange, idPrefix, label, variant }: {
  tabs: TabDef[]; value: string; onChange: (id: string) => void; idPrefix: string; label?: string; variant?: "line" | "segmented";
}): React.JSX.Element {
  const list = useRef<HTMLDivElement | null>(null);
  const [ink, setInk] = useState<{ x: number; w: number } | null>(null);
  const segmented = variant === "segmented";
  // The indicator is measured from the selected button, so a count that widens a tab moves it with it. A layout effect: the line is
  // placed before the first paint, and a tab strip that reflows (fonts arriving, a resize) is measured again.
  const sig = tabs.map((t) => `${t.id}:${String(t.badge ?? "")}`).join("|");
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const measure = (): void => {
      const on = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      setInk(on ? { x: on.offsetLeft, w: on.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [value, sig]);
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
    <div
      ref={list}
      className={segmented ? "seg" : "tabs"}
      role="tablist"
      aria-label={label}
      data-ink={ink ? "" : undefined}
      style={ink ? ({ "--ink-x": `${ink.x}px`, "--ink-w": `${ink.w}px` } as CSSProperties) : undefined}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`${idPrefix}-tab-${t.id}`}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          aria-controls={`${idPrefix}-panel-${t.id}`}
          tabIndex={t.id === value ? 0 : -1}
          className={segmented ? undefined : `tab-btn${t.id === value ? " on" : ""}`}
          title={t.hint}
          onClick={() => onChange(t.id)}
          onKeyDown={onKey}
        >
          {t.label}
          {t.badge != null ? <em className={`tab-n${t.badgeHot ? " hot" : ""}`}>{t.badge}</em> : null}
        </button>
      ))}
      {ink ? <span className="tabs-ink" aria-hidden="true" /> : null}
    </div>
  );
}

/** One choice of a few, always visible, as buttons that carry `aria-pressed` (a filter, a range, a view mode). For panels use Tabs.
 *  The chosen one is raised out of a trough. States: default, hover, pressed (chosen), focus-visible. */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: ReadonlyArray<{ id: T; label: ReactNode; hint?: string }>; value: T; onChange: (id: T) => void; label: string;
}): React.JSX.Element {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={o.id === value} title={o.hint} onClick={() => onChange(o.id)}>{o.label}</button>
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
 *  mesh from a dead one. `.empty` (styles.css "empty, error and loading") is the shared shell. */
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
      "tech-lead": "var(--role-tech-lead)", pm: "var(--role-pm)", "product-manager": "var(--role-pm)",
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
    | { kind: "text"; label: string; placeholder?: string; /** a field of several lines (Enter makes a new one; Ctrl+Enter confirms) */ multiline?: boolean };
}

/**
 * Resolves with the typed text on confirm (`""` when nothing was required), or
 * `null` on cancel — so `if ((await confirm(…)) === null) return;` reads the
 * same way the old `if (!window.confirm(…)) return;` did.
 */
export type ConfirmFn = (req: ConfirmRequest) => Promise<string | null>;

/**
 * A dialog on rung 4 (styles.css "dialogs"): a blurred scrim, a 20px panel in 180ms, a title row with a hairline, the body, and the
 * actions at the end on a quieter band. Focus moves in, Tab stays in, Escape and the scrim close it and focus goes back to
 * what opened it (useDismissable). On a phone it is a sheet at the foot. `onSubmit` makes it a form (Enter submits); `role` is
 * `alertdialog` when it interrupts to ask. States: open, and what it holds.
 */
interface DialogProps {
  title: ReactNode; children?: ReactNode; actions?: ReactNode; onSubmit?: (e: React.FormEvent<HTMLFormElement>) => void;
  role?: "dialog" | "alertdialog"; describedBy?: string; labelId?: string;
  /** 640 wide instead of 480, for a dialog that holds a text area or a grid of choices. */
  wide?: boolean;
}

/** The dialog's panel on its own: the title row, the body and the actions band, with no scrim and no focus handling. Dialog is this
 *  inside the behaviour; the gallery draws it alone to show it. */
export function DialogPanel({ title, children, actions, onSubmit, role = "dialog", describedBy, labelId = "dialog-title", wide, panelRef }: DialogProps & { panelRef?: RefObject<HTMLDivElement | null> }): React.JSX.Element {
  // On a short screen the body scrolls under the title and the actions; a body that scrolls takes a tab stop, so a keyboard can read it.
  const body = useRef<HTMLDivElement | null>(null);
  const scrolls = useScrolls(body);
  return (
    <div className={`confirm${wide ? " wide" : ""}`} role={role} aria-modal="true" aria-labelledby={labelId} aria-describedby={describedBy} ref={panelRef}>
      <form onSubmit={onSubmit ?? ((e) => e.preventDefault())}>
        <header className="dlg-head"><h2 id={labelId}>{title}</h2></header>
        <div className="dlg-body" ref={body} tabIndex={scrolls ? 0 : undefined}>{children}</div>
        {actions ? <footer className="dlg-foot confirm-acts">{actions}</footer> : null}
      </form>
    </div>
  );
}

/** A dialog on a blurred scrim: it arrives in 180ms, keeps Tab inside it, closes on Escape or a click on the scrim, and gives the focus
 *  back to what had it. The title names it; `actions` are the band at the foot (the one to do is last, and primary). */
export function Dialog({ onClose, ...panel }: DialogProps & { onClose: () => void }): React.JSX.Element {
  const ref = useDismissable<HTMLDivElement>(true, onClose);
  return (
    <>
      <div className="confirm-scrim" onClick={onClose} />
      <DialogPanel {...panel} panelRef={ref} />
    </>
  );
}

/** A question that asks before a move that cannot be undone, or that costs something: a Dialog with a title, the sentences that say what
 *  happens, and a button that says what it does (not "OK"). `danger` makes the button red; `require` arms it only once a person has
 *  typed a name (match) or a reason (any text). The answer is the typed text, or null when cancelled. Cancel has the focus unless a
 *  field does. */
export function ConfirmDialog({ req, onResolve }: { req: ConfirmRequest; onResolve: (v: string | null) => void }): React.JSX.Element {
  const [text, setText] = useState("");
  const cancel = useCallback(() => onResolve(null), [onResolve]);
  const need = req.require;
  // A `match` guard is the point of the dialog, so it is checked exactly: no
  // case folding, only the surrounding whitespace a copy-paste drags along.
  const armed = !need ? true : need.kind === "match" ? text.trim() === need.value : text.trim().length > 0;
  const descId = "confirm-body";
  return (
    <Dialog
      title={req.title}
      role="alertdialog"
      labelId="confirm-title"
      describedBy={req.body?.length ? descId : undefined}
      onClose={cancel}
      onSubmit={(e) => {
        e.preventDefault();
        if (armed) onResolve(text.trim());
      }}
      actions={
        <>
          <Button variant="soft" onClick={cancel}>
            {req.cancelLabel ?? "Cancel"}
          </Button>
          {/* A destructive confirmation is the red fill: the one place that colour is a button. */}
          <Button variant="primary" danger={req.danger} type="submit" disabled={!armed}>
            {req.confirmLabel ?? "Confirm"}
          </Button>
        </>
      }
    >
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
          {need.kind === "text" && need.multiline ? (
            <TextArea
              value={text}
              onChange={(e) => setText(e.target.value)}
              /* Enter is a new line here, so confirming from the keyboard is Ctrl or Cmd with it. */
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && armed) {
                  e.preventDefault();
                  onResolve(text.trim());
                }
              }}
              placeholder={need.placeholder}
              rows={9}
              autoComplete="off"
              spellCheck={false}
              mono
            />
          ) : (
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={need.kind === "match" ? need.value : need.placeholder}
              /* The guard is the whole point — never let a password manager or
                 the browser's own history pre-arm it. */
              autoComplete="off"
              spellCheck={false}
              aria-describedby={need.kind === "match" ? "confirm-hint" : undefined}
            />
          )}
          {need.kind === "match" ? (
            <small id="confirm-hint" className="muted">
              {/* Says what is still missing rather than only greying the button:
                  a disabled control with no reason given is a dead end. */}
              {armed ? "matches — the action is armed" : `type ${need.value} exactly to continue`}
            </small>
          ) : null}
        </label>
      ) : null}
    </Dialog>
  );
}

/**
 * One notice, in the corner: a tone icon, a title, a line of detail, and the one action that answers it. It arrives in 180ms from
 * below and goes by itself (the store times it). `count` is how many times it fired while it was up. States: info, ok, warn, bad.
 */
export function ToastCard({ kind, title, msg, count, action }: { kind?: "ok" | "warn" | "bad" | string; title: ReactNode; msg: ReactNode; count?: number; action?: { label: string; run: () => void } }): React.JSX.Element {
  return (
    <div className={`toast ${kind ?? ""}`}>
      <Icon className="toast-ico" name={kind === "ok" ? "check" : kind === "bad" || kind === "warn" ? "alert" : "info"} size={18} />
      <div className="toast-body">
        <b>{title}{count && count > 1 ? <span className="toast-n">×{count}</span> : null}</b>
        <span className="toast-msg">{msg}</span>
        {action ? <button type="button" className="toast-act" onClick={action.run}>{action.label}</button> : null}
      </div>
    </div>
  );
}

/** The title row of a panel on the right: its name, the close button beside it (not inside the heading, so it is not read as part
 *  of the name), a hairline, and it stays put while the body scrolls. drawers.tsx's DrawerHeader is this with the store's close. */
export function DrawerHead({ children, onClose }: { children: ReactNode; onClose: () => void }): React.JSX.Element {
  return (
    <div className="drawer-head">
      <h2 id="drawer-title">{children}</h2>
      <button type="button" className="close-x" aria-label="Close panel" title="Close (Esc)" onClick={onClose}>
        <Icon name="x" size={16} />
      </button>
    </div>
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
  // An icon-only button says what it does in a tooltip, and what happened in the same place once it has.
  const tip = state === "fail" ? "The browser would not allow copying here. Select the text and copy it by hand." : state === "done" ? "Copied" : title ?? (compact ? name : undefined);
  const button = (
    <button
      type="button"
      className={compact ? "copy-btn compact" : "small copy-btn"}
      onClick={() => void go()}
      aria-label={state === "idle" && (compact || what) ? name : undefined}
      title={compact ? undefined : tip}
    >
      <Icon name={icon} size={14} />
      {compact ? null : <span>{shown}</span>}
    </button>
  );
  return (
    <>
      {compact ? <Tooltip content={tip}>{button}</Tooltip> : button}
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
