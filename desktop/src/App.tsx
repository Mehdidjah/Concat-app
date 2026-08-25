import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ContextMenu, type ContextTarget } from "./components/ContextMenu";
import { ExportDialog } from "./components/ExportDialog";
import { Icon } from "./components/Icon";
import { MediaBin, type BinTab } from "./components/MediaBin";
import { Preview, type PreviewSource } from "./components/Preview";
import { Resizer } from "./components/Resizer";
import { RightPanel, type RightTab } from "./components/RightPanel";
import { StartScreen, type ProjectSession } from "./components/StartScreen";
import { TitleBar } from "./components/TitleBar";
import { TimelinePanel, resolveDrop, type Tool } from "./components/TimelinePanel";
import { createAssets, requestAssets } from "./lib/assets";
import { AudioPreview } from "./lib/audio";
import { engineVersion, probeMedia, type ExportClip } from "./lib/engine";
import {
  addClip,
  addMedia,
  addTrack,
  clipGainAt,
  clipsAt,
  clipsOnTrack,
  createProject,
  findClip,
  firstFreeTrack,
  findMedia,
  findTrack,
  mergeClips,
  moveClip,
  moveClips,
  projectDuration,
  removeClips,
  removeTrack,
  renameTrack,
  setTrackFlag,
  snapTime,
  splitClip,
  toMediaItem,
  updateClip,
  trimClip,
  whyNotMerge,
  type MediaItem,
  type Project,
} from "./lib/project";
import { useTheme, type Theme } from "./lib/theme";
import { useTransport } from "./lib/transport";

const MIN_SECONDS_PER_PIXEL = 0.0005;
const MAX_SECONDS_PER_PIXEL = 2;

/**
 * The window: either the launch screen or an open editor.
 *
 * The editor is a separate component rather than a branch inside one, so that
 * every hook it owns - transport, audio, asset cache - mounts when a project
 * opens and unmounts when it closes. Closing a project therefore cannot leave
 * a stale audio element or a half-finished waveform behind.
 */
export function App() {
  const [session, setSession] = useState<ProjectSession | null>(null);
  // Owned here rather than in the editor so the launch screen is themed too,
  // and so the choice survives closing a project.
  const { theme, toggle } = useTheme();

  if (!session) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <TitleBar projectName="" menus={[]} theme={theme} onToggleTheme={toggle} />
        <div className="min-h-0 flex-1">
          <StartScreen onCreate={setSession} />
        </div>
      </div>
    );
  }

  return (
    <Editor
      session={session}
      theme={theme}
      onToggleTheme={toggle}
      onCloseProject={() => setSession(null)}
    />
  );
}

/**
 * The editor shell.
 *
 * Layout follows CapCut's shape: a thin custom title bar, a three-up top row
 * (bin, preview, details) and a full-width timeline beneath, every divider
 * draggable. Panels are docked and flush - in an editor, gutters are wasted
 * timeline.
 *
 * State here is window state (what is selected, where the playhead is, how
 * panels are sized) plus, for now, the edit itself. See lib/project.ts for why
 * the edit lives here temporarily and what makes moving it to the engine cheap.
 */
