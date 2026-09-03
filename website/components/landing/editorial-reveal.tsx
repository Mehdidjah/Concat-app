'use client';

import { useEffect, useRef, useState } from 'react';

const statement =
  'Concat is built around a simple idea: your footage belongs to you. Edit locally, skip subscriptions and watermarks, and keep the creative process on your machine.';

const words = statement.split(' ');

export function EditorialReveal() {
  const [activeWordCount, setActiveWordCount] = useState(0);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frameId = 0;
    const calculate = () => {
      frameId = 0;
      const rect = element.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const inActiveViewport =
        rect.bottom > viewportHeight * 0.2 && rect.top < viewportHeight * 0.8;
      const progress = inActiveViewport
        ? Math.max(0, Math.min(1, (viewportHeight - rect.top) / viewportHeight))
        : 0;
      setActiveWordCount(Math.floor(progress * words.length));
    };
    const schedule = () => {
      if (!frameId) frameId = requestAnimationFrame(calculate);
    };

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(element);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    document.fonts?.ready.then(schedule).catch(() => undefined);
    schedule();

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return (
    <p ref={ref} className="editorial-copy" aria-label={statement}>
      {words.map((word, index) => {
        const highlighted = index >= 9 && index <= 11;
        const active = index < activeWordCount;
        return (
          <span
            aria-hidden="true"
            className={
              [
                highlighted ? 'editorial-highlight' : '',
                active ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ') || undefined
            }
            key={`${word}-${index}`}
          >
            {word}{' '}
          </span>
        );
      })}
    </p>
  );
}
