'use client';

import Image from 'next/image';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef } from 'react';

type StickerKind =
  | 'wolf'
  | 'scissors'
  | 'playhead'
  | 'film'
  | 'waveform'
  | 'timeline'
  | 'local'
  | 'zero'
  | 'open'
  | 'platforms'
  | 'cut';

type StickerDefinition = {
  kind: StickerKind;
  left: number;
  top: number;
  tone: 'lime' | 'dark' | 'light' | 'blue';
};

type PhysicsState = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  dragging: boolean;
  pointerId: number | null;
  lastX: number;
  lastY: number;
  lastTime: number;
};

const stickers: StickerDefinition[] = [
  { kind: 'wolf', left: 4, top: 10, tone: 'light' },
  { kind: 'scissors', left: 19, top: 86, tone: 'lime' },
  { kind: 'playhead', left: 34, top: 10, tone: 'dark' },
  { kind: 'film', left: 82, top: 8, tone: 'light' },
  { kind: 'waveform', left: 69, top: 86, tone: 'blue' },
  { kind: 'timeline', left: 4, top: 82, tone: 'dark' },
  { kind: 'local', left: 86, top: 88, tone: 'lime' },
  { kind: 'zero', left: 48, top: 84, tone: 'light' },
  { kind: 'open', left: 66, top: 12, tone: 'lime' },
  { kind: 'platforms', left: 18, top: 14, tone: 'blue' },
  { kind: 'cut', left: 80, top: 84, tone: 'dark' },
];

const GRAVITY = 1880;
const BOUNCE = 0.78;
const FRICTION = 1;
const THROW_POWER = 1.2;
const MAX_VELOCITY = 2200;
const SUBSTEPS = 3;
const COLLISION_PASSES = 2;

function clampVelocity(value: number) {
  return Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, value));
}

function stickerSize(width: number) {
  if (width < 810) return 62;
  if (width < 1180) return 78;
  return 122;
}

type CollisionBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function keepOutsideCopy(
  state: PhysicsState,
  size: number,
  wall: DOMRect,
  copy: DOMRect | null,
) {
  if (!copy) return;

  const gap = wall.width < 810 ? 12 : 24;
  const exclusion: CollisionBounds = {
    left: copy.left - wall.left - gap,
    top: copy.top - wall.top - gap,
    right: copy.right - wall.left + gap,
    bottom: copy.bottom - wall.top + gap,
  };

  const intersects =
    state.x + size > exclusion.left &&
    state.x < exclusion.right &&
    state.y + size > exclusion.top &&
    state.y < exclusion.bottom;
  if (!intersects) return;

  const maxX = Math.max(0, wall.width - size);
  const maxY = Math.max(0, wall.height - size);
  const candidates = [
    { axis: 'x' as const, value: exclusion.left - size },
    { axis: 'x' as const, value: exclusion.right },
    { axis: 'y' as const, value: exclusion.top - size },
    { axis: 'y' as const, value: exclusion.bottom },
  ].filter(({ axis, value }) =>
    axis === 'x' ? value >= 0 && value <= maxX : value >= 0 && value <= maxY,
  );

  const closest = candidates.sort((a, b) => {
    const aPosition = a.axis === 'x' ? state.x : state.y;
    const bPosition = b.axis === 'x' ? state.x : state.y;
    return Math.abs(a.value - aPosition) - Math.abs(b.value - bPosition);
  })[0];
  if (!closest) return;

  if (closest.axis === 'x') {
    state.x = closest.value;
    state.vx =
      closest.value < exclusion.left ? -Math.abs(state.vx) : Math.abs(state.vx);
  } else {
    state.y = closest.value;
    state.vy =
      closest.value < exclusion.top ? -Math.abs(state.vy) : Math.abs(state.vy);
  }
}

function StickerGraphic({ kind }: { kind: StickerKind }) {
  if (kind === 'wolf') {
    return (
      <Image
        src="/wolfcut-logo.png"
        alt=""
        width={82}
        height={82}
        draggable={false}
      />
    );
  }

  if (kind === 'zero' || kind === 'open' || kind === 'cut') {
    return <strong>{kind === 'zero' ? '$0' : kind.toUpperCase()}</strong>;
  }

  if (kind === 'platforms') {
    return (
      <span className="platform-sticker-copy">
        <b>MAC</b>
        <b>WIN</b>
        <b>LINUX</b>
      </span>
    );
  }

  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    strokeWidth: 2,
  };

  if (kind === 'scissors') {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="15" cy="17" r="8" {...common} />
        <circle cx="15" cy="47" r="8" {...common} />
        <path d="m21 22 29 25M21 42 50 17M31 32l19 15" {...common} />
      </svg>
    );
  }

  if (kind === 'playhead') {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M11 13h42v38H11z" {...common} />
        <path d="m27 23 15 9-15 9zM19 13v38M45 13v38" {...common} />
      </svg>
    );
  }

  if (kind === 'film') {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <rect x="8" y="13" width="48" height="38" rx="3" {...common} />
        <path
          d="M8 23h48M8 41h48M18 13v10M31 13v10M45 13v10M18 41v10M31 41v10M45 41v10"
          {...common}
        />
      </svg>
    );
  }

  if (kind === 'waveform') {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M7 32h6l4-13 7 27 7-36 7 44 7-29 4 7h8" {...common} />
      </svg>
    );
  }

  if (kind === 'timeline') {
    return (
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M8 16h48M8 32h48M8 48h48M27 9v46" {...common} />
        <rect x="11" y="20" width="21" height="8" rx="2" {...common} />
        <rect x="36" y="36" width="17" height="8" rx="2" {...common} />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <path d="M12 15h17l6 7h17v29H12z" {...common} />
      <path d="M24 39h16M32 31v16" {...common} />
    </svg>
  );
}

