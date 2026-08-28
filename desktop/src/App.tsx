import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { ConfirmDialog } from "./components/ConfirmDialog";
import { ContextMenu, type ContextTarget } from "./components/ContextMenu";
import { ExportDialog } from "./components/ExportDialog";
import { Icon } from "./components/Icon";
import { ALL_MEDIA, MediaBin, type BinFilter } from "./components/MediaBin";
import type { MenuOption } from "./components/Menu";
import { Preview } from "./components/Preview";
import {
  exportClipsOf,
  exportTitlesOf,
  previewGhostAt,
  previewSourceAt,
  previewVeilAt,
  textOverlaysAt,
  type ExportTitle,
} from "./lib/monitor";
import { Resizer } from "./components/Resizer";
import { RightPanel, type RightTab } from "./components/RightPanel";
import { SaveTemplateDialog } from "./components/SaveTemplateDialog";
import { SettingsDialog } from "./components/SettingsDialog";
import { StartScreen, type ProjectSession } from "./components/StartScreen";
import { TitleBar } from "./components/TitleBar";
import { TimelinePanel, resolveDrop, type Tool } from "./components/TimelinePanel";
import { createAssets, requestAssets, requestVideoPeaks } from "./lib/assets";
import {
  activeTimeline,
  clipsAt,
  detachedAudioOf,
  findClip,
  findMedia,
  precedingClip,
  projectDuration,
  snapTime,
  speedPatch,
  timelineClipCount,
  transformPatch,
  trimPatch,
  whyNotMerge,
  type Clip,
  type MediaItem,
  type TimelineMeta,
} from "./lib/editor";
import {
  editorSave,
  engineVersion,
  newMediaFromSummary,
  probeMedia,
  readMediaBytes,
  templateSave,
  type ExportClip,
  type TemplateInfo,
} from "./lib/engine";
import { findTransition } from "./lib/effects";
import { familyForPath, registerFont } from "./lib/text";
import { useCaptions } from "./hooks/useCaptions";
import { useEngineSession } from "./hooks/useEngineSession";
import { useEngineTruth } from "./hooks/useEngineTruth";
import { usePlaybackBridge } from "./hooks/usePlaybackBridge";
import { useTheme, type Theme } from "./lib/theme";
import { useTransport } from "./lib/transport";

const MIN_SECONDS_PER_PIXEL = 0.0005;
const MAX_SECONDS_PER_PIXEL = 2;

/**
 * The window: either the launch screen or an open editor.
 *
 * The editor is a separate component rather than a branch inside one, so that
 * every hook it owns - transport, asset cache, the engine session - mounts
 * when a project opens and unmounts when it closes.
 */
export function App() {
  const [session, setSession] = useState<ProjectSession | null>(null);
  // Choosing "use template" inside the editor closes the project and lands
  // the launch screen straight in that template's fill mode.
  const [pendingTemplate, setPendingTemplate] = useState<TemplateInfo | null>(null);
  // Owned here rather than in the editor so the launch screen is themed too,
  // and so the choice survives closing a project.
  const { theme, toggle } = useTheme();

  if (!session) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <TitleBar projectName="" menus={[]} theme={theme} onToggleTheme={toggle} />
        <div className="min-h-0 flex-1">
          <StartScreen
            initialTemplate={pendingTemplate}
            onCreate={(next) => {
              setPendingTemplate(null);
              setSession(next);
            }}
          />
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
      onUseTemplate={(template) => {
        setPendingTemplate(template);
        setSession(null);
      }}
    />
  );
}

/**
 * The editor shell.
 *
 * The engine owns the edit (see engine decision 0007). This component holds
 * *window* state - selection, playhead, panel sizes - plus the latest
 * `EditorView` the engine returned, and a transient gesture echo: during a
 * drag the change previews locally with the engine's own arithmetic, and one
 * command commits on release. Every mutation is a command; every render draws
 * the state that came back.
 */
