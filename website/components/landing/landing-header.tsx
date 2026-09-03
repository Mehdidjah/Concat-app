'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AUTO_DOWNLOAD_URL, REPOSITORY_URL } from '@/lib/downloads';

const repositoryUrl = REPOSITORY_URL;

const navigation = [
  { label: 'Features', href: '#features', external: false },
  { label: 'Principles', href: '#principles', external: false },
  { label: 'FAQ', href: '#faq', external: false },
  { label: 'GitHub', href: repositoryUrl, external: true },
] as const;

export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [dotPhase, setDotPhase] = useState<'closed' | 'action' | 'opened'>(
    'closed',
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dotInitialRender = useRef(true);
  const suppressFocusOpen = useRef(false);

  useEffect(() => {
    const product = document.querySelector<HTMLElement>('[data-hero-media]');
    if (!product) return;
    let frameId = 0;
    const update = () => {
      frameId = 0;
      const next = product.getBoundingClientRect().top <= 0;
      setScrolled((current) => (current === next ? current : next));
    };
    const schedule = () => {
      if (!frameId) frameId = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  useEffect(() => {
    if (dotInitialRender.current) {
      dotInitialRender.current = false;
      return;
    }
    setDotPhase('action');
    const timer = window.setTimeout(
      () => setDotPhase(menuOpen ? 'opened' : 'closed'),
      menuOpen ? 600 : 240,
    );
    return () => window.clearTimeout(timer);
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        if (document.activeElement !== triggerRef.current) {
          suppressFocusOpen.current = true;
          triggerRef.current?.focus({ preventScroll: true });
        }
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen]);

  const openOnHover = () => {
    if (
      window.innerWidth >= 810 &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches
    ) {
      setMenuOpen(true);
    }
  };

  const closeOnHover = () => {
    if (
      window.innerWidth >= 810 &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      !menuRef.current?.contains(document.activeElement)
    ) {
      setMenuOpen(false);
    }
  };

  return (
    <header className="landing-header" data-scrolled={scrolled}>
      <nav className="nav-frame" aria-label="Primary navigation">
        <Link className="brand-link" href="/" aria-label="Concat home">
          <Image
            src="/concat-logo-green.png"
            alt=""
            width={40}
            height={40}
            className="brand-logo"
            priority
          />
          <span>Concat</span>
        </Link>

        <div className="nav-actions">
          <div
            className="menu-wrap"
            ref={menuRef}
            data-open={menuOpen}
            data-dot-phase={dotPhase}
            onMouseEnter={openOnHover}
            onMouseLeave={closeOnHover}
            onFocusCapture={() => {
              if (suppressFocusOpen.current) {
                suppressFocusOpen.current = false;
                return;
              }
              if (document.activeElement === triggerRef.current) {
                setMenuOpen(true);
              }
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                setMenuOpen(false);
              }
            }}
          >
            <button
              ref={triggerRef}
              className="menu-trigger"
              type="button"
              aria-expanded={menuOpen}
              aria-controls="landing-menu"
              onPointerDown={() => {
                suppressFocusOpen.current = true;
              }}
              onClick={(event) => {
                suppressFocusOpen.current = false;
                const mouseHover =
                  event.detail > 0 &&
                  window.innerWidth >= 810 &&
                  window.matchMedia('(hover: hover) and (pointer: fine)')
                    .matches;
                if (mouseHover) setMenuOpen(true);
                else setMenuOpen((open) => !open);
              }}
            >
              <span>Menu</span>
              <span className="menu-dots" aria-hidden="true">
                <span />
                <span />
              </span>
            </button>
            <div
              id="landing-menu"
              className="menu-panel"
              aria-hidden={!menuOpen}
            >
              {navigation.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  tabIndex={menuOpen ? 0 : -1}
                  onClick={() => {
                    triggerRef.current?.focus({ preventScroll: true });
                    setMenuOpen(false);
                  }}
                >
                  <span>{item.label}</span>
                  <span aria-hidden="true">{item.external ? '↗' : '↓'}</span>
                </a>
              ))}
            </div>
          </div>

          <a
            className="button button-primary nav-download"
            href={AUTO_DOWNLOAD_URL}
            aria-label="Download Concat"
          >
            <span>Download</span>
            <span className="button-arrow" aria-hidden="true">
              ↓
            </span>
          </a>
        </div>
      </nav>
    </header>
  );
}
