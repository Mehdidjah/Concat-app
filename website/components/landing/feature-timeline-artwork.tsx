'use client';

import { useEffect, useRef, useState } from 'react';

export function FeatureTimelineArtwork() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(Boolean(entry?.isIntersecting)),
      { threshold: 0.1 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="timeline-art"
      data-mobile-active={visible}
      aria-hidden="true"
    >
      <div className="timeline-ruler">
        <span>00:00</span>
        <span>00:08</span>
        <span>00:16</span>
      </div>
      <div className="timeline-track">
        <span className="clip clip-a" />
        <span className="clip clip-b" />
        <span className="clip clip-c" />
      </div>
      <div className="timeline-track timeline-track-audio">
        <span className="clip clip-wave">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>
      <span className="timeline-playhead" />
    </div>
  );
}
