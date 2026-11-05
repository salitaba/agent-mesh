import { parseArtifactUri, type Artifact, type GoalId } from "../../protocol/src/index";
import { openReviews } from "./projections-helpers";
import type { Projections } from "./state";

/**
 * The review queue, split by what the mission's own contract still depends on.
 *
 * A file cited as evidence by an acceptance criterion is part of what the mission
 * delivered; an uncited report nobody decided is residue — often the fourth
 * version of a TestReport whose third version was reviewed. On the live mission
 * of 2026-11-04 the queue stood at 99, and **5** were cited by a criterion. The
 * strict completion gate then cannot tell those two cases apart and blocks on
 * both, which is how "require reviews" turns into a deadlock without a remedy.
 *
 * This is the remedy's view: `cited` may never be archived by the system, and
 * `uncited` is exactly the set a curator may close, with a reason, reversibly.
 */

export interface ReviewDebt {
  /** Every artifact waiting on a verdict. */
  open: Artifact[];
  /** Open, and cited by an accepted criterion or named in a rejected-evidence list: the system must not close these. */
  cited: Artifact[];
  /** Open, uncited, and not a CodePatch: residue a curator may archive with a reason. */
  uncited: Artifact[];
  /** The names the criteria cite, for an audit line. */
  citedNames: string[];
}

export function reviewDebt(state: Projections, goalId: GoalId | undefined): ReviewDebt {
  const goal = goalId ? state.goals.get(goalId) : undefined;
  const citedNames = new Set<string>();
  for (const criterion of goal?.acceptanceCriteria ?? []) {
    for (const evidence of criterion.evidence) {
      const parsed = evidence.artifactRef?.uri ? parseArtifactUri(evidence.artifactRef.uri) : null;
      if (parsed) citedNames.add(parsed.name);
    }
    // An artifact the operator already rejected is one they have opinions about:
    // archiving it out from under them would hide the thing they rejected.
    for (const uri of criterion.rejectedEvidence ?? []) {
      const parsed = parseArtifactUri(uri);
      if (parsed) citedNames.add(parsed.name);
    }
  }
  const open = goalId ? openReviews(state, goalId) : [];
  const cited = open.filter((a) => citedNames.has(a.name));
  // Only READY, never UNDER_REVIEW: an artifact a reviewer has picked up is still
  // someone's, and the curator's job is the queue nobody decided. Code is never
  // closed by the system.
  const uncited = open.filter((a) => a.status === "READY_FOR_REVIEW" && !citedNames.has(a.name) && a.type !== "CodePatch");
  return { open, cited, uncited, citedNames: [...citedNames] };
}
