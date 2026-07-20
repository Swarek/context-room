---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup skills
  last_verified: 2026-07-20
  sources: [src/context_room.mjs, docs/agent-configuration.md]
---

# Startup Skills

## Purpose

Startup skills show skill folders that may affect future agent behavior.

## Example Flow

1. Fresh setup enables `startupSkills` when the project contains a configured local skill root.
2. Keep `projectOnly: true`, or deliberately opt into ancestor skill roots for a broader room.
3. Open a discovered skill from the startup skills panel.
4. Review each discovered skill entrypoint once to establish its trusted content.
5. Create or delete skills only in writable skill folders.

## Rules

- System skill folders are read-only.
- Accepting the current content of a changed system skill records the review without rewriting the file. A reject or mixed decision that would change the file is blocked and returns the review to an actionable state.
- Fresh configs discover project skill roots only. Existing configs without `projectOnly` retain ancestor discovery for compatibility.
- Writable skill folders can create a new skill from the panel.
- Startup skills can be opened in the explorer without broadening the whole project allowlist.
- Every discovered skill entrypoint enters review once, then re-enters only after its meaningful content changes.
- At first discovery, Context Room stores an observation baseline immediately without accepting or trusting the skill. If the file remains unchanged, the initial review still offers `Accept document` or `Request changes` for the whole document.
- Any edit after that first observation uses the stored baseline and normal line-level accept/reject diff, even when the initial human review has not happened yet.
- Context Room cannot infer content that changed before its first observation when no Git history, backup, or recoverable snapshot exists. A recovered snapshot can be imported as the baseline without accepting or modifying the current skill.
- Repo skills already covered by a Git-backed queue item are deduplicated in favor of that richer diff.

## Source Map

- `listStartupSkillFolders` discovers skill roots.
- `readStartupSkillFile`, `writeStartupSkillFile`, `createStartupSkillFile`, and `deleteStartupSkill` handle skill actions.
- `startupSkillExplorerRootPath` exposes one active skill folder to the explorer.
- `buildStartupSkillReviewQueue` adds initial and changed skill reviews.
- `writeDocReviewBaselineContent` imports a recovered pre-edit snapshot without recording a review decision.
- `renderStartupSkillsPanel` renders the hub panel.
