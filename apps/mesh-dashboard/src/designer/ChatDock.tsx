/* Global designer-assistant entry point: a floating button on every view that
 * opens a non-modal slide-over. Shell owns `open` so the command palette can
 * open it too; the transcript lives in chatStore, so closing the panel or
 * switching views never loses the conversation. */

import { useCallback, useEffect, useRef } from "react";
import ChatPanel from "./panels/ChatPanel";
import { markSeen, useChatSelector } from "./chatStore";
// Imported here rather than in the lazy Designer view: ChatDock is eager (it
// renders on every shell view), so the shared ms-* styles must ride the eager
// chunk or the floating button is unstyled until Designer first loads.
import "./designer.css";

export default function ChatDock({ open, onOpen, onClose }: {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const busy = useChatSelector((s) => s.busy);
  const entryCount = useChatSelector((s) => s.entries.length);
  const seen = useChatSelector((s) => s.seen);
  const lastRole = useChatSelector((s) => s.entries[s.entries.length - 1]?.role);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fabRef = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    if (open) {
      markSeen();
      panelRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    } else if (wasOpen.current) {
      fabRef.current?.focus();
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

  const unread = !open && !busy && entryCount > seen && lastRole === "assistant";

  return (
    <>
      <button
        ref={fabRef}
        type="button"
        className={`ms-dock-fab${busy ? " busy" : ""}`}
        aria-expanded={open}
        aria-controls="ms-dock"
        aria-label={open ? "close the designer assistant" : "ask the designer"}
        title={busy ? "The designer is thinking…" : "Ask the designer — describe a mesh or a change"}
        onClick={() => (open ? onClose() : onOpen())}
      >
        <span className="ms-dock-spark" aria-hidden="true">✦</span>
        {busy ? "thinking…" : "ask designer"}
        {unread ? <span className="ms-dock-unread" role="status" aria-label="new reply from the designer" /> : null}
      </button>
      {open ? (
        <div id="ms-dock" className="ms-dock" role="dialog" aria-label="designer assistant" ref={panelRef} tabIndex={-1}>
          <div className="ms-dock-head">
            <b>Designer assistant</b>
            <span className="muted">whole-config proposals · applied to the draft</span>
            <button type="button" className="ms-slide-close" aria-label="close designer assistant" onClick={onClose}>×</button>
          </div>
          <ChatPanel />
        </div>
      ) : null}
    </>
  );
}
