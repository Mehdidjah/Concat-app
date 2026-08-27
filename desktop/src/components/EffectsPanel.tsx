import {
  EFFECTS,
  findEffect,
  findTransition,
  resolveEffectParams,
  type AppliedEffect,
  type ClipTransition,
} from "../lib/effects";
import type { Clip } from "../lib/project";
import { HelpTip, Slider } from "./controls";
import { Icon, IconButton } from "./Icon";
import { Empty } from "./Panel";

/**
 * The Effects tab: the video sibling of the Filters tab.
 *
 * Effects are a list on the clip, applied in order, each with its own
 * parameters, bypass and remove - the exact shape FiltersPanel gives audio,
 * because the two are the same idea pointed at different senses. The browsing
 * library lives in the bin's Effects page; this panel manages what is already
 * on the clip, plus the transition on its cut.
 */
export function EffectsPanel({
  clip,
  hasPreceding,
  onChangeEffects,
  onChangeTransition,
}: {
  clip: Clip | null;
  /** Whether a clip ends where this one starts - what a transition needs. */
  hasPreceding: boolean;
  onChangeEffects: (effects: AppliedEffect[]) => void;
  onChangeTransition: (transition: ClipTransition | undefined) => void;
}) {
  if (!clip || (clip.kind !== "video" && clip.kind !== "image")) {
    return (
      <Empty icon={<Icon name="sparkles" size={26} strokeWidth={1.5} />}>
        Select a video or image clip to add effects.
      </Empty>
    );
  }

  const applied = clip.videoEffects;
  const transition = clip.transitionIn;
  const transitionDefinition = transition ? findTransition(transition.id) : null;

  const add = (id: string) => onChangeEffects([...applied, { id, params: {} }]);
  const remove = (index: number) => onChangeEffects(applied.filter((_, at) => at !== index));
  const patch = (index: number, change: Partial<AppliedEffect>) =>
    onChangeEffects(applied.map((effect, at) => (at === index ? { ...effect, ...change } : effect)));
  const setParam = (index: number, key: string, value: number) =>
    patch(index, { params: { ...applied[index].params, [key]: value } });
  const move = (index: number, by: number) => {
    const target = index + by;
    if (target < 0 || target >= applied.length) return;
    const next = [...applied];
    [next[index], next[target]] = [next[target], next[index]];
    onChangeEffects(next);
  };

  return (
    <div className="px-3 py-3">
      {transition && transitionDefinition && (
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
            Transition
            <HelpTip text="The transition on the cut into this clip. It needs the clip before it to stay touching - moved apart, it renders as a plain cut." />
          </h3>
          <div className="rounded-lg bg-sunken p-2.5">
            <div className="mb-2 flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate text-xs text-primary">
                {transitionDefinition.label}
              </span>
              <IconButton
                icon="close"
                label={`Remove ${transitionDefinition.label}`}
                size={7}
                tone="danger"
                onClick={() => onChangeTransition(undefined)}
              />
            </div>
            {!hasPreceding && (
              <p className="mb-2 text-[11px] leading-snug text-danger">
                No clip ends where this one starts, so this transition currently renders as a
                plain cut.
              </p>
            )}
            <Slider
              label="Duration"
              value={transition.duration}
              min={0.2}
              max={3}
              step={0.1}
              format={(value) => `${value.toFixed(1)}s`}
              onReset={() =>
                onChangeTransition({ ...transition, duration: transitionDefinition.defaultDuration })
              }
              onChange={(value) => onChangeTransition({ ...transition, duration: value })}
            />
          </div>
        </section>
      )}

      {applied.length > 0 && (
        <section className="mb-5">
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
            Applied
            <HelpTip text="Effects run top to bottom. The eye bypasses one without losing its settings - flick it to compare." />
          </h3>

          <ul className="flex flex-col gap-2">
            {applied.map((entry, index) => {
              const definition = findEffect(entry.id);
              if (!definition) return null;
              const values = resolveEffectParams(definition, entry.params);
              const active = entry.enabled !== false;

              return (
                <li key={`${entry.id}-${index}`} className="rounded-lg bg-sunken p-2.5">
                  <div className="mb-2 flex items-center gap-1">
                    <span
                      className={`min-w-0 flex-1 truncate text-xs ${
                        active ? "text-primary" : "text-tertiary line-through"
                      }`}
                    >
                      {definition.label}
                    </span>
                    <IconButton
                      icon={active ? "eye" : "eyeOff"}
                      label={active ? `Bypass ${definition.label}` : `Enable ${definition.label}`}
                      size={7}
                      onClick={() => patch(index, { enabled: !active })}
                    />
                    <IconButton
                      icon="chevronUp"
                      label="Move earlier in the chain"
                      size={7}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    />
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

                  {/* Dimmed but still editable while bypassed, so a setting
                      can be dialled in before the effect is switched on. */}
                  <div className={active ? "" : "opacity-50"}>
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
                    {definition.params.length === 0 && (
                      <p className="text-[11px] text-tertiary">Nothing to adjust.</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
        Add an effect
      </h3>
      <ul className="flex flex-col gap-0.5">
        {EFFECTS.map((effect) => (
          <li key={effect.id}>
            <button
              type="button"
              onClick={() => add(effect.id)}
              title={effect.blurb}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5
                         text-left transition-colors hover:bg-hover"
            >
              <Icon name="plus" size={12} className="shrink-0 text-tertiary" />
              <span className="min-w-0 flex-1 truncate text-xs text-primary">{effect.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
