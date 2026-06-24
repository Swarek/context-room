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

8. If available, start the UI and smoke-test the hub and review queue:

```bash
context-room start --port 4317
```

9. If commits should be blocked until watched docs are verified, install the local Git hook:

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
7. Run `context-room doctor`.
8. If the project wants commit protection, run `context-room install-hook`.
9. Run `context-room guard` to verify the watched docs queue is clean or correctly blocking.
10. Do not include secrets, .env files, build outputs, node_modules, private exports, or generated artifacts.
```
