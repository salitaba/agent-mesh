/**
 * Making a project from a starting point.
 *
 * `POST /api/projects` has always registered a folder, and with `init: true` scaffolded the default team into one that held
 * no mesh.yaml. A first visit to the dashboard needs more than that: the shipped demo, and the default team in a folder the
 * person chose, each saying beforehand where it writes. That is `template` on the same route, and `GET /api/templates` for
 * what the dashboard may offer.
 *
 * The rules are the existing add's, held to the letter:
 *
 *   - the folder is resolved and judged by where it REALLY is (`MESH_PROJECTS_ROOT` confines a server);
 *   - a mesh.yaml that is already there is never overwritten, and is not quietly registered either: that is a different
 *     request ("add an existing folder"), so it is refused with a reason that says so;
 *   - a template is looked up in the closed set `describeTemplates` returns (the default team, and the folders that exist
 *     under the install's `examples/`). The request's text is compared against that list and never joined onto a path;
 *   - every refusal carries a `reason`: one sentence the dashboard shows as it is.
 *
 * Nothing here knows about HTTP. host.ts maps a refusal to a status and a body, and a success to a project summary.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ConfigError,
  describeTemplates,
  scaffoldExample,
  writeDefaultMeshYaml,
  type TemplateInfo,
} from "../../../packages/config/src/index";
import { toProjectId } from "../../../packages/protocol/src/index";
import { MESH_CONFIG_FILENAME, type ProjectRef } from "../../../packages/projects/src/index";
import { insideRoots, projectRoots, realLocation } from "./confine";
import { managedModels, rewriteForManagedModels, type ManagedModels } from "./managed";

/** The slice of the registry this needs. The real one satisfies it; a test can hand over two functions. */
export interface TemplateRegistry {
  list(): ProjectRef[];
  add(root: string): Promise<ProjectRef>;
}

export interface NewProjectDeps {
  registry: TemplateRegistry;
  /** The directory holding `examples/` and `roles/`, or undefined when this install ships neither. */
  shippedRoot: string | undefined;
  env?: NodeJS.ProcessEnv;
}

/** A starting point, and the folder the dashboard would write it to if the person does not choose another. */
export interface TemplateOffer extends TemplateInfo {
  suggestedRoot: string;
}

export interface TemplatesView {
  templates: TemplateOffer[];
  /** The folder new projects are suggested under: the projects directory when the server is confined to one. */
  defaultParent: string;
  /** `MESH_PROJECTS_ROOT` is set: folders outside it are refused. */
  confined: boolean;
  /**
   * Names of the settings, in this host's own environment, through which a seat on the Claude runtime would reach a model.
   * Names only, never values. Empty means a team on that runtime could not start a turn yet.
   */
  modelAccess: string[];
  /**
   * This host was given the address and the key of a model gateway (the hosted service does this for every workspace). A team
   * made here runs on those models, the person brings no key, and what it uses is charged to their balance.
   */
  managed: boolean;
  /** When {@link managed}: whether the models are the service's gateway, or the owner's own key at their own provider (a hosting-only plan). */
  modelSource?: "gateway" | "own";
  /**
   * This host is a Curule Cloud workspace: the service that made it said where the account page is. Absent on any other host. A
   * customer has no folders, host or environment to set, so the console welcomes them differently, and where a model key is missing
   * it sends them to this address, because the key is added there and nowhere else.
   */
  hosted?: { accountUrl: string };
}

export type NewProjectResult =
  | { ok: true; ref: ProjectRef; template: string }
  | { ok: false; status: number; code: string; reason: string };

const refuse = (status: number, code: string, reason: string): NewProjectResult => ({ ok: false, status, code, reason });

/** Where a person's own folders are on this machine; the same answer the folder picker starts from. */
const homeDir = (env: NodeJS.ProcessEnv): string => env.HOME || env.USERPROFILE || os.homedir() || "/";

/** The folder new projects are suggested under: the first projects directory when confined, else `~/curule-projects`. */
export function defaultParent(env: NodeJS.ProcessEnv = process.env): string {
  return projectRoots(env)[0] ?? path.join(homeDir(env), "curule-projects");
}

/** `~` and `~/x` mean the home directory of whoever runs the host, which is what a person typing a path means by them. */
export function expandHome(input: string, env: NodeJS.ProcessEnv = process.env): string {
  if (input === "~") return homeDir(env);
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homeDir(env), input.slice(2));
  return input;
}

