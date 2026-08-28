//! Engine-owned audio playback.
//!
//! This replaces the webview audio preview (see the superseded
//! docs/decisions/0004): the engine decodes, mixes and clocks all audible
//! clips itself, and the UI is a controller that follows.
//!
//! The shape of it:
//!
//! - Every audible clip's span is decoded **once** by FFmpeg straight to raw
//!   PCM - the clip's filter chain and speed baked in with the same filters
//!   the exporter uses, so the preview and the export cannot disagree. The
//!   PCM lands as a file in the project's cache and is memory-mapped, so
//!   memory stays bounded however long the material is, and a reopened
//!   project pays nothing.
//!
//! - One cpal output stream mixes the mapped clips sample by sample, with
//!   volume and fades applied at mix time. Gain-only edits therefore never
//!   re-decode, and what a fade sounds like has exactly one definition: this
//!   file's `gain_at`.
//!
//! - The playback clock is the audio device's own sample counter. The UI
//!   receives `transport` position events and interpolates between them;
//!   there is no second clock to drift against.
//!
//! The mix callback owns its state and receives changes as messages, so it
//! takes no locks on the audio thread. Decodes run on worker threads and the
//! clip set is re-sent to the callback as each one lands.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};

use serde::Deserialize;
use tauri::Emitter;

/// Every clip is decoded to this rate; the callback resamples to the device.
const PCM_RATE: u32 = 48_000;

/// One audible clip, as the frontend describes it.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipSpec {
    pub path: String,
    /// Timeline seconds.
    pub start: f64,
    pub duration: f64,
    /// Seconds into the source file.
    pub source_start: f64,
    pub volume: f32,
    pub fade_in: f64,
    pub fade_out: f64,
    pub speed: f64,
    pub preserve_pitch: bool,
    /// FFmpeg audio filter chain, or empty.
    #[serde(default)]
    pub chain: String,
}

/// Decoded audio: 16-bit little-endian stereo at [`PCM_RATE`] inside a WAV
/// container, memory-mapped from the cache file so the OS decides what stays
/// resident.
///
/// WAV rather than raw PCM because the bundled FFmpeg is a trimmed build, and
/// the raw `s16le` muxer is one of the things trimmed away - the `wav` muxer
/// is not. The header costs a one-time chunk walk here; the samples inside
/// are the identical bytes.
struct Pcm {
    map: memmap2::Mmap,
    /// Byte offset of the first sample - just past the `data` chunk header.
    start: usize,
    frames: u64,
}

impl Pcm {
    fn open(path: &Path) -> Result<Pcm, String> {
        let file = std::fs::File::open(path)
            .map_err(|error| format!("could not open {}: {error}", path.display()))?;
        let map = unsafe { memmap2::Mmap::map(&file) }
            .map_err(|error| format!("could not map {}: {error}", path.display()))?;
        let (start, length) = wav_data_range(&map)
            .ok_or_else(|| format!("{} is not the wav this cache writes", path.display()))?;
        let frames = (length / 4) as u64;
        Ok(Pcm { map, start, frames })
    }

    /// One sample as a float in [-1, 1]. Out of range reads are silence.
    fn sample(&self, frame: u64, channel: usize) -> f32 {
        if frame >= self.frames {
            return 0.0;
        }
        let at = self.start + (frame as usize * 2 + channel) * 2;
        let raw = i16::from_le_bytes([self.map[at], self.map[at + 1]]);
        f32::from(raw) / 32768.0
    }
}

