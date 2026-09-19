/**
 * `mesh backups` and `mesh restore` — the offline path.
 *
 * The server routes are covered in `tests/server/restore.test.ts`. What is
 * specific to the CLI is that it works on a mesh that is NOT running, which
 * makes the state lock the only thing standing between it and a live mission's
 * log. So the interesting case here is the refusal, and it needs a genuinely
 * separate process: a same-process double-open exercises a different branch of
 * `acquireStateLock` and produces a different message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { runBackupsCommand, runRestoreCommand } from "../../apps/mesh-cli/src/backups";
import { acquireStateLock } from "../../packages/persistence/src/index";
import { resolveConfig } from "../../packages/config/src/index";
import { testConfigYaml } from "../helpers";

const hasGit = (() => {
  try {
    require("child_process").execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** Captures stdout/stderr so command output can be asserted, not just eyeballed. */
async function capture(fn: () => number): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    return { code: fn(), out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

function writeMesh(dir: string): string {
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }),
    "utf8",
  );
  return configPath;
}

/** Boot a file-backed mesh, leave events behind, reset, and hand back the stamp. */
async function meshWithOneBackup(dir: string): Promise<string> {
  const configPath = writeMesh(dir);
  const m = await bootstrapMesh({ configPath, mode: "parked" });
  try {
    await m.kernel.emit("human.input", { action: "the-work-we-want-back" }, { actorId: "human" });
    const report = await m.reset({});
    const stamp = /\.bak-(\d{8}-\d{6})/.exec(report.archivedTo!)?.[1];
    assert.ok(stamp, "the reset must have written a stamped state archive");
    return stamp;
  } finally {
    await m.close();
  }
}

test("mesh backups lists one reset's archives and marks only the state one restorable", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-backups-"));
  try {
    const configPath = writeMesh(dir);
    const stamp = await meshWithOneBackup(dir);

    const text = await capture(() => runBackupsCommand([configPath], {}));
    assert.equal(text.code, 0);
    assert.match(text.out, new RegExp(stamp), "the stamp must appear");
    // Whether an archive can be restored is the reason to look at this listing
    // at all, so every row has to answer it.
    const lines = text.out.split("\n");
    const restorable = lines.filter((l) => l.includes("restorable") && !l.includes("not restorable"));
    const notRestorable = lines.filter((l) => l.includes("not restorable"));
    assert.equal(restorable.length, 1, `exactly one archive is restorable:\n${text.out}`);
    assert.equal(notRestorable.length, 1, `the product archive must be marked unrestorable:\n${text.out}`);
    assert.match(restorable[0], /state/, "the restorable one is the state archive");

    const asJson = await capture(() => runBackupsCommand([configPath], { json: true }));
    const parsed = JSON.parse(asJson.out) as { backups: Array<{ stamp: string; kind: string }> };
    assert.ok(parsed.backups.some((b) => b.stamp === stamp && b.kind === "state"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh backups on a mesh that never reset says so instead of printing nothing", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-backups-empty-"));
  try {
    const configPath = writeMesh(dir);
    const m = await bootstrapMesh({ configPath, mode: "parked" });
    await m.close();

    const r = await capture(() => runBackupsCommand([configPath], {}));
    assert.equal(r.code, 0);
    assert.match(r.out, /no backups/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh restore brings the mission back offline", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-restore-"));
  try {
    const configPath = writeMesh(dir);
    const stamp = await meshWithOneBackup(dir);

    const r = await capture(() => runRestoreCommand([configPath, stamp], {}));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`restored .*${stamp}`));
    assert.match(r.out, /the state it replaced was archived at/, "the swap must be reversible");

    // Booting now replays the restored log: the whole point of doing this
    // offline is that the next boot finds the mission it was told to find.
    const m = await bootstrapMesh({ configPath, mode: "parked" });
    try {
      const events = await m.store.read();
      assert.ok(
        events.some((e) => (e.payload as { action?: string })?.action === "the-work-we-want-back"),
        "the restored mission must be in the log at boot",
      );
    } finally {
      await m.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh restore refuses an unknown stamp and names the command that lists them", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-restore-unknown-"));
  try {
    const configPath = writeMesh(dir);
    await meshWithOneBackup(dir);
    assert.throws(() => runRestoreCommand([configPath, "19990101-000000"], {}), /no backup with stamp 19990101-000000[\s\S]*mesh backups/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh restore refuses while another process holds the state lock, naming its pid", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-restore-locked-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const configPath = writeMesh(dir);
    const stamp = await meshWithOneBackup(dir);
    const stateDir = resolveConfig(configPath).stateDir;

    // A real second process: a same-process double-open takes a different
    // branch and would not prove the lock works across the boundary that
    // actually matters here.
    const holder = path.join(dir, "holder.js");
    fs.writeFileSync(
      holder,
      `
const { acquireStateLock } = require(${JSON.stringify(path.join(__dirname, "../../packages/persistence/src/index"))});
acquireStateLock(process.argv[2]);
process.stdout.write("READY\\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1 << 30);
`,
      "utf8",
    );
    child = spawn(process.execPath, [holder, stateDir], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lock holder never became ready")), 10_000);
      child!.stdout!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child!.on("error", reject);
      child!.on("exit", (code) => reject(new Error(`lock holder exited early with ${code}`)));
    });

    assert.throws(
      () => runRestoreCommand([configPath, stamp], {}),
      (err: Error) => {
        // The pid is what makes the refusal actionable: it says who to stop.
        assert.match(err.message, /already in use by pid \d+/);
        return true;
      },
    );
  } finally {
    child?.kill("SIGTERM");
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("mesh restore with no stamp prints usage rather than guessing", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-restore-usage-"));
  try {
    const configPath = writeMesh(dir);
    assert.throws(() => runRestoreCommand([configPath], {}), /usage: mesh restore <mesh\.yaml> <stamp>/);
    assert.throws(() => runBackupsCommand([], {}), /usage: mesh backups <mesh\.yaml>/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
