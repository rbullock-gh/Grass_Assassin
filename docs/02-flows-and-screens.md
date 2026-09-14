# GrassAssassin — User Flows & Screen Map
**Owner:** FRIDAY (UI/UX) · Reviewed by SPIDER-MAN (usability)

---

## 1. Customer flow

### Onboarding → first job (the funnel that matters most)

```
Splash → Value prop (3 cards) → Sign up (email / Apple / Google)
  → Verify email (non-blocking; can post first)
  → "Where's your yard?"  ← address autocomplete
  → Confirm pin on map  ← drag to adjust
  → Yard size  ← auto-estimated from parcel data, user confirms
  → DONE: property created
```

**SPIDER-MAN note:** the original brief's order was *Create account → Add property → Post job*.
That front-loads two chores before any value. We invert it: the user starts posting a job and
the property is created *inside* that flow, because the address is needed anyway. Account
creation is deferred to the moment before publish, when the user is committed.
Measured elsewhere in this category, this pattern is worth 15–25% of the funnel.

### Post a job — 5 steps, each one screen

```
1. WHAT   job category grid (icons, large tap targets)
          → description, photos (optional but nudged)
2. WHERE  property picker (or add new) — pre-filled if only one
3. WHEN   date picker: Today · Tomorrow · This week · Pick date
          → optional time window
4. HOW    yard size confirm · equipment provided? · special instructions
          (gate code, dog, sprinkler heads, "don't touch the roses")
5. PRICE  price input with live guidance:
          ▸ "Jobs like this usually claim at $55–70"
          ▸ live claim-likelihood meter as they type
          → fee breakdown, total, payment method
          → REVIEW & PUBLISH
```

Every step is skippable-forward where legal; back preserves state; the whole draft
autosaves so a dropped session is recoverable. Progress is a 5-dot indicator, not a
percentage bar (percentages invite "how much is left" anxiety).

### After publish

```
POSTED         "Finding a pro near you" · live count of workers notified
CLAIMED        push: "Marcus claimed your job" · worker card · chat unlocked
EN_ROUTE       push + live ETA
IN_PROGRESS    push: "Work started" · before photos appear
PENDING_APPROVAL  push: "Work complete — review photos"
               → before/after slider · APPROVE · TIP · REPORT A PROBLEM
               → auto-approves in 24h (warned at 20h)
PAID           receipt
CLOSED         rate worker (1–5 + tags) · "Make this recurring?"  ← conversion moment
```

The "Make this recurring?" prompt fires at peak satisfaction, immediately after a good
rating. This is the highest-leverage single prompt in the product (see Strategy §3.1).

### Customer capabilities
View worker profile · rank · rating · completed jobs · message · notifications ·
cancel (per policy) · edit instructions (allowed until `IN_PROGRESS`) · approve ·
report problem · tip · rehire favorite · rate.

**Cancellation policy** (configurable, admin-editable):
| When | Charge |
|---|---|
| Before claim | free |
| Within 1h of claim | free |
| >1h after claim, >12h before window | 15% |
| <12h before window | 50% to worker |
| After `EN_ROUTE` | 100% to worker |

---

## 2. Worker flow

### Onboarding
```
Sign up → Phone verify (OTP) → Profile (photo, first name, bio)
  → Service radius (map circle, draggable)
  → Categories (what you'll do)  → Equipment (what you own)
  → Stripe Connect Express (identity + payout — hosted by Stripe)
  → Background check consent (Checkr)
  → PENDING → APPROVED → can claim
```
While `PENDING`, the worker can browse the map but not claim — showing them the money on
the table is the strongest possible motivation to finish onboarding.

### Home — answers "what can I earn right now?" in under one second

```
┌─────────────────────────────────┐
│  $340 this week    ⚡ 1,240 XP  │  ← earnings + rank strip
│  Lawn Ranger  ▓▓▓▓▓▓░░ 260 to  │
├─────────────────────────────────┤
│                                 │
│         [ MAP VIEW ]            │  ← full-bleed, clustered
│    $65    $45   $120            │     price markers
│       $80    $55                │
│                                 │
│  ╭───────────────────────────╮  │  ← draggable bottom sheet
│  │ ━━━                       │  │
│  │ 12 jobs nearby      ⚙ ▾   │  │
│  │ ┌───────────────────────┐ │  │
│  │ │ $65 · Lawn Mowing     │ │  │
│  │ │ 2.4 mi · ~0.4 acres   │ │  │
│  │ │ Due today 7 PM        │ │  │
│  │ │ ⭐ 4.9  Bring own     │ │  │
│  │ │ [VIEW]    [CLAIM $65] │ │  │
│  │ └───────────────────────┘ │  │
│  ╰───────────────────────────╯  │
└─────────────────────────────────┘
```

**Claim is two taps from cold open**, and `[CLAIM $65]` is present on the *card*, not only on
the detail screen — the single most important interaction in the product should never require
navigation.

