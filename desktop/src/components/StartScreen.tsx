import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { desktopDir, join } from "@tauri-apps/api/path";

import {
  createProject,
  forgetProject,
  openProject,
  recentProjects,
  type ProjectInfo,
} from "../lib/engine";
import { relativeTime } from "../lib/time";
import { Icon } from "./Icon";

/** The settings a project is created with. Fixed for its lifetime, for now. */
export interface ProjectSession {
  name: string;
  /** Absolute path to the project folder on disk. */
  path: string;
  width: number;
  height: number;
  /** Frames per second as a decimal, for display. */
  frameRate: number;
  /** The same rate as an exact fraction. Export uses these, never the decimal. */
  rateNum: number;
  rateDen: number;
}

const RESOLUTIONS = [
  { label: "1080p", width: 1920, height: 1080 },
  { label: "720p", width: 1280, height: 720 },
  { label: "4K", width: 3840, height: 2160 },
  { label: "Vertical", width: 1080, height: 1920 },
] as const;

// Stored as fractions because 29.97 is 30000/1001 and never anything else.
const FRAME_RATES = [
  { label: "24", num: 24, den: 1 },
  { label: "25", num: 25, den: 1 },
  { label: "29.97", num: 30000, den: 1001 },
  { label: "30", num: 30, den: 1 },
  { label: "60", num: 60, den: 1 },
] as const;

/**
 * The launch screen.
 *
 * Full-bleed on the window's own background - no card, no border, no drop
 * shadow. A setup screen is not a dialog floating over something; it *is* the
 * window, and framing it as a card only adds an edge that means nothing.
 * Hierarchy comes from type size and whitespace instead.
 *
 * An editor should not drop you straight into an untitled timeline either: the
 * frame rate, size and location are decisions the whole edit depends on, and
 * choosing them after material is cut is how you end up conforming footage.
 */
