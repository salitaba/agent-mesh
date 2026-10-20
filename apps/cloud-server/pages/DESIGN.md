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

- The home page's sections are numbered entries (`01 Plans`, `02 What you get`, …). The
  number is a small monospace caption marked `aria-hidden`; the h2 is the heading. Legal
  pages index their headings in a contents list instead of numbering them, because a
  reader arrives at a section directly from a link.
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
| Phone | Every action is reachable one-thumbed at 360px: targets at least 44px, no hover-only affordance, nothing meaningful hidden only on a phone. A row of navigation links wraps rather than hiding its last item past the edge. |
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

## What this pass changed (2026-10-20)

Every figure below was measured in Chromium (playwright-core, Chromium 1248) against the
trial service, with `prefers-reduced-motion: reduce`, at 320 / 360 / 768 / 1440px, in
light and dark. Geometry is from `getBoundingClientRect` and `getComputedStyle`; nothing
here is an impression.

- **The home page prices before it argues.** The h1 is now one sentence, the lede states
  what the service is and who runs it, and a line under the buttons says what the plans
  start at. The first plan begins at **y = 693** at 360×800 (was **y = 1737**), at 612
  at 768 and 712 at 1440; "From $149.00 a month" is at y = 485 on a 360px phone. The h1
  computes to **28px** at 360, **48.5px** at 768 and **60px** at 1440. The page is 3,737px
  tall at 360 because it then gives the four facts, the four steps and the billing rules;
  the price is inside the first screen.
- **A failed plans request no longer lies about the bill.** Previously `/api/plans`
  failing fell through to the hosting-only claims, so a usage-selling service told the
  reader it did not sell usage. The failure state now hides both conditional arrangements,
  shows the neutral "Model usage, stated" fact, keeps the price line unchanged ("Plans and
  prices below"), and offers **Try again**, which clears the cached failure and re-runs
  the request. The retry test takes the page from no cards to two cards and
  "From $149.00 a month". "No plan is on offer just now" and "could not be loaded" are
  distinct sentences.
- **Legal pages are navigable on a phone.** The side contents are hidden below 1000px, so
  a `<details>` contents box now sits after the h1: its summary and every link are 44px
  tall, and it duplicates `nav.toc` exactly (a test enforces the mirror). Terms is
  3,574px at 360px with the box; at 1440 the side contents links are 34px tall, above the
  24px inline exception and reachable with a pointer.
- **The five sign-in pages are one family with five jobs.** Each has its own eyebrow,
  h1, lede and rail of three or four steps, exactly one step marked
  `aria-current="step"`: signup (create → plan → workspace → team), login (sign in →
  workspaces → plan → settings), verify (link → once only → expiry), forgot (email →
  open link → sign in) and reset (the link → new password → sign in). A phone-only line
  under the form says what happens next ("Next: confirm your email, then choose a plan.").
  Signup's consent links are **44px tall** at 360 (they were 18px); the label grows to
  108px to give each line its own target.
- **The account's section strip wraps instead of hiding Settings.** At 360 the strip was
  421px of content in a 328px box with `scrollbar-width: none`: Settings ended at x = 437,
  93px past the edge, with no visible cue. It now wraps onto two rows; scroll width equals
  client width (328px), Settings sits at x = 174 on the second row, and all five panels
  remain reachable. First panel begins at y = 775; the page is 3,007px tall at 360.
- **The type floor is 12px everywhere.** Nine 11px labels on account and legal pages were
  raised; the account's step numerals were the last 11px text and are now 12px. A census
  of every visible text node at 320, 360, 768 and 1440 in both schemes finds nothing
  below 12px.
- **Words match the product.** "Mesh" is gone from the index title, h1 and the two account
  messages ("a workspace", "a team"); a test rejects it on every page and in the script.
  The front page title and meta description describe the hosted service without claiming a
  deployment mode. The password hint reads "A few words in a row make a good password."
  and the forgotten-password page is titled "Forgot your password?" as the link that
  brings people there says.
- **Dead weight removed.** The home redesign left `.how-card` unused, and `.todo`, `.org`
  and `.w3` were already unused (the last two were substrings of the SVG data URI, not
  selectors). The rules are gone. The stylesheet is **40,564 bytes** against its 40,960
  byte budget.

## What is still wrong

- **A dead reset link is only refused on submit.** The reset page cannot ask the API
  whether its token is still valid: the page's allowed routes have no token check, and
  adding one means changing the control plane outside this surface. The form says "That
  link did not work" with the server's reason after the password is sent, and keeps the
  field; a reader still types before learning. Next pass, if server work is allowed: a
  `GET` check on page load that reuses the same refusal copy.
- **Prose-only inline links remain 18–19px tall.** The Terms page's "Privacy notice" link
  is 112×19 at 360; the signup consent links are fixed, and footer/header links are 44px.
  The W3C inline-link exception applies, and these links are reading rather than doing,
  but a thumb can miss them.
- **The account headings are not numbered entries.** They are labelled regions with
  pinned ids; adding a visible number inside the h2 would enter the accessible name of
  the section (an `aria-labelledby` reference includes hidden text), so it needs an
  `aria-label` on each panel or a number placed outside the heading. Left alone rather
  than half-done.
- **The checkout page is the trial's stand-in.** The real payment provider's page is not
  part of this repository's surface and was not inspected. Prices and periods on the site
  were checked against the trial's plan fixtures (Team $149/month, Business $599/month,
  top-ups for a usage-selling service).
- **No automated accessibility audit.** axe-core is not installed and no dependency was
  added. Contrast is computed from token pairs by `tests/cloud/pages.test.ts` and
  `tests/build/*`; targets, overflow, type sizes and focus order were measured by hand in
  the browser.
- **200% zoom at 360px was not run.** The harness has no zoom emulation; the 320px pass is
  the closest stand-in, and it shows no horizontal overflow. A larger-text phone should be
  the first check of the next pass.
- **The signed-in 404 offers two primary buttons** ("See the plans and prices" and "Go to
  your account"). Both are reasonable destinations and the page is not broken; the
  hierarchy would be cleaner with the account first for a signed-in reader, which needs a
  session-aware class swap rather than a hidden-attribute selector.

## Next pass

- Check at 200% browser zoom and with a large-text phone profile; measure the same census.
- Add the reset-token check on page load if the control plane can grow a non-mutating
  route, and use the same "That link did not work" copy as verify.
- Number the account's panels as entries only if the accessible names can stay clean;
  otherwise leave them as ruled headings.
- Run axe-core if it is ever available, on the same 320 / 360 / 768 / 1440 grid.
- Look at the checkout stand-in and the payment-return state as a page, not only as a
  flow.
- Re-run the failure, empty, refused and long-output states against a real deployment with
  a model key, where the account's usage table has more than one row.
