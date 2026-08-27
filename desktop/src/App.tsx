import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type ContextTarget } from "./components/ContextMenu";
import { ExportDialog, type ExportTitle } from "./components/ExportDialog";
import { Icon } from "./components/Icon";
import { ALL_MEDIA, MediaBin, type BinFilter } from "./components/MediaBin";
import { Preview, type PreviewSource, type TextOverlay } from "./components/Preview";
import { Resizer } from "./components/Resizer";
import { RightPanel, type RightTab } from "./components/RightPanel";
import { SettingsDialog } from "./components/SettingsDialog";
import { StartScreen, type ProjectSession } from "./components/StartScreen";
import { TitleBar } from "./components/TitleBar";
import { TimelinePanel, resolveDrop, type Tool } from "./components/TimelinePanel";
import { createAssets, requestAssets, requestVideoPeaks } from "./lib/assets";
import {
  engineVersion,
  loadProject,
  probeMedia,
  readMediaBytes,
  saveProject,
  transcribeClip,
  type ExportClip,
} from "./lib/engine";
import { getTranscriberLanguage, getTranscriberModel } from "./lib/settings";
import {
  addClip,
  addMedia,
  addTimeline,
  addTrack,
  clipsAt,
  createProject,
  detachAudio,
  detachedAudioOf,
  findClip,
  firstFreeTrack,
  findMedia,
  findTrack,
  addFont,
  addTextClip,
  mergeClips,
  moveClip,
  moveClips,
  projectDuration,
  reattachAudio,
  removeClips,
  removeFont,
  removeMediaEverywhere,
  removeTimeline,
  removeTrack,
  renameTimeline,
  renameTrack,
  setClipSpeed,
  setClipTransform,
  setTrackFlag,
  snapTime,
  splitClip,
  switchTimeline,
  timelineClipCount,
  toMediaItem,
  updateClip,
  trimClip,
  whyNotMerge,
  type Clip,
  type MediaItem,
  type Project,
  type TimelineMeta,
} from "./lib/project";
import { buildChain } from "./lib/filters";
import { familyForPath, registerFont } from "./lib/text";
import { fromDocument, toDocument } from "./lib/persist";
import { useTheme, type Theme } from "./lib/theme";
import { useTransport } from "./lib/transport";

const MIN_SECONDS_PER_PIXEL = 0.0005;
const MAX_SECONDS_PER_PIXEL = 2;