Claim confirmation is a bottom-sheet with payout breakdown and a hold-to-confirm button
(prevents fat-finger claims, which produce cancellations, which cost points).

### Sort & filter
Sort: distance · highest pay · newest · due soon · **best $/est. hour**
Filters: max distance · min payout · category · equipment required · today · this week ·
difficulty. Filters persist per-worker and are summarized as removable chips.

### Job execution
```
CLAIMED → [I'M ON MY WAY] → notifies customer, shares live ETA
EN_ROUTE → [START WORK]   → geofence check (within 150m) + before photos
IN_PROGRESS → timer running, chat available
  → [COMPLETE] → after photos (required) → notes → submit
PENDING_APPROVAL → paid on approval (or 24h auto)
```

---

## 3. Screen map

### Mobile — Customer
```
/(auth)      welcome · sign-in · sign-up · verify-email · forgot-password
/(customer)
  /home            active jobs · quick-post · recent
  /post            [what · where · when · how · price · review]
  /jobs            list → /jobs/[id]  (status timeline, chat, photos, approve)
  /properties      list · add · edit
  /workers/[id]    public worker profile
  /messages        conversations → /messages/[id]
  /account         payment methods · notifications · privacy · support
```

### Mobile — Worker
```
/(worker)
  /map             ★ PRIMARY · map + bottom sheet + filters
  /list            list view of same data
  /jobs/[id]       detail · claim · execution
  /active          current job (persistent banner when active)
  /earnings        balance · history · payouts · tax docs
  /rank            XP · rank progress · badges · leaderboards
  /leaderboard     local · city · weekly · monthly · all-time · rookie
  /profile         edit · equipment · categories · radius
  /messages
```

### Web (Next.js)
```
/                 marketing
/how-it-works · /for-workers · /pricing · /cities/[slug]
/app/*            customer web app (mirrors mobile customer)
/admin/*          staff only
```

### Admin
```
/admin
  /                  metrics dashboard
  /users             search · detail · suspend · impersonate (audited)
  /workers           approval queue · background checks · ranks
  /jobs              search · detail · force-transition · reassign
  /payments          transactions · refunds · payouts · reconciliation
  /disputes          queue · evidence · resolve
  /reports           user reports · moderation queue
  /reviews           moderation
  /config
    /fees            commission · service fee · minimums  (per-market)
    /categories      job categories · difficulty · duration estimates
    /points          point rules · rank thresholds · benefits
    /service-areas   polygons · launch gates
    /plans           subscription plans
    /flags           feature flags
  /promos            promo codes
  /notifications     broadcast push
  /analytics         funnels · cohorts · markets
```

---

## 4. Responsive strategy

The brief is explicit that desktop must not be a stretched phone. Four layouts, one codebase,
driven by width breakpoints plus foldable posture APIs.

| Class | Width | Layout |
|---|---|---|
| Compact | <600dp | Full-bleed map, draggable bottom sheet (3 detents: peek / half / full). Single column. |
| Medium | 600–904dp | *Large phone, folded Fold, small tablet.* Map + persistent bottom sheet at half-detent. |
| Expanded | 905–1239dp | *Tablet, unfolded Fold.* **Two-pane:** list rail (360dp) │ map. Detail opens as a modal sheet. |
| Large | ≥1240dp | *Desktop.* **Three-pane:** filters+list (380) │ map (flex) │ detail (420). Nothing is ever a stretched phone. |

**Foldables specifically:** listen to fold posture. On a half-opened Fold (tabletop mode), the
map occupies the upper half and the job list the lower — a genuinely better experience than
either flat state, and a cheap differentiator since almost nobody does it.

**Also handled:** safe areas and notches, Dynamic Island collision on the map header,
landscape on phones (map left, list right), keyboard avoidance in the post flow, and the
iPad/desktop pointer affordances (hover states, right-click context menus) that touch-only
layouts forget.

---

## 5. Notification matrix

| Event | Customer | Worker | Channel |
|---|---|---|---|
| New matching job posted | — | ✅ "💰 New $85 mowing job 2.1 mi away" | push |
| Job claimed | ✅ | — | push + email |
| 24h / 3h before deadline | — | ✅ | push |
| Worker en route | ✅ | — | push |
| Work started | ✅ | — | push |
| Photos uploaded | ✅ | — | push |
| Work complete / approval needed | ✅ | — | push + email |
| Approval reminder (20h) | ✅ | — | push |
| Auto-approved | ✅ | ✅ | push |
| Payment released | — | ✅ | push |
| Tip received | — | ✅ | push |
| New message | ✅ | ✅ | push |
| Rank up | — | ✅ | push + in-app |
| Weekly leaderboard result | — | ✅ | push |
| Job expiring unclaimed | ✅ | — | push |

Quiet hours 9pm–7am local (except active-job events), per-category preferences,
and a hard cap on job-match pushes per worker per day so the map alerts stay valuable
rather than becoming noise people mute.
