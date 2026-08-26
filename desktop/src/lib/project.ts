/**
 * The prototype's edit model.
 *
 * A note on where this lives: the engine is the eventual owner of the timeline,
 * and `relay-core` already has a far better version of these types (exact
 * rational time, arena handles, generational IDs). This module exists because
 * the engine has no project *API* yet - no commands, no undo, no
 * serialisation - and the UI needs something to draw.
 *
 * So this is explicitly provisional. Two rules keep the eventual migration
 * cheap, and both are worth honouring:
 *
 *   1. Every operation is a pure function `(project, args) => project`. That is
 *      the same shape a command sent to the engine will have, so the call sites
 *      do not change when the implementation moves.
 *   2. No component mutates a project. They call these functions.
 *
 * Times are seconds as JS numbers, which is a real downgrade from the engine's
 * exact rationals. Acceptable while nothing here is authoritative; not
 * acceptable once it is. See docs/decisions/0004.
 */

import type { MediaSummary } from "./engine";
import type { ClipFilter } from "./filters";
import { defaultTextStyle, type CustomFont, type TextStyle } from "./text";

/**
 * What a piece of media is.
 *
 * A still is not a video with one frame: it has no intrinsic duration, so how
 * long it lasts on the timeline is an editorial choice rather than a property
 * of the file. Everything downstream of that difference - the default clip
 * length, how it is previewed, how it is decoded on export - follows from
 * keeping the two apart.
 */
export type MediaKind = "video" | "audio" | "image";

/** Kept as an alias so existing call sites read naturally. */
export type TrackKind = MediaKind;

/**
 * What a clip can be.
 *
 * Wider than `MediaKind` because a text clip has no file behind it - it *is*
 * its own content. That is the whole reason for the distinction: everything in
 * the bin is a `MediaKind`, but not everything on the timeline came from the
 * bin. A text clip carries `mediaId: ""` and a `text` style instead.
 */
export type ClipKind = MediaKind | "text";

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  /** Seconds. Null when the container did not say. */
  duration: number | null;
  kind: TrackKind;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  /** The exact fraction the engine works in, e.g. "30000/1001". */
  frameRateFraction: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

/**
 * A lane. Deliberately untyped: any media goes on any track.
 *
 * Typed video/audio lanes are an assumption inherited from tape, and they cost
 * you every time an mp3 belongs next to a cutaway or a clip needs to move down
 * one row. A clip knows what it is; a track does not need to.
 *
 * Both flags therefore exist on every track, because one track can carry
 * picture and sound at the same time.
 */
export interface Track {
  id: string;
  name: string;
  /** Video clips on this track are left out of the composite when false. */
  visible: boolean;
  /** Audio on this track is silent when true. */
  muted: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  mediaId: string;
  /** Empty for a text clip, which has no file behind it. */
  name: string;
  kind: ClipKind;
  /** Seconds from the start of the timeline. */
  start: number;
  duration: number;
  /** In-point: how far into the media the clip starts. */
  sourceStart: number;

  /**
   * Linear gain, 1 being unity. Above 1 is a boost.
   *
   * Linear rather than decibels because that is what both the audio element
   * and ffmpeg's `volume` filter take; the UI converts for display.
   */
  volume: number;
  /** Fade-in length in seconds. Zero means no fade. */
  fadeIn: number;
  /** Fade-out length in seconds. Zero means no fade. */
  fadeOut: number;

  /**
   * How big the picture is drawn, where 1 fills the frame.
   *
   * "Fills the frame" means the size the clip would be with no transform at
   * all - fitted to the project's frame, preserving its aspect. Everything is
   * relative to that, so a transform means the same thing on a 4K clip and a
   * 720p one.
   */
  scale: number;
  /** Offset from centred, as a fraction of frame width. */
  offsetX: number;
  /** Offset from centred, as a fraction of frame height. */
  offsetY: number;

