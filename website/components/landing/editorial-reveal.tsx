'use client';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

const statement =
  'Wolf-Cut is built around a simple idea: your footage belongs to you. Edit locally, skip subscriptions and watermarks, and keep the creative process on your machine.';

const words = statement.split(' ');

export function EditorialReveal() {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { threshold: 0.22 },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <p
      ref={ref}
      className="editorial-copy"
      data-visible={visible}
      aria-label={statement}
    >
      {words.map((word, index) => {
        const highlighted = index >= 9 && index <= 11;
        return (
          <span
            aria-hidden="true"
            className={highlighted ? 'editorial-highlight' : undefined}
            key={`${word}-${index}`}
            style={{ '--word-index': index } as CSSProperties}
          >
            {word}{' '}
          </span>
        );
      })}
    </p>
  );
}
