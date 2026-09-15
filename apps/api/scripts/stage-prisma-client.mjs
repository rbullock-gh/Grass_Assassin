/**
 * Copies the generated Prisma client into a pruned production tree.
 *
 * `pnpm deploy --prod` produces a flat node_modules with @prisma/client in it,
 * but NOT the generated client — that lives in a `.prisma/client` folder beside
 * whichever copy of @prisma/client the generator ran against, which under pnpm
 * is a path containing the resolved version and its peer hashes. Regenerating
 * inside the pruned tree is not an option either: the Prisma CLI is a dev
 * dependency and has been pruned away with everything else.
 *
 * So: resolve where it really is, and put it where the runtime will look.
 *
 *   node scripts/stage-prisma-client.mjs <destination-node_modules>
 */
import { cp, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)

const destination = process.argv[2]
if (!destination) {
  console.error('Usage: node scripts/stage-prisma-client.mjs <destination-node_modules>')
  process.exit(1)
}

// .prisma/client sits beside @prisma/client in the same node_modules, whatever
// the surrounding path happens to be called.
const manifest = require.resolve('@prisma/client/package.json')
const nodeModules = path.resolve(path.dirname(manifest), '..', '..')
const source = path.join(nodeModules, '.prisma', 'client')

if (!existsSync(source)) {
  console.error(
    `No generated client at ${source}. Run \`prisma generate\` before staging it — ` +
    'the runtime cannot generate it for itself.',
  )
  process.exit(1)
}

const target = path.join(destination, '.prisma', 'client')
await mkdir(path.dirname(target), { recursive: true })
await cp(source, target, { recursive: true, dereference: true })
console.log(`staged the generated Prisma client -> ${target}`)
