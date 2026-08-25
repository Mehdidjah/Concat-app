import type { ReactNode } from "react";

import type { Clip, MediaItem } from "../lib/project";
import { shortDuration, timecode } from "../lib/time";
import { Icon } from "./Icon";
import { Empty } from "./Panel";

/**
 * Properties of the current selection - a clip if one is selected, otherwise
 * the highlighted bin item.
 *
 * Read-only for now. When these become editable the edits go to the engine as
 * commands and come back as new state; the panel stays dumb. That is what
 * makes undo possible later without unpicking it.
 */
export function Inspector({
  clip,
  media,
  frameRate,
}: {
  clip: Clip | null;
  media: MediaItem | null;
  frameRate: number;
}) {
  return (
    <div>
      {!clip && !media ? (
        <Empty icon={<Icon name="info" size={26} strokeWidth={1.5} />}>
          Select a clip or a bin item.
        </Empty>
      ) : (
        <div className="selectable px-3 py-2">
          {clip && (
            <Section title="Clip">
              <Row label="Name" value={clip.name} />
              <Row label="Track" value={clip.trackId} mono />
              <Row label="Start" value={timecode(clip.start, frameRate)} mono />
              <Row label="Duration" value={timecode(clip.duration, frameRate)} mono />
              <Row label="End" value={timecode(clip.start + clip.duration, frameRate)} mono />
              <Row label="In point" value={timecode(clip.sourceStart, frameRate)} mono />
            </Section>
          )}

          {media && (
            <>
              <Section title="Source">
                <Row label="Name" value={media.name} />
                <Row label="Path" value={media.path} mono wrap />
                <Row label="Duration" value={shortDuration(media.duration)} mono />
              </Section>

              {media.width !== null && (
                <Section title="Video">
                  <Row label="Codec" value={media.videoCodec ?? "unknown"} />
                  <Row label="Size" value={`${media.width} x ${media.height}`} mono />
                  <Row
                    label="Rate"
                    value={media.frameRate ? `${media.frameRate.toFixed(3)} fps` : "unknown"}
                    mono
                  />
                  <Row label="Exact" value={media.frameRateFraction ?? "unknown"} mono />
                </Section>
              )}

              {media.hasAudio && (
                <Section title="Audio">
                  <Row label="Codec" value={media.audioCodec ?? "unknown"} />
                </Section>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
        {title}
      </h3>
      <dl className="space-y-1.5">{children}</dl>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  wrap,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-secondary">{label}</dt>
      <dd
        title={value}
        className={`min-w-0 text-right text-xs text-primary ${mono ? "text-[11px]" : ""} ${
          wrap ? "break-all" : "truncate"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
