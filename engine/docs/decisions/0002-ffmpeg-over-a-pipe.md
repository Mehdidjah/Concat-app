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
| Playback and scrubbing | **FFI** (`rusty_ffmpeg`) | Built and tested (`FfiDecoder`, `ffi` feature); not yet wired to the app. |

The subprocess backends run everything today; the FFI decoder exists and waits
on the frame cache and reader pool before playback can use it.

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
`wolfcut-media`. The FFI backend is one new type implementing `FrameSource`;
`wolfcut-core`, `wolfcut-render` and every caller stay untouched. The subprocess
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

## Status: the FFI half now exists

`wolfcut-media`'s `ffi` feature builds a linked decoder, `FfiDecoder`, which
implements `FrameSource` and `SeekableSource`. Both correctness gaps above are
closed in it and covered by `tests/ffi_decode.rs`:

- real presentation timestamps, exact rationals straight from the container
- frame-accurate seeking, verified by landing between keyframes

It is **off by default and unused by the app.** The subprocess backend is still
what runs, and probe and export are staying on it permanently.

The seam held: adding it required one new type implementing an existing trait,
one new trait for the capability the pipe genuinely lacks, and no change to
`wolfcut-core`, `wolfcut-render`, or any caller.

## Status: the reader pool exists too

`wolfcut_media::pool` is the per-media reader pool with a byte-budgeted LRU
frame cache that playback was waiting on: warm readers roll forward for near
requests and seek for far ones - frame-accurately through `FfiDecoder` when
the `ffi` feature is on, by respawn on the pipe otherwise. Its first two
consumers are live: `wolfcut-cli render` (whose founding "deliberate shortcut"
comment is finally deleted) and the host's `preview_frame` command, which
composites the true frame for the paused monitor.

## Status: streaming presentation has begun, and the FFI half is portable now

The "what remains" below is half done: the desktop monitor now pulls pooled
frames continuously against the transport clock wherever its approximation
cannot composite - see desktop decision 0009 for the shape and its
native-surface exit. And the FFI build plumbing this note budgeted for is
paid on macOS too: the feature builds and passes every test against a
package-manager FFmpeg via `FFMPEG_PKG_CONFIG_PATH` (after two portability
fixes - a committed Windows vendor path, and `AVERROR(EAGAIN)` being -35,
not -11, on macOS and the BSDs). It stays off in shipped builds; linking
FFmpeg is the licensing tripwire decision 0005 records.

## What would change our mind
Nothing left to decide about *whether*. What remains is streaming playback -
presenting pooled frames continuously against the transport clock rather than
one paused frame at a time.

Do **not** migrate probe or export along with it - for those, the tradeoff
never flips.
