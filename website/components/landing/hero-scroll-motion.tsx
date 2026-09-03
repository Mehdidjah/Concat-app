'use client';

import Image from 'next/image';
import { useEffect, useRef } from 'react';
import { AUTO_DOWNLOAD_URL, REPOSITORY_URL } from '@/lib/downloads';

const repositoryUrl = REPOSITORY_URL;
const headlineLines = ['Your videos.', 'Your rules.'] as const;
const headlineLabel = headlineLines.join(' ');

function Arrow({ direction = 'down' }: { direction?: 'down' | 'out' }) {
  return (
    <span className="button-arrow" aria-hidden="true">
      {direction === 'out' ? '↗' : '↓'}
    </span>
  );
}

export function HeroScrollMotion() {
  const heroRef = useRef<HTMLElement>(null);
  const copyMotionRef = useRef<HTMLDivElement>(null);
  const headlineRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const hero = heroRef.current;
    const copy = copyMotionRef.current;
    const headline = headlineRef.current;
    if (!hero || !copy || !headline) return;

    const desktop = window.matchMedia('(min-width: 810px)');
    const finePointer = window.matchMedia('(pointer: fine)');
    const hover = window.matchMedia('(hover: hover)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const characters = Array.from(
      headline.querySelectorAll<HTMLElement>('.hero-char'),
    );
    let frameId = 0;

    const magnifierEnabled = () =>
      desktop.matches &&
      finePointer.matches &&
      hover.matches &&
      !reducedMotion.matches;
    const resetCharacters = () => {
      for (const character of characters) {
        character.style.webkitTextStrokeWidth = '0.1px';
        if (magnifierEnabled()) {
          character.style.transform = 'scaleX(1.008) scaleY(0.998)';
          character.style.paddingInline = '0.002em';
        } else {
          character.style.removeProperty('transform');
          character.style.removeProperty('padding-inline');
        }
      }
    };

    const calculateScrollMotion = () => {
      frameId = 0;
      if (!desktop.matches || reducedMotion.matches) {
        copy.style.removeProperty('transform');
        copy.style.removeProperty('opacity');
        headline.style.removeProperty('transform');
        return;
      }

      const heroHeight = hero.getBoundingClientRect().height;
      const progress = Math.max(
        0,
        Math.min(1, window.scrollY / Math.max(heroHeight, 1)),
      );
      copy.style.transform = `translate3d(0, ${progress * 360}px, 0)`;
      copy.style.opacity = `${1 - progress}`;
      headline.style.transform = `translate3d(0, ${window.scrollY * -0.05}px, 0)`;
    };
    const scheduleScrollMotion = () => {
      if (!frameId) frameId = requestAnimationFrame(calculateScrollMotion);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!magnifierEnabled()) {
        resetCharacters();
        return;
      }

      const headlineBounds = headline.getBoundingClientRect();
      if (
        event.clientX < headlineBounds.left - 110 ||
        event.clientX > headlineBounds.right + 110 ||
        event.clientY < headlineBounds.top - 110 ||
        event.clientY > headlineBounds.bottom + 110
      ) {
        resetCharacters();
        return;
      }

      const centers = characters.map((character) => {
        const bounds = character.getBoundingClientRect();
        return {
          x: bounds.left + bounds.width / 2,
          y: bounds.top + bounds.height / 2,
        };
      });
      characters.forEach((character, index) => {
        const center = centers[index];
        if (!center) return;
        const distance = Math.hypot(
          event.clientX - center.x,
          event.clientY - center.y,
        );
        const strength =
          distance <= 20 ? 1 : Math.max(0, 1 - (distance - 20) / 90);
        const stroke = 0.1 + strength * 1.1;
        character.style.webkitTextStrokeWidth = `${stroke}px`;
        character.style.transform = `scaleX(${1 + stroke * 0.08}) scaleY(${1 - stroke * 0.02})`;
        character.style.paddingInline = `${stroke * 0.02}em`;
      });
    };

    const onCapabilityChange = () => {
      resetCharacters();
      scheduleScrollMotion();
    };

    resetCharacters();
    scheduleScrollMotion();
    window.addEventListener('scroll', scheduleScrollMotion, { passive: true });
    window.addEventListener('resize', scheduleScrollMotion);
    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', resetCharacters);
    desktop.addEventListener('change', onCapabilityChange);
    finePointer.addEventListener('change', onCapabilityChange);
    hover.addEventListener('change', onCapabilityChange);
    reducedMotion.addEventListener('change', onCapabilityChange);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', scheduleScrollMotion);
      window.removeEventListener('resize', scheduleScrollMotion);
      hero.removeEventListener('pointermove', onPointerMove);
      hero.removeEventListener('pointerleave', resetCharacters);
      desktop.removeEventListener('change', onCapabilityChange);
      finePointer.removeEventListener('change', onCapabilityChange);
      hover.removeEventListener('change', onCapabilityChange);
      reducedMotion.removeEventListener('change', onCapabilityChange);
    };
  }, []);

  return (
    <section ref={heroRef} className="hero" aria-labelledby="hero-title">
      <div className="hero-atmosphere" aria-hidden="true" />
      <div className="hero-copy-entrance page-width">
        <div ref={copyMotionRef} className="hero-copy-motion">
          <p className="eyebrow">Free · Open source · Local</p>
          <div className="hero-headline-slot">
            <h1
              ref={headlineRef}
              id="hero-title"
              className="hero-title"
              aria-label={headlineLabel}
            >
              {headlineLines.map((line, lineIndex) => (
                <span
                  className="hero-title-line"
                  data-accent={lineIndex === 1}
                  aria-hidden="true"
                  key={line}
                >
                  {Array.from(line).map((character, characterIndex) => (
                    <span
                      className="hero-char"
                      key={`${character}-${characterIndex}`}
                    >
                      {character === ' ' ? '\u00a0' : character}
                    </span>
                  ))}
                </span>
              ))}
            </h1>
          </div>
          <p className="hero-description">
            A fast, private video editor without watermarks, subscriptions, or
            cloud uploads. Install Concat and start creating.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href={AUTO_DOWNLOAD_URL}>
              <span>Download Concat</span>
              <Arrow />
            </a>
            <a
              className="button button-secondary"
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span>View source</span>
              <Arrow direction="out" />
            </a>
          </div>
          <p className="platform-note">
            Downloads for macOS, Windows, and Linux
          </p>
        </div>
      </div>

      <div className="hero-media-entrance page-width">
        <div className="product-shell" data-hero-media>
          <div className="product-window">
            <div className="window-bar" aria-hidden="true">
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-dot" />
              <span className="window-title">Concat · Untitled project</span>
            </div>
            <Image
              src="/editor-preview.webp"
              alt="Concat desktop editor with media browser, preview, inspector, and multi-track timeline"
              width={1920}
              height={1175}
              priority
              sizes="(max-width: 810px) 96vw, 960px"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
