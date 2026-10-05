# The Curule website

Seven plain pages (the home page, pricing, documentation, security, contact, legal, and the page for an address that does not
exist), one stylesheet and two small scripts. No build step, no framework, no third-party request of any kind (tests pin that),
so it needs no cookie banner and any static host serves it. Every page reads without a script.

```bash
python3 -m http.server --directory site 8080      # then open http://127.0.0.1:8080
```

## What is here

| File | Address | What it holds |
|---|---|---|
| `index.html` | `/` | The tagline and what Curule is, a product frame (overview, events, designer), why it is not a group chat, how a mission goes, a tour of the console in six views, the commands that run the demo today, security in brief, the plans in a line, and the questions |
| `pricing/index.html` | `/pricing/` | The plans with the Annual/Monthly choice, the comparison table, what a plan pays for, a calculator, how licences work, and questions |
| `docs/index.html` | `/docs/` | A map of the documents in the repository: what each is for, and whether it is reference, a guide, short, or a log |
| `security/index.html` | `/security/` | What it protects, what leaves your environment, what it does not do, a hardening checklist, assurance, and how to report a problem |
| `contact/index.html` | `/contact/` | Who to write to for sales, support and security, and what to put in the message |
| `legal/index.html` | `/legal/` | The source licence in plain words, privacy (this site collects nothing), and the terms |
| `404.html` | any address that is not found | A short page with links; written with addresses from the root, because a host shows it at the address that was not found |
| `assets/site.css` | | The one stylesheet: the brand's colours under the names the pages use, the system fonts, and every component |
| `assets/site.js` | | Sets the links that leave the site, the copy buttons on the commands, and the phone menu; nothing else |
| `assets/pricing.js` | | The calculator on the pricing page |
| `assets/shots/` | | The product screenshots, under stable names (see below) |
| `assets/favicon.svg`, `apple-touch-icon.png`, `social-card.png` | | Copies of the files in [`brand/`](../brand/README.md); a test fails if one stops matching the kit |

A page works with a script switched off: the menu, the tabs in the product frame and the Annual/Monthly choice are plain CSS,
the plan cards and tables are in the markup, and the contact addresses are text. What the script adds is the calculator, the
copy buttons, and the links to the documents and the source (which live on GitHub, so they cannot be written into the pages: see
the next section).

## No request leaves the site, and the pages say so

Every page carries a content security policy in a `<meta>` tag that allows only the site's own files: no other host, no inline
script, no inline style. That is why the pages have no `style` attributes and no inline scripts (the one `<script>` that is not
a file holds the plan data as JSON, which is not executed). The links to the documents and the source are not in the markup at
all: the shared script sets them from constants at the top of `assets/site.js`, so no page contains an address of another
site, and `tests/build/site.test.ts` fails if one does.

The constants at the top of `assets/site.js` are the whole of the site's configuration:

| Constant | What it is | Who sets it |
|---|---|---|
| `DOCS_BASE` | where the documents are published; the repository, until a documentation site exists | `site:domain --docs-base github`, or by hand for another site (and its test) |
| `REPO_URL` | the repository: the "Source code" link, and the address the "Try it" commands clone | by hand |
| `APP_URL` | where "Sign in" goes (the address of your own dashboard); `""` removes the link | `site:domain --app-url <https address>` or `none` |
| `CLOUD_URL` | the address of Curule Cloud, once it is open: the pages then offer "Sign in" and "Get started" and say Curule is also run for you; `""` while it is not | `site:domain --cloud-url <https address>` or `none` |
| `CONTACT_HREF` | the `mailto:` the "Talk to us" and plan buttons use; without it they go to the contact page | `site:domain --contact` |
| `IMAGE_RELEASED` | `false` until the first release has published the container image; then the "Try it" steps also show the pull-and-run command | by hand, on the day of the release |

While `IMAGE_RELEASED` is `false`, no page names the image: a command that pulls `ghcr.io/salitaba/curule` fails until a tag has
published it, and `tests/build/site.test.ts` checks that none does. The "Try it" steps clone the repository and build the image,
which is what `README.md` says works today.

## The way into Curule Cloud

