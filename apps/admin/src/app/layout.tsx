import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GrassAssassin Admin',
  description: 'Marketplace operations',
}

/**
 * Deliberately bare: html, body, stylesheet, nothing else.
 *
 * The sidebar used to live here, which meant the sign-in page rendered the
 * whole admin navigation to people who had not signed in — every section name
 * we have, handed over before the password. The shell now belongs to the
 * (dashboard) group, which only renders behind the gate.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
