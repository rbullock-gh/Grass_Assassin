-- A device reports the timezone it is actually in.
--
-- Quiet hours used a hard-coded US Central offset for every user in the system,
-- which is correct for the launch market and a 3am push for anyone outside it.
-- Nullable because existing rows genuinely do not know, and the notifier keeps
-- falling back to the launch market when the column is null.
ALTER TABLE "devices" ADD COLUMN "tzOffsetMinutes" INTEGER;
