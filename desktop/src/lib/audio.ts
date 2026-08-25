/**
 * Audio preview.
 *
 * Each audible clip gets a media element for decoding, routed through a Web
 * Audio `GainNode` for level. The gain node is the whole reason this is not
 * just `element.volume`: that property is hard-capped at 1.0 by every browser,
 * so a boost could not be previewed at all - it could only be promised and
 * applied later at export, which is a useless thing to tell someone mixing.
 * A `GainNode` has no ceiling, so what you hear is what gets rendered.
 *
 * Audio is loaded as a blob rather than through the asset protocol, and that
 * is deliberate too. `createMediaElementSource` on a cross-origin element
 * yields *silence* with no error - the element plays, the graph outputs
 * nothing. A blob URL is same-origin, so the graph is guaranteed to work. The
 * cost is holding the file in memory, which we already do for the waveform.
 *
 * The known limits, so nobody mistakes this for a finished mixer:
 *   - Sync is corrective, not sample-accurate. Drift past a tolerance is
 *     fixed by reseeking, which is audible when it happens.
 *   - No effects and no automation beyond the clip's constant gain and fades.
 *   - Scrubbing repositions audio, it does not scrub it.
 *
 * See docs/decisions/0004-audio-preview-in-the-webview.md.
 */

import { readMediaBytes } from "./engine";

/** One audio clip that should be sounding right now. */
export interface Voice {
  clipId: string;
  path: string;
  /** Where in the source file the playhead currently sits, in seconds. */
  time: number;
  /** Linear gain, fades already applied. May exceed 1. */
  volume: number;
}

/**
 * How far out of step a voice may drift before it is reseeked.
 *
 * Generous while playing: a reseek is an audible click, and browsers do not
 * keep a media element perfectly locked to an external clock anyway. Tight
 * while paused, where "seek" is the entire operation.
 */
const TOLERANCE_PLAYING = 0.3;
const TOLERANCE_PAUSED = 0.02;

let sharedContext: AudioContext | null = null;

/** The one AudioContext. Browsers cap how many a page may create. */
export function audioContext(): AudioContext {
  sharedContext ??= new AudioContext();
  return sharedContext;
}

/**
 * A context created before any user interaction starts suspended. Resuming is
 * safe to call repeatedly and only does anything the first time.
 */
function wake(): void {
  const context = audioContext();
  if (context.state === "suspended") void context.resume().catch(() => undefined);
}

// One source node per element, forever: calling createMediaElementSource twice
// on the same element throws, and there is no way to undo the first call.
const routed = new WeakMap<HTMLMediaElement, GainNode>();

/**
 * Routes a media element through a gain node and returns it.
 *
 * Shared with the video preview, so picture and sound obey the same clip gain
 * through the same graph.
 */
export function connectElement(element: HTMLMediaElement): GainNode {
  const existing = routed.get(element);
  if (existing) return existing;

  const context = audioContext();
  const gain = context.createGain();
  context.createMediaElementSource(element).connect(gain);
  gain.connect(context.destination);
  routed.set(element, gain);
  return gain;
}

interface Loaded {
  element: HTMLAudioElement;
  gain: GainNode;
  objectUrl?: string;
  loading: boolean;
}

export class AudioPreview {
  private voices = new Map<string, Loaded>();

  /**
   * Brings the audio output in line with the transport.
   *
   * Idempotent - calling it every animation frame is fine, and is in fact how
   * drift gets corrected.
   */
  sync(active: Voice[], playing: boolean): void {
    if (playing) wake();

    const wanted = new Set(active.map((voice) => voice.clipId));
    for (const [clipId, loaded] of this.voices) {
      if (!wanted.has(clipId) && !loaded.element.paused) loaded.element.pause();
    }

    const tolerance = playing ? TOLERANCE_PLAYING : TOLERANCE_PAUSED;

    for (const voice of active) {
      const loaded = this.load(voice.clipId, voice.path);
      const element = loaded.element;

      // No clamp. A boost is meant to be audible.
      loaded.gain.gain.value = Math.max(0, voice.volume);

      // readyState 0 means metadata has not arrived; setting currentTime then
      // throws in some engines and is discarded in others.
      if (element.readyState > 0 && Math.abs(element.currentTime - voice.time) > tolerance) {
        try {
          element.currentTime = Math.max(0, voice.time);
        } catch {
          // Still opening; the next sync lands it.
        }
      }

      if (playing) {
        if (element.paused) void element.play().catch(() => undefined);
      } else if (!element.paused) {
        element.pause();
      }
    }
  }

  stopAll(): void {
    for (const loaded of this.voices.values()) loaded.element.pause();
  }

  /** Drops a voice, for instance when its clip is deleted. */
  release(clipId: string): void {
    const loaded = this.voices.get(clipId);
    if (!loaded) return;

    loaded.element.pause();
    loaded.element.removeAttribute("src");
    loaded.element.load();
    loaded.gain.disconnect();
    if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
    this.voices.delete(clipId);
  }

  dispose(): void {
    for (const clipId of [...this.voices.keys()]) this.release(clipId);
  }

  private load(clipId: string, path: string): Loaded {
    const existing = this.voices.get(clipId);
    if (existing) return existing;

    const element = new Audio();
    element.preload = "auto";

    const loaded: Loaded = { element, gain: connectElement(element), loading: true };
    this.voices.set(clipId, loaded);

    // Source arrives asynchronously; until then the element is silent and the
    // sync pass above simply has nothing to play, which is correct.
    void readMediaBytes(path)
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes]));
        loaded.objectUrl = url;
        loaded.element.src = url;
        loaded.element.load();
      })
      .catch((cause) => console.error(`Relay: could not load audio for ${path}`, cause))
      .finally(() => {
        loaded.loading = false;
      });

    return loaded;
  }
}
