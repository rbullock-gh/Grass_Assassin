/**
 * Generate the favicon set and the link-preview card.
 *
 *     node apps/web/scripts/make-assets.mjs
 *
 * Rasterising goes through Playwright's Chromium because it is already a root
 * devDependency for the browser checks — no image toolchain is added for three
 * files. Re-run after changing the mark or the brand tokens.
 *
 * The mark is the one from apps/admin/src/app/icon.svg, so the tab icon on the
 * marketing site and the dashboard are the same shape.
 */
import { chromium } from 'playwright'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url))

// Mirrors packages/design: palette.green700 tile, green400 on dark grounds.
const TILE = '#0C682F'
const INK = '#0B1410'
const BRAND_DARK = '#39C26F'

const mark = (tile) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="${tile}"/>
  <g stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none">
    <path d="M6 25h20"/><path d="M10 25v-6"/><path d="M15 25v-10"/><path d="M20 25v-7"/><path d="M25 25v-12"/>
  </g>
</svg>`

const ogCard = (markSvg) => `<!doctype html><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap">
<style>
  *{box-sizing:border-box;margin:0}
  body{width:1200px;height:630px;background:${INK};color:#F4F7F5;
    font-family:Inter,system-ui,sans-serif;padding:74px 78px;display:flex;
    flex-direction:column;justify-content:space-between;position:relative;overflow:hidden}
  body::before{content:"";position:absolute;inset:0;
    background:radial-gradient(64% 84% at 82% 4%, rgba(57,194,111,.15), transparent 62%),
      repeating-linear-gradient(107deg, rgba(255,255,255,.028) 0 44px, transparent 44px 88px)}
  .row{position:relative;display:flex;align-items:center;gap:15px}
  .row img{width:50px;height:50px}
  .name{font-size:33px;font-weight:700;letter-spacing:-.03em}
  h1{position:relative;font-size:72px;font-weight:700;line-height:1.04;
    letter-spacing:-.035em;max-width:17ch}
  .foot{position:relative;display:flex;align-items:center;gap:18px}
  .pill{border:2px solid rgba(57,194,111,.42);color:${BRAND_DARK};border-radius:999px;
    padding:8px 21px;font-size:18px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
  .sub{font-size:22px;color:#A8B6AE}
</style>
<div class="row">
  <img src="data:image/svg+xml;base64,${Buffer.from(markSvg).toString('base64')}">
  <div class="name">GrassAssassin</div>
</div>
<h1>Booking a mow shouldn&rsquo;t take three phone calls.</h1>
<div class="foot">
  <span class="pill">Waitlist open</span>
  <span class="sub">A marketplace for yard work.</span>
</div>`

await mkdir(PUBLIC, { recursive: true })
await writeFile(`${PUBLIC}icon.svg`, mark(TILE))

const browser = await chromium.launch()

for (const [file, size] of [['apple-touch-icon.png', 180], ['icon-512.png', 512]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } })
  await page.setContent(
    `<style>html,body{margin:0}img{width:${size}px;height:${size}px;display:block}</style>`
    + `<img src="data:image/svg+xml;base64,${Buffer.from(mark(TILE)).toString('base64')}">`,
  )
  await page.waitForTimeout(100)
  await page.screenshot({ path: `${PUBLIC}${file}` })
  await page.close()
  console.log(`  public/${file}`)
}

const card = await browser.newPage({ viewport: { width: 1200, height: 630 } })
await card.setContent(ogCard(mark(BRAND_DARK)), { waitUntil: 'networkidle' })
// Without this the card can screenshot mid-swap and ship in the fallback face.
await card.evaluate(() => document.fonts.ready)
await card.waitForTimeout(300)
if (!(await card.evaluate(() => document.fonts.check('700 72px Inter')))) {
  console.log('  ! Inter did not load — the card fell back to a system face')
}
await card.screenshot({ path: `${PUBLIC}og-image.png` })
console.log('  public/og-image.png (1200x630)')

await browser.close()
