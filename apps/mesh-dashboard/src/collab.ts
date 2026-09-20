/* ---------------------------------------------------------------------- *
 * Collab sessions: the fold behind the Overview's collaboration card.
 *
 * A collab is an agent-to-agent working session opened by the `mesh_collab`
 * op. It obliges nobody to answer, but it is bounded twice over — by a wall
 * clock and by a count of messages in its thread — and both bounds are stamped
 * into `collab.opened` at the moment it opens, so a mesh that edits
 * `bus.collab` mid-run cannot move the edge of a session already running.
 * Running past either edge closes the session OVERRUN and raises an operator
 * card, which means a surface for this is only worth anything if it shows the
 * pressure BEFORE the card exists.
 *
 * Folded out of the event log rather than fetched, because there is nothing to
 * fetch. The kernel keeps the live record in `state.collabSessions`, but
 * `supervisor.status()` returns goal / agents / budgets / progress /
 * escalations / eventCount and never reaches it, and no HTTP route exposes it
 * either. What the log does carry is enough: `collab.opened` holds the whole
 * session record including its bounds, and the exchange meter in between can
 * be recounted here exactly the way `applyMessagingEvent` counts it
 * server-side — every `message.sent` in the thread while the session is OPEN,
 * whoever sent it, because the box bounds the CONVERSATION and not one seat's
 * share of it.
 *
 * Pure and DOM-free, and structurally typed over the event rather than
 * importing `TimelineEvent` from `./store` — for vitals.ts's reason: the store
 * is a .tsx module, and importing it drags React and the DOM lib into a file
 * that has no business needing either. `TimelineEvent` satisfies `CollabEvent`.
 * ---------------------------------------------------------------------- */

/** The three fields the fold reads off an event. `TimelineEvent` satisfies it. */
export interface CollabEvent {
  seq: number;
  type: string;
  timestamp: string;
  payload?: any;
}

/**
 * One collaboration as the client can know it.
 *
 * Mirrors the kernel's `CollabSession` field for field, minus `closedAt` and
 * the fields nothing here renders. `exchanges` is the one value that is
 * recounted rather than read: the opening record always carries 0, because the
 * message that opens the thread is the OPEN and is deliberately not metered.
 */
export interface CollabThread {
  threadId: string;
  /** What it is for. Also the thread subject and the overrun card's title. */
  topic: string;
  openedBy: string;
  participants: string[];
  openedAt: string;
  /** ISO-8601. The wall-clock edge of the box, fixed at open. */
  expiresAt: string;
  maxExchanges: number;
  exchanges: number;
  status: "OPEN" | "CLOSED" | "OVERRUN";
  /** `closed`, `expired`, or `exchanges_exhausted`. */
  closedReason?: string;
  goalId?: string;
  /** Budget line the session's tokens land on — not a second meter. */
  budgetKey?: string;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v ? v : fallback);

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x) : [];
}

/**
 * Every collaboration the retained event buffer knows about, open or ended.
 *
 * The buffer is a contiguous tail (`retainCap`), so a session whose
 * `collab.opened` is still in it has every one of its own messages in it too —
 * which is what makes the recounted meter exact rather than a lower bound. The
 * converse is the real limit and it is not fixable from here: once the open
 * event rolls off, the session is invisible to the client entirely, because no
 * endpoint will name it.
 *
 * The events are sorted by seq rather than trusted in array order: the store
 * appends, and a refill after a backgrounded tab re-ingests older events at the
 * END of the list. Counting in arrival order would then meter messages against
 * a session the fold had not opened yet.
 */
