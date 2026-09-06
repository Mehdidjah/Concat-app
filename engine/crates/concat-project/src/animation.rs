// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jareer and Concat contributors

//! Animation presets: the named ways a clip comes in, goes out, or moves
//! for its whole length, as keys the engine can play.
//!
//! The document stores a name and a length per slot, not keys: a preset
//! re-materialises for the clip's current length every time it is asked
//! for, so trimming a clip keeps its half-second fade a half-second. The
//! shapes are relative to the clip's own placement (see the engine's
//! `animate` module), so a preset never has to know where the clip sits.

use std::collections::BTreeMap;

use concat_core::animate::{Animation, CubicBezier, Ease, Key, PostBehavior, Track};

use crate::model::{
    AnimationSlot, Clip, ClipAnimation, ClipKeyframeTrack, KeyProperty, KeyframeEase,
    KeyframeProperty, PostKeyBehavior,
};

/// One shape: what it is called, and its keys over the slot as `(property,
/// at-within-slot, value, ease)`.
struct Shape {
    name: &'static str,
    keys: &'static [(Prop, f64, f64, Ease)],
}

#[derive(Clone, Copy)]
enum Prop {
    Scale,
    X,
    Y,
    Rotation,
    Opacity,
}

use Prop::{Opacity, Rotation, Scale, X, Y};

/// The In shapes, in the order a menu lists them.
const IN: &[Shape] = &[
    Shape {
        name: "Fade",
        keys: &[
            (Opacity, 0.0, 0.0, Ease::LINEAR),
            (Opacity, 1.0, 1.0, Ease::OUT),
        ],
    },
    Shape {
        name: "Zoom In",
        keys: &[
            (Scale, 0.0, 0.5, Ease::LINEAR),
            (Scale, 1.0, 1.0, Ease::OUT),
            (Opacity, 0.0, 0.0, Ease::LINEAR),
            (Opacity, 1.0, 1.0, Ease::OUT),
        ],
    },
    Shape {
        name: "Zoom Out",
        keys: &[
            (Scale, 0.0, 1.6, Ease::LINEAR),
            (Scale, 1.0, 1.0, Ease::OUT),
            (Opacity, 0.0, 0.0, Ease::LINEAR),
            (Opacity, 1.0, 1.0, Ease::OUT),
        ],
    },
    Shape {
        name: "Slide Up",
        keys: &[(Y, 0.0, 0.6, Ease::LINEAR), (Y, 1.0, 0.0, Ease::OUT)],
    },
    Shape {
        name: "Slide Down",
        keys: &[(Y, 0.0, -0.6, Ease::LINEAR), (Y, 1.0, 0.0, Ease::OUT)],
    },
    Shape {
        name: "Slide Left",
        keys: &[(X, 0.0, 0.6, Ease::LINEAR), (X, 1.0, 0.0, Ease::OUT)],
    },
    Shape {
        name: "Slide Right",
        keys: &[(X, 0.0, -0.6, Ease::LINEAR), (X, 1.0, 0.0, Ease::OUT)],
    },
    Shape {
        name: "Spin",
        keys: &[
            (Rotation, 0.0, -180.0, Ease::LINEAR),
            (Rotation, 1.0, 0.0, Ease::OUT),
            (Scale, 0.0, 0.3, Ease::LINEAR),
            (Scale, 1.0, 1.0, Ease::OUT),
            (Opacity, 0.0, 0.0, Ease::LINEAR),
            (Opacity, 1.0, 1.0, Ease::OUT),
        ],
    },
];

