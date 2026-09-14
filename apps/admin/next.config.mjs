/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // The admin reads the marketplace database directly rather than going through
  // the public API. It is a staff tool on a trusted network, and going through
  // the API would mean exposing admin-only endpoints on a public surface.
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
