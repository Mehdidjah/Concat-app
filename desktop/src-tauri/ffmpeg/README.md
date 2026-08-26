# Bundled FFmpeg

Drop the `ffmpeg` and `ffprobe` binaries for the current platform in here
(`.exe` suffixed on Windows) and the packaged app ships them; see
`.github/workflows/ffmpeg.yml` for how the Windows pair is produced.

If this directory holds only this README, the packaged app falls back to
FFmpeg on `PATH` — dev builds (`npm run app`) always do. This file is
tracked so the directory exists on a fresh checkout; the `ffmpeg/*`
resources glob in `tauri.conf.json` fails the build when it matches nothing.
