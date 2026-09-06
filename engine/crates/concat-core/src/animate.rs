// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! Placement that changes over a clip.
//!
//! A clip's transform and opacity are one value each. An *animation* is a
//! set of keys on top of them: for each of scale, the two offsets, rotation
//! and opacity, a list of `(at, value)` with `at` a fraction of the clip's
//! length, eased between neighbours. The values are relative to the clip's
//! own - a scale key is a factor, an offset key an addition, an opacity key
//! a factor - so the same animation means the same motion on any clip, and
//! a preset never has to know where the clip sits.
//!
//! This is the one place the per-frame arithmetic lives; the plan asks the
//! clip, and the clip asks here.

use std::collections::BTreeMap;

use crate::timeline::Transform;

/// How a key is approached from the one before it: a CSS timing function,
/// as its two control points.
///
/// Four numbers rather than a handful of named shapes, because the named
/// shapes are four numbers each and a curve editor is not - the panel hands
/// people a bezier to drag, and the presets below are what its chips write.
/// The endpoints are pinned at (0,0) and (1,1), so only the middle two
/// points are stored, and `x` is clamped into `0..=1` where a legal timing
/// function keeps it.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Ease {
    /// First control point's x, `0..=1`.
    pub x1: f64,
    /// First control point's y; may overshoot.
    pub y1: f64,
    /// Second control point's x, `0..=1`.
    pub x2: f64,
    /// Second control point's y; may overshoot.
    pub y2: f64,
}

impl Default for Ease {
    fn default() -> Self {
        Ease::LINEAR
    }
}

/// A temporal cubic Bezier in the normalised time/value square.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct CubicBezier {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

impl CubicBezier {
    /// Evaluate Y at a supplied X. Newton iteration gives the fast common
    /// path and bisection makes unusual user handles deterministic.
    pub fn solve(self, x: f64) -> f64 {
        let x = x.clamp(0.0, 1.0);
        let sample = |t: f64, a: f64, b: f64| {
            let u = 1.0 - t;
            3.0 * u * u * t * a + 3.0 * u * t * t * b + t * t * t
        };
        let derivative = |t: f64, a: f64, b: f64| {
            3.0 * (1.0 - t).powi(2) * a + 6.0 * (1.0 - t) * t * (b - a) + 3.0 * t * t * (1.0 - b)
        };
        let mut t = x;
        for _ in 0..5 {
            let error = sample(t, self.x1, self.x2) - x;
            let slope = derivative(t, self.x1, self.x2);
            if slope.abs() < 1e-7 {
                break;
            }
            t = (t - error / slope).clamp(0.0, 1.0);
        }
        let mut low = 0.0;
        let mut high = 1.0;
        for _ in 0..10 {
            if sample(t, self.x1, self.x2) < x {
                low = t;
            } else {
                high = t;
            }
            t = (low + high) * 0.5;
        }
        sample(t, self.y1, self.y2)
    }
}

/// What a track evaluates to after its final key.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum PostBehavior {
    #[default]
    Hold,
    Reset,
    Loop,
    Extrapolate,
}

impl Ease {
    /// A straight line.
    pub const LINEAR: Ease = Ease::new(0.0, 0.0, 1.0, 1.0);
    /// Starts slow, arrives fast. CSS `ease-in`.
    pub const IN: Ease = Ease::new(0.42, 0.0, 1.0, 1.0);
    /// Starts fast, arrives slow. CSS `ease-out`.
    pub const OUT: Ease = Ease::new(0.0, 0.0, 0.58, 1.0);
    /// Slow at both ends. CSS `ease-in-out`.
    pub const IN_OUT: Ease = Ease::new(0.42, 0.0, 0.58, 1.0);

    /// The four control-point numbers, as given.
    pub const fn new(x1: f64, y1: f64, x2: f64, y2: f64) -> Ease {
        Ease { x1, y1, x2, y2 }
    }

    /// Whether this is the straight line, to within a hair. What lets the
    /// mixer skip resampling a ride that has nothing to resample.
    pub fn is_linear(self) -> bool {
        (self.x1 - self.y1).abs() < 1e-6 && (self.x2 - self.y2).abs() < 1e-6
    }

