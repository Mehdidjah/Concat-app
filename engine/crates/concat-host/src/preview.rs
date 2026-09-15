// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! The paused monitor's true frame.
//!
//! One reader pool for the app's lifetime: its whole value is what stays
//! warm between scrubs. The pool locks per reader, so a frame is composited
//! on whatever thread the caller chose while another thread decodes ahead
//! on a different file - the window debounces and drops stale results, so a
//! slow decode never wedges anything but itself.
//!
//! With the `gpu` feature and a device from [`Monitor::with_gpu`], a frame
//! is composited on that device and handed back as a texture: decoded
//! pictures go up once, the composite happens where it is shown, and no
//! pixel comes back down.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use concat_export::ExportClip;
use concat_project::DocumentSettings;

use crate::proxy::ProxyStore;

/// A frame request: the instant and the size, with the clips coming from
/// the session that owns them.
#[derive(Clone, Copy, Debug)]
pub struct FrameSpec {
    /// The timeline instant to composite, in seconds.
    pub time: f64,
    /// Preview frame width in pixels.
    pub width: u32,
    /// Preview frame height in pixels.
    pub height: u32,
    /// Low-latency playback or an active gesture may use a local preview
    /// proxy; a settled frame and export remain source-exact.
    pub live: bool,
    /// The editor can prepare proxies while paused so playback starts warm.
    /// One-shot API renders leave this false and do no speculative work.
    pub prewarm: bool,
}

/// The reader pool behind the monitor, shareable across threads.
#[derive(Clone)]
pub struct Monitor {
    pool: Arc<concat_media::ReaderPool>,
    /// At most one speculative decode may compete with requested frames.
    prefetching: Arc<AtomicBool>,
    /// The last clip list's plan, kept until the list changes: playback
    /// and scrubbing ask for many instants of one document, and the plan
    /// is the half of a frame that does not depend on the instant.
    plan: Arc<Mutex<Option<PlanEntry>>>,
    proxies: ProxyStore,
    #[cfg(feature = "gpu")]
    gpu: Option<Arc<Mutex<concat_render::WgpuCompositor>>>,
}

/// One kept plan and what it was built for.
struct PlanEntry {
    clips: Arc<Vec<ExportClip>>,
    width: u32,
    height: u32,
    rate: (i64, i64),
    gpu: bool,
    plan: Arc<concat_export::PreviewPlan>,
}

/// The wgpu the monitor's textures belong to.
#[cfg(feature = "gpu")]
pub use concat_render::wgpu;

impl Default for Monitor {
    fn default() -> Self {
        Self::new()
    }
}

impl Monitor {
    /// A monitor with the engine's default pool budget.
    pub fn new() -> Self {
        Self {
            pool: Arc::new(concat_media::ReaderPool::with_defaults()),
            prefetching: Arc::new(AtomicBool::new(false)),
            plan: Arc::new(Mutex::new(None)),
            proxies: ProxyStore::default(),
            #[cfg(feature = "gpu")]
            gpu: None,
        }
    }

    /// A monitor that composites on `device` - the window's - so
    /// [`Monitor::frame_texture`] yields textures the window shows as they
    /// are.
    #[cfg(feature = "gpu")]
    pub fn with_gpu(device: wgpu::Device, queue: wgpu::Queue) -> Self {
        Self {
            pool: Arc::new(concat_media::ReaderPool::with_defaults()),
            prefetching: Arc::new(AtomicBool::new(false)),
            plan: Arc::new(Mutex::new(None)),
            proxies: ProxyStore::default(),
            gpu: Some(Arc::new(Mutex::new(
                concat_render::WgpuCompositor::with_device(device, queue),
            ))),
        }
    }

    /// Whether frames can be composited on the GPU.
    pub fn has_gpu(&self) -> bool {
        #[cfg(feature = "gpu")]
        {
            self.gpu.is_some()
        }
        #[cfg(not(feature = "gpu"))]
        {
            false
        }
    }

