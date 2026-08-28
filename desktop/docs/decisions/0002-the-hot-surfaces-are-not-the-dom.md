# 0002 - The timeline and the preview are not made of DOM

## Decision
The timeline is one `<canvas>` drawn from a `requestAnimationFrame` loop. The
preview is a placeholder that will become a native GPU surface. Neither renders
through React.

> The preview half has moved twice since: 0007 promoted its approximation
> layer to the plan of record, and 0009 streams the engine's true composite
> against the transport clock. The native surface stays the endgame; those two
> notes are the path to it.

## Why
- A real edit is thousands of clips, keyframes and waveform segments. As DOM
  nodes that is thousands of elements, restyled and re-laid-out on every scrub.
  React reconciliation is not the bottleneck there - layout and paint are, and
  no amount of memoisation avoids them.
- One canvas is one draw call per frame, and the draw cost scales with what is
  *visible* rather than with what exists.
- Frames must never be paced by React state. Playback is a clock, and the clock
  belongs to the engine.

## Consequences
- The canvas has to handle its own hit-testing, scrolling and device pixel
  ratio. That is real work, and it is why `Timeline.tsx` is longer than the
  panels around it.
- Accessibility does not come free on a canvas. Keyboard editing operations
  must be first-class rather than an afterthought bolted onto mouse handlers.
- The draw loop reads its inputs through a ref, so changing a prop never tears
  down and rebuilds the loop.

## The preview specifically
Pushing decoded frames to the webview over IPC means copying every frame into
JSON-adjacent plumbing and through the browser compositor. That is acceptable
for a still and hopeless at 60 fps. The plan is a native child window that the
GPU compositor draws into directly, positioned to the preview element's
bounding box - which is why that element keeps a strict aspect box even while
it is empty.

## What would change our mind
Nothing for the timeline. For the preview, a zero-copy path from a GPU texture
into the webview would remove the reason for a separate surface - worth
re-checking when the `wgpu` backend lands.