  /**
   * Playback rate. 1 is normal, 2 is twice as fast.
   *
   * Changing it rescales the clip's timeline duration, because the same span
   * of source now takes a different amount of time to play. That is what every
   * editor does and what people expect from a speed control.
   */
  speed: number;
  /**
   * Whether pitch stays put when the speed changes.
   *
   * True is the modern default - time-stretching that leaves the voice where
   * it was. False is the tape behaviour, where faster also means higher.
   */
  preservePitch: boolean;

  /**
   * Audio filters, applied in order.
   *
   * An array rather than a set because order is audible: an EQ before a
   * limiter is a different sound from the reverse.
   */
  filters: ClipFilter[];

  /**
   * The overlay, when this is a text clip. Absent on every other kind.
   *
   * On the clip rather than in the bin because two titles are two different
   * pieces of content even when they share a face - there is no shared source
   * to point at, so there is nothing to put in the bin.
   */
  text?: TextStyle;
}

export interface Project {
  media: MediaItem[];
  tracks: Track[];
  clips: Clip[];
  /**
   * Font files the user added, by path.
   *
   * On the project rather than in app settings because a title's face is part
   * of the edit: opening the project has to bring the font back with it, or
   * the composition silently changes.
   */
  fonts: CustomFont[];
}

/** Fallback length for media whose container reports no duration. */
const UNKNOWN_DURATION = 5;
/** How long a still lasts when first placed. Editorial default, not a fact. */
export const DEFAULT_IMAGE_DURATION = 5;
const MIN_CLIP_DURATION = 1 / 60;

let counter = 0;
const nextId = (prefix: string) => `${prefix}${(counter += 1)}`;

/** A project with four empty lanes. */
export function createProject(): Project {
  return {
    media: [],
    fonts: [],
    // Bottom-most first, matching the engine's compositing order, so track 1
    // sits at the bottom of the screen the way it does in every other editor.
    tracks: [1, 2, 3, 4].map((number) => ({
      id: `T${number}`,
      name: `Track ${number}`,
      visible: true,
      muted: false,
    })),
    clips: [],
  };
}

/** Turns a probe result into a bin item. */
export function toMediaItem(summary: MediaSummary): MediaItem {
  const name = summary.path.split(/[\\/]/).pop() ?? summary.path;
  return {
    id: nextId("m"),
    path: summary.path,
    name,
    duration: summary.duration,
    kind: summary.kind,
    width: summary.video?.width ?? null,
    height: summary.video?.height ?? null,
    frameRate: summary.video?.frameRate ?? null,
    frameRateFraction: summary.video?.frameRateFraction ?? null,
    videoCodec: summary.video?.codec ?? null,
    audioCodec: summary.audio?.codec ?? null,
    hasAudio: summary.audio !== null,
  };
}

/** Adds media to the bin, ignoring a path that is already there. */
export function addMedia(project: Project, item: MediaItem): Project {
  if (project.media.some((existing) => existing.path === item.path)) return project;
  return { ...project, media: [...project.media, item] };
}

export function findMedia(project: Project, mediaId: string): MediaItem | null {
  return project.media.find((item) => item.id === mediaId) ?? null;
}

export function findClip(project: Project, clipId: string): Clip | null {
  return project.clips.find((clip) => clip.id === clipId) ?? null;
}

export function findTrack(project: Project, trackId: string): Track | null {
  return project.tracks.find((track) => track.id === trackId) ?? null;
}

/**
 * The lowest track with nothing already occupying `[start, start + duration)`,
 * falling back to the bottom track.
 *
 * Used when material is added without being dropped somewhere specific, so
 * repeatedly adding clips stacks them up the tracks instead of piling them all
 * onto one lane on top of each other.
 */
export function firstFreeTrack(project: Project, start: number, duration: number): Track | null {
  const end = start + duration;
  const free = project.tracks.find(
    (track) =>
      !project.clips.some(
        (clip) =>
          clip.trackId === track.id && clip.start < end && start < clip.start + clip.duration,
      ),
  );
  return free ?? project.tracks[0] ?? null;
}

