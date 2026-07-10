---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: hub and navigation
  last_verified: 2026-07-06
  sources: [src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Hub And Navigation

## Purpose

The hub is the first screen for review-first work. It keeps the review queue visible before navigation and secondary context.

## Example Flow

1. Open Context Room.
2. Start with the review queue.
3. Open pending review files before using navigation.
4. If nothing needs review, use the explorer or cards to open files, filter folders, or expand child cards.
5. Use breadcrumbs to return through nested cards.

## Rules

- The review queue is the primary hub surface. Do not bury it behind navigation.
- The explorer is the direct path to known files and folders.
- Cards are secondary navigation for stable project areas.
- Startup context, skills, and hooks stay collapsed until needed.
- Cards must point only to paths covered by `allowedPaths`.
- Browser refresh should restore the current page, file, diff state, and scroll position.
- The first frame appears only after files, settings, and review data are ready, so the hub never assembles in visible stages.
- Background audits reuse cached results until a relevant file or setting changes; navigation and session-state updates do not rebuild the hub.
- Use child cards for curated structure and `autoChildren` for immediate folder children.
- Keep card titles short.
- Review behavior belongs in [Review Queue](review-queue.md).

## Source Map

- `renderDocQaDashboard` renders the review queue before hub folders.
- `renderHubFolders`, `renderHubFolderCard`, and related helpers render the hub.
- `hubSectionsForRoot` and card normalization build the visible card model.
- `buildDocQaReport` builds the changed files queue.
- `schemas/config.schema.json` defines the config shape.
