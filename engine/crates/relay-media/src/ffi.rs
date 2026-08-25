//! Linked FFmpeg, as opposed to spawned FFmpeg.
//!
//! This backend exists for the two things a pipe fundamentally cannot do:
//! report a frame's real presentation timestamp, and seek to an exact frame.
//! Both are needed for playback and scrubbing; neither matters for probing or
//! export, which is why the subprocess backend is not going anywhere.
//!
//! Only compiled with the `ffi` feature. See
//! `docs/decisions/0002-ffmpeg-over-a-pipe.md`.

use std::ffi::CStr;

/// The version of FFmpeg this binary is linked against.
///
/// Cheap, and the first thing worth checking when something behaves oddly: it
/// proves which library actually loaded, which is not always the one you think
/// on a machine with several FFmpeg installs.
pub fn linked_version() -> String {
    // SAFETY: av_version_info returns a pointer to a static, NUL-terminated
    // string compiled into the library. It is valid for the process lifetime
    // and never freed, so borrowing it here cannot dangle.
    let raw = unsafe { rusty_ffmpeg::ffi::av_version_info() };
    if raw.is_null() {
        return "unknown".to_owned();
    }

    // SAFETY: checked non-null above, and the contract of av_version_info is a
    // NUL-terminated C string.
    unsafe { CStr::from_ptr(raw) }.to_string_lossy().into_owned()
}

/// Major version of the linked `libavcodec`.
///
/// Read from the library at runtime rather than from the headers, so a
/// mismatch between what we compiled against and what actually loaded shows up
/// as a number rather than as undefined behaviour.
pub fn avcodec_major() -> u32 {
    // SAFETY: a pure accessor returning a packed integer; no pointers involved.
    unsafe { rusty_ffmpeg::ffi::avcodec_version() >> 16 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_against_the_expected_ffmpeg() {
        let version = linked_version();
        assert!(!version.is_empty(), "av_version_info returned nothing");

        // The bindings rusty_ffmpeg ships are generated for avcodec 62
        // (FFmpeg 8.x). Loading a different major version would mean the
        // struct layouts we compiled against do not match the library that
        // actually loaded - which corrupts silently rather than failing, so
        // it is worth an explicit check.
        assert_eq!(
            avcodec_major(),
            62,
            "linked libavcodec is {} but the bindings expect 62 - see BUILD.md",
            avcodec_major()
        );
    }
}
