// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! The document model: what a Concat project *is*.
//!
//! Times are `f64` seconds here because that is what the on-disk format
//! stores, and the documents that exist freeze the format. The conversion
//! to exact rationals stays at the render boundary - `concat-export`'s
//! timeline builder. Moving the *document* to rational time is a format
//! decision for a deliberate version 2, made once, here.
//!
//! Serde names are camelCase: that is the document's spelling.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// What a piece of media is. A still is not a video with one frame: it has no
/// intrinsic duration, so its length on a timeline is editorial.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    /// Moving pictures, with or without embedded sound.
    Video,
    /// Sound only; nothing to composite.
    Audio,
    /// A still, whose timeline length is editorial rather than intrinsic.
    Image,
}

/// What a clip can be - wider than [`MediaKind`] because a text clip has no
/// file behind it; it *is* its own content.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClipKind {
    /// A cut of a video media item.
    Video,
    /// A cut of audio - either audio media or sound detached from a video.
    Audio,
    /// A placed still.
    Image,
    /// A title. No media behind it; the content lives in [`Clip::text`].
    Text,
    /// A treatment over everything beneath it for as long as it runs - a
    /// look or an effect placed as a layer. No media behind it; the chain
    /// lives in [`Clip::video_effects`], its strength in [`Clip::opacity`]
    /// and its ramps in the fades.
    Layer,
}

impl ClipKind {
    /// True for the kinds that put pixels on screen.
    pub fn is_visual(self) -> bool {
        matches!(self, ClipKind::Video | ClipKind::Image)
    }
}

/// One entry in the media bin: a file the user imported, plus what the host's
/// probe learned about it. The probe metadata is stored, not re-derived, so a
/// document opens meaningfully even when the file itself is missing.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    /// Minted by the editor ("m1", "m2", ...) and never re-issued, even
    /// across a save/load - clips reference media by this id.
    pub id: String,
    /// Absolute path on the user's disk. Doubles as the duplicate check:
    /// adding the same path twice is a no-op.
    pub path: String,
    /// Display name in the bin, normally the file's basename.
    pub name: String,
    /// Seconds. None when the container did not say.
    pub duration: Option<f64>,
    /// What the probe decided the file is; fixes which [`ClipKind`] its
    /// clips get.
    pub kind: MediaKind,
    /// Pixel width, when the file has pictures and the probe found one.
    pub width: Option<u32>,
    /// Pixel height, same terms as `width`.
    pub height: Option<u32>,
    /// Frames per second as a decimal - convenient for display, not exact.
    pub frame_rate: Option<f64>,
    /// The exact fraction the engine works in, e.g. "30000/1001".
    pub frame_rate_fraction: Option<String>,
    /// Codec name as the probe reported it, e.g. "h264". Informational.
    pub video_codec: Option<String>,
    /// Codec of the embedded audio, when there is any.
    pub audio_codec: Option<String>,
    /// Whether the file carries an audio stream; gates `DetachAudio`.
    pub has_audio: bool,
    /// True when this item is a template slot: a stand-in whose metadata says
    /// what kind of media belongs here, waiting to be replaced by the user's
    /// own file (`Command::FillSlot`). In a creator's own project the path is
    /// still real; only a packed template bundle blanks it. Skipped when
    /// false, so documents without templates stay byte-identical.
    #[serde(default, skip_serializing_if = "is_false")]
    pub placeholder: bool,
}

fn unity() -> f64 {
    1.0
}

fn is_unity(value: &f64) -> bool {
    *value == 1.0
}

fn is_zero(value: &f64) -> bool {
    *value == 0.0
}

fn is_false(value: &bool) -> bool {
    !value
}

/// A lane. Deliberately untyped: any media goes on any track.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// Minted per timeline ("t5", or "T1".."T4" for the first timeline's
    /// starter lanes); never shared between timelines.
    pub id: String,
    /// User-editable label. Renames to whitespace are ignored, so it is
    /// never blank.
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
    /// Which catalogue entry this is, e.g. "sepia". Not minted; an id the
    /// catalogue no longer knows is simply skipped at render time.
    pub id: String,
    /// The user's knob settings, keyed by parameter name. Missing keys mean
    /// the catalogue's defaults; ordered so serialisation is stable.
    #[serde(default)]
    pub params: BTreeMap<String, f64>,
    /// False bypasses without losing settings. Absent means enabled.
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

/// How a picture's background is taken away when there is no key colour
/// to remove: a person mask found by the cutout model, alone or corrected
/// by hand.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cutout {
    /// Automatic keeps what the model finds; custom adds the strokes.
    pub mode: CutoutMode,
    /// How far the edge is softened, as a fraction of the picture's width.
    #[serde(default = "default_feather")]
    pub feather: f64,
    /// Corrections painted on the monitor, in the order they were made.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub strokes: Vec<Stroke>,
}

/// The two ways a cutout decides what stays.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CutoutMode {
    /// The model's mask as it is.
    Auto,
    /// The model's mask, then the strokes over it.
    Custom,
}

/// One brush stroke over a cutout: which tool, how wide, and where it went.
/// Points are fractions of the source picture, `(0, 0)` its top-left, so a
/// stroke survives a change of output size, a crop or a flip.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    /// What the stroke does to the mask beneath it.
    pub tool: BrushTool,
    /// The brush's diameter as a fraction of the picture's width.
    pub size: f64,
    /// The path, as `[x, y]` fractions.
    pub points: Vec<[f64; 2]>,
}

/// The four brushes of a custom cutout.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrushTool {
    /// Keeps what the model thought might be the subject under the stroke.
    SmartBrush,
    /// Keeps everything under the stroke.
    Brush,
    /// Removes what the model was unsure of under the stroke.
    SmartEraser,
    /// Removes everything under the stroke.
    Eraser,
}

