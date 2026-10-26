/**
 * Which pages a server has. DOM-free, so the rule can be tested.
 *
 * There are two kinds of server behind the same page. A host (`curule host`) holds a registry of projects and has pages of its own:
 * Projects, and the limits that apply to every project. A single-mesh server (`curule run`, `console`, `serve`, which is what the
 * README's quick start starts) runs one mesh, has no registry and answers none of the host's routes, so those pages would be a
 * sidebar entry that leads to a wall of errors.
 */

export type ServerKind =
  /** The registry has not answered yet, so which of the two this is is not known. */
  | "pending"
  /** One mesh, no registry. */
  | "single"
  /** A host with at least one project. */
  | "host"
  /** A host with none: first run, where only the host's pages can be shown. */
  | "empty-host";

export interface RegistryFacts {
  /** `null` until the first answer; `false` when the server has no registry route at all. */
  hasRegistry: boolean | null;
  loaded: boolean;
  projectCount: number;
}

/** `null` is no provider at all, which is a single mesh with nothing to ask. */
export function serverKind(facts: RegistryFacts | null): ServerKind {
  if (facts === null) return "single";
  if (facts.hasRegistry === null) return "pending";
  if (facts.hasRegistry === false) return "single";
  return facts.loaded && facts.projectCount === 0 ? "empty-host" : "host";
}

export type RegistryPhase =
  /** The first answer is still on its way. */
  | "waiting"
  /** The host was asked and did not answer, and nothing has ever said what it holds. */
  | "failed"
  /** The server has said which of the two kinds it is. */
  | "known";

/**
 * What the view area does while the registry has not answered. A host that answers 5xx is "down", and `projects.tsx` keeps
 * the last list it had; with no last list there is nothing to keep, and the console used to sit on the loading placeholder
 * for ever because `hasRegistry` stayed null and every view held. It is a failed first read, so it says so and offers a retry.
 */
export function registryPhase(facts: { hasRegistry: boolean | null; hostDown: boolean } | null): RegistryPhase {
  if (facts === null || facts.hasRegistry !== null) return "known";
  return facts.hostDown ? "failed" : "waiting";
}

/** The sidebar's group the host owns. */
export const HOST_SECTION = "Host";

/** Whether a sidebar group is shown. The host's group waits for the host to say it is one, rather than arriving and leaving. */
export function showsSection(kind: ServerKind, section: string): boolean {
  if (kind === "empty-host") return section === HOST_SECTION;
  if (kind === "host") return true;
  return section !== HOST_SECTION;
}

/** The two pages only a host has. A single-mesh server answers neither, so the address that names one gets an explanation. */
export const HOST_VIEWS: readonly string[] = ["projects", "hostsettings"];

export function isHostView(view: string): boolean {
  return HOST_VIEWS.includes(view);
}

/**
 * Whether the view area waits for a project instead of drawing a view. A host that has not chosen a project yet (a beat after the first
 * one is made), or whose project is still booting, has no mission to read, and every view that mounted would ask for one and be told
 * 409: a page of zeros under a console full of red. The host's own pages do not need a project and are never held.
 */
export function holdsForProject(kind: ServerKind, view: string, project: { chosen: boolean; status: string | null }): boolean {
  if (kind !== "host") return false;
  if (isHostView(view)) return false;
  return !project.chosen || project.status === "booting";
}
