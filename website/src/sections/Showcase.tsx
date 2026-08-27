import Section from '../components/Section'
import screenshotDark from '../assets/screenshot-dark.png'

export default function Showcase() {
  return (
    <Section id="engine">
      <div className="grid items-center gap-12 sm:grid-cols-2">
        <div>
          <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            A Rust engine under the hood.
          </h2>
          <p className="mt-4 text-lg text-ink-secondary">
            Decoding, compositing, effects, and export all run in a native
            engine written in Rust — the interface just tells it what to do.
            That&rsquo;s why WolfCut stays a few megabytes, opens instantly,
            and scrubs smoothly where web-based editors stutter.
          </p>
          <a
            href="https://github.com/jub0t/WolfCut/blob/main/ARCHITECTURE.md"
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-block text-sm text-accent hover:underline"
          >
            Read the architecture &rsaquo;
          </a>
        </div>
        <img
          src={screenshotDark}
          alt="The WolfCut editor rendering a project in the dark theme"
          className="w-full rounded-2xl border border-hairline/60 shadow-lg"
        />
      </div>
    </Section>
  )
}
