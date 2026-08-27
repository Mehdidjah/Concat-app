import DownloadButton from '../components/DownloadButton'
import Section from '../components/Section'

export default function CallToAction() {
  return (
    <Section>
      <div className="text-center">
        <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Start cutting.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-lg text-ink-secondary">
          Free forever. No account, no watermark, no subscription.
        </p>
        <div className="mt-8">
          <DownloadButton />
        </div>
        <p className="mt-4 text-sm text-ink-tertiary">
          Or{' '}
          <a
            href="https://github.com/jub0t/WolfCut"
            target="_blank"
            rel="noreferrer"
            className="text-accent hover:underline"
          >
            build it from source
          </a>{' '}
          — it&rsquo;s open.
        </p>
      </div>
    </Section>
  )
}
