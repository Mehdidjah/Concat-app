// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! Source-space geometric masks.
//!
//! A mask is evaluated before the clip is placed, so its position, size and
//! turn travel with the picture through every preview/export compositor. The
//! shape edge is an analytic signed distance where possible; that gives
//! feathering and antialiasing without keeping a second full-frame bitmap.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use concat_core::frame::Frame;
use concat_project::model::{ClipMask, MaskProperty, MaskShape};

use crate::Mask;

/// Applies all enabled masks as one additive alpha matte. An empty Brush or
/// Pen is ignored until the user puts a path in it, so choosing a drawing
/// tool never makes the picture disappear before the first stroke.
pub fn cut(frame: &mut Frame, masks: &[ClipMask], at: f64, text_masks: &BTreeMap<String, Mask>) {
    let width = frame.width();
    let height = frame.height();
    if width == 0 || height == 0 {
        return;
    }
    let evaluated: Vec<_> = masks
        .iter()
        .filter(|mask| {
            mask.enabled
                && (!matches!(mask.shape, MaskShape::Brush | MaskShape::Pen)
                    || !mask.points.is_empty())
        })
        .map(|mask| Evaluated::new(mask, at, width, height))
        .collect();
    if evaluated.is_empty() {
        return;
    }

    let row = width as usize * 4;
    for y in 0..height {
        for x in 0..width {
            let mut matte = 0.0_f32;
            for mask in &evaluated {
                let text = text_masks.get(&mask.id);
                matte = matte.max(mask.coverage(x as f64 + 0.5, y as f64 + 0.5, text));
            }
            let alpha = y as usize * row + x as usize * 4 + 3;
            let source_alpha = frame.pixels()[alpha];
            frame.pixels_mut()[alpha] =
                (f32::from(source_alpha) * matte.clamp(0.0, 1.0)).round() as u8;
        }
    }
}

struct Evaluated<'a> {
    id: String,
    source: &'a ClipMask,
    cx: f64,
    cy: f64,
    width: f64,
    height: f64,
    min_dimension: f64,
    sin: f64,
    cos: f64,
    feather_pixels: f64,
    roundness: f64,
    points: Vec<(f64, f64)>,
}

impl<'a> Evaluated<'a> {
    fn new(mask: &'a ClipMask, at: f64, frame_width: u32, frame_height: u32) -> Self {
        let value = |property: MaskProperty| mask.value_at(property, at);
        let frame_width = f64::from(frame_width);
        let frame_height = f64::from(frame_height);
        let width = value(MaskProperty::Width).clamp(0.01, 4.0) * frame_width;
        let height = value(MaskProperty::Height).clamp(0.01, 4.0) * frame_height;
        let angle = value(MaskProperty::Rotation).to_radians();
        let (sin, cos) = angle.sin_cos();
        Self {
            id: mask.id.clone(),
            source: mask,
            cx: frame_width * (0.5 + value(MaskProperty::PositionX) * 0.5),
            cy: frame_height * (0.5 + value(MaskProperty::PositionY) * 0.5),
            width,
            height,
            min_dimension: width.min(height).max(1.0),
            sin,
            cos,
            feather_pixels: value(MaskProperty::Feather).clamp(0.0, 0.5)
                * frame_width.min(frame_height),
            roundness: value(MaskProperty::Roundness).clamp(0.0, 1.0),
            points: mask
                .points
                .iter()
                .map(|[x, y]| (*x - 0.5, *y - 0.5))
                .collect(),
        }
    }

    /// The point in a unit shape whose boundary normally lies at ±0.5.
    fn local(&self, x: f64, y: f64) -> (f64, f64) {
        let dx = x - self.cx;
        let dy = y - self.cy;
        let x = dx * self.cos + dy * self.sin;
        let y = -dx * self.sin + dy * self.cos;
        (x / self.width, y / self.height)
    }

