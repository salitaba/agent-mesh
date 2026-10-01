# Changelog

What changed between versions, for whoever runs Agent Mesh. The format follows [Keep a Changelog](https://keepachangelog.com).
There is no supported downgrade: the event log is append-only and a newer build may append events an older one does
not know ([docs/operations.md](docs/operations.md#upgrade)). The fixes from the live Haiku runs (`NOTES-live-run-20260930-haiku.md`,
sections 1 to 12) are described there, run by run.

## Unreleased

### Changed: read this before upgrading a deployment

- **The server fails closed on the network.** It refuses to listen on any address but loopback unless
  `MESH_API_TOKEN` is set to 32 or more characters (`openssl rand -hex 32`). A blank token on a network address is a
  refusal, not "no authentication". `MESH_ALLOW_INSECURE_BIND=1` overrides it, loudly, for a server whose only way in is a
  proxy that authenticates every request. `mesh run|serve|console` take `--bind` (default loopback).
- **Browser requests are checked.** State-changing requests must be JSON and same-origin (`Origin`, `Sec-Fetch-Site`;
  more origins through `MESH_ALLOWED_ORIGINS`). The wildcard CORS header is gone. With `MESH_ALLOWED_HOSTS` set, any other
  `Host` is refused with 421. Responses carry a CSP, `nosniff` and frame protection; agent-written pages run in a sandbox.
- **Sign-in is a session.** The dashboard asks for the operator token once and keeps an `HttpOnly`, `SameSite=Strict`
  cookie (`MESH_COOKIE_SECURE=1` behind TLS). The token is no longer accepted in a URL.
- **`/health` needs the token.** Probes use `/healthz` (liveness) and `/readyz` (readiness, 503 while draining); both
  are open and answer with a one-word status.
- **Seats no longer inherit the operator's secrets.** The operator token, the licence and the other `MESH_*` secrets are
  removed from the environment the agents' commands run in. Provider credentials still reach them.
- **Projects are confined.** With `MESH_PROJECTS_ROOT` set (it is `/data/projects` in the image), a project can only be
  registered, browsed or opened under it.
- **The spend ceiling counts the whole bill.** It priced input and output tokens only, which left out about 80% of a
  measured run's bill (cache reads and writes). It now prices all four token classes at Anthropic's published list
  prices, or at your own `model_prices`.
- **The image keeps the Claude Code binary quiet.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` is set in the image
  (telemetry, error reports, update and feature-flag calls). Set it to an empty value to allow them.
- **Licence limits warn by default.** `MESH_LICENSE_ENFORCEMENT` is `warn`. `enforce` refuses to start what a plan does not
  allow; nothing ever stops a running mission or deletes data because a licence expired.

### Added

- **Licensing.** Offline Ed25519 licence keys (`AML1.…`) verified on the customer's machine with no call out; the plan table
  (Community, Team, Business, Enterprise) with its limits and entitlements; `mesh license status|install|verify|remove`;
  a licence card and an expiry banner in the dashboard; `tools/license/mesh-license.mjs` to generate and sign keys.
  See [docs/commercial/licensing.md](docs/commercial/licensing.md).
- **Usage and metrics.** `mesh usage` reports what the meshes consumed by day, project, seat and model from their own event
  logs, as a table, JSON or CSV, with a dollar estimate at list prices; `/metrics/prometheus` exposes projects, spend, turns
  and the licence. Both are Team-plan features.
- **Deployment.** A container image (unprivileged, read-only root, tini) with a keyless `demo` mode; a Compose file; a Helm
  chart (one replica, `Recreate`, network policy, restricted pod, probes); a fleet provisioning script that creates a namespace,
  a credentials Secret and a release per tenant; a release workflow that builds for amd64 and arm64, attaches an SBOM and
  provenance and signs the digest; CI and security workflows; Dependabot. See
  [docs/commercial/deployment.md](docs/commercial/deployment.md).
- **`mesh init`** can scaffold a mesh on the stub runtime (`--runtime stub`) or from a shipped example (`--example name`,
  `--list`).
- **Documents.** The operations runbook ([docs/operations.md](docs/operations.md)), deployment, pricing (its tables generated
  from the plan table), licensing, security and a security questionnaire under [docs/commercial/](docs/commercial/README.md),
  [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) generated from the lockfile.
- **A landing and pricing page** in [site/](site/README.md), with a plan-and-cost calculator whose numbers are generated.

### Fixed

- A replacement pod now takes over its predecessor's state lock at once (`MESH_INSTANCE_ID` is stable across restarts of one
  deployment); a different instance waits `MESH_LOCK_STALE_MS`. A host that loses the lock exits with status 70 instead of
  carrying on with two writers.
- The hosted demo project started with no scripted team and never moved; the host's demo mode now attaches it.
- Request bodies, live-stream subscribers and failed sign-ins are capped before authentication, so an unauthenticated client
  cannot exhaust memory.
- Paths served for previews are resolved through their real location, and object keys that could pollute prototypes are
  refused.
