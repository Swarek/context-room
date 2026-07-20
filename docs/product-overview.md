---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: product overview
  last_verified: 2026-07-20
  sources: [README.md, bin/context-room.mjs, src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Product Overview

## Purpose

Context Room is a local browser UI for keeping project context visible, editable, and reviewable. It is built for repos where humans and agents both depend on docs, skills, runbooks, and startup instructions.

## Product Loop

1. Run `context-room setup` to discover the project's documentation, write a project-aware map, and start an isolated room.
2. Use the truth-aware hub to find current docs, targets, records, and source areas that matter.
3. Edit safe text files inside `allowedPaths`.
4. Review watched changes from `watchAllow`, folder `watchRules`, and `reviewPaths`.
5. Run `doctor`, `guard`, or `brief` before handing work to an agent or committing.

## Main Surfaces

- Hub: card-based navigation from `hubSections`.
- Explorer and editor: safe project text, with editing limited by `allowedPaths` and four explicit folder watch modes.
- Changed files to review: Git-backed review queue, required review paths, project `AGENTS.md` files unless implicit review is disabled, and every skill exposed by Startup skills.
- Startup context: project instruction files by default, with ancestor and global discovery available by opt-in.
- Startup skills: project skill folders by default, with ancestor discovery available for existing or explicitly broadened configs.
- Startup hooks: project AI-agent and hook-manager files plus current-repository Git hooks by default.
- Settings: tabbed editor for project configuration plus computer-wide appearance and keyboard-shortcut preferences.
- Agent CLI: queue inspection, navigation, annotations, and explicit folder watch configuration for coding agents.

Feature-level docs live in [Features](features/index.md).

## Product Rules

- Keep the edit surface narrow. Add paths only when Context Room should be allowed to read and write them.
- Treat review as human-owned. Agents can surface the queue, but they should not mark docs verified for the user.
- Keep executable hooks read-only unless the project owner explicitly enables hook editing.
- Keep briefs deterministic. `context-room brief` ranks local docs and does not call an LLM.
- Keep config changes source-grounded. Run `context-room doctor` after changing `.context-room/config.json`.
- Keep rooms isolated. Automatic port selection must not stop another room, and a stale tab must not write state after its port begins serving another project root.

## Data Model

- `allowedPaths`: files and folders Context Room may expose for editing.
- `watchAllow`: simple exact file watches and compatible recursive live folder watches.
- `watchRules`: explicit folder watches that combine recursive or direct-child scope with live or current-file membership. The full contract lives in [Agent configuration](agent-configuration.md#watchrules).
- `reviewPaths`: files and folders that stay in review until the current content is verified. `Mark verified` is reserved for unchanged required-review files.
- `.context-room/review-gate.json`: local owner policy selecting which Git operations pending review can block. It stays outside project config and the agent CLI cannot change it.
- `hubSections`: visible navigation structure.
- `startupContext`: instruction files that may shape agent behavior before work starts.
- `startupSkills`: skill folders that may shape future agent behavior.
- `startupHooks`: hook files that can run around agent work, Git actions, or validation.
- `context_room` metadata: optional Markdown frontmatter used by `doctor`, graph health, and briefs.

## Source Map

- `bin/context-room.mjs`: CLI entry point and command routing.
- `src/context_room.mjs`: server, file access, review queue, graph, brief, UI, and API.
- `src/codex_composer_bridge.mjs`: loopback-only insertion into the active Codex composer.
- `src/doc_metadata.mjs`: Markdown metadata parsing.
- `src/yaml_utils.mjs`: YAML helpers.
- `schemas/config.schema.json`: config contract.
- `test/context_room.test.mjs`: CLI, config, review, startup scanner, and UI behavior tests.
- `docs/agent-configuration.md`: detailed config guide.

## Development Loop

```bash
npm test
node bin/context-room.mjs doctor --root .
node bin/context-room.mjs start --root .
```

Without an explicit port, Context Room selects the first free port within the 200-port range starting at `4317`. An explicitly requested occupied port fails; Context Room does not stop the process using it. Confirm the served root through `/api/health` after startup.
