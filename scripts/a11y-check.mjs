import path from 'node:path'
import { launchChromium } from './lib/browser.mjs'
import { mintAccessToken } from './lib/token.mjs'

/**
 * An accessibility audit that runs, rather than a checklist someone signs.
 *
 * Four things, chosen because they are the ones that actually stop people using
 * a marketplace app, and because a machine can judge them honestly:
 *
 *   Contrast — a worker reads this screen outdoors, in sunlight, on a phone held
 *   at arm's length. Grey-on-grey that looks refined on a desk monitor is
 *   invisible in a front yard at 2pm.
 *
 *   Target size — the person tapping "claim" may be wearing work gloves. A 30px
 *   button is a missed tap, and a missed tap on this app is a lost job.
 *
 *   Names — an unlabelled icon button is a button a screen reader announces as
 *   "button", which tells someone nothing about whether it cancels their job.
 *
 *   Focus — a visible focus ring is the only way anyone navigating by keyboard
 *   knows where they are.
 *
 * Usage:
 *   node scripts/a11y-check.mjs --app mobile [--base http://localhost:4311]
 *   node scripts/a11y-check.mjs --app admin  [--base http://localhost:3001]
 */

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const APP = argOf('--app', 'mobile')
const API = (process.env.API_URL ?? 'http://localhost:4000/v1').replace(/\/$/, '')
const PASSWORD = process.env.DEMO_PASSWORD ?? 'GrassDemo123!'

/** WCAG AA. 3:1 is the large-text threshold; 4.5:1 everything else. */
const AA_NORMAL = 4.5
const AA_LARGE = 3.0
/** Apple and Google both land on 44pt. Gloves do not make it easier. */
const MIN_TARGET = 44

const MOBILE_SCREENS = [
  { name: 'welcome', path: '/', as: null },
  { name: 'cust-home', path: '/home', as: 'customer' },
  { name: 'post', path: '/post', as: 'customer' },
  { name: 'payment-methods', path: '/payment-methods', as: 'customer' },
  /*
   * settleMs, because the map's "Location is off" banner appears only after
   * the location fallback fires at 6s. Auditing at 500ms had never once seen
   * it — and when finally measured it was 2.86:1, the least readable thing in
   * the product, on the screen a worker looks at most.
   */
  { name: 'worker-map', path: '/map', as: 'worker', settleMs: 8000 },
  { name: 'earnings', path: '/earnings', as: 'worker' },
  { name: 'payouts', path: '/payouts', as: 'worker' },
  { name: 'leaderboard', path: '/leaderboard', as: 'worker' },
  { name: 'report-person', path: '/report-person/someone?name=Riley', as: 'customer' },
  { name: 'settings', path: '/settings', as: 'worker' },
  { name: 'recurring', path: '/recurring', as: 'customer' },
]

const ADMIN_PAGES = [
  { name: 'sign-in', path: '/sign-in' },
  { name: 'dashboard', path: '/' },
  { name: 'disputes', path: '/disputes' },
  { name: 'config', path: '/config' },
  { name: 'jobs', path: '/jobs' },
  { name: 'reports', path: '/reports' },
]

/**
 * Everything measured in one pass inside the page.
 *
 * Done here rather than over the wire because contrast needs the COMPUTED
 * background, which means walking ancestors until something is actually opaque —
 * a colour that looks fine in the stylesheet can be sitting on a surface that
 * makes it unreadable.
 */
