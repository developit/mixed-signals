# demos/orchestra

Scaffold and design documents for **The Impossible Orchestra**, a multi-realm showcase for `mixed-signals`.

This directory is intentionally prepared for a follow-up implementation pass.

## What is here

- `PLAN.md` — product/architecture/implementation plan
- `AGENTS.md` — scoped instructions for implementor agents
- `shared/types.ts` — API/type contracts across realms
- `shared/transports.ts` — transport wrappers and helpers
- `audio/` — audio worker-side model stubs and bootstrapping
- `visual/` — visual worker-side model stubs and bootstrapping
- `broker/` — composition/orchestration scaffolding
- `ui/` — reflected model registrations and UI skeletons

## Intended implementation order

1. audio worker
2. broker
3. UI
4. visual worker
5. debug overlay and multi-client audience mode
