-- GrassAssassin: spatial indexes and integrity constraints
--
-- Prisma cannot express GIST indexes, partial indexes, or CHECK constraints in
-- schema.prisma, so they live here. Everything in this file is load-bearing:
-- without the GIST indexes the worker map degrades to a sequential scan, and
-- without the CHECK constraints a bug in application code can write a job whose
-- money does not add up.

-- ---------------------------------------------------------------------------
-- Spatial indexes
-- ---------------------------------------------------------------------------

-- The hot path. Worker map search filters on approx_location; exact_location is
-- only ever fetched by primary key for a claimed job, so it needs no index.
CREATE INDEX "jobs_approx_location_gist" ON "jobs" USING GIST ("approxLocation");

-- Partial index covering the actual search predicate: only POSTED jobs are ever
-- returned by the map query, and they are a small fraction of the table once the
-- marketplace has history. This keeps the index small and hot in cache.
CREATE INDEX "jobs_open_approx_location_gist"
  ON "jobs" USING GIST ("approxLocation")
  WHERE "status" = 'POSTED';

-- Supports "is this address inside my service radius" and reverse matching of
-- newly posted jobs to nearby workers.
CREATE INDEX "properties_location_gist" ON "properties" USING GIST ("location");
CREATE INDEX "worker_profiles_base_location_gist" ON "worker_profiles" USING GIST ("baseLocation");
CREATE INDEX "service_areas_boundary_gist" ON "service_areas" USING GIST ("boundary");
CREATE INDEX "job_photos_captured_location_gist" ON "job_photos" USING GIST ("capturedLocation");

-- ---------------------------------------------------------------------------
-- Partial and covering indexes for hot queries
-- ---------------------------------------------------------------------------

-- Sweeping expired claim reservations back to POSTED runs frequently and should
-- never scan the whole table.
CREATE INDEX "jobs_claim_expiry_sweep"
  ON "jobs" ("claimExpiresAt")
  WHERE "status" = 'CLAIM_PENDING_PAYMENT';

-- Auto-approval sweep: jobs sitting in PENDING_APPROVAL past the window.
CREATE INDEX "jobs_pending_approval_sweep"
  ON "jobs" ("completedAt")
  WHERE "status" = 'PENDING_APPROVAL';

-- Deadline reminder sweep.
CREATE INDEX "jobs_active_due_at"
  ON "jobs" ("dueAt")
  WHERE "status" IN ('CLAIMED', 'EN_ROUTE', 'IN_PROGRESS');

-- A worker's active workload, checked on every claim attempt.
CREATE INDEX "jobs_worker_active"
  ON "jobs" ("claimedByWorkerId")
  WHERE "status" IN ('CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL', 'DISPUTED');

-- Unread notification badge count.
CREATE INDEX "notifications_unread"
  ON "notifications" ("userId", "createdAt")
  WHERE "readAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Money integrity
-- ---------------------------------------------------------------------------
-- These exist because a rounding or assignment bug in application code that
-- silently corrupts a job's economics is far more expensive to discover from
-- a reconciliation report weeks later than from a failed INSERT today.

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_price_positive"
  CHECK ("priceCents" > 0);

ALTER TABLE "jobs" ADD CONSTRAINT "jobs_fees_non_negative"
  CHECK ("serviceFeeCents" >= 0 AND "workerCommissionCents" >= 0 AND "workerPayoutCents" >= 0);

-- The customer's total must be exactly the job price plus the service fee.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_total_balances"
  CHECK ("customerTotalCents" = "priceCents" + "serviceFeeCents");

-- The worker's payout plus our commission must be exactly the job price. No
-- cent may be created or destroyed between the two sides of the split.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_worker_split_balances"
  CHECK ("workerPayoutCents" + "workerCommissionCents" = "priceCents");

ALTER TABLE "tips" ADD CONSTRAINT "tips_amount_positive"
  CHECK ("amountCents" > 0);

ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive"
  CHECK ("amountCents" > 0 AND "feeCents" >= 0);

-- ---------------------------------------------------------------------------
-- Domain integrity
-- ---------------------------------------------------------------------------

ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_range"
  CHECK ("rating" >= 1 AND "rating" <= 5);

-- Nobody reviews themselves.
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_no_self_review"
  CHECK ("authorId" <> "subjectId");

ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_no_self_block"
  CHECK ("blockerId" <> "blockedId");

ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_difficulty_range"
  CHECK ("difficulty" >= 1 AND "difficulty" <= 5);

ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_price_range_ordered"
  CHECK ("typicalHighCents" >= "typicalLowCents");

ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_rates_are_fractions"
  CHECK ("completionRate" >= 0 AND "completionRate" <= 1 AND "onTimeRate" >= 0 AND "onTimeRate" <= 1);

ALTER TABLE "worker_profiles" ADD CONSTRAINT "worker_profiles_radius_sane"
  CHECK ("serviceRadiusMiles" > 0 AND "serviceRadiusMiles" <= 100);

-- A promo code is either a fixed amount off or a percentage off, never both and
-- never neither.
ALTER TABLE "promo_codes" ADD CONSTRAINT "promo_codes_exactly_one_discount"
  CHECK (("amountOffCents" IS NULL) <> ("percentOffBps" IS NULL));

-- A job's time window, when present, must be ordered.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_window_ordered"
  CHECK ("windowStartAt" IS NULL OR "windowEndAt" IS NULL OR "windowEndAt" > "windowStartAt");

-- ---------------------------------------------------------------------------
-- Single-winner claim invariant
-- ---------------------------------------------------------------------------
-- The conditional UPDATE in the claim path is what actually enforces single-
-- winner semantics. This constraint is a second, independent guard: it makes it
-- structurally impossible for a job to be in a claimed state without a claimant,
-- so a future code path that forgets to set the worker id fails loudly instead
-- of silently orphaning a job.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_claimed_requires_worker"
  CHECK (
    "status" NOT IN ('CLAIM_PENDING_PAYMENT', 'CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL')
    OR "claimedByWorkerId" IS NOT NULL
  );

-- A reservation must always carry its expiry, or the sweeper cannot reclaim it
-- and the job would be stuck out of the pool forever.
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_pending_claim_requires_expiry"
  CHECK ("status" <> 'CLAIM_PENDING_PAYMENT' OR "claimExpiresAt" IS NOT NULL);
