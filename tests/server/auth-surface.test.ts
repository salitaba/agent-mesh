/**
 * The child mesh server's authorization surface, route by route.
 *
 * `MESH_API_TOKEN` is the operator's credential, and `MESH_STRICT_AUTH=1` is
 * how a multi-project child says "nothing here is public". The promise both
 * make is that a local process which does not hold the token cannot drive the
 * mission. These tests hold the server to that promise on the routes where it
 * is easiest to break:
 *
 * - `/internal/mcp/:agent` answers BEFORE `requireAuth` runs, on the theory
 *   that each caller carries a per-agent token the toolset verifies itself.
 *   The `human` seat's "token" used to be the constant `human-local` (or
 *   anything starting `human:`) — a second, unauthenticated operator door —
 *   and seat tokens were a hash of public ids. Both are now secrets.
 * - `POST /config/save` used to write wherever `b.path` pointed.
 * - `POST /workspace/run` spawns `npm run <script>` in the product checkout —
 *   a package.json the agents write — and used to pass the server's whole
 *   environment, operator token included.
 *
 * Each of those was once a `todo: "BUG: ..."` and is now a regression guard;
 * the controls keep them honest (a seat token still works, the operator's own
 * save still lands).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { shortHash } from "../../packages/protocol/src/index";
import { mintSeatToken, verifySeatToken } from "../../packages/core/src/seat-token";
import { makeMesh } from "../helpers";

const OPERATOR = "operator-secret-7f3a";

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/**
 * Serve a parked mesh with an active goal, with the operator token (and
 * optionally strict mode) set for the duration. `requireAuth` reads the env
 * per request, so setting it around the server's lifetime is enough.
 */
async function withServer(
  fn: (ctx: { base: string; m: Mesh }) => Promise<void>,
  opts: { strict?: boolean } = {},
): Promise<void> {
  const prevToken = process.env.MESH_API_TOKEN;
  const prevStrict = process.env.MESH_STRICT_AUTH;
  process.env.MESH_API_TOKEN = OPERATOR;
  if (opts.strict) process.env.MESH_STRICT_AUTH = "1";
  else delete process.env.MESH_STRICT_AUTH;
  const m = await makeMesh({
    agents: [
      { id: "a", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "b", role: "reviewer", interests: [] },
    ],
    mayContact: { a: ["b"], b: ["a"] },
    // Parked: nothing here is about turns, and a scheduler running under the
    // assertions would only add events the "nothing changed" checks must skip.
    mode: "parked",
  });
  // A goal, so a seat token has something to be minted against.
  await m.supervisor.createGoal({ description: "probe the auth surface" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ base, m });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    if (prevToken === undefined) delete process.env.MESH_API_TOKEN;
    else process.env.MESH_API_TOKEN = prevToken;
    if (prevStrict === undefined) delete process.env.MESH_STRICT_AUTH;
    else process.env.MESH_STRICT_AUTH = prevStrict;
  }
}

interface RpcReply {
  status: number;
  json: { result?: { tools?: { name: string }[]; isError?: boolean; content?: { text?: string }[] }; error?: { message?: string } };
}

async function rpc(base: string, route: string, token: string, method: string, params?: unknown): Promise<RpcReply> {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-mesh-token": token },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, json: (await res.json()) as RpcReply["json"] };
}

/** Refused = an HTTP 401/403, or a JSON-RPC error. A tool-level isError is NOT a refusal: the call ran. */
function refused(r: RpcReply): boolean {
  return r.status === 401 || r.status === 403 || r.json.error !== undefined;
}

/**
 * The seat token exactly as the supervisor mints it for a turn (supervisor.ts
 * buildRuntimeContext). It is an HMAC under a per-process secret now, so the
 * only way to get one is the minting function itself — which is the point.
 */
function seatToken(m: Mesh, agentId: string): string {
  return mintSeatToken(m.config.meshId, agentId, m.kernel.state.activeGoalId);
}

// ------------------------------------------------------------------ 8.1 MCP

// The guessable human credentials. `human:` is a prefix check, so any suffix
// passes; `human-local` is the literal the designer bus hands its own runtime.
const HUMAN_GUESSES = ["human-local", "human:anything"];
// Every toolset the bridge route can select for the human seat.
const BRIDGE_VARIANTS = ["", "?readOnly=1", "?staging=1"];

for (const strict of [false, true]) {
  const label = strict ? "MESH_STRICT_AUTH=1" : "MESH_API_TOKEN";
  test(
    `8.1 [${label}] /internal/mcp/human refuses tools/list for a guessable human token, on every toolset`,
    async () => {
      await withServer(async ({ base }) => {
        // Collected rather than asserted one by one, so a failure names every
        // open door and not just the first.
        const leaks: string[] = [];
        for (const variant of BRIDGE_VARIANTS) {
          for (const guess of HUMAN_GUESSES) {
            const r = await rpc(base, `/internal/mcp/human${variant}`, guess, "tools/list");
            if (!refused(r)) leaks.push(`/internal/mcp/human${variant} '${guess}' -> ${r.json.result?.tools?.length ?? 0} tools`);
          }
        }
        assert.deepEqual(leaks, [], "tools handed out without the operator token");
      }, { strict });
    },
  );
}

