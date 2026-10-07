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
| `index.html` | `/` | The tagline, what Curule is and a picture of it beside the first actions (a product frame: overview, events, designer), the two ways in (we run it, or you do), why it is not a group chat, how a mission goes, a tour of the console in six views, the commands that run the demo today, security in brief, the plans in a line, and the questions |
| `pricing/index.html` | `/pricing/` | The two ways to pay (while Curule Cloud is open), the plans with the Annual/Monthly choice, the comparison table, what a plan pays for, a calculator, how licences work, and questions |
| `docs/index.html` | `/docs/` | "Start here": a card for each thing a visitor comes to do (run the demo, deploy it, describe a team and its rules, use Curule Cloud), each naming the one document to open first; then a map of the documents in the repository: what each is for, and whether it is reference, a guide, short, or a log, with a filter over them |
| `security/index.html` | `/security/` | An At a glance box (what it protects, what leaves your environment, what it does not do: one line each, from the page's own sentences, each linking to its section, with a mark that says what kind of answer it is), then the three in full, a hardening checklist, assurance, and how to report a problem |
| `contact/index.html` | `/contact/` | Which address is for what, in three rows (the place the links to sales, support and security land, each with a copy button that the script adds), and what to put in the message |
| `legal/index.html` | `/legal/` | The source licence in plain words, privacy (this site collects nothing), and the terms |
| `404.html` | any address that is not found | A short list of the pages a person was probably looking for, each with what it is for (and the account, while Curule Cloud is open), and the way home; written with addresses from the root, because a host shows it at the address that was not found |
| `assets/site.css` | | The one stylesheet: the generated UI kit block, the brand's colours under the names the pages use, the system fonts, and every component |
| `assets/site.js` | | Sets the links that leave the site, the copy buttons on the commands, the phone menu, the header's line and blur once the page has moved, the arrival of what is below the first screen, the On this page bar of the long pages, Back to top, and the documentation page's filter; nothing else |
| `assets/pricing.js` | | The calculator on the pricing page |
| `assets/shots/` | | The product screenshots, under stable names (see below) |
| `assets/favicon.svg`, `apple-touch-icon.png`, `social-card.png` | | Copies of the files in [`brand/`](../brand/README.md); a test fails if one stops matching the kit |

Where a mark helps a reader find the card they want, the card has one: a small drawing (an inline SVG in the stylesheet's colours, hidden
from a screen reader, since the heading says the same) on the four reasons and the three security answers of the home page, and on
the three answers in the security page's At a glance box. A shield is what it does, an arrow out of a box is what leaves, a barred
circle is what it does not do, wherever it appears, so the kind shows in the shape and not in the colour; `tests/build/site-copy.test.ts`
pins that each card in a row has its own drawing and that the security answers are the same drawings on both pages.

A mark carries its own size, fill and stroke as attributes (`width="24" height="24" fill="none" stroke="currentColor" ...`), the same
values as the stylesheet's `.mark` rule, which the stylesheet overrides where it says otherwise (a card's mark is 28 px and in the
accent colour). The attributes are what a mark falls back to, so a card is right in a browser that holds a stylesheet older than the
page: a mark that waited for the stylesheet to say how big it is, and that it is an outline, once filled its card in black. The same
test holds the attributes to the rule, so they cannot drift apart.

A page works with a script switched off: the menu, the tabs in the product frame and the Annual/Monthly choice are plain CSS,
the plan cards and tables are in the markup, and the contact addresses are text. What the script adds is the calculator, the
copy buttons, and the links to the documents and the source (which live on GitHub, so they cannot be written into the pages: see
the next section).

The long pages (pricing, security, legal) have an *On this page* bar under their heading: a row of chips, one for each section.
Without a script it is a row of plain links. With one, the bar stays under the header while the page is read, and the chip of the
section being read is marked (`aria-current`, and a filled chip with a dot). It is one row at every width, scrolled sideways when
the chips do not fit, so it is as tall where it rests as where it stays and nothing moves when it starts to stay. The reading
position is looked at when a section's top crosses the line (an IntersectionObserver) and as the window scrolls, once a frame, so a
jump that passes whole sections at once (Back to top under reduced motion) clears the mark and brings the row back to its first chips. A followed link
lands below the header and the bar: `--head-h` and `--toc-h` in `assets/site.css` are their heights, and
`tests/build/site-script.test.ts` checks them against the rules that make them.

