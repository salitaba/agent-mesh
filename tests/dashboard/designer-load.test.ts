import test from "node:test";
import assert from "node:assert/strict";

import { readConfigAnswer } from "../../apps/mesh-dashboard/src/designer/load";

/**
 * The Designer read every `GET /config` answer without a `raw` as "there is no mesh.yaml", so a project that was closed or still
 * starting (409) opened on the Triad template under "No mesh.yaml was found", and a save from there would have replaced the
 * person's file. These pin that only a 200 with no file means no file, and which failures are worth asking again about.
 */

const RAW = { mesh: { id: "demo", goal: "Ship it" }, agents: { pm: { role: "product-manager" } } };

test("a 200 with the file is the file, with where it lives", () => {
  assert.deepEqual(readConfigAnswer({ status: 200, json: { filePath: "/w/demo/mesh.yaml", dir: "/w/demo", raw: RAW } }), {
    kind: "file", raw: RAW, filePath: "/w/demo/mesh.yaml",
  });
  assert.equal((readConfigAnswer({ status: 200, json: { raw: RAW } }) as { filePath: string }).filePath, "", "a path is not invented");
});

test("only a 200 that carries no file is a new mesh", () => {
  for (const json of [{}, { raw: null }, { raw: {} }, { filePath: "", raw: undefined }]) {
    assert.deepEqual(readConfigAnswer({ status: 200, json }), { kind: "none" }, JSON.stringify(json));
  }
});

test("a project that is not running is a failed load, never 'no file', and is worth asking again about", () => {
  const closed = readConfigAnswer({ status: 409, json: { error: "project 'demo' is closed", status: "closed", projectId: "demo" } });
  assert.equal(closed.kind, "error");
  assert.ok(closed.kind === "error" && closed.waiting, "the page asks again by itself until the project is up");
  assert.match(closed.kind === "error" ? closed.text : "", /not running/);
  assert.equal(readConfigAnswer({ status: 409, json: null }).kind, "error");
});

test("a server fault or an unreadable answer is a failed load that says what happened, and is not retried behind the person's back", () => {
  const fault = readConfigAnswer({ status: 500, json: { error: "EACCES: permission denied" } });
  assert.deepEqual(fault, { kind: "error", text: "The server answered 500: EACCES: permission denied", waiting: false });
  assert.deepEqual(readConfigAnswer({ status: 502, json: null }), { kind: "error", text: "The server answered 502.", waiting: false });
  assert.deepEqual(readConfigAnswer({ status: 404, json: { reason: "no such route" } }), { kind: "error", text: "The server answered 404: no such route", waiting: false });
  assert.equal(readConfigAnswer({ status: 401, json: { error: "sign in" } }).kind, "error");
  assert.deepEqual(readConfigAnswer({ status: 200, json: null }), { kind: "error", text: "The server's answer could not be read.", waiting: false });
  assert.deepEqual(readConfigAnswer({ status: 200, json: "<!doctype html>" }), { kind: "error", text: "The server's answer could not be read.", waiting: false });
});

test("no answer at all is a failed load", () => {
  assert.deepEqual(readConfigAnswer({ status: 0, json: null, timeout: true }), { kind: "error", text: "The server did not answer in time.", waiting: false });
  assert.deepEqual(readConfigAnswer({ status: 0, json: null }), { kind: "error", text: "The server did not answer.", waiting: false });
});
