'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { RELEASES_URL, REPOSITORY_URL } from '@/lib/downloads';

const releasesUrl = RELEASES_URL;
const repositoryUrl = REPOSITORY_URL;
const rayPhases = [0, Math.PI / 2, Math.PI, (Math.PI * 3) / 2, Math.PI / 4];

export function SiteFooter() {
  const [entered, setEntered] = useState(false);
  const footerRef = useRef<HTMLElement>(null);
  const rayRefs = useRef<Array<HTMLSpanElement | null>>([]);

  useEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let frameId = 0;

    const stop = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    };
    const animate = (time: number) => {
      if (
        !visible ||
        reducedMotion.matches ||
        document.visibilityState === 'hidden'
      ) {
        frameId = 0;
        return;
      }
      const phase = ((time % 7560) / 7560) * Math.PI * 2;
      rayRefs.current.forEach((ray, index) => {
        if (!ray) return;
        const x = Math.sin(phase + (rayPhases[index] ?? 0)) * 10;
        ray.style.transform = `translateX(${x}px)`;
      });
      frameId = requestAnimationFrame(animate);
    };
    const start = () => {
      if (
        frameId ||
        !visible ||
        reducedMotion.matches ||
        document.visibilityState === 'hidden'
      ) {
        return;
      }
      frameId = requestAnimationFrame(animate);
    };
    const resetRays = () => {
      for (const ray of rayRefs.current) ray?.style.removeProperty('transform');
    };

    const visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        visible = Boolean(entry?.isIntersecting);
        if ((entry?.intersectionRatio ?? 0) >= 0.5) setEntered(true);
        if (visible) start();
        else stop();
      },
      { threshold: [0, 0.5] },
    );
    const onDocumentVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    const onMotionPreference = () => {
      stop();
      if (reducedMotion.matches) resetRays();
      else start();
    };

    visibilityObserver.observe(footer);
    document.addEventListener('visibilitychange', onDocumentVisibility);
    reducedMotion.addEventListener('change', onMotionPreference);

    return () => {
      stop();
      visibilityObserver.disconnect();
      document.removeEventListener('visibilitychange', onDocumentVisibility);
      reducedMotion.removeEventListener('change', onMotionPreference);
    };
  }, []);

  return (
    <footer ref={footerRef} className="site-footer" data-visible={entered}>
      <div className="footer-surface">
        <div className="footer-background" aria-hidden="true" />
        <div className="footer-rays" aria-hidden="true">
          {rayPhases.map((phase, index) => (
            <span
              className="footer-ray-shift"
              key={phase}
              ref={(element) => {
                rayRefs.current[index] = element;
              }}
            >
              <i />
            </span>
          ))}
        </div>
        <div className="footer-content page-width">
          <div className="footer-brand">
            <Image src="/concat-logo-green.png" alt="" width={52} height={52} />
            <h2>Concat</h2>
            <p>Cut locally. Create freely.</p>
          </div>
          <div className="footer-links">
            <div>
              <h3>Product</h3>
              <a href="#features">Features</a>
              <a href="#principles">Principles</a>
              <a href="#download">Download</a>
            </div>
            <div>
              <h3>Project</h3>
              <a href={repositoryUrl} target="_blank" rel="noopener noreferrer">
                GitHub
              </a>
              <a href={releasesUrl}>Releases</a>
              <a href={repositoryUrl} target="_blank" rel="noopener noreferrer">
                Source code
              </a>
            </div>
          </div>
        </div>
        <div className="footer-wordmark" aria-hidden="true">
          CONCAT
        </div>
        <div className="footer-bottom page-width">
          <span>© 2026 Concat</span>
          <span>Free · Open source · Local</span>
        </div>
      </div>
    </footer>
  );
}
