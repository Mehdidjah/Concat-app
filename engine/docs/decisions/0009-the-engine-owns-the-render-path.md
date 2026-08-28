# 0009 - The engine owns the render path

## Decision

Rendering moves into the engine as `wolfcut-export`: transition resolution
(decision 0006's semantics, unchanged), the flat-clip-list-to-`Timeline`
conversion, the frame loop, audio mix orchestration, and the paused-monitor
composite. The desktop host's `export.rs` shrinks to a wire shim - deserialise
the request, forward progress as `export://progress` events.

This lands the standing doctrine as structure, not comments: **the Tauri and
TypeScript sides are interface; everything important exists in the engine.**
A piece of editing or rendering semantics found in `desktop/` is debt to be
moved, not a home to be extended.

## Why now

The 2026-08 audit found the "engine owns the model" doctrine true for editing
and persistence but false for rendering: what actually exported was a clip
list flattened by the UI, re-interpreted by a hundred lines of dissolve
semantics living in the host - in a file whose own header said editing
semantics must not live there. Three definitions of "a clip" existed
(`wolfcut-core` rational, `wolfcut-project` f64, host `ExportClip`), and any
drift between them was invisible to every test in the workspace, because the
host was the only place they met.

## Shape choices worth recording

- **A separate crate, not part of wolfcut-render.** `wolfcut-render` turns a
  timeline plus a timestamp into one frame and depends only on core; the
  export path also needs media (decoders, the audio graph) and orchestrates
  whole files. Folding that tree into wolfcut-render would make every
  render-only consumer pay for it.
- **The GPU stays behind a feature gate** (`gpu`, forwarding to
  wolfcut-render's), for the same reason it is one there: engine-only work
  never pays for the wgpu tree.
- **The flattened `ExportClip` remains, for now, produced by the UI.** Moving
  the code was step one; making the engine's own `Editor` session the source
  the flattener reads - so export and preview stop trusting UI JSON at all -
  is the follow-on step, along with the FFmpeg effect/filter chain builders
  (today mirrored between `lib/effects.ts`/`lib/filters.ts` and
  `wolfcut-export::chains`, pinned to byte-identical output by tests on both
  sides).

## Consequences

- The CLI and any future frontend can render a timeline identically to the
  app, from the engine alone.
- `resolve_transitions` and the conversion seam are tested where they live;
  a change to dissolve semantics fails an engine test, not a user's export.
- The host no longer compiles any code that decides what pixels mean. What
  remains in `desktop/src-tauri` is process supervision (playback's device
  babysitting, whisper, single-flight job slots) and wire conversion - the
  things a host is for.
