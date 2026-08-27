/**
 * The video effect and transition catalogues.
 *
 * Browse-only for now: the engine cannot yet render a video effect or a
 * transition, so nothing in here produces an FFmpeg fragment. What this file
 * fixes today is the *shape* of the library - stable ids, categories, and the
 * one place the panel reads from - so that when the engine work lands, each
 * entry grows a `chain` builder the way `lib/filters.ts` entries have one, and
 * the browsing UI does not change at all.
 *
 * Ids are forever: they will be written into project files once effects can be
 * applied, so renaming one later would orphan clips. Pick them like you mean
 * them.
 */

export type EffectCategory = "basic" | "blur" | "color" | "stylize" | "distort";

export interface EffectDefinition {
  id: string;
  label: string;
  category: EffectCategory;
  /** One line on what it does, shown in the card tooltip. */
  blurb: string;
  /** CSS background for the preview tile, until real thumbnails exist. */
  swatch: string;
}

/** The categories under the "Video Effects" dropdown, in display order. */
export const EFFECT_CATEGORIES: { id: EffectCategory; label: string }[] = [
  { id: "basic", label: "Basic" },
  { id: "blur", label: "Blur" },
  { id: "color", label: "Color" },
  { id: "stylize", label: "Stylize" },
  { id: "distort", label: "Distort" },
];

export const EFFECTS: EffectDefinition[] = [
  // ── basic ────────────────────────────────────────────────────────────────
  {
    id: "black-white",
    label: "Black & White",
    category: "basic",
    blurb: "Drops all colour, keeps the tones.",
    swatch: "linear-gradient(135deg, #e8e8e8 0%, #6b6b6b 55%, #1c1c1c 100%)",
  },
  {
    id: "sepia",
    label: "Sepia",
    category: "basic",
    blurb: "Aged warm brown, like an old photograph.",
    swatch: "linear-gradient(135deg, #e9d3ae 0%, #a9773f 60%, #513a1c 100%)",
  },
  {
    id: "invert",
    label: "Invert",
    category: "basic",
    blurb: "Flips every colour to its negative.",
    swatch: "linear-gradient(135deg, #00d0ff 0%, #7a00c8 55%, #ffe600 100%)",
  },
  {
    id: "sharpen",
    label: "Sharpen",
    category: "basic",
    blurb: "Crisps up edges and fine detail.",
    swatch: "linear-gradient(135deg, #cfd8dc 0%, #607d8b 55%, #263238 100%)",
  },
  // ── blur ─────────────────────────────────────────────────────────────────
  {
    id: "gaussian-blur",
    label: "Gaussian Blur",
    category: "blur",
    blurb: "Soft, even blur across the whole frame.",
    swatch: "linear-gradient(135deg, #b3c7f9 0%, #7f9cf5 55%, #4c6ef5 100%)",
  },
  {
    id: "box-blur",
    label: "Box Blur",
    category: "blur",
    blurb: "Fast, slightly harsher blur.",
    swatch: "linear-gradient(135deg, #a5d8ff 0%, #4dabf7 55%, #1971c2 100%)",
  },
  {
    id: "motion-blur",
    label: "Motion Blur",
    category: "blur",
    blurb: "Directional streaking, as if the camera swept.",
    swatch: "linear-gradient(90deg, #91a7ff 0%, #5c7cfa 45%, #91a7ff 100%)",
  },
  // ── color ────────────────────────────────────────────────────────────────
  {
    id: "warm",
    label: "Warm",
    category: "color",
    blurb: "Pushes the frame toward orange and gold.",
    swatch: "linear-gradient(135deg, #ffd8a8 0%, #ff922b 55%, #d9480f 100%)",
  },
  {
    id: "cool",
    label: "Cool",
    category: "color",
    blurb: "Pushes the frame toward blue and teal.",
    swatch: "linear-gradient(135deg, #99e9f2 0%, #22b8cf 55%, #0b7285 100%)",
  },
  {
    id: "vibrance",
    label: "Vibrance",
    category: "color",
    blurb: "Richer colour without blowing out skin tones.",
    swatch: "linear-gradient(135deg, #ff6b6b 0%, #fcc419 40%, #51cf66 70%, #339af0 100%)",
  },
  {
    id: "contrast-pop",
    label: "Contrast Pop",
    category: "color",
    blurb: "Deeper blacks, brighter whites.",
    swatch: "linear-gradient(135deg, #f8f9fa 0%, #868e96 45%, #212529 100%)",
  },
  // ── stylize ──────────────────────────────────────────────────────────────
  {
    id: "vignette",
    label: "Vignette",
    category: "stylize",
    blurb: "Darkens the corners to pull the eye inward.",
    swatch: "radial-gradient(circle at 50% 50%, #ced4da 0%, #495057 60%, #16191c 100%)",
  },
  {
    id: "film-grain",
    label: "Film Grain",
    category: "stylize",
    blurb: "Fine analogue noise over the picture.",
    swatch: "linear-gradient(135deg, #dee2e6 0%, #adb5bd 50%, #495057 100%)",
  },
  {
    id: "glow",
    label: "Glow",
    category: "stylize",
    blurb: "Blooms the highlights softly.",
    swatch: "radial-gradient(circle at 50% 40%, #fff9db 0%, #ffe066 45%, #e8590c 100%)",
  },
  {
    id: "posterize",
    label: "Posterize",
    category: "stylize",
    blurb: "Flattens colour into bold bands.",
    swatch:
      "linear-gradient(135deg, #e64980 0%, #e64980 33%, #7950f2 33%, #7950f2 66%, #1098ad 66%, #1098ad 100%)",
  },
  // ── distort ──────────────────────────────────────────────────────────────
  {
    id: "pixelate",
    label: "Pixelate",
    category: "distort",
    blurb: "Chunks the frame into visible blocks.",
    swatch:
      "repeating-linear-gradient(0deg, #74c0fc 0 6px, #4dabf7 6px 12px), repeating-linear-gradient(90deg, #74c0fc80 0 6px, #4dabf780 6px 12px)",
  },
  {
    id: "mirror",
    label: "Mirror",
    category: "distort",
    blurb: "Reflects one half of the frame onto the other.",
    swatch: "linear-gradient(90deg, #63e6be 0%, #0ca678 50%, #63e6be 100%)",
  },
  {
    id: "fisheye",
    label: "Fisheye",
    category: "distort",
    blurb: "Bulges the centre like a wide lens.",
    swatch: "radial-gradient(circle at 50% 50%, #d0bfff 0%, #9775fa 55%, #5f3dc4 100%)",
  },
  {
    id: "shake",
    label: "Shake",
    category: "distort",
    blurb: "Handheld-style camera judder.",
    swatch: "linear-gradient(105deg, #ffc9c9 0%, #ff8787 40%, #fa5252 60%, #ffc9c9 100%)",
  },
];

