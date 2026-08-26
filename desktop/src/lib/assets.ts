/**
 * Clip artwork: waveforms for audio, filmstrips for video.
 *
 * Both are expensive to produce and never change, so they are computed once
 * per media item and cached in a plain mutable `Map`. The timeline reads that
 * map directly from inside its draw loop, which means artwork appearing does
 * not require a React render - the next frame simply has it.
 *
 * Everything here fails soft. A file whose peaks cannot be decoded draws as a
 * flat clip, which is exactly what it looked like before, rather than taking
 * the timeline down with it.
 */

import { invoke } from "@tauri-apps/api/core";

import { readMediaBytes } from "./engine";

/** Min/max sample pairs, bucketed at a fixed rate. */
export interface Peaks {
  min: Float32Array;
  max: Float32Array;
  /** How many buckets cover one second of audio. */
  bucketsPerSecond: number;
}

export interface MediaAssets {
  peaks: Map<string, Peaks>;
  /** A horizontal strip of evenly spaced frames, as one decoded image. */
  strips: Map<string, ImageBitmap>;
  /** How many frames are in each strip. */
  stripFrames: Map<string, number>;
  /** Guards against starting the same work twice. */
  pending: Set<string>;
  /** Notified when anything lands, for views that do not redraw continuously. */
  listeners: Set<() => void>;
}

export function createAssets(): MediaAssets {
  return {
    peaks: new Map(),
    strips: new Map(),
    stripFrames: new Map(),
    pending: new Set(),
    listeners: new Set(),
  };
}

/**
 * Subscribes to artwork arriving. Returns an unsubscribe function.
 *
 * The timeline does not need this - it repaints every frame regardless - but
 * anything that draws once and then sits there, like a bin thumbnail, does.
 */
export function subscribeAssets(assets: MediaAssets, listener: () => void): () => void {
  assets.listeners.add(listener);
  return () => assets.listeners.delete(listener);
}

function announce(assets: MediaAssets): void {
  for (const listener of assets.listeners) listener();
}

/**
 * Resolution of the cached waveform.
 *
 * 200 buckets per second is roughly two buckets per pixel at the default zoom,
 * which is enough that the drawn shape does not visibly change as you zoom in
 * a step or two, without storing the whole decoded file.
 */
const BUCKETS_PER_SECOND = 200;

/** Frames per filmstrip. Enough to read the shot, few enough to stay cheap. */
const STRIP_FRAMES = 24;
const STRIP_HEIGHT = 72;

/**
 * Starts producing artwork for one media item if it is not already cached.
 *
 * Fire and forget - the caller does not await this. Results land in the maps
 * and the timeline picks them up on its next frame.
 */
export function requestAssets(
  assets: MediaAssets,
  media: {
    id: string;
    path: string;
    kind: "video" | "audio" | "image";
    duration: number | null;
  },
): void {
  if (assets.pending.has(media.id)) return;
  if (assets.peaks.has(media.id) || assets.strips.has(media.id)) return;

  assets.pending.add(media.id);

  const work =
    media.kind === "audio"
      ? loadPeaks(media.path).then((peaks) => {
          if (peaks) assets.peaks.set(media.id, peaks);
        })
      : media.kind === "image"
        ? // A still is a one-frame filmstrip. Storing it that way means the
          // timeline and the bin draw it with the code they already have, and
          // a long still clip tiles the same frame instead of stretching it.
          loadImage(media.path).then((bitmap) => {
            if (bitmap) {
              assets.strips.set(media.id, bitmap);
              assets.stripFrames.set(media.id, 1);
            }
          })
        : loadStrip(media.path, media.duration).then((strip) => {
            if (strip) {
              assets.strips.set(media.id, strip);
              assets.stripFrames.set(media.id, STRIP_FRAMES);
            }
          });

  void work.finally(() => {
    assets.pending.delete(media.id);
    announce(assets);
  });
}

/** Decodes a file and reduces it to min/max pairs. */
async function loadPeaks(path: string): Promise<Peaks | null> {
  try {
    const bytes = await readMediaBytes(path);

    // An OfflineAudioContext decodes without opening an output device, which
    // matters because this runs at import time with no user gesture behind it.
    const context = new OfflineAudioContext(1, 1, 44100);
    const buffer = await context.decodeAudioData(bytes);

    const samples = buffer.getChannelData(0);
    const bucketSize = Math.max(1, Math.floor(buffer.sampleRate / BUCKETS_PER_SECOND));
    const bucketCount = Math.ceil(samples.length / bucketSize);

    const min = new Float32Array(bucketCount);
    const max = new Float32Array(bucketCount);

    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const from = bucket * bucketSize;
      const to = Math.min(from + bucketSize, samples.length);

      let low = 0;
      let high = 0;
      for (let index = from; index < to; index += 1) {
        const sample = samples[index];
        if (sample < low) low = sample;
        if (sample > high) high = sample;
      }
      min[bucket] = low;
      max[bucket] = high;
    }

    return { min, max, bucketsPerSecond: buffer.sampleRate / bucketSize };
  } catch (cause) {
    console.warn(`WolfCut: no waveform for ${path}`, cause);
    return null;
  }
}

/** Decodes a still. No ffmpeg involved - the browser already reads these. */
async function loadImage(path: string): Promise<ImageBitmap | null> {
  try {
    const bytes = await readMediaBytes(path);
    return await createImageBitmap(new Blob([bytes]));
  } catch (cause) {
    console.warn(`WolfCut: could not decode ${path}`, cause);
    return null;
  }
}

/** Asks the engine for a strip of frames and decodes it into an ImageBitmap. */
async function loadStrip(path: string, duration: number | null): Promise<ImageBitmap | null> {
  if (!duration || duration <= 0) return null;

  try {
    const bytes = await invoke<ArrayBuffer>("extract_filmstrip", {
      path,
      count: STRIP_FRAMES,
      height: STRIP_HEIGHT,
    });
    // createImageBitmap decodes off the main thread, so a slow JPEG does not
    // stall the timeline.
    return await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  } catch (cause) {
    console.warn(`WolfCut: no filmstrip for ${path}`, cause);
    return null;
  }
}
