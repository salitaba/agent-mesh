import { useState } from "react";
import { ago, fmt, fmtBudget } from "../format";
import { Button, Input } from "../components";
import { Icon } from "../icons";
import { AgentDrawer, ArtifactDrawer } from "../drawers";
import { useMesh } from "../store";
import {
  answerPlan, capTarget, cardKind, escAgents, escalationText, holdsOf, openSupports, plainTaskOf, resolveArtifactId, shortArt, stuckInfoOf,
  raisedByLabel, type AnswerPlan, type BudgetInfo, type EscalationLike,
} from "../escalation-card";
import { Bar } from "./Meter";
import { draftGet, draftSet, type Decisions } from "./useDecisions";
import "./inbox.css";

/** The files an escalation hangs on, as buttons that open them when they resolve and as plain names when they do not. */
function EvidenceRefs({ uris, artIndex, label }: { uris: string[]; artIndex: any[]; label?: string }): React.JSX.Element | null {
  const { openDrawer } = useMesh();
  if (!uris.length) return null;
  return (
    <div className="dc-refs">
      <span>{label ?? (uris.length > 1 ? "Files" : "File")}:</span>
      {uris.map((uri, i) => {
        const id = resolveArtifactId(artIndex, uri);
        const label = shortArt(uri);
        return id
          ? <Button key={`${uri}-${i}`} variant="small" title={uri} onClick={() => openDrawer(<ArtifactDrawer id={id} />)}>{label}</Button>
          : <code key={`${uri}-${i}`} title={uri}>{label}</code>;
      })}
    </div>
  );
}

/** A budget as a figure and a bar. Over the limit says by how much. */
function BudgetMeter({ b }: { b: BudgetInfo }): React.JSX.Element {
  const consumed = typeof b.consumed === "number" ? b.consumed : 0;
  const limit = typeof b.limit === "number" ? b.limit : 0;
  const over = limit > 0 ? consumed - limit : 0;
  const unitWord = b.unit === "minutes" ? "" : b.unit === "events" ? " events" : " tokens";
  const pct = limit > 0 ? Math.min(100, Math.round((consumed / limit) * 100)) : 100;
  return (
    <div className="dc-meter">
      <div className="dc-meter-line">
        <span><b>{fmtBudget(consumed, b.unit)}</b> <span className="muted">of {fmtBudget(limit, b.unit)}{unitWord}</span></span>
        <span className="muted">{over > 0 ? `over by ${b.unit === "minutes" ? fmtBudget(over, b.unit) : fmt(over)}` : `${pct}%`}</span>
      </div>
      <Bar value={consumed} max={limit || 1} label={b.agent ? `${b.agent}'s budget spent` : "Budget spent"} tone="bad" />
    </div>
  );
}

/* ------------------------------ the answers ------------------------------- */

interface AnswerProps {
  e: EscalationLike;
  plan: AnswerPlan;
  /** This card's answer is being sent. */
  busy: boolean;
  /** Some other card's answer is being sent: one at a time. */
  otherBusy: boolean;
}

/** A typed answer and the one button that sends it. Used by every card whose answer is words. */
function TextAnswer({ e, plan, busy, otherBusy, suggestion, onSend, children }: AnswerProps & { suggestion?: string; onSend: (text: string) => void; children?: React.ReactNode }): React.JSX.Element {
  const id = String(e.id);
  const [text, setText] = useState(() => draftGet(id));
  const write = (v: string): void => {
    setText(v);
    draftSet(id, v);
  };
  const required = plan.text?.required ?? false;
  const empty = !text.trim();
  const blocked = busy || otherBusy || (required && empty);
  const label = plan.primaryWithText && !empty ? plan.primaryWithText : plan.primary.label;
  return (
    <form
      className="respond-form dc-answer" data-id={id} id={`respond-form-${id}`}
      onSubmit={(ev) => {
        ev.preventDefault();
        if (!blocked) onSend(text.trim() || plan.emptyText || "");
      }}
    >
      <label className="dc-label" htmlFor={`dc-${id}-text`}>{plan.text?.label}</label>
      <Input id={`dc-${id}-text`} value={text} onChange={(ev) => write(ev.currentTarget.value)} placeholder={plan.text?.placeholder} disabled={busy} aria-required={required} />
      <div className="dc-acts">
        <Button variant="primary" type="submit" disabled={blocked}>{busy ? "Sending…" : label}</Button>
        {/* A suggestion is something you choose: it is never pre-typed, so sending always needs a deliberate act. */}
        {suggestion && text !== suggestion ? <Button variant="small" title="Fill the box with the suggested answer. You can still edit it." disabled={busy} onClick={() => write(suggestion)}>Use the suggested answer</Button> : null}
        {children}
      </div>
      <p className="dc-cons">{plan.consequence}</p>
    </form>
  );
}

