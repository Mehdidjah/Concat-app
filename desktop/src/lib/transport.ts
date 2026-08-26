import { useCallback, useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * The playback clock.
 *
 * The engine owns it: the position that matters is the audio device's sample
 * counter, reported through `transport` events at ~30Hz. Between events the
 * UI interpolates on the wall clock from the last reported anchor, so the
 * playhead moves at animation rate while never drifting further than one
 * event interval from the truth.
 *
 * In a plain browser (`npm run dev` with no Rust host) there is no engine and
 * the anchor simply never gets corrected - the wall clock alone is the same
 * prototype behaviour this file always had there.
 */
export interface Transport {
  playhead: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  /** Jumps to an absolute time, clamped at zero. */
  seek: (seconds: number) => void;
  /** Moves by a signed number of frames at the given rate. */
  step: (frames: number, frameRate: number) => void;
}

export function useTransport({ duration }: { duration: number }): Transport {
  const native = isTauri();
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  // The last known-true position and when it was known. While playing, the
  // rendered playhead is `position + (now - at)`.
  const anchor = useRef({ position: 0, at: 0 });
  // Read inside loops and callbacks without restarting them.
  const playheadRef = useRef(0);
  playheadRef.current = playhead;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const pause = useCallback(() => {
    setPlaying(false);
    if (native) void invoke("transport_pause").catch(() => undefined);
  }, [native]);

  const play = useCallback(() => {
    const from = playheadRef.current;
    anchor.current = { position: from, at: performance.now() };
    if (native) void invoke("transport_play", { position: from }).catch(() => undefined);
    setPlaying(true);
  }, [native]);

  const toggle = useCallback(() => {
    if (playingRef.current) pause();
    else play();
  }, [pause, play]);

  const seek = useCallback(
    (seconds: number) => {
      const next = Math.max(0, seconds);
      anchor.current = { position: next, at: performance.now() };
      setPlayhead(next);
      if (native) void invoke("transport_seek", { position: next }).catch(() => undefined);
    },
    [native],
  );

  const step = useCallback(
    (frames: number, frameRate: number) => {
      // Land on an exact frame boundary rather than adding an offset to
      // wherever the playhead happened to stop.
      const next = Math.max(0, (Math.round(playheadRef.current * frameRate) + frames) / frameRate);
      seek(next);
    },
    [seek],
  );

  // Engine position reports re-anchor the interpolation. Ignored while
  // paused: a report can arrive just after a local pause, and rewinding the
  // playhead to it would visibly snap.
  useEffect(() => {
    if (!native) return;
    let stopped = false;
    const stopping = listen<number>("transport", (event) => {
      if (stopped || !playingRef.current) return;
      anchor.current = { position: event.payload, at: performance.now() };
    });
    return () => {
      stopped = true;
      void stopping.then((stop) => stop());
    };
  }, [native]);

  // The render loop: interpolate from the anchor while playing.
  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    const tick = (now: number) => {
      const next = anchor.current.position + (now - anchor.current.at) / 1000;
      const end = durationRef.current;

      if (end > 0 && next >= end) {
        setPlayhead(end);
        setPlaying(false);
        if (native) void invoke("transport_pause").catch(() => undefined);
        return;
      }

      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, native]);

  return { playhead, playing, play, pause, toggle, seek, step };
}