/** Places media on a track. Returns the project unchanged if either is unknown. */
export function addClip(
  project: Project,
  { mediaId, trackId, start }: { mediaId: string; trackId: string; start: number },
): { project: Project; clipId: string | null } {
  const media = findMedia(project, mediaId);
  const track = findTrack(project, trackId);
  if (!media || !track) return { project, clipId: null };

  const clip: Clip = {
    id: nextId("c"),
    trackId,
    mediaId,
    name: media.name,
    // The clip's kind comes from the media, never from the lane it lands on.
    kind: media.kind,
    start: Math.max(0, start),
    duration:
      media.kind === "image" ? DEFAULT_IMAGE_DURATION : (media.duration ?? UNKNOWN_DURATION),
    sourceStart: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    speed: 1,
    preservePitch: true,
    filters: [],
  };

  return { project: { ...project, clips: [...project.clips, clip] }, clipId: clip.id };
}

/** How long a title lasts when first placed. Editorial default, not a fact. */
export const DEFAULT_TEXT_DURATION = 4;

/**
 * Puts a title on the timeline.
 *
 * Unlike `addClip` this needs no media, which is the entire point: a text clip
 * carries its own content, so there is nothing to import first. It still takes
 * a track and a start so it behaves like any other clip once placed - it can
 * be moved, trimmed, split and stacked with no special cases downstream.
 */
export function addTextClip(
  project: Project,
  { trackId, start, style }: { trackId: string; start: number; style?: Partial<TextStyle> },
): { project: Project; clipId: string | null } {
  const track = findTrack(project, trackId);
  if (!track) return { project, clipId: null };

  const text: TextStyle = { ...defaultTextStyle(), ...style };

  const clip: Clip = {
    id: nextId("c"),
    trackId,
    // No media to point at. Every consumer keys off `kind` rather than
    // probing this, so an empty id is never dereferenced.
    mediaId: "",
    // The name follows the words, so the timeline reads like the title looks.
    // It is snapshotted rather than derived so that renaming the clip and
    // editing the text stay independent.
    name: firstLine(text.content),
    kind: "text",
    start: Math.max(0, start),
    duration: DEFAULT_TEXT_DURATION,
    sourceStart: 0,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    speed: 1,
    preservePitch: true,
    filters: [],
    text,
  };

  return { project: { ...project, clips: [...project.clips, clip] }, clipId: clip.id };
}

/** A one-line label for a block of text, for the timeline and the bin. */
export function firstLine(content: string): string {
  const line = content.split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "Text").trim().slice(0, 40) || "Text";
}

/** Registers a font file against the project, ignoring one already added. */
export function addFont(project: Project, font: CustomFont): Project {
  if (project.fonts.some((existing) => existing.path === font.path)) return project;
  return { ...project, fonts: [...project.fonts, font] };
}

/**
 * Forgets a font.
 *
 * Clips already using it keep the family name: the face may come back when the
 * file does, and silently rewriting a title's styling because a list entry was
 * removed would be a worse surprise than a temporary fallback.
 */
export function removeFont(project: Project, family: string): Project {
  return { ...project, fonts: project.fonts.filter((font) => font.family !== family) };
}

/** Moves a clip in time, and optionally to another track of the same kind. */
export function moveClip(
  project: Project,
  clipId: string,
  { start, trackId }: { start: number; trackId?: string },
): Project {
  return {
    ...project,
    clips: project.clips.map((clip) => {
      if (clip.id !== clipId) return clip;
      // Any clip may sit on any track, so the only check is that it exists.
      const target = trackId ? findTrack(project, trackId) : null;
      return { ...clip, start: Math.max(0, start), trackId: target?.id ?? clip.trackId };
    }),
  };
}

