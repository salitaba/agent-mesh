/* Where in the Designer a validation message is about.
 *
 * The server's checks come back as sentences in four shapes: a schema path (`/agents/pm/role: must NOT have fewer than 1
 * characters`), a dotted config path (`policies.communication.pm.may_contact references unknown agent 'ghost'`), a seat named in
 * quotes (`agent 'pm' has invalid interest expression ...`), and a gate or rule named in quotes. The review used to send every one of
 * them to a tab by keyword and leave the person to hunt for the field. This reads the sentence for the seat and the section it names,
 * so the click can open that seat, that part of its form, and the first control in it.
 *
 * DOM-free, so tests/dashboard can pin the readings against the strings the server really sends. */

import type { Tab } from "./types";

/** The parts of the inspector a message can point at. Each is the `id` suffix of a section in the panels (`ins-sec-<section>`). */
export type Section =
  | "general" | "behavior" | "tools" | "communication" | "budget" | "advanced"
  | "identity" | "goal" | "criteria" | "runtime" | "defaults" | "concurrency" | "triage" | "timeouts" | "server"
  | "gates" | "escalation" | "budgets" | "rules";

export interface Where {
  tab: Tab;
  /** The seat the message is about, when it names one that exists. */
  seat?: string;
  section?: Section;
  /** A control inside the section, by its `data-field`. */
  field?: string;
  /** False when the Designer has no control for this (a file-level key): the review says to edit mesh.yaml instead of offering a jump. */
  editable: boolean;
}

const SEAT_SECTION: Record<string, Section> = {
  role: "general", model: "general", runtime: "general", variant: "general", mode: "general",
  prompt: "behavior", interests: "behavior",
  capabilities: "tools", authority: "tools",
  budget: "budget",
  session: "advanced", delegation: "advanced", wake: "advanced", hard_actions: "advanced", context_window: "advanced",
};

const MESH_SECTION: Record<string, Section> = {
  id: "identity", name: "identity", workspace: "identity",
  goal: "goal", acceptance_criteria: "criteria", generate_acceptance_criteria: "criteria",
  runtime: "runtime", defaults: "defaults",
};

/** Keys that exist in a mesh file and have no control in the Designer. */
const FILE_ONLY = new Set(["project", "bus", "sandbox", "audit", "extensions"]);

const quoted = (s: string): string[] => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1]!);

/** What a section is called on screen. */
export const SECTION_LABEL: Record<Section, string> = {
  general: "General", behavior: "Behavior", tools: "Tools", communication: "Communication", budget: "Budget", advanced: "Advanced",
  identity: "Identity", goal: "Goal", criteria: "Done-when checks", runtime: "Runtime", defaults: "Seat defaults", concurrency: "Concurrency",
  triage: "Triage", timeouts: "Timeouts", server: "Server", gates: "Gates", escalation: "Escalation", budgets: "Budgets", rules: "Policy rules",
};

const TAB_LABEL: Record<Tab, string> = { crew: "Seat", mesh: "Mesh", policy: "Policy" };

/** The words on the button that goes there: "Open pm: Tools", "Open Policy: Gates", "Open Mesh". */
export function whereLabel(w: Where): string {
  const part = w.section ? `: ${SECTION_LABEL[w.section]}` : "";
  if (w.seat) return `Open ${w.seat}${part}`;
  return `Open ${TAB_LABEL[w.tab]}${part}`;
}

/** Read what a validation message is about. `seats` are the seat ids in the draft, so a name is only taken for a seat if it is one. */
export function locateIssue(text: string, seats: string[]): Where {
  const t = text.trim();
  const isSeat = (id: string | undefined): id is string => !!id && seats.includes(id);

  // /agents/<id>/<field>: ...   (schema path)
  let m = /^\/agents\/([^/:\s]+)(?:\/([^/:\s]+))?/.exec(t);
  if (m) {
    const [, id, field] = m;
    return { tab: "crew", seat: isSeat(id) ? id : undefined, section: SEAT_SECTION[field ?? ""] ?? "general", field, editable: true };
  }
  if (/^\/agents\b/.test(t)) return { tab: "crew", section: "general", editable: true };

  // /mesh/<field>: ...
  m = /^\/mesh(?:\/([^/:\s]+))?/.exec(t);
  if (m) {
    const field = m[1];
    return { tab: "mesh", section: field ? MESH_SECTION[field] ?? "identity" : "identity", field, editable: true };
  }
  m = /^\/([a-z_]+)/.exec(t);
  if (m && FILE_ONLY.has(m[1]!)) return { tab: "mesh", editable: false };

  // The Designer's own note about a seat that still has the role it was created with. It says "a policy rule can name a role", so it is read
  // before the sentences below, which take any mention of a policy rule for a message about one.
  m = /^Seat '([^']+)' still has the placeholder role\b/.exec(t);
  if (m) return { tab: "crew", seat: isSeat(m[1]) ? m[1] : undefined, section: "general", field: "role", editable: true };

  // policies.communication.<id>.may_contact references unknown agent 'x'
  m = /^policies\.communication\.([^.\s]+)\.(may_contact|may_be_contacted_by)/.exec(t);
  if (m) return { tab: "crew", seat: isSeat(m[1]) ? m[1] : undefined, section: "communication", field: m[2], editable: true };

  if (/^startup\.activate/.test(t)) return { tab: "crew", section: "behavior", field: "start", editable: true };

  // transition gate 'g' ... / gate 'g' token ...
  if (/^(transition )?gate\b/i.test(t) || /\btransitions?\b/i.test(t)) return { tab: "policy", section: "gates", field: quoted(t)[0], editable: true };
  if (/^policy rule\b/i.test(t) || /\bpolicy rules?\b/i.test(t)) return { tab: "policy", section: "rules", field: quoted(t)[0], editable: true };
  if (/^(policies\.)?escalation\b/i.test(t)) return { tab: "policy", section: "escalation", editable: true };
  if (/^budgets?\./i.test(t) || /\bbudgets?\b/i.test(t) && !/^agent '/.test(t)) return { tab: "policy", section: "budgets", editable: true };
  if (/^scheduling\.triage/i.test(t)) return { tab: "mesh", section: "triage", editable: true };
  if (/^scheduling\./i.test(t)) return { tab: "mesh", section: "concurrency", editable: true };
  if (/^server\./i.test(t)) return { tab: "mesh", section: "server", editable: true };

  // mesh.yaml declares no project.id ...
  if (/^mesh\.yaml\b/i.test(t) || /\bproject\.id\b/.test(t)) return { tab: "mesh", editable: false };

  // startup.activate is empty ...
  if (/startup\.activate/.test(t)) return { tab: "crew", section: "behavior", field: "start", editable: true };

  // agent 'x' ... : the seat is named in quotes
  m = /^agent '([^']+)'/.exec(t);
  const named = m ? m[1] : quoted(t).find((q) => seats.includes(q));
  if (named !== undefined) {
    const section: Section =
      /\binterest/.test(t) ? "behavior"
      : /\bwired to nobody|\bmay_contact|\bmay_be_contacted/.test(t) ? "communication"
      : /\bprompt\b/.test(t) ? "behavior"
      : /\bholds '|\bcapabilit|\bauthority/.test(t) ? "tools"
      : /\bbudget/.test(t) ? "budget"
      : "general";
    return { tab: "crew", seat: isSeat(named) ? named : undefined, section, editable: true };
  }

  return { tab: "mesh", editable: true };
}
