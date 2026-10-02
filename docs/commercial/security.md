# Security

What Ordane protects, how, what it does not, and what a deployer should do about the rest. Written for a
security reviewer and for the person answering a security questionnaire; the pre-filled answers are in
[security-questionnaire.md](security-questionnaire.md). To report a vulnerability see
[SECURITY.md](../../SECURITY.md).

Every control below is pinned by a test named in the right-hand column. `npm test` runs them.

## The model in one page

Ordane runs AI agents that **execute shell commands and write code**. That is the product, and it sets the
security posture: the agents are not trusted to stay inside a box that the software merely asks them to stay in.
The box is the **container** (or pod), and the unit of isolation is **one instance per tenant**.

| Boundary | Who is on each side | Held by |
|---|---|---|
| Network ↔ host | browsers, scripts, the CLI ↔ the host process | the operator token, the Host and Origin checks, the listen policy |
| Host ↔ project | the host ↔ one child process per open project | a per-child token the browser never sees; the child listens on loopback only |
| Project ↔ agent | the mesh's kernel ↔ an agent's tools and shell | a per-agent credential minted in memory for each turn; the agents' environment is scrubbed of the operator's secrets |
| Instance ↔ world | the container ↔ everything else | the container's privileges, the network policy, what you put in its environment |

Inside one instance, projects are **not isolated from each other**: they share the container, its user and its
volume. Anyone who must not see another's work gets their own instance.

## What leaves the instance

- **Calls to your model provider**, made by the agents with your credentials. Prompts, files and tool output go
  to that provider under your agreement with it. This is inherent to running the agents.
- **Nothing else from the product.** There is no telemetry, no analytics, no update check and no licence server.
  The licence is verified on the machine. The runtime's only network calls are to its own components and to a
  configured agent endpoint if you use the HTTP runtime.
- **The Claude Code binary** the agents run is Anthropic's, and left alone it reports telemetry and errors and
  checks for updates. The image sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (Anthropic's documented switch
  for that class of traffic) and keeps it through `isolate_host`. Setting it to an empty value turns that off.
- Whatever the **agents themselves fetch**: package registries, git hosts, the web, if the network lets them.

## Controls

### Reaching the server

| Control | Behaviour | Pinned by |
|---|---|---|
| Listen policy | Listening on anything but loopback **requires** `MESH_API_TOKEN` of at least 32 characters. Unset, blank or short is a refusal at start (exit 78), not a warning. `MESH_ALLOW_INSECURE_BIND=1` is the one explicit door, and says so on stderr. | `tests/cli/network-bind.test.ts`, `tests/server/web-security.test.ts` |
| Sign-in | The dashboard trades the operator token for a session cookie: `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS, held in the host's memory. The token is never accepted in a URL (query strings land in logs, history and `Referer`). | `tests/server/sessions.test.ts`, `tests/server/sign-in.test.ts` |
| Brute force | Wrong credentials are counted per client address and answered with 429 and `Retry-After`. A 32+ character random token is the real defence. | `tests/server/sign-in.test.ts` |
| DNS rebinding | The `Host` header must be one the server answers to: on a loopback connection only loopback names (and `MESH_ALLOWED_HOSTS`), so a page on another site that rebinds to `127.0.0.1` is refused (421). | `tests/server/web-security.test.ts` |
| Cross-site forgery | A state-changing request from a page must be same-origin or from `MESH_ALLOWED_ORIGINS`; a cross-site one is refused (403) even with valid credentials, because the browser would attach them itself. | `tests/server/web-security.test.ts`, `tests/server/host-web-surface.test.ts` |
| No CORS | No response ever carries `Access-Control-Allow-Origin`: not JSON, not an error, not the event stream. | `tests/server/web-surface.test.ts` |
| Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store` on the API; a Content-Security-Policy of `default-src 'self'` on the dashboard with its one inline script admitted by hash. | `tests/server/web-surface.test.ts` |
| Probes | `/healthz` and `/readyz` answer one word with no credential and reveal nothing. The detailed `/health` needs the token. | `tests/server/web-surface.test.ts`, `tests/server/host-web-surface.test.ts` |
| Resource caps | Request bodies (1 MiB), event-stream subscribers (256) and the designer's model calls and chat sessions are bounded, and a subscriber that stops reading is cut off. | `tests/server/resource-caps.test.ts` |

### Agents' pages and files

| Control | Behaviour | Pinned by |
|---|---|---|
| Playground sandbox | A web page an agent wrote is served inside a sandboxed frame on an opaque origin, through a signed link that expires, with no cookie and no route back to the API. Also checked in real Chromium. | `tests/server/sign-in.test.ts`, `tests/server/web-security.test.ts` |
| Path containment | Files read for previews and the playground are resolved through their real paths: a link in the workspace cannot point out of it. | `tests/server/workspace-links.test.ts` |
| Projects root | `MESH_PROJECTS_ROOT` confines the registry and the folder browser: the API cannot be pointed at the registry home, a licence, or another tenant's workspace. | `tests/server/host-confine.test.ts` |
| Prototype pollution | JSON bodies cannot set `__proto__`, `constructor` or `prototype` keys. (A real one was found: a budget key of `__proto__` polluted every object in the process.) | `tests/server/proto-safety.test.ts` |

### Agents themselves

