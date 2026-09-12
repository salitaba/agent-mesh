import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

// Static SPA build served by the mesh server itself (same port, no second
// process). `npm run build:ui` emits apps/mesh-dashboard/dist.
// `api` carries the whole multi-project surface (/api/projects, /api/browse,
// /api/p/:id/*, /api/events/stream). Without it the project tab bar and the
// folder picker 404 against Vite's own dev server instead of reaching the
// host, which looks exactly like a missing route on the server.
const API_ROOTS = [
  "api",
  "playground", "presets",
  "status", "metrics", "steps", "turns", "scheduler", "activity", "events",
  "graph", "timeline", "agents", "threads", "messages", "artifacts", "budgets",
  "approvals", "escalations", "mission", "goals", "config", "internal", "health",
];

// Dev proxy target: override with MESH_BUS_URL (e.g. when your mesh runs on a
// non-default port).
//
// Defaults to the multi-project host on 7420, not `mesh console` on 7421: the
// host serves every route console does (it proxies them straight through to
// the active project's child) *plus* /api/*, so pointing dev at the host is
// strictly more capable. Single-project dev still works — run
// `MESH_BUS_URL=http://127.0.0.1:7421 npm run dev:ui` against a console.
const proxyTarget =
  process.env.MESH_BUS_URL ?? `http://127.0.0.1:${process.env.MESH_PORT ?? "7420"}`;

export default defineConfig({
  root,
  plugins: [react()],
  // No public/ copying: the legacy static dir is gone; everything ships from src.
  publicDir: false,
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      API_ROOTS.map((r) => [`/${r}`, { target: proxyTarget, changeOrigin: true }]),
    ),
  },
});
