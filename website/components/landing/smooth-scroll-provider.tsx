'use client';

import Lenis from 'lenis';
import type { ReactNode } from 'react';
import { useEffect } from 'react';

type SmoothScrollProviderProps = {
  children: ReactNode;
};

function isPlainPrimaryClick(event: MouseEvent) {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function SmoothScrollProvider({ children }: SmoothScrollProviderProps) {
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let lenis: Lenis | null = null;
    let rafId = 0;
    let historyFrame = 0;

    const stopLenis = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      lenis?.destroy();
      lenis = null;
    };

    const startLenis = () => {
      stopLenis();
      if (reducedMotion.matches) return;

      lenis = new Lenis({
        duration: 1,
        easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        orientation: 'vertical',
        gestureOrientation: 'vertical',
        smoothWheel: true,
        wheelMultiplier: 1,
        touchMultiplier: 1,
        syncTouch: false,
      });

      const raf = (time: number) => {
        lenis?.raf(time);
        rafId = requestAnimationFrame(raf);
      };
      rafId = requestAnimationFrame(raf);
    };

    const destinationFor = (hash: string) => {
      if (!hash || hash === '#') return document.documentElement;
      try {
        return document.getElementById(decodeURIComponent(hash.slice(1)));
      } catch {
        return null;
      }
    };

    const scrollToHash = (hash: string) => {
      const target = destinationFor(hash);
      if (!target) return;
      const scrollMargin = Number.parseFloat(
        window.getComputedStyle(target).scrollMarginTop,
      );
      const offset = Number.isFinite(scrollMargin) ? -scrollMargin : 0;

      if (lenis && !reducedMotion.matches) {
        lenis.scrollTo(target, { offset });
      } else {
        target.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
    };

    const onDocumentClick = (event: MouseEvent) => {
      if (!isPlainPrimaryClick(event) || event.defaultPrevented) return;
      const origin = event.target;
      if (!(origin instanceof Element)) return;
      const anchor = origin.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor ||
        anchor.target === '_blank' ||
        anchor.hasAttribute('download')
      ) {
        return;
      }

      const destination = new URL(anchor.href, window.location.href);
      const current = new URL(window.location.href);
      if (
        !destination.hash ||
        destination.origin !== current.origin ||
        destination.pathname !== current.pathname ||
        destination.search !== current.search
      ) {
        return;
      }

      const target = destinationFor(destination.hash);
      if (!target) return;
      event.preventDefault();
      window.history.pushState(null, '', destination.hash);
      scrollToHash(destination.hash);
    };

    const onHistoryNavigation = () => {
      if (historyFrame) cancelAnimationFrame(historyFrame);
      historyFrame = requestAnimationFrame(() => {
        historyFrame = 0;
        scrollToHash(window.location.hash);
      });
    };

    const onMotionPreferenceChange = () => {
      startLenis();
      if (reducedMotion.matches) scrollToHash(window.location.hash);
    };

    startLenis();
    document.addEventListener('click', onDocumentClick);
    window.addEventListener('popstate', onHistoryNavigation);
    window.addEventListener('hashchange', onHistoryNavigation);
    reducedMotion.addEventListener('change', onMotionPreferenceChange);

    if (window.location.hash) onHistoryNavigation();

    return () => {
      stopLenis();
      if (historyFrame) cancelAnimationFrame(historyFrame);
      document.removeEventListener('click', onDocumentClick);
      window.removeEventListener('popstate', onHistoryNavigation);
      window.removeEventListener('hashchange', onHistoryNavigation);
      reducedMotion.removeEventListener('change', onMotionPreferenceChange);
    };
  }, []);

  return children;
}
