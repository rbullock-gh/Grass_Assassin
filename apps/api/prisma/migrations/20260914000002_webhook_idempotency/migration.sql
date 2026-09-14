-- At-most-once webhook processing.
--
-- Payment providers retry aggressively (Stripe for up to three days), so a
-- handler that is not idempotent will eventually double-apply — refunding
-- twice, crediting a worker twice, or posting a chargeback to the ledger twice.
--
-- This unique index is what actually enforces it. Checking for an existing row
-- and then inserting would race with a concurrent retry of the same delivery;
-- a unique violation cannot. The partial predicate keeps the index small: it
-- covers only webhook rows, not the whole audit log.
CREATE UNIQUE INDEX "audit_logs_entity_unique"
  ON "audit_logs" ("entityType", "entityId")
  WHERE "entityId" IS NOT NULL AND "entityType" = 'WebhookEvent';
