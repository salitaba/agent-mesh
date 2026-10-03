import type { ApprovalRecord } from "../../protocol/src/index";

/**
 * Who can supply what a gate is missing, and what becomes of a verdict when its artifact gets a new version.
 *
 * Both are said where a seat decides. The sixteenth cronlite run reached the finish line with every criterion evidenced (09:04:22)
 * and could not close for another 13 minutes 44 seconds: the developer's task carried the implementation gate
 * (`implementation.completed` requires `tech-lead.approve` and `qa.pass`), and QA's pass, given at 08:54:51, had been dropped at
 * 08:57:20, when QA published a new version of its own report (a new version drops every verdict recorded on the old one, by
 * design). Nothing told QA that its pass was gone. The developer's completion was refused with "missing: qa.pass", which names a
 * token and not who can give it or how: it was refused in three turns and nudged five times, asked QA once (who answered "recorded"
 * and recorded nothing), and raised an escalation that blamed "a system state synchronization issue".
 */

/** A seat as the roster knows it: the id a message is addressed to, and the role a gate may name instead. */
export interface RosterSeat {
  id: string;
  role: string;
}

interface Alternative {
  token: string;
  actor: string;
  kind: string;
}

/** `qa.pass`, or `qa.pass (superseded by qa.block)`, as `checkApprovals` labels what is missing. */
function parseAlternative(label: string): Alternative | undefined {
  const token = label.replace(/\s*\(superseded by [^)]*\)\s*$/, "").trim();
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return undefined;
  return { token, actor: token.slice(0, dot), kind: token.slice(dot + 1) };
}

/**
 * The route a refusal for missing approvals gives: for each missing requirement, the seats that can record it and the call that
 * does, and the two facts a claimant does not know. An empty list gives nothing.
 *
 * `missing` is `checkApprovals`' own: one entry per unmet requirement, its alternatives joined by `|`. A gate names an actor by seat
 * id or by role, so the seats are matched on both. The human is not a seat that records a gate's verdict.
 */
export function gateRoute(missing: readonly string[], seats: readonly RosterSeat[], humanId = "human"): string {
  const parts: string[] = [];
  for (const entry of missing) {
    const named: string[] = [];
    for (const label of entry.split("|")) {
      const alt = parseAlternative(label);
      if (!alt) continue;
      const holders = seats.filter((s) => s.id !== humanId && (s.id === alt.actor || s.role === alt.actor)).map((s) => s.id);
      named.push(
        holders.length > 0
          ? `${alt.token} is ${holders.join(" or ")}'s to give, with mesh_approve { kind: "${alt.kind}" }`
          : `${alt.token}: no seat holds it, so nothing in this mesh can give it`,
      );
    }
    if (named.length > 0) parts.push(named.join(", or "));
  }
  if (parts.length === 0) return "";
  return ` — ${parts.join("; ")}. You cannot give it for them: ask them, naming that call. A verdict given on an earlier version of an artifact does not stand once it has a newer one, so a seat that gave it may have to give it again.`;
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  approve: "approval",
  pass: "pass",
  reject: "rejection",
  block: "block",
  accept: "acceptance",
  merge: "merge approval",
  veto: "veto",
};

/**
 * What a seat is told when it publishes a new version of an artifact that carries verdicts: they are dropped.
 *
 * Empty when there are none. `publisher` is the seat reading this reply: its own verdicts are named as "yours", and the others'
 * as theirs to give again. `version` is the new version's number.
 */
export function droppedVerdictsNotice(dropped: readonly ApprovalRecord[], version: number, artifactId: string, publisher: string): string {
  const seen = new Set<string>();
  const each: Array<{ actor: string; kind: string }> = [];
  for (const r of dropped) {
    const key = `${r.actorId}|${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    each.push({ actor: r.actorId, kind: r.kind });
  }
  if (each.length === 0) return "";
  const list = each.map((v) => `${v.actor}'s ${KIND_WORDS[v.kind] ?? v.kind}`).join(", ");
  const mine = each.filter((v) => v.actor === publisher);
  const yours = mine.length > 0 ? ` Yours (${mine.map((v) => KIND_WORDS[v.kind] ?? v.kind).join(", ")}) is among them: record it again now if it still holds, with mesh_approve { kind: "${mine[0]!.kind}", artifactId: "${artifactId}" }.` : "";
  return `v${version} is new content, so the verdicts recorded on v${version - 1} are dropped (${list}): none of them stands for this version. Whoever gave one has to give it again on this one; a gate that names a verdict, such as qa.pass, stays unsatisfied until they do.${yours}`;
}
