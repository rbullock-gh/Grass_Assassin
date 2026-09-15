/**
 * Renders every mobile screen in a real browser and reports what broke.
 *
 * This exists because three of the worst defects this project has had were
 * invisible to typecheck and to the entire unit suite: the app could not bundle
 * at all, every line of text overlapped the line above it, and a worker's
 * balance was rounded up to more money than they had. None of those are
 * findable by reading. All three are obvious in a screenshot.
 *
 * It drives the Expo WEB build, which is not a phone — gestures, native maps,
 * the camera and SecureStore all behave differently. What it does prove is that
 * every screen mounts, fetches, lays out and paints against real data, at four
 * widths, in both themes, without throwing.
 *
 * Usage:
 *   pnpm --filter @grassassassin/api dev            # the API, seeded
 *   pnpm --filter @grassassassin/mobile exec expo export --platform web --output-dir .web
 *   node scripts/serve-web.mjs .web                 # SPA fallback server
 *   node scripts/render-check.mjs
 *
 * Exits non-zero if any combination has a console error, a page error,
 * horizontal overflow, an unmatched route, or renders almost nothing.
 */
import { launchChromium } from './lib/browser.mjs'
import fs from 'node:fs'
import path from 'node:path'

const APP = process.env.APP_URL ?? 'http://localhost:4311'
const API = process.env.API_URL ?? 'http://localhost:4000/v1'
const OUT = process.env.SHOT_DIR ?? path.join(process.cwd(), '.render-check')
const PASSWORD = process.env.DEMO_PASSWORD ?? 'GrassDemo123!'

/**
 * Errors that are expected and say nothing about the screen.
 *
 * A signed-out screen calling /me and getting 401 is the app working correctly.
 * Keep this list short — a permissive filter turns the whole check into
 * decoration.
 */
const IGNORABLE = [/Unauthorized/i, /favicon/i, /\b401\b/]

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  // A Flip unfolded, or an iPad in a narrow split. This width has already
  // caught one layout bug that neither phone nor desktop showed.
  { name: 'fold', width: 600, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
]

async function login(email) {
  const response = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  const body = await response.json()
  if (!body.tokens) throw new Error(`Could not sign in as ${email}: ${JSON.stringify(body)}`)
  return body.tokens
}

const authed = (token) => ({ headers: { authorization: `Bearer ${token}` } })