export type TransitionCategory = "basic" | "motion";

export interface TransitionDefinition {
  id: string;
  label: string;
  category: TransitionCategory;
  /** One line on what it does, shown in the card tooltip. */
  blurb: string;
}

/** The categories under the "Transitions" dropdown, in display order. */
export const TRANSITION_CATEGORIES: { id: TransitionCategory; label: string }[] = [
  { id: "basic", label: "Basic" },
  { id: "motion", label: "Motion" },
];

export const TRANSITIONS: TransitionDefinition[] = [
  {
    id: "cross-fade",
    label: "Cross Fade",
    category: "basic",
    blurb: "The outgoing clip dissolves into the incoming one.",
  },
  {
    id: "fade-black",
    label: "Fade to Black",
    category: "basic",
    blurb: "Out through black, then in from black.",
  },
  {
    id: "fade-white",
    label: "Fade to White",
    category: "basic",
    blurb: "Out through white, then in from white.",
  },
  {
    id: "wipe-left",
    label: "Wipe Left",
    category: "motion",
    blurb: "The incoming clip sweeps in from the right edge.",
  },
  {
    id: "wipe-right",
    label: "Wipe Right",
    category: "motion",
    blurb: "The incoming clip sweeps in from the left edge.",
  },
  {
    id: "push",
    label: "Push",
    category: "motion",
    blurb: "The incoming clip shoves the outgoing one off screen.",
  },
  {
    id: "zoom",
    label: "Zoom",
    category: "motion",
    blurb: "Punches in on the cut, then settles.",
  },
];
