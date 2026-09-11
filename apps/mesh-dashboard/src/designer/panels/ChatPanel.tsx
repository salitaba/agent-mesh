/* Chat inspector: converse with the config designer. Each assistant turn may
 * carry a whole-config proposal; nothing touches the draft until the operator
 * reviews the diff against the current model and applies it. The transcript is
 * client-side only — the server is stateless and gets it resent each turn. */

import { useState } from "react";
import { summarizeDiff } from "../model";
import { Button, TextArea } from "../../components";
import { useMesh } from "../../store";
import type { DCtx } from "../types";

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  proposed?: any;
  problems?: string[];
}

/** Model turns can take far longer than the client's 20s default. */
const CHAT_TIMEOUT_MS = 120000;

export default function ChatPanel({ ctx, onApply }: { ctx: DCtx; onApply: (model: any) => void }): React.JSX.Element {
  const { client, toast } = useMesh();
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [review, setReview] = useState<number | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const next: ChatEntry[] = [...entries, { role: "user", content: text }];
    setEntries(next);
    setInput("");
    setFailed(null);
    setReview(null);
    setBusy(true);
    try {
      const { status, json } = await client.post(
        "/designer/chat",
        { messages: next.map(({ role, content }) => ({ role, content })), currentConfig: ctx.m },
        { timeoutMs: CHAT_TIMEOUT_MS },
      );
      if (status !== 200) {
        setFailed(json?.error || `designer chat failed (${status})`);
      } else {
        setEntries([
          ...next,
          {
            role: "assistant",
            content: typeof json?.reply === "string" ? json.reply : "",
            proposed: json?.proposedConfig,
            problems: Array.isArray(json?.problems) ? json.problems : [],
          },
        ]);
      }
    } catch {
      setFailed("designer chat failed — check the server and the model backend");
    } finally {
      setBusy(false);
    }
  };

  const apply = (i: number, proposed: any) => {
    onApply(proposed);
    setApplied(i);
    setReview(null);
    toast("designer chat", "proposal applied to the draft — review and save", "ok");
  };

  return (
    <div className="ms-panel ms-chat">
      <p className="ms-hint">
        Describe the crew or the change you want. Each answer proposes a whole mesh.yaml; the draft changes
        only after you review the diff and apply it.
      </p>
      <div className="ms-chat-log" role="log" aria-live="polite" aria-label="designer conversation">
        {entries.length === 0 ? <div className="muted">No messages yet.</div> : null}
        {entries.map((e, i) => {
          const diff = e.proposed !== undefined ? summarizeDiff(e.proposed, ctx.m) : [];
          return (
            <div key={i} className={`ms-chat-msg ${e.role}`}>
              <span className="ms-chat-who">{e.role === "user" ? "You" : "Designer"}</span>
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
        {busy ? <div className="muted" role="status">designer is thinking…</div> : null}
      </div>
      {failed ? <div className="verdict bad" role="alert">{failed}</div> : null}
      <div className="ms-chat-compose">
        <TextArea
          rows={3}
          placeholder="e.g. add a security reviewer that qa must consult before release"
          aria-label="message to the designer"
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="ms-chat-actions">
          <Button variant="primary" disabled={busy || !input.trim()} onClick={() => void send()}>{busy ? "waiting…" : "send"}</Button>
          <Button variant="ghost" disabled={busy || entries.length === 0} onClick={() => { setEntries([]); setReview(null); setApplied(null); setFailed(null); }}>
            clear
          </Button>
        </div>
      </div>
    </div>
  );
}
