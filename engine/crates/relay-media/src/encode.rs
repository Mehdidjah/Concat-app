//! Writing RGBA frames back out to a file.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};

use relay_core::frame::Frame;
use relay_core::time::FrameRate;

use crate::error::{Error, Result};

const FFMPEG: &str = "ffmpeg";

/// Anything that accepts finished frames.
///
/// The mirror of [`FrameSource`](crate::decode::FrameSource): render code
/// writes to this trait, so an export target, a preview window and a test spy
/// are interchangeable.
pub trait FrameSink {
    /// Accepts one frame. Frames must all be the size the sink was opened with.
    fn write_frame(&mut self, frame: &Frame) -> Result<()>;

    /// Flushes and closes. Always call this - a dropped sink produces a
    /// truncated file, because the encoder never got to write its trailer.
    fn finish(&mut self) -> Result<()>;
}

/// Encoder settings.
#[derive(Clone, Debug)]
pub struct EncodeOptions {
    /// Video codec, as FFmpeg names it.
    pub codec: String,
    /// x264-style speed/size tradeoff.
    pub preset: String,
    /// Constant rate factor. Lower is better quality and a bigger file.
    pub crf: u8,
    /// Output pixel format. `yuv420p` is what players actually accept.
    pub pixel_format: String,
}

impl Default for EncodeOptions {
    fn default() -> Self {
        Self {
            codec: "libx264".to_owned(),
            preset: "medium".to_owned(),
            crf: 18,
            pixel_format: "yuv420p".to_owned(),
        }
    }
}

/// Encodes by piping raw RGBA into an `ffmpeg` child process.
pub struct FfmpegEncoder {
    path: PathBuf,
    child: Child,
    /// Taken in `finish` - closing the pipe is what tells FFmpeg to stop.
    stdin: Option<ChildStdin>,
    width: u32,
    height: u32,
    written: u64,
}

impl FfmpegEncoder {
    /// Opens `path` for writing, overwriting anything already there.
    pub fn create(
        path: impl AsRef<Path>,
        width: u32,
        height: u32,
        frame_rate: FrameRate,
        options: &EncodeOptions,
    ) -> Result<Self> {
        let path = path.as_ref();
        let fps = frame_rate.fps();

        let mut command = Command::new(FFMPEG);
        command
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"])
            // Input: what is coming down the pipe.
            .args(["-f", "rawvideo", "-pix_fmt", "rgba"])
            .args(["-s", &format!("{width}x{height}")])
            .args(["-r", &format!("{}/{}", fps.numerator(), fps.denominator())])
            .args(["-i", "-"])
            // Output.
            .args(["-c:v", &options.codec])
            .args(["-preset", &options.preset])
            .args(["-crf", &options.crf.to_string()])
            .args(["-pix_fmt", &options.pixel_format])
            .args(["-movflags", "+faststart"])
            .arg(path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());

        let mut child =
            command.spawn().map_err(|source| Error::Spawn { program: FFMPEG, source })?;
        let stdin = child.stdin.take().expect("stdin was piped");

        Ok(Self { path: path.to_path_buf(), child, stdin: Some(stdin), width, height, written: 0 })
    }

    /// How many frames have been accepted so far.
    pub const fn written(&self) -> u64 {
        self.written
    }
}

impl FrameSink for FfmpegEncoder {
    fn write_frame(&mut self, frame: &Frame) -> Result<()> {
        if frame.width() != self.width || frame.height() != self.height {
            // Raw video has no framing, so a wrong-sized frame would not fail
            // here - it would silently shear every frame after it.
            return Err(Error::FrameSizeMismatch {
                want_width: self.width,
                want_height: self.height,
                got_width: frame.width(),
                got_height: frame.height(),
            });
        }

        let Some(stdin) = self.stdin.as_mut() else {
            return Err(Error::Io {
                program: FFMPEG,
                source: std::io::Error::other("encoder was already finished"),
            });
        };

        stdin
            .write_all(frame.pixels())
            .map_err(|source| Error::Io { program: FFMPEG, source })?;
        self.written += 1;
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        // Closing stdin is the signal to flush and write the trailer.
        drop(self.stdin.take());

        let status = self.child.wait().map_err(|source| Error::Io { program: FFMPEG, source })?;
        if status.success() {
            Ok(())
        } else {
            Err(Error::Exited { program: FFMPEG, path: self.path.clone(), status })
        }
    }
}

impl Drop for FfmpegEncoder {
    fn drop(&mut self) {
        if self.stdin.is_some() {
            // finish() was never called, so the output is garbage anyway.
            // Kill the child instead of blocking a drop on an encode flush.
            drop(self.stdin.take());
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_a_playable_h264_file() {
        let options = EncodeOptions::default();
        assert_eq!(options.codec, "libx264");
        assert_eq!(options.pixel_format, "yuv420p", "yuv444 will not play in browsers");
    }

    #[test]
    fn a_wrong_sized_frame_is_rejected() {
        let Ok(mut encoder) = FfmpegEncoder::create(
            std::env::temp_dir().join("relay-encode-size-test.mp4"),
            64,
            64,
            FrameRate::THIRTY,
            &EncodeOptions::default(),
        ) else {
            // No FFmpeg on this machine; nothing to assert.
            return;
        };

        let wrong = Frame::black(32, 32);
        assert!(matches!(
            encoder.write_frame(&wrong),
            Err(Error::FrameSizeMismatch { got_width: 32, .. })
        ));
    }
}
