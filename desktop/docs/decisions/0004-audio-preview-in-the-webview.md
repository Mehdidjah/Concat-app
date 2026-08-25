# 0004 - Audio and video preview run in the webview, for now

## Decision
Playback preview - both the picture in the monitor and the sound - uses the
webview's own `<video>` and `<audio>` elements, fed through Tauri's asset
protocol. The engine is not involved.

## Why
Decision 0002 in this folder says the hot surfaces are not the DOM, and that is
still the plan. But the engine cannot currently present a frame or open an
output device, and an editor where pressing play does nothing is not an editor.
The webview already has a demuxer, a decoder, a video output and an audio
device. Using them is the difference between an editor you can use today and a
screenshot.

## What this is not
It is a preview, not the program output. Specifically:

- **No compositing.** The monitor shows the top-most video clip under the
  playhead and nothing else. Two stacked clips do not blend; the lower one is
  invisible.
- **No mixing.** Overlapping audio clips play at once and will clip if loud.
  There is no gain staging, no pan, no fades.
- **Sync is corrective, not sample-accurate.** Each element is nudged back into
  step when it drifts past a tolerance - 300 ms while playing, 30 ms while
  paused. A correction while playing is audible and visible.
- **No effects.** Nothing in the render graph is applied.
- **Scrubbing repositions audio, it does not scrub it.** There is no
  granular playback.
- **Frame stepping is approximate.** The transport computes an exact frame
  boundary, but a media element seeks to the nearest frame *it* can decode.

## The asset protocol, and the fallback
`convertFileSrc` produces an `asset:` URL that streams and seeks, which is what
you want. It requires `assetProtocol.enable` plus a scope in
`tauri.conf.json`, and the scope is currently `["**"]` - a video editor opens
arbitrary user files, so a narrower scope would be a lie. Note this widens what
a compromised front end could read; it should be revisited alongside the CSP
(decision 0003).

If the protocol is unavailable for any reason, `lib/audio.ts` falls back to
pulling the whole file through the `read_media_bytes` command and playing a
blob URL. Slower and memory-hungry, but it degrades to working audio rather
than to silence. The video path has no such fallback.

## What replaces it
The engine growing a presentation path: a frame cache and reader pool first
(so scrubbing is possible at all), then a native surface for picture and a
cpal-based mixer for sound. At that point the elements in `Preview.tsx` and
`lib/audio.ts` are deleted outright rather than adapted - they share no code
with what replaces them, which is the point of keeping them this small.

## What would change our mind
Nothing. This is scaffolding with a known demolition date.
