# The public site: a design record

The surface is `apps/cloud-server/pages`: the pages a stranger reads to understand Curule
Cloud, create an account, confirm an address, choose a plan and pay. Shared styles are
`assets/app.css`; shared behaviour is `assets/app.js`; the pages are static HTML with no
external asset and no inline script or style.

## Direction: the plain ledger

**Exact, unhurried, warm.**

Curule's product is a record: roles, authority, approvals, an append-only log. The site
should look like a record kept by hand for someone who will read it later — ruled lines,
numbered entries, plain arithmetic, nothing decorative that is not also information.
*Exact* because the buying decision is a price and a set of limits, and every number must
carry its unit, period and condition. *Unhurried* because the reader arrives cold; the
price and the next action should be reachable without a wall of claims, and a paragraph
should be allowed to be one thought. *Warm* because this is a small service, not a bank:
paper rather than white, ink rather than black, rounding and space rather than borders
everywhere.

The direction applies mechanically:

- Sections are numbered entries (`01 Plans`, `02 What you get`) on the home page and in
  the legal table of contents. Numbers are counters, not typed text, so inserting a
  section does not renumber the rest by hand.
- A price always appears with its period and currency; a limit always with what it
  limits. Copy that is only true of one deployment mode is conditional, and a page that
  cannot learn the mode says only what is true in both.
- Rules are 1px `--k-line`; a stronger rule marks a section boundary. Cards are for
  things you act on (a plan, a form), not for every paragraph.
- Actions are verbs: "Create account", "Send the link", "Choose Team". The same action
  keeps the same name in the header, the hero and the account.

## Type

System UI for prose (`--k-font`), monospace for figures, addresses, keys and event ids
(`--k-mono`). The public site reads at **16px**; secondary prose is **15px**; captions,
labels and section numbers are **12px** and never smaller. Display sizes are fluid and
drawn from the same steps: **28 / 36 / 48 / 60px** for the home and 404 h1, **28 / 36px**
for auth and legal h1. Plan prices sit at **36px**; account figures at **30px**. The
dashboard's stricter 11–30 ramp does not apply here, but no public-site text may compute
below 12px at any width.

## Space

One scale, used without ad-hoc values: **4, 8, 12, 16, 20, 24, 32, 40, 48, 56, 64, 88**.
Section rhythm is 40–64px; card padding 24–32px; form gaps 20px; the gap between a
heading and its first line is 8–12px. The page gutter is `--gutter` (20px on a phone).
Content width is `--max`; prose inside legal pages is capped near 68 characters.

## Every view must cover

| State | The page says |
| --- | --- |
| Reading | The content is complete before JavaScript runs. Plans and the account say "Loading…" in words with a skeleton; the skeleton is hidden from assistive tech and a live region says what is happening. |
| Empty | What would be here, why it is not, and the one action that changes it. Never a blank panel. |
| Failed | What failed, whether the reader's data is safe, and the action to retry. A retry re-runs the same request. Failure copy must be true for both hosting-only and usage-selling services. |
| Refused | A link that cannot be used, a password that is wrong, a signed-out page: say what happened, then offer the way forward (send a new link, sign in, reset). |
| Long | Tables and output scroll inside their own box with a border and a reachable edge; the page itself never scrolls sideways at 320px. |
| Phone | Every action is reachable one-thumbed at 360px: targets at least 44px, no hover-only affordance, nothing meaningful hidden only on a phone. |
| Signed in / out | The header and the home hero actions change with the session; the page does not show "Sign in" to someone who is signed in. |
| Dark / light, forced colors, reduced motion, JS off | All content and controls remain legible and operable; animation is optional. |

## Words

- Say "workspace", "agent", "plan", "record". Do not say "mesh" to a stranger.
- "Hosting" and "model usage" are separate lines of the bill. A page must not claim there
  is no model usage when its own plans include some, and must not claim usage is included
  when it is not.
- Use the second person, the present tense, and the active voice. "We send a link", not
  "a link will be sent".
- Controls name their outcome; errors name the cause and the next action.

## What is still wrong

Recorded at the start of the 2026-10-20 pass; the closing section below replaces this
list with what remains after it.

- The first plan is 2.2 screens down at 360×800 (y = 1737); the hero argues before it
  prices.
- When `/api/plans` fails, the page falls back to five hosting-only claims and hides the
  usage-sold one, so a usage-selling service tells the reader it does not sell usage.
- The meta description always says "with your own model key".
- "Mesh" appears in the index title and h1, and "a mesh" in two account messages.
- The legal table of contents is `display: none` below 1000px; terms is 3505px tall at
  360px with no in-page navigation.
- Nine 11px labels remain on the account page at 360px.
- The five sign-in pages repeat the same three bullets; only one of the five is about
  signing up.
- The signup hint reads "A few words in a row is a good password" (plural subject, singular
  verb).

## Next pass

- Give the account's plan and balance panels the same numbered-entry treatment as the
  home page, if the pinned section ids allow it without losing behaviour.
- Look at the checkout page (served by the payment provider on the trial; the real provider
  is out of scope) for the same price/period/limit discipline.
- Re-run the browser audit with axe-core if it is ever available; this pass measured
  contrast, targets, overflow, type sizes and focus order by hand.
- Check the pages at 200% browser zoom at 360px, which is the closest stand-in for a
  larger-text phone the current harness does not emulate.
