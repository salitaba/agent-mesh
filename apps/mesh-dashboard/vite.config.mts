import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

// Static SPA build served by the mesh server itself (same port, no second
// process). `npm run build:ui` emits apps/mesh-dashboard/dist.
const API_ROOTS = [
  "status", "metrics", "steps", "turns", "scheduler", "activity", "events",
  "graph", "timeline", "agents", "threads", "messages", "artifacts", "budgets",
  "approvals", "escalations", "mission", "goals", "config", "internal", "health",
];

// Dev proxy target: override with MESH_BUS_URL (e.g. when your mesh runs on a
// non-default port). Falls back to the default `mesh console` port 7421.
const proxyTarget =
  process.env.MESH_BUS_URL ?? `http://127.0.0.1:${process.env.MESH_PORT ?? "7421"}`;

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
