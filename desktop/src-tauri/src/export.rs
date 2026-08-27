//! Rendering a timeline to a file.
//!
//! This is the seam where the UI's model becomes the engine's: clips arrive as
//! flat JSON, are converted into a `relay_core::Timeline`, and from there the
//! engine decides everything - what is on screen (`relay-render`), what the
//! sound means (`relay_media::audio`), and how bytes move (`relay-media`).
//! Editing semantics deliberately do not live here; this file converts,
//! orchestrates and reports.
//!
//! Picture is composited frame by frame - on the GPU when the machine has one,
//! with the CPU compositor as the always-correct fallback. Sound is planned by
//! the engine as one FFmpeg filtergraph and mixed in a single pass.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use relay_core::frame::Frame;
use relay_core::time::{FrameRate, Rational};
use relay_core::timeline::{Clip, ClipId, MediaRef, Timeline, Track, TrackKind, Transform};
use relay_media::audio::{self, AudioClip};
use relay_media::{
    DecodeOptions, EncodeOptions, FfmpegDecoder, FfmpegEncoder, FrameSink, FrameSource,
};
use relay_render::{Compositor, CpuCompositor, Layer, Placement, WgpuCompositor, plan_frame};
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

/// What the export loop calls to report and to ask "should I stop?".
pub struct Reporter<'a> {
    /// Called with (frame, total, stage).
    pub progress: &'a mut dyn FnMut(i64, i64, &'static str),
    /// Checked between frames and stages; true aborts cleanly.
    pub cancel: &'a AtomicBool,
}

impl Reporter<'_> {
    fn emit(&mut self, frame: i64, total: i64, stage: &'static str) {
        (self.progress)(frame, total, stage);
    }

    fn cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Relaxed) {
            Err("export cancelled".to_owned())
        } else {
            Ok(())
        }
    }
}

/// Renders `request` and returns the path written. Tauri-facing wrapper that
/// reports through the `export://progress` event; the logic is in [`render`].
pub fn run(
    app: &tauri::AppHandle,
    request: ExportRequest,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let mut progress = |frame: i64, total: i64, stage: &'static str| {
        // A dropped progress event is not worth failing an export over.
        let _ = app.emit("export://progress", Progress { frame, total, stage });
    };
    render(&request, Reporter { progress: &mut progress, cancel })
}

/// Renders `request` and returns the path written.
pub fn render(request: &ExportRequest, mut reporter: Reporter<'_>) -> Result<String, String> {
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

    // An unmuted clip can still have no audio stream - a screen recording, a
    // silent render. FFmpeg refuses a filtergraph that names `[N:a]` on such
    // an input rather than treating it as silence, so membership in the mix
    // is decided by probing the file, not by the clip's kind.
    let mut has_audio: HashMap<&str, bool> = HashMap::new();
    sound.retain(|clip| {
        *has_audio.entry(clip.path.as_str()).or_insert_with(|| {
            relay_media::probe(&clip.path).is_ok_and(|info| info.audio.is_some())
        })
    });

    let timeline_end = request
        .clips
        .iter()
        .map(|clip| clip.start + clip.duration)
        .fold(0.0f64, f64::max);
    let total_frames = (timeline_end * rate.fps().as_f64()).round() as i64;
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
        render_picture(request, rate, total_frames, &visible, &silent, &mut reporter)?;

        if sound.is_empty() {
            std::fs::rename(&silent, &output)
                .map_err(|error| format!("could not write {}: {error}", output.display()))?;
            return Ok(());
        }

        reporter.cancelled()?;
        reporter.emit(0, total_frames, "mixing audio");
        let mix: Vec<AudioClip> = sound.iter().map(|clip| audio_clip(clip)).collect();
        audio::mix_to_file(&mix, timeline_end, &mixed).map_err(|error| error.to_string())?;

        reporter.cancelled()?;
        reporter.emit(total_frames, total_frames, "muxing");
        audio::mux(&silent, &mixed, &output).map_err(|error| error.to_string())
    })();

    let _ = std::fs::remove_file(&silent);
    let _ = std::fs::remove_file(&mixed);

    result.map(|()| output.to_string_lossy().into_owned())
}

/// The engine's view of one audible clip.
fn audio_clip(clip: &ExportClip) -> AudioClip {
    AudioClip {
        path: PathBuf::from(&clip.path),
        start: clip.start,
        duration: clip.duration,
        source_start: clip.source_start,
        speed: audio::clamp_speed(clip.speed),
        preserve_pitch: clip.preserve_pitch,
        volume: clip.volume,
        fade_in: clip.fade_in,
        fade_out: clip.fade_out,
        filter_chain: clip.filter_chain.clone(),
    }
}

/// The best compositor this machine offers: the GPU when it has one, the CPU
/// reference otherwise. Never an error - a machine with no adapter renders
/// slower, not not-at-all.
fn best_compositor() -> Box<dyn Compositor> {
    match WgpuCompositor::new() {
        Some(gpu) => Box::new(gpu),
        None => Box::new(CpuCompositor),
    }
}

/// Composites every frame of the timeline into a soundless video file.
fn render_picture(
    request: &ExportRequest,
    rate: FrameRate,
    total_frames: i64,
    visible: &[&ExportClip],
    destination: &Path,
    reporter: &mut Reporter<'_>,
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

    let mut compositor = best_compositor();

    // One decoder per clip, opened at its in-point the first time the clip is
    // needed and dropped the moment it leaves the playhead. Every decoder is
    // opened at `output rate / clip speed`, so pulling exactly one frame per
    // output frame keeps each of them in step with the plan's source times
    // without any seeking - including retimed clips.
    let mut decoders: HashMap<ClipId, FfmpegDecoder> = HashMap::new();

    for index in 0..total_frames {
        reporter.cancelled()?;

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

                    // A retimed clip advances the source by `speed / fps`
                    // seconds per output frame, so the decoder must emit
                    // frames exactly that far apart: a rate of `fps / speed`.
                    // (At 2x, 300 output frames cover 20s of source - the
                    // decoder emits 15 frames per source second, not 60.)
                    let decode_rate = if layer.speed == Rational::ONE {
                        rate
                    } else {
                        FrameRate::new(rate.fps() / layer.speed)
                    };

                    let mut options = DecodeOptions::default()
                        .starting_at(layer.source_time)
                        .scaled_to(decode_width, decode_height)
                        .at_rate(decode_rate);

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
            reporter.emit(index, total_frames, "rendering");
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
        // The same clamp the audio path applies, so a 2x clip means the same
        // thing to picture and sound. A still has no meaningful rate.
        if clip.kind != "image" {
            engine_clip.speed = Rational::approximate(audio::clamp_speed(clip.speed))
                .unwrap_or(Rational::ONE);
        }
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