    /// The eased fraction for a linear one.
    pub fn apply(self, t: f64) -> f64 {
        if self.is_linear() {
            return t.clamp(0.0, 1.0);
        }
        bezier_y_at_x(self.x1, self.y1, self.x2, self.y2, t)
    }
}

/// x of a cubic bezier with endpoints pinned at 0 and 1, at parameter `t`.
fn bezier_axis(p1: f64, p2: f64, t: f64) -> f64 {
    let u = 1.0 - t;
    3.0 * u * u * t * p1 + 3.0 * u * t * t * p2 + t * t * t
}

fn bezier_axis_slope(p1: f64, p2: f64, t: f64) -> f64 {
    let u = 1.0 - t;
    3.0 * u * u * p1 + 6.0 * u * t * (p2 - p1) + 3.0 * t * t * (1.0 - p2)
}

/// Solve a CSS cubic-bezier for y at a given x: Newton first, bisection as
/// the fallback where the curve is flat enough that Newton stalls.
///
/// The one solver. The window's `Curves.ease` global reaches it through
/// `format::bezier_y_at_x`, because Slint's expression language has no loops
/// and so cannot do this itself; the engine reaches it through `Ease::apply`
/// on every frame of every keyed property. Two callers, one definition -
/// which matters here more than most, because a preview whose easing
/// disagreed with the export's would disagree invisibly.
pub fn bezier_y_at_x(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    let mut t = x;

    for _ in 0..8 {
        let error = bezier_axis(x1, x2, t) - x;
        if error.abs() < 1e-7 {
            return bezier_axis(y1, y2, t);
        }
        let slope = bezier_axis_slope(x1, x2, t);
        if slope.abs() < 1e-9 {
            break;
        }
        t -= error / slope;
    }

    let (mut lo, mut hi) = (0.0_f64, 1.0_f64);
    t = x;
    for _ in 0..32 {
        let at = bezier_axis(x1, x2, t);
        if (at - x).abs() < 1e-7 {
            break;
        }
        if at > x {
            hi = t;
        } else {
            lo = t;
        }
        t = (lo + hi) / 2.0;
    }
    bezier_axis(y1, y2, t)
}

/// One key of one property.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Key {
    /// Where in the clip, `0..=1`.
    pub at: f64,
    /// The value there, in the property's relative terms.
    pub value: f64,
    /// How this key is approached from the previous one.
    pub ease: Ease,
    /// Optional user-authored temporal handles. They never alter the spatial
    /// path followed by Position.
    pub curve: Option<CubicBezier>,
    /// Incoming and outgoing Position tangents in frame-relative units.
    pub spatial_in: Option<[f64; 2]>,
    pub spatial_out: Option<[f64; 2]>,
}

/// The keys of one property, sorted by `at`.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Track {
    keys: Vec<Key>,
    post: PostBehavior,
}

impl Track {
    /// A track through these keys, sorted.
    pub fn new(mut keys: Vec<Key>) -> Track {
        keys.retain(|key| key.at.is_finite() && key.value.is_finite());
        for key in &mut keys {
            key.at = key.at.clamp(0.0, 1.0);
        }
        keys.sort_by(|a, b| a.at.total_cmp(&b.at));
        Track {
            keys,
            post: PostBehavior::Hold,
        }
    }

    /// Set the explicit behavior after the final key.
    pub fn with_post(mut self, post: PostBehavior) -> Self {
        self.post = post;
        self
    }

    pub fn post_behavior(&self) -> PostBehavior {
        self.post
    }

    /// The keys, sorted.
    pub fn keys(&self) -> &[Key] {
        &self.keys
    }

