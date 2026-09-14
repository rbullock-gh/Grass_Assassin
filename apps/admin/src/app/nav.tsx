'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const SECTIONS = [
  {
    label: 'Overview',
    items: [{ href: '/', text: 'Dashboard' }],
  },
  {
    label: 'Marketplace',
    items: [
      { href: '/jobs', text: 'Jobs' },
      { href: '/workers', text: 'Workers' },
    ],
  },
  {
    label: 'Trust & safety',
    items: [
      { href: '/disputes', text: 'Disputes' },
      { href: '/reports', text: 'Reports' },
    ],
  },
  {
    label: 'Money',
    items: [
      { href: '/payments', text: 'Ledger' },
      { href: '/config', text: 'Fees & config' },
    ],
  },
]

export function Nav() {
  const pathname = usePathname()
  return (
    <nav className="nav">
      {SECTIONS.map((section) => (
        <div key={section.label}>
          <div className="nav-label">{section.label}</div>
          {section.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
            >
              {item.text}
            </Link>
          ))}
        </div>
      ))}
    </nav>
  )
}
