/**
 * Hash routing — deliberately DOM-free.
 *
 * Every function here takes the hash as a string and returns a string, so the
 * whole routing table is covered by `node:test` without a browser. The rest of
 * the dashboard is `.tsx` that the root tsconfig cannot compile, which is why
 * this file is pulled in through tsconfig `files` rather than `include`.
 */

export const VIEWS = ["overview", "steps", "agents", "graph", "events", "artifacts", "cost", "product", "escalations", "gates", "designer", "hostsettings", "projects"] as const;
export type View = (typeof VIEWS)[number];

export const DEFAULT_VIEW: View = "overview";

/**
 * Pages that belong to the host, not to a project: every project at once. Their address never names one
 * (`#/projects`), so a link to one is the same link whichever project happens to be in front, and it is not
 * a "legacy bare link" that has to be rewritten onto the active project.
 */
export const HOST_VIEWS: readonly View[] = ["projects"];
export const isHostView = (view: View): boolean => HOST_VIEWS.includes(view);

export interface RouteDetail {
  /**
   * `event` differs from the other two: it is not a drawer. The events console
   * renders the selected event in its own right-hand pane, so the shell must
   * leave it alone (see the detail switch in shell.tsx). It is in the URL for
   * the same reason the others are — a specific event is the thing an operator
   * wants to link someone to.
   */
  kind: "step" | "agent" | "event";
  id: string;
}

/**
 * The hash carries three independent things: which project is shown, which page
 * is shown, and which detail is open on top of it —
 * `#/p/acme/steps/step/turn-ab12`. Keeping project and detail in the URL is what
 * makes a step shareable and lets a reload land back on the same project; the
 * drawer stack alone lost both.
 */
export interface HashRoute {
  /** Null for a legacy `#/steps` link written before projects existed. */
  projectId: string | null;
  view: View;
  detail?: RouteDetail;
}

const isView = (v: string | undefined): v is View => !!v && (VIEWS as readonly string[]).includes(v);

function parseTail(segments: string[]): { view: View; detail?: RouteDetail } {
  const [v, kind, ...rest] = segments;
  const view = isView(v) ? v : DEFAULT_VIEW;
  // A host page has nothing to open on top of it.
  if (isHostView(view)) return { view };
  const id = rest.join("/");
  if ((kind === "step" || kind === "agent" || kind === "event") && id) {
    return { view, detail: { kind, id: safeDecode(id) } };
  }
  return { view };
}

/** A malformed `%` sequence must not throw and blank the whole app. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseHash(hash: string): HashRoute {
  const raw = hash.replace(/^#\/?/, "");
  const segments = raw.split("/");
  // `#/p/:projectId/...` — "p" is not a view name, so there is no ambiguity
  // between the project form and the legacy bare form.
  if (segments[0] === "p" && segments[1]) {
    return { projectId: safeDecode(segments[1]), ...parseTail(segments.slice(2)) };
  }
  return { projectId: null, ...parseTail(segments) };
}

export function hashFor(projectId: string | null | undefined, view: View, detail?: RouteDetail): string {
  // A host page has no project and no detail: asking for one with a project in hand still gives `#/projects`.
  if (isHostView(view)) return `#/${view}`;
  const tail = detail ? `${view}/${detail.kind}/${encodeURIComponent(detail.id)}` : view;
  return projectId ? `#/p/${encodeURIComponent(projectId)}/${tail}` : `#/${tail}`;
}

/**
 * True when the hash names no project and therefore has to be rewritten onto
 * the active one. Returning the already-parsed route keeps the caller from
 * parsing twice just to decide. A host page names none on purpose, so it is
 * left as it is.
 */
export function needsProjectRedirect(route: HashRoute): boolean {
  return route.projectId === null && !isHostView(route.view);
}

/**
 * Which project a freshly loaded window should show: the deep link wins, then
 * the last one the operator used, then the only open project, then whatever the
 * registry lists first. Returns null when the registry is empty — the caller
 * shows the "add a project" empty state rather than routing nowhere.
 */
export function pickActiveProject(input: {
  fromHash?: string | null;
  remembered?: string | null;
  open?: readonly string[];
  known: readonly string[];
}): string | null {
  const known = new Set(input.known);
  // A deep link into a project that is merely closed is still valid — it is
  // opened on arrival. Only an unknown id falls through.
  if (input.fromHash && known.has(input.fromHash)) return input.fromHash;
  if (input.remembered && known.has(input.remembered)) return input.remembered;
  const open = (input.open ?? []).filter((id) => known.has(id));
  if (open.length) return open[0];
  return input.known[0] ?? null;
}

/** `?since=` cursor list for the multiplexed stream: `a:120,b:44`. */
export function formatCursors(cursors: Iterable<[string, number]>): string {
  const parts: string[] = [];
  for (const [id, seq] of cursors) {
    if (!id || !Number.isFinite(seq) || seq <= 0) continue;
    parts.push(`${id}:${Math.floor(seq)}`);
  }
  return parts.join(",");
}

/**
 * The multiplexed stream URL. The full project set and every known cursor go on
 * every connect: that is what makes opening a project lossless instead of a
 * dropped-and-replayed connection.
 */
export function streamUrl(projects: readonly string[], cursors: Iterable<[string, number]>): string {
  const params: string[] = [];
  if (projects.length) params.push(`projects=${projects.map(encodeURIComponent).join(",")}`);
  const since = formatCursors(cursors);
  if (since) params.push(`since=${encodeURIComponent(since)}`);
  return params.length ? `/api/events/stream?${params.join("&")}` : "/api/events/stream";
}

/**
 * A single-mesh server (`curule console`, `run`, `serve`) has no registry and no project ids: it streams its one mesh itself, on
 * the unprefixed route, and resumes from `sinceSeq`. A host multiplexes (`streamUrl`); this is not that.
 */
export function singleStreamUrl(cursor: number): string {
  return cursor > 0 ? `/events/stream?sinceSeq=${Math.floor(cursor)}` : "/events/stream";
}

/** `/api/p/:id/<path>`; the bare path when no project is named (registry calls). */
export function projectPath(projectId: string | null | undefined, path: string): string {
  if (!projectId) return path;
  const rest = path.startsWith("/") ? path : `/${path}`;
  return `/api/p/${encodeURIComponent(projectId)}${rest}`;
}
