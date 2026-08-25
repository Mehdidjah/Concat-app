//! Rendering a timeline to a file.
//!
//! This is the first thing in the app that uses the engine for what it is for:
//! `relay-render` decides what is on screen at each instant, `relay-media`
//! decodes and encodes, and `relay-core` holds the timeline. The UI's own
//! model is converted into the engine's on the way in, which is a useful
//! rehearsal for the day the engine owns the model outright.
//!
//! Picture and sound take different routes. Picture is composited frame by
//! frame here, because that is the part that needs a compositor. Sound is
//! handed to FFmpeg as one `filter_complex`, because mixing delayed, trimmed
//! audio streams is exactly what it is good at and writing a mixer to do it
//! twice would be silly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use relay_core::frame::Frame;
use relay_core::time::{FrameRate, Rational};
use relay_core::timeline::{Clip, ClipId, MediaRef, Timeline, Track, TrackKind};
use relay_media::{
    DecodeOptions, EncodeOptions, FfmpegDecoder, FfmpegEncoder, FrameSink, FrameSource,
};
use relay_render::{Compositor, CpuCompositor, Layer, plan_frame};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

/// One clip, as the UI describes it.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportClip {
    pub path: String,
    /// "video" or "audio".
    pub kind: String,
    pub start: f64,
    pub duration: f64,
    pub source_start: f64,
    /// Index into the track stack, zero being bottom-most.
    pub track: usize,
    /// The track's picture is switched off.
    pub hidden: bool,
    /// The track's sound is switched off.
    pub muted: bool,
    /// Linear gain, 1 being unity.
    #[serde(default = "unity")]
    pub volume: f64,
    #[serde(default)]
    pub fade_in: f64,
    #[serde(default)]
    pub fade_out: f64,
    /// FFmpeg filter chain from the Filters tab, or empty.
    #[serde(default)]
    pub filter_chain: String,
}

fn unity() -> f64 {
    1.0
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub output: String,
    pub width: u32,
    pub height: u32,
    /// Frame rate as an exact fraction, so 29.97 stays 30000/1001.
    pub rate_num: i64,
    pub rate_den: i64,
    /// Constant rate factor. Lower is better quality and a bigger file.
    pub crf: u8,
    pub preset: String,
    pub clips: Vec<ExportClip>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    frame: i64,
    total: i64,
    stage: &'static str,
}

/// Renders `request` and returns the path written.
pub fn run(app: &tauri::AppHandle, request: ExportRequest) -> Result<String, String> {
    if request.clips.is_empty() {
        return Err("there is nothing on the timeline to export".to_owned());
    }

    let rate = FrameRate::new(Rational::new(request.rate_num, request.rate_den));
    let output = PathBuf::from(&request.output);

    // Stills composite exactly like footage; they only differ in how they are
    // decoded, which is handled where the decoder is opened.
    let visible: Vec<&ExportClip> = request
        .clips
        .iter()
        .filter(|clip| (clip.kind == "video" || clip.kind == "image") && !clip.hidden)
        .collect();
    let audible: Vec<&ExportClip> = request
        .clips
        .iter()
        .filter(|clip| clip.kind == "audio" && !clip.muted)
        .collect();

    // A video clip carries its own sound, so an unmuted video track
    // contributes to the mix as well as to the picture.
    let mut sound: Vec<&ExportClip> = audible;
    sound.extend(
        request
            .clips
            .iter()
            .filter(|clip| clip.kind == "video" && !clip.muted),
    );

    let duration = request
        .clips
        .iter()
        .map(|clip| clip.start + clip.duration)
        .fold(0.0f64, f64::max);
    let total_frames = (duration * rate.fps().as_f64()).round() as i64;
    if total_frames <= 0 {
        return Err("the timeline is empty".to_owned());
    }

    // Render into siblings of the output so the move at the end stays on one
    // filesystem, then clean up whatever we made.
    let stem = output.file_stem().map_or_else(|| "relay".into(), |s| s.to_string_lossy());
    let directory = output.parent().unwrap_or(Path::new("."));
    let silent = directory.join(format!(".{stem}.relay-video.mp4"));
    let mixed = directory.join(format!(".{stem}.relay-audio.m4a"));

    let result = (|| -> Result<(), String> {
        render_picture(app, &request, rate, total_frames, &visible, &silent)?;

        if sound.is_empty() {
            std::fs::rename(&silent, &output)
                .map_err(|error| format!("could not write {}: {error}", output.display()))?;
            return Ok(());
        }

        emit(app, 0, total_frames, "mixing audio");
        mix_audio(&sound, duration, &mixed)?;

        emit(app, total_frames, total_frames, "muxing");
        mux(&silent, &mixed, &output)
    })();

    let _ = std::fs::remove_file(&silent);
    let _ = std::fs::remove_file(&mixed);

    result.map(|()| output.to_string_lossy().into_owned())
}

