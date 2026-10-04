/**
 * What a crashed view tells the person, and what a bug report about it carries. DOM-free, so the wording and the one
 * detection that changes the advice can be tested.
 */

export interface Thrown {
  name: string;
  message: string;
  stack: string;
}

/** Anything can be thrown: an Error, a string a library threw, a rejected value with a circular shape. None may make the report itself throw. */
export function describeThrown(thrown: unknown): Thrown {
  if (thrown instanceof Error) return { name: thrown.name || "Error", message: thrown.message, stack: thrown.stack ?? "" };
  if (typeof thrown === "string") return { name: "Error", message: thrown, stack: "" };
  try {
    return { name: "Error", message: JSON.stringify(thrown) ?? String(thrown), stack: "" };
  } catch {
    return { name: "Error", message: String(thrown), stack: "" };
  }
}

/**
 * A lazily loaded view whose file is gone from the server. The console's files are named by content, so after the host is
 * updated a tab that was open before the update asks for a file that no longer exists. That is not a fault in the view and
 * "try again" cannot fix it: the tab itself is old, and a reload is the whole remedy. Browsers word it three ways.
 */
export function isStaleBundle(thrown: unknown): boolean {
  const { name, message } = describeThrown(thrown);
  return name === "ChunkLoadError" || /dynamically imported module|Importing a module script failed|Loading (CSS )?chunk [\w-]+ failed/i.test(message);
}

const capLines = (text: string, max: number): string => {
  const lines = text.split("\n");
  return lines.length <= max ? text : `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines`;
};

export interface CrashFacts {
  view: string;
  /** `location.hash`: the view and the project, which is what it takes to open the same page again. */
  route: string;
  error: unknown;
  componentStack?: string | null;
  /** The console's own version, when the server reported one. */
  version?: string | null;
}

/** The text the "Copy error details" button puts on the clipboard: enough for someone else to find the failing component. */
export function crashReport(f: CrashFacts): string {
  const t = describeThrown(f.error);
  const lines = [
    `Curule console${f.version ? ` ${f.version}` : ""}, view: ${f.view || "unknown"}`,
    `Route: ${f.route || "(none)"}`,
    `${t.name}: ${t.message}`,
  ];
  if (t.stack) lines.push("", "Stack:", capLines(t.stack, 30));
  if (f.componentStack?.trim()) lines.push("", "Component stack:", capLines(f.componentStack.trim(), 20));
  return lines.join("\n");
}

/** One line of the message, cut for the screen. The full text is in the copied report. */
export function crashHeadline(thrown: unknown, max = 200): string {
  const first = describeThrown(thrown).message.split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}
