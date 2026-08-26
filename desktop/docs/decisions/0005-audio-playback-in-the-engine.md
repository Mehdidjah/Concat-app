# 0005 - Audio playback lives in the engine

## Decision

All audible playback is decoded, mixed and clocked by the Rust host
(`src-tauri/src/playback.rs`). The webview no longer owns any part of the
audio path: it describes the audible clip set (`audio_set_clips`), drives the
transport (`transport_play` / `transport_pause` / `transport_seek`), and
follows the engine's `transport` position events. The monitor's `<video>`
element is permanently muted - it is a picture surface, nothing more.

## Why

The webview mixer (decision 0004) was built on `HTMLMediaElement` routed
through `createMediaElementSource`, corrected against a wall-clock transport.
That design hit its ceiling in practice, not in theory: WebKit's
element-through-graph pipeline drops out audibly even on a three-second file,
corrective reseeks are audible clicks, filtered clips required rendering a
whole WAV per slider adjustment, and there were three clocks - wall clock,
media element, audio context - that could only ever agree approximately.

The engine path has exactly one clock: the audio device's sample counter.

## How it works

- **Decode once, mix forever.** Each audible clip's source span is decoded by
  FFmpeg to raw 48 kHz stereo PCM, with the clip's filter chain and speed
  baked in using the same filters the exporter uses - preview and export
  cannot disagree. Volume and fades apply at mix time (the gain law mirrors
  `clipGainAt`), so gain edits never re-decode.
- **Disk-backed, memory-mapped.** PCM lands in `<project>/cache/audio/` keyed
  by everything that changes the samples, and is memory-mapped rather than
  loaded - memory stays bounded on long material, and a reopened project
  replays instantly.
- **A lock-free mix callback.** The cpal callback owns its state and drains a
  message channel; no locks are taken on the audio thread. Clip-set changes,
  play, pause and seek are messages.
- **The clock flows outward.** The callback publishes its position; a 30 Hz
  event stream carries it to the UI, which interpolates on the wall clock
  between events. The UI never tells the engine what time it is while playing.

## What this is not, yet

- **Not video presentation.** The picture is still the muted webview element
  showing the top-most clip (decision 0004's video half stands). When the
  engine can decode and present frames, the same transport already drives it.
- **Not streaming decode.** A clip's span is decoded whole before it joins
  the mix. New material is silent for the decode's duration (cached
  thereafter). Fine for editing; a capture monitor would need a ring buffer.
- **Not an undo boundary.** The mixer is a pure function of the clip set it
  is sent; it holds no editing state at all.
