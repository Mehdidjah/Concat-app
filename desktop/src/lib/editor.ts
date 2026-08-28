/**
 * The UI's view of the engine-owned edit.
 *
 * The engine (`wolfcut-project`, via the `editor_*` commands) is the model of
 * record: every mutation is an [`EditorCommand`] sent through
 * `lib/engine.ts`, and the state that comes back is the truth. What lives
 * here is everything that is legitimately the UI's:
 *
 * - the TypeScript mirror of the engine's types (field for field - serde on
 *   the other side writes exactly these names),
 * - read-only selectors over that state,
 * - the *gesture echo*: during a drag the UI previews the edit locally with
 *   the same arithmetic the engine will apply, then commits one command on
 *   release. One command per gesture is what keeps undo meaning "undo the
 *   drag", not "undo one pixel of it".
 *
 * No mutation of project state happens in TypeScript outside the echo, and
 * the echo never survives past its commit.
 */

import type { AppliedEffect, ClipTransition } from "./effects";
import type { ClipFilter } from "./filters";
import type { TextStyle } from "./text";

// ── the engine's types, mirrored ─────────────────────────────────────────────

export type MediaKind = "video" | "audio" | "image";
export type ClipKind = MediaKind | "text";

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  duration: number | null;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  frameRateFraction: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  /** True when this item is a template slot awaiting the user's own media.
   * Absent from documents that predate templates, which means false. */
  placeholder?: boolean;
}

export interface Track {
  id: string;
  name: string;
  visible: boolean;
  muted: boolean;
}

export interface Clip {
  id: string;
  trackId: string;
  mediaId: string;
  name: string;
  kind: ClipKind;
  start: number;
  duration: number;
  sourceStart: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  opacity: number;
  speed: number;
  preservePitch: boolean;
  filters: ClipFilter[];
  videoEffects: AppliedEffect[];
  muted?: boolean;
  detachedFrom?: string;
  transitionIn?: ClipTransition;
  text?: TextStyle;
}

export interface TimelineData {
  id: string;
  name: string;
  tracks: Track[];
  clips: Clip[];
}

/** A timeline's identity, for the tab strip. */
export type TimelineMeta = Pick<TimelineData, "id" | "name">;

/** Transform limits, shared with the preview gizmo. The engine clamps too. */
export const MIN_SCALE = 0.05;
export const MAX_SCALE = 8;

export interface CustomFont {
  family: string;
  path: string;
  /** UI-only: a load attempt failed. Never sent to or from the engine. */
  missing?: boolean;
}

export interface EditorProject {
  media: MediaItem[];
  fonts: CustomFont[];
  timelines: TimelineData[];
  activeTimelineId: string;
}

export interface EditorSettings {
  name: string;
  width: number;
  height: number;
  rateNum: number;
  rateDen: number;
}

/** What every editor call returns: the authoritative state. */
export interface EditorView {
  project: EditorProject;
  canUndo: boolean;
  canRedo: boolean;
  settings: EditorSettings;
  createdId?: string;
}

// ── commands: the whole edit vocabulary ──────────────────────────────────────

/** A partial clip update. `null` clears `transitionIn`/`text`; absent leaves
 * a field untouched - the wire distinction the engine's double-options keep. */
export interface ClipPatch {
  name?: string;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
  opacity?: number;
  preservePitch?: boolean;
  filters?: ClipFilter[];
  videoEffects?: AppliedEffect[];
  transitionIn?: ClipTransition | null;
  text?: TextStyle | null;
}

export interface ClipMove {
  clipId: string;
  start: number;
  trackId: string;
}

