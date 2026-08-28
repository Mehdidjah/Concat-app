# 0008 - A template is a document plus slots, not a new format

## Decision
A template (the CapCut-style "drop your clips into a finished edit" feature)
is an ordinary wolfcut document with one new fact and one new operation:

- `MediaItem.placeholder: bool` marks a media item as a *slot* - a stand-in
  whose metadata says what belongs there. Skipped when false, so documents
  without templates stay byte-identical. In the creator's own project the
  path stays real and everything previews; only a packed bundle blanks it.
- `Command::FillSlot { media_id, item }` replaces the identity behind the
  media id - path, duration, codecs, kind - and leaves every clip that
  references it untouched, except that in-points reset (they referred to the
  old footage) and clip kind follows the new media. Slot timing is the
  template's: start, duration and speed stay put, which is what keeps cuts
  on the beat. A clip shorter than its slot freeze-frames, which is the
  renderer's existing behaviour for a trim past the media's end.
- `Command::Batch { commands }` applies a list all-or-nothing (staged clone,
  committed on success) as one undo step. Filling eleven slots is one edit.

The *bundle* - `template.json` with `assets/` for the music and overlays
that are part of the design, paths relative to the bundle - is host territory
(`desktop/src-tauri/src/templates.rs`), not engine territory. The host packs
and unpacks; instantiation opens the document in a `wolfcut_project::Editor`
and applies a batch of fills, so what a fill *means* lives in exactly one
place. The editor never opens on a slot with a dead path: the launch screen
collects every slot's media first, and instantiation refuses a partial set.

## Why this shape
- The document model, tolerant reader, undo and command wire all exist; a
  template format that was not the document format would mean porting every
  future feature twice, which is the exact debt decision 0007 paid off.
- Binding fills to the media id rather than to clips means one slot can cut
  to the beat many times and fill once - and the engine's "clips reference
  media" indirection was already the right join point.
- Relative asset paths stay confined to the bundle boundary. The engine
  still never sees anything but ordinary paths, so `wolfcut-media`,
  `wolfcut-render` and the exporter needed no changes at all.

## What it costs
- Slot metadata rides in every document, invisible until used.
- A bundle copies its design media in full; big soundtracks make big
  templates. Acceptable - a template that references files it does not own
  breaks the moment it travels, which is the whole point of having one.

## What would change our mind
Sharing templates between machines at scale (a gallery, a marketplace) would
want a zipped single-file form and a manifest version - packaging concerns,
which change the host's bundle code and nothing in this crate.
