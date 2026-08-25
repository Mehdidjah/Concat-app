import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The playback clock.
 *
 * The playhead is computed as `origin + (now - startedAt)`, never accumulated
 * frame by frame. Accumulation drifts - it is the same mistake as summing
 * `1/29.97` in a loop, and it is why `relay-core` has a rational time type at
 * all. Here it also means a dropped frame costs nothing: the next tick reads
 * the wall clock and lands in the right place.
 *
 * Playback is still paced by the browser here. That is a prototype
 * compromise: the engine owns the clock once it can decode and present
 * frames itself.
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
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  // Where the clock was when playback started, and when that was.
  const origin = useRef(0);
  const startedAt = useRef(0);
  // Read inside the rAF loop so the effect does not restart on every change.
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const pause = useCallback(() => setPlaying(false), []);

  const play = useCallback(() => {
    setPlayhead((current) => {
      origin.current = current;
      return current;
    });
    startedAt.current = performance.now();
    setPlaying(true);
  }, []);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [pause, play, playing]);

  const seek = useCallback((seconds: number) => {
    const next = Math.max(0, seconds);
    origin.current = next;
    startedAt.current = performance.now();
    setPlayhead(next);
  }, []);

  const step = useCallback(
    (frames: number, frameRate: number) => {
      // Land on an exact frame boundary rather than adding an offset to
      // wherever the playhead happened to stop.
      setPlayhead((current) => {
        const next = Math.max(0, (Math.round(current * frameRate) + frames) / frameRate);
        origin.current = next;
        startedAt.current = performance.now();
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    const tick = (now: number) => {
      const next = origin.current + (now - startedAt.current) / 1000;
      const end = durationRef.current;

      if (end > 0 && next >= end) {
        setPlayhead(end);
        setPlaying(false);
        return;
      }

      setPlayhead(next);
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  return { playhead, playing, play, pause, toggle, seek, step };
}
