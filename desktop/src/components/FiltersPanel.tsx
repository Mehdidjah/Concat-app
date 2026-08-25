import { useState } from "react";

import {
  CATEGORIES,
  FILTERS,
  findFilter,
  resolveParams,
  type ClipFilter,
  type FilterCategory,
} from "../lib/filters";
import type { Clip } from "../lib/project";
import { Slider } from "./controls";
import { Icon, IconButton } from "./Icon";
import { Empty } from "./Panel";

/**
 * The Filters tab.
 *
 * Filters are a *list* on the clip, not a set of toggles, because they apply
 * in order and order is audible. Adding the same filter twice is allowed for
 * the same reason - two gentle EQ lifts are a real thing to want.
 *
 * Everything here writes plain numbers onto the clip. The FFmpeg chain is
 * built from those in one place (`lib/filters.ts`) and used by both the
 * preview and the exporter, so what you hear is what gets rendered.
 */
export function FiltersPanel({
  clip,
  rendering,
  onChange,
}: {
  clip: Clip | null;
  /** True while the preview is re-rendering this clip's audio. */
  rendering: boolean;
  onChange: (filters: ClipFilter[]) => void;
}) {
  const [category, setCategory] = useState<FilterCategory>("voice");

  if (!clip) {
    return (
      <Empty icon={<Icon name="settings" size={26} strokeWidth={1.5} />}>
        Select a single clip to add filters.
      </Empty>
    );
  }

  if (clip.kind === "image") {
    return (
      <Empty icon={<Icon name="image" size={26} strokeWidth={1.5} />}>
        A still has no audio to filter.
      </Empty>
    );
  }

  const applied = clip.filters;

  const add = (id: string) => onChange([...applied, { id, params: {} }]);
  const remove = (index: number) => onChange(applied.filter((_, at) => at !== index));
  const setParam = (index: number, key: string, value: number) =>
    onChange(
      applied.map((filter, at) =>
        at === index ? { ...filter, params: { ...filter.params, [key]: value } } : filter,
      ),
    );
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= applied.length) return;
    const next = [...applied];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="px-3 py-3">
      {applied.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
            Applied
            {rendering && (
              <span className="font-normal normal-case tracking-normal text-accent">
                rendering...
              </span>
            )}
          </h3>

          <ul className="flex flex-col gap-2">
            {applied.map((entry, index) => {
              const definition = findFilter(entry.id);
              if (!definition) return null;
              const values = resolveParams(definition, entry.params);

              return (
                <li key={`${entry.id}-${index}`} className="rounded-lg bg-sunken p-2.5">
                  <div className="mb-2 flex items-center gap-1">
                    <span className="min-w-0 flex-1 truncate text-xs text-primary">
                      {definition.label}
                    </span>
                    <IconButton
                      icon="chevronDown"
                      label="Move later in the chain"
                      size={7}
                      disabled={index === applied.length - 1}
                      onClick={() => move(index, 1)}
                    />
                    <IconButton
                      icon="close"
                      label={`Remove ${definition.label}`}
                      size={7}
                      tone="danger"
                      onClick={() => remove(index)}
                    />
                  </div>

                  {definition.params.map((param) => (
                    <Slider
                      key={param.key}
                      label={param.label}
                      value={values[param.key]}
                      min={param.min}
                      max={param.max}
                      step={param.step}
                      format={param.format}
                      onReset={() => setParam(index, param.key, param.default)}
                      onChange={(value) => setParam(index, param.key, value)}
                    />
                  ))}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <div className="mb-3 flex rounded-lg bg-sunken p-0.5">
        {CATEGORIES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            aria-pressed={category === entry.id}
            onClick={() => setCategory(entry.id)}
            className={`flex-1 cursor-pointer rounded-[6px] px-2 py-1 text-[12px] transition-colors ${
              category === entry.id
                ? "bg-panel text-primary shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
                : "text-secondary hover:text-primary"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <ul className="flex flex-col gap-1">
        {FILTERS.filter((filter) => filter.category === category).map((filter) => (
          <li key={filter.id}>
            <button
              type="button"
              onClick={() => add(filter.id)}
              className="w-full cursor-pointer rounded-lg px-2 py-2 text-left transition-colors
                         hover:bg-hover"
            >
              <span className="flex items-center gap-2">
                <Icon name="plus" size={12} className="shrink-0 text-tertiary" />
                <span className="text-xs text-primary">{filter.label}</span>
              </span>
              <span className="mt-0.5 block pl-5 text-[11px] leading-snug text-tertiary">
                {filter.blurb}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
