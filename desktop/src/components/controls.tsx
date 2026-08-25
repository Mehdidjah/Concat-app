import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * Property controls for the inspector.
 *
 * Pure: value in, callback out. None of them hold state, because the value
 * they show has to be whatever the project says it is - including when it
 * changes from somewhere else, like a drag on the timeline.
 */

/**
 * A slider whose whole track is the grab target.
 *
 * Clicking anywhere on it jumps there and starts dragging, the way parameter
 * sliders work in editors rather than the way a browser range input does. The
 * fill doubles as the readout, so there is no separate progress element to
 * keep in step.
 */
export function Slider({
  label,
  value,
  min,
  max,
  step = 0.01,
  format,
  onChange,
  onReset,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Turns the raw value into what the reader sees. */
  format: (value: number) => string;
  onChange: (value: number) => void;
  /** Double-clicking the label returns the control to this value. */
  onReset?: () => void;
}) {
  const track = useRef<HTMLDivElement>(null);

  const commit = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = track.current?.getBoundingClientRect();
    if (!bounds || bounds.width === 0) return;

    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    const stepped = Math.round((min + fraction * (max - min)) / step) * step;
    // Re-round, or steps accumulate float noise like 0.30000000000000004.
    onChange(Number(stepped.toFixed(6)));
  };

  const fill = max === min ? 0 : Math.min(1, Math.max(0, (value - min) / (max - min)));

  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span
          onDoubleClick={onReset}
          title={onReset ? "Double-click to reset" : undefined}
          className={`text-[12px] text-secondary ${onReset ? "cursor-pointer" : ""}`}
        >
          {label}
        </span>
        <span className="font-technical text-[11px] text-primary">{format(value)}</span>
      </div>

      <div
        ref={track}
        role="slider"
        aria-label={label}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") onChange(Math.max(min, value - step));
          if (event.key === "ArrowRight") onChange(Math.min(max, value + step));
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          commit(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) commit(event);
        }}
        className="relative h-6 cursor-ew-resize touch-none select-none overflow-hidden
                   rounded-md bg-sunken"
      >
        <div
          className="absolute inset-y-0 left-0 bg-accent-soft"
          style={{ width: `${fill * 100}%` }}
        />
        {/* The knob subtracts its own width as it travels, so it stays inside
            the track at both ends instead of hanging over the edge. */}
        <div
          className="absolute top-0 h-full w-1 rounded bg-accent"
          style={{ left: `calc(${fill * 100}% - ${fill * 4}px)` }}
        />
      </div>
    </div>
  );
}

/** A labelled group of controls. */
export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-tertiary">
        {title}
      </h3>
      {children}
    </section>
  );
}