/// Finds the samples inside a WAV file: byte offset of the `data` chunk's
/// payload and its usable length.
///
/// A plain chunk walk, not a format library: the file was written by our own
/// FFmpeg invocation two functions down, so the only variability is which
/// bookkeeping chunks precede `data`. Sizes written to a pipe are `u32::MAX`
/// placeholders - the muxer could not seek back to patch them - in which case
/// the payload is simply the rest of the file.
fn wav_data_range(bytes: &[u8]) -> Option<(usize, usize)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }

    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]);
        let payload = at + 8;

        if id == b"data" {
            let available = bytes.len() - payload;
            let length = if size == u32::MAX { available } else { (size as usize).min(available) };
            return Some((payload, length));
        }

        // A placeholder size on any other chunk means the walk cannot
        // continue - refuse rather than misread samples as headers.
        if size == u32::MAX {
            return None;
        }
        // Chunks are word-aligned; an odd size is followed by a pad byte.
        at = payload + size as usize + (size as usize & 1);
    }
    None
}

/// A clip the mix callback can play: spec fields it needs, plus the audio.
struct ActiveClip {
    start: f64,
    duration: f64,
    volume: f32,
    fade_in: f64,
    fade_out: f64,
    pcm: Arc<Pcm>,
}

/// The one definition of a clip's gain envelope. It used to mirror a
/// `clipGainAt` in the frontend; that copy died with the webview audio path
/// (decision 0005), which is the better arrangement - nothing to drift.
fn gain_at(clip: &ActiveClip, local: f64) -> f32 {
    if local < 0.0 || local > clip.duration {
        return 0.0;
    }
    let mut gain = f64::from(clip.volume);
    if clip.fade_in > 0.0 {
        gain *= (local / clip.fade_in).min(1.0);
    }
    if clip.fade_out > 0.0 {
        gain *= ((clip.duration - local) / clip.fade_out).min(1.0);
    }
    gain.max(0.0) as f32
}

enum Msg {
    SetClips(Vec<ActiveClip>),
    Play(f64),
    Pause,
    Seek(f64),
}

struct Shared {
    /// Timeline position in microseconds, written by the mix callback.
    position_micros: AtomicU64,
    playing: AtomicBool,
}

pub struct Playback {
    tx: mpsc::Sender<Msg>,
    shared: Arc<Shared>,
    /// For surfacing failures; a mute app must never be a mystery.
    app: tauri::AppHandle,
    /// Decoded clips by decode key, for the lifetime of the app.
    cache: Mutex<HashMap<String, Arc<Pcm>>>,
    decoding: Mutex<HashSet<String>>,
    /// What the timeline currently wants audible.
    specs: Mutex<Vec<ClipSpec>>,
}

/// A playback failure the user would otherwise experience as unexplained
/// silence. Logged for the dev console, emitted for the UI's toast - the
/// difference between "audio is broken" and a bug report that names a file.
fn report(app: &tauri::AppHandle, message: String) {
    eprintln!("relay: {message}");
    let _ = app.emit("audio://error", message);
}