/// A geometric or hand-authored alpha mask attached to a picture clip.
///
/// Coordinates are relative to the decoded picture rather than the output
/// frame, so the mask follows crop, flip, placement and animation exactly as
/// if it had been painted on the source itself.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipMask {
    /// Stable identity used by the inspector and namespaced keyframe tracks.
    pub id: String,
    /// The analytic or authored geometry this mask uses.
    pub shape: MaskShape,
    /// Whether this mask participates while the clip-level switch is on.
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Keeps everything outside the shape instead of everything inside it.
    #[serde(default)]
    pub inverted: bool,
    /// Centre offset: -1 is the leading/top edge, 0 is centred, 1 the
    /// trailing/bottom edge.
    #[serde(default)]
    pub position_x: f64,
    /// Vertical centre offset on the same terms as `position_x`.
    #[serde(default)]
    pub position_y: f64,
    /// Fractions of the decoded picture's width and height.
    #[serde(default = "default_mask_size")]
    pub width: f64,
    /// Fraction of the decoded picture's height.
    #[serde(default = "default_mask_size")]
    pub height: f64,
    /// Clockwise degrees about the mask's centre.
    #[serde(default)]
    pub rotation: f64,
    /// Edge softness as a fraction of the shorter picture edge.
    #[serde(default)]
    pub feather: f64,
    /// Rectangle/filmstrip corner radius, 0 square through 1 pill-shaped.
    #[serde(default)]
    pub roundness: f64,
    /// Whether the inspector edits width and height together.
    #[serde(default = "yes")]
    pub linked: bool,
    /// Words cut through a Text mask. Other shapes ignore this.
    #[serde(default = "default_mask_text")]
    pub text: String,
    /// Brush path or Pen polygon in source-picture fractions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub points: Vec<[f64; 2]>,
    /// Brush diameter as a fraction of picture width.
    #[serde(default = "default_mask_brush")]
    pub brush_size: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
/// Built-in geometric and authored mask kinds.
pub enum MaskShape {
    /// One side of a rotatable dividing line.
    Split,
    /// Three parallel rounded bands.
    Filmstrip,
    /// An ellipse inside the configured bounds.
    Circle,
    #[default]
    /// A rectangle with optional rounded corners.
    Rectangle,
    /// A five-point star.
    Star,
    /// A heart silhouette.
    Heart,
    /// The alpha of a rendered text string.
    Text,
    /// A freehand round brush path.
    Brush,
    /// A closed user-authored polygon.
    Pen,
}

impl MaskShape {
    /// Inspector order, kept stable because Slint transports the ordinal.
    pub const ALL: [Self; 9] = [
        Self::Split,
        Self::Filmstrip,
        Self::Circle,
        Self::Rectangle,
        Self::Star,
        Self::Heart,
        Self::Text,
        Self::Brush,
        Self::Pen,
    ];

    /// Human-facing English name used as a translation key.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Split => "Split",
            Self::Filmstrip => "Filmstrip",
            Self::Circle => "Circle",
            Self::Rectangle => "Rectangle",
            Self::Star => "Stars",
            Self::Heart => "Heart",
            Self::Text => "Text",
            Self::Brush => "Brush",
            Self::Pen => "Pen",
        }
    }
}

/// A mask setting that may use the same namespaced keyframe model as an
/// effect parameter or clip transform.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MaskProperty {
    /// Horizontal centre offset.
    PositionX,
    /// Vertical centre offset.
    PositionY,
    /// Clockwise degrees.
    Rotation,
    /// Fraction of source width.
    Width,
    /// Fraction of source height.
    Height,
    /// Soft edge radius.
    Feather,
    /// Rectangle corner radius.
    Roundness,
}

impl MaskProperty {
    /// Inspector order, kept stable because Slint transports the ordinal.
    pub const ALL: [Self; 7] = [
        Self::PositionX,
        Self::PositionY,
        Self::Rotation,
        Self::Width,
        Self::Height,
        Self::Feather,
        Self::Roundness,
    ];

    /// The suffix used by this property's namespaced keyframe track.
    pub const fn suffix(self) -> &'static str {
        match self {
            Self::PositionX => "positionX",
            Self::PositionY => "positionY",
            Self::Rotation => "rotation",
            Self::Width => "width",
            Self::Height => "height",
            Self::Feather => "feather",
            Self::Roundness => "roundness",
        }
    }

    /// Stable keyframe track id for one mask's property.
    pub fn id(self, mask_id: &str) -> String {
        format!("mask:{mask_id}:{}", self.suffix())
    }
}

fn default_mask_size() -> f64 {
    0.65
}

fn default_mask_text() -> String {
    "TEXT".to_owned()
}

fn default_mask_brush() -> f64 {
    0.08
}

impl ClipMask {
    /// Makes one mask in its shape-appropriate useful default size.
    pub fn new(id: String, shape: MaskShape) -> Self {
        let (width, height, roundness) = match shape {
            MaskShape::Split => (2.0, 1.0, 0.0),
            MaskShape::Filmstrip => (1.2, 0.35, 0.08),
            MaskShape::Circle => (0.65, 0.65, 1.0),
            MaskShape::Rectangle => (0.7, 0.55, 0.08),
            MaskShape::Star => (0.65, 0.65, 0.0),
            MaskShape::Heart => (0.68, 0.62, 0.0),
            MaskShape::Text => (0.85, 0.35, 0.0),
            MaskShape::Brush => (1.0, 1.0, 0.0),
            MaskShape::Pen => (1.0, 1.0, 0.0),
        };
        Self {
            id,
            shape,
            enabled: true,
            inverted: false,
            position_x: 0.0,
            position_y: 0.0,
            width,
            height,
            rotation: 0.0,
            feather: 0.0,
            roundness,
            linked: true,
            text: default_mask_text(),
            points: Vec::new(),
            brush_size: default_mask_brush(),
        }
    }

    /// Reads an animatable property.
    pub fn value(&self, property: MaskProperty) -> f64 {
        match property {
            MaskProperty::PositionX => self.position_x,
            MaskProperty::PositionY => self.position_y,
            MaskProperty::Rotation => self.rotation,
            MaskProperty::Width => self.width,
            MaskProperty::Height => self.height,
            MaskProperty::Feather => self.feather,
            MaskProperty::Roundness => self.roundness,
        }
    }

