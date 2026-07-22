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
- Share accepted documentation and global or project skills across repositories without giving agents a direct edit path to the accepted snapshot.

## Core Loop

1. Configure `.context-room/config.json`.
2. Start the local UI.
3. Edit docs inside `allowedPaths`.
4. Review changes from `watchAllow`, folder `watchRules`, or `reviewPaths`.
5. Run `doctor`, `guard`, or `brief` when you need proof.

## Quick Start

Requires Node.js 20 or newer.

From npm:

```bash
npm install -D context-room
npx context-room setup --title "My Project"
```

From this repo checkout:

```bash
npm test
node bin/context-room.mjs setup --root /path/to/project --title "My Project"
```

Fresh setup discovers the project's documentation, watches it, organizes it into truth-aware hub sections, and starts on the first free local port from `4317` upward. It prints the URL. Existing Context Rooms keep running, and re-running setup preserves an existing project configuration unless an explicit setup option deliberately amends its matching field.

Open the printed `/api/health` URL and confirm that `root` is the intended project before relying on the room.

## Main Files

- `.context-room/config.json`: project map, safe edit paths, watched paths, hub cards, startup scanners, templates.
- `~/.context-room/shared/registry.json`: user-approved bindings from source repositories and subpaths to generic shared-context projects.
- `~/.context-room/preferences.json`: computer-wide appearance preferences shared by every Context Room.
- Runtime review state and external baselines live under `.context-room/`.
- `docs/agent-configuration.md`: full config guide for agents and humans.
- `schemas/config.schema.json`: JSON Schema for config validation and editor autocomplete.
- `schemas/shared-repository.schema.json`: JSON Schema for the optional shared repository manifest.
- `schemas/shared-projects.schema.json`: JSON Schema for its project catalog and cwd mappings.

Runtime files under `.context-room/` are excluded from Git where possible. Commit the config only when the project should share the same Context Room map.

## Commands

```bash
context-room init [--title "My Project"] [--allow docs/,src/] [--watch docs/]
context-room setup [--root .] [--title "My Project"] [--port 4317]
context-room start [--root .] [--port 4317]
context-room doctor [--root .] [--strict]
context-room guard [--root .] [--profile advisory|review-only|strict] [--operation commit|push|pull-request|merge]
context-room brief [--root .] [--task "change billing onboarding"] [--limit 12]
context-room agent queue [--root .]
context-room agent open [--root .] [--path docs/INDEX.md] [--view hub|settings|file|diff]
context-room agent annotate --root . --path docs/INDEX.md --note "Human-facing note"
context-room agent watch --root . --path docs/ [--mode recursive-live|recursive-current|direct-current|direct-live]
context-room agent unwatch --root . --path docs/
context-room shared init-repository --root /path/to/shared-context --name "Company Shared Context"
context-room shared bind --root . --repository <git-url> [--project <project-id>]
context-room shared setup --root . --repository <git-url> [--project <project-id>]
context-room shared sync|status|proposals --root .
context-room shared secure-github|security-check --root .
context-room shared propose --root . --title "Change" --description "Current proposal summary" [--scope project|global] [--session <task-id>]
context-room shared publish --root . --proposal proposal/... [--title "Updated name"] [--description "Required when updating"] [--message "..."]
context-room shared review --root . --proposal proposal/... [--port 4317]
context-room install-hooks [--root .]
context-room update-all [--dry-run] [--no-restart] [--exclude /path]
```

- `doctor` reports config, graph, metadata, link, startup-context, startup-hook, and hub health.
- `setup` performs fresh project-aware initialization and starts the room; `init` remains write-only.
- Without an explicit port, `setup` and `start` choose the first free port within the 200-port range starting at `4317` and never stop another room. An occupied explicit port fails.
- `guard` and `review-only` are non-blocking. `--profile strict` can always fail; a selected `--operation` fails when review is pending.
- The Review settings tab stores owner-selected gates outside project config. Local hooks cover commit, push, and local merge; pull requests and hosted merges need a required provider check.
- `brief` ranks relevant docs locally and deterministically. It does not call an LLM.
- `agent` commands let an agent open files, inspect the queue, leave annotations for the human, and manage explicit folder watch rules without making review decisions.
- `shared` commands connect any compatible shared-context Git repository, refresh its accepted default-branch snapshot, manage scoped proposal worktrees, and open the normal review UI against an exact proposal commit. See [Shared context](docs/features/shared-context.md).
- `update-all` installs the latest npm release globally and restarts every verified active room it discovers except a Context Room development checkout. Before acting, it verifies each room's canonical project root through `/api/health`, so paths containing spaces are not inferred from process command text.

