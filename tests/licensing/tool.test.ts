import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * The vendor's licence tool, run as the vendor runs it: generate a key, sign, check, and be
 * refused when something is unsafe. It imports the compiled licensing package, so what it
 * signs is what the product verifies.
 */

const TOOL = path.resolve(__dirname, "..", "..", "..", "tools", "license", "mesh-license.mjs");

const run = (args: string[]) => spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });

test("keygen, sign, inspect and verify, end to end", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-licensetool-"));
  try {
    const keyFile = path.join(dir, "k1.pem");
    const gen = run(["keygen", "--kid", "k1", "--out", keyFile]);
    assert.equal(gen.status, 0, gen.stderr);
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600, "the private key is readable by its owner only");
    const publicKey = /k1: "([A-Za-z0-9_-]+)"/.exec(gen.stdout)?.[1];
    assert.ok(publicKey, "the public key to paste into keys.ts is printed");
    assert.ok(!gen.stdout.includes("PRIVATE KEY") && !gen.stderr.includes("PRIVATE KEY"), "the private key is never printed");

    const signed = run(["sign", "--key", keyFile, "--kid", "k1", "--customer", "Acme Robotics", "--plan", "team", "--days", "30", "--max-projects", "7", "--max-seats", "unlimited", "--feature", "prometheus-metrics", "--id", "lic_test"]);
    assert.equal(signed.status, 0, signed.stderr);
    const token = signed.stdout.trim();
    assert.match(token, /^AML1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const verified = run(["verify", token, "--public", publicKey!]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.match(verified.stdout, /valid signature \(key k1\)/);
    assert.match(verified.stdout, /Team licence for Acme Robotics \(lic_test\), valid until \d{4}-\d{2}-\d{2}: unlimited seats per mesh, 7 project\(s\), 8 concurrent turns\./);

    const inspected = run(["inspect", token]);
    assert.equal(inspected.status, 0);
    const claims = JSON.parse(inspected.stdout) as Record<string, unknown>;
    assert.deepEqual(claims.limits, { maxSeatsPerMesh: null, maxProjects: 7 });
    assert.deepEqual(claims.features, ["prometheus-metrics"]);
    assert.match(inspected.stderr, /signature was NOT checked/);

    const tokenFile = path.join(dir, "license.key");
    fs.writeFileSync(tokenFile, `${token}\n`);
    assert.equal(run(["verify", tokenFile, "--public", publicKey!]).status, 0, "a file holding the token works as well as the token");

    const tampered = run(["verify", `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`, "--public", publicKey!]);
    assert.equal(tampered.status, 1);
    assert.match(tampered.stderr, /bad-signature/);
    const wrongKey = run(["verify", token, "--public", JSON.parse(JSON.stringify(publicKey!)).replace(/.$/, publicKey!.endsWith("A") ? "B" : "A")]);
    assert.notEqual(wrongKey.status, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the tool refuses what would leak a key or issue a bad licence", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-licensetool-"));
  try {
    const keyFile = path.join(dir, "k1.pem");
    assert.equal(run(["keygen", "--kid", "k1", "--out", keyFile]).status, 0);

    const again = run(["keygen", "--kid", "k1", "--out", keyFile]);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already exists; refusing to overwrite a private key/);

    fs.chmodSync(keyFile, 0o644);
    const open = run(["sign", "--key", keyFile, "--kid", "k1", "--customer", "X", "--plan", "team"]);
    assert.equal(open.status, 2);
    assert.match(open.stderr, /readable by others \(mode 644\); run chmod 600/);
    fs.chmodSync(keyFile, 0o600);

    for (const [args, expected] of [
      [["--plan", "gold", "--customer", "X"], /--plan must be one of community, team, business, enterprise/],
      [["--plan", "team"], /--customer is required/],
      [["--plan", "team", "--customer", "X", "--days", "-3"], /--days must be a positive number/],
      [["--plan", "team", "--customer", "X", "--max-projects", "many"], /--max-projects must be a whole number or 'unlimited'/],
      [["--plan", "team", "--customer", "X", "--feature", "teleport"], /refusing to sign: features/],
      [["--plan", "team", "--customer", "X", "--grace", "400"], /refusing to sign: graceDays/],
    ] as Array<[string[], RegExp]>) {
      const res = run(["sign", "--key", keyFile, "--kid", "k1", ...args]);
      assert.equal(res.status, 2, args.join(" "));
      assert.match(res.stderr, expected, args.join(" "));
      assert.equal(res.stdout, "", "nothing is printed that could be mistaken for a licence");
    }

    assert.equal(run(["keygen", "--out", path.join(dir, "k2.pem")]).status, 2, "--kid is required");
    assert.equal(run(["bogus"]).status, 2);
    assert.equal(run([]).status, 0, "no command prints the usage");
    assert.match(run([]).stdout, /Vendor-side licence tool/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
