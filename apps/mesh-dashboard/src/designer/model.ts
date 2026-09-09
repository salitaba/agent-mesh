/* Model facts + pure helpers: known capability list, mesh defaults, starter
 * templates, schema padding (densure), diff summary and error routing.
 * No React here — import from anywhere. */

import type { Tab } from "./types";

export const CAPS = ["repository.read", "repository.write", "architecture.write", "architecture.read", "review.design", "code.review", "task.assign", "test.execute", "test.write", "security.scan", "security.review", "git.commit", "git.merge", "shell.execute", "network.request"];

export const deepCopy = (v: any): any => JSON.parse(JSON.stringify(v));
export const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

export function fmtNum(n: any): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : String(n ?? "—");
}

export function setPath(obj: any, p: string, v: any): void {
  const k = p.split(".");
  let o = obj;
  for (let i = 0; i < k.length - 1; i++) o = o[k[i]] ??= {};
  o[k[k.length - 1]] = v;
}

/** Guarantee every optional section exists so panels can read/write blindly. */
export function densure(m: any): void {
  m.mesh ||= {};
  m.mesh.workspace ||= { path: "./workspace" };
  m.mesh.runtime ||= { default: "stub" };
  m.mesh.acceptance_criteria ||= [];
  m.startup ||= { activate: [] };
  m.agents ||= {};
  m.policies ||= {};
  m.policies.communication ||= {};
  m.policies.transitions ||= {};
  m.policies.escalation ||= { thread: { max_depth: 8 }, repeated_conflict: { threshold: 3 }, artifact_review_rounds: { max: 5 } };
  m.budgets ||= {};
  m.budgets.mission ||= { tokens: 2000000, wall_clock_minutes: 240, max_events: 10000 };
  m.budgets.agent ||= {};
  m.budgets.thread ||= { tokens: 50000 };
  m.budgets.task ||= { tokens: 100000 };
  m.scheduling ||= {};
  m.scheduling.mode ||= "event-driven";
  m.scheduling.activation ||= { strategy: "interest" };
  m.scheduling.triage ||= { mode: "off" };
  m.scheduling.triage.rules ||= [];
  m.scheduling.concurrency ||= { max_active_agents: 4 };
  m.scheduling.timeouts ||= {};
  m.server ||= { port: 7420 };
  for (const a of Object.values(m.agents) as any[]) {
    a.budget ||= {};
    a.session ||= {};
    a.delegation ||= {};
  }
}

/* ---------------- starter templates ---------------- */

export interface Template {
  key: string;
  name: string;
  desc: string;
  make: () => any;
}

function baseMesh(id: string, name: string, goal: string, runtime: string): any {
  return {
    version: 1,
    mesh: { id, name, goal, workspace: { path: "./workspace" }, runtime: { default: runtime } },
    startup: { activate: [] },
    agents: {},
    policies: { communication: {}, transitions: {}, escalation: { thread: { max_depth: 8 }, repeated_conflict: { threshold: 3 }, artifact_review_rounds: { max: 5 } } },
    budgets: { mission: { tokens: 2000000, wall_clock_minutes: 240, max_events: 10000 }, agent: {}, thread: { tokens: 50000 }, task: { tokens: 100000 } },
    scheduling: { mode: "event-driven", activation: { strategy: "interest" }, triage: { mode: "off", rules: [] }, concurrency: { max_active_agents: 4 }, timeouts: {} },
    server: { port: 7420 },
  };
}

function tplSolo(): any {
  const m = baseMesh("solo-builder", "Solo Builder", "Ship a small change end-to-end: design it, build it, test it.", "opencode");
  m.startup.activate = ["builder"];
  m.agents.builder = {
    role: "developer",
    capabilities: ["repository.read", "repository.write", "test.execute", "test.write", "git.commit"],
    interests: ["review.rejected", "goal.progress"],
    budget: { tokens: 600000 },
  };
  m.budgets.mission = { tokens: 800000, wall_clock_minutes: 120, max_events: 4000 };
  return m;
}

function tplTriad(): any {
  const m = baseMesh("my-mesh", "My Mesh", "Describe the mission goal here.", "stub");
  m.startup.activate = ["architect"];
  m.agents.architect = {
    role: "architect", capabilities: ["repository.read", "architecture.write", "review.design"], authority: ["architecture.approve"],
    interests: ["architecture.*", "design.question"], session: { persistent: true }, budget: { tokens: 300000 },
  };
  m.agents.developer = {
    role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"],
    interests: ["architecture.approved", "review.rejected"], budget: { tokens: 700000 },
  };
  m.agents.qa = {
    role: "qa", capabilities: ["test.execute", "test.write"], authority: ["quality.block"],
    interests: ["patch.ready", "release.candidate"], budget: { tokens: 200000 },
  };
  m.policies.communication = {
    architect: { may_contact: ["developer", "qa"] },
    developer: { may_contact: ["architect", "qa"] },
    qa: { may_contact: ["architect", "developer"] },
  };
  m.policies.transitions = { "patch.merge": { requires: ["architect.approve"] } };
  return m;
}

