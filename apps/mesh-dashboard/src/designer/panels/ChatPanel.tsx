/* Global designer assistant: converse with the config designer from any view.
 * Each assistant turn may carry a whole-config proposal; applying it hands the
 * model to the Designer as a pending proposal, so the draft, undo stack and
 * validation all stay owned by one place. The transcript lives in chatStore
 * (localStorage-backed), so switching views or refreshing never loses it. */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { parse as parseYaml } from "yaml";
import type { StagedMutation } from "@mesh/protocol";
import { summarizeDiff } from "../diff";
import { confirmationFor, confirmationSatisfied, goalDriftWarning, showsTextProposal, splitByTarget, summarizeMutation, type LiveMission } from "../mutations";
import { Button, Input, TextArea } from "../../components";
import { useMesh } from "../../store";
import { clearChat, getSnapshot, markApplied, sendMessage, setReview, setShowThinking, stopTurn, subscribe } from "../chatStore";
import { getDraftSnapshot, type DraftState } from "../storage";
import { list as listCommands, setPendingProposal } from "../../commands";

/* Diffs are pure but not cheap; streamed tokens re-render the panel on every
 * delta, so cache each proposal's diff until the draft store commits again. */
const DIFF_CACHE = new WeakMap<object, { snapshot: DraftState; diff: string[] }>();
function proposalDiff(proposed: any, snapshot: DraftState): string[] {
  if (proposed === null || (typeof proposed !== "object" && typeof proposed !== "function")) return summarizeDiff(proposed, snapshot.model);
  const hit = DIFF_CACHE.get(proposed);
  if (hit && hit.snapshot === snapshot) return hit.diff;
  const diff = summarizeDiff(proposed, snapshot.model);
  DIFF_CACHE.set(proposed, { snapshot, diff });
  return diff;
}

/** What was typed and not sent, kept while the page lives: closing the panel (Esc) must not throw a half-written message away. */
let UNSENT = "";

/** Undo the Designer's last step, when the Designer is on the page to do it. */
const designerUndo = (): (() => void) | null => {
  const cmd = listCommands().find((c) => c.id === "designer.undo");
  return cmd ? () => cmd.run() : null;
};