| Control | Behaviour | Pinned by |
|---|---|---|
| No operator token | The operator token, the licence and the other `MESH_*` secrets are removed from the environment agents' commands run in, with or without `isolate_host`. The agents never hold an operator credential. | `tests/agent-runtime/host-isolation.test.ts` |
| Per-agent credentials | An agent reaches the mesh's tools with a credential minted from a key that exists only in memory and dies with the process. | `tests/server/auth-surface.test.ts` |
| Staging is human-only | The tools that stage changes to the mission itself (its goal, criteria, seats, budgets) answer only to the human operator, not to an agent that is asked to call them. | `tests/server/auth-surface.test.ts` |
| Children are not exposed | A project's child process listens on loopback, accepts only its own per-child token, and strips the browser's cookie and origin on the way in. | `tests/projects/spawn.test.ts`, `tests/server/host-web-surface.test.ts` |
| Budgets and the ceiling | Per-agent, per-thread and mission token budgets, and a host-wide spend ceiling that prices all four token classes. | `tests/protocol/pricing.test.ts`, `tests/server/host-resources.test.ts` |

### Records and recovery

| Control | Behaviour | Pinned by |
|---|---|---|
| Event-sourced state | Every change is an appended event; every view is a projection. Nothing is edited in place, and any past moment can be replayed. | the kernel's own suites |
| Audit trail | Every state-changing request that was let through is logged once, with how it was authorised and the client address: `<state>/logs/mutations.log` and `auth-audit.log` for a mesh, and `[mesh-host-audit]` lines on the host's stderr. Log injection (newlines, control characters) is neutralised. | `tests/server/audit.test.ts` |
| One writer | Each state directory has a lock with a heartbeat. A replacement pod takes over its predecessor's lock at once, another instance's only after it has gone silent, and a process that loses its lock exits (code 70) rather than interleave two writers. | `tests/event-store/state-lock-pods.test.ts`, `tests/persistence/process-identity.test.ts` |

### The build and the container

| Control | Behaviour |
|---|---|
| Image | Unprivileged user (uid 10001), read-only root file system, all capabilities dropped, `no-new-privileges`, `tini` as PID 1, one writable volume, no credentials baked in. |
| Chart | One replica with the `Recreate` strategy, a default-on network policy (ingress from the ingress controller only; egress to DNS and to public HTTPS, excluding private ranges and the cloud metadata address), no service-account token mounted, `RuntimeDefault` seccomp. |
| Supply chain | Lockfile and `npm ci`; **0 known advisories in production dependencies** (`npm audit --omit=dev`, 2026-10-01); a weekly audit and CodeQL scan in CI; Dependabot for npm, Actions and Docker; releases are multi-architecture, carry an SBOM and build provenance, and are signed with a keyless signature over the image digest. |
| Licences | 115 production packages, every one permissive except Anthropic's SDK, which is installed unmodified and is not covered by this product's licence ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)). |

## What it does not do

Read this section before you promise anything to a customer.

- **One shared credential.** There is a single operator token. There are no per-user identities, no roles, and no
  single sign-on, so the audit trail says *how* a request was authorised and *from where*, never *who*. This is
  on the roadmap (OIDC, per-operator identity and roles, audit export with identity) and is not sold as included.
  Until then, restrict the network path (VPN, private ingress, IP allow-list) and put an authenticating proxy in
  front if you need to know who reached the sign-in page.
- **The agents can use what the container can reach.** An agent's shell runs as an unprivileged user inside the
  container, with the provider credential in its environment (it needs it) and whatever network egress you
  allow. A prompt-injected or misbehaving agent can read the workspace, read that credential and send things to
  anywhere egress allows. The container is the boundary; **narrow the egress, give each instance its own
  provider key with a spend limit set at the provider, and keep secrets you would not give an engineer out of the
  workspace.** The Helm chart's network policy does the first by default; the others are yours.
- **No isolation between projects in one instance.** One instance, one trust level.
- **TLS is the deployer's.** Terminate it at an ingress or a proxy. The server speaks plain HTTP and expects to be
  told (`MESH_TRUST_PROXY`, `MESH_COOKIE_SECURE`) when it is behind one.
- **No encryption at rest** of its own. Use an encrypted volume and encrypted backups.
- **The event log holds everything the agents saw and said**, including any secret that passed through a prompt
  or a command's output. There is no redaction. Treat the volume, and every backup of it, as sensitive as the
  most sensitive thing you let an agent read.
- **Not independently assessed.** No third-party penetration test, no SOC 2, no ISO 27001. The controls above
  are tested by the repository's own suite and were exercised in a real browser; that is not an audit.
- **Licence checks are not tamper-proof.** See [licensing.md](licensing.md).

## A hardening checklist for the deployer

1. **TLS in front**, HSTS at the proxy. Set `MESH_COOKIE_SECURE=1`, `MESH_TRUST_PROXY=1` and
   `MESH_ALLOWED_HOSTS=<your host name>` (the chart does all three from `ingress.host`).
2. **A strong token from a secret store**, 32+ random characters, rotated on a schedule and when anyone who knew it
   leaves.
3. **Do not put it on the open internet.** Reach it over a VPN or a private ingress.
4. **Narrow the egress** to the model provider, your git host and your package mirror. Keep the network policy on.
5. **A dedicated provider key per instance**, with a budget and alerts at the provider. The host's spend ceiling
   (default $50) is a backstop, not the control.
6. **Encrypt the volume and its backups**, and restrict who can read them.
7. **Ship the audit trail**: the host's `[mesh-host-audit]` stderr lines and each project's `logs/mutations.log`
   and `auth-audit.log`, to a log store you retain.
8. **Pin the image by digest**, verify the signature (`cosign verify`), and subscribe to advisories for the repository.
9. **Watch the metrics** ([operations.md](../operations.md#metrics)): crashed projects, spend against the ceiling,
   escalations waiting for a person.
10. **Plan for the agents being wrong.** Review what they merge before it ships. The mesh has gates for that, and a
    gate somebody configured is the control; the agents' good behaviour is not.
