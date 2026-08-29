<div align="center">

<img src="assets/wolfcut_logo_512.png" alt="WolfCut" width="140" />

# WolfCut

**The free, open-source CapCut replacement.**

[![Build](https://github.com/jub0t/WolfCut/actions/workflows/build.yml/badge.svg)](https://github.com/jub0t/WolfCut/actions/workflows/build.yml)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-8A2BE2)](https://github.com/jub0t/WolfCut/releases)
[![Version](https://img.shields.io/badge/version-0.2.0-blue)](https://github.com/jub0t/WolfCut)
[![Discord](https://img.shields.io/badge/Discord-join%20the%20server-5865F2?logo=discord&logoColor=white)](https://discord.gg/DVuPfpXfqP)

<img src="assets/preview-dark.png" alt="WolfCut editor" width="100%" />

</div>

---

WolfCut is everything you use CapCut for — without the watermarks, paywalls,
or subscriptions. A native Rust engine does the heavy lifting, a clean React
interface does the editing, and it all runs on your machine: install it and
start cutting, no account, no extra downloads, no setup.

## Highlights

- 🎬 Multi-track editing, with several timelines per project when one isn't enough
- ✂️ The cutting toolkit you'd expect: split, trim, merge, transitions, speed control
- 💬 Auto-captions that run entirely on your machine — your audio never leaves it
- 🎙️ Voice filters for cleaning up or playing with your sound
- 📝 Titles and styled text
- 📦 Templates — build an edit once, reuse it for the next video
- 🚫 No watermarks, no account, nothing behind a paywall
- 🖥️ Works the same on macOS, Windows and Linux

## Get started

Currently in Alpha (pre-release), Download from [Releases](https://github.com/jub0t/WolfCut/releases), Supports:
- Windows (tested)
- MacOs (tested) - unsigned binaries, use `xattr -dr com.apple.quarantine /Applications/WolfCut.app`
- Linux

### Nix (Linux)

The repository is a flake. `nix run github:jub0t/WolfCut` starts the editor
with ffmpeg and whisper wired in; `nix develop` opens a shell with everything
`npm run app` needs.

## Contribution

> [!IMPORTANT]
> The best way to contribute is to grab a build from the [Release](https://github.com/jub0t/WolfCut/releases) page and test the application to see where it breaks or how it can be improved.

To learn more about contributing to this project please refer to [this Discussion announcement](https://github.com/jub0t/WolfCut/discussions/3).

## Roadmap (or ideas)

🌟 = important or really desired.

- [ ] 🌟 Total website/ revamp: and a proper deploy website for a Download landing page.
- [ ] 🌟 Templates: Improve templates, create centralized registry of templates contributed by users (kinda like npm).
- [ ] 🌟 Script to reverse-engineer TikTok's templates, really helpful.
- [ ] Hardware analysis: for device-tier detection, checking how good or potato someone's device is.
- [ ] Effects: A scaleable way to embed or add hundreds of different Transition styles, Effects, etc to the Library.
- [ ] Noise Cancelation/Removal.
- [ ] Object/Face Tracking: Proposed (can do better): MOSSE/KCF/optical flow.
- [ ] Auto Human Face Detection & Blurring features: YuNet + tracker, or look for better alternative tech.
- [ ] Caption text highlighting: Achievable with Whisper.cpp for timestamps.
- [ ] Profanity detection from Audio: Whisper + dictionary.
- [ ] Audio Silence removal feature.
- [ ] Auto Reframe: YuNet/person detector + tracker.
