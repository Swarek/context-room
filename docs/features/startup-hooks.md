---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup hooks
  last_verified: 2026-07-19
  sources: [src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Startup Hooks

## Purpose

Startup hooks show files that can run around agent work, Git actions, or validation.

## Example Flow

1. Fresh setup enables `startupHooks` with `projectOnly: true`.
2. Configure project-local agent hook sources, current-repository Git hook names, and hook-manager paths.
3. Review grouped hook files from the startup hooks panel.
4. Keep hook editing disabled unless the project owner wants Context Room to edit executable files.

## Rules

- Hooks are read-only by default because they execute code.
- Fresh configs scan project-local hook paths and the current repository's effective Git hooks. Existing configs without `projectOnly` retain broader discovery for compatibility.
- Agent hook sources are configurable by label and path.
- JSON agent hook configs can expose referenced local scripts.
- Git hooks and hook managers should be visible when they can affect work. The current repository's effective Git hooks remain visible even when `projectOnly` is enabled; unrelated ancestor agent-hook configuration requires broader discovery.

## Source Map

- `listStartupHookFiles` discovers hooks.
- `readStartupHookFile` and `writeStartupHookFile` handle hook file access.
- `startupHookMetadata`, command summarizers, and provider helpers build labels.
- `renderStartupHooksPanel` renders filters and hook cards.
