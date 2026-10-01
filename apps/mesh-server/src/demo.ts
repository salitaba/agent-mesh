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
import type { ResolvedMeshConfig } from "../../../packages/config/src/index";

export const SCRIPTED_DEMO_MESH_ID = "demo-stub";

export function isScriptedDemo(config: Pick<ResolvedMeshConfig, "meshId" | "agentOrder" | "agents">): boolean {
  return config.meshId === SCRIPTED_DEMO_MESH_ID && config.agentOrder.length > 0 && config.agentOrder.every((id) => config.agents[id]?.runtime === "stub");
}

/**
 * Clear the state of a mesh that is the shipped demo, and say whether it was. The demo's team is re-attached at
 * every start, so it begins from nothing; any other mesh is returned untouched and the answer is `false`.
 */
export function startCleanIfScriptedDemo(config: Pick<ResolvedMeshConfig, "meshId" | "agentOrder" | "agents" | "stateDir">): boolean {
  if (!isScriptedDemo(config)) return false;
  fs.rmSync(config.stateDir, { recursive: true, force: true });
  return true;
}
