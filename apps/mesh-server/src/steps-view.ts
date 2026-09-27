import { boundOpTiming, type TurnRecord } from "../../../packages/core/src/index";
import type { EventStore } from "../../../packages/event-store/src/index";
import { buildTurnSteps, currentToolOf, type TurnStep } from "../../../packages/observability/src/index";
import type { MeshEvent } from "../../../packages/protocol/src/index";

/**
 * The part of the event store the step views read: a tail window, and the
 * correlation index for one turn's own events. Injected so the fill below can
 * be tested without a server or a supervisor.
 */
export type StepEventReader = Pick<EventStore, "read">;

/**
 * Merge log-reconstructed turn steps with the in-memory tracker's live turns.
 *
 * The log carries lifecycle, ops and tokens but no sub-turn timing; a turn
 * still in flight may not have flushed its terminal event yet. Live data wins
 * per field, while log-derived fields survive through `prev` so both live and
 * replayed views of "any step" stay complete.
 *
 * A live turn with no log step keeps `ops` undefined. Its counts are unknown,
 * which is a different statement from zero. Callers that want real counts for
 * such a turn go through `fillTurnSteps`, which reads its events first.
 */
export function mergeTurnSteps(fromLog: TurnStep[], live: TurnRecord[]): TurnStep[] {
  const merged = new Map<string, TurnStep>();
  for (const s of fromLog) merged.set(s.turnId, s);
  for (const t of live) {
    const prev = merged.get(t.turnId);
    merged.set(t.turnId, {
      turnId: t.turnId,
      agentId: t.agentId,
      reasonKind: t.reason.kind,
      reasonNote: t.reason.note ?? (t.reason as unknown as Record<string, unknown>).eventType as string | undefined,
      triggerEventType: (t.reason as unknown as Record<string, unknown>).eventType as string | undefined,
      startedAt: t.startedAt,
      endedAt: t.endedAt ?? prev?.endedAt,
      durationMs: t.durationMs ?? prev?.durationMs,
      status: t.status === "ok" ? "ok" : t.status === "waiting" ? "waiting" : t.status === "blocked" ? "blocked" : t.status === "failed" ? "failed" : prev?.status ?? "running",
      lifecycle: prev?.lifecycle ?? (t.status === "running" ? "THINKING" : "IDLE"),
      // Never a fabricated `{0,0,0,0}`. The tracker does not count ops; only
      // the log does, so with no log step there is nothing to report.
      ops: prev?.ops,
      messageIds: prev?.messageIds ?? [],
      artifactIds: prev?.artifactIds ?? [],
      tokens: t.tokens ?? prev?.tokens ?? 0,
      // The split lives on `TurnRecord` and on the log-derived step; carrying it
      // here is what lets the drawer show in/out for a turn that has aged out of
      // the tracker's ring, where only the log-reconstructed step survives.
      tokensInput: t.tokensInput ?? prev?.tokensInput,
      tokensOutput: t.tokensOutput ?? prev?.tokensOutput,
      tokensCacheRead: t.tokensCacheRead ?? prev?.tokensCacheRead,
      tokensThinking: t.tokensThinking ?? prev?.tokensThinking,
      model: t.model ?? prev?.model,
      error: t.error ?? prev?.error,
      seqStart: prev?.seqStart ?? 0,
      seqEnd: prev?.seqEnd ?? 0,
      eventCount: prev?.eventCount ?? 0,
      // Sub-turn timing exists only in memory — the log has no marks — so it
      // rides along here or not at all.
      phases: t.phases ?? prev?.phases,
      attempt: t.attempt ?? prev?.attempt,
      streamChars: t.streamChars ?? prev?.streamChars,
      toolFrames: t.toolFrames ?? prev?.toolFrames,
      errorDetail: t.errorDetail ?? prev?.errorDetail,
      // Bounded again on the way out: records persisted before the tracker
      // bounded at write time still carry every read_artifact's full body as
      // its `reason` — 93% of a 1.5 MB payload this list polls every 3.5s.
      opTimings: (t.opTimings ?? prev?.opTimings)?.map(boundOpTiming),
      // What a long turn is doing while it does it. Live-only like the marks
      // above, so there is no `prev` to fall back to — and only summaries: the
      // call list, the file list and the advisory texts stay on `/turns/:id`,
      // because this payload is polled at limit 60 every few seconds.
      toolCallCount: t.toolCallCount,
      currentTool: currentToolOf(t.liveTools),
      deadlineAt: t.phases?.deadlineAt,
      ceilingAt: t.phases?.ceilingAt,
      liveTokens: t.liveTokens,
      filesTouchedCount: Array.isArray(t.filesTouched) ? t.filesTouched.length : undefined,
      advisoryCount: Array.isArray(t.advisories) ? t.advisories.length : undefined,
    });
  }
  return [...merged.values()];
}

