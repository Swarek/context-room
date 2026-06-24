# Context Room

Local-first project context control room for humans and AI agents.

Context Room gives any repository a small browser UI to:

- browse and edit allowed project files;
- configure cards and nested cards for project navigation;
- mark folders/files as watched;
- review changed or newly-created watched files from Git;
- keep review state local to the project;
- let an AI agent install and configure the project map without inventing a custom dashboard.

It is the generic/open-source version of the LifeOS memory webapp prototype.

## Install

From npm once published:

```bash
npx context-room init
npx context-room start
```

From this repo checkout:

```bash
npm test
node bin/context-room.mjs init --root /path/to/project --title "My Project"
node bin/context-room.mjs start --root /path/to/project --port 4317
```

Then open:

```text
http://127.0.0.1:4317
```

## Project config

`context-room init` writes:

```text
.context-room/config.json
.context-room/review-state.json
```

Minimal config:

```json
{
  "title": "My Project",
  "allowedPaths": ["docs/", "src/", "tests/", "README.md"],
  "watchAllow": ["docs/architecture/"],
  "hubSections": [
    {
      "id": "main",
      "title": "Main",
      "cards": [
        {
          "id": "docs",
          "title": "Docs",
          "path": "docs/",
          "cards": [
            { "id": "architecture", "title": "Architecture", "path": "docs/architecture/" }
          ]
        }
      ]
    }
  ]
}
```

`allowedPaths` is the safety boundary. Context Room will only read/write editable text files inside those paths.

`watchAllow` controls the review queue. A watched folder includes changed tracked files and new untracked files inside it.

## CLI

```bash
context-room init [--title "My Project"] [--allow docs/,src/,README.md] [--watch docs/]
context-room start [--root .] [--port 4317]
context-room doctor [--root .]
```

## Agent setup prompt

Use this in Hermes, Claude Code, Codex, OpenCode, or another coding agent:

```text
Install Context Room in this repository.
1. Run `npx context-room init` or the local `node bin/context-room.mjs init`.
2. Inspect the repo structure.
3. Configure `.context-room/config.json` with useful cards and nested cards.
4. Put only safe editable text surfaces in `allowedPaths`.
5. Put the important docs/context folders in `watchAllow`.
6. Run `context-room doctor` and `context-room start`.
7. Smoke-test the UI at http://127.0.0.1:4317.
Do not include secrets, .env files, build outputs, node_modules, or private data exports.
```

## Open-source release checklist

Before publishing:

```bash
npm test
npm pack --dry-run
```

Recommended repo settings:

- MIT license;
- GitHub Actions running `npm test` on Node 20 and 22;
- npm provenance when publishing;
- screenshots/GIF after first public polish pass.

## Development

```bash
npm test
node bin/context-room.mjs init --root /tmp/demo-project --title Demo
node bin/context-room.mjs start --root /tmp/demo-project
```

The package has no runtime dependencies beyond Node.js built-ins.