/// The Out shapes: the In shapes run backwards, and eased in rather than
/// out, which is what leaving looks like.
const OUT: &[Shape] = &[
    Shape {
        name: "Fade",
        keys: &[
            (Opacity, 0.0, 1.0, Ease::LINEAR),
            (Opacity, 1.0, 0.0, Ease::IN),
        ],
    },
    Shape {
        name: "Zoom In",
        keys: &[
            (Scale, 0.0, 1.0, Ease::LINEAR),
            (Scale, 1.0, 1.6, Ease::IN),
            (Opacity, 0.0, 1.0, Ease::LINEAR),
            (Opacity, 1.0, 0.0, Ease::IN),
        ],
    },
    Shape {
        name: "Zoom Out",
        keys: &[
            (Scale, 0.0, 1.0, Ease::LINEAR),
            (Scale, 1.0, 0.5, Ease::IN),
            (Opacity, 0.0, 1.0, Ease::LINEAR),
            (Opacity, 1.0, 0.0, Ease::IN),
        ],
    },
    Shape {
        name: "Slide Up",
        keys: &[(Y, 0.0, 0.0, Ease::LINEAR), (Y, 1.0, -0.6, Ease::IN)],
    },
    Shape {
        name: "Slide Down",
        keys: &[(Y, 0.0, 0.0, Ease::LINEAR), (Y, 1.0, 0.6, Ease::IN)],
    },
    Shape {
        name: "Slide Left",
        keys: &[(X, 0.0, 0.0, Ease::LINEAR), (X, 1.0, -0.6, Ease::IN)],
    },
    Shape {
        name: "Slide Right",
        keys: &[(X, 0.0, 0.0, Ease::LINEAR), (X, 1.0, 0.6, Ease::IN)],
    },
    Shape {
        name: "Spin",
        keys: &[
            (Rotation, 0.0, 0.0, Ease::LINEAR),
            (Rotation, 1.0, 180.0, Ease::IN),
            (Scale, 0.0, 1.0, Ease::LINEAR),
            (Scale, 1.0, 0.3, Ease::IN),
            (Opacity, 0.0, 1.0, Ease::LINEAR),
            (Opacity, 1.0, 0.0, Ease::IN),
        ],
    },
];

/// The Combo shapes: over the whole clip.
const COMBO: &[Shape] = &[
    Shape {
        name: "Pulse",
        keys: &[
            (Scale, 0.0, 1.0, Ease::LINEAR),
            (Scale, 0.5, 1.08, Ease::IN_OUT),
            (Scale, 1.0, 1.0, Ease::IN_OUT),
        ],
    },
    Shape {
        name: "Shake",
        keys: &[
            (X, 0.0, 0.0, Ease::LINEAR),
            (X, 0.1, 0.02, Ease::LINEAR),
            (X, 0.2, -0.02, Ease::LINEAR),
            (X, 0.3, 0.02, Ease::LINEAR),
            (X, 0.4, -0.02, Ease::LINEAR),
            (X, 0.5, 0.02, Ease::LINEAR),
            (X, 0.6, -0.02, Ease::LINEAR),
            (X, 0.7, 0.02, Ease::LINEAR),
            (X, 0.8, -0.02, Ease::LINEAR),
            (X, 0.9, 0.02, Ease::LINEAR),
            (X, 1.0, 0.0, Ease::LINEAR),
        ],
    },
    Shape {
        name: "Spin",
        keys: &[
            (Rotation, 0.0, 0.0, Ease::LINEAR),
            (Rotation, 1.0, 360.0, Ease::LINEAR),
        ],
    },
    Shape {
        name: "Bounce",
        keys: &[
            (Y, 0.0, 0.0, Ease::LINEAR),
            (Y, 0.25, -0.06, Ease::OUT),
            (Y, 0.5, 0.0, Ease::IN),
            (Y, 0.75, -0.03, Ease::OUT),
            (Y, 1.0, 0.0, Ease::IN),
        ],
    },
    Shape {
        name: "Drift",
        keys: &[
            (Scale, 0.0, 1.0, Ease::LINEAR),
            (Scale, 1.0, 1.12, Ease::LINEAR),
        ],
    },
];

fn shapes(slot: AnimationSlot) -> &'static [Shape] {
    match slot {
        AnimationSlot::In => IN,
        AnimationSlot::Out => OUT,
        AnimationSlot::Combo => COMBO,
    }
}

/// The names a slot offers, in menu order.
pub fn names(slot: AnimationSlot) -> Vec<&'static str> {
    shapes(slot).iter().map(|shape| shape.name).collect()
}

