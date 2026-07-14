---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent configuration
  last_verified: 2026-07-14
  sources: [bin/context-room.mjs, src/context_room.mjs, schemas/config.schema.json]
---

# Agent configuration guide

Project behavior is configured with one JSON file:

```text
.context-room/config.json
```

That file is the contract between the project owner, the UI, and AI agents. If an agent needs to add a card, create a sub-card, change which folders are watched, or adjust the safe editable surface, it should edit this JSON file and then run `context-room doctor`.

Appearance preferences are shared across every Context Room on the computer and stored separately:

```text
~/.context-room/preferences.json
```

Use the Settings screen to change the app theme, hidden-file visibility, or `Auto-open Git diff`. Project paths, review rules, scanners, templates, and hub cards remain local to `.context-room/config.json`.

The human-owned review gate is also stored separately:

```text
.context-room/review-gate.json
```

Use the Review tab in Settings to choose any combination of `commit`, `push`, `pull request`, and `merge`. This policy is local to the worktree, excluded from Git, omitted from project configuration, and not writable through the Context Room agent CLI. Context Room treats it as owner-controlled policy; it is not a security boundary against a process with unrestricted filesystem access.

## Configuration intent checklist

Use this checklist to make the intended setup clear before checking field details. The schema and `context-room doctor` validate JSON syntax.

Check intent:

- `allowedPaths` exposes only safe editable text.
- `watchAllow` contains the docs, skills, and agent instructions that must be reviewed after changes.
- `reviewPaths` is used only for files that must be reviewed even without a Git diff.
- `hubSections` matches the clearest project navigation path.
- `startupContext`, `startupSkills`, and `startupHooks` show what can affect agent behavior before work starts.
- Hook editing stays off unless the project owner explicitly wants Context Room to edit executable files.

If those boundaries are right, the exact JSON shape is a mechanical concern.

## Configuration fields

### Global appearance preferences

`fileTheme`, `showHiddenFiles`, and `autoOpenGitDiff` apply to every Context Room on the computer. The Settings screen writes them to `~/.context-room/preferences.json`; they do not belong in project configuration.

### `allowedPaths`

Safety boundary.

Context Room only reads and writes editable text files inside these files or folders. Keep this list narrow and documentation-focused.

Good examples:

```json
"allowedPaths": ["docs/", "skills/", "README.md", "AGENTS.md"]
```

Avoid secrets, dependency folders, build outputs, generated files, private exports, and binary assets.

### `watchAllow`

Review boundary.

Files and folders here appear in the review queue when they are changed or newly created. This is where you put the documentation and skills that must be easy to review after agent work.

Good examples:

```json
"watchAllow": ["docs/", "skills/", "AGENTS.md", "docs/decisions/"]
```

### `reviewPaths`

Required verification boundary.

Files and folders here appear in the review queue until the current content is marked verified, even when there is no Git diff. Their array order defines the human verification path; critical safety issues still appear first. Use this for onboarding a documentation set or requiring explicit review of agent-critical files. Only unchanged entries from `reviewPaths` show `Mark verified`; Git changes are reviewed through their inline diff.

Good examples:

```json
"reviewPaths": ["AGENTS.md", "docs/INDEX.md", "skills/docs-architect/SKILL.md"]
```

### Shared review ledger

Verified content is recorded in the local Context Room state and in a shared repo ledger:

```text
.context-room/review-ledger.json
```

The shared key is the canonical absolute file path. Trust stores the exact content hash, a review hash that ignores only `context_room.last_verified`, whether the resource was present or absent when reviewed, and the last Git change for an absent path. When Context Room observes a restored path, it clears that deletion trust so a later deletion at the same path requires review again. A date-only edit is omitted from review queues and inline diffs. If two Context Rooms watch the same present file, one verification is enough until meaningful content changes.

When two or more watched files are deleted without being recognized as renames, the webapp groups them into an expandable deletion set. The path list is loaded only when opened, up to 5,000 pending paths at a time. Routine paths start selected; protected or uncertain-history paths start unselected and require an extra acknowledgement when included. A human can narrow the selection and confirm the removals once; the server rejects a stale batch key and revalidates every path before recording its absent state. This action acknowledges files that are already missing and never deletes them.

### `hubSections`

Navigation model.

Use hub sections for the paths that should be opened first. A card can point to one file or folder:

```json
{
  "id": "docs",
  "title": "Docs",
  "path": "docs/",
  "autoChildren": true
}
```

Use nested cards only when a folder needs a curated hierarchy. Use `autoChildren: true` when immediate children are enough.

### `startupContext`

Startup context scanner.

When enabled, Context Room lists matching files from the filesystem root down to the Context Room root. `globalPaths` adds explicit tool-level files such as `~/.codex/AGENTS.md`. This is useful for checking which instruction files may be injected before an agent starts working.

These files are read-only in Context Room and do not appear in the explorer.

Startup context files outside the Context Room root are not Git-reviewable from the project. Context Room therefore creates a local internal baseline the first time it sees them, then reports later edits in the Changed files to review queue. Opening one of those queue items shows the same inline accept/reject mini-diff flow, and accepting or rejecting the visible changes updates the Context Room baseline for future reviews.

### Generated agent context

Context Room writes its installed HTML visual guidance to `.context-room/`. The stable entry point is `.context-room/README.md`; it is a standalone creation guide and links to the full usage contract, pattern reference, and both visual catalogs in `.context-room/agent-context/`. `context-room init` and `context-room start` refresh these generated files, so agents can use one project-local path without depending on the npm installation location. The generated files are local runtime material and excluded from Git.