/// Composites every frame of the timeline into a soundless video file.
fn render_picture(
    app: &tauri::AppHandle,
    request: &ExportRequest,
    rate: FrameRate,
    total_frames: i64,
    visible: &[&ExportClip],
    destination: &Path,
) -> Result<(), String> {
    let (timeline, stills) = build_timeline(request, rate, visible);

    let mut encoder = FfmpegEncoder::create(
        destination,
        request.width,
        request.height,
        rate,
        &EncodeOptions {
            crf: request.crf,
            preset: request.preset.clone(),
            ..EncodeOptions::default()
        },
    )
    .map_err(|error| error.to_string())?;

    let mut compositor = CpuCompositor;

    // One decoder per clip, opened at its in-point the first time the clip is
    // needed and dropped the moment it leaves the playhead. Because every
    // decoder is opened at the output frame rate, pulling exactly one frame
    // per output frame keeps each of them in step without any seeking.
    let mut decoders: HashMap<ClipId, FfmpegDecoder> = HashMap::new();

    for index in 0..total_frames {
        let time = rate.time_of_frame(index);
        let plan = plan_frame(&timeline, time);

        let mut sources: Vec<(Frame, f32)> = Vec::with_capacity(plan.layers.len());
        for layer in &plan.layers {
            let decoder = match decoders.entry(layer.clip) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let mut options = DecodeOptions::default()
                        .starting_at(layer.source_time)
                        .scaled_to(request.width, request.height)
                        .at_rate(rate);

                    // A still is a one-frame stream. Without looping it would
                    // contribute a single frame and then disappear.
                    if stills.contains(&layer.clip) {
                        options = options.repeating().starting_at(Rational::ZERO);
                    }

                    entry.insert(
                        FfmpegDecoder::open(&layer.media, &options)
                            .map_err(|error| error.to_string())?,
                    )
                }
            };

            // A source that has run out contributes nothing rather than
            // aborting the export - a clip trimmed past its media's end is a
            // mistake in the edit, not a failure of the renderer.
            if let Some(frame) = decoder.next_frame().map_err(|error| error.to_string())? {
                sources.push((frame, layer.opacity));
            }
        }

        let layers: Vec<Layer<'_>> = sources
            .iter()
            .map(|(frame, opacity)| Layer::new(frame).with_opacity(*opacity))
            .collect();

        let composed = compositor.composite(request.width, request.height, &layers);
        encoder.write_frame(&composed).map_err(|error| error.to_string())?;

        // Retire decoders whose clip has finished, so a long timeline does not
        // hold an ffmpeg process open for every clip it has ever passed.
        let live: Vec<ClipId> = plan.layers.iter().map(|layer| layer.clip).collect();
        decoders.retain(|clip, _| live.contains(clip));

        if index % 15 == 0 {
            emit(app, index, total_frames, "rendering");
        }
    }

    encoder.finish().map_err(|error| error.to_string())
}

/// Converts the UI's flat clip list into an engine timeline.
///
/// Also returns which clips are stills, because that is knowledge the engine's
/// timeline has no field for and the decoder needs.
fn build_timeline(
    request: &ExportRequest,
    rate: FrameRate,
    visible: &[&ExportClip],
) -> (Timeline, std::collections::HashSet<ClipId>) {
    let mut timeline = Timeline::new(request.width, request.height, rate);
    let mut stills = std::collections::HashSet::new();

    let lanes = visible.iter().map(|clip| clip.track).max().unwrap_or(0) + 1;
    let tracks: Vec<_> = (0..lanes)
        .map(|index| timeline.add_track(Track::new(format!("T{index}"), TrackKind::Video)))
        .collect();

    for clip in visible {
        // Quantise to the frame grid on the way in. The UI works in f64
        // seconds; the engine works in exact rationals, and this is the seam
        // where a value stops being approximate.
        let start = quantise(clip.start, rate);
        let duration = quantise(clip.duration, rate);
        if duration.is_zero() {
            continue;
        }

        let mut engine_clip = Clip::new(MediaRef::new(&clip.path), start, duration);
        engine_clip.source_start = quantise(clip.source_start, rate);

        if let Some(id) = timeline.add_clip(tracks[clip.track], engine_clip) {
            if clip.kind == "image" {
                stills.insert(id);
            }
        }
    }

    (timeline, stills)
}