impl Playback {
    pub fn start(app: tauri::AppHandle) -> Arc<Playback> {
        let (tx, rx) = mpsc::channel::<Msg>();
        let shared = Arc::new(Shared {
            position_micros: AtomicU64::new(0),
            playing: AtomicBool::new(false),
        });

        {
            let shared = Arc::clone(&shared);
            let app = app.clone();
            std::thread::Builder::new()
                .name("audio-output".into())
                .spawn(move || audio_thread(rx, shared, app))
                .expect("could not spawn the audio thread");
        }

        // Position events at ~30Hz while playing. The UI interpolates between
        // them, so this cadence bounds correction error, not smoothness.
        {
            let shared = Arc::clone(&shared);
            let app = app.clone();
            std::thread::Builder::new()
                .name("transport-events".into())
                .spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_millis(33));
                    if shared.playing.load(Ordering::Relaxed) {
                        let position =
                            shared.position_micros.load(Ordering::Relaxed) as f64 / 1_000_000.0;
                        let _ = app.emit("transport", position);
                    }
                })
                .expect("could not spawn the transport event thread");
        }

        Arc::new(Playback {
            tx,
            shared,
            app,
            cache: Mutex::new(HashMap::new()),
            decoding: Mutex::new(HashSet::new()),
            specs: Mutex::new(Vec::new()),
        })
    }

    pub fn play(&self, position: f64) {
        self.shared.playing.store(true, Ordering::Relaxed);
        self.shared
            .position_micros
            .store((position.max(0.0) * 1_000_000.0) as u64, Ordering::Relaxed);
        let _ = self.tx.send(Msg::Play(position.max(0.0)));
    }

    pub fn pause(&self) {
        self.shared.playing.store(false, Ordering::Relaxed);
        let _ = self.tx.send(Msg::Pause);
    }

    pub fn seek(&self, position: f64) {
        let _ = self.tx.send(Msg::Seek(position.max(0.0)));
    }

    /// Replaces the audible clip set.
    ///
    /// Anything already decoded plays immediately; anything new decodes on a
    /// worker and joins the mix when it lands. `project` is the project
    /// folder, whose cache holds the PCM files.
    pub fn set_clips(self: &Arc<Self>, project: PathBuf, specs: Vec<ClipSpec>) {
        *self.specs.lock().unwrap() = specs.clone();

        for spec in specs {
            let key = decode_key(&spec);
            if self.cache.lock().unwrap().contains_key(&key) {
                continue;
            }
            if !self.decoding.lock().unwrap().insert(key.clone()) {
                continue;
            }

            let this = Arc::clone(self);
            let project = project.clone();
            std::thread::Builder::new()
                .name("audio-decode".into())
                .spawn(move || {
                    match decode(&spec, &project, &key) {
                        Ok(pcm) => {
                            this.cache.lock().unwrap().insert(key.clone(), Arc::new(pcm));
                        }
                        Err(error) => report(
                            &this.app,
                            format!("audio decode failed for {}: {error}", spec.path),
                        ),
                    }
                    this.decoding.lock().unwrap().remove(&key);
                    this.resync();
                })
                .expect("could not spawn a decode thread");
        }

        self.resync();
    }

    /// Sends the mix callback everything currently wanted *and* decoded.
    fn resync(&self) {
        let specs = self.specs.lock().unwrap();
        let cache = self.cache.lock().unwrap();
        let active = specs
            .iter()
            .filter_map(|spec| {
                let pcm = cache.get(&decode_key(spec))?;
                Some(ActiveClip {
                    start: spec.start,
                    duration: spec.duration,
                    volume: spec.volume,
                    fade_in: spec.fade_in,
                    fade_out: spec.fade_out,
                    pcm: Arc::clone(pcm),
                })
            })
            .collect();
        let _ = self.tx.send(Msg::SetClips(active));
    }
}

