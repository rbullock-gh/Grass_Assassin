import { chromium } from 'playwright'

/**
 * Proves the admin sign-in throttle both works and does not backfire.
 *
 * Two failure modes worth more than the happy path. A throttle that does not
 * engage is decoration. A throttle that locks out the wrong person is worse
 * than none at all on a dashboard where the moment access matters most — a
 * dispute queue backing up, a fee set wrong — is exactly the moment an attacker
 * would choose. So this checks that ten guesses from one source stop working,
 * AND that a different source can still sign in normally while that block is in
 * force.
 *
 * Requires an admin account (see admin:create) and a running dashboard. Leaves
 * the attacking address blocked for fifteen minutes in that process's memory.
 *
 * Usage: node scripts/admin-bruteforce-check.mjs [--base http://localhost:3001]
 */

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = argOf('--base', process.env.ADMIN_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
let pass = 0, fail = 0
const check = (ok, l, d = '') => { ok ? (pass++, console.log(`  PASS  ${l}`)) : (fail++, console.log(`  FAIL  ${l}${d ? ` — ${d}` : ''}`)) }

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

async function attempt(ctx, password, ip) {
  const page = await ctx.newPage()
  if (ip) await page.setExtraHTTPHeaders({ 'x-forwarded-for': ip })
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' })
  const before = page.url()
  await page.fill('input[name="email"]', process.env.ADMIN_EMAIL ?? 'admin@grassassassin.test')
  await page.fill('input[name="password"]', password)
  await Promise.all([
    page.waitForURL((u) => u.toString() !== before, { timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ])
  const url = new URL(page.url())
  const text = await page.locator('.signin-error').innerText().catch(() => '')
  await page.close()
  return { path: url.pathname, blocked: url.searchParams.has('blocked'), text }
}

const ctx = await browser.newContext()
// Unique per run: reusing one address would mean the second run starts
// already blocked and reports a failure against working code.
const ATTACKER = `203.0.113.${1 + Math.floor(Math.random() * 250)}`

// Ten wrong guesses from one source.
let lastText = ''
for (let i = 1; i <= 10; i += 1) {
  const r = await attempt(ctx, `guess-${i}`, ATTACKER)
  if (i < 10) check(!r.blocked && r.path === '/sign-in', `attempt ${i} refused but not blocked`, JSON.stringify(r))
  lastText = r.text
}

const eleventh = await attempt(ctx, 'guess-11', ATTACKER)
check(eleventh.blocked, 'the eleventh attempt is blocked, not just refused', JSON.stringify(eleventh))
check(/Too many failed attempts/.test(eleventh.text), 'the message says why', eleventh.text)
check(/minute/.test(eleventh.text), 'the message says when to come back', eleventh.text)

// The CORRECT password from the blocked source is still refused — the block is
// on the source, not on knowing the password.
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'test-admin-password'
const correctFromBlocked = await attempt(ctx, PASSWORD, ATTACKER)
check(correctFromBlocked.blocked, 'even the right password is blocked from that source',
  JSON.stringify(correctFromBlocked))

// A different source is unaffected — this is the lockout-DoS check.
const other = await attempt(ctx, PASSWORD, `198.51.100.${1 + Math.floor(Math.random() * 200)}`)
check(other.path === '/' && !other.blocked,
  'a different source can still sign in with the right password', JSON.stringify(other))

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
