# Licences and plan limits

How a customer proves what they bought, how the product behaves around it, and how you issue and manage
licences. For the price list see [pricing.md](pricing.md). What makes the limits binding is legal, not technical:
the source licence below and, for the paid plans, the commercial licence agreement the customer signs, which is not
part of this repository.

## The source licence

The code in this repository is under the [Business Source License 1.1](../../LICENSE): public and readable, but
**source-available, not open source**. In plain words (the licence text governs wherever they differ):

- **You can read, build, modify and run it**, and use it for anything that is not production, at any size.
- **Production use is free within the Community plan's limits** ([pricing.md](pricing.md)). The licence's
  *Additional Use Grant* spells those limits out, and `tests/build/source-licence.test.ts` keeps its numbers equal to
  the plan table.
- **Beyond those limits you need a commercial licence**: that is what the paid plans are. The licence does not define
  "production"; if you are not sure whether a use is, ask (the contact is in [LICENSE](../../LICENSE)).
- **Two conditions apply to every production use**: do not take the licence-key check out or work around it, and do
  not provide the software to third parties as a hosted or managed service, or embed it in a product or service you
  provide to them. Those uses need a commercial licence.
- **Each version becomes Apache 2.0 four years after it is published.** From then on that version is open source;
  newer versions keep their own date.
- **Earlier versions stay MIT.** Everything up to and including commit `d03781c336a4081a446e8e9977fe15011bf66479` was
  published under the MIT licence, and whoever received it keeps those rights. The Business Source License applies
  from the next commit.

Anthropic's Agent SDK, which the agents run, is Anthropic's and is not covered by this licence
([THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md)).

## What a licence is

A licence is one line of text, signed by you:

```
AML1.k1.eyJ2IjoxLCJpZCI6ImxpY18wMDQyIiwiY3VzdG9tZXIiOiJBY21lIFJvYm90aWNzIiwicGxhbiI6InRlYW0i….MEUCIQD…
 │    │  └ the claims, as JSON, base64url                                                  └ an Ed25519 signature
 │    └ which of your public keys checks it
 └ format version
```

The claims say who it was issued to, which plan, when it was issued and when it expires, and optionally a grace
period, negotiated limits that replace the plan's, extra features and a note. The signature is Ed25519 over the
exact bytes of the token.

**It is checked offline.** The public keys are in the build (`packages/licensing/src/keys.ts`). There is no
licence server to run, secure or keep up, nothing phones home, and an air-gapped install verifies a licence the
same way a connected one does.

**It is not copy protection.** The runtime is JavaScript; anyone who can edit it can remove the check. A licence
is how an honest customer shows, and a vendor can verify, what was bought. The contract does the rest: the source
licence above limits free production use to the Community plan and rules out working around the key, and the
commercial licence agreement a customer signs covers everything beyond it. Those, not the check, are what actually
bind a customer to their plan.

## How an install finds its licence

In this order, first one found:

1. `MESH_LICENSE`: the key itself, in the environment.
2. `MESH_LICENSE_FILE`: the path of a file that holds it.
3. `<MESH_HOME>/license.key`, which `ordane license install` writes (owner-readable only).

No licence, or one that does not verify, means the **Community** plan. A running host re-reads its licence every
30 seconds, so installing or replacing one needs no restart.

```
ordane license status [mesh.yaml]     the plan, limits, what is in use (and, given a mesh.yaml, its seat count)
ordane license install <key|file>     verify it, then save it; a key that does not verify is never written
ordane license verify <key|file>      check a key without saving it
ordane license remove                 delete the saved licence: back to Community
```

The dashboard shows the same on *Host settings*, and a banner appears above every view when the licence is
expiring, has lapsed, or more projects are open than the plan allows. `GET /license` (a single mesh) and
`GET /api/license` (a host) return it as JSON, and the metrics carry it (`ordane_license_*`).

## What a limit does

Set by `MESH_LICENSE_ENFORCEMENT`:

| Mode | A limit that is exceeded |
|---|---|
| `warn` (the **default**) | is reported (log, dashboard, API, metrics) and **never refused**. Nothing changes for anyone until you decide it should. |
| `enforce` | stops the thing from **starting**: a mesh with more seats than the plan will not boot, a project beyond the open-project cap will not open (HTTP 403, `license_limit`), an export the plan lacks answers 403 (`license_feature`), and the plan's concurrent-turn cap tightens the host's. |
| `off` | is not checked. |

Two promises hold in every mode, and a test pins each:

- **Nothing that is running is stopped or touched.** `enforce` refuses to start things; it does not stop a mission
  that is half done because a licence lapsed.
- **No data is held hostage.** An expired licence cannot lock anyone out of their own event logs, artifacts or
  workspaces: they are plain files on the customer's own volume, backup and restore work on every plan, and the
  Community plan has no expiry. (The usage *report* is a Team feature; the event log it is computed from is not.)

