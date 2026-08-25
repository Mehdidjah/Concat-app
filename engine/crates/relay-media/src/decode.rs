//! Pulling RGBA frames out of a file.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

use relay_core::frame::Frame;
use relay_core::time::{FrameRate, Rational};

use crate::error::{Error, Result};
use crate::probe;

/// Name used in error messages. The binary actually run comes from
/// [`crate::binaries::ffmpeg`], which may be a bundled copy.
const FFMPEG: &str = "ffmpeg";

/// Anything that yields frames in order.
///
/// The engine is written against this rather than against [`FfmpegDecoder`], so
/// that a GPU-decode backend can be dropped in later, and so that tests can
/// feed synthetic frames without touching the disk.
pub trait FrameSource {
    /// Width of the frames this source produces.
    fn width(&self) -> u32;

    /// Height of the frames this source produces.
    fn height(&self) -> u32;

    /// The next frame, or `Ok(None)` at the end of the stream.
    fn next_frame(&mut self) -> Result<Option<Frame>>;

    /// When the frame just returned is meant to be shown.
    ///
    /// `None` means the source cannot say. The subprocess backend never can -
    /// raw video carries no timestamps - which is exactly why variable frame
    /// rate material desyncs through a pipe. A linked decoder reports the real
    /// presentation timestamp.
    fn position(&self) -> Option<Rational> {
        None
    }
}

/// A source that can jump to an arbitrary point.
///
/// Deliberately separate from [`FrameSource`]. Seeking over a pipe would mean
/// respawning the process and decoding forward from a keyframe, which is not
/// the same operation and should not be able to masquerade as one - so the
/// subprocess decoder simply does not implement this.
pub trait SeekableSource: FrameSource {
    /// Moves to `to`, or the nearest decodable point before it.
    ///
    /// The next [`FrameSource::next_frame`] returns the first frame at or
    /// after that point.
    fn seek(&mut self, to: Rational) -> Result<()>;
}

/// How to open a decoder.
#[derive(Clone, Debug, Default)]
pub struct DecodeOptions {
    /// Seek here before the first frame.
    pub start: Option<Rational>,
    /// Stop after this many frames.
    pub max_frames: Option<u64>,
    /// Scale to this size. Defaults to the file's own dimensions.
    pub size: Option<(u32, u32)>,
    /// Resample to this frame rate, duplicating or dropping frames.
    pub frame_rate: Option<FrameRate>,
    /// Repeat the input forever.
    ///
    /// A still image is a one-frame stream: decode it normally and you get a
    /// single frame and then end-of-stream, which on a timeline means the
    /// picture vanishes after 1/30th of a second. Looping makes it behave like
    /// footage of arbitrary length, and the caller stops pulling when the clip
    /// ends.
    pub looping: bool,
}

impl DecodeOptions {
    /// Seeks to `start` before decoding.
    pub fn starting_at(mut self, start: Rational) -> Self {
        self.start = Some(start);
        self
    }

    /// Stops after `count` frames.
    pub fn limited_to(mut self, count: u64) -> Self {
        self.max_frames = Some(count);
        self
    }

    /// Scales output to `width` by `height`.
    pub fn scaled_to(mut self, width: u32, height: u32) -> Self {
        self.size = Some((width, height));
        self
    }

    /// Resamples output to `rate`.
    pub fn at_rate(mut self, rate: FrameRate) -> Self {
        self.frame_rate = Some(rate);
        self
    }

    /// Repeats the input forever. See [`DecodeOptions::looping`].
    pub fn repeating(mut self) -> Self {
        self.looping = true;
        self
    }
}

/// Decodes a file by piping raw RGBA out of an `ffmpeg` child process.
///
/// The child's stderr is inherited rather than captured: reading two pipes from
/// one process without deadlocking needs a second thread, and at `-loglevel
/// error` the only thing it ever prints is the message you want to see anyway.
pub struct FfmpegDecoder {
    path: PathBuf,
    child: Child,
    stdout: ChildStdout,
    width: u32,
    height: u32,
    /// Reused between frames so decoding does not allocate per frame.
    buffer: Vec<u8>,
    produced: u64,
    limit: Option<u64>,
    finished: bool,
}

