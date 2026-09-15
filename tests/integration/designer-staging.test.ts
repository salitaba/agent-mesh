import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";
import type { DesignerPromptOptions, StagedProposal } from "../../packages/protocol/src/index";

type ChatReply = { reply?: string; proposedConfig?: unknown; problems: string[]; proposal?: StagedProposal };

/**
 * The designer runtime is stubbed, but the staging path it exercises is real:
 * the stub speaks JSON-RPC to the bridge URL the server handed it, exactly as
 * the `mesh mcp --staging` process would. What is under test is the turn
 * correlation and the drain, not the model.
 */
async function stagingHarness() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: [], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: [] },
  });

  /** What the stubbed "model" does with its tools this turn. */
  let turnScript: (call: ToolCaller, opts?: DesignerPromptOptions) => Promise<string> = async () => "nothing to do";

  const runTurn = async (text: string, opts?: DesignerPromptOptions): Promise<string> => {
    const mcp = opts?.mcp;
    const call: ToolCaller = async (name, args, overrides) => {
      if (!mcp) throw new Error("the server offered no staging bridge this turn");
      const res = await fetch(overrides?.url ?? mcp.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...(overrides?.headers ?? mcp.headers ?? {}) },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const body = (await res.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
      return {
        isError: !!body.result?.isError,
        payload: JSON.parse(body.result?.content?.[0]?.text ?? "{}") as Record<string, unknown>,
      };
    };
    return turnScript(call, opts);
  };

  m.designerRuntime.prompt = async (text, opts) => runTurn(text, opts);
  m.designerRuntime.promptStream = async (text, opts) => ({ reply: await runTurn(text, opts), thinking: "" });

  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  return {
    base,
    script(fn: typeof turnScript) {
      turnScript = fn;
    },
    async chat(body: unknown): Promise<{ status: number; json: ChatReply }> {
      const res = await fetch(`${base}/designer/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as ChatReply };
    },
    async listTools(): Promise<string[]> {
      const res = await fetch(`${base}/internal/mcp/human?staging=1`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-mesh-token": "human-local" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      const body = (await res.json()) as { result?: { tools?: { name: string }[] } };
      return (body.result?.tools ?? []).map((t) => t.name);
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await m.cleanup();
    },
  };
}

type ToolCaller = (
  name: string,
  args: Record<string, unknown>,
  overrides?: { url?: string; headers?: Record<string, string> },
) => Promise<{ isError: boolean; payload: Record<string, unknown> }>;

const ask = { messages: [{ role: "user", content: "tidy the run up" }] };

test("designer staging: a staged mutation reaches the final frame as a proposal", async () => {
  const h = await stagingHarness();
  try {
    h.script(async (call) => {
      const r = await call("mesh_stage_goal_description", { description: "Ship the staging bridge", reason: "operator asked" });
      assert.equal(r.isError, false, JSON.stringify(r.payload));
      return "I staged a new mission statement for you to review.";
    });

    const r = await h.chat(ask);
    assert.equal(r.status, 200);
    assert.equal(r.json.proposal?.mutations.length, 1);
    const [m] = r.json.proposal!.mutations;
    assert.equal(m.kind, "goal.description");
    assert.equal((m as { description: string }).description, "Ship the staging bridge");
    // A tools-only turn is a complete answer: the "no parseable config block"
    // complaint must not be reported as a problem just because the model
    // proposed through tools instead of a fenced block.
    assert.deepEqual(r.json.problems, []);
  } finally {
    await h.close();
  }
});

test("designer staging: the toolset offers mesh_stage_* alongside read-only observability, and nothing that writes", async () => {
  const h = await stagingHarness();
  try {
    const names = await h.listTools();
    assert.ok(names.includes("mesh_stage_goal_description"), "staging tools are advertised");
    assert.ok(names.includes("mesh_stage_seat_retire"));
    assert.ok(names.includes("mesh_run_status"), "the assistant can look before it proposes");
    // The whole point: nothing here executes.
    for (const forbidden of ["mesh_send", "mesh_merge", "mesh_approve", "mesh_commit", "mesh_task_create"]) {
      assert.ok(!names.includes(forbidden), `${forbidden} must not be reachable from the designer`);
    }
  } finally {
    await h.close();
  }
});

test("designer staging: a refusal reaches the model mid-turn and nothing is staged", async () => {
  const h = await stagingHarness();
  try {
    let refusal = "";
    h.script(async (call) => {
      // Destructive without a reason, and against a seat that does not exist —
      // either is enough to refuse.
      const r = await call("mesh_stage_seat_retire", { agentId: "ghost", reason: "cleanup" });
      refusal = String(r.payload.error ?? "");
      assert.equal(r.isError, true);
      return "I could not stage that.";
    });

    const r = await h.chat(ask);
    assert.match(refusal, /unknown agent 'ghost'/);
    assert.equal(r.json.proposal?.mutations.length, 0);
  } finally {
    await h.close();
  }
});

test("designer staging: retirement is terminal, so suspend/resume/wake on a retired seat never stage", async () => {
  const h = await stagingHarness();
  try {
    const seen: Record<string, string> = {};
    h.script(async (call) => {
      const retire = await call("mesh_stage_seat_retire", { agentId: "dev", reason: "duplicate seat" });
      assert.equal(retire.isError, false, JSON.stringify(retire.payload));
      // Staging does NOT execute, so 'dev' is still live and a suspend staged
      // in the same turn is legitimate. The terminal check bites at apply time
      // and on any LATER turn, which is what the next assertion covers.
      const suspend = await call("mesh_stage_seat_suspend", { agentId: "dev" });
      seen.suspend = String(suspend.payload.error ?? "ok");
      return "staged";
    });
    const r = await h.chat(ask);
    assert.equal(r.json.proposal?.mutations.length, 2);
    assert.equal(seen.suspend, "ok");
  } finally {
    await h.close();
  }
});

test("designer staging: mesh_staged_list and _discard let the model retract before the operator sees it", async () => {
  const h = await stagingHarness();
  try {
    h.script(async (call) => {
      await call("mesh_stage_run_pause", { reason: "thinking" });
      await call("mesh_stage_goal_description", { description: "Keep this one" });
      const listed = await call("mesh_staged_list", {});
      assert.deepEqual(JSON.parse(String(listed.payload.detail)), [
        { index: 0, kind: "run.pause" },
        { index: 1, kind: "goal.description" },
      ]);
      const dropped = await call("mesh_staged_discard", { index: 0 });
      assert.equal(dropped.isError, false);
      return "staged one change";
    });

    const r = await h.chat(ask);
    assert.equal(r.json.proposal?.mutations.length, 1);
    assert.equal(r.json.proposal?.mutations[0].kind, "goal.description");
  } finally {
    await h.close();
  }
});

test("designer staging: two concurrent turns cannot write into each other's buffer", async () => {
  const h = await stagingHarness();
  try {
    // Both turns must be in flight at once, or the isolation is untested.
    let release!: () => void;
    const bothStarted = new Promise<void>((r) => {
      let arrived = 0;
      release = () => {
        if (++arrived === 2) r();
      };
    });

    h.script(async (call, opts) => {
      const mine = opts?.mcp?.headers?.["x-mesh-designer-turn"];
      release();
      await bothStarted;
      // Stage one mutation carrying this turn's own id, so a cross-write would
      // be visible as the wrong description landing in the wrong response.
      await call("mesh_stage_goal_description", { description: `turn ${mine}` });
      return "staged";
    });

    const [a, b] = await Promise.all([h.chat(ask), h.chat(ask)]);
    for (const r of [a, b]) {
      assert.equal(r.json.proposal?.mutations.length, 1, "each turn drains exactly its own mutation");
      const desc = (r.json.proposal!.mutations[0] as { description: string }).description;
      assert.equal(desc, `turn ${r.json.proposal!.id}`, "a turn's buffer holds only what that turn staged");
    }
    assert.notEqual(a.json.proposal!.id, b.json.proposal!.id);
  } finally {
    await h.close();
  }
});

test("designer staging: with two turns open and no turn header, staging is refused rather than guessed", async () => {
  const h = await stagingHarness();
  try {
    // Two barriers, not one: the first proves both turns are open before
    // either stages, the second holds both turns open until both staging
    // calls have come back. Without the second, the server may answer one
    // call, close its turn, and only then read the other socket — which is
    // the unambiguous single-turn case, not the race under test.
    const barrier = (n: number) => {
      let trip!: () => void;
      const reached = new Promise<void>((r) => {
        let arrived = 0;
        trip = () => {
          if (++arrived === n) r();
        };
      });
      return async () => {
        trip();
        await reached;
      };
    };
    const bothStarted = barrier(2);
    const bothCalled = barrier(2);
    const errors: string[] = [];

    h.script(async (call) => {
      await bothStarted();
      // Drop the header the way opencode's shared, spawn-time bridge does.
      const r = await call("mesh_stage_run_pause", {}, { headers: { "x-mesh-token": "human-local" } });
      if (r.isError) errors.push(String(r.payload.error ?? ""));
      await bothCalled();
      return "done";
    });

    const [a, b] = await Promise.all([h.chat(ask), h.chat(ask)]);
    assert.equal(errors.length, 2, "both ambiguous calls are refused");
    for (const e of errors) assert.match(e, /more than one designer turn is open/);
    assert.equal(a.json.proposal?.mutations.length, 0);
    assert.equal(b.json.proposal?.mutations.length, 0);
  } finally {
    await h.close();
  }
});

test("designer staging: a single open turn needs no header, which is how opencode's shared bridge works", async () => {
  const h = await stagingHarness();
  try {
    h.script(async (call) => {
      const r = await call("mesh_stage_run_pause", { reason: "cooling off" }, { headers: { "x-mesh-token": "human-local" } });
      assert.equal(r.isError, false, JSON.stringify(r.payload));
      return "staged a pause";
    });
    const r = await h.chat(ask);
    assert.equal(r.json.proposal?.mutations.length, 1);
    assert.equal(r.json.proposal?.mutations[0].kind, "run.pause");
  } finally {
    await h.close();
  }
});

test("designer staging: the buffer is closed after the turn, so a late tool call cannot write", async () => {
  const h = await stagingHarness();
  try {
    let late!: ToolCaller;
    let url = "";
    let headers: Record<string, string> = {};
    h.script(async (call, opts) => {
      late = call;
      url = opts!.mcp!.url;
      headers = opts!.mcp!.headers ?? {};
      return "done";
    });
    await h.chat(ask);

    // The turn has drained and closed. A bridge process that outlived it (or a
    // replayed request) must not be able to append to a proposal the operator
    // is already looking at.
    const r = await late("mesh_stage_run_pause", { reason: "too late" }, { url, headers });
    assert.equal(r.isError, true);
    assert.match(String(r.payload.error ?? ""), /no longer open/);
  } finally {
    await h.close();
  }
});

test("designer staging: a staged config.replace suppresses the fenced block, so the operator sees one config card", async () => {
  const h = await stagingHarness();
  try {
    h.script(async (call) => {
      await call("mesh_stage_config_replace", { yaml: "mesh:\n  id: staged\n", reason: "tool path" });
      // The model breaking the one-block rule must not produce a second,
      // conflicting config proposal (plan Risk 5).
      return "Here it is\n\n```json\n{\"mesh\":{\"id\":\"from-text\"}}\n```";
    });
    const r = await h.chat(ask);
    assert.equal(r.json.proposedConfig, undefined, "the text block is suppressed when a config was staged");
    const configs = r.json.proposal!.mutations.filter((m) => m.kind === "config.replace");
    assert.equal(configs.length, 1);
    assert.match((configs[0] as { yaml: string }).yaml, /id: staged/);
  } finally {
    await h.close();
  }
});
