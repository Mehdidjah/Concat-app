/**
 * The typed boundary between the UI and the Rust engine.
 *
 * Every `invoke` in this app goes through this file. Nothing else imports
 * `@tauri-apps/api/core` for commands, so when a command's shape changes there
 * is exactly one place to fix and the compiler finds every call site.
 *
 * The types here mirror the serde structs in `src-tauri/src/lib.rs`. Keep them
 * in step - the IPC boundary is JSON, so TypeScript cannot check it for you.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface VideoStreamInfo {
  index: number;
  codec: string;
  width: number;
  height: number;
  /** Frames per second as a decimal, for display only. */
  frameRate: number;
  /** The exact fraction, e.g. "30000/1001". The engine works in these. */
  frameRateFraction: string;
}

export interface AudioStreamInfo {
  index: number;
  codec: string;
  sampleRate: number;
  channels: number;
}

export interface MediaSummary {
  path: string;
  /** Seconds, or null when the container does not say. Always null for stills. */
  duration: number | null;
  /** Decided by the host, which sees the extension as well as the streams. */
  kind: "video" | "audio" | "image";
  video: VideoStreamInfo | null;
  audio: AudioStreamInfo | null;
}

/** Asks the engine what is inside a media file. Throws with FFmpeg's message. */
export async function probeMedia(path: string): Promise<MediaSummary> {
  return invoke<MediaSummary>("probe_media", { path });
}

/** Reports the app version the UI is talking to. */
export async function engineVersion(): Promise<string> {
  return invoke<string>("engine_version");
}

/**
 * Reads a whole file into memory as bytes.
 *
 * Only used as the audio fallback when the asset protocol is unavailable - see
 * `lib/audio.ts`. It loads the entire file, so do not reach for it as a
 * general-purpose reader.
 */
export async function readMediaBytes(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("read_media_bytes", { path });
}


/** A project on disk, as the launch screen sees it. */
export interface ProjectInfo {
  path: string;
  name: string;
  width: number;
  height: number;
  rateNum: number;
  rateDen: number;
  /** Milliseconds since the epoch. */
  openedAt: number;
}

/**
 * Creates the project folder and writes its manifest.
 *
 * The returned path may differ from `location/name`, because the name has to
 * be made filesystem-safe first.
 */
export async function createProject(request: {
  location: string;
  name: string;
  width: number;
  height: number;
  rateNum: number;
  rateDen: number;
}): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("create_project", request);
}

/** Reads an existing project's settings and marks it as recently opened. */
export async function openProject(path: string): Promise<ProjectInfo> {
  return invoke<ProjectInfo>("open_project", { path });
}

/** Writes the whole project document to the project folder. */
export async function saveProject(path: string, document: unknown): Promise<void> {
  return invoke<void>("save_project", { path, document });
}

/** Reads the whole project document back. */
export async function loadProject(path: string): Promise<unknown> {
  return invoke<unknown>("load_project", { path });
}

/** Recently opened projects, newest first, with vanished folders left out. */
export async function recentProjects(): Promise<ProjectInfo[]> {
  return invoke<ProjectInfo[]>("recent_projects");
}

/** Drops a project from the recents list. The folder itself is untouched. */
export async function forgetProject(path: string): Promise<void> {
  return invoke<void>("forget_project", { path });
}

/** One clip, flattened for the exporter. */
export interface ExportClip {
  path: string;
  kind: "video" | "audio" | "image";
  start: number;
  duration: number;
  sourceStart: number;
  /** Index into the track stack, zero being bottom-most. */
  track: number;
  hidden: boolean;
  muted: boolean;
  /** Linear gain, 1 being unity. */
  volume: number;
  fadeIn: number;
  fadeOut: number;
  /** FFmpeg filter chain, or empty for none. */
  filterChain: string;
  /** Playback rate, 1 being normal. */
  speed: number;
  preservePitch: boolean;
  /** Multiplier over the fitted size. 1 fills the frame, preserving aspect. */
  scale: number;
  /** Offset of the picture's centre from frame centre, frame-width fraction. */
  offsetX: number;
  /** Offset as a frame-height fraction. */
  offsetY: number;
  /** Clockwise rotation in degrees. */
  rotation: number;
  /** The source's pixel size, when known - what makes an aspect-correct fit possible. */
  mediaWidth: number | null;
  mediaHeight: number | null;
}

export interface ExportRequest {
  output: string;
  width: number;
  height: number;
  /** Exact frame rate. Never send a rounded decimal here. */
  rateNum: number;
  rateDen: number;
  crf: number;
  preset: string;
  clips: ExportClip[];
}

export interface ExportProgress {
  frame: number;
  total: number;
  stage: string;
}

/** Renders the timeline. Resolves with the path written. */
export async function exportProject(request: ExportRequest): Promise<string> {
  return invoke<string>("export_project", { request });
}

/** Subscribes to export progress. Resolves to an unsubscribe function. */
export async function onExportProgress(
  handler: (progress: ExportProgress) => void,
): Promise<UnlistenFn> {
  return listen<ExportProgress>("export://progress", (event) => handler(event.payload));
}
