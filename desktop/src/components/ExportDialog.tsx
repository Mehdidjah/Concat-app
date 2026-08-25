import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";

import type { ExportClip, ExportProgress } from "../lib/engine";
import { exportProject, onExportProgress } from "../lib/engine";
import { shortDuration } from "../lib/time";
import { Icon } from "./Icon";

/** Quality presets, in the terms a person picking one actually thinks in. */
const QUALITIES = [
  { label: "High", crf: 18, preset: "slow", hint: "large" },
  { label: "Balanced", crf: 22, preset: "medium", hint: "default" },
  { label: "Small", crf: 27, preset: "fast", hint: "compact" },
] as const;

type Phase =
  | { kind: "idle" }
  | { kind: "running"; progress: ExportProgress | null }
  | { kind: "done"; path: string }
  | { kind: "failed"; message: string };

/**
 * The export sheet.
 *
 * Rendering happens on a blocking thread in the host and reports back through
 * an event, so this listens rather than waiting - a two-minute export that
 * says nothing until it finishes is indistinguishable from a hang.
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
  onClose: () => void;
}) {
  const [output, setOutput] = useState(`${projectPath}\\${projectName}.mp4`);
  const [quality, setQuality] = useState<(typeof QUALITIES)[number]>(QUALITIES[1]);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const unlisten = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => unlisten.current?.();
  }, []);

  const running = phase.kind === "running";

  const browse = async () => {
    const chosen = await save({
      title: "Export to",
      defaultPath: output,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (chosen) setOutput(chosen);
  };

  const start = async () => {
    if (running || clips.length === 0) return;

    setPhase({ kind: "running", progress: null });
    unlisten.current = await onExportProgress((progress) =>
      setPhase((current) => (current.kind === "running" ? { kind: "running", progress } : current)),
    );

    try {
      const path = await exportProject({
        output,
        width,
        height,
        rateNum,
        rateDen,
        crf: quality.crf,
        preset: quality.preset,
        clips,
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-sunken p-8">
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
          <Row label="Clips" value={`${clips.length}`} />
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
                           text-xs text-primary transition-colors hover:bg-hover"
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
                                  : "bg-hover text-secondary hover:bg-hover"
                              }`}
                >
                  <span className="text-xs">{option.label}</span>
                  <span className="text-[10px] opacity-60">{option.hint}</span>
                </button>
              ))}
            </div>

            {phase.kind === "failed" && (
              <p className="mb-4 rounded-lg border border-danger bg-danger-soft px-3 py-2
                            font-technical text-[11px] leading-snug text-danger">
                {phase.message}
              </p>
            )}

            <button
              type="button"
              onClick={() => void start()}
              disabled={clips.length === 0 || !output.trim()}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg
                         bg-accent px-4 py-2.5 text-sm font-medium text-on-accent transition-colors
                         hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="export" size={15} />
              {clips.length === 0 ? "Nothing to export" : "Export"}
            </button>
          </>
        ) : phase.kind === "running" ? (
          <div className="py-2">
            <div className="mb-2 flex items-baseline justify-between">
              <span className="text-xs text-primary">
                {phase.progress?.stage ?? "starting"}
              </span>
              <span className="font-technical text-[11px] tabular-nums text-secondary">
                {percent === null ? "" : `${percent}%`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-active">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${percent ?? 3}%` }}
              />
            </div>
            {phase.progress && phase.progress.total > 0 && (
              <p className="mt-2 font-technical text-[10px] text-tertiary">
                frame {phase.progress.frame} of {phase.progress.total}
              </p>
            )}
          </div>
        ) : (
          <div className="py-1">
            <p className="mb-1 flex items-center gap-2 text-sm text-success">
              <Icon name="play" size={14} />
              Export finished
            </p>
            <p className="mb-5 wrap-break-word font-technical text-[10px] text-secondary">{phase.path}</p>
            <button
              type="button"
              onClick={onClose}
              className="w-full cursor-pointer rounded-lg bg-hover px-4 py-2.5 text-sm text-primary
                         transition-colors hover:bg-hover"
            >
              Done
            </button>
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
