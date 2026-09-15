# Instagram captions

One caption per asset in `out/`. First line is the hook — Instagram truncates
around 125 characters, so everything that has to land is in front of the fold.

Numbers in these captions are pinned to `DEFAULT_FEE_CONFIG` by
`apps/web/test/marketing-copy.test.ts`. Editing a rate here without changing the
product fails the suite.

---

## Read this before you spend a dollar

**1. The waitlist form has no endpoint yet.** `NEXT_PUBLIC_WAITLIST_ENDPOINT` is
unset, so the landing page currently shows an error instead of collecting
anything. Paid clicks against that page are money set on fire. Wire it first.

**2. Never state or imply earnings.** Not "make $800 a week", not "top pros
earn…", not a screenshot of somebody's balance. The FTC has pursued gig
platforms specifically over inflated earnings claims, and those cases turn on
whether typical users actually achieved the advertised figure — which, with no
market open, we cannot substantiate for anybody. "You keep 88%" is a *fee
disclosure* and is safe. "You'll earn X" is a *performance claim* and is not.

**3. Worker ads may be forced into Meta's Employment special ad category.**
Recruiting people to earn money through a platform has, in the past, triggered
it. If it applies, detailed targeting is stripped and the minimum radius widens
to roughly 15 miles — which directly undercuts the tight single-metro targeting
that `docs/00-strategy.md` Q4 assumes. **Verify against Meta's current policy
before building the launch plan around precise geo-targeting**, because if it
applies, the cheap way to reach the first 30 workers is organic: local lawn-care
Facebook groups, equipment dealers, and turning up where crews already are.
Customer-side ads are not affected.

**4. Do not imply the app is available.** There is no app store listing and no
open market. Every CTA points at the waitlist. Meta rejects ads whose landing
page does not match the promise, and "Download now" would be exactly that.

**5. R2 language rules.** Per the risk register, nothing may frame this as
employment: no "join our team", no "we're hiring", no "apply", no "shifts", and
ranks are never described as performance management. Workers are independent and
the copy has to keep saying so. This is a legal position, not a style preference.

---

## 01 · `01-keep-88.png` — worker

> You keep 88% of the job price.
>
> Commission is 12%. It drops to 8% as you rank up, and we never touch tips.
>
> No bidding against four other people. No driving across town to hand someone a
> number for free. The price is on the job before you claim it — take it or leave
> it, and leaving it costs you nothing.
>
> We're not open anywhere yet. The waitlist decides which city goes first, so if
> you cut grass for a living, get your ZIP on it. Link in bio.
>
> #lawncare #lawncarelife #lawnmowing #landscaping #yardwork #mowing #smallbusiness #lawncarebusiness

## 02 · `02-decline-free.png` — worker

> Turning down a job costs you nothing. Not now, not ever.
>
> No acceptance rate. No score quietly counting against you. No "you've been
> deprioritised" email. You set your radius and your schedule, and work outside
> them never reaches you in the first place.
>
> That isn't a promotion — it's built that way on purpose and it isn't changing.
>
> Waitlist is open and it decides our first city. Link in bio.
>
> #lawncare #lawncarelife #landscaping #lawncarebusiness #mowing #yardwork #smallbusiness

## 03 · `03-priced-before.png` — worker

> The price is set before you ever see the job.
>
> Every job shows up on the map already priced and already scoped. No quoting. No
> bidding war. No twenty-minute round trip to look at a yard you were never going
> to take.
>
> You look at the number, you look at where it is, and you decide. That's it.
>
> Not open anywhere yet — the waitlist picks the first city. Link in bio.
>
> #lawncare #lawnmowing #landscaping #lawncarebusiness #yardwork #mowing #curbappeal

## 04 · `04-rank-ladder.png` — worker · save-worthy

> Your commission goes down as you go up.
>
> Everyone starts at 12%. Do good work and it falls — 11%, 10%, 9%, 8% at the top.
> It's the same job; you just keep more of it.
>
> Rank comes from your rating, your completion rate and turning up on time, over a
> rolling window. It can't be bought, and it can't be bumped by taking every job
> that appears — declining costs nothing at every level.
>
> Save this one. Waitlist in bio.
>
> #lawncare #lawncarebusiness #landscaping #lawnmowing #smallbusiness #mowing #yardwork

## 05 · `05-you-set-the-price.png` — homeowner

> You set the price. Someone nearby claims it.
>
> Post what the job is worth to you, from $25. No waiting a week for a quote, no
> stranger turning up just to give you a number, no three phone calls to find out
> whether anyone's coming.
>
> Local, approved, and you see the price before anything happens.
>
> We haven't opened anywhere yet. Drop your ZIP on the waitlist and help us pick.
> Link in bio.
>
> #lawncare #curbappeal #yardwork #homeowner #lawnmowing #hometips #frontyard

## 06 · `06-approve-then-pay.png` — homeowner

> Nothing leaves your account until you've seen the work.
>
> Before-and-after photos land in the app when the job's done. You look. You
> approve. Then they get paid — not before.
>
> Changed your mind before anyone claimed it? Cancel, costs nothing.
>
> Waitlist is open and it decides our first city. Link in bio.
>
> #lawncare #curbappeal #yardwork #homeowner #hometips #lawnmowing

## 07 · `07-pick-a-city.png` — story, 9:16

> Sticker suggestion: put a poll or a question sticker over the lower third —
> "Where should we launch?" collects ZIPs directly in replies and gives the story
> something to interact with.
>
> Caption if reposting to feed:
>
> We haven't picked a first city yet. Yours could be it.
>
> Drop your ZIP on the waitlist. We're opening where the most people asked — both
> the folks who want their grass cut and the folks who cut it. Link in bio.

---

## Sequencing

Supply first. `docs/00-strategy.md` Q4 says the launch market is decided by where
the first 30 workers can be recruited, so the worker posts (01–04) carry the
weight and the homeowner posts (05–06) exist so the feed doesn't read as a
recruitment account when a customer lands on it.

A workable first two weeks: **02** (the strongest differentiator — every gig
worker has been punished for declining something), then **01**, then **05**,
then **04** as a save-worthy post, then **03**, then **06**. Run **07** as a
story whenever you post a feed item.

Post 02 is the one to put money behind if you only boost one.
