import type { Metadata, Viewport } from 'next'
import './globals.css'

/**
 * Link previews need an absolute, publicly fetchable URL — a relative og:image
 * is silently dropped by every scraper. Overridable so a staging deploy does
 * not advertise production's URLs.
 */
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://grassassassin.com'

const DESCRIPTION =
  'Post a yard job at your property and a nearby approved worker claims it on a map. '
  + 'The app is built — join the waitlist and help decide which market opens first.'

export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: 'GrassAssassin — yard work, booked without the phone tag',
  description: DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    siteName: 'GrassAssassin',
    title: 'GrassAssassin — yard work, booked without the phone tag',
    description: DESCRIPTION,
    url: SITE,
    images: [{ url: '/og-image.png', width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GrassAssassin — yard work, booked without the phone tag',
    description: DESCRIPTION,
    images: ['/og-image.png'],
  },
  icons: { icon: '/icon.svg', apple: '/apple-touch-icon.png' },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Both, so the browser paints its own chrome to match whichever the visitor
  // is in. A single value makes the address bar fight the page in one theme.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#F4F7F5' },
    { media: '(prefers-color-scheme: dark)', color: '#0B1410' },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Loaded as a plain stylesheet rather than next/font so the build never
            depends on reaching Google. If it fails the stack in --ga-font falls
            back to the platform UI face, which is a cosmetic loss, not a
            broken build in CI. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  )
}