    fn coverage(&self, x: f64, y: f64, text: Option<&Mask>) -> f32 {
        let (x, y) = self.local(x, y);
        let mut coverage = match self.source.shape {
            MaskShape::Split => self.from_distance(y * self.height),
            MaskShape::Filmstrip => {
                let mut bands = 0.0_f64;
                for centre in [-0.34_f64, 0.0, 0.34] {
                    let qx = x.abs() - 0.5;
                    let qy = (y - centre).abs() - 0.12;
                    let distance = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0);
                    bands = bands.max(self.from_distance(distance * self.min_dimension));
                }
                bands
            }
            MaskShape::Rectangle => {
                let radius = self.roundness * 0.5;
                let qx = x.abs() - (0.5 - radius);
                let qy = y.abs() - (0.5 - radius);
                let outside = qx.max(0.0).hypot(qy.max(0.0));
                let inside = qx.max(qy).min(0.0);
                self.from_distance((outside + inside - radius) * self.min_dimension)
            }
            MaskShape::Circle => {
                self.from_distance(((x * 2.0).hypot(y * 2.0) - 1.0) * self.min_dimension * 0.5)
            }
            MaskShape::Star => {
                self.from_distance(polygon_distance(x, y, star_points()) * self.min_dimension)
            }
            MaskShape::Heart => {
                self.from_distance(polygon_distance(x, y, heart_points()) * self.min_dimension)
            }
            MaskShape::Text => self.text_coverage(x, y, text),
            MaskShape::Brush => self.brush_coverage(x, y),
            MaskShape::Pen => {
                self.from_distance(polygon_distance(x, y, &self.points) * self.min_dimension)
            }
        };
        if self.source.inverted {
            coverage = 1.0 - coverage;
        }
        coverage.clamp(0.0, 1.0) as f32
    }

    fn from_distance(&self, signed: f64) -> f64 {
        let softness = self.feather_pixels.max(0.75);
        (0.5 - signed / (2.0 * softness)).clamp(0.0, 1.0)
    }

    fn brush_coverage(&self, x: f64, y: f64) -> f64 {
        let radius = self.source.brush_size.clamp(0.002, 1.0) * 0.5;
        let mut distance = f64::INFINITY;
        for pair in self.points.windows(2) {
            if pair[0].0 < -0.5 || pair[1].0 < -0.5 {
                continue;
            }
            distance = distance.min(segment_distance((x, y), pair[0], pair[1]) - radius);
        }
        for (px, py) in self.points.iter().filter(|point| point.0 >= -0.5) {
            distance = distance.min((x - px).hypot(y - py) - radius);
        }
        self.from_distance(distance * self.min_dimension)
    }

    fn text_coverage(&self, x: f64, y: f64, text: Option<&Mask>) -> f64 {
        let Some(text) = text else { return 0.0 };
        let sample = |x: f64, y: f64| text.sample((x + 0.5) as f32, (y + 0.5) as f32) as f64;
        if self.feather_pixels <= 0.75 {
            return sample(x, y);
        }
        let radius_x = self.feather_pixels / self.width.max(1.0);
        let radius_y = self.feather_pixels / self.height.max(1.0);
        let offsets = [
            (0.0, 0.0),
            (-radius_x, 0.0),
            (radius_x, 0.0),
            (0.0, -radius_y),
            (0.0, radius_y),
            (-radius_x * 0.7, -radius_y * 0.7),
            (radius_x * 0.7, -radius_y * 0.7),
            (-radius_x * 0.7, radius_y * 0.7),
            (radius_x * 0.7, radius_y * 0.7),
        ];
        offsets
            .iter()
            .map(|(dx, dy)| sample(x + dx, y + dy))
            .sum::<f64>()
            / offsets.len() as f64
    }
}

fn segment_distance(point: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let ab = (b.0 - a.0, b.1 - a.1);
    let length = ab.0 * ab.0 + ab.1 * ab.1;
    if length <= f64::EPSILON {
        return (point.0 - a.0).hypot(point.1 - a.1);
    }
    let t = (((point.0 - a.0) * ab.0 + (point.1 - a.1) * ab.1) / length).clamp(0.0, 1.0);
    (point.0 - (a.0 + ab.0 * t)).hypot(point.1 - (a.1 + ab.1 * t))
}

