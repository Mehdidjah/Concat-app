import { useState } from 'react'
import Section from '../components/Section'
import AudioPlayer from '../components/AudioPlayer'

/* Demo clips for the Sweet voice effect (test/sweet_voice.py).
   Generate the pair into website/public/audio/ with:
     python3 test/sweet_voice.py voice-before.mp3 voice-after.mp3 */
const clips = [
  {
    id: 'before',
    label: 'Before',
    caption: 'Original recording',
    src: '/audio/voice-before.mp3',
    accent: false,
  },
  {
    id: 'after',
    label: 'After',
    caption: 'Sweet voice effect',
    src: '/audio/voice-after.mp3',
    accent: true,
  },
] as const

type ClipId = (typeof clips)[number]['id']

export default function AudioComparison() {
  const [activeClip, setActiveClip] = useState<ClipId | null>(null)

  return (
    <Section id="audio" alt>
      <div className="text-center">
        <h2 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
          Voice filters, free for everyone.
        </h2>
        <p className="mx-auto mt-4 max-w-xl text-lg text-ink-secondary">
          The effects CapCut puts behind Pro, included for everyone. Here the
          Sweet voice effect lifts pitch, adds air, and smooths sibilance —
          same take, one pass.
        </p>
      </div>
      <div className="mx-auto mt-16 grid max-w-3xl gap-4 sm:grid-cols-2">
        {clips.map((clip) => (
          <AudioPlayer
            key={clip.id}
            src={clip.src}
            label={clip.label}
            caption={clip.caption}
            accent={clip.accent}
            playing={activeClip === clip.id}
            onPlayChange={(playing) => setActiveClip(playing ? clip.id : null)}
          />
        ))}
      </div>
    </Section>
  )
}
