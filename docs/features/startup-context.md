---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup context
  last_verified: 2026-07-06
  sources: [src/context_room.mjs, docs/agent-configuration.md]
---

# Startup Context

## Purpose

Startup context shows instruction files that may be injected before an agent works in the repo.

## Example Flow

1. Enable `startupContext`.
2. Configure ancestor filenames and explicit global paths.
3. Context Room scans from the filesystem root down to the Context Room root, then adds configured global files.
4. Open matching files from the startup context panel.

## Rules

- Startup context files are separate from the normal explorer.
- Global files must be listed explicitly; Context Room does not scan the whole home directory.
- Files outside the Context Room root use a local baseline for review.
- Markdown startup files can be backed up and deleted from the panel when supported.
- Do not treat ancestor instructions as project docs unless they are actually inside the project.

## Source Map

- `listStartupContextFiles` discovers matching files.
- `readStartupContextFile`, `writeStartupContextFile`, and `deleteStartupContextFile` handle file actions.
- `buildStartupContextReviewQueue` adds external changes to review.
- `renderStartupContextPanel` renders the hub panel.