const AUDIT = (opts = {}) => {
  // With `only`, re-measures a single element's contrast and nothing else.
  // Used by the hover pass, so that :hover states go through exactly the same
  // background resolution as everything else rather than a second copy of it.
  const parseColor = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/)
    if (!m) return null
    const [r, g, b, a] = m[1].split(',').map((n) => Number(n.trim()))
    return { r, g, b, a: a === undefined ? 1 : a }
  }

  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  const contrast = (fg, bg) => {
    const a = luminance(fg), b = luminance(bg)
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
  }

  /** Semi-transparent ink as the eye actually sees it: composited over its ground. */
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  })

  /**
   * The first ancestor that actually paints something.
   *
   * The fallback matters more than it looks. An earlier version assumed white
   * when nothing opaque was found, and reported every dark-mode screen title as
   * 1.04:1 — near-white text on an imagined white page — while the header
   * rendered perfectly. Falling back to the viewer's colour scheme instead of a
   * guess is the difference between an audit and a generator of false alarms.
   */
  const effectiveBackground = (el) => {
    /*
     * What is painted behind this text, taken from the paint stack rather than
     * the ancestor chain.
     *
     * Walking ancestors lied twice. Dark-mode screen titles reported 1.04:1 —
     * near-white on near-white — because the header's own background is drawn by
     * a positioned SIBLING, not a parent, so the walk sailed past it to a light
     * container underneath. A screenshot of that header shows white text on dark
     * grey, perfectly legible. elementsFromPoint returns everything stacked at a
     * point in paint order, siblings included, which is what the eye sees.
     */
    const box = el.getBoundingClientRect()
    const x = box.left + box.width / 2
    const y = box.top + box.height / 2
    const onScreen = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight

    if (onScreen) {
      const stack = document.elementsFromPoint(x, y)
      const self = stack.indexOf(el)
      // Only trust the stack when our own element is in it. If it is not, the
      // text is covered by something and the entries above it are not its
      // background.
      if (self !== -1) {
        /*
         * Starts AT the element, not after it.
         *
         * Skipping it reported the admin's green "Sign in" button as white text
         * at 1:1 — the button paints its own fill, so stepping past it found the
         * white card underneath. A screenshot shows white on dark green, 6.92:1.
         * An element's own background is painted behind its own text; there is
         * no case where it should be stepped over.
         */
        for (let i = self; i < stack.length; i += 1) {
          const bg = parseColor(getComputedStyle(stack[i]).backgroundColor)
          if (bg && bg.a > 0.95) return bg
        }
      }
    }

    let node = el
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor)
      if (bg && bg.a > 0.95) return bg
      node = node.parentElement
    }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches
    return dark ? { r: 11, g: 20, b: 16, a: 1 } : { r: 255, g: 255, b: 255, a: 1 }
  }

  const visible = (el) => {
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return false
    if (Number(style.opacity) < 0.1) return false
    const box = el.getBoundingClientRect()
    return box.width > 0 && box.height > 0
  }

  /**
   * Hidden from assistive technology, on purpose.
   *
   * A control marked aria-hidden is decoration with a bigger control wrapped
   * around it — the switch inside a pressable row, say. It is neither a tap
   * target nor a thing that needs a name, and reporting it as both sends
   * somebody off to "fix" a control that is already correct.
   */
  const ariaHidden = (el) => el.closest('[aria-hidden="true"]') !== null

  const describe = (el) => {
    const text = (el.textContent ?? '').trim().slice(0, 40)
    const id = el.id ? `#${el.id}` : ''
    return `${el.tagName.toLowerCase()}${id}${text ? ` "${text}"` : ''}`
  }

  const findings = { contrast: [], targets: [], names: [], focus: [] }

  // --- contrast -----------------------------------------------------------
  const scope = opts.only
    ? [...document.querySelectorAll(opts.only)]
    : [...document.querySelectorAll('*')]

  for (const el of scope) {
    if (!visible(el)) continue
    // Only elements that render their own text, not containers of it.
    const ownText = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .join('')
    if (ownText.length === 0) continue

    const style = getComputedStyle(el)
    const raw = parseColor(style.color)
    /*
     * Fully transparent text is decoration or a screen-reader-only label.
     * PARTLY transparent text is text, and skipping it was a real blind spot:
     * the admin sidebar rendered its signed-in name at rgba(255,255,255,.92)
     * and its email at .52 on a white surface — invisible in light mode, and
     * silently unmeasured because both fell under the old alpha cut-off. They
     * are composited over their background instead.
     */
    if (!raw || raw.a <= 0.05) continue

    const size = parseFloat(style.fontSize)
    const weight = Number(style.fontWeight) || 400
    const isLarge = size >= 24 || (size >= 18.66 && weight >= 700)
    const required = isLarge ? 3.0 : 4.5

    const bg = effectiveBackground(el)
    const fg = raw.a >= 0.999 ? raw : over(raw, bg)
    const ratio = contrast(fg, bg)
    if (ratio < required) {
      findings.contrast.push({
        el: describe(el),
        ratio: Number(ratio.toFixed(2)),
        required,
        size: Number(size.toFixed(1)),
        color: style.color,
      })
    }
  }

  // --- targets and names --------------------------------------------------
  if (opts.only) return findings
  const interactive = document.querySelectorAll(
    'button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"]',
  )
  for (const el of interactive) {
    if (!visible(el) || ariaHidden(el)) continue
    const box = el.getBoundingClientRect()

    // Hidden inputs behind a styled label are the normal pattern and are fine.
    const type = (el.getAttribute('type') ?? '').toLowerCase()
    const inLabel = el.closest('label') !== null
    const proxied = (type === 'radio' || type === 'checkbox') && inLabel

    if (!proxied && (box.height < 44 || box.width < 44)) {
      findings.targets.push({
        el: describe(el),
        // One decimal, not rounded. A 43.5px target printed as "44×49px" reads
        // like the checker is broken rather than like the element being half a
        // pixel short of the line.
        width: Number(box.width.toFixed(1)),
        height: Number(box.height.toFixed(1)),
      })
    }

    const name =
      (el.getAttribute('aria-label') ?? '').trim() ||
      (el.textContent ?? '').trim() ||
      (el.getAttribute('title') ?? '').trim() ||
      (el.getAttribute('placeholder') ?? '').trim() ||
      (el.labels && el.labels.length > 0 ? (el.labels[0].textContent ?? '').trim() : '') ||
      (el.getAttribute('alt') ?? '').trim()

    if (name.length === 0) findings.names.push({ el: describe(el) })
  }

  return findings
}

