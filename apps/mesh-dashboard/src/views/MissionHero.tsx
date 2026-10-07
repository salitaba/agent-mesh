import { dur, fmt, spanLabel } from "../format";
import { AgentAvatar, Button, IconTile, Menu, Pill, Progress, Stat, Tooltip, agentColor, useNow, type MenuItem, type TileTone } from "../components";
import { Icon, type IconName } from "../icons";
import { budgetTone } from "../cost";
import type { HeroAction, MissionAction, MissionControl, MissionState, NextStep } from "../mission";
import { checkSegments, heroLook, missionClock, seatStack, splitHeadline, type CheckMark, type ChecksSummary, type HeroNote } from "../overview-model";
import { rightNowRows, type RightNowInput, type RightNowKind } from "../rightnow";
import "./overview.css";

/** The icon of each mission action, the same set the top bar draws, so one action looks the same in both places. */
export const MISSION_ICON: Record<MissionAction, IconName> = {
  start: "play", pause: "pause", resume: "play", reopen: "undo", review: "inbox", settings: "sliders", agents: "agents", designer: "designer",
};

/** The icon of each thing the hero offers: the mission's actions, and where a finished mission's result is read. */
const HERO_ICON: Record<HeroAction, IconName> = { ...MISSION_ICON, files: "files", cost: "cost", replay: "refresh" };

/**
 * One thing to do next, as the mission state (mission.ts) offers it: the same label, hint and handler as the top bar's button when it
 * is the bar's action. How loud it is comes with it: the one to do is the large button, a second is the large quiet one, and what a
 * person only sometimes wants (what it cost, replay) is a ghost that waits to be pointed at. The hint is the tooltip.
 */
export function NextButton({ step, run }: { step: NextStep; run: (a: HeroAction) => void }): React.JSX.Element {
  const common = { icon: HERO_ICON[step.action], "data-action": step.action, onClick: () => run(step.action) };
  return (
    <Tooltip content={step.hint}>
      {step.look === "quiet"
        ? <Button variant="ghost" {...common}>{step.label}</Button>
        : <Button variant={step.look} size="lg" {...common}>{step.label}</Button>}
    </Tooltip>
  );
}

/** A headline's first sentence longer than this is set a size smaller: the display size is for a short line, not for a sentence. */
const LONG_LEAD = 44;

