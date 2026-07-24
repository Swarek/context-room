---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: global Context Hub
  last_verified: 2026-07-23
  sources: [src/context_hub.mjs, src/context_room.mjs, src/codex_prompt_center.mjs, src/shared_context.mjs, bin/context-room.mjs, docs/features/shared-context.md, docs/features/codex-prompt-center.md]
---

# Context Hub

## Purpose

Context Hub is one local cockpit for every registered Context Room project and shared-context repository. It keeps local files and shared proposals together without pretending they use the same trust workflow.

| Source | Trusted content | Owner workflow |
| --- | --- | --- |
| Local project | Files inside that project's allowed paths | Open the project room, edit normally, then complete its local review queue |
| Shared repository | The accepted default-branch snapshot | Open an exact proposal commit, accept all or part, then prepare and merge its pull request |

A project may be local-only, shared-only, or local and connected to shared docs and skills. The UI labels every item by source and explains which review path it uses.

## Start Or Reuse The Hub

```bash
context-room hub --root .
```

The command initializes and registers the current local project, then starts one global Hub service. If that service is already healthy, another invocation reuses it and prints a URL focused on the current project instead of starting another Hub.

Use a shared-only launch when the current directory should not become a local project:

```bash
context-room hub --no-local
```

Inspect the user-local catalog or add a shared repository without connecting a local project:

```bash
context-room hub list
context-room hub add-shared --repository git@github.com:example/company-shared-context.git
context-room hub proposals --session <task-id>
context-room hub open --session <task-id>
```

Normal `init`, `setup`, and `start` flows register their initialized project automatically. Shared setup records the repository and links the local project to its shared project ID.

`hub proposals` exposes the aggregated proposal index to agents and can filter by project or Codex task ID. `hub open` prints a deep link into the running Hub with the same focus.

## Inbox, Projects, And Codex Prompts

**Inbox** combines work that may need attention:

- published shared proposals, including their current title, latest cumulative agent recap, author, session, files, branch, and exact hash;
- local projects whose normal review queue contains files;
- proposal states such as ready, updated after review, in review, accepted branch ready, and merged.

**Projects** shows every registered project, including clean local projects and shared projects with no local folder. Filters can narrow by project or by local versus shared source. Search covers project names, proposal metadata, paths, sessions, hashes, roots, and repositories. The selected-proposal overview labels the recap explicitly before the owner opens the diff.

Repository-wide proposal scopes appear as a dedicated **Global skills** project. They stay searchable and filterable without being duplicated under every project that consumes them.

**Codex prompts** loads a compatible installed Codex runtime's global prompt catalog on demand. It groups every runtime-published target without hardcoding mode or model names, compares official, effective-after-restart, and runtime-loaded versions, and saves exact private overlays. Runtime receipts prove local resolution by target, not mode selection or task delivery. Prompt state is not project configuration and never enters the local or shared review workflow. See [Codex Prompt Center](codex-prompt-center.md).

Keyboard shortcuts inside the Hub:

- `/`: focus search;
- `j` and `k`: move through visible items;
- `Escape`: return to the current Context Room.

## Freshness And Isolation

Opening a connected local project refreshes its accepted shared snapshot before its room starts. If the remote is unavailable, the normal shared-context offline rules apply.

Each local project still runs in an isolated Context Room server with its own project identity. The Hub embeds that room instead of giving one server arbitrary path access. Shared proposal reviews use the same isolation: each exact commit receives its own review worktree and room.

The global registry lives at `$HOME/.context-room/hub/registry.json`. The running Hub record lives beside it in `runtime.json`. Both are computer-local state, not project truth and not files to commit.

## Source Map

- `src/context_hub.mjs`: global project, shared-repository, and runtime registry.
- `src/context_room.mjs`: aggregate Hub state, inbox UI, prompt-center UI, project-room isolation, and exact review embedding.
- `src/codex_prompt_center.mjs`: runtime-published prompt catalog, private overlays, and load receipts.
- `src/shared_context.mjs`: shared-only repository listing, proposal lifecycle signals, and exact review materialization.
- `bin/context-room.mjs`: `context-room hub` commands and automatic registration.
- [Shared context](shared-context.md): proposal, acceptance, skills, freshness, and permission contracts.
