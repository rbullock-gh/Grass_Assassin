/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,

  // The marketing site is a static bundle: no database, no sessions, no server
  // rendering at request time. `export` lets it sit on any CDN or object store,
  // which is the cheapest and most reliable thing to put in front of an ad
  // spend — a marketing page that 500s costs money per click.
  output: 'export',

  // Static export cannot run the image optimiser, which needs a server.
  images: { unoptimized: true },

  // Trailing slashes keep `out/` directory-per-route, so a plain static host
  // serves /waitlist as /waitlist/index.html without rewrite rules.
  trailingSlash: true,

  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },

  // The shared package ships TypeScript source, not a build, so webpack has to
  // compile it rather than treat it as a dependency.
  transpilePackages: ['@grassassassin/shared', '@grassassassin/design'],

  webpack: (config) => {
    /**
     * Map NodeNext's ".js" specifiers to the ".ts" files they actually mean.
     *
     * Same fix as apps/admin: the shared package is ESM TypeScript, where
     * `export * from './pricing.js'` is the correct way to refer to pricing.ts.
     * webpack looks for a literal pricing.js, does not find one, and the build
     * fails. One property of how the monorepo is written, surfacing once per
     * bundler.
     */
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    }
    return config
  },
}
