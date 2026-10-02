# Agent Mesh for buyers and operators

Agent Mesh is a runtime for persistent AI organizations: role-based agents (a product manager, an architect,
developers, QA, security) that work toward a mission through explicit authority, communication contracts and an
event-sourced record of everything they do. You run it on your own infrastructure with your own model
credentials.

| If you want to… | Read |
|---|---|
| see what it costs and why | [pricing.md](pricing.md) |
| try it, install it on a server or a cluster, run many instances | [deployment.md](deployment.md) |
| run it: settings, upgrade, backup, monitoring, what a refusal means | [../operations.md](../operations.md) |
| understand what it protects and what it does not | [security.md](security.md) |
| answer a security questionnaire | [security-questionnaire.md](security-questionnaire.md) |
| report a vulnerability | [../../SECURITY.md](../../SECURITY.md) |
| understand licences, plan limits and enforcement | [licensing.md](licensing.md) |
| see what third-party software ships | [../../THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) |

The architecture, protocol and configuration references are in the other files of [docs/](..).

## The short version

- **Self-hosted.** One container (or pod) per tenant. Nothing phones home: no telemetry, no licence server.
- **Your model credentials.** Anthropic, Amazon Bedrock, Google Cloud or Microsoft Foundry, billed to you by
  the provider. The plans are for the runtime only.
- **Free to start.** The Community plan (one open project, eight agents) needs no licence and never expires.
- **Source-available.** The code is public under the Business Source License 1.1 ([LICENSE](../../LICENSE)): free to
  read and run, free for production within the Community plan, a commercial licence beyond it
  ([licensing.md](licensing.md#the-source-licence)).
- **Built to be audited.** Every action is an appended event; any moment can be replayed; budgets and a spend
  ceiling bound what a run can cost; changes pass gates you configure.
- **Honest about its limits.** One shared operator credential today (no SSO or roles yet), and the agents can use
  what their container can reach. [security.md](security.md) says what to do about both.
