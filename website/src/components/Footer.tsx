const links = [
  { label: 'GitHub', href: 'https://github.com/jub0t/WolfCut' },
  { label: 'Releases', href: 'https://github.com/jub0t/WolfCut/releases' },
  { label: 'Report an issue', href: 'https://github.com/jub0t/WolfCut/issues' },
]

export default function Footer() {
  return (
    <footer className="border-t border-hairline/60 bg-surface-alt">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <p className="text-xs text-ink-tertiary">
          WolfCut is free, open-source software under active development —
          things move fast and edges are sharp. CapCut is a trademark of its
          respective owner; WolfCut is not affiliated with it.
        </p>
        <div className="mt-4 flex flex-col justify-between gap-4 border-t border-hairline/60 pt-4 sm:flex-row">
          <p className="text-xs text-ink-secondary">
            Copyright &copy; {new Date().getFullYear()} WolfCut.
          </p>
          <div className="flex gap-6">
            {links.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-ink-secondary transition-colors hover:text-ink"
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      </div>
    </footer>
  )
}
