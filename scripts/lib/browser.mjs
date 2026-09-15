import { existsSync } from 'node:fs'
import { chromium } from 'playwright'

/**
 * Launches Chromium wherever it happens to live.
 *
 * The development container ships a browser at a fixed path and tells Playwright
 * not to download its own. A CI runner does the opposite: `playwright install`
 * puts it somewhere Playwright knows about and that fixed path does not exist.
 * Hard-coding either one makes these suites run in exactly one place, which for
 * a check that only earns its keep by running on every change is no use at all.
 *
 * So: use the pinned path when it is really there, otherwise let Playwright
 * find its own.
 */
const PINNED = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium'

export function launchChromium(options = {}) {
  const executablePath = existsSync(PINNED) ? PINNED : undefined
  return chromium.launch({ ...options, ...(executablePath ? { executablePath } : {}) })
}
