import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";

import type { MediaAssets, Peaks } from "../lib/assets";
import { themeColor, type Theme } from "../lib/theme";
import type { Clip, ClipMove, Project, Track } from "../lib/project";
import { snapTime } from "../lib/project";
import { timecode } from "../lib/time";
import { Icon, IconButton } from "./Icon";
import { Bar, Divider, PANEL_SHELL, Spacer } from "./Panel";

export type Tool = "select" | "razor";

/** Geometry shared by the renderer and the hit tester, so they cannot disagree. */
const RULER_HEIGHT = 28;
/** Tall enough that a filmstrip frame and a waveform are both readable. */
const TRACK_HEIGHT = 64;
/** Marks the canvas so a drag in flight can find it. See `resolveDrop`. */
const CANVAS_MARKER = "data-relay-timeline";
const HEADER_WIDTH = 164;
/** How close to a clip edge the pointer must be to grab it, in pixels. */
const EDGE_GRAB = 6;
/** How near the canvas edge a drag starts pulling the view along, in pixels. */
const EDGE_MARGIN = 56;
/** Top auto-scroll speed. Roughly 4.5 viewport-widths per second at 900px. */
const EDGE_MAX_PIXELS_PER_FRAME = 24;
/** Where the playhead is parked when playback scrolls the view, 0..1. */
const FOLLOW_ANCHOR = 0.1;

/**
 * The canvas palette.
 *
 * Mutable, and deliberately so. Canvas cannot resolve `var(--color-x)` - it
 * needs a concrete colour string - so these are copied out of the stylesheet
 * whenever the theme changes and read straight from here by the draw loop.
 * The initial values are only what shows for the one frame before the first
 * refresh lands.
 */
const COLORS = {
  background: "#0d0d10",
  ruler: "#131316",
  trackOdd: "#0a0a0d",
  trackEven: "#0d0d10",
  hairline: "rgba(255,255,255,0.1)",
  tickMajor: "rgba(255,255,255,0.2)",
  text: "#6e6e73",
  clipSelected: "#0a84ff",
  clipText: "#ffffff",
  playhead: "#ff453a",
  dropZone: "rgba(10,132,255,0.18)",
};

/** Re-reads the canvas palette from the stylesheet. Cheap; call on theme change. */
function refreshCanvasPalette(): void {
  COLORS.background = themeColor("timeline", COLORS.background);
  COLORS.ruler = themeColor("ruler", COLORS.ruler);
  COLORS.trackEven = themeColor("timeline", COLORS.trackEven);
  COLORS.trackOdd = themeColor("timeline-alt", COLORS.trackOdd);
  COLORS.hairline = themeColor("hairline", COLORS.hairline);
  COLORS.tickMajor = themeColor("hairline-strong", COLORS.tickMajor);
  COLORS.text = themeColor("secondary", COLORS.text);
  COLORS.clipSelected = themeColor("accent", COLORS.clipSelected);
  COLORS.clipText = themeColor("on-accent", COLORS.clipText);
  COLORS.playhead = themeColor("playhead", COLORS.playhead);
  COLORS.dropZone = themeColor("accent-soft", COLORS.dropZone);

  PALETTE.video.header = themeColor("clip-video", PALETTE.video.header);
  PALETTE.video.body = themeColor("clip-video-body", PALETTE.video.body);
  PALETTE.video.edge = PALETTE.video.header;
  PALETTE.audio.header = themeColor("clip-audio", PALETTE.audio.header);
  PALETTE.audio.body = themeColor("clip-audio-body", PALETTE.audio.body);
  PALETTE.audio.edge = PALETTE.audio.header;
  PALETTE.audio.wave = themeColor("clip-wave", PALETTE.audio.wave);
  PALETTE.image.header = themeColor("clip-image", PALETTE.image.header);
  PALETTE.image.body = themeColor("clip-image-body", PALETTE.image.body);
  PALETTE.image.edge = PALETTE.image.header;
}

/** Where one clip sat when a move began, so the whole set moves rigidly. */
interface MoveOrigin {
  clipId: string;
  start: number;
  row: number;
}

type DragState =
  | { kind: "scrub" }
  | {
      kind: "marquee";
      /** Canvas-relative, so the band survives the view scrolling under it. */
      originX: number;
      originY: number;
      x: number;
      y: number;
      /** Shift held: add to the existing selection rather than replacing it. */
      additive: boolean;
      basis: readonly string[];
    }
  | {
      kind: "move";
      /** The clip actually grabbed; it is the one that snaps. */
      primary: string;
      /** Seconds between that clip's start and where it was grabbed. */
      grab: number;
      originRow: number;
      origins: MoveOrigin[];
    }
  | { kind: "trimStart" | "trimEnd"; clipId: string };

