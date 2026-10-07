/* Global designer-assistant entry point: a button in the top bar on every view that
 * opens a non-modal slide-over. Shell owns `open` so the command palette can
 * open it too; the transcript lives in chatStore, so closing the panel or
 * switching views never loses the conversation.
 *
 * It used to be a floating button over the bottom-right corner of every page, where it covered the last row of whatever
 * was underneath and fought the toasts and the Designer's save bar for the same 150 pixels. In the bar it is where
 * the other actions are. */

import { useCallback, useEffect, useRef } from "react";
import ChatPanel from "./panels/ChatPanel";
import { markSeen, useChatSelector } from "./chatStore";
import { Icon } from "../icons";
import { IconButton } from "../components";
// Imported here rather than in the lazy Designer view: ChatDock is eager (it
// renders on every shell view), so the shared ms-* styles must ride the eager
// chunk or the button and panel are unstyled until Designer first loads.
import "./assistant.css";

/** The id the panel hands focus back to when it closes. */
export const DOCK_BUTTON_ID = "btn-designer";

export function ChatDockButton({ open, onToggle }: { open: boolean; onToggle: () => void }): React.JSX.Element {
  const busy = useChatSelector((s) => s.busy);
  const entryCount = useChatSelector((s) => s.entries.length);
  const seen = useChatSelector((s) => s.seen);
  const lastRole = useChatSelector((s) => s.entries[s.entries.length - 1]?.role);
  const unread = !open && !busy && entryCount > seen && lastRole === "assistant";
  return (
    <button
      id={DOCK_BUTTON_ID}
      type="button"
      className={`soft ms-dock-btn${busy ? " busy" : ""}`}
      aria-expanded={open}
      aria-controls="ms-dock"
      aria-label={open ? "Close the designer assistant" : busy ? "Ask the designer (it is thinking)" : "Ask the designer"}
      title={busy ? "The designer is thinking…" : "Ask the designer: describe a mesh or a change"}
      onClick={onToggle}
    >
      <span className="ms-dock-spark"><Icon name="spark" /></span>
      <span className="act-lbl">{busy ? "Thinking…" : "Ask designer"}</span>
      {unread ? <span className="ms-dock-unread" role="status" aria-label="new reply from the designer" /> : null}
    </button>
  );
}

export default function ChatDock({ open, onClose }: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      markSeen();
      panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else if (wasOpen.current) {
      // On a phone the button lives in the overflow menu, so its trigger takes the focus instead.
      (document.getElementById(DOCK_BUTTON_ID) ?? document.getElementById("btn-more"))?.focus();
    }
    wasOpen.current = open;
  }, [open]);

  // The shell may hand a fresh onClose each render; keep the key listener
  // subscribed to a stable wrapper instead of re-binding on every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  const close = useCallback(() => onCloseRef.current(), []);

  // The shell's key router unwinds its own layers first; Esc reaches here only
  // when nothing else claimed it, so the dock is the innermost floating layer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;
  return (
    <div
      id="ms-dock" className="ms-dock" role="dialog" aria-label="Designer assistant" ref={panelRef} tabIndex={-1}
      // From inside the panel Esc closes it at once. The shell's own Esc handler first takes focus out of a text box and leaves the panel open, which
      // made a keyboard user press it twice; the unsent message is kept (ChatPanel), so closing loses nothing.
      onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); close(); } }}
    >
      <div className="ms-dock-head">
        <b>Designer assistant</b>
        <span className="muted">It proposes; you apply to your draft and save</span>
        <IconButton icon="x" label="Close the designer assistant" size="sm" extra="ms-slide-close" onClick={onClose} />
      </div>
      <ChatPanel />
    </div>
  );
}