Preview an update without changing installations or processes:

```bash
node scripts/update-context-rooms.mjs --dry-run
```

Run the update from this repository even when its code is ahead of npm:

```bash
node scripts/update-context-rooms.mjs
```

Project configuration and review state are preserved. Restarted rooms write logs to `~/.context-room/logs/`.

## Agent Context

Each initialized project contains a stable agent entry point:

```text
.context-room/README.md
```

Link an agent to this standalone workflow when configuring the room or creating a visual HTML document. It routes project setup, then explains visual selection, structure, interaction, scale, and quality checks. Context Room refreshes the local files from the installed version on every `init`, `setup`, and `start`; the generated files stay out of Git.

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
  "projectOnly": true,
  "allowedPaths": ["docs/", "README.md", "AGENTS.md"],
  "readOnlyPaths": [],
  "watchAllow": ["docs/", "README.md"],
  "watchRules": [],
  "reviewPaths": [],
  "startupContext": {
    "enabled": true,
    "projectOnly": true,
    "fileNames": ["AGENTS.md", "CLAUDE.md"],
    "globalPaths": []
  },
  "startupSkills": { "enabled": true, "projectOnly": true, "folderNames": [".codex/skills", "skills"] },
  "startupHooks": {
    "enabled": true,
    "projectOnly": true,
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

- `allowedPaths` is the edit boundary. Project-relative entries stay in the project; an explicit `~/...` entry authorizes that external home file or folder without making other home paths accessible.
- `readOnlyPaths` narrows allowed files to display-only access. Shared accepted snapshots are added to both arrays and must be changed through proposal branches.
- Top-level `projectOnly: true` also requires ordinary allowed, watched, and hub paths to remain physically inside the project after symbolic links are resolved. Fresh setup enables it. Setting it to `false`, or omitting it in a legacy config, can make explicitly configured symlink targets outside the project both readable and editable; retain that compatibility only for trusted, established hubs.
- `watchAllow` keeps the simple watch list. A folder entry uses the default recursive live behavior: current and future files at any depth can enter review.
- `watchRules` stores explicit folder modes for recursive versus direct-child scope and live versus current-file snapshots. External rules must already be covered by a narrow `~/...` entry in `allowedPaths` and use Context Room review baselines because project Git does not own them. See [Agent configuration](docs/agent-configuration.md#watchrules).
- `reviewPaths` forces review even when Git has no diff and its array order defines the human verification path. Critical safety issues still appear first. Only unchanged required-review files show `Mark verified`; Git changes are completed through the inline diff.
- Review verification is shared by canonical absolute path and content hash.
- The separate `startupContext.projectOnly`, `startupSkills.projectOnly`, and `startupHooks.projectOnly` flags control scanner scope. Fresh setup enables all three; broader ancestor or global discovery is opt-in.
- `startupHooks.editable` stays `false` unless the owner wants Context Room to edit executable hook files.

## Documentation

- [Product overview](docs/product-overview.md): product map and development source map.
- [Feature documentation](docs/features/index.md): clear docs for each user-facing feature.
- [Agent configuration](docs/agent-configuration.md): config fields, metadata, and agent setup.
- [Shared context](docs/features/shared-context.md): generic shared repositories, proposals, partial acceptance, skills, freshness, and permissions.

## Development

```bash
npm test
node bin/context-room.mjs doctor --root .
node bin/context-room.mjs start --root .
```

The package has no runtime dependencies beyond Node.js built-ins.
