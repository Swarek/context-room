---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent CLI
  last_verified: 2026-07-23
  sources: [bin/context-room.mjs, src/context_room.mjs, src/context_hub.mjs, src/doc_agent.mjs, src/shared_context.mjs, schemas/doc-context.schema.json]
---

# Agent CLI

## Purpose

The agent CLI lets a coding agent inspect Context Room state, request task-specific documentation context, manage explicit folder watch configuration, open files for the user, and leave annotations without bypassing human review. Its `hub` commands expose the computer-wide local/shared catalog, while `shared` commands let an agent create and publish scoped proposals without editing the accepted shared snapshot.

## Documentation Context Commands

The working agent uses one public command:

```bash
context-room context ask "what I need to do and why" [--root . | --repository <git-url> --project <project-id>] [--goal "outcome"] [--files path,...] [--depth quick|standard|exhaustive] [--budget 1200] [--session <task-id>] [--json]
```

Each call starts a fresh read-only, ephemeral `codex exec`. By default it uses the detected project. `--repository <git-url> --project <project-id>` instead reads that shared project's accepted docs, project skills, and global skills directly from an immutable cached Git snapshot; it does not initialize or bind the current directory. The researcher uses the deterministic `context-room docs capabilities|search|read|related|trace` surface and returns a schema-constrained evidence packet. It may read only documentation; working-file paths are search terms, not permission to inspect code. `--session`, or `CODEX_THREAD_ID`, also exposes the exact frozen project/global proposals owned by that task as separate pending evidence.

See [Documentation research agent](documentation-agent.md) for the complete retrieval, truth, output, and safety contract.

## Context Hub Commands

```bash
context-room hub --root .
context-room hub --no-local
context-room hub list
context-room hub add-shared --repository <git-url>
context-room hub proposals [--project <project-id>] [--session <task-id>]
context-room hub open [--project <project-id>] [--session <task-id>] [--proposal proposal/...]
```

`hub` starts or reuses the one global cockpit. From a project, it registers the canonical initialized root and prints a URL focused on that project. `--no-local` starts or reuses the Hub without registering the current directory. `hub list` and `hub proposals` are read-only. `hub open` prints a focused deep link into the running Hub. `hub add-shared` explicitly registers a compatible shared repository for shared-only browsing.

## Example Flow

1. Agent runs `context-room agent state` or `context-room agent queue`.
2. Agent runs `context-room agent open` to ask the UI to open a file, view, heading, text target, or scroll position.
3. When configuration work requires it, the agent runs `context-room agent watch` or `context-room agent unwatch` for a folder.
4. Agent runs `context-room agent annotate` when it needs human attention on a file.
5. Human resolves annotations and review decisions in the UI.

Create the default recursive live rule:

```bash
context-room agent watch --root . --path docs/
```

Choose another folder mode explicitly, or remove the exact folder rule:

```bash
context-room agent watch --root . --path docs/ --mode direct-current
context-room agent unwatch --root . --path docs/
```

The accepted modes are `recursive-live`, `recursive-current`, `direct-current`, and `direct-live`. The two current-file modes capture their snapshot when `watch` runs. For their exact file, future-file, and subfolder semantics, see [Agent configuration](../agent-configuration.md#watchrules).

After changing a folder rule, run `context-room doctor --root .` and inspect `context-room agent queue --root .` to confirm the intended boundary without making a human review decision.

## Shared Context Commands

Use the shared CLI when the project is connected to a generic shared-context Git repository:

```bash
context-room shared bind --root . --repository <git-url> [--project <project-id>]
context-room shared status --root .
context-room shared sync --root .
context-room shared security-check --root .
context-room shared proposals --root .
context-room shared propose --root . --title "Clarify onboarding" --description "Complete current agent recap" [--scope project|global] [--session <task-id>]
context-room shared publish --root . --proposal proposal/... [--title "Updated proposal name"] [--description "Required for every update"] [--message "..."]
context-room shared review --root . --proposal proposal/... [--port 4317]
```

`propose` returns a writable worktree and records the proposal name and agent recap. With a task ID, repeated calls reuse the one open proposal for that repository and project/global scope. `publish` rejects files outside the proposal's scope. The first publish uses the recap recorded by `propose`; every later publish requires a complete current `--description`, and may also replace the proposal name with `--title`. The latest commit therefore always owns the recap shown to owners.

`review` is the owner handoff: the room reuses the normal human inline decisions. Only the review UI exposes **Prepare pull request**, bound to the exact proposal hash that room examined. It publishes an `accepted/*` branch containing only the selected result; the agent-facing CLI has no acceptance or merge command. `security-check` verifies the live GitHub rule that blocks direct changes to `main`.

See [Shared context](shared-context.md) for repository initialization, read-only snapshots, refresh behavior, partial acceptance, and Git permission requirements.

## Rules

- Agent queue access is read-only.
- `context ask` launches a new documentation-only Codex researcher for every request; it never resumes an earlier research session.
- Accepted evidence and same-session pending proposal evidence are returned in separate packet fields.
- `docs` commands remain deterministic and make no model call.
- Agent commands can navigate, annotate, and update explicit folder watch configuration, but cannot verify files.
- Shared proposal commands can create and push a proposal, but they do not make its content trusted or accept it into the shared default branch.
- `agent watch` and `agent unwatch` change `.context-room/config.json`; they do not accept or reject review items and cannot change `.context-room/review-gate.json`.
- Annotations must stay human-facing and scoped to an allowed path.
- Session state is local runtime state, not project truth.

See [Documentation lifecycle](documentation-lifecycle.md) for the maintenance skill, scheduled audit, task proposal reuse, and local/shared/mixed routing.

## Source Map

- `context-room agent state`, `agent queue`, `agent open`, `agent annotate`, `agent watch`, and `agent unwatch` are CLI entry points.
- `context-room context ask` launches the researcher; `context-room docs` exposes its deterministic documentation toolbox.
- `src/doc_agent.mjs` builds the section-level corpus, enforces the prompt boundary, invokes Codex read-only and validates the context packet.
- `writeFolderWatchRule` and `removeFolderWatchRule` apply the same validated folder-rule mutations used by the webapp.
- `readCollaborationSessionState`, `writeAgentCommand`, `appendAgentAnnotation`, and `resolveAgentAnnotation` handle runtime state.
- `/api/agent/*` routes carry local command state between the CLI and browser UI.
