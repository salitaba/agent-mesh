import { useCallback, useEffect, useRef, useState } from "react";
import type { FocusEvent as ReactFocusEvent, PointerEvent as ReactPointerEvent, UIEvent as ReactUIEvent } from "react";
import { Button, useNow } from "./components";
import { NOT_HELD, feedState, holdMark, isHolding, newCountText } from "./feed";
import { Icon } from "./icons";
import { useMesh } from "./store";
import "./feed.css";

/* The live-feed controls shared by Events and Steps. The decisions are in feed.ts (tested); this file only draws them. */

/**
 * Is the console hearing from the mesh, and how fresh is what it shows? One chip and one sentence in the page header, so a
 * screen left open on a second monitor says "Live, updated 2s ago" while it is, and says what is wrong when it is not.
 *
 * "Heard from" is the last status poll, event or steps refresh: any of them is proof the server is answering. Event timestamps
 * are not used, because a quiet mesh has old events and a perfectly good connection.
 */
export function FeedStatus(): React.JSX.Element {
  const { sseState, serverDown, status, lastSeq, steps } = useMesh();
  const now = useNow(1000);
  const heardAt = useRef(Date.now());
  useEffect(() => {
    heardAt.current = Date.now();
  }, [status, lastSeq, steps]);
  const s = feedState({ sse: sseState, serverDown, heardAt: heardAt.current, now });
  return (
    <span className="feed">
      <span className={`feed-chip ${s.tone}`} role="status">
        <i className={`dot${s.live ? " live" : ""}`} aria-hidden="true" />
        {s.label}
      </span>
      <span className="feed-meta">{s.detail}</span>
    </span>
  );
}

/** The control that freezes the list. Events keep arriving while it is held; they are counted, never dropped. */
export function PauseButton({ paused, onToggle, noun }: { paused: boolean; onToggle: () => void; noun: "events" | "turns" }): React.JSX.Element {
  return (
    <Button
      variant="soft"
      icon={paused ? "play" : "pause"}
      aria-pressed={paused}
      title={paused ? `Show ${noun} as they arrive again` : `Freeze the list so rows stop moving. New ${noun} keep arriving and are counted, not lost.`}
      onClick={onToggle}
    >
      {paused ? "Resume" : "Pause"}
    </Button>
  );
}

/**
 * What a held list owes the reader: that it is held, and how much is waiting behind it. Silent when nothing is held and nothing
 * has arrived. `onShow` releases the hold and brings the newest rows into view.
 */
export function HoldBar({ paused, fresh, noun, onShow }: { paused: boolean; fresh: number; noun: "event" | "turn"; onShow: () => void }): React.JSX.Element | null {
  if (!paused && fresh === 0) return null;
  // Paused says so and says what is waiting; a hold from pointing or scrolling only owes the count.
  const text = paused ? (fresh > 0 ? `${newCountText(fresh, noun)} waiting.` : "Nothing new yet.") : `${newCountText(fresh, noun)}.`;
  return (
    <div className={`feed-hold${paused ? " paused" : ""}`}>
      <Icon name={paused ? "pause" : "arrow-down"} size={14} />
      <span className="feed-hold-text">
        {paused ? <b>Paused.</b> : null} {text}
      </span>
      <Button variant="small" onClick={onShow}>{paused ? "Resume" : "Show"}</Button>
    </div>
  );
}

export interface FeedHold {
  paused: boolean;
  setPaused: (on: boolean) => void;
  /** The newest key that was on screen when the hold began, or null when nothing is held. */
  mark: number | null;
  /** Spread on the element that scrolls, or the one that wraps the rows. */
  listProps: {
    onPointerEnter: (e: ReactPointerEvent<HTMLElement>) => void;
    onPointerLeave: () => void;
    onFocus: () => void;
    onBlur: (e: ReactFocusEvent<HTMLElement>) => void;
    onScroll: (e: ReactUIEvent<HTMLElement>) => void;
  };
  /** Drop every hold. The caller scrolls the list to its newest end. */
  release: () => void;
}

/**
 * Four reasons to hold a list still: the reader paused it, scrolled away from the newest end, is pointing at it, or has focus on
 * a row. Any one freezes the set of rows (feed.ts `heldList`); when the last ends, everything that arrived is there.
 *
 * `newest` is the newest key among ALL rows, not the filtered ones: the mark is a place in the stream, and a filter changing
 * under a hold must not move it.
 */
export function useFeedHold(newest: number, opts: { scroll?: boolean } = {}): FeedHold {
  const [paused, setPaused] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [mark, setMark] = useState<number | null>(null);
  const holding = isHolding({ ...NOT_HELD, paused, scrolled: scrolled && opts.scroll !== false, pointer, focus });
  // Derived during render: a row arriving between a reason starting and an effect running would shift the list once.
  const next = holdMark(mark, holding, newest);
  if (next !== mark) setMark(next);

  const release = useCallback(() => {
    setPaused(false);
    setScrolled(false);
    setPointer(false);
    setFocus(false);
  }, []);

  const listProps: FeedHold["listProps"] = {
    // A finger is not "pointing at" a list: only a mouse hovers.
    onPointerEnter: (e) => { if (e.pointerType === "mouse") setPointer(true); },
    onPointerLeave: () => setPointer(false),
    onFocus: () => setFocus(true),
    onBlur: (e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false); },
    onScroll: (e) => setScrolled(e.currentTarget.scrollTop > 24),
  };
  return { paused, setPaused, mark, listProps, release };
}
