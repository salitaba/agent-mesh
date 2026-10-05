# Curule Cloud: the hosted service

Curule Cloud is the runtime, run for you. A person signs up on the site, pays, and opens a workspace in the browser:
the same dashboard, the same agents, on servers the service operates and on models the service supplies. Nobody installs
anything, rents a server, or holds an API key.

It is the same product as the self-hosted one. The kernel, the policy engine and the dashboard are unchanged; what is
added is the part around them (accounts, payment, per-customer isolation, a model gateway) and one thing inside: a
runtime that is not tied to any single model vendor.

This document is the design and the status of each part. A part is listed as built only when its tests pass; what needs
a decision, an account or a credential from the operator of the service is stated as such, never assumed.

## Status

| Part | Where | State |
|---|---|---|
| Provider-neutral runtime, `native` | `packages/runtime-native` | built and tested; [runtime-native.md](runtime-native.md) |
| Model providers (OpenAI-compatible chat, Anthropic Messages) | `packages/llm` | built and tested against servers that speak each format; `curule providers check` proves a real provider |
| Model gateway: virtual keys, budgets, metering ledger, tiers with failover, admin API | `packages/ai-gateway`, `apps/cloud-server` | built and tested against servers that speak each wire format; [ai-gateway.md](ai-gateway.md) |
| Control plane: accounts, plans, credits, workspaces, and `curule-cloud control` to run them | `packages/cloud`, `apps/cloud-server` | built and tested, with a public API and an operator's API; [cloud-control-plane.md](cloud-control-plane.md) |
| Billing port with a hosted-checkout adapter and a manual adapter | `packages/cloud` | built and tested; the hosted-checkout adapter against servers that answer in the provider's documented shapes, not the live service |
| Workspace provisioner (local process for development, container for production) | `packages/cloud` | built and tested against a recording engine; no real container has been started |
| A workspace host that is given its models: a team made on it runs on the gateway, with no key from the person | `apps/mesh-server`, `packages/cloud` | built and tested; [runtime-native.md](runtime-native.md#hosted-workspaces) |
| Authenticating edge proxy for the dashboard and its event stream | `packages/cloud` | built and tested against a host that records what it is asked; each workspace is served at an address of its own |
| The whole service on one machine, with stand-ins for what costs money (`curule-cloud trial`) | `apps/cloud-server` | built; an end-to-end test runs it with a real host process for each workspace, [below](#try-it-on-one-machine) |
| `curule-cloud preflight`: what a configuration points at (gateway, engine, workspace network, folders, names, mail), as ok, warning or problem | `apps/cloud-server` | built and tested against stand-ins for the gateway, the engine and the name server, and its connection and listen probes on real sockets of this machine; not run against a real gateway, engine or name server; [cloud-control-plane.md](cloud-control-plane.md#running-it) |
| Mail over SMTP, queued on disk with retry, and `curule-cloud mail-check` | `packages/cloud`, `apps/cloud-server` | built and tested against a server that speaks SMTP, with TLS and STARTTLS over a real handshake; no mail provider has been used; [cloud-control-plane.md](cloud-control-plane.md#mail) |
| Sign up, sign in, billing and workspace pages | `apps/cloud-server/pages` | built and tested (the files, the script on a small DOM, and a pass in a real browser); the terms and the privacy notice are placeholders marked for the operator, and a production service is not started on them; [cloud-control-plane.md](cloud-control-plane.md#the-account-pages) |

## What a customer gets

1. A workspace: one isolated Curule host with its own state, projects and event log. The plan sets how many projects,
   seats per mesh and concurrent turns it allows, exactly as the self-hosted licence does, because the workspace runs
   with a signed licence minted for the plan.
2. Models, without keys. The workspace's agents call the service's gateway with a key that belongs to that workspace
   alone. The customer picks a tier (`fast`, `balanced`, `best`) or leaves the default; which provider and model serves a
   tier is the service's business and can change without the customer touching a setting. A customer who already holds
   terms with a model provider can bring that provider's key instead. The service keeps it as a secret of the workspace's
   host, never in an agent's shell, and does not resell that usage.
3. A balance, in money, not tokens. A plan period may include an amount of model usage, and more can be bought. The
   balance is debited what each call cost, which the customer can read in the usage report. When it reaches zero the
   gateway refuses new calls and the mesh pauses with one clear notice that says why. It does not fail seat by seat.
4. Their data. The workspace's event log, artifacts and git worktrees are exportable; deleting a workspace deletes them.

## What the mesh keeps guaranteeing

The guarantees of the runtime do not depend on where it runs or which model answers: every action is an appended event,
the policy engine refuses what a seat has no authority for on the op itself, budgets bound spend, and any moment can be
replayed. A hosted workspace gets the same log format as a local one, so a customer can leave with their record and
open it anywhere.

## Parts

### Provider-neutral runtime

`runtime: native` seats run an agent loop that belongs to Curule, behind a small port (`LlmProvider`) with one adapter
per wire format rather than one per vendor:

- **OpenAI-compatible chat completions.** The common format: OpenAI, Azure OpenAI, Google's compatibility endpoint,
  Groq, Together, Fireworks, DeepSeek, Mistral, OpenRouter, and local servers such as Ollama, vLLM and llama.cpp.
- **Anthropic Messages**, for Claude models called directly with an API key, with prompt caching.

The loop reads the same briefing the Claude adapter reads, calls the model with the seat's tools, runs them, and ends the
turn when the model stops. The tools are the ones a seat already knows (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`,
`WebFetch`, and the `mesh_*` bus tools over the bus's HTTP endpoint), gated by the same capability rules, the same
operator approval gate and the same landing gate. The gate code is shared with the Claude adapter, not copied.

The Claude adapter stays, for operators who run Claude Code with their own subscription or credentials. It is one runtime
among several, not the product's foundation.

### Model gateway

The gateway is the only place provider credentials exist. A workspace gets a virtual key: scoped to that workspace,
carrying a rate limit and optionally a daily cap, revocable at any moment, useless anywhere but the gateway. The full
reference is [ai-gateway.md](ai-gateway.md); this is what it guarantees.

For each call the gateway checks the key and its limits, holds back the most the call could cost from the account's balance,
forwards to the first model of the requested tier that can answer, streams the answer back, reads the usage the provider
reports, and appends one record to an append-only ledger. Budgets are enforced before the call (from the balance) and settled
after it (from the usage), so a single long call cannot overdraw an account by more than its own cost. The ledger, not a
counter, is the source of truth: a balance is a projection of it, in the same way every other view in Curule is a projection
of its event log.

The tenant-facing API is OpenAI-compatible chat completions with tool calls and streaming, which is exactly what the
`native` runtime speaks. Providers whose wire format differs are reached through the same adapters the runtime uses, so
there is one translation to maintain, not two. When a provider fails before it has produced anything, the next model in the
tier answers; what the caller is told about a failure is the same for every provider and names none.

### Control plane

Accounts, plans, credits, workspaces and their lifecycle (created, running, suspended for non-payment, deleted). Its state
is an append-only log with projections, like the kernel's, behind a store interface so a database can replace the file when
one process is no longer enough. The reference, including what each payment event does, is
[cloud-control-plane.md](cloud-control-plane.md).

- **Sign in.** Email and password (scrypt), sessions in an `HttpOnly`, `SameSite=Lax` cookie, a request-origin check on
  every mutating call, rate limits on sign-in and sign-up, and answers that do not reveal whether an email has an
  account.
- **Billing port.** The control plane never talks to a payment provider directly. It speaks a small interface (create a
  checkout, open the customer portal, verify and normalise a webhook), and each provider is an adapter. A hosted-checkout
  adapter and a manual adapter (the operator records a payment, which is how invoices and bank transfers work) ship
  first. Which provider can take payment for a given company depends on where the company is established and where its
  customers are; that choice belongs to the operator and changes nothing else.
- **Entitlements.** A paid plan becomes a signed licence for the workspace, minted by the control plane with the key the
  operator holds. The workspace verifies it offline, as any self-hosted install does.
- **Credits.** Plan periods and purchases append grants to a ledger; the gateway's usage appends spend. The balance is
  the sum, and it sets the virtual key's budget.

### Workspaces

A provisioner creates, suspends, resumes and destroys workspaces. It has two implementations behind one interface:

- **Local process**, for development and single-customer installs. It refuses to run when the service is configured as
  production, because an agent's shell is only as isolated as its process, and that is not isolation between customers.
- **Container**, for production: one container per workspace with a read-only image, a writable state volume, CPU and
  memory limits, no route to the control plane or to other workspaces, no route to cloud metadata addresses, and egress
  limited to the gateway, the package registries and git hosts the operator allows.

Stronger boundaries (a microVM per workspace) fit behind the same interface.

### Edge proxy

The dashboard and its server-sent event stream are served through the control plane's proxy, at `<slug>.<workspace domain>`.
It checks the session and the membership on every request, and again while a stream is open, adds the workspace's operator
credential on the way in, and never sends that credential to the browser. A workspace has no public address. How it works is
in [cloud-control-plane.md](cloud-control-plane.md#the-edge-a-workspace-at-its-own-address).

## Try it on one machine

`npm run cloud -- trial` runs the whole service on one machine with nothing real behind it, so that it can be tried, and shown,
before anything is paid for or any account exists anywhere. It needs the build (`npm run build`) and Node 20 or later.

```bash
npm run build
npm run cloud -- trial                       # the app is at http://localhost:7500
npm run cloud -- trial --port 9000 --dir ./trial   # another port; a folder that is named is kept
```

It prints where everything is, and then it prints each mail as the service writes it, which is how the confirmation link
reaches you. Open the app, create an account, follow the link, choose a plan, press the button on the trial's payment page,
make a workspace and open it. The workspace is a real Curule host in a process of its own, behind the control plane's proxy at
`<name>.localhost:<port>` (Chrome opens `*.localhost` on the machine by itself; for another browser, add the name to
`/etc/hosts`). A team made in it runs on the service's models, with no key asked for, and what each call was charged is in the
account page.

What is real: the gateway and its ledger, the control plane and its log, the account pages, the proxy and its credentials, the
virtual key each workspace is given, and a Curule host for each workspace. What stands in: the model (an answer of one sentence,
with no tool use, so a mission will not get far), the payment page (it applies the payment as a provider's message would, and
nothing is charged), mail (printed, and kept in the outbox file), and the isolation (a workspace is a child process, which is
not a boundary between customers, and the control plane refuses to use it in production). The plans and prices are the
trial's own and are not an offer. A named `--dir` keeps the accounts, the ledger and the workspaces; start the trial on it again
and the workspaces that were running are started again at once. Stopping the trial ends the hosts it started.

What it proves is that the parts fit: the proxy's credentials against the host's own checks, the host's environment from the
provisioner, the team the host writes naming the gateway and no key, the virtual key from the control plane working at the
gateway, and the ledger's spend reaching the account page. `tests/integration/cloud-trial.test.ts` walks a customer through all
of it, and `npm run qa:cloud` (`scripts/qa-cloud.mjs`) does the same in a real browser, with the public pages at three widths
and in both colour schemes and an accessibility scan. What it does not prove is a real payment provider, a real container
engine, a real model provider, mail that is delivered, TLS, or load.

## Threats and what answers them

| Threat | Answer | Residual |
|---|---|---|
| One customer reaches another's workspace | Membership check at the edge; a workspace has no public address; containers share no network | Container escape is the provider's and the host's risk; mitigated by a microVM provisioner |
| An agent, steered by hostile text in a repository, runs commands to attack the host | The workspace is the blast radius; its container has no route to anything but the gateway and the allowed egress | An agent can do what its container can reach, which is why the egress list is short |
| A customer uses a workspace to attack others, mine cryptocurrency or send spam | CPU and memory limits on the container; no inbound routes; egress limited to the gateway and the hosts the operator lists; suspension in one action | Traffic to a listed host; abuse is noticed after it starts, not before |
| An agent exfiltrates the workspace's gateway key | The key is rate-limited, may carry a daily cap, is revocable and is valid only at the gateway; the agent's shell does not inherit it in its environment | Anyone who obtains it can spend that account's balance, up to the key's daily cap, until it is revoked or empty |
| A customer runs up usage the service cannot bill | The balance is checked and held before each call and settled after; a key may also carry a daily cap | A call in flight can overdraw by at most its own cost |
| A forged payment event grants a plan | Webhooks are verified against the provider's signature before they are read; unverified bodies are refused | Compromise of the provider account |
| Stolen session | `HttpOnly`, `SameSite=Lax`, rotation on sign-in and password change, server-side revocation | A compromised browser |
| Provider outage or exhausted provider account | The gateway returns a typed error; the mesh pauses once, not seat by seat; tiers can fail over to another provider | Provider concentration, reduced by the tier layer |
| Server-side request forgery from an agent's `WebFetch` | Private, loopback and link-local addresses are refused after DNS resolution, including through redirects | An allowlisted host that is itself hostile |

## What is not done, and not claimed

- No model provider's terms are assumed to allow resale. The service must hold, for each provider it routes to, a
  commercial agreement that permits it to supply that provider's models to its customers. The runtime and gateway are
  provider-neutral so that this is a configuration of the service, not a limit of the software.
- Single sign-on and per-operator roles are not built; a workspace has one operator credential, as the self-hosted
  product does today.
- The control plane runs as one process. Its store interface is the seam for running more.
- Real-provider behaviour is only as tested as an operator makes it: the adapters are tested against servers that speak
  each wire format, and `curule providers check` is how an operator proves a key and a model work before relying
  on them.
