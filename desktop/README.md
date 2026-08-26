<p align="center">
  <img src="../assets/wolfcut_logo_512.png" alt="Wolfcut logo" width="160" />
</p>

# WolfCut Desktop

The editor front end. Tauri v2 + React 19 + Tailwind v4, talking to the Rust
engine in [`../engine`](../engine).

## Run it

```sh
npm install
npm run app          # tauri dev - builds the Rust host and opens the window
npm run app:build    # production bundle (msi/nsis on Windows)
npm run typecheck    # tsc --noEmit
```

`npm run dev` alone serves the UI in a browser, which is useful for pure layout
work - but every `invoke` fails there, because there is no Rust host behind it.

## Layout

```
src/
  App.tsx              editor shell: panel grid, window state, keyboard map
  components/
    TitleBar.tsx       custom title bar - the window is undecorated
    Icon.tsx           the whole icon set, plus the standard IconButton
    Panel.tsx          Panel / Bar / Divider / Empty - all shared chrome
    Menu.tsx           dropdown menus (title bar)
    ContextMenu.tsx    right-click menus (portal, edge-clamped)
    Resizer.tsx        draggable panel dividers
    MediaBin.tsx       import and list media; items are drag sources
    Preview.tsx        program monitor - a <video> element, for now
    TimelinePanel.tsx  toolbar, track headers, and the timeline canvas
    Inspector.tsx      properties of the selection
  lib/
    engine.ts          the ONLY file that calls invoke(). Typed IPC boundary.
    project.ts         the provisional edit model and its operations
    transport.ts       the playback clock
    audio.ts           audio preview - one media element per audible clip
    time.ts            display formatting. No time arithmetic lives in the UI.
  styles.css           Tailwind entry point, tokens, and the `surface` utility
src-tauri/
  src/lib.rs           Tauri commands: engine types in, JSON out. Nothing else.
```

## Rules that keep this fast

- **`lib/engine.ts` is the only file that calls `invoke`.** One place to fix
  when a command changes, and the compiler finds every call site.
- **The timeline is not DOM.** One canvas, one rAF loop. See decision 0002.
- **No time arithmetic in TypeScript.** The engine works in exact rational
  seconds; JS numbers are `f64` and drift. `lib/time.ts` formats, nothing more.
- **The UI does not own the edit — but it does today.** `lib/project.ts` holds
  a provisional model because the engine has no project API yet. Every
  operation there is a pure `(project, args) => project` function, which is the
  shape an engine command will have, so the call sites survive the migration.
  Do not let it grow an undo stack or a serialiser; those belong to the engine,
  and building them twice is how the two copies drift apart.

## Keyboard

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` `→` | Step one frame (`Shift` for ten) |
| `Home` `End` | Jump to start / end |
| `V` `C` | Select tool / razor tool |
| `S` | Split at playhead |
| `N` | Toggle snapping |
| `Del` | Delete selected clip |
| `Ctrl`+wheel | Zoom the timeline about the pointer |
| wheel | Pan the timeline |

## Adding a command

1. Write the function in `src-tauri/src/lib.rs`, `#[tauri::command]`, returning
   `Result<T, String>`.
2. Register it in `generate_handler![..]`.
3. Add the matching type and wrapper to `src/lib/engine.ts`.

The IPC boundary is JSON, so nothing checks steps 1 and 3 against each other.
Keep them adjacent in the same commit.

## Not decided yet

- **Content Security Policy** is `null` in `tauri.conf.json`. Fine while
  everything is local; it needs a real policy before the app loads anything it
  did not author. See decision 0003.
- **File import is a path box**, not a native dialog. Adding one means the
  `dialog` plugin and a capability entry - a decision for whoever builds real
  import.
- **No state library.** React state is enough while the engine owns the model.
  If it stops being enough, the answer is a store outside React (so timeline
  updates do not re-render the tree), not more `useState`.
