import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

import type { ExportClip, ExportProgress } from "../lib/engine";
import { exportProject, onExportProgress, writeCacheFile } from "../lib/engine";
import { rasterizeTitle } from "../lib/rasterize";
import type { TextStyle } from "../lib/text";
import { shortDuration } from "../lib/time";
import { ErrorNotice } from "./ErrorNotice";
import { Icon } from "./Icon";

/** Quality presets, in the terms a person picking one actually thinks in. */
const QUALITIES = [
  { label: "High", crf: 18, preset: "slow", hint: "large" },
  { label: "Balanced", crf: 22, preset: "medium", hint: "default" },
  { label: "Small", crf: 27, preset: "fast", hint: "compact" },
] as const;

/**
 * A title bound for the file. The engine composites pixels, not fonts, so the
 * dialog rasterises each of these into a full-frame transparent PNG at the
 * output size just before the render starts.
 */
export interface ExportTitle {
  clipId: string;
  style: TextStyle;
  /** Offset from centred, as a fraction of the frame. */
  offsetX: number;
  offsetY: number;
  start: number;
  duration: number;
  /** Index into the track stack, zero being bottom-most. */
  track: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "running"; progress: ExportProgress | null }
  | { kind: "done"; path: string }
  | { kind: "failed"; message: string };

/** A title's PNG, dressed as the flat clip the exporter understands. */
function overlayClip(title: ExportTitle, path: string): ExportClip {
  return {
    path,
    kind: "image",
    start: title.start,
    duration: title.duration,
    sourceStart: 0,
    track: title.track,
    hidden: false,
    muted: true,
    volume: 0,
    fadeIn: 0,
    fadeOut: 0,
    filterChain: "",
    speed: 1,
    preservePitch: true,
    // Identity on purpose: the clip's offsets are baked into the PNG, and
    // absent media dimensions make the exporter fill the frame edge to edge -
    // exactly what a full-frame overlay wants.
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    mediaWidth: null,
    mediaHeight: null,
  };
}

/**
 * The export sheet.
 *
 * Rendering happens on a blocking thread in the host and reports back through
 * an event, so this listens rather than waiting - a two-minute export that
 * says nothing until it finishes is indistinguishable from a hang.
 *
 * The backdrop dims rather than hides: the edit behind it is what is being
 * exported, and watching the file happen over the thing it is made from is
 * both orienting and honest. Only the sheet itself is opaque.
 */
