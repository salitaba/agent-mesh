import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MultiplexHub,
  SseDecoder,
  parseCursors,
  parseProjectList,
  type MultiplexSocket,
  type UpstreamSink,
} from "../../packages/observability/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function event(seq: number, type = "test.event"): MeshEvent {
  return {
    id: `e${seq}`,
    seq,
    type,
    at: new Date().toISOString(),
    actor: "a",
    payload: { n: seq },
  } as unknown as MeshEvent;
}

/**
 * A browser socket that records what it was written.
 *
 * `write` returns false once `stallAfter` frames have landed, which is the only
 * backpressure signal the real `http.ServerResponse` gives, and stays false
 * until the test calls `drain()`.
 */
class FakeSocket implements MultiplexSocket {
  written: string[] = [];
  ended = false;
  private drainListeners: (() => void)[] = [];
  private stalled = false;

  constructor(private stallAfter = Infinity) {}

  write(chunk: string): boolean {
    this.written.push(chunk);
    if (this.written.length >= this.stallAfter) this.stalled = true;
    return !this.stalled;
  }

  end(): void {
    this.ended = true;
  }

  once(_e: "drain", listener: () => void): unknown {
    this.drainListeners.push(listener);
    return this;
  }

  drain(): void {
    this.stalled = false;
    this.stallAfter = Infinity;
    const listeners = this.drainListeners;
    this.drainListeners = [];
    for (const l of listeners) l();
  }

  /** Every tagged kernel frame, parsed. Comments and heartbeats drop out. */
  frames(): { projectId: string; seq: number; event: MeshEvent }[] {
    const out: { projectId: string; seq: number; event: MeshEvent }[] = [];
    const decoder = new SseDecoder((frame) => {
      if (frame.event === "resync" || !frame.id) return;
      out.push(JSON.parse(frame.data));
    });
    decoder.push(this.written.join(""));
    return out;
  }

  named(type: string): any[] {
    const out: any[] = [];
    const decoder = new SseDecoder((frame) => {
      if (frame.event === type) out.push(JSON.parse(frame.data));
    });
    decoder.push(this.written.join(""));
    return out;
  }
}

/** A hub whose upstreams are driven by hand, one sink per project. */
function hubWithSinks(options: { maxQueue?: number; historyPerProject?: number } = {}): {
  hub: MultiplexHub;
  sinks: Map<string, UpstreamSink>;
  closed: string[];
} {
  const sinks = new Map<string, UpstreamSink>();
  const closed: string[] = [];
  const hub = new MultiplexHub({
    openUpstream: (projectId, _since, sink) => {
      sinks.set(projectId, sink);
      return {
        close: () => {
          closed.push(projectId);
          sinks.delete(projectId);
        },
      };
    },
    heartbeatMs: 0,
    ...options,
  });
  return { hub, sinks, closed };
}

test("frames are tagged with their project and per-project seq", async () => {
  const { hub, sinks } = hubWithSinks();
  await hub.follow("alpha");
  await hub.follow("beta");

  const socket = new FakeSocket();
  hub.add(socket, { projects: ["alpha", "beta"] });

  sinks.get("alpha")!.event(event(1));
  sinks.get("beta")!.event(event(1));
  sinks.get("alpha")!.event(event(2));

  const frames = socket.frames();
  assert.deepEqual(
    frames.map((f) => [f.projectId, f.seq]),
    [["alpha", 1], ["beta", 1], ["alpha", 2]],
  );
  // Two projects both at seq 1 is the point: sequence numbers are per-project
  // logs, so there is no global ordering to collapse them into.
  assert.equal(hub.lastSeq("alpha"), 2);
  assert.equal(hub.lastSeq("beta"), 1);
  assert.equal(frames[0].event.type, "test.event");
  await hub.close();
});

