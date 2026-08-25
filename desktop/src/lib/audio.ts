/**
 * Audio preview.
 *
 * This is what makes an mp3 on the timeline actually audible. It is a
 * *preview* path, not the engine's mixer: one `HTMLAudioElement` per audio
 * clip, kept roughly in step with the transport clock.
 *
 * Why the webview and not Rust: real-time audio needs a callback-driven output
 * device (cpal), a resampler, and a mixer that can survive the UI thread
 * stalling. That is a genuine piece of engineering and it belongs in the
 * engine. Until it exists, the webview already has a decoder and an output
 * device, and using them is the difference between hearing your edit and not.
 *
 * The known limits, so nobody mistakes this for the finished thing:
 *   - Sync is corrective, not sample-accurate. Drift beyond a tolerance is
 *     fixed by reseeking, which is audible if it happens often.
 *   - No mixing. Overlapping clips play simultaneously and clip if loud.
 *   - No effects, no fades, no per-clip gain automation.
 *   - Scrubbing does not scrub audio, it repositions it.
 *
 * See docs/decisions/0004-audio-preview-in-the-webview.md.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

import { readMediaBytes } from "./engine";

/** One audio clip that should be sounding right now. */
export interface Voice {
  clipId: string;
  path: string;
  /** Where in the source file the playhead currently sits, in seconds. */
  time: number;
  volume: number;
}

/**
 * How far out of step a voice may drift before it is reseeked.
 *
 * Generous while playing: a reseek is an audible click, and browsers do not
 * keep a media element perfectly locked to an external clock anyway. Tight
 * while paused, where "seek" is the entire operation and there is no click to
 * worry about.
 */
const TOLERANCE_PLAYING = 0.3;
const TOLERANCE_PAUSED = 0.02;

interface Loaded {
  element: HTMLAudioElement;
  /** Set when we fell back to a blob, so it can be revoked on dispose. */
  objectUrl?: string;
  /** Guards against retrying the blob fallback in a loop. */
  triedFallback: boolean;
}

export class AudioPreview {
  private voices = new Map<string, Loaded>();

  /**
   * Brings the audio output in line with the transport.
   *
   * Call this whenever the playhead, the play state, or the set of audible
   * clips changes. It is idempotent - calling it every animation frame is fine
   * and is in fact how drift gets corrected.
   */
  sync(active: Voice[], playing: boolean): void {
    const wanted = new Set(active.map((voice) => voice.clipId));

    // Silence anything that has fallen out from under the playhead.
    for (const [clipId, loaded] of this.voices) {
      if (!wanted.has(clipId) && !loaded.element.paused) {
        loaded.element.pause();
      }
    }

    const tolerance = playing ? TOLERANCE_PLAYING : TOLERANCE_PAUSED;

    for (const voice of active) {
      const loaded = this.load(voice.clipId, voice.path);
      const element = loaded.element;
      element.volume = Math.max(0, Math.min(1, voice.volume));

      // readyState 0 means metadata has not arrived; setting currentTime now
      // throws in some engines and is silently discarded in others.
      if (element.readyState > 0 && Math.abs(element.currentTime - voice.time) > tolerance) {
        try {
          element.currentTime = Math.max(0, voice.time);
        } catch {
          // Seeking an element that is still opening is not an error worth
          // surfacing; the next sync will land it.
        }
      }

      if (playing) {
        if (element.paused) {
          // Rejects when the element is not ready or autoplay is refused.
          // Either way the next sync retries, so there is nothing to handle.
          void element.play().catch(() => undefined);
        }
      } else if (!element.paused) {
        element.pause();
      }
    }
  }

  /** Stops everything, e.g. when the transport stops. */
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
    // Nothing here is a user-facing media player; the element exists only as a
    // decoder and an output. Keep it out of the document.
    element.src = convertFileSrc(path);

    const loaded: Loaded = { element, triedFallback: false };
    this.voices.set(clipId, loaded);

    // The asset protocol is the good path: it streams and it seeks. If it is
    // unavailable - scope misconfigured, protocol disabled - fall back to
    // pulling the bytes through the engine and playing a blob. Slower and
    // memory-hungry, but it means audio works rather than silently not.
    element.addEventListener("error", () => {
      if (loaded.triedFallback) return;
      loaded.triedFallback = true;
      void this.loadViaBlob(loaded, path);
    });

    return loaded;
  }

  private async loadViaBlob(loaded: Loaded, path: string): Promise<void> {
    try {
      const bytes = await readMediaBytes(path);
      const url = URL.createObjectURL(new Blob([bytes]));
      loaded.objectUrl = url;
      loaded.element.src = url;
      loaded.element.load();
    } catch (cause) {
      console.error(`Relay: could not load audio for ${path}`, cause);
    }
  }
}
