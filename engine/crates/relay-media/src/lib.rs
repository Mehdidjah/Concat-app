//! Media IO: reading frames out of files and writing them back.
//!
//! This is the only crate that knows FFmpeg exists, and it talks to it as a
//! child process rather than through FFI. See
//! `docs/decisions/0002-ffmpeg-over-a-pipe.md` for the reasoning and the exit
//! criteria.
//!
//! Everything process-shaped hides behind two traits, [`FrameSource`] and
//! [`FrameSink`]. A future GPU-decode or FFI backend implements those two and
//! nothing else in the workspace changes.

pub mod decode;
pub mod encode;
pub mod error;
pub mod probe;

pub use decode::{DecodeOptions, FfmpegDecoder, FrameSource};
pub use encode::{EncodeOptions, FfmpegEncoder, FrameSink};
pub use error::{Error, Result};
pub use probe::{AudioStream, MediaInfo, VideoStream, probe};
