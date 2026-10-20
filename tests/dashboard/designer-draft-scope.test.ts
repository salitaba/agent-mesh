import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { clearStored, commitDraft, getDraftSnapshot, readStored, resetDraft, storeDraft } from "../../apps/mesh-dashboard/src/designer/storage";

/*
 * A designer draft is the config of ONE project: the model, the baseline it is compared with and the absolute mesh.yaml
 * path a save writes to. The console is a single-page app and switching projects is a hash change, so the draft store —
 * a module singleton — and the browser mirror outlive the switch. A draft carried across it kept the other project's
 * mesh.yaml path, and Save then posted a path outside the new project: the server refused it with "save path escapes the
 * project directory (/data/projects/my-mesh-3)" for a file that was never meant for that project at all.
 */

function fakeStorage(): any {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
  };
}

/** A document shaped like the mesh.yaml the server hands the designer. */
function doc(projectId: string, meshId = projectId): any {
  return { version: 1, project: { id: projectId, name: projectId }, mesh: { id: meshId, name: meshId, agents: {} }, agents: { pm: { role: "pm" } } };
}

function withStore(run: (storage: any) => void): void {
  const previous = (globalThis as any).localStorage;
  const storage = fakeStorage();
  (globalThis as any).localStorage = storage;
  try {
    resetDraft("");
    run(storage);
  } finally {
    (globalThis as any).localStorage = previous;
    resetDraft("");
  }
}

test("a draft belongs to its project: resetDraft drops the model, the baseline and the mesh.yaml path", () => {
  resetDraft("a");
  commitDraft({ model: doc("a"), runningPath: "/data/projects/a/mesh.yaml", runningRaw: doc("a"), loaded: true });
  assert.equal(getDraftSnapshot().runningPath, "/data/projects/a/mesh.yaml");
  resetDraft("b");
  assert.equal(getDraftSnapshot().model, null);
  assert.equal(getDraftSnapshot().runningRaw, null);
  assert.equal(getDraftSnapshot().runningPath, "");
  assert.equal(getDraftSnapshot().loaded, false);
  assert.equal(getDraftSnapshot().projectId, "b");
});

test("the browser draft is stored per project, so the other project's draft is never offered back", () => {
  withStore((storage) => {
    resetDraft("a");
    commitDraft({ model: doc("a"), copyPath: "copies/a.yaml", loaded: true });
    storeDraft();
    resetDraft("b");
    commitDraft({ model: doc("b"), loaded: true });
    storeDraft();

    assert.equal(readStored("a")?.model.project.id, "a");
    assert.equal(readStored("b")?.model.project.id, "b");
    assert.equal(readStored("c"), null);
    // Neither project's write overwrote the other's.
    assert.ok([...Array(storage.length).keys()].map((i) => storage.key(i)).filter((k) => k?.includes("draft")).length >= 2);
  });
});

test("a draft written before the store was per-project is kept only for the project its own document names", () => {
  withStore((storage) => {
    storage.setItem("mesh-designer-draft-v2", JSON.stringify({ ts: 1, model: doc("my-mesh-2"), copyPath: "old.yaml" }));
    assert.equal(readStored("my-mesh-2")?.model.project.id, "my-mesh-2");
    assert.equal(readStored("my-mesh-3"), null);
    // Reading it for another project does not consume it: the project that owns it still gets it back.
    assert.equal(readStored("my-mesh-2")?.copyPath, "old.yaml");
  });
});

test("clearing one project's draft leaves another project's alone", () => {
  withStore((storage) => {
    resetDraft("a");
    commitDraft({ model: doc("a"), loaded: true });
    storeDraft();
    resetDraft("b");
    commitDraft({ model: doc("b"), loaded: true });
    storeDraft();

    clearStored("a");
    assert.equal(readStored("a"), null);
    assert.equal(readStored("b")?.model.project.id, "b");
  });
});

/* The refusal the owner saw names the path it refused, so a stale path is identifiable from the message alone. */
test("the save route's refusal names the path it refused beside the directory it had to be in", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "apps/mesh-server/src/index.ts"), "utf8");
  assert.match(source, /save path escapes the project directory \(\$\{configRoot\}\): \$\{String\(b\.path\)\}/);
});

/* The mount effect is where a switch between projects used to keep the previous project's draft: pin the check, because
 * the store is a singleton and nothing else in the page compares a draft with the project it belongs to. */
test("the designer keeps a draft only for the project it was read from, and drops one that belongs to another", () => {
  const source = fs.readFileSync(path.join(process.cwd(), "apps/mesh-dashboard/src/designer/Designer.tsx"), "utf8");
  assert.match(source, /current\.loaded && current\.model && current\.projectId === projectKey/);
  assert.match(source, /if \(current\.loaded && current\.projectId !== projectKey\) resetDraft\(projectKey\);/);
  assert.match(source, /readStored\(projectKey\)/);
});
