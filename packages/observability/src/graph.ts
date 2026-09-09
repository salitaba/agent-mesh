import type { Projections } from "../../core/src/state";

export interface GraphEdge {
  from: string;
  to: string;
  kind: "REQUEST" | "APPROVE" | "BLOCK" | "ESCALATE" | "INFORM" | "OTHER";
  count: number;
  lastAt: string;
}

export interface GraphNode {
  id: string;
  role: string;
  lifecycle: string;
  tokens: number;
  activations: number;
  mailbox: number;
}

export function buildMeshGraph(state: Projections): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [...state.agents.values()].map((r) => ({
    id: r.definition.id,
    role: r.definition.role,
    lifecycle: r.state.lifecycle,
    tokens: r.state.tokensConsumed,
    activations: r.state.activations,
    mailbox: state.unread.get(r.definition.id)?.length ?? 0,
  }));
  const edgeMap = new Map<string, GraphEdge>();
  const kindOf = (t: string): GraphEdge["kind"] =>
    t.startsWith("REQUEST") || t === "DELEGATE"
      ? "REQUEST"
      : t === "APPROVE"
        ? "APPROVE"
        : t === "BLOCK" || t === "VETO" || t === "REJECT"
          ? "BLOCK"
          : t === "ESCALATE"
            ? "ESCALATE"
            : t === "INFORM" || t === "DONE"
              ? "INFORM"
              : "OTHER";
  for (const m of state.messages.values()) {
    for (const target of m.to) {
      const key = `${m.from}|${target}|${kindOf(m.type)}`;
      const e = edgeMap.get(key) ?? { from: m.from, to: target, kind: kindOf(m.type), count: 0, lastAt: m.timestamp };
      e.count++;
      if (m.timestamp > e.lastAt) e.lastAt = m.timestamp;
      edgeMap.set(key, e);
    }
  }
  return { nodes, edges: [...edgeMap.values()] };
}
