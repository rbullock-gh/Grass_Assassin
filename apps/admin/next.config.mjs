/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // Traces the files actually needed and writes a self-contained server, so the
  // image does not have to carry the monorepo or a full node_modules.
  output: 'standalone',
  // Standalone tracing starts from this directory; without it Next guesses the
  // app folder and leaves the workspace's hoisted dependencies behind.
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,

  // The admin reads the marketplace database directly for its own pages rather
  // than going through the public API, which would mean exposing admin-only
  // read endpoints on a public surface. Writes that move money go the other
  // way — through the API, which is the only process holding the payment
  // provider's credentials. See src/app/(dashboard)/disputes/actions.ts.
  serverExternalPackages: ['@prisma/client'],

  // The shared package ships TypeScript source, not a build, so webpack has to
  // compile it rather than treat it as a dependency.
  transpilePackages: ['@grassassassin/shared'],

  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  webpack: (config) => {
    /**
     * Map NodeNext's ".js" specifiers to the ".ts" files they actually mean.
     *
     * The shared package is ESM TypeScript, where `export * from './pricing.js'`
     * is the correct and required way to refer to pricing.ts. tsc, tsx and
     * vitest all understand that; webpack looks for a literal pricing.js, does
     * not find one, and the whole page 500s.
     *
     * The same mismatch broke the mobile bundle, where Metro needed the
     * equivalent fix — one property of how the monorepo is written, surfacing
     * once per bundler.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}
