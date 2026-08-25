//! Blending layers into one frame.
//!
//! [`CpuCompositor`] is the reference implementation: obvious, dependency-free,
//! and slow enough that it will eventually only be used for tests and for
//! checking the GPU path's output. The `Compositor` trait is the seam that
//! `wgpu` will slot into.

use relay_core::frame::{BYTES_PER_PIXEL, Frame};

/// One source image, positioned and weighted.
#[derive(Clone, Copy, Debug)]
pub struct Layer<'a> {
    /// The pixels to draw.
    pub frame: &'a Frame,
    /// Blend strength over what is beneath, in `0.0..=1.0`.
    pub opacity: f32,
    /// Horizontal offset of the layer's top-left corner. May be negative.
    pub x: i32,
    /// Vertical offset of the layer's top-left corner. May be negative.
    pub y: i32,
}

impl<'a> Layer<'a> {
    /// A layer drawn at the origin, fully opaque.
    pub fn new(frame: &'a Frame) -> Self {
        Self { frame, opacity: 1.0, x: 0, y: 0 }
    }

    /// Sets the blend strength.
    pub fn with_opacity(mut self, opacity: f32) -> Self {
        self.opacity = opacity;
        self
    }

    /// Sets the top-left corner.
    pub fn at(mut self, x: i32, y: i32) -> Self {
        self.x = x;
        self.y = y;
        self
    }
}

