/**
 * Seeds reference data and a small demo marketplace.
 *
 * Reference data (categories, equipment, ranks, point rules, fee config) is
 * idempotent and safe to run against any environment — it is what the app needs
 * to function at all. Demo users and jobs are only created outside production.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import argon2 from 'argon2'
import { createId } from '@paralleldrive/cuid2'
import { RANKS, DEFAULT_POINT_VALUES, DEFAULT_FEE_CONFIG, computeApproximateLocation } from '@grassassassin/shared'

const prisma = new PrismaClient()

/**
 * Job categories.
 *
 * Seasonal categories are deliberately present but inactive. Lawn revenue
 * collapses November–March in most US metros, and the way this category
 * survives winter is leaf removal, gutters and light snow work — which we can
 * switch on without a release precisely because categories are data.
 */
const CATEGORIES = [
  { slug: 'mow-lawn',       name: 'Lawn Mowing',       icon: 'mower',       difficulty: 1, baseMinutes: 45,  low: 4000, high: 7500,  active: true,  order: 1 },
  { slug: 'weed-eat',       name: 'Weed Eating',       icon: 'trimmer',     difficulty: 1, baseMinutes: 30,  low: 3000, high: 5500,  active: true,  order: 2 },
  { slug: 'edge-driveway',  name: 'Edging',            icon: 'edger',       difficulty: 1, baseMinutes: 25,  low: 2500, high: 4500,  active: true,  order: 3 },
  { slug: 'blow-leaves',    name: 'Leaf Blowing',      icon: 'blower',      difficulty: 2, baseMinutes: 40,  low: 3500, high: 7000,  active: true,  order: 4 },
  { slug: 'trim-bushes',    name: 'Bush Trimming',     icon: 'shears',      difficulty: 3, baseMinutes: 60,  low: 5000, high: 11000, active: true,  order: 5 },
  { slug: 'pull-weeds',     name: 'Weed Pulling',      icon: 'gloves',      difficulty: 2, baseMinutes: 50,  low: 3500, high: 7500,  active: true,  order: 6 },
  { slug: 'flower-beds',    name: 'Flower Bed Cleanup',icon: 'flower',      difficulty: 2, baseMinutes: 55,  low: 4000, high: 9000,  active: true,  order: 7 },
  { slug: 'remove-branches',name: 'Branch Removal',    icon: 'branch',      difficulty: 4, baseMinutes: 75,  low: 6000, high: 15000, active: true,  order: 8 },
  { slug: 'pressure-wash',  name: 'Pressure Washing',  icon: 'sprayer',     difficulty: 3, baseMinutes: 90,  low: 8000, high: 20000, active: true,  order: 9 },
  { slug: 'mulch',          name: 'Mulching',          icon: 'mulch',       difficulty: 3, baseMinutes: 100, low: 7500, high: 18000, active: true,  order: 10 },
  { slug: 'yard-cleanup',   name: 'Yard Cleanup',      icon: 'rake',        difficulty: 3, baseMinutes: 110, low: 7000, high: 20000, active: true,  order: 11 },
  { slug: 'haul-debris',    name: 'Debris Hauling',    icon: 'truck',       difficulty: 4, baseMinutes: 70,  low: 6500, high: 18000, active: true,  order: 12 },
  { slug: 'gutter-clean',   name: 'Gutter Cleaning',   icon: 'gutter',      difficulty: 4, baseMinutes: 80,  low: 8000, high: 18000, active: false, order: 13 },
  { slug: 'snow-removal',   name: 'Snow Removal',      icon: 'snow',        difficulty: 3, baseMinutes: 50,  low: 5000, high: 12000, active: false, order: 14 },
  { slug: 'other',          name: 'Other Outdoor Work',icon: 'plus',        difficulty: 2, baseMinutes: 60,  low: 4000, high: 12000, active: true,  order: 99 },
]