async function main() {
  fs.mkdirSync(OUT, { recursive: true })

  const worker = await login('worker1@grassassassin.test')
  const customer = await login('customer1@grassassassin.test')

  // Real ids, so the dynamic routes render real state rather than a spinner.
  const mine = await (await fetch(`${API}/jobs/mine?role=CUSTOMER`, authed(customer.accessToken))).json()
  const byStatus = {}
  for (const job of mine.jobs ?? []) (byStatus[job.status] ??= []).push(job)
  const pick = (...wanted) => wanted.map((s) => byStatus[s]?.[0]).find(Boolean) ?? null

  const claimed = pick('CLAIMED', 'EN_ROUTE', 'IN_PROGRESS', 'PENDING_APPROVAL')
  const settled = pick('PAID', 'CLOSED', 'APPROVED')
  const posted = pick('POSTED')

  const screens = [
    { name: 'welcome', path: '/welcome', as: null },
    { name: 'sign-in', path: '/sign-in', as: null },
    { name: 'sign-up', path: '/sign-up', as: null },
    // Signed out by definition: somebody who cannot get in.
    { name: 'forgot-password', path: '/forgot-password', as: null },
    { name: 'reset-password', path: '/reset-password', as: null },
    // And the same screen arriving the way it usually does, from the emailed
    // link, with the token already in the URL.
    { name: 'reset-password-linked', path: '/reset-password?token=example-token', as: null },
    // The map is the one screen that waits on something slow: the location
    // fallback fires at 6s, so anything less screenshots an empty map and
    // reports a false "no jobs".
    { name: 'worker-map', path: '/map', as: worker, settleMs: 8000 },
    { name: 'worker-setup', path: '/setup', as: worker },
    { name: 'earnings', path: '/earnings', as: worker },
    { name: 'payouts', path: '/payouts', as: worker },
    { name: 'payment-methods', path: '/payment-methods', as: customer },
    { name: 'leaderboard', path: '/leaderboard', as: worker },
    { name: 'conversations', path: '/messages', as: worker },
    { name: 'cust-home', path: '/home', as: customer },
    { name: 'post', path: '/post', as: customer },
    { name: 'property-new', path: '/properties/new', as: customer },
    claimed && { name: 'job-claimed', path: `/jobs/${claimed.id}`, as: customer },
    settled && { name: 'job-settled', path: `/jobs/${settled.id}`, as: customer },
    posted && { name: 'job-posted', path: `/jobs/${posted.id}`, as: customer },
    claimed && { name: 'thread', path: `/messages/${claimed.id}`, as: customer },
    claimed && { name: 'report-problem', path: `/report/${claimed.id}`, as: customer },
    // Reporting a PERSON, which is a different screen and a different queue
    // from disputing a job. The subject id is only used on submit — the screen
    // fetches nothing — so any id renders the same thing.
    { name: 'report-person', path: '/report-person/someone?name=Riley', as: customer },
    // Where sign-out lives. Before this screen existed there was no way out of
    // the app at all.
    { name: 'settings', path: '/settings', as: worker },
    { name: 'recurring', path: '/recurring', as: customer },
    { name: 'change-password', path: '/change-password', as: worker },
    { name: 'delete-account', path: '/delete-account', as: worker },
  ].filter(Boolean)

  const browser = await launchChromium()

  const failures = []
  let checked = 0

  for (const scheme of ['light', 'dark']) {
    for (const viewport of VIEWPORTS) {
      // Dark mode is checked at the two extremes rather than everywhere: the
      // theme does not change layout, so the middle widths add runtime without
      // adding coverage.
      if (scheme === 'dark' && !['phone', 'desktop'].includes(viewport.name)) continue

      for (const screen of screens) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: scheme,
        })
        if (screen.as) {
          await context.addInitScript(([access, refresh]) => {
            try {
              localStorage.setItem('ga.access', access)
              localStorage.setItem('ga.refresh', refresh)
            } catch { /* private mode */ }
          }, [screen.as.accessToken, screen.as.refreshToken])
        }

        const page = await context.newPage()
        const errors = []
        page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
        page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`))

        await page.goto(`${APP}${screen.path}`, { waitUntil: 'networkidle' })
        // Most screens have painted by the time networkidle fires; a flat long
        // wait for all of them turns a two-minute check into an eleven-minute
        // one, and a check nobody runs catches nothing.
        await page.waitForTimeout(screen.settleMs ?? 1200)

        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth)
        const text = (await page.evaluate(() => document.body.innerText || '')).trim()
        const key = `${scheme}-${viewport.name}-${screen.name}`
        await page.screenshot({ path: path.join(OUT, `${key}.png`) })

        const problems = []
        const real = errors.filter((e) => !IGNORABLE.some((p) => p.test(e)))
        if (real.length) problems.push(`${real.length} error(s): ${real[0].slice(0, 160)}`)
        if (overflow > 0) problems.push(`${overflow}px horizontal overflow`)
        if (/Unmatched Route|could not be found/i.test(text)) problems.push('route does not exist')
        if (text.length < 30) problems.push(`rendered almost nothing (${text.length} chars)`)

        checked += 1
        if (problems.length) failures.push({ key, problems })
        process.stdout.write(problems.length ? 'x' : '.')
        await context.close()
      }
    }
  }

  await browser.close()

  console.log(`\n\n${checked} screen/viewport/theme combinations rendered`)
  console.log(`screenshots: ${OUT}`)

  if (failures.length === 0) {
    console.log('no problems found')
    return
  }

  console.log(`\n${failures.length} FAILED:`)
  for (const failure of failures) {
    console.log(`  ${failure.key}`)
    for (const problem of failure.problems) console.log(`      ${problem}`)
  }
  process.exitCode = 1
}

await main()