test(
  "8.1 a guessable human token cannot mutate the mission through the bridge",
  async () => {
    await withServer(async ({ base, m }) => {
      const leaks: string[] = [];
      for (const guess of HUMAN_GUESSES) {
        const before = m.kernel.state.eventCount;
        const r = await rpc(base, "/internal/mcp/human", guess, "tools/call", {
          name: "mesh_broadcast",
          arguments: { type: "INFORM", payload: { text: "written by whoever could reach loopback" } },
        });
        const appended = m.kernel.state.eventCount - before;
        if (!refused(r) || appended > 0) leaks.push(`'${guess}': ran (isError=${r.json.result?.isError}), +${appended} events: ${r.json.result?.content?.[0]?.text ?? ""}`);
      }
      assert.deepEqual(leaks, [], "a guessable human token drove the mission");
    });
  },
);

test(
  "8.1 a guessable human token cannot read the mission through the read-only or staging bridge",
  async () => {
    await withServer(async ({ base }) => {
      const leaks: string[] = [];
      for (const variant of ["?readOnly=1", "?staging=1"]) {
        for (const guess of HUMAN_GUESSES) {
          const r = await rpc(base, `/internal/mcp/human${variant}`, guess, "tools/call", { name: "mesh_run_status", arguments: {} });
          if (!refused(r)) leaks.push(`${variant} '${guess}': ${(r.json.result?.content?.[0]?.text ?? "").slice(0, 60)}`);
        }
      }
      assert.deepEqual(leaks, [], "mission state read without the operator token");
    });
  },
);

test("8.1 control: a seat's minted token still reaches the bridge with MESH_API_TOKEN set, and a forged one does not", async () => {
  await withServer(async ({ base, m }) => {
    // Positive control. Whatever closes the human door must not close this
    // one: seats reach the bridge with their own token and no Bearer at all.
    const ok = await rpc(base, "/internal/mcp/a", seatToken(m, "a"), "tools/list");
    assert.equal(ok.status, 200);
    assert.equal(ok.json.error, undefined, JSON.stringify(ok.json.error));
    assert.ok((ok.json.result?.tools?.length ?? 0) > 0, "the seat is offered its tools");
    // Seat a's token is not seat b's, and a wrong goal hash is not a's.
    assert.ok(refused(await rpc(base, "/internal/mcp/b", seatToken(m, "a"), "tools/list")), "a's token opens b's bridge");
    const forged = `${m.config.meshId}:a:${shortHash("not-the-goal")}`;
    assert.ok(refused(await rpc(base, "/internal/mcp/a", forged, "tools/list")), "a token for another goal is accepted");
    // The pre-HMAC shape was computable from public ids alone; it must not
    // open the seat it names.
    const derivable = `${m.config.meshId}:a:${shortHash(m.kernel.state.activeGoalId ?? "")}`;
    assert.ok(refused(await rpc(base, "/internal/mcp/a", derivable, "tools/list")), "a token derived from public ids is accepted");
    assert.ok(refused(await rpc(base, "/internal/mcp/a", mintSeatToken(m.config.meshId, "a", "another-goal"), "tools/list")), "a minted token for another goal is accepted");
  });
});

test("8.1 a seat minted with no active goal verifies with no active goal (mint and verify normalise the goal alike)", () => {
  // The supervisor mints with `activeGoalId` (undefined when goalless) and the
  // bridge verifies with the same field; the old pair hashed "x" on one side
  // and "" on the other, so a goalless seat's own token was refused.
  for (const absent of [undefined, null, ""]) {
    assert.ok(verifySeatToken("mesh", "a", undefined, mintSeatToken("mesh", "a", absent)), `mint(${String(absent)}) vs verify(undefined)`);
  }
  assert.equal(verifySeatToken("mesh", "a", undefined, mintSeatToken("mesh", "a", "g1")), false, "a goal token is not a goalless one");
});

test("8.1 control: the server's own designer bridge secret opens the human seat", async () => {
  await withServer(async ({ base, m }) => {
    let observe: (() => { busUrl: string; token: string } | undefined) | undefined;
    // Re-bind to capture the locator: createHttpServer already handed it to the
    // runtime, so read it back from a second server over the same mesh.
    m.designerRuntime.setDesignerObserve = (p) => {
      observe = p;
    };
    const second = createHttpServer(m, { dashboardDir: undefined });
    await new Promise<void>((r) => second.listen(0, "127.0.0.1", r));
    try {
      const token = observe?.()?.token ?? "";
      assert.ok(token.length >= 32, "the bridge secret is minted");
      const secondBase = `http://127.0.0.1:${(second.address() as { port: number }).port}`;
      const r = await rpc(secondBase, "/internal/mcp/human?readOnly=1", token, "tools/list");
      assert.equal(r.json.error, undefined, JSON.stringify(r.json.error));
      // Each server mints its own: the second server's secret is not the first's.
      assert.ok(refused(await rpc(base, "/internal/mcp/human?readOnly=1", token, "tools/list")), "one server's bridge secret opens another");
    } finally {
      await closeHttpServer(second);
    }
  });
});