fn quantise(seconds: f64, rate: FrameRate) -> Rational {
    rate.time_of_frame((seconds * rate.fps().as_f64()).round().max(0.0) as i64)
}

/// Trims, delays and mixes every audible clip into one track.
fn mix_audio(clips: &[&ExportClip], duration: f64, destination: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new(relay_media::ffmpeg());
    command.args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"]);

    for clip in clips {
        command.args(["-i", &clip.path]);
    }

    // Each input is trimmed to its in-point, restamped from zero, then delayed
    // to where it sits on the timeline. `all=1` applies the delay to every
    // channel; without it only the left channel moves, which is a memorable
    // way to discover the flag exists.
    let mut chains: Vec<String> = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        let delay_ms = (clip.start * 1000.0).round().max(0.0) as i64;

        // Gain and fades sit between the restamp and the delay: after the
        // restamp so the fade times are measured from the clip's own start,
        // and before the delay so they are not pushed along with it.
        let mut stage = format!(
            "[{index}:a]atrim=start={:.6}:duration={:.6},asetpts=PTS-STARTPTS",
            clip.source_start, clip.duration
        );

        // Filters first: they are what the clip *is* now, and gain and fades
        // are adjustments applied to that result. Reversing the order would
        // let a compressor inside a filter chain undo the fade.
        if !clip.filter_chain.is_empty() {
            stage.push(',');
            stage.push_str(&clip.filter_chain);
        }

        if (clip.volume - 1.0).abs() > f64::EPSILON {
            stage.push_str(&format!(",volume={:.4}", clip.volume.max(0.0)));
        }
        if clip.fade_in > 0.0 {
            stage.push_str(&format!(",afade=t=in:st=0:d={:.4}", clip.fade_in));
        }
        if clip.fade_out > 0.0 {
            let start = (clip.duration - clip.fade_out).max(0.0);
            stage.push_str(&format!(",afade=t=out:st={start:.4}:d={:.4}", clip.fade_out));
        }

        stage.push_str(&format!(",adelay={delay_ms}:all=1[a{index}]"));
        chains.push(stage);
    }

    let inputs: String = (0..clips.len()).map(|index| format!("[a{index}]")).collect();
    let mix = if clips.len() == 1 {
        // amix with one input would still apply its normalisation curve.
        format!("{inputs}anull[mixed]")
    } else {
        format!("{inputs}amix=inputs={}:normalize=0[mixed]", clips.len())
    };
    chains.push(format!("{mix};[mixed]apad,atrim=duration={duration:.6}[out]"));

    command
        .args(["-filter_complex", &chains.join(";")])
        .args(["-map", "[out]"])
        .args(["-c:a", "aac", "-b:a", "192k"])
        .arg(destination);

    run_ffmpeg(command, "mixing audio")
}

fn mux(video: &Path, audio: &Path, output: &Path) -> Result<(), String> {
    let mut command = std::process::Command::new(relay_media::ffmpeg());
    command
        .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-y"])
        .arg("-i")
        .arg(video)
        .arg("-i")
        .arg(audio)
        // The picture is already encoded exactly as asked; re-encoding it here
        // would cost a second full pass and a generation of quality.
        .args(["-c:v", "copy", "-c:a", "copy", "-shortest"])
        .args(["-movflags", "+faststart"])
        .arg(output);

    run_ffmpeg(command, "muxing")
}

fn run_ffmpeg(mut command: std::process::Command, stage: &str) -> Result<(), String> {
    let output = command
        .output()
        .map_err(|error| format!("could not run ffmpeg while {stage}: {error}"))?;

    if output.status.success() {
        return Ok(());
    }

    let detail = String::from_utf8_lossy(&output.stderr);
    let tail = detail.lines().rev().take(3).collect::<Vec<_>>().join(" / ");
    Err(format!("ffmpeg failed while {stage}: {tail}"))
}

fn emit(app: &tauri::AppHandle, frame: i64, total: i64, stage: &'static str) {
    // A dropped progress event is not worth failing an export over.
    let _ = app.emit("export://progress", Progress { frame, total, stage });
}