The explorer shows safe hidden files, including this generated folder, by default. `Show hidden files` is a computer-wide Appearance preference; disabling it hides dotfiles and dotfolders without changing project configuration or deleting anything.

### `startupSkills`

Startup skill scanner.

When enabled, Context Room lists configured skill folders such as `.codex/skills` or `skills`. This helps users see which reusable instructions may affect future agent work.

Startup skills can be opened in the explorer without making the whole project editable.

### `startupHooks`

Startup hook scanner.

When enabled, Context Room lists hook files that can affect agent work, commits, or validation. It scans AI coding agent hook sources from `agentHookSources`, effective Git hook directories including `core.hooksPath`, and common hook managers such as Husky, Lefthook, pre-commit, lint-staged, and `package.json` hook config.

Each `agentHookSources` entry names one agent system and the config/plugin paths to scan. This keeps Context Room usable with Codex, Claude Code, OpenCode, or any other coding agent without hard-coding one vendor as the default mental model.

For JSON agent hook configs, Context Room lists both the hook config file and referenced local hook scripts so users can review the exact commands that may run around agent tool use, prompt submission, session start, stop, or other lifecycle events.

Hook cards include a readable name, provider/source, a short description extracted from docstrings or comments, the file path, the event/source, tracking state, and a compact command summary when a command is known.

Hooks are read-only by default because they execute code. Enable `startupHooks.editable` only when the project owner intentionally wants Context Room to edit hook files.

## Documentation metadata

Structured Markdown docs should include frontmatter:

```md
---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: [src/billing.ts, docs/pricing.md]
---
```

Kinds:

- `agents`: instructions that shape agent behavior.
- `index`: navigation and source-of-truth map.
- `canonical`: current truth for a feature, system, or workflow.
- `procedure`: runbook, workflow, checklist, deploy or testing procedure.
- `decision`: decision record.

Statuses:

- `current`: can be trusted as current context.
- `draft`: still being prepared.
- `historical`: useful history, not current truth.
- `superseded`: replaced by another document.

Keep metadata small. The goal is not bureaucracy; it lets Context Room find stale docs, duplicate canonical truth, broken references, and missing source links.

## Rules for agents

1. Treat `.context-room/config.json` as the source of truth for Context Room setup.
2. Prefer editing the JSON directly over clicking in the UI when doing repository setup.
3. Keep `allowedPaths` conservative: documentation, skills, runbooks, agent instructions, and safe text files.
4. Put the truly important docs in `watchAllow`, not every file in the repo.
5. Use stable lowercase IDs with dashes, for example `agent-context`, `architecture`, `release-runbooks`.
6. Preserve the `$schema` field so editors and agents can validate the file shape.
7. After editing config, run:

```bash
context-room doctor
```

8. For stronger validation, run:

```bash
context-room doctor --strict
context-room guard --profile strict
```

Use strict mode only when the project is ready to enforce metadata and graph health.

9. To generate a local no-LLM context brief for a task, run:

```bash
context-room brief --task "change billing onboarding"
```

10. If available, start the UI and smoke-test the hub and review queue:

```bash
context-room start --port 4317
```

11. To install or refresh the local Git hooks selected by the owner review gate, run:

```bash
context-room install-hooks
```

`install-hook` remains as a compatibility alias. Context Room manages `pre-commit`, `pre-push`, and `pre-merge-commit` only when their matching operation is selected and refuses to overwrite a custom hook. A managed dispatcher can remain installed after an operation is deselected; it reads the active worktree's owner policy and exits silently. Git hooks are local and are not committed to the repository.

There is no local Git hook for creating a pull request, and a merge performed by GitHub, GitLab, or another host does not run the clone's hooks. For those selections, connect the corresponding command to a hosted check and make that check required:

```bash
context-room guard --operation pull-request --profile strict
context-room guard --operation merge --profile strict
```

The pull-request check runs after the PR exists; repository rules can use its result to prevent merge. Provider wiring is intentionally separate because Context Room is provider-agnostic.

To check what the hook will enforce without committing, run:

```bash
context-room guard
```

`guard` is advisory by default and exits with status `0` even when review is pending. `review-only` also reports without blocking. An explicit `--profile strict` invocation can fail regardless of owner policy. A selected `--operation` fails only for pending review; it does not add strict documentation-health failures to the Git gate.

## Agent setup prompt

```text
Configure Context Room for this repository.

Edit `.context-room/config.json` directly.

Goal: make the documentation and agent skills easy to navigate, maintain, and verify.

1. Inspect the repo structure.
2. Identify docs, skills, runbooks, agent instructions, prompts, and decision records.
3. Add them to `allowedPaths` only if they are safe editable text surfaces.
4. Add the critical ones to `watchAllow` so future agent changes are reviewable.
5. Organize `hubSections` into clear cards and nested cards.
6. Keep IDs stable and lowercase with dashes.
7. Prefer structured Markdown templates with `context_room` metadata.
8. Run `context-room doctor`.
9. Leave `.context-room/review-gate.json` to the project owner; agents do not change the selected operations.
10. Run `context-room guard` to inspect the watched docs queue without blocking work.
11. Optionally run `context-room brief --task "..."` before an agent starts a focused change.
12. Do not include secrets, .env files, build outputs, node_modules, private exports, or generated artifacts.
```
