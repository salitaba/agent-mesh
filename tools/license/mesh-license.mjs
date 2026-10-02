#!/usr/bin/env node
/**
 * Vendor-side licence tool. Issues and inspects Ordane licences.
 *
 *   node tools/license/mesh-license.mjs keygen  --kid k1 --out ~/secrets/mesh-license-k1.pem
 *   node tools/license/mesh-license.mjs sign    --key ~/secrets/mesh-license-k1.pem --kid k1 \
 *        --customer "Acme Robotics" --plan team --days 365 [--grace 14] [--id lic_0042] \
 *        [--max-seats N|unlimited] [--max-projects N|unlimited] [--max-turns N|unlimited] \
 *        [--feature usage-export ...] [--notes "pilot"]
 *   node tools/license/mesh-license.mjs inspect <token|file>     (reads the claims; does NOT check the signature)
 *   node tools/license/mesh-license.mjs verify  <token|file> --public <base64url-spki>  [--kid k1]
 *
 * Run `npm run build` first: this imports the compiled licensing package, so what it signs is
 * exactly what the product verifies. The PRIVATE key never leaves the vendor: it is not in the
 * repository, the image or the package, and this tool refuses to write it anywhere readable by
 * others.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const lic = (() => {
  try {
    return require(path.resolve(here, "..", "..", "dist", "packages", "licensing", "src", "index.js"));
  } catch (err) {
    console.error("could not load the compiled licensing package. Run `npm run build` first.\n" + String(err && err.message ? err.message : err));
    process.exit(2);
  }
})();

function parseArgs(argv) {
  const out = { _: [], feature: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : (i += 1, next);
    if (key === "feature") out.feature.push(String(value));
    else out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [command, ...rest] = args._;

function die(message, code = 2) {
  console.error(`error: ${message}`);
  process.exit(code);
}

const limitFrom = (raw, name) => {
  if (raw === undefined) return undefined;
  if (String(raw).toLowerCase() === "unlimited") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) die(`--${name} must be a whole number or 'unlimited'`);
  return n;
};

const tokenFrom = (arg) => {
  if (!arg) die("give a licence token or a file that holds one");
  return fs.existsSync(arg) ? fs.readFileSync(arg, "utf8").trim() : String(arg).trim();
};

function homeDir(p) {
  return p.startsWith("~") ? path.join(process.env.HOME ?? "", p.slice(1)) : p;
}

switch (command) {
  case "keygen": {
    const kid = String(args.kid ?? "");
    if (!kid) die("--kid is required (for example k1)");
    const out = args.out ? path.resolve(homeDir(String(args.out))) : undefined;
    if (!out) die("--out <file> is required: where to write the private key");
    if (fs.existsSync(out)) die(`${out} already exists; refusing to overwrite a private key`);
    const { privateKeyPem, publicKey } = lic.generateLicenseKeyPair();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, privateKeyPem, { mode: 0o600, flag: "wx" });
    console.log(`private key written to ${out} (mode 600). Keep it secret; back it up; never commit it.`);
    console.log("");
    console.log("Add this public key to packages/licensing/src/keys.ts and rebuild:");
    console.log("");
    console.log(`  export const LICENSE_PUBLIC_KEYS: PublicKeySet = { ${kid}: "${publicKey}" };`);
    break;
  }
  case "sign": {
    const keyFile = args.key ? path.resolve(homeDir(String(args.key))) : undefined;
    if (!keyFile) die("--key <private key file> is required");
    if (!fs.existsSync(keyFile)) die(`${keyFile} does not exist`);
    const mode = fs.statSync(keyFile).mode & 0o077;
    if (mode !== 0) die(`${keyFile} is readable by others (mode ${(fs.statSync(keyFile).mode & 0o777).toString(8)}); run chmod 600 on it first`);
    const kid = String(args.kid ?? "");
    if (!kid) die("--kid is required");
    const customer = String(args.customer ?? "").trim();
    if (!customer) die("--customer is required");
    const plan = String(args.plan ?? "");
    if (!lic.isPlanId(plan)) die(`--plan must be one of ${lic.PLAN_IDS.join(", ")}`);
    const days = Number(args.days ?? 365);
    if (!Number.isFinite(days) || days <= 0) die("--days must be a positive number");
    const issued = new Date();
    const claims = {
      v: 1,
      id: String(args.id ?? `lic_${issued.toISOString().slice(0, 10).replace(/-/g, "")}_${Math.random().toString(36).slice(2, 8)}`),
      customer,
      plan,
      issuedAt: issued.toISOString(),
      expiresAt: new Date(issued.getTime() + days * 86_400_000).toISOString(),
    };
    if (args.grace !== undefined) claims.graceDays = Number(args.grace);
    const limits = {};
    for (const [flag, name] of [["max-seats", "maxSeatsPerMesh"], ["max-projects", "maxProjects"], ["max-turns", "maxConcurrentTurns"]]) {
      const v = limitFrom(args[flag], flag);
      if (v !== undefined) limits[name] = v;
    }
    if (Object.keys(limits).length) claims.limits = limits;
    if (args.feature.length) claims.features = args.feature;
    if (typeof args.notes === "string") claims.notes = args.notes;
    let token;
    try {
      token = lic.signLicense(claims, kid, fs.readFileSync(keyFile, "utf8"));
    } catch (err) {
      die(String(err && err.message ? err.message : err));
    }
    console.error(`licence ${claims.id} for ${customer}: ${plan}, valid until ${claims.expiresAt.slice(0, 10)}`);
    console.log(token);
    break;
  }
  case "inspect": {
    const token = tokenFrom(rest[0]);
    const parts = token.split(".");
    if (parts.length !== 4) die("not a licence: expected AML1.<kid>.<payload>.<signature>");
    try {
      const claims = JSON.parse(Buffer.from(parts[2], "base64url").toString("utf8"));
      console.log(JSON.stringify({ kid: parts[1], ...claims }, null, 2));
      console.error("(claims read as written; the signature was NOT checked. Use `verify` for that.)");
    } catch {
      die("the payload is not JSON");
    }
    break;
  }
  case "verify": {
    const token = tokenFrom(rest[0]);
    const publicKey = String(args.public ?? "");
    if (!publicKey) die("--public <base64url SPKI public key> is required");
    const kid = String(args.kid ?? token.split(".")[1] ?? "");
    const result = lic.verifyLicense(token, { [kid]: publicKey });
    if (!result.ok) die(`${result.reason}: ${result.detail}`, 1);
    const ent = lic.resolveEntitlements({ token, publicKeys: { [kid]: publicKey }, enforcement: "enforce" });
    console.log(`valid signature (key ${result.kid}).`);
    console.log(ent.summary);
    for (const w of ent.warnings) console.log(`warning: ${w}`);
    break;
  }
  default:
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(2, 20).map((l) => l.replace(/^ ?\* ?/, "")).join("\n"));
    process.exit(command ? 2 : 0);
}
