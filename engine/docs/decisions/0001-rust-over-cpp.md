# 0001 - Rust, not C++

## Decision
The engine is written in Rust.

## Why
- The render path is a fan-out across cores sharing a frame cache. Data races and
  use-after-free on frame buffers are *the* bug class here, and they are compile
  errors in Rust instead of a corrupt frame three hours into a render.
- This project is maintained by one person, intermittently. Rust's payoff is that
  you debug at compile time, alone, from the error text. No exceptions unwinding
  through the render loop, no implicit conversions, no surprise copy constructors.
- One build system, one formatter, one linter, one doc generator. Re-entering a
  C++ codebase cold means re-learning whatever build archaeology it invented.
- `wgpu` gives one GPU backend across Vulkan/Metal/DX12. In C++ that portability
  is a permanent tax.

## What it costs
- OpenFX / VST plugin hosting is a C ABI and will need `unsafe extern "C"` shims.
- Some vendor encoder SDKs are C++-first.
- Lifetime and trait-bound errors on generic code can be opaque - mitigated by
  keeping generics shallow.

## What would change our mind
A hard dependency that only ships a C++-template-only API.
