/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The admin reads the marketplace database directly rather than going through
  // the public API. It is a staff tool on a trusted network, and going through
  // the API would mean exposing admin-only endpoints on a public surface.
  serverExternalPackages: ['@prisma/client'],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
}
