/**
 * Generates the app's icon, splash and notification artwork.
 *
 * Before this ran there was no `assets/` directory at all, `icon` was null in
 * app.json, and the splash and adaptive icon named a background colour with no
 * image behind it. A store build does not warn about that — Xcode and Gradle
 * refuse outright, and EAS produces a build wearing Expo's placeholder, which
 * is worse because it looks finished.
 *
 * Drawn here rather than committed as opaque binaries so the mark can be
 * changed by editing shapes instead of by finding whoever has the source file.
 * Chromium renders the SVG; it is already in this repo for the render and
 * accessibility checks, so this adds no tooling.
 *
 *   node scripts/make-icons.mjs
 *
 * `pnpm test:scripts` checks the results are real PNGs at the exact dimensions
 * each platform requires, and that the Android foreground keeps its mark inside
 * the safe circle the launcher may crop to.
 */
import { launchChromium } from './lib/browser.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'

const OUT = path.join(process.cwd(), 'apps/mobile/assets')

// From packages/design tokens. Restated rather than imported because this is a
// plain script and the tokens are TypeScript; the test asserts they still match.
export const BRAND = { mid: '#0F833B', deep: '#0C682F', light: '#39C26F' }

/**
 * The mark: a blade of grass, cut.
 *
 * ONE shape, not a clump. The first attempt drew three even blades on a
 * baseline and read as a crown — at icon size a row of similar verticals stops
 * being grass and becomes a fence, a crown or a jelly mould, and no amount of
 * detail rescues it because the detail is what disappears first.
 *
 * So: one bold leaf with a real curve and a real taper, and a diagonal slice
 * taken off the tip. The slice is the product. A customer is not buying grass,
 * they are buying grass that has been dealt with, and the cut is the only part
 * of that idea that survives being 40px wide. Two much smaller blades behind
 * it place the shape as grass rather than a feather or a flame, and they are
 * small enough to drop out gracefully when they are two pixels across.
 *
 * `scale` shrinks the mark within its box: Android crops an adaptive icon to
 * whatever shape the launcher likes, so the foreground has to sit well inside.
 */
function mark({ size, scale = 1, fill = 'white', background = null }) {
  const pad = (1 - scale) / 2
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  ${background ? `<rect width="100" height="100" fill="${background}"/>` : ''}
  <g transform="translate(${pad * 100} ${pad * 100}) scale(${scale})">
    <g fill="${fill}">
      <!-- Back blades: smaller, leaning away, so the silhouette is not one
           lonely vertical. Drawn first so the main blade overlaps them. -->
      <path d="M30 88 C 28 70, 26 58, 18 46 C 30 52, 37 68, 38 88 Z"/>
      <path d="M70 88 C 71 72, 74 62, 84 52 C 76 64, 75 74, 76 88 Z"/>

      <!--
        The main blade. Rises from a wide base, curves right, and stops at a
        flat diagonal instead of a point — that flat is the cut.
      -->
      <path d="M40 88
               C 40 62, 44 40, 58 22
               L 72 33
               C 58 47, 52 66, 52 88 Z"/>

      <!-- The severed tip, lifted clear and tilted, so the cut reads as
           something that just happened rather than a blade that grew blunt. -->
      <path d="M74 20 C 80 13, 86 9, 92 7 C 88 13, 84 19, 80 26 Z"/>
    </g>
  </g>
</svg>`
}

/** Every file a store build asks for, and why that size. */
const ASSETS = [
  {
    file: 'icon.png',
    size: 1024,
    // iOS requires 1024×1024 with NO transparency — an alpha channel is
    // rejected at upload, which is a late and annoying place to find out.
    svg: () => mark({ size: 1024, scale: 0.62, background: BRAND.deep }),
    opaque: true,
  },
  {
    file: 'adaptive-icon.png',
    size: 1024,
    /*
     * Android's foreground layer, transparent, and drawn small on purpose.
     * The launcher crops this to a circle, squircle or whatever the OEM
     * prefers, and only the middle 66% is guaranteed to survive. A mark sized
     * to fill the square loses its edges on a Pixel.
     */
    svg: () => mark({ size: 1024, scale: 0.42 }),
    safeZone: 0.66,
  },
  {
    file: 'splash.png',
    size: 1284,
    // Shown on the brand green named in app.json, so the mark is transparent
    // and `resizeMode: contain` keeps it centred at any aspect ratio.
    svg: () => mark({ size: 1284, scale: 0.5 }),
  },
  {
    file: 'notification-icon.png',
    size: 96,
    /*
     * Android draws a notification icon as a SILHOUETTE: every non-transparent
     * pixel becomes the accent colour, whatever colour it started as. A
     * full-colour icon here renders as a solid blob, which is the single most
     * common way this file is got wrong.
     */
    svg: () => mark({ size: 96, scale: 0.72 }),
  },
  {
    file: 'favicon.png',
    size: 48,
    svg: () => mark({ size: 48, scale: 0.7, background: BRAND.deep }),
    opaque: true,
  },
]

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const browser = await launchChromium()

  try {
    for (const asset of ASSETS) {
      const page = await browser.newPage({
        viewport: { width: asset.size, height: asset.size },
        deviceScaleFactor: 1,
      })
      await page.setContent(
        `<style>html,body{margin:0;padding:0;background:transparent}</style>${asset.svg()}`,
      )
      await page.screenshot({
        path: path.join(OUT, asset.file),
        omitBackground: !asset.opaque,
        type: 'png',
      })
      await page.close()
      console.log(`  ${asset.file.padEnd(22)} ${asset.size}×${asset.size}`)
    }
  } finally {
    await browser.close()
  }

  console.log(`\n${ASSETS.length} assets written to apps/mobile/assets`)
}

export { ASSETS }

if (import.meta.url === `file://${process.argv[1]}`) {
  await main()
}