    /// True with no keys: the property is the clip's own.
    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// The value at `x`: `rest` with no keys, the first key's before it,
    /// the last key's after it, and eased between neighbours.
    pub fn value_at(&self, x: f64, rest: f64) -> f64 {
        let Some(first) = self.keys.first() else {
            return rest;
        };
        if x <= first.at {
            return first.value;
        }
        let right = self.keys.partition_point(|key| key.at < x);
        if right < self.keys.len() {
            let (a, b) = (self.keys[right - 1], self.keys[right]);
            if b.at <= a.at {
                return b.value;
            }
            let linear = (x - a.at) / (b.at - a.at);
            let t = b
                .curve
                .map_or_else(|| b.ease.apply(linear), |curve| curve.solve(linear));
            return a.value + (b.value - a.value) * t;
        }
        let last = self.keys[self.keys.len() - 1];
        match self.post {
            PostBehavior::Hold => last.value,
            PostBehavior::Reset => rest,
            PostBehavior::Loop if self.keys.len() > 1 => {
                let span = last.at - first.at;
                if span <= f64::EPSILON {
                    last.value
                } else {
                    self.value_at(first.at + (x - first.at).rem_euclid(span), rest)
                }
            }
            PostBehavior::Extrapolate if self.keys.len() > 1 => {
                let before = self.keys[self.keys.len() - 2];
                let span = last.at - before.at;
                if span <= f64::EPSILON {
                    last.value
                } else {
                    last.value + (last.value - before.value) * (x - last.at) / span
                }
            }
            PostBehavior::Loop | PostBehavior::Extrapolate => last.value,
        }
    }

    fn segment_at(&self, x: f64) -> Option<(Key, Key, f64)> {
        let right = self.keys.partition_point(|key| key.at < x);
        if right == 0 || right >= self.keys.len() {
            return None;
        }
        let (left, right) = (self.keys[right - 1], self.keys[right]);
        let span = right.at - left.at;
        if span <= f64::EPSILON {
            return None;
        }
        let linear = ((x - left.at) / span).clamp(0.0, 1.0);
        let t = right
            .curve
            .map_or_else(|| right.ease.apply(linear), |curve| curve.solve(linear));
        Some((left, right, t))
    }

    /// The same ride, with every eased segment replaced by `steps` straight
    /// ones through the same points.
    ///
    /// For callers that can interpolate but cannot ease. The mixer is the
    /// one that needs it: a clip's gain ride becomes an FFmpeg `volume`
    /// expression, and an expression can lerp but cannot run the Newton
    /// solve a bezier wants. Sampling here rather than there keeps the
    /// easing in the one place that understands it, and leaves the
    /// expression generator with nothing but straight lines to write.
    ///
    /// Linear segments are passed through untouched, so a ride nobody has
    /// eased costs nothing and reads identically on both sides.
    pub fn resample(&self, steps: usize) -> Track {
        let steps = steps.max(1);
        if self.keys.len() < 2 || self.keys.iter().all(|key| key.ease.is_linear()) {
            return self.clone();
        }
        let mut out = vec![self.keys[0]];
        for pair in self.keys.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            if b.ease.is_linear() || b.at <= a.at {
                out.push(Key {
                    ease: Ease::LINEAR,
                    ..b
                });
                continue;
            }
            for step in 1..=steps {
                let t = step as f64 / steps as f64;
                out.push(Key {
                    at: a.at + (b.at - a.at) * t,
                    value: a.value + (b.value - a.value) * b.ease.apply(t),
                    ease: Ease::LINEAR,
                    curve: None,
                    spatial_in: None,
                    spatial_out: None,
                });
            }
        }
        Track {
            keys: out,
            post: self.post,
        }
    }
}

/// Every animatable property's keys.
#[derive(Clone, PartialEq, Debug, Default)]
pub struct Animation {
    /// A factor on the clip's scale; 1 is as placed.
    pub scale: Track,
    /// Added to the clip's horizontal offset, in frame widths.
    pub offset_x: Track,
    /// Added to the clip's vertical offset, in frame heights.
    pub offset_y: Track,
    /// Pivot offsets from the picture centre, in frame fractions.
    pub anchor_x: Track,
    pub anchor_y: Track,
    /// Added to the clip's rotation, in degrees.
    pub rotation: Track,
    /// 3D transform values. The renderer projects these consistently in the
    /// monitor and exporter.
    pub rotation_x: Track,
    pub rotation_y: Track,
    pub position_z: Track,
    /// Axis-specific size multipliers.
    pub stretch_x: Track,
    pub stretch_y: Track,
    /// A factor on the clip's opacity; 1 is as set.
    pub opacity: Track,
    /// Relative stacking offset from the lane order.
    pub layer_order: Track,
    /// Effect/expression/element/mesh tracks share the same evaluator and
    /// stable namespaced property ids.
    pub parameters: BTreeMap<String, Track>,
    /// A factor on the clip's gain; 1 is as mixed. Sound rather than
    /// picture, but the same shape of fact - a value that changes over the
    /// clip - so it is a track here and not a second mechanism somewhere
    /// else. Nothing in the compositor reads it; the mixer does.
    pub volume: Track,
}

