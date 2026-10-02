# Security questionnaire: answers

The answers to the questions a buyer's security team usually asks, written from what the product does and what
the repository's tests pin. They are meant to be sent as they are. Where the answer is "no", it says no.

Details, and the tests that pin each control, are in [security.md](security.md). Settings are in
[../operations.md](../operations.md). Last reviewed against version 0.1.0.

## About the vendor and the assurance behind the product

| Question | Answer |
|---|---|
| Do you hold SOC 2, ISO 27001 or a similar certification? | **No.** |
| Has the product had an independent penetration test? | **No.** The controls are tested by the repository's own suite, and the web surface was exercised in a real browser. That is not an audit. |
| Do you have a vulnerability disclosure policy? | **Yes**: [SECURITY.md](../../SECURITY.md), with acknowledgement and fix targets. |
| How is the code checked before release? | CI runs the type checker, the linter and the full test suite on every change. A weekly scheduled job runs a production-dependency audit and CodeQL. Dependabot proposes updates for npm packages, GitHub Actions and the base image. |
| Is there a software bill of materials? | **Yes.** Each published image carries an SBOM and build provenance, and is signed (keyless, `cosign verify`). The inventory of third-party packages and their licences is [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md). |
| Known vulnerabilities in dependencies? | `npm audit --omit=dev` reported 0 on 2026-10-01. |

## Data

| Question | Answer |
|---|---|
| Where is our data stored? | Only in your environment: on the volume you give the instance. The event log, artifacts, workspaces and the agents' sessions are all there. |
| Does the vendor have access to it? | **No.** The software runs on your infrastructure, has no telemetry, no analytics and no licence server, and sends nothing to the vendor. |
| Which third parties process our data? | **For the product: none.** The agents call the model provider you configured, with your credentials and under your agreement with it. That provider is your processor, not ours. |
| Is data encrypted at rest? | **Not by the product.** Use an encrypted volume and encrypted backups. |
| Is data encrypted in transit? | Between the browser or CLI and the server: TLS, terminated at your ingress or reverse proxy (the server speaks HTTP behind it). Between the host and its project processes: plain HTTP on loopback inside the container. |
| What does it log, and could secrets be in the logs? | The event log records everything the agents saw and said, including any secret that passed through a prompt or a command's output; there is no redaction. Treat the volume and its backups as sensitive as the most sensitive thing an agent may read. The audit logs record requests (method, path, how authorised, client address), not bodies. |
| Retention and deletion? | You control both. Nothing is held by the vendor. Deleting a project's folder deletes its log and artifacts; a volume snapshot is a copy you manage. |
| Data residency? | Wherever you run it. Model calls go to the provider's region you choose. |

## Access and identity

| Question | Answer |
|---|---|
| How are users authenticated? | One **operator token** of 32 or more random characters, entered at the dashboard's sign-in (which trades it for an `HttpOnly`, `SameSite=Strict` session cookie, `Secure` over HTTPS) or sent as a bearer token by the CLI and scripts. The server refuses to listen on a network address without one. |
| Single sign-on? Multi-factor? | **No.** Both are on the roadmap (OIDC, per-operator identity and roles) and are not sold as included. Meanwhile, restrict the network path (VPN, private ingress, an authenticating proxy in front). |
| Role-based access control? | **No.** There is one operator role. |
| Is there an audit trail? | **Yes, without identity.** Every state-changing request is logged with how it was authorised (token, session or open) and the client address; sign-in events are logged. With one shared credential it cannot say *who*. |
| Brute-force protection? | Wrong credentials are counted per client address and answered with 429 and `Retry-After`. The real defence is the token's length. |
| Do the agents hold the operator's credentials? | **No.** The operator token, the licence and the other `MESH_*` secrets are removed from the environment the agents' commands run in. The agents hold a per-agent credential minted in memory for each turn, and the model provider key you gave them. |

## Application security