function Editor({
  session,
  theme,
  onToggleTheme,
  onCloseProject,
  onUseTemplate,
}: {
  session: ProjectSession;
  theme: Theme;
  onToggleTheme: () => void;
  onCloseProject: () => void;
  /** Leaves this project for the launch screen's fill flow on a template. */
  onUseTemplate: (template: TemplateInfo) => void;
}) {
  const [toast, setToast] = useState<{ id: number; message: string; failed: boolean } | null>(
    null,
  );
  const pushToast = useCallback((message: string, failed: boolean) => {
    setToast({ id: Date.now(), message, failed });
  }, []);
  const [error, setError] = useState<string | null>(null);

  // The engine session: queue, echo, undo, autosave. See useEngineSession.
  const {
    view,
    viewRef,
    loaded,
    project,
    dispatch,
    undoAction,
    redoAction,
    liveClip,
    commitEcho,
    frame,
    setFrame,
    saveState,
    saveAndNotify,
  } = useEngineSession({
    session,
    onOpenError: setError,
    onCommandError: useCallback((message: string) => pushToast(message, true), [pushToast]),
    onSaved: useCallback(
      (ok: boolean, message?: string) =>
        pushToast(ok ? "Project saved" : `Save failed: ${message}`, !ok),
      [pushToast],
    ),
  });

  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [snap, setSnap] = useState(true);
  const [binFilter, setBinFilter] = useState<BinFilter>(ALL_MEDIA);
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [context, setContext] = useState<ContextTarget | null>(null);
  const [mediaDrag, setMediaDrag] = useState<{ item: MediaItem; x: number; y: number } | null>(
    null,
  );
  const [exporting, setExporting] = useState(false);
  const [rightTab, setRightTab] = useState<RightTab>("details");
  /** Families whose font files failed to load - shown in the picker. */
  const [missingFonts, setMissingFonts] = useState<Set<string>>(new Set());

  // Panel geometry.
  // Wide enough that the library's five tabs and a row of cards breathe;
  // the resizer still allows 220-560.
  const [leftWidth, setLeftWidth] = useState(420);
  const [rightWidth, setRightWidth] = useState(300);
  const [timelineHeight, setTimelineHeight] = useState(340);

  // Timeline viewport.
  const [secondsPerPixel, setSecondsPerPixel] = useState(0.02);
  const [scrollLeft, setScrollLeft] = useState(0);
  // Vertical offset into the track stack, shared by the lanes and their headers.
  const [trackScroll, setTrackScroll] = useState(0);
  const zoomRef = useRef(secondsPerPixel);
  zoomRef.current = secondsPerPixel;

  const timeline = activeTimeline(project);

  const duration = projectDuration(project);
  const transport = useTransport({ duration });
  const { playhead, playing } = transport;

  // Read by event listeners that outlive the render that installed them.
  const latest = useRef({ project, secondsPerPixel, scrollLeft, trackScroll, snap, playhead, frame });
  latest.current = { project, secondsPerPixel, scrollLeft, trackScroll, snap, playhead, frame };

  // The project's rate is authoritative, not the first clip's.
  const frameRate = session.frameRate;

  // A selection can name clips an undo or a command just removed.
  useEffect(() => {
    setSelectedClipIds((ids) => {
      const kept = ids.filter((id) => timeline.clips.some((clip) => clip.id === id));
      return kept.length === ids.length ? ids : kept;
    });
    setSelectedMediaId((id) =>
      id && project.media.some((item) => item.id === id) ? id : null,
    );
    // Keyed on the engine state, not the echo - the echo never removes clips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Bring back every font the project names, once, when it opens. A font
  // whose file has moved is marked rather than dropped.
  useEffect(() => {
    if (!loaded || !view || view.project.fonts.length === 0) return;
    let cancelled = false;
    void Promise.all(
      view.project.fonts.map(async (font) => ({
        family: font.family,
        ok: await registerFont(font, readMediaBytes),
      })),
    ).then((results) => {
      if (cancelled) return;
      const failed = results.filter((result) => !result.ok).map((result) => result.family);
      if (failed.length > 0) setMissingFonts(new Set(failed));
    });
    return () => {
      cancelled = true;
    };
    // Deliberately keyed on `loaded` alone: fonts are registered once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const fontsForUi = useMemo(
    () =>
      project.fonts.map((font) =>
        missingFonts.has(font.family) ? { ...font, missing: true } : font,
      ),
    [project.fonts, missingFonts],
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  // The save-as-template sheet: null closed, otherwise whether the host is
  // packing the bundle right now.
  const [templateDialog, setTemplateDialog] = useState<null | { busy: boolean }>(null);

  useEffect(() => {
    engineVersion()
      .then(setVersion)
      .catch(() => setVersion("unavailable"));
  }, []);

  // Waveforms and filmstrips. A ref, not state: the timeline reads this map
  // from inside its draw loop, so artwork arriving needs no re-render.
  const assets = useRef(createAssets());

  // ── clip edits (echo + commit) ───────────────────────────────────────────

  /** Live patch from a panel control; committed by its onCommit. */
  const changeClip = useCallback(
    (patch: Partial<Clip>) => {
      const clipId = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
      if (!clipId) return;
      // Transform-family fields get the engine's clamps applied to the echo,
      // so what previews is what will commit.
      const { scale, offsetX, offsetY, rotation, ...rest } = patch;
      const clamped =
        scale !== undefined || offsetX !== undefined || offsetY !== undefined || rotation !== undefined
          ? transformPatch({ scale, offsetX, offsetY, rotation })
          : {};
      liveClip(clipId, { ...rest, ...clamped });
    },
    [selectedClipIds, liveClip],
  );

  const changeSpeed = useCallback(
    (speed: number) => {
      const clipId = selectedClipIds.length === 1 ? selectedClipIds[0] : null;
      if (!clipId) return;
      const clip = findClip(latest.current.project, clipId);
      if (clip) liveClip(clipId, speedPatch(clip, speed));
    },
    [selectedClipIds, liveClip],
  );

  // ── media import ─────────────────────────────────────────────────────────
  const importPaths = useCallback(
    async (paths: string[]) => {
      setBusy(true);
      setError(null);
      for (const path of paths) {
        try {
          const summary = await probeMedia(path);
          const mediaId = await dispatch({
            op: "addMedia",
            item: newMediaFromSummary(summary),
          });
          if (mediaId) {
            setSelectedMediaId(mediaId);
            // Fire and forget: the clip draws flat until the artwork lands.
            requestAssets(
              assets.current,
              {
                id: mediaId,
                path: summary.path,
                kind: summary.kind,
                duration: summary.duration,
                hasAudio: summary.audio !== null,
              },
              session.path,
            );
          }
        } catch (cause) {
          setError(String(cause));
        }
      }
      setBusy(false);
    },
    [dispatch, session.path],
  );

  // Artwork for everything already in the project: a reopened project should
  // get its thumbnails and waveforms back without re-importing anything.
  useEffect(() => {
    if (!loaded) return;
    const wantsPeaks = new Set(
      timeline.clips.filter((clip) => clip.kind === "audio").map((clip) => clip.mediaId),
    );
    for (const item of project.media) {
      requestAssets(assets.current, item, session.path);
      if (item.kind === "video" && wantsPeaks.has(item.id)) {
        requestVideoPeaks(assets.current, item, session.path);
      }
    }
  }, [loaded, project.media, timeline.clips, session.path]);

  // Files dropped from the OS.
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
  usePlaybackBridge({
    project,
    timeline,
    projectPath: session.path,
    onError: useCallback((message: string) => pushToast(message, true), [pushToast]),
  });

  // ── text, effects, transitions ───────────────────────────────────────────

  const addText = useCallback(() => {
    void dispatch({
      op: "addTextClip",
      trackId: null,
      start: latest.current.playhead,
      style: null,
    }).then((clipId) => {
      if (clipId) {
        setSelectedClipIds([clipId]);
        setSelectedMediaId(null);
        setRightTab("text");
      }
    });
  }, [dispatch]);

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
      void dispatch({ op: "addFont", family: font.family, path: font.path });
    } catch (cause) {
      setError(String(cause));
    }
  }, [dispatch]);

  const applyEffect = useCallback(
    (effectId: string) => {
      const current = latest.current.project;
      const selected = selectedClipIds.length === 1 ? findClip(current, selectedClipIds[0]) : null;
      if (!selected || (selected.kind !== "video" && selected.kind !== "image")) {
        setToast({
          id: Date.now(),
          message: "Select a video or image clip on the timeline first",
          failed: true,
        });
        return;
      }
      void dispatch({
        op: "updateClip",
        clipId: selected.id,
        patch: { videoEffects: [...selected.videoEffects, { id: effectId, params: {} }] },
      });
      setRightTab("effects");
    },
    [selectedClipIds, dispatch],
  );

  const applyTransition = useCallback(
    (transitionId: string) => {
      const definition = findTransition(transitionId);
      if (!definition?.implemented) return;
      const current = latest.current.project;
      const selected = selectedClipIds.length === 1 ? findClip(current, selectedClipIds[0]) : null;
      if (!selected || (selected.kind !== "video" && selected.kind !== "image")) {
        setToast({
          id: Date.now(),
          message: "Select the incoming clip - the one after the cut - first",
          failed: true,
        });
        return;
      }
      if (!precedingClip(current, selected.id)) {
        setToast({
          id: Date.now(),
          message: "No clip ends where this one starts - transitions need a cut",
          failed: true,
        });
        return;
      }
      void dispatch({
        op: "updateClip",
        clipId: selected.id,
        patch: { transitionIn: { id: transitionId, duration: definition.defaultDuration } },
      });
      setRightTab("effects");
      setToast({ id: Date.now(), message: `${definition.label} added to the cut`, failed: false });
    },
    [selectedClipIds, dispatch],
  );

  const { autoCaption, transcribing } = useCaptions({
    dispatch,
    getProject: useCallback(() => latest.current.project, []),
    onToast: pushToast,
  });

  /** The audio/video tools dropdown. Hidden entirely for soundless clips. */
  const clipTools = useMemo<MenuOption[][]>(() => {
    const clip = selectedClipIds.length === 1 ? findClip(project, selectedClipIds[0]) : null;
    const media = clip ? findMedia(project, clip.mediaId) : null;
    if (!clip || (clip.kind !== "video" && clip.kind !== "audio")) return [];

    const hasSound = Boolean(media?.hasAudio);
    const canDetach = Boolean(
      clip.kind === "video" &&
        !clip.muted &&
        media?.hasAudio &&
        detachedAudioOf(project, clip.id).length === 0,
    );
    const canReattach = Boolean(
      (clip.kind === "video" && detachedAudioOf(project, clip.id).length > 0) ||
        (clip.kind === "audio" && clip.detachedFrom && findClip(project, clip.detachedFrom)),
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
          onSelect: () => void dispatch({ op: "detachAudio", clipId: clip.id }),
        },
        {
          label: "Reattach audio",
          icon: "merge" as const,
          disabled: !canReattach,
          onSelect: () => {
            void dispatch({ op: "reattachAudio", clipId: clip.id });
            setSelectedClipIds([]);
          },
        },
      ],
    ];
  }, [project, selectedClipIds, transcribing, autoCaption, dispatch]);

  // ── timelines ────────────────────────────────────────────────────────────
  const [timelineToDelete, setTimelineToDelete] = useState<TimelineMeta | null>(null);
  const playheadByTimeline = useRef(new Map<string, number>());

  const selectTimeline = useCallback(
    (timelineId: string) => {
      const current = latest.current.project;
      if (timelineId === current.activeTimelineId) return;
      playheadByTimeline.current.set(current.activeTimelineId, latest.current.playhead);
      void dispatch({ op: "selectTimeline", timelineId }).then(() => {
        setSelectedClipIds([]);
        transport.pause();
        transport.seek(playheadByTimeline.current.get(timelineId) ?? 0);
      });
    },
    [dispatch, transport],
  );

  const createTimeline = useCallback(() => {
    playheadByTimeline.current.set(
      latest.current.project.activeTimelineId,
      latest.current.playhead,
    );
    void dispatch({ op: "addTimeline" }).then(() => {
      setSelectedClipIds([]);
      transport.pause();
      transport.seek(0);
    });
  }, [dispatch, transport]);

  const deleteTimelineNow = useCallback(
    (timelineId: string) => {
      const wasActive = timelineId === latest.current.project.activeTimelineId;
      playheadByTimeline.current.delete(timelineId);
      void dispatch({ op: "removeTimeline", timelineId }).then(() => {
        if (wasActive) {
          setSelectedClipIds([]);
          transport.pause();
          const nextActive = viewRef.current?.project.activeTimelineId;
          transport.seek((nextActive && playheadByTimeline.current.get(nextActive)) || 0);
        }
      });
    },
    [dispatch, transport],
  );

  // ── edit operations ──────────────────────────────────────────────────────
  const placeMedia = useCallback(
    (mediaId: string, trackId: string, start: number) => {
      void dispatch({ op: "addClip", mediaId, trackId, start }).then((clipId) => {
        if (clipId) setSelectedClipIds([clipId]);
      });
    },
    [dispatch],
  );

  const addToTimeline = useCallback(
    (mediaId: string) => {
      void dispatch({
        op: "addClipAtFirstFree",
        mediaId,
        start: latest.current.playhead,
      }).then((clipId) => {
        if (clipId) setSelectedClipIds([clipId]);
      });
    },
    [dispatch],
  );

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
          tracks: activeTimeline(state.project).tracks,
          secondsPerPixel: state.secondsPerPixel,
          scrollLeft: state.scrollLeft,
          trackScroll: state.trackScroll,
        });
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
    const current = latest.current.project;
    const at = latest.current.playhead;
    const targets =
      selectedClipIds.length > 0
        ? selectedClipIds
        : clipsAt(current, at).map((clip) => clip.id);
    if (targets.length === 0) return;
    void dispatch({ op: "splitClips", clipIds: targets, time: at });
  }, [selectedClipIds, dispatch]);

  const mergeSelected = useCallback(() => {
    void dispatch({ op: "mergeClips", clipIds: selectedClipIds }).then((clipId) => {
      if (clipId) setSelectedClipIds([clipId]);
    });
  }, [selectedClipIds, dispatch]);

  const deleteSelected = useCallback(() => {
    if (selectedClipIds.length === 0) return;
    void dispatch({ op: "removeClips", clipIds: selectedClipIds });
    setSelectedClipIds([]);
  }, [selectedClipIds, dispatch]);

  const zoom = useCallback((factor: number, anchor?: number) => {
    const previous = zoomRef.current;
    const next = Math.min(
      MAX_SECONDS_PER_PIXEL,
      Math.max(MIN_SECONDS_PER_PIXEL, previous * factor),
    );
    zoomRef.current = next;
    setSecondsPerPixel(next);
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
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        switch (event.code) {
          case "KeyZ":
            event.preventDefault();
            if (event.shiftKey) redoAction();
            else undoAction();
            break;
          case "KeyY":
            event.preventDefault();
            redoAction();
            break;
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
        case "KeyF": {
          // The same marker resolveDrop uses to find the timeline canvas -
          // its width is a layout fact only that element knows.
          const canvas = document.querySelector<HTMLCanvasElement>("[data-relay-timeline]");
          if (canvas) fit(canvas.clientWidth);
          break;
        }
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
  }, [
    deleteSelected,
    duration,
    fit,
    frameRate,
    mergeSelected,
    redoAction,
    saveAndNotify,
    splitAtPlayhead,
    transport,
    undoAction,
  ]);

  // ── derived views ────────────────────────────────────────────────────────

  // Derived views of the monitor and exporter, all pure in lib/monitor.ts -
  // which is what makes the cross-fade pre-roll and the flattening testable.
  const textOverlays = useMemo(
    () => textOverlaysAt(project, timeline, playhead),
    [project, timeline, playhead],
  );

  const previewSource = useMemo(
    () => previewSourceAt(project, timeline, playhead),
    [project, timeline, playhead],
  );

  const previewClip = previewSource ? findClip(project, previewSource.clipId) : null;
  const previewMedia = previewClip ? findMedia(project, previewClip.mediaId) : null;

  const previewGhost = useMemo(
    () => previewGhostAt(project, timeline, playhead),
    [project, timeline, playhead],
  );

  const previewVeil = useMemo(
    () => previewVeilAt(project, timeline, playhead),
    [project, timeline, playhead],
  );

  // The exporter works from a flat list of the active timeline's clips.
  const exportClips = useMemo<ExportClip[]>(
    () => exportClipsOf(project, timeline),
    [project, timeline],
  );

  const exportTitles = useMemo<ExportTitle[]>(
    () => exportTitlesOf(project, timeline),
    [project, timeline],
  );

  // The engine's true frames: paused dwell + playback stream. See
  // useEngineTruth and desktop decision 0009.
  const engineStill = useEngineTruth({
    playing,
    loaded,
    playhead,
    exportClips,
    frame,
    rateNum: session.rateNum,
    rateDen: session.rateDen,
    latest,
  });

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
        onOpenSettings={() => setSettingsOpen(true)}
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
                {
                  label: "Save as template...",
                  icon: "slot",
                  onSelect: () => setTemplateDialog({ busy: false }),
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
                {
                  label: "Undo",
                  icon: "chevronUp",
                  hint: "Ctrl+Z",
                  disabled: !view?.canUndo,
                  onSelect: undoAction,
                },
                {
                  label: "Redo",
                  icon: "chevronDown",
                  hint: "Ctrl+Shift+Z",
                  disabled: !view?.canRedo,
                  onSelect: redoAction,
                },
              ],
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
              onRemove={(id) => void dispatch({ op: "removeMedia", mediaId: id })}
              onDismissError={() => setError(null)}
              onBeginDrag={beginMediaDrag}
              onAddToTimeline={addToTimeline}
              onApplyEffect={applyEffect}
              onApplyTransition={applyTransition}
              onToggleSlot={(mediaId, placeholder) =>
                void dispatch({ op: "setMediaPlaceholder", mediaId, placeholder })
              }
              onSaveTemplate={() => setTemplateDialog({ busy: false })}
              onUseTemplate={(template) => {
                // Save what is open first: leaving for the fill flow closes
                // this project, and the debounced autosave may not have fired.
                void editorSave(latest.current.frame)
                  .catch(() => undefined)
                  .then(() => onUseTemplate(template));
              }}
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
              effects={previewClip?.videoEffects ?? null}
              ghost={previewGhost}
              engineStill={engineStill}
              veil={previewVeil}
              mediaSize={
                previewMedia && previewMedia.width && previewMedia.height
                  ? { width: previewMedia.width, height: previewMedia.height }
                  : null
              }
              selectedClipId={selectedClipIds.length === 1 ? selectedClipIds[0] : null}
              onSelectClip={(clipId) => setSelectedClipIds([clipId])}
              onTransformChange={(clipId, transform) =>
                liveClip(clipId, transformPatch(transform))
              }
              onTransformEnd={commitEcho}
              onOverlayChange={(clipId, change) => {
                const patch: Partial<Clip> = transformPatch({
                  offsetX: change.offsetX,
                  offsetY: change.offsetY,
                });
                if (change.fontSize !== undefined) {
                  const clip = findClip(latest.current.project, clipId);
                  if (clip?.text) patch.text = { ...clip.text, fontSize: change.fontSize };
                }
                liveClip(clipId, patch);
              }}
              onOverlayEnd={commitEcho}
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
              fonts={fontsForUi}
              projectName={session.name}
              projectPath={session.path}
              frame={frame}
              duration={duration}
              frameRate={frameRate}
              onAddFont={() => void pickFont()}
              onRemoveFont={(family) => void dispatch({ op: "removeFont", family })}
              onChangeClip={changeClip}
              onCommitClip={commitEcho}
              onSpeedChange={changeSpeed}
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
            onMoveClips={(moves) => {
              for (const move of moves) {
                liveClip(move.clipId, { start: Math.max(0, move.start), trackId: move.trackId });
              }
            }}
            onTrimClip={(clipId, edge, delta) => {
              const clip = findClip(latest.current.project, clipId);
              if (clip) liveClip(clipId, trimPatch(clip, edge, delta));
            }}
            onGestureEnd={commitEcho}
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
              void dispatch({ op: "setTrackFlag", trackId, flag, value })
            }
            clipTools={clipTools}
            onSelectTimeline={selectTimeline}
            onAddTimeline={createTimeline}
            onRenameTimeline={(timelineId, name) =>
              void dispatch({ op: "renameTimeline", timelineId, name })
            }
            onRequestRemoveTimeline={(timelineId) => {
              const meta = project.timelines.find((candidate) => candidate.id === timelineId);
              if (meta) setTimelineToDelete({ id: meta.id, name: meta.name });
            }}
            onAddTrack={() => void dispatch({ op: "addTrack" })}
            onRenameTrack={(trackId, name) =>
              void dispatch({ op: "renameTrack", trackId, name })
            }
            onRemoveTrack={(trackId) => void dispatch({ op: "removeTrack", trackId })}
            onClipContextMenu={(clipId, x, y) => {
              const target = selectedClipIds.includes(clipId) ? selectedClipIds : [clipId];
              setSelectedClipIds(target);

              const clip = findClip(project, clipId);
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
                          onSelect: () => void dispatch({ op: "detachAudio", clipId }),
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
                            void dispatch({ op: "reattachAudio", clipId });
                            setSelectedClipIds([]);
                          },
                        },
                      ]
                    : []),
                  {
                    label: "Move to playhead",
                    icon: "select",
                    onSelect: () => {
                      const moving = findClip(latest.current.project, clipId);
                      if (moving) {
                        void dispatch({
                          op: "moveClips",
                          moves: [
                            {
                              clipId,
                              start: latest.current.playhead,
                              trackId: moving.trackId,
                            },
                          ],
                        });
                      }
                    },
                  },
                  {
                    label: many ? `Delete ${target.length} clips` : "Delete",
                    icon: "trash",
                    hint: "Del",
                    danger: true,
                    onSelect: () => {
                      void dispatch({ op: "removeClips", clipIds: target });
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

      {templateDialog && (
        <SaveTemplateDialog
          defaultName={session.name}
          slotCount={project.media.filter((item) => item.placeholder).length}
          busy={templateDialog.busy}
          onSave={(name) => {
            setTemplateDialog({ busy: true });
            templateSave(name)
              .then((info) => {
                setTemplateDialog(null);
                setToast({
                  id: Date.now(),
                  message: `Saved template "${info.name}"`,
                  failed: false,
                });
              })
              .catch((cause: unknown) => {
                setTemplateDialog({ busy: false });
                setToast({ id: Date.now(), message: String(cause), failed: true });
              });
          }}
          onCancel={() => setTemplateDialog(null)}
        />
      )}

      {timelineToDelete && (
        <ConfirmDialog
          title={`Delete "${timelineToDelete.name}"?`}
          message={(() => {
            const count = timelineClipCount(project, timelineToDelete.id);
            return count > 0
              ? `The ${count} clip${count === 1 ? "" : "s"} on this timeline will be lost.`
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

      {/* The dragged item follows the pointer. */}
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
