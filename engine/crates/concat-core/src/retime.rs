// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! Speed that changes over a clip.
//!
//! A constant speed is one number. A *curve* is speed as a function of where
//! in the clip you are: a handful of points, `(x, speed)` with `x` the
//! fraction of the clip's timeline length, joined by straight lines. The
//! source time at any instant is then the area under that line up to it -
//! which is why the curve lives here, beside the clip's affine map: it is the
//! same fact, and every renderer has to agree with it.
//!
//! The units are deliberately relative. A curve stored as fractions means
//! the same thing after the clip is trimmed or the project re-timed, and a
//! preset can be applied to any clip without knowing how long it is.

/// Speed over a clip, as points joined by straight lines.
#[derive(Clone, PartialEq, Debug)]
pub struct SpeedCurve {
    /// `(x, speed)` with `x` in `0..=1` ascending and speed positive.
    points: Vec<(f64, f64)>,
    /// Area at each corresponding point, so source-time lookup remains
    /// logarithmic even for a densely sampled temporal curve.
    areas: Vec<f64>,
}

impl SpeedCurve {
    /// The floor a curve's speed is held at: a stop would consume no source
    /// and the map would stop being invertible.
    pub const MIN_SPEED: f64 = 0.0625;
    /// And the ceiling, matching the constant rate's.
    pub const MAX_SPEED: f64 = 16.0;

    /// A curve through these points, tidied: sorted by `x`, clamped into the
    /// unit interval and the speed range, and anchored at both ends so the
    /// line covers the whole clip. Fewer than one point is `None`.
    pub fn new(points: &[(f64, f64)]) -> Option<SpeedCurve> {
        let mut points: Vec<(f64, f64)> = points
            .iter()
            .filter(|(x, speed)| x.is_finite() && speed.is_finite())
            .map(|&(x, speed)| {
                (
                    x.clamp(0.0, 1.0),
                    speed.clamp(Self::MIN_SPEED, Self::MAX_SPEED),
                )
            })
            .collect();
        if points.is_empty() {
            return None;
        }
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        if points[0].0 > 0.0 {
            points.insert(0, (0.0, points[0].1));
        }
        if points[points.len() - 1].0 < 1.0 {
            points.push((1.0, points[points.len() - 1].1));
        }
        let mut areas = Vec::with_capacity(points.len());
        areas.push(0.0);
        for pair in points.windows(2) {
            let width = pair[1].0 - pair[0].0;
            let area = areas.last().copied().unwrap_or(0.0) + width * (pair[0].1 + pair[1].1) / 2.0;
            areas.push(area);
        }
        Some(SpeedCurve { points, areas })
    }

    /// The points, as tidied.
    pub fn points(&self) -> &[(f64, f64)] {
        &self.points
    }

    /// Speed at `x`, a fraction of the clip's length.
    pub fn speed_at(&self, x: f64) -> f64 {
        let x = x.clamp(0.0, 1.0);
        let right = self.points.partition_point(|point| point.0 < x);
        if right == 0 {
            return self.points[0].1;
        }
        if right >= self.points.len() {
            return self.points[self.points.len() - 1].1;
        }
        let (x0, v0) = self.points[right - 1];
        let (x1, v1) = self.points[right];
        if x1 <= x0 {
            return v1;
        }
        v0 + (v1 - v0) * (x - x0) / (x1 - x0)
    }

    /// The area under the curve from the start to `x`: how much of the
    /// source, as a fraction of the clip's timeline length, has been consumed
    /// by then. Each segment is a trapezoid, so this is exact.
    pub fn consumed(&self, x: f64) -> f64 {
        let x = x.clamp(0.0, 1.0);
        let right = self.points.partition_point(|point| point.0 < x);
        if right == 0 {
            return 0.0;
        }
        if right >= self.points.len() {
            return *self.areas.last().unwrap_or(&0.0);
        }
        let left = right - 1;
        let (x0, v0) = self.points[left];
        let v_end = self.speed_at(x);
        self.areas[left] + (x - x0) * (v0 + v_end) / 2.0
    }

    /// The average speed: source seconds consumed per timeline second over
    /// the whole clip.
    pub fn mean(&self) -> f64 {
        self.consumed(1.0).max(Self::MIN_SPEED)
    }

    /// The clip cut into `count` equal timeline pieces, each `(x0, x1,
    /// consumed_at_x0, mean_speed)` - the constant-rate approximation a
    /// sound path that can only change tempo in steps needs.
    pub fn pieces(&self, count: usize) -> Vec<(f64, f64, f64, f64)> {
        let count = count.max(1);
        (0..count)
            .map(|index| {
                let x0 = index as f64 / count as f64;
                let x1 = (index + 1) as f64 / count as f64;
                let from = self.consumed(x0);
                let to = self.consumed(x1);
                (x0, x1, from, ((to - from) / (x1 - x0)).max(Self::MIN_SPEED))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_flat_curve_is_a_constant_speed() {
        let curve = SpeedCurve::new(&[(0.0, 2.0), (1.0, 2.0)]).unwrap();
        assert_eq!(curve.speed_at(0.3), 2.0);
        assert!((curve.consumed(0.5) - 1.0).abs() < 1e-12);
        assert!((curve.mean() - 2.0).abs() < 1e-12);
    }

    #[test]
    fn the_ends_are_anchored_and_the_area_is_exact() {
        // Speed ramps from 1 to 3 over the clip: the area is the trapezoid.
        let curve = SpeedCurve::new(&[(0.25, 1.0), (0.75, 3.0)]).unwrap();
        assert_eq!(curve.points()[0], (0.0, 1.0));
        assert_eq!(curve.points()[curve.points().len() - 1], (1.0, 3.0));
        assert!((curve.speed_at(0.5) - 2.0).abs() < 1e-12);
        // 0..0.25 at 1, 0.25..0.75 averaging 2, 0.75..1 at 3.
        assert!((curve.mean() - (0.25 + 1.0 + 0.75)).abs() < 1e-12);
        assert!((curve.consumed(0.5) - (0.25 + 0.25 * 1.5)).abs() < 1e-12);
    }

    #[test]
    fn pieces_add_up_to_the_whole() {
        let curve = SpeedCurve::new(&[(0.0, 0.5), (0.5, 4.0), (1.0, 0.5)]).unwrap();
        let pieces = curve.pieces(8);
        assert_eq!(pieces.len(), 8);
        let total: f64 = pieces
            .iter()
            .map(|(x0, x1, _, mean)| (x1 - x0) * mean)
            .sum();
        assert!((total - curve.mean()).abs() < 1e-9);
        assert!((pieces[3].2 - curve.consumed(3.0 / 8.0)).abs() < 1e-12);
    }

    #[test]
    fn nonsense_is_tidied_or_refused() {
        assert!(SpeedCurve::new(&[]).is_none());
        let curve = SpeedCurve::new(&[(2.0, 0.0), (-1.0, 100.0)]).unwrap();
        assert_eq!(curve.points()[0], (0.0, SpeedCurve::MAX_SPEED));
        assert_eq!(curve.points()[1], (1.0, SpeedCurve::MIN_SPEED));
    }
}