export function StartScreen({ onCreate }: { onCreate: (session: ProjectSession) => void }) {
  const [name, setName] = useState("Untitled project");
  const [location, setLocation] = useState("");
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]>(RESOLUTIONS[0]);
  const [rate, setRate] = useState<(typeof FRAME_RATES)[number]>(FRAME_RATES[3]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<ProjectInfo[]>([]);

  // Default to Desktop/WolfCut. Failing to resolve it is not worth surfacing;
  // the field simply starts empty and Choose still works.
  useEffect(() => {
    void desktopDir()
      .then((desktop) => join(desktop, "WolfCut"))
      .then(setLocation)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void recentProjects()
      .then(setRecents)
      .catch(() => undefined);
  }, []);

  const reopen = async (project: ProjectInfo) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      // Re-read from disk rather than trusting the cached entry: the manifest
      // is the truth, and the folder may have been edited or moved since.
      const fresh = await openProject(project.path);
      onCreate(toSession(fresh));
    } catch (cause) {
      setError(String(cause));
      setBusy(false);
    }
  };

  const forget = async (project: ProjectInfo) => {
    setRecents((current) => current.filter((entry) => entry.path !== project.path));
    await forgetProject(project.path).catch(() => undefined);
  };

  const browse = async () => {
    const chosen = await open({
      directory: true,
      multiple: false,
      title: "Where should this project live?",
      defaultPath: location || undefined,
    });
    if (typeof chosen === "string") setLocation(chosen);
  };

  const create = async () => {
    const trimmed = name.trim() || "Untitled project";
    if (!location.trim() || busy) return;

    setBusy(true);
    setError(null);
    try {
      // The engine creates the folder and writes the manifest, and hands back
      // where it actually landed - which is not always `location/name`, since
      // the name has to be made filesystem-safe first.
      const project = await createProject({
        location: location.trim(),
        name: trimmed,
        width: resolution.width,
        height: resolution.height,
        rateNum: rate.num,
        rateDen: rate.den,
      });

      onCreate(toSession(project));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="thin-scroll h-full overflow-y-auto bg-base">
      <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center px-8 py-16">
        <header className="mb-10">
          <h1 className="font-display text-[34px] font-semibold leading-tight tracking-[-0.03em] text-primary">
            New project
          </h1>
          <p className="mt-1.5 text-sm text-secondary">
            These settings apply to the whole edit and cannot be changed later.
          </p>
        </header>

        <Field label="Name">
          <input
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => event.key === "Enter" && void create()}
            className="w-full bg-transparent py-1 text-[15px] text-primary outline-none
                       placeholder:text-tertiary"
          />
        </Field>

        <Field label="Location">
          <div className="flex items-center gap-3">
            <input
              value={location}
              spellCheck={false}
              placeholder="Choose a folder"
              onChange={(event) => setLocation(event.target.value)}
              className="min-w-0 flex-1 bg-transparent py-1 font-technical text-[12px] text-primary
                         outline-none placeholder:text-tertiary"
            />
            <button
              type="button"
              onClick={() => void browse()}
              className="shrink-0 cursor-pointer text-[13px] text-accent transition-opacity
                         hover:opacity-70"
            >
              Choose...
            </button>
          </div>
        </Field>

        <Field label="Resolution">
          <Segmented
            options={RESOLUTIONS.map((option) => option.label)}
            value={resolution.label}
            onChange={(label) =>
              setResolution(RESOLUTIONS.find((option) => option.label === label) ?? RESOLUTIONS[0])
            }
          />
          <p className="mt-2 font-technical text-[11px] text-tertiary">
            {resolution.width} x {resolution.height}
          </p>
        </Field>

        <Field label="Frame rate" last>
          <Segmented
            options={FRAME_RATES.map((option) => option.label)}
            value={rate.label}
            onChange={(label) =>
              setRate(FRAME_RATES.find((option) => option.label === label) ?? FRAME_RATES[3])
            }
          />
          <p className="mt-2 font-technical text-[11px] text-tertiary">
            {rate.num}/{rate.den} fps
          </p>
        </Field>

        {error && (
          <p className="mt-6 text-[12px] leading-relaxed text-danger">{error}</p>
        )}

        <div className="mt-10 flex items-center gap-4">
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy || !location.trim()}
            className="cursor-pointer rounded-full bg-accent px-6 py-2.5 text-[14px] font-medium
                       text-on-accent transition-colors hover:bg-accent-hover
                       disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Creating..." : "Create"}
          </button>
          <p className="flex items-center gap-1.5 text-[11px] text-tertiary">
            <Icon name="info" size={12} className="shrink-0" />
            The timeline is not saved to disk yet.
          </p>
        </div>

        {/* No empty state: a "Recent" heading over nothing is worse than no
            heading at all, so the section simply is not there until it has
            something to show. */}
        {recents.length > 0 && (
          <section className="mt-14 border-t border-hairline pt-7">
            <h2 className="mb-2 text-[13px] font-semibold text-secondary">Recent</h2>
            <ul className="-mx-3">
              {recents.map((project) => (
                <li key={project.path} className="group flex items-center gap-3 rounded-lg px-3
                                                  transition-colors hover:bg-hover">
                  <button
                    type="button"
                    title={project.path}
                    disabled={busy}
                    onClick={() => void reopen(project)}
                    className="min-w-0 flex-1 cursor-pointer py-2.5 text-left
                               disabled:cursor-not-allowed"
                  >
                    <span className="block truncate text-[14px] text-primary">{project.name}</span>
                    <span className="block truncate font-technical text-[11px] text-tertiary">
                      {project.width} x {project.height} ·{" "}
                      {(project.rateNum / project.rateDen).toFixed(2)} fps
                    </span>
                  </button>

                  <span className="shrink-0 text-[11px] text-tertiary">
                    {relativeTime(project.openedAt)}
                  </span>

                  <button
                    type="button"
                    aria-label={`Remove ${project.name} from recents`}
                    title="Remove from this list. The folder is left alone."
                    onClick={() => void forget(project)}
                    className="invisible shrink-0 cursor-pointer rounded p-1 text-tertiary
                               transition-colors hover:bg-active hover:text-primary
                               group-hover:visible"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

/** The decimal rate is derived, never stored - the fraction is the truth. */
function toSession(project: ProjectInfo): ProjectSession {
  return {
    name: project.name,
    path: project.path,
    width: project.width,
    height: project.height,
    frameRate: project.rateNum / project.rateDen,
    rateNum: project.rateNum,
    rateDen: project.rateDen,
  };
}

/** A labelled row separated by a hairline, in the style of a settings list. */
function Field({
  label,
  children,
  last = false,
}: {
  label: string;
  children: ReactNode;
  last?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-4 py-4 ${
        last ? "" : "border-b border-hairline"
      }`}
    >
      <span className="text-[13px] text-secondary">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * An Apple-style segmented control: one recessed track with a raised pill
 * marking the selection, rather than a row of separate buttons.
 */
function Segmented({
  options,
  value,
  onChange,
}: {
  options: readonly string[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      className="inline-flex rounded-lg bg-sunken p-0.5"
    >
      {options.map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={option === value}
          onClick={() => onChange(option)}
          className={`cursor-pointer rounded-[6px] px-3.5 py-1 text-[13px] transition-colors ${
            option === value
              ? "bg-panel text-primary shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
              : "text-secondary hover:text-primary"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