/** A token budget: one click adds half again, with the alternatives beside it, and a note the agents read. */
function BudgetAnswer({ e, plan, budget, busy, otherBusy, raiseBusy, onRaise, onRespond }: AnswerProps & {
  budget: BudgetInfo; raiseBusy: boolean;
  onRaise: (key: string, limit: number, note: string, ask: boolean) => void;
  onRespond: (note: string) => void;
}): React.JSX.Element {
  const id = String(e.id);
  const [note, setNote] = useState(() => draftGet(id));
  const [custom, setCustom] = useState(!plan.raise);
  const [value, setValue] = useState("");
  const write = (v: string): void => {
    setNote(v);
    draftSet(id, v);
  };
  const off = busy || otherBusy || raiseBusy;
  const key = budget.key as string;
  const current = typeof budget.limit === "number" ? budget.limit : 0;
  const wanted = Number(value);
  const valid = Number.isFinite(wanted) && wanted > current;
  return (
    <form className="respond-form dc-answer" data-id={id} id={`respond-form-${id}`} onSubmit={(ev) => { ev.preventDefault(); if (plan.raise && !off) onRaise(key, plan.raise.limit, note, true); }}>
      <div className="dc-acts">
        {plan.raise ? (
          <>
            <Button variant="primary" type="submit" icon="plus" disabled={off}>{raiseBusy ? "Raising…" : plan.primary.label}</Button>
            <Button variant="small" disabled={off} onClick={() => onRaise(key, plan.raise!.doubleLimit, note, true)}>{plan.raise.doubleLabel}</Button>
            <Button variant="small" aria-expanded={custom} disabled={off} onClick={() => setCustom(!custom)}>Set a limit</Button>
          </>
        ) : null}
      </div>
      {custom ? (
        <div className="dc-row">
          <label className="dc-label" htmlFor={`dc-${id}-limit`}>New limit, in tokens</label>
          <Input id={`dc-${id}-limit`} type="number" inputMode="numeric" min={current + 1} step={1000} mono value={value} onChange={(ev) => setValue(ev.currentTarget.value)} placeholder={current ? String(Math.ceil(current * 1.5)) : "e.g. 3000000"} aria-invalid={value !== "" && !valid} aria-describedby={`dc-${id}-limit-hint`} />
          <Button variant="small" disabled={off || !valid} onClick={() => onRaise(key, Math.floor(wanted), note, false)}>{`Set it${plan.primary.label.endsWith("and resume") ? " and resume" : ""}`}</Button>
          <span id={`dc-${id}-limit-hint`} className="dc-hint">{value !== "" && !valid ? `Enter a limit above the current ${fmt(current)}.` : ""}</span>
        </div>
      ) : null}
      <label className="dc-label" htmlFor={`dc-${id}-note`}>{plan.text?.label}</label>
      <Input id={`dc-${id}-note`} value={note} onChange={(ev) => write(ev.currentTarget.value)} placeholder={plan.text?.placeholder} disabled={busy} />
      <p className="dc-cons">{plan.consequence}</p>
      <Button variant="linklike" disabled={off || !note.trim()} title={note.trim() ? "Record this note without changing the limit" : "Write a note for the agents first"} onClick={() => onRespond(note)}>Respond without adding tokens</Button>
    </form>
  );
}

/** The host's ceiling is raised in host settings; the card is cleared here afterwards. */
function CeilingAnswer({ e, plan, busy, otherBusy, onSettings, onSend }: AnswerProps & { onSettings: () => void; onSend: (text: string) => void }): React.JSX.Element {
  const id = String(e.id);
  const [note, setNote] = useState(() => draftGet(id));
  const write = (v: string): void => {
    setNote(v);
    draftSet(id, v);
  };
  const off = busy || otherBusy;
  return (
    <form className="respond-form dc-answer" data-id={id} id={`respond-form-${id}`} onSubmit={(ev) => { ev.preventDefault(); if (!off) onSend(note.trim() || "ceiling raised"); }}>
      <div className="dc-acts">
        <Button variant="primary" icon="sliders" onClick={onSettings}>{plan.primary.label}</Button>
      </div>
      <label className="dc-label" htmlFor={`dc-${id}-note`}>{plan.text?.label}</label>
      <Input id={`dc-${id}-note`} value={note} onChange={(ev) => write(ev.currentTarget.value)} placeholder={plan.text?.placeholder} disabled={busy} />
      <div className="dc-acts"><Button variant="soft" type="submit" disabled={off}>{busy ? "Sending…" : plan.secondary?.label}</Button></div>
      <p className="dc-cons">{plan.consequence}</p>
    </form>
  );
}