    /// Writes and clamps an animatable property.
    pub fn set_value(&mut self, property: MaskProperty, value: f64) {
        let value = match property {
            MaskProperty::PositionX | MaskProperty::PositionY => value.clamp(-2.0, 2.0),
            MaskProperty::Rotation => value.clamp(-3600.0, 3600.0),
            MaskProperty::Width | MaskProperty::Height => value.clamp(0.01, 4.0),
            MaskProperty::Feather => value.clamp(0.0, 0.5),
            MaskProperty::Roundness => value.clamp(0.0, 1.0),
        };
        match property {
            MaskProperty::PositionX => self.position_x = value,
            MaskProperty::PositionY => self.position_y = value,
            MaskProperty::Rotation => self.rotation = value,
            MaskProperty::Width => self.width = value,
            MaskProperty::Height => self.height = value,
            MaskProperty::Feather => self.feather = value,
            MaskProperty::Roundness => self.roundness = value,
        }
    }

    /// Normalises values read from a document or received in a command.
    pub fn tidy(mut self) -> Self {
        self.position_x = finite_or(self.position_x, 0.0).clamp(-2.0, 2.0);
        self.position_y = finite_or(self.position_y, 0.0).clamp(-2.0, 2.0);
        self.width = finite_or(self.width, default_mask_size()).clamp(0.01, 4.0);
        self.height = finite_or(self.height, default_mask_size()).clamp(0.01, 4.0);
        self.rotation = finite_or(self.rotation, 0.0).clamp(-3600.0, 3600.0);
        self.feather = finite_or(self.feather, 0.0).clamp(0.0, 0.5);
        self.roundness = finite_or(self.roundness, 0.0).clamp(0.0, 1.0);
        self.brush_size = finite_or(self.brush_size, default_mask_brush()).clamp(0.002, 1.0);
        self.text = self.text.trim().chars().take(120).collect();
        if self.text.is_empty() {
            self.text = default_mask_text();
        }
        self.points
            .retain(|point| point.iter().all(|value| value.is_finite()));
        for [x, y] in &mut self.points {
            if *x < 0.0 && *y < 0.0 {
                *x = -1.0;
                *y = -1.0;
                continue;
            }
            *x = x.clamp(0.0, 1.0);
            *y = y.clamp(0.0, 1.0);
        }
        self
    }
}

/// The edge softness a cutout starts with.
pub const DEFAULT_FEATHER: f64 = 0.01;
/// The widest an edge may be softened.
pub const MAX_FEATHER: f64 = 0.1;
/// The brush's narrowest and widest, as fractions of the picture's width.
pub const MIN_BRUSH: f64 = 0.005;
/// See [`MIN_BRUSH`].
pub const MAX_BRUSH: f64 = 0.5;

fn default_feather() -> f64 {
    DEFAULT_FEATHER
}

impl Cutout {
    /// An automatic cutout with the default edge.
    pub fn auto() -> Cutout {
        Cutout {
            mode: CutoutMode::Auto,
            feather: DEFAULT_FEATHER,
            strokes: Vec::new(),
        }
    }

    /// The feather held to its range, every stroke to its own, and strokes
    /// with nowhere to go dropped.
    pub fn tidy(mut self) -> Cutout {
        self.feather = if self.feather.is_finite() {
            self.feather.clamp(0.0, MAX_FEATHER)
        } else {
            DEFAULT_FEATHER
        };
        self.strokes = self.strokes.into_iter().filter_map(Stroke::tidy).collect();
        self
    }
}

impl Stroke {
    /// The size held to its range and the points to the picture; `None`
    /// for a stroke with no points left.
    pub fn tidy(mut self) -> Option<Stroke> {
        self.size = if self.size.is_finite() {
            self.size.clamp(MIN_BRUSH, MAX_BRUSH)
        } else {
            MIN_BRUSH
        };
        self.points.retain(|[x, y]| x.is_finite() && y.is_finite());
        for point in &mut self.points {
            point[0] = point[0].clamp(-0.5, 1.5);
            point[1] = point[1].clamp(-0.5, 1.5);
        }
        (!self.points.is_empty()).then_some(self)
    }
}

/// A crop: what is taken off each edge, as fractions of the source.
#[derive(Clone, Copy, PartialEq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Crop {
    /// Off the left, `0..1`.
    pub left: f64,
    /// Off the top.
    pub top: f64,
    /// Off the right.
    pub right: f64,
    /// Off the bottom.
    pub bottom: f64,
}

impl Crop {
    /// True when nothing is cut.
    pub fn is_none(&self) -> bool {
        self.left <= 0.0 && self.top <= 0.0 && self.right <= 0.0 && self.bottom <= 0.0
    }

    /// Each edge held to `0..=0.9`, and a pair that would meet pulled back
    /// so at least a tenth of the picture is left.
    pub fn tidy(self) -> Crop {
        let mut out = Crop {
            left: self.left.clamp(0.0, 0.9),
            top: self.top.clamp(0.0, 0.9),
            right: self.right.clamp(0.0, 0.9),
            bottom: self.bottom.clamp(0.0, 0.9),
        };
        if out.left + out.right > 0.9 {
            out.right = (0.9 - out.left).max(0.0);
        }
        if out.top + out.bottom > 0.9 {
            out.bottom = (0.9 - out.top).max(0.0);
        }
        out
    }
}

/// Which end of a clip an animation belongs to, or the whole of it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AnimationSlot {
    /// The first seconds.
    In,
    /// The last seconds.
    Out,
    /// The whole clip.
    Combo,
}

/// A named animation on one slot. The keys are made from the name for the
/// clip's current length whenever they are needed; see the `animation`
/// module.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipAnimation {
    /// The shape's name, e.g. "Fade".
    pub preset: String,
    /// Seconds the shape takes, for In and Out; ignored by a Combo.
    pub duration: f64,
}

