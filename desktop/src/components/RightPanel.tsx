import type { AppliedEffect, ClipTransition } from "../lib/effects";
import type { ClipFilter } from "../lib/filters";
import { precedingClip, type Clip, type MediaItem, type Project } from "../lib/project";
import { AdjustPanel } from "./AdjustPanel";
import { EffectsPanel } from "./EffectsPanel";
import { FiltersPanel } from "./FiltersPanel";
import { Inspector } from "./Inspector";
import { Panel } from "./Panel";
import { TextPanel } from "./TextPanel";

export type RightTab = "details" | "adjust" | "filters" | "effects" | "text";

/**
 * The tab strip follows the selection.
 *
 * Nothing selected: only Details, showing the project itself - there is
 * nothing to edit, so no editing tabs. A media clip selected: Adjust and
 * Filters, the things that can actually be changed. A title: just Text,
 * because a text clip has no volume, no speed and no audio filters, and
 * offering those tabs would be offering panels that can only say "nothing
 * here".
 */
const DETAILS_TABS: { id: RightTab; label: string }[] = [{ id: "details", label: "Details" }];

const CLIP_TABS: { id: RightTab; label: string }[] = [
  { id: "adjust", label: "Adjust" },
  { id: "filters", label: "Filters" },
  { id: "effects", label: "Effects" },
];

// A still has picture but no sound, so it gets Effects but not Filters.
const IMAGE_TABS: { id: RightTab; label: string }[] = [
  { id: "adjust", label: "Adjust" },
  { id: "effects", label: "Effects" },
];

const TEXT_TABS: { id: RightTab; label: string }[] = [{ id: "text", label: "Text" }];

/**
 * The right-hand panel.
 *
 * Details is what a thing *is*, Adjust is what you can change about it, and
 * Filters is what you can add to it. Keeping those apart matters because the
 * first is read-only and the other two are not, and mixing them makes it
 * unclear which numbers you are allowed to touch.
 */
export function RightPanel({
  tab,
  onTab,
  clip,
  media,
  project,
  projectName,
  projectPath,
  frame,
  duration,
  frameRate,
  onChangeClip,
  onSpeedChange,
  onAddFont,
  onRemoveFont,
}: {
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  clip: Clip | null;
  media: MediaItem | null;
  project: Project;
  projectName: string;
  projectPath: string;
  frame: { width: number; height: number };
  duration: number;
  frameRate: number;
  onChangeClip: (patch: Partial<Clip>) => void;
  onSpeedChange: (speed: number) => void;
  onAddFont: () => void;
  onRemoveFont: (family: string) => void;
}) {
  const isText = clip?.kind === "text";
  const tabs = clip
    ? isText
      ? TEXT_TABS
      : clip.kind === "image"
        ? IMAGE_TABS
        : CLIP_TABS
    : DETAILS_TABS;

  // A selection change can leave the strip showing a tab that is no longer
  // offered, so the active tab falls back to the first one that exists.
  const active = tabs.some((entry) => entry.id === tab) ? tab : tabs[0].id;

  return (
    <Panel>
      <div className="sticky top-0 z-10 border-b border-hairline bg-panel px-2 pb-2 pt-2">
        <div className="flex rounded-lg bg-sunken p-0.5">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={active === entry.id}
              onClick={() => onTab(entry.id)}
              className={`flex-1 cursor-pointer rounded-[6px] px-2 py-1 text-[12px] transition-colors ${
                active === entry.id
                  ? "bg-panel text-primary shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
                  : "text-secondary hover:text-primary"
              }`}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {active === "details" && (
        <Inspector
          clip={clip}
          media={media}
          frameRate={frameRate}
          project={project}
          projectName={projectName}
          projectPath={projectPath}
          frame={frame}
          duration={duration}
        />
      )}
      {active === "text" && (
        <TextPanel
          clip={clip}
          project={project}
          onChange={onChangeClip}
          onAddFont={onAddFont}
          onRemoveFont={onRemoveFont}
        />
      )}
      {active === "adjust" && (
        <AdjustPanel clip={clip} onChange={onChangeClip} onSpeedChange={onSpeedChange} />
      )}
      {active === "filters" && (
        <FiltersPanel
          clip={clip}
          onChange={(filters: ClipFilter[]) => onChangeClip({ filters })}
        />
      )}
      {active === "effects" && (
        <EffectsPanel
          clip={clip}
          hasPreceding={clip ? precedingClip(project, clip.id) !== null : false}
          onChangeEffects={(videoEffects: AppliedEffect[]) => onChangeClip({ videoEffects })}
          onChangeTransition={(transitionIn: ClipTransition | undefined) =>
            onChangeClip({ transitionIn })
          }
        />
      )}
    </Panel>
  );
}
