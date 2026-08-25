//! Tauri host for the Relay editor.
//!
//! Deliberately thin. Every command here does two things: call into the engine
//! crates, and convert the result to something `serde` can put on the wire.
//! No editing logic lives on this side of the bridge - if a command starts
//! making decisions about the edit, that logic belongs in `relay-core` or
//! `relay-render` where it can be unit-tested without a window.

mod export;
mod projects;

use serde::Serialize;

/// A video stream, as the UI sees it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    index: u32,
    codec: String,
    width: u32,
    height: u32,
    /// Decimal fps, for display only.
    frame_rate: f64,
    /// The exact fraction the engine actually works in, e.g. "30000/1001".
    frame_rate_fraction: String,
}

/// An audio stream, as the UI sees it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    index: u32,
    codec: String,
    sample_rate: u32,
    channels: u32,
}

/// What `probe_media` hands back.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSummary {
    path: String,
    duration: Option<f64>,
    /// "video", "audio" or "image".
    kind: &'static str,
    video: Option<VideoStreamInfo>,
    audio: Option<AudioStreamInfo>,
}

/// Extensions Relay is willing to treat as stills.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif", "gif",
];

/// Decides whether a file is footage, sound or a still.
///
/// Extension first, because that is what the user means by "a png", and
/// ffprobe is genuinely ambiguous here: a PNG presents as a one-frame video
/// stream, usually with `r_frame_rate` of 25/1 invented by the demuxer.
///
/// The duration check is what separates a still from an animation. An animated
/// GIF or WebP reports a duration; a single image does not. It is a heuristic,
/// and a deliberately conservative one - misreading an animation as a still
/// shows its first frame rather than failing.
fn classify(info: &relay_media::MediaInfo) -> &'static str {
    if info.video.is_none() {
        return "audio";
    }

    let extension = info
        .path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if IMAGE_EXTENSIONS.contains(&extension.as_str()) && info.duration.is_none() {
        "image"
    } else {
        "video"
    }
}

impl From<relay_media::MediaInfo> for MediaSummary {
    fn from(info: relay_media::MediaInfo) -> Self {
        Self {
            kind: classify(&info),
            path: info.path.to_string_lossy().into_owned(),
            // Exact rational time stops at this boundary: JSON has no
            // fractions, and the UI only ever displays these numbers.
            duration: info.duration.map(|duration| duration.as_f64()),
            video: info.video.map(|video| VideoStreamInfo {
                index: video.index,
                codec: video.codec,
                width: video.width,
                height: video.height,
                frame_rate: video.frame_rate.fps().as_f64(),
                frame_rate_fraction: format!(
                    "{}/{}",
                    video.frame_rate.fps().numerator(),
                    video.frame_rate.fps().denominator()
                ),
            }),
            audio: info.audio.map(|audio| AudioStreamInfo {
                index: audio.index,
                codec: audio.codec,
                sample_rate: audio.sample_rate,
                channels: audio.channels,
            }),
        }
    }
}

/// Reports what is inside a media file.
#[tauri::command]
fn probe_media(path: String) -> Result<MediaSummary, String> {
    relay_media::probe(&path).map(MediaSummary::from).map_err(describe)
}

/// The version of the app the UI is talking to. Also a liveness check on the
/// IPC bridge at startup.
#[tauri::command]
fn engine_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// Reads a whole file and returns it as raw bytes.
///
/// This exists only as the audio preview's fallback for when the asset
/// protocol is unavailable. `tauri::ipc::Response` puts the bytes on the wire
/// as an ArrayBuffer rather than a JSON array of numbers, which for a few
/// megabytes of audio is the difference between instant and unusable.
///
/// It loads the entire file into memory, so it is not a general-purpose
/// reader and must not become one.
#[tauri::command]
fn read_media_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|error| format!("could not read {path}: {error}"))
}

/// Renders a strip of evenly spaced frames from a video as one JPEG.
///
/// One image rather than N, because the timeline draws the frames as slices of
/// a single texture - that is one decode and one cached bitmap instead of
/// twenty-four of each.
///
/// `fps=count/duration` is what spaces the frames evenly, and `tile` lays them
/// out side by side. If the container reports no duration there is nothing to
/// space frames across, so this refuses rather than guessing.
#[tauri::command]
async fn extract_filmstrip(path: String, count: u32, height: u32) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || filmstrip(&path, count, height))
        .await
        .map_err(|error| format!("filmstrip task failed: {error}"))??;

    Ok(tauri::ipc::Response::new(bytes))
}

