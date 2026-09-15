/**
 * Render the Instagram creative.
 *
 *     node apps/web/marketing/instagram/build.mjs
 *
 * Copy lives in posts.mjs; this file only draws it. Everything is typeset from
 * the same tokens as the product — packages/design palette, Inter, the mark
 * from apps/admin/src/app/icon.svg — so an ad and the landing page it points at
 * look like the same company.
 *
 * Output: out/<slug>.png, 1080x1350 for feed and 1080x1920 for story.
 */
import { chromium } from 'playwright'
import { mkdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { posts } from './posts.mjs'

const OUT = fileURLToPath(new URL('./out/', import.meta.url))

/**
 * Where Inter comes from.
 *
 * Normally the Google Fonts CDN. Set GA_FONT_CSS to a local stylesheet — one
 * with the faces embedded as data URIs — to render without network access at
 * all. Needed behind a proxy that re-signs TLS (Chromium refuses the font
 * files even when it accepts the stylesheet) and useful in an air-gapped CI.
 * See README.md for the one-liner that builds such a file.
 */
const FONT_CSS_FILE = process.env.GA_FONT_CSS

// packages/design: ink900 ground, green400 because green600 fails AA on it.
const INK = '#0B1410'
const INK_800 = '#16211B'
const INK_700 = '#24332B'
const INK_300 = '#A8B6AE'
const INK_50 = '#F4F7F5'
const GREEN = '#39C26F'
const TILE = '#0C682F'

const SIZES = {
  feed: { w: 1080, h: 1350 },
  // Instagram overlays its own UI on roughly the top 250px and bottom 320px of
  // a story. Nothing that has to be read goes there.
  story: { w: 1080, h: 1920 },
}

const MARK = `<svg viewBox="0 0 32 32" width="64" height="64">
  <rect width="32" height="32" rx="8" fill="${TILE}"/>
  <g stroke="#fff" stroke-width="2.6" stroke-linecap="round" fill="none">
    <path d="M6 25h20"/><path d="M10 25v-6"/><path d="M15 25v-10"/><path d="M20 25v-7"/><path d="M25 25v-12"/>
  </g>
</svg>`

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const body = (post) => {
  const eyebrow = `<p class="eyebrow">${esc(post.eyebrow)}</p>`
  const support = `<p class="support">${esc(post.support)}</p>`

  if (post.layout === 'numeral') {
    return `${eyebrow}
      <p class="numeral">${esc(post.numeral)}</p>
      <h1 class="h h--after-numeral">${esc(post.headline)}</h1>
      ${support}`
  }

  if (post.layout === 'ladder') {
    const rows = post.ladderRows
      .map(([name, points, rate], i) => {
        // Only the ranks that actually cut the rate get the accent; the rest
        // are the standing rate and must not look like a discount.
        const cut = rate !== post.ladderRows[0][2]
        return `<tr class="${i === 0 ? 'first' : ''}">
          <td class="rank">${esc(name)}</td>
          <td class="pts">${esc(points)}</td>
          <td class="rate ${cut ? 'cut' : ''}">${esc(rate)}</td>
        </tr>`
      })
      .join('')
    return `${eyebrow}
      <h1 class="h h--ladder">${esc(post.headline)}</h1>
      <table class="ladder"><tbody>${rows}</tbody></table>
      ${support}`
  }

  return `${eyebrow}<h1 class="h">${esc(post.headline)}</h1>${support}`
}

const fontCss = FONT_CSS_FILE ? await readFile(FONT_CSS_FILE, 'utf8') : null

const fontHead = fontCss
  ? `<style>${fontCss}</style>`
  : `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap">`

const page = (post) => {
  const { w, h } = SIZES[post.size]
  const story = post.size === 'story'
  return `<!doctype html><meta charset="utf-8">
${fontHead}
<style>
  *{box-sizing:border-box;margin:0}
  body{
    width:${w}px;height:${h}px;background:${INK};color:${INK_50};
    font-family:Inter,system-ui,sans-serif;position:relative;overflow:hidden;
    padding:${story ? '300px 96px 360px' : '96px 96px 92px'};
    display:flex;flex-direction:column;
  }
  /* Mower stripes: the brand texture, and the same one the site uses. */
  body::before{content:"";position:absolute;inset:0;
    background:
      radial-gradient(58% 70% at 84% 6%, rgba(57,194,111,.16), transparent 62%),
      repeating-linear-gradient(107deg, rgba(255,255,255,.03) 0 52px, transparent 52px 104px);}
  .inner{position:relative;display:flex;flex-direction:column;height:100%;}
  .content{flex:1;display:flex;flex-direction:column;justify-content:center;}

  .eyebrow{color:${GREEN};font-size:28px;font-weight:600;letter-spacing:.16em;
    text-transform:uppercase;margin-bottom:34px}
  .h{font-size:${story ? 86 : 82}px;font-weight:700;line-height:1.06;letter-spacing:-.035em;
    text-wrap:balance;max-width:15ch}
  .h--after-numeral{font-size:66px;max-width:14ch;margin-top:-8px}
  .h--ladder{font-size:64px;max-width:16ch;margin-bottom:46px}
  .numeral{font-size:264px;font-weight:800;line-height:.86;letter-spacing:-.05em;
    color:${GREEN};font-variant-numeric:tabular-nums lining-nums;margin-bottom:18px}
  .support{color:${INK_300};font-size:34px;line-height:1.45;margin-top:34px;max-width:26ch}

  .ladder{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums lining-nums}
  .ladder td{padding:19px 0;border-top:1px solid ${INK_700};font-size:33px}
  .ladder tr.first td{border-top:none}
  .ladder .rank{font-weight:600}
  .ladder .pts{color:${INK_300};text-align:right;padding-right:64px}
  .ladder .rate{text-align:right;width:150px;color:${INK_300};font-weight:600}
  .ladder .rate.cut{color:${GREEN}}

  .foot{position:relative;display:flex;align-items:center;gap:22px;
    border-top:1px solid ${INK_700};padding-top:${story ? 40 : 46}px}
  .lockup{display:flex;align-items:center;gap:20px}
  .name{font-size:40px;font-weight:700;letter-spacing:-.03em}
  .pill{margin-left:auto;border:2px solid rgba(57,194,111,.4);color:${GREEN};
    border-radius:999px;padding:12px 28px;font-size:25px;font-weight:600;
    letter-spacing:.07em;text-transform:uppercase;white-space:nowrap}
</style>
<div class="inner">
  <div class="content">${body(post)}</div>
  <div class="foot">
    <div class="lockup">${MARK}<span class="name">GrassAssassin</span></div>
    <span class="pill">${esc(post.cta ?? 'Waitlist open')}</span>
  </div>
</div>`
}

await mkdir(OUT, { recursive: true })

const browser = await chromium.launch()
// This sandbox proxies HTTPS with a CA that Chromium does not trust, which
// silently drops the webfont and ships the card in a fallback face. Harmless
// where the certificate is trusted; necessary where it is not.
const ctx = await browser.newContext({ ignoreHTTPSErrors: true })

let missingFont = 0
let wrongSize = 0
for (const post of posts) {
  const { w, h } = SIZES[post.size]
  // context.newPage() takes no options — a viewport passed here is silently
  // ignored and every post renders at the context default. Set it on the page.
  const p = await ctx.newPage()
  await p.setViewportSize({ width: w, height: h })
  await p.setContent(page(post), { waitUntil: 'networkidle' })
  // fonts.ready resolves once the *current* set is settled, which can be before
  // a face used further down the page has been requested. Wait for the specific
  // weights this creative actually sets.
  const loaded = await p.evaluate(async () => {
    const wanted = ['600 28px Inter', '700 82px Inter', '800 264px Inter', '400 34px Inter']
    try {
      await Promise.all(wanted.map((f) => document.fonts.load(f)))
    } catch {
      return false // the face could not be fetched at all
    }
    await document.fonts.ready
    return wanted.every((f) => document.fonts.check(f))
  })
  if (!loaded) {
    missingFont += 1
    console.log(`  ! ${post.slug}: Inter did not load`)
  }
  await p.screenshot({ path: `${OUT}${post.slug}.png` })

  // Assert the export is the size Instagram will be given. A silently wrong
  // viewport crops the headline, and a cropped headline is the kind of thing
  // that ships because the thumbnail looked fine.
  const actual = await p.evaluate(() => [window.innerWidth, window.innerHeight])
  if (actual[0] !== w || actual[1] !== h) {
    wrongSize += 1
    console.log(`  ! ${post.slug}: rendered ${actual[0]}x${actual[1]}, expected ${w}x${h}`)
  }

  // Nothing may overflow the canvas; a story's safe areas are padding, not luck.
  const overflow = await p.evaluate(() =>
    document.body.scrollHeight > window.innerHeight + 1
    || document.body.scrollWidth > window.innerWidth + 1)
  if (overflow) {
    wrongSize += 1
    console.log(`  ! ${post.slug}: content overflows the canvas — something is clipped`)
  }

  await p.close()
  console.log(`  out/${post.slug}.png  ${w}x${h}  ${post.audience}`)
}

if (missingFont) {
  console.log(`\n  ! Inter did not load for ${missingFont} post(s) — they fell back to a system face.`)
  process.exitCode = 1
}
if (wrongSize) {
  console.log(`  ! ${wrongSize} sizing problem(s) above.`)
  process.exitCode = 1
}

await browser.close()
