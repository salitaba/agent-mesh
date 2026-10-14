import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh } from "../helpers";
import { TerminationManager } from "../../packages/core/src/termination";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The platform promises every delivered product a playground, and the promise is kept by the engine.
 *
 * The console frames `apps/playground/index.html` from the product's own tree — read-only, in a sandbox — so a product
 * without that page is delivered with something nobody can open. Nothing ever asked the seats for one: measured
 * 2026-10-14, a live mesh shipped a UI that only existed while its own command ran, and the console said "this checkout
 * has none" about a product that visibly had a UI. Its operator's words: "i want fix the agent mesh core system always
 * have playground".
 *
 * The check lives in the supervisor rather than in the termination verdict, and that is deliberate: the verdict is
 * evaluated from projections alone so a replay reaches the same answer, and a file on disk is not a projection. So the
 * verdict may say `complete` while the mission is held — which this spec asserts, because it is the design.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead", "qa"], qa: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "every patch is merged", mandatory: true }];

type MergeResult = Awaited<ReturnType<WorkspacePort["mergeWorktree"]>>;
type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));
const status = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;
const goalStatus = (m: Mesh) => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.status;
const verdict = (m: Mesh) => new TerminationManager().evaluate({ state: m.kernel.state, config: m.config, wallClockMs: 1000 });
const settle = (m: Mesh) => (m.supervisor as unknown as { watchdog(): Promise<void> }).watchdog();

/** A mesh whose seats could write a page, with a product checkout this spec owns. */
async function fixture(runtime = "claude"): Promise<{ m: Mesh; product: string }> {
  const product = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "playground-page-"));
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, runtime } as never);
  let n = 0;
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  const workspace: WorkspacePort = {
    mainPath: product,
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: unused("ensureWorktree"),
    commitWorktree: unused("commitWorktree"),
    mergeWorktree: async (): Promise<MergeResult> => ({ commit: `${(++n).toString(16).padStart(2, "0")}23456789abcdef0123456789abcdef01234567` }),
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = workspace;
  return { m, product };
}

/** The run the other gate asks for, verified: this spec is about the page. */
async function ranTheProduct(m: Mesh): Promise<void> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "product-run", type: "ExecutionRecord", content: "$ node bin/skillctl.js --help\nusage…\n" });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["qa"] });
  assert.equal((await op(m, "qa", { op: "approve", subject: "quality", artifactId: id })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("qa", id, { to: "FINAL" })).ok, true);
}

/** A patch that landed: MERGED is what evidences `implementation-merged` here. */
async function landed(m: Mesh, name: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: `the whole of ${name}, at length` });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
  assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" })).ok, true);
  const res = await op(m, "lead", { op: "merge", artifactId: id });
  assert.equal(res.ok, true, res.reason);
  assert.equal(status(m, id), "MERGED");
  return id;
}

test("a product delivered without the page the console opens is held, and writing it releases the mission", async () => {
  const { m, product } = await fixture();
  try {
    await landed(m, "library");
    await ranTheProduct(m);
    await settle(m);
    assert.equal(
      verdict(m).kind,
      "complete",
      "the verdict is about the projections, and nothing in them is unfinished — this hold is a fact about the checkout",
    );
    assert.equal(goalStatus(m), "ACTIVE", "the mission is held: the product has no playground for its owner to open");

    // The page a seat would write.
    fs.mkdirSync(path.join(product, "apps", "playground"), { recursive: true });
    fs.writeFileSync(path.join(product, "apps", "playground", "index.html"), "<!doctype html><title>the product</title>", "utf8");
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED", "with a page at that path the mission closes as it otherwise would");
  } finally {
    await m.cleanup();
    fs.rmSync(product, { recursive: true, force: true });
  }
});

test("control: a scripted mesh is not held, because its seats cannot write a page", async () => {
  const { m, product } = await fixture("stub");
  try {
    await landed(m, "library");
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED", "a stub runtime writes nothing: holding it on a file would be a deadlock");
  } finally {
    await m.cleanup();
    fs.rmSync(product, { recursive: true, force: true });
  }
});
