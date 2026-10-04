/**
 * The welcome and the "New project" chooser: what each way of starting may truthfully say, and when it may proceed.
 * DOM-free (see route.ts), because every line a card prints about a starting point is a claim about the host or about
 * files that are about to be written, and the person acts on it.
 *
 * Three ways in, one vocabulary:
 *   demo      a shipped team on the stub runtime: no API key, no model calls
 *   new       the default team on the Claude runtime, in a folder the person picks
 *   existing  a folder that already holds a mesh.yaml
 */
import type { View } from "./route";
import { usd } from "./projectsmodel";

export type Intent = "demo" | "new" | "existing";

/** Mirrors `TemplateOffer` in apps/mesh-server/src/new-project.ts. */
export interface TemplateOffer {
  id: string;
  kind: "default" | "example";
  title: string;
  goal: string | null;
  seats: number;
  runtime: string;
  needsApiKey: boolean;
  rolePrompts: number;
  missionTokens: number | null;
  projectId: string | null;
  suggestedRoot: string;
}

export interface TemplatesAnswer {
  templates: TemplateOffer[];
  defaultParent: string;
  confined: boolean;
  modelAccess: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * `GET /api/templates` as the page uses it. An entry that is not complete is dropped rather than half-shown, and an answer
 * with nothing usable is null, which the page treats as "this host cannot make projects from the dashboard".
 */
export function parseTemplates(json: unknown): TemplatesAnswer | null {
  if (!isObject(json) || !Array.isArray(json.templates)) return null;
  const templates: TemplateOffer[] = [];
  for (const t of json.templates) {
    if (!isObject(t)) continue;
    const id = str(t.id);
    const suggestedRoot = str(t.suggestedRoot);
    if (!id || !suggestedRoot || (t.kind !== "default" && t.kind !== "example")) continue;
    templates.push({
      id, kind: t.kind, suggestedRoot,
      title: str(t.title) ?? id,
      goal: str(t.goal),
      seats: num(t.seats) ?? 0,
      runtime: str(t.runtime) ?? "claude",
      needsApiKey: t.needsApiKey !== false,
      rolePrompts: num(t.rolePrompts) ?? 0,
      missionTokens: num(t.missionTokens),
      projectId: str(t.projectId),
    });
  }
  if (templates.length === 0) return null;
  return {
    templates,
    defaultParent: str(json.defaultParent) ?? "",
    confined: json.confined === true,
    modelAccess: Array.isArray(json.modelAccess) ? json.modelAccess.filter((x): x is string => typeof x === "string") : [],
  };
}

/** The demo is the shipped team that needs no model: found by that property, not by a name that could drift. */
export const pickDemo = (a: TemplatesAnswer): TemplateOffer | null => a.templates.find((t) => t.kind === "example" && !t.needsApiKey) ?? null;
export const pickDefault = (a: TemplatesAnswer): TemplateOffer | null => a.templates.find((t) => t.kind === "default") ?? null;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What a starting point is, in a sentence, from the facts the host read out of its files. */
export function whatItIs(o: TemplateOffer): string {
  if (o.kind === "default") return "The default team: one architect seat and a goal for you to write. You add the rest of the team in the Designer.";
  const team = `A scripted team of ${plural(o.seats, "seat")}`;
  return o.goal ? `${team} works on this goal: ${o.goal}` : `${team}.`;
}

/** What it writes, so the line above the button can say what and where: the files, then the folder beside it. */
export function writesWhat(o: TemplateOffer): string {
  return o.rolePrompts > 0 ? `mesh.yaml and ${plural(o.rolePrompts, "role prompt")}` : "mesh.yaml";
}

/**
 * How long a run takes, said only where it is known: a scripted team on the stub runtime makes no model calls and finishes in
 * seconds (measured: about 4 s from Start). A team on a real model takes as long as the work does, and no figure is offered.
 */
export function whatItTakes(o: TemplateOffer): string | null {
  return o.runtime === "stub" ? "A few seconds after you press Start." : null;
}

/** What it needs from this host. Says what the host has, by the names of the settings. */
export function whatItNeeds(o: TemplateOffer, modelAccess: readonly string[]): { text: string; tone: "ok" | "warn" } {
  if (!o.needsApiKey) return { text: `Nothing. It runs on the ${o.runtime} runtime, so it makes no model calls.`, tone: "ok" };
  if (modelAccess.length > 0) return { text: `Model access, which this host has (${modelAccess.join(", ")}).`, tone: "ok" };
  return {
    text: "Model access, which this host lacks. Set ANTHROPIC_API_KEY, or the settings for Bedrock, Vertex AI or Foundry, in its environment.",
    tone: "warn",
  };
}

/** What it costs. A team that needs no key costs nothing; one that does spends tokens on the person's own account. */
export function whatItCosts(o: TemplateOffer, ceilingUsd: number | null): string {
  // The console shows token counts for the demo too: they are the script's own, and said to be.
  if (!o.needsApiKey) return "Nothing, and there is no bill. The token counts it shows are the script's own.";
  const cap = o.missionTokens ? ` The mission is capped at ${o.missionTokens.toLocaleString("en-US")} tokens.` : "";
  const ceiling = ceilingUsd !== null && ceilingUsd > 0 ? ` The host parks every open project once their estimated spend reaches ${usd(ceilingUsd)}.` : "";
  return `Spends tokens on your own provider account.${cap}${ceiling}`;
}

/** Where each way of starting lands the person: the demo to be run, a new mesh to be written, an existing one to be looked at. */
export function landingView(intent: Intent): View {
  return intent === "new" ? "designer" : "overview";
}

/** The line under each button: where the console goes next. Said from `landingView`, so the sentence and the move cannot part. */
export function whatHappensNext(intent: Intent): string {
  const page = landingView(intent) === "designer" ? "the Designer" : "the Overview";
  return intent === "demo" ? `Then opens ${page}, where you press Start.` : `Then opens ${page}.`;
}

/** What `GET /api/browse` said about the folder a person typed. */
export type FolderFacts =
  | { kind: "folder"; hasMesh: boolean }
  | { kind: "missing" }
  | { kind: "file" }
  | { kind: "denied" }
  | { kind: "unreadable"; detail: string }
  | { kind: "outside"; reason: string };

/** `status` and `json` are the browse call's own. Null when the call did not get an answer at all. */
export function readBrowse(status: number, json: unknown): FolderFacts | null {
  if (!isObject(json)) return null;
  if (status === 403 && json.code === "outside_projects_root") {
    return { kind: "outside", reason: str(json.reason) ?? str(json.error) ?? "That folder is outside the projects directory this host is confined to." };
  }
  if (status < 200 || status >= 300) return null;
  const error = str(json.error);
  if (error) {
    if (/ENOENT/.test(error)) return { kind: "missing" };
    if (/ENOTDIR/.test(error)) return { kind: "file" };
    if (/EACCES|EPERM/.test(error)) return { kind: "denied" };
    return { kind: "unreadable", detail: error.slice(0, 160) };
  }
  return { kind: "folder", hasMesh: json.hasMesh === true };
}

export interface FolderVerdict {
  tone: "ok" | "warn" | "bad" | "neutral";
  message: string;
  /** The button may be pressed. When the host could not say, it may: the host decides, and says why if it refuses. */
  canProceed: boolean;
  /** For "existing": the folder has no mesh.yaml, and making one there is a separate, explicit choice. */
  offerCreate: boolean;
}

/**
 * Whether a typed path names a full location: `/x`, `~`, `~/x`, `C:\x` or `\\server\share`. The host refuses anything
 * else (a relative path would mean "relative to wherever the host was started"), so the field says so before asking.
 */
export const looksAbsolute = (path: string): boolean => /^(\/|~(\/|\\|$)|\\\\|[A-Za-z]:[\\/])/.test(path.trim());

/**
 * Whether the folder in the field suits what this card does. `create` writes a mesh.yaml (and so needs none to be there);
 * `add` registers one (and so needs one). Null facts mean the host has not been asked yet, or did not answer. An empty
 * field and a relative path are answered here, without asking.
 */
export function folderVerdict(intent: "create" | "add", path: string, facts: FolderFacts | null): FolderVerdict {
  const go = (tone: FolderVerdict["tone"], message: string, offerCreate = false): FolderVerdict => ({ tone, message, canProceed: true, offerCreate });
  const stop = (message: string, offerCreate = false): FolderVerdict => ({ tone: "bad", message, canProceed: false, offerCreate });
  if (path.trim() === "") return { tone: "neutral", message: "Type the folder's full path, or choose one with Browse.", canProceed: false, offerCreate: false };
  if (!looksAbsolute(path)) return stop("Give the folder's full path, starting with / or ~/.");
  if (facts === null) return { tone: "neutral", message: "", canProceed: true, offerCreate: false };
  switch (facts.kind) {
    case "outside":
      return stop(facts.reason);
    case "file":
      return stop("That path is a file, not a folder.");
    case "missing":
      return intent === "create" ? go("neutral", "This folder does not exist yet. It will be created.") : stop("That folder does not exist.");
    case "denied":
      return go("warn", "This host is not allowed to read that folder, so it cannot check it. The host will say if it cannot write there.");
    case "unreadable":
      return go("warn", `This host could not check that folder (${facts.detail}).`);
    case "folder":
      if (intent === "create") {
        return facts.hasMesh
          ? stop('This folder already holds a mesh.yaml. Use "Add an existing folder" to register it; nothing here is replaced.')
          : go("neutral", "This folder exists. Its other files stay as they are.");
      }
      return facts.hasMesh ? go("ok", "mesh.yaml found.") : stop("There is no mesh.yaml in this folder.", true);
  }
}

/** One sentence for a failed create or add, from what the host answered: its `reason`, else its `error`, else the status. */
export function failureText(res: { status: number; reason?: string; error?: string } | null): string {
  if (res === null || res.status === 0) return "The host did not answer. Check that it is still running, then try again.";
  const said = res.reason?.trim() || res.error?.trim();
  if (said) return /[.!?]$/.test(said) ? said : `${said}.`;
  return `The host answered ${res.status}. Try again.`;
}