/** Trims a clip from one edge, keeping the source content under the other. */
export function trimClip(
  project: Project,
  clipId: string,
  edge: "start" | "end",
  delta: number,
): Project {
  return {
    ...project,
    clips: project.clips.map((clip) => {
      if (clip.id !== clipId) return clip;
      if (edge === "end") {
        return { ...clip, duration: Math.max(MIN_CLIP_DURATION, clip.duration + delta) };
      }
      // Dragging the head moves the in-point too, so the pixels under the
      // remaining part of the clip do not slide.
      const shift = Math.min(delta, clip.duration - MIN_CLIP_DURATION);
      const start = Math.max(0, clip.start + shift);
      const applied = start - clip.start;
      return {
        ...clip,
        start,
        duration: clip.duration - applied,
        sourceStart: Math.max(0, clip.sourceStart + applied),
      };
    }),
  };
}

/** Where one clip is going. */
export interface ClipMove {
  clipId: string;
  start: number;
  trackId: string;
}

/**
 * Moves several clips at once.
 *
 * A single pass rather than repeated `moveClip` calls, so that a multi-clip
 * drag is one new project object per frame instead of one per selected clip.
 */
export function moveClips(project: Project, moves: ClipMove[]): Project {
  if (moves.length === 0) return project;
  const byId = new Map(moves.map((move) => [move.clipId, move]));

  return {
    ...project,
    clips: project.clips.map((clip) => {
      const move = byId.get(clip.id);
      if (!move) return clip;
      const target = findTrack(project, move.trackId);
      return { ...clip, start: Math.max(0, move.start), trackId: target?.id ?? clip.trackId };
    }),
  };
}

/**
 * Changes some of a clip's properties.
 *
 * The generic patch keeps the panel that edits a clip from needing one
 * function per field, while the `Partial<Clip>` type still stops it inventing
 * fields that do not exist.
 */
export function updateClip(project: Project, clipId: string, patch: Partial<Clip>): Project {
  return {
    ...project,
    clips: project.clips.map((clip) => (clip.id === clipId ? { ...clip, ...patch } : clip)),
  };
}

/**
 * A clip's gain at a timeline instant, fades included.
 *
 * Shared between the audio preview and anything else that needs to know how
 * loud a clip is right now, so the two cannot disagree about where a fade
 * reaches full volume.
 */
export function clipGainAt(clip: Clip, time: number): number {
  const local = time - clip.start;
  if (local < 0 || local > clip.duration) return 0;

  let gain = clip.volume;
  if (clip.fadeIn > 0) gain *= Math.min(1, local / clip.fadeIn);
  if (clip.fadeOut > 0) gain *= Math.min(1, (clip.duration - local) / clip.fadeOut);

  return Math.max(0, gain);
}

export function removeClip(project: Project, clipId: string): Project {
  return { ...project, clips: project.clips.filter((clip) => clip.id !== clipId) };
}

export function removeClips(project: Project, clipIds: readonly string[]): Project {
  const doomed = new Set(clipIds);
  return { ...project, clips: project.clips.filter((clip) => !doomed.has(clip.id)) };
}

/** Cuts a clip in two at `time`. Does nothing if the cut misses the clip. */
export function splitClip(project: Project, clipId: string, time: number): Project {
  const clip = findClip(project, clipId);
  if (!clip) return project;

  const offset = time - clip.start;
  if (offset <= MIN_CLIP_DURATION || offset >= clip.duration - MIN_CLIP_DURATION) {
    return project;
  }

  const head: Clip = { ...clip, duration: offset, filters: [...clip.filters] };
  const tail: Clip = {
    ...clip,
    id: nextId("c"),
    start: clip.start + offset,
    duration: clip.duration - offset,
    sourceStart: clip.sourceStart + offset,
    filters: [...clip.filters],
  };

  return {
    ...project,
    clips: project.clips.flatMap((current) => (current.id === clipId ? [head, tail] : [current])),
  };
}

