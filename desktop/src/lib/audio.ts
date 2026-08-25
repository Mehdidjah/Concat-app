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

import { readMediaBytes, renderFilteredAudio } from "./engine";

/** One audio clip that should be sounding right now. */
export interface Voice {
  clipId: string;
  path: string;
  /** Where in the source file the playhead currently sits, in seconds. */
  time: number;
  /** Linear gain, fades already applied. May exceed 1. */
  volume: number;
  /** Playback rate. */
  speed: number;
  /** False lets pitch rise with speed, like tape. */
  preservePitch: boolean;
  /**
   * A filtered render of this clip, when it has filters.
   *
   * The rendered audio begins at the clip's in-point rather than the file's,
   * so a position inside it is offset by `sourceStart`.
   */
  filter?: {
    /** Identity of this exact render. A change means re-render. */
    key: string;
    chain: string;
    sourceStart: number;
    duration: number;
  };
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

/**
 * How long the filter settings must hold still before re-rendering.
 *
 * Without this, every step of a slider drag spawned an FFmpeg process and tore
 * down the audio element mid-playback - dozens of renders for one gesture, and
 * audio that cut out while you were trying to hear what you were adjusting.
 */
const RENDER_DEBOUNCE_MS = 400;

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
  /** Which render this element holds; undefined means the unfiltered file. */
  key?: string;
  /** How far into the file this element's audio begins. */
  offset: number;
}

export class AudioPreview {
  private voices = new Map<string, Loaded>();
  private rendering = new Set<string>();
  /** Pending re-renders, keyed by clip. */
  private timers = new Map<string, number>();
  /** Which key each pending timer is waiting to render. */
  private scheduled = new Map<string, string | undefined>();
  /** Notified when a render finishes, so the UI can drop its spinner. */
  onRenderChange: (() => void) | null = null;

  /** Clips whose filtered audio is still rendering. */
  pending(): ReadonlySet<string> {
    return this.rendering;
  }

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
      const loaded = this.load(voice);
      const element = loaded.element;

      // No clamp. A boost is meant to be audible.
      loaded.gain.gain.value = Math.max(0, voice.volume);

      // `preservesPitch` is exactly the toggle: on, the browser time-stretches
      // and the voice stays put; off, it resamples and pitch rides the rate.
      element.playbackRate = Math.max(0.0625, Math.min(16, voice.speed));
      element.preservesPitch = voice.preservePitch;

      // A filtered render starts at the clip's in-point, so the same instant
      // sits at a different offset inside it than in the original file.
      const target = Math.max(0, voice.time - loaded.offset);

      // readyState 0 means metadata has not arrived; setting currentTime then
      // throws in some engines and is discarded in others.

      if (element.readyState > 0 && Math.abs(element.currentTime - target) > tolerance) {
        try {
          element.currentTime = target;
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
    const timer = this.timers.get(clipId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(clipId);
      this.scheduled.delete(clipId);
    }

    const loaded = this.voices.get(clipId);
    if (!loaded) return;
    this.voices.delete(clipId);
    this.destroy(loaded);

    if (this.rendering.delete(clipId)) this.onRenderChange?.();
  }

  /** Tears down one element and its graph node. */
  private destroy(loaded: Loaded): void {
    loaded.element.pause();
    loaded.element.removeAttribute("src");
    loaded.element.load();
    loaded.gain.disconnect();
    if (loaded.objectUrl) URL.revokeObjectURL(loaded.objectUrl);
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.scheduled.clear();
    for (const clipId of [...this.voices.keys()]) this.release(clipId);
  }

  private load(voice: Voice): Loaded {
    const key = voice.filter?.key;
    const existing = this.voices.get(voice.clipId);

    if (existing && existing.key === key) return existing;

    // The settings changed. Do *not* tear down what is currently audible:
    // schedule the swap and keep playing the old render until the new one is
    // ready, so adjusting a filter does not silence the thing you are judging.
    if (existing) {
      this.schedule(voice);
      return existing;
    }

    return this.create(voice);
  }

  /** Queues a re-render, restarting the clock on every further change. */
  private schedule(voice: Voice): void {
    const key = voice.filter?.key;
    if (this.scheduled.get(voice.clipId) === key) return;

    const timer = this.timers.get(voice.clipId);
    if (timer !== undefined) clearTimeout(timer);

    this.scheduled.set(voice.clipId, key);
    this.timers.set(
      voice.clipId,
      window.setTimeout(() => {
        this.timers.delete(voice.clipId);
        this.scheduled.delete(voice.clipId);

        const previous = this.voices.get(voice.clipId);
        this.voices.delete(voice.clipId);
        this.create(voice);
        if (previous) this.destroy(previous);
      }, RENDER_DEBOUNCE_MS),
    );
  }

  private create(voice: Voice): Loaded {
    const key = voice.filter?.key;
    const element = new Audio();
    element.preload = "auto";

    const loaded: Loaded = {
      element,
      gain: connectElement(element),
      loading: true,
      key,
      offset: voice.filter ? voice.filter.sourceStart : 0,
    };
    this.voices.set(voice.clipId, loaded);

    const source = voice.filter
      ? renderFilteredAudio({
          path: voice.path,
          sourceStart: voice.filter.sourceStart,
          duration: voice.filter.duration,
          chain: voice.filter.chain,
        })
      : readMediaBytes(voice.path);

    if (voice.filter) {
      this.rendering.add(voice.clipId);
      this.onRenderChange?.();
    }

    // Source arrives asynchronously; until then the element is silent and the
    // sync pass simply has nothing to play, which is correct.
    void source
      .then((bytes) => {
        const url = URL.createObjectURL(new Blob([bytes]));

        // A render that finishes after its clip was replaced or removed has
        // nothing to play into; hand the URL straight back rather than
        // leaking it into a detached element.
        if (this.voices.get(voice.clipId) !== loaded) {
          URL.revokeObjectURL(url);
          return;
        }

        loaded.objectUrl = url;
        loaded.element.src = url;
        loaded.element.load();
      })
      .catch((cause) => console.error(`Relay: could not load audio for ${voice.path}`, cause))
      .finally(() => {
        loaded.loading = false;
        if (this.rendering.delete(voice.clipId)) this.onRenderChange?.();
      });

    return loaded;
  }
}
