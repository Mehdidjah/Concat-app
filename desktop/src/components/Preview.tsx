import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { timecode } from "../lib/time";
import { textCss, type TextStyle } from "../lib/text";
import { Icon, IconButton } from "./Icon";
import { Menu } from "./Menu";
import { PANEL_SHELL } from "./Panel";

/**
 * Output frames people actually deliver to. Dimensions rather than bare
 * ratios, because a ratio alone does not say how many pixels the export has.
 */
const FRAME_PRESETS = [
  { label: "16:9", width: 1920, height: 1080 },
  { label: "16:9 · 4K", width: 3840, height: 2160 },
  { label: "9:16", width: 1080, height: 1920 },
  { label: "1:1", width: 1080, height: 1080 },
  { label: "4:3", width: 1440, height: 1080 },
  { label: "21:9", width: 2560, height: 1080 },
] as const;

/** "16:9" for a preset size, the reduced fraction for anything else. */
function ratioLabel(width: number, height: number): string {
  const preset = FRAME_PRESETS.find(
    (candidate) => candidate.width === width && candidate.height === height,
  );
  if (preset) return preset.label.split(" ")[0];
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(width, height) || 1;
  return `${width / divisor}:${height / divisor}`;
}

/** The video clip that should be on screen right now, if any. */
export interface PreviewSource {
  clipId: string;
  path: string;
  /** Where in the source file the playhead sits, in seconds. */
  time: number;
  /** A still is shown as an image; there is nothing to seek or play. */
  isStill: boolean;
}

/** A title to draw over the picture, already positioned. */
export interface TextOverlay {
  clipId: string;
  style: TextStyle;
  /** Offset from centred, as a fraction of the frame. */
  offsetX: number;
  offsetY: number;
}

/**
 * The program monitor.
 *
 * A `<video>` element, synced to the transport the same way audio is. This is
 * a *preview*, not the engine's output: it shows one clip at a time, so it
 * cannot composite, and it knows nothing about effects or the render graph.
 * What it does do is let you see and hear your edit today.
 *
 * The engine takes this over when it can present frames - see
 * docs/decisions/0002. Until then the element keeps a strict aspect box,
 * because a native surface will eventually be positioned to exactly these
 * bounds and the layout has to be right before anything can be aligned to it.
 */
