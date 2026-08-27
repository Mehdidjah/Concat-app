import { useEffect, useRef, useState } from 'react'

type Os = 'mac' | 'windows' | 'linux'

const DOWNLOAD_URLS: Record<Exclude<Os, 'linux'>, string> = {
  mac: 'https://github.com/jub0t/WolfCut/releases',
  windows: 'https://github.com/jub0t/WolfCut/releases',
}

function detectOs(): Exclude<Os, 'linux'> {
  if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform)) {
    return 'windows'
  }
  return 'mac'
}

const OS_LABELS: Record<Os, string> = {
  mac: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
}

function AppleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  )
}

function WindowsIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M3 5.55l7.36-1.01v7.1H3V5.55zm0 12.9l7.36 1.01v-7.02H3v6.01zm8.17 1.12L21 21V12.44h-9.83v7.13zm0-15.13v7.2H21V3L11.17 4.44z" />
    </svg>
  )
}

function LinuxIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 2c-2.21 0-3.5 1.79-3.5 4 0 1.5.3 2.34-.5 3.5-1.13 1.64-2.5 3.5-2.5 5.5 0 .82.16 1.6.46 2.31-.28.16-.51.38-.68.65-.33.52-.4 1.17-.28 1.79.06.31.27.55.55.66.85.33 1.9.51 2.95.7.5.62 1.66 1.39 3.5 1.39s3-.77 3.5-1.39c1.05-.19 2.1-.37 2.95-.7.28-.11.49-.35.55-.66.12-.62.05-1.27-.28-1.79-.17-.27-.4-.49-.68-.65.3-.71.46-1.49.46-2.31 0-2-1.37-3.86-2.5-5.5-.8-1.16-.5-2-.5-3.5 0-2.21-1.29-4-3.5-4zm-1.5 5.5c.28 0 .5.34.5.75s-.22.75-.5.75-.5-.34-.5-.75.22-.75.5-.75zm3 0c.28 0 .5.34.5.75s-.22.75-.5.75-.5-.34-.5-.75.22-.75.5-.75z" />
    </svg>
  )
}

const OS_ICONS: Record<Os, typeof AppleIcon> = {
  mac: AppleIcon,
  windows: WindowsIcon,
  linux: LinuxIcon,
}

export default function DownloadButton({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const defaultOs = detectOs()
  const DefaultIcon = OS_ICONS[defaultOs]

  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const mainClasses =
    size === 'lg'
      ? 'gap-2.5 pl-7 pr-5 py-3.5 text-base'
      : 'gap-2 pl-6 pr-4 py-2.5 text-sm'
  const chevronClasses = size === 'lg' ? 'pl-3 pr-4 py-3.5' : 'pl-2.5 pr-3.5 py-2.5'

  return (
    <div ref={rootRef} className="relative inline-flex">
      <a
        href={DOWNLOAD_URLS[defaultOs]}
        className={`inline-flex items-center rounded-l-full bg-accent font-medium text-white transition-colors hover:bg-accent-hover ${mainClasses}`}
      >
        <DefaultIcon className={size === 'lg' ? 'size-5' : 'size-4'} />
        Download for {OS_LABELS[defaultOs]}
      </a>
      <button
        type="button"
        aria-label="Download for other platforms"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex items-center rounded-r-full border-l border-white/25 bg-accent text-white transition-colors hover:bg-accent-hover ${chevronClasses}`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`${size === 'lg' ? 'size-4' : 'size-3.5'} transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute top-full right-0 z-20 mt-2 w-56 overflow-hidden rounded-2xl border border-hairline bg-surface py-1.5 text-left shadow-lg"
        >
          {(['mac', 'windows'] as const).map((os) => {
            const Icon = OS_ICONS[os]
            return (
              <a
                key={os}
                role="menuitem"
                href={DOWNLOAD_URLS[os]}
                onClick={() => setOpen(false)}
                className="flex items-center gap-3 px-4 py-2.5 text-sm text-ink transition-colors hover:bg-surface-alt"
              >
                <Icon className="size-4.5 text-ink-secondary" />
                Download for {OS_LABELS[os]}
              </a>
            )
          })}
          <div
            role="menuitem"
            aria-disabled="true"
            className="flex cursor-default items-center gap-3 px-4 py-2.5 text-sm text-ink-tertiary"
          >
            <LinuxIcon className="size-4.5" />
            Download for Linux
            <span className="ml-auto rounded-full bg-surface-alt px-2 py-0.5 text-[11px] font-medium text-ink-secondary">
              Coming soon
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
