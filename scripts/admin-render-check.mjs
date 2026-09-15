import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { launchChromium } from './lib/browser.mjs'

/**
 * Draws every admin page at every width, in both themes, and reports what broke.
 *
 * The functional suites prove the locks lock and the money adds up. Neither
 * looks at the page. A dispute form that overflows its container at 600px, or
 * renders white text on white in dark mode, passes every one of them — and the
 * screen where somebody decides who keeps two hundred dollars is a bad place to
 * discover that the number is unreadable.
 *
 * Fails on a console error, a page error, horizontal overflow, a page that
 * renders almost nothing, or an unstyled page (which is what a stylesheet that
 * failed to load looks like, and is otherwise surprisingly easy to miss).
 *
 * Usage:
 *   node scripts/admin-render-check.mjs [--base http://localhost:3001]
 */

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const BASE = argOf('--base', process.env.ADMIN_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '')
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@grassassassin.test'
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'test-admin-password'
const OUT = process.env.SHOT_DIR ?? path.join(process.cwd(), '.render-check-admin')

/** Short on purpose: a permissive filter turns this into decoration. */
const IGNORABLE = [/favicon/i, /Download the React DevTools/i]

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  // A Flip unfolded or a narrow split view. The sidebar collapses at 900px, so
  // this width sits on the wrong side of the breakpoint on purpose.
  { name: 'fold', width: 600, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'desktop', width: 1440, height: 900 },
]

/**
 * `requires` is the point of this list, not decoration.
 *
 * The first run of this suite reported 64 clean combinations while rendering
 * none of the dispute form it was written for — every dispute in the database
 * happened to be resolved, so the page drew a table and nothing else and the
 * check called that a pass. A visual suite that goes green because the thing it
 * checks was absent is worse than no visual suite, because it is trusted.
 *
 * So each page names a selector that must be on it. A missing one is a failure
 * of the run, not a quiet skip.
 */
const PAGES = [
  { name: 'sign-in', path: '/sign-in', signedIn: false, requires: 'input[name="password"]' },
  { name: 'dashboard', path: '/', requires: '.sidebar' },
  { name: 'jobs', path: '/jobs', requires: 'table' },
  { name: 'workers', path: '/workers', requires: 'table' },
  { name: 'disputes', path: '/disputes', requires: 'form.resolve-form' },
  { name: 'reports', path: '/reports', requires: '.panel' },
  { name: 'payments', path: '/payments', requires: '.panel' },
  { name: 'config', path: '/config', requires: 'input[name="fees.worker_commission_bps"]' },
]

async function signIn(page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: 'networkidle' })
  const before = page.url()
  await page.fill('input[name="email"]', EMAIL)
  await page.fill('input[name="password"]', PASSWORD)
  await Promise.all([
    page.waitForURL((u) => u.toString() !== before, { timeout: 20_000 }),
    page.click('button[type="submit"]'),
  ])
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await launchChromium()
  const failures = []
  let checked = 0

  for (const scheme of ['light', 'dark']) {
    for (const viewport of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        colorScheme: scheme,
        // A fresh source per context: sign-in is throttled per source, and this
        // suite signs in eight times per combination.
        extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${1 + Math.floor(Math.random() * 250)}` },
      })
      const page = await ctx.newPage()

      const noise = []
      page.on('pageerror', (e) => noise.push({ kind: 'page', text: String(e) }))
      page.on('console', (m) => {
        if (m.type() === 'error') noise.push({ kind: 'console', text: m.text() })
      })

      await signIn(page)

      for (const target of PAGES) {
        noise.length = 0
        await page.goto(BASE + target.path, { waitUntil: 'networkidle' })
        await page.waitForTimeout(350)

        const problems = []
        const url = new URL(page.url())
        if (target.signedIn === false) {
          if (url.pathname !== target.path) problems.push(`redirected to ${url.pathname}`)
        } else if (url.pathname !== target.path) {
          problems.push(`did not stay on ${target.path} (went to ${url.pathname})`)
        }

        const measured = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          text: (document.body.innerText ?? '').trim().length,
          // A page with no stylesheet still has text; it just looks like 1995.
          // Reading a computed colour is the cheapest way to notice.
          styled: getComputedStyle(document.body).backgroundColor,
        }))

        // 2px of tolerance for sub-pixel rounding, not for a real overflow.
        if (measured.scrollWidth > measured.clientWidth + 2) {
          problems.push(`horizontal overflow: ${measured.scrollWidth} > ${measured.clientWidth}`)
        }
        if (measured.text < 40) problems.push(`almost nothing rendered (${measured.text} chars)`)

        /**
         * Controls clipped inside a scrolling container.
         *
         * The document-level overflow check above passes happily when a table
         * has `overflow-x: auto` — the page does not scroll, the table does. So
         * a decision form parked inside one had its options and its submit
         * button off the right edge at 390px while every check reported green.
         * This asks each interactive control whether it is actually reachable.
         */
        const clipped = await page.evaluate(() => {
          const out = []
          const controls = document.querySelectorAll('button, input, select, textarea, a[href]')
          for (const el of controls) {
            const box = el.getBoundingClientRect()
            if (box.width === 0 && box.height === 0) continue
            // Off the right edge of the window, or off the right edge of an
            // ancestor that scrolls horizontally.
            if (box.left >= window.innerWidth || box.right <= 0) {
              out.push(`${el.tagName.toLowerCase()}${el.name ? `[name=${el.name}]` : ''}`)
              continue
            }
            let parent = el.parentElement
            while (parent && parent !== document.body) {
              const style = getComputedStyle(parent)
              if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
                const pb = parent.getBoundingClientRect()
                if (box.right > pb.right + 2 || box.left < pb.left - 2) {
                  out.push(`${el.tagName.toLowerCase()}${el.name ? `[name=${el.name}]` : ''} in a scroller`)
                }
                break
              }
              parent = parent.parentElement
            }
          }
          return [...new Set(out)]
        })
        if (clipped.length > 0) {
          problems.push(`controls out of reach: ${clipped.slice(0, 6).join(', ')}`)
        }

        if (target.requires && (await page.locator(target.requires).count()) === 0) {
          problems.push(
            `nothing matching "${target.requires}" — this page's subject is not on it, ` +
            'so rendering it proves nothing (for /disputes, the fixture needs an OPEN dispute)',
          )
        }
        if (measured.styled === 'rgba(0, 0, 0, 0)' || measured.styled === '') {
          problems.push('body has no background — stylesheet did not load')
        }

        for (const item of noise) {
          if (IGNORABLE.some((re) => re.test(item.text))) continue
          problems.push(`${item.kind} error: ${item.text.slice(0, 200)}`)
        }

        const shot = `${scheme}-${viewport.name}-${target.name}.png`
        await page.screenshot({ path: path.join(OUT, shot), fullPage: true })
        checked += 1
        if (problems.length > 0) failures.push({ shot, problems })
        process.stdout.write(problems.length ? 'x' : '.')
      }

      await ctx.close()
    }
  }

  await browser.close()

  console.log(`\n\n${checked} page/viewport/theme combinations rendered`)
  console.log(`screenshots: ${OUT}`)
  if (failures.length === 0) {
    console.log('no problems found')
    return
  }
  console.log(`\n${failures.length} with problems:\n`)
  for (const failure of failures) {
    console.log(`  ${failure.shot}`)
    for (const problem of failure.problems) console.log(`    - ${problem}`)
  }
  process.exitCode = 1
}

await main()
