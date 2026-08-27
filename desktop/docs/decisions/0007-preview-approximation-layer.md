# 0007 - The monitor is an approximation layer, and that is the plan

## Decision
The webview monitor draws every effect and transition live, through per-effect
preview mechanisms declared next to their FFmpeg chains in `lib/effects.ts`:
CSS filters where CSS is faithful, SVG filters for matrices and convolutions,
overlay layers (vignette, grain), a canvas redraw pass for geometry (pixelate,
mirror, fisheye), deterministic playhead-clocked jitter (shake), and a second
ghost video element for cross-fades. This layer is the **plan of record**, not
scaffolding: it stays until the engine can present frames, and it is allowed
to grow with the effect catalogue.

## What this supersedes
Decision 0004 called the monitor "scaffolding with a known demolition date."
That story is dead - deliberately. Users evaluate an editor by what they see
while editing, and "export only" effects tested as a retention killer. We
traded single-renderer purity for a live monitor, with eyes open.

## The drift risk, and its containment
This is a second implementation of effect *appearance* - exactly the shape
the architecture doctrine warns about. Containment:

- Both renderings read the **same parameters** from the same clip; there is
  no preview-only knob anywhere.
- The export chain is ground truth; the preview is documented as its
  approximation, never the reverse.
- Every effect's chain and preview live in **one catalogue entry**, so adding
  or changing an effect touches one place.

## What would change our mind
The engine presentation path (frame cache + reader pool + native surface).
When the engine can show its own frames at interactive rates, this layer
retires bottom-up: composite first, effects last.
