# 0003 - Timeline and graph objects are arena handles, not `Rc<RefCell<..>>`

## Decision
Clips, tracks and graph nodes live in a `wolfcut_core::arena::Arena<T>` and are
referred to by a `Copy` handle, `Id<T>`.

## Why
- Editor data is a graph: clips reference media, effects reference clips, nodes
  reference other nodes. Expressing that with owning pointers fights the borrow
  checker forever; expressing it with `Rc<RefCell<T>>` moves the fight to runtime
  and hands you cycles, leaks and `already borrowed` panics.
- Handles are `Copy`, `Eq` and `Hash`. They go into undo records, serialized
  projects, and across thread boundaries without ceremony.
- The generation counter turns "stale reference to a deleted clip" from a
  use-after-free into `arena.get(id) == None`.

## What it costs
- One indirection and one `Option` unwrap at every access.
- You pass `&Arena` around instead of following a pointer.

## What would change our mind
Nothing. This is the standard shape for this problem in Rust.
