# The control plane

The control plane is the part of [Curule Cloud](cloud.md) that knows who a customer is, what they have paid for, and which
workspaces they run. It signs people up, turns a payment into credit and a plan, starts and stops each customer's workspace,
and gives the operator a view of the money. It sits in front of the [model gateway](ai-gateway.md) and never holds a model
provider's key.

**Status.** The core is built and tested (`packages/cloud`, `tests/cloud/`): accounts, plans, the billing port with its two
adapters, workspaces and their provisioners, licences for workspaces, and the operator's views. It is exercised against fakes
of everything outside it: a payment provider that answers in its documented shapes, a container engine that records what it
is asked, a gateway that is the real admin API called in process. Nothing here has taken a real payment or started a real
container. What each of those needs from the operator is in [What only the operator can do](#what-only-the-operator-can-do).

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
| The licence signing key, and its public half in the build | See above. |
| A commercial agreement with each model provider the gateway routes to | The gateway is provider-neutral, but resale is allowed only where the provider's terms allow it. |
| Prices | The catalogue and the price table are the operator's. |

## Tests

`tests/cloud/` has the control plane's tests, and each module's are mutation-checked: a change to the code that no test
notices is a gap in the tests. `tests/ai-gateway/` and `tests/integration/gateway-mission.test.ts` cover the gateway, and a
whole mission through it.
