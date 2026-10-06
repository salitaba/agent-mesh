# The native runtime

`runtime: native` runs a seat's model call inside Curule, through a small port, instead of through a vendor's agent. A seat
can be served by any provider that speaks one of two wire formats, and a mesh can name several providers and give each seat
its own model.

Use it when the models are not Claude, when you want one key and one price list per provider rather than one per tool, or
when the mesh runs somewhere (a hosted workspace, an air-gapped cluster with a local model server) where a vendor's agent
cannot. The Claude adapter ([runtime-claude](runtime.md#runtime-claude)) stays: it is the right runtime for Claude Code on
your own subscription or credentials, and a mesh can mix the two, seat by seat.

## Start

```yaml
mesh:
  runtime:
    default: native
    model: main/MODEL-ID            # provider/model; see "Models"
    providers:
      main:
        kind: openai-compatible     # or: anthropic
        base_url: https://api.example.com/v1
        api_key_env: MAIN_API_KEY   # the variable the key is read from; a key is never written in mesh.yaml
```

```bash
export MAIN_API_KEY=...
curule providers check mesh.yaml --model main/MODEL-ID
curule run mesh.yaml
```

`curule providers check` reads the providers from `mesh.yaml` and the keys from the environment, as the server does. For each
provider it says whether the key is set, whether the endpoint answers and which models it lists. With `--model` it makes one
small call with a tool, as a seat would, and says what the call used and what the provider called the model. A model that
answers in text instead of calling the tool fails the check: a seat acts on the mesh by calling tools, so a model that does not
do tool calls cannot be one. The call costs a few hundred tokens and nothing is spent without `--model`.

`curule validate` checks the same configuration without the network: a provider with no base URL, a default that names nothing,
and every seat on `native` whose model cannot be placed are refused at load, not on a seat's first turn.

## Providers

A provider is a name, a kind and where to send calls. Seats refer to it as `provider/model`.

| Kind | Wire format | Calls |
|---|---|---|
| `openai-compatible` | chat completions with tool calls, streamed | `POST {base_url}/chat/completions` |
| `anthropic` | the Messages API with tool use, streamed | `POST {base_url}/v1/messages` (`base_url` defaults to `https://api.anthropic.com`) |

The first is the format most providers and nearly every self-hosted server offer: OpenAI and Azure OpenAI, Google's
compatibility endpoint for Gemini, Groq, Together, Fireworks, DeepSeek, Mistral, OpenRouter, and local servers such as Ollama,
vLLM and llama.cpp. They agree on the shape and differ at the edges, and the adapter is written for the edges: tool-call indexes
and ids that are missing, repeated or reused; arguments sent as a string, an object or nothing; cached tokens reported under two
names; reasoning text under two; usage that is absent (then estimated, and marked so); and a parameter the server refuses by
name (`stream_options`, `max_tokens` against `max_completion_tokens`, `temperature`, `reasoning_effort`), which is dropped once
and remembered. It is tested against servers that implement the format, not against every vendor; run `curule providers check`
before relying on one.

The Anthropic adapter marks the end of the system prompt, of the tool list and of the last message for prompt caching, which a
seat's long, stable prefix is the case for, and reports cache reads and writes apart from input.

Every key of a provider:

| Key | Meaning |
|---|---|
| `kind` | `openai-compatible` or `anthropic`. Required. |
| `base_url` | Required for `openai-compatible`, up to and including the version segment (`https://api.openai.com/v1`). |
| `api_key_env` | The environment variable the key is read from. Said at boot if it is not set. |
| `headers` | Extra headers on every call, such as an organisation id. Not for secrets. |
| `auth_header` | `anthropic` only: `x-api-key` (default) or `bearer`, for a gateway that wants an `Authorization` header. |
| `max_tokens_field` | `openai-compatible` only: `max_tokens` (default) or `max_completion_tokens`. |
| `stream_usage` | `openai-compatible` only: ask for usage at the end of the stream (default true). |
| `effort_field` | `openai-compatible` only: the body field a reasoning effort goes in (default `reasoning_effort`), or `false`. |
| `default_max_output_tokens` | The cap to send when nothing names one. |
| `context_window` | The window, in tokens, of any model of this provider that names none of its own. |
| `cache_ttl_ms` | How long the provider's prompt cache lives. After this idle time a large conversation is rotated instead of re-read. Defaults to ten minutes for `anthropic`, and to never for the rest. |
| `idle_timeout_ms` | How long a response may go without a byte before the call is abandoned as slow (default 180 s). |
| `max_retries` | Retries after the first attempt, before any of an answer has been read (default 2). |

A call is retried only when the provider could not be reached or answered 429 or 5xx, honouring `Retry-After` up to twenty
seconds. A refused request (a bad key, a prompt that does not fit, an exhausted account) is never repeated.

When a provider refuses a turn, the failure is worded `API Error: <status> <detail>`, which the supervisor reads as it reads
the Claude CLI's: a rate limit, an exhausted account, a rejected key or an outage is one fault shared by every seat, and the
mesh pauses once with a clear notice instead of failing seat by seat ([provider outages](runtime.md#provider-outages-the-mission-wide-breaker)).

A workspace on [Curule Cloud](cloud.md) has one provider, the [model gateway](ai-gateway.md), and names tiers instead of models:

```yaml
mesh:
  runtime:
    default: native
    model: curule/balanced        # the tiers are fast, balanced and best
    providers:
      curule: { kind: openai-compatible, base_url: "https://gateway.example.com/v1", api_key_env: CURULE_GATEWAY_KEY }
```

The key is a virtual key: it works at the gateway and nowhere else, and the seats' shells do not inherit it. A balance that
runs out arrives as `API Error: 402`, which the supervisor reads as an exhausted account, so the mesh pauses once with that
notice and carries on when credit is added (`tests/integration/gateway-mission.test.ts` runs exactly that).

Behind a proxy, set `NODE_USE_ENV_PROXY=1` with `HTTPS_PROXY` (Node 22.21 and later).

## Models

`model:` is `provider/model`, split on the first slash, so a model id that has slashes of its own survives:
`openrouter/openai/gpt-4o` is provider `openrouter`, model `openai/gpt-4o`. A first segment that is not a configured provider is
part of the model id and goes to `default_provider`, or to the only provider when there is one. `mesh.runtime.model` is the
default for a seat that names none.

```yaml
  runtime:
    default_provider: main
    models:
      MODEL-ID:
        context_window: 128000     # tokens; rotation is measured against 60% of it
        max_output_tokens: 8192
        effort: low                # low | medium | high, where the provider takes one
        temperature: 0.2
```

The context window decides when a seat's conversation is rotated. A seat's own `context_window` wins, then the model's, then the
provider's, then `mesh.runtime.context_window`, and a model nobody has said anything about is assumed to hold 200,000 tokens on
`anthropic` and 128,000 elsewhere, with a notice at the first turn. A local model server often serves a smaller window than the
model supports (Ollama's default is a few thousand tokens): set `context_window` to what the server really has.

The model name written to the ledger and to price lookups is the one configured here (`MODEL-ID`); the provider's own spelling,
which is often a dated snapshot, is kept beside it as `modelVersion`. Prices for the host's spend ceiling and the usage report
come from `host.yaml` (`model_prices`), keyed by that id.

## A turn

A seat's session is a conversation held by the runtime. A turn adds the mesh's briefing to it as a user message and runs a loop:
call the model with the seat's tools, run the calls it makes in order, give it the results, and stop when it stops.

- **Tools.** A seat is offered the file tools always (`Read`, `Glob`, `Grep`), `Write` and `Edit` if a capability reaches them,
  `Bash` if it holds `shell.execute`, `test.execute` or `git.commit`, `WebFetch` with `network.request`, and the mesh's own `mesh_*`
  tools from the bus. The list is cut to what the seat can use, because a tool the gate will refuse costs tokens on every call
  and invites the attempt. The gate still decides every call, with the same rules as the Claude adapter: the capability checks, the
  operator's approval gate (a held tool is reported to the operator and the seat is told to end its turn), the commit-only shell
  scope, and the landing gate that keeps a seat from landing work on the product branch from a shell or writing into the product
  checkout.
- **The bus.** The mesh's tools are called at `/internal/mcp/<agent>` over HTTP with the seat's token, which is what `curule mcp`
  bridges for a CLI. A bus that is not up when the turn starts is waited for (about thirty seconds) and then fails the turn as an
  unreachable backend. A call the bus has taken is never repeated.
- **Finishing.** `mesh_done` ends the turn. When the mesh accepts it without a note, the runtime does not spend another call on
  the model saying goodbye. When it comes back with a note (a task kept claimed) or an error, the seat reads it and goes on.
- **Not speaking to the mesh.** A seat that ends a turn without calling a single mesh tool has said nothing the mesh can hear. It
  is told once, in the same turn, and gets one more round.
- **Notes.** `advise` (the supervisor's deadline warnings) reaches the model at the next tool boundary, on the last result of the
  batch.
- **Stopping.** The mesh interrupting a turn (a deadline, an operator) ends it as a failure that still reports what the finished
  calls spent, and every call of a cut-short batch is answered, so the conversation stays valid. The mesh ending a turn as
  complete (a continuity record landed) lets the batch in progress finish and spends no further call.
- **Cut off.** A reply cut off by the output cap is asked to continue, twice at most. A call whose arguments were cut off, or are
  not a JSON object, is not run as if complete: the seat is shown what it sent and asked to send it again.
- **Limits.** A turn may make 200 model calls (`mesh.runtime.native.max_steps`); past that it fails with what it spent.

Usage is summed over the turn's calls into four numbers that never overlap (fresh input, output, cache reads, cache writes), and
the turn's billable total excludes cache reads, as everywhere else in Curule.

## Tools

| Tool | Does | Bounds |
|---|---|---|
| `Read` | A file's lines, numbered. | 2000 lines and 60,000 characters per call, with the offset to continue from; a file over 2 MB only in ranges; binary files refused. |
| `Write` | Creates or replaces a file, and its directories. | 5 MB; never inside `.git`. |
| `Edit` | Replaces text that occurs once (or all, with `replace_all`). | Refuses a missing, repeated or unchanged string, in the words models already recognise. |
| `Glob` | Files by name pattern (`**`, `*`, `?`, `{a,b}`), newest first. | 500 results; `.git` and `node_modules` skipped. |
| `Grep` | A regular expression over files, as paths, matching lines (with context) or counts. | 250 lines by default; binary and files over 2 MB skipped. |
| `Bash` | A command in a fresh shell in the workspace. | 120 s by default and 600 s at most; the first 20,000 and last 10,000 characters of output; no stdin. |
| `WebFetch` | A page's text over http or https. | Public addresses only; 2 MB, 40,000 characters, 20 s, 5 redirects. |

Glob and Grep are written in Node, so a seat's search works the same in a minimal container as on a laptop.

## What a seat can reach

- **Files.** The file tools read the seat's workspace and the product checkout (plus any `mesh.runtime.native.extra_read_roots`)
  and write only the seat's own workspace. Paths are resolved the way the operating system resolves them, symlinks included, so a
  link out of the workspace is not a way out, and a file that does not exist yet is judged by where it would be. A seat with no
  shell still has `Read`, and a `Read` that could open `/proc/self/environ` would hand it every key the process holds.
- **The shell.** A command runs as the user that runs the mesh. The gate decides whether a seat gets a shell and, for a commit-only
  seat, which command; what the shell can reach is what that user and its container can reach. Its environment is the process
  environment without the mesh's own credentials (`MESH_API_TOKEN`, the licence, anything named `MESH_*TOKEN|SECRET|PASSWORD`) and
  without the variables the providers' keys are read from. `mesh.runtime.native.shell_env: minimal` starts from an allowlist
  instead (`PATH`, `HOME`, `LANG` and a few more), which is the setting for any deployment where the process environment cannot be
  trusted to hold only what a seat may use. Everything a command leaves running is killed when it returns.
- **The network.** `WebFetch` judges the address, not the name: every address a host name resolves to must be public, the
  connection is made to the address that was judged, redirects are judged on every hop, and an IP literal is judged before any
  lookup. Loopback, private, link-local (including a cloud's metadata address), carrier-grade and reserved ranges are refused. A
  seat with a shell can still open its own connections; the container's network policy is what bounds that.

## Sessions

A conversation is kept on disk, so a restarted mesh resumes it: one append-only JSON-lines file per conversation under
`<state dir>/native/<seat>/`, written at the end of each round of a turn, not only at the end of the turn. Loading cuts a torn
or damaged tail off the file, answers any call left without a result, and keeps the seat's last two conversations.

A conversation is rotated when what the last call was handed (the whole prompt, cache reads and writes included) reaches 60% of
the window, or when it is large and has sat idle past its provider's cache lifetime. The supervisor is told first and may spend a
turn asking the seat for a continuity record; the turn after it starts a new conversation from the mesh's projections.

A prompt the model refuses for its size is not a failed turn. The runtime elides older tool results and tries again, and if that
is not enough it rotates on the spot and goes on from the turn's briefing.

## The designer

The designer's chat, and acceptance-criteria generation, can run on the same runtime: `mesh.runtime.designer: native` (the
default when `default` is `native`), with `designer_model: provider/model` or the default model. The designer gets only the tools
the bus offers it (staging and read-only observability); it proposes and never executes.

## Hosted workspaces

On [Curule Cloud](cloud.md) every workspace's host is started with three settings, and a person who opens the workspace brings
no key:

| Setting | Meaning |
|---|---|
| `CURULE_GATEWAY_URL` | The service's model gateway, up to and including `/v1`. |
| `CURULE_GATEWAY_KEY` | A virtual key for that gateway, scoped to this workspace. It works there and nowhere else, and it is removed from the environment of every seat's shell like any other provider key. |
| `CURULE_GATEWAY_MODEL` | The tier a team uses unless a seat names another. The plan sets it; left out, `balanced`. |

A workspace's host is also told where its customer's account page is (`CURULE_ACCOUNT_URL`, set by the provisioner after the operator's own
environment, so that it cannot be overridden). The console reads it from `GET /api/templates` (`hosted: { accountUrl }`) to tell a customer's
workspace from a laptop: it welcomes the customer with a goal field instead of folders, and, on a hosting-only plan whose model key has not
been added, links to the account page where it is added. It is not a credential and grants nothing.

A host with the address and the key is a *managed* one. A team made on it from the dashboard, from a shipped example or by adding a
folder with `init`, runs on the native runtime through one provider named `curule`: the default runtime and each seat that
would have been on the Claude runtime go to `native`, a Claude model hint on a seat is dropped (it cannot be placed on another
provider), and the model is `curule/<tier>`. What is written names the variable the key is read from and never the key:

```yaml
mesh:
  runtime:
    default: native
    designer: native
    model: curule/balanced
    providers:
      curule:
        kind: openai-compatible
        base_url: https://gateway.example/v1
        api_key_env: CURULE_GATEWAY_KEY
```

### A workspace on the customer's own model key

On a hosting-only plan (`byok: true`, see [cloud-control-plane.md](cloud-control-plane.md#plans-and-credit)) the service sells no
model usage and runs no gateway. The customer sets a key of their own for the workspace on their account page, and the host is
started with these instead of the three above:

| Setting | Meaning |
|---|---|
| `CURULE_MODEL_PROVIDER` | `anthropic` or `openai-compatible`. |
| `CURULE_MODEL_NAME` | The model, as that provider names it. |
| `CURULE_MODEL_BASE_URL` | For `openai-compatible` only: where the provider is called, up to and including `/v1`. Must be https and public. |
| `CURULE_MODEL_KEY` | The customer's key. Like the gateway key, it is removed from the environment of every seat's shell. |

A host with a provider, a model and a key is managed the same way: a team made on it runs on the native runtime, on that key, and
the provider bills the customer directly. `curule doctor` lists the four settings by name and says so, and never prints the key.
Until a key is set the workspace is started with no models. On a container workspace whose network is internal, the provider is
reached through the operator's egress proxy, so the provider's host must be on its list.

The shipped demo runs on the stub runtime and makes no model calls, so it is left as it is. The welcome says the models are
supplied and that what a team uses is charged to the account's balance, and `curule doctor` lists the three settings by name.
A mesh that already names its own providers is not rewritten. A mesh taken out of a workspace names the service's gateway: point
its provider at one of your own to run it anywhere else.

## What it does not do

- Extended thinking is not enabled on the Anthropic adapter, so no signed thinking blocks are carried between calls. Reasoning
  that an OpenAI-compatible provider streams is shown to the operator and left out of the conversation.
- Images and other non-text input are not read.
- A seat's tool calls in one reply run one after another, not together.
- The shell is not available on Windows.
- A model that does not call tools, or calls them badly, cannot be a seat. `curule providers check --model` finds the first
  case; the second shows as failed calls in the seat's steps.
