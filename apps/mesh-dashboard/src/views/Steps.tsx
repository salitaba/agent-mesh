import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ago, dur, fmt, localTime, plainBlocker, plainReason, plural, refusalSummary, outcomeOf, zoneLabel, OUTCOME_META, type Outcome } from "../format";
import { useMesh, type TurnStep } from "../store";
import { AgentAvatar, Button, EmptyState, ErrorState, Input, PageHeader, agentColor, useNow } from "../components";
import { Icon } from "../icons";
import { compactNow, nowLine, timeLeftText, type CurrentTool } from "../livework";
import { BUCKETS, heldList, newestKey } from "../feed";
import { FeedStatus, HoldBar, PauseButton, useFeedHold } from "../feedstatus";
import { useRoving } from "../rovinglist";
import { titleWhenClipped } from "../domutil";
import {
  FILTERS, OUTCOME_ORDER, WINDOWS, autoWindow, busyText, filterSteps, groupSteps, outcomeCounts, pulseLine, rowSummary, spendOf, timeline,
  type Bar, type Lane,
} from "../steps";
import { useMission } from "../useMission";
import { useMissionActions } from "../useMissionActions";
import { useMedia } from "../shell";
import "./steps.css";

/* The page is a ledger: one console strip on top (what is running, what the run has cost, who was busy when), one sticky toolbar
   (the outcome legend is the filter), and one spine of turns underneath. Everything shares the outcome palette in `.o-*`, so a
   colour means the same thing everywhere. What it decides lives in steps.ts and feed.ts, which node:test covers. */

const css = (vars: Record<string, string | number>): CSSProperties => vars as CSSProperties;

/** Mirrors the phone rule in steps.css. A phone gets the numbers first and the swimlanes one tap away. */
const PHONE = "(max-width: 620px)";

/* ------------------------------- the strip -------------------------------- */

