# 0006 - Transitions resolve in the exporter, ramps live in the core

## Decision
A transition is stored on the *incoming* clip of a cut (`transitionIn`), and
is turned into things the renderer already understands at export time, by
`resolve_transitions` in the host's `export.rs`:

- **Cross-fade**: the incoming clip is extended backwards over the outgoing
  one - consuming its source handle, clamped to what exists - moved onto a
  synthetic lane directly above it (every track index is doubled; incoming
  clips take the odd lane), and given a `video_fade_in` opacity ramp.
- **Fade to black/white**: frame-exact `fade` filters appended to each side's
  decode chain. Nothing moves.

`relay-core::Clip` grew exactly one concept: `video_fade_in`/`video_fade_out`
ramps, multiplied into the frame plan's layer opacity. The compositor never
learns transitions exist.

## Why this shape
- Binding a transition to the cut by *adjacency* (a clip ends where this one
  starts) means moving the clips apart orphans it into a plain cut - no
  dangling entity, no repair pass.
- Resolving in the exporter keeps the engine timeline free of a transition
  type it would only ever lower into overlaps anyway.
- The handle rule (a dissolve consumes source before the in-point) is what
  every NLE does, and the clamp means "no handle, shorter dissolve" instead
  of frozen frames.

## What it costs
- Chained cross-fades within one dissolve window degrade (the synthetic-lane
  trick assumes one incoming clip per cut). Pathological, documented in code.
- The motion transitions (wipe, push, zoom) need animated transforms in the
  engine and stay "Soon" until it has them.

## What would change our mind
Animated transforms landing in `relay-core` - at which point wipes arrive and
cross-fade could become a first-class engine op instead of an export lowering.