Wherever the script finds a clipboard it adds a Copy button to each block of commands, and one beside each address on the contact
page (`a[data-mail]`, when the text is an address): one click writes it to the clipboard and says "Copied", to a screen reader
too, for a moment. The address stays a link and text, so a page with no script, or a browser that does not allow copying, loses
only the button. On a phone the button is a 44 pixel target.

Once a reader is two screens down any page and turns back (scrolls up), or has come to the end of the content, a *Back to top*
button shows in the bottom right corner. While the reader goes down it is not shown: on a phone it would sit on the ends of the
lines being read. Eight pixels is a turn; the shake of a thumb is not. The script makes it, at the end of `<main>`: it stays at the
bottom of the window while the content is in view and rests above the footer at the end, so it never covers the footer's links. It
jumps under reduced motion, and it moves the focus to the top of the content, so the keyboard carries on from there. It is not
printed, and without a script it is not there.

The documentation page opens with four "Start here" cards, one for each goal, each with the document to open first, its label and its
path (the shared script gives the title its address, as it does in the map, and without a script the path is there to read). The card
for Curule Cloud, and the map's entry for the document it names, are there only while Curule Cloud is open. The cards are not part
of the map, so its filter leaves them alone. The page also has a filter over its documents ("Filter the documents"). It is in the markup, hidden, and the script shows
it: what is typed keeps the documents that have every word somewhere in their title, description, label (Guide, Reference, Short,
Log), path or group, hides a group that has none left, and says how many are left in a polite live region after a pause in the
typing. When nothing matches it says so, with a button that clears the filter; Escape clears it too. It reads only the page.

## How it is drawn