export function foldCollabs(events: readonly CollabEvent[]): CollabThread[] {
  const relevant = events
    .filter((e) => e.type === "collab.opened" || e.type === "collab.closed" || e.type === "message.sent")
    .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  const byThread = new Map<string, CollabThread>();

  for (const e of relevant) {
    const p = e.payload || {};

    if (e.type === "collab.opened") {
      const s = p.session;
      const threadId = str(s?.threadId);
      if (!threadId) continue;
      byThread.set(threadId, {
        threadId,
        topic: str(s.topic),
        openedBy: str(s.openedBy),
        participants: ids(s.participants),
        openedAt: str(s.openedAt, e.timestamp),
        expiresAt: str(s.expiresAt),
        maxExchanges: Number(s.maxExchanges) > 0 ? Number(s.maxExchanges) : 0,
        exchanges: Number(s.exchanges) || 0,
        status: "OPEN",
        goalId: str(s.goalId) || undefined,
        budgetKey: str(s.budgetKey) || undefined,
      });
      continue;
    }

    if (e.type === "collab.closed") {
      const t = byThread.get(str(p.threadId));
      if (!t) continue;
      // OVERRUN is kept distinct from CLOSED because they mean opposite things:
      // one session ended because someone decided it was done, the other ran
      // until a clock or a message budget stopped it. Collapsing them here
      // would hide exactly the runaway this card exists to catch.
      const reason = str(p.reason, "closed");
      t.status = reason === "closed" ? "CLOSED" : "OVERRUN";
      t.closedReason = reason;
      // The close event carries the server's own final counts. Prefer them:
      // they are authoritative where the recount is merely faithful.
      if (Number(p.exchanges) >= 0 && Number.isFinite(Number(p.exchanges))) t.exchanges = Number(p.exchanges);
      if (Number(p.maxExchanges) > 0) t.maxExchanges = Number(p.maxExchanges);
      continue;
    }

    // message.sent — the meter, and the only place participants grow. An
    // outsider who replies into the thread is in the room whether or not the
    // opener named them, which is how the kernel reads it too.
    const m = p.message;
    const t = m ? byThread.get(str(m.threadId)) : undefined;
    if (!t || t.status !== "OPEN") continue;
    t.exchanges++;
    for (const part of [str(m.from), ...ids(m.to)]) {
      if (part && !t.participants.includes(part)) t.participants.push(part);
    }
  }

  return [...byThread.values()];
}

/**
 * How close a session is to the edge that will end it.
 *
 * Both bounds are reported, and `worst` is the one that decides the tone,
 * because either of them closing the session costs the operator the same card.
 */
export interface CollabPressure {
  /** 0..1 of the exchange budget spent. */
  exchangeRatio: number;
  /** 0..1 of the wall-clock box spent. */
  timeRatio: number;
  /** ms left in the box; negative once the edge has passed, NaN if unstamped. */
  leftMs: number;
  /** The nearer of the two edges — what the tone is read off. */
  worst: number;
  tone: "ok" | "warn" | "bad";
}

/** The console already warns on spend at these marks (see Cost); a box is a
 *  budget too, and a second set of thresholds would only read as noise. */
export const COLLAB_WARN = 0.75;
export const COLLAB_BAD = 0.9;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function collabPressure(t: CollabThread, nowMs: number): CollabPressure {
  const opened = Date.parse(t.openedAt);
  const expires = Date.parse(t.expiresAt);
  const boxMs = expires - opened;
  const leftMs = expires - nowMs;
  // A box whose stamps do not parse reports no time pressure rather than a
  // made-up one: an invented "past its edge" on a healthy session would send
  // the operator looking for a runaway that does not exist.
  const timeRatio = Number.isFinite(boxMs) && boxMs > 0 ? clamp01(1 - leftMs / boxMs) : 0;
  const exchangeRatio = t.maxExchanges > 0 ? clamp01(t.exchanges / t.maxExchanges) : 0;
  const worst = Math.max(timeRatio, exchangeRatio);
  return {
    exchangeRatio,
    timeRatio,
    leftMs,
    worst,
    tone: worst >= COLLAB_BAD ? "bad" : worst >= COLLAB_WARN ? "warn" : "ok",
  };
}

/** Open sessions, nearest to their edge first — the reading order an operator
 *  wants when the card is there to warn them. */
export function pressedFirst(threads: readonly CollabThread[], nowMs: number): Array<{ t: CollabThread; p: CollabPressure }> {
  return threads
    .filter((t) => t.status === "OPEN")
    .map((t) => ({ t, p: collabPressure(t, nowMs) }))
    .sort((a, b) => b.p.worst - a.p.worst);
}
