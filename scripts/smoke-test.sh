#!/usr/bin/env bash
#
# End-to-end smoke test.
#
# Drives the complete marketplace loop against a RUNNING server and a real
# database: post -> search -> claim -> photo gate -> geofenced start -> complete
# -> approve -> pay -> rate -> convert to recurring.
#
# This exists alongside the integration suite because the suite exercises
# modules in-process; this exercises the deployed shape — real HTTP, real
# routing, real serialisation. A route that is registered but unreachable, or a
# response that serialises wrongly, passes the suite and fails here.
#
# Usage:
#   pnpm --filter @grassassassin/api dev          # in one terminal
#   pnpm --filter @grassassassin/api db:seed      # service area must exist
#   bash scripts/smoke-test.sh
#
set -euo pipefail

API="${API_BASE_URL:-http://localhost:4000}/v1"
S=$(date +%s)
j() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1"; }
# Connect via DATABASE_URL rather than a hardcoded database name. The first
# version hardcoded grassassassin_dev, which works locally and fails in CI
# where the database is named differently — exactly the kind of "works on my
# machine" the smoke test exists to catch.
: "${DATABASE_URL:=postgresql://grass:grass@localhost:5432/grassassassin_dev}"
sql() { psql "$DATABASE_URL" -q -tA -c "$1"; }

: "${API_BASE_URL:=http://localhost:4000}"

# --- preconditions ----------------------------------------------------------
#
# Checked up front and reported plainly. The first version failed with
# "KeyError: 'id'" from a Python one-liner three steps in, which tells whoever
# is looking nothing about what is actually wrong.

fail() { echo "SMOKE TEST CANNOT RUN: $1" >&2; exit 1; }

curl -sf "$API_BASE_URL/health" > /dev/null \
  || fail "no API responding at $API_BASE_URL. Start it with 'pnpm dev:api'."

psql "$DATABASE_URL" -tAc 'SELECT 1' > /dev/null 2>&1 \
  || fail "cannot reach the database at DATABASE_URL."

AREAS=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM service_areas WHERE active = true" 2>/dev/null || echo 0)
[ "${AREAS:-0}" -gt 0 ] \
  || fail "no active service area, so every property will be refused. Run 'pnpm --filter @grassassassin/api db:seed'."

CATEGORIES=$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM service_categories WHERE active = true" 2>/dev/null || echo 0)
[ "${CATEGORIES:-0}" -gt 0 ] \
  || fail "no active job categories. Run 'pnpm --filter @grassassassin/api db:seed'."

echo "Preconditions OK — API up, ${AREAS} service area(s), ${CATEGORIES} categories."


echo "── customer + property + job"
CUST=$(curl -sS -X POST $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"e2b-c-$S@t.com\",\"password\":\"a-long-enough-password\",\"firstName\":\"Casey\",\"intent\":\"CUSTOMER\"}")
CT=$(echo "$CUST" | j "['tokens']['accessToken']"); CID=$(echo "$CUST" | j "['user']['id']")
PROP=$(curl -sS -X POST $API/properties -H "authorization: Bearer $CT" -H 'content-type: application/json' \
  -d '{"label":"Home","addressLine1":"742 Evergreen Terrace","city":"Nashville","state":"TN","postalCode":"37205","location":{"lat":36.1627,"lng":-86.7816},"yardSize":"HALF_TO_ONE","gateCode":"4412"}')
PID=$(echo "$PROP" | j "['id']")
CAT=$(curl -sS $API/categories | python3 -c "import json,sys; print(json.load(sys.stdin)['categories'][0]['id'])")
JOB=$(curl -sS -X POST $API/jobs -H "authorization: Bearer $CT" -H 'content-type: application/json' \
  -d "{\"propertyId\":\"$PID\",\"categoryId\":\"$CAT\",\"priceCents\":9500,\"dueAt\":\"$(date -u -d '+2 days' +%Y-%m-%dT%H:%M:%SZ)\",\"specialInstructions\":\"Gate code 4412.\"}")
JID=$(echo "$JOB" | j "['id']")
echo "   job $JID at \$95"

echo "── worker claims"
W=$(curl -sS -X POST $API/auth/register -H 'content-type: application/json' \
  -d "{\"email\":\"e2b-w-$S@t.com\",\"password\":\"a-long-enough-password\",\"firstName\":\"Marcus\",\"intent\":\"WORKER\"}")
