---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent CLI
  last_verified: 2026-07-20
  sources: [bin/context-room.mjs, src/context_room.mjs]
---

# Agent CLI

## Purpose

The agent CLI lets a coding agent inspect Context Room state, manage explicit folder watch configuration, open files for the user, and leave annotations without bypassing human review.

## Example Flow

1. Agent runs `context-room agent state` or `context-room agent queue`.
2. Agent runs `context-room agent open` to ask the UI to open a file, view, heading, text target, or scroll position.
3. When configuration work requires it, the agent runs `context-room agent watch` or `context-room agent unwatch` for a folder.
4. Agent runs `context-room agent annotate` when it needs human attention on a file.
5. Human resolves annotations and review decisions in the UI.

Create the default recursive live rule:

```bash
context-room agent watch --root . --path docs/
```

Choose another folder mode explicitly, or remove the exact folder rule:

```bash
context-room agent watch --root . --path docs/ --mode direct-current
context-room agent unwatch --root . --path docs/
```

The accepted modes are `recursive-live`, `recursive-current`, `direct-current`, and `direct-live`. The two current-file modes capture their snapshot when `watch` runs. For their exact file, future-file, and subfolder semantics, see [Agent configuration](../agent-configuration.md#watchrules).

After changing a folder rule, run `context-room doctor --root .` and inspect `context-room agent queue --root .` to confirm the intended boundary without making a human review decision.

## Rules

- Agent queue access is read-only.
- Agent commands can navigate, annotate, and update explicit folder watch configuration, but cannot verify files.
- `agent watch` and `agent unwatch` change `.context-room/config.json`; they do not accept or reject review items and cannot change `.context-room/review-gate.json`.
- Annotations must stay human-facing and scoped to an allowed path.
- Session state is local runtime state, not project truth.

## Source Map

- `context-room agent state`, `agent queue`, `agent open`, `agent annotate`, `agent watch`, and `agent unwatch` are CLI entry points.
- `writeFolderWatchRule` and `removeFolderWatchRule` apply the same validated folder-rule mutations used by the webapp.
- `readCollaborationSessionState`, `writeAgentCommand`, `appendAgentAnnotation`, and `resolveAgentAnnotation` handle runtime state.
- `/api/agent/*` routes carry local command state between the CLI and browser UI.
