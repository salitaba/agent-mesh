# The model gateway

The model gateway is the one process of [Curule Cloud](cloud.md) that holds model-provider credentials. A hosted workspace
never has a provider's key: it has a virtual key that works at the gateway and nowhere else, carries its own limits, and
can be revoked at any moment. The gateway checks the key, holds back what the call could cost, asks a provider, streams
the answer back, and writes what it cost to a ledger.

It speaks OpenAI-compatible chat completions, which is what the [native runtime](runtime-native.md) already speaks to
any provider, so a workspace points a provider at the gateway in `mesh.yaml` and nothing else changes. Inside, every
upstream is reached through the same adapters the runtime uses (`packages/llm`): one translation to keep right, for the
OpenAI-compatible format and for Anthropic Messages alike.

**Status.** Built and tested against servers that speak each wire format (`tests/ai-gateway/`). No real provider has been
called by this code: `curule providers check` proves a key and a model, and a staging run proves the whole path, and both
need credentials the operator holds. The control plane that creates keys and credit for workspaces is
[designed, not built](cloud.md#status); until it exists, the admin API below is how an operator does it by hand.

## Running it

```bash
GATEWAY_ADMIN_TOKEN=<24 or more characters> EXAMPLE_API_KEY=<a provider key> \
  npm run cloud -- gateway --config gateway.yaml --check     # read it, print what it would run, listen on nothing
GATEWAY_ADMIN_TOKEN=... EXAMPLE_API_KEY=... \
  npm run cloud -- gateway --config gateway.yaml             # run it
```

`--check` prints the currency and the price version, the addresses, the limits, each provider (the host it calls and the
name of the variable its key is read from, never the key) and each tier with the price of every model in it. It exits 0
when the file is valid and 1, with every problem at once, when it is not. A running gateway stops on `SIGTERM` or `SIGINT`: it
takes no more calls, lets the ones in flight finish for up to ten seconds, and releases the ledger.

[`examples/cloud/`](../examples/cloud/gateway.yaml) has a configuration and a price table to start from. Its prices are
placeholders for a provider that does not exist.

One gateway writes a ledger at a time. A second process on the same ledger file refuses to start and names the process that
holds it.

## `gateway.yaml`

Paths are relative to the file. Nothing secret is written in it.

| Key | Meaning |
|---|---|
| `ledger` | The ledger file: keys, credit and every spend, one JSON object per line. |
| `prices` | The price table (below). |
| `tenant` | `host` and `port` workspaces connect to. The default is `127.0.0.1:8080`. The gateway speaks plain HTTP: terminate TLS in front of it. |
| `admin` | `host`, `port` and `token_env`, the name of the environment variable that holds the admin token (24 characters or more). The default is `127.0.0.1:8081`. It must not share an address with `tenant`, and it must not be reachable from a workspace. |
| `limits.default_rpm` | Calls a minute per key, when the key sets none. Default 120. |
| `limits.default_concurrent` | Calls open at once per key, when the key sets none. Default 16. |
| `limits.reserve_cap` | The most one call holds back from the balance, in currency units. Default 2. |
| `limits.deadline_seconds` | The longest one call may take. Default 600. |
| `limits.commit_seconds` | How long to wait for a provider's first word before the stream is opened anyway. Default 10. |
| `limits.max_body_bytes` | The largest request body. Default 8 MiB. |
| `expose_upstream_model` | Show callers the provider's name for the model that answered. With `false` they see the tier they asked for. The ledger records the model either way. Default `true`. |
| `providers` | Each: `kind` (`openai-compatible` or `anthropic`), `base_url`, and `api_key_env`, the name of the variable its key is read from. A provider whose variable is empty stops the gateway from starting. A provider with no `api_key_env` is called without a key, as a local server is. |
| `tiers` | Each tier is a list of `provider/model`, tried in order. An entry may be written `{ model: provider/model, max_output_tokens: N }`. The default cap on one answer is 16,384 tokens. |

## The price table

The operator owns it and the code ships none. A call that is not priced is a call the service pays for and nobody is
billed for, so a tier that names a model with no price stops the gateway from starting.

```yaml
currency: USD
version: "2026-10-05"        # which figures these are: recorded on every spend
default_markup: 1.25         # what a customer is charged is what the call cost times this
models:
  provider/model: { input: 1, output: 4, cache_read: 0.1, cache_write: 1.25 }   # per million tokens, as the provider charges you
  provider/other: { input: 3, output: 12, cache_read: 0.3, cache_write: 0, markup: 1.5 }
```

All four rates are required for every model. A provider that does not charge for cache writes is written as `0`; nothing is
assumed. A markup below 1 is refused unless `allow_below_cost: true` says it is meant. Every problem in the file is reported
at once.

Money is kept as whole millionths of the currency. The cost of a call is one exact product (tokens times rate, summed over
the four kinds) rounded up once, and the charge is the exact product times the markup rounded up once, not the rounded
cost times the markup. For example, on a model at 1 in, 4 out and 0.1 cache read per million with a markup of 1.5, a call
that used 1,000 fresh input tokens, 200 output tokens and 5,000 cache read tokens costs 1,000 + 800 + 500 = 2,300
millionths of a unit and is charged 3,450.

## Tiers and failover

A workspace asks for `fast`, `balanced` or `best`. Which provider and model answers is the operator's business and can
change without the workspace changing a setting. A tier is a chain. When the first model could not answer, the next is
tried. That happens for every kind of failure before the model has produced anything: busy, down, unreachable, slow, a
refused key or account at the provider, a request the provider rejected. Once an answer has begun to go to the caller there is
no passing over, because the caller has already seen part of it. A failure then is an error event in the stream.

A call carries a cap on its answer. The gateway asks the provider for the smaller of what the caller asked for and what the
tier allows.

## Keys

A key looks like `curule_vk_<12 hex>_<43 characters>`. The prefix is fixed so that a leaked key is recognisable to secret
scanners, the id is safe to log and to show, and the rest is 256 bits of secret of which only a SHA-256 is stored. The
admin API returns a key once, in the response that made it.

A key belongs to an account and may name a workspace. It may carry limits: `rpm`, `concurrent` and `dailyCapMicros` (the
most it may be charged in a UTC day), and a list of the tiers it may use. Every way of presenting a bad key (none, malformed,
unknown, wrong secret, revoked) is answered the same way, so a refusal says nothing about which keys exist.

## The balance

An account has two buckets of credit. `included` is what a plan period gives and is replaced when the next period starts.
`purchased` is bought and does not expire. A spend draws on `included` first.

**Held before, settled after.** Before a call goes to a provider the gateway holds back the most it could cost: the request
as JSON at three characters to a token, priced as fresh input, plus an answer of the full cap, at the price of the most
expensive model in the tier, with the markup. The hold is capped by `limits.reserve_cap`. If the balance less what other
calls in flight are holding does not cover it, the call is refused with `402`, and the provider is not asked. When the call
ends, the hold is given back and the real usage is written. So a call can cost more than was held, and an account can go
below zero, by at most the cost of the calls that were in flight when it ran out; the next call is then refused.

**What a caller is charged**

| What happened | Outcome | Charged |
|---|---|---|
| The answer finished | `ok` | What the provider reported, at the markup. Where it reported nothing, an estimate, flagged `estimated`. |
| The caller went away mid-call | `aborted` | The prompt and what had been produced, estimated: the provider has done that work. |
| The provider failed after the answer began | `failed` | Nothing. What it cost the service is recorded, so the loss is visible. |
| Every provider failed before the first word | not recorded | Nothing. |

The spend is written, and made durable, before the last event of a stream is sent. A caller never receives the end of a call
the ledger has not recorded.

## What a caller is told

| Status | `type` | When | What the native runtime does |
|---|---|---|---|
| 401 | `invalid_api_key`, `missing_api_key` | no key, or a key that is not valid for any reason | treats it as a rejected key and pauses the mesh once |
| 402 | `insufficient_credits` | the balance cannot cover the call; the message says how much it may cost and how much is available | treats it as an exhausted account and pauses the mesh once |
| 404 | `model_not_found` | a tier this key may not use; the message lists the ones it may | a configuration error, reported |
| 400 | `invalid_request_error`, `unsupported_parameter`, `unsupported_content` | a request the gateway cannot honour (more than one choice, an image, a forced tool, ...), named in the message | a configuration error, reported |
| 400 | `context_length_exceeded` | the prompt is too long for the model | shrinks the conversation and asks again |
| 429 | `rate_limit_exceeded`, `too_many_requests`, `daily_limit_reached` | a limit of the key, or a provider that is limiting requests; `Retry-After` says when | waits when the wait is short, and reports a longer one |
| 413 | `request_too_large` | the body is over `limits.max_body_bytes` | reported |
| 503 | `service_unavailable` | every provider in the tier failed, or the ledger cannot be written | retries, then pauses the mesh once as a provider outage |
| 504 | `upstream_timeout` | the call ran past its deadline | retries |

Over HTTP the status carries the fault. Inside a stream, where the status has already gone, the same error is a `data:`
event with a numeric `code`, which the runtime's adapter reads the same way. What a caller is told about a provider failure
is the same for every provider and names none: no provider, no account, no credential. The log has all of it.

Every response carries `x-request-id`; the same id is in the ledger's spend and in the log.

## The admin API

Behind `Authorization: Bearer <admin token>`, on its own port. Every route returns JSON. A key that a workspace holds is not
an admin token.

| Route | What it does |
|---|---|
| `POST /admin/keys` | `{ accountId, workspaceId?, label?, limits?, models? }`. Makes a key. `models` must be tiers that exist. Returns `201` with the key's record and its `token`. |
| `GET /admin/keys?accountId=&workspaceId=` | Lists keys, oldest first, without secrets. |
| `POST /admin/keys/:keyId/revoke` | `{ reason? }`. The key stops working at once. |
| `POST /admin/grants` | `{ id, accountId, bucket, mode?, amountMicros, reason, reference? }`. `bucket` is `included` or `purchased`; `mode` is `add` (the default, and negative to take credit back) or `set` (replace the bucket, which is what a new plan period does). `id` makes the call safe to repeat: the same grant sent twice counts once, and an id reused for a different grant is a `409`. |
| `GET /admin/accounts/:id` | The balance by bucket, what calls in flight are holding, what has been charged and what it cost, and how many keys are live. |
| `GET /admin/ledger?accountId=&type=&since=&until=&limit=` | The last `limit` matching entries (default 100, at most 1,000), oldest first. A key's hash is never included. |
| `GET /admin/report?groupBy=&from=&to=&accountId=&workspaceId=` | Spend added up by `account`, `workspace`, `model`, `alias` or `day`: calls, calls that failed or were abandoned, tokens of each kind, what it cost, what was charged and the difference. |
| `GET /admin/health` | Whether the ledger can be written, the currency, the price version and the tiers. |

## The ledger

An append-only file, one JSON object per line. Everything the gateway knows about money is a projection of it: a balance is
the sum of its entries, not a counter. An entry is never edited; a mistake is corrected by another entry. Replaying the file
gives back the same balances to the micro-unit (`tests/ai-gateway/ledger.test.ts`).

Entries are `ledger.opened` (the currency; a ledger of another currency is refused), `key.created` (with the hash, never
the secret), `key.revoked`, `grant` and `spend`. A spend records the request id, the account, key and workspace, the tier
asked for, the provider and model that answered and the model as the provider named it, the price version, the four token
counts, the cost, the charge, the outcome, whether the figures were estimated and the latency.

- **Durable before acknowledged.** Each batch is written and synced before the calls that made it are told; appends that
  arrive together share one sync.
- **A cut-off last line** from a crash is dropped when the file is opened, so the next append starts on a clean line.
- **An unreadable line in the middle** stops the gateway from starting, and the message names the line. A record of money is
  not skipped. Restore the file from a backup, or repair that line.
- **A failed write stops the gateway for good.** It takes no more calls (`503`) until it is restarted, because memory and
  the file may no longer agree. A spend that could not be written for a call that was already served is logged in full,
  with an alert field, for the operator to reconcile.
- **Back it up.** The file is the only record of what customers have been given and have spent.

## The log

One JSON object per line on standard error. Each call writes `call settled` with the request, key, account and workspace
ids, the provider and model, the outcome, the charge and cost and the latency. A provider that cannot answer writes `a
provider could not answer` with its kind, its status and its reason with anything that looks like a credential removed. A
provider refusing the gateway's own key or account is logged at `error` with an `alert` field, because every caller on that
route is affected and someone has to act. The prompt, the answer and the key are never logged.

## What this build does not do

- It is one process with one ledger file. Reports read the whole file. A database behind the same interface is the way to run
  more than one.
- It has no TLS and no network policy of its own. Put TLS in front of the tenant port and keep the admin port off any network a
  workspace can reach. A virtual key is valid from anywhere that can reach the gateway; which workspaces can is the
  container network's job.
- It limits a key, not a provider: there is no ceiling on what the service spends at one provider in a day.
- Calls that a caller abandons are charged on an estimate (three characters to a token for the prompt, four for the
  answer), because the provider's own count is not available.
- It does not meter the workspace's other costs. A workspace's compute is the provisioner's business.
- No real provider has been called. See the status above.
