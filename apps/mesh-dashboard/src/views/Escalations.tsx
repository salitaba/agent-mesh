import { useEffect, useMemo, useRef } from "react";
import { ago } from "../format";
import { useMesh } from "../store";
import { Banner, Button, EmptyState, ErrorState, IconButton, IconTile, PageHeader, Pill, Skeleton, TabPanel, Tabs } from "../components";
import { Icon } from "../icons";
import { useMedia } from "../useMedia";
import { useMission } from "../useMission";
import { useMissionActions } from "../useMissionActions";
import { useToolApprovals } from "../useToolApprovals";
import { answerOutcome, escalationText } from "../escalation-card";
import { inboxCounts, inboxSummary, inboxTabs, orderDecisions, tabOfView, viewOfTab, type InboxTab } from "../inbox-model";
import { NotifyRow } from "../notifycontrol";
import { DecisionCard } from "./DecisionCard";
import { ToolAccess } from "./ToolAccess";
import { useDecisions, type Answered } from "./useDecisions";
import "./inbox.css";

/** How many answered cards the Done list shows before it says there are older ones. */
const DONE_SHOWN = 10;

/** Mirrors the phone tier in styles.css (the ladder's 620). */
const PHONE = "(max-width: 620px)";

/**
 * An answer given in this visit. The newest one says whether the mission moved, read from the mission's own state, so it
 * follows the top bar's chip; the older ones only say what was sent, since the state they would repeat is the same.
 */
function AnsweredRow({ a, latest, onDismiss }: { a: Answered; latest: boolean; onDismiss: () => void }): React.JSX.Element {
  const { setView } = useMesh();
  const { facts, state } = useMission();
  const actions = useMissionActions();
  const ref = useRef<HTMLLIElement | null>(null);
  // The card the operator just answered is gone from the list, and so is the button they pressed: focus lands here instead of on the page.
  // Whichever row is the newest takes focus: a fresh answer, or the next one down when the newest is dismissed.
  useEffect(() => {
    if (latest) ref.current?.focus();
  }, [latest]);
  const o = answerOutcome({ phase: state.phase, blockingDecisions: facts.blockingDecisions, primaryLabel: state.primary?.label ?? null, holds: a.holds });
  const primary = state.primary;
  return (
    <li ref={ref} tabIndex={-1} className="ib-answered" data-answered={a.id}>
      <IconTile icon="check" tone="ok" size="sm" />
      <div className="ib-answered-body">
        <b>{a.title}</b>
        <p className="ib-sent" title={a.text}>{a.text}</p>
        {latest ? (
          <p className={`ib-outcome ${o.tone}`} role="status">
            {o.text}
            {o.action && primary ? <> <Button variant="small" onClick={() => actions.run(primary.action, { inboxView: "escalations" })}>{primary.label}</Button></> : null}
            {/* Nothing more is asked of them here, and the way back to the mission is behind the menu on a phone: it is offered where the answer was sent. */}
            {!(o.action && primary) && state.phase !== "needs-you" ? <> <Button variant="small" onClick={() => setView("overview")}>Back to the Overview</Button></> : null}
          </p>
        ) : null}
      </div>
      <IconButton icon="x" label={`Dismiss the note about ${a.title}`} onClick={onDismiss} />
    </li>
  );
}

/**
 * Everything waiting on the operator, in one place: the decisions the mesh needs answered (cards that hold the mission or a
 * seat, and notices that hold nothing) and the tools its seats have asked to use. The header, the tab counts and the empty state
 * come from the same two lists, so "all clear" is only said when nothing is waiting in either.
 *
 * `escalations` and `gates` are two routes onto this one page: the second opens it on its tool section. Both routes render this
 * same component, so moving between the tabs keeps the page and its data instead of loading it again.
 */
