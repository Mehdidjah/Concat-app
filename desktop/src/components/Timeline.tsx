import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

import { timecode } from "../lib/time";

/**
 * The timeline, drawn on a canvas.
 *
 * Deliberately not made of DOM nodes. A real edit has thousands of clips,
 * keyframes and waveform segments, and scrubbing repaints all of them sixty
 * times a second. React reconciliation cannot keep up with that and neither can
 * the compositor. One canvas and one draw call per frame can.
 *
 * See docs/decisions/0002-the-hot-surfaces-are-not-the-dom.md.
 */

export interface TimelineClip {
  id: string;
  track: number;
  /** Seconds from the start of the timeline. */
  start: number;
  duration: number;
  label: string;
  kind: "video" | "audio";
}

interface TimelineProps {
  clips: TimelineClip[];
  trackCount: number;
  playhead: number;
  /** Seconds of timeline per horizontal pixel of canvas. */
  secondsPerPixel: number;
  frameRate: number;
  onScrub: (seconds: number) => void;
}

const RULER_HEIGHT = 28;
const TRACK_HEIGHT = 56;

const COLORS = {
  background: "#0d0f13",
  ruler: "#14171d",
  trackEven: "#101319",
  trackOdd: "#0d1015",
  gridMinor: "#1b1f27",
  gridMajor: "#2b3240",
  text: "#9aa2b1",
  clipVideo: "#2b5f8f",
  clipAudio: "#2f7a5c",
  clipEdge: "#4f8cff",
  clipText: "#e8eaef",
  playhead: "#ff4f6d",
};

export function Timeline({
  clips,
  trackCount,
  playhead,
  secondsPerPixel,
  frameRate,
  onScrub,
}: TimelineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The draw function reads the latest props through a ref so that the rAF loop
  // never has to be torn down and rebuilt when a prop changes.
  const props = useRef({ clips, trackCount, playhead, secondsPerPixel, frameRate });
  props.current = { clips, trackCount, playhead, secondsPerPixel, frameRate };

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;

    const { clips, trackCount, playhead, secondsPerPixel, frameRate } = props.current;

    // Match the backing store to the device pixel ratio, or everything is
    // blurry on a scaled display and text looks like mud.
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, width, height);

    drawTrackBands(context, width, height, trackCount);
    drawRuler(context, width, secondsPerPixel, frameRate);
    drawGrid(context, width, height, secondsPerPixel);

    for (const clip of clips) {
      drawClip(context, clip, secondsPerPixel);
    }

    drawPlayhead(context, height, playhead / secondsPerPixel);
  }, []);

  useEffect(() => {
    let frame = 0;
    // One rAF loop, started once. Repainting on a timer rather than on every
    // state change keeps scrubbing smooth and coalesces bursts of updates.
    const tick = () => {
      draw();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    const canvas = canvasRef.current;
    const observer = new ResizeObserver(() => draw());
    if (canvas) observer.observe(canvas);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [draw]);

  const scrubTo = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    onScrub(Math.max(0, (event.clientX - bounds.left) * props.current.secondsPerPixel));
  };

  return (
    <canvas
      ref={canvasRef}
      className="h-full w-full cursor-text"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        scrubTo(event);
      }}
      onPointerMove={(event) => {
        if (event.buttons === 1) scrubTo(event);
      }}
    />
  );
}

function drawTrackBands(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  trackCount: number,
) {
  for (let track = 0; track < trackCount; track += 1) {
    const y = RULER_HEIGHT + track * TRACK_HEIGHT;
    if (y > height) break;
    context.fillStyle = track % 2 === 0 ? COLORS.trackEven : COLORS.trackOdd;
    context.fillRect(0, y, width, TRACK_HEIGHT);
  }
}

/** Chooses a tick spacing that stays readable at any zoom. */
function tickInterval(secondsPerPixel: number): number {
  const candidates = [1 / 30, 0.1, 0.5, 1, 2, 5, 10, 30, 60, 300, 600, 1800];
  const minimumPixels = 80;
  return (
    candidates.find((seconds) => seconds / secondsPerPixel >= minimumPixels) ??
    candidates[candidates.length - 1]
  );
}

function drawRuler(
  context: CanvasRenderingContext2D,
  width: number,
  secondsPerPixel: number,
  frameRate: number,
) {
  context.fillStyle = COLORS.ruler;
  context.fillRect(0, 0, width, RULER_HEIGHT);
  context.strokeStyle = COLORS.gridMajor;
  context.beginPath();
  context.moveTo(0, RULER_HEIGHT - 0.5);
  context.lineTo(width, RULER_HEIGHT - 0.5);
  context.stroke();

  const interval = tickInterval(secondsPerPixel);
  context.fillStyle = COLORS.text;
  context.font = "10px ui-monospace, monospace";
  context.textBaseline = "middle";

  for (let seconds = 0; seconds / secondsPerPixel < width; seconds += interval) {
    const x = Math.round(seconds / secondsPerPixel) + 0.5;
    context.strokeStyle = COLORS.gridMajor;
    context.beginPath();
    context.moveTo(x, RULER_HEIGHT - 8);
    context.lineTo(x, RULER_HEIGHT);
    context.stroke();
    context.fillText(timecode(seconds, frameRate), x + 4, RULER_HEIGHT / 2 - 2);
  }
}

function drawGrid(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  secondsPerPixel: number,
) {
  const interval = tickInterval(secondsPerPixel);
  context.strokeStyle = COLORS.gridMinor;
  context.beginPath();
  for (let seconds = 0; seconds / secondsPerPixel < width; seconds += interval) {
    const x = Math.round(seconds / secondsPerPixel) + 0.5;
    context.moveTo(x, RULER_HEIGHT);
    context.lineTo(x, height);
  }
  context.stroke();
}

function drawClip(
  context: CanvasRenderingContext2D,
  clip: TimelineClip,
  secondsPerPixel: number,
) {
  const x = clip.start / secondsPerPixel;
  const clipWidth = Math.max(2, clip.duration / secondsPerPixel);
  const y = RULER_HEIGHT + clip.track * TRACK_HEIGHT + 4;
  const clipHeight = TRACK_HEIGHT - 8;

  context.fillStyle = clip.kind === "video" ? COLORS.clipVideo : COLORS.clipAudio;
  context.beginPath();
  context.roundRect(x, y, clipWidth, clipHeight, 4);
  context.fill();

  context.strokeStyle = COLORS.clipEdge;
  context.lineWidth = 1;
  context.stroke();

  // Only bother with a label if it will not immediately be clipped away.
  if (clipWidth > 44) {
    context.save();
    context.beginPath();
    context.rect(x, y, clipWidth - 6, clipHeight);
    context.clip();
    context.fillStyle = COLORS.clipText;
    context.font = "11px ui-sans-serif, system-ui, sans-serif";
    context.textBaseline = "top";
    context.fillText(clip.label, x + 6, y + 6);
    context.restore();
  }
}

function drawPlayhead(context: CanvasRenderingContext2D, height: number, x: number) {
  const position = Math.round(x) + 0.5;
  context.strokeStyle = COLORS.playhead;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(position, 0);
  context.lineTo(position, height);
  context.stroke();

  context.fillStyle = COLORS.playhead;
  context.beginPath();
  context.moveTo(position - 5, 0);
  context.lineTo(position + 5, 0);
  context.lineTo(position, 8);
  context.closePath();
  context.fill();
}
