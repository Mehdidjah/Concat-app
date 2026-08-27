type MediaPlaceholderProps = {
  label?: string
  aspect?: string
}

/** Neutral block standing in for future imagery or video. */
export default function MediaPlaceholder({
  label = 'Media',
  aspect = 'aspect-[16/9]',
}: MediaPlaceholderProps) {
  return (
    <div
      className={`flex w-full items-center justify-center rounded-3xl bg-surface-alt ${aspect}`}
    >
      <span className="text-sm text-ink-tertiary">{label}</span>
    </div>
  )
}
