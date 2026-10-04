/**
 * Which meshes are the shipped scripted demo.
 *
 * `examples/demo-stub` carries the mesh id `demo-stub` and runs on the stub runtime, and for exactly that the
 * product wipes its state at every start and attaches a scripted team (`attachDemoTeam`), so a first-time user
 * sees the whole flow with no model and no key. Both are destructive and both are wrong for anything else. A
 * team that kept the example's name and moved to a real runtime is a real project, and its log is not to be
 * wiped on a restart: the id alone is not enough, every seat must be on the stub.
 */
import * as fs from "fs";
import * as path from "path";
import type { ResolvedMeshConfig } from "../../../packages/config/src/index";
import { acquireStateLock, STATE_LOCK_FILENAME } from "../../../packages/persistence/src/index";

export const SCRIPTED_DEMO_MESH_ID = "demo-stub";

export function isScriptedDemo(config: Pick<ResolvedMeshConfig, "meshId" | "agentOrder" | "agents">): boolean {
  return config.meshId === SCRIPTED_DEMO_MESH_ID && config.agentOrder.length > 0 && config.agentOrder.every((id) => config.agents[id]?.runtime === "stub");
}

/**
 * Clear the state of a mesh that is the shipped demo, and say whether it was. The demo's team is re-attached at
 * every start, so it begins from nothing; any other mesh is returned untouched and the answer is `false`.
 *
 * The state lock is taken first. This ran before the server took it, so a second process starting the demo over
 * a folder a first was running on deleted that mesh's state, its lock file included, from under it, and the two
 * then shared one log: the case the lock exists to refuse. A mesh that is running holds the lock, so this throws
 * the same `StateLockError` the server would have, and touches nothing. The lock is held only for the wipe; the
 * server takes it again as it starts.
 */
export function startCleanIfScriptedDemo(config: Pick<ResolvedMeshConfig, "meshId" | "agentOrder" | "agents" | "stateDir">): boolean {
  if (!isScriptedDemo(config)) return false;
  const lock = acquireStateLock(config.stateDir, { projectId: config.meshId });
  try {
    for (const entry of fs.readdirSync(config.stateDir)) {
      if (entry !== STATE_LOCK_FILENAME) fs.rmSync(path.join(config.stateDir, entry), { recursive: true, force: true });
    }
  } finally {
    lock.release();
  }
  try {
    // Begins from nothing, as under `curule run`: the empty directory goes too (it fails, harmlessly, if anyone has
    // already put something in it).
    fs.rmdirSync(config.stateDir);
  } catch {
    /* not empty, or already gone */
  }
  return true;
}
