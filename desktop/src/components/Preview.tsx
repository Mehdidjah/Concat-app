import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { connectElement } from "../lib/audio";
import { timecode } from "../lib/time";
import { Icon, IconButton } from "./Icon";
import { PANEL_SHELL } from "./Panel";

/** The video clip that should be on screen right now, if any. */
export interface PreviewSource {
  clipId: string;
  path: string;
  /** Where in the source file the playhead sits, in seconds. */
  time: number;
  muted: boolean;
  /** Linear gain with fades applied. May exceed 1; see lib/audio.ts. */
  volume: number;
  /** A still is shown as an image; there is nothing to seek or play. */
  isStill: boolean;
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
  playing,
  playhead,
  duration,
  frameRate,
  onTogglePlay,
  onStep,
  onSeek,
}: {
  source: PreviewSource | null;
  playing: boolean;
  playhead: number;
  duration: number;
  frameRate: number;
  onTogglePlay: () => void;
  onStep: (frames: number) => void;
  onSeek: (seconds: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const loadedClip = useRef<string | null>(null);

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

    element.muted = source.muted;

    // Through a gain node, not element.volume, which browsers cap at 1.0.
    // A video clip's audio obeys the same clip gain as an audio clip's.
    try {
      connectElement(element).gain.value = Math.max(0, source.volume);
    } catch {
      // Routing can only fail if the element was already claimed by another
      // graph, which cannot happen here - but silence is not worth a crash.
    }

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
        <div data-preview-surface className="relative h-full w-full">
          <video
            ref={video}
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
          {!source && (
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

        <span className="min-w-0 truncate justify-self-end font-technical text-[10px] text-tertiary">
          {frameRate.toFixed(2)} fps
        </span>
      </div>
    </div>
  );
}