function tplSquad(): any {
  const m = baseMesh("full-squad", "Full Squad", "Build and ship a feature: requirements → architecture → implementation → QA → security → release.", "stub");
  m.budgets.mission = { tokens: 2000000, wall_clock_minutes: 60, max_events: 10000 };
  m.budgets.thread = { tokens: 100000 };
  m.scheduling.concurrency = { max_active_agents: 4 };
  m.scheduling.timeouts = { turn_timeout_ms: 300000, wait_wakeup_ms: 3000 };
  const A: Record<string, any> = {
    pm: { role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: ["requirement.blocked", "goal.progress", "release.candidate", "implementation.completed"] },
    architect: { role: "architect", capabilities: ["repository.read", "architecture.write", "review.design"], authority: ["architecture.approve"], interests: ["architecture.*", "design.question", "requirements.created"] },
    "tech-lead": { role: "tech-lead", capabilities: ["repository.read", "code.review", "review.design", "task.assign", "git.merge"], authority: ["implementation.approve"], interests: ["patch.ready", "review.requested"] },
    developer: { role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: ["architecture.approved", "review.rejected"] },
    qa: { role: "qa", capabilities: ["test.execute", "test.write"], authority: ["quality.block"], interests: ["patch.ready", "release.candidate"] },
    security: { role: "security", capabilities: ["security.scan", "security.review"], authority: ["security.block"], interests: ["release.candidate", "authentication.changed", "dependency.changed"] },
    explorer: { role: "explorer", mode: "service", capabilities: ["repository.read"], interests: ["research.requested"] },
  };
  for (const [id, a] of Object.entries(A)) {
    a.session = { persistent: true };
    a.budget = { tokens: 250000 };
    m.agents[id] = a;
  }
  const C = (list: string[]) => ({ may_contact: list });
  const all = (id: string, others: string[]) => C(others.filter((x) => x !== id));
  const names = Object.keys(A);
  m.policies.communication = {
    pm: all("pm", ["architect", "tech-lead", "developer", "qa", "security"]),
    architect: all("architect", ["developer", "tech-lead", "explorer", "pm"]),
    "tech-lead": all("tech-lead", names),
    developer: all("developer", ["architect", "tech-lead", "explorer", "qa"]),
    qa: all("qa", ["developer", "tech-lead", "architect", "security", "pm"]),
    security: all("security", ["developer", "tech-lead", "qa", "pm"]),
    explorer: { may_contact: [] },
  };
  m.policies.transitions = {
    "patch.merge": { requires: ["tech-lead.approve"] },
    "implementation.completed": { requires: ["tech-lead.approve", "qa.pass"] },
    "release.accepted": { requires: ["qa.pass", "security.pass"] },
  };
  m.startup.activate = ["pm"];
  return m;
}

export const TEMPLATES: Template[] = [
  { key: "solo", name: "Solo builder", desc: "one agent, no gates", make: tplSolo },
  { key: "triad", name: "Triad", desc: "architect · developer · qa", make: tplTriad },
  { key: "squad", name: "Full squad", desc: "7 roles, review + release gates", make: tplSquad },
];

/* ---------------- diff summary (review before save) ---------------- */

export function summarizeDiff(cur: any, base: any | null): string[] {
  if (!base) return [];
  const out: string[] = [];
  if (cur?.mesh?.id !== base?.mesh?.id) out.push(`mesh id “${base?.mesh?.id}” → “${cur?.mesh?.id}”`);
  if ((cur?.mesh?.goal || "") !== (base?.mesh?.goal || "")) out.push("goal text changed");
  const ca = Object.keys(cur?.agents || {});
  const ba = Object.keys(base?.agents || {});
  for (const id of ca.filter((x) => !ba.includes(x))) out.push(`agent +${id}`);
  for (const id of ba.filter((x) => !ca.includes(x))) out.push(`agent −${id}`);
  for (const id of ca.filter((x) => ba.includes(x))) {
    const keys = new Set([...Object.keys(cur.agents[id] || {}), ...Object.keys(base.agents[id] || {})]);
    const changed = [...keys].filter((k) => JSON.stringify((cur.agents[id] || {})[k]) !== JSON.stringify((base.agents[id] || {})[k]));
    if (changed.length) out.push(`agent ~${id} (${changed.join(", ")})`);
  }
  const ct = cur?.policies?.transitions || {};
  const bt = base?.policies?.transitions || {};
  for (const g of Object.keys(ct).filter((x) => !(x in bt))) out.push(`gate +${g}`);
  for (const g of Object.keys(bt).filter((x) => !(x in ct))) out.push(`gate −${g}`);
  for (const g of Object.keys(ct).filter((x) => x in bt)) {
    if (JSON.stringify(ct[g]) !== JSON.stringify(bt[g])) out.push(`gate ~${g}`);
  }
  if (JSON.stringify(cur?.policies?.communication || {}) !== JSON.stringify(base?.policies?.communication || {})) out.push("wiring changed");
  if (JSON.stringify(cur?.startup?.activate || []) !== JSON.stringify(base?.startup?.activate || [])) {
    out.push(`startup: ${(base?.startup?.activate || []).join(", ") || "none"} → ${(cur?.startup?.activate || []).join(", ") || "none"}`);
  }
  if (JSON.stringify(cur?.budgets?.mission) !== JSON.stringify(base?.budgets?.mission)) {
    out.push(`mission budget → ${fmtNum(cur?.budgets?.mission?.tokens)} tokens / ${fmtNum(cur?.budgets?.mission?.wall_clock_minutes)} min / ${fmtNum(cur?.budgets?.mission?.max_events)} events`);
  }
  return out;
}

/* ---------------- error → inspector tab routing ---------------- */

export function tabOfError(e: string): Tab {
  const s = e.toLowerCase();
  if (s.includes("transition") || s.includes("escalation") || s.includes("budget")) return "policy";
  if (s.includes("communication") || s.includes("may_contact") || s.includes("may_be_contacted") || s.includes("startup") || s.includes("activate") || s.includes("agent") || s.includes("interest")) return "crew";
  return "mesh";
}


