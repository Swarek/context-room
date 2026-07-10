---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup skills
  last_verified: 2026-07-06
  sources: [src/context_room.mjs, docs/agent-configuration.md]
---

# Startup Skills

## Purpose

Startup skills show skill folders that may affect future agent behavior.

## Example Flow

1. Enable `startupSkills`.
2. Configure folder names such as user or repo skill roots.
3. Open a discovered skill from the startup skills panel.
4. Create or delete skills only in writable skill folders.

## Rules

- System skill folders are read-only.
- Writable skill folders can create a new skill from the panel.
- Startup skills can be opened in the explorer without broadening the whole project allowlist.
- Skill edits should still follow the normal review rules when the edited file is watched.

## Source Map

- `listStartupSkillFolders` discovers skill roots.
- `readStartupSkillFile`, `writeStartupSkillFile`, `createStartupSkillFile`, and `deleteStartupSkill` handle skill actions.
- `startupSkillExplorerRootPath` exposes one active skill folder to the explorer.
- `renderStartupSkillsPanel` renders the hub panel.
