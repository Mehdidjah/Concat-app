# Mask picker design QA

- Source visual truth: `/Users/a/Desktop/Screenshot 2026-09-13 at 11.45.54.png`
- Earlier reference: `/Users/a/Desktop/Screenshot 2026-09-13 at 11.33.40.png`
- Final implementation screenshot: `/tmp/concat-mask-picker-final-v2.png`
- Final full-app screenshot: `/tmp/concat-mask-picker-final-v2-screen.png`
- Side-by-side comparison: `/tmp/concat-mask-picker-before-after.png`
- Viewport: macOS desktop, 3456 × 2234 physical pixels, Retina density; native Slint app (CSS size and device scale factor are not applicable)
- Source pixels: 835 × 474 focused crop
- Implementation pixels: 720 × 900 focused crop; 3456 × 2234 full screen
- State: dark theme, video clip selected, Mask tab open; source has Filmstrip selected and final capture has Rectangle selected after interaction

## Full-view comparison evidence

The final full-app capture shows the Mask tab in the real Concat workspace at the user's current window size. The picker stays inside the inspector, fills its inner width, and leaves the settings section directly below it without horizontal overflow.

## Focused-region comparison evidence

The combined before/after image was inspected as one comparison input. Before the fix, the three rows occupied only the left part of the inspector and labels such as Rectangle, Circle, Heart, and Brush were truncated. After the fix, each row spans the available content width and each of its three cards has the same width. All nine labels are visible and centered.

## Comparison history

### Iteration 1

- [P1] Mask cards did not use the available panel width. The nested row layouts kept their preferred width, leaving most of the inspector empty.
- [P2] Uneven narrow cards truncated multiple labels and made their click targets unnecessarily small.
- [P2] Selection had no pressed or keyboard-focus feedback.
- Fixes: replaced the intrinsic grid with three uniform rows, reduced and aligned glyphs, added selected/hover/pressed/focus states, and expanded the hit target to the whole card.
- Post-fix evidence: the first post-fix capture still showed collapsed rows because stretch hints alone did not override Slint's preferred-width calculation.

### Iteration 2

- Fixes: assigned the picker the section width, assigned every row the inner width, and constrained every card to `(row width - two gaps) / 3`.
- Post-fix evidence: `/tmp/concat-mask-picker-final-v2.png` shows three equal columns spanning the inspector. Rectangle became selected after clicking it, the mask chip changed to `Mask1 Rectangle`, and the preview changed, confirming the interaction reached application state.
- Remaining P0/P1/P2 findings: none.

## Required fidelity surfaces

- Fonts and typography: existing Concat font, sizes, and weights are preserved. Labels no longer truncate at the tested inspector width; selected text uses the existing title weight.
- Spacing and layout rhythm: three equal columns, consistent gaps, 68px cards, matching radii, and full-width alignment with the mask chip and settings section.
- Colors and visual tokens: only existing theme tokens are used for panel, field, hover, active, line, and accent states. Contrast remains consistent with the rest of Concat.
- Image quality and asset fidelity: all mask symbols continue to use Concat's existing vector glyph system; no raster substitutes, placeholders, or generated assets were introduced.
- Copy and content: all nine mask names and existing inspector copy remain unchanged and readable.

## Interaction checks

- Mask tab opens beside Effects.
- Clicking Rectangle from the Filmstrip state changes the selected card, mask label, and preview.
- The full card is the pointer target.
- Pointer hover, pointer press, and keyboard focus/activation states are implemented.
- The optimized native build completed and the app remains running without a startup failure.

## Findings

No actionable P0, P1, or P2 visual differences remain for the requested mask-type picker correction.

## Open Questions

None.

## Implementation Checklist

- [x] Fill the inspector's available inner width.
- [x] Keep all three columns equal.
- [x] Prevent label truncation at the tested width.
- [x] Make the entire card interactive.
- [x] Provide hover, pressed, selected, and keyboard-focus states.
- [x] Verify selection updates the mask and preview.

## Follow-up Polish

No blocking polish remains for this component.

final result: passed
