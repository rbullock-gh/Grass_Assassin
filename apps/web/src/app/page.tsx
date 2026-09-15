import { AUDIENCES, FAQ, fees, ranks } from '@/content'
import { WaitlistForm } from '@/components/WaitlistForm'
import { Arrow, Camera, Check, Map, Mark, PhoneOff, Pin, Route, Wallet } from '@/components/Icons'

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://grassassassin.com'

/**
 * FAQPage markup generated from the same array the page renders, so every
 * answer in the structured data is guaranteed to be visible on the page —
 * which is Google's actual requirement, and the thing that silently breaks
 * when the two are maintained separately.
 */
const structuredData = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'Organization',
      '@id': `${SITE}/#org`,
      name: 'GrassAssassin',
      url: `${SITE}/`,
      description: 'A location-based marketplace for yard work.',
    },
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#site`,
      url: `${SITE}/`,
      name: 'GrassAssassin',
      publisher: { '@id': `${SITE}/#org` },
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}/#faq`,
      mainEntity: FAQ.map((entry) => ({
        '@type': 'Question',
        name: entry.q,
        acceptedAnswer: { '@type': 'Answer', text: entry.a },
      })),
    },
  ],
}

export default function Home() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />

      <a className="skip" href="#main">Skip to content</a>

      <header className="head on-dark">
        <div className="shell head__in">
          <a className="brand" href="#top">
            <Mark size={30} tile="#39C26F" />
            <span>GrassAssassin</span>
          </a>
          <nav className="nav" aria-label="Main">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#status">Where it stands</a>
            <a href="#faq">Questions</a>
          </nav>
          <a className="btn btn--sm head__cta" href="#top">Join the waitlist</a>
        </div>
      </header>

      <main id="main">
        {/* ============================================================ hero */}
        <section className="hero on-dark" id="top">
          <div className="shell hero__in">
            <div>
              <p className="eyebrow">
                <span className="dot" aria-hidden="true" />
                Built — picking the first market
              </p>
              <h1 className="hero__h">Booking a mow shouldn&rsquo;t take three phone calls.</h1>
              <p className="hero__sub">
                GrassAssassin is a marketplace for yard work. A homeowner posts a job at their
                property, nearby approved workers see it on a map and claim it, and nobody gets
                paid until the work is approved.
              </p>

              {/*
                Real radio inputs driving real CSS, so the switch works with
                JavaScript off and adds no client bundle. Panels are swapped by
                :has(); where :has() is unsupported both panels stay on the
                page and nothing is lost but the filtering.
              */}
              <fieldset className="switch" id="audience">
                <legend className="switch__lead">I&rsquo;m here because&hellip;</legend>
                <div className="switch__track">
                  <input
                    type="radio"
                    name="audience-view"
                    id={AUDIENCES.home.id}
                    className="switch__input"
                    defaultChecked
                  />
                  <label className="switch__opt" htmlFor={AUDIENCES.home.id}>
                    {AUDIENCES.home.label}
                  </label>
                  <input
                    type="radio"
                    name="audience-view"
                    id={AUDIENCES.pro.id}
                    className="switch__input"
                  />
                  <label className="switch__opt" htmlFor={AUDIENCES.pro.id}>
                    {AUDIENCES.pro.label}
                  </label>
                </div>
              </fieldset>

              {(['home', 'pro'] as const).map((key) => (
                <div className={`panel panel--${key}`} key={key}>
                  <p className="hero__pitch">{AUDIENCES[key].pitch}</p>
                  <ul className="ticks">
                    {AUDIENCES[key].ticks.map((tick) => (
                      <li key={tick}>
                        <Check />
                        <span>{tick}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>

            {/* The form sits in the hero on purpose: a waitlist page that makes
                you scroll to sign up loses the people who were already sold. */}
            <div>
              <div className="panel panel--home">
                <WaitlistForm
                  audience="Homeowner"
                  idPrefix="home"
                  heading={AUDIENCES.home.formHeading}
                  intro={AUDIENCES.home.formIntro}
                  fine={AUDIENCES.home.fine}
                />
              </div>
              <div className="panel panel--pro">
                <WaitlistForm
                  audience="Worker"
                  idPrefix="pro"
                  heading={AUDIENCES.pro.formHeading}
                  intro={AUDIENCES.pro.formIntro}
                  fine={AUDIENCES.pro.fine}
                />
              </div>
            </div>
          </div>
        </section>

        {/* ========================================================= problem */}
        <section className="sec" id="problem">
          <div className="shell">
            <h2 className="sec__h">Both sides of this are broken</h2>
            <p className="sec__lead">
              Nobody set out to make hiring someone to cut grass complicated. It just never
              got fixed.
            </p>
            <div className="split">
              <article className="card">
                <h3 className="card__h"><PhoneOff />If you have a lawn</h3>
                <ul className="card__list">
                  <li>You found someone in a Facebook group. They came twice, then stopped answering.</li>
                  <li>Nobody will quote without seeing it, and seeing it takes a week.</li>
                  <li>You have no idea whether $40 is a fair price or a fleecing.</li>
                  <li>&ldquo;I&rsquo;ll swing by Saturday&rdquo; is not a time.</li>
                </ul>
              </article>
              <article className="card">
                <h3 className="card__h"><Route />If you cut grass</h3>
                <ul className="card__list">
                  <li>Half the day goes on quoting jobs that were never going to book.</li>
                  <li>You drive across town for one yard because that is where the call came from.</li>
                  <li>Chasing $60 by text, three weeks later, is its own part-time job.</li>
                  <li>The work is seasonal and lumpy, and the phone does not ring evenly.</li>
                </ul>
              </article>
            </div>
          </div>
        </section>

        {/* ============================================================= how */}
        <section className="sec sec--dark on-dark" id="how">
          <div className="shell">
            <h2 className="sec__h">How it works</h2>
            <p className="sec__lead">Three steps on each side. That is the whole product.</p>

            <div className="panel panel--home">
              <ol className="steps">
                <li className="step">
                  <span className="step__n">1</span>
                  <h3 className="step__h"><Pin />Post the job</h3>
                  <p>Pick the property, say what needs doing, and set what you&rsquo;ll pay. From {fees.minJob} up.</p>
                </li>
                <li className="step">
                  <span className="step__n">2</span>
                  <h3 className="step__h"><Map />A nearby worker claims it</h3>
                  <p>Approved workers in range see it on their map. The first to claim it gets it — no auction, no waiting.</p>
                </li>
                <li className="step">
                  <span className="step__n">3</span>
                  <h3 className="step__h"><Camera />Approve, then pay</h3>
                  <p>Before-and-after photos land in the app. Money moves when you approve the work, not before.</p>
                </li>
              </ol>
            </div>

            <div className="panel panel--pro">
              <ol className="steps">
                <li className="step">
                  <span className="step__n">1</span>
                  <h3 className="step__h"><Route />Set your patch</h3>
                  <p>How far you&rsquo;ll drive and what work you take. Jobs outside it never bother you.</p>
                </li>
                <li className="step">
                  <span className="step__n">2</span>
                  <h3 className="step__h"><Map />Claim what fits</h3>
                  <p>Jobs appear on your map already priced and already scoped. Take the ones on your route; declining costs you nothing, ever.</p>
                </li>
                <li className="step">
                  <span className="step__n">3</span>
                  <h3 className="step__h"><Wallet />Get paid without asking</h3>
                  <p>Photos in, customer approves, money moves. No invoice and no three-week wait.</p>
                </li>
              </ol>
            </div>
          </div>
        </section>

        {/* ========================================================= pricing */}
        <section className="sec sec--sunken" id="pricing">
          <div className="shell">
            <h2 className="sec__h">What it costs</h2>
            <p className="sec__lead">
              Published up front, because a marketplace that hides its take rate is telling you
              something about the take rate.
            </p>

            <div className="panel panel--home">
              <div className="rates">
                <div className="rate">
                  <p className="rate__n tnum">{fees.serviceFee}</p>
                  <p className="rate__label">Service fee</p>
                  <p className="rate__note">
                    Added to the job price you set, with a {fees.serviceFeeFloor} minimum.
                  </p>
                </div>
                <div className="rate">
                  <p className="rate__n tnum">$0</p>
                  <p className="rate__label">To post a job</p>
                  <p className="rate__note">Posting, browsing and cancelling before a claim are free.</p>
                </div>
                <div className="rate">
                  <p className="rate__n tnum">$0</p>
                  <p className="rate__label">Until you approve</p>
                  <p className="rate__note">Nothing is charged until you have seen the work and accepted it.</p>
                </div>
              </div>
              <p className="rates__foot">
                You set the job price yourself, from {fees.minJob} up. Workers see it before they
                claim, so nobody turns up to give you a number.
              </p>
            </div>

            <div className="panel panel--pro">
              <div className="rates">
                <div className="rate">
                  <p className="rate__n tnum">{fees.workerKeeps}</p>
                  <p className="rate__label">You keep</p>
                  <p className="rate__note">
                    Commission is {fees.workerCommission}, falling to {fees.workerBestCommission} as
                    you rank up.
                  </p>
                </div>
                <div className="rate">
                  <p className="rate__n tnum">100%</p>
                  <p className="rate__label">Of every tip</p>
                  <p className="rate__note">The platform takes nothing from tips. Not now, not later.</p>
                </div>
                <div className="rate">
                  <p className="rate__n tnum">$0</p>
                  <p className="rate__label">To decline a job</p>
                  <p className="rate__note">Turning work down never costs points, rank or standing.</p>
                </div>
              </div>

              <div className="ladder-wrap">
                <table className="ladder">
                  <caption>Commission falls as you rank up. Rank is earned on quality, never bought.</caption>
                  <thead>
                    <tr><th scope="col">Rank</th><th scope="col">Points</th><th scope="col">Commission</th></tr>
                  </thead>
                  <tbody>
                    {ranks.map((rank) => (
                      <tr key={rank.name}>
                        <th scope="row">{rank.name}</th>
                        <td className="tnum">{rank.points}</td>
                        <td className={`tnum${rank.discounted ? ' ladder__cut' : ''}`}>
                          {rank.commission}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </section>

        {/* ========================================================== status */}
        <section className="sec" id="status">
          <div className="shell">
            <h2 className="sec__h">Where this actually stands</h2>
            <p className="sec__lead">
              Most pre-launch pages imply more than exists. Here is the straight version, so you
              know exactly what you are signing up to.
            </p>
            <div className="status">
              <article className="status__col status__col--done">
                <h3 className="status__h">Built</h3>
                <ul>
                  <li>The marketplace itself: post, search, claim, message, photo gates, approve, pay, rate.</li>
                  <li>The app, for both customers and workers.</li>
                  <li>Payments, points and ranks, disputes, and recurring jobs.</li>
                </ul>
              </article>
              <article className="status__col status__col--soon">
                <h3 className="status__h">Not yet</h3>
                <ul>
                  <li>App store review. You cannot download it today.</li>
                  <li>A single market open to the public.</li>
                  <li>The first workers approved and on the map.</li>
                </ul>
              </article>
              <article className="status__col status__col--open">
                <h3 className="status__h">Undecided</h3>
                <ul>
                  <li>Launch date.</li>
                  <li>Which market goes first — <strong>that is what the waitlist decides.</strong></li>
                </ul>
              </article>
            </div>
            <p className="status__note">
              There is no app to download yet, and nothing on this page is a live service.
            </p>
          </div>
        </section>

        {/* ============================================================= faq */}
        <section className="sec sec--sunken" id="faq">
          <div className="shell shell--narrow">
            <h2 className="sec__h">Questions worth asking</h2>
            <div className="faq">
              {FAQ.map((entry) => (
                <details key={entry.q}>
                  <summary>{entry.q}</summary>
                  <p>{entry.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="foot on-dark">
        <div className="shell foot__in">
          <a className="brand" href="#top">
            <Mark size={26} tile="#39C26F" />
            <span>GrassAssassin</span>
          </a>
          <p>A marketplace for yard work. Not yet open in any market.</p>
          <p className="foot__legal">&copy; {new Date().getFullYear()} GrassAssassin.</p>
          <a className="btn btn--sm" href="#top">Join the waitlist<Arrow /></a>
        </div>
      </footer>
    </>
  )
}
