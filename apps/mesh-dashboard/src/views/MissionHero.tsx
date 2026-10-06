import type { ReactNode } from "react";
import { dur, fmt, spanLabel } from "../format";
import { Button, Menu, useNow, type MenuItem } from "../components";
import { Icon, type IconName } from "../icons";
import type { HeroAction, MissionAction, MissionControl, MissionState, NextStep } from "../mission";
import { missionClock, type ChecksSummary, type HeroNote } from "../overview-model";
import { rightNow, type RightNowInput } from "../rightnow";
import { Bar } from "./Meter";
import "./overview.css";

/** The icon of each mission action, the same set the top bar draws, so one action looks the same in both places. */
export const MISSION_ICON: Record<MissionAction, IconName> = {
  start: "play", pause: "pause", resume: "play", reopen: "undo", review: "inbox", settings: "sliders", agents: "agents", designer: "designer",
};

/** The icon of each thing the hero offers: the mission's actions, and where a finished mission's result is read. */
const HERO_ICON: Record<HeroAction, IconName> = { ...MISSION_ICON, files: "files", cost: "cost", replay: "refresh" };

/**
 * One thing to do next, as the mission state (mission.ts) offers it: the same label, hint and handler as the top bar's button when it
 * is the bar's action. How loud it is comes with it: a result is read or sent back, and the rest is quiet.
 */
export function NextButton({ step, run }: { step: NextStep; run: (a: HeroAction) => void }): React.JSX.Element {
  return (
    <Button variant={step.look === "quiet" ? "small" : step.look} icon={HERO_ICON[step.action]} title={step.hint} data-action={step.action} onClick={() => run(step.action)}>
      {step.label}
    </Button>
  );
}

/** One labelled figure. The detail under the value lives inside the <dd>, so the list stays a valid definition list. */
function Stat({ label, tone, title, value, children }: { label: string; tone?: "bad"; title?: string; value: ReactNode; children?: ReactNode }): React.JSX.Element {
  return (
    <div className="ov-stat">
      <dt>{label}</dt>
      <dd>
        <span className={`v${tone ? ` ${tone}` : ""}`} title={title}>{value}</span>
        {children}
      </dd>
    </div>
  );
}

/** Time since the goal was created, or how long the mission ran. It owns its own tick so the rest of the page does not re-render every second. */
function ClockStat({ goal, ticking }: { goal: unknown; ticking: boolean }): React.JSX.Element | null {
  const now = useNow(ticking ? 1000 : 15000);
  const clock = missionClock(goal as Parameters<typeof missionClock>[0], now);
  if (!clock) return null;
  const sub = clock.ended
    ? "From creation to delivery"
    : clock.limitMs === null
      ? "Since the goal was created"
      : clock.over ? `Over the ${spanLabel(clock.limitMs)} limit` : `of ${spanLabel(clock.limitMs)} allowed`;
  return (
    <Stat
      label={clock.ended ? "Ran for" : "Elapsed"}
      tone={clock.over ? "bad" : undefined}
      title={clock.ended ? undefined : "The mission's wall clock runs from the goal's creation and does not stop while the project is parked."}
      value={dur(clock.ms)}
    >
      <span className="ov-sub">{sub}</span>
    </Stat>
  );
}

/**
 * What is happening this minute, in a few plain lines (rightnow.ts). It owns its own clock, so "for 2 min" moves without the rest of
 * the page re-rendering with it, and it is not a live region: it changes with every turn, and a screen reader is not told each time.
 */
function RightNow({ input }: { input: Omit<RightNowInput, "now"> }): React.JSX.Element | null {
  const now = useNow(15000);
  const lines = rightNow({ ...input, now });
  if (!lines.length) return null;
  return (
    <section className="ov-now" aria-labelledby="ov-now-h">
      <b id="ov-now-h">Right now</b>
      <ul>{lines.map((l) => <li key={l}>{l}</li>)}</ul>
    </section>
  );
}

function Note({ note }: { note: HeroNote }): React.JSX.Element {
  if (!note.detail.length && !note.server) return <p className="ov-note">{note.summary}</p>;
  return (
    <details className="ov-note">
      <summary>
        <Icon name="chevron-right" size={14} className="chev" />
        <span>{note.summary}</span>
      </summary>
      <div className="ov-note-body">
        {note.detail.map((p, i) => <p key={i}>{p}</p>)}
        {note.server ? <blockquote className="ov-server"><b>The server says</b>{note.server}</blockquote> : null}
      </div>
    </details>
  );
}

