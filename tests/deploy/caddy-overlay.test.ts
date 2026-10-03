/**
 * `docker-compose.caddy.yml` and `deploy/docker/Caddyfile` put Caddy in front of the host so that one command serves an instance
 * on a hostname over HTTPS. CI does not start Compose with a domain (it needs a public name and the internet), so what can
 * be pinned without a daemon is pinned here: what the overlay publishes, what it hands the proxy and what it must not, the four
 * settings that tell the host it is behind one, the proxy's closed box, and that the Caddyfile only uses values the overlay gives
 * it and sends the stream through unbuffered. The first start on a real server, with `scripts/smoke.sh url`, is the rest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

interface Service {
  image?: string;
  restart?: string;
  depends_on?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  read_only?: boolean;
  tmpfs?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  security_opt?: string[];
}
interface Compose {
  services: Record<string, Service>;
  volumes?: Record<string, unknown>;
}
const base = parseYaml(read("docker-compose.yml")) as Compose;
const overlay = parseYaml(read("docker-compose.caddy.yml")) as Compose;
const caddy = overlay.services["caddy"]!;
const mesh = overlay.services["mesh"]!;
const caddyfile = read("deploy/docker/Caddyfile");

test("the overlay publishes the web ports on the proxy and adds none to the host", () => {
  assert.deepEqual(caddy.ports, ["80:80", "443:443", "443:443/udp"], "http (to prove the certificate and redirect), https, and HTTP/3");
  assert.equal(mesh.ports, undefined, "Compose appends lists: a port here would be published beside the loopback one the base file sets");
  assert.deepEqual(Object.keys(overlay.services).sort(), ["caddy", "mesh"], "and nothing else is started");
});

test("the four settings that say the host is behind a proxy are set, and are the ones the base file passes through", () => {
  const env = mesh.environment!;
  assert.deepEqual(Object.keys(env).sort(), ["MESH_ALLOWED_HOSTS", "MESH_ALLOWED_ORIGINS", "MESH_COOKIE_SECURE", "MESH_TRUST_PROXY"]);
  for (const key of Object.keys(env)) assert.ok(key in base.services["mesh"]!.environment!, `${key} overrides a setting the base file passes through, it does not invent one`);
  // The server reads the two flags as exactly "1" (apps/mesh-server/src/sessions.ts, web-security.ts).
  assert.equal(env["MESH_TRUST_PROXY"], "1");
  assert.equal(env["MESH_COOKIE_SECURE"], "1");
  assert.equal(env["MESH_ALLOWED_ORIGINS"], "https://${CURULE_DOMAIN}");
  assert.match(env["MESH_ALLOWED_HOSTS"]!, /^\$\{CURULE_DOMAIN:\?[^}]+\},127\.0\.0\.1,localhost$/, "the hostname, and the loopback names so a tunnel to the loopback port still works");
});

test("the proxy is given its three values and never the host's token or the provider key", () => {
  assert.deepEqual(Object.keys(caddy.environment!).sort(), ["ACME_CA", "ACME_EMAIL", "CURULE_DOMAIN"]);
  assert.match(caddy.environment!["CURULE_DOMAIN"]!, /^\$\{CURULE_DOMAIN:\?[^}]+\}$/, "no hostname, no start");
  assert.match(caddy.environment!["ACME_EMAIL"]!, /^\$\{ACME_EMAIL:\?[^}]+\}$/, "no address for the certificate authority, no start");
  assert.equal(caddy.environment!["ACME_CA"], "${ACME_CA:-https://acme-v02.api.letsencrypt.org/directory}", "production by default; staging is one variable away");
  assert.ok(!/MESH_API_TOKEN|ANTHROPIC_API_KEY/.test(JSON.stringify(caddy)), "the one process on the internet holds neither");
});

test("the proxy runs in a closed box, with the one privilege it needs and its state on volumes", () => {
  assert.match(caddy.image!, /^caddy:2[.\-\w]*$/, "Caddy 2, from the official image");
  assert.equal(caddy.restart, "unless-stopped");
  assert.deepEqual(caddy.depends_on, ["mesh"]);
  assert.equal(caddy.read_only, true);
  assert.deepEqual(caddy.tmpfs, ["/tmp"]);
  assert.deepEqual(caddy.cap_drop, ["ALL"]);
  assert.deepEqual(caddy.cap_add, ["NET_BIND_SERVICE"], "to listen on 80 and 443, and nothing else");
  assert.deepEqual(caddy.security_opt, ["no-new-privileges:true"]);
  assert.deepEqual(caddy.volumes, ["./deploy/docker/Caddyfile:/etc/caddy/Caddyfile:ro", "caddy-data:/data", "caddy-config:/config"]);
  assert.deepEqual(Object.keys(overlay.volumes ?? {}).sort(), ["caddy-config", "caddy-data"], "the certificate and the account key survive a recreated container");
  assert.ok(fs.existsSync(path.join(ROOT, "deploy", "docker", "Caddyfile")), "and the file the first volume mounts exists");
});

test("the Caddyfile serves the hostname it is given, over HTTPS, to the host's service, with the stream unbuffered", () => {
  const code = caddyfile.replace(/^\s*#.*$/gm, "");
  assert.match(code, /^\{\n\s+email \{\$ACME_EMAIL\}\n\s+acme_ca \{\$ACME_CA\}\n\}$/m, "the account address and the authority come from the environment");
  assert.match(code, /^\{\$CURULE_DOMAIN\} \{$/m, "a bare hostname: Caddy then gets the certificate and redirects http to https");
  assert.match(code, /reverse_proxy mesh:7420 \{\s+flush_interval -1\s+\}/, "the console is a live event stream");
  assert.match(code, /header Strict-Transport-Security "max-age=31536000"\n/);
  assert.ok(!/includeSubDomains|preload/.test(code), "a decision about the whole domain is not this file's to make");
  assert.ok(!/auto_https|tls internal|http:\/\//.test(code), "nothing turns HTTPS off or serves a plain-HTTP site");
  const structure = code.replace(/\{\$[A-Z_]+\}/g, "");
  assert.equal((structure.match(/\{/g) ?? []).length, (structure.match(/\}/g) ?? []).length, "braces are balanced");
  // Every value the file reads is one the overlay hands the proxy, and the upstream is the service the base file defines.
  const used = [...code.matchAll(/\{\$([A-Z_]+)\}/g)].map((m) => m[1]!);
  assert.deepEqual([...new Set(used)].sort(), ["ACME_CA", "ACME_EMAIL", "CURULE_DOMAIN"]);
  for (const name of used) assert.ok(name in caddy.environment!, `${name} is passed to the proxy`);
  assert.ok("mesh" in base.services, "mesh is the service the proxy reaches");
  assert.match(read("Dockerfile"), /^EXPOSE 7420$/m, "on the port the image listens on");
});

test("the runbook gives the command, and the files and the variables it names are the ones the overlay uses", () => {
  const doc = read("docs/commercial/deployment.md");
  assert.match(doc, /docker compose -f docker-compose\.yml -f docker-compose\.caddy\.yml up -d/);
  assert.match(doc, /scripts\/smoke\.sh url "https:\/\/\$CURULE_DOMAIN" "\$MESH_API_TOKEN"/);
  for (const name of ["CURULE_DOMAIN", "ACME_EMAIL", "ACME_CA", "caddy-data"]) assert.ok(doc.includes(name), `the runbook says what ${name} is`);
  assert.match(doc, /acme-staging-v02\.api\.letsencrypt\.org\/directory/, "and how to rehearse without spending the real allowance");
  for (const file of ["docker-compose.caddy.yml", "deploy/docker/Caddyfile", "scripts/smoke.sh"]) assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  assert.match(read("docker-compose.caddy.yml"), /docker compose -f docker-compose\.yml -f docker-compose\.caddy\.yml up -d/, "the file's own header gives the same command");
});