export function Preview({
  source,
  overlays,
  playing,
  playhead,
  duration,
  frameRate,
  frame,
  onFrameChange,
  onTogglePlay,
  onStep,
  onSeek,
}: {
  source: PreviewSource | null;
  /** Text clips live at the playhead, bottom-most first. */
  overlays: TextOverlay[];
  playing: boolean;
  playhead: number;
  duration: number;
  frameRate: number;
  /** The project's output size, shown and changed in the footer. */
  frame: { width: number; height: number };
  onFrameChange: (width: number, height: number) => void;
  onTogglePlay: () => void;
  onStep: (frames: number) => void;
  onSeek: (seconds: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const loadedClip = useRef<string | null>(null);

  // Text is sized as a fraction of the frame, so drawing it needs the pixel
  // height of the surface it lands on. That is a layout fact, not a prop, and
  // it changes whenever the panel is resized - hence an observer rather than a
  // one-off measurement.
  const stage = useRef<HTMLDivElement>(null);
  const [surface, setSurface] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;

    const measure = () => {
      const bounds = element.getBoundingClientRect();
      setSurface({ width: bounds.width, height: bounds.height });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Swap the source only when the clip under the playhead actually changes.
  // Reassigning `src` every frame would restart the decoder continuously.
  useEffect(() => {
    const element = video.current;
    if (!element) return;

    // A still never goes near the video element - it is rendered as an <img>
    // below - so release whatever the element was holding.
    if (!source || source.isStill) {
      loadedClip.current = null;
      element.removeAttribute("src");
      element.load();
      return;
    }

    if (loadedClip.current !== source.clipId) {
      loadedClip.current = source.clipId;
      element.src = convertFileSrc(source.path);
      element.load();
    }
  }, [source]);

  // Same corrective sync as the audio preview: generous tolerance while
  // playing (a reseek is a visible stutter), tight while paused (a seek is the
  // entire operation).
  useEffect(() => {
    const element = video.current;
    if (!element || !source || source.isStill) return;

    const tolerance = playing ? 0.3 : 0.03;
    if (element.readyState > 0 && Math.abs(element.currentTime - source.time) > tolerance) {
      try {
        element.currentTime = Math.max(0, source.time);
      } catch {
        // Still opening; the next update lands it.
      }
    }

    if (playing && element.paused) void element.play().catch(() => undefined);
    if (!playing && !element.paused) element.pause();
  }, [source, playing]);

  return (
    <div className={PANEL_SHELL}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-secondary">
          Preview
        </h2>
      </header>

      {/*
        Containment, deliberately belt and braces.

        A flex item defaults to `min-height: auto`, so a 4K video's intrinsic
        size can push a flex container past its parent no matter what
        `max-h-full` says. Rather than rely on that, the stage clips, and the
        media is absolutely positioned to fill a box that is exactly the
        stage's content area. `object-contain` then fits the picture inside
        that box, so it can never exceed the panel whatever its resolution.
      */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden bg-stage p-4">
        <div ref={stage} data-preview-surface className="relative h-full w-full">
          {/* Picture only. Every drop of audio - a video clip's included -
              comes from the engine's mixer, so there is exactly one clock and
              one gain law. */}
          <video
            ref={video}
            muted
            playsInline
            className={`absolute inset-0 h-full w-full object-contain ${
              source && !source.isStill ? "block" : "hidden"
            }`}
          />
          {source?.isStill && (
            <img
              // Keyed on the clip so switching between two stills actually
              // swaps the picture rather than reusing the decoded one.
              key={source.clipId}
              src={convertFileSrc(source.path)}
              alt=""
              draggable={false}
              className="absolute inset-0 h-full w-full object-contain"
            />
          )}
          {/*
            Titles sit above the picture and below the empty-state message.
            `pointer-events-none` matters: the overlay covers the whole stage,
            and without it the transport underneath would still be clickable
            but the video would not.
          */}
          {surface.height > 0 &&
            overlays.map((overlay) => (
              <div
                key={overlay.clipId}
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <div
                  style={{
                    ...textCss(overlay.style, surface.height),
                    // Percentages here would resolve against the text block's
                    // own width, which varies with the words. The frame is the
                    // thing offsets are relative to, so they are converted
                    // against the measured surface instead.
                    transform: `translate(${overlay.offsetX * surface.width}px, ${
                      overlay.offsetY * surface.height
                    }px)`,
                    maxWidth: "92%",
                  }}
                >
                  {overlay.style.content}
                </div>
              </div>
            ))}

          {!source && overlays.length === 0 && (
            // No surface of its own: an empty monitor *is* black, and drawing
            // a bordered card on top of it invents an edge that means nothing.
            // Just the words, sitting on the stage.
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3
                            text-on-stage">
              <Icon name="film" size={30} strokeWidth={1.5} />
              <p className="text-xs">Nothing under the playhead</p>
            </div>
          )}
        </div>
      </div>

      {/*
        A three-column grid, not a flex row with `ml-auto`.

        Two things were making the transport jump as the timecode counted. The
        digits themselves can change width, and - worse - auto margins size the
        centre group from whatever space the sides leave, so *any* change on
        the left shoved the buttons sideways.

        `minmax(0, 1fr)` on both sides fixes the second properly: the columns
        are equal and cannot grow past their share, so the middle column is
        centred on the panel regardless of what the sides contain. The sides
        clip rather than push. `tabular-nums` then handles the first.
      */}
      <div
        className="grid h-11 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center
                   gap-2 border-t border-hairline px-3"
      >
        <span className="min-w-0 truncate font-mono text-[11px] tabular-nums text-secondary">
          {timecode(playhead, frameRate)}
          <span className="text-tertiary"> / </span>
          <span className="text-tertiary">{timecode(duration, frameRate)}</span>
        </span>

        <div className="flex items-center gap-0.5">
          <IconButton icon="skipStart" label="Go to start" size={7} onClick={() => onSeek(0)} />
          <IconButton
            icon="stepBack"
            label="Previous frame"
            size={7}
            onClick={() => onStep(-1)}
          />
          <IconButton
            icon={playing ? "pause" : "play"}
            label={playing ? "Pause (Space)" : "Play (Space)"}
            onClick={onTogglePlay}
            tone="go"
            active={playing}
          />
          <IconButton
            icon="stepForward"
            label="Next frame"
            size={7}
            onClick={() => onStep(1)}
          />
          <IconButton
            icon="skipEnd"
            label="Go to end"
            size={7}
            onClick={() => onSeek(duration)}
          />
        </div>

        <span className="flex min-w-0 items-center gap-2 justify-self-end">
          <Menu
            align="right"
            direction="up"
            groups={[
              FRAME_PRESETS.map((preset) => ({
                label: `${preset.label} — ${preset.width} x ${preset.height}`,
                icon:
                  preset.width === frame.width && preset.height === frame.height
                    ? ("check" as const)
                    : undefined,
                onSelect: () => onFrameChange(preset.width, preset.height),
              })),
            ]}
            trigger={(open) => (
              <span
                title="Output size"
                className={`flex items-center gap-1 rounded-md px-1.5 py-0.5 font-technical text-[10px]
                            transition-colors ${
                              open
                                ? "bg-active text-primary"
                                : "text-tertiary hover:bg-hover hover:text-secondary"
                            }`}
              >
                {ratioLabel(frame.width, frame.height)} · {frame.width}x{frame.height}
                <Icon name="chevronDown" size={10} />
              </span>
            )}
          />
          <span className="truncate font-technical text-[10px] text-tertiary">
            {frameRate.toFixed(2)} fps
          </span>
        </span>
      </div>
    </div>
  );
}
