/**
 * Provisioning a tenant: one namespace, one credentials Secret, one Helm release, repeatable.
 *
 * `kubectl` and `helm` are replaced by stubs that record every call, so what is checked is what the script
 * asks them to do: that no credential ever appears on a command line (argv is readable by every process on
 * the machine), that a re-run keeps the operator token, and that a name that would not make a valid namespace
 * is refused before anything runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "deploy", "fleet", "provision-tenant.sh");

interface Fixture {
  dir: string;
  bin: string;
  log: string;
  applied: string;
}

/** Stubs for `kubectl` and `helm` that log argv, expand --from-file into base64 YAML, and keep `apply` input. */
function fixture(existingToken?: string): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-fleet-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  const applied = path.join(dir, "applied.yaml");
  fs.writeFileSync(
    path.join(bin, "kubectl"),
    `#!/bin/sh
echo "kubectl $*" >> "${log}"
case "$*" in
  *"get secret mesh-credentials"*)
    ${existingToken ? `printf '%s' '${Buffer.from(existingToken).toString("base64")}'; exit 0` : "exit 1"} ;;
  *"create secret generic"*)
    echo "kind: Secret"; echo "data:"
    for a in "$@"; do
      case "$a" in
        --from-file=*) kv="\${a#--from-file=}"; key="\${kv%%=*}"; file="\${kv#*=}"; echo "  $key: $(base64 < "$file" | tr -d '\\n')" ;;
      esac
    done ;;
  *"create namespace"*) echo "kind: Namespace" ;;
  *"apply -f -"*) cat >> "${applied}" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "helm"), `#!/bin/sh\necho "helm $*" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  return { dir, bin, log, applied };
}

function run(f: Fixture, args: string[]): { status: number | null; stdout: string; stderr: string; calls: string[]; applied: string } {
  const r = spawnSync("sh", [SCRIPT, ...args], { env: { PATH: `${f.bin}:${process.env.PATH}`, HOME: f.dir }, encoding: "utf8", timeout: 30_000 });
  const calls = fs.existsSync(f.log) ? fs.readFileSync(f.log, "utf8").split("\n").filter(Boolean) : [];
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls, applied: fs.existsSync(f.applied) ? fs.readFileSync(f.applied, "utf8") : "" };
}

const decode = (yaml: string, key: string): string | undefined => {
  const m = new RegExp(`^\\s+${key}: (\\S+)$`, "m").exec(yaml);
  return m ? Buffer.from(m[1]!, "base64").toString("utf8") : undefined;
};

function files(f: Fixture): { licence: string; provider: string } {
  const licence = path.join(f.dir, "acme.key");
  const provider = path.join(f.dir, "acme-anthropic.key");
  fs.writeFileSync(licence, "AML1.k1.PAYLOAD-OF-THE-LICENCE.SIGNATURE-OF-THE-LICENCE\n");
  fs.writeFileSync(provider, "sk-ant-api03-THE-TENANTS-OWN-KEY\n");
  return { licence, provider };
}

test("it creates the namespace, the Secret and the release, and no credential is ever on a command line", () => {
  const f = fixture();
  const k = files(f);
  const r = run(f, ["--name", "acme", "--host", "mesh.acme.example.com", "--licence-file", k.licence, "--provider-key-file", k.provider, "--ingress-class", "nginx"]);
  assert.equal(r.status, 0, r.stderr);

  const argv = r.calls.join("\n");
  for (const secret of ["PAYLOAD-OF-THE-LICENCE", "THE-TENANTS-OWN-KEY"]) assert.ok(!argv.includes(secret), `${secret} must not be on a command line`);
  const token = decode(r.applied, "MESH_API_TOKEN")!;
  assert.match(token, /^[0-9a-f]{64}$/, "a 256-bit random operator token");
  assert.ok(!argv.includes(token), "nor the generated token");
  assert.equal(decode(r.applied, "MESH_LICENSE"), "AML1.k1.PAYLOAD-OF-THE-LICENCE.SIGNATURE-OF-THE-LICENCE", "the licence, without its trailing newline");
  assert.equal(decode(r.applied, "ANTHROPIC_API_KEY"), "sk-ant-api03-THE-TENANTS-OWN-KEY");
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), "the token is not printed unless asked for");
  assert.match(r.stdout, /kubectl -n mesh-acme get secret mesh-credentials/, "but how to read it is");

  assert.ok(r.calls.some((c) => c === "kubectl label namespace mesh-acme pod-security.kubernetes.io/enforce=restricted --overwrite"));
  const helm = r.calls.find((c) => c.startsWith("helm upgrade --install"))!;
  assert.match(helm, /^helm upgrade --install mesh .*deploy\/helm\/ordane --namespace mesh-acme /);
  for (const part of ["--set auth.existingSecret=mesh-credentials", "--set ingress.enabled=true", "--set ingress.host=mesh.acme.example.com", "--set ingress.tlsSecretName=mesh-tls", "--set ingress.className=nginx", "--wait"]) {
    assert.ok(helm.includes(part), `${part} in: ${helm}`);
  }
});

