/**
 * Reading and writing the project document.
 *
 * The document is the file on disk. It is deliberately *not* the same shape as
 * the in-memory `Project`: loading fills in anything a file predates, so a
 * project saved before a feature existed still opens instead of arriving with
 * `undefined` where a number should be.
 *
 * That tolerance is the whole job of this module. Everything else is a
 * one-to-one copy.
 */

import type { ProjectSession } from "../components/StartScreen";
import type { Clip, MediaItem, Project, Track } from "./project";

/** Bumped only when a change cannot be absorbed by defaulting. */
const DOCUMENT_VERSION = 1;

export interface ProjectDocument {
  relay: string;
  version: number;
  name: string;
  video: { width: number; height: number; rateNum: number; rateDen: number };
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
}

export function toDocument(session: ProjectSession, project: Project): ProjectDocument {
  return {
    relay: "0.1.0",
    version: DOCUMENT_VERSION,
    name: session.name,
    video: {
      width: session.width,
      height: session.height,
      rateNum: session.rateNum,
      rateDen: session.rateDen,
    },
    media: project.media,
    tracks: project.tracks,
    clips: project.clips,
  };
}

const number = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const text = (value: unknown, fallback: string): string =>
  typeof value === "string" ? value : fallback;

const flag = (value: unknown, fallback: boolean): boolean =>
  typeof value === "boolean" ? value : fallback;

/**
 * Rebuilds a project from a document.
 *
 * Every field is defaulted rather than trusted. A hand-edited or older file
 * should degrade to something openable, not produce a timeline full of `NaN`
 * that fails somewhere far away from the cause.
 *
 * Returns null only when there is nothing recognisable to load at all.
 */
export function fromDocument(raw: unknown): Project | null {
  if (typeof raw !== "object" || raw === null) return null;
  const document = raw as Record<string, unknown>;

  const media: MediaItem[] = Array.isArray(document.media)
    ? document.media.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== "string" || typeof item.path !== "string") return [];

        const kind = item.kind === "audio" || item.kind === "image" ? item.kind : "video";
        return [
          {
            id: item.id,
            path: item.path,
            name: text(item.name, item.path),
            duration: typeof item.duration === "number" ? item.duration : null,
            kind,
            width: typeof item.width === "number" ? item.width : null,
            height: typeof item.height === "number" ? item.height : null,
            frameRate: typeof item.frameRate === "number" ? item.frameRate : null,
            frameRateFraction:
              typeof item.frameRateFraction === "string" ? item.frameRateFraction : null,
            videoCodec: typeof item.videoCodec === "string" ? item.videoCodec : null,
            audioCodec: typeof item.audioCodec === "string" ? item.audioCodec : null,
            hasAudio: flag(item.hasAudio, false),
          },
        ];
      })
    : [];

  const tracks: Track[] = Array.isArray(document.tracks)
    ? document.tracks.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const track = entry as Record<string, unknown>;
        if (typeof track.id !== "string") return [];
        return [
          {
            id: track.id,
            name: text(track.name, track.id),
            visible: flag(track.visible, true),
            muted: flag(track.muted, false),
          },
        ];
      })
    : [];

  const known = new Set(tracks.map((track) => track.id));
  const mediaIds = new Set(media.map((item) => item.id));

  const clips: Clip[] = Array.isArray(document.clips)
    ? document.clips.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const clip = entry as Record<string, unknown>;
        if (typeof clip.id !== "string") return [];

        // A clip whose track or media vanished has nowhere to live and nothing
        // to play. Dropping it beats keeping a reference that resolves to
        // nothing everywhere it is used.
        if (typeof clip.trackId !== "string" || !known.has(clip.trackId)) return [];
        if (typeof clip.mediaId !== "string" || !mediaIds.has(clip.mediaId)) return [];

        const kind = clip.kind === "audio" || clip.kind === "image" ? clip.kind : "video";
        return [
          {
            id: clip.id,
            trackId: clip.trackId,
            mediaId: clip.mediaId,
            name: text(clip.name, "clip"),
            kind,
            start: Math.max(0, number(clip.start, 0)),
            duration: Math.max(0.01, number(clip.duration, 1)),
            sourceStart: Math.max(0, number(clip.sourceStart, 0)),
            volume: Math.max(0, number(clip.volume, 1)),
            fadeIn: Math.max(0, number(clip.fadeIn, 0)),
            fadeOut: Math.max(0, number(clip.fadeOut, 0)),
            scale: Math.max(0.05, number(clip.scale, 1)),
            offsetX: number(clip.offsetX, 0),
            offsetY: number(clip.offsetY, 0),
            speed: Math.max(0.1, number(clip.speed, 1)),
            preservePitch: flag(clip.preservePitch, true),
            filters: Array.isArray(clip.filters)
              ? clip.filters.flatMap((filter) => {
                  if (typeof filter !== "object" || filter === null) return [];
                  const applied = filter as Record<string, unknown>;
                  if (typeof applied.id !== "string") return [];
                  return [
                    {
                      id: applied.id,
                      params:
                        typeof applied.params === "object" && applied.params !== null
                          ? (applied.params as Record<string, number>)
                          : {},
                    },
                  ];
                })
              : [],
          },
        ];
      })
    : [];

  // A file with no tracks at all is not something to open silently as empty.
  if (tracks.length === 0) return null;

  return { media, tracks, clips };
}