The checks are: seats per mesh (checked when a mesh starts), projects open at once (checked when one opens),
concurrent turns (the host's cap is tightened to the plan's, only under `enforce`, and never loosened), and the
features `usage-export` (the usage report and `ordane usage`) and `prometheus-metrics`.

## From purchase to expiry

| When | What the install does |
|---|---|
| Valid | the plan's limits. |
| 30 days before expiry | says so: at start, in the log, in the dashboard banner and in `ordane_license_expires_timestamp_seconds`. |
| Expired, in grace (14 days by default; the claims can say 0 to 90) | **keeps the plan's limits** and tells the operator every way it can. A card that lapsed over a weekend is not an outage. |
| After grace | the Community plan. Nothing is deleted; missions, logs and artifacts are as they were. Install a renewed licence and the plan returns within 30 seconds. |

Plan for renewals one licence at a time: the term of a licence is the billing term, so a customer who pays
annually gets a licence that expires a year (plus the grace) later.

## Your side: issuing and managing licences

You need the compiled tool, so `npm run build` first. The private key stays with you; it is not in the repository,
the image or any package, and the tool refuses to write it anywhere readable by others.

### One time

```bash
# 1. Make a key pair. Keep the PEM somewhere only you can read (an offline machine, a hardware key, a secrets
#    manager with an audit log). Losing it means you cannot issue licences; leaking it means anyone can.
node tools/license/mesh-license.mjs keygen --kid k1 --out ~/secrets/mesh-license-k1.pem
#    It prints the PUBLIC key. Paste it into packages/licensing/src/keys.ts:
#        export const LICENSE_PUBLIC_KEYS: PublicKeySet = { k1: "MCow…" };
# 2. Build and release a version that carries it. Until a build has your public key, every licence reads as
#    "unknown-key" and the install runs on Community.
```

### For each customer

```bash
node tools/license/mesh-license.mjs sign --key ~/secrets/mesh-license-k1.pem --kid k1 \
  --customer "Acme Robotics" --plan team --days 365 --id lic_0042 --notes "annual, PO 7781"
# optional: --grace 30, --max-seats 20, --max-projects 8, --max-turns 12, --feature usage-export
```

Send the printed key to the customer; they run `ordane license install <key>` or put it in `MESH_LICENSE`. Keep a
record of what you issued (`id`, customer, plan, expiry, price, who approved it): the tool prints the claims, and
`inspect` reads any token's claims back (without checking its signature), so a customer's key can be matched to
your records when they write in.

```bash
node tools/license/mesh-license.mjs inspect <token|file>
node tools/license/mesh-license.mjs verify <token|file> --public <your public key> --kid k1
```

Every override (`--max-seats`, `--feature`, …) is a promise to support something that is not on the price list.
Use them for contracts, not for convenience.

### Rotating a key

Add `k2` beside `k1` in `keys.ts`, release, and sign new licences with `k2`. Drop `k1` in a later release, once
the licences signed with it have expired. If `k1` is ever exposed, do the same, and re-issue the licences that
are still live: an old build still trusts `k1`, so the customer must also move to a build without it.

### What you cannot do

- **Revoke a licence.** There is no server to ask. Short terms and a grace period are the only lever, which is
  one reason the term follows the billing term. If a licence is shared beyond its customer, the remedy is the
  contract; the claims name the customer, and `ordane license status` shows it.
- **Meter by use.** A licence states limits; it does not count. Usage reports are the customer's to produce
  (`ordane usage`) and yours to ask for if a contract says so.

## For the customer: questions you will be asked

**Does it phone home?** No. The licence check is a signature check on the machine. The runtime makes no calls of
its own except to its own components and to the model provider you configured, and the image tells the Claude Code
binary the agents run to make no nonessential calls (telemetry, update checks).

**Can it run air-gapped?** Yes. A licence needs no network. The agents need to reach your model provider; a
private endpoint (Bedrock or Vertex over a private link, a proxy) works through the usual `HTTPS_PROXY` and
provider settings.

**What if it expires?** See the table above. Nothing stops, nothing is lost, and the limits become Community's
after the grace period.

**Can I move it to another machine or cluster?** Yes. A licence is not bound to a machine. It names the
customer and limits what one instance may do.

**Do you collect usage?** No. `ordane usage` produces a report for you; nothing sends it anywhere.

**Is it open source?** No. The source is public under the Business Source License 1.1, which is source-available: you
can read, modify and run it, it is free for production within the Community plan's limits, and each version becomes
Apache 2.0 four years after it is published. See [The source licence](#the-source-licence).

**Can we host it for our own customers, or build it into our product?** Not under the free grant. That needs a
commercial licence: use the contact in [LICENSE](../../LICENSE).
