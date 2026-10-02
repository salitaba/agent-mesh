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

## Before it is published

Everything the page needs from you is marked `TODO(owner)`:

- `DOCS_BASE` in the script: where the documents under `docs/` are served. It points at the repository on GitHub
  until a documentation site exists.
- `CONTACT_HREF`: a `mailto:` or a form for "Talk to us" and the paid plans.
- The licensing contact in `LICENSE`: its contact line points at the repository's issue tracker until you have an
  address, and should then use the same one as `CONTACT_HREF`. Change only that line; the licence's terms are pinned
  by `tests/build/source-licence.test.ts`.
- The footer: company name and contact address, and the privacy policy and terms once they exist.

```bash
grep -n "TODO(owner)" site/index.html      # must print nothing before the page goes live
```

## The screenshots

`assets/overview.jpg` and `assets/graph.jpg` are 1440 × 900 captures of the dashboard after the scripted demo mission
has finished (`docker run … demo`, see `docs/commercial/deployment.md`), so they show only what the free, keyless
demo shows. If the dashboard changes, retake them at the same size and keep the `width` and `height` attributes.
Keep each under 400 KB.
