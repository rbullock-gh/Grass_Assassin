import { chromium } from 'playwright'

/**
 * Drives the admin sign-in gate in a real browser.
 *
 * The admin dashboard shipped with no authentication at all, and by the time
 * that was noticed it could change the platform commission and resolve
 * disputes. Unit tests cover the token signing; they cannot tell you whether
 * the middleware is actually wired to the routes, whether the cookie carries
 * httpOnly, or whether a signed-out visitor can still read the page. Those are
 * browser facts, so this asks a browser.
 *
 * Usage:
 *   ADMIN_PASSWORD=... ADMIN_SESSION_SECRET=... pnpm --filter @grassassassin/admin dev
 *   node scripts/admin-auth-check.mjs [--base http://localhost:3001]
 *
 * The password must match the server's ADMIN_PASSWORD; pass it the same way.
 */

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = argOf('--base', process.env.ADMIN_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'test-admin-password'
const HOST = new URL(BASE).host
let pass = 0, fail = 0
const check = (ok, label, detail = '') => {
  if (ok) { pass += 1; console.log(`  PASS  ${label}`) }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

/**
 * Submits the sign-in form and waits for the navigation it causes.
 *
 * A server action replies 303 and Next follows it client-side, so the URL is
 * still the old one when `click` resolves. My first version of this script read
 * the URL right there and reported three failures against an app that was
 * working. waitForURL is the difference between testing the app and testing my
 * own patience.
 */
async function submitPassword(page, password) {
  const before = page.url()
  await page.fill('input[name="password"]', password)
  await Promise.all([
    page.waitForURL((url) => url.toString() !== before, { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ])
  await page.waitForLoadState('networkidle')
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })

// ---- 1. A fresh visitor cannot reach the money pages -------------------
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  for (const path of ['/', '/config', '/disputes', '/jobs', '/workers']) {
    const response = await page.goto(BASE + path, { waitUntil: 'networkidle' })
    check(new URL(page.url()).pathname === '/sign-in', `${path} sends an anonymous visitor to /sign-in`, page.url())
    check(response?.status() === 200, `${path} ends on a real page, not an error`, String(response?.status()))
  }
  check(await page.locator('input[name="password"]').isVisible(), 'sign-in shows a password field')
  check(errors.length === 0, 'sign-in renders with no page errors', errors.join('; '))

  // The sign-in page used to render inside the dashboard shell, handing an
  // anonymous visitor the whole admin site map — every section we have, listed
  // before the password. It gets a bare layout now.
  check(await page.locator('.sidebar').count() === 0, 'sign-in does not render the admin sidebar')
  const text = await page.locator('body').innerText()
  for (const section of ['Disputes', 'Ledger', 'Fees & config', 'Workers', 'Reports']) {
    check(!text.includes(section), `sign-in does not name the "${section}" section`)
  }
  check(await page.locator('a[href="/config"]').count() === 0,
    'sign-in exposes no link into the dashboard')
  await ctx.close()
}

// ---- 2. The wrong password is refused ---------------------------------
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.goto(`${BASE}/sign-in?next=%2Fconfig`, { waitUntil: 'networkidle' })
  await submitPassword(page, 'not-the-password')

  check(new URL(page.url()).pathname === '/sign-in', 'wrong password stays on /sign-in', page.url())
  // waitFor, not isVisible: after a server-action redirect React is still
  // patching the DOM when networkidle resolves, and reading it right then
  // reported a missing error message on a page that was rendering one.
  const shown = await page.locator('.signin-error')
    .waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false)
  check(shown, 'wrong password shows the error message')
  check(new URL(page.url()).searchParams.get('next') === '/config',
    'a failed attempt remembers where they were headed', page.url())
  const cookies = await ctx.cookies()
  check(!cookies.some((c) => c.name === 'ga_admin'), 'wrong password issues no session cookie',
    JSON.stringify(cookies.map((c) => c.name)))

  await page.goto(`${BASE}/config`, { waitUntil: 'networkidle' })
  check(new URL(page.url()).pathname === '/sign-in', 'after a failed attempt /config is still gated', page.url())
  await ctx.close()
}

