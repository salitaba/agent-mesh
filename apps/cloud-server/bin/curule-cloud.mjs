#!/usr/bin/env node
// The processes of the hosted service. Not installed as a command with the product: it is run from a checkout or an image,
// as `node apps/cloud-server/bin/curule-cloud.mjs gateway --config gateway.yaml`.
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "..", "..", "dist", "apps", "cloud-server", "src", "index.js");

const { main } = await import(entry);
const code = await main(process.argv.slice(2));
// A running service returns only when it has been told to stop; a command that finished has nothing left to wait for.
process.exit(code);
