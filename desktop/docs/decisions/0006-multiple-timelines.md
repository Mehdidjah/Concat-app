# 0006 - Multiple timelines, and the shelf that made them cheap

> **Status: the exit was taken.** The shelf died with `lib/project.ts` when
> the UI flipped onto the engine model (engine decision 0007), exactly as
> planned below - no `shelved` map exists anywhere in the tree. What
> survives of this note is the feature itself and the document-format
> compatibility reasoning.

## Decision
A project holds several timelines (tabs above the timeline tray). In the
frozen UI model the active timeline's tracks and clips stay at the top of the
project - exactly where they always were - and inactive timelines park their
content in a `shelved` map. Switching swaps content in and out at one seam.

## Why the shelf
Every edit operation and every reader (the canvas draw loop included) already
worked on `project.tracks`/`project.clips`. The shelf made "which timeline am
I editing" a fact decided in exactly one place, and no other code had to
learn timelines exist. Thirty operations, zero changes.

## Its known ugliness, and the exit
Two homes for the same kind of data is a real smell - which is why the
engine model (`relay-project`, engine decision 0007) has **no shelf**: it
stores a plain list of timelines and an active id, and operations address the
active one. The shelf dies with `lib/project.ts` when the UI flips. The
*document* format never had a shelf either; both models read and write the
same `timelines` array.

## Rules that hold either way
- New timelines mint fresh track ids - reusing `T1..T4` across timelines
  would make duplicate-id repair orphan clips.
- Deleting is confirmed (no undo existed when this shipped), floors at one
  timeline, and switches to a neighbour first when the active one dies.
- Per-timeline playhead positions are window state, never saved.
