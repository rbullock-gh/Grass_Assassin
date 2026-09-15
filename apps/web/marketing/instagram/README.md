# Instagram launch creative

Seven assets and their captions, for the pre-launch waitlist push. Six 1080×1350
feed posts and one 1080×1920 story, generated from the product's own design
tokens and the mark in `apps/admin/src/app/icon.svg` — so an ad and the landing
page it points at look like the same company.

```bash
node apps/web/marketing/instagram/build.mjs     # renders into out/
```

| File | Audience | Angle |
|---|---|---|
| `01-keep-88.png` | worker | Take-home rate, stated as a fee not an earnings claim |
| `02-decline-free.png` | worker | Declining never costs anything — the sharpest differentiator we have |
| `03-priced-before.png` | worker | No quoting, no bidding, no unpaid site visits |
| `04-rank-ladder.png` | worker | Commission falls with rank; save-worthy |
| `05-you-set-the-price.png` | homeowner | Customer-set pricing |
| `06-approve-then-pay.png` | homeowner | Photos, approval, then payment |
| `07-pick-a-city.png` | both · story | Waitlist decides the first market |

Worker-first is deliberate: `docs/00-strategy.md` **Q4** makes the launch market
a function of where the first 30 workers can be recruited, so supply is what the
creative is for. The two homeowner posts exist so a customer landing on the
profile does not find a recruitment account.

## Copy lives in `posts.mjs`, not in the renderer

`posts.mjs` is the file a human edits. `build.mjs` only draws it. Captions are in
`captions.md`, and **`captions.md` also carries the rules you need before
spending money** — the unset waitlist endpoint, FTC exposure on earnings claims,
and Meta's Employment special ad category, which may strip the precise
geo-targeting the single-metro launch plan assumes.

## What is enforced

`apps/web/test/marketing-copy.test.ts` runs in CI and fails on:

- **A rate the product does not charge.** Every percentage and dollar figure in
  `posts.mjs` and in the blockquoted captions must be producible from
  `DEFAULT_FEE_CONFIG` and `RANKS`.
- **A rank ladder that has drifted.** The poster's rows are checked name by name,
  threshold by threshold, rate by rate against `RANKS`. A printed ladder outlives
  the config that produced it.
- **Employment framing.** `docs/00-strategy.md` R2 calls worker misclassification
  an existential risk and requires that the product never exert employment-style
  control. Recruitment copy is where that slips first, because "join our team" is
  the most natural phrase in the genre. The test rejects it and fifteen
  relatives, along with anything implying the app can be downloaded today.

Only blockquoted lines in `captions.md` count as copy. The guidance sections
quote forbidden phrasing in order to forbid it, and are excluded.

All three checks were confirmed to fail when deliberately broken, then restored.

## Fonts

The renderer pulls Inter from Google Fonts. Behind a TLS-inspecting proxy
Chromium will accept the stylesheet and refuse the font files, and the posters
ship in a fallback face — the build fails loudly rather than letting that
through. To render with no network at all, point `GA_FONT_CSS` at a stylesheet
with the faces embedded as data URIs:

```bash
GA_FONT_CSS=/path/to/inter-embedded.css node apps/web/marketing/instagram/build.mjs
```
