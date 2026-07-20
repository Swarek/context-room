---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup context
  last_verified: 2026-07-19
  sources: [src/context_room.mjs, docs/agent-configuration.md]
---

# Startup Context

## Purpose

Startup context shows instruction files that may be injected before an agent works in the repo.

## Example Flow

1. Fresh setup enables `startupContext` when the project contains a matching local instruction file.
2. Keep `projectOnly: true` for project-local discovery.
3. To inspect broader context deliberately, set `projectOnly: false` and configure ancestor filenames or explicit global paths.
4. Open matching files from the startup context panel.

## Rules

- Project-local instruction files can also appear in the normal explorer. Ancestor and global startup-context files stay outside it.
- Fresh configs are project-only. Existing configs without `projectOnly` retain ancestor discovery for compatibility.
- Global files must be listed explicitly; Context Room does not scan the whole home directory.
- Files outside the Context Room root require one initial review. Context Room stores an observation baseline as soon as each file is discovered, without marking it verified, so edits made before the first human decision still produce a real diff.
- Content changed before Context Room's first observation is recoverable only when Git history, a backup, or another trustworthy snapshot exists.
- Every `AGENTS.md` inside the project is automatically editable and watched, including nested instruction files omitted from configured paths. It is also required for review by default; `reviewAgentInstructions: false` removes only that implicit required-review rule.
- Markdown startup files can be backed up and deleted from the panel when supported.
- Do not treat ancestor instructions as project docs unless they are actually inside the project.

## Source Map

- `listStartupContextFiles` discovers matching files.
- `readStartupContextFile`, `writeStartupContextFile`, and `deleteStartupContextFile` handle file actions.
- `buildStartupContextReviewQueue` adds external changes to review.
- `renderStartupContextPanel` renders the hub panel.
