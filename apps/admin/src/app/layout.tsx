import type { Metadata } from 'next'
import './globals.css'
import { Nav } from './nav'

export const metadata: Metadata = {
  title: 'GrassAssassin Admin',
  description: 'Marketplace operations',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="sidebar">
            <div className="brand">
              <div className="brand-mark" aria-hidden>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M3 20h18" /><path d="M7 20v-5" /><path d="M11 20v-8" /><path d="M15 20v-6" /><path d="M19 20v-9" />
                </svg>
              </div>
              <div>
                <div className="brand-name">Grass<span>Assassin</span></div>
              </div>
            </div>
            <Nav />
            <div style={{ marginTop: 'auto', padding: '0 8px' }}>
              <span className="brand-env">Development</span>
            </div>
          </aside>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  )
}