export interface NewMedia {
  path: string;
  name: string;
  duration: number | null;
  kind: MediaKind;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  frameRateFraction: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

export type EditorCommand =
  | { op: "addMedia"; item: NewMedia }
  | { op: "removeMedia"; mediaId: string }
  | { op: "setMediaPlaceholder"; mediaId: string; placeholder: boolean }
  | { op: "fillSlot"; mediaId: string; item: NewMedia }
  | { op: "batch"; commands: EditorCommand[] }
  | { op: "addClip"; mediaId: string; trackId: string; start: number }
  | { op: "addClipAtFirstFree"; mediaId: string; start: number }
  | {
      op: "addTextClip";
      trackId: string | null;
      start: number;
      style: TextStyle | null;
      /** Seconds on the timeline; the editorial default when absent. Lets a
       * caption run land as one batch - a batch cannot trim ids it cannot
       * know yet. */
      duration?: number;
      /** Vertical placement as a frame-height fraction; lower thirds. */
      offsetY?: number;
    }
  | { op: "moveClips"; moves: ClipMove[] }
  | { op: "trimClip"; clipId: string; edge: "start" | "end"; delta: number }
  | { op: "splitClips"; clipIds: string[]; time: number }
  | { op: "mergeClips"; clipIds: string[] }
  | { op: "removeClips"; clipIds: string[] }
  | { op: "updateClip"; clipId: string; patch: ClipPatch }
  | { op: "setClipSpeed"; clipId: string; speed: number }
  | {
      op: "setClipTransform";
      clipId: string;
      scale?: number;
      offsetX?: number;
      offsetY?: number;
      rotation?: number;
    }
  | { op: "detachAudio"; clipId: string }
  | { op: "reattachAudio"; clipId: string }
  | { op: "addTrack" }
  | { op: "removeTrack"; trackId: string }
  | { op: "renameTrack"; trackId: string; name: string }
  | { op: "setTrackFlag"; trackId: string; flag: "visible" | "muted"; value: boolean }
  | { op: "addTimeline" }
  | { op: "removeTimeline"; timelineId: string }
  | { op: "renameTimeline"; timelineId: string; name: string }
  | { op: "selectTimeline"; timelineId: string }
  | { op: "addFont"; family: string; path: string }
  | { op: "removeFont"; family: string };

// ── selectors ────────────────────────────────────────────────────────────────

export function activeTimeline(project: EditorProject): TimelineData {
  return (
    project.timelines.find((timeline) => timeline.id === project.activeTimelineId) ??
    project.timelines[0]
  );
}

export function findClip(project: EditorProject, clipId: string): Clip | null {
  return activeTimeline(project).clips.find((clip) => clip.id === clipId) ?? null;
}

export function findTrack(project: EditorProject, trackId: string): Track | null {
  return activeTimeline(project).tracks.find((track) => track.id === trackId) ?? null;
}

export function findMedia(project: EditorProject, mediaId: string): MediaItem | null {
  return project.media.find((item) => item.id === mediaId) ?? null;
}

/** Where the last clip of the active timeline ends. */
export function projectDuration(project: EditorProject): number {
  return activeTimeline(project).clips.reduce(
    (end, clip) => Math.max(end, clip.start + clip.duration),
    0,
  );
}

/** Clips under the playhead on tracks that are not disabled. */
export function clipsAt(project: EditorProject, time: number): Clip[] {
  const timeline = activeTimeline(project);
  return timeline.clips.filter((clip) => {
    const track = timeline.tracks.find((candidate) => candidate.id === clip.trackId);
    if (!track) return false;
    if (clip.kind !== "audio" && !track.visible) return false;
    if (clip.kind === "audio" && track.muted) return false;
    return time >= clip.start && time < clip.start + clip.duration;
  });
}

/** The audio clips holding sound detached from this video clip, if any. */
export function detachedAudioOf(project: EditorProject, videoClipId: string): Clip[] {
  return activeTimeline(project).clips.filter((clip) => clip.detachedFrom === videoClipId);
}

/**
 * The clip that ends exactly where this one starts, on the same track - what
 * a transition needs to exist. Whole-frame tolerance, matching the engine's
 * exporter-side adjacency test.
 */
export function precedingClip(project: EditorProject, clipId: string): Clip | null {
  const timeline = activeTimeline(project);
  const clip = timeline.clips.find((candidate) => candidate.id === clipId);
  if (!clip) return null;
  return (
    timeline.clips.find(
      (other) =>
        other.id !== clip.id &&
        other.trackId === clip.trackId &&
        other.kind !== "audio" &&
        Math.abs(other.start + other.duration - clip.start) < 1 / 60,
    ) ?? null
  );
}

/** How many clips a timeline holds. For the delete prompt. */
export function timelineClipCount(project: EditorProject, timelineId: string): number {
  return project.timelines.find((timeline) => timeline.id === timelineId)?.clips.length ?? 0;
}

const JOIN_EPSILON = 1e-6;

/**
 * Why these clips cannot be merged, or null if they can - the UI's read-only
 * twin of the engine's own check, for the disabled button's tooltip. The
 * engine re-validates on the command; this only phrases the reason early.
 */
export function whyNotMerge(project: EditorProject, clipIds: readonly string[]): string | null {
  if (clipIds.length < 2) return "Select two or more clips to merge.";
  const timeline = activeTimeline(project);
  const clips = clipIds.flatMap((id) => {
    const clip = timeline.clips.find((candidate) => candidate.id === id);
    return clip ? [clip] : [];
  });
  if (clips.length < 2) return "Select two or more clips to merge.";
  if (clips.some((clip) => clip.trackId !== clips[0].trackId)) {
    return "Merged clips must be on the same track.";
  }
  if (clips.some((clip) => clip.mediaId !== clips[0].mediaId)) {
    return "Merged clips must come from the same file.";
  }
  if (clips.some((clip) => clip.speed !== clips[0].speed)) {
    return "Merged clips must play at the same speed.";
  }
  const ordered = [...clips].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (Math.abs(current.start - (previous.start + previous.duration)) > JOIN_EPSILON) {
      return "Merged clips must touch, with no gap or overlap.";
    }
    if (
      Math.abs(
        current.sourceStart - (previous.sourceStart + previous.duration * previous.speed),
      ) > JOIN_EPSILON
    ) {
      return "These pieces are no longer in their original order.";
    }
  }
  return null;
}

