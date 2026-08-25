import type { Clip } from "../lib/project";
import { Group, Slider } from "./controls";
import { Icon } from "./Icon";
import { Empty } from "./Panel";

/** Above unity the preview cannot follow; see the note in the panel. */
const MAX_GAIN = 2;
/** A fade longer than the clip is meaningless, and this keeps it obvious. */
const MAX_FADE = 5;

/** Linear gain as decibels, which is the unit anyone mixing audio thinks in. */
function decibels(gain: number): string {
  if (gain <= 0.0001) return "-inf dB";
  const value = 20 * Math.log10(gain);
  return `${value > 0 ? "+" : ""}${value.toFixed(1)} dB`;
}

/**
 * The Adjust tab: properties of the selected clip that change how it plays.
 *
 * Everything here is applied in two places - the preview, so you can hear it
 * now, and the exporter, so the file matches. Both read the same numbers off
 * the clip, which is the only way those two can be guaranteed to agree.
 */
export function AdjustPanel({
  clip,
  onChange,
}: {
  clip: Clip | null;
  onChange: (patch: Partial<Clip>) => void;
}) {
  if (!clip) {
    return (
      <Empty icon={<Icon name="settings" size={26} strokeWidth={1.5} />}>
        Select a single clip to adjust it.
      </Empty>
    );
  }

  const hasSound = clip.kind !== "image";
  // A fade cannot be longer than half the clip without the two overlapping.
  const fadeLimit = Math.min(MAX_FADE, clip.duration / 2);

  return (
    <div className="px-3 py-3">
      {hasSound ? (
        <>
          <Group title="Volume">
            <Slider
              label="Level"
              value={clip.volume}
              min={0}
              max={MAX_GAIN}
              step={0.01}
              format={decibels}
              onReset={() => onChange({ volume: 1 })}
              onChange={(volume) => onChange({ volume })}
            />
            {clip.volume > 1 && (
              <p className="-mt-1 mb-1 text-[11px] leading-snug text-tertiary">
                Boost above 0 dB applies on export. The preview cannot play louder than
                unity, so it will sound quieter than the exported file.
              </p>
            )}
          </Group>

          <Group title="Fades">
            <Slider
              label="Fade in"
              value={Math.min(clip.fadeIn, fadeLimit)}
              min={0}
              max={fadeLimit}
              step={0.05}
              format={(value) => (value === 0 ? "none" : `${value.toFixed(2)}s`)}
              onReset={() => onChange({ fadeIn: 0 })}
              onChange={(fadeIn) => onChange({ fadeIn })}
            />
            <Slider
              label="Fade out"
              value={Math.min(clip.fadeOut, fadeLimit)}
              min={0}
              max={fadeLimit}
              step={0.05}
              format={(value) => (value === 0 ? "none" : `${value.toFixed(2)}s`)}
              onReset={() => onChange({ fadeOut: 0 })}
              onChange={(fadeOut) => onChange({ fadeOut })}
            />
          </Group>
        </>
      ) : (
        <Empty icon={<Icon name="image" size={26} strokeWidth={1.5} />}>
          A still has nothing to adjust yet. Opacity and transform land with the
          compositor.
        </Empty>
      )}
    </div>
  );
}
