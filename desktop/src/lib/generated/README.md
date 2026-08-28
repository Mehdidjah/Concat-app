# Generated IPC types

Every `.ts` file in this directory is **generated from the Rust wire types**
by [ts-rs](https://github.com/Aleph-Alpha/ts-rs) - do not edit them by hand.
The Rust structs and enums are the source of truth:

- `engine/crates/wolfcut-project` - the document model and the whole command
  vocabulary (`Command`, `Clip`, `Project`, ...).
- `engine/crates/wolfcut-export` - the flattened clip the UI sends as a
  rasterised title overlay (`export/ExportClip.ts`).
- `desktop/src-tauri/src/editor_api.rs` - the host's own wire types
  (`EditorView`, `SettingsView`).

`desktop/src/lib/editor.ts` and `engine.ts` re-export these under the names
the UI has always used (`Command` as `EditorCommand`, `Timeline` as
`TimelineData`, and so on), so nothing else imports from here directly.

## Regenerating

After changing any `#[ts(export)]` type, run from the repository root:

```sh
scripts/generate-ipc-types.sh          # everything
scripts/generate-ipc-types.sh engine   # just the engine crates
scripts/generate-ipc-types.sh host     # just desktop/src-tauri
```

which is shorthand for (the export dir must be absolute):

```sh
export TS_RS_EXPORT_DIR="$PWD/desktop/src/lib/generated"
(cd engine && cargo test -p wolfcut-project -p wolfcut-export \
  --features wolfcut-project/types,wolfcut-export/types export_bindings)
(cd desktop/src-tauri && cargo test --features types export_bindings)
```

The files are committed, and CI regenerates them and fails on any diff - so a
Rust wire-type change that forgets to regenerate cannot land green. ts-rs
never deletes files: if a Rust type is renamed or removed, delete its stale
`.ts` file here by hand.
