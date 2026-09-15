import Link from 'next/link'
import { Arrow, Mark } from '@/components/Icons'

export default function NotFound() {
  return (
    <main className="on-dark lost">
      <div className="lost__in">
        <Mark size={52} tile="#39C26F" />
        <p className="lost__code">404</p>
        {/* Strategy Q3: humour lives in micro-copy, and a 404 is the one place
            on this site where it costs nothing. */}
        <h1>This one got mowed over.</h1>
        <p>The page you were after isn&rsquo;t here. The waitlist still is.</p>
        <Link className="btn btn--lg" href="/">
          Back to the front
          <Arrow />
        </Link>
      </div>
    </main>
  )
}
