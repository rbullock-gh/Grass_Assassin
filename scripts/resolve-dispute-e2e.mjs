import { chromium } from 'playwright'
import { PrismaClient } from '@prisma/client'

/**
 * Resolves a real dispute through the admin UI, then checks the database.
 *
 * The parts that matter are not on the screen. A dispute resolution has to move
 * money in three directions, leave the double-entry ledger balanced, name the
 * administrator who actually decided it, and not pay twice when the page is
 * reloaded. A green button proves none of that, so this drives the browser and
 * then reads the ledger, the dispute row, the audit log and the worker's
 * balance directly.
 *
 * MUTATES the database — it really does resolve a dispute and really does move
 * money. Development databases only. It needs an open dispute to act on.
 *
 * Usage:
 *   ADMIN_SERVICE_TOKEN=… pnpm --filter @grassassassin/api dev
 *   ADMIN_SESSION_SECRET=… API_BASE_URL=… ADMIN_SERVICE_TOKEN=… \
 *     pnpm --filter @grassassassin/admin start
 *   node scripts/resolve-dispute-e2e.mjs
 */

const BASE = 'http://localhost:3011'
const EMAIL = 'admin@grassassassin.test'
const PASSWORD = 'test-admin-password'

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const db = new PrismaClient()

// The books must be in balance before, so an imbalance after is attributable.
const before = await db.$queryRawUnsafe('SELECT COALESCE(SUM("amountCents"),0)::bigint AS delta FROM "ledger_entries"')
check(Number(before[0].delta) === 0, 'the ledger starts balanced', String(before[0].delta))

const target = await db.dispute.findFirst({
  where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
  select: {
    id: true, jobId: true,
    job: { select: { customerTotalCents: true, workerPayoutCents: true, claimedByWorkerId: true } },
  },
})
if (!target) { console.error('No open dispute to resolve.'); process.exit(1) }
console.log(`  (resolving dispute ${target.id}: customer paid ${target.job.customerTotalCents}c, worker due ${target.job.workerPayoutCents}c)`)

const workerBefore = await db.workerProfile.findFirstOrThrow({
  where: { userId: target.job.claimedByWorkerId },
  select: { availableBalanceCents: true, lifetimeEarningsCents: true },
})

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const ctx = await browser.newContext()
const page = await ctx.newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