/// Where a name sits in its slot's menu, or None for a name the slot does
/// not know.
pub fn index_of(slot: AnimationSlot, name: &str) -> Option<usize> {
    shapes(slot).iter().position(|shape| shape.name == name)
}

/// The engine's keys for everything set on `clip`, over its current
/// length, or None when nothing is set. In and Out keys are placed over
/// their slot's seconds at the head and tail; a Combo runs the whole clip.
/// A slot longer than the clip is squeezed to it, and a head and tail that
/// would overlap share the clip in half.
pub fn animation_of(clip: &Clip) -> Option<Animation> {
    let duration = clip.duration.max(1e-6);
    let mut tracks: [Vec<Key>; 5] = Default::default();
    let mut any = false;

    let mut lay =
        |slot: AnimationSlot, set: &Option<ClipAnimation>, other: &Option<ClipAnimation>| {
            let Some(set) = set else { return };
            let Some(shape) = shapes(slot).iter().find(|shape| shape.name == set.preset) else {
                return;
            };
            // The slot's share of the clip, as a fraction of its length.
            let mut span = (set.duration.max(0.05) / duration).min(1.0);
            if let Some(other) = other {
                let both = span + (other.duration.max(0.05) / duration).min(1.0);
                if both > 1.0 {
                    span /= both;
                }
            }
            let (from, to) = match slot {
                AnimationSlot::In => (0.0, span),
                AnimationSlot::Out => (1.0 - span, 1.0),
                AnimationSlot::Combo => (0.0, 1.0),
            };
            for &(prop, at, value, ease) in shape.keys {
                let key = Key {
                    at: from + (to - from) * at,
                    value,
                    ease,
                    curve: None,
                    spatial_in: None,
                    spatial_out: None,
                };
                tracks[match prop {
                    Scale => 0,
                    X => 1,
                    Y => 2,
                    Rotation => 3,
                    Opacity => 4,
                }]
                .push(key);
                any = true;
            }
        };
    lay(AnimationSlot::In, &clip.animation_in, &clip.animation_out);
    lay(AnimationSlot::Out, &clip.animation_out, &clip.animation_in);
    lay(AnimationSlot::Combo, &clip.animation_combo, &None);

    // A hand-authored track owns its property. Presets still animate every
    // other property, but must not add a second, conflicting curve on this
    // one. The document stores the values exactly as the inspector shows
    // them; the core engine consumes values relative to the clip's base.
    let custom = |track: &ClipKeyframeTrack, relative: &dyn Fn(f64) -> f64| {
        Track::new(
            track
                .keys
                .iter()
                .map(|key| Key {
                    at: key.at,
                    value: relative(key.value),
                    ease: match key.ease {
                        KeyframeEase::Linear => Ease::LINEAR,
                        KeyframeEase::In => Ease::IN,
                        KeyframeEase::Out => Ease::OUT,
                        KeyframeEase::InOut => Ease::IN_OUT,
                    },
                    curve: key.temporal_curve.map(|curve| CubicBezier {
                        x1: curve.x1,
                        y1: curve.y1,
                        x2: curve.x2,
                        y2: curve.y2,
                    }),
                    spatial_in: key.spatial_in,
                    spatial_out: key.spatial_out,
                })
                .collect::<Vec<_>>(),
        )
        .with_post(match track.post {
            PostKeyBehavior::Hold => PostBehavior::Hold,
            PostKeyBehavior::Reset => PostBehavior::Reset,
            PostKeyBehavior::Loop => PostBehavior::Loop,
            PostKeyBehavior::Extrapolate => PostBehavior::Extrapolate,
        })
    };
    let legacy = |property: KeyProperty, relative: &dyn Fn(f64) -> f64| {
        Track::new(
            clip.keys_on(property)
                .map(|key| Key {
                    at: key.at,
                    value: relative(key.value),
                    ease: key.ease.into(),
                    curve: None,
                    spatial_in: None,
                    spatial_out: None,
                })
                .collect(),
        )
    };
    let custom_or_preset = |property: KeyframeProperty,
                            legacy_property: KeyProperty,
                            preset: Vec<Key>,
                            relative: &dyn Fn(f64) -> f64| {
        match clip.keyframes.tracks.get(property.id()) {
            Some(track) if !track.keys.is_empty() => custom(track, relative),
            _ if clip.is_keyed(legacy_property) => legacy(legacy_property, relative),
            _ => Track::new(preset),
        }
    };
    // Time remapping is evaluated into the engine's source-time map by the
    // flattener. Every visual and namespaced parameter still becomes this
    // one Animation object.
    any |= clip
        .keyframes
        .tracks
        .iter()
        .any(|(id, track)| id != KeyframeProperty::TimeRemap.id() && !track.keys.is_empty());
    any |= !clip.keys.is_empty();
    if !any {
        return None;
    }
    let [scale, x, y, rotation, opacity] = tracks;
    let scale = custom_or_preset(
        KeyframeProperty::Scale,
        KeyProperty::Scale,
        scale,
        &|value| value / clip.scale.max(1e-6),
    );
    let offset_x = custom_or_preset(
        KeyframeProperty::OffsetX,
        KeyProperty::OffsetX,
        x,
        &|value| value - clip.offset_x,
    );
    let offset_y = custom_or_preset(
        KeyframeProperty::OffsetY,
        KeyProperty::OffsetY,
        y,
        &|value| value - clip.offset_y,
    );
    let rotation = custom_or_preset(
        KeyframeProperty::Rotation,
        KeyProperty::Rotation,
        rotation,
        &|value| value - clip.rotation,
    );
    let opacity = custom_or_preset(
        KeyframeProperty::Opacity,
        KeyProperty::Opacity,
        opacity,
        &|value| value / clip.opacity.max(1e-6),
    );
    let extra = |property: KeyframeProperty, relative: &dyn Fn(f64) -> f64| {
        clip.keyframes
            .tracks
            .get(property.id())
            .filter(|track| !track.keys.is_empty())
            .map_or_else(Track::default, |track| custom(track, relative))
    };
    let built_in_ids = KeyframeProperty::ALL.map(KeyframeProperty::id);
    let parameters: BTreeMap<_, _> = clip
        .keyframes
        .tracks
        .iter()
        .filter(|(id, track)| !track.keys.is_empty() && !built_in_ids.contains(&id.as_str()))
        .map(|(id, track)| (id.clone(), custom(track, &|value| value)))
        .collect();
    let animation = Animation {
        scale,
        offset_x,
        offset_y,
        anchor_x: extra(KeyframeProperty::AnchorX, &|value| value - clip.anchor_x),
        anchor_y: extra(KeyframeProperty::AnchorY, &|value| value - clip.anchor_y),
        rotation,
        rotation_x: extra(KeyframeProperty::RotationX, &|value| {
            value - clip.rotation_x
        }),
        rotation_y: extra(KeyframeProperty::RotationY, &|value| {
            value - clip.rotation_y
        }),
        position_z: extra(KeyframeProperty::PositionZ, &|value| {
            value - clip.position_z
        }),
        stretch_x: extra(KeyframeProperty::StretchX, &|value| {
            value / clip.stretch_x.max(1e-6)
        }),
        stretch_y: extra(KeyframeProperty::StretchY, &|value| {
            value / clip.stretch_y.max(1e-6)
        }),
        opacity,
        volume: custom_or_preset(
            KeyframeProperty::Volume,
            KeyProperty::Volume,
            Vec::new(),
            &|value| value / clip.volume.max(1e-6),
        ),
        layer_order: extra(KeyframeProperty::LayerOrder, &|value| value),
        parameters,
    };
    (!animation.is_empty()).then_some(animation)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::ClipPatch;
    use crate::model::{ClipKeyframe, ClipKeyframes, KeyframeProperty};
    use crate::{Command, Editor};

    #[test]
    fn every_slot_names_its_shapes_and_finds_them_again() {
        for slot in [AnimationSlot::In, AnimationSlot::Out, AnimationSlot::Combo] {
            let names = names(slot);
            assert!(!names.is_empty());
            for (index, name) in names.iter().enumerate() {
                assert_eq!(index_of(slot, name), Some(index));
            }
            assert_eq!(index_of(slot, "Nothing"), None);
        }
    }

    #[test]
    fn a_fade_in_lands_over_its_seconds_at_the_head() {
        let mut editor = Editor::new();
        let id = editor
            .apply(Command::AddTextClip {
                track_id: None,
                start: 0.0,
                style: None,
                duration: Some(4.0),
                offset_y: None,
            })
            .unwrap()
            .created_id
            .unwrap();
        editor
            .apply(Command::SetClipAnimation {
                clip_id: id.clone(),
                slot: AnimationSlot::In,
                animation: Some(ClipAnimation {
                    preset: "Fade".to_owned(),
                    duration: 1.0,
                }),
            })
            .unwrap();
        let clip = editor.project().active().clip(&id).unwrap();
        let animation = animation_of(clip).expect("a fade is set");
        // A second of a four-second clip: the fade is done by a quarter.
        assert!((animation.opacity_at(1.0, 0.0) - 0.0).abs() < 1e-9);
        assert!(animation.opacity_at(1.0, 0.125) > 0.0 && animation.opacity_at(1.0, 0.125) < 1.0);
        assert!((animation.opacity_at(1.0, 0.25) - 1.0).abs() < 1e-9);
        assert!((animation.opacity_at(1.0, 0.9) - 1.0).abs() < 1e-9);
        assert_eq!(animation.transform_at(Default::default(), 0.1).scale, 1.0);
    }

    #[test]
    fn custom_tracks_are_independent_and_evaluate_as_inspector_values() {
        let mut editor = Editor::new();
        let id = editor
            .apply(Command::AddTextClip {
                track_id: None,
                start: 0.0,
                style: None,
                duration: Some(4.0),
                offset_y: None,
            })
            .unwrap()
            .created_id
            .unwrap();
        editor
            .apply(Command::SetClipTransform {
                clip_id: id.clone(),
                scale: Some(2.0),
                offset_x: Some(0.2),
                offset_y: None,
                rotation: None,
                stretch_x: None,
                stretch_y: None,
            })
            .unwrap();
        editor
            .apply(Command::UpdateClip {
                clip_id: id.clone(),
                patch: ClipPatch {
                    opacity: Some(0.8),
                    keyframes: Some(ClipKeyframes::from_tracks([
                        (
                            KeyframeProperty::Scale,
                            vec![
                                ClipKeyframe::linear(0.0, 1.0),
                                ClipKeyframe::linear(1.0, 2.0),
                            ],
                        ),
                        (
                            KeyframeProperty::OffsetX,
                            vec![
                                ClipKeyframe::linear(0.0, 0.1),
                                ClipKeyframe::linear(1.0, 0.5),
                            ],
                        ),
                        (
                            KeyframeProperty::Opacity,
                            vec![
                                ClipKeyframe::linear(0.0, 0.2),
                                ClipKeyframe::linear(1.0, 0.6),
                            ],
                        ),
                    ])),
                    ..ClipPatch::default()
                },
            })
            .unwrap();

        let clip = editor.project().active().clip(&id).unwrap();
        let animation = animation_of(clip).unwrap();
        let placed = animation.transform_at(
            concat_core::timeline::Transform {
                scale: clip.scale,
                offset_x: clip.offset_x,
                offset_y: clip.offset_y,
                anchor_x: clip.anchor_x,
                anchor_y: clip.anchor_y,
                rotation: clip.rotation,
                rotation_x: clip.rotation_x,
                rotation_y: clip.rotation_y,
                position_z: clip.position_z,
                stretch_x: clip.stretch_x,
                stretch_y: clip.stretch_y,
            },
            0.5,
        );
        assert!((placed.scale - 1.5).abs() < 1e-9);
        assert!((placed.offset_x - 0.3).abs() < 1e-9);
        assert_eq!(placed.offset_y, 0.0);
        assert!((animation.opacity_at(clip.opacity as f32, 0.5) - 0.4).abs() < 1e-6);
    }
}
