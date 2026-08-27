fn main() {
    // A release build is a packaged build, and a packaged app that shipped
    // without its FFmpeg pair has happened once already: everything media-
    // shaped failed at runtime, launched from Finder with no PATH to fall
    // back on. Fail the build instead - staging the binaries is part of
    // building for release (see BUILD.md).
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        let suffix = if cfg!(target_os = "windows") { ".exe" } else { "" };
        let staged = std::path::Path::new("ffmpeg");
        for binary in ["ffmpeg", "ffprobe"] {
            let path = staged.join(format!("{binary}{suffix}"));
            assert!(
                path.is_file(),
                "release build without a bundled {binary}: stage the FFmpeg pair in \
                 desktop/src-tauri/ffmpeg/ first (see BUILD.md), or the packaged app \
                 will ship broken"
            );
        }
        println!("cargo:rerun-if-changed=ffmpeg");
    }

    tauri_build::build()
}