/**
 * Focus visibility, checked by actually focusing things.
 *
 * A computed style cannot answer this — `:focus-visible` rules only apply once
 * something is focused, so the only honest test is to focus it and look.
 */
const FOCUS_AUDIT = () => {
  const results = []
  const targets = [...document.querySelectorAll('button, a[href], input, select, textarea')]
    .filter((el) => {
      const box = el.getBoundingClientRect()
      return box.width > 0 && box.height > 0
    })
    .slice(0, 12)

  for (const el of targets) {
    const before = getComputedStyle(el)
    const baseline = `${before.outlineStyle}|${before.outlineWidth}|${before.boxShadow}|${before.borderColor}`
    el.focus()
    const after = getComputedStyle(el)
    const focused = `${after.outlineStyle}|${after.outlineWidth}|${after.boxShadow}|${after.borderColor}`
    const ring = after.outlineStyle !== 'none' && parseFloat(after.outlineWidth) > 0
    if (!ring && baseline === focused) {
      results.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"`)
    }
    el.blur()
  }
  return results
}

/**
 * Puts a signed-in session in the page, without using the login endpoint.
 *
 * Sign-in is rate limited per address, and this suite visits eight screens as
 * two different people twice over — which looks exactly like an attack from one
 * machine and gets refused. The token is minted with the API's own secret, so it
 * is an ordinary valid one.
 */
async function signIn(page, base, who) {
  const db = await workerAndCustomer()
  const person = who === 'worker' ? db.worker : db.customer
  const accessToken = await mintAccessToken(person.id, person.roles)

  await page.goto(base, { waitUntil: 'domcontentloaded' })
  await page.evaluate((token) => {
    try {
      localStorage.setItem('ga.access', token)
    } catch { /* private mode */ }
  }, accessToken)
}