/**
 * Adds a lane on top of the stack.
 *
 * Numbered from the highest number already in use rather than from the track
 * count, so removing Track 2 and adding another does not produce a second
 * Track 3 sitting next to the first.
 */
export function addTrack(project: Project): { project: Project; trackId: string } {
  const highest = project.tracks.reduce((best, track) => {
    const number = Number.parseInt(track.name.replace(/\D+/g, ""), 10);
    return Number.isFinite(number) ? Math.max(best, number) : best;
  }, 0);

  const track: Track = {
    id: nextId("t"),
    name: `Track ${highest + 1}`,
    visible: true,
    muted: false,
  };

  // Appended, and the timeline draws the array reversed, so a new track
  // appears at the top of the stack.
  return { project: { ...project, tracks: [...project.tracks, track] }, trackId: track.id };
}

/**
 * Removes a lane and everything on it.
 *
 * Refuses to remove the last one: a timeline with no tracks has nowhere to
 * drop anything, and recovering from that would need its own undo.
 */
export function removeTrack(project: Project, trackId: string): Project {
  if (project.tracks.length <= 1) return project;
  return {
    ...project,
    tracks: project.tracks.filter((track) => track.id !== trackId),
    clips: project.clips.filter((clip) => clip.trackId !== trackId),
  };
}

/** Renames a lane. An empty or whitespace-only name is ignored. */
export function renameTrack(project: Project, trackId: string, name: string): Project {
  const trimmed = name.trim();
  if (!trimmed) return project;

  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === trackId ? { ...track, name: trimmed } : track,
    ),
  };
}

/** Which clips sit on a track. Used to warn before removing a full one. */
export function clipsOnTrack(project: Project, trackId: string): Clip[] {
  return project.clips.filter((clip) => clip.trackId === trackId);
}

/**
 * How far apart two clips may sit and still count as touching, in seconds.
 *
 * Splitting produces edges that meet exactly, but the numbers have been
 * through float arithmetic on the way, so an exact comparison would
 * occasionally refuse to rejoin a clip it had just cut.
 */
const JOIN_EPSILON = 1e-6;

/**
 * Why these clips cannot be merged, or `null` if they can.
 *
 * Merge is the inverse of split: it rejoins pieces of *one* source that are
 * still lying end to end. It is not a way to weld two different files into a
 * single clip - that is a compound clip, which needs nesting and a render of
 * its own, and pretending otherwise here would produce a clip whose source
 * range means nothing.
 *
 * Returns a sentence, because a disabled button that will not say why is worse
 * than no button.
 */
export function whyNotMerge(project: Project, clipIds: readonly string[]): string | null {
  if (clipIds.length < 2) return "Select two or more clips to merge.";

  const clips = clipIds.flatMap((id) => {
    const clip = findClip(project, id);
    return clip ? [clip] : [];
  });
  if (clips.length < 2) return "Select two or more clips to merge.";

  if (clips.some((clip) => clip.trackId !== clips[0].trackId)) {
    return "Merged clips must be on the same track.";
  }
  if (clips.some((clip) => clip.mediaId !== clips[0].mediaId)) {
    return "Merged clips must come from the same file.";
  }

  const ordered = [...clips].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];

    if (Math.abs(current.start - (previous.start + previous.duration)) > JOIN_EPSILON) {
      return "Merged clips must touch, with no gap or overlap.";
    }
    // The source has to be continuous too. Two halves that were rearranged
    // are adjacent on the timeline but no longer a single run of the file,
    // and joining them would silently change what plays.
    if (
      Math.abs(current.sourceStart - (previous.sourceStart + previous.duration)) > JOIN_EPSILON
    ) {
      return "These pieces are no longer in their original order.";
    }
  }

  return null;
}

/**
 * Rejoins adjacent pieces of one source into a single clip.
 *
 * Does nothing unless [`whyNotMerge`] returns null. The surviving clip keeps
 * the first piece's identity, so a selection referring to it stays valid.
 */
