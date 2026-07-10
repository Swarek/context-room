---
context_room:
  kind: agents
  scope: context-room
  status: current
  canonical_for: repository agent instructions
  last_verified: 2026-07-06
  sources: [README.md, docs/product-overview.md, docs/features/index.md, docs/agent-configuration.md, package.json]
---

# AGENTS.md

## Scope

These instructions apply to this repository. Use them for Context Room product, code, docs, config, tests, and release work.

## Read First

- Product/source map: `docs/product-overview.md`.
- Feature behavior: `docs/features/index.md`, then the relevant feature page.
- Config contract: `docs/agent-configuration.md` and `schemas/config.schema.json`.
- CLI entry point: `bin/context-room.mjs`.
- Main implementation: `src/context_room.mjs`.
- Tests: `test/context_room.test.mjs`.

## Local Rules

- Keep Context Room local-first and deterministic. Do not add LLM calls to `doctor`, `guard`, or `brief`.
- Keep edit and review boundaries explicit. Changes to `allowedPaths`, `watchAllow`, or `reviewPaths` must be source-grounded.
- Treat review as human-owned. Agents may expose the queue, but must not mark docs verified for the user.
- Keep executable hooks read-only by default. Only enable hook editing when the project owner asks.
- Replace stale docs instead of adding competing notes.
- Prefer fewer clearer words in docs and UI copy.
- Keep Markdown review focused on human-reviewable docs; do not add code or JSON to review paths unless requested.

## Implementation Notes

- `src/context_room.mjs` contains the server, API, file access, review queue, graph, brief logic, and browser UI.
- Prefer small changes inside existing helpers before adding new abstractions.
- When config behavior changes, update `schemas/config.schema.json`, `docs/agent-configuration.md`, and relevant feature docs.
- When user-facing behavior changes, update or add a focused test in `test/context_room.test.mjs`.

## Verification

Run the narrowest useful check first.

```bash
npm test
node bin/context-room.mjs doctor --root .
```

For package/release work, also run:

```bash
npm pack --dry-run
```
