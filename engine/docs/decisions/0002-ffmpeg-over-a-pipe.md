# 0002 - FFmpeg as a subprocess now, FFI where the pipe cannot reach

*Revised. The first version of this note claimed the pipe was fine until 4K
playback. That was too generous: two of its limits are correctness problems,
not performance ones, and they bite much earlier. The revised trigger is at the
bottom.*

## Decision
Split by use case rather than picking one backend for everything.

| Path | Backend | Status |
|---|---|---|
| Probe (`ffprobe`) | subprocess | Permanent. Runs once per import; robustness beats latency. |
| Export / render | subprocess | Permanent unless throughput demands otherwise. |
| Playback and scrubbing | **FFI** (`rsmpeg` or `ffmpeg-next`) | Not built yet. Required before playback ships. |

Today only the subprocess backends exist, because nothing scrubs yet. The FFI
backend arrives with the frame cache and the transport, not before.

## Why the subprocess path is genuinely right for probe and export
- A crashing decoder on malformed input kills a child process, not the editor.
  We are parsing arbitrary user media; every serious video app has a CVE
  history in its demuxers.
- The boundary is trivially debuggable: print the argv, paste it into a shell,
  read what FFmpeg says.
- It builds anywhere `ffmpeg` is on `PATH`. No headers, no import libs, no
  bindgen, no `FFMPEG_DIR` to keep correct on every machine and CI runner
  forever. For a project maintained by one person intermittently, that is worth
  a great deal.

## What the pipe cannot do, in order of severity

1. **No timestamps.** `rawvideo` is a naked pixel stream with no PTS. Frame time
   is inferred from ordinal position, which is only true for constant-frame-rate
   material. Variable-frame-rate footage - screen recordings, phone video -
   silently desyncs. There is no way to fix this over a pipe; the information
   simply is not in the stream.
2. **No frame-accurate seek.** `-ss` lands on a keyframe. Seeking to an exact
   frame means decode-from-keyframe-and-discard, per request, which the pipe
   cannot express.
3. **No hardware decode into GPU textures.** Frames must land in system memory
   and be uploaded again, which defeats the point of the `wgpu` compositor.
4. **Bandwidth.** 1080p60 RGBA is roughly 500 MB/s through the pipe.
5. **A process spawn per media open.** A twenty-clip timeline being scrubbed
   means spawning and killing processes continuously.

Items 1 and 2 are correctness. Items 3 to 5 are performance. That ordering is
the whole reason this note was rewritten.

## Containment
Everything process-shaped hides behind `FrameSource` and `FrameSink` in
`relay-media`. The FFI backend is one new type implementing `FrameSource`;
`relay-core`, `relay-render` and every caller stay untouched. The subprocess
decoder stays as a fallback for formats the linked build was not compiled with.

## What the FFI work will actually cost
Not "add a crate". As of writing, the development machine has FFmpeg 8.1 from
Chocolatey - binaries only, no `libavcodec/avcodec.h` and no import libs, and
`pkg-config` has nothing FFmpeg-shaped to find. So the work is:

- source a `-shared` dev build (gyan.dev) or `vcpkg install ffmpeg`,
- set and document `FFMPEG_DIR`, and keep it true on every machine and CI runner,
- get bindgen agreeing with the installed MSVC toolchain,
- then write the wrapper: roughly 500 lines of `unsafe extern "C"` behind a safe
  `FrameSource`.

Budget for the build plumbing, not the Rust. The Rust is the easy half.

## What would change our mind
Building playback. Specifically, the first time we need either a real PTS or a
frame-accurate seek - whichever comes first. Both arrive with the transport
controls, so that is the deadline.

Do **not** wait for 4K, and do not migrate probe or export along with it.