impl Animation {
    /// True when no property has a key.
    pub fn is_empty(&self) -> bool {
        self.scale.is_empty()
            && self.offset_x.is_empty()
            && self.offset_y.is_empty()
            && self.anchor_x.is_empty()
            && self.anchor_y.is_empty()
            && self.rotation.is_empty()
            && self.rotation_x.is_empty()
            && self.rotation_y.is_empty()
            && self.position_z.is_empty()
            && self.stretch_x.is_empty()
            && self.stretch_y.is_empty()
            && self.opacity.is_empty()
            && self.layer_order.is_empty()
            && self.parameters.values().all(Track::is_empty)
            && self.volume.is_empty()
    }

    /// The clip's transform at `x`, a fraction of its length.
    pub fn transform_at(&self, base: Transform, x: f64) -> Transform {
        let (offset_x, offset_y) = self.position_at(base.offset_x, base.offset_y, x);
        Transform {
            scale: (base.scale * self.scale.value_at(x, 1.0)).max(0.001),
            offset_x,
            offset_y,
            anchor_x: base.anchor_x + self.anchor_x.value_at(x, 0.0),
            anchor_y: base.anchor_y + self.anchor_y.value_at(x, 0.0),
            rotation: base.rotation + self.rotation.value_at(x, 0.0),
            rotation_x: base.rotation_x + self.rotation_x.value_at(x, 0.0),
            rotation_y: base.rotation_y + self.rotation_y.value_at(x, 0.0),
            position_z: base.position_z + self.position_z.value_at(x, 0.0),
            stretch_x: (base.stretch_x * self.stretch_x.value_at(x, 1.0)).max(0.001),
            stretch_y: (base.stretch_y * self.stretch_y.value_at(x, 1.0)).max(0.001),
        }
    }

    fn position_at(&self, base_x: f64, base_y: f64, x: f64) -> (f64, f64) {
        let fallback = (
            base_x + self.offset_x.value_at(x, 0.0),
            base_y + self.offset_y.value_at(x, 0.0),
        );
        let (Some((left_x, right_x, t)), Some((left_y, right_y, _))) =
            (self.offset_x.segment_at(x), self.offset_y.segment_at(x))
        else {
            return fallback;
        };
        if (left_x.at - left_y.at).abs() > 1e-9 || (right_x.at - right_y.at).abs() > 1e-9 {
            return fallback;
        }
        if left_x.spatial_out.is_none()
            && left_y.spatial_out.is_none()
            && right_x.spatial_in.is_none()
            && right_y.spatial_in.is_none()
        {
            return fallback;
        }
        let p0 = [left_x.value, left_y.value];
        let p3 = [right_x.value, right_y.value];
        let out = left_x
            .spatial_out
            .or(left_y.spatial_out)
            .unwrap_or([0.0, 0.0]);
        let incoming = right_x
            .spatial_in
            .or(right_y.spatial_in)
            .unwrap_or([0.0, 0.0]);
        let p1 = [p0[0] + out[0], p0[1] + out[1]];
        let p2 = [p3[0] + incoming[0], p3[1] + incoming[1]];
        let u = 1.0 - t;
        let cubic = |axis: usize| {
            u.powi(3) * p0[axis]
                + 3.0 * u * u * t * p1[axis]
                + 3.0 * u * t * t * p2[axis]
                + t.powi(3) * p3[axis]
        };
        (base_x + cubic(0), base_y + cubic(1))
    }