/**
 * The first folder under `defaultParent` that does not exist yet and would not collide with a registered project, named
 * after the template. A second demo is `demo-stub-2`: two folders with one name are two projects with one id, which the
 * registry refuses.
 */
export function suggestRoot(template: TemplateInfo, taken: ReadonlySet<string>, env: NodeJS.ProcessEnv = process.env): string {
  const parent = defaultParent(env);
  const base = template.kind === "default" ? "my-mesh" : template.id;
  // A template that pins its project id has one name to offer: the request will say it is taken.
  if (template.projectId && taken.has(template.projectId)) return path.join(parent, base);
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    const dir = path.join(parent, name);
    if (!fs.existsSync(dir) && !taken.has(template.projectId ?? toProjectId(name))) return dir;
  }
  return path.join(parent, `${base}-${Date.now().toString(36)}`);
}

/**
 * Whether the host's environment holds a way for a Claude-runtime seat to reach a model: the same variables `curule doctor`
 * looks for, by name. `ANTHROPIC_BASE_URL` alone is not one (it says where to send a key, not which key).
 */
const MODEL_ACCESS: ReadonlyArray<{ name: string; truthy?: boolean }> = [
  { name: "ANTHROPIC_API_KEY" },
  { name: "ANTHROPIC_AUTH_TOKEN" },
  { name: "CLAUDE_CODE_USE_BEDROCK", truthy: true },
  { name: "CLAUDE_CODE_USE_VERTEX", truthy: true },
  { name: "CLAUDE_CODE_USE_FOUNDRY", truthy: true },
  { name: "CLAUDE_CODE_OAUTH_TOKEN" },
];

export function modelAccessFound(env: NodeJS.ProcessEnv = process.env): string[] {
  return MODEL_ACCESS.filter((m) => {
    const v = (env[m.name] ?? "").trim();
    return m.truthy ? v === "1" || v.toLowerCase() === "true" : v !== "";
  }).map((m) => m.name);
}

/** The variable the hosted service gives a workspace's host: the address of the account page. */
export const ACCOUNT_URL_ENV = "CURULE_ACCOUNT_URL";

/**
 * The account page's address, when this host was made by the hosted service. Only an http or https address without credentials is
 * passed on: the console draws it as a link, so no other kind of address (`javascript:`, say) may reach a person's browser through it.
 */
export function accountUrlOf(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env[ACCOUNT_URL_ENV] ?? "").trim();
  if (raw === "") return undefined;
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** What `GET /api/templates` answers. */
export function templatesView(deps: NewProjectDeps): TemplatesView {
  const env = deps.env ?? process.env;
  const taken = new Set(deps.registry.list().map((r) => r.id));
  const models = managedModels(env);
  const managed = models !== undefined;
  const accountUrl = accountUrlOf(env);
  return {
    // On managed models a team that would have run on the Claude runtime runs on the native one, and says so.
    templates: describeTemplates(deps.shippedRoot).map((t) => ({ ...t, ...(managed && t.runtime === "claude" ? { runtime: "native" } : {}), suggestedRoot: suggestRoot(t, taken, env) })),
    defaultParent: defaultParent(env),
    confined: projectRoots(env).length > 0,
    modelAccess: modelAccessFound(env),
    managed,
    ...(models ? { modelSource: models.source } : {}),
    ...(accountUrl ? { hosted: { accountUrl } } : {}),
  };
}

/** The refusal for a folder outside `MESH_PROJECTS_ROOT`, as one sentence a person can act on. Said the same on every route that judges a folder. */
export const outsideRootsReason = (roots: readonly string[]): string =>
  `This host only works under ${roots.join(", ")}. Choose a folder there, or change MESH_PROJECTS_ROOT.`;

