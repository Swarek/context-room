---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: product overview
  last_verified: 2026-07-23
  sources: [README.md, bin/context-room.mjs, src/context_room.mjs, src/context_hub.mjs, src/doc_agent.mjs, src/shared_context.mjs, schemas/config.schema.json, schemas/doc-context.schema.json, schemas/shared-repository.schema.json, docs/agent-configuration.md]
---

# Product Overview

## Purpose

Context Room is a local browser UI for keeping project context visible, editable, and reviewable. It is built for repos where humans and agents both depend on docs, skills, runbooks, and startup instructions.

## Product Loop

1. Run `context-room setup` for one isolated project room, or `context-room hub` for the global local-and-shared cockpit.
2. Use the truth-aware hub to find current docs, targets, records, and source areas that matter.
3. Edit safe text files inside `allowedPaths`.
4. Review watched changes from `watchAllow`, folder `watchRules`, and `reviewPaths`.
5. Run `doctor`, `guard`, or `brief` for deterministic proof, or `context ask` when a working agent needs a task-specific documentation packet from the detected project or an explicit shared-only project target.
6. Route durable documentation updates through the local review queue or a task-scoped shared proposal; selected large projects may run a scheduled read-only-first audit.

Projects that need cross-project documentation or skills can add the optional [Shared context](features/shared-context.md) loop. The accepted shared default branch is mounted as read-only context; agents propose changes on scoped `proposal/*` branches and humans review the exact proposal before accepting all or part of it.

## Main Surfaces

- Hub: card-based navigation from `hubSections`.
- Context Hub: one computer-local inbox and project switcher for local review queues and shared proposals, while each opened project keeps an isolated server and identity.
- Explorer and editor: safe project text, with editing limited by `allowedPaths` and four explicit folder watch modes.
- Changed files to review: Git-backed review queue, required review paths, project `AGENTS.md` files unless implicit review is disabled, and every skill exposed by Startup skills.
- Startup context: project instruction files by default, with ancestor and global discovery available by opt-in.
- Startup skills: project skill folders by default, with ancestor discovery available for existing or explicitly broadened configs.
- Startup hooks: project AI-agent and hook-manager files plus current-repository Git hooks by default.
- Settings: tabbed editor for project configuration plus computer-wide appearance and keyboard-shortcut preferences.
- Agent CLI: queue inspection, navigation, annotations, and explicit folder watch configuration for coding agents.
- Documentation research agent: a fresh read-only Codex researcher per request, backed by a deterministic section-level documentation CLI and a schema-constrained evidence packet.
- Documentation lifecycle: shared maintenance and audit skills, task-scoped proposal reuse, and explicit local/shared/mixed write routing.
- Shared context: an optional, generic Git-backed accepted snapshot with project and global skills, scoped proposal worktrees, and exact-commit human review.

Feature-level docs live in [Features](features/index.md).

## Product Rules

- Keep the edit surface narrow. Add paths only when Context Room should be allowed to read and write them.
- Treat review as human-owned. Agents can surface the queue, but they should not mark docs verified for the user.
- Keep executable hooks read-only unless the project owner explicitly enables hook editing.
- Keep briefs deterministic. `context-room brief` ranks local docs and does not call an LLM.
- Keep documentation research isolated. `context-room context ask` may launch Codex, while every `context-room docs` command remains deterministic and read-only.
- Keep accepted and pending evidence separate. Same-task proposals may guide current work, but they never become current facts before human acceptance and merge.
- Keep config changes source-grounded. Run `context-room doctor` after changing `.context-room/config.json`.
- Keep accepted shared context read-only. Changes belong in a proposal worktree, and only a human should complete the acceptance into the shared default branch.
- Keep rooms isolated. Automatic port selection must not stop another room, and a stale tab must not write state after its port begins serving another project root.

## Data Model

- `allowedPaths`: files and folders Context Room may expose for editing.
- `readOnlyPaths`: allowed files and folders Context Room may display but must not create, edit, or delete.
- `watchAllow`: simple exact file watches and compatible recursive live folder watches.
- `watchRules`: explicit folder watches that combine recursive or direct-child scope with live or current-file membership. The full contract lives in [Agent configuration](agent-configuration.md#watchrules).
- `reviewPaths`: files and folders that stay in review until the current content is verified. `Mark verified` is reserved for unchanged required-review files.
- `.context-room/review-gate.json`: local owner policy selecting which Git operations pending review can block. It stays outside project config and the agent CLI cannot change it.
- `hubSections`: visible navigation structure.
- `startupContext`: instruction files that may shape agent behavior before work starts.
- `startupSkills`: skill folders that may shape future agent behavior.
- `startupHooks`: hook files that can run around agent work, Git actions, or validation.
- `context_room` metadata: optional Markdown frontmatter used by `doctor`, graph health, and briefs.
- `~/.context-room/shared/registry.json`: user-approved source-repository and subpath bindings for generic shared context.
- `$HOME/.context-room/hub/registry.json`: local project and shared-repository catalog used by the global Context Hub.
- `<shared-repository>/.context-room/shared-repository.json`: versioned contract for a shared repository's branch and path layout.
- `schemas/doc-context.schema.json`: structured evidence contract returned by the documentation research agent.

## Source Map

- `bin/context-room.mjs`: CLI entry point and command routing.
- `src/context_room.mjs`: server, file access, review queue, graph, brief, UI, and API.
- `src/shared_context.mjs`: shared repository sync, snapshots, skill links, proposals, review materialization, and acceptance.
- `src/context_hub.mjs`: global project/shared-repository registration and single-Hub runtime discovery.
- `src/doc_agent.mjs`: documentation-only corpus, section retrieval, Codex researcher invocation, and evidence packet rendering.
- `src/codex_composer_bridge.mjs`: loopback-only insertion into the active Codex composer.
- `src/doc_metadata.mjs`: Markdown metadata parsing.
- `src/yaml_utils.mjs`: YAML helpers.
- `schemas/config.schema.json`: config contract.
- `schemas/shared-repository.schema.json`: shared repository manifest contract.
- `schemas/doc-context.schema.json`: documentation research output contract.
- `test/context_room.test.mjs`: CLI, config, review, startup scanner, and UI behavior tests.
- `test/shared_context.test.mjs`: shared snapshots, skills, offline fallback, proposal scope, hash expiry, and partial-acceptance tests.
- `test/doc_agent.test.mjs`: documentation corpus, retrieval, provenance, prompt boundaries, and Codex invocation tests.
- `docs/agent-configuration.md`: detailed config guide.

## Development Loop

```bash
npm test
node bin/context-room.mjs doctor --root .
node bin/context-room.mjs start --root .
```

Without an explicit port, Context Room selects the first free port within the 200-port range starting at `4317`. An explicitly requested occupied port fails; Context Room does not stop the process using it. Confirm the served root through `/api/health` after startup.