export interface HeroProps {
  state: MissionState;
  /** `state.headline`. */
  headline: string;
  goalText: string;
  note: HeroNote | null;
  checks: ChecksSummary;
  goal: unknown;
  tokens: { consumed: number; limit: number } | null;
  events: number;
  messages: number | null;
  agents: { working: number; waiting: number; queued: number };
  /** The figures are the last the server reported. */
  stale: boolean;
  /** The mission's clock is running: tick it every second. */
  ticking: boolean;
  /** What rightnow.ts reads, for a mission that is live; it says nothing for the others. */
  live: Omit<RightNowInput, "now">;
  /** What to do next, beside the headline (`MissionState.next`). */
  next: NextStep[];
  /** What else the mission can do, behind "...": whatever `next` does not already show. */
  secondary: MissionControl[];
  run: (a: HeroAction) => void;
}

/**
 * Is it OK, and what do I do? One status, one headline, the goal, four figures, one button. The server's own explanatory text
 * is the quiet line under them, with the long wording a click away, where the old Overview put it in up to four banners.
 */
export function MissionHero(p: HeroProps): React.JSX.Element {
  const { state, checks } = p;
  // An action the hero already shows is not offered again behind "...".
  const items: MenuItem[] = p.secondary.filter((c) => !p.next.some((n) => n.action === c.action)).map((c) => ({ icon: MISSION_ICON[c.action], label: c.label, title: c.hint, onClick: () => p.run(c.action) }));
  const spentRatio = p.tokens && p.tokens.limit > 0 ? p.tokens.consumed / p.tokens.limit : 0;
  const barTone = spentRatio >= 0.95 ? "bad" : spentRatio >= 0.8 ? "warn" : undefined;
  return (
    <section className={`ov-hero ${state.tone}${p.stale ? " stale" : ""}`} aria-label="Mission status">
      <div className="ov-hero-top">
        <div className="ov-hero-lead">
          <div className="ov-status">
            <span className={`mission-chip ${state.tone}`}>
              <i className={`dot${state.pulse && !p.stale ? " pulse" : ""}`} aria-hidden="true" />
              {state.label}
            </span>
            {p.stale ? <span className="ov-stale">Last known state</span> : null}
          </div>
          <p className="ov-headline">{p.headline}</p>
          {p.goalText ? <p className="ov-goal" title={p.goalText}>{p.goalText}</p> : null}
        </div>
        <div className="ov-acts">
          {p.next.filter((n) => n.look !== "quiet").map((n) => <NextButton key={n.action} step={n} run={p.run} />)}
          {/* Together, so that on a phone they are one row of their own under the two that matter, not stragglers beside them. */}
          {p.next.some((n) => n.look === "quiet") ? (
            <div className="ov-quiet">{p.next.filter((n) => n.look === "quiet").map((n) => <NextButton key={n.action} step={n} run={p.run} />)}</div>
          ) : null}
          {items.length ? <Menu label={<Icon name="more" size={18} />} title="More actions on the mission" items={items} /> : null}
        </div>
      </div>

      <dl className="ov-stats">
        {checks.total > 0 ? (
          <Stat label="Checks" value={<>{checks.done}<span className="of"> of {checks.total}</span></>}>
            <Bar value={checks.done} max={checks.total} label="Mandatory checks evidenced" tone={checks.done === checks.total ? "ok" : undefined} />
            <span className="ov-sub">{checks.claimed > 0 ? `${checks.claimed} more claimed, not verified` : `${checks.pct}% evidenced`}</span>
          </Stat>
        ) : (
          <Stat label="Checks" value="None">
            <span className="ov-sub">This goal declares no mandatory checks.</span>
          </Stat>
        )}
        <ClockStat goal={p.goal} ticking={p.ticking} />
        <Stat
          label="Tokens"
          value={p.tokens && p.tokens.limit > 0 ? <>{fmt(p.tokens.consumed)}<span className="of"> of {fmt(p.tokens.limit)}</span></> : <>{fmt(p.tokens?.consumed ?? 0)}<span className="of"> no limit set</span></>}
        >
          {p.tokens && p.tokens.limit > 0 ? <Bar value={p.tokens.consumed} max={p.tokens.limit} label="Mission token budget spent" tone={barTone} /> : null}
          <span className="ov-sub">{p.events} events{p.messages !== null ? ` · ${p.messages} messages` : ""}</span>
        </Stat>
        <Stat label="Agents" value={<>{p.agents.working}<span className="of"> working</span></>}>
          <span className="ov-sub">{p.agents.waiting} waiting · {p.agents.queued} queued</span>
        </Stat>
      </dl>

      <RightNow input={p.live} />
      {p.note ? <Note note={p.note} /> : null}
    </section>
  );
}
