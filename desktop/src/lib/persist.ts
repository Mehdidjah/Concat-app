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
import { adoptProject, type Clip, type ClipKind, type MediaItem, type Project, type Track } from "./project";
import { defaultTextStyle, type CustomFont, type TextStyle } from "./text";

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
  fonts: CustomFont[];
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
    fonts: project.fonts,
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

        // A text clip is its own content, so it has no media to resolve. Only
        // the kinds that come from the bin are dropped when their source is
        // gone - applying that rule to titles would delete every one of them
        // on reload, because an empty id is never in the media set.
        const isText = clip.kind === "text";
        if (!isText && (typeof clip.mediaId !== "string" || !mediaIds.has(clip.mediaId))) {
          return [];
        }

        const kind: ClipKind = isText
          ? "text"
          : clip.kind === "audio" || clip.kind === "image"
            ? clip.kind
            : "video";
        return [
          {
            id: clip.id,
            trackId: clip.trackId,
            mediaId: isText ? "" : (clip.mediaId as string),
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
            rotation: number(clip.rotation, 0),
            // Clamped, not just defaulted: a hand-edited 2 would export
            // differently from how the preview clamps it on screen.
            opacity: Math.min(1, Math.max(0, number(clip.opacity, 1))),
            speed: Math.max(0.1, number(clip.speed, 1)),
            preservePitch: flag(clip.preservePitch, true),
            muted: flag(clip.muted, false) || undefined,
            detachedFrom: typeof clip.detachedFrom === "string" ? clip.detachedFrom : undefined,
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
                      // Absent in files saved before bypass existed: enabled.
                      enabled: flag(applied.enabled, true),
                    },
                  ];
                })
              : [],
            ...(isText ? { text: readTextStyle(clip.text) } : {}),
          },
        ];
      })
    : [];

  const fonts: CustomFont[] = Array.isArray(document.fonts)
    ? document.fonts.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const font = entry as Record<string, unknown>;
        if (typeof font.family !== "string" || typeof font.path !== "string") return [];
        return [{ family: font.family, path: font.path }];
      })
    : [];

  // A file with no tracks at all is not something to open silently as empty.
  if (tracks.length === 0) return null;

  // The restored ids were minted by an earlier session; the counter must move
  // past them - and any baked-in duplicates must be re-minted - before
  // anything new is added, or identities collide.
  return adoptProject({ media, tracks, clips, fonts });
}

/**
 * Rebuilds a text style, defaulting every field.
 *
 * Same tolerance as the rest of this module: a title saved before a styling
 * option existed opens with that option at its default rather than
 * `undefined`, which would otherwise reach the CSS and render as nothing.
 */
function readTextStyle(raw: unknown): TextStyle {
  const base = defaultTextStyle();
  if (typeof raw !== "object" || raw === null) return base;
  const style = raw as Record<string, unknown>;

  const align = style.align;
  return {
    content: text(style.content, base.content),
    fontFamily: text(style.fontFamily, base.fontFamily),
    // Clamped, not just defaulted: a hand-edited 0 would render an invisible
    // title, and a 10 would be one letter filling the frame.
    fontSize: Math.min(1, Math.max(0.01, number(style.fontSize, base.fontSize))),
    fontWeight: Math.min(900, Math.max(100, number(style.fontWeight, base.fontWeight))),
    italic: flag(style.italic, base.italic),
    color: text(style.color, base.color),
    align: align === "left" || align === "center" || align === "right" ? align : base.align,
    opacity: Math.min(1, Math.max(0, number(style.opacity, base.opacity))),
    strokeWidth: Math.max(0, number(style.strokeWidth, base.strokeWidth)),
    strokeColor: text(style.strokeColor, base.strokeColor),
    shadow: flag(style.shadow, base.shadow),
    background: text(style.background, base.background),
    lineHeight: Math.max(0.5, number(style.lineHeight, base.lineHeight)),
    tracking: number(style.tracking, base.tracking),
  };
}