/// Negative inside, positive outside a closed polygon.
fn polygon_distance(x: f64, y: f64, points: &[(f64, f64)]) -> f64 {
    if points.len() < 3 {
        return f64::INFINITY;
    }
    let mut inside = false;
    let mut distance = f64::INFINITY;
    for index in 0..points.len() {
        let a = points[index];
        let b = points[(index + 1) % points.len()];
        distance = distance.min(segment_distance((x, y), a, b));
        if ((a.1 > y) != (b.1 > y)) && x < (b.0 - a.0) * (y - a.1) / (b.1 - a.1) + a.0 {
            inside = !inside;
        }
    }
    if inside { -distance } else { distance }
}

fn star_points() -> &'static [(f64, f64)] {
    static POINTS: OnceLock<Vec<(f64, f64)>> = OnceLock::new();
    POINTS
        .get_or_init(|| {
            (0..10)
                .map(|index| {
                    let angle =
                        -std::f64::consts::FRAC_PI_2 + index as f64 * std::f64::consts::PI / 5.0;
                    let radius = if index % 2 == 0 { 0.49 } else { 0.22 };
                    (radius * angle.cos(), radius * angle.sin())
                })
                .collect()
        })
        .as_slice()
}

fn heart_points() -> &'static [(f64, f64)] {
    static POINTS: OnceLock<Vec<(f64, f64)>> = OnceLock::new();
    POINTS
        .get_or_init(|| {
            (0..64)
                .map(|index| {
                    let t = index as f64 / 64.0 * std::f64::consts::TAU;
                    let x = 16.0 * t.sin().powi(3) / 34.0;
                    let y = -(13.0 * t.cos()
                        - 5.0 * (2.0 * t).cos()
                        - 2.0 * (3.0 * t).cos()
                        - (4.0 * t).cos())
                        / 34.0;
                    (x, y)
                })
                .collect()
        })
        .as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(shape: MaskShape, inverted: bool) -> Frame {
        let mut frame = Frame::from_rgba(32, 32, vec![255; 32 * 32 * 4]).unwrap();
        let mut mask = ClipMask::new("mask1".to_owned(), shape);
        mask.inverted = inverted;
        cut(&mut frame, &[mask], 0.0, &BTreeMap::new());
        frame
    }

    #[test]
    fn a_circle_keeps_its_centre_and_drops_its_corners() {
        let frame = masked(MaskShape::Circle, false);
        assert!(frame.pixel(16, 16).unwrap()[3] > 240);
        assert_eq!(frame.pixel(0, 0).unwrap()[3], 0);
    }

    #[test]
    fn inversion_flips_the_geometric_matte() {
        let frame = masked(MaskShape::Rectangle, true);
        assert_eq!(frame.pixel(16, 16).unwrap()[3], 0);
        assert!(frame.pixel(0, 0).unwrap()[3] > 240);
    }

    #[test]
    fn a_mask_uses_its_independent_position_keys() {
        let mut frame = Frame::from_rgba(32, 32, vec![255; 32 * 32 * 4]).unwrap();
        let mut mask = ClipMask::new("mask1".to_owned(), MaskShape::Circle);
        mask.width = 0.2;
        mask.height = 0.2;
        mask.set_key(
            MaskProperty::PositionX,
            0.0,
            0.0,
            concat_project::model::KeyEase::LINEAR,
        );
        mask.set_key(
            MaskProperty::PositionX,
            1.0,
            0.5,
            concat_project::model::KeyEase::LINEAR,
        );
        cut(&mut frame, &[mask], 1.0, &BTreeMap::new());
        assert_eq!(frame.pixel(16, 16).unwrap()[3], 0);
        assert!(frame.pixel(24, 16).unwrap()[3] > 240);
    }

    #[test]
    fn empty_drawing_masks_leave_the_picture_alone() {
        let mut frame = Frame::from_rgba(8, 8, vec![255; 8 * 8 * 4]).unwrap();
        let mask = ClipMask::new("mask1".to_owned(), MaskShape::Brush);
        cut(&mut frame, &[mask], 0.0, &BTreeMap::new());
        assert_eq!(frame.pixel(0, 0).unwrap()[3], 255);
    }
}