/** Read once: the seeded pair every screen here is viewed as. */
let people = null
async function workerAndCustomer() {
  if (people) return people
  const { PrismaClient } = await import('@prisma/client')
  const db = new PrismaClient()
  const [worker, customer] = await Promise.all([
    db.user.findFirstOrThrow({
      where: { roles: { has: 'WORKER' }, status: 'ACTIVE' },
      select: { id: true, roles: true },
    }),
    db.user.findFirstOrThrow({
      where: { roles: { has: 'CUSTOMER' }, status: 'ACTIVE' },
      select: { id: true, roles: true },
    }),
  ])
  await db.$disconnect()
  people = { worker, customer }
  return people
}

/**
 * Contrast in the :hover state, checked by actually hovering.
 *
 * This exists because of a bug found by accident. The admin's sign-in click
 * left the pointer resting on the submit button; the next pass through that
 * page measured the button in :hover and reported 3.30:1. It was right — every
 * primary button in that dashboard got HARDER to read the moment the pointer
 * landed on it, which is the one moment someone is reading it. A hover rule
 * that brightens a fill under white text is invisible to a computed-style audit
 * and invisible to a screenshot taken with the mouse parked in a corner.
 */
async function hoverContrast(page, AUDIT) {
  const found = []
  const handles = await page.$$('button, a[href], [role="button"]')

  for (const handle of handles.slice(0, 20)) {
    try {
      await handle.evaluate((el) => el.setAttribute('data-a11y-hover', '1'))
      await handle.hover({ timeout: 1500 })
      const findings = await page.evaluate(AUDIT, { only: '[data-a11y-hover]' })
      for (const c of findings.contrast) {
        found.push(`${c.el} on hover — ${c.ratio}:1 at ${c.size}px (needs ${c.required}:1) ${c.color}`)
      }
    } catch {
      // Off-screen, covered, or detached between query and hover. Not a finding:
      // the element simply could not be hovered, which is not the same as
      // failing, and reporting it as one is how a suite loses its credibility.
    } finally {
      await handle.evaluate((el) => el.removeAttribute('data-a11y-hover')).catch(() => {})
    }
  }

  // Park the pointer somewhere harmless so the next page is measured at rest.
  await page.mouse.move(0, 0)
  return found
}

