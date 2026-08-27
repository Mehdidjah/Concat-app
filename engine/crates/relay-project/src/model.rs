//! The document model: what a WolfCut project *is*.
//!
//! This is the same shape `desktop/src/lib/project.ts` holds - deliberately,
//! field for field, because the two must describe identical documents while
//! the UI migrates onto this crate. Times are `f64` seconds here because that
//! is what the on-disk format stores; the conversion to exact rationals stays
//! at the render boundary (`export.rs`), exactly as it does today. Moving the
//! *document* to rational time is a format decision for later, made once,
//! here, instead of twice.
//!
//! Serde names are camelCase so a document written by this crate is byte-level
//! compatible with one written by the TypeScript side.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a piece of media is. A still is not a video with one frame: it has no
/// intrinsic duration, so its length on a timeline is editorial.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

/// What a clip can be - wider than [`MediaKind`] because a text clip has no
/// file behind it; it *is* its own content.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    Video,
    Audio,
    Image,
    Text,
}

impl ClipKind {
    /// True for the kinds that put pixels on screen.
    pub fn is_visual(self) -> bool {
        matches!(self, ClipKind::Video | ClipKind::Image)
    }
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: String,
    pub path: String,
    pub name: String,
    /// Seconds. None when the container did not say.
    pub duration: Option<f64>,
    pub kind: MediaKind,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub frame_rate: Option<f64>,
    /// The exact fraction the engine works in, e.g. "30000/1001".
    pub frame_rate_fraction: Option<String>,
    pub video_codec: Option<String>,
    pub audio_codec: Option<String>,
    pub has_audio: bool,
}

/// A lane. Deliberately untyped: any media goes on any track.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    /// Video clips on this track are left out of the composite when false.
    pub visible: bool,
    /// Audio on this track is silent when true.
    pub muted: bool,
}

/// One applied audio filter or video effect: a catalogue id plus whatever
/// parameters were set. The catalogues themselves (and the FFmpeg strings
/// they build) live in the UI today; the model only stores the numbers.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedFilter {
    pub id: String,
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
    /// False bypasses without losing settings. Absent means enabled.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// A transition on the cut into a clip.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    pub id: String,
    /// Seconds the transition covers.
    pub duration: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    Left,
    Center,
    Right,
}

/// A title's styling. Sizes are fractions of the frame, so a title composed
/// against 1080p lands correctly exported at 4K.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    pub content: String,
    pub font_family: String,
    /// Cap height as a fraction of frame height.
    pub font_size: f64,
    pub font_weight: f64,
    pub italic: bool,
    pub color: String,
    pub align: TextAlign,
    pub opacity: f64,
    pub stroke_width: f64,
    pub stroke_color: String,
    pub shadow: bool,
    /// A solid plate behind the text. Empty string for none.
    pub background: String,
    pub line_height: f64,
    pub tracking: f64,
}

impl Default for TextStyle {
    fn default() -> Self {
        Self {
            content: "Your text".to_owned(),
            font_family: "\"Cabinet Grotesk\"".to_owned(),
            font_size: 0.09,
            font_weight: 700.0,
            italic: false,
            color: "#ffffff".to_owned(),
            align: TextAlign::Center,
            opacity: 1.0,
            stroke_width: 0.0,
            stroke_color: "#000000".to_owned(),
            shadow: true,
            background: String::new(),
            line_height: 1.2,
            tracking: 0.0,
        }
    }
}