The site is static and the hosted service is not on it: the account pages (sign-up, sign-in, plans, the account, the dashboard)
are the app's, on the app's own address. The way from one to the other is `CLOUD_URL`, and it ships empty, because until the app
is running there is nothing to sign in to and a page must not offer it.

| `CLOUD_URL` | What a visitor sees |
|---|---|
| `""` (as shipped) | Curule as software you run. No page mentions Curule Cloud, sign-in or sign-up; the header's one button is "Try the demo"; the FAQ says it is not offered as a hosted service. |
| `"https://app.curule.dev"` | "Sign in" and "Get started" in every page's header (and "Sign in" in the phone menu); the home page leads with "Get started" and says Curule is also run for you; the pricing page has a strip that sends a visitor to the app's plans, and says the plans on the page are licences for the software you run yourself; the sentences that said it is not offered give way to the ones that say it is. |

The pages carry both versions, and the shared script chooses: `data-selfhost-only` is what is shown while the service is not open,
`data-cloud-only` is what is shown once it is, and `data-cloud="login|signup|home|terms|privacy"` is a link to that page of the app.
Both halves of every pair are in the markup and the script only hides the one that does not apply, so **a visitor without a script
sees the pages as they ship**, the self-hosted version, and a link into the app never has an address in the markup (the script
sets it from `CLOUD_URL`, as it does the dashboard's). A visitor who follows "Sign in" while already signed in is sent on to their
account by the app's sign-in page, so it is never a dead end. The prices of Curule Cloud's plans are not copied into the site:
they are kept in the app, and a test fails if a page writes one.

The switch is one command, run on the day the app is reachable, and then the site is published again:

```bash
npm run site:domain -- curule.dev --contact hello@curule.dev --cloud-url https://app.curule.dev
```

`--cloud-url none` puts it back. `tests/build/site-cloud.test.ts` runs the shared script against every page, once closed and once
open, and pins both: nothing about Curule Cloud is visible or linked while it is closed, and no sentence that says it is not
offered survives when it is open.

## Where the numbers come from

The plans, their prices and limits, the comparison table, the measured mission and the home page's line of plans are all
written from the plan table (`packages/licensing/src/plans.ts`), Anthropic's list prices (`packages/protocol/src/pricing.ts`) and
the measured mission (`pricing/measured-runs.json`). They sit between `generated:` markers in the pages. Do not edit them by hand:

```bash
npm run build              # the generator reads the compiled plan table
npm run pricing:export     # rewrites the blocks, pricing/plans.json and the tables in docs/commercial/pricing.md
npm run pricing:check      # fails if any of them is out of date (a test runs the same check)
```

The blocks are the JSON the calculator reads (`plans-json`), the plan cards (`plan-cards`), the table (`plan-table`), the
mission priced at each model (`run-costs`), all on the pricing page, and `plan-teaser` on the home page. They are static HTML, so
the numbers are there without a script; the Annual/Monthly choice only hides the price that is not selected. The HTML is written
by `scripts/pricing-html.mjs`.

A sentence that quotes a number in prose (the free plan's size, the measured mission, the grace period) is checked against the
same data or the documents by `tests/build/site-copy.test.ts`, so changing a price or a limit fails a test until the copy is
updated. Every `$` amount and every percentage in a page's prose has to be one of the data's.

## The header and the footer

Every page has the same header and footer, written by `scripts/site-chrome.mjs` between two pairs of markers, so that seven copies
of the navigation cannot drift apart. The rest of each page is yours to edit.

```bash
node scripts/site-chrome.mjs           # rewrite the header and footer in every page
node scripts/site-chrome.mjs --check   # exit 1 if a page differs (tests/build/site-chrome.test.ts runs the same check)
```

To change the navigation or the footer's links, edit the lists at the top of `scripts/site-chrome.mjs` and run it. The links are
written for each page's depth (`../pricing/` from a folder, `/pricing/` on `404.html`). The footer's company and contact line is
the owner's: the script carries it over as it finds it, so running it after `site:domain` does not put the placeholder back.

## Adding a page

1. Copy a short page (`legal/index.html`) to `site/<name>/index.html` and change its title, description, `og:` texts and content.
   Keep the marker pairs for the header and the footer, the content security policy, the `<main id="main" tabindex="-1">`, and one `h1`.
2. Run `node scripts/site-chrome.mjs`. Add the page to the lists in that script if it should be in the navigation or the footer.
3. Run `npm test`. The structure tests (`tests/build/site.test.ts`) and the claims tests (`tests/build/site-copy.test.ts`) read every
   page in `site/`, so the new one is held to them without being listed anywhere; link it from the home page's footer, or the
   first of them fails.
4. `node scripts/set-domain.mjs` finds the page by itself and gives it its own address, canonical link and sitemap entry.

## Putting it on a domain

Everything the site needs from you is marked `TODO(owner)`, and one command fills them, from the domain you chose and the
addresses you have. It never buys, registers or publishes anything; those are yours.

```bash
npm run site:domain -- curule.dev --contact hello@curule.dev --security security@curule.dev \
    --company "Your Company Ltd" --docs-base github --app-url https://mesh.curule.dev/ --dry-run   # say what would change
npm run site:domain -- curule.dev --contact hello@curule.dev --security security@curule.dev \
    --company "Your Company Ltd" --docs-base github --app-url https://mesh.curule.dev/             # the same, for real
npm run site:check                                                # exits 1 while anything is still marked
```

`--sales` and `--support` give those two addresses of their own (they default to `--contact`), `--app-url none` removes the
"Sign in" link for a project that has no hosted dashboard, and `--cloud-url` is the address of [Curule Cloud](#the-way-into-curule-cloud)
once it is open (`none`, and the default, while it is not). `tests/build/set-domain.test.ts` pins what it writes against a small
site written out in the test, and once against the repository's own files:

- Every page: `og:image` and `twitter:image` as absolute addresses (a link preview needs them; a crawler does not resolve a
  relative one), a canonical link and `og:url` that name the page's own address, and the footer's company and contact.
  `404.html` gets the footer and nothing else: a page that is not found has no address of its own.
- `contact/index.html`: the sales, support and security addresses and the company line.
- `assets/site.js`: `CONTACT_HREF`, `APP_URL`, `CLOUD_URL`, and, with `--docs-base github`, the decision that the documents stay in the repository.
- `SECURITY.md`: the reporting address (`--security`).
- `CNAME`, `robots.txt`, `sitemap.xml` (every page, not the one that is not found), and `security.txt` (RFC 9116, also at
  `.well-known/security.txt`, which is where the RFC looks first; a host that drops dotfiles still serves the other copy).

Run it again with the same arguments and nothing changes; run it with another domain and it replaces what it wrote, so a change of
mind is one command. `security.txt` expires after a year, as the RFC asks: run the command again before then (with the same
arguments only the dates change). `--dry-run` and `--check` write nothing. A page or policy that is no longer the shape it expects
is refused whole, with the text it could not find, and nothing is written. `npm run site:check` lists every marker that is left,
in every page, and the files a host and a crawler read that are not written yet.

What it leaves to you, because it is yours to decide:

- **The terms.** The legal page says that the terms of a commercial agreement are written with counsel, and carries one
  `TODO(owner)` for you to replace with them, or a link, when counsel has. That marker keeps `site:check` failing, and so keeps the
  publish workflow from running, until it is dealt with.
- The licensing contact in `LICENSE`: its contact line points at the repository's issue tracker until you have an address, and should
  then use the same one as `--contact`. Change only that line, with your counsel; the licence's terms are pinned by
  `tests/build/source-licence.test.ts`. `--check` reminds you while it still points at the repository.
- A documentation site, if you want one: `DOCS_BASE` in `assets/site.js`, and the test that pins it, change by hand.
- The company's registered address and any other line you want in the footer: it is a page of yours.

### Publishing

The site is plain files, so any static host serves it. The repository carries one way, GitHub Pages, as a workflow you run by
hand: **Actions → Publish the site → Run workflow**. It runs `npm run site:check` first and stops while anything is still
marked, so a placeholder cannot reach the internet by accident. It has to be switched on once, in the repository's settings
(Pages → Source: *GitHub Actions*, then your domain under *Custom domain*; when the certificate is ready, *Enforce HTTPS*). A
publish from Actions takes the domain from those settings and ignores `CNAME`, which is there for hosts that read it and as the
repository's own record of the domain. GitHub serves Pages from a private repository only on a paid plan.
`tests/build/pages-workflow.test.ts` pins that the workflow starts only by hand, checks first, and uses nothing but GitHub's own actions.

`404.html` is served by GitHub Pages, Netlify and Cloudflare Pages for any address that is not found, at any depth, and it assumes
the site is served from the root of its domain (which is what `CNAME` and `site:domain` set up). Under a sub-path
(`<owner>.github.io/<repository>/`) its addresses that start with `/` would need that prefix.

DNS, at your registrar: for an apex domain (`curule.dev`), the four `A` records (and four `AAAA`) GitHub lists for Pages;
for a subdomain (`www`), a `CNAME` to `<owner>.github.io`. Take the addresses from GitHub's current "custom domain"
documentation rather than from a copy of them here.

## The logo and icons

`assets/favicon.svg`, `assets/apple-touch-icon.png` and `assets/social-card.png` are copies of the files in
[`brand/`](../brand/README.md), and the logo in every header and footer is drawn inline from `brand/curule-logo.svg`.
`tests/build/brand-assets.test.ts` fails if any of them stops matching the kit, and recomputes the contrast of the colours in
`assets/site.css`. The name, voice and colours are in [docs/brand.md](../docs/brand.md).

## The screenshots

Every picture of the product is under `assets/shots/` with a name that does not change, so a retaken picture replaces the file and
no page is touched. The pages say how big each picture is (`width` and `height`), and `tests/build/site.test.ts` fails when a
file's real size is not the size its page says, when a file is under no page, and when one is over 250 KB.

| File | View | Size, in pixels |
|---|---|---|
| `shot-overview-light.jpg`, `shot-overview-dark.jpg` | Overview of the finished demo mission: the Delivered card and the What shipped cards | 1440 × 900, the whole window |
| `shot-events-light.jpg`, `shot-events-dark.jpg` | Events with the Messages chip selected, newest first, with a refused line in view | 1440 × 900, the whole window |
| `shot-designer-light.jpg`, `shot-designer-dark.jpg` | Designer, the demo team's graph and the save bar | 1440 × 900, the whole window |
| `shot-tile-overview.jpg` | Overview: the Delivered card with its four figures | 720 × 450, the view's own content |
| `shot-tile-events.jpg` | Events with the Messages chip selected: the search box, the filter chips and the first rows | 720 × 450, the view's own content |
| `shot-tile-steps.jpg` | Steps with the timeline folded: rows of agent turns, with one that produced and one that was refused | 720 × 450, the view's own content |
| `shot-tile-designer.jpg` | Designer: the seats and the arrows between them | 720 × 450, the graph |
| `shot-tile-cost.jpg` | Cost, scrolled to the By agent card: the bars, tokens, share and each seat's own budget | 720 × 450, the view's own content |
| `shot-tile-approvals.jpg` | The Approve or reject panel (More actions, Approve or reject) | 720 × 450, the panel and a little of the page behind it |
| `shot-graph.jpg` | Graph: who talked to whom, with its legend | 1100 × 560, the graph and the legend |

A light picture and its dark twin must be the same size, so that the page does not move when the visitor's colour scheme changes.
They show the scripted demo, which makes no model calls, and the pages say so beside them.

To retake them without Docker: scaffold the demo project into a scratch folder (`curule init <dir> --example demo-stub`), register
it under a scratch `MESH_HOME` (`curule project add <dir>`), start `curule host --home <scratch>`, open it in a browser window
of the size above, start the mission, wait for *Delivered*, and capture each view in the light colour scheme and in the
dark one (the dashboard's *theme* button). The 720 × 450 pictures are crops of the view's own content (a 960 pixel wide window
shows all of it) taken without the sidebar. Save JPEGs at quality about 80. In the Designer, the path shown at the bottom is the
scratch folder's: replace it with `/data/projects/demo-stub/mesh.yaml`, which is what the container the pages tell people to run
shows. `npm run demo:capture` does the same for the GIF in the README and needs Chrome (`CHROME=/path/to/chrome`) and an ffmpeg
that can write GIFs.
