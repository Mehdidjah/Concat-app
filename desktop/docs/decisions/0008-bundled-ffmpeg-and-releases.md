# 0008 - Releases bundle static FFmpeg, staged by CI

## Decision
Every packaged build ships its own `ffmpeg`/`ffprobe` pair in the app's
resources; `build.rs` refuses a release build without them staged, because a
packaged app without FFmpeg ships broken (no PATH to fall back on from
Finder). CI stages the pair before building: BtbN static GPL builds on
Windows, Martin Riedl static builds on macOS (arm64), both verified runnable
and - on macOS - verified present and executable inside the bundle after
packaging.

Tags matching `v*` additionally publish the installers to a GitHub release;
a hyphen in the tag marks a pre-release. The release body links
`THIRD_PARTY_NOTICES.md` for the FFmpeg licensing story (the builds are GPL;
we invoke, never link - see engine decisions 0002 and 0005).

## Why download static builds instead of our trimmed workflow's output
The `ffmpeg.yml` workflow builds a cut-down FFmpeg whose feature list is
matched to exactly what the app invokes, but it is Windows-only today and its
output must be staged by hand. Full static builds are ~100 MB heavier and
always sufficient; correctness beats size for the alpha. When the trimmed
build graduates (both platforms, automated staging), its enable-filter list
already tracks the effect catalogue - keep it that way.

## What would change our mind
Nothing about bundling. The source of the binaries flips to the trimmed
build when it covers both platforms; the guard in `build.rs` and the CI
verification step stay regardless.
