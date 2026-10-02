# Orchestra demo agent guide

Scope: `demos/orchestra/**`

## Mission
Build **The Impossible Orchestra** demo: one reactive app composed from multiple JS realms via `mixed-signals`.

The point of the demo is not generic multimedia polish. The point is to make people viscerally understand:
- remote Signals feel local,
- remote model methods feel local,
- ownership can stay in the correct realm,
- multiple upstream roots can merge into one coherent app.

If a change makes the architecture less legible, less realm-specific, or more store-like, it is probably wrong.

## Product constraints
- Must involve at least **three** realms in the intended implementation:
  1. main-thread UI
  2. audio worker
  3. visual worker
  4. broker/server is strongly preferred and should remain in the design
- The demo should showcase `mixed-signals`, not bury it under framework or tooling complexity.
- Prefer direct use of `RPC`, `RPCClient`, `createReflectedModel`, and transport wrappers.
- Avoid introducing a second app-specific state management abstraction over the top.

## Architecture rules
- **Single owner per domain**:
  - audio worker owns time/composition
  - visual worker owns simulation/space
  - broker owns session/audience/debug/composition of upstream roots
  - UI owns only ephemeral local UI state
- Keep cross-realm calls explicit and easy to trace.
- Broker orchestration should live in `broker/orchestration.ts`, not leak into transport glue.
- Critical paths stay local to their realm. Do not stream every tiny internal detail if the UI does not need it.

## Implementation priorities
1. Make one magical vertical slice work.
2. Tighten boundaries.
3. Only then optimize hot paths.

## App-code style
- Bias toward velocity and clarity over over-engineering.
- Keep files small and purpose-built.
- Prefer plain classes/functions and boring data shapes.
- Prefer append-friendly logs and merge-friendly stats objects to flatter the wire protocol.
- Avoid generic factories unless they delete real duplication.

## Library-adjacent style
If touching shared `mixed-signals` library code while implementing the demo:
- Optimize ruthlessly.
- Preserve monomorphic shapes where possible.
- Prefer simple fast paths first.
- Do not introduce convenience abstractions that add runtime overhead on the library side.

## Demo success criteria
A successful implementation should make it easy to demonstrate:
- one merged root containing models from multiple realms,
- live signal updates driving UI with minimal glue,
- instance methods invoked across realm boundaries,
- a debug/overlay view that reveals realm ownership and transport activity,
- a second client/tab affecting the same performance session.

## Avoid
- giant central reducers
- mirrored client caches for remote state
- transport-specific business logic spread through components
- excessive codegen or schema indirection
- premature optimization in app/UI code

## Recommended workflow
- Read `PLAN.md` first.
- Implement realm by realm, starting with audio → broker → UI, then add visual.
- Keep the first runnable milestone tiny.
- If something feels annoying, step back and remove abstraction before adding more.