function Strip({ steps, loaded, onPick, filter, counts, missionTokens }: {
  steps: TurnStep[];
  /** The step history has arrived. Before that the strip shows dashes, not zeros: zero is a claim about a list nobody has fetched. */
  loaded: boolean;
  onPick: (s: TurnStep) => void;
  filter: string;
  counts: Record<string, number>;
  /** Whole-mission spend from the budget projection, or null before /status lands. */
  missionTokens: number | null;
}): React.JSX.Element {
  const now = useNow(1000);
  const { state } = useMission();
  const [win, setWin] = useState<string | null>(null);
  // Open on a wide screen and closed on a phone until the reader says otherwise; their choice then holds.
  const phone = useMedia(PHONE);
  const [openPref, setOpenPref] = useState<boolean | null>(null);
  const open = openPref ?? !phone;
  const auto = useMemo(() => autoWindow(steps, Date.now()), [steps]);
  const winId = win ?? auto;

  const live = steps.filter((s) => outcomeOf(s) === "live");
  const done = steps.length - live.length;
  const spend = useMemo(() => spendOf(steps, missionTokens), [steps, missionTokens]);
  const pulse = pulseLine(live.length, state.phase, loaded);
  // A turn marked live while the server is silent is the last thing it said, so the strip does not glow green for it.
  const working = live.length > 0 && state.phase !== "offline";
  const tl = useMemo(() => timeline(steps, winId, now), [steps, winId, now]);
  const mix = OUTCOME_ORDER.map((o) => ({ o, n: counts[o] || 0 })).filter((x) => x.n > 0);

  const barKeys = useMemo(() => tl?.lanes.flatMap((l) => l.bars.map((b) => b.step.turnId)) ?? [], [tl]);
  const roving = useRoving(barKeys, { horizontal: true });

  return (
    <section className={`st-console${working ? " hot" : ""}`} aria-label="Mission pulse">
      <div className="st-console-top">
        <div className="st-live">
          <span className={`st-beacon${working ? " on" : ""}`} aria-hidden="true" />
          <div className="st-live-text">
            <b>{pulse.title}</b>
            <span>{pulse.detail}</span>
          </div>
          {live.map((s) => (
            <button
              key={s.turnId}
              type="button"
              className="st-now"
              onClick={() => onPick(s)}
              title={`${s.agentId}. Woke: ${plainReason(s.reasonKind)}${s.currentTool ? `. ${nowLine(s.currentTool, now)}` : ""}`}
            >
              <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} size="sm" />
              <span className="st-now-name">{s.agentId}</span>
              <span className="st-now-t">{dur(now - Date.parse(s.startedAt))}</span>
            </button>
          ))}
        </div>

        <dl className="st-stats">
          <div title="Turns that have finished.">
            <dt>done</dt><dd>{loaded ? done : "–"}</dd>
          </div>
          <div
            title={
              missionTokens == null
                ? `${fmt(spend.loaded)} tokens across the ${plural(steps.length, "turn")} loaded here.`
                : `Every turn of the mission, from the budget ledger.${spend.partial ? ` The ${plural(steps.length, "turn")} loaded below account for ${fmt(spend.loaded)}.` : ""}`
            }
          >
            <dt>tokens</dt><dd>{loaded || missionTokens != null ? fmt(spend.tokens) : "–"}</dd>
          </div>
          <div
            className={spend.wastedPct >= 40 ? "warn" : ""}
            title={`Share of the ${fmt(spend.loaded)} tokens in the ${plural(steps.length, "loaded turn")} that went to turns which wrote nothing or were refused.${spend.partial ? " Older turns are not counted." : ""}`}
          >
            {/* Not "wasted": a turn that decided nothing needed doing, or was refused by policy, is working as designed. The figure says what is
                measured (tokens that produced no output) and leaves the verdict to the reader. */}
            <dt>{spend.partial ? `no output (${plural(steps.length, "turn")} loaded)` : "no output"}</dt><dd>{loaded ? `${spend.wastedPct}%` : "–"}</dd>
          </div>
        </dl>
      </div>

      {mix.length ? (
        <div className="st-mix" role="img" aria-label={`Outcome mix: ${mix.map(({ o, n }) => `${n} ${OUTCOME_META[o].label.toLowerCase()}`).join(", ")}`}>
          {mix.map(({ o, n }) => (
            <span
              key={o}
              className={`st-mix-seg ${OUTCOME_META[o].cls}${filter && filter !== o ? " dim" : ""}`}
              style={css({ "--g": n })}
              title={`${n} ${OUTCOME_META[o].label.toLowerCase()}, ${Math.round((n / steps.length) * 100)}%`}
            />
          ))}
        </div>
      ) : null}

      {tl ? (
        <div className="st-tl">
          <div className="st-tl-head">
            <button type="button" className="st-tl-cap" aria-expanded={open} onClick={() => setOpenPref(!open)}>
              <Icon name="chevron-right" size={12} className={open ? "caret turned" : "caret"} />
              Who was busy, when
            </button>
            {/* Beside the caption, not on the axis: there it sat on top of the "now" tick, which is always at the right edge. */}
            {tl.hidden ? <span className="st-axis-note">{tl.hidden} older turn{tl.hidden > 1 ? "s" : ""} outside this window</span> : null}
            <span className="seg" role="group" aria-label="Timeline window">
              {WINDOWS.map((w) => (
                <button key={w.id} type="button" aria-pressed={winId === w.id} onClick={() => setWin(w.id)} title={w.ms ? `Show the last ${w.label}` : "Show the whole run"}>
                  {w.label}
                </button>
              ))}
            </span>
          </div>
          {open ? (
            <div className="st-lanes" role="group" aria-label="Turns on a timeline, one lane per agent" onKeyDown={roving.onKeyDown}>
              {tl.lanes.map((ln) => (
                <LaneRow key={ln.agentId} lane={ln} filter={filter} ticks={tl.ticks} stop={roving.stop} setLast={roving.setLast} onPick={onPick} />
              ))}
              <div className="st-axis" aria-hidden="true">
                {tl.ticks.map((t) => (
                  <span key={t.at} className={`st-tick${t.label === "now" ? " now" : t.at === 0 ? " edge" : ""}${t.major ? " major" : ""}`} style={css({ "--at": `${t.at}%` })}>{t.label}</span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function LaneRow({ lane, filter, ticks, stop, setLast, onPick }: {
  lane: Lane<TurnStep>; filter: string; ticks: { at: number }[];
  stop: string | null; setLast: (key: string) => void; onPick: (s: TurnStep) => void;
}): React.JSX.Element {
  return (
    <div className="st-lane">
      <div className="st-lane-label" title={lane.agentId}>
        <AgentAvatar id={lane.agentId} color={agentColor(lane.agentId)} size="sm" />
        <span>{lane.agentId}</span>
      </div>
      <div className="st-track">
        {ticks.map((t) => <span key={t.at} className="st-grid" style={css({ "--at": `${t.at}%` })} aria-hidden="true" />)}
        {lane.bars.map((b: Bar<TurnStep>) => {
          const s = b.step;
          const oc = outcomeOf(s);
          const dim = filter && oc !== filter;
          return (
            <button
              key={s.turnId}
              type="button"
              data-rv=""
              tabIndex={stop === s.turnId ? 0 : -1}
              className={`st-bar ${OUTCOME_META[oc].cls}${dim ? " dim" : ""}${b.clipped ? " clipped" : ""}`}
              style={css({ "--l": `${b.left}%`, "--w": `${b.width}%` })}
              onClick={() => onPick(s)}
              onFocus={() => setLast(s.turnId)}
              title={`${s.agentId}. ${OUTCOME_META[oc].label}. ${dur(s.durationMs)}. ${fmt(s.tokens)} tokens.`}
              aria-label={`${s.agentId} turn, ${OUTCOME_META[oc].label.toLowerCase()}, ${dur(s.durationMs) || "running"}, ${ago(s.startedAt)}`}
            />
          );
        })}
      </div>
      <div className="st-lane-sum" title={`Busy ${busyText(lane)} of the window. ${fmt(lane.tokens)} tokens.`}>
        <b>{busyText(lane)}</b>
        <span>{fmt(lane.tokens)} tok</span>
      </div>
    </div>
  );
}

/* -------------------------------- the ledger ------------------------------- */

function LiveElapsed({ startedAt }: { startedAt: string }): React.JSX.Element {
  const now = useNow(1000);
  return <>{dur(now - Date.parse(startedAt)) || "0s"}</>;
}

/** "Edit model.ts, 4s": what a live row is doing, instead of its lifecycle word. */
function LiveVerb({ tool }: { tool: CurrentTool }): React.JSX.Element {
  const now = useNow(1000);
  return <span className={`st-sum st-now-tool${tool.status === "running" ? " run" : ""}`} title={nowLine(tool, now)}>{compactNow(tool, now)}</span>;
}

/** "4m left" against the turn's current deadline. */
function LiveLeft({ deadlineAt, ceilingAt }: { deadlineAt: number; ceilingAt?: number }): React.JSX.Element | null {
  const now = useNow(1000);
  const text = timeLeftText(deadlineAt, now);
  if (!text) return null;
  const at = (ms: number): string => localTime(new Date(ms).toISOString());
  return (
    <span
      className={deadlineAt - now < 60_000 ? "st-left warn" : "st-left"}
      title={`Stopped at ${at(deadlineAt)} ${zoneLabel()} unless extended${ceilingAt ? `. Hard stop ${at(ceilingAt)} ${zoneLabel()}.` : "."}`}
    >
      {text}
    </span>
  );
}

const StepRow = memo(function StepRow({ s, maxTokens, tab, onPick, onTab }: {
  s: TurnStep; maxTokens: number; tab: boolean; onPick: (s: TurnStep) => void; onTab: (key: string) => void;
}): React.JSX.Element {
  const oc = outcomeOf(s);
  const meta = OUTCOME_META[oc];
  const refusal = refusalSummary(s);
  const live = oc === "live";
  const elapsed = live ? Date.now() - Date.parse(s.startedAt) : s.durationMs;
  const share = maxTokens && s.tokens ? Math.max(6, Math.round((s.tokens / maxTokens) * 100)) : 0;
  const note = s.reasonNote && s.reasonNote !== s.triggerEventType ? s.reasonNote : "";
  const liveTok = live && typeof s.liveTokens === "number";
  const summary = rowSummary(s);
  return (
    <li className="st-item">
      <button
        type="button"
        data-rv=""
        data-turn={s.turnId}
        tabIndex={tab ? 0 : -1}
        className={`st-row ${meta.cls}`}
        onClick={() => onPick(s)}
        onFocus={() => onTab(s.turnId)}
      >
        <span className="st-mark" aria-hidden="true" />
        <AgentAvatar id={s.agentId} color={agentColor(s.agentId)} />
        <span className="st-main">
          <span className="st-l1">
            <b className="st-agent">{s.agentId}</b>
            <span className="otag" title={meta.hint}>{meta.label}</span>
            {live && s.currentTool ? <LiveVerb tool={s.currentTool} /> : live ? <span className="st-sum">{s.lifecycle ? s.lifecycle.toLowerCase().replace(/_/g, " ") : "thinking"}…</span> : summary ? <span className="st-sum">{summary}</span> : null}
            {s.attempt && s.attempt > 1 ? <span className="st-retry" title="The scheduler woke this agent again after a timeout.">attempt {s.attempt}</span> : null}
          </span>
          {/* The reasons are phrases of mixed grammar ("new message", "restarted after a problem"), so a fixed verb only fit some of them. */}
          <span className="st-l2">
            <span className="st-woke" onMouseEnter={titleWhenClipped}>Woke: {plainReason(s.reasonKind)}{note ? <span className="st-note">{` · ${note}`}</span> : null}</span>
          </span>
          {/* Clamped to two lines, the full text in the tooltip: slicing at 160 characters cut words in half with no ellipsis. */}
          {refusal ? <span className="st-refusal" title={`The kernel refused this op: ${refusal}`}><b>Refused.</b> {refusal}</span> : null}
          {s.error ? <span className="st-err" title={s.error}>{plainBlocker(s.error)}</span> : null}
        </span>
        <span className="st-num">
          <b>{live ? <LiveElapsed startedAt={s.startedAt} /> : (dur(elapsed) || "no duration")}</b>
          <span
            className="st-cost"
            title={s.tokens
              ? `${fmt(s.tokens)} tokens. The bar is relative to the costliest loaded turn.`
              : liveTok ? "Billable tokens the runtime has reported so far, cache reads excluded." : live ? "No token figure reported yet." : "No tokens spent."}
          >
            {share ? <i className="st-cost-bar" style={css({ "--w": `${share}%` })} aria-hidden="true" /> : null}
            {/* A running turn has spent nothing final yet; "no cost" read as a free turn while it burned tokens for seventeen minutes. */}
            {s.tokens ? `${fmt(s.tokens)} tok` : liveTok ? `${fmt(s.liveTokens)} tok so far` : live ? "no figure yet" : "no cost"}
          </span>
          {/* A live row's start is its elapsed time, already above; how long it has left is the number that is not on screen elsewhere. */}
          {live && typeof s.deadlineAt === "number" ? <LiveLeft deadlineAt={s.deadlineAt} ceilingAt={s.ceilingAt} /> : <span className="st-when">{ago(s.startedAt)}</span>}
        </span>
      </button>
    </li>
  );
});

function Skeleton(): React.JSX.Element {
  return (
    <ol className="st-list" aria-busy="true" aria-label="Loading steps">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="st-item">
          <div className="st-row st-skel">
            <span className="st-mark" /><span className="sk sk-av" />
            <div className="st-main"><span className="sk sk-l1" /><span className="sk sk-l2" /></div>
            <div className="st-num"><span className="sk sk-n" /><span className="sk sk-n2" /></div>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* ---------------------------------- page ----------------------------------- */

export default function Steps(): React.JSX.Element {
  const { steps, stepsLoaded, stepFilter, setStepFilter, stepSearch, setStepSearch, openDetail, refreshSteps, stepLimit, setStepLimit, status, serverDown } = useMesh();
  const { state } = useMission();
  const missionActions = useMissionActions();
  const [fold, setFold] = useState(true);
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const ledgerRef = useRef<HTMLDivElement | null>(null);
  // Buckets only move at minute scale; a 30s clock keeps the ledger out of the per-second render path while live durations tick
  // inside their own leaves.
  const now = useNow(30_000);

  // Mission-wide spend lives in the budget projection, not in the step tail. `/status` is already polled every 4s by the store,
  // so this costs nothing.
  const missionTokens = useMemo(() => {
    const agents: { tokens?: number }[] = status?.agents ?? [];
    return agents.length ? agents.reduce((a, x) => a + (x.tokens || 0), 0) : null;
  }, [status]);

  useEffect(() => {
    void refreshSteps(true);
    const iv = setInterval(() => {
      void refreshSteps(true);
    }, 3500);
    return () => clearInterval(iv);
  }, [refreshSteps]);

  const all = useMemo(() => steps ?? [], [steps]);
  // Deep link rather than a bare drawer push: a step someone is debugging should survive a refresh and be pasteable into a chat.
  const pick = useCallback((s: TurnStep) => openDetail("step", s.turnId), [openDetail]);

  /* The ledger can be held still (pause, pointing at it, focus on a row). Only the SET of rows freezes: a running turn that
     finishes meanwhile shows its result in place, and turns that began after the hold are counted, not drawn. */
  const newest = useMemo(() => newestKey(all, (s) => s.seqStart), [all]);
  const hold = useFeedHold(newest, { scroll: false });
  const held = useMemo(() => heldList(all, (s) => s.seqStart, hold.mark), [all, hold.mark]);
  const visible = held.shown as TurnStep[];

  const counts = useMemo(() => outcomeCounts(visible), [visible]);
  const rows = useMemo(() => filterSteps(visible, stepFilter, stepSearch), [visible, stepFilter, stepSearch]);
  const maxTokens = useMemo(() => visible.reduce((m, s) => Math.max(m, s.tokens || 0), 0), [visible]);

  const filtered = Boolean(stepFilter || stepSearch.trim());
  const folding = fold && !filtered;
  const groups = useMemo(() => groupSteps(rows, now, folding, BUCKETS), [rows, folding, now]);

  const rowKeys = useMemo(
    () => groups.flatMap((g) => g.rows.flatMap((r) => {
      if (r.kind === "step") return [r.s.turnId];
      const key = foldKey(r.items);
      return [key, ...(openFolds.has(key) ? r.items.map((s) => s.turnId) : [])];
    })),
    [groups, openFolds],
  );
  const roving = useRoving(rowKeys);

  const showNewest = useCallback(() => {
    hold.release();
    ledgerRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [hold]);
  const clearFilters = (): void => { setStepFilter(""); setStepSearch(""); };
  const startable = state.primary && (state.primary.action === "start" || state.primary.action === "resume") ? state.primary : null;

  return (
    <div className={`st-page${serverDown ? " offline" : ""}`}>
      <PageHeader
        title="Steps"
        status={<FeedStatus />}
        lede="One row per agent turn, newest first."
        actions={
          <>
            <label className="sr-only" htmlFor="step-search">Filter steps</label>
            <Input search id="step-search" placeholder="Agent or word…  ( / )" value={stepSearch} onChange={(e) => setStepSearch(e.target.value)} />
            <PauseButton paused={hold.paused} onToggle={() => hold.setPaused(!hold.paused)} noun="turns" />
          </>
        }
      />

      <Strip steps={visible} loaded={stepsLoaded} onPick={pick} filter={stepFilter} counts={counts} missionTokens={missionTokens} />

      <div className="st-toolbar">
        <div className="st-filters" role="group" aria-label="Filter by outcome">
          {FILTERS.map((f) => {
            const n = f.id ? counts[f.id] || 0 : visible.length;
            return (
              <button
                key={f.id}
                type="button"
                className={`fchip ${f.id ? OUTCOME_META[f.id as Outcome].cls : ""}${stepFilter === f.id ? " on" : ""}`}
                onClick={() => setStepFilter(stepFilter === f.id ? "" : f.id)}
                title={f.id ? OUTCOME_META[f.id as Outcome].hint : "Every turn, whatever it did."}
                aria-pressed={stepFilter === f.id}
                // A chip with nothing behind it is disabled, except the one that is on: it must stay operable so the filter can be lifted.
                disabled={Boolean(f.id) && n === 0 && stepFilter !== f.id}
              >
                {f.id ? <i className="fchip-dot" aria-hidden="true" /> : null}
                {f.label}
                <span className="fchip-n">{stepsLoaded ? n : "–"}</span>
              </button>
            );
          })}
        </div>
        <div className="st-toolbar-right">
          <span className="st-count">
            {!stepsLoaded ? "Loading…" : filtered ? `${rows.length} of ${visible.length}` : `${visible.length} turn${visible.length === 1 ? "" : "s"}`}
          </span>
          {/* Said aloud only while a filter is on: a count that announced every new turn would talk all through a live run. */}
          <span className="sr-only" role="status">{filtered ? `${rows.length} of ${plural(visible.length, "turn")} ${rows.length === 1 ? "matches" : "match"}.` : ""}</span>
          <button
            type="button"
            className={`fchip${folding ? " on" : ""}`}
            aria-pressed={folding}
            disabled={filtered}
            onClick={() => setFold((f) => !f)}
            title={filtered ? "Folding is off while a filter or search is active." : "Fold runs of three or more turns that wrote nothing into one row."}
          >
            Collapse quiet runs
          </button>
        </div>
      </div>

      <HoldBar paused={hold.paused} fresh={held.fresh} noun="turn" onShow={showNewest} />

      <div className="st-ledger" ref={ledgerRef} onKeyDown={roving.onKeyDown} {...hold.listProps}>
        {groups.length ? (
          <>
            {groups.map((g) => (
              <section key={g.id} className="st-group" aria-labelledby={`st-g-${g.id}`}>
                <header className="st-group-head">
                  <h3 id={`st-g-${g.id}`}>{g.label}</h3>
                  <span>{g.list.length} turn{g.list.length === 1 ? "" : "s"} · {fmt(g.tokens)} tokens</span>
                </header>
                <ol className="st-list">
                  {g.rows.map((r) => {
                    if (r.kind === "step") {
                      return <StepRow key={r.s.turnId} s={r.s} maxTokens={maxTokens} tab={roving.stop === r.s.turnId} onPick={pick} onTab={roving.setLast} />;
                    }
                    const key = foldKey(r.items);
                    return (
                      <FoldRow
                        key={key}
                        id={key}
                        items={r.items}
                        open={openFolds.has(key)}
                        onToggle={() => setOpenFolds((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; })}
                        maxTokens={maxTokens}
                        stop={roving.stop}
                        setLast={roving.setLast}
                        onPick={pick}
                      />
                    );
                  })}
                </ol>
              </section>
            ))}
            {all.length >= stepLimit ? (
              <div className="st-more">
                <Button variant="small" onClick={() => setStepLimit(stepLimit + 60)}>Load 60 older turns</Button>
              </div>
            ) : null}
          </>
        ) : !stepsLoaded ? (
          // Before the first /steps response "No steps match" was a lie twice over: nothing had been fetched, and no filter had been applied.
          serverDown
            ? <ErrorState what="the step history" detail="The mesh server stopped answering. It may be restarting." onRetry={() => void refreshSteps(true)} />
            : <Skeleton />
        ) : visible.length ? (
          <EmptyState icon="search" title="No turns match" action={<Button variant="small" onClick={clearFilters}>Clear filters</Button>}>
            Clear the outcome filter or the search to see every turn.
          </EmptyState>
        ) : (
          <EmptyState
            icon="steps"
            title="No turns yet"
            action={startable ? <Button variant="primary" icon="play" onClick={() => missionActions.run(startable.action)}>{startable.label}</Button> : undefined}
          >
            {startable ? "A turn is one agent waking up, acting and going back to wait. Nothing is running yet." : "A turn is one agent waking up, acting and going back to wait. They appear here as agents work."}
          </EmptyState>
        )}
      </div>
    </div>
  );
}

/** A fold is keyed by its OLDEST turn: new quiet turns join at the top, and keying on the first remounted a fold the reader had opened. */
const foldKey = (items: TurnStep[]): string => `fold-${items[items.length - 1]!.turnId}`;

const FoldRow = memo(function FoldRow({ id, items, open, onToggle, maxTokens, stop, setLast, onPick }: {
  id: string; items: TurnStep[]; open: boolean; onToggle: () => void; maxTokens: number;
  stop: string | null; setLast: (key: string) => void; onPick: (s: TurnStep) => void;
}): React.JSX.Element {
  const tokens = items.reduce((a, s) => a + (s.tokens || 0), 0);
  const agents = [...new Set(items.map((s) => s.agentId))];
  return (
    <li className={`st-fold${open ? " open" : ""}`}>
      <button type="button" data-rv="" tabIndex={stop === id ? 0 : -1} className="st-fold-head" onClick={onToggle} onFocus={() => setLast(id)} aria-expanded={open}>
        <Icon name="chevron-right" size={12} className={open ? "caret turned" : "caret"} />
        <b>{items.length} quiet turns</b>
        <span className="st-fold-who">
          {agents.slice(0, 4).join(", ")}
          {agents.length > 4 ? ` +${agents.length - 4}` : ""} woke and wrote nothing
        </span>
        <span className="st-fold-cost">{fmt(tokens)} tok</span>
      </button>
      {open ? (
        <ol className="st-fold-body">
          {items.map((s) => <StepRow key={s.turnId} s={s} maxTokens={maxTokens} tab={stop === s.turnId} onPick={onPick} onTab={setLast} />)}
        </ol>
      ) : null}
    </li>
  );
});