/* -------------------------------- the card -------------------------------- */

export interface DecisionCardProps {
  e: EscalationLike;
  status: any;
  list: any[];
  msgs: Map<string, any>;
  artIndex: any[];
  decisions: Decisions;
}

/**
 * One missing answer. What is being asked and what it holds up; the context (the request, the files, who is involved); then
 * one answer, whatever kind of card it is. The pattern does not change between a budget and a stalled request, only the words,
 * and the words are chosen from state in `answerPlan` so they stay true when the project is parked or the card is a notice.
 */
export function DecisionCard({ e, status, list, msgs, artIndex, decisions: d }: DecisionCardProps): React.JSX.Element {
  const { openDrawer, setView, setEvSearch, setEvFilter } = useMesh();
  const id = String(e.id);
  const parked = d.parked;
  // `null` is "no host to ask": the card keeps its original claims. `false` is a ceiling raised past the spend.
  const ceilingRaised = d.ceilingTripped === false;
  const text = escalationText(e, { status, msgs, parked, phrase: d.phrase, ceilingRaised });
  const budget = text.budget;
  const kind = cardKind(e, budget);
  const holds = holdsOf(e);
  const agents = escAgents(e);
  const detail = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, any>;
  const stuck = kind === "stuck" || kind === "derived" ? stuckInfoOf(e, msgs) : null;
  const reqMsg = stuck?.requestId ? msgs.get(stuck.requestId) : undefined;
  const supports = kind === "derived" ? openSupports(e, list) : [];
  const ledger = budget?.key ? (status?.budgets || []).find((b: any) => b.key === budget.key) : undefined;
  const limit = typeof ledger?.limit === "number" ? ledger.limit : budget?.limit;
  const plan = answerPlan({
    kind, parked, holds, budget, limit,
    capTarget: budget?.configCap ? capTarget(budget.configCap, budget, status) : undefined,
    supports: supports.length, asker: stuck?.askerId, placeholder: text.placeholder, ceilingRaised,
  });
  const busy = d.busy === id;
  const otherBusy = d.busy !== null && !busy;
  const raiseBusy = d.raiseBusy !== null && d.raiseBusy.startsWith(id);
  const tone = holds.scope === "mission" ? "bad" : holds.scope === "seat" ? "warn" : "info";
  const disUri = detail.disagreementRef?.uri || (e as { disagreementArtifactRef?: { uri?: string } }).disagreementArtifactRef?.uri;
  const who = raisedByLabel(e.raisedBy);
  const requestFiles: string[] = (Array.isArray(reqMsg?.artifactRefs) ? reqMsg.artifactRefs : []).map((r: any) => String(r?.uri || "")).filter(Boolean);
  const showWhat = kind !== "stuck" && text.what.trim() !== text.title.trim();
  const openThread = (): void => {
    if (reqMsg?.threadId) {
      setEvSearch(reqMsg.threadId);
      setEvFilter("");
      setView("events");
    }
  };
  const skip = plan.skip && stuck
    ? <Button variant="small" danger extra="dc-skip" disabled={busy || otherBusy} title="Drop this request: the waiting agent carries on without an answer" onClick={() => void d.skip(e, text.title, stuck.requestLabel, { label: plan.skip!.reasonLabel, placeholder: plan.skip!.reasonPlaceholder })}>{plan.skip.label}</Button>
    : null;
  const suggestion = kind === "stuck" && text.placeholder ? text.placeholder : "";

  return (
    <article className={`dc ${tone}`} data-esc={id} aria-labelledby={`dc-${id}-t`}>
      <header className="dc-head">
        <span className={`dc-ico ${tone}`}><Icon name={kind === "notice" ? "info" : "alert"} size={18} /></span>
        <div className="dc-titles">
          <h4 id={`dc-${id}-t`}>{text.title}</h4>
          <p className="dc-meta">
            <span className={`dc-holds ${holds.scope}`} title={holds.scope === "mission" ? "The mission is halted until this is answered." : holds.scope === "seat" ? "Only this seat is parked. The rest of the mesh keeps working." : "The mission carries on whether or not this is answered."}>
              {holds.scope === "mission" ? "Holds the mission" : holds.scope === "seat" ? `Holds ${holds.seat}` : "Notice: holds nothing"}
            </span>
            <span>{stuck?.age ? stuck.age : `Raised by ${who} ${ago(e.createdAt)}`}</span>
          </p>
        </div>
      </header>

      {showWhat ? <p className="dc-what">{text.what}</p> : null}
      {budget && (budget.consumed || budget.limit) ? <BudgetMeter b={budget} /> : null}

      {stuck && kind === "stuck" ? (
        <div className="dc-ask">
          <p><b>{stuck.askerId || "Someone"}</b> is waiting for <b>{stuck.agentId || "an agent"}</b> to answer:</p>
          <p className="dc-ask-what">{stuck.requestLabel.slice(0, 280)}</p>
          <EvidenceRefs uris={requestFiles} artIndex={artIndex} />
        </div>
      ) : null}

      {kind === "derived" ? (
        <div className="dc-ask">
          <p><b>{supports.length ? `Waiting on ${supports.length}:` : "Nothing is waiting any more."}</b>{supports.length ? "" : " Every request this summary covered has been answered. The mesh retires this card on its own within a few seconds; answering clears it at once."}</p>
          <ul className="dc-supports">
            {supports.map(({ id: sid, esc }) => {
              const dd = (esc.detail && typeof esc.detail === "object" ? esc.detail : {}) as Record<string, any>;
              const m = typeof dd.requestMessageId === "string" ? msgs.get(dd.requestMessageId) : undefined;
              const desc = typeof dd.description === "string" ? dd.description.trim() : "";
              const title = m ? plainTaskOf(m, dd.requestType).title : desc || plainTaskOf(m, dd.requestType).title;
              const participants = Array.isArray(dd.participants) ? dd.participants.filter((p: any) => typeof p === "string") : [];
              const who2 = dd.agentId ? `needs ${dd.agentId}` : participants.length > 0 ? participants.join(", ") : "waiting";
              return (
                <li key={sid}>
                  <span>{title} <span className="muted">· {who2}</span></span>
                  <Button variant="small" onClick={() => document.querySelector(`[data-esc="${CSS.escape(sid)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>Jump to it</Button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {kind !== "stuck" && kind !== "derived" && (agents.length || disUri) ? (
        <div className="dc-context">
          {agents.length ? (
            <div className="dc-refs">
              <span>Involves:</span>
              {agents.map((a) => <button key={a} type="button" className="chip-toggle" onClick={() => openDrawer(<AgentDrawer id={a} />)}>{a}</button>)}
            </div>
          ) : null}
          {disUri ? <EvidenceRefs uris={[String(disUri)]} artIndex={artIndex} label="Decision record" /> : null}
        </div>
      ) : null}

      {text.next ? <p className="dc-next">{text.next}</p> : null}

      {kind === "stuck" || kind === "decision" || kind === "derived" || kind === "notice" || (kind === "ceiling" && plan.primary.id === "respond") ? (
        <TextAnswer
          e={e} plan={plan} busy={busy} otherBusy={otherBusy} suggestion={suggestion}
          onSend={(t) => void (kind === "stuck" ? d.answer(e, text.title, t) : d.respond(e, text.title, t))}
        >
          {kind === "stuck" && reqMsg?.threadId ? <Button variant="small" onClick={openThread}>See the full thread</Button> : null}
          {skip}
        </TextAnswer>
      ) : null}
      {kind === "budget" && budget ? (
        <BudgetAnswer
          e={e} plan={plan} budget={budget} busy={busy} otherBusy={otherBusy} raiseBusy={raiseBusy}
          onRaise={(key, lim, note, ask) => void d.raise(e, text.title, key, lim, note, ask)}
          onRespond={(note) => void d.respond(e, text.title, note)}
        />
      ) : null}
      {kind === "cap" && budget ? (
        <div className="respond-form dc-answer" data-id={id} id={`respond-form-${id}`}>
          <div className="dc-acts">
            <Button variant="primary" icon="plus" data-cap-raise={budget.configCap} disabled={busy || otherBusy || raiseBusy} onClick={() => void d.raiseCap(e, text.title, budget)}>{raiseBusy ? "Raising…" : plan.primary.label}</Button>
          </div>
          <p className="dc-cons">{plan.consequence}</p>
        </div>
      ) : null}
      {kind === "ceiling" && plan.primary.id === "open-settings" ? (
        <CeilingAnswer e={e} plan={plan} busy={busy} otherBusy={otherBusy} onSettings={() => setView("hostsettings")} onSend={(t) => void d.respond(e, text.title, t)} />
      ) : null}

      <details className="esc-raw dc-tech">
        <summary>Technical details</summary>
        <pre>{JSON.stringify({ id, reason: e.reason, raisedBy: e.raisedBy, conflictKey: e.conflictKey, detail: e.detail }, null, 2).slice(0, 2000)}</pre>
        <div className="dc-acts">
          <Button variant="small" icon="copy" onClick={() => void d.copyId(id)}>Copy id</Button>
          <Button variant="small" onClick={() => { setEvSearch(id); setEvFilter(""); setView("events"); }}>Related events</Button>
        </div>
      </details>
    </article>
  );
}
