# Ordane: name, voice and look

How the product presents itself, so that a page, a talk or a README written by someone new reads like the rest of it.
The files are in [`brand/`](../brand/README.md).

## The name

**Ordane** (pronounced *or-DAYN*, like "ordain") is a respelling of *ordain*: to appoint someone to a role and give
them authority. That is the whole product. Each agent is appointed to a seat, what the seat may do is written down, and
the runtime refuses the rest.

- In prose it is **Ordane**, with a capital O. The command, the package and the container image are lower case:
  `ordane`, `ghcr.io/<owner>/ordane`. It is never ORDANE or OrDane.
- The logo is lower case (`ordane`), because it is drawn, not typeset.
- Before the rename the product was called **Agent Mesh**. That name is retired; do not use it for the product. The
  word *mesh* stays, because it is the product's own word for one running organization: `mesh.yaml`, a *mesh run*, the
  `mesh` command that still works as an alias of `ordane`.

### Words the product uses

| Say | Meaning | Not |
|---|---|---|
| **mesh** | one running organization: its roles, rules, artifacts and event log (`mesh.yaml`) | "the Ordane" |
| **seat** | one role held by one agent in a mesh; plans count seats | "bot", "worker" |
| **agent** | what a seat is, to someone who is new to it | "assistant" |
| **project** | a mesh registered with a host | "workspace" (that is the folder an agent writes in) |
| **host** | the process that supervises projects (`ordane host`) | "server" for the whole product |
| **gate** | a rule the runtime checks before a change counts as done | "check" when it is enforced |

## What to say it is

Use these as they are, or shorter. Every claim in them is one the documents already make and a test or a measured run
supports.

**One line.** Ordane is a runtime for persistent AI organizations: role-based agents that work on your own
infrastructure, under rules the runtime enforces.

**A paragraph.** Ordane runs a team of AI agents like an organization. Each agent has a role and explicit authority; the
runtime refuses what a role may not do; every action is recorded in an append-only log that can be replayed and audited.
It runs on your own infrastructure with your own model credentials, and nothing phones home.

**With the terms.** The Community plan is free for one open project with up to eight agents; the paid plans lift the
limits ([pricing](commercial/pricing.md)). The source is available under the Business Source License 1.1, which is not an
open source licence, and each version becomes Apache 2.0 four years after it is published
([licensing](commercial/licensing.md)).

**The tagline** is *A team of AI agents, run like an organization.* It is set in sentence case with a full stop.

## How it sounds

Plain, exact, evidence first. The documents already read this way; this is what keeps them reading this way.

- **Say what it does, then what it costs or cannot do.** A limit stated next to a claim is what makes the claim believable.
- **A number beats an adjective, and a number has a source.** "A five-seat mission cost $5.50 at list price on Haiku" is
  a sentence. "Dramatically cheaper" is not. Quote the run, the model and the date.
- **Say what failed.** The project keeps the defects its own real runs found
  ([the run notes](../NOTES-live-run-20260930-haiku.md)). Showing the audit trail, including the refusals, is the pitch.
- **Source-available, never "open source".** The licence is BSL 1.1 and the OSI does not call it open source.
- **Name Claude and Anthropic only as what Ordane runs on,** and keep the line the site uses: *Claude and Anthropic are
  trademarks of Anthropic PBC; Ordane is not affiliated with or endorsed by Anthropic.*
- **No** "revolutionary", "seamless", "supercharge", "unleash", "10x", "autonomous workforce". No exclamation marks.

| Instead of | Write |
|---|---|
| "Supercharge your engineering with an AI workforce." | "A team of agents with roles, who may approve what, and a log of everything they did." |
| "Fully autonomous." | "Agents wake on the events they care about; a person is asked when the rules say so." |
| "Enterprise-grade security." | "Seats do not inherit the operator's token, and an agent-written page runs in a sandbox. [What it does not protect.](commercial/security.md)" |
| "Open source." | "Source-available under the Business Source License 1.1." |

## The mark

A **ring with one seat filled**. The ring is the organization, a seat is a role, and the bead on its rim is an agent
appointed to it. In the wordmark the first *o* is the mark, so the name and the sign are one thing.

![The Ordane logo](../brand/ordane-logo-light.svg)

| File in `brand/` | Use it for |
|---|---|
| `ordane-logo.svg` | the logo on any page; it follows the visitor's light or dark setting |
| `ordane-logo-light.svg`, `ordane-logo-dark.svg` | where the setting cannot be followed (a README on GitHub, slides, print on a fixed background) |
| `ordane-logo-mono.svg` | one colour: it takes the colour of the text around it (`currentColor`) |
| `ordane-mark*.svg` | the ring and seat alone: an avatar, a badge, a corner |
| `favicon.svg`, `apple-touch-icon.png`, `icon-512.png`, `app-icon.svg` | the icon in a tab, on a home screen, in an app list |
| `social-card.png` | the 1200 × 630 image shown when a link is shared |
| `tokens.css` | the colours and type below as CSS custom properties |

**Space and size.** Keep clear space around the logo equal to half its height. Do not set the wordmark narrower than
72 px on screen (about 18 mm in print), or the mark smaller than 16 px.

**Do not** recolour the seat, rotate or outline the logo, add a shadow, stretch it, set it on a photograph or a busy
pattern, or retype the name in a font beside it and call that the logo.

## Colour

Two surfaces, one blue. Light is the default; the visitor's dark setting switches it.

| Role | Light | Dark | Contrast on its surface |
|---|---|---|---|
| Surface | `#fbfaf8` | `#131211` | |
| Panel | `#ffffff` | `#1b1a18` | |
| Ink (text, the letters) | `#1c1b1a` | `#efece6` | 16.5 : 1 and 15.9 : 1 |
| Muted text | `#5d5a55` | `#aaa59c` | 6.6 : 1 and 7.6 : 1 |
| Line | `#e4e0d9` | `#302e2a` | |
| Blue (the seat, links, the main button) | `#2b5fd9` | `#7ba0ff` | 5.4 : 1 and 7.4 : 1 |
| Text on blue | `#ffffff` | `#0e1220` | 5.6 : 1 and 7.4 : 1 |

Every text pair clears WCAG AA (4.5 : 1). `tests/build/brand-assets.test.ts` recomputes the ratios, so a changed colour
that stops clearing it fails there. The dashboard keeps its own, darker console palette; its logo uses the same drawing
with the console's text and accent colours.

## Type

The system's own fonts, nothing downloaded: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif` for text and
`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` for code. That is a choice and not an omission: a page that
loads no font makes no third-party request, which is what lets the site say it has no cookie banner. The wordmark is
drawn as paths, so it does not depend on a font either.

## Using the name

The name and the logo identify this project and its author. The source licence covers the code
([`LICENSE`](../LICENSE)); it does not grant the right to use the name or the logo for a product of your own, or in a way
that suggests the project endorses yours. Saying that you use Ordane, or that your product works with it, is welcome.
No trademark registration is claimed, so do not write the name with a registered mark.
