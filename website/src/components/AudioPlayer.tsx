import { useEffect, useRef, useState } from 'react'

type AudioPlayerProps = {
  src: string
  label: string
  caption?: string
  playing: boolean
  onPlayChange: (playing: boolean) => void
  /** Accent styling for the card that shows the effect applied. */
  accent?: boolean
}

const BAR_COUNT = 56

/* Stand-in waveform shown until the real peaks are decoded, so the layout
   never jumps. Deterministic — same shape on every render. */
const FALLBACK_PEAKS = Array.from(
  { length: BAR_COUNT },
  (_, i) => 0.3 + 0.25 * Math.sin(i * 0.9) * Math.sin(i * 0.23),
)

function formatTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Waveform audio card. Playback state is lifted so a parent can ensure only
 *  one player is audible at a time. */
export default function AudioPlayer({
  src,
  label,
  caption,
  playing,
  onPlayChange,
  accent = false,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const scrubbing = useRef(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [missing, setMissing] = useState(false)
  const [peaks, setPeaks] = useState<number[] | null>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.play().catch(() => onPlayChange(false))
    } else {
      audio.pause()
    }
  }, [playing, onPlayChange])

  useEffect(() => {
    let cancelled = false
    const ctx = new AudioContext()
    fetch(src)
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`)
        return res.arrayBuffer()
      })
      .then((buf) => ctx.decodeAudioData(buf))
      .then((decoded) => {
        if (cancelled) return
        const data = decoded.getChannelData(0)
        const step = Math.floor(data.length / BAR_COUNT)
        const raw: number[] = []
        for (let i = 0; i < BAR_COUNT; i++) {
          let peak = 0
          for (let j = i * step; j < (i + 1) * step; j += 32) {
            const v = Math.abs(data[j])
            if (v > peak) peak = v
          }
          raw.push(peak)
        }
        const max = Math.max(...raw, 0.01)
        setPeaks(raw.map((p) => Math.max(p / max, 0.08)))
      })
      .catch(() => {
        /* keep the fallback shape; a truly missing file is caught by <audio> */
      })
      .finally(() => void ctx.close())
    return () => {
      cancelled = true
    }
  }, [src])

  const seekToClientX = (clientX: number, target: HTMLElement) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    const rect = target.getBoundingClientRect()
    const fraction = Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1)
    audio.currentTime = fraction * duration
    setCurrentTime(audio.currentTime)
  }

  const seekBy = (delta: number) => {
    const audio = audioRef.current
    if (!audio || !duration) return
    audio.currentTime = Math.min(Math.max(audio.currentTime + delta, 0), duration)
    setCurrentTime(audio.currentTime)
  }

  const progress = duration ? currentTime / duration : 0
  const bars = peaks ?? FALLBACK_PEAKS
  const playedColor = accent ? 'bg-accent' : 'bg-ink'
  const remaining = duration - currentTime

  return (
    <div className="rounded-2xl bg-surface p-6 ring-1 ring-hairline/60">
      <div className="flex items-center justify-between">
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            accent ? 'bg-accent/10 text-accent' : 'bg-surface-alt text-ink-secondary'
          }`}
        >
          {label}
        </span>
        {caption && <span className="text-xs text-ink-tertiary">{caption}</span>}
      </div>

      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onTimeUpdate={(e) => {
          if (!scrubbing.current) setCurrentTime(e.currentTarget.currentTime)
        }}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        onEnded={() => onPlayChange(false)}
        onError={() => setMissing(true)}
      />

      {missing ? (
        <p className="mt-5 text-xs text-ink-tertiary">
          Audio not found — add <code className="font-mono">{src}</code>
        </p>
      ) : (
        <div className="mt-5 flex items-center gap-4">
          <button
            type="button"
            onClick={() => onPlayChange(!playing)}
            aria-label={playing ? `Pause ${label}` : `Play ${label}`}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white transition-all hover:scale-105 active:scale-95 ${
              accent ? 'bg-accent hover:bg-accent-hover' : 'bg-ink hover:opacity-85'
            }`}
          >
            {playing ? (
              <svg width="11" height="12" viewBox="0 0 11 12" fill="currentColor">
                <rect x="0" y="0" width="4" height="12" rx="1" />
                <rect x="7" y="0" width="4" height="12" rx="1" />
              </svg>
            ) : (
              <svg
                width="12"
                height="12"
                viewBox="0 0 12 12"
                fill="currentColor"
                className="translate-x-px"
              >
                <path d="M2.1.6a1 1 0 0 0-1.5.87v9.06a1 1 0 0 0 1.5.87l7.8-4.53a1 1 0 0 0 0-1.74L2.1.6Z" />
              </svg>
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div
              role="slider"
              tabIndex={0}
              aria-label={`Seek ${label}`}
              aria-valuemin={0}
              aria-valuemax={Math.round(duration)}
              aria-valuenow={Math.round(currentTime)}
              aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
              onPointerDown={(e) => {
                scrubbing.current = true
                e.currentTarget.setPointerCapture(e.pointerId)
                seekToClientX(e.clientX, e.currentTarget)
              }}
              onPointerMove={(e) => {
                if (scrubbing.current) seekToClientX(e.clientX, e.currentTarget)
              }}
              onPointerUp={() => {
                scrubbing.current = false
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') seekBy(-5)
                if (e.key === 'ArrowRight') seekBy(5)
              }}
              className="flex h-12 cursor-pointer touch-none items-center gap-[2px] rounded-md outline-offset-4 focus-visible:outline-2 focus-visible:outline-accent"
            >
              {bars.map((peak, i) => {
                const played = (i + 0.5) / BAR_COUNT <= progress
                return (
                  <div
                    key={i}
                    className={`min-w-0 flex-1 rounded-full transition-colors duration-75 ${
                      played ? playedColor : 'bg-hairline'
                    } ${peaks ? '' : 'animate-pulse'}`}
                    style={{ height: `${Math.round(peak * 100)}%` }}
                  />
                )
              })}
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] text-ink-tertiary tabular-nums">
              <span>{formatTime(currentTime)}</span>
              <span>&minus;{formatTime(remaining)}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
