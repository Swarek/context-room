---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent configuration
  last_verified: 2026-07-20
  sources: [bin/context-room.mjs, src/context_room.mjs, schemas/config.schema.json]
---

# Agent configuration guide

Project behavior is configured with one JSON file:

```text
.context-room/config.json
```

That file is the contract between the project owner, the UI, and AI agents. Fresh setup derives it from the documentation that actually exists in the project. If an agent later needs to curate a card or safe editable surface, it should edit this JSON file and then run `context-room doctor`. For folder watch rules, prefer `context-room agent watch` and `context-room agent unwatch` so snapshots are captured consistently.

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

## Fresh project setup

Use one command to initialize the project-aware configuration and start an isolated room:

```bash
context-room setup --root . --title "My Project"
```

For a fresh project, `setup` and `init` inspect the existing repository before writing configuration. They:

- discover project-owned documentation, indexes, agent instructions, skills, runbooks, decisions, and records;
- add safe documentation surfaces to `allowedPaths` and `watchAllow`;
- organize discovered docs into the nonempty sections Start here, Current documentation, Target documentation, Decisions, research, and incidents, Documentation to classify, and Agent guidance;
- keep startup context, skills, and hooks project-only by default; and
- leave existing `AGENTS.md`, CLAUDE.md, documentation, and owner-controlled review policy unchanged.

`init` remains write-only. `setup` continues into the local server. Re-running either command preserves an existing `.context-room/config.json`, including intentionally empty or curated lists, instead of rebuilding it from inference. Explicit `--title`, `--allow`, or `--watch` options amend only their matching fields and preserve extension fields permitted by the schema. Invalid JSON stops setup without overwriting the file.

When no port is supplied, `setup` and `start` select the first free port within the 200-port range starting at `4317`. They never stop another Context Room. An explicitly requested occupied port fails with a clear error.

After startup, open the printed `/api/health` URL and confirm that `root` is the intended absolute project path. A current tab also binds itself to that root. If the same port later serves another project, the server rejects requests carrying the stale identity and the current tab reloads before old project state can be written into the new room. During an upgrade, browser-originated mutations from an older tab that sends no project identity are rejected with `409`; reload that tab once before editing. Headerless non-browser API and CLI requests remain compatible.

Run the deterministic configuration check as well:

```bash
context-room doctor --root .
```

Setup is complete when the health endpoint reports the intended root, watched and hub paths resolve inside `allowedPaths`, the hub exposes the discovered documentation clearly, and `doctor` has no unresolved high- or critical-severity setup issue.

## Configuration intent checklist

Use this checklist to make the intended setup clear before checking field details. The schema and `context-room doctor` validate JSON syntax.

Check intent:

- `allowedPaths` exposes only safe editable text. A `~/...` entry is an explicit external authorization, so keep it as narrow as a project-relative entry.
- Top-level `projectOnly` controls physical containment for ordinary project paths. Fresh setup writes `true`. Setting it to `false`, or omitting it in a legacy config, can make configured symlink targets outside the project readable and editable; retain that compatibility only for trusted, established hubs.
- `watchAllow` contains simple file watches and legacy/default recursive live folder watches.
- `watchRules` contains folder watches that need an explicit recursive/direct and live/current-files mode.
- `reviewPaths` is used only for files that must be reviewed even without a Git diff.
- `hubSections` separates current truth, target truth, and records when the project makes those distinctions.
- Fresh `startupContext`, `startupSkills`, and `startupHooks` settings expose project-local surfaces only unless the owner opts into broader scanning.
- Hook editing stays off unless the project owner explicitly wants Context Room to edit executable files.

If those boundaries are right, the exact JSON shape is a mechanical concern.

## Configuration fields

### Global appearance preferences

`fileTheme`, `showHiddenFiles`, and `autoOpenGitDiff` apply to every Context Room on the computer. The Settings screen writes them to `~/.context-room/preferences.json`; they do not belong in project configuration.

### `allowedPaths`

Safety boundary.

Context Room only reads and writes editable text files inside these files or folders. Project-relative entries stay inside the room's normal project boundary. An entry beginning with `~/` explicitly authorizes that home file or folder even though Git in the project does not own it. Keep both forms narrow and documentation-focused.

Set top-level `projectOnly: true` to require every ordinary allowed, watched, and hub path to remain physically inside the project root after symbolic links are resolved. Fresh setup writes this flag. Setting it to `false`, or omitting it in an existing configuration, preserves established symlink documentation hubs but can make their configured targets outside the project both readable and editable. Use that mode only for trusted, established hubs. This flag does not govern explicit `~/...` integrations.

