import type { Clip, CustomFont } from "../lib/editor";
import { FONTS, WEIGHTS, type TextStyle } from "../lib/text";
import { Group, Slider, Toggle } from "./controls";
import { Icon } from "./Icon";
import { Empty } from "./Panel";

/**
 * The Text tab: everything about how a title looks.
 *
 * Sizes are fractions of the frame rather than points, so a title composed
 * against a 1080p project lands in the same place when the same project is
 * exported at 4K. The panel converts for display - nobody thinks in "0.09 of
 * the frame height" - but the stored value stays relative.
 *
 * The preview overlay and the export rasteriser both read these numbers
 * through `textCss`, so what is on screen is what gets burned in.
 */
export function TextPanel({
  clip,
  fonts,
  onChange,
  onCommit,
  onAddFont,
  onRemoveFont,
}: {
  clip: Clip | null;
  /** The project's custom fonts, with the UI's missing-file marks applied. */
  fonts: CustomFont[];
  /** Live change - echoed locally while the gesture is in flight. */
  onChange: (patch: Partial<Clip>) => void;
  /** Gesture finished - the accumulated change becomes one engine command. */
  onCommit: () => void;
  onAddFont: () => void;
  onRemoveFont: (family: string) => void;
}) {
  if (!clip || clip.kind !== "text" || !clip.text) {
    return (
      <Empty icon={<Icon name="type" size={26} strokeWidth={1.5} />}>
        Select a text clip to style it.
      </Empty>
    );
  }

  const style = clip.text;

  // Every edit rewrites the whole style, and the clip's name follows the first
  // line so the timeline label tracks the words without a second control.
  const set = (patch: Partial<TextStyle>) => {
    const next = { ...style, ...patch };
    onChange(
      patch.content === undefined
        ? { text: next }
        : { text: next, name: firstLineOf(patch.content) },
    );
  };

  // Discrete controls commit immediately; sliders and the textarea echo
  // live and commit on release or blur.
  const commitSet = (patch: Partial<TextStyle>) => {
    set(patch);
    onCommit();
  };

  const custom: CustomFont[] = fonts;

  return (
    <div className="px-3 py-3">
      <Group title="Content">
        <textarea
          value={style.content}
          onChange={(event) => set({ content: event.target.value })}
          onBlur={onCommit}
          rows={3}
          spellCheck={false}
          placeholder="Your text"
          className="mb-3 w-full resize-y rounded-lg border border-hairline-strong bg-sunken px-2.5
                     py-2 text-[13px] leading-snug text-primary outline-none
                     placeholder:text-tertiary focus:border-accent"
        />
      </Group>

      <Group title="Font">
        <select
          value={style.fontFamily}
          onChange={(event) => commitSet({ fontFamily: event.target.value })}
          className="mb-2 w-full cursor-pointer rounded-lg border border-hairline-strong bg-sunken
                     px-2.5 py-2 text-[12px] text-primary outline-none focus:border-accent"
        >
          <optgroup label="Bundled">
            {FONTS.filter((font) => font.bundled).map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </optgroup>
          {custom.length > 0 && (
            <optgroup label="Yours">
              {custom.map((font) => (
                <option key={font.family} value={`"${font.family}"`}>
                  {font.family}
                  {font.missing ? " (file missing)" : ""}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="System">
            {FONTS.filter((font) => !font.bundled).map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </optgroup>
        </select>

        <button
          type="button"
          onClick={onAddFont}
          className="mb-3 flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg
                     border border-dashed border-hairline-strong px-3 py-2 text-[11px]
                     text-secondary transition-colors hover:border-accent hover:bg-hover
                     hover:text-primary"
        >
          <Icon name="import" size={12} />
          Add font file
        </button>

        {custom.length > 0 && (
          <ul className="mb-3 space-y-1">
            {custom.map((font) => (
              <li
                key={font.family}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] hover:bg-hover"
              >
                <span
                  className="min-w-0 flex-1 truncate text-secondary"
                  style={{ fontFamily: `"${font.family}"` }}
                  title={font.path}
                >
                  {font.family}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${font.family}`}
                  onClick={() => onRemoveFont(font.family)}
                  className="shrink-0 cursor-pointer text-tertiary hover:text-danger"
                >
                  <Icon name="close" size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <select
          value={style.fontWeight}
          onChange={(event) => commitSet({ fontWeight: Number(event.target.value) })}
          className="mb-3 w-full cursor-pointer rounded-lg border border-hairline-strong bg-sunken
                     px-2.5 py-2 text-[12px] text-primary outline-none focus:border-accent"
        >
          {WEIGHTS.map((weight) => (
            <option key={weight.value} value={weight.value}>
              {weight.label}
            </option>
          ))}
        </select>

        <Slider
          label="Size"
          value={style.fontSize}
          min={0.02}
          max={0.4}
          step={0.005}
          // Shown as a share of frame height, which is the thing it actually
          // is. Points would be a lie: the frame can be any resolution.
          format={(value) => `${(value * 100).toFixed(1)}% of height`}
          onChange={(fontSize) => set({ fontSize })}
          onCommit={onCommit}
          onReset={() => commitSet({ fontSize: 0.09 })}
        />

        <Toggle label="Italic" checked={style.italic} onChange={(italic) => commitSet({ italic })} />
      </Group>

      <Group title="Colour">
        <Swatch label="Fill" value={style.color} onChange={(color) => commitSet({ color })} />

        <Slider
          label="Opacity"
          value={style.opacity}
          min={0}
          max={1}
          format={(value) => `${Math.round(value * 100)}%`}
          onChange={(opacity) => set({ opacity })}
          onCommit={onCommit}
          onReset={() => commitSet({ opacity: 1 })}
        />

        <Toggle
          label="Drop shadow"
          hint="Keeps text readable over bright footage."
          checked={style.shadow}
          onChange={(shadow) => commitSet({ shadow })}
        />

        <Toggle
          label="Plate behind text"
          hint="A solid block, for when a shadow is not enough."
          checked={style.background !== ""}
          onChange={(on) => commitSet({ background: on ? "#000000" : "" })}
        />
        {style.background !== "" && (
          <Swatch
            label="Plate colour"
            value={style.background}
            onChange={(background) => commitSet({ background })}
          />
        )}
      </Group>

      <Group title="Outline">
        <Slider
          label="Width"
          value={style.strokeWidth}
          min={0}
          max={0.15}
          step={0.005}
          format={(value) => (value === 0 ? "none" : `${(value * 100).toFixed(1)}%`)}
          onChange={(strokeWidth) => set({ strokeWidth })}
          onCommit={onCommit}
          onReset={() => commitSet({ strokeWidth: 0 })}
        />
        {style.strokeWidth > 0 && (
          <Swatch
            label="Outline colour"
            value={style.strokeColor}
            onChange={(strokeColor) => commitSet({ strokeColor })}
          />
        )}
      </Group>

      <Group title="Layout">
        <div className="mb-3 flex rounded-lg bg-sunken p-0.5">
          {(["left", "center", "right"] as const).map((align) => (
            <button
              key={align}
              type="button"
              aria-pressed={style.align === align}
              onClick={() => commitSet({ align })}
              className={`flex-1 cursor-pointer rounded-[6px] px-2 py-1 text-[11px] capitalize
                          transition-colors ${
                            style.align === align
                              ? "bg-panel text-primary shadow-[0_1px_2px_rgba(0,0,0,0.14)]"
                              : "text-secondary hover:text-primary"
                          }`}
            >
              {align}
            </button>
          ))}
        </div>

        <Slider
          label="Line height"
          value={style.lineHeight}
          min={0.8}
          max={2.5}
          step={0.05}
          format={(value) => value.toFixed(2)}
          onChange={(lineHeight) => set({ lineHeight })}
          onCommit={onCommit}
          onReset={() => commitSet({ lineHeight: 1.2 })}
        />

        <Slider
          label="Tracking"
          value={style.tracking}
          min={-0.1}
          max={0.4}
          step={0.005}
          format={(value) => `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}%`}
          onChange={(tracking) => set({ tracking })}
          onCommit={onCommit}
          onReset={() => commitSet({ tracking: 0 })}
        />
      </Group>

      <Group title="Position">
        {/*
          Offsets are fractions of the frame, and centred is zero - so the
          reset on each is "put it back in the middle", and a title composed
          here sits in the same place at any export resolution.
        */}
        <Slider
          label="Horizontal"
          value={clip.offsetX}
          min={-0.5}
          max={0.5}
          step={0.005}
          format={(value) =>
            Math.abs(value) < 0.0025 ? "centred" : `${(value * 100).toFixed(1)}%`
          }
          onChange={(offsetX) => onChange({ offsetX })}
          onCommit={onCommit}
          onReset={() => { onChange({ offsetX: 0 }); onCommit(); }}
        />
        <Slider
          label="Vertical"
          value={clip.offsetY}
          min={-0.5}
          max={0.5}
          step={0.005}
          format={(value) =>
            Math.abs(value) < 0.0025 ? "centred" : `${(value * 100).toFixed(1)}%`
          }
          onChange={(offsetY) => onChange({ offsetY })}
          onCommit={onCommit}
          onReset={() => { onChange({ offsetY: 0 }); onCommit(); }}
        />
      </Group>
    </div>
  );
}

/** A colour well plus its hex, because one of the two is always the faster way. */
function Swatch({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <span className="text-[12px] text-primary">{label}</span>
      <span className="flex items-center gap-2">
        <input
          type="text"
          value={value}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            // Only commit a complete colour: repainting on "#f" would flash
            // the title black on the way to "#ff0000".
            if (/^#[0-9a-f]{6}$/i.test(next) || /^#[0-9a-f]{3}$/i.test(next)) onChange(next);
          }}
          className="w-[76px] rounded-md border border-hairline-strong bg-sunken px-1.5 py-1
                     text-right font-technical text-[11px] text-secondary outline-none
                     focus:border-accent"
        />
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={label}
          className="h-[26px] w-[34px] cursor-pointer rounded-md border border-hairline-strong
                     bg-transparent p-0.5"
        />
      </span>
    </div>
  );
}

function firstLineOf(content: string): string {
  const line = content.split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "Text").trim().slice(0, 40) || "Text";
}