// ----------------------------------------------------------- 8.2 config save

/** The running mesh's own config, which is a schema-valid body for /config/save. */
function ownYaml(m: Mesh): string {
  return fs.readFileSync(m.config.filePath, "utf8");
}

async function save(base: string, body: unknown, bearer?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/config/save`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

test("8.2 /config/save sits behind operator auth when MESH_API_TOKEN is set", async () => {
  await withServer(async ({ base, m }) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-auth-save-"));
    const target = path.join(outside, "noauth", "mesh.yaml");
    try {
      const r = await save(base, { yaml: ownYaml(m), path: target });
      assert.equal(r.status, 401, JSON.stringify(r.json));
      assert.equal(fs.existsSync(target), false, "an unauthenticated save wrote the file");
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("8.2 control: the operator can still save over the running config", async () => {
  await withServer(async ({ base, m }) => {
    const r = await save(base, { yaml: ownYaml(m), path: m.config.filePath }, OPERATOR);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.savedTo, path.resolve(m.config.filePath));
  });
});

test(
  "8.2 /config/save refuses a path outside the project root, and writes nothing there",
  async () => {
    await withServer(async ({ base, m }) => {
      // A sibling tmp dir: not under the mesh's config dir, state dir or product.
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-auth-escape-"));
      const target = path.join(outside, "deep", "mesh.yaml");
      const traversal = `${path.dirname(m.config.filePath)}/../${path.basename(outside)}/via-dotdot.yaml`;
      try {
        for (const p of [target, traversal]) {
          const r = await save(base, { yaml: ownYaml(m), path: p }, OPERATOR);
          assert.ok(r.status >= 400 && r.status < 500, `save to ${p} answered ${r.status}: savedTo=${String(r.json.savedTo)}`);
          assert.equal(fs.existsSync(path.resolve(p)), false, `save to ${p} left a file behind`);
        }
        assert.equal(fs.existsSync(path.join(outside, "deep")), false, "the refused save still created directories");
      } finally {
        fs.rmSync(outside, { recursive: true, force: true });
      }
    });
  },
);

// ------------------------------------------------------------ 8.3 workspace run

/**
 * Point the mesh's product checkout at a scratch dir whose package.json has a
 * whitelisted `build` script that reports whether it can see the operator
 * token. That package.json is exactly the file a seat writes in a real run.
 */
function productWithProbe(m: Mesh): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-auth-product-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "probe",
      scripts: { build: `node -e "console.log('PROBE_TOKEN=' + (process.env.MESH_API_TOKEN || 'absent'))"` },
    }),
    "utf8",
  );
  (m as unknown as { productPath: string }).productPath = dir;
  return dir;
}

test("8.3 /workspace/run sits behind operator auth when MESH_API_TOKEN is set", async () => {
  await withServer(async ({ base, m }) => {
    const dir = productWithProbe(m);
    try {
      const r = await fetch(`${base}/workspace/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script: "build" }),
      });
      assert.equal(r.status, 401, await r.text());
      // And the same for a guessable agent-ish token in the MCP header slot:
      // requireAuth accepts x-mesh-token, so it must not accept the human literal.
      const h = await fetch(`${base}/workspace/run`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-token": "human-local" },
        body: JSON.stringify({ script: "build" }),
      });
      assert.equal(h.status, 401, await h.text());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

test(
  "8.3 a workspace run does not hand the operator token to agent-authored scripts",
  async () => {
    await withServer(async ({ base, m }) => {
      const dir = productWithProbe(m);
      try {
        const started = await fetch(`${base}/workspace/run`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${OPERATOR}` },
          body: JSON.stringify({ script: "build" }),
        });
        assert.equal(started.status, 201, await started.clone().text());
        const { runId } = (await started.json()) as { runId: string };
        let status: { done?: boolean; log?: string; exitCode?: number | null } = {};
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const s = await fetch(`${base}/workspace/run/${runId}`, { headers: { authorization: `Bearer ${OPERATOR}` } });
          status = (await s.json()) as typeof status;
          if (status.done) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(status.done, `the probe run never finished: ${status.log ?? ""}`);
        // The probe ran, so the absence below is a measurement, not a silence.
        assert.match(status.log ?? "", /PROBE_TOKEN=/, `the probe script did not run: ${status.log ?? ""}`);
        assert.doesNotMatch(status.log ?? "", new RegExp(OPERATOR), "the agent-authored script could read MESH_API_TOKEN");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