const EQUIPMENT = [
  { slug: 'push-mower',    name: 'Push Mower' },
  { slug: 'riding-mower',  name: 'Riding Mower' },
  { slug: 'string-trimmer',name: 'String Trimmer' },
  { slug: 'edger',         name: 'Edger' },
  { slug: 'leaf-blower',   name: 'Leaf Blower' },
  { slug: 'hedge-trimmer', name: 'Hedge Trimmer' },
  { slug: 'chainsaw',      name: 'Chainsaw' },
  { slug: 'pressure-washer',name: 'Pressure Washer' },
  { slug: 'truck-trailer', name: 'Truck / Trailer' },
  { slug: 'wheelbarrow',   name: 'Wheelbarrow' },
]

const BADGES = [
  { key: 'first-job',      name: 'First Cut',        description: 'Completed your first job' },
  { key: 'photo-pro',      name: 'Photo Pro',        description: 'Before and after photos on 25 jobs' },
  { key: 'early-bird',     name: 'Early Bird',       description: 'Ten jobs finished before deadline' },
  { key: 'streak-10',      name: 'On a Roll',        description: 'Ten jobs in a row without a cancellation' },
  { key: 'perfect-week',   name: 'Perfect Week',     description: 'Five-star ratings across a full week' },
  { key: 'regular',        name: 'The Regular',      description: 'Five customers booked you more than once' },
]

