/* Global designer assistant: converse with the config designer from any view.
 * Each assistant turn may carry a whole-config proposal; applying it hands the
 * model to the Designer as a pending proposal, so the draft, undo stack and
 * validation all stay owned by one place. The transcript lives in chatStore
 * (localStorage-backed), so switching views or refreshing never loses it. */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { summarizeDiff } from "../model";
import { Button, TextArea } from "../../components";
import { useMesh } from "../../store";
import { clearChat, getSnapshot, markApplied, sendMessage, setReview, setShowThinking, subscribe } from "../chatStore";
import { draft } from "../storage";
import { setPendingProposal } from "../../commands";

export default function ChatPanel(): React.JSX.Element {
  const { client, toast, setView } = useMesh();
  const { entries, busy, failed, review, applied, live, showThinking } = useSyncExternalStore(subscribe, getSnapshot);
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement | null>(null);
  /* Follow the latest turn while the reader is already at the bottom; the
   * closing panel unmounts, so reopening lands at the end instead of the top. */
  const stick = useRef(true);
  useEffect(() => {
    const el = logRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, busy, live?.text.length, live?.thinking.length, showThinking]);

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage(client, text, draft.model ?? undefined);
  };

  const apply = (i: number, proposed: any) => {
    setPendingProposal(proposed);
    markApplied(i);
    setView("designer");
    toast("designer chat", "proposal applied to the draft — review and save", "ok");
  };

  return (
    <div className="ms-panel ms-chat">
      <p className="ms-hint">
        Describe the crew or the change you want. Each answer proposes a whole mesh.yaml; applying it opens the
        Designer with the proposal in the draft, so you can review the diff before saving.
      </p>
      <div
        className="ms-chat-log"
        role="log"
        aria-live="polite"
        aria-label="designer conversation"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {entries.length === 0 ? <div className="muted">No messages yet.</div> : null}
        {entries.map((e, i) => {
          const diff = e.proposed !== undefined ? summarizeDiff(e.proposed, draft.model) : [];
          return (
            <div key={i} className={`ms-chat-msg ${e.role}`}>
              <span className="ms-chat-who">{e.role === "user" ? "You" : "Designer"}</span>
              {e.role === "assistant" && showThinking && e.thinking ? (
                <details className="ms-chat-thinking">
                  <summary>thinking</summary>
                  <pre>{e.thinking}</pre>
                </details>
              ) : null}
              {e.content}
              {e.role === "assistant" && e.problems?.length ? (
                <ul className="ms-chat-problems">
                  {e.problems.map((p, j) => <li key={j}>{p}</li>)}
                </ul>
              ) : null}
              {e.role === "assistant" && e.proposed !== undefined ? (
                <div className="ms-chat-review">
                  <div className="ms-chat-actions">
                    <Button variant="small" aria-expanded={review === i} onClick={() => setReview(review === i ? null : i)}>
                      {review === i ? "hide diff" : `review proposal (${diff.length} change${diff.length === 1 ? "" : "s"})`}
                    </Button>
                    {applied === i ? <span className="muted">applied to draft</span> : null}
                  </div>
                  {review === i ? (
                    <>
                      {diff.length ? <ul className="diff-list">{diff.map((d, j) => <li key={j}>{d}</li>)}</ul> : <div className="muted tx-meta">no itemized differences from the current draft.</div>}
                      {e.problems?.length ? <div className="verdict warn">the server flagged this proposal — applying it puts those problems in your draft.</div> : null}
                      <div className="ms-chat-actions">
                        <Button variant="primary" disabled={applied === i} onClick={() => apply(i, e.proposed)}>
                          {e.problems?.length ? "apply anyway" : "apply to draft"}
                        </Button>
                        <Button variant="ghost" onClick={() => setReview(null)}>cancel</Button>
                      </div>
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {busy && showThinking && live?.thinking ? (
          <div className="ms-chat-thinking live">
            <span className="ms-chat-who">Thinking</span>
            <pre>{live.thinking}</pre>
          </div>
        ) : null}
        {busy && live?.text ? (
          <div className="ms-chat-msg assistant live">
            <span className="ms-chat-who">Designer</span>
            {live.text}
          </div>
        ) : null}
        {busy && !live?.text && !(showThinking && live?.thinking) ? <div className="muted" role="status">designer is thinking…</div> : null}
      </div>
      {failed ? <div className="verdict bad" role="alert">{failed}</div> : null}
      <div className="ms-chat-compose">
        <TextArea
          rows={3}
          placeholder="e.g. add a security reviewer that qa must consult before release"
          aria-label="message to the designer"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="ms-chat-actions">
          <Button variant="primary" disabled={busy || !input.trim()} onClick={send}>{busy ? "waiting…" : "send"}</Button>
          <Button variant="ghost" disabled={busy || entries.length === 0} onClick={clearChat}>clear</Button>
          <label className="ms-chat-think" title="show the model's reasoning as it streams">
            <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} />
            show thinking
          </label>
          <span className="ms-chat-kbd muted" aria-hidden="true">Ctrl/⌘ + Enter sends</span>
        </div>
      </div>
    </div>
  );
}
