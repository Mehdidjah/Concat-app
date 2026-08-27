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
    /// Blend strength over the layers beneath, 1 being solid. Defaulted for
    /// requests from a UI that predates it.
    #[serde(default = "unity")]
    pub opacity: f64,
    /// FFmpeg *video* filter chain from the Effects tab, or empty. Applied at
    /// decode, after scaling - see `DecodeOptions::filter_chain`.
    #[serde(default)]
    pub video_filter_chain: String,
    /// The transition into this clip's cut, when the UI put one there. The
    /// clip before it on the same track is found here, by adjacency - the UI
    /// only says what it wants, never how to overlap decoders.
    #[serde(default)]
    pub transition: Option<TransitionSpec>,
    /// Video opacity ramp up from the clip's start, in seconds. Set by
    /// transition resolution below, never by the UI directly.
    #[serde(default)]
    pub video_fade_in: f64,
    /// The source's pixel size, when the UI knows it. What makes an
    /// aspect-correct decode possible - absent, the frame is filled edge to
    /// edge the way it always was.
    #[serde(default)]
    pub media_width: Option<u32>,
    #[serde(default)]
    pub media_height: Option<u32>,
}

/// A transition on the cut into a clip.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransitionSpec {
    /// "cross-fade", "fade-black" or "fade-white". Anything else is ignored.
    pub kind: String,
    /// Seconds the transition covers.
    pub duration: f64,
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

/// Turns per-cut transition requests into things the renderer already knows
/// how to draw: overlapping clips, opacity ramps, and fade filters.
///
/// Track indices are doubled first, so an incoming cross-fade clip gets an
/// odd lane of its own directly above the pair it dissolves over - stacking
/// against every other track is preserved, and nothing else occupies odd
/// lanes. Cuts are collected before anything mutates, so resolving one
/// transition cannot unhook the adjacency test of the next.
fn resolve_transitions(clips: &mut [ExportClip], rate: FrameRate) {
    for clip in clips.iter_mut() {
        clip.track *= 2;
    }

    let fps = rate.fps().as_f64();
    let frame = 1.0 / fps;

    struct Cut {
        incoming: usize,
        outgoing: usize,
        kind: String,
        duration: f64,
    }
    let mut cuts: Vec<Cut> = Vec::new();
    for (incoming, clip) in clips.iter().enumerate() {
        let Some(transition) = &clip.transition else { continue };
        if clip.hidden || (clip.kind != "video" && clip.kind != "image") {
            continue;
        }
        // The outgoing clip is whatever ends where this one starts, on the
        // same lane. No match - the cut was edited apart - means the
        // transition is silently orphaned, exactly like the UI treats it.
        let outgoing = clips.iter().position(|other| {
            !other.hidden
                && (other.kind == "video" || other.kind == "image")
                && other.track == clip.track
                && (other.start + other.duration - clip.start).abs() < frame / 2.0
        });
        match outgoing {
            Some(outgoing) if outgoing != incoming => cuts.push(Cut {
                incoming,
                outgoing,
                kind: transition.kind.clone(),
                duration: transition.duration.max(0.0),
            }),
            _ => {}
        }
    }

    for cut in cuts {
        match cut.kind.as_str() {
            "cross-fade" => {
                let (a_track, a_duration) = {
                    let a = &clips[cut.outgoing];
                    (a.track, a.duration)
                };
                let b = &mut clips[cut.incoming];

                // The incoming clip extends backwards over the outgoing one,
                // showing the source it has *before* its in-point - the
                // handle, exactly what a dissolve consumes in any editor. No
                // handle, shorter dissolve: the duration clamps to what
                // actually exists rather than freezing or inventing frames.
                let mut d = cut.duration.min(a_duration).min(b.duration);
                if b.kind != "image" {
                    d = d.min(b.source_start / b.speed.max(0.0625));
                }
                if d < frame {
                    continue;
                }
                b.start -= d;
                b.duration += d;
                if b.kind != "image" {
                    b.source_start -= d * b.speed;
                }
                b.video_fade_in = d;
                // Sound rides the picture: the pre-roll fades in rather than
                // arriving at full level a dissolve early.
                b.fade_in = b.fade_in.max(d);
                b.track = a_track + 1;
            }
            "fade-black" | "fade-white" => {
                // Half the duration on each side of the cut, as fade filters
                // at decode. Frame-based, because the decoder emits exactly
                // one frame per output frame - so the fade lands on the same
                // frames the timeline arithmetic says it covers.
                let colour = if cut.kind == "fade-white" { ":color=white" } else { "" };
                let half = cut.duration / 2.0;
                {
                    let a = &mut clips[cut.outgoing];
                    let frames = ((half.min(a.duration) * fps).round() as i64).max(1);
                    let total = (a.duration * fps).round() as i64;
                    append_filter(
                        &mut a.video_filter_chain,
                        &format!(
                            "fade=t=out:start_frame={}:nb_frames={frames}{colour}",
                            (total - frames).max(0)
                        ),
                    );
                }
                {
                    let b = &mut clips[cut.incoming];
                    let frames = ((half.min(b.duration) * fps).round() as i64).max(1);
                    append_filter(
                        &mut b.video_filter_chain,
                        &format!("fade=t=in:start_frame=0:nb_frames={frames}{colour}"),
                    );
                }
            }
            // A kind this build does not know renders as a plain cut rather
            // than failing the export - the same degrade a missing effect
            // filter must NOT get, because there the user styled the picture.
            _ => {}
        }
    }
}

