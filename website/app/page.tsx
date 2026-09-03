import Image from 'next/image';
import { EditorialReveal } from '@/components/landing/editorial-reveal';
import { FaqSection } from '@/components/landing/faq-section';
import { LandingHeader } from '@/components/landing/landing-header';
import { Reveal } from '@/components/landing/reveal';
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

function SectionHeading({
  eyebrow,
  title,
  copy,
}: {
  eyebrow: string;
  title: string;
  copy: string;
}) {
  return (
    <header className="section-heading">
      <p>{eyebrow}</p>
      <h2>{title}</h2>
      <span>{copy}</span>
    </header>
  );
}

function TimelineArtwork() {
  return (
    <div className="timeline-art" aria-hidden="true">
      <div className="timeline-ruler">
        <span>00:00</span>
        <span>00:08</span>
        <span>00:16</span>
      </div>
      <div className="timeline-track">
        <span className="clip clip-a" />
        <span className="clip clip-b" />
        <span className="clip clip-c" />
      </div>
      <div className="timeline-track timeline-track-audio">
        <span className="clip clip-wave">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <span className="timeline-playhead" />
    </div>
  );
}

function PlatformArtwork() {
  return (
    <div className="platform-art" aria-hidden="true">
      <div className="platform-card platform-mac">
        <span className="platform-mark">
          <span />
        </span>
        <div>
          <strong>macOS</strong>
          <small>Desktop build</small>
        </div>
      </div>
      <div className="platform-card platform-win">
        <span className="windows-mark">
          <i />
          <i />
          <i />
          <i />
        </span>
        <div>
          <strong>Windows</strong>
          <small>Desktop build</small>
        </div>
      </div>
      <div className="platform-card platform-linux">
        <span className="linux-mark">LNX</span>
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
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-atmosphere" aria-hidden="true" />
          <div className="hero-copy page-width">
            <p className="eyebrow hero-enter hero-enter-1">
              Free · Open source · Local
            </p>
            <h1 id="hero-title" className="hero-title hero-enter hero-enter-2">
              <span>Your videos.</span> <span>Your rules.</span>
            </h1>
            <p className="hero-description hero-enter hero-enter-3">
              A fast, private video editor without watermarks, subscriptions, or
              cloud uploads. Install Wolf-Cut and start creating.
            </p>
            <div className="hero-actions hero-enter hero-enter-4">
              <a className="button button-primary" href={releasesUrl}>
                <span>Download Wolf-Cut</span>
                <Arrow />
              </a>
              <a
                className="button button-secondary"
                href={repositoryUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span>View source</span>
                <Arrow direction="out" />
              </a>
            </div>
            <p className="platform-note hero-enter hero-enter-4">
              Downloads for macOS, Windows, and Linux
            </p>
          </div>

          <div className="product-shell hero-media page-width">
            <div className="product-window">
              <div className="window-bar" aria-hidden="true">
                <span className="window-dot" />
                <span className="window-dot" />
                <span className="window-dot" />
                <span className="window-title">
                  Wolf-Cut · Untitled project
                </span>
              </div>
              <Image
                src="/editor-preview.webp"
                alt="Wolf-Cut desktop editor with media browser, preview, inspector, and multi-track timeline"
                width={1920}
                height={1175}
                priority
                sizes="(max-width: 810px) 96vw, 960px"
              />
            </div>
          </div>
        </section>

        <section id="features" className="content-section feature-section">
          <div className="page-width">
            <Reveal>
              <SectionHeading
                eyebrow="Built for the edit"
                title="Everything you need to cut with control."
                copy="A focused desktop editor built around speed, privacy, and ownership."
              />
            </Reveal>

            <div className="feature-grid">
              <Reveal className="feature-card-wrap feature-wide" delay={30}>
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
              </Reveal>

              <Reveal className="feature-card-wrap feature-narrow" delay={90}>
                <article className="feature-card feature-timeline">
                  <div className="feature-copy">
                    <span className="feature-index">02</span>
                    <h3>Cut without the clutter.</h3>
                    <p>
                      A focused editing surface for moving from footage to final
                      cut.
                    </p>
                  </div>
                  <TimelineArtwork />
                </article>
              </Reveal>

              <Reveal className="feature-card-wrap feature-narrow" delay={30}>
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
              </Reveal>

              <Reveal className="feature-card-wrap feature-wide" delay={90}>
                <article className="feature-card feature-platforms">
                  <div className="feature-copy">
                    <span className="feature-index">04</span>
                    <h3>Built for your desktop.</h3>
                    <p>Download Wolf-Cut for macOS, Windows, and Linux.</p>
                  </div>
                  <PlatformArtwork />
                </article>
              </Reveal>
            </div>
          </div>
        </section>

        <section className="editorial-section" aria-label="Wolf-Cut philosophy">
          <div className="page-width editorial-inner">
            <EditorialReveal />
          </div>
        </section>

        <section id="principles" className="content-section principles-section">
          <div className="page-width">
            <Reveal>
              <SectionHeading
                eyebrow="No trade-offs"
                title="Simple by design."
                copy="No confusing plans, no cloud dependency, and no ownership trade-offs."
              />
            </Reveal>

            <div className="principle-grid">
              {principles.map((principle, index) => (
                <Reveal key={principle.label} delay={index * 70}>
                  <article
                    className="principle-card"
                    data-featured={principle.featured}
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
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section id="faq" className="content-section faq-section">
          <div className="page-width">
            <Reveal>
              <SectionHeading
                eyebrow="Before you install"
                title="Questions, cut short."
                copy="What to know before installing Wolf-Cut."
              />
            </Reveal>
            <Reveal delay={80}>
              <FaqSection />
            </Reveal>
          </div>
        </section>

        <section id="download" className="download-section">
          <StickerWall />
          <Reveal className="download-copy">
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

      <footer className="site-footer">
        <div className="footer-surface">
          <div className="footer-rays" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className="footer-content page-width">
            <div className="footer-brand">
              <Image src="/wolfcut-logo.png" alt="" width={52} height={52} />
              <h2>Wolf-Cut</h2>
              <p>Cut locally. Create freely.</p>
            </div>
            <div className="footer-links">
              <div>
                <h3>Product</h3>
                <a href="#features">Features</a>
                <a href="#principles">Principles</a>
                <a href="#download">Download</a>
              </div>
              <div>
                <h3>Project</h3>
                <a
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  GitHub
                </a>
                <a href={releasesUrl}>Releases</a>
                <a
                  href={repositoryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Source code
                </a>
              </div>
            </div>
          </div>
          <div className="footer-wordmark" aria-hidden="true">
            WOLF-CUT
          </div>
          <div className="footer-bottom page-width">
            <span>© 2026 Wolf-Cut</span>
            <span>Free · Open source · Local</span>
          </div>
        </div>
      </footer>
    </>
  );
}
