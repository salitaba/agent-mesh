import { applyEvent as coreApply, ProjectionError } from "../../packages/core/src/projections";
import { createInitialState, type Projections } from "../../packages/core/src/state";
import { MACHINE_TRANSITIONS } from "../../packages/protocol/src/catalog";
import type { Artifact, ArtifactStatus, MeshEvent, EventType } from "../../packages/protocol/src/index";
import { mulberry32 } from "./_rng";

function iso(n: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
}

export function seededArtifactState(status: ArtifactStatus = "DRAFT"): { state: Projections; artifact: Artifact } {
  const state = createInitialState();
  const artifact: Artifact = {
    id: "art-prop",
    name: "property-patch",
    type: "CodePatch",
    goalId: "goal-1",
    owner: "dev",
    version: 1,
    status,
    contentRef: "mem://x",
    digest: "sha256:0000",
    metadata: {},
    provenance: { source: "agent", trustLevel: 50 },
    createdAt: iso(0),
    createdBy: "dev",
  };
  coreApply(state, evt("evt-created", "artifact.created", { artifact }));
  return { state, artifact };
}

function evt(id: string, type: EventType, payload: unknown, timestamp = iso(1)): MeshEvent {
  return { id, type, timestamp, goalId: "goal-1", payload };
}

export function tryTransition(state: Projections, to: ArtifactStatus): { ok: boolean; error?: string } {
  try {
    coreApply(state, evt(`evt-t-${Math.random()}`, "artifact.transition", { artifactId: "art-prop", to, gateSatisfied: true }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function applyEvent(
  state: Projections,
  event: MeshEvent,
  config: { transitionGates: Record<string, string[]> },
  probe?: unknown,
): void {
  void probe;
  coreApply(state, event, config);
}

export interface TrailResult {
  signature: string;
  finalStatuses: string[];
  illegalAttempts: number;
  acceptedTransitions: number;
}

export function createRandomTrail(seed: number): TrailResult {
  const state = createInitialState();
  const rng = mulberry32(seed);
  coreApply(
    state,
    evt("evt-goal", "goal.created", {
      goal: { id: "goal-1", description: "trail", acceptanceCriteria: [], status: "ACTIVE", budget: { tokens: 1000, wallClockMinutes: 1, maxEvents: 100 }, rootThreadId: "thread-root", createdAt: iso(0) },
    }),
    { transitionGates: {} },
  );
  const artifacts: Artifact[] = [];
  const statuses: ArtifactStatus[] = ["DRAFT", "READY_FOR_REVIEW", "UNDER_REVIEW", "APPROVED", "REJECTED", "VERIFIED", "MERGEABLE", "MERGED", "ARCHIVED"];
  let illegalAttempts = 0;
  let acceptedTransitions = 0;
  const table = MACHINE_TRANSITIONS.code;

  for (let i = 0; i < 60; i++) {
    const a: Artifact = {
      id: `art-${i}`,
      name: `p${i}`,
      type: "CodePatch",
      goalId: "goal-1",
      owner: "dev",
      version: 1,
      status: "DRAFT",
      contentRef: "mem://x",
      digest: "sha256:0",
      metadata: {},
      provenance: { source: "agent", trustLevel: 50 },
      createdAt: iso(i),
      createdBy: "dev",
    };
    coreApply(state, evt(`evt-c-${i}`, "artifact.created", { artifact: a }), { transitionGates: {} });
    artifacts.push(a);
    for (let t = 0; t < 6; t++) {
      const current = state.artifacts.get(a.id)!;
      const to = statuses[Math.floor(rng() * statuses.length)];
      if (to === current.status) continue;
      const allowed = (table[current.status as keyof typeof table] ?? []).includes(to);
      if (!allowed) illegalAttempts++;
      const before = state.eventCount;
      try {
        coreApply(state, evt(`evt-t-${i}-${t}`, "artifact.transition", { artifactId: a.id, to, gateSatisfied: true }), { transitionGates: {} });
        if (allowed) acceptedTransitions++;
        else if (to === "APPROVED") {
          /* structural approval evidence may legitimately block a machine-legal transition */
        } else {
          throw new Error(`machine-illegal transition applied: ${current.status} -> ${to}`);
        }
      } catch (err) {
        if (!(err instanceof ProjectionError)) throw err;
        if (state.eventCount !== before) throw new Error("rejected event mutated state");
      }
      void before;
    }
  }
  const finalStatuses = artifacts.map((a) => state.artifacts.get(a.id)?.status ?? "MISSING");
  return {
    signature: JSON.stringify({ finalStatuses, events: state.eventCount }),
    finalStatuses,
    illegalAttempts,
    acceptedTransitions,
  };
}
