import type { Clip, MediaItem } from "../lib/project";
import type { ClipFilter } from "../lib/filters";
import { AdjustPanel } from "./AdjustPanel";
import { FiltersPanel } from "./FiltersPanel";
import { Inspector } from "./Inspector";
import { Panel } from "./Panel";

export type RightTab = "details" | "adjust" | "filters";

const TABS: { id: RightTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "adjust", label: "Adjust" },
  { id: "filters", label: "Filters" },
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
  frameRate,
  onChangeClip,
  rendering,
}: {
  tab: RightTab;
  onTab: (tab: RightTab) => void;
  clip: Clip | null;
  media: MediaItem | null;
  frameRate: number;
  onChangeClip: (patch: Partial<Clip>) => void;
  /** True while the selected clip's filtered audio is being rendered. */
  rendering: boolean;
}) {
  return (
    <Panel>
      <div className="sticky top-0 z-10 border-b border-hairline bg-panel px-2 pb-2 pt-2">
        <div className="flex rounded-lg bg-sunken p-0.5">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={tab === entry.id}
              onClick={() => onTab(entry.id)}
              className={`flex-1 cursor-pointer rounded-[6px] px-2 py-1 text-[12px] transition-colors ${
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

      {tab === "details" && <Inspector clip={clip} media={media} frameRate={frameRate} />}
      {tab === "adjust" && <AdjustPanel clip={clip} onChange={onChangeClip} />}
      {tab === "filters" && (
        <FiltersPanel
          clip={clip}
          rendering={rendering}
          onChange={(filters: ClipFilter[]) => onChangeClip({ filters })}
        />
      )}
    </Panel>
  );
}
