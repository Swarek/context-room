---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: settings
  last_verified: 2026-07-10
  sources: [src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Settings

## Purpose

Settings separates project setup from computer-wide preferences without exposing every option at once.

## Categories

- `Review`: watched and required-review paths.
- `Startup`: context, skills, and hook scanners.
- `Appearance`: global theme and Git diff behavior.
- `Templates`: Markdown document templates.
- `Hub`: sections, cards, and routing.

## Rules

- Show one category at a time and keep all categories reachable from the tab bar.
- Keep unsaved field values when switching categories, then save everything once.
- Label each category as project-scoped or global.
- Restore the active category after browser refresh.
- Keep nested template and hub editors collapsed until selected.

## Source Map

- `renderSettingsPanel` builds the category content.
- `renderSettingsTabs` and `activateSettingsSection` control navigation.
- `/api/settings` separates project configuration from global appearance preferences.