export default function ChatPanel(): React.JSX.Element {
  const { client, toast, setView, status } = useMesh();
  const { entries, busy, failed, review, applied, live, showThinking } = useSyncExternalStore(subscribe, getSnapshot);
  /* The mission as it is actually RUNNING, for the draft card's drift warning.
   * Note `live` above is the streaming reply, not the live mesh. Memoized on
   * the goal identity because /status re-polls every few seconds and this maps
   * an array, while streamed tokens re-render the panel on every delta. */
  const mission: LiveMission | null = useMemo(() => {
    const g = status?.goal;
    if (!g) return null;
    return {
      description: String(g.description ?? ""),
      criteria: (g.acceptanceCriteria ?? []).map((c: any) => ({ id: String(c?.id ?? ""), description: String(c?.description ?? "") })),
    };
  }, [status?.goal]);
  const [input, setInputState] = useState(UNSENT);
  const setInput = (v: string): void => { UNSENT = v; setInputState(v); };
  /* Per-entry state for the live-run card: the typed confirmation, and the
   * server's own report. Local rather than in chatStore on purpose — applying
   * to a running mesh is an action taken now, not part of the transcript that
   * gets replayed from localStorage on the next load. */
  const [confirmText, setConfirmText] = useState<Record<number, string>>({});
  const [runApply, setRunApply] = useState<Record<number, { busy: boolean; ok?: boolean; msg: string }>>({});
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
    void sendMessage(client, text, getDraftSnapshot().model ?? undefined);
  };

  const apply = (i: number, proposed: any) => {
    setPendingProposal(proposed);
    markApplied(i);
    setView("designer");
    toast("Draft updated", "The proposal is in your draft. Nothing is saved yet.", "ok");
  };

  /* A staged config.replace carries YAML; the Designer's draft path wants a
   * parsed model. Translating here is what keeps `applyChatProposal`'s
   * next.agents / mesh.id assumptions in the one branch that already had them. */
  const applyStagedDraft = (i: number, mutations: StagedMutation[]) => {
    const rep = mutations.find((m) => m.kind === "config.replace");
    if (!rep || rep.kind !== "config.replace") return;
    let model: any;
    try {
      model = parseYaml(rep.yaml);
    } catch (err) {
      toast("Nothing applied", `The proposed YAML does not parse (${err instanceof Error ? err.message : String(err)}).`, "bad");
      return;
    }
    apply(i, model);
  };

  /* The other target, and the one that must never reach commitDraft: these go
   * to the server, which re-checks every refusal in front of the operator. */
  const applyToRun = async (i: number, mutations: StagedMutation[]) => {
    setRunApply((s) => ({ ...s, [i]: { busy: true, msg: "" } }));
    // `confirmId` is what the server checks for a `mission.reset`, and the only
    // thing it can check: the reason on that mutation is written by the agent,
    // so it distinguishes a proposal from a stray replay and nothing more. The
    // card asked for the mesh id; hand over exactly what was typed rather than
    // re-deriving it, so the two comparisons can never disagree.
    const res = await client.post("/designer/staged/apply", { mutations, confirmId: confirmText[i] ?? "" });
    const report = res.json;
    const ok = res.status === 200 && report?.ok === true;
    /* Report the server's own sentences, not an HTTP code: a refusal here is a
     * deliberate policy answer and the operator needs to read why. */
    const details: string[] = Array.isArray(report?.results)
      ? report.results.filter((r: any) => r && r.ok === false).map((r: any) => `${r.kind}: ${r.detail}`)
      : [];
    const msg = ok
      ? `applied ${report?.applied ?? mutations.length} change${(report?.applied ?? mutations.length) === 1 ? "" : "s"} to the running mesh`
      : details.length
        ? `${report?.applied ?? 0} of ${mutations.length} applied — ${details.join("; ")}`
        : `the server refused this apply (HTTP ${res.status})`;
    setRunApply((s) => ({ ...s, [i]: { busy: false, ok, msg } }));
    toast(ok ? "Mission updated" : "Not everything applied", msg, ok ? "ok" : "bad");
  };

  return (
    <div className="ms-panel ms-chat">
      <p className="ms-hint">
        Describe the team or the change you want. The designer answers with a proposal for the whole team. Nothing changes until you apply it,
        and applying it changes only your draft in the Designer: you review it there and save it yourself.
      </p>
      <div
        className="ms-chat-log"
        role="log"
        aria-live="polite"
        aria-label="Designer conversation"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {entries.length === 0 ? <div className="muted">No messages yet. Try: add a security reviewer, or describe the team you want in a sentence.</div> : null}
        {entries.map((e, i) => {
          const staged = e.proposal ?? null;
          const split = staged ? splitByTarget(staged.mutations) : { draft: [] as StagedMutation[], server: [] as StagedMutation[] };
          const ctx = { model: getDraftSnapshot().model };
          const drift = goalDriftWarning(split.draft, mission);
          /* Both proposal formats ride the same reply for one release. The text
           * one is surfaced only when the staged buffer carries no
           * config.replace, so a turn never shows two whole-config proposals. */
          const showText = e.proposed !== undefined && showsTextProposal(staged);
          const diff = showText ? proposalDiff(e.proposed, getDraftSnapshot()) : [];
          const draftLines = split.draft.flatMap((m) => summarizeMutation(m, ctx));
          const runLines = split.server.flatMap((m) => summarizeMutation(m, ctx));
          const runConfirmation = confirmationFor(split.server, String(status?.meshId ?? ""));
          const confirmed = confirmationSatisfied(runConfirmation, confirmText[i] ?? "");
          const changes = diff.length + draftLines.length + runLines.length;
          const cards = (showText ? 1 : 0) + (split.draft.length ? 1 : 0) + (split.server.length ? 1 : 0);
          const run = runApply[i];
          return (
            <div key={e.id} className={`ms-chat-msg ${e.role}`}>
              <span className="ms-chat-who">{e.role === "user" ? "You" : "Designer"}</span>
              {e.role === "assistant" && showThinking && e.thinking ? (
                <details className="ms-chat-thinking">
                  <summary>Thinking</summary>
                  <pre>{e.thinking}</pre>
                </details>
              ) : null}
              {e.content}
              {e.role === "assistant" && e.stopped ? (
                <div className="muted tx-meta ms-chat-stopped">Stopped. Above is what the model had written when you stopped it.</div>
              ) : null}
              {e.role === "assistant" && e.problems?.length ? (
                <ul className="ms-chat-problems">
                  {e.problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              ) : null}
              {e.role === "assistant" && cards > 0 ? (
                <div className="ms-chat-review">
                  <div className="ms-chat-actions">
                    <Button variant="small" aria-expanded={review === i} onClick={() => setReview(review === i ? null : i)}>
                      {review === i ? "Hide review" : `Review proposal (${changes} change${changes === 1 ? "" : "s"})`}
                    </Button>
                    {applied === i ? (
                      <>
                        <span className="muted">Applied to your draft.</span>
                        {designerUndo() ? <Button variant="small" onClick={() => designerUndo()?.()}>Undo</Button> : null}
                      </>
                    ) : null}
                  </div>
                  {review === i ? (
                    <>
                      {e.problems?.length ? <div className="verdict warn">The server flagged this proposal. Applying it puts those problems in your draft.</div> : null}
                      {staged?.problems?.length ? (
                        <div className="verdict warn">The designer could not stage everything: {staged.problems.join("; ")}</div>
                      ) : null}

                      {showText ? (
                        <div className="ms-chat-card draft">
                          <div className="tx-meta">Draft change: in this browser only, until you save</div>
                          <div className="muted tx-meta">It replaces your current draft, and you can undo that. mesh.yaml is not written until you save, and the running mission does not change until you apply or restart after saving.</div>
                          {diff.length ? <ul className="diff-list">{diff.map((d) => <li key={d}>{d}</li>)}</ul> : <div className="muted tx-meta">No itemized differences from the current draft.</div>}
                          <div className="ms-chat-actions">
                            <Button variant="primary" disabled={applied === i} onClick={() => apply(i, e.proposed)}>
                              {e.problems?.length ? "Apply anyway" : "Apply to draft"}
                            </Button>
                          </div>
                        </div>
                      ) : null}

                      {split.draft.length ? (
                        <div className="ms-chat-card draft">
                          <div className="tx-meta">Draft change: in this browser only, until you save</div>
                          <div className="muted tx-meta">It replaces your current draft, and you can undo that. mesh.yaml is not written until you save, and the running mission does not change until you apply or restart after saving.</div>
                          {drift ? <div className="verdict warn">{drift}</div> : null}
                          <ul className="diff-list">{draftLines.map((d, k) => <li key={`d${k}-${d}`}>{d}</li>)}</ul>
                          <div className="ms-chat-actions">
                            <Button variant="primary" disabled={applied === i} onClick={() => applyStagedDraft(i, split.draft)}>Apply to draft</Button>
                          </div>
                        </div>
                      ) : null}

                      {split.server.length ? (
                        <div className="ms-chat-card server">
                          <div className="verdict warn">Live change: it applies to the running mission now, with no Save step.</div>
                          <ul className="diff-list">{runLines.map((d, k) => <li key={`s${k}-${d}`}>{d}</li>)}</ul>
                          {runConfirmation ? (
                            <div className="ms-chat-confirm">
                              <div className="verdict bad">{runConfirmation.prompt}</div>
                              <Input
                                value={confirmText[i] ?? ""}
                                onChange={(ev) => setConfirmText((c) => ({ ...c, [i]: ev.target.value }))}
                                placeholder={runConfirmation.word}
                                aria-label={`Type ${runConfirmation.word} to confirm a destructive change`}
                              />
                            </div>
                          ) : null}
                          <div className="ms-chat-actions">
                            <Button variant="primary" disabled={run?.busy === true || run?.ok === true || !confirmed} onClick={() => void applyToRun(i, split.server)}>
                              {run?.busy ? "Applying…" : "Apply to the running mission"}
                            </Button>
                          </div>
                          {run && !run.busy && run.msg ? <div className={`verdict ${run.ok ? "ok" : "bad"}`}>{run.msg}</div> : null}
                        </div>
                      ) : null}

                      <div className="ms-chat-actions">
                        <Button variant="ghost" onClick={() => setReview(null)}>Cancel</Button>
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
        {busy && !live?.text && !(showThinking && live?.thinking) ? (
          <div className="muted ms-chat-waiting" role="status">
            The designer is thinking…
            <Button variant="ghost" onClick={() => stopTurn(client)}>Stop</Button>
          </div>
        ) : null}
      </div>
      {failed ? <div className="verdict bad" role="alert">{failed}</div> : null}
      <div className="ms-chat-compose">
        <TextArea
          rows={3}
          placeholder="For example: add a security reviewer that qa must consult before release"
          aria-label="Message to the designer"
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
          <Button variant="primary" disabled={busy || !input.trim()} onClick={send}>{busy ? "Waiting…" : "Send"}</Button>
          <Button variant="ghost" disabled={!busy} onClick={() => stopTurn(client)} title="End this turn and keep what the model has written">Stop</Button>
          <Button variant="ghost" disabled={busy || entries.length === 0} onClick={clearChat}>Clear</Button>
          <label className="ms-chat-think" title="show the model's reasoning as it streams">
            <input type="checkbox" checked={showThinking} onChange={(e) => setShowThinking(e.target.checked)} />
            Show thinking
          </label>
          <span className="ms-chat-kbd muted">Ctrl or Cmd and Enter sends</span>
        </div>
      </div>
    </div>
  );
}