#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    pub id: String,
    pub track_id: String,
    /// Empty for a text clip, which has no file behind it.
    pub media_id: String,
    pub name: String,
    pub kind: ClipKind,
    /// Seconds from the start of the timeline.
    pub start: f64,
    pub duration: f64,
    /// In-point: how far into the media the clip starts.
    pub source_start: f64,
    /// Linear gain, 1 being unity.
    pub volume: f64,
    pub fade_in: f64,
    pub fade_out: f64,
    /// Multiplier over the fitted size. 1 fills the frame, preserving aspect.
    pub scale: f64,
    /// Offset from centred, as a fraction of frame width / height.
    pub offset_x: f64,
    pub offset_y: f64,
    /// Clockwise rotation in degrees, about the picture's centre.
    pub rotation: f64,
    /// Blend strength over whatever is beneath, in 0..1.
    pub opacity: f64,
    /// Playback rate. 1 is normal.
    pub speed: f64,
    pub preserve_pitch: bool,
    /// Audio filters, in order - order is audible.
    #[serde(default)]
    pub filters: Vec<AppliedFilter>,
    /// Video effects, in order - the visual sibling of `filters`.
    #[serde(default)]
    pub video_effects: Vec<AppliedFilter>,
    /// True when a video clip's embedded audio is detached out of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub muted: Option<bool>,
    /// On a detached audio clip: the video clip the sound came from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_from: Option<String>,
    /// The transition on the cut into this clip, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_in: Option<Transition>,
    /// The overlay, when this is a text clip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<TextStyle>,
}

/// One timeline: a name and its lanes and clips. Unlike the UI's provisional
/// model there is no "shelf" - that split existed only so the TypeScript
/// operations could stay ignorant of timelines. Here every operation takes
/// the project and works on whichever timeline is active.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    pub id: String,
    pub name: String,
    pub tracks: Vec<Track>,
    pub clips: Vec<Clip>,
}

/// A font the user added from disk.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFont {
    pub family: String,
    pub path: String,
}

/// The edit: everything the document stores except the app-level settings
/// (name, output format) that the host manages around it.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub media: Vec<MediaItem>,
    pub fonts: Vec<CustomFont>,
    /// Every timeline, in tab order. Always at least one.
    pub timelines: Vec<Timeline>,
    pub active_timeline_id: String,
}

impl Project {
    /// A new project: one timeline, four lanes.
    pub fn new() -> Self {
        Self {
            media: Vec::new(),
            fonts: Vec::new(),
            timelines: vec![Timeline {
                id: "TL1".to_owned(),
                name: "Timeline 1".to_owned(),
                tracks: (1..=4)
                    .map(|number| Track {
                        id: format!("T{number}"),
                        name: format!("Track {number}"),
                        visible: true,
                        muted: false,
                    })
                    .collect(),
                clips: Vec::new(),
            }],
            active_timeline_id: "TL1".to_owned(),
        }
    }

    /// The timeline being edited. The active id is maintained by the command
    /// layer, so a broken invariant here is a bug, not user input - but it
    /// degrades to the first timeline rather than panicking.
    pub fn active(&self) -> &Timeline {
        self.timelines
            .iter()
            .find(|timeline| timeline.id == self.active_timeline_id)
            .unwrap_or(&self.timelines[0])
    }

    pub fn active_mut(&mut self) -> &mut Timeline {
        let index = self
            .timelines
            .iter()
            .position(|timeline| timeline.id == self.active_timeline_id)
            .unwrap_or(0);
        &mut self.timelines[index]
    }

    pub fn media_by_id(&self, media_id: &str) -> Option<&MediaItem> {
        self.media.iter().find(|item| item.id == media_id)
    }
}

impl Default for Project {
    fn default() -> Self {
        Self::new()
    }
}

impl Timeline {
    pub fn clip(&self, clip_id: &str) -> Option<&Clip> {
        self.clips.iter().find(|clip| clip.id == clip_id)
    }

    pub fn clip_mut(&mut self, clip_id: &str) -> Option<&mut Clip> {
        self.clips.iter_mut().find(|clip| clip.id == clip_id)
    }

    pub fn track(&self, track_id: &str) -> Option<&Track> {
        self.tracks.iter().find(|track| track.id == track_id)
    }

    /// Where the last clip ends. Zero for an empty timeline.
    pub fn duration(&self) -> f64 {
        self.clips
            .iter()
            .map(|clip| clip.start + clip.duration)
            .fold(0.0, f64::max)
    }
}
