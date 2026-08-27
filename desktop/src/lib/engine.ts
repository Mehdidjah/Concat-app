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
  /** Blend strength over the layers beneath, 1 being solid. */
  opacity: number;
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

/**
 * Asks the running export to stop at the next frame. The pending
 * `exportProject` call then rejects with "export cancelled".
 */
export async function cancelExport(): Promise<void> {
  return invoke<void>("cancel_export");
}

/**
 * Writes one file into the project's cache folder and returns its path.
 *
 * The same store the artwork cache uses, so it travels with the project and
 * vanishes with it. Keys are flat filenames; the host refuses anything else.
 */
export async function writeCacheFile(
  project: string,
  key: string,
  bytes: Uint8Array,
): Promise<string> {
  await invoke<void>("write_artwork", { project, key, bytes: Array.from(bytes) });
  return `${project}/cache/${key}`;
}

/** Subscribes to export progress. Resolves to an unsubscribe function. */
export async function onExportProgress(
  handler: (progress: ExportProgress) => void,
): Promise<UnlistenFn> {
  return listen<ExportProgress>("export://progress", (event) => handler(event.payload));
}

// ── transcription ──────────────────────────────────────────────────────────

/** One Whisper model, as the settings panel sees it. */
export interface TranscriberModel {
  id: string;
  label: string;
  blurb: string;
  englishOnly: boolean;
  /** Approximate download size in bytes, for display. */
  sizeBytes: number;
  downloaded: boolean;
}

export interface TranscriberStatus {
  /** Where `whisper-cli` was found, or null when it was not. */
  binary: string | null;
  /** Where models are stored on disk. */
  modelsDir: string;
  models: TranscriberModel[];
}

/** Progress of a model download, via `transcriber://download`. */
export interface TranscriberDownload {
  id: string;
  received: number;
  total: number;
  done: boolean;
}

/** One caption, in seconds relative to the transcribed window's start. */
export interface TranscribedSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscribeRequest {
  path: string;
  /** Seconds into the file where the clip's source window begins. */
  sourceStart: number;
  /** How much source the clip covers, in seconds (`duration * speed`). */
  window: number;
  /** Whisper language code, or "auto". */
  language: string;
  modelId: string;
}

export async function transcriberStatus(): Promise<TranscriberStatus> {
  return invoke<TranscriberStatus>("transcriber_status");
}

/** Remembers a user-chosen `whisper-cli`. Throws if the path is not a file. */
export async function setTranscriberBinary(path: string): Promise<TranscriberStatus> {
  return invoke<TranscriberStatus>("set_transcriber_binary", { path });
}

/** Downloads one model. Resolves when the file is complete and renamed. */
export async function downloadTranscriberModel(id: string): Promise<void> {
  return invoke<void>("download_transcriber_model", { id });
}

export async function cancelModelDownload(): Promise<void> {
  return invoke<void>("cancel_model_download");
}

export async function deleteTranscriberModel(id: string): Promise<void> {
  return invoke<void>("delete_transcriber_model", { id });
}

/** Subscribes to model download progress. Resolves to an unsubscribe function. */
export async function onTranscriberDownload(
  handler: (progress: TranscriberDownload) => void,
): Promise<UnlistenFn> {
  return listen<TranscriberDownload>("transcriber://download", (event) => handler(event.payload));
}

/** Transcribes one clip's audio window. Runs until done or cancelled. */
export async function transcribeClip(
  request: TranscribeRequest,
): Promise<TranscribedSegment[]> {
  return invoke<TranscribedSegment[]>("transcribe_clip", { request });
}

/** Kills the running transcription, if any. */
export async function cancelTranscribe(): Promise<void> {
  return invoke<void>("cancel_transcribe");
}