export function ExportDialog({
  projectName,
  projectPath,
  width,
  height,
  rateNum,
  rateDen,
  duration,
  clips,
  titles,
  onClose,
}: {
  projectName: string;
  projectPath: string;
  width: number;
  height: number;
  rateNum: number;
  rateDen: number;
  duration: number;
  clips: ExportClip[];
  titles: ExportTitle[];
  onClose: () => void;
}) {
  const [output, setOutput] = useState(`${projectPath}/${projectName}.mp4`);
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>(QUALITIES[1]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const unlisten = useRef<(() => void) | null>(null);
  // When the engine started counting frames, for the time-left estimate.
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    return () => unlisten.current?.();
  }, []);

  const running = phase.kind === "running";
  const empty = clips.length === 0 && titles.length === 0;

  const browse = async () => {
    const chosen = await save({
      title: "Export to",
      defaultPath: output,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (chosen) setOutput(chosen);
  };

  const start = async () => {
    if (running || empty) return;

    setPhase({ kind: "running", progress: null });
    startedAt.current = null;

    try {
      // Titles first, before the engine is involved: each becomes a PNG in
      // the project cache and joins the clip list as one more still.
      const overlays: ExportClip[] = [];
      for (const [index, title] of titles.entries()) {
        setPhase({
          kind: "running",
          progress: { frame: index, total: titles.length, stage: "drawing titles" },
        });
        const bytes = await rasterizeTitle(title.style, title.offsetX, title.offsetY, width, height);
        const key = `title-${index}-${title.clipId.replace(/[^A-Za-z0-9_-]/g, "")}.png`;
        const path = await writeCacheFile(projectPath, key, bytes);
        overlays.push(overlayClip(title, path));
      }

      setPhase({ kind: "running", progress: null });
      unlisten.current = await onExportProgress((progress) => {
        startedAt.current ??= performance.now();
        setPhase((current) =>
          current.kind === "running" ? { kind: "running", progress } : current,
        );
      });

      const path = await exportProject({
        output,
        width,
        height,
        rateNum,
        rateDen,
        crf: quality.crf,
        preset: quality.preset,
        clips: [...clips, ...overlays],
      });
      setPhase({ kind: "done", path });
    } catch (cause) {
      setPhase({ kind: "failed", message: String(cause) });
    } finally {
      unlisten.current?.();
      unlisten.current = null;
    }
  };

  const percent =
    phase.kind === "running" && phase.progress && phase.progress.total > 0
      ? Math.min(100, Math.round((phase.progress.frame / phase.progress.total) * 100))
      : null;

  // A time-left estimate from the frame rate so far. Held back until a second
  // of footage has rendered - the first frames carry startup cost and would
  // only produce a number that shrinks embarrassingly fast.
  let remaining: string | null = null;
  if (phase.kind === "running" && phase.progress && startedAt.current !== null) {
    const { frame, total } = phase.progress;
    const elapsed = (performance.now() - startedAt.current) / 1000;
    if (frame > rateNum / rateDen && total > frame && elapsed > 1) {
      remaining = `about ${shortDuration((elapsed / frame) * (total - frame))} left`;
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8
                 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        // The backdrop closes the sheet the way every sheet closes - but
        // never out from under a running render.
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <div className="surface w-full max-w-md rounded-2xl p-6">
        <div className="mb-5 flex items-center gap-2">
          <Icon name="export" size={17} className="text-accent" />
          <h2 className="flex-1 text-sm font-semibold text-primary">Export</h2>
          {!running && (
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="cursor-pointer rounded p-1 text-secondary hover:bg-hover hover:text-primary"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>

        <dl className="mb-5 space-y-1 rounded-lg bg-sunken px-3 py-2.5">
          <Row label="Format" value={`${width} x ${height} · ${(rateNum / rateDen).toFixed(2)} fps`} />
          <Row label="Duration" value={shortDuration(duration)} />
          <Row
            label="Contents"
            value={
              `${clips.length} clip${clips.length === 1 ? "" : "s"}` +
              (titles.length > 0 ? ` · ${titles.length} title${titles.length === 1 ? "" : "s"}` : "")
            }
          />
        </dl>

        {phase.kind === "idle" || phase.kind === "failed" ? (
          <>
            <Label>Save to</Label>
            <div className="mb-5 flex gap-1.5">
              <input
                value={output}
                spellCheck={false}
                onChange={(event) => setOutput(event.target.value)}
                className="min-w-0 flex-1 rounded-lg border border-hairline bg-sunken px-3 py-2
                           font-technical text-[11px] text-primary focus:border-accent focus:outline-none"
              />
              <button
                type="button"
                onClick={() => void browse()}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-hover px-3
                           text-xs text-primary transition-colors hover:bg-active"
              >
                <Icon name="folder" size={13} />
                Browse
              </button>
            </div>

            <Label>Quality</Label>
            <div className="mb-5 grid grid-cols-3 gap-1.5">
              {QUALITIES.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={option.label === quality.label}
                  onClick={() => setQuality(option)}
                  className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-lg px-2 py-2
                              transition-colors ${
                                option.label === quality.label
                                  ? "bg-accent text-on-accent"
                                  : "bg-hover text-secondary hover:bg-active"
                              }`}
                >
                  <span className="text-xs">{option.label}</span>
                  <span className="text-[10px] opacity-60">{option.hint}</span>
                </button>
              ))}
            </div>

            {phase.kind === "failed" && (
              <ErrorNotice message={phase.message} className="mb-4" />
            )}

            <button
              type="button"
              onClick={() => void start()}
              disabled={empty || !output.trim()}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg
                         bg-accent px-4 py-2.5 text-sm font-medium text-on-accent transition-colors
                         hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="export" size={15} />
              {empty ? "Nothing to export" : phase.kind === "failed" ? "Try again" : "Export"}
            </button>
          </>
        ) : phase.kind === "running" ? (
          <div className="py-2">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-xs text-primary">
                {phase.progress?.stage ?? "starting"}
              </span>
              <span className="shrink-0 font-technical text-sm tabular-nums text-primary">
                {percent === null ? "" : `${percent}%`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-active">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${percent ?? 3}%` }}
              />
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3">
              {phase.progress && phase.progress.total > 0 ? (
                <p className="font-technical text-[10px] text-tertiary">
                  frame {phase.progress.frame} of {phase.progress.total}
                </p>
              ) : (
                <span />
              )}
              {remaining && (
                <p className="font-technical text-[10px] tabular-nums text-tertiary">{remaining}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="py-1">
            <p className="mb-1 flex items-center gap-2 text-sm text-success">
              <Icon name="check" size={14} />
              Export finished
            </p>
            <p className="mb-5 wrap-break-word font-technical text-[10px] text-secondary">{phase.path}</p>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void revealItemInDir(phase.path).catch(() => undefined)}
                className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg
                           bg-hover px-4 py-2.5 text-sm text-primary transition-colors hover:bg-active"
              >
                <Icon name="folder" size={13} />
                Show in Finder
              </button>
              <button
                type="button"
                onClick={onClose}
                className="flex-1 cursor-pointer rounded-lg bg-accent px-4 py-2.5 text-sm font-medium
                           text-on-accent transition-colors hover:bg-accent-hover"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-secondary">
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-[11px] text-secondary">{label}</dt>
      <dd className="truncate font-technical text-[11px] text-primary">{value}</dd>
    </div>
  );
}