async function seedReferenceData() {
  for (const c of CATEGORIES) {
    await prisma.serviceCategory.upsert({
      where: { slug: c.slug },
      create: {
        slug: c.slug, name: c.name, icon: c.icon, difficulty: c.difficulty,
        baseMinutes: c.baseMinutes, typicalLowCents: c.low, typicalHighCents: c.high,
        active: c.active, sortOrder: c.order,
      },
      update: {
        name: c.name, icon: c.icon, difficulty: c.difficulty, baseMinutes: c.baseMinutes,
        typicalLowCents: c.low, typicalHighCents: c.high, sortOrder: c.order,
      },
    })
  }

  for (const [i, e] of EQUIPMENT.entries()) {
    await prisma.equipment.upsert({
      where: { slug: e.slug },
      create: { slug: e.slug, name: e.name, sortOrder: i },
      update: { name: e.name, sortOrder: i },
    })
  }

  for (const [i, r] of RANKS.entries()) {
    await prisma.rank.upsert({
      where: { key: r.key },
      create: {
        key: r.key, name: r.name, minPoints: r.minPoints, sortOrder: i,
        commissionDiscountBps: r.commissionDiscountBps, radiusBonusMiles: r.radiusBonusMiles,
        earlyAccessMinutes: r.earlyAccessMinutes, verifiedBadge: r.verifiedBadge,
        minRating: r.minRating, minCompletionRate: r.minCompletionRate, minOnTimeRate: r.minOnTimeRate,
      },
      update: {
        name: r.name, minPoints: r.minPoints, sortOrder: i,
        commissionDiscountBps: r.commissionDiscountBps, radiusBonusMiles: r.radiusBonusMiles,
        earlyAccessMinutes: r.earlyAccessMinutes, verifiedBadge: r.verifiedBadge,
        minRating: r.minRating, minCompletionRate: r.minCompletionRate, minOnTimeRate: r.minOnTimeRate,
      },
    })
  }

  for (const [event, points] of Object.entries(DEFAULT_POINT_VALUES)) {
    await prisma.pointRule.upsert({
      where: { event },
      create: { event, points, active: true },
      update: {},  // never clobber an admin's tuning
    })
  }

  for (const b of BADGES) {
    await prisma.badge.upsert({
      where: { key: b.key },
      create: b,
      update: { name: b.name, description: b.description },
    })
  }

  const config: Array<[string, unknown]> = [
    ['fees.worker_commission_bps', DEFAULT_FEE_CONFIG.workerCommissionBps],
    ['fees.customer_service_fee_bps', DEFAULT_FEE_CONFIG.customerServiceFeeBps],
    ['fees.customer_service_fee_min_cents', DEFAULT_FEE_CONFIG.customerServiceFeeMinCents],
    ['fees.min_job_price_cents', DEFAULT_FEE_CONFIG.minJobPriceCents],
    ['fees.max_job_price_cents', DEFAULT_FEE_CONFIG.maxJobPriceCents],
    ['cancellation.grace_minutes', 60],
    ['cancellation.late_hours', 12],
    ['cancellation.early_penalty_bps', 1500],
    ['cancellation.late_penalty_bps', 5000],
    ['approval.auto_approve_hours', 24],
  ]
  for (const [key, value] of config) {
    const existing = await prisma.platformConfig.findFirst({ where: { key, scopeKey: null } })
    if (!existing) {
      await prisma.platformConfig.create({ data: { key, value: value as never, scopeKey: null } })
    }
  }

  /**
   * Launch market.
   *
   * PLACEHOLDER. The real first market is a founder decision that has not been
   * made yet. The gate exists so the app can honestly tell someone outside the
   * service area that we are not live near them — showing an empty map instead
   * is how a marketplace burns a customer permanently. Change this from the
   * admin dashboard; no code change is required.
   */
  const existingArea = await prisma.serviceArea.findUnique({ where: { slug: 'nashville' } })
  if (!existingArea) {
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "service_areas" ("id","name","slug","centerLocation","radiusMiles","active","launchedAt","createdAt","updatedAt")
      VALUES (${createId()}, 'Nashville', 'nashville',
        ST_SetSRID(ST_MakePoint(-86.7816::float8, 36.1627::float8), 4326)::geography,
        30, true, now(), now(), now())
    `)
  }
}

// ---------------------------------------------------------------------------
// Demo data — never in production
// ---------------------------------------------------------------------------

const NASHVILLE = { lat: 36.1627, lng: -86.7816 }

function jitter(base: { lat: number; lng: number }, maxMiles: number) {
  const angle = Math.random() * Math.PI * 2
  const dist = Math.random() * maxMiles
  return {
    lat: base.lat + (dist / 69) * Math.cos(angle),
    lng: base.lng + (dist / (69 * Math.cos((base.lat * Math.PI) / 180))) * Math.sin(angle),
  }
}

async function seedDemoData() {
  const passwordHash = await argon2.hash('GrassDemo123!', {
    type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1,
  })

  const categories = await prisma.serviceCategory.findMany({ where: { active: true } })
  const equipment = await prisma.equipment.findMany()
  const ranks = await prisma.rank.findMany({ orderBy: { minPoints: 'asc' } })

  // --- customers ---
  const customers = []
  for (const [i, name] of ['Casey', 'Jordan', 'Morgan', 'Avery', 'Quinn'].entries()) {
    const email = `customer${i + 1}@grassassassin.test`
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email, passwordHash, firstName: name, lastName: 'Demo',
        roles: ['CUSTOMER'], emailVerifiedAt: new Date(),
      },
      /*
       * The password is RESET on every run, not left alone.
       *
       * `update: {}` meant re-seeding did not restore the credentials this
       * script prints at the end. Anything that had changed the password since
       * — a demo of the reset flow, a manual test — left the script cheerfully
       * announcing a password that no longer worked, and the failure surfaced
       * later as an unrelated harness dying on "Incorrect email or password".
       * A seed that advertises credentials has to guarantee them.
       */
      update: { passwordHash, emailVerifiedAt: new Date(), deletedAt: null, status: 'ACTIVE' },
    })
    await prisma.customerProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id, stripeCustomerId: `cus_demo_${i + 1}`,
        defaultPaymentMethodId: 'pm_demo_visa',
        averageRating: 4.4 + Math.random() * 0.6, ratingCount: 3 + i * 4, jobsCompleted: 2 + i * 3,
      },
      update: {},
    })

    const point = jitter(NASHVILLE, 12)
    const existing = await prisma.property.findFirst({ where: { ownerId: user.id } })
    let propertyId = existing?.id
    if (!propertyId) {
      propertyId = createId()
      await prisma.$executeRaw(Prisma.sql`
        INSERT INTO "properties" ("id","ownerId","label","addressLine1","city","state","postalCode",
          "countryCode","location","yardSize","lotSizeAcres","hasDog","createdAt","updatedAt")
        VALUES (${propertyId}, ${user.id}, 'Home', ${`${100 + i * 37} Harding Pike`},
          'Nashville','TN','37205','US',
          ST_SetSRID(ST_MakePoint(${point.lng}::float8, ${point.lat}::float8), 4326)::geography,
          'QUARTER_TO_HALF'::"YardSize", 0.375, ${i % 3 === 0}, now(), now())
      `)
    }
    customers.push({ user, propertyId, point })
  }

  // --- workers, spread across ranks so the leaderboard looks real ---
  const workerSpecs = [
    { name: 'Mike',   points: 8420, jobs: 84, rating: 4.9 },
    { name: 'Tyler',  points: 7980, jobs: 79, rating: 4.8 },
    { name: 'James',  points: 7550, jobs: 74, rating: 4.9 },
    { name: 'Dana',   points: 4100, jobs: 41, rating: 4.7 },
    { name: 'Sam',    points: 1620, jobs: 17, rating: 4.6 },
    { name: 'Riley',  points: 540,  jobs: 6,  rating: 4.5 },
    { name: 'Alex',   points: 90,   jobs: 1,  rating: null },
  ]

  for (const [i, spec] of workerSpecs.entries()) {
    const email = `worker${i + 1}@grassassassin.test`
    const user = await prisma.user.upsert({
      where: { email },
      create: {
        email, passwordHash, firstName: spec.name, lastName: 'Demo',
        roles: ['WORKER'], emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
      },
      // As above: re-seeding restores the advertised password rather than
      // printing one that may no longer be true.
      update: {
        passwordHash, emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(),
        deletedAt: null, status: 'ACTIVE',
      },
    })

    const rank = [...ranks].reverse().find((r) => spec.points >= r.minPoints) ?? ranks[0]!
    const profile = await prisma.workerProfile.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id, status: 'APPROVED', bio: `${spec.name} — ${spec.jobs} jobs completed.`,
        serviceRadiusMiles: 12 + i, points: spec.points, lifetimePoints: spec.points,
        rankId: rank.id, completedJobs: spec.jobs, claimedJobs: spec.jobs + 2,
        averageRating: spec.rating, ratingCount: spec.jobs,
        completionRate: 0.94 + Math.random() * 0.06, onTimeRate: 0.9 + Math.random() * 0.1,
        stripeAccountId: `acct_demo_${i + 1}`, payoutsEnabled: true, chargesEnabled: true,
        backgroundCheckStatus: 'CLEAR', currentStreak: i, longestStreak: i + 3,
        availableBalanceCents: spec.jobs * 4200,
        lifetimeEarningsCents: spec.jobs * 5280,
      },
      update: {},
    })

    // Back the cached points with real ledger rows.
    //
    // Without these the leaderboard (which sums point_transactions) shows an
    // empty board, and detectPointsDrift flags every seeded worker. A demo
    // whose own invariant checks fail is worse than no demo.
    const existingPoints = await prisma.pointTransaction.count({ where: { workerProfileId: profile.id } })
    if (existingPoints === 0 && spec.points > 0) {
      let running = 0
      const entries: Array<{ event: string; points: number; daysAgo: number }> = []
      for (let j = 0; j < spec.jobs; j++) {
        entries.push({ event: 'JOB_COMPLETED', points: 100, daysAgo: Math.floor((j / spec.jobs) * 60) })
      }
      // Distribute the remainder across quality events so the totals match the
      // profile figure exactly rather than approximately.
      let remainder = spec.points - spec.jobs * 100
      while (remainder > 0) {
        const points = Math.min(remainder, 25)
        entries.push({ event: 'COMPLETED_BEFORE_DEADLINE', points, daysAgo: Math.floor(Math.random() * 60) })
        remainder -= points
      }

      entries.sort((a, b) => b.daysAgo - a.daysAgo)
      await prisma.pointTransaction.createMany({
        data: entries.map((e) => {
          running += e.points
          return {
            workerProfileId: profile.id,
            event: e.event,
            points: e.points,
            balanceAfter: running,
            createdAt: new Date(Date.now() - e.daysAgo * 86_400_000),
          }
        }),
      })
      await prisma.workerProfile.update({
        where: { id: profile.id },
        data: { points: running, lifetimePoints: running },
      })
    }

    const base = jitter(NASHVILLE, 8)
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "worker_profiles"
         SET "baseLocation" = ST_SetSRID(ST_MakePoint(${base.lng}::float8, ${base.lat}::float8), 4326)::geography
       WHERE "id" = ${profile.id}
    `)

    // Skills and equipment, varied so filters have something to bite on.
    for (const category of categories.slice(0, 4 + (i % 6))) {
      await prisma.workerService.upsert({
        where: { workerProfileId_categoryId: { workerProfileId: profile.id, categoryId: category.id } },
        create: { workerProfileId: profile.id, categoryId: category.id },
        update: {},
      })
    }
    for (const eq of equipment.slice(0, 3 + (i % 5))) {
      await prisma.workerEquipment.upsert({
        where: { workerProfileId_equipmentId: { workerProfileId: profile.id, equipmentId: eq.id } },
        create: { workerProfileId: profile.id, equipmentId: eq.id },
        update: {},
      })
    }
  }

  // --- completed job history ---
  //
  // Without these the dashboard reads \$0 gross volume and 0% claim rate, which
  // makes a working marketplace look broken. Each completed job writes the same
  // balanced ledger lines the real settlement path writes, so the trial balance
  // nets to zero exactly as it would in production.
  const existingJobs = await prisma.job.count()
  if (existingJobs > 0) return

  const workers = await prisma.workerProfile.findMany({
    where: { status: 'APPROVED' },
    select: { id: true, userId: true },
  })

  const historySpecs = [
    { cat: 'mow-lawn',     price: 6000,  daysAgo: 2,  minutes: 47,  rating: 5 },
    { cat: 'mow-lawn',     price: 5500,  daysAgo: 3,  minutes: 41,  rating: 5 },
    { cat: 'yard-cleanup', price: 13500, daysAgo: 4,  minutes: 165, rating: 4 },
    { cat: 'blow-leaves',  price: 6500,  daysAgo: 5,  minutes: 52,  rating: 5 },
    { cat: 'trim-bushes',  price: 9000,  daysAgo: 6,  minutes: 88,  rating: 5 },
    { cat: 'mulch',        price: 15000, daysAgo: 8,  minutes: 140, rating: 4 },
    { cat: 'weed-eat',     price: 4000,  daysAgo: 9,  minutes: 33,  rating: 5 },
    { cat: 'pressure-wash',price: 18000, daysAgo: 11, minutes: 120, rating: 5 },
    { cat: 'mow-lawn',     price: 5800,  daysAgo: 12, minutes: 44,  rating: 5 },
    { cat: 'edge-driveway',price: 3500,  daysAgo: 13, minutes: 28,  rating: 4 },
  ]

  for (const [i, spec] of historySpecs.entries()) {
    const customer = customers[i % customers.length]!
    const worker = workers[i % workers.length]
    const category = categories.find((c) => c.slug === spec.cat)
    if (!category || !worker) continue

    const fee = Math.max(299, Math.round((spec.price * 800) / 10_000))
    const commission = Math.round((spec.price * 1200) / 10_000)
    const payout = spec.price - commission
    const total = spec.price + fee

    const postedAt = new Date(Date.now() - (spec.daysAgo * 86_400_000 + 6 * 3_600_000))
    const claimedAt = new Date(postedAt.getTime() + (12 + i * 7) * 60_000)
    const completedAt = new Date(claimedAt.getTime() + spec.minutes * 60_000 + 2 * 3_600_000)
    const dueAt = new Date(completedAt.getTime() + 4 * 3_600_000)

    const jobId = createId()
    const location = jitter(customer.point, 1.5)
    const approx = computeApproximateLocation(location)

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "jobs" (
        "id","customerId","propertyId","categoryId","title","status",
        "exactLocation","approxLocation","generalArea",
        "priceCents","serviceFeeCents","customerTotalCents","workerCommissionCents","workerPayoutCents",
        "dueAt","yardSize","estimatedMinutes","difficulty","equipmentProvided",
        "claimedByWorkerId","claimedAt","postedAt","enRouteAt","startedAt",
        "completedAt","approvedAt","paidAt","closedAt","createdAt","updatedAt"
      ) VALUES (
        ${jobId}, ${customer.user.id}, ${customer.propertyId}, ${category.id},
        ${category.name}, 'CLOSED'::"JobStatus",
        ST_SetSRID(ST_MakePoint(${location.lng}::float8, ${location.lat}::float8), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${approx.lng}::float8, ${approx.lat}::float8), 4326)::geography,
        'Nashville, TN',
        ${spec.price}, ${fee}, ${total}, ${commission}, ${payout},
        ${dueAt}, 'QUARTER_TO_HALF'::"YardSize", ${category.baseMinutes},
        ${category.difficulty >= 4 ? 'HARD' : category.difficulty >= 2 ? 'MODERATE' : 'EASY'}::"Difficulty",
        false,
        ${worker.userId}, ${claimedAt}, ${postedAt}, ${claimedAt}, ${claimedAt},
        ${completedAt}, ${completedAt}, ${completedAt}, ${completedAt}, ${postedAt}, ${completedAt}
      )
    `)

    // The same balanced lines the real settlement path writes.
    await prisma.ledgerEntry.createMany({
      data: [
        { jobId, account: `customer:${customer.user.id}`, amountCents: -total, memo: 'Charged for job', createdAt: claimedAt },
        { jobId, account: 'platform:escrow', amountCents: spec.price, memo: 'Held pending approval', createdAt: claimedAt },
        { jobId, account: 'platform:revenue', amountCents: fee, memo: 'Customer service fee', createdAt: claimedAt },
        { jobId, account: 'platform:escrow', amountCents: -spec.price, memo: 'Released on approval', createdAt: completedAt },
        { jobId, account: `worker:${worker.userId}`, amountCents: payout, memo: 'Job earnings', createdAt: completedAt },
        { jobId, account: 'platform:revenue', amountCents: commission, memo: 'Worker commission', createdAt: completedAt },
      ],
    })

    await prisma.transaction.createMany({
      data: [
        { jobId, kind: 'CHARGE', status: 'SUCCEEDED', amountCents: total, stripePaymentIntentId: `pi_demo_${jobId.slice(0, 8)}`, idempotencyKey: `job_${jobId}_capture`, createdAt: claimedAt },
        { jobId, kind: 'TRANSFER', status: 'SUCCEEDED', amountCents: payout, stripeTransferId: `tr_demo_${jobId.slice(0, 8)}`, idempotencyKey: `job_${jobId}_transfer`, createdAt: completedAt },
      ],
    })

    await prisma.review.create({
      data: {
        jobId, authorId: customer.user.id, subjectId: worker.userId,
        direction: 'CUSTOMER_TO_WORKER', rating: spec.rating,
        comment: spec.rating === 5 ? 'Great work, yard looks fantastic.' : 'Good job overall.',
        tags: spec.rating === 5 ? ['on time', 'thorough'] : ['on time'],
        createdAt: completedAt,
      },
    })
  }

  // --- open jobs on the map ---

  const jobSpecs = [
    { cat: 'mow-lawn',      price: 6500, hours: 8,   title: 'Mow front and back' },
    { cat: 'mow-lawn',      price: 4500, hours: 30,  title: 'Quick mow, small yard' },
    { cat: 'yard-cleanup',  price: 12000, hours: 48, title: 'Full yard cleanup after storm' },
    { cat: 'trim-bushes',   price: 8500, hours: 72,  title: 'Trim hedges along the fence' },
    { cat: 'blow-leaves',   price: 5500, hours: 24,  title: 'Clear leaves from driveway and walk' },
    { cat: 'pressure-wash', price: 16000, hours: 96, title: 'Pressure wash patio and siding' },
    { cat: 'weed-eat',      price: 3800, hours: 6,   title: 'Weed eat around the shed' },
    { cat: 'mulch',         price: 14000, hours: 120,title: 'Fresh mulch for the front beds' },
    { cat: 'pull-weeds',    price: 4200, hours: 36,  title: 'Weeds taking over the flower bed' },
    { cat: 'haul-debris',   price: 9500, hours: 48,  title: 'Haul off branches from tree work' },
    { cat: 'edge-driveway', price: 3200, hours: 18,  title: 'Edge the driveway and sidewalk' },
    { cat: 'remove-branches',price: 11000, hours: 60,title: 'Low branches over the roof' },
  ]

  for (const [i, spec] of jobSpecs.entries()) {
    const customer = customers[i % customers.length]!
    const category = categories.find((c) => c.slug === spec.cat)
    if (!category) continue

    const location = jitter(customer.point, 1.5)
    const approx = computeApproximateLocation(location)
    const fee = Math.max(299, Math.round((spec.price * 800) / 10_000))
    const commission = Math.round((spec.price * 1200) / 10_000)

    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "jobs" (
        "id","customerId","propertyId","categoryId","title","description","status",
        "exactLocation","approxLocation","generalArea",
        "priceCents","serviceFeeCents","customerTotalCents","workerCommissionCents","workerPayoutCents",
        "dueAt","yardSize","estimatedMinutes","difficulty","equipmentProvided",
        "isPremium","isFeatured","postedAt","createdAt","updatedAt"
      ) VALUES (
        ${createId()}, ${customer.user.id}, ${customer.propertyId}, ${category.id},
        ${spec.title}, 'Posted from the GrassAssassin demo seed.', 'POSTED'::"JobStatus",
        ST_SetSRID(ST_MakePoint(${location.lng}::float8, ${location.lat}::float8), 4326)::geography,
        ST_SetSRID(ST_MakePoint(${approx.lng}::float8, ${approx.lat}::float8), 4326)::geography,
        'Nashville, TN',
        ${spec.price}, ${fee}, ${spec.price + fee}, ${commission}, ${spec.price - commission},
        ${new Date(Date.now() + spec.hours * 3_600_000)},
        'QUARTER_TO_HALF'::"YardSize", ${category.baseMinutes},
        ${category.difficulty >= 4 ? 'HARD' : category.difficulty >= 2 ? 'MODERATE' : 'EASY'}::"Difficulty",
        ${i % 4 === 0}, ${spec.price >= 11000}, ${i === 2},
        ${new Date(Date.now() - i * 900_000)}, now(), now()
      )
    `)
  }
}

async function main() {
  console.log('Seeding reference data…')
  await seedReferenceData()

  if (process.env.NODE_ENV === 'production') {
    console.log('Production environment — skipping demo data.')
  } else {
    console.log('Seeding demo marketplace…')
    await seedDemoData()
  }

  const counts = {
    categories: await prisma.serviceCategory.count(),
    equipment: await prisma.equipment.count(),
    ranks: await prisma.rank.count(),
    pointRules: await prisma.pointRule.count(),
    badges: await prisma.badge.count(),
    serviceAreas: await prisma.serviceArea.count(),
    users: await prisma.user.count(),
    workers: await prisma.workerProfile.count(),
    properties: await prisma.property.count(),
    openJobs: await prisma.job.count({ where: { status: 'POSTED' } }),
  }
  console.table(counts)
  console.log('\nDemo credentials: customer1@grassassassin.test / worker1@grassassassin.test')
  console.log('Password: GrassDemo123!')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