test("a client resumes each project from its own cursor", async () => {
  const { hub, sinks } = hubWithSinks();
  await hub.follow("alpha");
  await hub.follow("beta");
  for (let seq = 1; seq <= 4; seq++) {
    sinks.get("alpha")!.event(event(seq));
    sinks.get("beta")!.event(event(seq));
  }

  const socket = new FakeSocket();
  hub.add(socket, { projects: ["alpha", "beta"], since: parseCursors("alpha:3,beta:1") });

  // One cursor per project, applied independently — a single global cursor
  // would either replay beta or skip alpha.
  assert.deepEqual(
    socket.frames().map((f) => [f.projectId, f.seq]),
    [["alpha", 4], ["beta", 2], ["beta", 3], ["beta", 4]],
  );
  await hub.close();
});

test("opening a project mid-session is lossless across a reconnect", async () => {
  const { hub, sinks } = hubWithSinks();
  await hub.follow("alpha");

  const first = new FakeSocket();
  const detach = hub.add(first, { projects: ["alpha"] });
  sinks.get("alpha")!.event(event(1));
  sinks.get("alpha")!.event(event(2));

  // The browser reconnects to add "beta". Frames alpha produces during the gap
  // are still ingested here, because subscriptions follow open projects rather
  // than browser connections.
  detach();
  await hub.follow("beta");
  sinks.get("alpha")!.event(event(3));
  sinks.get("beta")!.event(event(7));

  const second = new FakeSocket();
  hub.add(second, { projects: ["alpha", "beta"], since: parseCursors("alpha:2") });

  assert.deepEqual(
    second.frames().map((f) => [f.projectId, f.seq]),
    [["alpha", 3], ["beta", 7]],
    "nothing produced during the reconnect window is lost",
  );
  await hub.close();
});

test("a cursor older than the replay ring gets a gap signal, not a silent hole", async () => {
  const { hub, sinks } = hubWithSinks({ historyPerProject: 3 });
  await hub.follow("alpha");
  for (let seq = 1; seq <= 6; seq++) sinks.get("alpha")!.event(event(seq));

  const socket = new FakeSocket();
  hub.add(socket, { projects: ["alpha"], since: parseCursors("alpha:1") });

  // Seqs 2 and 3 were evicted. Replaying 4-6 would look complete.
  assert.deepEqual(socket.frames(), []);
  const resync = socket.named("resync");
  assert.equal(resync.length, 1);
  assert.equal(resync[0].reason, "gap");
  assert.equal(resync[0].projectId, "alpha");
  assert.equal(resync[0].seq, 1);
  await hub.close();
});

test("a slow consumer is bounded and resynced, and never stalls ingestion", async () => {
  const { hub, sinks } = hubWithSinks({ maxQueue: 4 });
  await hub.follow("alpha");

  // Stalls after the two preamble writes plus one frame.
  const slow = new FakeSocket(1);
  const fast = new FakeSocket();
  hub.add(slow, { projects: ["alpha"] });
  hub.add(fast, { projects: ["alpha"] });

  for (let seq = 1; seq <= 40; seq++) sinks.get("alpha")!.event(event(seq));

  // The stalled socket must not have absorbed 40 frames' worth of memory...
  assert.ok(slow.written.length < 10, `slow client buffered ${slow.written.length} writes`);
  // ...and must not have held back the client that was keeping up.
  assert.equal(fast.frames().length, 40);
  assert.equal(hub.lastSeq("alpha"), 40, "ingestion continued at full speed");

  slow.drain();
  const resync = slow.named("resync");
  assert.equal(resync.length, 1);
  assert.equal(resync[0].reason, "overflow");
  // The cursor tells the client exactly where to refetch from.
  assert.ok(resync[0].cursors.alpha >= 1);
  assert.ok(resync[0].dropped > 0);
  await hub.close();
});

