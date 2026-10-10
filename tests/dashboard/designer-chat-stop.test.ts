import { test } from "node:test";
import assert from "node:assert/strict";
import { clearChat, getSnapshot, sendMessage, stopTurn } from "../../apps/mesh-dashboard/src/designer/chatStore";
import type { ProjectClient } from "../../apps/mesh-dashboard/src/api";

/**
 * A client whose model turn runs until it is told to stop, the way a real one
 * does: the stream announces its turn id before anything else, writes some
 * text, then waits on the signal the caller passed in.
 */
function hangingClient(): { client: ProjectClient; stops: string[] } {
  const stops: string[] = [];
  const client = {
    api: async () => ({ status: 200, json: {} }),
    getText: async () => null,
    post: async (path: string, body?: any) => {
      if (path === "/designer/chat/stop") stops.push(String(body?.turnId ?? ""));
      return { status: 200, json: { stopped: true } };
    },
    postStream: async (_path: string, _body: unknown, onEvent: (e: any) => void, opts?: { signal?: AbortSignal }) => {
      onEvent({ type: "turn", turnId: "turn-7" });
      onEvent({ type: "thinking", delta: "weighing " });
      onEvent({ type: "text", delta: "Half an answer" });
      await new Promise<void>((resolve) => {
        if (opts?.signal?.aborted) {
          resolve();
          return;
        }
        opts?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { status: 200, canceled: true };
    },
  } as unknown as ProjectClient;
  return { client, stops };
}

/** A client whose turn finishes on its own, with a final frame, unreachable by Stop. */
function finishingClient(): ProjectClient {
  return {
    api: async () => ({ status: 200, json: {} }),
    getText: async () => null,
    post: async () => ({ status: 200, json: {} }),
    postStream: async (_path: string, _body: unknown, onEvent: (e: any) => void) => {
      onEvent({ type: "turn", turnId: "turn-8" });
      onEvent({ type: "text", delta: "The whole answer" });
      onEvent({ type: "final", reply: "The whole answer", thinking: "", problems: [] });
      return { status: 200 };
    },
  } as unknown as ProjectClient;
}

test("Stop ends the turn, keeps what the model had written, and says it was stopped", async () => {
  clearChat();
  const { client, stops } = hangingClient();
  const running = sendMessage(client, "add a security reviewer", {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(getSnapshot().busy, true, "the turn is running");
  assert.equal(getSnapshot().live?.text, "Half an answer");

  stopTurn(client);
  await running;

  const s = getSnapshot();
  assert.equal(s.busy, false, "a stopped turn is not still busy");
  assert.equal(s.live, null, "nothing is streaming into a stopped turn");
  assert.equal(s.failed, null, "a stop the operator asked for is not a failure");
  const last = s.entries[s.entries.length - 1];
  assert.equal(last.role, "assistant");
  assert.equal(last.content, "Half an answer", "what was written is kept");
  assert.equal(last.stopped, true, "and the transcript says it was stopped");
  assert.equal(stops.length, 1, "the server was told to end the turn too");
  assert.equal(stops[0], "turn-7", "by the id the stream announced");
});

test("Stop with no turn running does nothing and says nothing to the server", async () => {
  clearChat();
  const { client, stops } = hangingClient();
  stopTurn(client);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(stops, []);
  assert.equal(getSnapshot().busy, false);
});

test("a turn that finishes on its own is not marked stopped", async () => {
  clearChat();
  await sendMessage(finishingClient(), "make a mesh", {});
  const s = getSnapshot();
  assert.equal(s.busy, false);
  const last = s.entries[s.entries.length - 1];
  assert.equal(last.content, "The whole answer");
  assert.equal(last.stopped, undefined, "only the runtime's own flag marks a turn as stopped");
});
