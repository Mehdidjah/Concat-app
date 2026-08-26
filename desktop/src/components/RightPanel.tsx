import type { Clip, MediaItem, Project } from "../lib/project";
import type { ClipFilter } from "../lib/filters";
import { AdjustPanel } from "./AdjustPanel";
import { FiltersPanel } from "./FiltersPanel";
import { Inspector } from "./Inspector";
import { Panel } from "./Panel";
import { TextPanel } from "./TextPanel";

export type RightTab = "details" | "adjust" | "filters" | "text";

const TABS: { id: RightTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "adjust", label: "Adjust" },
  { id: "filters", label: "Filters" },
];

/**
 * Text replaces Adjust and Filters when a title is selected.
 *
 * A text clip has no volume, no speed and no audio filters, so offering those
 * tabs would be offering three panels that can only say "nothing here". The
 * tab strip therefore depends on what is selected rather than being fixed.
 */
const TEXT_TABS: { id: RightTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "text", label: "Text" },
];

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
  frameRate,
  onChangeClip,
  onSpeedChange,
  onAddFont,
  onRemoveFont,
  rendering,
}: {
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  clip: Clip | null;
  media: MediaItem | null;
  project: Project;
  frameRate: number;
  onChangeClip: (patch: Partial<Clip>) => void;
  onSpeedChange: (speed: number) => void;
  onAddFont: () => void;
  onRemoveFont: (family: string) => void;
  /** True while the selected clip's filtered audio is being rendered. */
  rendering: boolean;
}) {
  const isText = clip?.kind === "text";
  const tabs = isText ? TEXT_TABS : TABS;

  // Selecting a title while sitting on Filters would otherwise leave the strip
  // with nothing highlighted and the panel showing a tab that is no longer
  // offered, so the selection falls back to one that exists.
  const active = tabs.some((entry) => entry.id === tab) ? tab : "details";

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

      {active === "details" && <Inspector clip={clip} media={media} frameRate={frameRate} />}
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
          rendering={rendering}
          onChange={(filters: ClipFilter[]) => onChangeClip({ filters })}
        />
      )}
    </Panel>
  );
}
