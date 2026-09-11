import type { TurnRecord } from "../../../packages/core/src/index";
import type { TurnStep } from "../../../packages/observability/src/index";

/**
 * Merge log-reconstructed turn steps with the in-memory tracker's live turns.
 *
 * The log carries lifecycle, ops and tokens but no sub-turn timing; a turn
 * still in flight may not have flushed its terminal event yet. Live data wins
 * per field, while log-derived fields survive through `prev` so both live and
 * replayed views of "any step" stay complete.
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
      ops: prev?.ops ?? { messages: 0, artifacts: 0, tasks: 0, decisions: 0 },
      messageIds: prev?.messageIds ?? [],
      artifactIds: prev?.artifactIds ?? [],
      tokens: t.tokens ?? prev?.tokens ?? 0,
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
      errorDetail: t.errorDetail ?? prev?.errorDetail,
      opTimings: t.opTimings ?? prev?.opTimings,
    });
  }
  return [...merged.values()];
}
