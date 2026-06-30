# Agent configuration guide

Context Room is intentionally configured with one JSON file:

```text
.context-room/config.json
```

That file is the contract between the project owner, the UI, and AI agents. If an agent needs to add a card, create a sub-card, change which folders are watched, or adjust the safe editable surface, it should edit this JSON file and then run `context-room doctor`.

## Configuration model

```json
{
  "$schema": "https://raw.githubusercontent.com/Swarek/context-room/main/schemas/config.schema.json",
  "title": "My Project",
  "allowedPaths": ["docs/", "skills/", "README.md", "AGENTS.md"],
  "watchAllow": ["docs/", "skills/", "AGENTS.md"],
  "startupContext": {
    "enabled": true,
    "fileNames": ["AGENTS.md", "CLAUDE.md"]
  },
  "hubSections": []
}
```

### `allowedPaths`

Safety boundary.

Context Room only reads and writes editable text files inside these files or folders. Agents should keep this list narrow and documentation-focused.

Good examples:

```json
"allowedPaths": ["docs/", "skills/", "README.md", "AGENTS.md"]
```

Avoid secrets, dependency folders, build outputs, generated files, private exports, and binary assets.

### `watchAllow`

Review boundary.

Files and folders here appear in the review queue when they are changed or newly created. This is where you put the documentation and skills that must be human-verifiable after agent work.

Good examples:

```json
"watchAllow": ["docs/", "skills/", "AGENTS.md", "docs/decisions/"]
```

### `hubSections`

Navigation model.

A section contains cards. A card can point to one file/folder, multiple files/folders, or contain nested cards.

```json
{
  "id": "main",
  "title": "Documentation",
  "cards": [
    {
      "id": "docs",
      "title": "Docs",
      "path": "docs/",
      "autoChildren": true,
      "cards": [
        { "id": "architecture", "title": "Architecture", "path": "docs/architecture/" },
        { "id": "decisions", "title": "Decisions", "path": "docs/decisions/" }
      ]
    },
    {
      "id": "skills",
      "title": "Skills",
      "path": "skills/"
    },
    {
      "id": "agent-context",
      "title": "Agent context",
      "paths": ["AGENTS.md", "CLAUDE.md", ".hermes.md"]
    }
  ]
}
```

Use `autoChildren: true` when a folder should automatically expose its immediate files and subfolders as sub-cards. Explicit `cards` still win when you need a curated hierarchy.

### `startupContext`

Startup context scanner.

When enabled, Context Room lists matching files from the filesystem root down to the Context Room root. This is useful for checking which `AGENTS.md`, `CLAUDE.md`, or similar instruction files may be injected before an agent starts working.

These files are read-only in Context Room and do not appear in the explorer.

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

11. If commits should be blocked until watched docs are verified, install the local Git hook:

```bash
context-room install-hook
```

The hook writes `.git/hooks/pre-commit` in the current clone. Git hooks are local and are not committed to the repository, so each developer or agent environment must run this once after cloning.

To check what the hook will enforce without committing, run:

```bash
context-room guard
```

`guard` exits with status `1` when the watched docs review queue is not empty. A blocked commit means someone must open Context Room, inspect the watched-document diffs, and mark the changes verified before committing.

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
9. If the project wants commit protection, run `context-room install-hook`.
10. Run `context-room guard` to verify the watched docs queue is clean or correctly blocking.
11. Optionally run `context-room brief --task "..."` before an agent starts a focused change.
12. Do not include secrets, .env files, build outputs, node_modules, private exports, or generated artifacts.
```
