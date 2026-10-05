# The control plane

The control plane is the part of [Curule Cloud](cloud.md) that knows who a customer is, what they have paid for, and which
workspaces they run. It signs people up, turns a payment into credit and a plan, starts and stops each customer's workspace,
and gives the operator a view of the money. It sits in front of the [model gateway](ai-gateway.md) and never holds a model
provider's key.

**Status.** Built and tested (`packages/cloud`, `tests/cloud/`): accounts, plans, the billing port with its two adapters,
workspaces and their provisioners, licences for workspaces, the operator's views, the public API, the proxy that puts each
workspace at an address of its own, the operator's API, and `curule-cloud control`, which runs them. It is exercised against
fakes of everything outside it: a payment provider that answers in its documented shapes, a container engine that records what
it is asked, a gateway that is the real admin API, called over HTTP. The pages a customer sees (sign up, sign in, account) are
not built yet; the API is what they will call. Nothing here has taken a real payment or started a real container. What each of
those needs from the operator is in [What only the operator can do](#what-only-the-operator-can-do).

## What is kept

One append-only file of JSON lines, the control log, and every view is a projection of it, as in the kernel and in the
gateway's ledger. An account is not a row that is updated: it is what `account.created`, `account.verified` and
`account.password_changed` add up to. Replaying the file gives the same state, which is how a payment can be applied twice
without harm and how a crash is recovered.

The log holds no credential that can be used. A password is a scrypt hash. A verification link, a reset link and a session
token are each kept as a SHA-256 hash of a 256-bit random value that is shown once. A workspace's operator credential is not
in the log at all: it is derived from the service's secret and the workspace's id, so the proxy can present it after a
restart and nothing in the log can be used to reach a workspace.

A write is durable before the call that made it is told, a write that fails stops the log for good (memory and the file may no
longer agree, and only a restart replays the file), and one process writes the file at a time. The file sits behind a store
interface so that a database can replace it when one process is no longer enough.

## Accounts

| | |
|---|---|
| Sign up | An email and a password. Nothing is usable until the address is confirmed with a link sent to it. |
| Passwords | At least 10 and at most 200 characters; not one of the commonest; not four or fewer distinct characters; not the email address or the part before the `@`. Stored as scrypt (`N=32768, r=8, p=1`) with the parameters in the hash, so they can be raised later. Compared after Unicode normal form NFKC. |
| Links in mail | One use. A confirmation link lasts 24 hours and a reset link two. |
| Sessions | A random token in an `HttpOnly` cookie. A session ends 30 days after it began, or after 14 days without use, whichever is first. Use is written down at most every ten minutes. |
| Changing a password | Needs the current one. Every other session ends and the one that asked stays. |
| Resetting a password | Ends every session. |
| Stopping an account | The operator can stop one. It cannot sign in, its sessions end, and its running workspaces are stopped. |

**Nothing says whether an address has an account.** Signing up with an address that has one gives the same answer as signing up
with a new one, and the difference is in the mail that only the owner of the address reads. A sign-in that fails gives one
answer, in the same words, after the same work, whether the address is unknown, the password is wrong, the account is stopped
or the address was never confirmed (in that last case the confirmation link is sent again). A reset is asked for the same way
whether or not there is an account.

## Plans and credit

The operator writes the plans in a file, and the code ships no figures. [`examples/cloud/plans.yaml`](../examples/cloud/plans.yaml)
is an example to copy; its numbers are not an offer.

| Key | Meaning |
|---|---|
| `currency` | The currency customers are billed in, a three-letter code. |
| `plans.<id>.title` | The name shown to a customer. |
| `plans.<id>.licence_plan` | The self-hosted plan whose limits a workspace of this plan runs with: seats per mesh, projects, concurrent turns. One of `community`, `team`, `business`, `enterprise`. |
| `plans.<id>.price_minor` | What one period costs, in whole minor units of `currency`. |
| `plans.<id>.period` | `month` or `year`. |
| `plans.<id>.included_usage` | Model usage included each period, as a decimal in the gateway's currency with at most six places. Each period's payment replaces the included credit with this amount; it is not added to what was left. |
| `plans.<id>.workspaces` | Workspaces an account may run at once. |
| `plans.<id>.provider_price_id` | The payment provider's id for this price, where the provider needs one. |
| `plans.<id>.tiers` | The gateway tiers a workspace of this plan may use. Left out, every tier. |
| `topups.options_minor`, `minimum_minor`, `maximum_minor` | The amounts offered, and the bounds of any other amount. |
| `topups.usage_micros_per_minor` | Model usage one minor unit buys, in millionths of a unit of the gateway's currency. |

Credit has two buckets, as in the gateway. Included credit is replaced each period and spent first. Purchased credit does not
expire. When both are gone the gateway refuses new calls and the mesh pauses once with one clear notice.

## Payments

The control plane never talks to a payment provider except through the **billing port**: create a checkout, open the customer
portal, and verify and read a message. A provider is an adapter behind it, because which provider a company can use depends
on where it is established and where its customers are. Every provider's messages, and every payment the operator records by
hand, are read into the same few events and applied by the same rules.

| Event | What it does |
|---|---|
| `payment.succeeded`, a top-up | Purchased credit at the catalogue's rate. |
| `payment.succeeded`, a period | Replaces the included credit with the plan's amount; the subscription is active until the period's end; the account's stopped workspaces start if it had fallen behind; its running and stopped workspaces move to the new plan if the plan changed. |
| `payment.failed` | An active subscription becomes past due and the customer is told once. Nothing stops yet. |
| `subscription.ended` | The subscription ends, its running workspaces stop, and the customer is told once. |
| `payment.refunded` | Takes back the credit a top-up bought. The provider reports the total refunded for the payment, so a message counts for what it adds to what was taken back already; a late or repeated message takes back nothing more, and no more than the payment bought. A refund of a plan's payment changes nothing automatically, because whether the customer keeps the plan is the operator's decision. |
| `customer.linked` | Remembers which account the provider's customer is, so a later message that names only the customer finds the account. |

**An event is applied at most once.** It is identified by `ref`, the provider's own id for it, and the second time finds the
first's record. The gateway's grants carry ids made from the reference (`topup:`, `period:`, `refund:`), so a crash between
granting and recording is repeated harmlessly, and a failure to reach the gateway records nothing, so the same event can be
applied when it can be reached.

**A payment that cannot be matched is kept, not guessed at.** A payment for an account that does not exist, in a currency the
catalogue does not sell in, for a plan the catalogue does not have, or for an amount that is not a positive whole number of
minor units, grants nothing and is recorded with the reason. `unmatched()` lists them for the operator.

**Manual billing** is for payments that arrive some other way: an invoice, a bank transfer. The customer is sent to a page of
the operator's own with a reference to quote, and the operator records the payment when it arrives. There is no message to
verify and no portal.

### ADAPTER NOTES: the hosted-checkout adapter

The adapter for a payment provider with a Stripe-compatible API was written from the provider's public documentation and is
tested against servers that answer in the shapes the documentation gives. It has not been run against the live service.
Run it in the provider's test mode before it takes a real payment, and check these:

- **The checkout.** A subscription checkout is created with the plan's `provider_price_id`, the account's id as
  `client_reference_id` and in the metadata, and an idempotency key made from the account, the plan and the day, so asking
  twice gives the same checkout. A top-up is a one-off payment for the amount, in the account's currency, with the same
  reference. The customer pays on the provider's own page, so no card data touches this service.
- **The messages.** Point the provider's webhook at `POST /webhooks/billing` on the app's address and subscribe it to
  `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`,
  `customer.subscription.deleted` and `charge.refunded`. Anything else that arrives is acknowledged and ignored.
- **The signature.** `Stripe-Signature: t=<seconds>,v1=<hex>` is checked against the endpoint's secret over `<t>.<body>`,
  before the body is read as anything, and a message whose time is more than five minutes from this service's clock is
  refused. Several `v1` values are accepted when any one matches, so a secret can be rotated.
- **The plan of an invoice** is read from the invoice line's metadata, then the subscription's, then the line's price through
  `planOfPrice`. An invoice for which none of them names a plan is not guessed at: it is recorded as unmatched. Check that
  your provider carries the plan one of those ways.
- **Invoice shapes.** The adapter reads the period from the invoice line, then from the invoice, and the subscription from
  the invoice or its parent. Compare a real test-mode invoice with `tests/cloud/hosted-checkout.test.ts`.
- **Refunds.** `charge.refunded` carries the total refunded for the charge. The adapter passes it on as such.

Another provider is another adapter behind the same port, and changes nothing else.

## Workspaces

A workspace is one isolated Curule host, with its own state, projects and event log. It is made only for an account that is
confirmed, not stopped, and paid up, and under its plan's limit of workspaces. Everything it needs is made for it alone:

| | |
|---|---|
| A model key | A virtual key at the gateway, scoped to the workspace and the plan's tiers. It works at the gateway and nowhere else, and the workspace's shells do not inherit it. |
| A licence | A signed licence for the plan, minted for this workspace and valid for 400 days. The workspace verifies it offline, as a self-hosted install does, and runs with the plan's limits. Payment is enforced by stopping the workspace, not by the licence running out. |
| An operator credential | Derived, never stored. The edge proxy presents it to the host; the browser never sees it. |

Starting returns at once with the workspace `provisioning`. If any step fails, what was made is taken away again, so a failed
start leaves no key, no container and no charge behind.

| State | Meaning |
|---|---|
| `requested`, `provisioning` | Being made. |
| `running` | Serving. |
| `suspended` | Stopped, with its data kept. The reason is shown to the customer: they paused it, payment is overdue, the subscription ended, or the account was stopped. |
| `failed` | It could not be started, or its host disappeared. |
| `destroyed` | Deleted with its data. Its key stopped working first, so nothing can spend after the decision. |

**When an account stops paying.** A failed payment makes the subscription past due, and the workspaces keep running for the
grace period (three days). After it they are stopped, not deleted. A payment that arrives first puts everything back. A
subscription that ended stops its workspaces at once, and they are deleted after the retention period (30 days). A period that
ended with no payment recorded, because a message was lost or the payment did not come, makes the subscription past due after
three days. `reconcile()` is what applies these, and it is idempotent, so it is run on a timer. It also gives up on a start that
was in progress when the service stopped, and marks a running workspace failed when its host has gone.

### Provisioners

A provisioner starts, stops, resumes and removes the host. Two sit behind one interface.

**Local process** is for development and for a single customer on a machine they own. A workspace is a child process with its
own directory, and its credentials are in a file only its owner can read, outside the workspace's projects. It refuses to run
when the service is configured as production: an agent's shell is only as isolated as its process, and that is not isolation
between customers.

**Container** is for production, one container per workspace. The command is built in one place and run by an injected runner,
so what it asks the engine to do can be read and tested without an engine:

- secrets are passed by name (`--env NAME`), and their values are in the environment of that one command, never in an argument,
  which any process on the machine can read;
- a read-only root, a state volume at `/data` and a 512 MB temporary directory as the only places to write;
- an unprivileged user, every capability dropped, `no-new-privileges`, and limits on memory (swap included), CPUs and
  processes;
- one named network and nothing else.

**The network is the operator's to build.** The provisioner points a workspace at it and cannot make it. It must give a
workspace no route to the control plane, to other workspaces' containers, or to cloud metadata addresses, and no route out
except through an egress proxy that allows the gateway, the package registries and the git hosts the operator lists. With
`egressProxy` set, the provisioner sets `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` for the workspace and tells Node to use them.
A workspace is told the one host it is served on (`MESH_ALLOWED_HOSTS`, `MESH_ALLOWED_ORIGINS`), that it sits behind the
service's proxy, and to mark its cookies secure.

**The image** is the one the repository builds (`Dockerfile`): the host keeps what must survive a restart under `/data`, and
reads its port and bind address from `MESH_PORT` and `MESH_BIND`.

A microVM per workspace fits behind the same interface.

## Licences for workspaces

The control plane is the only thing that holds the licence signing key. Generating it is the operator's:

```bash
node tools/license/mesh-license.mjs keygen --kid k1 --out ~/secrets/mesh-license-k1.pem
```

The private key stays where only the operator can read it. The public key it prints goes into
`packages/licensing/src/keys.ts`, so that a workspace, which is built from this repository, accepts what the service signs.
Until it is there, a workspace reads every licence as unknown and runs with the Community plan's limits.

## Running it

```bash
npm run cloud -- control --config control.yaml --check   # validate, show what would run, and exit
npm run cloud -- control --config control.yaml           # run it
```

`examples/cloud/control.yaml` is a file to copy. Secrets are never in it: each key that needs one names the environment
variable it is read from, and a variable that is missing or too short stops the start, so the mistake is found when the service
is deployed and not by the first customer. Every problem is reported at once. `--check` reads and validates everything,
prints what the service would run (no secret is in it), and touches nothing.

| Key | Meaning |
|---|---|
| `app_url` | Where customers reach the app, as an address with no path: `https://app.example.com`. An `https` address means production: cookies are `Secure`, `Strict-Transport-Security` is sent, and the local provisioner is refused. An `http` address is a trial on one machine. |
| `workspaces.domain` | Workspaces are served at `<slug>.<domain>`. See below for what it may not be. |
| `public` | The listener a load balancer connects to: `host`, `port`, and `trust_proxy_hops`, how many proxies in front add to `X-Forwarded-For`. With 0 the header is not read, and behind a proxy every caller then looks like the proxy. |
| `owner` | The operator's listener (`host`, `port`) and `token_env`, the environment variable that holds its token (24 characters or more). |
| `pages` | A directory of account pages. Leave it out to serve the API alone. |
| `control_log`, `mail.outbox` | Where the log and the mail are written. |
| `plans` | The plan catalogue, [above](#plans-and-credit). |
| `secret_env` | The service's secret, 32 characters or more. Workspace cookies are signed with a key derived from it, and so is every workspace's operator token. Do not change it while workspaces exist: a workspace was given its operator token when it was made, the proxy presents the one derived from the current secret, and every existing workspace would refuse it. |
| `gateway` | `admin_url` and `admin_token_env` for the [model gateway](ai-gateway.md)'s admin API, and `tenant_url`, the address a workspace is told to call for models. It ends in `/v1`. |
| `licence` | `kid`, and `private_key_file` or `private_key_env`: the key workspace licences are signed with. |
| `provisioner` | `kind: container` with `image`, `network`, an optional `egress_proxy`, `no_proxy` and `limits` (`cpus`, `memory_mb`, `pids`), or `kind: local` for a trial. |
| `billing` | `provider: manual` with `pay_url` (where a customer is sent to pay, with `{ref}` for the reference to pay under), or `provider: hosted-checkout` with `api_key_env` and `webhook_secret_env`. |
| `reconcile_minutes` | How often unpaid and stuck workspaces are looked at. Default 15. |

**What the check refuses**, because none of it can be seen from outside once the service is running:

- *A workspace domain that shares the app's registrable domain.* A workspace runs a customer's code. A page on a sibling address
  can set cookies for the whole domain, and so can set cookies for the app, or fill the app's requests with cookies until the
  server refuses them. The workspace domain must be one of its own (`curule-ws.example` beside `app.curule.example`). The
  check compares the last two labels, which is right for most domains and conservative for the rest.
- *A licence key the build does not trust.* A workspace verifies its licence offline against the public keys in
  `packages/licensing/src/keys.ts`. If the key the service signs with is not the one whose public half is there, every
  workspace would read its licence as invalid and run on the Community plan, whatever was paid for. The check signs a
  licence and verifies it against the build.
- *The local provisioner in production.*
- A hosted checkout for a catalogue in which a plan has no `provider_price_id`, listeners on the same address, and the
  owner API open to every interface (allowed, and warned of).

**Two listeners.** The public one serves the app's host (the API, and the pages when there are any), every workspace host
(through the edge), and `/healthz` on any host, for a load balancer that asks by address. A request for any other host is
answered 404. The owner's is a separate listener behind its own token: keep it off any network a customer can reach.
TLS is terminated in front of both; the service speaks plain HTTP.

**Starting and stopping.** At start the service opens the log (one process holds it), listens, and runs the checks at once,
so a workspace that was being made when the last process ended is looked at now and not after the first interval. A check that
is still running is not started again, and one that fails is logged and the timer goes on. On `SIGINT` or `SIGTERM` it stops
taking requests, gives the ones in flight ten seconds and then ends them (an open event stream included), waits for
workspaces that are being made for the same time (what is not finished is looked at at the next start), and closes the log.

## The public API

Every answer is JSON, with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a `default-src 'none'` content
security policy, and `Cross-Origin-Resource-Policy: same-origin`. No answer is open to another site's script: there is no CORS
header and a preflight is not answered.

| Method and path | Needs | Does |
|---|---|---|
| `GET /healthz` | | 200 while the log can be written, 503 when it cannot. Not counted against an address. |
| `GET /api/plans` | | The plans and top-ups on offer: price, period, included usage, workspaces and tiers. Nothing of how they are paid for. |
| `POST /api/signup` `{email, password}` | | Always 202 with the same words, for an address that has an account and one that has not. The difference is in the mail. |
| `POST /api/verify` `{token}` | | Confirms the address from a mailed link, once, and signs the person in. |
| `POST /api/login` `{email, password}` | | Signs in. Every way it can fail is one answer, the same in status, body and headers. |
| `POST /api/logout` | | Ends the session and clears the cookie. |
| `POST /api/forgot` `{email}` | | Always 202. Mail goes only to an address with a confirmed account. |
| `POST /api/reset` `{token, password}` | | Chooses a new password from a mailed link, once. Every session ends. |
| `POST /api/password` `{current, next}` | session | Changes the password. Every other session ends; this one stays. |
| `GET /api/me` | session | The account (plan, workspaces, with a status and a reason) and its balance. |
| `GET /api/usage` | session | What was used, by day and by workspace, and what it was charged. What a call cost the service and what was made on it are not in any answer. |
| `POST /api/checkout` `{purpose, plan \| amountMinor}` | session | The address to pay at, for a plan or a top-up. Asking twice for the same thing on the same day is the same checkout. |
| `POST /api/portal` | session | The provider's page for managing what was paid for. |
| `POST /api/workspaces` `{name}` | session | Makes a workspace, answering at once as `provisioning`. |
| `POST /api/workspaces/:id/open` | session | A link, good for a minute and once, that trades for the workspace's cookie. |
| `POST /api/workspaces/:id/suspend`, `resume` | session | Stops and starts it. Starting needs the plan to be paid. |
| `POST /api/workspaces/:id/delete` `{confirm}` | session | Deletes it and its data, when `confirm` is its name. |
| `POST /webhooks/billing` | signature | The payment provider's messages. |

A workspace that is not the caller's, and one that does not exist, are the same 404 for every action.

**A cookie is never enough for a change.** Every POST that has a body says it is JSON, which a form on another site cannot, and
a POST that carries the session cookie must also name this service's own address as its `Origin`. The session cookie is
`HttpOnly`, `SameSite=Lax`, host-only, and named `__Host-curule_session` on HTTPS, which browsers refuse to accept from any
other host or for a wider path.

**Limits.** A limit is the most in any span of the window, not in a bucket that a burst can straddle. They live in memory in one
process: they brake guessing and mail, and are not a record.

| What | Limit |
|---|---|
| Sign-ups, from one address / for one email | 10 an hour / 3 an hour |
| Sign-in attempts, from one address / at one email | 30 / 10 in ten minutes |
| Reset requests, from one address / for one email | 10 an hour / 3 an hour |
| Links tried (confirmation and reset share it), from one address | 30 an hour |
| Everything else, from one address | 600 a minute |
| What costs something (checkout, portal, usage, workspaces, a password change), per session | 60 an hour |

An email is limited as it will be read, so another case or a space buys nothing. A sign-up or reset that sent no mail (a
mistyped address, a weak password) is not counted, and a limit says how long to wait in a `Retry-After` header and in words.
A sign-in that works clears the count for its email, and so does a completed password reset, because a link that came to the
mailbox says more than a password does: someone who knows only an address can make a person's sign-ins wait ten minutes by
guessing, but cannot keep them out. Their open sessions and workspaces are not affected.

**The payment provider's messages** are read only after their signature is checked over the exact bytes received, and the
signature is the whole credential. A message that is refused is answered `400` with words that say nothing about why, and the
reason is logged. One that could not be applied is answered `500`, so the provider sends it again; applying is idempotent by the
payment's own reference.

## The edge: a workspace at its own address

A workspace has no public address. It is served at `<slug>.<workspace domain>` through the control plane's proxy.

1. **Getting in.** The account page asks to open a workspace and is given a one-time link, good for a minute, to
   `https://<slug>.<domain>/__enter?code=…`. That address trades the code for a cookie of its own, `__Host-curule_ws`, which is
   signed by the service, host-only, `HttpOnly`, `SameSite=Lax`, and good for twelve hours. It says which account, workspace
   and session it was given for, and holds nothing that can be used anywhere else.
2. **Every request is asked again.** The control log says whether that session is still a session and that workspace is still
   the account's. Signing out, a new password, a stopped account and a deleted workspace end access at once, and a restart of the
   service signs nobody out. A response that is still open (an event stream, which may last for days) is looked at again every
   15 seconds and ended when its access has ended.
3. **Credentials are swapped.** The host takes one credential, its operator token, which the proxy presents and the browser
   never sees. Every cookie, `Authorization` header and `X-Mesh-Token` the browser sent is dropped, and so is everything that says
   who the caller is (`X-Forwarded-*`, `Forwarded`, `X-Real-IP`); the host is told the caller's address as the service saw it.
   Cookies the host sets are dropped on the way back. Headers that belong to one hop are not passed on.
4. **A change must come from the workspace's own page.** A non-GET request that names an `Origin` other than the workspace's own
   address is refused, which is what stops a page on a sibling address from acting with the cookie.
5. **A workspace that cannot answer says so.** A stopped or failed one gets a page that says why and when to come back
   (`503`, `Retry-After: 30`), and a host that does not answer is a `502`; a browser gets a page, and a script gets JSON. Someone
   with no cookie is told nothing of the workspace's state.
6. **It streams.** The dashboard's event stream passes through as it is produced, and may be quiet for as long as it likes after
   the host has begun it. A browser that goes away takes the request to the host with it. Uploads are capped (64 MiB by
   default), whether or not the caller says how large they are.

Security headers the host does not set are added (`nosniff`, `Referrer-Policy: no-referrer`, `Strict-Transport-Security`, and
`X-Frame-Options: SAMEORIGIN` unless the host says how it may be framed). WebSocket upgrades are not proxied; the dashboard does
not use them.

## The owner API

A separate listener, behind a bearer token. What it does is different in kind from what a customer can do: record that money
arrived, stop a customer, read every account. A wrong token is counted by address (20 in ten minutes), a right one is counted
against nobody. It returns no credential and no hash, and every change is an entry in the control log under `owner.action`.

| Method and path | Does |
|---|---|
| `GET /owner/health` | Whether the log can be written, how many accounts there are, workspaces by status, and unmatched payments. |
| `GET /owner/accounts?q=&limit=` | Accounts, oldest first, filtered by part of an email or an id; up to 200, the newest kept, with a note when the list was cut. |
| `GET /owner/accounts/:id` | One account as its owner sees it, with its balance. |
| `POST /owner/accounts/:id/disable` `{reason}`, `enable` | Stops an account (it cannot sign in, its sessions end, its running workspaces stop) or starts it again. Starting does not start what was stopped. |
| `POST /owner/payments` `{accountId, purpose, plan?, amountMinor, currency, ref, note?}` | Records a payment that arrived some other way, applied as a provider's message is: once, by `ref`. |
| `GET /owner/unmatched` | Payments that were received and could not be placed, with how much and in what. |
| `GET /owner/margin?from=&to=` | What came in, by currency and kind, beside what the models cost, for a period. |
| `POST /owner/reconcile` | Runs the checks on workspaces now and says what they did. |
| `GET /owner/workspaces?status=` | Workspaces and their status. |
| `POST /owner/workspaces/:id/suspend` `{reason}`, `resume`, `destroy` | Stops, starts and deletes a workspace by its id. |

## What the operator sees

- **Unmatched payments**: what was received and could not be matched, with the reason.
- **Margin**: for a period, what came in by currency (plan payments, top-ups and refunds, each counted once; unmatched and
  foreign-currency payments are not revenue) beside what the models cost and what was charged for the same time, from the
  gateway's ledger. The two are in different currencies when the catalogue and the gateway are, and are not converted: the
  operator has their own rate.
- **The log**: every owner action (a payment recorded, an account stopped or started) is an entry in it.

## What only the operator can do

| Needs | Because |
|---|---|
| A payment provider and the entity that takes the money | Which provider can take payment depends on where the company is established and where its customers are. |
| The adapter's check in the provider's test mode | The adapter has not met the live service. |
| A mail service | The control plane writes mail to an outbox file and sends none. An adapter for a mail service is a few lines behind the `Mailer` interface. |
| An infrastructure account, the network and the egress proxy | Container isolation is only as good as the network around it. |
| A domain for workspaces, separate from the app's, and TLS for both | The control plane speaks plain HTTP and serves `<slug>.<domain>` for every workspace, so the certificate is a wildcard for that domain. |
| The licence signing key, and its public half in the build | See above. |
| A commercial agreement with each model provider the gateway routes to | The gateway is provider-neutral, but resale is allowed only where the provider's terms allow it. |
| Prices | The catalogue and the price table are the operator's. |

## Tests

`tests/cloud/` has the control plane's tests, and each module's are mutation-checked: a change to the code that no test
notices is a gap in the tests. The public API and the owner API are tested as plain functions of a request, and again over
real sockets; the edge is tested against a host that records what it is asked; and one test runs a customer from sign-up to an
open workspace through the running service, against the real gateway admin API. `tests/ai-gateway/` and `tests/integration/gateway-mission.test.ts` cover the gateway, and a
whole mission through it.