/// How a custom keyframe is approached from the preceding key.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeyframeEase {
    /// Straight line between points.
    #[default]
    Linear,
    /// Starts slowly and arrives quickly.
    In,
    /// Starts quickly and eases into the point.
    Out,
    /// Eases at both ends of the segment.
    InOut,
}

/// A custom temporal cubic Bezier. X is time and Y is interpolation progress;
/// both handles stay normalised so the same curve works at every clip length.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemporalCurve {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

impl Default for TemporalCurve {
    fn default() -> Self {
        Self {
            x1: 0.25,
            y1: 0.1,
            x2: 0.25,
            y2: 1.0,
        }
    }
}

impl TemporalCurve {
    pub fn tidy(mut self) -> Self {
        self.x1 = finite_or(self.x1, 0.25).clamp(0.0, 1.0);
        self.y1 = finite_or(self.y1, 0.1).clamp(-2.0, 3.0);
        self.x2 = finite_or(self.x2, 0.25).clamp(0.0, 1.0);
        self.y2 = finite_or(self.y2, 1.0).clamp(-2.0, 3.0);
        self
    }
}

fn finite_or(value: f64, fallback: f64) -> f64 {
    value.is_finite().then_some(value).unwrap_or(fallback)
}

/// What an animation track does after its final key.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PostKeyBehavior {
    /// Keep the final keyed value.
    #[default]
    Hold,
    /// Return to the property's unkeyed value.
    Reset,
    /// Repeat the keyed time span.
    Loop,
    /// Continue with the final segment's slope.
    Extrapolate,
}

impl KeyframeEase {
    /// Map a linear segment fraction through this easing shape.
    pub fn apply(self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Self::Linear => t,
            Self::In => t * t,
            Self::Out => 1.0 - (1.0 - t) * (1.0 - t),
            Self::InOut => {
                if t < 0.5 {
                    2.0 * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
                }
            }
        }
    }
}

/// One editable animation point on one clip property.
///
/// Unlike preset animation keys, these values are absolute: a scale key of
/// `1.5` means 150%, and an X key of `0.1` means one tenth of the frame to
/// the right. That is also what the inspector displays and saves.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipKeyframe {
    /// Where in the clip, `0..=1`.
    pub at: f64,
    /// The property's value at that point.
    pub value: f64,
    /// How this point is approached from the preceding point.
    #[serde(default)]
    pub ease: KeyframeEase,
    /// An optional temporal curve, independent from Position's spatial path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temporal_curve: Option<TemporalCurve>,
    /// Incoming Position tangent in frame-relative X/Y units. Non-position
    /// tracks ignore it, but keeping it on the generic point makes selection,
    /// persistence and undo identical for every property.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_in: Option<[f64; 2]>,
    /// Outgoing Position tangent, separate from temporal easing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spatial_out: Option<[f64; 2]>,
}

impl ClipKeyframe {
    pub fn linear(at: f64, value: f64) -> Self {
        Self {
            at,
            value,
            ease: KeyframeEase::Linear,
            temporal_curve: None,
            spatial_in: None,
            spatial_out: None,
        }
    }
}

/// The one storage format used for every animatable property. Dynamic ids
/// such as `effect:blur:radius`, `expression:slider`, `element:title:x`, and
/// `mesh:face:vertex:12:y` use exactly the same representation as transform
/// properties.
#[derive(Clone, PartialEq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipKeyframeTrack {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keys: Vec<ClipKeyframe>,
    #[serde(default, skip_serializing_if = "is_hold")]
    pub post: PostKeyBehavior,
}

fn is_hold(value: &PostKeyBehavior) -> bool {
    *value == PostKeyBehavior::Hold
}

impl<'de> Deserialize<'de> for ClipKeyframeTrack {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            // Projects created by the first keyframe implementation stored a
            // bare array. Accept it forever as a Hold track.
            Legacy(Vec<ClipKeyframe>),
            Current {
                #[serde(default)]
                keys: Vec<ClipKeyframe>,
                #[serde(default)]
                post: PostKeyBehavior,
            },
        }
        Ok(match Wire::deserialize(deserializer)? {
            Wire::Legacy(keys) => Self {
                keys,
                post: PostKeyBehavior::Hold,
            },
            Wire::Current { keys, post } => Self { keys, post },
        })
    }
}

/// The independently editable keyframe track for every animatable clip
/// property. Empty tracks cost nothing in a project document.
#[derive(Clone, PartialEq, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipKeyframes {
    /// Property id to track. Built-ins use stable camelCase ids; namespaced
    /// ids carry effect, expression, element and mesh animation without a
    /// document schema change.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tracks: BTreeMap<String, ClipKeyframeTrack>,
}

impl<'de> Deserialize<'de> for ClipKeyframes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Default, Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Wire {
            #[serde(default)]
            tracks: BTreeMap<String, ClipKeyframeTrack>,
            #[serde(default)]
            scale: Vec<ClipKeyframe>,
            #[serde(default)]
            offset_x: Vec<ClipKeyframe>,
            #[serde(default)]
            offset_y: Vec<ClipKeyframe>,
            #[serde(default)]
            rotation: Vec<ClipKeyframe>,
            #[serde(default)]
            opacity: Vec<ClipKeyframe>,
        }
        let mut wire = Wire::deserialize(deserializer)?;
        for (id, keys) in [
            ("scale", wire.scale),
            ("offsetX", wire.offset_x),
            ("offsetY", wire.offset_y),
            ("rotation", wire.rotation),
            ("opacity", wire.opacity),
        ] {
            if !keys.is_empty() {
                wire.tracks
                    .entry(id.to_owned())
                    .or_insert(ClipKeyframeTrack {
                        keys,
                        post: PostKeyBehavior::Hold,
                    });
            }
        }
        Ok(Self {
            tracks: wire.tracks,
        })
    }
}

