/**
 * What an answer to `GET /config` means for the Designer. DOM-free, so the decision can be tested.
 *
 * The client resolves an HTTP answer with its status instead of throwing, and the Designer read every answer without a `raw` as
 * "there is no mesh.yaml". A project that is closed or still starting answers 409 and a server fault 500, so the Designer opened on
 * the Triad template, under "No mesh.yaml was found", for a project whose file was right there, and kept that draft when the
 * project came back: a save from there would have written a new file in place of the person's mesh. Only a 200 that carries no
 * file is "no file"; anything else is a load that failed, and says why.
 */

export type ConfigAnswer =
  /** The project's mesh.yaml, as the server read it. */
  | { kind: "file"; raw: Record<string, unknown>; filePath: string }
  /** The server answered and has no mesh.yaml: a new mesh, which starts from a template. */
  | { kind: "none" }
  /** Nothing is known about the file. `waiting`: the project's process is not running, so the same question can succeed later. */
  | { kind: "error"; text: string; waiting: boolean };

export function readConfigAnswer(a: { status: number; json: unknown; timeout?: boolean }): ConfigAnswer {
  if (a.timeout) return { kind: "error", text: "The server did not answer in time.", waiting: false };
  const json = a.json && typeof a.json === "object" ? (a.json as Record<string, unknown>) : null;
  // The host's answer for a project whose process is not running: closed, starting, crashed. Its file exists all the same.
  if (a.status === 409) return { kind: "error", text: "The project is not running, so its mesh.yaml cannot be read.", waiting: true };
  if (a.status !== 200) {
    const why = typeof json?.error === "string" ? json.error : typeof json?.reason === "string" ? json.reason : "";
    return { kind: "error", text: a.status ? `The server answered ${a.status}${why ? `: ${why}` : "."}` : "The server did not answer.", waiting: false };
  }
  if (!json) return { kind: "error", text: "The server's answer could not be read.", waiting: false };
  const raw = json.raw;
  if (raw && typeof raw === "object" && Object.keys(raw).length > 0) {
    return { kind: "file", raw: raw as Record<string, unknown>, filePath: typeof json.filePath === "string" ? json.filePath : "" };
  }
  return { kind: "none" };
}
