# Building Relay

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

FFmpeg must be on `PATH` as both `ffmpeg` **and** `ffprobe`. Relay does not
bundle it. Without it the app starts fine and then fails on first import with
"could not run `ffprobe` - is FFmpeg installed and on PATH?".

```
winget install Gyan.FFmpeg          # Windows
brew install ffmpeg                 # macOS
sudo apt install ffmpeg             # Debian/Ubuntu
```

## Engine

```sh
cd engine
cargo test --workspace     # ~60 tests, none of them need FFmpeg
cargo clippy --workspace --all-targets
cargo run -p relay-cli -- probe some-video.mp4
cargo run -p relay-cli -- render in.mp4 out.mp4 --frames 120 --fade 30
```

The tests are pure — they exercise the timeline model, rational time and the
compositor, and pass on a machine with no FFmpeg at all. The CLI is how you
exercise the parts that do need it.

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
bundle/nsis/Relay_0.1.0_x64-setup.exe   installer
bundle/msi/Relay_0.1.0_x64_en-US.msi    installer
```

Release builds use `lto = true` and `codegen-units = 1`, so expect them to be
several times slower than dev. That is deliberate; the final link is
single-threaded and is most of the wait.

## `vendor/` — not required

Holds an FFmpeg **development** build (headers and import libraries), used only
by the in-progress FFI decoder described below. It is gitignored, roughly
150 MB, and nothing in the normal build path touches it. Delete it freely.

## FFI decoder — in progress, not yet wired up

The engine currently runs FFmpeg as a subprocess
(`engine/docs/decisions/0002-ffmpeg-over-a-pipe.md`). That is permanent for
probing and export, but playback needs real timestamps and frame-accurate
seeking, which a pipe cannot provide — so a linked decoder is being added
behind the existing `FrameSource` trait.

Extra prerequisites for that path only:

- **LLVM / libclang** — `bindgen` generates the FFmpeg bindings at build time.
  `winget install LLVM.LLVM`
- **An FFmpeg dev build** — headers plus `.lib` import libraries, which the
  ordinary runtime download does not include. Get a `*-gpl-shared-*` archive
  from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) and
  unpack it into `vendor/`.
- Environment variables pointing at it (see `engine/crates/relay-media/README`
  once this lands).

This section will be replaced with exact, verified steps when the decoder
actually builds. Until then, ignore it — the app does not need any of it.

## Troubleshooting

**"could not run `ffprobe`"** — FFmpeg is not on `PATH`. Restart the terminal
after installing; a running shell keeps its old `PATH`.

**Rust rebuilds everything on each `npm run app`** — something is changing
`engine/`'s files. The desktop app depends on the engine by path, so a touched
engine file invalidates the host too.

**The window opens white** — the Vite dev server did not start. Check that port
1420 is free; Tauri is configured with `strictPort`, so it will not silently
pick another.