fn filmstrip(path: &str, count: u32, height: u32) -> Result<Vec<u8>, String> {
    let count = count.clamp(1, 60);
    let height = height.clamp(16, 240);

    let info = relay_media::probe(path).map_err(describe)?;
    let duration = info
        .duration
        .map(|duration| duration.as_f64())
        .filter(|seconds| *seconds > 0.0)
        .ok_or_else(|| format!("{path} reports no duration"))?;

    let output = std::process::Command::new(relay_media::ffmpeg())
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(["-i", path])
        .args([
            "-vf",
            // scale=-2 keeps the aspect ratio and an even width, which the
            // JPEG encoder requires.
            &format!(
                "fps={:.6},scale=-2:{height},tile={count}x1",
                f64::from(count) / duration
            ),
        ])
        .args(["-frames:v", "1", "-q:v", "6", "-f", "mjpeg", "-"])
        .output()
        .map_err(|error| format!("could not run ffmpeg: {error}"))?;

    if !output.status.success() {
        return Err(format!("ffmpeg exited with {} for {path}", output.status));
    }
    if output.stdout.is_empty() {
        return Err(format!("ffmpeg produced no filmstrip for {path}"));
    }

    Ok(output.stdout)
}

/// Creates a project folder, writes its manifest and records it as recent.
#[tauri::command]
async fn create_project(
    app: tauri::AppHandle,
    location: String,
    name: String,
    width: u32,
    height: u32,
    rate_num: i64,
    rate_den: i64,
) -> Result<projects::ProjectInfo, String> {
    let config = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let project = projects::create(&location, &name, width, height, rate_num, rate_den)?;
        // A project that cannot be added to the recents list has still been
        // created, so this failure is reported but not fatal.
        if let Err(error) = projects::remember(&config, &project) {
            eprintln!("relay: {error}");
        }
        Ok(project)
    })
    .await
    .map_err(|error| format!("create_project task failed: {error}"))?
}

/// Reads an existing project and moves it to the front of the recents list.
#[tauri::command]
async fn open_project(app: tauri::AppHandle, path: String) -> Result<projects::ProjectInfo, String> {
    let config = config_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let project = projects::open(&path)?;
        if let Err(error) = projects::remember(&config, &project) {
            eprintln!("relay: {error}");
        }
        Ok(project)
    })
    .await
    .map_err(|error| format!("open_project task failed: {error}"))?
}

/// The recents list, most recent first, with vanished folders left out.
#[tauri::command]
fn recent_projects(app: tauri::AppHandle) -> Result<Vec<projects::ProjectInfo>, String> {
    Ok(projects::list(&config_dir(&app)?))
}

/// Removes a project from the recents list. The folder itself is left alone.
#[tauri::command]
fn forget_project(app: tauri::AppHandle, path: String) -> Result<(), String> {
    projects::forget(&config_dir(&app)?, &path)
}

fn config_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map_err(|error| format!("could not locate the config directory: {error}"))
}

/// Renders the timeline to a file.
///
/// Runs on a blocking thread and reports progress through the
/// `export://progress` event, because a two-minute export must not freeze the
/// window and gives the UI nothing to show if it says nothing until it is done.
#[tauri::command]
async fn export_project(
    app: tauri::AppHandle,
    request: export::ExportRequest,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export::run(&app, request))
        .await
        .map_err(|error| format!("export task failed: {error}"))?
}

/// Flattens an error and its causes into one line.
///
/// `Display` on a `thiserror` enum prints only the outermost message, and the
/// useful half - what FFmpeg or the OS actually said - is in the source chain.
fn describe(error: relay_media::Error) -> String {
    use std::error::Error;

    let mut message = error.to_string();
    let mut cause = error.source();
    while let Some(current) = cause {
        message.push_str(&format!(": {current}"));
        cause = current.source();
    }
    message
}

/// Points the engine at the bundled FFmpeg, if there is one.
///
/// Tauri drops sidecar binaries next to the app executable with the target
/// triple stripped, so this looks for them there and silently leaves the
/// engine on its `PATH` default otherwise. That fallback is what keeps
/// `cargo run` working without copying binaries into the build directory.
///
/// Both must be present to switch: a bundled decoder paired with whatever
/// `ffprobe` happens to be on PATH is a version mismatch waiting to happen.
fn use_bundled_ffmpeg() {
    let Ok(executable) = std::env::current_exe() else { return };
    let Some(directory) = executable.parent() else { return };

    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let ffmpeg = directory.join(format!("ffmpeg{suffix}"));
    let ffprobe = directory.join(format!("ffprobe{suffix}"));

    if ffmpeg.is_file() && ffprobe.is_file() {
        relay_media::set_binaries(ffmpeg, ffprobe);
    }
}

/// Builds and runs the editor window.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use_bundled_ffmpeg();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            probe_media,
            engine_version,
            read_media_bytes,
            extract_filmstrip,
            create_project,
            open_project,
            recent_projects,
            forget_project,
            export_project
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
