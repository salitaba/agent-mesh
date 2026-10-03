# The landing and pricing page

One static page, `index.html`, and two screenshots in `assets/`. No build step, no framework, no third-party request
of any kind (a test pins that), so it needs no cookie banner and any static host serves it.

```bash
python3 -m http.server --directory site 8080      # then open http://127.0.0.1:8080
```

## Where the numbers come from

The plan cards and the calculator read a JSON block inside the page, between the `generated:plans-json` markers.
It is generated from the plan table (`packages/licensing/src/plans.ts`), Anthropic's list prices
(`packages/protocol/src/pricing.ts`) and the measured mission (`pricing/measured-runs.json`). Do not edit it by hand:

```bash
npm run pricing:export     # rewrites the block, pricing/plans.json and the tables in docs/commercial/pricing.md
npm run pricing:check      # fails if any of them is out of date (CI runs the same check as a test)
```

The sentences that quote a number in prose (the free plan's size, the measured mission) are checked against the same
data by `tests/build/site.test.ts`, so changing a price or a limit fails a test until the copy is updated.

## Putting it on a domain

Everything the page needs from you is marked `TODO(owner)`, and one command fills them, from the domain you chose and the
addresses you have. It never buys, registers or publishes anything; those are yours.

```bash
npm run site:domain -- curule.dev --contact hello@curule.dev --security security@curule.dev \
    --company "Your Company Ltd" --docs-base github --dry-run     # say what would change, write nothing
npm run site:domain -- curule.dev --contact hello@curule.dev --security security@curule.dev \
    --company "Your Company Ltd" --docs-base github               # the same, for real
npm run site:check                                                # exits 1 while anything is still marked
```

It writes, and a test (`tests/build/set-domain.test.ts`) pins each of these against the page and the policy as they are:

- `index.html`: `og:image` and `twitter:image` as absolute addresses (a link preview needs them; a crawler does not
  resolve a relative one), a canonical link and `og:url`, `CONTACT_HREF` (the "Talk to us" button and the paid plans) and
  the footer's company and contact, and, with `--docs-base github`, the decision that the documents stay in the repository.
- `SECURITY.md`: the reporting address (`--security`).
- `CNAME`, `robots.txt`, `sitemap.xml`, and `security.txt` (RFC 9116, also at `.well-known/security.txt`, which is where
  the RFC looks first; a host that drops dotfiles still serves the other copy).

Run it again with the same arguments and nothing changes; run it with another domain and it replaces what it wrote, so a
change of mind is one command. `security.txt` expires after a year, as the RFC asks: run the command again before then
(with the same arguments only the dates change). `--dry-run` and `--check` write nothing. A page or policy that is no
longer the shape it expects is refused whole, with the text it could not find, and nothing is written.

What it leaves to you, because it is yours to decide:

- The licensing contact in `LICENSE`: its contact line points at the repository's issue tracker until you have an
  address, and should then use the same one as `--contact`. Change only that line, with your counsel; the licence's terms
  are pinned by `tests/build/source-licence.test.ts`. `--check` reminds you while it still points at the repository.
- The footer's privacy policy and terms, once they exist.
- A documentation site, if you want one: `DOCS_BASE` in the page's script, and the test that pins it, change by hand.

### Publishing

The page is plain files, so any static host serves it. The repository carries one way, GitHub Pages, as a workflow you run
by hand: **Actions → Publish the site → Run workflow**. It runs `npm run site:check` first and stops while anything is
still marked, so a placeholder cannot reach the internet by accident. It has to be switched on once, in the repository's
settings (Pages → Source: *GitHub Actions*, then your domain under *Custom domain*; when the certificate is ready, *Enforce
HTTPS*). A publish from Actions takes the domain from those settings and ignores `CNAME`, which is there for hosts that read
it and as the repository's own record of the domain. GitHub serves Pages from a private repository only on a paid plan.

DNS, at your registrar: for an apex domain (`curule.dev`), the four `A` records (and four `AAAA`) GitHub lists for Pages;
for a subdomain (`www`), a `CNAME` to `<owner>.github.io`. Take the addresses from GitHub's current "custom domain"
documentation rather than from a copy of them here.

## The logo and icons

`assets/favicon.svg`, `assets/apple-touch-icon.png` and `assets/social-card.png` are copies of the files in
[`brand/`](../brand/README.md), and the logo in the header is drawn inline from `brand/curule-logo.svg`.
`tests/build/brand-assets.test.ts` fails if any of them stops matching the kit. The name, voice and colours are in
[docs/brand.md](../docs/brand.md).

## The screenshots

`assets/overview.jpg` and `assets/graph.jpg` are 1440 × 900 captures of the dashboard after the scripted demo mission
has finished (`docker run … demo`, see `docs/commercial/deployment.md`), so they show only what the free, keyless
demo shows. If the dashboard changes, retake them at the same size and keep the `width` and `height` attributes.
Keep each under 400 KB.

To retake them without Docker: scaffold the demo project into a scratch folder (`curule init <dir> --example demo-stub`),
register it under a scratch `MESH_HOME` (`curule project add <dir>`), start `curule host --home <scratch>`, open it in a
1440 × 900 browser window with the light colour scheme, start the mission, wait for *Mission delivered* and capture the
Overview; then open Graph and capture that (JPEG, quality about 80). `npm run demo:capture` does the same for the GIF
in the README and needs Chrome (`CHROME=/path/to/chrome`) and an ffmpeg that can write GIFs.
