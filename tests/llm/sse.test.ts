import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSse } from "../../packages/llm/src/index";

async function* chunks(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? new TextEncoder().encode(p) : p;
}

async function all(...parts: Array<string | Uint8Array>) {
  const out = [];
  for await (const m of parseSse(chunks(...parts))) out.push(m);
  return out;
}

test("events end at a blank line, and carry the event name when there is one", async () => {
  assert.deepEqual(await all("data: one\n\nevent: ping\ndata: two\n\n"), [
    { event: "message", data: "one" },
    { event: "ping", data: "two" },
  ]);
});

test("several data lines join with a newline", async () => {
  assert.deepEqual(await all("data: a\ndata: b\ndata:c\n\n"), [{ event: "message", data: "a\nb\nc" }]);
});

test("comments and unknown fields are ignored, and a block with no data is not an event", async () => {
  assert.deepEqual(await all(": keep-alive\n\nid: 7\nretry: 100\n\ndata: x\n\n"), [{ event: "message", data: "x" }]);
});

test("a line may end in \\r\\n or a lone \\r, and a split \\r\\n is one line ending", async () => {
  assert.deepEqual(await all("data: a\r\n\r\ndata: b\r\r"), [
    { event: "message", data: "a" },
    { event: "message", data: "b" },
  ]);
  assert.deepEqual(await all("data: a\r", "\n\r", "\ndata: b\n\n"), [
    { event: "message", data: "a" },
    { event: "message", data: "b" },
  ]);
});

test("a CRLF inside a multi-line event is one line ending, not a line and an empty line", async () => {
  assert.deepEqual(await all("data: a\r\ndata: b\r\n\r\n"), [{ event: "message", data: "a\nb" }]);
});

test("a field split across chunks is read whole", async () => {
  assert.deepEqual(await all("da", "ta: hel", "lo\n", "\n"), [{ event: "message", data: "hello" }]);
});

test("a multi-byte character split across chunks is not corrupted", async () => {
  const bytes = new TextEncoder().encode("data: héllo €\n\n");
  const cut = bytes.indexOf(0xc3) + 1; // inside the two-byte é
  assert.deepEqual(await all(bytes.slice(0, cut), bytes.slice(cut)), [{ event: "message", data: "héllo €" }]);
});

test("an event with no final blank line is still delivered when the stream ends", async () => {
  assert.deepEqual(await all("data: last"), [{ event: "message", data: "last" }]);
});

test("one space after the colon is dropped, and only one", async () => {
  assert.deepEqual(await all("data:  two spaces\n\n"), [{ event: "message", data: " two spaces" }]);
});