export function TimelinePanel({
  project,
  playhead,
  playing,
  frameRate,
  tool,
  snap,
  selectedClipIds,
  secondsPerPixel,
  scrollLeft,
  trackScroll,
  assets,
  theme,
  onToolChange,
  onSnapChange,
  onScrub,
  onSelectClips,
  onMoveClips,
  onTrimClip,
  onSplitAtPlayhead,
  onDeleteSelected,
  mediaDrag,
  onZoom,
  onScroll,
  onTrackScroll,
  onFit,
  onTrackFlag,
  onAddTrack,
  onRemoveTrack,
  onRenameTrack,
  onClipContextMenu,
}: {
  project: Project;
  playhead: number;
  /** Drives the view following the playhead during playback. */
  playing: boolean;
  frameRate: number;
  tool: Tool;
  snap: boolean;
  selectedClipIds: readonly string[];
  secondsPerPixel: number;
  scrollLeft: number;
  /** Vertical offset into the track stack, in pixels. */
  trackScroll: number;
  /** Waveform and filmstrip cache, read live from inside the draw loop. */
  assets: MediaAssets;
  /** Only used to know when to re-read the canvas palette. */
  theme: Theme;
  onToolChange: (tool: Tool) => void;
  onSnapChange: (snap: boolean) => void;
  onScrub: (seconds: number) => void;
  onSelectClips: (clipIds: string[]) => void;
  onMoveClips: (moves: ClipMove[]) => void;
  onTrimClip: (clipId: string, edge: "start" | "end", delta: number) => void;
  onSplitAtPlayhead: () => void;
  onDeleteSelected: () => void;
  /** A bin item currently being dragged, in client coordinates. */
  mediaDrag: { x: number; y: number } | null;
  onZoom: (factor: number, anchorSeconds?: number) => void;
  onScroll: (seconds: number) => void;
  onTrackScroll: (pixels: number) => void;
  /** Receives the canvas width, which is the only place that knows it. */
  onFit: (canvasWidth: number) => void;
  onTrackFlag: (trackId: string, flag: "visible" | "muted", value: boolean) => void;
  onAddTrack: () => void;
  onRemoveTrack: (trackId: string) => void;
  onRenameTrack: (trackId: string, name: string) => void;
  onClipContextMenu: (clipId: string, x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drag = useRef<DragState | null>(null);
  /** Last pointer position, replayed by the edge-scroll loop. */
  const pointer = useRef<{ x: number; y: number } | null>(null);
  /** Auto-scroll speed in pixels per frame; zero when not near an edge. */
  const edgeSpeed = useRef(0);
  /** Latest drag applier and scroll callback, for the frame loop to reach. */
  const applyDragRef = useRef<(clientX: number, clientY: number) => void>(() => {});
  const scrollRef = useRef(onScroll);
  scrollRef.current = onScroll;
  /** The header column, kept in step with the canvas's vertical offset. */
  const headerScroll = useRef<HTMLDivElement>(null);
  // Top-most track first on screen; the model stores them bottom-most first to
  // match the engine's compositing order.
  const rows: Track[] = [...project.tracks].reverse();

  // Which lane a dragged bin item would land on. Tracks are untyped, so any
  // lane under the pointer is a valid target.
  const dropTrack = (() => {
    if (!mediaDrag) return null;
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    if (mediaDrag.x < bounds.left || mediaDrag.x > bounds.right) return null;
    const offsetY = mediaDrag.y - bounds.top - RULER_HEIGHT;
    if (offsetY < 0) return null;
    return rows[Math.floor((offsetY + trackScroll) / TRACK_HEIGHT)]?.id ?? null;
  })();

  // Set membership is checked once per visible clip per frame; an array scan
  // would be O(clips x selection).
  const selected = new Set(selectedClipIds);

  // The draw loop reads everything through this ref, so a prop change never
  // tears down and rebuilds the loop.
  const view = useRef({ project, playhead, playing, secondsPerPixel, scrollLeft, trackScroll, frameRate, selected, rows, dropTrack, assets });
  view.current = { project, playhead, playing, secondsPerPixel, scrollLeft, trackScroll, frameRate, selected, rows, dropTrack, assets };

  const timeAt = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return 0;
      const bounds = canvas.getBoundingClientRect();
      return Math.max(0, (clientX - bounds.left) * view.current.secondsPerPixel + view.current.scrollLeft);
    },
    [],
  );

  const rowAt = useCallback((clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const bounds = canvas.getBoundingClientRect();
    const y = clientY - bounds.top - RULER_HEIGHT;
    if (y < 0) return null;
    const index = Math.floor((y + view.current.trackScroll) / TRACK_HEIGHT);
    return view.current.rows[index] ?? null;
  }, []);

  const clipAt = useCallback(
    (clientX: number, clientY: number): { clip: Clip; edge: "start" | "end" | null } | null => {
      const track = rowAt(clientY);
      if (!track) return null;
      const time = timeAt(clientX);
      const { project, secondsPerPixel } = view.current;

      // Later clips draw on top, so search back to front.
      for (let index = project.clips.length - 1; index >= 0; index -= 1) {
        const clip = project.clips[index];
        if (clip.trackId !== track.id) continue;
        if (time < clip.start || time > clip.start + clip.duration) continue;

        const grabSeconds = EDGE_GRAB * secondsPerPixel;
        const edge =
          time - clip.start < grabSeconds
            ? "start"
            : clip.start + clip.duration - time < grabSeconds
              ? "end"
              : null;
        return { clip, edge };
      }
      return null;
    },
    [rowAt, timeAt],
  );

  // ── drawing ──────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!canvas || !context) return;

    const state = view.current;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    // Keeping the playhead reachable, once per frame.
    //
    // Two cases, and dragging wins: while a drag is pulling at an edge the
    // view travels with it and the drag is replayed at the new scroll offset,
    // so the playhead stays glued to the pointer. Otherwise, during playback,
    // the view pages along whenever the playhead leaves the visible span.
    const span = width * state.secondsPerPixel;
    if (drag.current && edgeSpeed.current !== 0 && pointer.current) {
      scrollRef.current(Math.max(0, state.scrollLeft + edgeSpeed.current * state.secondsPerPixel));
      applyDragRef.current(pointer.current.x, pointer.current.y);
    } else if (
      state.playing &&
      (state.playhead < state.scrollLeft || state.playhead > state.scrollLeft + span)
    ) {
      scrollRef.current(Math.max(0, state.playhead - span * FOLLOW_ANCHOR));
    }

    const toX = (seconds: number) => (seconds - state.scrollLeft) / state.secondsPerPixel;

    context.fillStyle = COLORS.background;
    context.fillRect(0, 0, width, height);

    // Track bands.
    state.rows.forEach((track, index) => {
      const y = RULER_HEIGHT + index * TRACK_HEIGHT - state.trackScroll;
      context.fillStyle = index % 2 === 0 ? COLORS.trackEven : COLORS.trackOdd;
      context.fillRect(0, y, width, TRACK_HEIGHT);

      if (state.dropTrack === track.id) {
        context.fillStyle = COLORS.dropZone;
        context.fillRect(0, y, width, TRACK_HEIGHT);
      }

      context.strokeStyle = COLORS.hairline;
      context.beginPath();
      context.moveTo(0, y + TRACK_HEIGHT - 0.5);
      context.lineTo(width, y + TRACK_HEIGHT - 0.5);
      context.stroke();
    });

    drawRuler(context, width, state.scrollLeft, state.secondsPerPixel, state.frameRate);

    // Grid lines dropping out of the ruler.
    const interval = tickInterval(state.secondsPerPixel);
    context.strokeStyle = COLORS.hairline;
    context.beginPath();
    for (
      let seconds = Math.ceil(state.scrollLeft / interval) * interval;
      toX(seconds) < width;
      seconds += interval
    ) {
      const x = Math.round(toX(seconds)) + 0.5;
      context.moveTo(x, RULER_HEIGHT);
      context.lineTo(x, height);
    }
    context.stroke();

    // Clips and the selection band are confined to the lane area: scrolled far
    // enough, a clip would otherwise paint straight over the ruler.
    context.save();
    context.beginPath();
    context.rect(0, RULER_HEIGHT, width, Math.max(0, height - RULER_HEIGHT));
    context.clip();

    for (const clip of state.project.clips) {
      const rowIndex = state.rows.findIndex((track) => track.id === clip.trackId);
      if (rowIndex < 0) continue;

      const x = toX(clip.start);
      const clipWidth = clip.duration / state.secondsPerPixel;
      if (x + clipWidth < 0 || x > width) continue;

      drawClip(
        context,
        clip,
        x,
        RULER_HEIGHT + rowIndex * TRACK_HEIGHT - state.trackScroll,
        clipWidth,
        state.selected.has(clip.id),
        state.assets,
        state.secondsPerPixel,
      );
    }

    // The selection band, drawn over the clips it is catching.
    if (drag.current?.kind === "marquee") {
      const band = normalise(drag.current);
      context.fillStyle = "rgba(59,130,246,0.15)";
      context.fillRect(band.x, band.y, band.width, band.height);
      context.strokeStyle = "rgba(59,130,246,0.8)";
      context.lineWidth = 1;
      context.strokeRect(
        Math.round(band.x) + 0.5,
        Math.round(band.y) + 0.5,
        Math.round(band.width),
        Math.round(band.height),
      );
    }

    context.restore();

    drawPlayhead(context, height, toX(state.playhead));
  }, []);

  // Scrolling the canvas moves the headers. Guarded, because assigning
  // scrollTop fires onScroll again and the two would chase each other.
  useEffect(() => {
    const element = headerScroll.current;
    if (element && Math.abs(element.scrollTop - trackScroll) > 0.5) {
      element.scrollTop = trackScroll;
    }
  }, [trackScroll]);

  // The stylesheet has already been applied by the time this runs, so the
  // computed values it reads are the new theme's.
  useEffect(() => {
    refreshCanvasPalette();
  }, [theme]);

  useEffect(() => {
    let frame = 0;
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

  // ── pointer interaction ──────────────────────────────────────────────────
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.button === 2) return; // handled by onContextMenu

    const canvas = event.currentTarget;
    const bounds = canvas.getBoundingClientRect();
    const overRuler = event.clientY - bounds.top < RULER_HEIGHT;
    const hit = overRuler ? null : clipAt(event.clientX, event.clientY);

    canvas.setPointerCapture(event.pointerId);

    // The ruler is the scrub strip. Dragging in the track area draws a
    // selection band instead, which is the convention every NLE shares and the
    // only way marquee select and scrubbing can coexist on one surface.
    if (overRuler) {
      drag.current = { kind: "scrub" };
      onScrub(timeAt(event.clientX));
      return;
    }

    if (hit && tool === "razor") {
      // The razor cuts where you click, not where the playhead is.
      onSelectClips([hit.clip.id]);
      onScrub(timeAt(event.clientX));
      window.setTimeout(onSplitAtPlayhead, 0);
      return;
    }

    if (hit) {
      const alreadySelected = selectedClipIds.includes(hit.clip.id);

      // Shift toggles. Otherwise grabbing a clip that is already part of the
      // selection keeps the whole set - so a multi-clip drag does not collapse
      // to one clip the instant you touch it.
      const next = event.shiftKey
        ? alreadySelected
          ? selectedClipIds.filter((id) => id !== hit.clip.id)
          : [...selectedClipIds, hit.clip.id]
        : alreadySelected
          ? [...selectedClipIds]
          : [hit.clip.id];

      onSelectClips(next);

      if (hit.edge && next.length <= 1) {
        drag.current = {
          kind: hit.edge === "start" ? "trimStart" : "trimEnd",
          clipId: hit.clip.id,
        };
        return;
      }

      const moving = next.includes(hit.clip.id) ? next : [hit.clip.id];
      const originRow = rows.findIndex((track) => track.id === hit.clip.trackId);

      drag.current = {
        kind: "move",
        primary: hit.clip.id,
        grab: timeAt(event.clientX) - hit.clip.start,
        originRow,
        origins: moving.flatMap((clipId) => {
          const clip = project.clips.find((candidate) => candidate.id === clipId);
          if (!clip) return [];
          return [
            {
              clipId,
              start: clip.start,
              row: rows.findIndex((track) => track.id === clip.trackId),
            },
          ];
        }),
      };
      return;
    }

    // Empty track area: start a band.
    drag.current = {
      kind: "marquee",
      originX: event.clientX - bounds.left,
      originY: event.clientY - bounds.top,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
      additive: event.shiftKey,
      basis: event.shiftKey ? [...selectedClipIds] : [],
    };
    if (!event.shiftKey) onSelectClips([]);
  };

  /**
   * Applies whatever drag is in flight at these client coordinates.
   *
   * Split out from the pointer handler because the edge-scroll loop replays it
   * every frame from the last known pointer position - the pointer has stopped
   * moving at the window edge, but the timeline underneath it has not.
   */
  const applyDrag = (clientX: number, clientY: number) => {
    const state = drag.current;
    if (!state) return;

    const time = timeAt(clientX);

    if (state.kind === "scrub") {
      onScrub(time);
      return;
    }

    if (state.kind === "marquee") {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const bounds = canvas.getBoundingClientRect();
      state.x = clientX - bounds.left;
      state.y = clientY - bounds.top;
      return;
    }

    if (state.kind === "move") {
      const primary = project.clips.find((candidate) => candidate.id === state.primary);
      const anchor = state.origins.find((origin) => origin.clipId === state.primary);
      if (!primary || !anchor) return;

      // Only the grabbed clip snaps; everything else keeps its offset from it,
      // so the shape of a multi-clip selection is preserved exactly.
      const raw = time - state.grab;
      const snapped = snap
        ? snapTime(project, raw, {
            threshold: 8 * secondsPerPixel,
            playhead,
            exclude: primary.id,
          })
        : raw;

      const deltaTime = snapped - anchor.start;
      const currentRow = rowAt(clientY)
        ? rows.findIndex((track) => track.id === rowAt(clientY)?.id)
        : anchor.row;
      const deltaRow = currentRow - state.originRow;

      onMoveClips(
        state.origins.flatMap((origin) => {
          const row = Math.min(rows.length - 1, Math.max(0, origin.row + deltaRow));
          const track = rows[row];
          if (!track) return [];
          return [
            { clipId: origin.clipId, start: Math.max(0, origin.start + deltaTime), trackId: track.id },
          ];
        }),
      );
      return;
    }

    const clip = project.clips.find((candidate) => candidate.id === state.clipId);
    if (!clip) return;
    if (state.kind === "trimStart") onTrimClip(clip.id, "start", time - clip.start);
    if (state.kind === "trimEnd") onTrimClip(clip.id, "end", time - (clip.start + clip.duration));
  };
  applyDragRef.current = applyDrag;

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    pointer.current = { x: event.clientX, y: event.clientY };

    if (!drag.current) {
      edgeSpeed.current = 0;
      // Cursor feedback: the edges are grabbable, the body is draggable.
      const hit = clipAt(event.clientX, event.clientY);
      canvas.style.cursor =
        tool === "razor" && hit
          ? "crosshair"
          : hit?.edge
            ? "ew-resize"
            : hit
              ? "grab"
              : "text";
      return;
    }

    // Drag the playhead (or a clip) toward either edge and the view starts
    // travelling with it, so it cannot be parked somewhere off-screen and
    // lost. Speed ramps with how far past the margin the pointer is.
    const bounds = canvas.getBoundingClientRect();
    const past =
      event.clientX < bounds.left + EDGE_MARGIN
        ? event.clientX - (bounds.left + EDGE_MARGIN)
        : event.clientX > bounds.right - EDGE_MARGIN
          ? event.clientX - (bounds.right - EDGE_MARGIN)
          : 0;

    edgeSpeed.current =
      Math.sign(past) * Math.min(Math.abs(past) / EDGE_MARGIN, 1) * EDGE_MAX_PIXELS_PER_FRAME;

    applyDrag(event.clientX, event.clientY);
  };

  const endDrag = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    const state = drag.current;
    if (state?.kind === "marquee") {
      // Commit on release rather than live: selecting as the band sweeps looks
      // busy and makes a mistaken sweep hard to back out of.
      const band = normalise(state);
      const caught = project.clips.filter((clip) => {
        const rect = clipRect(clip, rows, secondsPerPixel, scrollLeft, trackScroll);
        return rect !== null && intersects(band, rect);
      });

      const ids = caught.map((clip) => clip.id);
      onSelectClips(state.additive ? [...new Set([...state.basis, ...ids])] : ids);
    }

    drag.current = null;
    edgeSpeed.current = 0;
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>) => {
    if (event.ctrlKey || event.metaKey) {
      onZoom(event.deltaY > 0 ? 1.15 : 1 / 1.15, timeAt(event.clientX));
      return;
    }

    // A trackpad's horizontal axis always pans time. Shift does the same for a
    // wheel, which has no horizontal axis of its own. Everything else scrolls
    // the track stack, which is what a plain wheel means in every other list.
    if (event.deltaX !== 0 || event.shiftKey) {
      const delta = (event.deltaX !== 0 ? event.deltaX : event.deltaY) * secondsPerPixel;
      onScroll(Math.max(0, scrollLeft + delta));
      return;
    }

    onTrackScroll(clampTrackScroll(trackScroll + event.deltaY, rows.length, canvasRef.current));
  };

  return (
    <div className={PANEL_SHELL}>
      <Bar>
        <IconButton
          icon="select"
          label="Select tool (V)"
          active={tool === "select"}
          onClick={() => onToolChange("select")}
        />
        <IconButton
          icon="razor"
          label="Razor tool (C)"
          active={tool === "razor"}
          onClick={() => onToolChange("razor")}
        />
        <Divider />
        <IconButton icon="minus" label="Split at playhead (S)" onClick={onSplitAtPlayhead} />
        <IconButton
          icon="trash"
          label={
            selectedClipIds.length > 1
              ? `Delete ${selectedClipIds.length} clips (Del)`
              : "Delete selected (Del)"
          }
          tone="danger"
          disabled={selectedClipIds.length === 0}
          onClick={onDeleteSelected}
        />
        {selectedClipIds.length > 1 && (
          <span className="px-1 font-technical text-[10px] text-accent">
            {selectedClipIds.length}
          </span>
        )}
        <Divider />
        <IconButton
          icon="magnet"
          label="Snapping (N)"
          active={snap}
          onClick={() => onSnapChange(!snap)}
        />
        <Divider />
        <IconButton icon="plus" label="Add track" onClick={onAddTrack} />

        <Spacer />

        {/* Fixed width for the same reason: without it the zoom controls to
            its right shuffle every time the frame digits change. */}
        <span className="w-30 px-2 text-right font-mono text-[10px] tabular-nums text-tertiary">
          {timecode(playhead, frameRate)}
        </span>
        <Divider />
        <IconButton
          icon="fit"
          label="Fit to window (F)"
          onClick={() => onFit(canvasRef.current?.clientWidth ?? 0)}
        />
        <IconButton icon="minus" label="Zoom out" size={7} onClick={() => onZoom(1.4)} />
        <IconButton icon="plus" label="Zoom in" size={7} onClick={() => onZoom(1 / 1.4)} />
      </Bar>

      <div className="flex min-h-0 flex-1">
        <div
          className="flex shrink-0 flex-col border-r border-hairline"
          style={{ width: HEADER_WIDTH }}
        >
          {/* Sits opposite the ruler and does not scroll with the lanes. */}
          <div className="shrink-0 border-b border-hairline" style={{ height: RULER_HEIGHT }} />

          {/*
            The headers are a real scroll container, so the native scrollbar and
            trackpad both drive the track stack. Its offset is pushed up to the
            canvas rather than the two keeping separate positions - one source
            of truth is the only way the lanes and their labels stay aligned.
          */}
          <div
            ref={headerScroll}
            onScroll={(event) => onTrackScroll(event.currentTarget.scrollTop)}
            className="thin-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          >
          {rows.map((track) => (
            <TrackHeader
              key={track.id}
              track={track}
              removable={rows.length > 1}
              onFlag={onTrackFlag}
              onRemove={onRemoveTrack}
              onRename={onRenameTrack}
            />
          ))}
          </div>
        </div>

        <canvas
          ref={canvasRef}
          {...{ [CANVAS_MARKER]: true }}
          className="min-w-0 flex-1"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onWheel={onWheel}
          onContextMenu={(event) => {
            event.preventDefault();
            const hit = clipAt(event.clientX, event.clientY);
            if (hit) onClipContextMenu(hit.clip.id, event.clientX, event.clientY);
          }}
        />
      </div>
    </div>
  );
}