The three nested startup scanner flags have a separate purpose: they control whether instruction, skill, and hook discovery stays inside the project or includes compatible ancestor/global sources.

Good examples:

```json
"allowedPaths": ["docs/", "skills/", "README.md", "AGENTS.md", "~/shared-project-docs/"]
```

Do not use `~/` as a broad filesystem browser. Avoid secrets, dependency folders, build outputs, generated files, private exports, and binary assets. External entries remain subject to the same supported-text and blocked-path checks as project entries.

### `watchAllow`

Review boundary.

Files here enter the review queue when they change. Folder entries use `recursive-live`: current and future eligible files at any depth enter the queue. Project files use Git status; files under an explicit `~/...` `allowedPaths` boundary use Context Room's local review baseline. This remains the compatible simple format for existing configurations.

Good examples:

```json
"watchAllow": ["docs/", "skills/", "AGENTS.md", "docs/decisions/"]
```

### `watchRules`

Explicit folder review boundary.

Use `watchRules` when a folder needs a mode other than the default recursive live behavior. Each rule stores an allowed folder path—normally project-relative, or an explicit `~/...` path already present in `allowedPaths`—and one of four modes:

Here, an eligible file is an allowed, supported text file that passes Context Room's secret, dependency, build-output, binary, and containment exclusions.

| Mode | Existing files | Future files | Subfolder files |
| --- | --- | --- | --- |
| `recursive-live` | Included | Included | Included at any depth |
| `recursive-current` | Included in a saved snapshot | Excluded | Included in the snapshot at any depth |
| `direct-current` | Included in a saved snapshot | Excluded | Excluded |
| `direct-live` | Included | Included | Excluded |

`recursive-live` is the default when the Explorer or agent CLI does not specify a mode. A live rule stays active after it is created. For example, `recursive-live` includes a file later created inside a new nested folder, while `direct-live` includes only future files whose immediate parent is the watched folder.

The two `current` modes persist the eligible file paths in `files` when the rule is created. They do not expand when later files or folders appear. Context Room reviews files, not empty directory objects: saying that a folder is watched means a live rule is retained so eligible files created under it can enter the queue.

```json
"watchRules": [
  {
    "path": "docs/",
    "mode": "recursive-current",
    "files": ["docs/index.md", "docs/guides/setup.md"]
  },
  {
    "path": "decisions/",
    "mode": "direct-live"
  }
]
```

Keep snapshot `files` inside their rule path. `recursive-current` may list descendants at any depth; `direct-current` lists only immediate file children. When rules overlap, the most specific matching path controls a file. An explicit structured rule wins a tie with a `watchAllow` folder entry at the same path.

The Explorer and agent CLI require an existing folder covered by `allowedPaths`; adding a watch rule never widens the edit boundary. They remove that same folder from `watchAllow` when they upsert a structured rule, leaving one owner for the scope. Use those surfaces to create snapshot rules so Context Room records the eligible files correctly. Removing an exact folder rule does not create an exclusion; a broader ancestor rule may still watch files below it.

External watched files are not assigned invented Git history. Their first appearance is a new-file first review. Accepting it records a local baseline; later edits and deletions are reviewed against that baseline. A live external rule also admits later eligible files according to its recursive or direct-child scope. The shared ledger still keys trust by canonical absolute path, so another room watching the same external file can reuse a matching verified content hash.

### `reviewPaths`

Required verification boundary.

Files and folders here appear in the review queue until the current content is marked verified, even when there is no Git diff. Their array order defines the human verification path; critical safety issues still appear first. Use this for onboarding a documentation set or requiring explicit review of agent-critical files. Only unchanged entries from `reviewPaths` show `Mark verified`; Git changes are reviewed through their inline diff.

Context Room automatically adds every project `AGENTS.md` to the editable and watched boundaries. By default they are also required-review paths. Set `"reviewAgentInstructions": false` only when a room deliberately reserves human review for a narrower set such as one documentation area; explicit `reviewPaths` still apply.

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

Fresh setup builds sections from discovered documentation rather than retaining generic cards for paths that do not exist. Explicit `_target`, `target`, `plans`, `proposals`, and `roadmap` paths go under Target documentation; a generic `draft` status alone does not prove target ownership and remains under Documentation to classify. Decisions, research, history, and incidents get their own records section. Entry points and indexes go under Start here unless their path makes them target or record material. Documentation explicitly marked `current` goes under Current documentation. Missing or invalid status metadata remains under Documentation to classify unless an explicit target or record path supplies its truth state; it is never presented as current truth. Project instructions plus safe skill documentation appear under Agent guidance. Empty sections are omitted.

