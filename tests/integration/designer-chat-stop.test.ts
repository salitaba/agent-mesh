import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";

/**
 * The same mesh fixture the designer-chat tests use, with one difference that
 * is the point of this file: the runtime's stream cannot finish on its own. It
 * writes a little, then waits on the signal the route gave it — which is how a
 * real model behaves while it is still generating, and the only state in which
 * Stop means anything.
 */
async function stopHarness() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["git.commit"], authority: ["requirements.accept"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: [] },
    startup: ["lead"],
  });
  const run: { signal: AbortSignal | null; interrupted: boolean } = { signal: null, interrupted: false };
  m.designerRuntime.promptStream = async (_text, opts, onDelta) => {
    onDelta?.({ kind: "text", delta: "Half an answer" });
    const signal = opts?.signal;
    run.signal = signal ?? null;
    if (!signal) return { reply: "Half an answer", thinking: "" };
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
    run.interrupted = true;
    // What a runtime returns when it was interrupted: what it had written, and
    // its own flag saying the turn ended early rather than well.
    return { reply: "Half an answer", thinking: "", stopped: true };
  };
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    base,
    run,
    async stream(): Promise<{ status: number; reader: ReadableStreamDefaultReader<Uint8Array> }> {
      const res = await fetch(`${base}/designer/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "make a mesh" }] }),
      });
      assert.ok(res.body, "the stream route answers with a body");
      return { status: res.status, reader: res.body!.getReader() };
    },
    async stop(body: unknown): Promise<{ status: number; json: any }> {
      const res = await fetch(`${base}/designer/chat/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    },
    async close() {
      await new Promise<void>((r) => server.close(() => r()));
      await m.cleanup();
    },
  };
}

/** Read SSE frames until `pred(line)` matches one, and return the frames so far. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  pred: (lines: string[]) => boolean,
): Promise<{ lines: string[]; text: string }> {
  const decoder = new TextDecoder();
  let text = "";
  let lines: string[] = [];
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    lines = text.split("\n").filter((l) => l.startsWith("data: "));
    if (pred(lines) || done) break;
  }
  return { lines, text };
}

const frame = (line: string): any => JSON.parse(line.slice("data: ".length));

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>, text: string): Promise<string> {
  const decoder = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (value) text += decoder.decode(value, { stream: true });
    if (done) return text;
  }
}

test("the stream announces the turn id first, before the model has said anything", async () => {
  const h = await stopHarness();
  try {
    const { status, reader } = await h.stream();
    assert.equal(status, 200);
    const { lines, text } = await readUntil(reader, (ls) => ls.some((l) => frame(l).type === "turn"));
    // The id is the handle Stop names, so it must arrive while the turn is still
    // running: a stop pressed during "thinking…" has nothing else to aim at.
    assert.equal(frame(lines[0]).type, "turn", `first frame was: ${lines[0]}`);
    assert.ok(frame(lines[0]).turnId, `expected a turn id in: ${text}`);
    assert.ok(h.run.signal, "the route handed the turn the signal that stops it");
    await h.stop({ turnId: frame(lines[0]).turnId });
    await drain(reader, text);
  } finally {
    await h.close();
  }
});

test("Stop ends the turn: the runtime is interrupted and the result says stopped", async () => {
  const h = await stopHarness();
  try {
    const { reader } = await h.stream();
    const first = await readUntil(reader, (ls) => ls.some((l) => frame(l).type === "turn"));
    const turnId = frame(first.lines[0]).turnId as string;

    const stopped = await h.stop({ turnId });
    assert.equal(stopped.status, 200);
    assert.deepEqual(stopped.json, { stopped: true, turnId });
    assert.equal(h.run.interrupted, true, "the model turn was actually stopped");

    const text = await drain(reader, first.text);
    const finalLine = text.split("\n").filter((l) => l.startsWith("data: ")).find((l) => frame(l).type === "final");
    assert.ok(finalLine, `expected a final frame in: ${text}`);
    const final = frame(finalLine!);
    assert.equal(final.stopped, true, "a stopped turn carries its own flag, not a guess");
    // Best-effort by contract: the flag is the only proof, and the partial reply
    // travels with it so the operator keeps what the model had written.
    assert.equal(final.reply, "Half an answer");
  } finally {
    await h.close();
  }
});

test("a stop that arrives after the turn ended is a no-op, not a conflict", async () => {
  const h = await stopHarness();
  try {
    const { reader } = await h.stream();
    const first = await readUntil(reader, (ls) => ls.some((l) => frame(l).type === "turn"));
    const turnId = frame(first.lines[0]).turnId as string;
    await h.stop({ turnId });
    await drain(reader, first.text);

    const again = await h.stop({ turnId });
    assert.equal(again.status, 404);
    assert.equal(again.json.code, "no_such_turn");
    // And the client tells the operator the same thing either way: `stopped` on
    // the transcript comes from the turn's own result, never from this route.
    assert.equal(again.json.stopped, undefined);
  } finally {
    await h.close();
  }
});

test("a stop naming a turn that never existed, or naming nothing, is refused", async () => {
  const h = await stopHarness();
  try {
    const bogus = await h.stop({ turnId: "not-a-turn" });
    assert.equal(bogus.status, 404);
    assert.equal(bogus.json.code, "no_such_turn");
    const empty = await h.stop({});
    assert.equal(empty.status, 404);
    const wrongType = await h.stop({ turnId: 42 });
    assert.equal(wrongType.status, 404);
  } finally {
    await h.close();
  }
});