export function StickerWall() {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickerRefs = useRef<Array<HTMLDivElement | null>>([]);
  const statesRef = useRef<PhysicsState[]>([]);
  const sizeRef = useRef(122);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frameId = 0;
    let previousTime = performance.now();
    let visible = false;

    const sync = (index: number) => {
      const element = stickerRefs.current[index];
      const state = statesRef.current[index];
      if (!element || !state) return;
      element.style.left = '0px';
      element.style.top = '0px';
      element.style.transform = `translate3d(${state.x}px, ${state.y}px, 0)`;
    };

    const layout = () => {
      const bounds = container.getBoundingClientRect();
      const size = stickerSize(bounds.width);
      sizeRef.current = size;

      if (reducedMotion.matches) {
        statesRef.current = [];
        stickerRefs.current.forEach((element) => {
          element?.style.removeProperty('left');
          element?.style.removeProperty('top');
          element?.style.removeProperty('transform');
        });
        container.dataset.physicsReady = 'true';
        return;
      }

      if (statesRef.current.length !== stickers.length) {
        statesRef.current = stickers.map((sticker, index) => ({
          x: ((bounds.width - size) * sticker.left) / 100,
          y: ((bounds.height - size) * sticker.top) / 100,
          vx: ((index % 3) - 1) * 18,
          vy: -20 - (index % 4) * 8,
          dragging: false,
          pointerId: null,
          lastX: 0,
          lastY: 0,
          lastTime: 0,
        }));
      } else {
        for (const state of statesRef.current) {
          state.x = Math.min(
            Math.max(0, state.x),
            Math.max(0, bounds.width - size),
          );
          state.y = Math.min(
            Math.max(0, state.y),
            Math.max(0, bounds.height - size),
          );
        }
      }

      const copyBounds = container.parentElement
        ?.querySelector<HTMLElement>('.download-copy')
        ?.getBoundingClientRect();
      for (const state of statesRef.current) {
        keepOutsideCopy(state, size, bounds, copyBounds ?? null);
      }

      stickers.forEach((_, index) => sync(index));
      container.dataset.physicsReady = 'true';
    };

    const resolveCollisions = (size: number) => {
      const collisionSize = size * 0.86;
      for (let first = 0; first < statesRef.current.length; first += 1) {
        for (
          let second = first + 1;
          second < statesRef.current.length;
          second += 1
        ) {
          const a = statesRef.current[first];
          const b = statesRef.current[second];
          if (!a || !b) continue;

          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.hypot(dx, dy) || 0.001;
          if (distance >= collisionSize) continue;

          const nx = dx / distance;
          const ny = dy / distance;
          const overlap = (collisionSize - distance) / 2;
          if (!a.dragging) {
            a.x -= nx * overlap;
            a.y -= ny * overlap;
          }
          if (!b.dragging) {
            b.x += nx * overlap;
            b.y += ny * overlap;
          }

          const relativeVelocity = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (relativeVelocity >= 0) continue;
          const impulse = (-(1 + BOUNCE) * relativeVelocity) / 2;
          if (!a.dragging) {
            a.vx = clampVelocity(a.vx - impulse * nx);
            a.vy = clampVelocity(a.vy - impulse * ny);
          }
          if (!b.dragging) {
            b.vx = clampVelocity(b.vx + impulse * nx);
            b.vy = clampVelocity(b.vy + impulse * ny);
          }
        }
      }
    };

    const canAnimate = () =>
      visible &&
      !reducedMotion.matches &&
      document.visibilityState !== 'hidden';

    const stop = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    };

    const animate = (time: number) => {
      if (!canAnimate()) {
        frameId = 0;
        return;
      }
      const bounds = container.getBoundingClientRect();
      const copyBounds = container.parentElement
        ?.querySelector<HTMLElement>('.download-copy')
        ?.getBoundingClientRect();
      const size = sizeRef.current;
      const delta = Math.min((time - previousTime) / 1000, 0.032);
      previousTime = time;

      const step = delta / SUBSTEPS;
      for (let substep = 0; substep < SUBSTEPS; substep += 1) {
        for (const state of statesRef.current) {
          if (state.dragging) continue;
          state.vy = clampVelocity(state.vy + GRAVITY * step);
          state.vx = clampVelocity(state.vx * Math.pow(FRICTION, step));
          state.x += state.vx * step;
          state.y += state.vy * step;

          if (state.x < 0) {
            state.x = 0;
            state.vx = Math.abs(state.vx) * BOUNCE;
          } else if (state.x > bounds.width - size) {
            state.x = bounds.width - size;
            state.vx = -Math.abs(state.vx) * BOUNCE;
          }
          if (state.y < 0) {
            state.y = 0;
            state.vy = Math.abs(state.vy) * BOUNCE;
          } else if (state.y > bounds.height - size) {
            state.y = bounds.height - size;
            state.vy = -Math.abs(state.vy) * BOUNCE;
            if (Math.abs(state.vy) < 18) state.vy = 0;
          }
        }

        for (let pass = 0; pass < COLLISION_PASSES; pass += 1) {
          resolveCollisions(size);
        }
        for (const state of statesRef.current) {
          if (!state.dragging) {
            keepOutsideCopy(state, size, bounds, copyBounds ?? null);
          }
          state.x = Math.max(0, Math.min(bounds.width - size, state.x));
          state.y = Math.max(0, Math.min(bounds.height - size, state.y));
        }
      }

      stickers.forEach((_, index) => sync(index));
      frameId = requestAnimationFrame(animate);
    };

    const start = () => {
      if (frameId || !canAnimate()) return;
      previousTime = performance.now();
      frameId = requestAnimationFrame(animate);
    };
    const resizeObserver = new ResizeObserver(layout);
    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        visible =
          Boolean(entry?.isIntersecting) &&
          (entry?.intersectionRatio ?? 0) >= 0.1;
        if (visible) start();
        else stop();
      },
      { threshold: [0, 0.1] },
    );
    const onDocumentVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    const onMotionPreference = () => {
      stop();
      layout();
      start();
    };

    resizeObserver.observe(container);
    visibilityObserver.observe(container);
    document.addEventListener('visibilitychange', onDocumentVisibility);
    reducedMotion.addEventListener('change', onMotionPreference);
    layout();

    return () => {
      stop();
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
      document.removeEventListener('visibilitychange', onDocumentVisibility);
      reducedMotion.removeEventListener('change', onMotionPreference);
    };
  }, []);

  const moveSticker = (index: number, clientX: number, clientY: number) => {
    const container = containerRef.current;
    const state = statesRef.current[index];
    const element = stickerRefs.current[index];
    if (!container || !state || !element) return;

    const bounds = container.getBoundingClientRect();
    const size = sizeRef.current;
    state.x = Math.min(
      Math.max(0, clientX - bounds.left - size / 2),
      Math.max(0, bounds.width - size),
    );
    state.y = Math.min(
      Math.max(0, clientY - bounds.top - size / 2),
      Math.max(0, bounds.height - size),
    );
    const copyBounds = container.parentElement
      ?.querySelector<HTMLElement>('.download-copy')
      ?.getBoundingClientRect();
    keepOutsideCopy(state, size, bounds, copyBounds ?? null);
    element.style.transform = `translate3d(${state.x}px, ${state.y}px, 0)`;
  };

  const onPointerDown = (
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const state = statesRef.current[index];
    if (!state) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    state.dragging = true;
    state.pointerId = event.pointerId;
    state.vx = 0;
    state.vy = 0;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
    moveSticker(index, event.clientX, event.clientY);
  };

  const onPointerMove = (
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const state = statesRef.current[index];
    if (!state?.dragging || state.pointerId !== event.pointerId) return;

    const now = event.timeStamp;
    const delta = Math.max((now - state.lastTime) / 1000, 0.008);
    state.vx = (event.clientX - state.lastX) / delta;
    state.vy = (event.clientY - state.lastY) / delta;
    state.lastX = event.clientX;
    state.lastY = event.clientY;
    state.lastTime = now;
    moveSticker(index, event.clientX, event.clientY);
  };

  const onPointerUp = (
    index: number,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    const state = statesRef.current[index];
    if (!state || state.pointerId !== event.pointerId) return;
    state.dragging = false;
    state.pointerId = null;
    state.vx = clampVelocity(state.vx * THROW_POWER);
    state.vy = clampVelocity(state.vy * THROW_POWER);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <div className="sticker-wall" ref={containerRef} aria-hidden="true">
      {stickers.map((sticker, index) => (
        <div
          className="sticker"
          data-tone={sticker.tone}
          key={sticker.kind}
          ref={(element) => {
            stickerRefs.current[index] = element;
          }}
          style={{ left: `${sticker.left}%`, top: `${sticker.top}%` }}
          onPointerDown={(event) => onPointerDown(index, event)}
          onPointerMove={(event) => onPointerMove(index, event)}
          onPointerUp={(event) => onPointerUp(index, event)}
          onPointerCancel={(event) => onPointerUp(index, event)}
        >
          <StickerGraphic kind={sticker.kind} />
        </div>
      ))}
    </div>
  );
}
