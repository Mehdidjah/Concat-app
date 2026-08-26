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
//!   volume and fades applied at mix time (they mirror `clipGainAt` in the
//!   frontend exactly). Gain-only edits therefore never re-decode.
//!
//! - The playback clock is the audio device's own sample counter. The UI
//!   receives `transport` position events and interpolates between them;
//!   there is no second clock to drift against.
//!
//! The mix callback owns its state and receives changes as messages, so it
//! takes no locks on the audio thread. Decodes run on worker threads and the
//! clip set is re-sent to the callback as each one lands.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
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

/// Decoded audio: 16-bit little-endian stereo at [`PCM_RATE`], memory-mapped
/// from the cache file so the OS decides what stays resident.
struct Pcm {
    map: memmap2::Mmap,
    frames: u64,
}

impl Pcm {
    fn open(path: &Path) -> Result<Pcm, String> {
        let file = std::fs::File::open(path)
            .map_err(|error| format!("could not open {}: {error}", path.display()))?;
        let map = unsafe { memmap2::Mmap::map(&file) }
            .map_err(|error| format!("could not map {}: {error}", path.display()))?;
        let frames = (map.len() / 4) as u64;
        Ok(Pcm { map, frames })
    }

    /// One sample as a float in [-1, 1]. Out of range reads are silence.
    fn sample(&self, frame: u64, channel: usize) -> f32 {
        if frame >= self.frames {
            return 0.0;
        }
        let at = (frame as usize * 2 + channel) * 2;
        let raw = i16::from_le_bytes([self.map[at], self.map[at + 1]]);
        f32::from(raw) / 32768.0
    }
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

/// Mirror of the frontend's `clipGainAt`, so preview loudness has exactly one
/// definition even though it is computed in two languages.
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
    /// Decoded clips by decode key, for the lifetime of the app.
    cache: Mutex<HashMap<String, Arc<Pcm>>>,
    decoding: Mutex<HashSet<String>>,
    /// What the timeline currently wants audible.
    specs: Mutex<Vec<ClipSpec>>,
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
            std::thread::Builder::new()
                .name("audio-output".into())
                .spawn(move || audio_thread(rx, shared))
                .expect("could not spawn the audio thread");
        }

        // Position events at ~30Hz while playing. The UI interpolates between
        // them, so this cadence bounds correction error, not smoothness.
        {
            let shared = Arc::clone(&shared);
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
                        Err(error) => eprintln!("audio decode failed for {}: {error}", spec.path),
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
fn decode_key(spec: &ClipSpec) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    spec.path.hash(&mut hasher);
    spec.source_start.to_bits().hash(&mut hasher);
    spec.duration.to_bits().hash(&mut hasher);
    spec.speed.to_bits().hash(&mut hasher);
    spec.preserve_pitch.hash(&mut hasher);
    spec.chain.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Decodes one clip span to the cache and maps it.
///
/// The FFmpeg invocation mirrors the exporter's treatment of filters and
/// speed, so what the preview mixes is what the export renders. A file
/// already in the cache is reused as is - that is the point of the cache.
fn decode(spec: &ClipSpec, project: &Path, key: &str) -> Result<Pcm, String> {
    if spec.chain.contains('\n') || spec.chain.contains('\r') {
        return Err("filter chain contains a line break".to_owned());
    }

    let directory = project.join("cache").join("audio");
    let destination = directory.join(format!("{key}.pcm"));
    if destination.is_file() {
        return Pcm::open(&destination);
    }
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("could not create {}: {error}", directory.display()))?;

    let mut filters: Vec<String> = Vec::new();
    if !spec.chain.is_empty() {
        filters.push(spec.chain.clone());
    }
    if (spec.speed - 1.0).abs() > 1e-9 {
        if spec.preserve_pitch {
            // atempo only accepts [0.5, 2]; factors outside compose.
            let mut factor = spec.speed.clamp(0.0625, 16.0);
            while factor > 2.0 {
                filters.push("atempo=2.0".to_owned());
                factor /= 2.0;
            }
            while factor < 0.5 {
                filters.push("atempo=0.5".to_owned());
                factor /= 0.5;
            }
            filters.push(format!("atempo={factor:.6}"));
        } else {
            // Tape behaviour: resample to the common rate, shift it, and land
            // back on the common rate. Pitch rides the speed.
            filters.push(format!(
                "aresample={PCM_RATE},asetrate={:.0},aresample={PCM_RATE}",
                f64::from(PCM_RATE) * spec.speed
            ));
        }
    }
    filters.push(format!("aresample={PCM_RATE}"));
    filters.push("aformat=sample_fmts=s16:channel_layouts=stereo".to_owned());

    // A sped-up clip reads further into the file than it occupies on the
    // timeline: the source window is `duration * speed`, exactly the window
    // the exporter trims.
    let window = spec.duration * spec.speed.clamp(0.0625, 16.0);

    let temporary = directory.join(format!("{key}.pcm.decoding"));
    let file = std::fs::File::create(&temporary)
        .map_err(|error| format!("could not create {}: {error}", temporary.display()))?;

    let status = std::process::Command::new(relay_media::ffmpeg())
        .args(["-hide_banner", "-nostdin", "-loglevel", "error"])
        .args(["-ss", &format!("{:.6}", spec.source_start)])
        .args(["-t", &format!("{window:.6}")])
        .args(["-i", &spec.path])
        .args(["-vn", "-af", &filters.join(",")])
        .args(["-f", "s16le", "-"])
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
fn audio_thread(rx: mpsc::Receiver<Msg>, shared: Arc<Shared>) {
    use cpal::traits::{DeviceTrait, HostTrait};

    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        eprintln!("no audio output device; preview will be silent");
        return;
    };
    let Ok(config) = device.default_output_config() else {
        eprintln!("no default output config; preview will be silent");
        return;
    };

    let sample_format = config.sample_format();
    let config: cpal::StreamConfig = config.into();

    let result = match sample_format {
        cpal::SampleFormat::F32 => run_stream::<f32>(&device, &config, rx, shared),
        cpal::SampleFormat::I16 => run_stream::<i16>(&device, &config, rx, shared),
        cpal::SampleFormat::U16 => run_stream::<u16>(&device, &config, rx, shared),
        other => Err(format!("unsupported sample format {other:?}")),
    };
    if let Err(error) = result {
        eprintln!("audio output failed: {error}");
    }
}

fn run_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    rx: mpsc::Receiver<Msg>,
    shared: Arc<Shared>,
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
            |error| eprintln!("audio stream error: {error}"),
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
