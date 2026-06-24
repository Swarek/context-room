# Context Room

Documentation control room for the era of AI agent loops.

AI agents can now loop on tasks for hours and days to create the biggest projects. In that world, the highest-leverage part of a project is no longer the source code. It is the documentation that tells agents what the project is, how it works, what matters, what are the features, all the details of the features it needs, and which reusable skills or procedures should guide future work.

Context Room is built around one belief: if you maintain excellent documentation, you can build the bests AI-native projects.

It gives any repository a local browser UI to manage, navigate, and verify the docs and skills that keep agents aligned.

## What it does

Context Room helps you:

- organize project documentation into cards and nested cards;
- define which folders and files matter most;
- mark critical documentation as watched;
- see what an agent changed in watched docs;
- review those changes with Git-backed diffs;
- verify that documentation updates are correct;
- keep the review state local to the project;
- let an AI agent install and configure the documentation map for you.

Documentation can include traditional docs, project instructions, agent context files, runbooks, operating procedures, prompts, skills, decision records, or any other text files that shape how humans and agents understand the project.

## Why this exists

AI agents are only as good as the context they inherit.

When documentation drifts, agents make worse decisions. When skills are stale, agents repeat old mistakes. When important files change without review, the whole project can slowly lose coherence.

Context Room gives you a simple loop:

1. choose the docs and skills that matter;
2. let humans and agents improve them;
3. see every important documentation change;
4. inspect the diff;
5. mark it verified when it is actually correct.

The goal is not to replace your editor or Git workflow. The goal is to make documentation maintenance visible, reviewable, and easy enough that it actually happens.

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
  "allowedPaths": ["docs/", "skills/", "README.md", "AGENTS.md"],
  "watchAllow": ["docs/", "skills/", "AGENTS.md"],
  "hubSections": [
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
  ]
}
```

`allowedPaths` is the safety boundary. Context Room will only read/write editable text files inside those paths.

`watchAllow` controls the review queue. A watched folder includes changed tracked files and new untracked files inside it.

## CLI

```bash
context-room init [--title "My Project"] [--allow docs/,skills/,README.md,AGENTS.md] [--watch docs/,skills/]
context-room start [--root .] [--port 4317]
context-room doctor [--root .]
```

## Agent setup prompt

Use this in Hermes, Claude Code, Codex, OpenCode, or another coding agent:

```text
Install Context Room in this repository.

Goal: make the project documentation and agent skills easy to navigate, maintain, and verify.

1. Run `npx context-room init` or the local `node bin/context-room.mjs init`.
2. Inspect the repo structure.
3. Identify the documentation, agent instructions, skills, runbooks, and decision records that shape future agent work.
4. Configure `.context-room/config.json` with useful cards and nested cards.
5. Put only safe editable text surfaces in `allowedPaths`.
6. Put the important docs and skills in `watchAllow`.
7. Run `context-room doctor` and `context-room start`.
8. Smoke-test the UI at http://127.0.0.1:4317.

Do not include secrets, .env files, build outputs, node_modules, private data exports, or generated artifacts.
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
