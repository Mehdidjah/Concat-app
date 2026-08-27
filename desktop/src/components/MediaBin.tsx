import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

import type { MediaAssets } from "../lib/assets";
import { subscribeAssets } from "../lib/assets";
import {
  EFFECT_CATEGORIES,
  EFFECTS,
  TRANSITION_CATEGORIES,
  TRANSITIONS,
  type EffectCategory,
  type TransitionCategory,
} from "../lib/effects";
import type { MediaItem } from "../lib/project";
import { themeColor } from "../lib/theme";
import { shortDuration } from "../lib/time";
import { ErrorNotice } from "./ErrorNotice";
import { Icon } from "./Icon";
import { Empty, Panel } from "./Panel";

/** Which kinds of media the bin is showing. */
export interface BinFilter {
  video: boolean;
  audio: boolean;
  image: boolean;
}

export const ALL_MEDIA: BinFilter = { video: true, audio: true, image: true };

/** The pages of the library strip, in display order. */
type LibraryTab = "media" | "text" | "transitions" | "effects";

const TABS: { id: LibraryTab; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "text", label: "Text" },
  { id: "transitions", label: "Transitions" },
  { id: "effects", label: "Effects" },
];

/**
 * The library panel.
 *
 * A strip of pages across the top - Media, Text, Transitions, Effects - then a
 * full-width divider, then the page itself split in two: a narrow category
 * sidebar on the left, and the browsing area on the right where media, effect
 * previews and so on are shown.
 *
 * Media is the only page that is fully live. Text offers the one title style
 * that exists. Transitions and Effects browse the catalogues in
 * `lib/effects.ts` but cannot yet be applied - the engine has no video effect
 * pipeline - so their cards say "Soon" instead of pretending to drag.
 *
 * Media items are drag sources: dragging one onto the timeline places a clip
 * at the drop position. That is the primary way material gets into an edit, so
 * it needs to be the obvious one - hence the whole card being the drag handle
 * rather than some grip affordance.
 */
export function MediaBin({
  items,
  filter,
  selectedId,
  busy,
  error,
  onFilter,
  onAddText,
  onSelect,
  onImport,
  onRemove,
  onDismissError,
  onBeginDrag,
  onAddToTimeline,
  onApplyEffect,
  onApplyTransition,
  assets,
  dropping,
}: {
  items: MediaItem[];
  filter: BinFilter;
  /** A file is being dragged over the window from outside. */
  dropping: boolean;
  /** Shared with the timeline, so a waveform is only ever computed once. */
  assets: MediaAssets;
  selectedId: string | null;
  busy: boolean;
  error: string | null;
  onFilter: (filter: BinFilter) => void;
  /** Puts a new title on the timeline at the playhead. */
  onAddText: () => void;
  onSelect: (id: string) => void;
  onImport: (paths: string[]) => void;
  onRemove: (id: string) => void;
  onDismissError: () => void;
  /** Called once the pointer has moved far enough to count as a drag. */
  onBeginDrag: (item: MediaItem, clientX: number, clientY: number) => void;
  onAddToTimeline: (mediaId: string) => void;
  /** Applies an effect to the selected clip; the app validates and explains. */
  onApplyEffect: (effectId: string) => void;
  /** Puts a transition on the selected clip's cut; the app validates. */
  onApplyTransition: (transitionId: string) => void;
}) {
  const [tab, setTab] = useState<LibraryTab>("media");
  const [effectCategory, setEffectCategory] = useState<EffectCategory>("basic");
  const [transitionCategory, setTransitionCategory] = useState<TransitionCategory>("basic");

  return (
    <Panel
      // Dropped files land in the bin, so the bin is what lights up. A
      // full-screen overlay would obscure the editor to say something that
      // only concerns one panel.
      className={dropping ? "ring-2 ring-accent ring-inset" : ""}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/* The page strip. Its bottom border is the full-width divider. */}
        <div className="shrink-0 border-b border-hairline px-2 pb-2 pt-2">
          <div className="flex rounded-lg bg-sunken p-0.5">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={`flex-1 cursor-pointer truncate rounded-md px-1.5 py-1 text-[11px]
                            transition-colors ${
                              tab === entry.id
                                ? "bg-panel text-primary shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
                                : "text-secondary hover:text-primary"
                            }`}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>

        {/* The page: category sidebar on the left, browsing area on the right. */}
        <div className="flex min-h-0 flex-1">
          <aside className="thin-scroll w-26 shrink-0 overflow-y-auto border-r border-hairline py-1">
            {tab === "media" && <MediaCategories items={items} filter={filter} onFilter={onFilter} />}
            {tab === "text" && (
              <CategoryGroup title="Text">
                <CategoryRow label="Titles" selected onSelect={() => {}} />
              </CategoryGroup>
            )}
            {tab === "transitions" && (
              <CategoryGroup title="Transitions">
                {TRANSITION_CATEGORIES.map((category) => (
                  <CategoryRow
                    key={category.id}
                    label={category.label}
                    selected={transitionCategory === category.id}
                    onSelect={() => setTransitionCategory(category.id)}
                  />
                ))}
              </CategoryGroup>
            )}
            {tab === "effects" && (
              <CategoryGroup title="Video Effects">
                {EFFECT_CATEGORIES.map((category) => (
                  <CategoryRow
                    key={category.id}
                    label={category.label}
                    selected={effectCategory === category.id}
                    onSelect={() => setEffectCategory(category.id)}
                  />
                ))}
              </CategoryGroup>
            )}
          </aside>

          <div className="thin-scroll min-w-0 flex-1 overflow-y-auto">
            {tab === "media" && (
              <MediaPage
                items={items}
                filter={filter}
                selectedId={selectedId}
                busy={busy}
                error={error}
                dropping={dropping}
                assets={assets}
                onSelect={onSelect}
                onImport={onImport}
                onRemove={onRemove}
                onDismissError={onDismissError}
                onBeginDrag={onBeginDrag}
                onAddToTimeline={onAddToTimeline}
              />
            )}
            {tab === "text" && <TextPage onAddText={onAddText} />}
            {tab === "transitions" && (
              <TransitionsPage category={transitionCategory} onApply={onApplyTransition} />
            )}
            {tab === "effects" && <EffectsPage category={effectCategory} onApply={onApplyEffect} />}
          </div>
        </div>
      </div>
    </Panel>
  );
}