/// One of the properties represented by [`ClipKeyframes`].
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyframeProperty {
    /// Fitted-size multiplier.
    Scale,
    /// Horizontal frame offset.
    OffsetX,
    /// Vertical frame offset.
    OffsetY,
    /// Horizontal anchor/pivot relative to the picture centre.
    AnchorX,
    /// Vertical anchor/pivot relative to the picture centre.
    AnchorY,
    /// Clockwise angle.
    Rotation,
    /// Rotation around the horizontal axis.
    RotationX,
    /// Rotation around the vertical axis.
    RotationY,
    /// Position toward/away from the camera.
    PositionZ,
    /// Independent horizontal scale.
    StretchX,
    /// Independent vertical scale.
    StretchY,
    /// Blend strength.
    Opacity,
    /// Relative stacking offset from the clip's lane.
    LayerOrder,
    /// Playback rate over the clip.
    TimeRemap,
}

impl KeyframeProperty {
    pub const ALL: [Self; 14] = [
        Self::Scale,
        Self::OffsetX,
        Self::OffsetY,
        Self::AnchorX,
        Self::AnchorY,
        Self::Rotation,
        Self::RotationX,
        Self::RotationY,
        Self::PositionZ,
        Self::StretchX,
        Self::StretchY,
        Self::Opacity,
        Self::LayerOrder,
        Self::TimeRemap,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Scale => "scale",
            Self::OffsetX => "offsetX",
            Self::OffsetY => "offsetY",
            Self::AnchorX => "anchorX",
            Self::AnchorY => "anchorY",
            Self::Rotation => "rotation",
            Self::RotationX => "rotationX",
            Self::RotationY => "rotationY",
            Self::PositionZ => "positionZ",
            Self::StretchX => "stretchX",
            Self::StretchY => "stretchY",
            Self::Opacity => "opacity",
            Self::LayerOrder => "layerOrder",
            Self::TimeRemap => "timeRemap",
        }
    }
}

impl ClipKeyframes {
    /// Construct a set from built-in property tracks. This is also convenient
    /// for importers while the on-disk representation remains generic.
    pub fn from_tracks(
        tracks: impl IntoIterator<Item = (KeyframeProperty, Vec<ClipKeyframe>)>,
    ) -> Self {
        let mut out = Self::default();
        for (property, keys) in tracks {
            out.named_track_mut(property.id()).keys = keys;
        }
        out.tidy()
    }

    /// True when no property has a key.
    pub fn is_empty(&self) -> bool {
        self.tracks.values().all(|track| track.keys.is_empty())
    }

    /// The selected property's sorted keys.
    pub fn track(&self, property: KeyframeProperty) -> &[ClipKeyframe] {
        self.named_track(property.id())
    }

    /// The selected property's mutable keys.
    pub fn track_mut(&mut self, property: KeyframeProperty) -> &mut Vec<ClipKeyframe> {
        &mut self.named_track_mut(property.id()).keys
    }

    pub fn named_track(&self, id: &str) -> &[ClipKeyframe] {
        self.tracks
            .get(id)
            .map_or(&[], |track| track.keys.as_slice())
    }

    pub fn named_track_mut(&mut self, id: &str) -> &mut ClipKeyframeTrack {
        self.tracks.entry(id.to_owned()).or_default()
    }

    pub fn post_behavior(&self, property: KeyframeProperty) -> PostKeyBehavior {
        self.named_post_behavior(property.id())
    }

    pub fn set_post_behavior(&mut self, property: KeyframeProperty, post: PostKeyBehavior) {
        self.named_track_mut(property.id()).post = post;
    }

    /// The end behavior of a built-in or namespaced property.
    pub fn named_post_behavior(&self, id: &str) -> PostKeyBehavior {
        self.tracks
            .get(id)
            .map_or(PostKeyBehavior::Hold, |track| track.post)
    }

    /// The track's interpolated absolute value at `at`, or `rest` when it is
    /// empty.
    pub fn value_at(&self, property: KeyframeProperty, at: f64, rest: f64) -> f64 {
        self.named_value_at(property.id(), at, rest)
    }

    /// Evaluate any property id with the same binary-search path used by the
    /// built-ins.
    pub fn named_value_at(&self, id: &str, at: f64, rest: f64) -> f64 {
        let keys = self.named_track(id);
        let Some(first) = keys.first() else {
            return rest;
        };
        if at <= first.at {
            return first.value;
        }
        let right_index = keys.partition_point(|key| key.at < at);
        if right_index >= keys.len() {
            let last = keys[keys.len() - 1];
            return match self.named_post_behavior(id) {
                PostKeyBehavior::Hold => last.value,
                PostKeyBehavior::Reset => rest,
                PostKeyBehavior::Loop if keys.len() > 1 => {
                    let span = last.at - first.at;
                    if span <= f64::EPSILON {
                        last.value
                    } else {
                        let wrapped = first.at + (at - first.at).rem_euclid(span);
                        return self.named_value_at(id, wrapped, rest);
                    }
                }
                PostKeyBehavior::Extrapolate if keys.len() > 1 => {
                    let before = keys[keys.len() - 2];
                    let span = last.at - before.at;
                    if span <= f64::EPSILON {
                        last.value
                    } else {
                        last.value + (last.value - before.value) * (at - last.at) / span
                    }
                }
                PostKeyBehavior::Loop | PostKeyBehavior::Extrapolate => last.value,
            };
        }
        let (left, right) = (keys[right_index - 1], keys[right_index]);
        let span = right.at - left.at;
        if span <= f64::EPSILON {
            return right.value;
        }
        let linear = (at - left.at) / span;
        let t = right.temporal_curve.map_or_else(
            || right.ease.apply(linear),
            |curve| {
                concat_core::animate::CubicBezier {
                    x1: curve.x1,
                    y1: curve.y1,
                    x2: curve.x2,
                    y2: curve.y2,
                }
                .solve(linear)
            },
        );
        left.value + (right.value - left.value) * t
    }

