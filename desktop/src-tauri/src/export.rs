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
use relay_core::timeline::{Clip, ClipId, MediaRef, Timeline, Track, TrackKind, Transform};
use relay_media::{
    DecodeOptions, EncodeOptions, FfmpegDecoder, FfmpegEncoder, FrameSink, FrameSource,
};
use relay_render::{Compositor, CpuCompositor, Layer, Placement, plan_frame};
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
    /// Playback rate. 1 is normal.
    #[serde(default = "unity")]
    pub speed: f64,
    /// False lets pitch rise with the rate, like tape.
    #[serde(default = "yes")]
    pub preserve_pitch: bool,
    /// Multiplier over the fitted size. 1 fills the frame, preserving aspect.
    #[serde(default = "unity")]
    pub scale: f64,
    /// Offset of the picture's centre from frame centre, frame-width fraction.
    #[serde(default)]
    pub offset_x: f64,
    /// Offset as a frame-height fraction.
    #[serde(default)]
    pub offset_y: f64,
    /// Clockwise rotation in degrees.
    #[serde(default)]
    pub rotation: f64,
    /// The source's pixel size, when the UI knows it. What makes an
    /// aspect-correct decode possible - absent, the frame is filled edge to
    /// edge the way it always was.
    #[serde(default)]
    pub media_width: Option<u32>,
    #[serde(default)]
    pub media_height: Option<u32>,
}

fn yes() -> bool {
    true
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
    let (timeline, stills, decode_sizes) = build_timeline(request, rate, visible);

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

        let mut sources: Vec<(Frame, f32, Transform)> = Vec::with_capacity(plan.layers.len());
        for layer in &plan.layers {
            let decoder = match decoders.entry(layer.clip) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    // Aspect-correct: decode at the source's fitted size and
                    // let the compositor place it, rather than stretching to
                    // the frame and losing the picture's shape.
                    let (decode_width, decode_height) = decode_sizes
                        .get(&layer.clip)
                        .copied()
                        .unwrap_or((request.width, request.height));
                    let mut options = DecodeOptions::default()
                        .starting_at(layer.source_time)
                        .scaled_to(decode_width, decode_height)
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
                sources.push((frame, layer.opacity, layer.transform));
            }
        }

        let layers: Vec<Layer<'_>> = sources
            .iter()
            .map(|(frame, opacity, transform)| {
                // Fitted and centred is the base; the clip's transform moves
                // it from there. The fraction-to-pixel conversion happens
                // here and nowhere else.
                let x = (i64::from(request.width) - i64::from(frame.width())) / 2;
                let y = (i64::from(request.height) - i64::from(frame.height())) / 2;
                let placement = if transform.is_identity() {
                    Placement::IDENTITY
                } else {
                    Placement {
                        scale: transform.scale as f32,
                        rotation: transform.rotation.to_radians() as f32,
                        translate_x: (transform.offset_x * f64::from(request.width)) as f32,
                        translate_y: (transform.offset_y * f64::from(request.height)) as f32,
                    }
                };
                Layer::new(frame)
                    .at(x as i32, y as i32)
                    .with_opacity(*opacity)
                    .with_placement(placement)
            })
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
) -> (
    Timeline,
    std::collections::HashSet<ClipId>,
    HashMap<ClipId, (u32, u32)>,
) {
    let mut timeline = Timeline::new(request.width, request.height, rate);
    let mut stills = std::collections::HashSet::new();
    let mut decode_sizes: HashMap<ClipId, (u32, u32)> = HashMap::new();

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
        engine_clip.transform = Transform {
            scale: clip.scale,
            offset_x: clip.offset_x,
            offset_y: clip.offset_y,
            rotation: clip.rotation,
        };

        if let Some(id) = timeline.add_clip(tracks[clip.track], engine_clip) {
            if clip.kind == "image" {
                stills.insert(id);
            }
            if let Some(size) = fitted_size(request, clip) {
                decode_sizes.insert(id, size);
            }
        }
    }

    (timeline, stills, decode_sizes)
}

