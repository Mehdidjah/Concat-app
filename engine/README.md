# Relay Engine

The video engine behind Relay. Rust, no GC, no hidden control flow.

## Layout

| Crate | What it is | Dependencies |
|---|---|---|
| `relay-core` | Time, arena, frames, timeline model. The vocabulary every other crate speaks. | **none** (std only) |
| `relay-media` | Getting pixels in and out of files. FFmpeg lives here and nowhere else. | `relay-core`, serde_json |
| `relay-render` | Turning a timeline plus a timestamp into one finished frame. | `relay-core` |
| `relay-cli` | A binary to drive the above. The vertical slice. | all of them |

The dependency arrows point one way: `cli -> {media, render} -> core`. If you ever
find yourself wanting `core` to depend on `media`, something has been put in the
wrong crate.

## Build and run

```sh
cargo build
cargo test
cargo run -p relay-cli -- probe some-video.mp4
cargo run -p relay-cli -- demo some-video.mp4 out.mp4 --frames 120
```

Requires `ffmpeg` and `ffprobe` on `PATH`.

## Reading this codebase cold

1. `docs/decisions/` - short notes on why things are the way they are. Read these first.
2. `crates/*/src/lib.rs` - every crate opens with a `//!` block saying what it is for.
3. `cargo doc --open` - the generated API map of the whole engine.

## Conventions

- **Time is exact.** All timestamps are `relay_core::time::Rational` seconds, never `f64`.
  Frame-accurate editing and floating point do not mix.
- **Graphs use handles, not pointers.** See decision 0003.
- **Shallow generics.** Concrete types until three call sites demand otherwise.
- **Threads, not async.** The render path is CPU-bound; `async` buys nothing here.
