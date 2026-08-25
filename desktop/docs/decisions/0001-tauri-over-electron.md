# 0001 - Tauri, not Electron

## Decision
The desktop shell is Tauri v2. React 19 and Tailwind v4 render the UI inside
the platform's own webview.

## Why
- Electron ships a whole Chromium per app: ~150 MB of installer and ~100 MB of
  idle RSS before the editor has done anything. A video editor needs that
  memory for frame caches.
- The host process is already Rust, so the engine links straight into it. With
  Electron the engine would sit behind a native module or a subprocess, and
  every frame would cross a language boundary that does not need to exist.
- Tauri v2's IPC is a normal function call into Rust, not a second process.
- The bundle is an ordinary signed installer on all three platforms.

## What it costs
- Three webview engines instead of one: WebView2 on Windows, WKWebView on
  macOS, WebKitGTK on Linux. Their CSS support differs at the edges, and
  WebKitGTK is the one that will surprise you.
- No Node APIs in the front end. Anything touching the filesystem is a command.
- A smaller ecosystem of desktop-specific examples to copy from.

## What would change our mind
Needing a Chromium-only capability in the UI itself. Note that this does *not*
include video decode or GPU compositing - those belong to the engine, not the
webview, so the webview's media support is close to irrelevant here.
