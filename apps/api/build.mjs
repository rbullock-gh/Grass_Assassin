/**
 * Production build for the API.
 *
 * `tsc` alone produced a dist that could not start. The workspace packages ship
 * TypeScript source — @grassassassin/shared's entry point is literally
 * src/index.ts — so the emitted JavaScript imported files Node cannot load and
 * `node dist/server.js` died on its first import. The build passed, the
 * typecheck passed, and nobody had ever run the start script.
 *
 * Bundling fixes it at the root: the workspace packages are inlined, so no
 * cross-package resolution is left to get wrong at runtime and the image needs
 * neither the monorepo layout nor a second package's build output.
 *
 * Real dependencies stay external and are installed normally in the image.
 * Bundling them would be slower to build, harder to patch for a CVE, and in the
 * case of anything native or anything that loads files by path at runtime —
 * argon2, the Prisma engines — simply broken.
 */
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))

// Everything installed from a registry stays out; the workspace packages, which
// are the whole reason this bundles at all, go in.
const external = [
  ...Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@grassassassin/')),
  // Prisma loads its generated client and engine binaries by path.
  '.prisma/client', '.prisma/client/default', 'prisma',
  // An optional native driver nothing here installs, which pg probes for.
  'pg-native',
]

const result = await build({
  /**
   * The server, plus the operational tasks that have to be runnable in a
   * container.
   *
   * Creating the first administrator was a `tsx` script, which means it could
   * only ever be run from a checkout — so the production story for "how do you
   * get into the dashboard at all" was "have the source tree handy". Bundled,
   * it is just another command the image can run.
   */
  entryPoints: {
    server: 'src/server.ts',
    'admin-create': 'prisma/create-admin.ts',
  },
  outdir: 'dist',
  platform: 'node',
  target: 'node22',
  format: 'esm',
  bundle: true,
  sourcemap: true,
  // Readable stack traces in production logs are worth more than the bytes
  // minifying a server bundle would save.
  minify: false,
  external,
  banner: {
    // Some dependencies still reach for CommonJS globals from inside an ESM
    // bundle; without these they throw on import.
    js: [
      "import { createRequire as __createRequire } from 'node:module'",
      "import { fileURLToPath as __fileURLToPath } from 'node:url'",
      "import { dirname as __dirname_of } from 'node:path'",
      'const require = __createRequire(import.meta.url)',
      'const __filename = __fileURLToPath(import.meta.url)',
      'const __dirname = __dirname_of(__filename)',
    ].join('\n'),
  },
  metafile: true,
  // Distinguishes the two entry points' chunks from each other.
  splitting: false,
  logLevel: 'warning',
})

for (const [file, output] of Object.entries(result.metafile.outputs)) {
  if (file.endsWith('.map')) continue
  console.log(`built ${file} — ${(output.bytes / 1024).toFixed(0)} KiB`)
}