test("run again for the same tenant it upgrades in place and keeps the operator token", () => {
  const existing = "e".repeat(64);
  const f = fixture(existing);
  const r = run(f, ["--name", "acme", "--host", "mesh.acme.example.com", "--print-token"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(decode(r.applied, "MESH_API_TOKEN"), existing, "an upgrade must not sign every operator out");
  assert.equal(r.stdout.trim().split("\n").pop(), existing, "--print-token prints it");
  assert.equal(decode(r.applied, "MESH_LICENSE"), undefined, "no licence given: the Community plan, and nothing else in the Secret");

  const rotated = run(fixture(existing), ["--name", "acme", "--host", "mesh.acme.example.com", "--rotate-token"]);
  assert.notEqual(decode(rotated.applied, "MESH_API_TOKEN"), existing);
  assert.match(decode(rotated.applied, "MESH_API_TOKEN")!, /^[0-9a-f]{64}$/);
});

test("a name or host that would not make a valid namespace or ingress is refused before anything runs", () => {
  const f = fixture();
  const cases: Array<[string[], RegExp]> = [
    [["--host", "h.example.com"], /--name is required/],
    [["--name", "acme"], /--host is required/],
    [["--name", "Acme", "--host", "h.example.com"], /--name must be lowercase/],
    [["--name", "-acme", "--host", "h.example.com"], /--name must be lowercase/],
    [["--name", "acme-", "--host", "h.example.com"], /--name must be lowercase/],
    [["--name", "a".repeat(41), "--host", "h.example.com"], /longer than 40/],
    [["--name", "acme", "--host", "https://h.example.com"], /--host must be a plain host name/],
    [["--name", "acme", "--host", "h.example.com:8443"], /--host must be a plain host name/],
    [["--name", "acme", "--host", "h.example.com", "--licence-file", "/nonexistent/lic"], /no such file/],
    [["--name", "acme", "--host", "h.example.com", "--chart", "oci://ghcr.io/x/charts/ordane"], /--version is required for an oci:\/\/ chart/],
    [["--name", "acme", "--host", "h.example.com", "--frobnicate"], /unknown option '--frobnicate'/],
  ];
  for (const [args, message] of cases) {
    const r = run(f, args);
    assert.equal(r.status, 2, args.join(" "));
    assert.match(r.stderr, message, args.join(" "));
  }
  assert.deepEqual(run(f, ["--name", "a b", "--host", "h"]).calls, [], "nothing was run");
});

test("--dry-run changes nothing: it renders the chart and applies no namespace, Secret or release", () => {
  const f = fixture();
  const r = run(f, ["--name", "acme", "--host", "mesh.acme.example.com", "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => / apply /.test(c) || c.startsWith("helm upgrade")), r.calls.join("\n"));
  assert.ok(r.calls.some((c) => c.startsWith("helm template mesh ")), "the chart is rendered with the tenant's values");
  assert.match(r.stdout, /keys: MESH_API_TOKEN/);
  assert.equal(r.applied, "");
});

test("a chart from a registry needs its version, and a version and extra values reach Helm", () => {
  const f = fixture();
  const values = path.join(f.dir, "values-acme.yaml");
  fs.writeFileSync(values, "persistence: { size: 50Gi }\n");
  const r = run(f, ["--name", "acme", "--host", "h.example.com", "--chart", "oci://ghcr.io/example/charts/ordane", "--version", "1.2.3", "--values", values, "--release", "prod"]);
  assert.equal(r.status, 0, r.stderr);
  const helm = r.calls.find((c) => c.startsWith("helm upgrade"))!;
  assert.match(helm, /^helm upgrade --install prod oci:\/\/ghcr\.io\/example\/charts\/ordane /);
  assert.ok(helm.includes("--version 1.2.3"));
  assert.ok(helm.includes(`--values ${values}`));
  assert.ok(helm.includes("--set ingress.tlsSecretName=prod-tls"), "the TLS Secret follows the release name");
});