The stylesheet is built on the UI kit ([docs/brand.md](../docs/brand.md#the-ui-kit)): its generated block gives the colour roles, the
five steps of elevation, the radii, the tracking that goes with each size of type and the motion, and the rest of `assets/site.css`
uses them by name. What is particular to the site:

- **Depth.** A card at rest sits on the first step of elevation with a lit top edge, so that in the dark scheme it is a lighter
  surface and not a shadow that is not there. A card that can be pressed rises a pixel and takes the second step; the product's frame
  on the home page is the fifth. Text that is only text stays flat.
- **Figures.** Every number that is compared (the prices, the limits, the estimate, the plan table) is tabular and in the text font,
  not in monospace.
- **Two controls with a thumb.** The home page's product tabs and the pricing page's Annual/Monthly switch are radio inputs and CSS:
  the thumb that slides under the chosen one is a pseudo-element moved by `--n` steps, so they work without a script.
- **Drawings.** An icon is a 24-unit drawing shown at 20 px with a 1.8-unit stroke (a test holds the attributes to the rules). The
  drawings on the four reasons, the three steps and the places to start are decoration: `aria-hidden`, no words in them, no
  `style`, and no two cards of a group share one. The glyph of a notice is made with gradients, so that no `data:` address is needed
  under the pages' policy.
- **Rows that line up.** A plan card and a "Start here" card are `subgrid` rows (`grid-row: span N`), so that title, price, limits,
  what is included and the button sit at one height across a row; a browser without subgrid shows plain cards.
- **Grounds.** A page alternates the paper with a slightly different paper (`--band`) and has one deep ground (`--deep`), the closing
  band. An inner page's heading sits on the same ruled paper as the home page's first screen, fainter.
- **Arrival.** The stylesheet hides nothing. For a visitor who has not asked for reduced motion the script marks the pieces *below the
  first screen* (`.rv`), and each rises 8 px and appears once as it comes into view, the children of a group 50 ms apart up to five.
  If the script never runs, or the visitor asked for stillness, nothing was ever hidden. Print overrides all of it, and a button
  prints as black text in a black line.
- **The header** is part of the page at rest, on the first screen's glow. Once the page has moved the script gives it a line and a
  blur and pins it; with no script it scrolls away and nothing flashes.

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
| `CLOUD_URL` | the address of Curule Cloud, once it is open: the pages then offer "Sign in" and "Get started" and say Curule is also run for you; `""` while it is not. The pages are written in the state it says | `site:domain --cloud-url <https address>` or `none` |
| `CONTACT_HREF` | the `mailto:` the "Talk to us" and plan buttons use; without it they go to the contact page | `site:domain --contact` |
| `IMAGE_RELEASED` | `false` until the first release has published the container image; then the "Try it" steps also show the pull-and-run command | by hand, on the day of the release |

While `IMAGE_RELEASED` is `false`, no page names the image: a command that pulls `ghcr.io/salitaba/curule` fails until a tag has
published it, and `tests/build/site.test.ts` checks that none does. The "Try it" steps clone the repository and build the image,
which is what `README.md` says works today.

## The way into Curule Cloud

The site is static and the hosted service is not on it: the account pages (sign-up, sign-in, plans, the account, the dashboard)
are the app's, on the app's own address. The way from one to the other is `CLOUD_URL`.

| `CLOUD_URL` | What a visitor sees |
|---|---|
| `"https://app.curule.dev"` (as shipped) | "Sign in" and "Get started" in every page's header (and "Sign in" in the phone menu); the home page leads with "Get started", says Curule is also run for you and sets the two ways in side by side; the pricing page opens with the same choice, sends a visitor to the app's plans for Curule Cloud's, and says the plans on the page are licences for the software you run yourself; the sentences that said it is not offered give way to the ones that say it is. |
| `""` | Curule as software you run. No page mentions Curule Cloud, sign-in or sign-up; the header's one button is "Try the demo"; the home page's way in is the one card for the software you run; the FAQ says it is not offered as a hosted service. |

The pages carry both versions of every sentence that depends on it: `data-selfhost-only` is what is shown while the service is not
open, `data-cloud-only` is what is shown once it is, and `data-cloud="login|signup|home|terms|privacy"` is a link to that page of
the app. **The state is written into the pages, not chosen in the browser.** `scripts/set-domain.mjs` does it to every page
(through `scripts/site-cloud-state.mjs`: it shows what is for the state, hides what is not, and gives the links their addresses),
and `scripts/site-chrome.mjs` writes the shared header in the same state. A page is therefore right on its first paint, so nothing
moves while it loads (the pricing page used to jump by 0.34 on a phone while the script switched its Cloud card on), and a visitor
with no script, a search engine and a link preview read the half that is true. The shared script applies the same rule when it
runs, in both directions: for a page that is right it changes nothing, and it puts right one that is not. The links into the app
are the one kind of address of another site that a page carries (a link a visitor follows, never something the page fetches);
`tests/build/site.test.ts` pins each to `CLOUD_URL` and `CLOUD_PATH`, so they cannot go anywhere else. A visitor who follows "Sign
in" while already signed in is sent on to their account by the app's sign-in page, so it is never a dead end. The prices of Curule
Cloud's plans are not copied into the site: they are kept in the app, and a test fails if a page writes one.

The switch is one command, run on the day the app is reachable, and then the site is published again:

```bash
npm run site:domain -- curule.dev --contact hello@curule.dev --cloud-url https://app.curule.dev
```

`--cloud-url none` puts it back, exactly as it was. Any run of the command puts the pages in the state the script says, so after
editing a page by hand (a new `data-cloud-only` block, say, which you can write with or without `hidden`) run it again with the
arguments you used. `npm run site:check` and `tests/build/site-cloud.test.ts` fail while a page says the other state than
`CLOUD_URL`, and that test runs the shared script against every page in both states and pins both: nothing about Curule Cloud is
visible or linked while it is closed, and no sentence that says it is not offered survives when it is open.

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

## The address of the stylesheet and the scripts

Every page names its stylesheet and its scripts with a fingerprint of the file: `assets/site.css?v=9af9e701cf`. The fingerprint is
ten hex digits of the file's SHA-256, so it changes when the file does and at no other time. It is there because a browser keeps a
file for as long as its host says (GitHub Pages: ten minutes, without asking) and a page and its stylesheet are kept on their own
clocks, so a visitor can be handed today's page with last week's stylesheet. That happened once: the new page drew marks that the
older stylesheet had no rule for, and each filled its card in black. With the fingerprint a new page asks for an address the older
stylesheet was never kept under, so it gets the new one. The file keeps its name and a host ignores the query.

```bash
node scripts/site-chrome.mjs           # also writes the fingerprints: run it after editing assets/site.css, site.js or pricing.js
node scripts/site-chrome.mjs --check   # exit 1 while a page names an older file than the one in assets/
```

`tests/build/site-chrome.test.ts` runs the check and pins every page to the files as they are (it computes the fingerprint on its
own), so a change to the stylesheet fails a test until the new fingerprint is written. `scripts/set-domain.mjs`, which changes
`assets/site.js`, writes that script's new fingerprint into the pages it writes in the same run. The images are not fingerprinted:
they are under stable names and only replaced when a picture is retaken, which does a page that still has the older one no harm.
The code is `scripts/site-assets.mjs`.

## Adding a page

1. Copy a short page (`legal/index.html`) to `site/<name>/index.html` and change its title, description, `og:` texts and content.
   Keep the marker pairs for the header and the footer, the content security policy, the `<main id="main" tabindex="-1">`, and one `h1`.
   Load the stylesheet and the script as the other pages do; the next step writes their fingerprints.
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
  `404.html` gets the footer (and the Curule Cloud state) and nothing else: a page that is not found has no address of its own.
- `contact/index.html`: the sales, support and security addresses and the company line.
- `assets/site.js`: `CONTACT_HREF`, `APP_URL`, `CLOUD_URL`, and, with `--docs-base github`, the decision that the documents stay in the repository.
- Every page, `404.html` too: the state of Curule Cloud that `CLOUD_URL` says, as [the way into Curule Cloud](#the-way-into-curule-cloud) describes.
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
Publishing again after any change is all a change needs: the pages name the stylesheet and the scripts by their fingerprints (above),
so a visitor's browser asks for the new files at once and nobody has to clear a cache. A browser that holds the page itself from
before the fingerprints (up to ten minutes) needs one reload.

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
| `shot-events-light.jpg`, `shot-events-dark.jpg` | Events with Messages selected, newest first, with an alert line at the top and a refused message in view | 1440 × 900, the whole window |
| `shot-designer-light.jpg`, `shot-designer-dark.jpg` | Designer, the demo team's graph and the save bar | 1440 × 900, the whole window |
| `shot-tile-overview.jpg` | Overview: the Delivered card with its goal and actions, and its four figures (checks, ran for, tokens, agents) | 720 × 450, the view's own content, taken at 0.83 scale (see below) |
| `shot-tile-events.jpg` | Events with Messages selected: the search box, the filters, the folded routine events and the first rows | 720 × 450, the view's own content |
| `shot-tile-steps.jpg` | Steps with the timeline folded (*Who was busy, when*): the filter chips and the rows of agent turns, one with a refused decision | 720 × 450, the view's own content |
| `shot-tile-designer.jpg` | Designer: the seats and the arrows between them, the product manager selected | 720 × 450, the canvas, cut from a 1440 × 900 window |
| `shot-tile-cost.jpg` | Cost, scrolled to the By agent card: the bars, tokens, share and each seat's own budget | 720 × 450, the view's own content |
| `shot-tile-approvals.jpg` | The Approve or reject panel (More actions, Approve or reject) | 720 × 450, the panel and a little of the page behind it |
| `shot-graph.jpg` | Graph: who talked to whom, with its legend | 1139 × 606, the inside of the graph card (6 pixels in from its edge, clear of its rounded corners), legend included |

A light picture and its dark twin must be the same size, so that the page does not move when the visitor's colour scheme changes.
They show the scripted demo, which makes no model calls, and the pages say so beside them.

To retake them without Docker: scaffold the demo project into a scratch folder (`curule init <dir> --example demo-stub`), register
it under a scratch `MESH_HOME` (`curule project add <dir>`), start `curule host --home <scratch>`, open it in a browser window
of the size above, start the mission, wait for *Delivered*, and capture each view in the light colour scheme and in the
dark one (the dashboard's *theme* button). The 720 × 450 pictures are crops of the view's own content (a 960 pixel wide window
shows all of it) taken without the sidebar; the Overview one needs a window about 1100 pixels wide to put its four figures in
one row, so it is taken from such a window at a scale of 0.83, which makes the 868 × 542 pixel view exactly 720 × 450. Save JPEGs
at quality about 80. In the Designer, the path shown at the bottom is the scratch folder's: replace it with
`/data/projects/demo-stub/mesh.yaml`, which is what the container the pages tell people to run shows.

The pages describe each picture in its `alt` text, and say only what is in the picture. Read them again when a picture is
retaken: a figure that moves, or a control that is renamed, is a sentence that has to follow.

`npm run demo:capture` does the same for the GIF in the README and needs Chrome (`CHROME=/path/to/chrome`) and an ffmpeg
that can write GIFs.