/// Identity of one decoded span: everything that changes the samples.
/// Volume, fades and timeline position are deliberately absent - they apply
/// at mix time.
///
/// FNV-1a rather than the standard library's hasher, because these keys name
/// files that outlive the process: `DefaultHasher` is free to change between
/// Rust releases, and a changed hash would silently orphan every project's
/// audio cache on a toolchain upgrade.
fn decode_key(spec: &ClipSpec) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut eat = |bytes: &[u8]| {
        for &byte in bytes {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    eat(spec.path.as_bytes());
    eat(&spec.source_start.to_bits().to_le_bytes());
    eat(&spec.duration.to_bits().to_le_bytes());
    eat(&spec.speed.to_bits().to_le_bytes());
    eat(&[u8::from(spec.preserve_pitch)]);
    eat(spec.chain.as_bytes());
    format!("{hash:016x}")
}

/// Decodes one clip span to the cache and maps it.
///
/// The FFmpeg invocation mirrors the exporter's treatment of filters and
/// speed, so what the preview mixes is what the export renders. A file
/// already in the cache is reused as is - that is the point of the cache.
fn decode(spec: &ClipSpec, project: &Path, key: &str) -> Result<Pcm, String> {
    relay_media::audio::validate_chain(&spec.chain).map_err(|error| error.to_string())?;

    let directory = project.join("cache").join("audio");
    // `.wav`, and `.pcm` before the muxer change - old raw caches are simply
    // orphaned and re-decoded, because a cache must never need migrating.
    let destination = directory.join(format!("{key}.wav"));
    if destination.is_file() {
        return Pcm::open(&destination);
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;

    // Speed first, then the clip's own filters - the same order the export
    // graph applies, because these are one definition, not two. The engine
    // owns what speed *means*; this function only decodes.
    let mut filters: Vec<String> =
        relay_media::audio::speed_filters(spec.speed, spec.preserve_pitch);
    if !spec.chain.is_empty() {
        filters.push(spec.chain.clone());
    }
    filters.push(format!("aresample={PCM_RATE}"));
    filters.push("aformat=sample_fmts=s16:channel_layouts=stereo".to_owned());

    // A sped-up clip reads further into the file than it occupies on the
    // timeline: the source window is `duration * speed`, exactly the window
    // the exporter trims.
    let window = spec.duration * relay_media::audio::clamp_speed(spec.speed);

    let temporary = directory.join(format!("{key}.wav.decoding"));
    let file = std::fs::File::create(&temporary)
        .map_err(|error| format!("could not create {}: {error}", temporary.display()))?;

    let status = std::process::Command::new(relay_media::ffmpeg())
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(["-ss", &format!("{:.6}", spec.source_start)])
        .args(["-t", &format!("{window:.6}")])
        .args(["-i", &spec.path])
        .args(["-vn", "-af", &filters.join(",")])
        // `wav`, not `s16le`: the bundled FFmpeg is a trimmed build and the
        // raw muxer is not in it. `Pcm::open` skips the header.
        .args(["-f", "wav", "pipe:1"])
        .stdout(file)
        .status()
        .map_err(|error| format!("could not run ffmpeg: {error}"))?;

    if !status.success() {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("ffmpeg exited with {status}"));
    }

    std::fs::rename(&temporary, &destination)
        .map_err(|error| format!("could not commit {}: {error}", destination.display()))?;
    Pcm::open(&destination)
}

/// Owns the output stream for the life of the app.
///
/// The stream's callback owns all mix state and drains the message channel
/// itself, so no lock is ever taken on the audio thread.
fn audio_thread(rx: mpsc::Receiver<Msg>, shared: Arc<Shared>, app: tauri::AppHandle) {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        report(&app, "no audio output device; playback will be silent".to_owned());
        return;
    };
    let Ok(config) = device.default_output_config() else {
        report(&app, "no default audio output config; playback will be silent".to_owned());
        return;
    };

    let sample_format = config.sample_format();
    let config: cpal::StreamConfig = config.into();

    let result = match sample_format {
        cpal::SampleFormat::F32 => run_stream::<f32>(&device, &config, rx, shared, app.clone()),
        cpal::SampleFormat::I16 => run_stream::<i16>(&device, &config, rx, shared, app.clone()),
        cpal::SampleFormat::U16 => run_stream::<u16>(&device, &config, rx, shared, app.clone()),
        other => Err(format!("unsupported sample format {other:?}")),
    };
    if let Err(error) = result {
        report(&app, format!("audio output failed: {error}; playback will be silent"));
    }
}