export default function Inbox(): React.JSX.Element {
  const { view, setView, status, client, serverDown } = useMesh();
  const { facts, state } = useMission();
  const actions = useMissionActions();
  const d = useDecisions();
  const tools = useToolApprovals(client, 3000);
  // On a phone the person has come to answer a decision, and a switch for being told next time is not what they should scroll past
  // to reach it: it goes after the page's content there, and under the title everywhere else. The top bar's menu has it on every page.
  const phone = useMedia(PHONE);

  const tab = tabOfView(view);
  const counts = inboxCounts(d.list, tools.seats);
  const summary = inboxSummary(counts, { decisions: d.load, tools: tools.state }, { stale: serverDown });
  const ordered = useMemo(() => orderDecisions(d.list), [d.list]);
  const answeredIds = new Set(d.answered.map((a) => a.id));
  const done = ordered.done.filter((e) => !answeredIds.has(String(e.id)));
  // An escalated goal with no open decision is a mission halted without a card to answer (an operator freeze, or an event emitted
  // directly). The top bar says a decision is waiting; the inbox must not answer "nothing" and leave the operator in a loop.
  const haltedWithoutCard = d.load === "ready" && facts.goalStatus === "ESCALATED" && counts.blocking === 0;

  return (
    <div className="ib">
      <PageHeader title="Needs you" status={<span className={`mission-chip ${summary.tone}`}>{summary.label}</span>} lede={summary.line} />
      {phone ? null : <NotifyRow />}
      <Tabs
        idPrefix="inbox" label="What is waiting on you" value={tab}
        tabs={inboxTabs(counts).map((t) => ({ id: t.id, label: t.label, hint: t.hint, badge: t.badge, badgeHot: t.hot }))}
        onChange={(id) => setView(viewOfTab(id as InboxTab))}
      />
      <TabPanel idPrefix="inbox" id={tab}>
        {tab === "tools" ? (
          <ToolAccess seats={tools.seats} state={tools.state} reload={tools.reload} />
        ) : (
          <>
            {haltedWithoutCard ? (
              <Banner tone="warn" title="The mission is halted, but no decision is open." actions={<Button variant="banner-act" icon="play" onClick={() => void actions.resume(true)}>Resume the mission</Button>}>
                Something stopped it without raising a card to answer. Resuming wakes the agents and spend resumes against the mission budget.
              </Banner>
            ) : null}

            {d.load === "error" && !d.list.length ? (
              <ErrorState what="the decision queue" detail={`${d.loadErr ?? "The server did not answer."} There may be decisions waiting that this page cannot show.`} onRetry={d.retry} />
            ) : null}
            {d.load === "loading" && !d.list.length ? (
              <div className="dc dc-skel" role="status" aria-busy="true">
                <span className="sr-only">Loading decisions.</span>
                <div className="dc-head" aria-hidden="true"><Skeleton w={40} h={40} /><div className="dc-titles"><Skeleton w="45%" h={18} /><Skeleton w="30%" h={22} /></div></div>
                <Skeleton w="90%" h={14} />
                <Skeleton w="100%" h={36} />
              </div>
            ) : null}

            {d.load === "ready" && counts.decisions === 0 && !d.answered.length && !serverDown ? (
              <div className="card ib-empty">
                <EmptyState icon="inbox" title="No decisions are waiting" action={<Button variant="soft" icon="overview" onClick={() => setView("overview")}>Back to the Overview</Button>}>
                  A decision appears here when the team needs an answer from you: a budget runs out, the agents cannot agree, a seat stops, or an agent asks you something.
                </EmptyState>
              </div>
            ) : null}

            {d.answered.length ? (
              <section className="ib-section" aria-labelledby="ib-answered-h">
                <h3 className="group-h" id="ib-answered-h">Just answered</h3>
                <ul className="ib-answered-list">
                  {d.answered.map((a, i) => <AnsweredRow key={a.id} a={a} latest={i === 0} onDismiss={() => d.dismissAnswered(a.id)} />)}
                </ul>
              </section>
            ) : null}

            {ordered.blocking.length ? (
              <section className="ib-section" aria-labelledby="ib-blocking-h">
                <h3 className="group-h" id="ib-blocking-h">Decisions <Pill tone="neutral" dot={false}>{ordered.blocking.length}</Pill></h3>
                {ordered.blocking.map((e) => <DecisionCard key={String(e.id)} e={e} status={status} list={d.list} msgs={d.msgs} artIndex={d.artIndex} decisions={d} />)}
              </section>
            ) : null}

            {ordered.notices.length ? (
              <section className="ib-section" aria-labelledby="ib-notices-h">
                <h3 className="group-h" id="ib-notices-h">Notices <Pill tone="neutral" dot={false}>{ordered.notices.length}</Pill></h3>
                <p className="ib-hint">These hold nothing. The mission carries on whether or not you answer.</p>
                {ordered.notices.map((e) => <DecisionCard key={String(e.id)} e={e} status={status} list={d.list} msgs={d.msgs} artIndex={d.artIndex} decisions={d} />)}
              </section>
            ) : null}

            {done.length ? (
              <details className="disc ib-done">
                <summary>Done ({done.length})</summary>
                <ul>
                  {done.slice(0, DONE_SHOWN).map((e) => {
                    const t = escalationText(e, { status, msgs: d.msgs, parked: d.parked, phrase: d.phrase });
                    const how = e.status === "AUTO_RESOLVED" ? "Cleared itself" : "Answered";
                    return (
                      <li key={String(e.id)}>
                        <Icon name="check" size={14} />
                        <span className="ib-done-title">{t.title}</span>
                        <span className="muted">{how}{e.respondedAt ? ` ${ago(e.respondedAt)}` : ""}</span>
                        {typeof e.response === "string" && e.response ? <span className="muted ib-done-resp" title={e.response}>{e.response}</span> : null}
                      </li>
                    );
                  })}
                </ul>
                {done.length > DONE_SHOWN ? <p className="ib-hint">and {done.length - DONE_SHOWN} older.</p> : null}
              </details>
            ) : null}
          </>
        )}
      </TabPanel>
      {phone ? <NotifyRow atEnd /> : null}
    </div>
  );
}
