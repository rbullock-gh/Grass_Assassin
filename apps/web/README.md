# @grassassassin/web

The public marketing site. A static export — no server, no database, no session.
Its only job is to turn a visitor into a waitlist signup with a ZIP code
attached, because the ZIP is what answers the open question in
[`docs/00-strategy.md`](../../docs/00-strategy.md) **Q4: which market launches first**.

```bash
pnpm --filter @grassassassin/web dev        # localhost:3002
pnpm --filter @grassassassin/web build      # static export into out/
pnpm --filter @grassassassin/web typecheck
pnpm --filter @grassassassin/web test

node apps/web/scripts/make-assets.mjs       # favicons + link-preview card
node apps/web/scripts/check-rendered.mjs    # render the export and check it
```

## Before this goes live

Both are silent failures — the page looks perfectly fine with either unset.

| | |
|---|---|
| `NEXT_PUBLIC_WAITLIST_ENDPOINT` | **Blocker.** Where the form POSTs. Unset, the form renders a visible error instead of pretending to work, but nothing is collected. Any form service that accepts a multipart POST and returns JSON works (Formspree, Tally, Basin). |
| `NEXT_PUBLIC_SITE_URL` | Defaults to `https://grassassassin.com`. It sets the canonical URL and the absolute `og:image`; a wrong value means link previews resolve to a domain you do not own. |

Longer term the form should POST to our own API rather than a third party: the
ZIP distribution *is* the launch-market decision, and it is worth more in
Postgres, queryable, than in someone's CSV export.

## The rule here: numbers are derived, never typed

Every rate and threshold on the page is computed from `@grassassassin/shared` —
`DEFAULT_FEE_CONFIG` and `RANKS` — in [`src/content.ts`](src/content.ts). Change
a default in the domain package and the page follows on the next build.

This is enforced twice, because a marketing page quoting a rate the API does not
charge is worse than one quoting nothing:

- **`test/content.test.ts`** scans the finished prose for anything shaped like
  `15%` or `$40` and fails unless the fee config can actually produce it. It
  catches a literal typed into the middle of a sentence, which derivation alone
  cannot.
- **`test/tokens.test.ts`** parses `globals.css` and asserts every `--ga-*`
  custom property equals the `@grassassassin/design` token named in its trailing
  comment. `apps/admin` mirrors the same tokens by hand with nothing checking
  it, and its `--brand` has already drifted a step darker than
  `semanticLight.brand`. That is survivable on an internal dashboard; it is not
  survivable on the page a customer sees immediately before opening the app.

Both tests were confirmed to fail when deliberately broken, then restored.

## Where the copy lives

`src/content.ts` holds the FAQ, the audience-specific pitches, and the derived
fee strings. `src/app/page.tsx` holds section prose.

The FAQ is declared **once** and generates both the rendered `<details>` blocks
and the `FAQPage` structured data. Google requires every answer in the markup to
be visible on the page; generating both from one array makes that true by
construction rather than by review.

## Two deliberate choices

**The audience switch is CSS, not JavaScript.** Real radio inputs plus `:has()`,
so it works with JavaScript off and adds nothing to the bundle. Guarded by
`@supports selector(:has(*))` — in a browser without `:has()` both panels stay
on the page and the only thing lost is the filtering.

**The form works without JavaScript.** It is a plain POST to the form provider.
The client component only upgrades that to an inline confirmation so the visitor
is not thrown onto a third-party page.

## What the page claims, and where each claim comes from

Nothing here is asserted without a source in this repository.

| Claim | Source |
|---|---|
| 12% worker commission · 88% take-home | `DEFAULT_FEE_CONFIG.workerCommissionBps` |
| 8% customer service fee, $2.99 floor | `DEFAULT_FEE_CONFIG.customerServiceFeeBps`, `customerServiceFeeMinCents` |
| Jobs from $25 | `DEFAULT_FEE_CONFIG.minJobPriceCents` |
| Commission falls to 8% at the top rank | `RANKS[].commissionDiscountBps` |
| Rank names and point thresholds | `RANKS` |
| Declining a job costs nothing | `docs/00-strategy.md` §Ranks — stated as permanent product behaviour |
| Tips are not cut by the platform | `docs/00-strategy.md` §5 monetization table |
| Homeowner sets the price | `docs/00-strategy.md` Q5 |
| "Built", "not in the app stores", "no market open" | root `README.md` status table |
| Which market launches first is undecided | `docs/00-strategy.md` Q4 |
| The mark | `apps/admin/src/app/icon.svg`, reused rather than redrawn |
| Premium tone, humour only in micro-copy | `docs/00-strategy.md` Q3 |

**Needs a human decision before launch** — both are defensible, neither is mine
to make:

- **Publishing the take rate at all.** 12%/8% is low against comparable
  marketplaces and reads as a competitive advantage, which is why it is on the
  page. It is also a number competitors can read. Delete the pricing section and
  the two FAQ cost entries to remove it; the tests will still pass.
- **The privacy promise** in the last FAQ entry ("not sold or passed on,
  one-click unsubscribe") is a commitment the business has to actually honour.
