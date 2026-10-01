# syntax=docker/dockerfile:1.7
#
# Agent Mesh — container image for the multi-project host (default) or a single mesh.
#
#   docker build -t agent-mesh .
#   docker run --rm -p 127.0.0.1:7420:7420 -v mesh-data:/data \
#     -e MESH_API_TOKEN="$(openssl rand -hex 32)" -e ANTHROPIC_API_KEY=sk-ant-... agent-mesh
#
# What is inside: the compiled runtime, the dashboard, the role prompts and the shipped examples; git
# (agents commit in worktrees); and the Claude Agent SDK's own `claude` executable, installed from npm
# unmodified, because that is how Anthropic's terms require it to run. The image holds no credentials:
# model access is the customer's own ANTHROPIC_API_KEY (or Bedrock / Vertex / Foundry credentials),
# supplied at run time and billed to them by the provider.
#
# Pin the base by digest in your registry's build (`--build-arg NODE_IMAGE=node:22-bookworm-slim@sha256:…`).

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- build
FROM ${NODE_IMAGE} AS build
WORKDIR /src

# Dependencies first: a source change must not re-download them. The workspace packages' manifests are
# needed for `npm ci` to link them, so `packages/` comes before the install.
COPY package.json package-lock.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.npm npm ci

COPY tsconfig.json ./
COPY apps ./apps
COPY schemas ./schemas
COPY roles ./roles
COPY examples ./examples
COPY scripts ./scripts

# Compile, then keep only what runs: no tests, no dev dependencies.
RUN npm run build \
 && rm -rf dist/tests \
 && npm prune --omit=dev

# -------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime

# git: agents work in worktrees and commit. tini: the host spawns one process per project and an agent's
# shell spawns more, so PID 1 must reap what its children leave behind. ca-certificates: TLS to the model
# provider. curl is for the health check only.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini curl \
 && rm -rf /var/lib/apt/lists/*

# Nothing here phones home, and the Claude Code binary the agents run does not either: it is told to make no
# nonessential network calls (telemetry, error reports, update checks, feature flags). What leaves the
# container is the agents' calls to the model provider, with the customer's own credentials. To let the binary
# report as it normally would, set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC to an empty value.

# A fixed, unprivileged identity. Everything that must survive a restart lives under /data: the registry
# and licence (MESH_HOME), each project's event log and workspace (/data/projects, which is also the only
# place the API may register or browse: MESH_PROJECTS_ROOT), and the agents' own CLI sessions (HOME),
# without which a restarted seat cannot resume its conversation.
ARG MESH_UID=10001
RUN useradd --uid ${MESH_UID} --user-group --home-dir /data/user --shell /bin/bash --no-create-home mesh \
 && mkdir -p /data/home /data/user /data/projects \
 && chown -R mesh:mesh /data

ENV NODE_ENV=production \
    MESH_HOME=/data/home \
    HOME=/data/user \
    MESH_PROJECTS_ROOT=/data/projects \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    MESH_PORT=7420 \
    MESH_BIND=0.0.0.0 \
    MESH_LICENSE_ENFORCEMENT=warn

WORKDIR /app
COPY --from=build /src/package.json ./package.json
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/apps/mesh-dashboard/dist ./apps/mesh-dashboard/dist
COPY --from=build /src/apps/mesh-cli/bin ./apps/mesh-cli/bin
COPY --from=build /src/roles ./roles
COPY --from=build /src/schemas ./schemas
COPY --from=build /src/examples ./examples
COPY deploy/docker/entrypoint.sh /usr/local/bin/mesh-entrypoint
RUN chmod 0755 /usr/local/bin/mesh-entrypoint /app/apps/mesh-cli/bin/mesh.mjs \
 && ln -s /app/apps/mesh-cli/bin/mesh.mjs /usr/local/bin/mesh

USER mesh
VOLUME ["/data"]
EXPOSE 7420

# Liveness only: `/healthz` answers from the event loop and reveals nothing. Readiness is `/readyz`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl --fail --silent --max-time 4 "http://127.0.0.1:${MESH_PORT}/healthz" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/mesh-entrypoint"]
CMD ["host"]
