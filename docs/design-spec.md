# Console design spec (proposal)

The bar for "the UI is good". Every claim in a review should be checkable against
one of the numbered rules below. If a rule is wrong, change the rule — not the UI
in isolation, or the two drift apart again.

Status: **proposal**, written from the code (tokens, `styles.css`,
`designer/designer.css`, the 12 views). It has **not** been checked against a
rendered screen — that is Phase 0's remaining job. Treat every "current" claim as
unverified until the visual baseline exists.

---

## 0. What this product is

A dense, dark-first **operations console** for a running multi-agent organisation:
one operator watching 12 views of an event-sourced mission (overview, events,
steps, agents, escalations, gates, graph, artifacts, product, cost, designer,
host settings). Optimise for **scanability under load and trust**, not for
delight. Two consequences that decide most arguments:

- **Density is a feature.** Do not "breathe" a working console into a marketing
  page. Whitespace must earn its place.
- **Two themes are a contract, not a skin.** Both are first-class; neither is a
  filter over the other.

---

## 1. Definition of done (the checklist)

A view is "best" only when **all** hold, in both themes and at 390 / 768 / 1280:

1. **States** — it has, and shows correctly: `loading`, `empty`, `error`,
   `partial` (some data), and `dense` (long/large content). No naked spinners,
   no empty box with no explanation.
2. **Keyboard** — every interactive control is reachable in visual order, has a
   visible `:focus-visible` ring, and Escape/Enter/Tab do what a user expects.
3. **Contrast** — body text ≥ 4.5:1, control boundaries ≥ 3:1, on the surface the
   element actually sits on (not just on white).
4. **Motion** — every non-essential animation is suppressed under
   `prefers-reduced-motion: reduce`.
5. **No bypass** — the view uses tokens and shared classes; it introduces no raw
   hex colour and no off-ramp `px` for type or rhythm (see §3, §4).
6. **Overflow** — long names, long paths, and 10k-row lists are handled by
   truncation or virtualisation, never by a horizontal page scrollbar.
7. **Honesty** — a number that is stale, partial, or estimated is labelled as
   such. The console reports the system; it must not flatter it.

---

## 2. Colour

Canonical tokens live in `:root` (`styles.css`) with a light override in
`[data-theme="light"]`.

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--bg-2`, `--panel`, `--panel-2`, `--drawer`, `--raised`, `--sunken` |
| Lines | `--line`, `--line-strong`, `--line-control` |
| Text | `--text`, `--text-dim`, `--muted` |
| Semantic | `--accent`, `--accent-2`, `--ok`, `--warn`, `--bad`, `--rej`, `--info` |
| Text-on-fill | `--text-on-accent`, `--text-on-hot` |
| Identity | `--role-*`, `--phase-prep`, `--phase-wait` |

Rules:

- **Text must never be a raw hex and never `--accent` on `--bg`** without a
  measured ratio. `--accent` is a *fill* colour; it fails as text on dark.
- **A chip tinted with its own hue** (`color-mix(in srgb, <token> N%, transparent)`
  — `.pill`, `.verdict`, `.bchip`, `.op-*`, `.avatar.tinted`) must clear 4.5:1 on
  the **darkest** surface it can land on. The light palette is derived to that
  target ("14% self-tint over `--sunken`"); re-derive the same way before editing
  any semantic value by eye.
- **`--line-control` is the >=3:1 boundary** for inputs. `--line` / `--line-strong`
  are decorative and must not be the only edge of a control.
- **`color-scheme`** must be set per theme (done) so native widgets follow.

---

## 3. Typography

One ramp. **Every** `font-size` resolves to one of these nine steps — currently
true in `styles.css` and `designer/designer.css` after the normalization pass:

```
10  11  12  13  14  16  18  20  30
```

Tier tokens (weight + size + line-height + family, so one rule = one tier):

| Token | Meaning |
|---|---|
| `--tx-title` | view title (`h2`) |
| `--tx-section` | uppercase group header |
| `--tx-label` | uppercase micro-label (nav, chips) |
| `--tx-value` | primary value / body |
| `--tx-meta` | secondary / metadata |

Rules:

- No half-pixel sizes. No tenth size. Need a new step → add a token and a reason,
  or use the nearest existing tier.
- Colour is **not** part of a tier (pair with `.muted`).
- **Heading order is semantic**: `h1`(app) → `h2`(view) → `h3`(section). Never
  skip a level for visual size.

---

## 4. Spacing, shape, elevation

```
--s0 2  --s1 4  --s1-5 6  --s2 8  --s2-5 10  --s3 12  --s3-5 14  --s4 16  --s5 20  --s6 28
--r-sm 6  --r 10  --r-lg 14
```

Rules:

- Rhythm (padding, margin, gap) uses `--s*`. Raw `px` is allowed **only** when
  optical-compensating a border or a glyph (e.g. `1.5px` ring, `padding: 0 0 6px`
  to centre a `3px`-bordered box) — and should say why in a comment.
- Radii are the three tokens only.
- Fixed/stuck layers use the `--z-*` ladder; never a bare `z-index`.

---

## 5. Breakpoints

Not tokens — CSS cannot read `var()` inside `@media`. The ladder is enforced by
convention (`styles.css` header):

```
1280  compact topbar        900  dense grids stack
1100  two-up grids collapse  800  sidebar → off-canvas drawer   (JS: NARROW)
760   step lanes compress    620  phone — topbar collapses      (JS: PHONE)
560   minimum supported      640  legacy stray → converge on 620
```

`801` is the deliberate complement of `800`. Any new media query must pick from
this list. `860` is the one remaining stray.

---

## 6. Components

Shared primitives in `components.tsx` (`Card`, `Pill`, `Input`, `ErrorState`, …)
are the **only** source of those shapes. A view that re-implements a Pill with
inline styles is a bug against this spec (§1.5).

Every primitive documents its states (§1.1) and owns its focus ring (§1.2).
Inline `style={{}}` is reserved for one-off, non-repeatable geometry — the
current ~150 sites are debt, not a pattern.

---

## 7. Visual QA protocol

Until this exists, "best" is unfalsifiable. Capture, per theme, at 390 / 768 /
1280:

1. Shell + nav + topbar (both themes, all three widths).
2. Each of the 12 views with **real** data (not empty).
3. Each view's `empty` and `error` state.
4. One **long-content** case (deep event list / large artifact / long agent name).
5. Drawer open; command palette open; one modal/confirm.
6. A keyboard-only pass: Tab through the primary flow, screenshot the focus ring.

Store under `docs/assets/` and treat a change to any of them as a review trigger.

---

## 8. Phases

| Phase | Scope | Needs the browser? |
|---|---|---|
| **0 Foundation** | This spec · preview · **visual baseline (todo)** | baseline: yes |
| **1 Polish & harden** | States, focus, reduced-motion, contrast, overflow; kill the remaining raw `px`/inline-style debt; responsive at 3 widths | yes (verify) |
| **2 Redesign** | The genuinely weak surfaces — `Escalations` density first, then `Overview` rhythm, then any view the baseline condemns | yes |
| **3 Guardrails** | Stylelint (ban raw hex + off-ramp px), visual-regression baseline wired to the QA protocol | partly |

Phase 1 is code-verifiable and lowest-risk. Phase 2 is where taste lives and is
illegitimate to do blind.
