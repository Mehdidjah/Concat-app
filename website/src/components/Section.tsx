import type { ReactNode } from 'react'

type SectionProps = {
  id?: string
  alt?: boolean
  children: ReactNode
}

/** Full-width section band with consistent vertical rhythm. */
export default function Section({ id, alt = false, children }: SectionProps) {
  return (
    <section id={id} className={alt ? 'bg-surface-alt' : 'bg-surface'}>
      <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">{children}</div>
    </section>
  )
}
