---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup hooks
  last_verified: 2026-07-06
  sources: [src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Startup Hooks

## Purpose

Startup hooks show files that can run around agent work, Git actions, or validation.

## Example Flow

1. Enable `startupHooks`.
2. Configure agent hook sources, Git hook names, and hook-manager paths.
3. Review grouped hook files from the startup hooks panel.
4. Keep hook editing disabled unless the project owner wants Context Room to edit executable files.

## Rules

- Hooks are read-only by default because they execute code.
- Agent hook sources are configurable by label and path.
- JSON agent hook configs can expose referenced local scripts.
- Git hooks, hook managers, and external hooks should be visible when they can affect work.

## Source Map

- `listStartupHookFiles` discovers hooks.
- `readStartupHookFile` and `writeStartupHookFile` handle hook file access.
- `startupHookMetadata`, command summarizers, and provider helpers build labels.
- `renderStartupHooksPanel` renders filters and hook cards.
