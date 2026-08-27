import logo from '../assets/wolfcut_logo_512.png'

const links = [
  { label: 'Overview', href: '#overview' },
  { label: 'Features', href: '#features' },
  { label: 'Engine', href: '#engine' },
  { label: 'Voice', href: '#audio' },
]

export default function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-hairline/60 bg-surface/80 backdrop-blur-md">
      <nav className="mx-auto flex h-12 max-w-5xl items-center justify-between px-6">
        <a href="#" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <img src={logo} alt="" className="size-6" />
          WolfCut
        </a>
        <div className="hidden items-center gap-8 sm:flex">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-xs text-ink-secondary transition-colors hover:text-ink"
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-4">
          <a
            href="https://github.com/jub0t/WolfCut"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-secondary transition-colors hover:text-ink"
          >
            GitHub
          </a>
          <a
            href="https://github.com/jub0t/WolfCut/releases"
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-accent px-3.5 py-1 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
          >
            Download
          </a>
        </div>
      </nav>
    </header>
  )
}
