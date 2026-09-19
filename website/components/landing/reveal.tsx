'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

type RevealProps = {
  children: ReactNode;
  className?: string;
  delay?: number;
  threshold?: number;
  variant?: 'rise' | 'scale';
};

export function Reveal({
  children,
  className = '',
  delay,
  threshold = 0.14,
  variant = 'rise',
}: RevealProps) {
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setVisible(true);
        observer.disconnect();
      },
      { threshold },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);

  return (
    <div
      ref={ref}
      className={`reveal ${className}`.trim()}
      data-variant={variant}
      data-visible={visible}
      style={
        {
          '--reveal-delay': `${delay ?? (variant === 'rise' ? 100 : 0)}ms`,
        } as CSSProperties
      }
    >
      {children}
    </div>
  );
}
