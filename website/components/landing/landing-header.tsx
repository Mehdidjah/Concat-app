'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

const releasesUrl = 'https://github.com/Mehdidjah/wolfcut-App/releases';
const repositoryUrl = 'https://github.com/Mehdidjah/wolfcut-App';

const navigation = [
  { label: 'Features', href: '#features', external: false },
  { label: 'Principles', href: '#principles', external: false },
  { label: 'FAQ', href: '#faq', external: false },
  { label: 'GitHub', href: repositoryUrl, external: true },
] as const;

export function LandingHeader() {
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > window.innerHeight / 2);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
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
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      setMenuOpen(true);
    }
  };

  const closeOnHover = () => {
    if (
      window.matchMedia('(hover: hover) and (pointer: fine)').matches &&
      !menuRef.current?.contains(document.activeElement)
    ) {
      setMenuOpen(false);
    }
  };

  return (
    <header className="landing-header" data-scrolled={scrolled}>
      <nav className="nav-frame" aria-label="Primary navigation">
        <Link className="brand-link" href="/" aria-label="Wolf-Cut home">
          <Image
            src="/wolfcut-logo.png"
            alt=""
            width={40}
            height={40}
            className="brand-logo"
            priority
          />
          <span>Wolf-Cut</span>
        </Link>

        <div className="nav-actions">
          <span className="version-badge version-badge-nav">Alpha 0.2.0</span>
          <div
            className="menu-wrap"
            ref={menuRef}
            onMouseEnter={openOnHover}
            onMouseLeave={closeOnHover}
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
              onFocus={(event) => {
                if (
                  event.currentTarget.matches(':focus-visible') &&
                  window.matchMedia('(hover: hover) and (pointer: fine)')
                    .matches
                ) {
                  setMenuOpen(true);
                }
              }}
              onClick={() => setMenuOpen((open) => !open)}
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
              data-open={menuOpen}
              aria-hidden={!menuOpen}
            >
              <span className="version-badge version-badge-menu">
                Alpha 0.2.0
              </span>
              {navigation.map((item) => (
                <a
                  key={item.label}
                  href={item.href}
                  target={item.external ? '_blank' : undefined}
                  rel={item.external ? 'noopener noreferrer' : undefined}
                  tabIndex={menuOpen ? 0 : -1}
                  onClick={() => {
                    setMenuOpen(false);
                    requestAnimationFrame(() =>
                      triggerRef.current?.focus({ preventScroll: true }),
                    );
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
            href={releasesUrl}
            aria-label="Download Wolf-Cut"
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