    /// Sample one generic track through the canonical evaluator. Consumers
    /// which need a piecewise-linear representation (notably media retiming)
    /// use this rather than reimplementing key lookup or easing.
    pub fn sampled_named_values(&self, id: &str, rest: f64, segments: usize) -> Vec<(f64, f64)> {
        let segments = segments.max(1);
        (0..=segments)
            .map(|index| {
                let at = index as f64 / segments as f64;
                (at, self.named_value_at(id, at, rest))
            })
            .collect()
    }

    /// Mean value of a sampled generic track. Trapezoidal integration keeps
    /// this identical to the `SpeedCurve` consumed by preview and export.
    pub fn named_mean(&self, id: &str, rest: f64, segments: usize) -> f64 {
        self.sampled_named_values(id, rest, segments)
            .windows(2)
            .map(|pair| (pair[1].0 - pair[0].0) * (pair[0].1 + pair[1].1) / 2.0)
            .sum()
    }

    /// Whether this property has a key close enough to the playhead to be
    /// considered the current frame.
    pub fn has_at(&self, property: KeyframeProperty, at: f64, tolerance: f64) -> bool {
        self.named_has_at(property.id(), at, tolerance)
    }

    /// Whether any namespaced track has a key on the current frame.
    pub fn named_has_at(&self, id: &str, at: f64, tolerance: f64) -> bool {
        let keys = self.named_track(id);
        let index = keys.partition_point(|key| key.at < at);
        keys.get(index)
            .is_some_and(|key| (key.at - at).abs() <= tolerance)
            || index
                .checked_sub(1)
                .and_then(|before| keys.get(before))
                .is_some_and(|key| (key.at - at).abs() <= tolerance)
    }

    /// Insert or replace a key at the playhead.
    pub fn set_at(&mut self, property: KeyframeProperty, at: f64, value: f64, tolerance: f64) {
        self.set_named_at(property.id(), at, value, tolerance);
    }

    /// Insert or replace a key on a namespaced property.
    pub fn set_named_at(&mut self, id: &str, at: f64, value: f64, tolerance: f64) {
        let at = at.clamp(0.0, 1.0);
        let keys = &mut self.named_track_mut(id).keys;
        if let Some(key) = keys.iter_mut().find(|key| (key.at - at).abs() <= tolerance) {
            key.at = at;
            key.value = value;
        } else {
            keys.push(ClipKeyframe::linear(at, value));
        }
        keys.sort_by(|left, right| left.at.total_cmp(&right.at));
    }

    /// Remove the key on the current frame, leaving neighbouring keys alone.
    pub fn remove_at(&mut self, property: KeyframeProperty, at: f64, tolerance: f64) -> bool {
        self.remove_named_at(property.id(), at, tolerance)
    }

    /// Remove the key on the current frame from a namespaced property.
    pub fn remove_named_at(&mut self, id: &str, at: f64, tolerance: f64) -> bool {
        let keys = &mut self.named_track_mut(id).keys;
        let before = keys.len();
        keys.retain(|key| (key.at - at).abs() > tolerance);
        keys.len() != before
    }

    /// Drop invalid values, clamp times and property values, sort tracks and
    /// collapse duplicate times. This is used for hand-edited documents too.
    pub fn tidy(mut self) -> Self {
        for (id, track) in &mut self.tracks {
            let property = KeyframeProperty::ALL
                .into_iter()
                .find(|property| property.id() == id);
            let keys = &mut track.keys;
            keys.retain(|key| key.at.is_finite() && key.value.is_finite());
            for key in keys.iter_mut() {
                key.at = key.at.clamp(0.0, 1.0);
                key.value = match property {
                    Some(KeyframeProperty::Scale) => key.value.clamp(0.05, 8.0),
                    Some(KeyframeProperty::OffsetX)
                    | Some(KeyframeProperty::OffsetY)
                    | Some(KeyframeProperty::AnchorX)
                    | Some(KeyframeProperty::AnchorY) => key.value.clamp(-3.0, 3.0),
                    Some(KeyframeProperty::Rotation)
                    | Some(KeyframeProperty::RotationX)
                    | Some(KeyframeProperty::RotationY) => key.value.clamp(-3600.0, 3600.0),
                    Some(KeyframeProperty::PositionZ) => key.value.clamp(-10.0, 10.0),
                    Some(KeyframeProperty::StretchX) | Some(KeyframeProperty::StretchY) => {
                        key.value.clamp(0.01, 16.0)
                    }
                    Some(KeyframeProperty::Opacity) => key.value.clamp(0.0, 1.0),
                    Some(KeyframeProperty::LayerOrder) => key.value.clamp(-128.0, 128.0),
                    Some(KeyframeProperty::TimeRemap) => key.value.clamp(0.0625, 16.0),
                    None => key.value,
                };
                key.temporal_curve = key.temporal_curve.map(TemporalCurve::tidy);
                for handle in [&mut key.spatial_in, &mut key.spatial_out] {
                    if let Some([x, y]) = handle {
                        if !x.is_finite() || !y.is_finite() {
                            *handle = None;
                        } else {
                            *x = x.clamp(-3.0, 3.0);
                            *y = y.clamp(-3.0, 3.0);
                        }
                    }
                }
            }
            keys.sort_by(|left, right| left.at.total_cmp(&right.at));
            keys.dedup_by(|left, right| (left.at - right.at).abs() <= 1e-9);
        }
        self.tracks.retain(|_, track| !track.keys.is_empty());
        self
    }

