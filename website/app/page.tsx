import Image from 'next/image';
import { AnimatedSectionHeading } from '@/components/landing/animated-section-heading';
import { EditorialReveal } from '@/components/landing/editorial-reveal';
import { FaqSection } from '@/components/landing/faq-section';
import { FeatureTimelineArtwork } from '@/components/landing/feature-timeline-artwork';
import { HeroScrollMotion } from '@/components/landing/hero-scroll-motion';
import { LandingHeader } from '@/components/landing/landing-header';
import { Reveal } from '@/components/landing/reveal';
import { SiteFooter } from '@/components/landing/site-footer';
import { StickerWall } from '@/components/landing/sticker-wall';

const releasesUrl = 'https://github.com/Mehdidjah/wolfcut-App/releases';
const repositoryUrl = 'https://github.com/Mehdidjah/wolfcut-App';

const principles = [
  {
    label: 'Free',
    value: '$0',
    subtext: 'Free to download',
    items: ['No subscription', 'No watermark', 'Desktop downloads'],
    cta: 'Download Wolf-Cut',
    href: releasesUrl,
    featured: false,
  },
  {
    label: 'Open source',
    value: 'OPEN',
    subtext: 'Source available',
    items: ['Public repository', 'Inspect the code', 'Build and contribute'],
    cta: 'View source',
    href: repositoryUrl,
    featured: true,
  },
  {
    label: 'Local',
    value: 'YOURS',
    subtext: 'Designed around your device',
    items: [
      'Local media workflow',
      'No required cloud upload',
      'Keep control of your files',
    ],
    cta: 'Explore features',
    href: '#features',
    featured: false,
  },
] as const;

function Arrow({ direction = 'down' }: { direction?: 'down' | 'out' }) {
  return (
    <span className="button-arrow" aria-hidden="true">
      {direction === 'out' ? '↗' : '↓'}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m4 10.5 3.7 3.7L16 5.9" />
    </svg>
  );
}

function PlatformArtwork() {
  return (
    <div className="platform-art" aria-hidden="true">
      <div className="platform-card platform-mac">
        <Image
          className="platform-logo platform-logo-apple"
          src="/platforms/apple-logo.svg"
          alt=""
          width={44}
          height={44}
        />
        <div>
          <strong>macOS</strong>
          <small>Desktop build</small>
        </div>
      </div>
      <div className="platform-card platform-win">
        <Image
          className="platform-logo platform-logo-windows"
          src="/platforms/windows-logo.svg"
          alt=""
          width={44}
          height={44}
        />
        <div>
          <strong>Windows</strong>
          <small>Desktop build</small>
        </div>
      </div>
      <div className="platform-card platform-linux">
        <Image
          className="platform-logo platform-logo-linux"
          src="/platforms/linux-logo.svg"
          alt=""
          width={44}
          height={44}
        />
        <div>
          <strong>Linux</strong>
          <small>Desktop build</small>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <LandingHeader />
      <main>
        <HeroScrollMotion />

        <section id="features" className="content-section feature-section">
          <div className="page-width">
            <AnimatedSectionHeading
              title="Everything you need to cut with control."
              copy="A focused desktop editor built around speed, privacy, and ownership."
            />

            <Reveal variant="scale" className="feature-grid-reveal">
              <div className="feature-grid">
                <div className="feature-card-wrap feature-wide">
                  <article className="feature-card feature-footage">
                    <div className="feature-copy">
                      <span className="feature-index">01</span>
                      <h3>Your footage stays yours.</h3>
                      <p>
                        Work locally without sending source media to the cloud.
                      </p>
                    </div>
                    <div className="feature-editor-crop" aria-hidden="true">
                      <Image
                        src="/editor-preview.webp"
                        alt=""
                        width={1920}
                        height={1175}
                        sizes="(max-width: 809px) 100vw, 760px"
                      />
                    </div>
                  </article>
                </div>

                <div className="feature-card-wrap feature-narrow">
                  <article className="feature-card feature-timeline">
                    <div className="feature-copy">
                      <span className="feature-index">02</span>
                      <h3>Cut without the clutter.</h3>
                      <p>
                        A focused editing surface for moving from footage to
                        final cut.
                      </p>
                    </div>
                    <FeatureTimelineArtwork />
                  </article>
                </div>

                <div className="feature-card-wrap feature-narrow">
                  <article className="feature-card feature-ownership">
                    <div className="feature-copy">
                      <span className="feature-index">03</span>
                      <h3>No subscriptions. No watermarks.</h3>
                      <p>Create without recurring fees or branded exports.</p>
                    </div>
                    <div className="ownership-art" aria-hidden="true">
                      <span className="ownership-value">$0</span>
                      <span className="ownership-chip">No watermark</span>
                      <span className="ownership-chip">Open source</span>
                    </div>
                  </article>
                </div>

                <div className="feature-card-wrap feature-wide">
                  <article className="feature-card feature-platforms">
                    <div className="feature-copy">
                      <span className="feature-index">04</span>
                      <h3>Built for your desktop.</h3>
                      <p>Download Wolf-Cut for macOS, Windows, and Linux.</p>
                    </div>
                    <PlatformArtwork />
                  </article>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        <section className="editorial-section" aria-label="Wolf-Cut philosophy">
          <div className="page-width editorial-inner">
            <EditorialReveal />
          </div>
        </section>

        <section id="principles" className="content-section principles-section">
          <div className="page-width">
            <AnimatedSectionHeading
              title="Simple by design."
              copy="No confusing plans, no cloud dependency, and no ownership trade-offs."
            />

            <Reveal threshold={0.1} className="principle-grid-reveal">
              <div className="principle-grid">
                {principles.map((principle) => (
                  <article
                    className="principle-card"
                    data-featured={principle.featured}
                    key={principle.label}
                  >
                    <div className="principle-card-top">
                      <span className="principle-label">{principle.label}</span>
                      {principle.featured ? (
                        <span className="featured-pill">Featured</span>
                      ) : null}
                    </div>
                    <strong className="principle-value">
                      {principle.value}
                    </strong>
                    <p>{principle.subtext}</p>
                    <ul>
                      {principle.items.map((item) => (
                        <li key={item}>
                          <CheckIcon />
                          <span>{item}</span>
                        </li>
                      ))}
                    </ul>
                    <a
                      className={`button ${principle.featured ? 'button-primary' : 'button-secondary'}`}
                      href={principle.href}
                      target={
                        principle.href === repositoryUrl ? '_blank' : undefined
                      }
                      rel={
                        principle.href === repositoryUrl
                          ? 'noopener noreferrer'
                          : undefined
                      }
                    >
                      <span>{principle.cta}</span>
                      <Arrow
                        direction={
                          principle.href === repositoryUrl ? 'out' : 'down'
                        }
                      />
                    </a>
                  </article>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        <section id="faq" className="content-section faq-section">
          <div className="page-width">
            <AnimatedSectionHeading
              title="Questions, cut short."
              copy="What to know before installing Wolf-Cut."
            />
            <Reveal threshold={0.2}>
              <FaqSection />
            </Reveal>
          </div>
        </section>

        <section id="download" className="download-section">
          <StickerWall />
          <Reveal className="download-copy" threshold={0.5}>
            <p>Ready when you are</p>
            <h2>Your videos. Your rules.</h2>
            <span>Download Wolf-Cut and make the cut on your own terms.</span>
            <a className="button button-primary" href={releasesUrl}>
              <span>Download Wolf-Cut</span>
              <Arrow />
            </a>
          </Reveal>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