const sentence = (s: string): string => {
  const t = s.trim();
  return t ? `${t[0]!.toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : "";
};

/** A registry refusal as the sentences a person reads: what happened, then the registry's own advice when it gave any. */
export function projectErrorReason(message: string, detail?: string): string {
  return [message, detail].filter((s): s is string => typeof s === "string" && s.trim() !== "").map(sentence).join(" ");
}

/** What went wrong writing, in words a person can act on. */
function whyNotWritten(err: unknown, dir: string): string {
  if (err instanceof ConfigError) return err.errors.join("; ");
  const code = (err as NodeJS.ErrnoException)?.code;
  const why =
    code === "EACCES" || code === "EPERM" ? "this host has no permission to write there"
    : code === "ENOTDIR" || code === "EEXIST" ? "part of that path is a file, not a folder"
    : code === "ENOSPC" ? "the disk is full"
    : code === "EROFS" ? "that location is read-only"
    : (err as Error)?.message ?? "unknown error";
  return `Could not write to ${dir}: ${why}.`;
}

/** Rewrite what was just scaffolded to run on the host's managed models. A mesh that needs no models is left as it is. */
function rewriteForTheService(file: string, managed: ManagedModels): void {
  const rewritten = rewriteForManagedModels(fs.readFileSync(file, "utf8"), managed);
  if (rewritten.changed) fs.writeFileSync(file, rewritten.text, "utf8");
}

/** The default team in a folder: on the Claude runtime, or on the host's managed models when it was given some. */
export function writeDefaultTeam(dir: string, name: string, env: NodeJS.ProcessEnv = process.env): void {
  writeDefaultMeshYaml(dir, name, "claude");
  const managed = managedModels(env);
  if (managed) rewriteForTheService(path.join(dir, MESH_CONFIG_FILENAME), managed);
}

export async function createFromTemplate(input: { template: unknown; root: unknown }, deps: NewProjectDeps): Promise<NewProjectResult> {
  const env = deps.env ?? process.env;
  const templates = describeTemplates(deps.shippedRoot);
  // The closed set. The request's text is only ever compared with `id`s that came from the install, never used as a path.
  const template = typeof input.template === "string" ? templates.find((t) => t.id === input.template) : undefined;
  if (!template) {
    return refuse(400, "unknown_template", "This host does not offer that starting point. Choose one from the list, or add a folder that already holds a mesh.yaml.");
  }

  const registered = deps.registry.list();
  let target: string;
  if (input.root === undefined || input.root === null || input.root === "") {
    target = suggestRoot(template, new Set(registered.map((r) => r.id)), env);
  } else if (typeof input.root !== "string" || input.root.trim() === "") {
    return refuse(400, "bad_root", "Give the folder as text: its full path.");
  } else {
    const typed = expandHome(input.root.trim(), env);
    if (!path.isAbsolute(typed)) return refuse(400, "relative_path", "Give the folder's full path, starting with / or ~/.");
    target = path.resolve(typed);
  }

  const roots = projectRoots(env);
  if (roots.length > 0 && !insideRoots(realLocation(target), roots)) {
    return refuse(403, "outside_projects_root", outsideRootsReason(roots));
  }

  if (fs.existsSync(path.join(target, MESH_CONFIG_FILENAME))) {
    return refuse(409, "exists", `${target} already holds a mesh.yaml, so nothing was written. Use "Add an existing folder" to register it.`);
  }

  // The id the registry will know it by: pinned by the template, or derived from the folder's real name, exactly as the
  // config loader derives it. Checked now so a refusal leaves no files behind.
  const projectId = template.projectId ?? toProjectId(path.basename(realLocation(target)));
  const clash = registered.find((r) => r.id === projectId);
  if (clash) {
    return refuse(409, "duplicate_id", `A project named "${projectId}" is already on this host (${clash.root}). Choose a folder with a different name.`);
  }

  try {
    if (template.kind === "default") {
      writeDefaultTeam(target, path.basename(realLocation(target)), env);
    } else {
      // An example is only in `templates` when the install ships examples, so `shippedRoot` is set.
      scaffoldExample(deps.shippedRoot as string, template.id, target);
      const managed = managedModels(env);
      if (managed) rewriteForTheService(path.join(target, MESH_CONFIG_FILENAME), managed);
    }
  } catch (err) {
    // The file appeared between the check above and the write. The writers refuse to replace it; say so, as above.
    if (err instanceof ConfigError && err.errors.some((e) => /already exists/.test(e))) {
      return refuse(409, "exists", `${target} already holds a mesh.yaml, so nothing was written. Use "Add an existing folder" to register it.`);
    }
    return refuse(500, "cannot_write", whyNotWritten(err, target));
  }

  // If this throws, what was written stays: it is a valid mesh the person asked for, and deleting inside their folder
  // would be a second surprise. The host's error handler says why it was not registered.
  const ref = await deps.registry.add(target);
  return { ok: true, ref, template: template.id };
}
