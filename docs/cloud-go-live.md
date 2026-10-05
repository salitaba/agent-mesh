# Going live with Curule Cloud, in order

This is the order in which the parts of [Curule Cloud](cloud.md) are made ready for a first customer, with what each step
proves and what to do when it does not. It assumes the decisions in
[what only the operator can do](cloud-control-plane.md#what-only-the-operator-can-do) have been made: who takes the money and
through which payment provider, where the service runs, which model providers it routes to and on what terms, what the
domains are, what the plans cost, and what the terms and the privacy notice say.

Every step ends in something that can be looked at, and each relies on the one before it. Nothing in this repository has been
run against a real payment provider, mail service, container engine or model provider. The steps that meet one are marked
**first contact**: that is where a mistake in an assumption shows first, so each says what to look at.

## 1. The licence key

```bash
node tools/license/mesh-license.mjs keygen --kid k1 --out ~/secrets/mesh-license-k1.pem
```

The private key stays where only the operator can read it. The public key it prints goes into
`packages/licensing/src/keys.ts`, before the build: a workspace is built from this repository and accepts only licences signed
by a key its build trusts, and without one it runs on the Community plan's limits whatever the customer paid. The control
plane's check refuses a production configuration whose licence key the build does not trust.

## 2. The build

```bash
npm ci
npm run build
npm test
```

This shows that the checkout is whole on the machine that will run the service. The workspace image is built from the same
checkout (`Dockerfile`); make it available to the container engine, or the first workspace's start pulls it, which is slow
and fails if the registry wants a sign-in (`preflight` says which in step 6).

## 3. The models (first contact)

For each provider and model that a tier will use, write the provider into a scratch `mesh.yaml` as
[runtime-native.md](runtime-native.md) shows, and prove it:

```bash
export MAIN_API_KEY=...
curule providers check mesh.yaml --model main/MODEL-ID
```

The check makes one small call with a tool, as a seat would. A model that answers in text instead of calling the tool fails,
because a seat acts by calling tools and cannot use it. The provider's terms must allow supplying its models to customers
([cloud.md](cloud.md#what-is-not-done-and-not-claimed)).

Then `gateway.yaml` and `prices.yaml`, starting from `examples/cloud/`: each provider names the variable its key is read from,
each tier is a chain of models, and every model has a price. The example's prices are placeholders: replace each with the
price on the provider's own price page, and write the date in `version`. A customer is charged what a call cost times the
markup, so a wrong price is a wrong charge. Read what `--check` prints for each tier.

```bash
npm run cloud -- gateway --config gateway.yaml --check
npm run cloud -- gateway --config gateway.yaml
curl -s -H "authorization: Bearer $GATEWAY_ADMIN_TOKEN" http://127.0.0.1:8081/admin/health
```

The health answer should say `ok: true`, `writable: true`, the currency of the plans, and every tier the plans name.
[ai-gateway.md](ai-gateway.md) has the rest.

## 4. The configuration

Copy `examples/cloud/`, write the plans and their prices, set the environment variables the file names, and check it:

```bash
npm run cloud -- control --config control.yaml --check
```

The check reports every problem at once and, in production, refuses what cannot be seen from outside once the service runs
([the list](cloud-control-plane.md#running-it)). Until it passes, nothing else is worth starting.

The terms and the privacy notice in `apps/cloud-server/pages` carry `TODO(owner)` wherever the operator has to write or confirm
something: who the company is, where, how to reach it, what it keeps and for how long. The software cannot write them, and a
production service is not started while any remain. They are the operator's text, with whatever advice the operator takes.

## 5. Mail (first contact)

```bash
npm run cloud -- mail-check --config control.yaml --to you@example.com
```

It sends one message through the configured server and says what the server answered. Then look in the inbox, and in the spam
folder: a message from a sender that is new is often put there until the sending domain has SPF and DKIM records, which the
mail provider tells you how to add. Do not go on until a message from this address reaches an inbox. A customer who cannot
receive the confirmation link cannot sign up. [The mail section](cloud-control-plane.md#mail) says what happens to a message
when the provider is down.

## 6. The machine (first contact)

The container engine, the internal network, the egress proxy, the names and the certificate are the operator's to build
([provisioners](cloud-control-plane.md#provisioners)). The repository ships the egress proxy (`npm run cloud -- egress`) and, with
`provisioner.subnet`, the way for a control plane that runs on the machine to reach each workspace at an address of its own. On a
machine where the services are processes and the workspaces are containers, the services that workspaces call (the gateway's tenant
port, the egress proxy) listen on the network's own address, and the host's firewall must let a workspace reach those two ports and
no other: the engine adds no rule about traffic from a container to the machine itself, so without one a workspace can reach every
service the machine has on any address. Then:

```bash
npm run cloud -- preflight --config control.yaml --mail-to you@example.com
```

Run it until it finds no problem, and read each warning: it says what it would be a problem for. Its exit status is 1 when a
customer would be failed.

It cannot see two things from one machine, and both are the one thing the network is there to prevent. From a container on the
workspace network, try to reach the control plane, another workspace's container, and the cloud metadata address
(`169.254.169.254` on the large clouds): each must fail. And from a browser, open `https://anything.<workspace domain>`: the
certificate must cover the wildcard.

## 7. Payments in the provider's test mode (first contact)

Work through the [adapter notes](cloud-control-plane.md#adapter-notes-the-hosted-checkout-adapter) with the provider's test
keys: the price id of each plan, the webhook at `/webhooks/billing` on the app's address, and the events it is subscribed to.
Then make a test payment for each plan and for a top-up, and look at what each did:

- `GET /owner/accounts/:id` shows the subscription (plan, status, end of the period) and the balance;
- `GET /owner/unmatched` is empty;
- a test refund takes back the credit a top-up bought, and a failed payment makes the subscription past due and sends one
  notice.

A provider whose API is not the one the adapter was written for needs another adapter behind the same port. Until it exists,
manual billing opens the service: the customer is sent to a page of the operator's own and pays by invoice or transfer, and the
operator records the payment with `POST /owner/payments`.

## 8. A rehearsal as a customer

With a real address and the provider still in test mode, do what a customer does: sign up, follow the link in the mail, choose a
plan, pay, open a workspace, make a team on each tier that is sold, run a mission, read the usage in the account, pause the
workspace and resume it, delete it. Watch while you do:

- `GET /owner/health`: `ok` is true;
- `GET /owner/margin`: what came in, beside what the models cost for the same time;
- the process logs of the control plane and the gateway: nothing at the `error` level that you did not cause.

This is the step that shows whether the pieces agree with each other, which no part's tests can. `npm run qa:cloud` walks the
same path in a real browser against a trial; it reads the confirmation link from the outbox file, so it cannot be pointed at a
service that sends mail.

## 9. Opening

Change the provider to its live mode (keys, webhook secret, price ids), make one payment with the operator's own card at the
lowest price, look at it as in step 7, and refund it. Then the service can take customers.

The marketing site does not offer the service until it is told where it is. Its pages ship saying that Curule is software you
run, with no sign-in or sign-up link (a page must not point at something that is not there). Once the app is reachable, tell the
site its address and publish the site again:

```bash
npm run site:domain -- curule.dev --contact hello@curule.dev --cloud-url https://app.curule.dev
```

Every page then has "Sign in" and "Get started" in its header, which lead to the app's sign-in and sign-up pages (the app sends a
visitor who is signed in already on to the account), the home page says Curule is also run for you, and the sentences that said it
is not give way. Prices are not copied into the site: the app's front page lists the plans from `/api/plans`, and "See the Curule
Cloud plans" goes there. [The site's README](../site/README.md#the-way-into-curule-cloud) has what changes, page by page. Open the
site in a browser with the service live, follow "Get started" to the end, and look at what the visitor sees.

## 10. Keeping it

Watch `GET /owner/health` (`ok` is false when the log cannot be written or mail has been stuck for an hour),
`GET /owner/unmatched` (a payment that was received and could not be placed), and the margin.

What is kept is plain files: the control log, the gateway's ledger, the mail spool (the messages that are waiting), and each
workspace's state volume (`/data` in its container). Each log is append-only and written by one process at a time. A last line
cut short by a crash is dropped when the file opens, and a line that cannot be read anywhere else stops the start rather than
being skipped, because a record of money or of what was granted is not skipped; so restoring a log is putting a copy of the
file back before the process starts. A restore that has not been tried is not a backup: try it before opening.

## What this does not cover

The control plane and the gateway each run as one process; running more of either, a second region, a cluster scheduler, and a
microVM per workspace are not built. No customer has used the service, so what it needs under real load is not known.
