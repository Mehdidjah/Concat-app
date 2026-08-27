import Section from '../components/Section'
import screenshotLight from '../assets/screenshot-light.png'
import screenshotDark from '../assets/screenshot-dark.png'

const features = [
  {
    title: 'A real multi-track timeline.',
    body: 'Cut, trim, split, and arrange video, audio, and text across tracks. The editing you already know, without the ceiling you already hit.',
    image: screenshotLight,
    alt: 'The WolfCut timeline in the light theme',
  },
  {
    title: 'No watermarks. Ever.',
    body: 'Your exports are yours, at full quality, on the free plan — because there is no other plan. No stamp in the corner, no export limit, no upsell.',
    image: screenshotDark,
    alt: 'The WolfCut editor in the dark theme',
  },
]

const details = [
  {
    title: 'Native performance',
    body: 'A Rust engine does the heavy lifting — not a browser pretending to.',
  },
  {
    title: 'Lightweight',
    body: 'A few megabytes on disk. Opens in a blink.',
  },
  {
    title: 'No account, no setup',
    body: 'No sign-up, no cloud, no extra downloads. It all runs on your machine.',
  },
  {
    title: 'macOS & Windows',
    body: 'One editor, both platforms. Linux is on the way.',
  },
]

export default function Features() {
  return (
    <Section id="features" alt>
      <div className="text-center">
        <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Everything essential. Nothing extra.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-ink-secondary">
          The tools you actually use, unlocked from day one.
        </p>
      </div>
      <div className="mt-16 grid gap-16 sm:grid-cols-2 sm:gap-12">
        {features.map((feature) => (
          <div key={feature.title}>
            <img
              src={feature.image}
              alt={feature.alt}
              className="w-full rounded-2xl border border-hairline/60"
            />
            <h3 className="mt-6 text-xl font-semibold tracking-tight">
              {feature.title}
            </h3>
            <p className="mt-2 text-ink-secondary">{feature.body}</p>
          </div>
        ))}
      </div>
      <div className="mt-16 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
        {details.map((detail) => (
          <div key={detail.title}>
            <h3 className="text-sm font-semibold">{detail.title}</h3>
            <p className="mt-1.5 text-sm text-ink-secondary">{detail.body}</p>
          </div>
        ))}
      </div>
    </Section>
  )
}