test("live stream frames carry projectId and stay out of the resume ring", async () => {
  const { hub, sinks } = hubWithSinks();
  await hub.follow("alpha");
  const socket = new FakeSocket();
  hub.add(socket, { projects: ["alpha"] });

  sinks.get("alpha")!.event(event(1));
  sinks.get("alpha")!.stream("turn.token", { turnId: "t1", agentId: "a", delta: "hi" });

  const tokens = socket.named("turn.token");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].projectId, "alpha");
  assert.equal(tokens[0].delta, "hi");

  // No seq, so it must not be replayed to a resuming client — EventSource
  // rewind and log catch-up both ignore it inside a child too.
  const resumed = new FakeSocket();
  hub.add(resumed, { projects: ["alpha"], since: parseCursors("alpha:0") });
  assert.equal(resumed.named("turn.token").length, 0);
  assert.equal(resumed.frames().length, 1);
  await hub.close();
});

test("one upstream per project no matter how many browsers ask", async () => {
  let opens = 0;
  const hub = new MultiplexHub({
    heartbeatMs: 0,
    openUpstream: (_id, _since, _sink) => {
      opens += 1;
      return { close: () => undefined };
    },
  });
  await hub.follow("alpha");
  await hub.follow("alpha");
  await Promise.all([hub.follow("beta"), hub.follow("beta")]);
  assert.equal(opens, 2, "a second browser joins the existing child subscription");
  assert.deepEqual(hub.followed().sort(), ["alpha", "beta"]);
  await hub.close();
});

test("an upstream that dies tells its clients where they stopped", async () => {
  const { hub, sinks } = hubWithSinks();
  await hub.follow("alpha");
  await hub.follow("beta");
  const socket = new FakeSocket();
  hub.add(socket, { projects: ["alpha", "beta"] });
  sinks.get("alpha")!.event(event(5));

  sinks.get("alpha")!.closed(new Error("child exited"));

  const resync = socket.named("resync");
  assert.equal(resync.length, 1);
  assert.equal(resync[0].reason, "upstream-closed");
  assert.equal(resync[0].projectId, "alpha");
  assert.equal(resync[0].seq, 5, "the cursor makes the reconnect lossless");
  assert.deepEqual(hub.followed(), ["beta"], "the dead subscription is dropped so follow() reopens it");
  await hub.close();
});

test("close drains clients and every subscription, including one opened mid-shutdown", async () => {
  const closed: string[] = [];
  let release: (() => void) | undefined;
  const hub = new MultiplexHub({
    heartbeatMs: 0,
    openUpstream: async (projectId) => {
      if (projectId === "slow") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return { close: () => closed.push(projectId) };
    },
  });
  await hub.follow("alpha");
  const socket = new FakeSocket();
  hub.add(socket, { projects: ["alpha"] });

  // A subscription still in its handshake when shutdown starts. Step 4 shipped
  // exactly this bug for child processes: not yet in the map, so teardown
  // skipped it and it outlived the host.
  const slow = hub.follow("slow");
  const closing = hub.close();
  release!();
  await slow;
  await closing;

  assert.ok(socket.ended, "clients are ended");
  assert.deepEqual(closed.sort(), ["alpha", "slow"], "no subscription outlives the hub");
  assert.deepEqual(hub.followed(), []);
});

test("query parsing drops garbage instead of defaulting it", () => {
  assert.deepEqual(parseProjectList("a, b ,,a,c"), ["a", "b", "c"]);
  assert.deepEqual(parseProjectList(null), []);
  assert.deepEqual([...parseCursors("a:120,b:44")], [["a", 120], ["b", 44]]);
  // A cursor read as NaN would either replay a whole log or skip it silently.
  assert.deepEqual([...parseCursors("a:abc,:5,b:,c:7")], [["c", 7]]);
  assert.deepEqual([...parseCursors(undefined)], []);
});

test("the decoder reassembles frames split across chunk boundaries", () => {
  const seen: { event?: string; data: string }[] = [];
  const decoder = new SseDecoder((f) => seen.push(f));
  const wire = `id: 1\nevent: a.b\ndata: {"n":1}\n\n: ping\n\nevent: turn.token\ndata: {"delta":"x"}\n\n`;
  // One byte at a time: chunk boundaries have nothing to do with frames.
  for (const ch of wire) decoder.push(ch);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].event, "a.b");
  assert.deepEqual(JSON.parse(seen[0].data), { n: 1 });
  assert.equal(seen[1].event, "turn.token");
});