fn run_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    rx: mpsc::Receiver<Msg>,
    shared: Arc<Shared>,
    app: tauri::AppHandle,
) -> Result<(), String>
where
    T: cpal::SizedSample + cpal::FromSample<f32>,
{
    use cpal::traits::{DeviceTrait, StreamTrait};

    let channels = config.channels as usize;
    let step = 1.0 / f64::from(config.sample_rate.0);

    let mut clips: Vec<ActiveClip> = Vec::new();
    let mut playing = false;
    let mut position = 0.0f64;

    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                while let Ok(message) = rx.try_recv() {
                    match message {
                        Msg::SetClips(next) => clips = next,
                        Msg::Play(at) => {
                            position = at;
                            playing = true;
                        }
                        Msg::Pause => playing = false,
                        Msg::Seek(at) => position = at,
                    }
                }

                if !playing {
                    data.fill(T::from_sample(0.0));
                    return;
                }

                for frame in data.chunks_mut(channels) {
                    let mut left = 0.0f32;
                    let mut right = 0.0f32;

                    for clip in &clips {
                        let local = position - clip.start;
                        if local < 0.0 || local >= clip.duration {
                            continue;
                        }
                        let gain = gain_at(clip, local);
                        if gain <= 0.0 {
                            continue;
                        }

                        // Linear interpolation across the 48k source grid -
                        // exact when the device runs at 48k, inaudibly close
                        // when it does not.
                        let read = local * f64::from(PCM_RATE);
                        let index = read.floor() as u64;
                        let fraction = (read - read.floor()) as f32;
                        let pcm = &clip.pcm;
                        left += gain
                            * (pcm.sample(index, 0) * (1.0 - fraction)
                                + pcm.sample(index + 1, 0) * fraction);
                        right += gain
                            * (pcm.sample(index, 1) * (1.0 - fraction)
                                + pcm.sample(index + 1, 1) * fraction);
                    }

                    // Hard limit. A mix of boosted clips can exceed full
                    // scale; wrapping would be far worse than flattening.
                    frame[0] = T::from_sample(left.clamp(-1.0, 1.0));
                    if channels > 1 {
                        frame[1] = T::from_sample(right.clamp(-1.0, 1.0));
                    }
                    for extra in frame.iter_mut().skip(2) {
                        *extra = T::from_sample(0.0);
                    }

                    position += step;
                }

                shared
                    .position_micros
                    .store((position * 1_000_000.0) as u64, Ordering::Relaxed);
            },
            move |error| report(&app, format!("audio stream error: {error}")),
            None,
        )
        .map_err(|error| format!("could not build the output stream: {error}"))?;

    stream
        .play()
        .map_err(|error| format!("could not start the output stream: {error}"))?;

    // The stream lives exactly as long as this thread.
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

#[cfg(test)]
mod tests {
    use super::wav_data_range;

    /// A minimal RIFF/WAVE: fmt chunk, then a data chunk with `samples`.
    fn wav(data_size: u32, samples: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&u32::MAX.to_le_bytes()); // pipe placeholder
        bytes.extend_from_slice(b"WAVE");
        bytes.extend_from_slice(b"fmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&[0u8; 16]);
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data_size.to_le_bytes());
        bytes.extend_from_slice(samples);
        bytes
    }

    #[test]
    fn finds_the_data_chunk_past_the_headers() {
        let bytes = wav(8, &[1, 2, 3, 4, 5, 6, 7, 8]);
        let (start, length) = wav_data_range(&bytes).expect("valid wav");
        assert_eq!(length, 8);
        assert_eq!(&bytes[start..start + length], &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn a_placeholder_data_size_means_the_rest_of_the_file() {
        // What the wav muxer writes to a pipe: it cannot seek back to patch.
        let bytes = wav(u32::MAX, &[9, 9, 9, 9]);
        let (start, length) = wav_data_range(&bytes).expect("valid wav");
        assert_eq!(length, 4);
        assert_eq!(start, bytes.len() - 4);
    }

    #[test]
    fn a_stated_size_is_clamped_to_the_file() {
        // A truncated decode must read short, not out of bounds.
        let bytes = wav(1000, &[1, 2]);
        assert_eq!(wav_data_range(&bytes).map(|(_, length)| length), Some(2));
    }

    #[test]
    fn refuses_files_that_are_not_wav() {
        assert_eq!(wav_data_range(b""), None);
        assert_eq!(wav_data_range(b"RIFFxxxxJUNK"), None);
        assert_eq!(wav_data_range(&[0u8; 64]), None);
    }
}
