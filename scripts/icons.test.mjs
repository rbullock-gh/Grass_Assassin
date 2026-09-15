import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { launchChromium } from './lib/browser.mjs'
import { ASSETS, BRAND } from './make-icons.mjs'

/**
 * The app's artwork, checked against what the stores actually require.
 *
 * These are the rules that reject a build or, worse, do not reject it and
 * produce something wrong-looking on a phone:
 *
 *  - iOS refuses a 1024 icon that has an alpha channel, at upload, long after
 *    you thought you were finished.
 *  - Android crops the adaptive foreground to whatever shape the launcher
 *    prefers. Only the middle 66% is guaranteed, so anything outside it is a
 *    coin flip per device.
 *  - Android draws a notification icon as a silhouette: every non-transparent
 *    pixel becomes the accent colour. A full-colour icon there is a solid blob.
 *
 * None of that is visible by looking at the files on a laptop, which is why it
 * is asserted rather than eyeballed.
 */

const DIR = path.join(process.cwd(), 'apps/mobile/assets')

let browser
beforeAll(async () => { browser = await launchChromium() }, 60_000)
afterAll(async () => { await browser?.close() })

/** Reads real pixels, by decoding the PNG in a browser rather than by hand. */
async function pixels(file) {
  const page = await browser.newPage()
  try {
    const dataUri = `data:image/png;base64,${fs.readFileSync(path.join(DIR, file)).toString('base64')}`
    return await page.evaluate(async (uri) => {
      const image = new Image()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = () => reject(new Error('not a decodable PNG'))
        image.src = uri
      })
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, image.width, image.height)

      let transparent = 0
      let opaque = 0
      let colouredOpaque = 0
      let outsideSafeCircle = 0
      const centre = image.width / 2
      // The 66% safe zone Android guarantees, as a radius.
      const safeRadius = image.width * 0.66 / 2

      for (let i = 0; i < data.length; i += 4) {
        const alpha = data[i + 3]
        if (alpha < 8) { transparent++; continue }
        opaque++

        const [r, g, b] = [data[i], data[i + 1], data[i + 2]]
        // "Coloured" = not near-white and not near-black.
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        if (max - min > 12) colouredOpaque++

        const pixel = i / 4
        const x = pixel % image.width
        const y = Math.floor(pixel / image.width)
        if (Math.hypot(x - centre, y - centre) > safeRadius) outsideSafeCircle++
      }

      return {
        width: image.width, height: image.height,
        transparent, opaque, colouredOpaque, outsideSafeCircle,
        total: data.length / 4,
      }
    }, dataUri)
  } finally {
    await page.close()
  }
}

describe('every asset exists and is a real PNG', () => {
  for (const asset of ASSETS) {
    it(`${asset.file} is ${asset.size}×${asset.size}`, async () => {
      const file = path.join(DIR, asset.file)
      expect(fs.existsSync(file), `${asset.file} is missing — run node scripts/make-icons.mjs`)
        .toBe(true)

      // PNG magic number, so a renamed JPEG or an HTML error page fails here
      // rather than at the far end of a 20-minute build.
      const head = fs.readFileSync(file).subarray(0, 8)
      expect([...head]).toEqual([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

      const info = await pixels(asset.file)
      expect(info.width).toBe(asset.size)
      expect(info.height).toBe(asset.size)
    }, 60_000)
  }
})

describe('what each platform demands', () => {
  it('the iOS icon has no transparency at all, which is an upload rule', async () => {
    const info = await pixels('icon.png')
    expect(info.transparent).toBe(0)
  }, 60_000)

  it('the favicon is opaque too, so it does not vanish on a dark tab bar', async () => {
    expect((await pixels('favicon.png')).transparent).toBe(0)
  }, 60_000)

  it('the Android foreground is transparent, because the background is a layer', async () => {
    const info = await pixels('adaptive-icon.png')
    expect(info.transparent).toBeGreaterThan(info.total * 0.5)
  }, 60_000)

  it('the Android foreground keeps every mark inside the 66% safe circle', async () => {
    // Outside that circle is a coin flip per launcher. Nothing may be there.
    expect((await pixels('adaptive-icon.png')).outsideSafeCircle).toBe(0)
  }, 60_000)

  it('the notification icon is a white silhouette, not artwork', async () => {
    // Android recolours every opaque pixel. Colour here becomes a blob.
    const info = await pixels('notification-icon.png')
    expect(info.opaque).toBeGreaterThan(0)
    expect(info.colouredOpaque).toBe(0)
  }, 60_000)

  it('the splash is transparent, so it sits on the colour app.json names', async () => {
    const info = await pixels('splash.png')
    expect(info.transparent).toBeGreaterThan(info.total * 0.5)
  }, 60_000)
})

describe('app.json actually points at them', () => {
  const config = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'apps/mobile/app.json'), 'utf8'),
  ).expo

  it('names an icon, a splash image and an Android foreground', () => {
    // Every one of these was absent, and a build does not warn — it either
    // refuses or ships Expo's placeholder, which looks deliberate.
    expect(config.icon).toBe('./assets/icon.png')
    expect(config.splash?.image).toBe('./assets/splash.png')
    expect(config.android?.adaptiveIcon?.foregroundImage).toBe('./assets/adaptive-icon.png')
    expect(config.web?.favicon).toBe('./assets/favicon.png')
  })

  it('gives expo-notifications its own icon', () => {
    const plugin = config.plugins.find(
      (p) => Array.isArray(p) && p[0] === 'expo-notifications',
    )
    expect(plugin?.[1]?.icon).toBe('./assets/notification-icon.png')
  })

  it('every path it names is a file that is really there', () => {
    for (const relative of [
      config.icon,
      config.splash.image,
      config.android.adaptiveIcon.foregroundImage,
      config.web.favicon,
    ]) {
      const file = path.join(process.cwd(), 'apps/mobile', relative)
      expect(fs.existsSync(file), `app.json names ${relative}, which does not exist`).toBe(true)
    }
  })

  it('uses the brand colours the design tokens define', () => {
    // Restated in the generator because it is a plain script; tied here so the
    // two cannot drift into an icon that is a different green from the app.
    const tokens = fs.readFileSync(
      path.join(process.cwd(), 'packages/design/src/tokens.ts'), 'utf8',
    )
    expect(tokens).toContain(BRAND.deep)
    expect(tokens).toContain(BRAND.mid)
    expect(config.splash.backgroundColor).toBe(BRAND.deep)
    expect(config.android.adaptiveIcon.backgroundColor).toBe(BRAND.deep)
  })
})
