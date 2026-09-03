'use client';

import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

type AnimatedSectionHeadingProps = {
  title: string;
  copy: string;
};

type MotionProperties = CSSProperties & {
  '--heading-word-delay'?: string;
  '--heading-line-delay'?: string;
};

export function AnimatedSectionHeading({
  title,
  copy,
}: AnimatedSectionHeadingProps) {
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const copyRef = useRef<HTMLParagraphElement>(null);
  const titleWords = title.split(' ');
  const copyWords = copy.split(' ');

  useEffect(() => {
    const root = rootRef.current;
    const paragraph = copyRef.current;
    if (!root || !paragraph) return;

    let measureFrame = 0;
    const measureLines = () => {
      measureFrame = 0;
      const tokens = Array.from(
        paragraph.querySelectorAll<HTMLElement>('[data-copy-word]'),
      );
      const tops = tokens.map((token) => token.offsetTop);
      const lines: number[] = [];
      const lineIndexes = tops.map((top) => {
        const existing = lines.findIndex(
          (lineTop) => Math.abs(lineTop - top) < 2,
        );
        if (existing >= 0) return existing;
        lines.push(top);
        return lines.length - 1;
      });
      tokens.forEach((token, index) => {
        const lineIndex = lineIndexes[index] ?? 0;
        token.style.setProperty(
          '--heading-line-delay',
          `${600 + lineIndex * 150}ms`,
        );
      });
    };
    const scheduleMeasure = () => {
      if (!measureFrame) measureFrame = requestAnimationFrame(measureLines);
    };

    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(paragraph);
    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        visibilityObserver.disconnect();
      },
      { threshold: 0.5 },
    );
    visibilityObserver.observe(root);
    document.fonts?.ready.then(scheduleMeasure).catch(() => undefined);
    scheduleMeasure();

    return () => {
      if (measureFrame) cancelAnimationFrame(measureFrame);
      resizeObserver.disconnect();
      visibilityObserver.disconnect();
    };
  }, []);

  return (
    <header
      ref={rootRef}
      className="section-heading animated-section-heading"
      data-visible={visible}
    >
      <h2 aria-label={title}>
        {titleWords.map((word, index) => (
          <span
            aria-hidden="true"
            className="heading-word"
            key={`${word}-${index}`}
            style={
              {
                '--heading-word-delay': `${100 + index * 200}ms`,
              } as MotionProperties
            }
          >
            {word}
            {index < titleWords.length - 1 ? '\u00a0' : ''}
          </span>
        ))}
      </h2>
      <p ref={copyRef} className="animated-heading-copy" aria-label={copy}>
        {copyWords.map((word, index) => (
          <span
            aria-hidden="true"
            data-copy-word
            key={`${word}-${index}`}
            style={{ '--heading-line-delay': '600ms' } as MotionProperties}
          >
            {word}
            {index < copyWords.length - 1 ? '\u00a0' : ''}
          </span>
        ))}
      </p>
    </header>
  );
}