/** What each of the four figures is drawn with beside its number: a slot as tall as the avatars, so the four lines under it line up. */
function Visual({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return <div className="stat-vis">{children}</div>;
}

/** A segment for each mandatory check: lit when it is evidenced, amber when it is only claimed, empty while it is to do. */
function Segments({ marks, label }: { marks: CheckMark[]; label: string }): React.JSX.Element {
  return (
    <div className="ov-seg" role="img" aria-label={label}>
      {marks.map((m, i) => <i key={i} className={m} />)}
    </div>
  );
}

function ChecksKpi({ checks, marks }: { checks: ChecksSummary; marks: CheckMark[] }): React.JSX.Element {
  if (checks.total === 0) {
    return <Stat label="Checks" value="None" sub="This goal declares no mandatory checks."><Visual /></Stat>;
  }
  const claimed = checks.claimed > 0 ? `, ${checks.claimed} more claimed and not verified` : "";
  return (
    <Stat label="Checks" value={checks.done} unit={`of ${checks.total}`} sub={checks.claimed > 0 ? `${checks.claimed} more claimed, not verified` : `${checks.pct}% evidenced`}>
      <Visual>
        {marks.length <= 24
          ? <Segments marks={marks} label={`${checks.done} of ${checks.total} mandatory checks evidenced${claimed}`} />
          : <Progress value={checks.done} max={checks.total} label="Mandatory checks evidenced" tone={checks.done === checks.total ? "ok" : undefined} />}
      </Visual>
    </Stat>
  );
}

/** Time since the goal was created, or how long the mission ran. It owns its own tick so the rest of the page does not re-render every second. */
function ClockKpi({ goal, ticking }: { goal: unknown; ticking: boolean }): React.JSX.Element | null {
  const now = useNow(ticking ? 1000 : 15000);
  const clock = missionClock(goal as Parameters<typeof missionClock>[0], now);
  if (!clock) return null;
  const sub = clock.ended
    ? "From creation to delivery"
    : clock.limitMs === null
      ? "Since the goal was created"
      : clock.over ? `Over the ${spanLabel(clock.limitMs)} limit` : `of ${spanLabel(clock.limitMs)} allowed`;
  // The line is how much of the allowed time is gone, and only a running mission with a limit has one to say.
  const ratio = !clock.ended && clock.limitMs ? clock.ms / clock.limitMs : null;
  const tone = ratio === null ? "ok" : budgetTone(ratio, clock.over);
  return (
    <div className="stat-cell" title={clock.ended ? undefined : "The mission's wall clock runs from the goal's creation and does not stop while the project is parked."}>
      <Stat label={clock.ended ? "Ran for" : "Elapsed"} value={dur(clock.ms)} tone={clock.over ? "bad" : undefined} sub={sub}>
        <Visual>
          {ratio !== null ? <Progress value={clock.ms} max={clock.limitMs!} label="Share of the allowed time gone" tone={tone === "ok" ? undefined : tone} valueText={`${dur(clock.ms)} of ${spanLabel(clock.limitMs!)}`} /> : null}
        </Visual>
      </Stat>
    </div>
  );
}

function TokensKpi({ tokens, events, messages }: { tokens: HeroProps["tokens"]; events: number; messages: number | null }): React.JSX.Element {
  const limited = tokens !== null && tokens.limit > 0;
  const tone = limited ? budgetTone(tokens.consumed / tokens.limit) : "ok";
  return (
    <Stat
      label="Tokens" value={fmt(tokens?.consumed ?? 0)} unit={limited ? `of ${fmt(tokens.limit)}` : "no limit set"}
      sub={`${events} events${messages !== null ? ` · ${messages} messages` : ""}`}
    >
      <Visual>
        {limited ? <Progress value={tokens.consumed} max={tokens.limit} size="lg" label="Mission token budget spent" tone={tone === "ok" ? undefined : tone} valueText={`${fmt(tokens.consumed)} of ${fmt(tokens.limit)} tokens`} /> : null}
      </Visual>
    </Stat>
  );
}

/** Every seat as an avatar on its role's colour, the ones in a turn lit; the roster is as long as the mesh, so what does not fit is counted. */
function AgentsKpi({ seats, agents }: { seats: HeroProps["seats"]; agents: HeroProps["agents"] }): React.JSX.Element {
  const { shown, more } = seatStack(seats);
  const names = shown.map((s) => (s.working ? `${s.id} (working)` : s.id)).join(", ");
  return (
    <Stat label="Agents" value={agents.working} unit="working" sub={`${agents.waiting} waiting · ${agents.queued} queued`}>
      <Visual>
        {shown.length ? (
          <div className="ov-seats" role="img" aria-label={`${shown.length + more} seats: ${names}${more ? ` and ${more} more` : ""}`}>
            {shown.map((s) => <span key={s.id} className={`ov-seat${s.working ? " on" : ""}`}><AgentAvatar id={s.id} color={agentColor(s.role)} size="sm" /></span>)}
            {more ? <span className="ov-seat more">+{more}</span> : null}
          </div>
        ) : null}
      </Visual>
    </Stat>
  );
}

/** What each line of "Right now" is marked with: the seat that is working, or the icon of what the line is about. */
const NOW_ICON: Record<RightNowKind, IconName> = { working: "dot", queue: "steps", waiting: "inbox", asked: "message", idle: "pause", you: "check" };

/**
 * What is happening this minute, in a few plain lines (rightnow.ts). It owns its own clock, so "for 2 min" moves without the rest of
 * the page re-rendering with it, and it is not a live region: it changes with every turn, and a screen reader is not told each time.
 */
function RightNow({ input, roleOf }: { input: Omit<RightNowInput, "now">; roleOf: (id: string) => string }): React.JSX.Element | null {
  const now = useNow(15000);
  const rows = rightNowRows({ ...input, now });
  if (!rows.length) return null;
  return (
    <section className="ov-now" aria-labelledby="ov-now-h">
      <h3 id="ov-now-h" className="caps"><i className="ov-live" aria-hidden="true" />Right now</h3>
      <ul>
        {rows.map((r) => (
          <li key={r.text} className={r.kind}>
            <span className="ov-mk">
              {r.kind === "working" && r.seat
                ? <span className="ov-seat on lit"><AgentAvatar id={r.seat} color={agentColor(roleOf(r.seat))} size="sm" /></span>
                : <IconTile size="sm" icon={r.kind === "you" && r.look ? "alert" : NOW_ICON[r.kind]} tone={r.kind === "you" ? (r.look ? "warn" : "ok") : "neutral"} />}
            </span>
            <span>{r.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Note({ note }: { note: HeroNote }): React.JSX.Element {
  if (!note.detail.length && !note.server) return <p className="ov-note"><Icon name="info" size={14} />{note.summary}</p>;
  return (
    <details className="ov-note disc">
      <summary>{note.summary}</summary>
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
  /** The mandatory checks as the goal lists them, for the segments under the figure. */
  marks: CheckMark[];
  goal: unknown;
  tokens: { consumed: number; limit: number } | null;
  events: number;
  messages: number | null;
  agents: { working: number; waiting: number; queued: number };
  /** The seats (the human is not one): who is in the stack, and what colour each one is. */
  seats: ReadonlyArray<{ id: string; role?: string; lifecycle?: string }>;
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
 * Is it OK, and what do I do? One mark for the state, one headline, the goal, four figures, one button. The state is a shape and a
 * word before it is a colour: the tile at the head says what kind of state it is, the headline's first sentence says which. The
 * server's own explanatory text is the quiet line under the figures, with the long wording a click away.
 */
export function MissionHero(p: HeroProps): React.JSX.Element {
  const { state, checks } = p;
  const look = heroLook(state.phase);
  const { lead, rest } = splitHeadline(p.headline);
  const roles = new Map(p.seats.map((s) => [s.id, String(s.role ?? "")]));
  // An action the hero already shows is not offered again behind "...".
  const items: MenuItem[] = p.secondary.filter((c) => !p.next.some((n) => n.action === c.action)).map((c) => ({ icon: MISSION_ICON[c.action], label: c.label, title: c.hint, onClick: () => p.run(c.action) }));
  const tone: TileTone = state.tone;
  return (
    <section className={`ov-hero ${state.tone} ${state.phase}${p.stale ? " stale" : ""}`} aria-label="Mission status">
      <div className="ov-hero-top">
        <IconTile icon={look.icon} tone={tone} size="lg" live={look.live && !p.stale} />
        <div className="ov-hero-lead">
          <p className="ov-headline">
            <b className={lead.length > LONG_LEAD ? "long" : undefined}>{lead}</b>
            {rest ? <> <span>{rest}</span></> : null}
          </p>
          {p.stale ? <Pill tone="bad" dot={false}>Last known state</Pill> : null}
          {p.goalText ? <p className="ov-goal" title={p.goalText}><span className="caps">Goal</span><span className="ov-goal-line">{p.goalText}</span></p> : null}
        </div>
        <div className="ov-acts">
          {p.next.map((n) => <NextButton key={n.action} step={n} run={p.run} />)}
          {items.length ? <Menu label={<Icon name="more" size={18} />} title="More actions on the mission" items={items} /> : null}
        </div>
      </div>

      <div className="stat-strip" role="group" aria-label="Mission figures">
        <div className="stat-cell"><ChecksKpi checks={checks} marks={p.marks} /></div>
        <ClockKpi goal={p.goal} ticking={p.ticking} />
        <div className="stat-cell"><TokensKpi tokens={p.tokens} events={p.events} messages={p.messages} /></div>
        <div className="stat-cell"><AgentsKpi seats={p.seats} agents={p.agents} /></div>
      </div>

      <RightNow input={p.live} roleOf={(id) => roles.get(id) ?? ""} />
      {p.note ? <Note note={p.note} /> : null}
    </section>
  );
}