impl FfmpegDecoder {
    /// Opens `path` for decoding.
    ///
    /// If `options.size` is not set this probes the file first to learn its
    /// dimensions, because the pipe carries raw pixels with no header to say
    /// how big a frame is.
    pub fn open(path: impl AsRef<Path>, options: &DecodeOptions) -> Result<Self> {
        let path = path.as_ref();
        let (width, height) = match options.size {
            Some(size) => size,
            None => {
                let info = probe::probe(path)?;
                let video = info.require_video()?;
                (video.width, video.height)
            }
        };

        let mut command = Command::new(crate::binaries::ffmpeg());
        command.args(["-hide_banner", "-nostdin", "-loglevel", "error"]);

        // Both of these are *input* options and have to precede -i.
        if options.looping {
            command.args(["-loop", "1"]);
        }

        // -ss before -i is the fast seek: FFmpeg jumps to the nearest keyframe
        // and decodes forward, instead of decoding everything and discarding it.
        if let Some(start) = options.start {
            command.args(["-ss", &format!("{:.6}", start.as_f64())]);
        }
        command.arg("-i").arg(path);

        if let Some(limit) = options.max_frames {
            command.args(["-frames:v", &limit.to_string()]);
        }
        if options.size.is_some() {
            command.args(["-vf", &format!("scale={width}:{height}")]);
        }
        if let Some(rate) = options.frame_rate {
            command.args(["-r", &fraction(rate)]);
        }

        command
            .args(["-f", "rawvideo", "-pix_fmt", "rgba", "-"])
            .stdout(Stdio::piped())
            .stdin(Stdio::null())
            .stderr(Stdio::inherit());

        let mut child =
            command.spawn().map_err(|source| Error::Spawn { program: FFMPEG, source })?;
        let stdout = child.stdout.take().expect("stdout was piped");

        Ok(Self {
            path: path.to_path_buf(),
            child,
            stdout,
            width,
            height,
            buffer: vec![0u8; Frame::byte_len(width, height)],
            produced: 0,
            limit: options.max_frames,
            finished: false,
        })
    }

    /// How many frames have been produced so far.
    pub const fn produced(&self) -> u64 {
        self.produced
    }

    /// Reaps the child and turns a non-zero exit into an error.
    fn finish(&mut self) -> Result<()> {
        if self.finished {
            return Ok(());
        }
        self.finished = true;
        let status = self.child.wait().map_err(|source| Error::Io { program: FFMPEG, source })?;
        if status.success() {
            Ok(())
        } else {
            Err(Error::Exited { program: FFMPEG, path: self.path.clone(), status })
        }
    }
}

impl FrameSource for FfmpegDecoder {
    fn width(&self) -> u32 {
        self.width
    }

    fn height(&self) -> u32 {
        self.height
    }

    fn next_frame(&mut self) -> Result<Option<Frame>> {
        if self.finished || self.limit.is_some_and(|limit| self.produced >= limit) {
            return Ok(None);
        }

        // read_exact would collapse a clean end-of-stream and a truncated frame
        // into the same error, and those mean very different things here.
        let mut filled = 0;
        while filled < self.buffer.len() {
            match self.stdout.read(&mut self.buffer[filled..]) {
                Ok(0) => break,
                Ok(read) => filled += read,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(source) => return Err(Error::Io { program: FFMPEG, source }),
            }
        }

        if filled == 0 {
            self.finish()?;
            return Ok(None);
        }
        if filled < self.buffer.len() {
            let error = Error::PartialFrame {
                path: self.path.clone(),
                got: filled,
                want: self.buffer.len(),
            };
            let _ = self.finish();
            return Err(error);
        }

        self.produced += 1;
        Ok(Some(
            Frame::from_rgba(self.width, self.height, self.buffer.clone())
                .expect("buffer is sized from the same width and height"),
        ))
    }
}

impl Drop for FfmpegDecoder {
    fn drop(&mut self) {
        // Dropping a decoder mid-stream is normal - a scrub replaces it. Kill
        // the child rather than leaking an ffmpeg process per seek.
        if !self.finished {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

/// Formats a frame rate as an exact `num/den` fraction. FFmpeg accepts these,
/// so 29.97 stays 30000/1001 all the way through.
fn fraction(rate: FrameRate) -> String {
    let fps = rate.fps();
    format!("{}/{}", fps.numerator(), fps.denominator())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_rates_reach_ffmpeg_as_exact_fractions() {
        assert_eq!(fraction(FrameRate::NTSC_30), "30000/1001");
        assert_eq!(fraction(FrameRate::THIRTY), "30/1");
    }

    #[test]
    fn options_build_up() {
        let options = DecodeOptions::default()
            .starting_at(Rational::from_int(2))
            .limited_to(10)
            .scaled_to(640, 360);
        assert_eq!(options.start, Some(Rational::from_int(2)));
        assert_eq!(options.max_frames, Some(10));
        assert_eq!(options.size, Some((640, 360)));
    }

    #[test]
    fn a_missing_ffmpeg_is_a_spawn_error_not_a_panic() {
        // Nothing to assert about the happy path without a fixture file, but
        // the error path must stay a Result.
        let result = FfmpegDecoder::open("does-not-exist.mp4", &DecodeOptions::default());
        assert!(result.is_err());
    }
}