async function main() {
  const isAdmin = APP === 'admin'
  const base = argOf('--base', isAdmin ? 'http://localhost:3001' : 'http://localhost:4311')
    .replace(/\/$/, '')

  const browser = await launchChromium()
  const problems = []
  let audited = 0

  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({
      viewport: isAdmin ? { width: 1280, height: 900 } : { width: 390, height: 844 },
      colorScheme: scheme,
      extraHTTPHeaders: { 'x-forwarded-for': `198.51.100.${1 + Math.floor(Math.random() * 250)}` },
    })
    const page = await ctx.newPage()

    if (isAdmin) {
      await page.goto(`${base}/sign-in`, { waitUntil: 'networkidle' })
      await page.fill('input[name="email"]', process.env.ADMIN_EMAIL ?? 'admin@grassassassin.test')
      await page.fill('input[name="password"]', process.env.ADMIN_PASSWORD ?? 'test-admin-password')
      const before = page.url()
      await Promise.all([
        page.waitForURL((u) => u.toString() !== before, { timeout: 20_000 }),
        page.click('button[type="submit"]'),
      ])
    }

    const pages = isAdmin ? ADMIN_PAGES : MOBILE_SCREENS
    let signedInAs = null

    for (const target of pages) {
      if (!isAdmin && target.as && target.as !== signedInAs) {
        await signIn(page, base, target.as)
        signedInAs = target.as
      }

      await page.goto(base + target.path, { waitUntil: 'networkidle' })
      await page.waitForTimeout(target.settleMs ?? 500)

      /*
       * Refuse to audit a page that is not wearing its stylesheet.
       *
       * A stale `next start` once served HTML pointing at a CSS bundle a
       * rebuild had renamed. Every link 404'd, the browser fell back to UA
       * defaults, and this script produced 1039 confident findings — black text
       * on black, every control 21px tall — about an app that renders fine. A
       * report that cannot tell "your design is broken" from "your CSS did not
       * load" is worse than no report, because someone acts on it.
       */
      const styling = await page.evaluate(() => {
        const sheets = [...document.styleSheets]
        let rules = 0
        for (const sheet of sheets) {
          try { rules += sheet.cssRules.length } catch { /* cross-origin */ }
        }
        const links = [...document.querySelectorAll('link[rel="stylesheet"]')].map((l) => l.href)
        return { rules, links }
      })
      if (styling.rules < 10) {
        throw new Error(
          `${scheme}/${target.name}: the page loaded with ${styling.rules} CSS rules — its ` +
          `stylesheet did not apply, so nothing measured here would mean anything.\n` +
          `  stylesheet links: ${styling.links.join(', ') || '(none)'}\n` +
          `  A stale server serving a renamed bundle is the usual cause: restart it after building.`,
        )
      }

      const findings = await page.evaluate(AUDIT)
      const noFocusRing = await page.evaluate(FOCUS_AUDIT)
      const hoverProblems = await hoverContrast(page, AUDIT)
      audited += 1

      const where = `${scheme}/${target.name}`
      for (const c of findings.contrast) {
        problems.push({
          kind: 'contrast', where,
          detail: `${c.el} — ${c.ratio}:1 at ${c.size}px (needs ${c.required}:1) ${c.color}`,
        })
      }
      for (const t of findings.targets) {
        problems.push({ kind: 'target', where, detail: `${t.el} — ${t.width}×${t.height}px` })
      }
      for (const n of findings.names) {
        problems.push({ kind: 'name', where, detail: `${n.el} has no accessible name` })
      }
      for (const f of noFocusRing) {
        problems.push({ kind: 'focus', where, detail: `${f} shows nothing when focused` })
      }
      for (const h of hoverProblems) {
        problems.push({ kind: 'contrast', where, detail: h })
      }

      process.stdout.write(
        findings.contrast.length + findings.targets.length +
        findings.names.length + noFocusRing.length + hoverProblems.length > 0 ? 'x' : '.',
      )
    }

    await ctx.close()
  }

  await browser.close()

  console.log(`\n\n${audited} screen/theme combinations audited`)

  if (problems.length === 0) {
    console.log('no accessibility problems found')
    return
  }

  const byKind = {}
  for (const p of problems) (byKind[p.kind] ??= []).push(p)

  const titles = {
    contrast: 'Text too faint to read',
    target: 'Tap targets under 44px',
    name: 'Controls a screen reader cannot name',
    focus: 'No visible focus',
  }

  console.log(`\n${problems.length} problems:\n`)
  for (const [kind, list] of Object.entries(byKind)) {
    console.log(`  ${titles[kind]} (${list.length})`)
    // Collapsed by detail, because the same button failing on eight screens is
    // one fix, not eight findings. The count is printed rather than dropped:
    // a list of 4 lines under a heading that says 10 reads like a bug in the
    // report, and hides that both themes are affected.
    const groups = new Map()
    for (const p of list) {
      const group = groups.get(p.detail)
      if (group) group.count += 1
      else groups.set(p.detail, { where: p.where, count: 1 })
    }
    for (const [detail, group] of groups) {
      const times = group.count > 1 ? ` (×${group.count})` : ''
      console.log(`    ${group.where.padEnd(24)} ${detail}${times}`)
    }
    console.log('')
  }
  process.exitCode = 1
}

await main()