/**
 * The nearest interesting time to `time`, within `threshold` seconds. Pure
 * view logic: snapping decides what the gesture *proposes*, the engine only
 * ever sees the snapped result.
 */
export function snapTime(
  project: EditorProject,
  time: number,
  { threshold, playhead, exclude }: { threshold: number; playhead: number; exclude?: string },
): number {
  const targets = [0, playhead];
  for (const clip of activeTimeline(project).clips) {
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

// ── the gesture echo ─────────────────────────────────────────────────────────

/** Transient per-clip patches shown during a gesture, keyed by clip id. */
export type Echo = Record<string, Partial<Clip>>;

/** The project as the monitor and timeline should draw it mid-gesture. */
export function withEcho(project: EditorProject, echo: Echo | null): EditorProject {
  if (!echo || Object.keys(echo).length === 0) return project;
  return {
    ...project,
    timelines: project.timelines.map((timeline) =>
      timeline.id === project.activeTimelineId
        ? {
            ...timeline,
            clips: timeline.clips.map((clip) =>
              echo[clip.id] ? { ...clip, ...echo[clip.id] } : clip,
            ),
          }
        : timeline,
    ),
  };
}

const MIN_CLIP_DURATION = 1 / 60;

/** The trim arithmetic, identical to the engine's, for the live echo. */
export function trimPatch(clip: Clip, edge: "start" | "end", delta: number): Partial<Clip> {
  if (edge === "end") {
    return { duration: Math.max(MIN_CLIP_DURATION, clip.duration + delta) };
  }
  const shift = Math.min(delta, clip.duration - MIN_CLIP_DURATION);
  const start = Math.max(0, clip.start + shift);
  const applied = start - clip.start;
  return {
    start,
    duration: clip.duration - applied,
    sourceStart: Math.max(0, clip.sourceStart + applied * clip.speed),
  };
}

/** The speed arithmetic, identical to the engine's, for the live echo. */
export function speedPatch(clip: Clip, speed: number): Partial<Clip> {
  const next = Math.max(0.0625, Math.min(16, speed));
  const sourceCovered = clip.duration * clip.speed;
  return { speed: next, duration: Math.max(MIN_CLIP_DURATION, sourceCovered / next) };
}

/** The transform clamps, identical to the engine's, for the live echo. */
export function transformPatch(
  patch: Partial<Pick<Clip, "scale" | "offsetX" | "offsetY" | "rotation">>,
): Partial<Clip> {
  const clamped: Partial<Clip> = {};
  if (patch.scale !== undefined) clamped.scale = Math.max(0.05, Math.min(8, patch.scale));
  if (patch.offsetX !== undefined) clamped.offsetX = Math.max(-3, Math.min(3, patch.offsetX));
  if (patch.offsetY !== undefined) clamped.offsetY = Math.max(-3, Math.min(3, patch.offsetY));
  if (patch.rotation !== undefined) {
    const wrapped = ((patch.rotation % 360) + 540) % 360 - 180;
    clamped.rotation = wrapped === -180 ? 180 : wrapped;
  }
  return clamped;
}

/**
 * Turns one clip's accumulated echo into the command(s) that make it real.
 *
 * A gesture touches one family of fields, so this usually yields exactly one
 * command; the ordering (speed, then transform, then move/trim, then the
 * patch) only matters for mixed accumulations from a busy panel.
 */
export function commandsForEcho(base: Clip, patch: Partial<Clip>): EditorCommand[] {
  const commands: EditorCommand[] = [];
  const has = (key: keyof Clip) => key in patch;

  if (has("speed") && patch.speed !== undefined) {
    commands.push({ op: "setClipSpeed", clipId: base.id, speed: patch.speed });
  }

  if (has("scale") || has("offsetX") || has("offsetY") || has("rotation")) {
    commands.push({
      op: "setClipTransform",
      clipId: base.id,
      ...(has("scale") ? { scale: patch.scale } : {}),
      ...(has("offsetX") ? { offsetX: patch.offsetX } : {}),
      ...(has("offsetY") ? { offsetY: patch.offsetY } : {}),
      ...(has("rotation") ? { rotation: patch.rotation } : {}),
    });
  }

  const durationChanged =
    !has("speed") && has("duration") && patch.duration !== undefined
      ? patch.duration !== base.duration
      : false;
  const startChanged = has("start") && patch.start !== undefined && patch.start !== base.start;

  if (durationChanged && startChanged) {
    commands.push({
      op: "trimClip",
      clipId: base.id,
      edge: "start",
      delta: (patch.start ?? base.start) - base.start,
    });
  } else if (durationChanged) {
    commands.push({
      op: "trimClip",
      clipId: base.id,
      edge: "end",
      delta: (patch.duration ?? base.duration) - base.duration,
    });
  } else if (startChanged || has("trackId")) {
    commands.push({
      op: "moveClips",
      moves: [
        {
          clipId: base.id,
          start: patch.start ?? base.start,
          trackId: patch.trackId ?? base.trackId,
        },
      ],
    });
  }

  const update: ClipPatch = {};
  if (has("name") && patch.name !== undefined) update.name = patch.name;
  if (has("volume") && patch.volume !== undefined) update.volume = patch.volume;
  if (has("fadeIn") && patch.fadeIn !== undefined) update.fadeIn = patch.fadeIn;
  if (has("fadeOut") && patch.fadeOut !== undefined) update.fadeOut = patch.fadeOut;
  if (has("opacity") && patch.opacity !== undefined) update.opacity = patch.opacity;
  if (has("preservePitch") && patch.preservePitch !== undefined) {
    update.preservePitch = patch.preservePitch;
  }
  if (has("filters") && patch.filters !== undefined) update.filters = patch.filters;
  if (has("videoEffects") && patch.videoEffects !== undefined) {
    update.videoEffects = patch.videoEffects;
  }
  // Key present with undefined means "clear" for the two clearable fields.
  if (has("transitionIn")) update.transitionIn = patch.transitionIn ?? null;
  if (has("text")) update.text = patch.text ?? null;
  if (Object.keys(update).length > 0) {
    commands.push({ op: "updateClip", clipId: base.id, patch: update });
  }

  return commands;
}
