import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { MediaAssets } from "../lib/assets";
import { subscribeAssets } from "../lib/assets";
import type { MediaItem } from "../lib/project";
import { themeColor } from "../lib/theme";
import { shortDuration } from "../lib/time";
import { Icon, IconButton } from "./Icon";
import { Empty, Panel } from "./Panel";

export type BinTab = "media" | "audio";

/**
 * The media bin.
 *
 * Items are HTML5 drag sources: dragging one onto the timeline places a clip
 * at the drop position. That is the primary way material gets into an edit, so
 * it needs to be the obvious one - hence the whole row being the drag handle
 * rather than some grip affordance.
 */
export function MediaBin({
  items,
  tab,
  selectedId,
  busy,
  error,
  onTab,
  onSelect,
  onImport,
  onRemove,
  onDismissError,
  onBeginDrag,
  onAddToTimeline,
  assets,
  dropping,
}: {
  items: MediaItem[];
  tab: BinTab;
  /** A file is being dragged over the window from outside. */
  dropping: boolean;
  /** Shared with the timeline, so a waveform is only ever computed once. */
  assets: MediaAssets;
  selectedId: string | null;
  busy: boolean;
  error: string | null;
  onTab: (tab: BinTab) => void;
  onSelect: (id: string) => void;
  onImport: (path: string) => void;
  onRemove: (id: string) => void;
  onDismissError: () => void;
  /** Called once the pointer has moved far enough to count as a drag. */
  onBeginDrag: (item: MediaItem, clientX: number, clientY: number) => void;
  onAddToTimeline: (mediaId: string) => void;
}) {
  const [path, setPath] = useState("");

  /**
   * Starts a drag using raw pointer events rather than HTML5 drag-and-drop.
   *
   * HTML5 dragging cannot be used here at all: Tauri's `dragDropEnabled`
   * native handler intercepts every drag over the webview, including ones that
   * begin inside it, so an internal drag registers as an incoming OS file drop
   * and raises the import overlay. Pointer events never involve the OLE drag
   * machinery, so the two stop fighting.
   *
   * The 4px threshold keeps a sloppy click from starting a drag.
   */
  const beginDrag = (event: ReactPointerEvent<HTMLLIElement>, item: MediaItem) => {
    if (event.button !== 0) return;
    const originX = event.clientX;
    const originY = event.clientY;

    const onMove = (moveEvent: PointerEvent) => {
      if (Math.hypot(moveEvent.clientX - originX, moveEvent.clientY - originY) <= 4) return;
      cleanup();
      onBeginDrag(item, moveEvent.clientX, moveEvent.clientY);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
  };

  const visible = items.filter((item) => (tab === "audio" ? item.kind === "audio" : true));

  const submit = () => {
    // Windows' "Copy as path" wraps the path in quotes, and pasting that
    // straight in is the single most likely first action.
    const trimmed = path.trim().replace(/^"|"$/g, "");
    if (!trimmed || busy) return;
    onImport(trimmed);
    setPath("");
  };

  return (
    <Panel
      title={tab === "audio" ? "Audio" : "Media"}
      // Dropped files land in the bin, so the bin is what lights up. A
      // full-screen overlay would obscure the editor to say something that
      // only concerns one panel.
      className={dropping ? "ring-2 ring-accent ring-inset" : ""}
      actions={
        <span className="font-technical text-[10px] text-tertiary">
          {visible.length > 0 ? `${visible.length}` : ""}
        </span>
      }
    >
      <div className="flex gap-0.5 px-2 pb-2 pt-2">
        <TabButton active={tab === "media"} onClick={() => onTab("media")} icon="folder">
          All
        </TabButton>
        <TabButton active={tab === "audio"} onClick={() => onTab("audio")} icon="music">
          Audio
        </TabButton>
      </div>

      <div className="flex gap-1.5 px-2 pb-2">
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          placeholder="Paste a file path"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-sunken px-2 py-1.5
                     text-xs text-primary placeholder:text-tertiary
                     focus:border-accent focus:outline-none"
        />
        <IconButton
          icon="plus"
          label="Add media"
          size={7}
          onClick={submit}
          disabled={busy || path.trim() === ""}
        />
      </div>

      {error && (
        <div className="mx-2 mb-2 flex items-start gap-2 rounded-lg border border-danger bg-danger-soft px-2 py-1.5">
          <p className="min-w-0 flex-1 wrap-break-word font-technical text-[10px] leading-snug text-danger">
            {error}
          </p>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={onDismissError}
            className="shrink-0 cursor-pointer text-danger hover:text-danger"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <Empty
          icon={
            <Icon
              name="import"
              size={28}
              strokeWidth={1.5}
              className={dropping ? "text-accent" : ""}
            />
          }
        >
          {dropping
            ? "Release to import"
            : "Drop video and audio files anywhere in the window, or paste a path above."}
        </Empty>
      ) : (
        <ul className="flex flex-col gap-0.5 px-2 pb-2">
          {visible.map((item) => (
            <li
              key={item.id}
              onPointerDown={(event) => beginDrag(event, item)}
              onClick={() => onSelect(item.id)}
              onDoubleClick={() => onAddToTimeline(item.id)}
              title="Drag onto a track, or double-click to add at the playhead"
              className={`group flex cursor-grab select-none items-center gap-2.5 rounded-lg px-2 py-2
                          transition-colors active:cursor-grabbing ${
                            item.id === selectedId
                              ? "bg-accent-soft ring-1 ring-accent"
                              : "hover:bg-hover"
                          }`}
            >
              <MediaThumb item={item} assets={assets} />

              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-primary">{item.name}</span>
                <span className="block truncate font-technical text-[10px] text-secondary">
                  {item.kind === "audio"
                    ? (item.audioCodec ?? "audio")
                    : item.kind === "image"
                      ? `${item.width}x${item.height} still`
                      : `${item.width}x${item.height} · ${item.frameRate?.toFixed(2)} fps`}
                  {" · "}
                  {shortDuration(item.duration)}
                </span>
              </span>

              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                title="Remove from bin"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(item.id);
                }}
                className="hidden shrink-0 cursor-pointer rounded p-1 text-secondary
                           hover:bg-active hover:text-primary group-hover:block"
              >
                <Icon name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/**
 * The bin preview for one item.
 *
 * Reuses exactly the artwork the timeline uses - the first frame of the cached
 * filmstrip for video, the cached peaks for audio - so nothing is decoded
 * twice and a clip looks the same in the bin as it does on a track.
 *
 * Artwork arrives asynchronously and deliberately does not cause a React
 * render, so this subscribes and repaints itself instead.
 */
function MediaThumb({ item, assets }: { item: MediaItem; assets: MediaAssets }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hasArt, setHasArt] = useState(false);

  useEffect(() => {
    const paint = () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) return;

      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // Stills and footage both draw from the strip cache; only audio differs.
      if (item.kind !== "audio") {
        const strip = assets.strips.get(item.id);
        const frames = assets.stripFrames.get(item.id);
        if (!strip || !frames) {
          setHasArt(false);
          return;
        }
        // Cover-fit the first frame: letterboxing a 56px thumbnail wastes
        // most of it, and a crop reads better than bars at this size.
        const tile = strip.width / frames;
        const scale = Math.max(width / tile, height / strip.height);
        const drawWidth = tile * scale;
        const drawHeight = strip.height * scale;
        context.drawImage(
          strip,
          0,
          0,
          tile,
          strip.height,
          (width - drawWidth) / 2,
          (height - drawHeight) / 2,
          drawWidth,
          drawHeight,
        );
        setHasArt(true);
        return;
      }

      const peaks = assets.peaks.get(item.id);
      if (!peaks) {
        setHasArt(false);
        return;
      }

      // The whole file squeezed into the thumbnail, extremes per column so a
      // transient does not vanish at this scale.
      const centre = height / 2;
      const half = height / 2 - 1;
      const buckets = peaks.max.length;

      context.fillStyle = themeColor("clip-audio", "#2f8a68");
      context.beginPath();
      for (let column = 0; column < width; column += 1) {
        const from = Math.floor((column / width) * buckets);
        const to = Math.max(from + 1, Math.floor(((column + 1) / width) * buckets));

        let low = 0;
        let high = 0;
        for (let bucket = from; bucket < to && bucket < buckets; bucket += 1) {
          if (peaks.min[bucket] < low) low = peaks.min[bucket];
          if (peaks.max[bucket] > high) high = peaks.max[bucket];
        }

        const top = centre - high * half;
        context.rect(column, top, 1, Math.max(1, centre - low * half - top));
      }
      context.fill();
      setHasArt(true);
    };

    paint();
    return subscribeAssets(assets, paint);
  }, [assets, item]);

  return (
    <span className="relative h-8 w-14 shrink-0 overflow-hidden rounded-md bg-sunken">
      <canvas ref={canvasRef} className="h-full w-full" />
      {!hasArt && (
        <span className="absolute inset-0 flex items-center justify-center text-tertiary">
          <Icon name={item.kind === "video" ? "film" : item.kind === "image" ? "image" : "music"} size={14} />
        </span>
      )}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: "folder" | "music";
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 py-1.5
                  text-xs transition-colors ${
                    active ? "bg-accent text-on-accent" : "text-secondary hover:bg-hover"
                  }`}
    >
      <Icon name={icon} size={13} />
      {children}
    </button>
  );
}
