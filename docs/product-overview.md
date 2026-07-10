---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: product overview
  last_verified: 2026-07-07
  sources: [README.md, bin/context-room.mjs, src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Product Overview

## Purpose

Context Room is a local browser UI for keeping project context visible, editable, and reviewable. It is built for repos where humans and agents both depend on docs, skills, runbooks, and startup instructions.

## Product Loop

1. Configure the repo map in `.context-room/config.json`.
2. Use the hub to find the docs and source areas that matter.
3. Edit safe text files inside `allowedPaths`.
4. Review watched changes from `watchAllow` and `reviewPaths`.
5. Run `doctor`, `guard`, or `brief` before handing work to an agent or committing.

## Main Surfaces

- Hub: card-based navigation from `hubSections`.
- Explorer and editor: project files limited by `allowedPaths`.
- Changed files to review: Git-backed review queue plus required review paths.
- Startup context: ancestor agent instruction files from configured filenames.
- Startup skills: discovered skill folders from configured roots.
- Startup hooks: AI agent hooks, Git hooks, and hook-manager files.
- Settings: tabbed editor for project configuration plus computer-wide appearance preferences.
- Agent CLI: queue inspection, navigation, and annotations for coding agents.

Feature-level docs live in [Features](features/index.md).

## Product Rules

- Keep the edit surface narrow. Add paths only when Context Room should be allowed to read and write them.
- Treat review as human-owned. Agents can surface the queue, but they should not mark docs verified for the user.
- Keep executable hooks read-only unless the project owner explicitly enables hook editing.
- Keep briefs deterministic. `context-room brief` ranks local docs and does not call an LLM.
- Keep config changes source-grounded. Run `context-room doctor` after changing `.context-room/config.json`.

## Data Model

- `allowedPaths`: files and folders Context Room may expose for editing.
- `watchAllow`: files and folders that enter the review queue when changed.
- `reviewPaths`: files and folders that stay in review until the current content is verified. `Mark verified` is reserved for unchanged required-review files.
- `hubSections`: visible navigation structure.
- `startupContext`: instruction files that may shape agent behavior before work starts.
- `startupSkills`: skill folders that may shape future agent behavior.
- `startupHooks`: hook files that can run around agent work, Git actions, or validation.
- `context_room` metadata: optional Markdown frontmatter used by `doctor`, graph health, and briefs.

## Source Map

- `bin/context-room.mjs`: CLI entry point and command routing.
- `src/context_room.mjs`: server, file access, review queue, graph, brief, UI, and API.
- `src/doc_metadata.mjs`: Markdown metadata parsing.
- `src/yaml_utils.mjs`: YAML helpers.
- `schemas/config.schema.json`: config contract.
- `test/context_room.test.mjs`: CLI, config, review, startup scanner, and UI behavior tests.
- `docs/agent-configuration.md`: detailed config guide.

## Development Loop

```bash
npm test
node bin/context-room.mjs doctor --root .
node bin/context-room.mjs start --root . --port 4317
```

Use another port when one is already occupied. Do not stop an unrelated local Context Room instance just to free the default port.