/// Blends layers into a single output frame.
pub trait Compositor {
    /// Draws `layers` bottom-most first over an opaque black background.
    ///
    /// Layers may hang off any edge; anything outside the output is clipped.
    /// The result is always fully opaque - it is what goes to screen or to an
    /// encoder, and neither has anything to show through.
    fn composite(&mut self, width: u32, height: u32, layers: &[Layer<'_>]) -> Frame;
}

/// A straightforward CPU compositor.
#[derive(Clone, Copy, Default, Debug)]
pub struct CpuCompositor;

impl Compositor for CpuCompositor {
    fn composite(&mut self, width: u32, height: u32, layers: &[Layer<'_>]) -> Frame {
        let mut output = Frame::black(width, height);

        for layer in layers {
            let opacity = layer.opacity.clamp(0.0, 1.0);
            if opacity <= 0.0 {
                continue;
            }

            let source = layer.frame;
            let Some((dst_x, src_x, columns)) = overlap(layer.x, source.width(), width) else {
                continue;
            };
            let Some((dst_y, src_y, rows)) = overlap(layer.y, source.height(), height) else {
                continue;
            };

            blend_region(
                &mut output,
                source,
                (dst_x, dst_y),
                (src_x, src_y),
                (columns, rows),
                opacity,
            );
        }

        output
    }
}

/// Works out the visible span along one axis when a layer of `source` pixels is
/// placed at `offset` inside a destination of `destination` pixels.
///
/// Returns `(destination_start, source_start, count)`, or `None` when the layer
/// falls entirely outside.
fn overlap(offset: i32, source: u32, destination: u32) -> Option<(u32, u32, u32)> {
    let source = i64::from(source);
    let destination = i64::from(destination);
    let offset = i64::from(offset);

    let dst_start = offset.max(0);
    let src_start = (-offset).max(0);
    let count = (source - src_start).min(destination - dst_start);

    (count > 0).then_some((dst_start as u32, src_start as u32, count as u32))
}

/// Source-over alpha blend of an aligned rectangle.
fn blend_region(
    output: &mut Frame,
    source: &Frame,
    (dst_x, dst_y): (u32, u32),
    (src_x, src_y): (u32, u32),
    (columns, rows): (u32, u32),
    opacity: f32,
) {
    let src_stride = source.width() as usize * BYTES_PER_PIXEL;
    let dst_stride = output.width() as usize * BYTES_PER_PIXEL;
    let span = columns as usize * BYTES_PER_PIXEL;

    let src_pixels = source.pixels();
    let dst_pixels = output.pixels_mut();

    for row in 0..rows as usize {
        let src_offset = (src_y as usize + row) * src_stride + src_x as usize * BYTES_PER_PIXEL;
        let dst_offset = (dst_y as usize + row) * dst_stride + dst_x as usize * BYTES_PER_PIXEL;

        let src_row = &src_pixels[src_offset..src_offset + span];
        let dst_row = &mut dst_pixels[dst_offset..dst_offset + span];

        for (src_pixel, dst_pixel) in
            src_row.chunks_exact(BYTES_PER_PIXEL).zip(dst_row.chunks_exact_mut(BYTES_PER_PIXEL))
        {
            let alpha = (f32::from(src_pixel[3]) / 255.0) * opacity;
            if alpha <= 0.0 {
                continue;
            }
            for channel in 0..3 {
                let over = f32::from(src_pixel[channel]) * alpha;
                let under = f32::from(dst_pixel[channel]) * (1.0 - alpha);
                dst_pixel[channel] = (over + under).round().clamp(0.0, 255.0) as u8;
            }
            dst_pixel[3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> Frame {
        let mut frame = Frame::transparent(width, height);
        frame.fill(rgba);
        frame
    }

    #[test]
    fn no_layers_gives_opaque_black() {
        let frame = CpuCompositor.composite(2, 2, &[]);
        assert_eq!(frame.pixel(0, 0), Some([0, 0, 0, 255]));
    }

    #[test]
    fn an_opaque_layer_replaces_the_background() {
        let red = solid(2, 2, [255, 0, 0, 255]);
        let frame = CpuCompositor.composite(2, 2, &[Layer::new(&red)]);
        assert_eq!(frame.pixel(1, 1), Some([255, 0, 0, 255]));
    }

    #[test]
    fn half_opacity_lands_halfway() {
        let white = solid(1, 1, [255, 255, 255, 255]);
        let frame = CpuCompositor.composite(1, 1, &[Layer::new(&white).with_opacity(0.5)]);
        assert_eq!(frame.pixel(0, 0), Some([128, 128, 128, 255]));
    }

    #[test]
    fn source_alpha_and_layer_opacity_multiply() {
        let half_alpha = solid(1, 1, [255, 255, 255, 128]);
        let frame = CpuCompositor.composite(1, 1, &[Layer::new(&half_alpha).with_opacity(0.5)]);
        // 128/255 * 0.5 ~= 0.251
        assert_eq!(frame.pixel(0, 0), Some([64, 64, 64, 255]));
    }

    #[test]
    fn later_layers_draw_on_top() {
        let red = solid(1, 1, [255, 0, 0, 255]);
        let blue = solid(1, 1, [0, 0, 255, 255]);
        let frame = CpuCompositor.composite(1, 1, &[Layer::new(&red), Layer::new(&blue)]);
        assert_eq!(frame.pixel(0, 0), Some([0, 0, 255, 255]));
    }

    #[test]
    fn a_transparent_layer_changes_nothing() {
        let clear = Frame::transparent(2, 2);
        let frame = CpuCompositor.composite(2, 2, &[Layer::new(&clear)]);
        assert_eq!(frame.pixel(0, 0), Some([0, 0, 0, 255]));
    }

    #[test]
    fn offset_layers_are_clipped_not_wrapped() {
        let red = solid(2, 2, [255, 0, 0, 255]);
        // Placed so only its bottom-right pixel lands on the output's top-left.
        let frame = CpuCompositor.composite(2, 2, &[Layer::new(&red).at(-1, -1)]);
        assert_eq!(frame.pixel(0, 0), Some([255, 0, 0, 255]));
        assert_eq!(frame.pixel(1, 1), Some([0, 0, 0, 255]), "must not wrap around");
    }

    #[test]
    fn a_layer_entirely_off_screen_is_skipped() {
        let red = solid(2, 2, [255, 0, 0, 255]);
        let frame = CpuCompositor.composite(2, 2, &[Layer::new(&red).at(50, 50)]);
        assert_eq!(frame.pixel(0, 0), Some([0, 0, 0, 255]));
    }

    #[test]
    fn a_layer_larger_than_the_output_is_cropped() {
        let red = solid(8, 8, [255, 0, 0, 255]);
        let frame = CpuCompositor.composite(2, 2, &[Layer::new(&red)]);
        assert_eq!(frame.width(), 2);
        assert_eq!(frame.pixel(1, 1), Some([255, 0, 0, 255]));
    }

    #[test]
    fn overlap_spans_are_correct() {
        assert_eq!(overlap(0, 4, 4), Some((0, 0, 4)));
        assert_eq!(overlap(2, 4, 4), Some((2, 0, 2)));
        assert_eq!(overlap(-2, 4, 4), Some((0, 2, 2)));
        assert_eq!(overlap(4, 4, 4), None);
        assert_eq!(overlap(-4, 4, 4), None);
    }
}
