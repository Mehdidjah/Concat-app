/**
 * The engine's true frames for the monitor: the paused dwell and the
 * playback stream, one owner.
 *
 * Paused: when the playhead settles, fetch the exporter's own composite at
 * up to 960px and hold it over the approximation until the playhead moves.
 * Playing: while two or more visual layers sit under the playhead, pull
 * frames continuously at up to 640px - request at the transport's position,
 * present, request the next when it lands (desktop decision 0009). Single
 * layers keep the smooth element preview.
 */
import { useEffect, useRef, useState } from "react";

import { clipsAt, type EditorProject } from "../lib/editor";
import { previewFrame, type ExportClip } from "../lib/engine";

export interface EngineStill {
  bytes: ArrayBuffer;
  width: number;
  height: number;
}

/** Even dimensions at an aspect-preserving cap - decoders round odd sizes. */
function capped(frame: { width: number; height: number }, cap: number) {
  const scale = Math.min(1, cap / Math.max(frame.width, frame.height));
  return {
    width: Math.max(2, Math.round((frame.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((frame.height * scale) / 2) * 2),
  };
}

export function useEngineTruth({
  playing,
  loaded,
  playhead,
  exportClips,
  frame,
  rateNum,
  rateDen,
  latest,
}: {
  playing: boolean;
  loaded: boolean;
  playhead: number;
  exportClips: ExportClip[];
  frame: { width: number; height: number };
  rateNum: number;
  rateDen: number;
  /** Live values, read mid-flight without restarting the loops. */
  latest: { current: { playhead: number; frame: { width: number; height: number }; project: EditorProject } };
}): EngineStill | null {
  const [engineStill, setEngineStill] = useState<EngineStill | null>(null);
  const stillToken = useRef(0);
  const exportClipsRef = useRef(exportClips);
  exportClipsRef.current = exportClips;

  // The paused dwell.
  useEffect(() => {
    // While playing, the streaming loop below owns the still; clearing it
    // here on every playhead tick would fight the stream frame by frame.
    if (playing) return;
    const token = ++stillToken.current;
    setEngineStill(null);
    if (!loaded || exportClips.length === 0) return;

    const timer = window.setTimeout(() => {
      const { width, height } = capped(frame, 960);
      previewFrame({
        time: latest.current.playhead,
        width,
        height,
        rateNum,
        rateDen,
        clips: exportClips,
      })
        .then((bytes) => {
          if (stillToken.current === token) setEngineStill({ bytes, width, height });
        })
        .catch(() => {
          if (stillToken.current === token) setEngineStill(null);
        });
    }, 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, loaded, playhead, exportClips, frame, rateNum, rateDen]);

  // The playback stream. Pull, not push: one request in flight, never a
  // queue of stale frames; the pool's warm readers make consecutive
  // requests rolls, not seeks. Rate beats resolution while moving.
  useEffect(() => {
    if (!playing || !loaded) return;
    let live = true;
    // Invalidate any paused-dwell fetch still in flight from before play.
    stillToken.current += 1;
    const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const visualLayers = (time: number) =>
      clipsAt(latest.current.project, time).filter(
        (clip) => clip.kind === "video" || clip.kind === "image",
      ).length;

    const run = async () => {
      while (live) {
        const time = latest.current.playhead;
        if (visualLayers(time) < 2) {
          setEngineStill(null);
          await wait(120);
          continue;
        }
        const { width, height } = capped(latest.current.frame, 640);
        try {
          const bytes = await previewFrame({
            time,
            width,
            height,
            rateNum,
            rateDen,
            clips: exportClipsRef.current,
          });
          if (live) setEngineStill({ bytes, width, height });
        } catch {
          // A failed frame keeps the approximation on screen; back off so a
          // persistently failing source cannot spin the pool.
          if (live) setEngineStill(null);
          await wait(200);
        }
      }
    };
    void run();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, loaded, rateNum, rateDen]);

  return engineStill;
}