/// Appends one filter to a chain, comma-separated. Effects the user stacked
/// come first; a transition fades the styled picture, not the raw one.
fn append_filter(chain: &mut String, filter: &str) {
    if !chain.is_empty() {
        chain.push(',');
    }
    chain.push_str(filter);
}

/// Renders `request` and returns the path written.
pub fn render(request: &ExportRequest, mut reporter: Reporter<'_>) -> Result<String, String> {
    if request.clips.is_empty() {
        return Err("there is nothing on the timeline to export".to_owned());
    }

    let rate = FrameRate::new(Rational::new(request.rate_num, request.rate_den));
    let output = PathBuf::from(&request.output);

    // Transitions become overlaps, ramps and fade filters before anything
    // else reads the clip list, so the picture and sound paths below never
    // know transitions exist.
    let mut resolved = request.clips.clone();
    resolve_transitions(&mut resolved, rate);

    // Stills composite exactly like footage; they only differ in how they are
    // decoded, which is handled where the decoder is opened.
    let visible: Vec<&ExportClip> = resolved
        .iter()
        .filter(|clip| (clip.kind == "video" || clip.kind == "image") && !clip.hidden)
        .collect();
    let audible: Vec<&ExportClip> = resolved
        .iter()
        .filter(|clip| clip.kind == "audio" && !clip.muted)
        .collect();

    // A video clip carries its own sound, so an unmuted video track
    // contributes to the mix as well as to the picture.
    let mut sound: Vec<&ExportClip> = audible;
    sound.extend(
        resolved
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

    let timeline_end = resolved
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
    let (timeline, stills, decode_sizes, filter_chains) = build_timeline(request, rate, visible);

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

                    // Effects and transition fades, as one FFmpeg chain. The
                    // decoder guards the frame size after it, so an effect
                    // that resizes cannot shear the pipe.
                    if let Some(chain) = filter_chains.get(&layer.clip) {
                        options = options.filtered(chain.clone());
                    }

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
    HashMap<ClipId, String>,
) {
    let mut timeline = Timeline::new(request.width, request.height, rate);
    let mut stills = std::collections::HashSet::new();
    let mut decode_sizes: HashMap<ClipId, (u32, u32)> = HashMap::new();
    let mut filter_chains: HashMap<ClipId, String> = HashMap::new();

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
        engine_clip.opacity = clip.opacity.clamp(0.0, 1.0) as f32;
        // Quantised like every other time: the ramp must land on the same
        // frame grid the overlap does, or the dissolve ends a frame early.
        engine_clip.video_fade_in = quantise(clip.video_fade_in, rate);

        if let Some(id) = timeline.add_clip(tracks[clip.track], engine_clip) {
            if clip.kind == "image" {
                stills.insert(id);
            }
            if let Some(size) = fitted_size(request, clip) {
                decode_sizes.insert(id, size);
            }
            if !clip.video_filter_chain.is_empty() {
                filter_chains.insert(id, clip.video_filter_chain.clone());
            }
        }
    }

    (timeline, stills, decode_sizes, filter_chains)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn clip(kind: &str, track: usize, start: f64, duration: f64, source_start: f64) -> ExportClip {
        ExportClip {
            path: format!("{kind}.mp4"),
            kind: kind.to_owned(),
            start,
            duration,
            source_start,
            track,
            hidden: false,
            muted: false,
            volume: 1.0,
            fade_in: 0.0,
            fade_out: 0.0,
            filter_chain: String::new(),
            speed: 1.0,
            preserve_pitch: true,
            scale: 1.0,
            offset_x: 0.0,
            offset_y: 0.0,
            rotation: 0.0,
            opacity: 1.0,
            video_filter_chain: String::new(),
            transition: None,
            video_fade_in: 0.0,
            media_width: None,
            media_height: None,
        }
    }

    fn spec(kind: &str, duration: f64) -> Option<TransitionSpec> {
        Some(TransitionSpec { kind: kind.to_owned(), duration })
    }

    #[test]
    fn a_cross_fade_overlaps_the_incoming_clip_on_its_own_lane() {
        let mut clips = vec![clip("video", 0, 0.0, 4.0, 0.0), clip("video", 0, 4.0, 4.0, 2.0)];
        clips[1].transition = spec("cross-fade", 1.0);
        resolve_transitions(&mut clips, FrameRate::THIRTY);

        let b = &clips[1];
        assert_eq!(b.start, 3.0, "extends backwards over the cut");
        assert_eq!(b.duration, 5.0);
        assert_eq!(b.source_start, 1.0, "consumes the handle before the in-point");
        assert_eq!(b.video_fade_in, 1.0);
        assert_eq!(b.fade_in, 1.0, "sound rides the picture");
        assert_eq!(clips[0].track, 0, "outgoing stays on its doubled lane");
        assert_eq!(b.track, 1, "incoming sits directly above it");
    }

    #[test]
    fn a_cross_fade_clamps_to_the_available_handle() {
        let mut clips = vec![clip("video", 0, 0.0, 4.0, 0.0), clip("video", 0, 4.0, 4.0, 0.25)];
        clips[1].transition = spec("cross-fade", 2.0);
        resolve_transitions(&mut clips, FrameRate::THIRTY);

        // Only a quarter second of source exists before the in-point, so that
        // is the whole dissolve.
        assert_eq!(clips[1].video_fade_in, 0.25);
        assert_eq!(clips[1].source_start, 0.0);
        assert_eq!(clips[1].start, 3.75);
    }

    #[test]
    fn a_still_needs_no_handle_to_dissolve() {
        let mut clips = vec![clip("video", 0, 0.0, 4.0, 0.0), clip("image", 0, 4.0, 4.0, 0.0)];
        clips[1].transition = spec("cross-fade", 1.0);
        resolve_transitions(&mut clips, FrameRate::THIRTY);
        assert_eq!(clips[1].video_fade_in, 1.0);
        assert_eq!(clips[1].source_start, 0.0, "a still has no source clock to rewind");
    }

    #[test]
    fn a_fade_to_black_splits_across_the_cut_as_fade_filters() {
        let mut clips = vec![clip("video", 0, 0.0, 4.0, 0.0), clip("video", 0, 4.0, 4.0, 0.0)];
        clips[1].transition = spec("fade-black", 1.0);
        resolve_transitions(&mut clips, FrameRate::THIRTY);

        // Half a second each side at 30fps is 15 frames.
        assert_eq!(clips[0].video_filter_chain, "fade=t=out:start_frame=105:nb_frames=15");
        assert_eq!(clips[1].video_filter_chain, "fade=t=in:start_frame=0:nb_frames=15");
        assert_eq!(clips[1].start, 4.0, "nothing moves for an edge fade");
    }

    #[test]
    fn a_fade_to_white_names_its_colour() {
        let mut clips = vec![clip("video", 0, 0.0, 2.0, 0.0), clip("video", 0, 2.0, 2.0, 0.0)];
        clips[1].transition = spec("fade-white", 0.5);
        resolve_transitions(&mut clips, FrameRate::THIRTY);
        assert!(clips[0].video_filter_chain.ends_with(":color=white"));
        assert!(clips[1].video_filter_chain.contains("t=in"));
    }

    #[test]
    fn transition_fades_append_after_the_clips_own_effects() {
        let mut clips = vec![clip("video", 0, 0.0, 2.0, 0.0), clip("video", 0, 2.0, 2.0, 0.0)];
        clips[1].video_filter_chain = "hue=s=0".to_owned();
        clips[1].transition = spec("fade-black", 0.5);
        resolve_transitions(&mut clips, FrameRate::THIRTY);
        assert!(
            clips[1].video_filter_chain.starts_with("hue=s=0,fade=t=in"),
            "was: {}",
            clips[1].video_filter_chain
        );
    }

    #[test]
    fn a_transition_with_no_adjacent_clip_is_orphaned_not_fatal() {
        let mut clips = vec![clip("video", 0, 0.0, 2.0, 0.0), clip("video", 0, 5.0, 2.0, 0.0)];
        clips[1].transition = spec("cross-fade", 1.0);
        resolve_transitions(&mut clips, FrameRate::THIRTY);
        assert_eq!(clips[1].start, 5.0);
        assert_eq!(clips[1].video_fade_in, 0.0);
    }

    #[test]
    fn track_indices_are_doubled_for_everyone() {
        let mut clips = vec![clip("video", 0, 0.0, 2.0, 0.0), clip("audio", 3, 0.0, 2.0, 0.0)];
        resolve_transitions(&mut clips, FrameRate::THIRTY);
        assert_eq!(clips[0].track, 0);
        assert_eq!(clips[1].track, 6);
    }

    #[test]
    fn an_unknown_transition_kind_renders_as_a_plain_cut() {
        let mut clips = vec![clip("video", 0, 0.0, 2.0, 0.0), clip("video", 0, 2.0, 2.0, 0.0)];
        clips[1].transition = spec("wipe-left", 1.0);
        resolve_transitions(&mut clips, FrameRate::THIRTY);
        assert_eq!(clips[1].start, 2.0);
        assert!(clips[1].video_filter_chain.is_empty());
    }
}
