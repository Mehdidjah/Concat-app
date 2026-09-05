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

/// How a key is approached from the one before it.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Ease {
    /// Straight line.
    #[default]
    Linear,
    /// Starts slow, arrives fast.
    In,
    /// Starts fast, arrives slow.
    Out,
    /// Slow at both ends.
    InOut,
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
    /// The eased fraction for a linear one.
    pub fn apply(self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Ease::Linear => t,
            Ease::In => t * t,
            Ease::Out => 1.0 - (1.0 - t) * (1.0 - t),
            Ease::InOut => {
                if t < 0.5 {
                    2.0 * t * t
                } else {
                    1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
                }
            }
        }
    }
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
            key(0.5, 1.0, Ease::Linear),
            key(0.0, 0.0, Ease::Linear),
        ]);
        assert_eq!(track.value_at(-1.0, 7.0), 0.0);
        assert_eq!(track.value_at(0.25, 7.0), 0.5);
        assert_eq!(track.value_at(0.9, 7.0), 1.0);
        assert_eq!(Track::default().value_at(0.5, 7.0), 7.0);

        let eased = Track::new(vec![key(0.0, 0.0, Ease::Linear), key(1.0, 1.0, Ease::Out)]);
        assert!(eased.value_at(0.5, 0.0) > 0.5);
        let eased = Track::new(vec![key(0.0, 0.0, Ease::Linear), key(1.0, 1.0, Ease::In)]);
        assert!(eased.value_at(0.5, 0.0) < 0.5);
    }

    #[test]
    fn an_animation_is_relative_to_the_clip() {
        let animation = Animation {
            scale: Track::new(vec![
                key(0.0, 0.5, Ease::Linear),
                key(1.0, 1.0, Ease::Linear),
            ]),
            offset_x: Track::new(vec![
                key(0.0, 0.5, Ease::Linear),
                key(1.0, 0.0, Ease::Linear),
            ]),
            opacity: Track::new(vec![
                key(0.0, 0.0, Ease::Linear),
                key(0.5, 1.0, Ease::Linear),
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
        let keys = vec![key(0.0, 0.0, Ease::Linear), key(0.5, 1.0, Ease::Linear)];
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
                ..key(0.0, 0.0, Ease::Linear)
            },
            Key {
                spatial_in: Some([0.0, 1.0]),
                ..key(1.0, 1.0, Ease::Linear)
            },
        ]);
        let y = Track::new(vec![
            Key {
                spatial_out: Some([0.0, 1.0]),
                ..key(0.0, 0.0, Ease::Linear)
            },
            Key {
                spatial_in: Some([0.0, 1.0]),
                ..key(1.0, 0.0, Ease::Linear)
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
}
