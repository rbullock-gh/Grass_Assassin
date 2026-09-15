/**
 * Inline SVG. No icon dependency for eight shapes, and inline means they inherit
 * currentColor and cost no extra request on a page whose whole job is loading
 * fast enough that an ad click does not bounce.
 */

/**
 * The GrassAssassin mark: blades rising on a baseline.
 *
 * Copied from apps/admin/src/app/icon.svg rather than redrawn, so the tab icon
 * on the marketing site and the one on the dashboard are the same shape. The
 * tile colour is a prop because the mark sits on the dark hero here and on
 * white elsewhere.
 */
export function Mark({ size = 32, tile = '#0C682F' }: { size?: number; tile?: string }) {
  return (
    <svg
      className="brand__mark"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="32" height="32" rx="8" fill={tile} />
      <g stroke="#fff" strokeWidth="2.6" strokeLinecap="round" fill="none">
        <path d="M6 25h20" />
        <path d="M10 25v-6" />
        <path d="M15 25v-10" />
        <path d="M20 25v-7" />
        <path d="M25 25v-12" />
      </g>
    </svg>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

type IconProps = { className?: string }

export const Check = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} strokeWidth={2.4} d="M20 6 9 17l-5-5" />
  </svg>
)

export const Arrow = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} strokeWidth={2.2} d="M5 12h14m-6-7 7 7-7 7" />
  </svg>
)

export const Pin = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle {...stroke} cx="12" cy="10" r="3" />
  </svg>
)

export const Map = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} d="m9 4-6 3v13l6-3 6 3 6-3V4l-6 3Z" />
    <path {...stroke} d="M9 4v13m6-10v13" />
  </svg>
)

export const Camera = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <circle {...stroke} cx="12" cy="13" r="3.5" />
  </svg>
)

export const Wallet = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2" />
    <path {...stroke} d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2H5" />
    <circle {...stroke} cx="16.5" cy="13" r="1.2" />
  </svg>
)

export const Route = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle {...stroke} cx="6" cy="19" r="2.5" />
    <circle {...stroke} cx="18" cy="5" r="2.5" />
    <path {...stroke} d="M15.5 5H9a3 3 0 0 0 0 6h6a3 3 0 0 1 0 6H8.5" />
  </svg>
)

export const PhoneOff = (p: IconProps) => (
  <svg {...p} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path {...stroke} d="M9.6 4.5A1.7 1.7 0 0 0 8 3.4H5.3A2.3 2.3 0 0 0 3 5.9C3 13.7 10.3 21 18.1 21a2.3 2.3 0 0 0 2.5-2.3V16a1.7 1.7 0 0 0-1.1-1.6l-2.6-.9a1.7 1.7 0 0 0-1.8.5l-1 1.2" />
    <path {...stroke} d="m3 3 18 18" />
  </svg>
)