    /// The engine-composited frame at one instant, as a texture on the
    /// device this monitor was given: `Rgba8Unorm`, `spec.width` by
    /// `spec.height`, bindable and renderable. Errs without a device, or
    /// once the device is lost.
    #[cfg(feature = "gpu")]
    pub fn frame_texture(
        &self,
        clips: Arc<Vec<ExportClip>>,
        settings: &DocumentSettings,
        spec: FrameSpec,
    ) -> Result<wgpu::Texture, String> {
        let gpu = self
            .gpu
            .as_ref()
            .ok_or_else(|| "the monitor has no GPU device".to_owned())?;
        let plan = self.plan_for(clips, settings, spec, true);
        let sources = concat_export::preview_sources_of(&self.pool, &plan, spec.time)?;
        let mut gpu = gpu.lock().map_err(|_| "compositor poisoned".to_owned())?;
        if sources.has_treatments() {
            // A layer whose look is a shader is applied where the stack is
            // drawn, on the GPU; only a layer that needs FFmpeg for a
            // package with no shader takes the frame through the CPU.
            if let Some(treatments) = sources.live_treatments() {
                let layers = sources.placed();
                return gpu
                    .composite_texture_treated(
                        spec.width,
                        spec.height,
                        sources.seconds(),
                        &layers,
                        &treatments,
                    )
                    .ok_or_else(|| "the GPU device was lost".to_owned());
            }
            let frame = sources.composite(&mut *gpu);
            let layers = [concat_render::Layer::new(&frame)];
            return gpu
                .composite_texture(spec.width, spec.height, &layers)
                .ok_or_else(|| "the GPU device was lost".to_owned());
        }
        let layers = sources.layers();
        gpu.composite_texture(spec.width, spec.height, &layers)
            .ok_or_else(|| "the GPU device was lost".to_owned())
    }

    /// The plan for this clip list at this size and rate: the kept one
    /// when it was built for the same list - the same allocation, or an
    /// equal one - and a fresh one otherwise, kept in its place.
    fn plan_for(
        &self,
        clips: Arc<Vec<ExportClip>>,
        settings: &DocumentSettings,
        spec: FrameSpec,
        gpu: bool,
    ) -> Arc<concat_export::PreviewPlan> {
        let rate = (settings.rate_num, settings.rate_den);
        let clips = if spec.live || spec.prewarm {
            self.proxies.clips(clips, spec.live, spec.time)
        } else {
            clips
        };
        let mut slot = self
            .plan
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(entry) = slot.as_ref()
            && entry.width == spec.width
            && entry.height == spec.height
            && entry.rate == rate
            && entry.gpu == gpu
            && (Arc::ptr_eq(&entry.clips, &clips) || *entry.clips == *clips)
        {
            return Arc::clone(&entry.plan);
        }
        let plan = Arc::new(concat_export::preview_plan(
            &clips,
            spec.width,
            spec.height,
            rate.0,
            rate.1,
            gpu,
        ));
        *slot = Some(PlanEntry {
            clips,
            width: spec.width,
            height: spec.height,
            rate,
            gpu,
            plan: Arc::clone(&plan),
        });
        plan
    }

    /// The engine-composited frame at one instant, as raw RGBA bytes:
    /// exactly `width * height * 4` of them.
    pub fn frame(
        &self,
        clips: Arc<Vec<ExportClip>>,
        settings: &DocumentSettings,
        spec: FrameSpec,
    ) -> Result<Vec<u8>, String> {
        let plan = self.plan_for(clips, settings, spec, false);
        let sources = concat_export::preview_sources_of(&self.pool, &plan, spec.time)?;
        Ok(sources
            .composite(&mut concat_render::CpuCompositor)
            .into_pixels())
    }

