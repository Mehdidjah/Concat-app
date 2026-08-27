import type { ReactNode } from "react";

import { activeTimeline, type Clip, type EditorProject, type MediaItem } from "../lib/editor";
import { shortDuration, timecode } from "../lib/time";

/**
 * Properties of the current selection - a clip if one is selected, otherwise
 * the highlighted bin item, otherwise the project itself.
 *
 * Read-only for now. When these become editable the edits go to the engine as
 * commands and come back as new state; the panel stays dumb. That is what
 * makes undo possible later without unpicking it.
 */
export function Inspector({
  clip,
  media,
  frameRate,
  project,
  projectName,
  projectPath,
  frame,
  duration,
}: {
  clip: Clip | null;
  media: MediaItem | null;
  frameRate: number;
  project: EditorProject;
  projectName: string;
  projectPath: string;
  /** The output size, as currently set in the preview footer. */
  frame: { width: number; height: number };
  /** Timeline length in seconds. */
  duration: number;
}) {
  return (
    <div>
      {!clip && !media ? (
        <div className="selectable px-3 py-2">
          <Section title="Project">
            <Row label="Name" value={projectName} />
            <Row label="Folder" value={projectPath} mono wrap />
            <Row label="Output" value={`${frame.width} x ${frame.height}`} mono />
            <Row label="Rate" value={`${frameRate.toFixed(2)} fps`} mono />
            <Row label="Duration" value={timecode(duration, frameRate)} mono />
          </Section>
          <Section title="Contents">
            <Row label="Media" value={`${project.media.length}`} mono />
            <Row label="Tracks" value={`${activeTimeline(project).tracks.length}`} mono />
            <Row label="Clips" value={`${activeTimeline(project).clips.length}`} mono />
          </Section>
        </div>
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
