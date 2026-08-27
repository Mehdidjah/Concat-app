import DownloadButton from '../components/DownloadButton'
import editorPreview from '../assets/editor-preview.png'

export default function Hero() {
  return (
    <section id="overview" className="bg-surface">
      <div className="mx-auto max-w-5xl px-6 pt-24 pb-16 text-center sm:pt-32">
        <p className="text-sm font-medium text-accent">Free &amp; open source</p>
        <h1 className="mt-3 text-5xl font-semibold tracking-tighter text-balance sm:text-7xl">
          Everything CapCut does.
          <br />
          Nothing it charges for.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-ink-secondary text-pretty sm:text-xl">
          WolfCut is a native video editor with no watermarks, no paywalls, and
          no account. Install it and start cutting.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <DownloadButton size="lg" />
          <a href="#features" className="text-sm text-accent hover:underline">
            Learn more &rsaquo;
          </a>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-6 pb-24">
        <img
          src={editorPreview}
          alt="The WolfCut editor in dark and light themes"
          className="w-full rounded-2xl border border-hairline/60 shadow-lg"
        />
      </div>
    </section>
  )
}