/**
 * One lane's controls.
 *
 * Both a visibility and a mute toggle on every track, because a track is not
 * typed - the same lane can be carrying a video clip and an mp3 side by side,
 * and each needs its own switch.
 */
function TrackHeader({
  track,
  removable,
  onFlag,
  onRemove,
  onRename,
}: {
  track: Track;
  removable: boolean;
  onFlag: (trackId: string, flag: "visible" | "muted", value: boolean) => void;
  onRemove: (trackId: string) => void;
  onRename: (trackId: string, name: string) => void;
}) {
  const silent = !track.visible && track.muted;
  const [renaming, setRenaming] = useState(false);

  return (
    <div
      className="group flex items-center gap-0.5 border-b border-hairline px-2"
      style={{ height: TRACK_HEIGHT }}
    >
      {renaming ? (
        <input
          autoFocus
          defaultValue={track.name}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          // Committing on blur means clicking away saves rather than discards,
          // which is what every rename-in-place in this app should do.
          onBlur={(event) => {
            onRename(track.id, event.target.value);
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = track.name;
              event.currentTarget.blur();
            }
          }}
          className="min-w-0 flex-1 rounded bg-sunken px-1 py-0.5 text-xs text-primary
                     outline-none ring-1 ring-accent"
        />
      ) : (
        <span
          onDoubleClick={() => setRenaming(true)}
          title="Double-click to rename"
          className={`min-w-0 flex-1 cursor-default truncate text-xs ${
            silent ? "text-tertiary" : "text-primary"
          }`}
        >
          {track.name}
        </span>
      )}

      {removable && !renaming && (
        <button
          type="button"
          aria-label={`Remove ${track.name}`}
          title={`Remove ${track.name} and its clips`}
          onClick={() => onRemove(track.id)}
          className="invisible shrink-0 cursor-pointer rounded p-1 text-tertiary transition-colors
                     hover:bg-danger-soft hover:text-danger group-hover:visible"
        >
          <Icon name="close" size={11} />
        </button>
      )}
      <IconButton
        icon={track.visible ? "eye" : "eyeOff"}
        label={track.visible ? "Hide picture on this track" : "Show picture on this track"}
        size={7}
        active={!track.visible}
        onClick={() => onFlag(track.id, "visible", !track.visible)}
      />
      <IconButton
        icon={track.muted ? "volumeOff" : "volume"}
        label={track.muted ? "Unmute this track" : "Mute this track"}
        size={7}
        active={track.muted}
        onClick={() => onFlag(track.id, "muted", !track.muted)}
      />
    </div>
  );
}