function Editor({
  session,
  theme,
  onToggleTheme,
  onCloseProject,
}: {
  session: ProjectSession;
  theme: Theme;
  onToggleTheme: () => void;
  onCloseProject: () => void;
}) {
  const [project, setProject] = useState<Project>(createProject);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [tab, setTab] = useState<BinTab>("media");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [context, setContext] = useState<ContextTarget | null>(null);
  const [mediaDrag, setMediaDrag] = useState<{ item: MediaItem; x: number; y: number } | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("details");

  // Panel geometry.
  const [leftWidth, setLeftWidth] = useState(340);
  const [rightWidth, setRightWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(340);

  // Timeline viewport.
  const [secondsPerPixel, setSecondsPerPixel] = useState(0.02);
  const [scrollLeft, setScrollLeft] = useState(0);
  // Vertical offset into the track stack, shared by the lanes and their headers.
  const [trackScroll, setTrackScroll] = useState(0);
  const zoomRef = useRef(secondsPerPixel);
  zoomRef.current = secondsPerPixel;

  const duration = projectDuration(project);
  const transport = useTransport({ duration });
  const { playhead, playing } = transport;

  // Read by event listeners that outlive the render that installed them.
  const latest = useRef({ project, secondsPerPixel, scrollLeft, trackScroll, snap, playhead });
  latest.current = { project, secondsPerPixel, scrollLeft, trackScroll, snap, playhead };

  // The project's rate is authoritative, not the first clip's. Timecode that
  // changes meaning when you import a 25fps file is worse than useless.
  const frameRate = session.frameRate;

  useEffect(() => {
    engineVersion()
      .then(setVersion)
      .catch(() => setVersion("unavailable"));
  }, []);

  // Waveforms and filmstrips. A ref, not state: the timeline reads this map
  // from inside its draw loop, so artwork arriving needs no re-render.
  const assets = useRef(createAssets());

  // ── media import ─────────────────────────────────────────────────────────
  const importPaths = useCallback(async (paths: string[]) => {
    setBusy(true);
    setError(null);
    for (const path of paths) {
      try {
        const item = toMediaItem(await probeMedia(path));
        setProject((current) => addMedia(current, item));
        setSelectedMediaId(item.id);
        // Fire and forget: the clip draws flat until the artwork lands.
        requestAssets(assets.current, item);
      } catch (cause) {
        // The engine's errors already name the file and quote FFmpeg.
        setError(String(cause));
      }
    }
    setBusy(false);
  }, []);

  // Files dropped from the OS. Tauri intercepts these before the webview sees
  // them, which is why this is an event subscription and not an HTML5 handler.
  useEffect(() => {
    if (!isTauri()) return;

    let stop: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") setDropping(true);
        else if (event.payload.type === "drop") {
          setDropping(false);
          void importPaths(event.payload.paths);
        } else setDropping(false);
      })
      .then((unlisten) => {
        stop = unlisten;
      });

    return () => stop?.();
  }, [importPaths]);

  // ── audio preview ────────────────────────────────────────────────────────
  const audio = useRef<AudioPreview | null>(null);
  if (audio.current === null) audio.current = new AudioPreview();

  useEffect(() => {
    const preview = audio.current;
    return () => preview?.dispose();
  }, []);

  useEffect(() => {
    const voices = clipsAt(project, playhead)
      .filter((clip) => clip.kind === "audio")
      .flatMap((clip) => {
        const media = findMedia(project, clip.mediaId);
        if (!media) return [];
        return [
          {
            clipId: clip.id,
            path: media.path,
            time: clip.sourceStart + (playhead - clip.start),
            // Uncapped: the preview routes through a gain node, so what you
            // hear matches what the exporter will render.
            volume: clipGainAt(clip, playhead),
          },
        ];
      });

    audio.current?.sync(voices, playing);
  }, [project, playhead, playing]);

  // The top-most video clip under the playhead is what the monitor shows.
  const previewSource = useMemo<PreviewSource | null>(() => {
    // Stills are picture too, so they compete for the monitor with footage.
    const active = clipsAt(project, playhead).filter((clip) => clip.kind !== "audio");
    if (active.length === 0) return null;

    const depth = (trackId: string) => project.tracks.findIndex((track) => track.id === trackId);
    const top = active.reduce((best, clip) =>
      depth(clip.trackId) > depth(best.trackId) ? clip : best,
    );

    const media = findMedia(project, top.mediaId);
    if (!media) return null;

    return {
      clipId: top.id,
      path: media.path,
      time: top.sourceStart + (playhead - top.start),
      muted: false,
      volume: clipGainAt(top, playhead),
      isStill: top.kind === "image",
    };
  }, [project, playhead]);

  // ── edit operations ──────────────────────────────────────────────────────
  const placeMedia = useCallback((mediaId: string, trackId: string, start: number) => {
    setProject((current) => {
      const { project: next, clipId } = addClip(current, { mediaId, trackId, start });
      if (clipId) setSelectedClipIds([clipId]);
      return next;
    });
  }, []);

  const addToTimeline = useCallback(
    (mediaId: string) => {
      const media = findMedia(project, mediaId);
      if (!media) return;
      // Stack onto the lowest lane that is free here, rather than piling
      // everything onto track 1 on top of itself.
      const track = firstFreeTrack(project, playhead, media.duration ?? 5);
      if (track) placeMedia(media.id, track.id, playhead);
    },
    [placeMedia, playhead, project],
  );

  /**
   * Drags a bin item onto the timeline.
   *
   * Window-level pointer listeners rather than pointer capture on the source
   * row: capture would deliver every move to the bin item, and the drop has to
   * be resolved against the timeline, which is a different element entirely.
   *
   * `latest` is read inside the listeners because they are installed once per
   * drag and would otherwise close over stale zoom and scroll values.
   */
  const beginMediaDrag = useCallback(
    (item: MediaItem, clientX: number, clientY: number) => {
      setMediaDrag({ item, x: clientX, y: clientY });

      const onMove = (event: PointerEvent) => {
        setMediaDrag((current) =>
          current ? { ...current, x: event.clientX, y: event.clientY } : null,
        );
      };

      const onUp = (event: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setMediaDrag(null);

        const state = latest.current;
        const drop = resolveDrop(event.clientX, event.clientY, {
          tracks: state.project.tracks,
          secondsPerPixel: state.secondsPerPixel,
          scrollLeft: state.scrollLeft,
          trackScroll: state.trackScroll,
        });
        // Null means outside the canvas or over the ruler; both mean "do
        // nothing". Any lane accepts any media.
        if (!drop) return;

        const start = state.snap
          ? snapTime(state.project, drop.start, {
              threshold: 8 * state.secondsPerPixel,
              playhead: state.playhead,
            })
          : drop.start;

        placeMedia(item.id, drop.trackId, Math.max(0, start));
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [placeMedia],
  );

  const splitAtPlayhead = useCallback(() => {
    setProject((current) => {
      // Split whatever is selected, or everything under the playhead if
      // nothing is - which is what the keyboard shortcut is usually for.
      const targets =
        selectedClipIds.length > 0
          ? selectedClipIds
          : clipsAt(current, playhead).map((clip) => clip.id);
      return targets.reduce((next, clipId) => splitClip(next, clipId, playhead), current);
    });
  }, [playhead, selectedClipIds]);

  const mergeSelected = useCallback(() => {
    setProject((current) => {
      const { project: next, clipId } = mergeClips(current, selectedClipIds);
      if (clipId) setSelectedClipIds([clipId]);
      return next;
    });
  }, [selectedClipIds]);

  const deleteSelected = useCallback(() => {
    if (selectedClipIds.length === 0) return;
    // Free the audio element first: once the clip is gone the sync pass has
    // nothing to match it against and it would keep sounding.
    for (const clipId of selectedClipIds) audio.current?.release(clipId);
    setProject((current) => removeClips(current, selectedClipIds));
    setSelectedClipIds([]);
  }, [selectedClipIds]);

  const zoom = useCallback((factor: number, anchor?: number) => {
    const previous = zoomRef.current;
    const next = Math.min(
      MAX_SECONDS_PER_PIXEL,
      Math.max(MIN_SECONDS_PER_PIXEL, previous * factor),
    );
    zoomRef.current = next;
    setSecondsPerPixel(next);

    // Keep the time under the pointer pinned to the same pixel.
    if (anchor !== undefined) {
      setScrollLeft((left) => Math.max(0, anchor - (anchor - left) * (next / previous)));
    }
  }, []);

  const fit = useCallback(
    (canvasWidth: number) => {
      if (canvasWidth <= 0) return;
      const span = Math.max(duration, 1) * 1.05;
      const next = Math.min(
        MAX_SECONDS_PER_PIXEL,
        Math.max(MIN_SECONDS_PER_PIXEL, span / canvasWidth),
      );
      zoomRef.current = next;
      setSecondsPerPixel(next);
      setScrollLeft(0);
    },
    [duration],
  );

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Never steal keys from a text field.
      if (event.target instanceof HTMLInputElement) return;

      const step = event.shiftKey ? 10 : 1;
      switch (event.code) {
        case "Space":
          event.preventDefault();
          transport.toggle();
          break;
        case "ArrowLeft":
          transport.step(-step, frameRate);
          break;
        case "ArrowRight":
          transport.step(step, frameRate);
          break;
        case "Home":
          transport.seek(0);
          break;
        case "End":
          transport.seek(duration);
          break;
        case "KeyV":
          setTool("select");
          break;
        case "KeyC":
          setTool("razor");
          break;
        case "KeyN":
          setSnap((current) => !current);
          break;
        case "KeyS":
          splitAtPlayhead();
          break;
        case "KeyM":
          mergeSelected();
          break;
        case "Delete":
        case "Backspace":
          deleteSelected();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected, duration, frameRate, mergeSelected, splitAtPlayhead, transport]);

  // The exporter works from a flat list: the engine rebuilds a real timeline
  // from it, so track *order* has to survive the trip even though track
  // identity does not.
  const exportClips = useMemo<ExportClip[]>(
    () =>
      project.clips.flatMap((clip) => {
        const media = findMedia(project, clip.mediaId);
        const track = findTrack(project, clip.trackId);
        const index = project.tracks.findIndex((candidate) => candidate.id === clip.trackId);
        if (!media || !track || index < 0) return [];
        return [
          {
            path: media.path,
            kind: clip.kind,
            start: clip.start,
            duration: clip.duration,
            sourceStart: clip.sourceStart,
            track: index,
            hidden: !track.visible,
            muted: track.muted,
            volume: clip.volume,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
          },
        ];
      }),
    [project],
  );

  // The inspector shows one clip's properties; with several selected there is
  // no single set of values to show, so it falls back to the bin item.
  const selectedClip =
    selectedClipIds.length === 1 ? findClip(project, selectedClipIds[0]) : null;
  const inspectorMedia = selectedClip
    ? findMedia(project, selectedClip.mediaId)
    : selectedMediaId
      ? findMedia(project, selectedMediaId)
      : null;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TitleBar
        projectName={session.name}
        status={version ? `engine ${version}` : undefined}
        theme={theme}
        onToggleTheme={onToggleTheme}
        actions={
          <button
            type="button"
            onClick={() => setExporting(true)}
            className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 py-1
                       text-xs font-medium text-on-accent transition-colors hover:bg-accent-hover"
          >
            <Icon name="export" size={13} />
            Export
          </button>
        }
        menus={[
          {
            label: "File",
            groups: [
              [
                {
                  label: "Add selected to timeline",
                  icon: "plus",
                  disabled: !selectedMediaId,
                  onSelect: () => selectedMediaId && addToTimeline(selectedMediaId),
                },
                {
                  label: "Export...",
                  icon: "export",
                  disabled: exportClips.length === 0,
                  onSelect: () => setExporting(true),
                },
              ],
              [
                {
                  label: "Close project",
                  icon: "folder",
                  onSelect: onCloseProject,
                },
                {
                  label: "Close window",
                  icon: "close",
                  onSelect: () => void getCurrentWindow().close(),
                  danger: true,
                },
              ],
            ],
          },
          {
            label: "Edit",
            groups: [
              [
                { label: "Split at playhead", icon: "razor", hint: "S", onSelect: splitAtPlayhead },
                {
                  label:
                    selectedClipIds.length > 1
                      ? `Delete ${selectedClipIds.length} clips`
                      : "Delete clip",
                  icon: "trash",
                  hint: "Del",
                  disabled: selectedClipIds.length === 0,
                  onSelect: deleteSelected,
                  danger: true,
                },
              ],
              [
                {
                  label: snap ? "Disable snapping" : "Enable snapping",
                  icon: "magnet",
                  hint: "N",
                  onSelect: () => setSnap((current) => !current),
                },
              ],
            ],
          },
          {
            label: "View",
            groups: [
              [
                { label: "Zoom in", icon: "plus", onSelect: () => zoom(1 / 1.4) },
                { label: "Zoom out", icon: "minus", onSelect: () => zoom(1.4) },
              ],
              [
                {
                  label: "Go to start",
                  icon: "skipStart",
                  hint: "Home",
                  onSelect: () => transport.seek(0),
                },
                {
                  label: "Go to end",
                  icon: "skipEnd",
                  hint: "End",
                  onSelect: () => transport.seek(duration),
                },
              ],
            ],
          },
        ]}
      />

      <div className="flex min-h-0 flex-1 flex-col p-2">
        <div className="flex min-h-0 flex-1">
          <div style={{ width: leftWidth }} className="min-w-0 shrink-0">
            <MediaBin
              items={project.media}
              assets={assets.current}
              dropping={dropping}
              tab={tab}
              selectedId={selectedMediaId}
              busy={busy}
              error={error}
              onTab={setTab}
              onSelect={(id) => {
                setSelectedMediaId(id);
                setSelectedClipIds([]);
              }}
              onImport={(path) => void importPaths([path])}
              onRemove={(id) =>
                setProject((current) => ({
                  ...current,
                  media: current.media.filter((item) => item.id !== id),
                  clips: current.clips.filter((clip) => clip.mediaId !== id),
                }))
              }
              onDismissError={() => setError(null)}
              onBeginDrag={beginMediaDrag}
              onAddToTimeline={addToTimeline}
            />
          </div>

          <Resizer
            direction="vertical"
            onResize={(delta) =>
              setLeftWidth((width) => Math.min(560, Math.max(220, width + delta)))
            }
          />

          <div className="min-w-0 flex-1">
            <Preview
              source={previewSource}
              playing={playing}
              playhead={playhead}
              duration={duration}
              frameRate={frameRate}
              onTogglePlay={transport.toggle}
              onStep={(frames) => transport.step(frames, frameRate)}
              onSeek={transport.seek}
            />
          </div>

          <Resizer
            direction="vertical"
            onResize={(delta) =>
              setRightWidth((width) => Math.min(520, Math.max(220, width - delta)))
            }
          />

          <div style={{ width: rightWidth }} className="min-w-0 shrink-0">
            <RightPanel
              tab={rightTab}
              onTab={setRightTab}
              clip={selectedClip}
              media={inspectorMedia}
              frameRate={frameRate}
              onChangeClip={(patch) => {
                if (selectedClipIds.length !== 1) return;
                setProject((current) => updateClip(current, selectedClipIds[0], patch));
              }}
            />
          </div>
        </div>

        <Resizer
          direction="horizontal"
          onResize={(delta) =>
            setTimelineHeight((height) => Math.min(700, Math.max(160, height - delta)))
          }
        />

        <div style={{ height: timelineHeight }} className="min-h-0 shrink-0">
          <TimelinePanel
            project={project}
            playhead={playhead}
            playing={playing}
            frameRate={frameRate}
            tool={tool}
            snap={snap}
            selectedClipIds={selectedClipIds}
            secondsPerPixel={secondsPerPixel}
            scrollLeft={scrollLeft}
            trackScroll={trackScroll}
            assets={assets.current}
            theme={theme}
            onToolChange={setTool}
            onSnapChange={setSnap}
            onScrub={transport.seek}
            onSelectClips={setSelectedClipIds}
            onMoveClips={(moves) => setProject((current) => moveClips(current, moves))}
            onTrimClip={(clipId, edge, delta) =>
              setProject((current) => trimClip(current, clipId, edge, delta))
            }
            onSplitAtPlayhead={splitAtPlayhead}
            onMergeSelected={mergeSelected}
            mergeBlockedBecause={whyNotMerge(project, selectedClipIds)}
            onDeleteSelected={deleteSelected}
            mediaDrag={mediaDrag ? { x: mediaDrag.x, y: mediaDrag.y } : null}
            onZoom={zoom}
            onScroll={setScrollLeft}
            onTrackScroll={setTrackScroll}
            onFit={fit}
            onTrackFlag={(trackId, flag, value) =>
              setProject((current) => setTrackFlag(current, trackId, flag, value))
            }
            onAddTrack={() => setProject((current) => addTrack(current).project)}
            onRenameTrack={(trackId, name) =>
              setProject((current) => renameTrack(current, trackId, name))
            }
            onRemoveTrack={(trackId) =>
              setProject((current) => {
                // Free the audio for anything about to disappear, or it keeps
                // sounding with no clip left to match it against.
                for (const clip of clipsOnTrack(current, trackId)) {
                  audio.current?.release(clip.id);
                }
                setSelectedClipIds((ids) =>
                  ids.filter((id) => findClip(current, id)?.trackId !== trackId),
                );
                return removeTrack(current, trackId);
              })
            }
            onClipContextMenu={(clipId, x, y) => {
              // Right-clicking outside the selection replaces it; inside it,
              // the menu acts on everything selected.
              const target = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
              setSelectedClipIds(target);

              const clip = findClip(project, clipId);
              const track = clip ? findTrack(project, clip.trackId) : null;
              const many = target.length > 1;

              setContext({
                x,
                y,
                items: [
                  {
                    label: many ? `Split ${target.length} clips at playhead` : "Split at playhead",
                    icon: "razor",
                    hint: "S",
                    onSelect: splitAtPlayhead,
                  },
                  ...(whyNotMerge(project, target) === null
                    ? [
                        {
                          label: `Merge ${target.length} clips`,
                          icon: "merge" as const,
                          hint: "M",
                          onSelect: mergeSelected,
                        },
                      ]
                    : []),
                  {
                    label: "Move to playhead",
                    icon: "select",
                    onSelect: () =>
                      setProject((current) =>
                        moveClip(current, clipId, {
                          start: playhead,
                          trackId: track?.id ?? "",
                        }),
                      ),
                  },
                  {
                    label: many ? `Delete ${target.length} clips` : "Delete",
                    icon: "trash",
                    hint: "Del",
                    danger: true,
                    onSelect: () => {
                      for (const id of target) audio.current?.release(id);
                      setProject((current) => removeClips(current, target));
                      setSelectedClipIds([]);
                    },
                  },
                ],
              });
            }}
          />
        </div>
      </div>

      {context && <ContextMenu target={context} onClose={() => setContext(null)} />}

      {exporting && (
        <ExportDialog
          projectName={session.name}
          projectPath={session.path}
          width={session.width}
          height={session.height}
          rateNum={session.rateNum}
          rateDen={session.rateDen}
          duration={duration}
          clips={exportClips}
          onClose={() => setExporting(false)}
        />
      )}

      {/* The dragged item follows the pointer. Offset down-right so it never
          sits under the cursor and hides the lane being targeted. */}
      {mediaDrag && (
        <div
          style={{ left: mediaDrag.x + 14, top: mediaDrag.y + 14 }}
          className="surface pointer-events-none fixed z-50 flex items-center gap-2 rounded-lg px-2.5 py-1.5"
        >
          <Icon
            name={mediaDrag.item.kind === "video" ? "film" : "music"}
            size={13}
            className={mediaDrag.item.kind === "video" ? "text-accent" : "text-clip-audio"}
          />
          <span className="max-w-48 truncate text-xs text-primary">{mediaDrag.item.name}</span>
        </div>
      )}

    </div>
  );
}
