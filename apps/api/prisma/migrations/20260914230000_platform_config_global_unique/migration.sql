-- Global platform_config rows could silently duplicate.
--
-- The table has UNIQUE ("scopeKey", key), which does its job for a market
-- override but does nothing at all for a global row: PostgreSQL treats NULL as
-- distinct from NULL, so ("scopeKey" = NULL, key = 'fees.worker_commission_bps')
-- never collides with another row exactly like it.
--
-- That matters because resolvePolicy indexes the global rows into a Map in
-- whatever order the query returns them. With two rows for one key, the
-- effective commission rate is whichever row Postgres felt like returning last
-- — a nondeterministic fee, changing between requests, with nothing in the
-- application looking wrong.
--
-- A partial unique index is the fix: it applies precisely to the rows the
-- composite constraint cannot reach.

-- Collapse any duplicates that already exist, keeping the most recently
-- updated row, so the index can be created.
DELETE FROM "platform_config" a
      USING "platform_config" b
      WHERE a."scopeKey" IS NULL
        AND b."scopeKey" IS NULL
        AND a."key" = b."key"
        AND (a."updatedAt" < b."updatedAt"
             OR (a."updatedAt" = b."updatedAt" AND a."id" < b."id"));

CREATE UNIQUE INDEX "platform_config_global_key_unique"
    ON "platform_config" ("key")
 WHERE "scopeKey" IS NULL;