/**
 * The window: either the launch screen or an open editor.
 *
 * The editor is a separate component rather than a branch inside one, so that
 * every hook it owns - transport, asset cache - mounts when a project
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
  const [binFilter, setBinFilter] = useState<BinFilter>(ALL_MEDIA);
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
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  /** Blocks autosave until the project on disk has been read in. */
  const [loaded, setLoaded] = useState(false);
  /**
   * The output frame. Starts from the project settings but is editable from
   * the preview footer, and the edited value is what the document keeps.
   */
  const [frame, setFrame] = useState({ width: session.width, height: session.height });

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
  const latest = useRef({ project, secondsPerPixel, scrollLeft, trackScroll, snap, playhead, frame });
  latest.current = { project, secondsPerPixel, scrollLeft, trackScroll, snap, playhead, frame };

  // The project's rate is authoritative, not the first clip's. Timecode that
  // changes meaning when you import a 25fps file is worse than useless.
  const frameRate = session.frameRate;

  // Load the saved timeline before anything can autosave over it.
  useEffect(() => {
    let cancelled = false;
    void loadProject(session.path)
      .then((document) => {
        const restored = fromDocument(document);
        if (!cancelled && restored) setProject(restored);
        // The document's frame wins over the manifest: it is where an edited
        // output size was saved.
        const video = (document as { video?: { width?: unknown; height?: unknown } }).video;
        if (
          !cancelled &&
          typeof video?.width === "number" &&
          typeof video?.height === "number" &&
          video.width > 0 &&
          video.height > 0
        ) {
          setFrame({ width: Math.round(video.width), height: Math.round(video.height) });
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session.path]);

  // Bring back every font the project names, once, when it opens.
  //
  // Without this a reopened project renders its titles in the fallback face
  // while still *claiming* the custom family, which looks like the styling was
  // lost. A font whose file has moved is marked rather than dropped: the entry
  // stays visible in the picker so it is obvious what is missing.
  useEffect(() => {
    if (!loaded || project.fonts.length === 0) return;

    let cancelled = false;
    void Promise.all(
      project.fonts.map(async (font) => ({
        family: font.family,
        ok: await registerFont(font, readMediaBytes),
      })),
    ).then((results) => {
      const failed = results.filter((result) => !result.ok).map((result) => result.family);
      if (cancelled || failed.length === 0) return;

      setProject((current) => ({
        ...current,
        fonts: current.fonts.map((font) =>
          failed.includes(font.family) ? { ...font, missing: true } : font,
        ),
      }));
    });

    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `loaded` alone. Depending on `project.fonts` would
    // re-run this on the very state update it performs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  /**
   * Puts a title on the timeline at the playhead.
   *
   * It lands on the first track with room, the same rule dropped media
   * follows, and is selected immediately with the Text tab open - the words
   * are the first thing anyone wants to change, so putting the panel in front
   * of them saves a click every single time.
   */
  const addText = useCallback(() => {
    setProject((current) => {
      const at = latest.current.playhead;
      const track = firstFreeTrack(current, at, 4);
      if (!track) return current;

      const { project: next, clipId } = addTextClip(current, { trackId: track.id, start: at });
      if (clipId) {
        setSelectedClipIds([clipId]);
        setSelectedMediaId(null);
        setRightTab("text");
      }
      return next;
    });
  }, []);

  // ── timelines ────────────────────────────────────────────────────────────
  // The timeline awaiting delete confirmation, if any. Deleting throws away
  // every clip on it and there is no undo, hence the prompt.
  const [timelineToDelete, setTimelineToDelete] = useState<TimelineMeta | null>(null);
  // Where the playhead was parked on each timeline, so switching back lands
  // where you left off. Window state, deliberately not saved in the document.
  const playheadByTimeline = useRef(new Map<string, number>());

  const selectTimeline = useCallback(
    (timelineId: string) => {
      const current = latest.current.project;
      if (timelineId === current.activeTimelineId) return;
      const next = switchTimeline(current, timelineId);
      if (next === current) return;

      playheadByTimeline.current.set(current.activeTimelineId, latest.current.playhead);
      setProject(next);
      // The selection names clips on the timeline being left; keeping it
      // would aim every clip operation at things no longer on screen.
      setSelectedClipIds([]);
      transport.pause();
      transport.seek(playheadByTimeline.current.get(timelineId) ?? 0);
    },
    [transport],
  );

  const createTimeline = useCallback(() => {
    const current = latest.current.project;
    playheadByTimeline.current.set(current.activeTimelineId, latest.current.playhead);
    setProject(addTimeline(current).project);
    setSelectedClipIds([]);
    transport.pause();
    transport.seek(0);
  }, [transport]);

  /** Runs after the ConfirmDialog's Delete button; never called directly. */
  const deleteTimelineNow = useCallback(
    (timelineId: string) => {
      const current = latest.current.project;
      const wasActive = timelineId === current.activeTimelineId;
      const next = removeTimeline(current, timelineId);
      if (next === current) return;

      playheadByTimeline.current.delete(timelineId);
      setProject(next);
      if (wasActive) {
        setSelectedClipIds([]);
        transport.pause();
        transport.seek(playheadByTimeline.current.get(next.activeTimelineId) ?? 0);
      }
    },
    [transport],
  );

  /** Adds a font file to the project and makes it available immediately. */
  const pickFont = useCallback(async () => {
    try {
      const picked = await openDialog({
        multiple: false,
        title: "Add a font",
        filters: [{ name: "Fonts", extensions: ["ttf", "otf", "woff", "woff2", "ttc"] }],
      });
      if (typeof picked !== "string") return;

      const current = latest.current.project;
      if (current.fonts.some((font) => font.path === picked)) return;

      const font = {
        family: familyForPath(
          picked,
          current.fonts.map((existing) => existing.family),
        ),
        path: picked,
      };

      // Registered before it is stored, so a file the webview cannot parse is
      // reported now rather than becoming a broken entry in the picker.
      if (!(await registerFont(font, readMediaBytes))) {
        setError(`Could not read ${picked.split(/[\/]/).pop() ?? picked} as a font.`);
        return;
      }

      setProject((project) => addFont(project, font));
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  const save = useCallback(async () => {
    setSaveState("saving");
    try {
      await saveProject(
        session.path,
        toDocument(
          { ...session, width: latest.current.frame.width, height: latest.current.frame.height },
          latest.current.project,
        ),
      );
      setSaveState("saved");
      return true;
    } catch (cause) {
      setSaveState("failed");
      setError(String(cause));
      return false;
    }
  }, [session]);

  // A deliberate save deserves an acknowledgement; the autosave stays silent
  // because a toast every 1.5 seconds of editing would be noise, not news.
  const [toast, setToast] = useState<{ id: number; message: string; failed: boolean } | null>(
    null,
  );
  const saveAndNotify = useCallback(() => {
    void save().then((saved) =>
      setToast({
        id: Date.now(),
        message: saved ? "Project saved" : "Save failed",
        failed: !saved,
      }),
    );
  }, [save]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  /**
   * Transcribes one clip's audio and lays the result out as text clips on a
   * "Captions" track (created on first use, reused after).
   *
   * The clip's identity is captured when the menu item is built, so the
   * timestamps map is computed against exactly the clip that was clicked -
   * even if the selection has moved on by the time whisper finishes. Segment
   * times come back relative to the source window; dividing by speed and
   * adding the clip's start is the same affine map the preview and exporter
   * use, run in reverse.
   */
  const autoCaption = useCallback(
    async (clip: Clip, media: MediaItem) => {
      setTranscribing(true);
      setToast({ id: Date.now(), message: "Transcribing...", failed: false });
      try {
        const segments = await transcribeClip({
          path: media.path,
          sourceStart: clip.sourceStart,
          window: clip.duration * clip.speed,
          language: getTranscriberLanguage(),
          modelId: getTranscriberModel(),
        });

        if (segments.length === 0) {
          setToast({ id: Date.now(), message: "No speech found", failed: false });
          return;
        }

        setProject((current) => {
          let next = current;
          let trackId = next.tracks.find((track) => track.name === "Captions")?.id ?? "";
          if (!trackId) {
            const grown = addTrack(next);
            next = renameTrack(grown.project, grown.trackId, "Captions");
            trackId = grown.trackId;
          }

          for (const segment of segments) {
            const start = clip.start + segment.start / clip.speed;
            const duration = Math.max(0.4, (segment.end - segment.start) / clip.speed);
            const made = addTextClip(next, {
              trackId,
              start,
              // Caption-sized and lower-third, not title-sized and centred.
              style: { content: segment.text, fontSize: 0.045 },
            });
            next = made.clipId
              ? updateClip(made.project, made.clipId, { duration, offsetY: 0.38 })
              : made.project;
          }
          return next;
        });
        setToast({
          id: Date.now(),
          message: `Added ${segments.length} caption${segments.length === 1 ? "" : "s"}`,
          failed: false,
        });
      } catch (cause) {
        setToast({ id: Date.now(), message: String(cause), failed: true });
      } finally {
        setTranscribing(false);
      }
    },
    [],
  );

  /**
   * The audio/video tools dropdown in the timeline tray.
   *
   * The same operations the clip context menu offers, but discoverable: a
   * right-click menu only teaches people who already right-click. Items are
   * disabled rather than hidden, so the tool's existence does not depend on
   * what happens to be selected.
   */
  const clipTools = useMemo(() => {
    const clip = selectedClipIds.length === 1 ? findClip(project, selectedClipIds[0]) : null;
    const media = clip ? findMedia(project, clip.mediaId) : null;

    const hasSound = Boolean(
      clip && (clip.kind === "video" || clip.kind === "audio") && media?.hasAudio,
    );
    const canDetach = Boolean(
      clip &&
        clip.kind === "video" &&
        !clip.muted &&
        media?.hasAudio &&
        detachedAudioOf(project, clip.id).length === 0,
    );
    const canReattach = Boolean(
      clip &&
        ((clip.kind === "video" && detachedAudioOf(project, clip.id).length > 0) ||
          (clip.kind === "audio" && clip.detachedFrom && findClip(project, clip.detachedFrom))),
    );

    return [
      [
        {
          label: transcribing ? "Transcribing..." : "Auto captions",
          icon: "type" as const,
          disabled: !hasSound || transcribing,
          onSelect: () => {
            if (clip && media) void autoCaption(clip, media);
          },
        },
      ],
      [
        {
          label: "Detach audio",
          icon: "waveform" as const,
          disabled: !canDetach,
          onSelect: () => {
            if (clip) setProject((current) => detachAudio(current, clip.id));
          },
        },
        {
          label: "Reattach audio",
          icon: "merge" as const,
          disabled: !canReattach,
          onSelect: () => {
            if (clip) {
              setProject((current) => reattachAudio(current, clip.id));
              setSelectedClipIds([]);
            }
          },
        },
      ],
    ];
  }, [project, selectedClipIds, transcribing, autoCaption]);

  // Autosave, debounced. The edit is the thing people lose; making them
  // remember a keystroke to keep it is a design decision nobody wants.
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setTimeout(() => void save(), 1500);
    return () => clearTimeout(timer);
  }, [project, frame, loaded, save]);

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
        requestAssets(assets.current, item, session.path);
      } catch (cause) {
        // The engine's errors already name the file and quote FFmpeg.
        setError(String(cause));
      }
    }
    setBusy(false);
  }, [session.path]);

  // Artwork for everything already in the project: a reopened project should
  // get its thumbnails and waveforms back without re-importing anything. The
  // disk cache makes the second launch cheap; requestAssets dedupes the rest.
  useEffect(() => {
    if (!loaded) return;
    // Audio clips cut from a video (detached, or split out) draw a waveform,
    // so those videos - and only those - need peaks decoded.
    const wantsPeaks = new Set(
      project.clips.filter((clip) => clip.kind === "audio").map((clip) => clip.mediaId),
    );
    for (const item of project.media) {
      requestAssets(assets.current, item, session.path);
      if (item.kind === "video" && wantsPeaks.has(item.id)) {
        requestVideoPeaks(assets.current, item, session.path);
      }
    }
  }, [loaded, project.media, project.clips, session.path]);

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

  // ── audio playback ───────────────────────────────────────────────────────
  // The engine mixes everything audible - see src-tauri/src/playback.rs. The
  // UI's whole job is to describe the audible clip set whenever it changes:
  // audio clips, plus video clips that still own their sound. The engine
  // decodes what is new (cached across sessions) and remixes the rest.
  const audibleClips = useMemo(
    () =>
      project.clips.flatMap((clip) => {
        if (clip.kind !== "audio" && clip.kind !== "video") return [];
        if (clip.kind === "video" && clip.muted) return [];
        const track = findTrack(project, clip.trackId);
        if (!track || track.muted) return [];
        const media = findMedia(project, clip.mediaId);
        if (!media || !media.hasAudio) return [];
        return [
          {
            path: media.path,
            start: clip.start,
            duration: clip.duration,
            sourceStart: clip.sourceStart,
            volume: clip.volume,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            speed: clip.speed,
            preservePitch: clip.preservePitch,
            chain: buildChain(clip.filters) ?? "",
          },
        ];
      }),
    [project],
  );

  useEffect(() => {
    if (!isTauri()) return;
    // Debounced so a slider drag settles before its chain re-decodes; gain
    // and position changes are cheap remixes either way.
    const timer = window.setTimeout(() => {
      void invoke("audio_set_clips", { project: session.path, clips: audibleClips }).catch(
        (cause: unknown) => console.error("WolfCut: could not update the mix", cause),
      );
    }, 150);
    return () => window.clearTimeout(timer);
  }, [audibleClips, session.path]);

  /**
   * Every title live at the playhead, bottom track first.
   *
   * All of them, not just the top one: titles stack, and a lower third plus a
   * name card is a normal thing to want on screen at once. Order follows track
   * order so the compositing matches what the timeline shows.
   */
  const textOverlays = useMemo<TextOverlay[]>(() => {
    const depth = (trackId: string) => project.tracks.findIndex((track) => track.id === trackId);

    return clipsAt(project, playhead)
      .filter((clip) => clip.kind === "text" && clip.text !== undefined)
      .filter((clip) => findTrack(project, clip.trackId)?.visible !== false)
      .sort((a, b) => depth(a.trackId) - depth(b.trackId))
      .map((clip) => ({
        clipId: clip.id,
        style: clip.text!,
        offsetX: clip.offsetX,
        offsetY: clip.offsetY,
      }));
  }, [project, playhead]);

  // The top-most video clip under the playhead is what the monitor shows.
  const previewSource = useMemo<PreviewSource | null>(() => {
    // Stills are picture too, so they compete for the monitor with footage.
    // Titles do not: they are drawn *over* whatever is showing, so they are
    // handled as overlays below rather than as a source.
    const active = clipsAt(project, playhead).filter(
      (clip) => clip.kind !== "audio" && clip.kind !== "text",
    );
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
      // A timeline second covers `speed` source seconds - the same map the
      // exporter's frame plan applies.
      time: top.sourceStart + (playhead - top.start) * top.speed,
      speed: top.speed,
      isStill: top.kind === "image",
    };
  }, [project, playhead]);

  // What the monitor's transform gizmo works on: the displayed clip's picture
  // transform, and the source's pixel size so the fitted rect can be computed.
  const previewClip = previewSource ? findClip(project, previewSource.clipId) : null;
  const previewMedia = previewClip ? findMedia(project, previewClip.mediaId) : null;

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
      // Never steal keys from anywhere text is being written: inputs, the
      // text panel's textarea, and inline editing (contentEditable). Space
      // must insert a space there, and Backspace must not delete a clip.
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      /*
       * Modified shortcuts are handled separately and then we return.
       *
       * Without this the two sets ran together: Ctrl+S matched the bare `S`
       * case and split the clip instead of saving, which is exactly the sort
       * of thing that makes an app feel hostile.
       */
      if (event.ctrlKey || event.metaKey) {
        switch (event.code) {
          case "KeyS":
            event.preventDefault();
            saveAndNotify();
            break;
          case "KeyB":
            event.preventDefault();
            splitAtPlayhead();
            break;
          case "KeyE":
            event.preventDefault();
            setExporting(true);
            break;
          default:
            break;
        }
        return;
      }

      // Alt is left alone entirely; nothing here claims it.
      if (event.altKey) return;

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
  }, [deleteSelected, duration, frameRate, mergeSelected, saveAndNotify, splitAtPlayhead, transport]);

  // The exporter works from a flat list: the engine rebuilds a real timeline
  // from it, so track *order* has to survive the trip even though track
  // identity does not.
  const exportClips = useMemo<ExportClip[]>(
    () =>
      project.clips.flatMap((clip) => {
        // Titles have no file to hand the exporter, so they are rasterised
        // separately and appended as full-frame overlays - see `textLayers`.
        if (clip.kind === "text") return [];

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
            muted: track.muted || clip.muted === true,
            volume: clip.volume,
            fadeIn: clip.fadeIn,
            fadeOut: clip.fadeOut,
            filterChain: buildChain(clip.filters) ?? "",
            speed: clip.speed,
            preservePitch: clip.preservePitch,
            scale: clip.scale,
            offsetX: clip.offsetX,
            offsetY: clip.offsetY,
            rotation: clip.rotation,
            opacity: clip.opacity,
            mediaWidth: media.width,
            mediaHeight: media.height,
          },
        ];
      }),
    [project],
  );

  // Titles for the exporter. They have no file to hand over - the dialog
  // rasterises them into full-frame PNGs at export time - so all it needs is
  // the style and where the clip sits. Hidden tracks drop out here, the same
  // cut `exportClips` makes with `hidden`.
  const exportTitles = useMemo<ExportTitle[]>(
    () =>
      project.clips.flatMap((clip) => {
        if (clip.kind !== "text" || !clip.text) return [];
        const track = findTrack(project, clip.trackId);
        const index = project.tracks.findIndex((candidate) => candidate.id === clip.trackId);
        if (!track || !track.visible || index < 0) return [];
        return [
          {
            clipId: clip.id,
            style: clip.text,
            offsetX: clip.offsetX,
            offsetY: clip.offsetY,
            start: clip.start,
            duration: clip.duration,
            track: index,
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
        status={
          saveState === "saving"
            ? "saving..."
            : saveState === "failed"
              ? "save failed"
              : saveState === "saved"
                ? "saved"
                : version
                  ? `engine ${version}`
                  : undefined
        }
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
                  label: "Save",
                  icon: "folder",
                  hint: "Ctrl+S",
                  onSelect: () => saveAndNotify(),
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
                  label: "Settings...",
                  icon: "settings",
                  onSelect: () => setSettingsOpen(true),
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
                { label: "Split at playhead", icon: "razor", hint: "Ctrl+B", onSelect: splitAtPlayhead },
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
              filter={binFilter}
              selectedId={selectedMediaId}
              busy={busy}
              error={error}
              onFilter={setBinFilter}
              onAddText={addText}
              onSelect={(id) => {
                setSelectedMediaId(id);
                setSelectedClipIds([]);
              }}
              onImport={(paths) => void importPaths(paths)}
              onRemove={(id) => setProject((current) => removeMediaEverywhere(current, id))}
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
              overlays={textOverlays}
              playing={playing}
              playhead={playhead}
              duration={duration}
              frameRate={frameRate}
              frame={frame}
              transform={
                previewClip
                  ? {
                      scale: previewClip.scale,
                      offsetX: previewClip.offsetX,
                      offsetY: previewClip.offsetY,
                      rotation: previewClip.rotation,
                    }
                  : null
              }
              opacity={previewClip?.opacity ?? 1}
              mediaSize={
                previewMedia && previewMedia.width && previewMedia.height
                  ? { width: previewMedia.width, height: previewMedia.height }
                  : null
              }
              selectedClipId={selectedClipIds.length === 1 ? selectedClipIds[0] : null}
              onSelectClip={(clipId) => setSelectedClipIds([clipId])}
              onTransformChange={(clipId, transform) =>
                setProject((current) => setClipTransform(current, clipId, transform))
              }
              onOverlayChange={(clipId, change) =>
                setProject((current) => {
                  let next = current;
                  if (change.offsetX !== undefined || change.offsetY !== undefined) {
                    next = setClipTransform(next, clipId, {
                      offsetX: change.offsetX,
                      offsetY: change.offsetY,
                    });
                  }
                  if (change.fontSize !== undefined) {
                    const clip = findClip(next, clipId);
                    if (clip?.text) {
                      next = updateClip(next, clipId, {
                        text: { ...clip.text, fontSize: change.fontSize },
                      });
                    }
                  }
                  return next;
                })
              }
              onFrameChange={(width, height) => setFrame({ width, height })}
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
              project={project}
              projectName={session.name}
              projectPath={session.path}
              frame={frame}
              duration={duration}
              frameRate={frameRate}
              onAddFont={() => void pickFont()}
              onRemoveFont={(family) => setProject((current) => removeFont(current, family))}
              onChangeClip={(patch) => {
                if (selectedClipIds.length !== 1) return;
                setProject((current) => updateClip(current, selectedClipIds[0], patch));
              }}
              onSpeedChange={(speed) => {
                if (selectedClipIds.length !== 1) return;
                setProject((current) => setClipSpeed(current, selectedClipIds[0], speed));
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
            clipTools={clipTools}
            onSelectTimeline={selectTimeline}
            onAddTimeline={createTimeline}
            onRenameTimeline={(timelineId, name) =>
              setProject((current) => renameTimeline(current, timelineId, name))
            }
            onRequestRemoveTimeline={(timelineId) => {
              const meta = project.timelines.find((candidate) => candidate.id === timelineId);
              if (meta) setTimelineToDelete(meta);
            }}
            onAddTrack={() => setProject((current) => addTrack(current).project)}
            onRenameTrack={(trackId, name) =>
              setProject((current) => renameTrack(current, trackId, name))
            }
            onRemoveTrack={(trackId) =>
              setProject((current) => {
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
                  // "Detach audio" and its reverse, offered only where they
                  // mean something: one clip, with a link to make or unmake.
                  // Captions come from the clip's own sound, so the item only
                  // appears where there is sound to transcribe - and only one
                  // transcription runs at a time.
                  ...(() => {
                    const media = clip ? findMedia(project, clip.mediaId) : null;
                    return !many &&
                      clip &&
                      (clip.kind === "video" || clip.kind === "audio") &&
                      media?.hasAudio &&
                      !transcribing
                      ? [
                          {
                            label: "Auto captions",
                            icon: "type" as const,
                            onSelect: () => void autoCaption(clip, media),
                          },
                        ]
                      : [];
                  })(),
                  ...(!many &&
                  clip?.kind === "video" &&
                  !clip.muted &&
                  findMedia(project, clip.mediaId)?.hasAudio &&
                  detachedAudioOf(project, clip.id).length === 0
                    ? [
                        {
                          label: "Detach audio",
                          icon: "waveform" as const,
                          onSelect: () => setProject((current) => detachAudio(current, clipId)),
                        },
                      ]
                    : []),
                  ...(!many &&
                  clip &&
                  ((clip.kind === "video" && detachedAudioOf(project, clip.id).length > 0) ||
                    (clip.kind === "audio" &&
                      clip.detachedFrom &&
                      findClip(project, clip.detachedFrom)))
                    ? [
                        {
                          label: "Reattach audio",
                          icon: "merge" as const,
                          onSelect: () => {
                            setProject((current) => reattachAudio(current, clipId));
                            setSelectedClipIds([]);
                          },
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
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      {timelineToDelete && (
        <ConfirmDialog
          title={`Delete "${timelineToDelete.name}"?`}
          message={(() => {
            const count = timelineClipCount(project, timelineToDelete.id);
            return count > 0
              ? `The ${count} clip${count === 1 ? "" : "s"} on this timeline will be lost. ` +
                  "There is no undo."
              : "The timeline is empty; nothing else is affected.";
          })()}
          confirmLabel="Delete timeline"
          onConfirm={() => {
            deleteTimelineNow(timelineToDelete.id);
            setTimelineToDelete(null);
          }}
          onCancel={() => setTimelineToDelete(null)}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          role="status"
          className={`surface fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-xl
                      px-3 py-2 text-xs ${toast.failed ? "text-danger" : "text-primary"}`}
        >
          <Icon
            name={toast.failed ? "close" : "check"}
            size={13}
            className={toast.failed ? "" : "text-success"}
          />
          {toast.message}
        </div>
      )}

      {exporting && (
        <ExportDialog
          projectName={session.name}
          projectPath={session.path}
          width={frame.width}
          height={frame.height}
          rateNum={session.rateNum}
          rateDen={session.rateDen}
          duration={duration}
          clips={exportClips}
          titles={exportTitles}
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