    /// The clip's opacity at `x`.
    pub fn opacity_at(&self, base: f32, x: f64) -> f32 {
        (f64::from(base) * self.opacity.value_at(x, 1.0)).clamp(0.0, 1.0) as f32
    }

    pub fn layer_order_at(&self, x: f64) -> i32 {
        self.layer_order.value_at(x, 0.0).round() as i32
    }

    pub fn parameter_at(&self, id: &str, x: f64, rest: f64) -> f64 {
        self.parameters
            .get(id)
            .map_or(rest, |track| track.value_at(x, rest))
    }

    /// The clip's gain at `x`. Unclamped at the top: a key above unity is a
    /// clip being lifted, which is the whole point of keying gain, and the
    /// mixer is where clipping is anyone's business.
    pub fn volume_at(&self, base: f64, x: f64) -> f64 {
        (base * self.volume.value_at(x, 1.0)).max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(at: f64, value: f64, ease: Ease) -> Key {
        Key {
            at,
            value,
            ease,
            curve: None,
            spatial_in: None,
            spatial_out: None,
        }
    }

    #[test]
    fn a_track_holds_its_ends_and_eases_between() {
        let track = Track::new(vec![
            key(0.5, 1.0, Ease::LINEAR),
            key(0.0, 0.0, Ease::LINEAR),
        ]);
        assert_eq!(track.value_at(-1.0, 7.0), 0.0);
        assert_eq!(track.value_at(0.25, 7.0), 0.5);
        assert_eq!(track.value_at(0.9, 7.0), 1.0);
        assert_eq!(Track::default().value_at(0.5, 7.0), 7.0);

        let eased = Track::new(vec![key(0.0, 0.0, Ease::LINEAR), key(1.0, 1.0, Ease::OUT)]);
        assert!(eased.value_at(0.5, 0.0) > 0.5);
        let eased = Track::new(vec![key(0.0, 0.0, Ease::LINEAR), key(1.0, 1.0, Ease::IN)]);
        assert!(eased.value_at(0.5, 0.0) < 0.5);
    }

    #[test]
    fn an_animation_is_relative_to_the_clip() {
        let animation = Animation {
            scale: Track::new(vec![
                key(0.0, 0.5, Ease::LINEAR),
                key(1.0, 1.0, Ease::LINEAR),
            ]),
            offset_x: Track::new(vec![
                key(0.0, 0.5, Ease::LINEAR),
                key(1.0, 0.0, Ease::LINEAR),
            ]),
            opacity: Track::new(vec![
                key(0.0, 0.0, Ease::LINEAR),
                key(0.5, 1.0, Ease::LINEAR),
            ]),
            ..Animation::default()
        };
        let base = Transform {
            scale: 2.0,
            offset_x: 0.1,
            offset_y: -0.2,
            rotation: 10.0,
            anchor_x: 0.0,
            anchor_y: 0.0,
            rotation_x: 0.0,
            rotation_y: 0.0,
            position_z: 0.0,
            stretch_x: 1.0,
            stretch_y: 1.0,
        };
        let mid = animation.transform_at(base, 0.5);
        assert!((mid.scale - 1.5).abs() < 1e-12);
        assert!((mid.offset_x - 0.35).abs() < 1e-12);
        assert_eq!(mid.offset_y, -0.2);
        assert_eq!(mid.rotation, 10.0);
        assert!((animation.opacity_at(0.8, 0.25) - 0.4).abs() < 1e-6);
        assert_eq!(animation.opacity_at(0.8, 0.9), 0.8);
        assert!(!animation.is_empty());
        assert!(Animation::default().is_empty());
    }

    #[test]
    fn post_key_behaviors_are_explicit() {
        let keys = vec![key(0.0, 0.0, Ease::LINEAR), key(0.5, 1.0, Ease::LINEAR)];
        assert_eq!(Track::new(keys.clone()).value_at(0.75, 7.0), 1.0);
        assert_eq!(
            Track::new(keys.clone())
                .with_post(PostBehavior::Reset)
                .value_at(0.75, 7.0),
            7.0
        );
        assert!(
            (Track::new(keys.clone())
                .with_post(PostBehavior::Loop)
                .value_at(0.75, 7.0)
                - 0.5)
                .abs()
                < 1e-9
        );
        assert!(
            (Track::new(keys)
                .with_post(PostBehavior::Extrapolate)
                .value_at(0.75, 7.0)
                - 1.5)
                .abs()
                < 1e-9
        );
    }

    #[test]
    fn spatial_position_handles_are_separate_from_temporal_easing() {
        let x = Track::new(vec![
            Key {
                spatial_out: Some([0.0, 1.0]),
                ..key(0.0, 0.0, Ease::LINEAR)
            },
            Key {
                spatial_in: Some([0.0, 1.0]),
                ..key(1.0, 1.0, Ease::LINEAR)
            },
        ]);
        let y = Track::new(vec![
            Key {
                spatial_out: Some([0.0, 1.0]),
                ..key(0.0, 0.0, Ease::LINEAR)
            },
            Key {
                spatial_in: Some([0.0, 1.0]),
                ..key(1.0, 0.0, Ease::LINEAR)
            },
        ]);
        let animation = Animation {
            offset_x: x,
            offset_y: y,
            ..Animation::default()
        };
        let placed = animation.transform_at(Transform::IDENTITY, 0.5);
        assert!((placed.offset_x - 0.5).abs() < 1e-9);
        assert!(placed.offset_y > 0.7, "the spatial path bows independently");
    }

    #[test]
    fn the_eases_bend_the_way_their_names_say() {
        // The endpoints are pinned whatever the control points are.
        for ease in [Ease::LINEAR, Ease::IN, Ease::OUT, Ease::IN_OUT] {
            assert!((ease.apply(0.0) - 0.0).abs() < 1e-6, "{ease:?} at 0");
            assert!((ease.apply(1.0) - 1.0).abs() < 1e-6, "{ease:?} at 1");
        }
        // Only the straight line is straight, and it costs no solve.
        assert!(Ease::LINEAR.is_linear());
        assert_eq!(Ease::LINEAR.apply(0.37), 0.37);
        assert!(!Ease::IN.is_linear());

        // In starts slow, out starts fast, and in-out is symmetric about
        // the middle.
        assert!(Ease::IN.apply(0.5) < 0.5);
        assert!(Ease::OUT.apply(0.5) > 0.5);
        assert!((Ease::IN_OUT.apply(0.5) - 0.5).abs() < 1e-6);
        assert!(Ease::IN_OUT.apply(0.25) < 0.25);
        assert!(Ease::IN_OUT.apply(0.75) > 0.75);

        // Out of range is held, not extrapolated.
        assert_eq!(Ease::IN.apply(-1.0), 0.0);
        assert_eq!(Ease::IN.apply(2.0), 1.0);
    }

    #[test]
    fn resampling_follows_the_curve_it_flattens() {
        let track = Track::new(vec![
            key(0.0, 0.0, Ease::LINEAR),
            key(1.0, 4.0, Ease::IN_OUT),
        ]);
        let flat = track.resample(12);

        // Every segment of the flattened ride is straight, so a caller that
        // can only lerp - the mixer's filtergraph - reads it correctly.
        assert!(flat.keys().iter().all(|key| key.ease.is_linear()));
        assert!(flat.keys().len() > track.keys().len());

        // And it is the same ride, to a few thousandths of its range -
        // which on a gain ramp is a hundredth of a decibel.
        let range = 4.0;
        for step in 0..=40 {
            let x = f64::from(step) / 40.0;
            let error = (flat.value_at(x, 0.0) - track.value_at(x, 0.0)).abs();
            assert!(error < range * 0.005, "at {x}: off by {error}");
        }

        // A ride with nothing to flatten is handed back untouched, so the
        // common case costs neither keys nor expression length.
        let straight = Track::new(vec![
            key(0.0, 0.0, Ease::LINEAR),
            key(1.0, 1.0, Ease::LINEAR),
        ]);
        assert_eq!(straight.resample(12), straight);
    }
}