    /// Re-map every track after a trim or split. `start_shift` is how many
    /// seconds the new clip begins after the old one; it may be negative when
    /// the head is extended. Boundary keys preserve the held/interpolated
    /// value where the new clip begins and ends.
    pub fn retimed(&self, old_duration: f64, start_shift: f64, new_duration: f64) -> Self {
        if old_duration <= 0.0 || new_duration <= 0.0 {
            return Self::default();
        }
        let mut out = Self::default();
        for (id, track) in &self.tracks {
            let source = &track.keys;
            if source.is_empty() {
                continue;
            }
            let from = start_shift / old_duration;
            let to = (start_shift + new_duration) / old_duration;
            out.named_track_mut(id).post = track.post;
            let from_value = self.named_value_at(id, from, source[0].value);
            let to_value = self.named_value_at(id, to, source[source.len() - 1].value);
            let keys = &mut out.named_track_mut(id).keys;
            keys.push(ClipKeyframe::linear(0.0, from_value));
            for key in source {
                let seconds = key.at * old_duration - start_shift;
                if seconds > 0.0 && seconds < new_duration {
                    keys.push(ClipKeyframe {
                        at: seconds / new_duration,
                        value: key.value,
                        ease: key.ease,
                        temporal_curve: key.temporal_curve,
                        spatial_in: key.spatial_in,
                        spatial_out: key.spatial_out,
                    });
                }
            }
            keys.push(ClipKeyframe::linear(1.0, to_value));
        }
        out.tidy()
    }
}

/// One point of a speed curve.
#[derive(Clone, Copy, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeedPoint {
    /// Where in the clip, as a fraction of its timeline length, 0..=1.
    pub at: f64,
    /// Source seconds per timeline second there.
    pub speed: f64,
}

/// A transition on the cut into a clip.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transition {
    /// Which transition from the catalogue, e.g. "cross-fade".
    pub id: String,
    /// Seconds the transition covers.
    pub duration: f64,
}

/// How a title's lines sit within their block. The block itself is placed by
/// the clip's transform, so this only matters for multi-line text.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TextAlign {
    /// Lines share a left edge.
    Left,
    /// Lines are centred on each other - the default, and what the reader
    /// falls back to for an unrecognised value.
    Center,
    /// Lines share a right edge.
    Right,
}

/// A title's styling. Sizes are fractions of the frame, so a title composed
/// against 1080p lands correctly exported at 4K.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyle {
    /// The words themselves, newlines included. The clip's display name is
    /// snapshotted from the first non-empty line.
    pub content: String,
    /// CSS-style family name, quotes included where the name needs them,
    /// e.g. `"Cabinet Grotesk"`. May name a [`CustomFont`] the user added.
    pub font_family: String,
    /// Cap height as a fraction of frame height.
    pub font_size: f64,
    /// CSS-scale weight, 100..=900; the reader clamps hand-edited values
    /// into that range.
    pub font_weight: f64,
    /// Italic when true. A style flag, not a separate face.
    pub italic: bool,
    /// Fill colour as a CSS hex string, e.g. "#ffffff".
    pub color: String,
    /// Line alignment within the block; see [`TextAlign`].
    pub align: TextAlign,
    /// Opacity of the whole title in 0..=1, multiplied with the clip's own
    /// opacity.
    pub opacity: f64,
    /// Outline thickness as a fraction of frame height. Zero - the default -
    /// means no stroke.
    pub stroke_width: f64,
    /// Outline colour, only visible when `stroke_width` is non-zero.
    pub stroke_color: String,
    /// A drop shadow for legibility over footage. On by default.
    pub shadow: bool,
    /// A solid plate behind the text. Empty string for none.
    pub background: String,
    /// Baseline spacing as a multiple of the font size; the reader floors it
    /// at 0.5 so lines cannot collapse onto each other.
    pub line_height: f64,
    /// Extra letter spacing, in the same frame-height fractions as
    /// `font_size`. Zero is the font's natural fit.
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

/// One placed piece of a timeline: a stretch of media (or a title) with its
/// timing, mix, transform, and effects. Everything an edit decision touches
/// lives here, which is why most commands are clip commands.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// Minted by the editor ("c1", "c2", ...); how every command names its
    /// target. Survives splits - the head keeps the id - and merges.
    pub id: String,
    /// The lane this clip sits on. Always a track of the same timeline; the
    /// reader drops clips whose track vanished.
    pub track_id: String,
    /// Empty for a text clip, which has no file behind it.
    pub media_id: String,
    /// Display label. Snapshotted from the media's name (or a title's first
    /// line) at creation, then the user's to change.
    pub name: String,
    /// What this clip renders as. Follows the media's kind, and is rewritten
    /// when a template slot is filled with a different kind of file.
    pub kind: ClipKind,
    /// Seconds from the start of the timeline.
    pub start: f64,
    /// Seconds of timeline the clip occupies. Source seconds divided by
    /// `speed`; never below a sixtieth of a second.
    pub duration: f64,
    /// In-point: how far into the media the clip starts.
    pub source_start: f64,
    /// Linear gain, 1 being unity.
    pub volume: f64,
    /// Seconds of audio ramp-in from silence at the head. Zero for none.
    pub fade_in: f64,
    /// Seconds of audio ramp-out to silence at the tail. Zero for none.
    pub fade_out: f64,
    /// Multiplier over the fitted size. 1 fills the frame, preserving aspect.
    pub scale: f64,
    /// Offset from centred, as a fraction of frame width / height.
    pub offset_x: f64,
    /// The vertical half of `offset_x`'s pair; positive moves down.
    pub offset_y: f64,
    /// Pivot offset from the picture centre, in frame-relative units.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub anchor_x: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub anchor_y: f64,
    /// Clockwise rotation in degrees, about the picture's centre.
    pub rotation: f64,
    /// Rotation around the horizontal and vertical axes, in degrees.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotation_x: f64,
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotation_y: f64,
    /// Depth used by the renderer's bounded perspective projection.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub position_z: f64,
    /// A multiplier on the fitted width beyond `scale`, for a picture
    /// pulled wider or narrower than its aspect; 1 keeps the aspect.
    #[serde(default = "unity", skip_serializing_if = "is_unity")]
    pub stretch_x: f64,
    /// The same for the height.
    #[serde(default = "unity", skip_serializing_if = "is_unity")]
    pub stretch_y: f64,
    /// Blend strength over whatever is beneath, in 0..1.
    pub opacity: f64,
    /// Base stacking offset. Animated Layer order is added to it.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub layer_order: f64,
    /// Playback rate. 1 is normal. With a curve set this is the curve's
    /// mean, kept in step by the commands that set either.
    pub speed: f64,
    /// Speed as it changes over the clip: points of `(at, speed)`, `at` a
    /// fraction of the clip's timeline length. None is the constant rate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speed_curve: Option<Vec<SpeedPoint>>,
    /// Played backwards.
    #[serde(default, skip_serializing_if = "is_false")]
    pub reverse: bool,
    /// How the clip comes in: a named shape over its first seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation_in: Option<ClipAnimation>,
    /// How it goes out: a named shape over its last seconds.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation_out: Option<ClipAnimation>,
    /// A shape over its whole length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub animation_combo: Option<ClipAnimation>,
    /// User-authored per-property animation points, independent of presets.
    #[serde(default, skip_serializing_if = "ClipKeyframes::is_empty")]
    pub keyframes: ClipKeyframes,
    /// Mirrored left to right.
    #[serde(default, skip_serializing_if = "is_false")]
    pub flip_h: bool,
    /// Mirrored top to bottom.
    #[serde(default, skip_serializing_if = "is_false")]
    pub flip_v: bool,
    /// How the picture's colour meets what is beneath it: "normal",
    /// "multiply", "screen", "add", "lighten", "darken".
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub blend: String,
    /// What is cut off each edge of the source before it is fitted, as
    /// fractions of the source's width and height.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    /// The background taken away by a mask rather than a key colour; see
    /// [`Cutout`]. Keying by colour is a package on `video_effects`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cutout: Option<Cutout>,
    /// Geometric/painted masks, combined as one alpha matte before the clip
    /// is transformed. Disabled masks stay in the project for later reuse.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub masks: Vec<ClipMask>,
    /// The clip-level bypass for every geometric mask.
    #[serde(default, skip_serializing_if = "is_false")]
    pub masks_enabled: bool,
    /// Keep voices at their natural pitch when `speed` is not 1. On by
    /// default; off gives the tape-machine chipmunk/slow-motion sound.
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