### `startupContext`

Startup context scanner.

When enabled, Context Room lists matching instruction files. Fresh setup writes `projectOnly: true` and enables this scanner only when the project contains a matching local instruction file. In that mode, it does not traverse ancestor folders or load global instruction paths. Owners can set `projectOnly: false` and configure `globalPaths` when they intentionally want broader startup context.

Existing configs without `projectOnly` keep the previous ancestor-scanning behavior for compatibility.

Project-local instruction files can also appear in the normal explorer, where project `AGENTS.md` files are automatically editable and watched. Ancestor and global startup-context files stay outside the project explorer.

Startup context files outside the Context Room root are not Git-reviewable from the project. Context Room requires an initial review of each one and stores an untrusted observation baseline immediately at discovery. An edit made before the first human decision therefore appears as a real inline diff. Accepting or rejecting visible changes updates the local baseline for future reviews. Content that changed before the first observation still requires Git history, a backup, or another recovered snapshot.

### Generated agent context

Context Room writes its installed setup and HTML visual guidance to `.context-room/`. The stable entry point is `.context-room/README.md`; it routes an agent through project setup and links to the full visual usage contract, pattern reference, and catalogs in `.context-room/agent-context/`. `context-room init`, `setup`, and `start` refresh these generated files, so agents can use one project-local path without depending on the npm installation location. The generated files are local runtime material and excluded from Git.

The explorer shows safe hidden files, including this generated folder, by default. `Show hidden files` is a computer-wide Appearance preference; disabling it hides dotfiles and dotfolders without changing project configuration or deleting anything.

### `startupSkills`

Startup skill scanner.

When enabled, Context Room lists configured skill folders such as `.codex/skills` or `skills`. Fresh setup enables it only when one of those folders exists locally and writes `projectOnly: true`, preventing discovery in ancestor folders. Existing configs without `projectOnly` keep ancestor discovery for compatibility.

Startup skills can be opened in the explorer without making the whole project editable.

Every discovered skill entrypoint requires an initial review, including skills outside the repo. Context Room captures the first observed content immediately without treating it as verified. If it remains unchanged, the UI offers whole-document acceptance or a non-destructive request-changes decision; if it changes first, the UI shows the line-level diff against that observation baseline. Once verified, its content hash is trusted until the skill changes. If a repo skill already appears through the normal Git queue, Context Room keeps only that richer Git-backed item instead of showing a duplicate.

### `startupHooks`

Startup hook scanner.

When enabled, Context Room lists hook files that can affect agent work, commits, or validation. Fresh setup keeps hooks enabled with `projectOnly: true`: it scans project-local AI-agent and hook-manager paths plus the current repository's effective Git hooks, without walking unrelated ancestor projects. Existing configs without `projectOnly` retain their broader discovery behavior.

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
2. Start with `context-room setup`; edit the JSON directly only when the inferred project map needs deliberate curation.
3. Keep `allowedPaths` conservative: documentation, skills, runbooks, agent instructions, and safe text files.
4. Put the truly important docs in `watchAllow` or an explicit `watchRules` mode, not every file in the repo. Use `context-room agent watch` to create folder snapshots.
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
context-room start --root .
```

Without `--port`, Context Room selects a free port and prints the URL. Do not stop or reuse an unrelated room to obtain a preferred port.

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
Configure Context Room for this repository with `context-room setup --root .`.

Goal: make the documentation and agent skills easy to navigate, maintain, and verify.

1. Read the root README, every applicable project `AGENTS.md` or CLAUDE.md, and existing documentation indexes. Do not create, replace, or append agent instructions merely to configure Context Room.
2. Confirm that the discovered docs, skills, runbooks, decisions, and records are project-owned safe text surfaces.
3. Check that important docs are in `watchAllow` or an appropriate `watchRules` mode, not only `allowedPaths`. Use `context-room agent watch` for explicit folder modes so current-file snapshots are captured consistently.
4. Check that `hubSections` separates Start here, Current documentation, Target documentation, records, unclassified docs, and Agent guidance where those groups exist.
5. Preserve existing config values and leave `.context-room/review-gate.json` to the project owner.
6. Keep startup scanners project-only unless the owner explicitly requests ancestor or global context.
7. Run `context-room doctor --root .` and resolve high- or critical-severity setup issues.
8. Open the printed `/api/health` URL and confirm that `root` matches this repository.
9. Run `context-room guard` to inspect the watched-doc queue without blocking work.
10. Do not include secrets, `.env` files, private data, build outputs, dependencies, exports, or generated artifacts.
```
