# 0010 - The app installs its own tools

## Decision
No feature may arrive as a setup chore. Every binary WolfCut needs ships
inside the bundle or installs itself behind a single button with progress.
Concretely, as of this note:

- `whisper-cli` is staged at build like FFmpeg (`src-tauri/whisper/`,
  declared in the bundle's resources) and the release guard in `build.rs`
  refuses to build without it - a release that would ask the user to "locate
  whisper-cli" does not get to exist. CI builds it from source on macOS and
  Linux (cached by version) and takes the official binary on Windows.
- Models remain downloads, because half a gigabyte of weights someone may
  never use does not belong in every installer - but the download is one
  button in Settings with a progress bar, which is the ceiling for what a
  feature may ask.
- The Settings "Locate..." picker survives only as a dev-build escape hatch
  and is hidden whenever the bundled copy is in use.

## Why
The product's one-line promise is "install it and start cutting, no setup".
The transcriber shipped as the opposite: a feature that greeted its user
with a binary hunt. The user's words, verbatim, now policy: "never offload
technical jobs to the user... At most, the user should do some basic config
and have to click a 'Install' button, AT MOST."

## What it costs
- CI builds whisper.cpp once per platform per version bump (~4 minutes cold,
  then cached), and installers grow by a few megabytes.
- The bundled copy is CPU/Metal only; exotic accelerators mean the escape
  hatch in a dev build.

## What would change our mind
Nothing about the principle. The mechanics move if the engine grows an
audio-analysis seam (this note's staging follows the runner there, per the
note in `transcribe.rs`).
