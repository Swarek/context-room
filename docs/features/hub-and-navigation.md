---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: hub and navigation
  last_verified: 2026-07-19
  sources: [src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Hub And Navigation

## Purpose

The project hub is the first screen for review-first work inside one isolated project. It keeps that project's review queue visible before navigation and secondary context. The computer-wide local/shared switcher is documented separately in [Context Hub](context-hub.md).

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
- Fresh setup derives cards from paths that exist. It uses nonempty sections for Start here, Current documentation, Target documentation, Decisions, research, and incidents, Documentation to classify, and Agent guidance. Unclassified docs stay visible without being promoted to current truth.
- Startup context, skills, and hooks stay collapsed until needed.
- Cards must point only to paths covered by `allowedPaths`.
- Browser refresh should restore the current page, file, diff state, and scroll position.
- A current tab binds API requests to the project root established at boot. If the same origin later serves a different root, stale requests are rejected and the tab reloads before its navigation or session state can affect the new room. Browser mutations from an older tab without a project identity are also rejected with `409` and cannot write state until the tab is reloaded.
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
