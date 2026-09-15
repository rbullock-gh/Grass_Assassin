/**
 * Render the exported site and assert the things that only appear once a page
 * is actually laid out.
 *
 *     pnpm --filter @grassassassin/web build
 *     node apps/web/scripts/check-rendered.mjs
 *
 * Covers the four failures a static marketing page actually ships with:
 * horizontal overflow on a phone, content that only exists once JavaScript
 * runs, a console full of errors, and a theme nobody looked at.
 *
 * Exit code is 0 when everything passes, 1 on any failure.
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join, normalize } from 'node:path'

const OUT = fileURLToPath(new URL('../out/', import.meta.url))
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.txt': 'text/plain', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

const failures = []
const fail = (m) => { failures.push(m); console.log(`  FAIL  ${m}`) }
const pass = (m) => console.log(`    ok   ${m}`)

// Static export uses absolute /_next/... paths, so file:// cannot load the page.
const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let path = join(OUT, rel)
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
  } catch {
    path = join(OUT, '404.html')
  }
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  }
})

await new Promise((r) => server.listen(0, r))
const base = `http://127.0.0.1:${server.address().port}/`
console.log(`Checking the exported site at ${base}\n`)

const browser = await chromium.launch()

/* ---- overflow, console errors, both themes ----------------------------- */
for (const scheme of ['light', 'dark']) {
  console.log(`  ${scheme} scheme`)
  for (const width of [390, 820, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      colorScheme: scheme,
    })
    const errors = []
    const offsite = []
    page.on('pageerror', (e) => errors.push(`uncaught: ${e.message}`))
    // "Failed to load resource" is the console's echo of a failed request; the
    // requestfailed handler below reports those with a URL, which is the part
    // that says whether it matters.
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
        errors.push(`console: ${m.text()}`)
      }
    })
    page.on('requestfailed', (r) => {
      const line = `${r.url()} — ${r.failure()?.errorText ?? 'failed'}`
      // A same-origin asset that fails is this site's bug. A third-party one is
      // the network's, and the page is built to survive it: the webfont has a
      // full fallback stack behind it, which is exactly why it loads as a
      // stylesheet rather than blocking the render.
      if (r.url().startsWith(base)) errors.push(`missing asset: ${line}`)
      else offsite.push(line)
    })

    await page.goto(base, { waitUntil: 'networkidle' })
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 500) {
        window.scrollTo(0, y)
        await new Promise((r) => setTimeout(r, 20))
      }
    })
    await page.waitForTimeout(200)

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    )
    if (overflows) fail(`${scheme} ${width}px: the page scrolls sideways`)
    else pass(`${width}px no horizontal overflow`)

    for (const e of errors) fail(`${scheme} ${width}px ${e}`)
    if (!errors.length) pass(`${width}px no page or asset errors`)
    for (const o of offsite) console.log(`    note  offsite resource unavailable here: ${o}`)
    await page.close()
  }
}

/* ---- the switch actually switches -------------------------------------- */
console.log('\n  audience switch')
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(base, { waitUntil: 'networkidle' })
  const homeVisible = () => page.locator('.panel--home .signup__h').first().isVisible()
  const proVisible = () => page.locator('.panel--pro .signup__h').first().isVisible()

  if (await homeVisible()) pass('homeowner panel shows by default')
  else fail('homeowner panel is not visible by default')
  if (await proVisible()) fail('worker panel is visible before the switch is used')
  else pass('worker panel hidden by default')

  await page.click('label[for="view-pro"]')
  await page.waitForTimeout(250)
  if (await proVisible()) pass('worker panel shows after switching')
  else fail('switching to worker showed nothing')
  if (await homeVisible()) fail('homeowner panel still visible after switching')
  else pass('homeowner panel hidden after switching')
  await page.close()
}

/* ---- JavaScript off ----------------------------------------------------- */
console.log('\n  javascript off')
{
  const ctx = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 1280, height: 900 },
  })
  const page = await ctx.newPage()
  await page.goto(base, { waitUntil: 'load' })
  await page.waitForTimeout(200)

  // isVisible() reports true for a fully transparent element, so assert on
  // computed opacity instead.
  const invisible = await page.evaluate(() =>
    [...document.querySelectorAll('h1, .sec__h, .card, .rate, .faq details')]
      .filter((el) => parseFloat(getComputedStyle(el).opacity) < 0.99).length)
  if (invisible) fail(`${invisible} blocks are transparent with JavaScript off`)
  else pass('all content visible')

  const forms = await page.locator('form.signup').count()
  if (forms >= 2) pass(`${forms} waitlist forms still post without JavaScript`)
  else fail(`expected 2 waitlist forms without JavaScript, found ${forms}`)

  // The switch is pure CSS, so it must still work here.
  await page.click('label[for="view-pro"]')
  await page.waitForTimeout(150)
  if (await page.locator('.panel--pro .signup__h').first().isVisible()) {
    pass('the audience switch works with JavaScript off')
  } else {
    fail('the audience switch does nothing with JavaScript off')
  }
  await ctx.close()
}

await browser.close()
server.close()

console.log('\n' + '-'.repeat(58))
if (failures.length) {
  console.log(`${failures.length} failure(s)`)
  process.exit(1)
}
console.log('All rendered checks passed')