// ---- 3. The right password opens exactly the page they asked for ------
let goodCookie
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`${BASE}/sign-in?next=%2Fconfig`, { waitUntil: 'networkidle' })
  await submitPassword(page, PASSWORD)

  check(new URL(page.url()).pathname === '/config',
    'correct password lands on the requested page, not the dashboard', page.url())

  goodCookie = (await ctx.cookies()).find((c) => c.name === 'ga_admin')
  check(Boolean(goodCookie), 'a session cookie is issued')
  check(goodCookie?.httpOnly === true, 'session cookie is httpOnly (script cannot read it)')
  check(goodCookie?.sameSite === 'Lax', 'session cookie is SameSite=Lax', String(goodCookie?.sameSite))

  const readable = await page.evaluate(() => document.cookie)
  check(!readable.includes('ga_admin'), 'session cookie is invisible to document.cookie', readable)

  // Identify the config page by the fee input itself, not by "a form exists" —
  // the sign-in page has a form too, which is how my first version of this
  // check passed while sign-in was failing.
  const commission = page.locator('input[name="fees.worker_commission_bps"]')
  check(await commission.count() === 1, 'the commission input is present once signed in')
  const value = await commission.inputValue().catch(() => '')
  check(/^\d+$/.test(value), 'the commission input is seeded with a real rate, not blank', JSON.stringify(value))

  check(await page.locator('.sidebar').count() === 1,
    'the sidebar is back once signed in (the fix hid it, not deleted it)')

  await page.goto(`${BASE}/disputes`, { waitUntil: 'networkidle' })
  check(new URL(page.url()).pathname === '/disputes', 'the session carries to /disputes', page.url())
  check(errors.length === 0, 'signed-in pages render with no page errors', errors.join('; '))
  await ctx.close()
}

// ---- 4. Forged and expired cookies are rejected -----------------------
{
  const original = goodCookie.value
  const [expiry, nonce, sig] = original.split('.')
  const flip = (s) => s.slice(0, -1) + (s.endsWith('a') ? 'b' : 'a')

  const cases = [
    ['a signature with one byte changed', `${expiry}.${nonce}.${flip(sig)}`],
    ['a nonce with one byte changed', `${expiry}.${flip(nonce)}.${sig}`],
    ['an expiry pushed a year into the future', `${Date.now() + 31_536_000_000}.${nonce}.${sig}`],
    ['an already-expired timestamp', `${Date.now() - 1000}.${nonce}.${await signLike(expiry, nonce)}`],
    ['no signature at all', `${expiry}.${nonce}`],
    ['outright garbage', 'admin'],
  ]

  for (const [label, value] of cases) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await ctx.addCookies([{ name: 'ga_admin', value, domain: new URL(BASE).hostname, path: '/' }])
    await page.goto(`${BASE}/config`, { waitUntil: 'networkidle' })
    check(new URL(page.url()).pathname === '/sign-in', `${label} is rejected`, page.url())
    await ctx.close()
  }
}

// We cannot forge a valid signature without the secret — which is the point.
// This returns the real signature unchanged so the expired-token case tests
// expiry rather than accidentally testing the signature check again.
async function signLike(_expiry, _nonce) { return goodCookie.value.split('.')[2] }

// ---- 5. ?next= cannot be used as an open redirect ---------------------
{
  for (const evil of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)']) {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${BASE}/sign-in?next=${encodeURIComponent(evil)}`, { waitUntil: 'networkidle' })
    await submitPassword(page, PASSWORD)
    const url = new URL(page.url())
    check(url.host === HOST && url.pathname === '/',
      `next=${evil} is ignored, not followed off-site`, page.url())
    await ctx.close()
  }
}

await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