/**
 * Where a bin item dropped at these client coordinates would land.
 *
 * Lives here because this module owns the timeline's geometry, and returns
 * null when the point is outside the canvas or above the first track - so the
 * caller can simply do nothing.
 */
export function resolveDrop(
  clientX: number,
  clientY: number,
  {
    tracks,
    secondsPerPixel,
    scrollLeft,
    trackScroll,
  }: { tracks: Track[]; secondsPerPixel: number; scrollLeft: number; trackScroll: number },
): { trackId: string; start: number } | null {
  const canvas = document.querySelector<HTMLCanvasElement>(`[${CANVAS_MARKER}]`);
  if (!canvas) return null;

  const bounds = canvas.getBoundingClientRect();
  if (clientX < bounds.left || clientX > bounds.right) return null;
  if (clientY < bounds.top || clientY > bounds.bottom) return null;

  const offsetY = clientY - bounds.top - RULER_HEIGHT;
  if (offsetY < 0) return null;

  const rows = [...tracks].reverse();
  const track = rows[Math.floor((offsetY + trackScroll) / TRACK_HEIGHT)];
  if (!track) return null;

  return {
    trackId: track.id,
    start: Math.max(0, (clientX - bounds.left) * secondsPerPixel + scrollLeft),
  };
}

/** Keeps the track stack from scrolling past its own contents. */
export function clampTrackScroll(
  value: number,
  trackCount: number,
  canvas: HTMLCanvasElement | null,
): number {
  const viewport = Math.max(0, (canvas?.clientHeight ?? 0) - RULER_HEIGHT);
  const content = trackCount * TRACK_HEIGHT;
  return Math.min(Math.max(0, content - viewport), Math.max(0, value));
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Where a clip sits on the canvas, or null if its track is gone. */
function clipRect(
  clip: Clip,
  rows: readonly Track[],
  secondsPerPixel: number,
  scrollLeft: number,
  trackScroll: number,
): Rect | null {
  const rowIndex = rows.findIndex((track) => track.id === clip.trackId);
  if (rowIndex < 0) return null;
  return {
    x: (clip.start - scrollLeft) / secondsPerPixel,
    y: RULER_HEIGHT + rowIndex * TRACK_HEIGHT - trackScroll,
    width: clip.duration / secondsPerPixel,
    height: TRACK_HEIGHT,
  };
}

/** A drag band has a start and a current corner; this gives it a positive size. */
function normalise(band: { originX: number; originY: number; x: number; y: number }): Rect {
  return {
    x: Math.min(band.originX, band.x),
    y: Math.min(band.originY, band.y),
    width: Math.abs(band.x - band.originX),
    height: Math.abs(band.y - band.originY),
  };
}

/** Touching counts as intersecting, so a band brushing a clip catches it. */
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Picks a tick spacing that keeps labels readable at any zoom. */
function tickInterval(secondsPerPixel: number): number {
  const candidates = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  return candidates.find((seconds) => seconds / secondsPerPixel >= 90) ?? candidates.at(-1)!;
}

function drawRuler(
  context: CanvasRenderingContext2D,
  width: number,
  scrollLeft: number,
  secondsPerPixel: number,
  frameRate: number,
) {
  context.fillStyle = COLORS.ruler;
  context.fillRect(0, 0, width, RULER_HEIGHT);
  context.strokeStyle = COLORS.hairline;
  context.beginPath();
  context.moveTo(0, RULER_HEIGHT - 0.5);
  context.lineTo(width, RULER_HEIGHT - 0.5);
  context.stroke();

  const interval = tickInterval(secondsPerPixel);
  context.fillStyle = COLORS.text;
  context.font = '10px "Cabinet Grotesk", system-ui, sans-serif';
  context.textBaseline = "middle";

  for (
    let seconds = Math.ceil(scrollLeft / interval) * interval;
    (seconds - scrollLeft) / secondsPerPixel < width;
    seconds += interval
  ) {
    const x = Math.round((seconds - scrollLeft) / secondsPerPixel) + 0.5;
    context.strokeStyle = COLORS.tickMajor;
    context.beginPath();
    context.moveTo(x, RULER_HEIGHT - 7);
    context.lineTo(x, RULER_HEIGHT);
    context.stroke();
    context.fillText(timecode(seconds, frameRate), x + 5, RULER_HEIGHT / 2 - 2);
  }
}

/** Height of the coloured name strip at the top of every clip. */
const CLIP_HEADER = 17;
const LABEL_FONT = '11px "Cabinet Grotesk", system-ui, sans-serif';

/**
 * Truncates text to fit, with an ellipsis.
 *
 * Canvas has no built-in equivalent of `text-overflow: ellipsis`. The
 * `maxWidth` argument to `fillText` is not it - that *condenses* the glyphs to
 * fit, which is what made long clip names look crushed rather than cut.
 *
 * Results are memoised because this runs for every visible clip on every
 * frame, and `measureText` forces text shaping each time it is called.
 */
const labelCache = new Map<string, string>();

function ellipsize(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";

  // Quantise the width so that a clip being dragged does not miss the cache on
  // every single frame.
  const key = `${text}|${Math.round(maxWidth / 4)}`;
  const cached = labelCache.get(key);
  if (cached !== undefined) return cached;

  let result = text;
  if (context.measureText(text).width > maxWidth) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (context.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    result = low > 0 ? `${text.slice(0, low)}…` : "";
  }

  // Plain cap rather than a real LRU: names are few and short-lived enough
  // that eviction order does not matter.
  if (labelCache.size > 512) labelCache.clear();
  labelCache.set(key, result);
  return result;
}

/** Clip fills, refreshed alongside COLORS. See `refreshCanvasPalette`. */
const PALETTE = {
  video: {
    body: "#16283d",
    header: "#2b6ca8",
    edge: "#2b6ca8",
  },
  audio: {
    body: "#123027",
    header: "#2f8a68",
    edge: "#2f8a68",
    wave: "rgba(190,240,216,0.65)",
  },
  image: {
    body: "#241a38",
    header: "#7b53c4",
    edge: "#7b53c4",
  },
};

function drawClip(
  context: CanvasRenderingContext2D,
  clip: Clip,
  x: number,
  trackY: number,
  width: number,
  selected: boolean,
  assets: MediaAssets,
  secondsPerPixel: number,
) {
  const y = trackY + 4;
  const height = TRACK_HEIGHT - 10;
  const drawWidth = Math.max(2, width);
  const palette =
    clip.kind === "video"
      ? PALETTE.video
      : clip.kind === "image"
        ? PALETTE.image
        : PALETTE.audio;
  const bodyY = y + CLIP_HEADER;
  const bodyHeight = height - CLIP_HEADER;

  context.save();
  // One clip path for the whole clip: artwork drawn inside it cannot bleed
  // past the rounded corners, so no separate masking is needed per layer.
  context.beginPath();
  context.roundRect(x, y, drawWidth, height, 5);
  context.clip();

  context.fillStyle = palette.body;
  context.fillRect(x, y, drawWidth, height);

  if (bodyHeight > 4) {
    if (clip.kind === "audio") {
      const peaks = assets.peaks.get(clip.mediaId);
      if (peaks) {
        drawWaveform(context, peaks, clip, x, bodyY, drawWidth, bodyHeight, secondsPerPixel);
      }
    } else {
      // Video and stills share this path: a still is cached as a one-frame
      // filmstrip, so tiling it repeats the same picture along the clip.
      const strip = assets.strips.get(clip.mediaId);
      const frames = assets.stripFrames.get(clip.mediaId);
      if (strip && frames) {
        drawFilmstrip(context, strip, frames, x, bodyY, drawWidth, bodyHeight);
      }
    }
  }

  if (clip.fadeIn > 0 || clip.fadeOut > 0) {
    drawFades(context, clip, x, bodyY, drawWidth, bodyHeight, secondsPerPixel);
  }

  context.fillStyle = palette.header;
  context.fillRect(x, y, drawWidth, CLIP_HEADER);

  if (drawWidth > 30) {
    context.fillStyle = COLORS.clipText;
    context.font = LABEL_FONT;
    context.textBaseline = "middle";
    const label = ellipsize(context, clip.name, drawWidth - 14);
    if (label) context.fillText(label, x + 7, y + CLIP_HEADER / 2 + 0.5);
  }

  context.restore();

  context.beginPath();
  context.roundRect(x, y, drawWidth, height, 5);
  context.strokeStyle = selected ? COLORS.clipSelected : palette.edge;
  context.lineWidth = selected ? 2 : 1;
  context.stroke();
}

/**
 * Draws the fade ramps as wedges over the clip body.
 *
 * The shaded area is the part being attenuated and the bright line is the
 * envelope itself - the same shape every editor draws, because it reads as
 * "this much is being taken away" at a glance.
 *
 * On a video clip the wedge is confined to a band at the bottom. The fade is
 * an *audio* property, and shading the picture would say it fades to black.
 */
function drawFades(
  context: CanvasRenderingContext2D,
  clip: Clip,
  x: number,
  bodyY: number,
  width: number,
  bodyHeight: number,
  secondsPerPixel: number,
) {
  const band = clip.kind === "audio" ? bodyHeight : Math.min(10, bodyHeight);
  const top = bodyY + bodyHeight - band;
  const bottom = bodyY + bodyHeight;
  if (band <= 1) return;

  context.save();
  context.beginPath();
  context.rect(x, top, width, band);
  context.clip();

  const ramp = (seconds: number, fromLeft: boolean) => {
    const span = Math.min(seconds / secondsPerPixel, width);
    if (span < 1) return;

    const originX = fromLeft ? x : x + width;
    const endX = fromLeft ? x + span : x + width - span;

    context.fillStyle = "rgba(0,0,0,0.42)";
    context.beginPath();
    context.moveTo(originX, top);
    context.lineTo(endX, top);
    context.lineTo(originX, bottom);
    context.closePath();
    context.fill();

    context.strokeStyle = "rgba(255,255,255,0.75)";
    context.lineWidth = 1.5;
    context.beginPath();
    context.moveTo(originX, bottom);
    context.lineTo(endX, top);
    context.stroke();
  };

  if (clip.fadeIn > 0) ramp(clip.fadeIn, true);
  if (clip.fadeOut > 0) ramp(clip.fadeOut, false);

  context.restore();
}

/**
 * Tiles frames from a single strip image across the clip body.
 *
 * Each frame is drawn at its natural aspect ratio for the available height,
 * and which frame appears is chosen by how far along the clip it sits - so a
 * long clip repeats frames rather than stretching four of them.
 */
function drawFilmstrip(
  context: CanvasRenderingContext2D,
  strip: ImageBitmap,
  frames: number,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const tileWidth = strip.width / frames;
  const drawWidth = height * (tileWidth / strip.height);
  if (!Number.isFinite(drawWidth) || drawWidth <= 0) return;

  const columns = Math.ceil(width / drawWidth);
  for (let column = 0; column < columns; column += 1) {
    const fraction = columns > 1 ? column / (columns - 1) : 0;
    const index = Math.min(frames - 1, Math.round(fraction * (frames - 1)));
    context.drawImage(
      strip,
      index * tileWidth,
      0,
      tileWidth,
      strip.height,
      x + column * drawWidth,
      y,
      drawWidth,
      height,
    );
  }
}

/**
 * Draws the cached peaks, mirrored about a centre line.
 *
 * Zoomed out, one pixel covers many buckets, so each column takes the extremes
 * across its whole range - otherwise transients disappear and loud passages
 * look quiet. The scan is capped at eight samples per column so that zooming
 * all the way out stays cheap.
 */
function drawWaveform(
  context: CanvasRenderingContext2D,
  peaks: Peaks,
  clip: Clip,
  x: number,
  y: number,
  width: number,
  height: number,
  secondsPerPixel: number,
) {
  const centre = y + height / 2;
  const half = height / 2 - 1;
  // The drawn amplitude follows the clip's gain, so turning a clip up makes
  // its waveform visibly taller. Clamped, because a boosted waveform that
  // overflowed its clip would bleed into the lane above.
  const gain = Math.max(0, clip.volume);
  const perPixel = Math.max(1, Math.round(secondsPerPixel * peaks.bucketsPerSecond));
  const stride = Math.max(1, Math.floor(perPixel / 8));

  context.fillStyle = PALETTE.audio.wave;
  context.beginPath();

  for (let column = 0; column < width; column += 1) {
    const from = Math.floor((clip.sourceStart + column * secondsPerPixel) * peaks.bucketsPerSecond);
    if (from < 0 || from >= peaks.max.length) continue;
    const to = Math.min(from + perPixel, peaks.max.length);

    let low = 0;
    let high = 0;
    for (let bucket = from; bucket < to; bucket += stride) {
      if (peaks.min[bucket] < low) low = peaks.min[bucket];
      if (peaks.max[bucket] > high) high = peaks.max[bucket];
    }

    const top = centre - Math.min(1, high * gain) * half;
    const bottom = centre - Math.max(-1, low * gain) * half;
    context.rect(x + column, top, 1, Math.max(1, bottom - top));
  }

  context.fill();

  context.strokeStyle = "rgba(255,255,255,0.18)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, Math.round(centre) + 0.5);
  context.lineTo(x + width, Math.round(centre) + 0.5);
  context.stroke();
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
  context.lineTo(position, 9);
  context.closePath();
  context.fill();
}
