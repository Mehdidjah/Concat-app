import Image from 'next/image';
import Link from 'next/link';

const releasesUrl = 'https://github.com/Mehdidjah/wolfcut-App/releases';
const repositoryUrl = 'https://github.com/Mehdidjah/wolfcut-App';
const actionClassName =
  'inline-flex h-13 w-full items-center justify-center rounded-xl border px-6 text-base font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary active:translate-y-px sm:w-auto';

export default function Home() {
  return (
    <main className="relative isolate flex min-h-screen flex-col overflow-hidden bg-background px-5 text-foreground sm:px-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[-26rem] -z-10 mx-auto h-[42rem] max-w-5xl rounded-full bg-[radial-gradient(circle,rgba(198,244,50,0.16)_0%,rgba(10,132,255,0.09)_36%,transparent_70%)] blur-3xl"
      />

      <header className="mx-auto flex w-full max-w-6xl items-center justify-between py-6 sm:py-8">
        <Link
          href="/"
          aria-label="WolfCut home"
          className="flex items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
        >
          <Image
            src="/wolfcut-logo.png"
            alt=""
            width="42"
            height="42"
            className="size-10 rounded-xl ring-1 ring-white/10"
          />
          <span className="text-lg font-semibold tracking-[-0.03em]">WolfCut</span>
        </Link>

        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-medium text-muted-foreground">
          Alpha 0.2.0
        </span>
      </header>

      <section className="mx-auto flex w-full max-w-4xl flex-1 flex-col items-center justify-center pb-24 pt-14 text-center sm:pb-32 sm:pt-20">
        <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/[0.07] px-3.5 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
          Free · Open source · Local
        </p>

        <h1 className="max-w-4xl text-balance text-[clamp(3.25rem,9vw,7.5rem)] font-semibold leading-[0.88] tracking-[-0.07em]">
          Your videos.
          <span className="block text-primary">Your rules.</span>
        </h1>

        <p className="mt-8 max-w-2xl text-pretty text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
          A fast, private video editor without watermarks, subscriptions, or
          cloud uploads. Install WolfCut and start creating.
        </p>

        <div className="mt-10 flex w-full flex-col items-center justify-center gap-3 sm:w-auto sm:flex-row">
          <a
            href={releasesUrl}
            className={`${actionClassName} border-primary bg-primary text-primary-foreground shadow-[0_12px_40px_rgba(198,244,50,0.18)] hover:border-[#d4ff52] hover:bg-[#d4ff52]`}
          >
            Download WolfCut&nbsp; ↓
          </a>

          <a
            href={repositoryUrl}
            target="_blank"
            rel="noreferrer"
            className={`${actionClassName} border-white/10 bg-white/[0.035] text-foreground hover:bg-white/[0.08]`}
          >
            View source&nbsp; ↗
          </a>
        </div>

        <p className="mt-5 text-sm text-muted-foreground">
          Downloads for macOS, Windows, and Linux
        </p>
      </section>

      <footer className="mx-auto flex w-full max-w-6xl justify-center border-t border-white/[0.07] py-5 text-xs text-muted-foreground sm:justify-between">
        <span>© 2026 WolfCut</span>
        <span className="hidden sm:inline">Cut locally. Create freely.</span>
      </footer>
    </main>
  );
}