/// One timeline: a name and its lanes and clips. Every operation takes the
/// project and works on whichever timeline is active.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timeline {
    /// Minted by the editor ("tl2", ...), except the founding "TL1".
    pub id: String,
    /// The tab label; "Timeline N" by default, renameable but never blank.
    pub name: String,
    /// The lanes, top to bottom. Never empty - `RemoveTrack` keeps a floor
    /// of one.
    pub tracks: Vec<Track>,
    /// Every clip on this timeline, in insertion order, not time order -
    /// readers must sort by `start` where order matters.
    pub clips: Vec<Clip>,
}

/// A font the user added from disk.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomFont {
    /// The family name titles refer to; removal leaves referring clips
    /// untouched so the face can come back when the file does.
    pub family: String,
    /// Where the font file lives on disk. Doubles as the duplicate check
    /// when adding.
    pub path: String,
}

/// The edit: everything the document stores except the app-level settings
/// (name, output format) that the host manages around it.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// The bin: every imported file, shared by all timelines.
    pub media: Vec<MediaItem>,
    /// Fonts the user added from disk, available to every title.
    pub fonts: Vec<CustomFont>,
    /// Every timeline, in tab order. Always at least one.
    pub timelines: Vec<Timeline>,
    /// Which timeline commands act on. Maintained by the command layer, so
    /// it always names a member of `timelines`; [`Project::active`] degrades
    /// to the first timeline if it somehow does not.
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

    /// Mutable twin of [`Project::active`], with the same degrade-to-first
    /// behaviour.
    pub fn active_mut(&mut self) -> &mut Timeline {
        let index = self
            .timelines
            .iter()
            .position(|timeline| timeline.id == self.active_timeline_id)
            .unwrap_or(0);
        &mut self.timelines[index]
    }

    /// The bin entry with this id, or None if it was removed.
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
    /// The clip with this id, or None if it is not on this timeline - which
    /// most commands treat as a tolerated no-op, not an error.
    pub fn clip(&self, clip_id: &str) -> Option<&Clip> {
        self.clips.iter().find(|clip| clip.id == clip_id)
    }

    /// Mutable twin of [`Timeline::clip`].
    pub fn clip_mut(&mut self, clip_id: &str) -> Option<&mut Clip> {
        self.clips.iter_mut().find(|clip| clip.id == clip_id)
    }

    /// The track with this id, or None if it was removed.
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

#[cfg(test)]
mod keyframe_tests {
    use super::{ClipKeyframe, ClipKeyframes, KeyframeEase, KeyframeProperty};

    #[test]
    fn custom_keyframes_use_the_destination_keys_easing() {
        let keys = ClipKeyframes::from_tracks([(
            KeyframeProperty::Opacity,
            vec![
                ClipKeyframe::linear(0.0, 0.0),
                ClipKeyframe {
                    ease: KeyframeEase::Out,
                    ..ClipKeyframe::linear(0.4, 1.0)
                },
            ],
        )]);
        assert!((keys.value_at(KeyframeProperty::Opacity, 0.2, 7.0) - 0.75).abs() < 1e-9);
        assert_eq!(keys.value_at(KeyframeProperty::Opacity, 0.8, 7.0), 1.0);
    }

    #[test]
    fn legacy_arrays_migrate_to_generic_hold_tracks() {
        let keys: ClipKeyframes = serde_json::from_value(serde_json::json!({
            "scale": [
                { "at": 0.0, "value": 1.0 },
                { "at": 0.5, "value": 2.0 }
            ]
        }))
        .expect("legacy keyframes remain readable");
        assert_eq!(keys.track(KeyframeProperty::Scale).len(), 2);
        assert_eq!(
            keys.post_behavior(KeyframeProperty::Scale),
            super::PostKeyBehavior::Hold
        );
        let saved = serde_json::to_value(keys).expect("generic tracks serialize");
        assert!(saved.get("tracks").is_some());
    }
}
