# 0007 - The engine owns the project

> **Status: the migration is complete.** Every step below is done;
> `lib/project.ts` and `lib/persist.ts` are deleted, and the freeze language
> in the decision is historical. This crate has since grown the template
> commands (decision 0008) on exactly the seam this note built.

## Decision
`relay-project` is the model of record for the edit: the document types,
every operation as a serialisable `Command`, whole-state undo, and the
tolerant `relay.json` reader/writer - all ported semantics-for-semantics from
the UI's provisional `lib/project.ts`. The host exposes it as the `editor_*`
commands (open / apply / undo / redo / save / state / close).

`lib/project.ts` is **frozen**: bug fixes only, mirrored into `relay-project`
in the same commit, until the UI has flipped onto the engine API and the file
is deleted.

## Why now
The provisional model was meant to be scaffolding, but it was accreting
features faster than the engine grew an API - multiple timelines, effects and
transitions all landed UI-side, and every one raised the migration bill. The
audit that preceded this decision called it the repo's biggest strategic
debt; this crate is the answer.

## Shape choices worth recording
- **A separate crate, not part of relay-core.** The document model needs
  serde; relay-core's zero-dependency rule is worth more than adjacency.
- **String ids and f64 seconds in the document model.** These match the
  on-disk format and the ten projects that already exist. The arena-handled,
  rational-time `relay-core::Timeline` remains the *render* model; the
  exporter converts, as it always has. Moving the document itself to exact
  time is a format decision to make once, deliberately, later.
- **Undo is whole-state snapshots**, capped at 200. A heavy project is a few
  hundred kilobytes; cloning per edit is cheaper than inverse operations and
  impossible to get wrong.
- **Compatibility is tested**, both ways: a document written by the TS side
  loads here (fixture test), and this crate's writer produces the same
  structure - including the flat active-timeline mirror for old builds.

## The migration plan
1. *(done)* Crate, commands, undo, document IO, host API, freeze.
2. *(done)* UI flipped: App state is the `EditorView` the host returns; every
   mutation is a serialised command; drags echo locally with the engine's own
   arithmetic (`lib/editor.ts`) and commit one command on release, so undo
   means "undo the drag"; Ctrl+Z / Ctrl+Shift+Z and the Edit menu drive the
   engine's history.
3. *(done)* `lib/project.ts` and `lib/persist.ts` are deleted. What remains
   in the UI is `lib/editor.ts`: type mirrors, read-only selectors, and the
   echo - view logic, not model ownership.

## What would change our mind
Nothing about ownership. IPC round-trip cost could force a finer-grained
state-sync protocol (patches instead of full snapshots) if profiling demands
it - that changes the wire format, not who owns the model.
