---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: settings
  last_verified: 2026-07-23
  sources: [src/context_room.mjs, src/codex_prompt_center.mjs, schemas/config.schema.json, docs/agent-configuration.md, docs/features/codex-prompt-center.md]
---

# Settings

## Purpose

Settings separates project setup from computer-wide preferences without exposing every option at once.

Codex prompts are not a Settings category. They use the global [Codex Prompt Center](codex-prompt-center.md), whose versioned runtime catalog, conflict handling, and private storage are separate from project configuration and appearance preferences.

## Categories

- `Review`: simple watched paths, structured folder watch rules, and required-review paths.
- `Startup`: context, skills, and hook scanners.
- `Appearance`: global theme, hidden-file visibility, Git diff behavior, and the **Reference in Codex** shortcut.
- `Templates`: Markdown document templates.
- `Hub`: sections, cards, and routing.

## Rules

- Show one category at a time and keep all categories reachable from the tab bar.
- Keep unsaved field values when switching categories, then save everything once.
- Label each category as project-scoped or global.
- Show safe hidden files by default. The global `Show hidden files` preference may hide dotfiles and dotfolders in every explorer.
- Store the Reference in Codex shortcut as a computer-wide preference. The default is `Mod+Shift+L`; clearing it disables keyboard activation without removing the floating action.
- Restore the active category after browser refresh.
- Keep nested template and hub editors collapsed until selected.
- Preserve structured `watchRules` when other settings are saved. Show each folder rule with its mode and snapshot size when applicable; removing a rule changes configuration, not project files or human review decisions.
- Create folder rules from the Explorer or agent CLI. See [Agent configuration](../agent-configuration.md#watchrules) for the canonical four-mode contract.

## Source Map

- `renderSettingsPanel` builds the category content.
- `removeWatchRuleFromSettings` removes one exact structured folder rule through `/api/watch-rule`.
- `renderSettingsTabs` and `activateSettingsSection` control navigation.
- `/api/settings` separates project configuration from global appearance and shortcut preferences.
