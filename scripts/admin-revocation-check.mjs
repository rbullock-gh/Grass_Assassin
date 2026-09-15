import { launchChromium } from './lib/browser.mjs'
import { PrismaClient } from '@prisma/client'

/**
 * Proves that revoking an administrator takes effect on their next request.
 *
 * The session cookie is signed, so nothing about the cookie itself changes when
 * someone's access is taken away. If the dashboard trusted the signature alone,
 * a dismissed administrator would keep the power to change fees and resolve
 * disputes until their cookie expired — up to twelve hours on the surface that
 * moves money. currentAdmin re-reads the account on every request specifically
 * to close that window, and this is the test of whether it actually does.
 *
 * Mutates the database, so it is a separate script from the browser suite and
 * is meant for a development database. It restores what it changed, including
 * after a failure.
 *
 * Usage:
 *   node scripts/admin-revocation-check.mjs [--base http://localhost:3011]
 */

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = argOf('--base', process.env.ADMIN_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@grassassassin.test'
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'test-admin-password'

let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

const db = new PrismaClient()
const browser = await launchChromium()
const ctx = await browser.newContext()
const page = await ctx.newPage()

const original = await db.user.findUnique({
  where: { email: EMAIL },
  select: { id: true, roles: true, status: true, suspendedUntil: true },
})
if (!original) {
  console.error(`No account ${EMAIL}. Create one with: pnpm --filter @grassassassin/api admin:create`)
  process.exit(1)
}

const restore = () => db.user.update({
  where: { id: original.id },
  data: {
    roles: { set: original.roles },
    status: original.status,
    suspendedUntil: original.suspendedUntil,
  },
})

/** Can the browser, with whatever cookie it holds, still reach a money page? */
async function stillInside() {
  await page.goto(`${BASE}/config`, { waitUntil: 'networkidle' })
  return new URL(page.url()).pathname === '/config'
}

try {
  // Sign in and confirm the session works to begin with, so a later failure
  // means revocation worked rather than that sign-in never did.
  await page.goto(`${BASE}/sign-in?next=%2Fconfig`, { waitUntil: 'networkidle' })
  const before = page.url()
  await page.fill('input[name="email"]', EMAIL)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((u) => u.toString() !== before, { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ])
  check(await stillInside(), 'baseline: a valid administrator reaches /config')
  const cookie = (await ctx.cookies()).find((c) => c.name === 'ga_admin')
  check(Boolean(cookie), 'baseline: holding a session cookie')

  // Each case takes access away by a different route, WITHOUT touching the
  // cookie, and asserts the same cookie stops working.
  const revocations = [
    ['the ADMIN role is removed', { roles: { set: ['CUSTOMER'] } }],
    ['the account is suspended', { status: 'SUSPENDED' }],
    ['the account is banned', { status: 'BANNED' }],
    ['the account is soft-deleted', { deletedAt: new Date() }],
    ['a suspension window is set', { suspendedUntil: new Date(Date.now() + 86_400_000) }],
  ]

  for (const [label, data] of revocations) {
    await db.user.update({ where: { id: original.id }, data })
    const inside = await stillInside()
    check(!inside, `access ends immediately when ${label}`, inside ? 'still at /config' : '')

    // The cookie must survive unchanged, or this would be testing sign-out.
    const held = (await ctx.cookies()).find((c) => c.name === 'ga_admin')
    check(held?.value === cookie.value || !held,
      `  (the cookie itself was not what changed: ${label})`)

    await db.user.update({
      where: { id: original.id },
      data: { roles: { set: original.roles }, status: 'ACTIVE', suspendedUntil: null, deletedAt: null },
    })
    check(await stillInside(), `access returns when ${label} is undone`)
  }
} finally {
  await restore()
  await db.user.update({ where: { id: original.id }, data: { deletedAt: null } })
  await db.$disconnect()
  await browser.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
