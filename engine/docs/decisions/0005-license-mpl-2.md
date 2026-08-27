# 0005 - License: MPL-2.0

## Decision
WolfCut is licensed under the Mozilla Public License 2.0. `LICENSE` at the
repository root is the canonical text; every crate and package manifest names
`MPL-2.0`.

## Why
- File-level copyleft: changes to WolfCut's own files must be shared, which
  keeps improvements flowing back without capturing everything they touch.
- A proprietary plugin, integration, or vendor SDK can link against the engine
  without inheriting the license - the future OpenFX/VST story (decision 0001)
  stays possible.
- Compatible with the dependency tree in use (MIT/Apache Rust crates), and
  with distributing GPL-built FFmpeg *alongside* the app as a separate
  program.

## The FFmpeg constraint, restated
The bundled `ffmpeg`/`ffprobe` binaries are GPL builds (x264). Because they are
invoked as child processes and never linked (decision 0002), their license does
not propagate to this code - but distributing them makes the *bundle* subject
to FFmpeg's source-availability terms. `THIRD_PARTY_NOTICES.md` names the
builds we ship and where their sources live, and every release links it.

## What would change our mind
Linking FFmpeg into the shipped app (the `ffi` feature graduating from
dev-only) would force the bundle question open again: a GPL libavcodec linked
into an MPL binary is a licensing decision, not a build flag.
