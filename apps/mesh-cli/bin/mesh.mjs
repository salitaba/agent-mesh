#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(__dirname, "..", "..", "..", "dist", "apps", "mesh-cli", "src", "index.js");

const { main } = await import(entry);
const code = await main(process.argv.slice(2));
process.exit(code);