// ── the category sidebar ─────────────────────────────────────────────────────

/**
 * A collapsible dropdown of categories - "Video Effects" with its list under
 * it, and the equivalents on the other pages.
 */
function CategoryGroup({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="px-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1.5
                   text-[11px] font-medium text-secondary transition-colors hover:bg-hover
                   hover:text-primary"
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={10} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{title}</span>
      </button>
      {open && <div className="flex flex-col gap-px pb-1">{children}</div>}
    </div>
  );
}

function CategoryRow({
  label,
  count,
  selected,
  onSelect,
}: {
  label: string;
  count?: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-center gap-1 rounded-md py-1 pl-4.5 pr-1.5
                  text-[11px] transition-colors ${
                    selected ? "bg-active text-primary" : "text-secondary hover:bg-hover"
                  }`}
    >
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="font-technical text-[10px] text-tertiary">{count}</span>
      )}
    </button>
  );
}

/** One media kind on, the rest off - what a sidebar category means. */
function onlyKind(kind: keyof BinFilter): BinFilter {
  return { video: false, audio: false, image: false, [kind]: true };
}

const KIND_LABELS = { video: "Video", audio: "Audio", image: "Images" } as const;

function MediaCategories({
  items,
  filter,
  onFilter,
}: {
  items: MediaItem[];
  filter: BinFilter;
  onFilter: (filter: BinFilter) => void;
}) {
  const kinds = ["video", "audio", "image"] as const;
  const enabled = kinds.filter((kind) => filter[kind]);
  // The old filter menu could leave two of three kinds on; the sidebar has no
  // row for that state, so nothing highlights until a category is clicked.
  const selected = enabled.length === 3 ? "all" : enabled.length === 1 ? enabled[0] : null;

  return (
    <CategoryGroup title="Media">
      <CategoryRow
        label="All media"
        count={items.length}
        selected={selected === "all"}
        onSelect={() => onFilter(ALL_MEDIA)}
      />
      {kinds.map((kind) => (
        <CategoryRow
          key={kind}
          label={KIND_LABELS[kind]}
          count={items.filter((item) => item.kind === kind).length}
          selected={selected === kind}
          onSelect={() => onFilter(onlyKind(kind))}
        />
      ))}
    </CategoryGroup>
  );
}

// ── the media page ───────────────────────────────────────────────────────────

/** Cards sized for the browsing area, however narrow the panel is dragged. */
const CARD_GRID = "grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 px-2 pb-2";

function MediaPage({
  items,
  filter,
  selectedId,
  busy,
  error,
  dropping,
  assets,
  onSelect,
  onImport,
  onRemove,
  onDismissError,
  onBeginDrag,
  onAddToTimeline,
}: {
  items: MediaItem[];
  filter: BinFilter;
  selectedId: string | null;
  busy: boolean;
  error: string | null;
  dropping: boolean;
  assets: MediaAssets;
  onSelect: (id: string) => void;
  onImport: (paths: string[]) => void;
  onRemove: (id: string) => void;
  onDismissError: () => void;
  onBeginDrag: (item: MediaItem, clientX: number, clientY: number) => void;
  onAddToTimeline: (mediaId: string) => void;
}) {
  const browse = async () => {
    if (busy) return;
    const chosen = await open({
      multiple: true,
      title: "Import media",
      filters: [
        {
          name: "Media",
          extensions: [
            "mp4", "mov", "mkv", "webm", "avi", "m4v",
            "mp3", "wav", "flac", "aac", "m4a", "ogg", "opus",
            "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif", "gif",
          ],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });

    // The picker hands back a string for one file and an array for many.
    if (Array.isArray(chosen)) onImport(chosen);
    else if (typeof chosen === "string") onImport([chosen]);
  };

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

  const visible = items.filter((item) => filter[item.kind]);

  return (
    <>
      <div className="px-2 pb-2 pt-2">
        <button
          type="button"
          onClick={() => void browse()}
          disabled={busy}
          className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg
                     border border-dashed border-hairline-strong px-3 py-2.5 text-xs text-secondary
                     transition-colors hover:border-accent hover:bg-hover hover:text-primary
                     disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="import" size={14} />
          {busy ? "Importing..." : "Import media"}
        </button>
      </div>

      {error && <ErrorNotice message={error} onDismiss={onDismissError} className="mx-2 mb-2" />}

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
        <ul className={CARD_GRID}>
          {visible.map((item) => (
            <li
              key={item.id}
              onPointerDown={(event) => beginDrag(event, item)}
              onClick={() => onSelect(item.id)}
              onDoubleClick={() => onAddToTimeline(item.id)}
              // The details that used to sit on a second line live here now.
              // They are worth having, but not worth a permanent row each.
              title={`${item.name}
${describe(item)}
Drag onto a track, or double-click to add at the playhead`}
              className="group cursor-grab select-none active:cursor-grabbing"
            >
              <div
                className={`relative overflow-hidden rounded-lg transition-shadow ${
                  item.id === selectedId
                    ? "ring-2 ring-accent"
                    : "ring-1 ring-hairline group-hover:ring-hairline-strong"
                }`}
              >
                <MediaThumb item={item} assets={assets} />

                <span className="pointer-events-none absolute left-1 top-1 flex h-5 w-5
                                 items-center justify-center rounded bg-black/55 text-white">
                  <Icon
                    name={item.kind === "video" ? "film" : item.kind === "image" ? "image" : "music"}
                    size={11}
                  />
                </span>

                <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/55
                                 px-1 py-px font-technical text-[10px] text-white">
                  {item.kind === "image" ? "still" : shortDuration(item.duration)}
                </span>

                <button
                  type="button"
                  aria-label={`Remove ${item.name}`}
                  title="Remove from bin"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(item.id);
                  }}
                  className="invisible absolute right-1 top-1 cursor-pointer rounded bg-black/55 p-1
                             text-white transition-colors hover:bg-danger group-hover:visible"
                >
                  <Icon name="close" size={10} />
                </button>
              </div>

              <span className="mt-1 block truncate text-[11px] leading-tight text-secondary">
                {item.name}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The second line that used to be shown for every item, now on hover. */
function describe(item: MediaItem): string {
  if (item.kind === "audio") return item.audioCodec ?? "audio";
  const size = `${item.width}x${item.height}`;
  return item.kind === "image" ? `${size} still` : `${size} · ${item.frameRate?.toFixed(2)} fps`;
}

// ── the text page ────────────────────────────────────────────────────────────

function TextPage({ onAddText }: { onAddText: () => void }) {
  return (
    <ul className={`${CARD_GRID} pt-2`}>
      <li
        onClick={onAddText}
        onDoubleClick={onAddText}
        title="Adds a title at the playhead"
        className="group cursor-pointer select-none"
      >
        <div
          className="relative flex aspect-video items-center justify-center overflow-hidden
                     rounded-lg bg-sunken ring-1 ring-hairline transition-shadow
                     group-hover:ring-hairline-strong"
        >
          <span className="text-xl font-semibold text-primary">Aa</span>
        </div>
        <span className="mt-1 block truncate text-[11px] leading-tight text-secondary">
          Default title
        </span>
      </li>
    </ul>
  );
}

// ── the transitions and effects pages ────────────────────────────────────────

/**
 * A catalogue card. Clickable when the thing it offers actually works;
 * otherwise the "Soon" badge stays - the honest version of a disabled drag,
 * kept for the motion transitions the engine cannot animate yet.
 */
function CatalogueCard({
  label,
  blurb,
  onApply,
  children,
}: {
  label: string;
  blurb: string;
  /** Absent means not implemented yet - the card browses but does nothing. */
  onApply?: () => void;
  children: ReactNode;
}) {
  return (
    <li
      title={`${label}\n${blurb}\n${onApply ? "Click to apply to the selected clip" : "Not available yet"}`}
      onClick={onApply}
      className={`group select-none ${onApply ? "cursor-pointer" : ""}`}
    >
      <div
        className={`relative flex aspect-video items-center justify-center overflow-hidden
                    rounded-lg bg-sunken ring-1 ring-hairline ${
                      onApply ? "transition-shadow group-hover:ring-hairline-strong" : ""
                    }`}
      >
        {children}
        {onApply ? (
          <span
            className="invisible absolute bottom-1 right-1 flex h-5 w-5 items-center
                       justify-center rounded bg-black/55 text-white group-hover:visible"
          >
            <Icon name="plus" size={11} />
          </span>
        ) : (
          <span
            className="absolute bottom-1 right-1 rounded bg-black/55 px-1 py-px font-technical
                       text-[10px] text-white"
          >
            Soon
          </span>
        )}
      </div>
      <span className="mt-1 block truncate text-[11px] leading-tight text-secondary">{label}</span>
    </li>
  );
}

function TransitionsPage({
  category,
  onApply,
}: {
  category: TransitionCategory;
  onApply: (transitionId: string) => void;
}) {
  const visible = TRANSITIONS.filter((transition) => transition.category === category);
  return (
    <ul className={`${CARD_GRID} pt-2`}>
      {visible.map((transition) => (
        <CatalogueCard
          key={transition.id}
          label={transition.label}
          blurb={transition.blurb}
          onApply={transition.implemented ? () => onApply(transition.id) : undefined}
        >
          <Icon name="transition" size={22} strokeWidth={1.5} className="text-tertiary" />
        </CatalogueCard>
      ))}
    </ul>
  );
}

function EffectsPage({
  category,
  onApply,
}: {
  category: EffectCategory;
  onApply: (effectId: string) => void;
}) {
  const visible = EFFECTS.filter((effect) => effect.category === category);
  return (
    <ul className={`${CARD_GRID} pt-2`}>
      {visible.map((effect) => (
        <CatalogueCard
          key={effect.id}
          label={effect.label}
          blurb={effect.blurb}
          onApply={() => onApply(effect.id)}
        >
          <span className="absolute inset-0" style={{ background: effect.swatch }} aria-hidden />
          <Icon name="sparkles" size={20} strokeWidth={1.5} className="relative text-white/85" />
        </CatalogueCard>
      ))}
    </ul>
  );
}

// ── thumbnails ───────────────────────────────────────────────────────────────

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
        // Cover-fit the first frame: letterboxing a small thumbnail wastes
        // most of it, and a crop reads better than bars at this size.
        const tile = strip.width / frames;
        const scale = Math.max(width / tile, height / strip.height);
        context.imageSmoothingQuality = "high";
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
    <span className="relative block aspect-video w-full overflow-hidden bg-sunken">
      <canvas ref={canvasRef} className="h-full w-full" />
      {!hasArt && (
        <span className="absolute inset-0 flex items-center justify-center text-tertiary">
          <Icon name={item.kind === "video" ? "film" : item.kind === "image" ? "image" : "music"} size={14} />
        </span>
      )}
    </span>
  );
}
