/* Model facts + pure helpers: known capability list, mesh defaults, starter
 * templates, schema padding (densure) and error routing. No React here — import
 * from anywhere. What changed between two configs lives in ./diff, what a seat or
 * wire edit does in ./edits. */

import { AUTHORITY_DOMAINS, AUTHORITY_TOKENS, AUTHORITY_VERBS, CAPABILITY_TOKENS } from "../../../../packages/protocol/src/catalog";
import { GOAL_PLACEHOLDER } from "../goal";
import { locateIssue } from "./locate";
import type { Tab } from "./types";

/* Derived, not duplicated: this list was hand-maintained and drifted — it was
 * missing `request_review`, so the designer could not offer a token the runtime
 * accepts. Sourcing it from the runtime's own catalog makes that class of drift
 * impossible rather than merely fixed once. */
export const CAPS: string[] = [...CAPABILITY_TOKENS];

/** What a seat may hold as authority, from the same catalogue the runtime checks: a token outside it grants nothing. */
export const AUTHORITY = {
  domains: AUTHORITY_DOMAINS as readonly string[],
  /** The verbs the grid offers. `*` is the wildcard the human seat holds; it is shown when a file has it, not offered as a switch. */
  verbs: AUTHORITY_VERBS.filter((v) => v !== "*") as readonly string[],
  tokens: AUTHORITY_TOKENS,
};

/* Capability → permissions group. Explicit for every known CAPS entry because
 * the name and the prefix don't always agree (`code.review` is Review, not
 * "code"); unknown caps fall back to a known sibling prefix, then `OTHER`. */
export const CAP_GROUP: Record<string, string> = {
  "repository.read": "Repository",
  "repository.write": "Repository",
  "architecture.read": "Architecture",
  "architecture.write": "Architecture",
  "review.design": "Review",
  "code.review": "Review",
  "task.assign": "Tasks",
  "test.execute": "Execution",
  "test.write": "Execution",
  "security.scan": "Security",
  "security.review": "Security",
  "git.commit": "Version control",
  "git.merge": "Version control",
  "shell.execute": "Execution",
  "network.request": "Execution",
  request_review: "Review",
};

export const OTHER_CAP_GROUP = "Other";

export function capGroup(cap: string): string {
  const known = CAP_GROUP[cap];
  if (known) return known;
  const prefix = cap.split(".")[0];
  const sibling = prefix ? CAPS.find((c) => c.split(".")[0] === prefix) : undefined;
  return (sibling && CAP_GROUP[sibling]) || OTHER_CAP_GROUP;
}

export interface CapGroup {
  group: string;
  caps: string[];
}

/** Bucket `caps` into groups; group order follows CAPS (first appearance).
 * Custom/unknown caps join their prefix group, or the fallback bucket. */
export function groupCaps(caps: string[]): CapGroup[] {
  const out: CapGroup[] = [];
  const index = new Map<string, CapGroup>();
  const bucket = (g: string): CapGroup => {
    let b = index.get(g);
    if (!b) {
      b = { group: g, caps: [] };
      index.set(g, b);
      out.push(b);
    }
    return b;
  };
  for (const c of CAPS) if (caps.includes(c)) bucket(capGroup(c)).caps.push(c);
  for (const c of caps) if (!CAPS.includes(c)) bucket(capGroup(c)).caps.push(c);
  return out;
}

export const deepCopy = (v: any): any => JSON.parse(JSON.stringify(v));
export const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

/* ---------------- save-path helpers ---------------- */

/** Lexically resolve `.`/`..` and duplicate slashes the way the server's path.resolve would. */
export function normalizeSavePath(p: string): string {
  const raw = p.trim().replace(/\\/g, "/");
  const abs = raw.startsWith("/");
  const out: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!abs) out.push(part);
    } else out.push(part);
  }
  return (abs ? "/" : "") + out.join("/");
}

/** Last path segment — the save hint names the file it will actually write. */
export function baseName(p: string): string {
  const parts = normalizeSavePath(p).split("/");
  return parts[parts.length - 1] || p;
}

/**
 * True when saving to `target` would land on the running file. Mirrors the server:
 * relative paths resolve against the running file's directory (config.dir is
 * dirname(filePath)) and a directory target gets mesh.yaml appended. Symlinks and a
 * server restarted with a different config are beyond what the client can see.
 */
export function saveLandsOnRunning(target: string, running: string): boolean {
  const r = normalizeSavePath(running);
  const raw = target.trim();
  const dir = r.slice(0, Math.max(0, r.lastIndexOf("/"))) || "/";
  const t = raw.startsWith("/") ? normalizeSavePath(raw) : normalizeSavePath(`${dir}/${raw}`);
  return t === r || `${t}/mesh.yaml` === r;
}

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
  // No `activation` seeding: both keys it ever held (`strategy`,
  // `max_activation_delay_ms`) are inert and no longer editable, so seeding it
  // would write an empty block into every saved mesh.yaml for nobody.
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
  /** How many seats it brings, so the picker can say so without building one. */
  seats: number;
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
    scheduling: { mode: "event-driven", triage: { mode: "off", rules: [] }, concurrency: { max_active_agents: 4 }, timeouts: {} },
    server: { port: 7420 },
  };
}

function tplSolo(): any {
  const m = baseMesh("solo-builder", "Solo Builder", "Ship a small change end-to-end: design it, build it, test it.", "stub");
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
  const m = baseMesh("my-mesh", "My Mesh", GOAL_PLACEHOLDER, "stub");
  m.startup.activate = ["architect"];
  m.agents.architect = {
    role: "architect", capabilities: ["repository.read", "architecture.write", "review.design", "code.review"], authority: ["architecture.approve", "implementation.approve"],
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
  { key: "solo", name: "Solo builder", desc: "One seat that designs, builds and tests. No gates.", seats: 1, make: tplSolo },
  { key: "triad", name: "Triad", desc: "An architect, a developer and a tester, with a merge gate.", seats: 3, make: tplTriad },
  { key: "squad", name: "Full squad", desc: "Seven roles with review and release gates.", seats: 7, make: tplSquad },
];

/* ---------------- the goal a scaffold starts with ---------------- */

// The placeholder and its length are the console's one answer (../goal), shared with the welcome, the top bar and the Start dialog.
export { GOAL_MAX, GOAL_PLACEHOLDER, goalIsPlaceholder } from "../goal";

/* ---------------- error → inspector tab routing ---------------- */

export function tabOfError(e: string): Tab {
  return locateIssue(e, []).tab;
}