try {
  await page.goto(`${BASE}/sign-in?next=%2Fdisputes`, { waitUntil: 'networkidle' })
  const before1 = page.url()
  await page.fill('input[name="email"]', EMAIL)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((u) => u.toString() !== before1, { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ])
  check(new URL(page.url()).pathname === '/disputes', 'signed in and on the disputes page', page.url())

  const form = page.locator(`form.resolve-form:has(input[value="${target.id}"])`)
  check(await form.count() === 1, 'the open dispute has a decision form')

  // The dollar figures must be on screen BEFORE a decision is made.
  const workerOption = form.locator('label.choice', { hasText: 'For the worker' })
  const customerOption = form.locator('label.choice', { hasText: 'For the customer' })
  const expectWorker = `$${(target.job.workerPayoutCents / 100).toFixed(2)}`
  const expectCustomer = `$${(target.job.customerTotalCents / 100).toFixed(2)}`
  check((await workerOption.innerText()).includes(expectWorker),
    `the worker option states the payout (${expectWorker})`, await workerOption.innerText())
  check((await customerOption.innerText()).includes(expectCustomer),
    `the customer option states the refund (${expectCustomer})`, await customerOption.innerText())

  // Submit should be impossible before a decision is chosen.
  check(await form.locator('button[type="submit"]').isDisabled(),
    'cannot submit before choosing a decision')

  // A too-short explanation must be refused.
  await form.locator('input[value="SPLIT"]').check()
  const splitInput = form.locator('input[name="refundDollars"]')
  check(await splitInput.isVisible(), 'choosing split reveals the refund amount field')

  await splitInput.fill('40.00')
  const hint = form.locator('.resolve-split p.muted')
  const shown = await hint.innerText()
  // 9720 paid, 4000 refunded -> 5720 stands -> worker gets round(7920 * 5720/9720)
  const expectedSplitPay = Math.min(
    target.job.workerPayoutCents,
    Math.round(target.job.workerPayoutCents * ((target.job.customerTotalCents - 4000) / target.job.customerTotalCents)),
  )
  check(shown.includes(`$${(expectedSplitPay / 100).toFixed(2)}`),
    `the split preview computes the worker's share ($${(expectedSplitPay / 100).toFixed(2)})`, shown)

  // A too-short explanation cannot even be submitted. It used to be refused by
  // the server, which then reset the form and erased everything typed — so the
  // check now is that the button never becomes available.
  await form.locator('textarea[name="resolution"]').fill('too short')
  check(await form.locator('button[type="submit"]').isDisabled(),
    'a too-short explanation cannot be submitted')

  // Now a real resolution.
  const REASON = 'Before photos show the back third uncut. Refunding that portion; the worker is paid for the rest.'
  await form.locator('textarea[name="resolution"]').fill(REASON)
  await form.locator('button[type="submit"]').click()

  // The form does not report success itself — resolving revalidates the page,
  // the dispute stops being open, and this form is replaced by the outcome read
  // back from the database. So wait for the form to GO, not for a message.
  await form.waitFor({ state: 'detached', timeout: 20_000 })
  check(true, 'the decision form is replaced once the dispute is resolved')

  check(errors.length === 0, 'no page errors during the whole flow', errors.join('; '))

  // --- now the part that actually matters: the database -----------------
  const after = await db.dispute.findUniqueOrThrow({
    where: { id: target.id },
    select: { status: true, refundCents: true, resolution: true, resolvedById: true, resolvedAt: true },
  })
  check(after.status === 'RESOLVED_SPLIT', 'the dispute is recorded as a split', after.status)
  check(after.refundCents === 4000, 'the refund amount is what was typed', String(after.refundCents))
  check(after.resolution === REASON, 'the explanation is stored verbatim')
  check(after.resolvedAt !== null, 'a resolution timestamp is recorded')

  const admin = await db.user.findUniqueOrThrow({ where: { email: EMAIL }, select: { id: true } })
  check(after.resolvedById === admin.id,
    'the dispute names the administrator who actually clicked, not a placeholder', String(after.resolvedById))

  const audit = await db.auditLog.findFirst({
    where: { action: 'dispute.resolved', entityId: target.id },
    select: { actorId: true, actorType: true, after: true },
  })
  check(audit?.actorId === admin.id, 'the audit log names the same real person', String(audit?.actorId))
  check(audit?.actorType === 'ADMIN', 'the audit log records an ADMIN actor')

  const balance = await db.$queryRawUnsafe('SELECT COALESCE(SUM("amountCents"),0)::bigint AS delta FROM "ledger_entries"')
  check(Number(balance[0].delta) === 0, 'the ledger is still balanced after real money moved', String(balance[0].delta))

  const workerAfter = await db.workerProfile.findFirstOrThrow({
    where: { userId: target.job.claimedByWorkerId },
    select: { availableBalanceCents: true, lifetimeEarningsCents: true },
  })
  const paid = workerAfter.availableBalanceCents - workerBefore.availableBalanceCents
  check(paid === expectedSplitPay,
    `the worker's balance moved by exactly the split share (${expectedSplitPay}c)`, `moved ${paid}c`)

  // The page must show what was actually recorded, in money.
  await page.waitForTimeout(800)
  // Scoped to THIS dispute. Reading .first() picked up an older resolution and
  // reported a failure against a row that was perfectly correct.
  const noteText = await page.locator(`.resolved-note[data-dispute="${target.id}"]`).innerText()
  check(noteText.includes('$40.00'), 'the page states the refund that was recorded', noteText)
  check(noteText.includes(`$${(expectedSplitPay / 100).toFixed(2)}`),
    'the page states what the worker was actually paid', noteText)
  check(noteText.includes('Ada'), 'the page names who resolved it', noteText)

  // Resolving twice must not pay twice.
  await page.reload({ waitUntil: 'networkidle' })
  check(await page.locator(`form.resolve-form:has(input[value="${target.id}"])`).count() === 0,
    'the resolved dispute no longer offers a decision form')
  const workerFinal = await db.workerProfile.findFirstOrThrow({
    where: { userId: target.job.claimedByWorkerId },
    select: { availableBalanceCents: true },
  })
  check(workerFinal.availableBalanceCents === workerAfter.availableBalanceCents,
    'a reload does not pay the worker again')
} finally {
  await db.$disconnect()
  await browser.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