export function mergeClips(
  project: Project,
  clipIds: readonly string[],
): { project: Project; clipId: string | null } {
  if (whyNotMerge(project, clipIds) !== null) return { project, clipId: null };

  const ordered = clipIds
    .flatMap((id) => {
      const clip = findClip(project, id);
      return clip ? [clip] : [];
    })
    .sort((left, right) => left.start - right.start);

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const doomed = new Set(ordered.slice(1).map((clip) => clip.id));

  const merged: Clip = {
    ...first,
    duration: last.start + last.duration - first.start,
    // Gain and fades come from the first piece; the later ones are discarded
    // along with their clips, which is what "these are one clip again" means.
  };

  return {
    project: {
      ...project,
      clips: project.clips
        .filter((clip) => !doomed.has(clip.id))
        .map((clip) => (clip.id === first.id ? merged : clip)),
    },
    clipId: first.id,
  };
}

/**
 * Changes a clip's speed, rescaling its duration to match.
 *
 * The amount of *source* the clip covers is held constant - that is what makes
 * this a speed change rather than a trim. Playing the same material twice as
 * fast means occupying half as much timeline.
 */
export function setClipSpeed(project: Project, clipId: string, speed: number): Project {
  const clip = findClip(project, clipId);
  if (!clip) return project;

  const next = Math.max(0.1, Math.min(8, speed));
  const sourceCovered = clip.duration * clip.speed;

  return updateClip(project, clipId, {
    speed: next,
    duration: Math.max(MIN_CLIP_DURATION, sourceCovered / next),
  });
}

/** Limits, so a clip cannot be scaled or dragged out of reach. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;
const MAX_OFFSET = 3;

/** Moves and resizes a clip's picture, clamped to something recoverable. */
export function setClipTransform(
  project: Project,
  clipId: string,
  transform: Partial<Pick<Clip, "scale" | "offsetX" | "offsetY">>,
): Project {
  const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

  const patch: Partial<Clip> = {};
  if (transform.scale !== undefined) {
    patch.scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, transform.scale));
  }
  if (transform.offsetX !== undefined) patch.offsetX = clamp(transform.offsetX, MAX_OFFSET);
  if (transform.offsetY !== undefined) patch.offsetY = clamp(transform.offsetY, MAX_OFFSET);

  return updateClip(project, clipId, patch);
}

export function setTrackFlag(
  project: Project,
  trackId: string,
  flag: "visible" | "muted",
  value: boolean,
): Project {
  return {
    ...project,
    tracks: project.tracks.map((track) =>
      track.id === trackId ? { ...track, [flag]: value } : track,
    ),
  };
}

/** Where the last clip ends. */
export function projectDuration(project: Project): number {
  return project.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
}

/** Clips under the playhead on tracks that are not disabled. */
export function clipsAt(project: Project, time: number): Clip[] {
  return project.clips.filter((clip) => {
    const track = findTrack(project, clip.trackId);
    if (!track) return false;
    // Stills are picture, so the eye switches them off just like footage.
    if (clip.kind !== "audio" && !track.visible) return false;
    if (clip.kind === "audio" && track.muted) return false;
    return time >= clip.start && time < clip.start + clip.duration;
  });
}

/**
 * The nearest interesting time to `time`, within `threshold` seconds.
 *
 * Snap targets are zero, the playhead, and every clip edge except those of the
 * clip being dragged - snapping a clip to itself would pin it in place.
 */
export function snapTime(
  project: Project,
  time: number,
  { threshold, playhead, exclude }: { threshold: number; playhead: number; exclude?: string },
): number {
  const targets = [0, playhead];
  for (const clip of project.clips) {
    if (clip.id === exclude) continue;
    targets.push(clip.start, clip.start + clip.duration);
  }

  let best = time;
  let bestDistance = threshold;
  for (const target of targets) {
    const distance = Math.abs(target - time);
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}
