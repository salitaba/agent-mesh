# The control plane

The control plane is the part of [Curule Cloud](cloud.md) that knows who a customer is, what they have paid for, and which
workspaces they run. It signs people up, turns a payment into credit and a plan, starts and stops each customer's workspace,
and gives the operator a view of the money. It sits in front of the [model gateway](ai-gateway.md) and never holds a model
provider's key.

**Status.** Built and tested (`packages/cloud`, `tests/cloud/`): accounts, plans, the billing port with its two adapters,
workspaces and their provisioners, licences for workspaces, the operator's views, the public API, the proxy that puts each
workspace at an address of its own, the operator's API, and `curule-cloud control`, which runs them. It is exercised against
fakes of everything outside it: a payment provider that answers in its documented shapes, a container engine that records what
it is asked, a gateway that is the real admin API, called over HTTP. The pages a customer sees (sign up, sign in, the account,
the terms and the privacy notice) are built too, in `apps/cloud-server/pages`, and the terms and the privacy notice are
placeholders until the operator writes them ([The account pages](#the-account-pages)). Nothing here has taken a real payment or
started a real container. What each of those needs from the operator is in
[What only the operator can do](#what-only-the-operator-can-do).

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
| `plans.<id>.byok` | `true` for a hosting-only plan: the customer brings their own model key and the service sells no model usage. Such a plan cannot set `included_usage` (other than 0), `tiers` or `default_tier`; a payment grants no credit. |
| `plans.<id>.provider_price_id` | The payment provider's id for this price, where the provider needs one. |
| `plans.<id>.tiers` | The gateway tiers a workspace of this plan may use. Left out, every tier. |
| `plans.<id>.default_tier` | The tier a team in the workspace uses unless a seat names another, one of `tiers` when that is given. Left out, a plan that lists tiers uses `balanced` if it is among them and the first listed if it is not, and a plan with no list leaves the host's own default. The workspace is told it as `CURULE_GATEWAY_MODEL`. |
| `topups.options_minor`, `minimum_minor`, `maximum_minor` | The amounts offered, and the bounds of any other amount. |
| `topups.usage_micros_per_minor` | Model usage one minor unit buys, in millionths of a unit of the gateway's currency. |

Credit has two buckets, as in the gateway. Included credit is replaced each period and spent first. Purchased credit does not
expire. When both are gone the gateway refuses new calls and the mesh pauses once with one clear notice.

### Hosting-only plans (`byok`)

When every plan is `byok`, the service holds no balance, has no top-ups (`topups` is refused), and needs no gateway: leave the
`gateway:` section out of `control.yaml`. `check` and `preflight` say so; a `gateway:` section that no plan uses is a warning.
The first workspace of such a plan is made without models. The customer sets, replaces or deletes their key for a workspace:

| Route | |
|---|---|
| `POST /api/workspaces/:id/model-key` | `{provider, model, key, baseUrl?}`. `provider` is `anthropic` or `openai-compatible` (which needs `baseUrl`, https, public). Answers with the workspace as the customer sees it: which provider, model and base URL, when it was set, never the key. |
| `POST /api/workspaces/:id/model-key/delete` | Removes it. |

The key is write-only. It is read in one place, to start the workspace's host, which is then started again (its data is kept; a turn
in progress is interrupted). It is kept encrypted (AES-256-GCM) in `model-keys.json` beside the control log (`model_keys:` names
another file), mode 0600, with a key derived from `CONTROL_SECRET` and bound to the workspace's id; losing or changing
`CONTROL_SECRET` loses every stored key. The control log holds only `workspace.model_key_set` (provider, model, base URL) and
`workspace.model_key_removed`. A container provisioner passes it to the host as an environment variable of that one container
(`CURULE_MODEL_KEY`, [runtime-native.md](runtime-native.md#hosted-workspaces)), a local one to the child process. Another
account's workspace is answered as not found. A session may set a key 10 times an hour and an account 20. A plan that sells usage
refuses it (`409 not_byok`), and a workspace still being made says to wait (`409 not_ready`).

**Seeing it on one machine.** `curule-cloud trial --hosting-only` runs this mode with nothing real behind it
([cloud.md](cloud.md#try-it-on-one-machine)): the trial's two plans with `byok: true`, no top-ups, no `gateway:` section and no
gateway. A key is for a provider at a public https address, which the control plane and the host each insist on, so a model on this
machine cannot be named in the key form. The trial gives out an address that no one owns, `https://stand-in.example/v1` (`.example`
never resolves), and starts each workspace's host with a preload (`NODE_OPTIONS=--require .../trial-reroute.js`) that sends the calls
made to that address, and to no other, to a stand-in on the port the gateway would have had (the app's port plus 10): an
OpenAI-compatible `POST /v1/chat/completions` (streamed or not) and `GET /v1/models` that answer every call with one sentence, use no
tool, and take any key. Everything between the key form and the host is the real code, so a workspace shows its own key as its models;
a real provider's address and key work too. A folder kept with `--dir` belongs to the kind of trial that made it: starting the other
kind on it is refused. `npm run qa:cloud -- --hosting-only` walks a customer through it, key included.


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
was in progress when the service stopped, and looks at the host of every workspace the log calls running: one that is gone for
good marks the workspace failed, and one that has stopped (a container that crashed, a machine that was restarted, a control plane
restarted over hosts that were its children) is started again, with where it now is recorded, and what keeps it from starting is
said and tried again at the next check.

### Provisioners

A provisioner starts, stops, resumes and removes the host. Two sit behind one interface.

**Local process** is for development and for a single customer on a machine they own. A workspace is a child process with its
own directory, and its credentials are in a file only its owner can read, outside the workspace's projects. What the host
prints is kept in `host.log` beside it, because a host that does not come up has nothing else to say why. A host does not outlive
the control plane: it does not keep the process open, and it is told to end when the process does, however that happens. It
refuses to run when the service is configured as production: an agent's shell is only as isolated as its process, and that is not
isolation between customers. `curule-cloud trial` runs the whole service this way, on one machine
([cloud.md](cloud.md#try-it-on-one-machine)).

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

**A control plane that runs on the machine** and not in a container on the network cannot resolve a container's name: the engine's
name server answers only on its own network. Set `provisioner.subnet` to the subnet the network was made with
(`10.213.0.0/24`), and each workspace is run at a fixed address of it (`--ip`, the first free one from the tenth, which the
engine keeps for a stopped container too and gives up when it is removed), and is reached there. Allocations are made one at a
time, so two workspaces made together do not ask for the same address, and a container that was made and did not start is
removed with its volume. `preflight` compares the subnet with the network's own.

**The egress proxy** is `curule-cloud egress --config egress.yaml`. It carries HTTPS tunnels (`CONNECT`) and nothing else, to the
names the operator lists (`registry.npmjs.org`, or a family such as `*.githubusercontent.com`, which is every name below it and
not the name itself) on the ports listed (443 unless said otherwise). An address given as digits is never a name on the list,
and neither is anything a resolver would read as one (`127.1`, `0x7f.1`). The proxy looks the name up itself and refuses it
when any address it gets is not public (loopback, private, shared, link-local including the cloud metadata address, multicast,
documentation and tunnelling ranges, and IPv4 addresses written as IPv6), and then connects to the address it checked, not to the
name again. It answers only the networks named in `allow_from` and drops a connection from anywhere else without a word; it
refuses to listen on every interface; it bounds the tunnels open in all and from one workspace, the time to connect, the time with
no byte and the longest life of a tunnel; and it writes down who asked for which name and port, never what went through.
`examples/cloud/egress.yaml` is a file to copy.

What it cannot do: it sees the name a tunnel is made to and not what goes through it, so a listed host is a host a workspace can
send anything to. And a workspace container on an internal network may still be able to resolve public names through the
engine's own name server, which is a way to send a little data out that this does not close: whether it is open is for the
operator to find out on their engine (`docker run --rm --network <workspace network> ... nslookup <a name>`).
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
| `workspaces.domain` | Workspaces are served at `<slug>.<domain>`. See below for what it may not be. `allow_same_site: true` beside it accepts, knowingly, a domain under the app's own. |
| `public` | The listener a load balancer connects to: `host`, `port`, and `trust_proxy_hops`, how many proxies in front add to `X-Forwarded-For`. With 0 the header is not read, and behind a proxy every caller then looks like the proxy. |
| `owner` | The operator's listener (`host`, `port`) and `token_env`, the environment variable that holds its token (24 characters or more). |
| `pages` | A directory of account pages: the product's own are in `apps/cloud-server/pages` ([below](#the-account-pages)). Leave it out to serve the API alone. |
| `control_log` | Where the log is written. |
| `mail` | Where mail goes: `smtp`, a server it is delivered to, or `outbox`, a file it is written to. [Below](#mail). |
| `plans` | The plan catalogue, [above](#plans-and-credit). |
| `secret_env` | The service's secret, 32 characters or more. Workspace cookies are signed with a key derived from it, and so is every workspace's operator token. Do not change it while workspaces exist: a workspace was given its operator token when it was made, the proxy presents the one derived from the current secret, and every existing workspace would refuse it. |
| `gateway` | `admin_url` and `admin_token_env` for the [model gateway](ai-gateway.md)'s admin API, and `tenant_url`, the address a workspace is told to call for models. It ends in `/v1`. |
| `licence` | `kid`, and `private_key_file` or `private_key_env`: the key workspace licences are signed with. |
| `provisioner` | `kind: container` with `image`, `network`, an optional `subnet` (the network's own, to give each workspace an address of its own), `egress_proxy`, `no_proxy` and `limits` (`cpus`, `memory_mb`, `pids`), or `kind: local` for a trial. |
| `billing` | `provider: manual` with `pay_url` (where a customer is sent to pay, with `{ref}` for the reference to pay under), or `provider: hosted-checkout` with `api_key_env` and `webhook_secret_env`. |
| `reconcile_minutes` | How often unpaid and stuck workspaces are looked at, and workspaces the log calls running whose host is not. Default 15. |

**What the check refuses**, because none of it can be seen from outside once the service is running:

- *A workspace domain that shares the app's registrable domain.* A workspace runs a customer's code. A page on a sibling address
  can set cookies for the whole domain, and so can set cookies for the app, or fill the app's requests with cookies until the
  server refuses them. The workspace domain must be one of its own (`curule-ws.example` beside `app.curule.example`). The
  check compares the last two labels, which is right for most domains and conservative for the rest. An operator who has only
  one domain can write `allow_same_site: true` under `workspaces`, which turns the refusal into a warning that the check prints
  every time. What then stands in the way of a page in a workspace is two things and no more: the app's session cookie is
  host-only and prefixed `__Host-`, so a sibling address can neither set nor read it, and every change to the app must name
  the app's own address as its `Origin`. What no longer does is `SameSite`: the two are the same site. A page in a workspace can
  still set cookies for the whole domain, which is enough to make a browser's requests to the app too large to be answered.
  It is the operator's to accept, and a domain of its own is the way to stop needing to.
- *A licence key the build does not trust.* A workspace verifies its licence offline against the public keys in
  `packages/licensing/src/keys.ts`. If the key the service signs with is not the one whose public half is there, every
  workspace would read its licence as invalid and run on the Community plan, whatever was paid for. The check signs a
  licence and verifies it against the build.
- *The local provisioner in production.*
- *Pages with a place still marked `TODO(owner)`.* The terms and the privacy notice are what a person agrees to when they sign up
  and pay, and they are the operator's to write. The check reads every text file in the `pages` folder and, in production,
  refuses to start while any carries the marker, naming the first four places; in a trial it is a warning.
- *A mail server that would be sent a password in the clear.* `security: none` with an account, to a server that is not on this
  machine, is refused; without an account it is warned of. Mail held in an outbox file in production is warned of: nothing
  delivers it, and a person who signs up gets no link.
- A hosted checkout for a catalogue in which a plan has no `provider_price_id`, listeners on the same address, and the
  owner API open to every interface (allowed, and warned of).

**Looking at what the configuration points at.** `--check` says whether a file is consistent. `preflight` goes on to look at what the
file names, and says what would fail a customer, so that mistakes in the world around the service are found at deploy time and not
by the first person to sign up:

```bash
npm run cloud -- preflight --config control.yaml [--mail-to you@example.com]
```

Each check is independent, so one that fails does not hide the next, and each answer is `ok`, a `warning` (allowed, and worth reading)
or a `problem` (the service would fail a customer). The exit status is 1 when there is a problem. It sends nothing to a customer; it
asks for the gateway's health, asks the engine to inspect, and makes and removes one empty file in each folder the service writes.
It sends a message only when it is given an address to send it to.

| Looks at | A problem when | A warning when |
|---|---|---|
| The configuration | It is not valid (every problem is listed, and nothing else is looked at) | `--check` would warn of something |
| Folders the service writes (the log, the mail spool or outbox, a trial's workspaces) | A file cannot be made there, or in the nearest folder above that exists | |
| The model gateway (`GET /admin/health` with the admin token) | It cannot be reached, refuses the token, answers something else, says it is not well, lists no tiers, or does not have a tier that a plan lets a workspace use | The ledger is kept in another currency than the plans are sold in; the address workspaces call does not accept a connection from here |
| The container engine, its image and the workspace network | The engine cannot be run, or the network does not exist or is not internal | The image is not here (it is pulled at the first workspace); the egress proxy does not accept a connection from here, or there is none |
| The names customers use | | The app's host, or a name under the workspace domain, does not resolve (the wildcard record) |
| The listeners | | An address cannot be listened on (it may be this service, already running) |
| Mail | With `--mail-to`: the message is not taken | The configuration writes mail to a file |

A network that is not internal is the one check that cannot be a warning: it is the one thing the network is there to prevent. What
`preflight` cannot see from one machine is whether a workspace on the network really has no route to the control plane, to another
workspace or to a cloud metadata address, and whether the certificate covers `*.<workspace domain>`; those are the operator's to prove
from a container on the network and from a browser.

**Two listeners.** The public one serves the app's host (the API, and the pages when there are any), every workspace host
(through the edge), and `/healthz` on any host, for a load balancer that asks by address. A request for any other host is
answered 404. The owner's is a separate listener behind its own token: keep it off any network a customer can reach.
TLS is terminated in front of both; the service speaks plain HTTP.

**Starting and stopping.** At start the service opens the log (one process holds it), listens, and runs the checks at once,
so a workspace that was being made when the last process ended is looked at now and not after the first interval. A check that
is still running is not started again, and one that fails is logged and the timer goes on. On `SIGINT` or `SIGTERM` it stops
taking requests, gives the ones in flight ten seconds and then ends them (an open event stream included), waits for
workspaces that are being made for the same time (what is not finished is looked at at the next start), and closes the log.

## Mail

The control plane sends the link that confirms an address, the link that resets a password, and notices that a payment failed,
that a subscription ended and that a workspace was stopped. Which service delivers it is the operator's choice, and two ways
ship. Both are behind one interface (`Mailer`, in `packages/cloud/src/mailer.ts`), so another can be added without touching
what sends.

Each message names the product in its subject (a stranger's inbox shows it between others), says what to do, and where. What
a person can act on is a link to the account page, and what is said about time is what the service does:

| `kind` | Subject | What it says |
|---|---|---|
| `verify` | Confirm your Curule account | The confirmation link, once, and how long it lasts (24 hours). |
| `reset` | Reset your Curule password | The reset link, once, and how long it lasts (two hours); that the password has not changed if it was not asked for. |
| `signup-existing` | You already have a Curule account | Sent when someone signs up with an address that has an account: links to the sign-in and the forgotten-password pages, and no token. |
| `payment-failed` | A Curule payment did not go through | How many days the workspaces keep running (the grace period, three), that they are then stopped and not deleted, and the account page to update the payment details at. |
| `subscription-ended` | Your Curule subscription has ended | That the workspaces are stopped, how many days the data is kept before it is deleted (the retention period, 30), and the account page to subscribe again or delete them at. |

**An outbox file** (`mail.outbox`) delivers nothing. Each message is appended to the file as a JSON object on a line, readable
by its owner alone, for something of the operator's to deliver or for a person to read while trying the service (the
[trial](cloud.md#try-it-on-one-machine) prints each as it is written). In production the check warns of it.

**SMTP** (`mail.smtp`) delivers to any provider that offers it, with nothing but Node's standard library:

```yaml
mail:
  smtp:
    host: smtp.example.com
    port: 587                    # default by security: tls 465, starttls 587, none 25
    security: starttls           # tls, starttls or none; default starttls, or tls when the port is 465
    user_env: SMTP_USER          # the account and its password, both or neither
    password_env: SMTP_PASSWORD
    from: "Curule <no-reply@example.com>"
    hello: curule.example.com    # what this machine calls itself in EHLO; default its host name
  spool: ./data/mail             # where mail waits; default a folder `mail` beside control_log
```

`host` is a name or an address with no port and no scheme. `from` is an address, or a name and an address in angle brackets.
The account and password are read from the environment and are never in the file, the check, or a message.

*The connection.* `tls` is encrypted from the first byte. `starttls` starts plain and is upgraded before anything private is said;
the server's list of what it offers is asked for again afterwards, because what was said before the upgrade is not to be relied
on. A server that does not offer STARTTLS when it is asked for is an error and nothing is sent. The certificate is verified
against the system's authorities and its name is checked; there is no setting that turns this off (an internal authority is
added with `NODE_EXTRA_CA_CERTS`). A password is never sent over a connection that is not encrypted, unless the server is on
this machine (`localhost`, `::1` and the `127.` addresses, and not a name that merely begins with `127.`). Sign-in is `AUTH PLAIN`,
or `AUTH LOGIN` when that is all the server offers.

*The message.* Nothing that reaches a header or a command is trusted: an address, a subject or a sender with a line break is
refused before any connection is made, which is how an address becomes a way to send other mail. A domain that is not ASCII is
sent as its ASCII form (`bücher.de` as `xn--bcher-kva.de`); an address whose part before the `@` is not ASCII needs an extension
this does not use, and is refused. The text is UTF-8, sent as quoted-printable; a subject or a name that is not plain ASCII
is sent as RFC 2047 words, cut between characters. Every message carries `Auto-Submitted: auto-generated`, so that an
out-of-office reply does not answer it.

*The queue.* A confirmation link is sent while a person waits, and a provider that is slow or down must not make sign-up slow or
fail, nor a restart at the wrong moment lose the link. So the control plane does not send: it writes the message to the spool
and returns, and a worker delivers it.

```
<spool>/queue/<id>.json    a message waiting; written whole to another name, synced, and renamed into place
<spool>/failed/<id>.json   a message set aside, with the reason and how many times it was tried
<spool>/sent.jsonl         a line for each message delivered or set aside: when, to whom, what for. Never the text
```

A message holds a link that signs someone in, so it is kept no longer than it is needed: when a message is delivered its file
is removed, and nothing on disk keeps the text. Files are readable by their owner alone. A message is delivered at least once:
one that was being sent when the process ended is sent again at the next start, and can arrive twice; one that was queued is not
lost. Order is not promised.

What is done about a failure depends on whose it is:

| The server said | Meaning | What happens |
|---|---|---|
| A 5xx answer to the recipient (`550 no such user`) | The recipient cannot be sent to | Set aside at once, and not tried again |
| The connection failed or went quiet, the greeting or EHLO was refused, STARTTLS or the certificate failed, the sign-in was refused, the sender was refused, any 421 | Trouble in reaching or using the service, which the operator puts right | Nothing is tried for a while, for any message, and the wait doubles with each failure: one probe goes to a service that is down, not one for every message waiting |
| Any other refusal (a 4xx to the recipient, a refusal of DATA or of the message) | This message, for now | This message is tried again after a wait that doubles; the others are not held back |

The waits are 30 seconds, doubling to 15 minutes. A message that has not been delivered after 24 hours is set aside, because the
link in it has expired. A customer whose confirmation link was set aside asks for another by signing up again, or by signing
in with the right password; one whose reset link was set aside asks for the reset again.

*What the operator sees.* `GET /owner/health` has `mail`: how many messages are queued, how many were set aside and are in `failed/`,
when the oldest was queued, and what the last failed try said until a delivery works. `ok` is false while the oldest message has
waited more than an hour (`mail.stuck`), because then no one is being told to confirm an address or that a payment failed. The
process log says what happened to a message by its name and kind, and never by its address or its words. To clear a message that
was set aside, remove its file.

*Checking it.* Mail is proved before the first customer asks for a link, and before the rest of the service is ready:

```bash
npm run cloud -- mail-check --config control.yaml --to you@example.com
```

It reads only the `mail` settings, sends one message now through the server the file names (not through the queue), and says
what the server answered, apart for a recipient it will not take, a message it will not take, and trouble with the server itself
(its address, the encryption, the account). Then look in the inbox, and in the spam folder: a message from a sender that is
new is often put there until the sending domain has SPF and DKIM records, which the mail provider tells you how to add.

*What this does not do.* It does not hear of a message that the provider accepted and bounced later: that comes back to the
sending address, as the provider sets it up. It does not set up the sending domain's SPF, DKIM or DMARC records, which belong to
the domain. It sends plain text, from one address. A provider that offers only an HTTP API and no SMTP needs an adapter behind
`Mailer`; the queue works over any `Mailer` whose errors say, as `DeliveryError` does, whether the message is refused for good and
whether the trouble is with the service.

## The public API

Every answer is JSON, with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, a `default-src 'none'` content
security policy, and `Cross-Origin-Resource-Policy: same-origin`. No answer is open to another site's script: there is no CORS
header and a preflight is not answered.

| Method and path | Needs | Does |
|---|---|---|
| `GET /healthz` | | 200 while the log can be written, 503 when it cannot. Not counted against an address. |
| `GET /api/plans` | | The plans and top-ups on offer: price, period, included usage, workspaces and tiers, and the `policy` the pages quote: how long a session and a link last, how long workspaces keep running after a payment fails, and how long they are kept after a subscription ends. Nothing of how plans are paid for. |
| `GET /api/session` | | Who the browser is signed in as: `{account}` with the plan and the workspaces, or `{account: null}`. It is what every page asks to draw its header, so it reads no balance, and it is not a 401 for a visitor. |
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

## The account pages

`apps/cloud-server/pages` is what a customer sees: the front page (the plans, what a top-up buys, how billing works), sign up, sign
in, the page the confirmation link opens, forgot and reset, the account, the terms and the privacy notice. They are plain HTML,
one stylesheet and one script, with no build step and nothing loaded from another address. The control plane serves them at
fixed paths (`/`, `/signup`, `/login`, `/verify`, `/forgot`, `/reset`, `/account`, `/terms`, `/privacy`) and the assets by
name; a path that is not on that list is never looked for on the disk. A browser that follows a wrong address (it asks for HTML) is
shown `404.html` with the status 404, and a program, or any address under `/api`, `/owner` or `/webhooks`, still gets the JSON
error. The colours and the type are the site's.

- **They are written for the policy they are served under**: `default-src 'self'`, `script-src 'self'`, `style-src 'self'`,
  `frame-ancestors 'none'`. No inline script, no inline style, no handler attribute, no address of another site. A test reads
  every page and fails on any of them. The script builds everything it shows from text nodes and elements, never from a string
  of markup, so a workspace named like markup is a name.
- **The account knows where the customer is.** A card at the top says the one thing the account is waiting for and offers one
  action: choose a plan, make the first workspace, add the model key (a plan that sells hosting only), open the workspace, resume
  it, or update the payment details when the last payment failed. While a person is getting started it shows the steps (Plan,
  Workspace, Model key where there is one, Open) and which one they are at; the key comes after the workspace because it can only be
  given to a workspace that has started. `stageOf` and `nextStepOf` in `assets/app.js` decide the stage and the words from
  `GET /api/me` and `GET /api/plans`, and are tried on tables. The rest of the page follows the stage: workspaces are listed once
  there is one, each as a card (its state and a sentence on why and what can be done, Open, Pause or Resume, Delete behind More
  and away from Open with its name typed, and its address as a quiet detail); the plan is shown once, with the others behind
  Change plan; the balance, what a top-up buys and the usage by day and by workspace (as what was charged) are shown only for a
  plan that sells model usage; the password is a setting at the end. On a plan that sells hosting only each card also holds its
  model key: which is kept (Replace key and Remove key), or that there is none, with the form open. A workspace that is stopped
  because a payment is missing has no Resume, which the service would refuse; it is started when the payment comes. A workspace
  that is starting offers "Open it when it is ready", off until the person ticks it: the page then opens it as soon as it is
  running (and, on hosting only, has its key) and the tab is in front. A workspace that is starting is looked
  at again every few seconds, for ten minutes, and the page says when it has stopped looking. A payment is made on the provider's
  page, and the account is where it returns to: what the account looked like before leaving is kept in the tab, so a payment that
  was applied while the person was away is said to have arrived, and one that has not been is waited for for a minute and then
  said to be on its way. The balance is shown rounded down.
- **They help the person at them, and only with a script.** The main button of a form says what it is doing while the call is out
  (`data-busy` in the markup: Signing in, Creating account, Sending, Saving, Changing) and is itself again afterwards; a password
  field has Show and Hide, which the markup carries hidden, so a browser that runs no script shows no control that does nothing, and
  a password that was shown is hidden again when it is sent; the heading and the tab's title follow what the page has become (a sent
  link is "Check your email", a failed check "That link did not work", a changed password "Password changed"); and on a device with
  a mouse the cursor starts in the first field, while a finger's page is left alone, because a keyboard that opens by itself covers
  the page it opened for.
- **What a page says about a period is the service's own setting.** How long a session or a link lasts, how long workspaces keep
  running after a payment fails and how long they are kept after a subscription ends are options of the control plane;
  `GET /api/plans` returns them as `policy`, the pages fill them in (`data-policy`), and a test fails if a page states one as a
  fixed number.
- **The terms and the privacy notice are the operator's text.** They state what the software does (what it keeps, who receives what)
  and the operator's own commitments: who the operator is, refunds and tax, the acceptable-use list, liability, the processors and a
  contact. They say plainly that a lawyer has not reviewed them and that the governing law is not set, and they are not legal advice.
  A place that still needs the operator's decision is marked `TODO(owner)`, and the check [refuses to start a production
  service](#running-it) while any marker is left. The footer's contact link stays hidden until `CONTACT` in `assets/app.js` is given
  an address.
- **To change them, copy the folder** and name the copy in `pages`. The files are the product's, so the colours, the logo and the
  words can all be yours; what must stay is the `id`s and `data-` attributes the script looks for (a test compares each page with
  the list at the top of the script) and the absence of anything inline.
- **How they are tested.** The files by `tests/cloud/pages.test.ts`: what is in the folder and what serves it, the policy, the
  markup the script needs, every link and every call the script makes, the colours and their contrast, and the numbers. The script
  by `tests/cloud/pages-app.test.ts` and `tests/cloud/pages-stage.test.ts` (the stage of an account, what the card says, and what is
  shown), which run it unchanged on the real files in a small DOM with a service that answers as each test says. And in a real
  browser, at three widths and in both colour schemes, with an accessibility scan, against a control plane started for the purpose;
  that pass is not part of `npm test`.

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
| `GET /owner/health` | Whether the log can be written, how many accounts there are, workspaces by status, unmatched payments, and what the [mail queue](#mail) holds. `ok` is false when the log cannot be written or mail is stuck. |
| `GET /owner/accounts?q=&limit=` | Accounts, oldest first, filtered by part of an email or an id; up to 200, the newest kept, with a note when the list was cut. |
| `GET /owner/accounts/:id` | One account as its owner sees it, with its balance. |
| `POST /owner/accounts/:id/disable` `{reason}`, `enable` | Stops an account (it cannot sign in, its sessions end, its running workspaces stop) or starts it again. Starting does not start what was stopped. |
| `POST /owner/payments` `{accountId, purpose, plan?, amountMinor, currency, ref, note?}` | Records a payment that arrived some other way, applied as a provider's message is: once, by `ref`. With no `plan` (or null, or empty) a subscription payment goes to the plan the account has; a `plan` that is not text is refused. |
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

The order in which these are done, and what each step proves, is in [cloud-go-live.md](cloud-go-live.md).

| Needs | Because |
|---|---|
| A payment provider and the entity that takes the money | Which provider can take payment depends on where the company is established and where its customers are. |
| The adapter's check in the provider's test mode | The adapter has not met the live service. |
| A mail service and its account, and the sending domain's records | The control plane delivers over SMTP to the server the operator names. The account, the address mail is sent from, and the domain's SPF and DKIM records are the provider's and the operator's, and `mail-check` is how they are proved. |
| An infrastructure account, the network and the egress proxy | Container isolation is only as good as the network around it. |
| A domain for workspaces, separate from the app's, and TLS for both | The control plane speaks plain HTTP and serves `<slug>.<domain>` for every workspace, so the certificate is a wildcard for that domain. |
| The licence signing key, and its public half in the build | See above. |
| A commercial agreement with each model provider the gateway routes to | The gateway is provider-neutral, but resale is allowed only where the provider's terms allow it. |
| Prices | The catalogue and the price table are the operator's. |

## Tests

`tests/cloud/` has the control plane's tests, and each module's are mutation-checked: a change to the code that no test
notices is a gap in the tests. The public API and the owner API are tested as plain functions of a request, and again over
real sockets; the edge is tested against a host that records what it is asked; mail is tested against a server of the tests' own that speaks SMTP (and, for the certificate checks, a real TLS handshake with a certificate made by `openssl`, skipped where it is not installed); and one test runs a customer from sign-up to an
open workspace through the running service, against the real gateway admin API. `tests/ai-gateway/` and `tests/integration/gateway-mission.test.ts` cover the gateway, and a
whole mission through it.