    /// Decode-ahead for the playback stream: warms the pool for the next
    /// `frames` instants after `spec.time`, so the following [`Monitor::frame`]
    /// pulls are cache hits instead of decode waits. Clamped, so a confused
    /// caller cannot park the pool's mutex on a long decode march.
    pub fn prefetch(
        &self,
        clips: Arc<Vec<ExportClip>>,
        settings: &DocumentSettings,
        spec: FrameSpec,
        frames: u32,
    ) {
        if self.prefetching.swap(true, Ordering::AcqRel) {
            return;
        }
        struct Finished<'a>(&'a AtomicBool);
        impl Drop for Finished<'_> {
            fn drop(&mut self) {
                self.0.store(false, Ordering::Release);
            }
        }
        let _finished = Finished(&self.prefetching);
        let plan = self.plan_for(clips, settings, spec, self.has_gpu());
        concat_export::preview_prefetch_of(&self.pool, &plan, spec.time, frames.min(8));
    }

    /// Forgets every cached frame, reader and plan, for when the project
    /// closes.
    pub fn clear(&self) {
        self.pool.clear();
        self.proxies.clear();
        *self
            .plan
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use concat_project::model::{ClipMask, MaskProperty, MaskShape};

    #[test]
    #[ignore]
    fn real_media_live_monitor_uses_proxy_and_settled_monitor_uses_source() {
        let source = std::path::PathBuf::from(std::env::var_os("CONCAT_DIAG_MEDIA").unwrap());
        let video = concat_media::probe(&source).unwrap().video.unwrap();
        let at = std::env::var("CONCAT_DIAG_AT")
            .ok()
            .and_then(|value| value.parse::<f64>().ok())
            .unwrap_or(0.0);
        let mut clip: ExportClip = serde_json::from_value(serde_json::json!({
            "path": source.to_string_lossy(),
            "kind": "video",
            "start": 0.0,
            "duration": 1.0,
            "sourceStart": at,
            "track": 0,
            "hidden": false,
            "muted": true,
            "mediaWidth": video.width,
            "mediaHeight": video.height
        }))
        .unwrap();
        let mask = ClipMask::new("mask1".to_owned(), MaskShape::Heart);
        clip.masks_enabled = true;
        clip.masks.push(mask.clone());
        clip.animation = [-0.3, 0.3]
            .into_iter()
            .enumerate()
            .map(|(index, value)| concat_export::ExportKey {
                property: MaskProperty::PositionX.id(&mask.id),
                at: index as f64,
                value,
                ease: [0.0, 0.0, 1.0, 1.0],
                curve: None,
                spatial_in: None,
                spatial_out: None,
                post: String::new(),
            })
            .collect();
        clip.animation
            .extend([1.0, 0.12].into_iter().enumerate().map(|(index, value)| {
                concat_export::ExportKey {
                    property: "scale".to_owned(),
                    at: index as f64,
                    value,
                    ease: [0.0, 0.0, 1.0, 1.0],
                    curve: None,
                    spatial_in: None,
                    spatial_out: None,
                    post: String::new(),
                }
            }));
        let clips = Arc::new(vec![clip]);
        let settings = DocumentSettings {
            name: "diagnostic".to_owned(),
            width: 960,
            height: 540,
            rate_num: 30,
            rate_den: 1,
        };
        let monitor = Monitor::new();
        let start = std::time::Instant::now();
        loop {
            let resolved = monitor.proxies.clips(Arc::clone(&clips), true, 0.0);
            if resolved[0].path != clips[0].path {
                break;
            }
            assert!(start.elapsed().as_secs() < 60, "proxy did not become ready");
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let mut samples = Vec::new();
        for index in 0..30 {
            let start = std::time::Instant::now();
            let bytes = monitor
                .frame(
                    Arc::clone(&clips),
                    &settings,
                    FrameSpec {
                        time: index as f64 / 30.0,
                        width: 960,
                        height: 540,
                        live: true,
                        prewarm: true,
                    },
                )
                .unwrap();
            assert_eq!(bytes.len(), 960 * 540 * 4);
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }
        samples.sort_by(f64::total_cmp);
        println!(
            "live animated scale-and-mask monitor: median {:.2} ms, p90 {:.2} ms",
            samples[15], samples[27]
        );
        assert_ne!(
            monitor.plan.lock().unwrap().as_ref().unwrap().clips[0].path,
            clips[0].path
        );

        monitor
            .frame(
                Arc::clone(&clips),
                &settings,
                FrameSpec {
                    time: 0.5,
                    width: 960,
                    height: 540,
                    live: false,
                    prewarm: false,
                },
            )
            .unwrap();
        assert_eq!(
            monitor.plan.lock().unwrap().as_ref().unwrap().clips[0].path,
            clips[0].path
        );
    }
}
