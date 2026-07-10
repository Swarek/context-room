---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent CLI
  last_verified: 2026-07-07
  sources: [bin/context-room.mjs, src/context_room.mjs]
---

# Agent CLI

## Purpose

The agent CLI lets a coding agent inspect Context Room state, open files for the user, and leave annotations without bypassing human review.

## Example Flow

1. Agent runs `context-room agent state` or `context-room agent queue`.
2. Agent runs `context-room agent open` to ask the UI to open a file, view, heading, text target, or scroll position.
3. Agent runs `context-room agent annotate` when it needs human attention on a file.
4. Human resolves annotations in the UI.

## Rules

- Agent queue access is read-only.
- Agent commands can navigate or annotate, not verify files.
- Annotations must stay human-facing and scoped to an allowed path.
- Session state is local runtime state, not project truth.

## Source Map

- `context-room agent state`, `agent queue`, `agent open`, and `agent annotate` are CLI entry points.
- `readCollaborationSessionState`, `writeAgentCommand`, `appendAgentAnnotation`, and `resolveAgentAnnotation` handle runtime state.
- `/api/agent/*` routes carry local command state between the CLI and browser UI.