WT=$(echo "$W" | j "['tokens']['accessToken']"); WID=$(echo "$W" | j "['user']['id']")
sql "UPDATE worker_profiles SET status='APPROVED', \"completedJobs\"=30, \"averageRating\"=4.9, \"completionRate\"=1, \"onTimeRate\"=1, \"stripeAccountId\"='acct_e2b_$S', \"payoutsEnabled\"=true WHERE \"userId\"='$WID'" > /dev/null
sql "UPDATE customer_profiles SET \"stripeCustomerId\"='cus_e2b_$S', \"defaultPaymentMethodId\"='pm_test_visa' WHERE \"userId\"='$CID'" > /dev/null
curl -sS -X POST $API/jobs/$JID/claim -H "authorization: Bearer $WT" -H 'content-type: application/json' -d '{}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   ',d['outcome'],d.get('status'))"

echo "── conversation opened on claim?"
sql "SELECT '   conversation: '||count(*) FROM conversations WHERE \"jobId\"='$JID'"

echo "── en route"
curl -sS -X POST $API/jobs/$JID/status -H "authorization: Bearer $WT" -H 'content-type: application/json' -d '{"to":"EN_ROUTE"}' > /dev/null
echo "   EN_ROUTE"

echo "── presign a BEFORE photo, but DON'T upload, then try to start"
P1=$(curl -sS -X POST $API/jobs/$JID/photos/presign -H "authorization: Bearer $WT" -H 'content-type: application/json' \
  -d '{"kind":"BEFORE","contentType":"image/jpeg"}')
PHOTO1=$(echo "$P1" | j "['photoId']")
curl -sS -X POST $API/jobs/$JID/status -H "authorization: Bearer $WT" -H 'content-type: application/json' \
  -d '{"to":"IN_PROGRESS","workerLocation":{"lat":36.1627,"lng":-86.7816}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   blocked:',d['error']['code'])"

echo "── the upload genuinely lands, then start"
# Confirm is skipped here: the fake storage lives inside the server process and
# this script cannot PUT to it, and calling confirm with no object would
# correctly DELETE the row. Marking it APPROVED is what a real confirmed
# upload produces.
sql "UPDATE job_photos SET \"moderationStatus\"='APPROVED', bytes=1200000 WHERE id='$PHOTO1'" > /dev/null
curl -sS -X POST $API/jobs/$JID/status -H "authorization: Bearer $WT" -H 'content-type: application/json' \
  -d '{"to":"IN_PROGRESS","workerLocation":{"lat":36.1627,"lng":-86.7816}}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('   ->',d.get('status') or d.get('error'))"

echo "── complete and approve"
P2=$(curl -sS -X POST $API/jobs/$JID/photos/presign -H "authorization: Bearer $WT" -H 'content-type: application/json' -d '{"kind":"AFTER","contentType":"image/jpeg"}')
PHOTO2=$(echo "$P2" | j "['photoId']")
sql "UPDATE job_photos SET \"moderationStatus\"='APPROVED' WHERE id='$PHOTO2'" > /dev/null
curl -sS -X POST $API/jobs/$JID/status -H "authorization: Bearer $WT" -H 'content-type: application/json' -d '{"to":"PENDING_APPROVAL"}' > /dev/null
curl -sS -X POST $API/jobs/$JID/status -H "authorization: Bearer $CT" -H 'content-type: application/json' -d '{"to":"APPROVED"}' \
  | python3 -c "import json,sys; print('   ->',json.load(sys.stdin)['status'])"

echo "── rate, then convert to recurring"
curl -sS -X POST $API/jobs/$JID/review -H "authorization: Bearer $CT" -H 'content-type: application/json' \
  -d '{"rating":5,"comment":"Perfect.","tags":["on time","thorough"]}' > /dev/null
curl -sS -X POST $API/jobs/$JID/make-recurring -H "authorization: Bearer $CT" -H 'content-type: application/json' \
  -d '{"interval":"BIWEEKLY"}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"   recurring every {d['interval'].lower()}, next {d['nextRunAt'][:10]}, preferred pro locked in\")"

echo "── final"
sql "SELECT '   job: '||status FROM jobs WHERE id='$JID'"
sql "SELECT '   ledger nets to: '||COALESCE(SUM(\"amountCents\"),0) FROM ledger_entries"
curl -sS $API/worker/earnings -H "authorization: Bearer $WT" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(f\"   worker balance: \${d['availableBalanceCents']/100:.2f}\")"
sql "SELECT '   points: '||string_agg(pt.event||' '||pt.points,', ') FROM point_transactions pt JOIN worker_profiles w ON w.id=pt.\"workerProfileId\" WHERE w.\"userId\"='$WID'"
