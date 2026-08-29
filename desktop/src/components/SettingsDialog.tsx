import { useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import {
  cancelModelDownload,
  deleteTranscriberModel,
  downloadTranscriberModel,
  engineVersion,
  onTranscriberDownload,
  setTranscriberBinary,
  transcriberStatus,
  type TranscriberStatus,
} from "../lib/engine";
import {
  getTranscriberLanguage,
  getTranscriberModel,
  setTranscriberLanguage,
  setTranscriberModel,
} from "../lib/settings";
import { HelpTip } from "./controls";
import { Icon } from "./Icon";

/** The pages of the settings dialog, in display order. */
type SettingsTab = "transcriber" | "about";

const TABS: { id: SettingsTab; label: string; icon: "waveform" | "info" }[] = [
  { id: "transcriber", label: "Transcriber", icon: "waveform" },
  { id: "about", label: "About", icon: "info" },
];

/**
 * The settings sheet: a tab rail on the left, one feature's settings on the
 * right - the same shape as the library panel, so the app has one way of
 * laying out "categories of things".
 *
 * Settings here are app-level (this machine), never project state.
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>("transcriber");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8
                 backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="surface flex h-[460px] w-full max-w-2xl flex-col rounded-2xl">
        <div className="flex items-center gap-2 border-b border-hairline px-5 py-3.5">
          <Icon name="settings" size={16} className="text-accent" />
          <h2 className="flex-1 text-sm font-semibold text-primary">Settings</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="cursor-pointer rounded p-1 text-secondary hover:bg-hover hover:text-primary"
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <aside className="w-40 shrink-0 border-r border-hairline p-2">
            {TABS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                aria-pressed={tab === entry.id}
                onClick={() => setTab(entry.id)}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5
                            text-xs transition-colors ${
                              tab === entry.id
                                ? "bg-active text-primary"
                                : "text-secondary hover:bg-hover"
                            }`}
              >
                <Icon name={entry.icon} size={13} className="shrink-0 opacity-70" />
                {entry.label}
              </button>
            ))}
          </aside>

          <div className="thin-scroll min-w-0 flex-1 overflow-y-auto px-5 py-4">
            {tab === "transcriber" && <TranscriberSettings />}
            {tab === "about" && <AboutSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Bytes as a short human figure for model rows. */
function formatSize(bytes: number): string {
  return bytes >= 1_000_000_000
    ? `${(bytes / 1_000_000_000).toFixed(1)} GB`
    : `${Math.round(bytes / 1_000_000)} MB`;
}

const LANGUAGES = [
  { id: "auto", label: "Auto-detect" },
  { id: "en", label: "English" },
] as const;

function TranscriberSettings() {
  const [status, setStatus] = useState<TranscriberStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(getTranscriberModel());
  const [language, setLanguage] = useState(getTranscriberLanguage());
  /** The model being downloaded and how far along it is, or null. */
  const [download, setDownload] = useState<{ id: string; fraction: number } | null>(null);
  const unlisten = useRef<(() => void) | null>(null);

  const refresh = () => {
    transcriberStatus()
      .then((next) => {
        setStatus(next);
        setError(null);
      })
      .catch((cause: unknown) => setError(String(cause)));
  };

  useEffect(() => {
    refresh();
    void onTranscriberDownload((progress) => {
      if (progress.done) {
        setDownload(null);
        refresh();
      } else {
        setDownload({
          id: progress.id,
          fraction: progress.total > 0 ? progress.received / progress.total : 0,
        });
      }
    }).then((stop) => {
      unlisten.current = stop;
    });
    return () => unlisten.current?.();
  }, []);

  const locate = async () => {
    const chosen = await open({
      title: "Locate whisper-cli",
      multiple: false,
      filters: [{ name: "Program", extensions: ["exe", "*"] }],
    });
    if (typeof chosen !== "string") return;
    try {
      setStatus(await setTranscriberBinary(chosen));
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const startDownload = (id: string) => {
    setDownload({ id, fraction: 0 });
    downloadTranscriberModel(id)
      .then(() => {
        setDownload(null);
        refresh();
      })
      .catch((cause: unknown) => {
        setDownload(null);
        setError(String(cause));
        refresh();
      });
  };

  const remove = (id: string) => {
    deleteTranscriberModel(id)
      .then(refresh)
      .catch((cause: unknown) => setError(String(cause)));
  };

  const chooseModel = (id: string) => {
    setModel(id);
    setTranscriberModel(id);
  };

  const chooseLanguage = (id: string) => {
    setLanguage(id);
    setTranscriberLanguage(id);
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Which binary transcribes is plumbing, not a setting: a healthy
          install says nothing about it. The bar exists only for a dev build
          with no engine at all, where Locate... is the way out. */}
      {status !== null && !status.binary && (
        <section>
          <div className="flex items-center gap-2 rounded-lg bg-sunken px-3 py-2.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-danger" />
            <span className="min-w-0 flex-1 truncate text-xs text-secondary">
              Transcription engine not found in this dev build
            </span>
            <button
              type="button"
              onClick={() => void locate()}
              className="shrink-0 cursor-pointer rounded-md bg-panel px-2.5 py-1 text-[11px]
                         text-primary ring-1 ring-hairline transition-colors hover:bg-hover"
            >
              Locate...
            </button>
          </div>
        </section>
      )}

      <section>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
          Language
        </h3>
        <div className="flex w-56 rounded-lg bg-sunken p-0.5">
          {LANGUAGES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={language === entry.id}
              onClick={() => chooseLanguage(entry.id)}
              className={`flex-1 cursor-pointer rounded-md px-2 py-1 text-[12px] transition-colors ${
                language === entry.id
                  ? "bg-panel text-primary shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
                  : "text-secondary hover:text-primary"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
          Models
          <HelpTip
            align="start"
            text="Bigger models transcribe better and slower. English-only variants beat the multilingual ones at the same size when the audio is English. The selected model is what Auto captions uses. Everything runs locally - nothing leaves this machine."
          />
        </h3>

        <ul className="flex flex-col gap-1.5">
          {(status?.models ?? []).map((entry) => {
            const downloading = download?.id === entry.id;
            const selected = model === entry.id;
            return (
              <li
                key={entry.id}
                // The whole card selects, not just the radio dot: the dot is
                // a 16px target and the card is what the eye reads as the
                // option. Buttons inside stop propagation so deleting or
                // downloading is never also a selection.
                onClick={() => entry.downloaded && chooseModel(entry.id)}
                className={`flex items-center gap-2.5 rounded-lg px-3 py-2 ring-1 transition-shadow ${
                  selected ? "ring-accent" : "ring-hairline"
                } ${entry.downloaded ? "cursor-pointer" : ""} ${
                  entry.downloaded && !selected ? "hover:ring-hairline-strong" : ""
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={`Use ${entry.label}`}
                  disabled={!entry.downloaded}
                  onClick={() => chooseModel(entry.id)}
                  title={entry.downloaded ? "Use this model" : "Download it first"}
                  className="flex h-4 w-4 shrink-0 cursor-pointer items-center justify-center
                             rounded-full ring-1 ring-hairline-strong
                             disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {selected && <span className="h-2 w-2 rounded-full bg-accent" />}
                </button>

                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-primary">{entry.label}</span>
                  <span className="block truncate text-[11px] text-tertiary">{entry.blurb}</span>
                </span>

                <span className="shrink-0 font-technical text-[10px] text-tertiary">
                  {formatSize(entry.sizeBytes)}
                </span>

                {downloading ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="h-1 w-16 overflow-hidden rounded-full bg-sunken">
                      <span
                        className="block h-full bg-accent transition-[width]"
                        style={{ width: `${Math.round(download.fraction * 100)}%` }}
                      />
                    </span>
                    <button
                      type="button"
                      aria-label="Cancel download"
                      onClick={(event) => {
                        event.stopPropagation();
                        void cancelModelDownload();
                      }}
                      className="cursor-pointer rounded p-0.5 text-secondary hover:bg-hover
                                 hover:text-primary"
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </span>
                ) : entry.downloaded ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Icon name="check" size={12} className="text-success" />
                    <button
                      type="button"
                      aria-label={`Delete ${entry.label}`}
                      title="Delete the downloaded model"
                      onClick={(event) => {
                        event.stopPropagation();
                        remove(entry.id);
                      }}
                      className="cursor-pointer rounded p-0.5 text-secondary transition-colors
                                 hover:bg-hover hover:text-danger"
                    >
                      <Icon name="trash" size={11} />
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={download !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      startDownload(entry.id);
                    }}
                    className="shrink-0 cursor-pointer rounded-md bg-panel px-2.5 py-1 text-[11px]
                               text-primary ring-1 ring-hairline transition-colors hover:bg-hover
                               disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Download
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {error && <p className="mt-2 text-[11px] leading-snug text-danger">{error}</p>}
      </section>
    </div>
  );
}

function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    engineVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
        WolfCut
      </h3>
      <p className="text-xs text-secondary">Version {version ?? "unknown"}</p>
      <p className="text-[11px] leading-relaxed text-tertiary">
        Local-first video editing. Media, models and renders stay on this machine.
      </p>
    </div>
  );
}
