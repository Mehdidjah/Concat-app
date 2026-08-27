# Building WolfCut

Two independent pieces:

- **`engine/`** — the Rust video engine. Builds and tests on its own, with no UI
  and no Node involved.
- **`desktop/`** — the Tauri + React editor. Depends on the engine by path.

You can work on the engine without ever touching the desktop app.

## What you need

| | Version | Why | Check |
|---|---|---|---|
| **Rust** | 1.93 | Pinned by `engine/rust-toolchain.toml`; rustup installs it automatically | `rustc --version` |
| **Node** | 22+ | Vite 7 and the Tauri CLI | `node --version` |
| **FFmpeg** | 7+ | Runtime dependency — the engine shells out to it | `ffmpeg -version` |
| **MSVC Build Tools** | 2022 | Windows only; Rust's default toolchain links with it | — |

For **development**, FFmpeg must be on `PATH` as both `ffmpeg` **and**
`ffprobe`. Without it the app starts fine and then fails on first import with
"could not run `ffprobe` - is FFmpeg installed and on PATH?".

**Packaged builds ship their own FFmpeg** and never touch `PATH` - a `.app`
launched from Finder does not see a shell's `PATH` at all, so relying on it
there is a guaranteed failure. Stage the pair in `desktop/src-tauri/ffmpeg/`
before `npm run app:build`: on Windows, download the artifact from
`.github/workflows/ffmpeg.yml`; on macOS, build the same cut-down FFmpeg
locally with that workflow's configure line (static x264, system frameworks
only - verify with `otool -L`). A release build **fails** if the pair is not
staged - `src-tauri/build.rs` checks, because an app once shipped without it
and every media operation failed at runtime.

Two lessons that trimmed build has already taught, encoded in the code and
the `export_integration` test: modern FFmpeg resolves a bare `-` to the `fd:`
protocol, which the trimmed build does not include, so every pipe is spelled
`pipe:0`/`pipe:1`; and any filter used anywhere in the app must be in the
build's `--enable-filter` list, which the integration test is there to catch.

```
winget install Gyan.FFmpeg          # Windows
brew install ffmpeg                 # macOS
sudo apt install ffmpeg             # Debian/Ubuntu
```

## Engine

```sh
cd engine
cargo test --workspace     # pure tests; none need FFmpeg
cargo test --workspace --features relay-render/gpu   # adds the wgpu compositor
cargo clippy --workspace --all-targets
cargo run -p relay-cli -- probe some-video.mp4
cargo run -p relay-cli -- render in.mp4 out.mp4 --frames 120 --fade 30
```

The tests are pure — they exercise the timeline model, rational time and the
compositor, and pass on a machine with no FFmpeg at all. The CLI is how you
exercise the parts that do need it.

The `gpu` feature of `relay-render` builds `WgpuCompositor`, a second
implementation of the same `Compositor` trait. The desktop app enables it and
uses it for export when the machine has an adapter, with `CpuCompositor` as
the always-correct fallback and reference (its tests diff the two). The
feature is off by default so engine-only work never pays for the wgpu tree.

There is also an end-to-end suite that runs a real export — decoders,
compositor, encoder, audio graph, mux — against the **bundled** FFmpeg pair
when it is staged, so a component missing from the trimmed build fails in CI
rather than in a user's export:

```sh
cd desktop/src-tauri
cargo test --test export_integration    # needs a system ffmpeg for fixtures
```

## Desktop app

```sh
cd desktop
npm install
npm run app          # dev: builds the Rust host, opens the window, HMR for the UI
npm run typecheck    # tsc --noEmit
npm run build        # UI only, into dist/
npm run app:build    # production installers
```

**First `npm run app` takes several minutes** — it compiles ~360 Rust crates.
After that only your own crates rebuild, so it is seconds. Editing anything
under `src/` hot-reloads without a Rust rebuild at all.

`npm run app:build` produces, under `desktop/src-tauri/target/release/`:

```
relay-desktop.exe                       standalone, no install needed
bundle/nsis/WolfCut_0.1.0_x64-setup.exe   installer
bundle/msi/WolfCut_0.1.0_x64_en-US.msi    installer
```

Release builds use `lto = true` and `codegen-units = 1`, so expect them to be
several times slower than dev. That is deliberate; the final link is
single-threaded and is most of the wait.

## `vendor/` — not required

Holds an FFmpeg **development** build (headers and import libraries), used only
by the in-progress FFI decoder described below. It is gitignored, roughly
150 MB, and nothing in the normal build path touches it. Delete it freely.

## FFI decoder — optional, off by default

The engine talks to FFmpeg as a subprocess
(`engine/docs/decisions/0002-ffmpeg-over-a-pipe.md`). That is permanent for
probing and export. Playback is different: a pipe carries no presentation
timestamps and cannot seek to an exact frame, so there is a second decoder that
links FFmpeg directly, behind the `ffi` feature.

Nothing in the app enables it yet. **You do not need any of this to build or
run WolfCut.**

### Setup, exactly as verified

1. **Get a development build** — headers plus `.lib` import libraries, which
   the ordinary runtime download does not include. From
   [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases), take a
   `win64-gpl-**shared**` archive and unpack it into `vendor/`:

   ```sh
   curl -L -o ff.zip https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-gpl-shared-8.1.zip
   unzip ff.zip -d vendor/
   ```

   **The version has to match the bindings.** `rusty_ffmpeg` ships
   pre-generated bindings for a specific FFmpeg, currently 8.1 — avcodec 62,
   avformat 62, avutil 60. A different major version compiles fine and then
   misreads struct layouts at runtime, which corrupts silently rather than
   failing. `ffi::tests::links_against_the_expected_ffmpeg` checks this and is
   the first thing to look at if the decoder behaves strangely.

2. **Nothing else.** No LLVM, no libclang, no bindgen run — the pre-generated
   bindings are used as-is. `engine/.cargo/config.toml` already points at
   `vendor/`, so no environment variables to set either.

   If you unpack a differently-named archive, update the paths in that file.

3. **Build and test:**

   ```sh
   cd engine
   PATH="../vendor/ffmpeg-n8.1-latest-win64-gpl-shared-8.1/bin:$PATH" \
     cargo test -p relay-media --features ffi
   ```

   The DLLs must be on `PATH` at *run* time. Linking uses `lib/` (import
   libraries); running needs `bin/` (the DLLs themselves). Pointing either at
   the other is the most likely thing to go wrong — `LNK1181: cannot open input
   file 'avcodec.lib'` means the linker was aimed at `bin/`.

### What it provides

`FfiDecoder` implements `FrameSource` plus `SeekableSource`:

- **`position()`** — the real presentation timestamp, as an exact rational. The
  subprocess decoder returns `None` here, honestly: raw video carries no
  timestamps, which is why variable-frame-rate material desyncs through a pipe.
- **`seek()`** — frame-accurate, by seeking to the preceding keyframe and
  decoding forward. Deliberately a separate trait, so the subprocess decoder
  cannot pretend to offer it.

`tests/ffi_decode.rs` proves both against a generated fixture, and skips
entirely if FFmpeg is not installed.

## Troubleshooting

**"could not run `ffprobe`"** — FFmpeg is not on `PATH`. Restart the terminal
after installing; a running shell keeps its old `PATH`.

**Rust rebuilds everything on each `npm run app`** — something is changing
`engine/`'s files. The desktop app depends on the engine by path, so a touched
engine file invalidates the host too.

**The window opens white** — the Vite dev server did not start. Check that port
1420 is free; Tauri is configured with `strictPort`, so it will not silently
pick another.
