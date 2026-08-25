# 0004 - CPU compositor first, GPU behind the same trait

## Decision
`relay-render` ships a correct, dependency-free `CpuCompositor`. The GPU path
(`wgpu`) will be a second implementation of the same `Compositor` trait.

## Why
- The interesting design work is the *plan*: given a timeline and a timestamp,
  which layers are visible, at what source time, with what opacity. That is pure
  logic, testable with zero IO, and the GPU backend consumes the same plan.
- A CPU compositor is the reference implementation. When GPU output looks wrong,
  you diff against this.
- `wgpu` is a large dependency tree and a long compile. Not worth paying before
  the plan is settled.

## What it costs
Playback performance until the GPU path lands. Acceptable - nothing ships yet.

## What would change our mind
Nothing; this is sequencing, not a fork in the road.
