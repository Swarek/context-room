# Context Room

Local-first documentation control room for AI-assisted projects.

Context Room gives a repository a browser UI to map important docs, edit safe text files, review watched doc changes, and generate deterministic context briefs before agent work.

## Use It For

- Make project docs, runbooks, skills, and agent instructions easy to find.
- Keep edits inside explicit safe paths.
- Review important doc changes before they become trusted context.
- Inspect startup context, startup skills, and hooks that can affect agents.
- Run local checks with no LLM call.
- Report watched doc changes before commits without blocking by default.

## Core Loop

1. Configure `.context-room/config.json`.
2. Start the local UI.
3. Edit docs inside `allowedPaths`.
4. Review changes from `watchAllow` or `reviewPaths`.
5. Run `doctor`, `guard`, or `brief` when you need proof.

## Quick Start

Requires Node.js 20 or newer.

From npm:

```bash
npm install -D context-room
npx context-room init --title "My Project"
npx context-room start --root . --port 4317
```

From this repo checkout:

```bash
npm test
node bin/context-room.mjs init --root /path/to/project --title "My Project"
node bin/context-room.mjs start --root /path/to/project --port 4317
```

Open:

```text
http://127.0.0.1:4317
```

## Main Files

- `.context-room/config.json`: project map, safe edit paths, watched paths, hub cards, startup scanners, templates.
- `~/.context-room/preferences.json`: computer-wide appearance preferences shared by every Context Room.
- Runtime review state and external baselines live under `.context-room/`.
- `docs/agent-configuration.md`: full config guide for agents and humans.
- `schemas/config.schema.json`: JSON Schema for config validation and editor autocomplete.

Runtime files under `.context-room/` are excluded from Git where possible. Commit the config only when the project should share the same Context Room map.

## Commands

```bash
context-room init [--title "My Project"] [--allow docs/,src/] [--watch docs/]
context-room start [--root .] [--port 4317]
context-room doctor [--root .] [--strict]
context-room guard [--root .] [--profile advisory|review-only|strict] [--operation commit|push|pull-request|merge]
context-room brief [--root .] [--task "change billing onboarding"] [--limit 12]
context-room agent queue [--root .]
context-room agent open [--root .] [--path docs/INDEX.md] [--view hub|settings|file|diff]
context-room agent annotate --root . --path docs/INDEX.md --note "Human-facing note"
context-room install-hooks [--root .]
context-room update-all [--dry-run] [--no-restart] [--exclude /path]
```

- `doctor` reports config, graph, metadata, link, startup-context, startup-hook, and hub health.
- `guard` and `review-only` are non-blocking. `--profile strict` can always fail; a selected `--operation` fails when review is pending.
- The Review settings tab stores owner-selected gates outside project config. Local hooks cover commit, push, and local merge; pull requests and hosted merges need a required provider check.
- `brief` ranks relevant docs locally and deterministically. It does not call an LLM.
- `agent` commands let an agent open files, inspect the queue, and leave annotations for the human.
- `update-all` installs the latest npm release globally and restarts every active room except a Context Room development checkout.

Preview an update without changing installations or processes:

```bash
node scripts/update-context-rooms.mjs --dry-run
```

Run the update from this repository even when its code is ahead of npm:

```bash
node scripts/update-context-rooms.mjs
```

Project configuration and review state are preserved. Restarted rooms write logs to `~/.context-room/logs/`.

## Agent HTML Context

Each initialized project contains a stable agent entry point:

```text
.context-room/README.md
```

Link an agent to this standalone workflow before asking it to create or edit a visual HTML document. It explains selection, structure, interaction, scale, and quality checks, then links to the detailed catalogs. Context Room refreshes the local files from the installed version on every `init` and `start`; the generated files stay out of Git.

The reusable HTML examples are available directly at:

```text
.context-room/agent-context/context-room-visual-components.html
.context-room/agent-context/context-room-data-visual-components.html
```

## Minimal Config

```json
{
  "$schema": "https://raw.githubusercontent.com/Swarek/context-room/main/schemas/config.schema.json",
  "title": "My Project",
  "allowedPaths": ["docs/", "README.md", "AGENTS.md"],
  "watchAllow": ["docs/", "README.md"],
  "reviewPaths": [],
  "startupContext": {
    "enabled": true,
    "fileNames": ["AGENTS.md", "CLAUDE.md"],
    "globalPaths": ["~/.codex/AGENTS.md"]
  },
  "startupSkills": { "enabled": true, "folderNames": [".codex/skills", "skills"] },
  "startupHooks": {
    "enabled": true,
    "editable": false,
    "agentHooks": true,
    "gitHooks": true,
    "hookManagers": true,
    "agentHookSources": [
      { "id": "codex", "label": "Codex", "paths": [".codex/hooks.json"] }
    ]
  },
  "hubSections": [
    {
      "id": "main",
      "title": "Main",
      "cards": [
        { "id": "docs", "title": "Docs", "path": "docs/", "autoChildren": true },
        { "id": "readme", "title": "Readme", "path": "README.md" }
      ]
    }
  ]
}
```

Rules that matter:

- `allowedPaths` is the edit boundary.
- `watchAllow` controls changed files that need review.
- `reviewPaths` forces review even when Git has no diff and its array order defines the human verification path. Critical safety issues still appear first. Only unchanged required-review files show `Mark verified`; Git changes are completed through the inline diff.
- Review verification is shared by canonical absolute path and content hash.
- `startupHooks.editable` stays `false` unless the owner wants Context Room to edit executable hook files.

## Documentation

- `docs/product-overview.md`: product map and development source map.
- `docs/features/`: clear docs for each user-facing feature.
- `docs/agent-configuration.md`: config fields, metadata, and agent setup.

## Development

```bash
npm test
node bin/context-room.mjs doctor --root .
node bin/context-room.mjs start --root . --port 4317
```

The package has no runtime dependencies beyond Node.js built-ins.