/// The source's contain-fitted size inside the output frame, or `None` when
/// the UI never learnt the source's dimensions.
fn fitted_size(request: &ExportRequest, clip: &ExportClip) -> Option<(u32, u32)> {
    let media_width = clip.media_width.filter(|value| *value > 0)?;
    let media_height = clip.media_height.filter(|value| *value > 0)?;

    let fit = (f64::from(request.width) / f64::from(media_width))
        .min(f64::from(request.height) / f64::from(media_height));
    let width = ((f64::from(media_width) * fit).round() as u32).max(2);
    let height = ((f64::from(media_height) * fit).round() as u32).max(2);
    // Even, because a decoder asked for an odd width may round it itself and
    // then every frame read is misaligned by a pixel's worth of bytes.
    Some((width & !1, height & !1))
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
        // A sped-up clip covers more source than its timeline length, so the
        // trim has to take `duration * speed` before the rate is applied.
        let speed = clip.speed.clamp(0.1, 8.0);
        let mut stage = format!(
            "[{index}:a]atrim=start={:.6}:duration={:.6},asetpts=PTS-STARTPTS",
            clip.source_start,
            clip.duration * speed
        );

        if (speed - 1.0).abs() > f64::EPSILON {
            if clip.preserve_pitch {
                // atempo time-stretches, leaving pitch alone. Its per-instance
                // range is limited, so a large change is split into stages
                // that multiply out to the requested rate.
                for factor in tempo_stages(speed) {
                    stage.push_str(&format!(",atempo={factor:.6}"));
                }
            } else {
                // Resampling moves pitch and tempo together - the tape effect.
                stage.push_str(&format!(
                    ",asetrate=48000*{speed:.6},aresample=48000"
                ));
            }
        }

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

    // The `aresample` is load-bearing, and not about sample rates.
    //
    // `atempo` emits a fractional number of samples per frame, and the leftover
    // rides along in the timestamps it produces. Mixing such a branch with an
    // untouched one gave `amix` an output whose timestamps eventually came out
    // as AV_NOPTS_VALUE, and the muxer rejected the packet:
    //
    //     non monotonically increasing dts to muxer: 9223372036854775807
    //
    // The effect was a two-second mix written as a ~40 ms file - so any export
    // of more than one clip, where any clip had a speed other than 1 with
    // "preserve pitch" on, produced a silently truncated soundtrack. The
    // exporter reported success either way, which is how it went unnoticed.
    //
    // Passing the mix through the resampler regenerates one continuous
    // timestamp series from the sample count and absorbs the drift. Verified
    // against every shape this function emits: both speed directions, the
    // multi-stage `atempo` used beyond 2x, the `asetrate` path, several clips
    // at once, and the single-clip `anull` path.
    //
    // Do not "simplify" this away because the rate on both sides is 48000.
    chains.push(format!(
        "{mix};[mixed]aresample=48000,apad,atrim=duration={duration:.6}[out]"
    ));

    command
        .args(["-filter_complex", &chains.join(";")])
        .args(["-map", "[out]"])
        .args(["-c:a", "aac", "-b:a", "192k"])
        .arg(destination);

    run_ffmpeg(command, "mixing audio")
}

/// Splits a rate into `atempo` stages that each stay inside its valid range.
///
/// One filter instance is limited, so 4x has to become 2x then 2x. Multiplying
/// the stages back together is what keeps the result exact.
fn tempo_stages(speed: f64) -> Vec<f64> {
    let mut stages = Vec::new();
    let mut remaining = speed;

    while remaining > 2.0 {
        stages.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        stages.push(0.5);
        remaining /= 0.5;
    }

    stages.push(remaining);
    stages
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tempo_stages_multiply_back_to_the_requested_rate() {
        for speed in [0.25, 0.5, 0.9, 1.0, 1.5, 2.0, 3.0, 4.0, 8.0] {
            let product: f64 = tempo_stages(speed).iter().product();
            assert!(
                (product - speed).abs() < 1e-9,
                "stages for {speed} multiplied to {product}",
            );
        }
    }

    #[test]
    fn every_stage_is_within_the_filter_range() {
        for speed in [0.25, 0.5, 1.0, 4.0, 8.0] {
            for factor in tempo_stages(speed) {
                assert!(
                    (0.5..=2.0).contains(&factor),
                    "{factor} is outside atempo's range, from speed {speed}",
                );
            }
        }
    }
}
