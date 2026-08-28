# 0009 - The monitor streams the true frame where the approximation is wrong

## Decision
While the transport runs, the monitor pulls the engine's real composite -
the exporter's own plan, pool and compositor via `preview_frame` - in a loop:
request the frame at the transport's current position, present it, request
the next the moment it lands. The loop engages only while **two or more
visual layers** sit under the playhead; single-layer stretches keep the
webview element's smooth playback, exactly as before. Streamed frames are
capped at 640 px on the long edge; the paused dwell still re-fetches at 960
the moment the transport stops.

This is the presentation half that 0007 left open ("presenting pooled frames
continuously against the transport clock"), built on the seam that already
existed rather than a new one.

## Why this shape
- **Pull, not push.** The UI asks for one frame at the *current* position and
  does not ask again until it arrives. Backpressure is structural: a slow
  machine gets a lower rate, never a growing queue of stale frames, and the
  host's pool mutex serialises requests in order - which is also what makes
  consecutive requests warm roll-forwards instead of seeks.
- **Only where the element is wrong.** The `<video>` element is exact for one
  layer and *cannot composite* a stack. Streaming everywhere would trade the
  common case's 60 fps smoothness for uniform choppiness; streaming only on
  stacks buys truth precisely where the approximation lies.
- **The IPC budget holds.** 640-wide RGBA is ~1 MB a frame as an ArrayBuffer
  response; at the 15-30 fps the pool sustains for warm readers that is well
  inside what Tauri's IPC moves locally, and it degrades by rate, not by
  failure.

## What this is not
- **Not a vsync-locked presentation.** Frames display one fetch-latency
  behind the transport and at whatever rate decoding sustains. It is honest
  compositing, not final playback smoothness.
- **Not the native surface.** Decision 0002's endgame - a GPU surface
  positioned to the frame box, engine-presented - still stands. When it
  arrives it replaces the *transport* of pixels (IPC → surface); the plan,
  pool and compositor this loop exercises are exactly what it will present
  from, which is why building this first is not throwaway.

## What it costs
- Streamed frames are visibly softer than the element (640 upscaled) and
  arrive a beat late. Acceptable on stacks, which previously showed
  something *wrong* rather than something soft.
- A failed frame drops back to the approximation silently (logged host-side).

## What would change our mind
The native surface landing - at which point this loop is deleted, not
adapted, the same clean demolition 0004 got.
