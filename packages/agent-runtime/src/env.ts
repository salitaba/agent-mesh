/**
 * The environment a seat's shell starts with.
 *
 * A seat's shell inherits the environment of the process that runs it, and that process holds credentials no seat has a
 * use for: the mesh's own tokens, the licence, and (in a runtime that calls a model itself) the provider keys. A seat that
 * is steered by hostile text in a file or a web page, and that can read its own environment, can put them in a message.
 * Every runtime therefore starts a shell from {@link withoutMeshSecrets}, and the native runtime removes its provider keys
 * as well.
 */

/**
 * The mesh's own credentials, which no seat has a use for.
 *
 * `MESH_API_TOKEN` is the operator's token (or, under a host, this child's own): a seat that reads it can call the API as
 * the operator, which is `POST /approvals {by: "human"}`, `/mission/reset`, `/config/save`, past every gate the mesh
 * enforces on the seat. `MESH_LICENSE` is the vendor-signed entitlement: not a way into anything, but a seat that can read
 * it can send it anywhere, and a licence is meant to stay with the install it was issued to. A seat reaches the mesh
 * through its bus with a per-seat token handed to the runtime directly, so none of these is ever needed in the seat's own
 * environment.
 *
 * Anything named like a mesh token, secret or password goes: a credential added later is covered without anyone
 * remembering to list it. Provider credentials are not named here, because the Claude CLI needs its own to reach its
 * model: whether a seat's shell may see them is each runtime's decision, and the native runtime removes its own.
 */
export function isMeshSecret(name: string): boolean {
  return name === "MESH_API_TOKEN" || name === "MESH_LICENSE" || name === "MESH_LICENSE_KEY" || /^MESH_.*(TOKEN|SECRET|PASSWORD)$/.test(name);
}

/** `env` without the mesh's own credentials. */
export function withoutMeshSecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isMeshSecret(name)));
}