/**
 * Whether an event names this turn without carrying it as its correlation id.
 * In-turn operator messages carry no correlationId, so the index alone would
 * omit them; this is the rule `/turns/:id` scans the tail with.
 */
export function namesTurn(e: MeshEvent, turnId: string): boolean {
  return (e.payload as Record<string, unknown> | null)?.turnId === turnId || e.causationId === turnId;
}

/**
 * One turn's events: the correlation-index read plus any extras found by a
 * scan, deduplicated by id and put back in log order.
 *
 * The order matters twice. The timeline reads top to bottom, and `/turns/:id`
 * used to append the scanned extras after the indexed events, so they rendered
 * after the turn's close. And `buildTurnSteps` is a fold over the log: the last
 * state change it sees becomes the step's lifecycle, and a side effect seen
 * before its step is opened is dropped.
 */
export function turnEvents(indexed: MeshEvent[], extras: MeshEvent[]): MeshEvent[] {
  const seen = new Set<string>();
  const out: MeshEvent[] = [];
  for (const e of [...indexed, ...extras]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  // `sort` is stable, so events without a seq keep the order they came in.
  return out.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * How much of the log tail the step views scan for a given output size. A turn
 * spans a handful of events; turns older than the window are read through the
 * correlation index by `fillTurnSteps`, so the window only sets cost.
 */
export function stepWindow(limit: number): number {
  return Math.min(2000, Math.max(400, limit * 10));
}

/**
 * Build turn steps from a log window, then complete every step the window
 * could not see whole by reading that turn's own events through the
 * correlation index, and merge in the live tracker.
 *
 * A step is incomplete in two ways, and both produced wrong counts:
 *
 * - A tracker turn older than the window got no log step at all, and the merge
 *   used to invent four zeros for it. The tracker ring and the tail window are
 *   sized independently, so this was common: a ring of 60 turns easily reaches
 *   further back than 600 events.
 * - A turn that straddles the window's start got a partial step. Its opening
 *   `agent.awakened` was cut off, so the step was opened late by a state change
 *   and every side effect before that was dropped.
 *
 * A step is whole exactly when its `seqStart` is an `agent.awakened` inside the
 * window. Those are left as they are: the window saw them from the start, and a
 * re-read from the index would lose events that were attributed to the running
 * turn without carrying its id.
 */
export async function fillTurnSteps(
  window: MeshEvent[],
  live: TurnRecord[],
  reader: StepEventReader,
  logLimit: number,
): Promise<TurnStep[]> {
  const fromLog = buildTurnSteps(window, logLimit);
  const opened = new Set<number>();
  for (const e of window) if (e.type === "agent.awakened" && e.seq !== undefined) opened.add(e.seq);
  const byId = new Map(fromLog.map((s) => [s.turnId, s]));
  const whole = (s: TurnStep | undefined): boolean => s !== undefined && opened.has(s.seqStart);

  const toRead = new Set<string>();
  for (const s of fromLog) if (!whole(s)) toRead.add(s.turnId);
  for (const t of live) if (!whole(byId.get(t.turnId))) toRead.add(t.turnId);

  if (toRead.size > 0) {
    // Index the window's extras once rather than rescanning it per turn.
    const extras = new Map<string, MeshEvent[]>();
    const note = (id: unknown, e: MeshEvent): void => {
      if (typeof id !== "string" || !toRead.has(id)) return;
      const list = extras.get(id);
      if (list) list.push(e);
      else extras.set(id, [e]);
    };
    for (const e of window) {
      const tid = (e.payload as Record<string, unknown> | null)?.turnId;
      note(tid, e);
      if (e.causationId !== tid) note(e.causationId, e);
    }
    for (const turnId of toRead) {
      const indexed = await reader.read({ correlationId: turnId });
      const events = turnEvents(indexed, extras.get(turnId) ?? []);
      if (events.length === 0) continue;
      const step = buildTurnSteps(events, Infinity).find((s) => s.turnId === turnId);
      // A step the index could not rebuild keeps whatever the window had;
      // with none at all, the merge leaves its counts unknown.
      if (step) byId.set(turnId, step);
    }
  }
  return mergeTurnSteps([...byId.values()], live);
}

/**
 * The step list `/steps` and `mesh_steps` both answer with: the newest `limit`
 * steps by start time, after `keep`. Filtering happens before the cut, so a
 * filtered query still returns up to `limit` matches from the candidates.
 */
export async function recentTurnSteps(
  reader: StepEventReader,
  live: TurnRecord[],
  limit: number,
  keep: (s: TurnStep) => boolean = () => true,
): Promise<TurnStep[]> {
  const window = await reader.read({ tail: stepWindow(limit) });
  const steps = await fillTurnSteps(window, live, reader, limit * 2);
  return steps
    .filter(keep)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, limit);
}