| Question | Answer |
|---|---|
| CSRF, DNS rebinding, clickjacking, MIME sniffing? | A state-changing request from a page must be same-origin or from an origin you list; the `Host` header must be one the server answers to; responses carry `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer` and `Cache-Control: no-store`; the dashboard has a Content-Security-Policy of `default-src 'self'`. |
| CORS? | No response ever carries `Access-Control-Allow-Origin`. |
| Is input validated? | Configuration, messages and events are validated against JSON schemas (Ajv). Request bodies are bounded (1 MiB by default). JSON keys that would pollute prototypes are refused. |
| How is agent-written web content handled? | Served in a sandboxed frame on an opaque origin through a signed, expiring link, with no cookie and no route back to the API. |
| File system access through the API? | Confined to the projects directory you set; paths are resolved through their real locations so a link cannot point out of it. |
| Rate and resource limits? | Bodies, event-stream subscribers and the designer's model calls are capped; a subscriber that stops reading is disconnected. |
| Secrets in the repository or image? | None. The image holds no credentials; they are supplied at run time. The licence signing key is not in the repository. |

## Infrastructure (yours, with the product's defaults)

| Question | Answer |
|---|---|
| How is the container hardened? | Unprivileged user (uid 10001), read-only root file system, all capabilities dropped, `no-new-privileges`, `tini` as PID 1, one writable volume. |
| And on Kubernetes? | One replica with `Recreate`; a restricted pod (non-root, default seccomp, no privilege escalation, no service-account token); a network policy on by default that allows ingress only from your ingress controller and egress only to DNS and public HTTPS (private ranges and the cloud metadata address excluded). |
| Isolation between our teams? | **One instance per team.** Inside an instance, projects share the container, its user and its volume and are not isolated from each other. |
| What can an agent reach? | What the container can: its workspace, the model provider key in its environment, and whatever egress you allow. Narrow the egress and give each instance its own provider key with a spend limit set at the provider. |
| Backups and recovery? | A volume snapshot is enough ([operations.md](../operations.md#back-up-and-restore)). The state is an append-only log that is replayed on start. There is no high-availability mode: one writer per instance. |
| Monitoring? | Liveness and readiness probes, and a Prometheus endpoint for the host and each project (Team plan and above). |

## About the AI

| Question | Answer |
|---|---|
| Which models does it use, and who controls them? | The ones you configure, through your own provider account (Anthropic directly, or Amazon Bedrock, Google Cloud or Microsoft Foundry). The vendor does not sit between you and the model. |
| Is our data used to train a model? | The vendor never receives it. Whether your provider trains on it is governed by your agreement with them; check it. |
| Can the agents be manipulated by what they read (prompt injection)? | **Yes, like any agent that reads untrusted text and can act.** The mitigations are structural, not a guarantee: the container and its egress limits bound what an agent can do; the mesh's gates, approvals and escalations put a person or another agent's review in front of a change; budgets and the spend ceiling bound what a runaway can cost. |
| Is there human oversight? | Missions have acceptance criteria, review gates and escalations to a person; the operator can park everything at any time. What you configure as a gate is the control; the agents' good behaviour is not. |
| How reliable are the results? | Measured on one mission class (a small library built by five agents, reopened once against an independent oracle): 99.6% of 3,034 checks passed on the final product. One run is an illustration, not a guarantee, and the product makes no warranty of output quality. |

## Legal

| Question | Answer |
|---|---|
| What licence terms apply? | The Business Source License 1.1 ([LICENSE](../../LICENSE)) for the source and for production use within the Community plan; a commercial licence agreement for the paid plans ([licensing.md](licensing.md#the-source-licence)); and for the model provider your own agreement with them. Anthropic's SDK, which the agents run, is under Anthropic's terms ([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)). |
| Does the vendor resell model usage? | **No.** You bring your own credentials and are billed by your provider ([pricing.md](pricing.md)). |
| Do you need a data processing agreement? | Only if the vendor is given access to personal data, for example to debug on your instance. By default it is not. |
