---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: shared context repositories
  last_verified: 2026-07-21
  sources: [src/shared_context.mjs, bin/context-room.mjs, src/context_room.mjs, schemas/shared-repository.schema.json, schemas/shared-projects.schema.json, schemas/config.schema.json]
---

# Shared Context

## Purpose

Shared Context adds an optional Git repository for documentation and skills that several projects, humans, or agents need to share. The normal Context Room workflow remains the default.

| Mode | Trusted content | How changes are made |
| --- | --- | --- |
| Project-local | Files in the current project | Edit an allowed file, then use the normal review queue |
| Shared | The merged commit on the shared repository's default branch | Create and publish a `proposal/*` branch, review its exact commit in a dedicated Context Room, publish the selected result as `accepted/*`, then merge its pull request |

The accepted shared snapshot is exposed to the connected project as read-only. An agent therefore cannot change accepted shared documentation or skills through the normal editor. Its writable surface is a proposal worktree created by the CLI.

## Repository Contract

Initialize any Git repository with the generic shared layout:

```bash
context-room shared init-repository --root /path/to/shared-context --name "Company Shared Context"
```

The default layout is:

```text
.context-room/shared-repository.json
projects.json
skills/
  global/
    <skill-name>/SKILL.md
projects/
  <project-id>/
    docs/
    skills/
      <skill-name>/SKILL.md
```

The generated repository manifest contains the paths and branch conventions used by the CLI:

```json
{
  "$schema": "https://raw.githubusercontent.com/Swarek/context-room/main/schemas/shared-repository.schema.json",
  "version": 1,
  "name": "Company Shared Context",
  "defaultBranch": "main",
  "proposalPrefix": "proposal/",
  "acceptancePrefix": "accepted/",
  "globalSkillsPath": "skills/global",
  "projectsPath": "projects",
  "projectsFile": "projects.json"
}
```

`projects.json` is the project-resolution authority. Each entry declares a stable project ID and may map it to one or more source-repository remotes plus a subpath:

```json
{
  "$schema": "https://raw.githubusercontent.com/Swarek/context-room/main/schemas/shared-projects.schema.json",
  "version": 1,
  "projects": [
    {
      "id": "my-project",
      "title": "My Project",
      "source": {
        "remotes": ["git@github.com:example/product-monorepo.git"],
        "subpath": "apps/my-project"
      }
    }
  ]
}
```

Commit and push both schemas' data plus every registered `projects/<project-id>/` directory. The paths and proposal and acceptance prefixes come from the manifest; the implementation is not tied to one organization or project name. Context Room normalizes SSH and HTTPS forms of the same Git remote and chooses the longest matching source subpath. Older version 1 manifests without `acceptancePrefix` use `accepted/`.

## Connect And Refresh A Project

From the project that consumes the shared context:

```bash
context-room shared setup \
  --root . \
  --repository git@github.com:example/company-shared-context.git
```

When the catalog has no source mapping, or the current directory is not in a Git checkout, add `--project my-project` explicitly.

For a monorepo rollout, `shared bind` records the same approved cwd mapping without initializing or modifying the source project's Context Room config. A later `shared setup` or normal context-dependent command can materialize it:

```bash
context-room shared bind --root apps/my-project --repository git@github.com:example/company-shared-context.git
```

Setup:

- records an explicitly approved repository, project ID, Git source remote, and source subpath in the user-local registry under `~/.context-room/shared/`; a committed project file cannot silently authorize a new remote;
- resolves the canonical project root even when setup starts from a nested cwd, and applies the same binding in another worktree of the same source repository;
- fetches the shared remote's accepted default branch;
- materializes its exact commit under `~/.context-room/shared/` and advances a local `current` link to that immutable snapshot;
- adds the shared docs and skills to `allowedPaths` and `readOnlyPaths` and creates a Shared context hub section; and
- refreshes global and project skill links.

When more than one registered project path could match a source checkout, Context Room uses the most specific matching source subpath.

Inspect or refresh the connection explicitly:

```bash
context-room shared status --root .
context-room shared sync --root .
```

Normal `setup`, `start`, `doctor`, `guard`, `brief`, and `agent` CLI invocations also attempt a shared refresh before doing their work. If the remote is unavailable and a previous snapshot exists, Context Room continues with that snapshot, reports `online: false`, and includes the fetch error and cached revision. Creating, publishing, reviewing, and preparing accepted branches still require the remote.

## Propose A Change

Create a project-scoped proposal from the latest accepted remote commit:

```bash
context-room shared propose \
  --root . \
  --title "Clarify onboarding" \
  --description "Clarify the owner-visible onboarding steps and their prerequisites."
```

The command prints a proposal branch and a writable worktree path. Make the documentation or skill changes inside that returned worktree, then publish the exact proposal:

```bash
context-room shared publish \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding \
  --message "Clarify onboarding"
```

The proposal name and description are stored in the proposal commit, not only in local CLI state. When the agent changes an already published proposal, it must publish again with a current description:

```bash
context-room shared publish \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding \
  --title "Clarify onboarding and prerequisites" \
  --description "Adds the missing prerequisite and updates the two owner-facing onboarding pages." \
  --message "Update onboarding proposal"
```

`--title` is optional during an update; `--description` is required. Context Room refuses an update without it, so the proposal inbox never silently keeps an older description after the branch changes.

Project proposals may change only `projects/<project-id>/docs/` and `projects/<project-id>/skills/`. A global proposal uses `--scope global`, receives a `proposal/global/...` branch by default, and may change only the configured global skills directory. The explicit branch scope must match the requested scope.

Context Room repeats that validation after fetching the remote branch, so bypassing the local publish command does not widen the review. Proposal files must be reviewable UTF-8 text supported by Context Room and no larger than 750 KB. Symlinks, gitlinks, binaries, and special files are rejected. The proposal commit records its current name and description, accepted-doc base, plus the source repository, branch, commit, and Codex task ID when those are available. `shared propose` reads `CODEX_THREAD_ID` automatically in Codex; `--session <task-id>` can attach an explicit identity in another agent runtime. This identity is metadata for finding a proposal, not an authorization token.

`--branch proposal/...` can provide an explicit unique branch name. Otherwise Context Room derives one from the project or global scope, timestamp, and title.

## Review And Partial Acceptance

List remote proposals, then open one in a dedicated review room:

```bash
context-room shared proposals --root .
context-room shared review \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding
```

The review command:

1. fetches the current accepted default branch;
2. records the exact proposal commit hash;
3. creates a detached review worktree from the accepted default branch;
4. applies the proposal as uncommitted changes; and
5. starts the normal Context Room review UI for those changes.

Every connected project room can act as the shared proposal cockpit. It lists proposals for every project in the shared repository, not only the project used to launch Context Room. **Browse all** opens a full-screen proposal inbox with project and text filters; the search covers title, description, changed paths, branch, author, commit hash, and linked Codex task ID. Each proposal row shows its name, latest description, changed-file count, and a short path preview. Selecting it opens a larger overview with the full current description, complete changed-file list, author, update time, branch, hash, and linked session before any review room is created.

Pressing **Open files to review** creates a dedicated exact-hash review server and worktree. The review is embedded below the proposal overview instead of replacing the cockpit URL. Several opened reviews remain mounted while the owner switches between them, so unsaved browser state is not discarded. Returning to the normal project context only hides the workspace. Reopening the same unchanged proposal reuses its exact review room; if the branch moves, Context Room presents the new hash as a separate review and the old review remains bound to the hash already examined. Local-only projects keep the existing UI without these controls.

Use the existing inline controls to accept or reject each change. Rejecting a change block rewrites the review worktree to remove that block; accepting it keeps the proposed result. This means the final worktree diff contains only the parts the human chose to accept.

After the review queue is empty, the human owner presses **Prepare pull request** in the review room. The agent-facing CLI deliberately has no acceptance or merge command.

Acceptance is bound to the recorded proposal hash. If the proposal branch moved after the room was created, acceptance expires and the new commit must be reviewed in a new room. The cockpit makes this visible by showing the old exact hash and offering the branch's new hash as a separate review.

An exact review authority is single-use after a successful acceptance. Reopen the proposal if another reviewed result is needed.

Before publishing, Context Room fetches the latest default branch and applies only the reviewed result onto that newer commit. Unrelated merged changes already on the default branch are preserved. If the selected result conflicts with the latest default branch, nothing is pushed and the resolved result must be reviewed again. If no selected change remains, no commit is created.

The result is committed and pushed to a unique `accepted/<scope>/...` branch. `main` remains unchanged. For GitHub remotes, Context Room opens the compare page so the human can create and merge the pull request. The pull request diff is the final visibility layer for changes that arrived on `main` while the proposal was under review.

## Shared Skills

A skill is shared when its directory contains `<skill-directory>/SKILL.md`.

- Global skills are linked into `~/.codex/skills/<skill-name>`.
- Project skills are linked into `<project>/.codex/skills/<skill-name>`.
- Both links target the exact accepted immutable snapshot, never a writable proposal checkout.
- Relative scripts and assets stay inside the skill directory; Git executable bits are preserved while all snapshot files remain non-writable.
- A project skill cannot shadow a global skill with the same name.
- Context Room refuses to replace an existing ordinary directory or a symbolic link that it does not manage.
- Refresh removes a managed link when its accepted skill is deleted or renamed, without touching unmanaged paths.

Skills therefore follow the same trust path as documentation: proposal, exact-commit human review, accepted branch, human pull-request merge, then refresh of the read-only snapshot.

## Permission Boundary

Context Room never pushes a shared review result to the default branch. Proposal publication writes `proposal/*`; partial acceptance writes `accepted/*`; only the Git host merges a pull request into `main`.

For a GitHub shared repository, an owner runs this once from the shared repository or a connected project:

```bash
context-room shared secure-github --root .
context-room shared security-check --root .
```

`secure-github` uses the authenticated GitHub CLI owner session to create or update an active repository ruleset for the configured default branch. It also creates a repository-specific writable deploy key under the user-local shared cache and configures the managed Git checkout to use only that key. The managed rule has no bypass actors, requires a pull request, blocks deletion and force-pushes, and requires review conversations to be resolved. It requires zero additional GitHub approvals because the owner already made the line-level decision in Context Room; merging the pull request remains a separate explicit human action.

`security-check` reads the live GitHub rule, exits non-zero unless every required protection is present, and records the last successful remote check for `shared status`. Re-run it after repository or permission changes. If the GitHub plan does not support rulesets for that private repository, setup fails instead of claiming protection.

The generated deploy key may push ordinary proposal and accepted branches, but GitHub rejects its direct push to `main`; it cannot administer repository rules or merge pull requests. Keep the GitHub owner browser/API credential and any GitHub connector with merge or administration permission outside the agent runtime: an agent that can operate either has crossed the owner boundary and cannot be constrained by Git branch policy alone.

## Source Map

- `src/shared_context.mjs`: repository format, connections, cache, snapshots, skill links, proposals, reviews, and acceptance.
- `bin/context-room.mjs`: shared CLI commands and automatic refresh before context-dependent commands.
- `schemas/shared-repository.schema.json`: shared repository manifest contract.
- `schemas/shared-projects.schema.json`: project catalog and cwd-resolution contract.
- `readOnlyPaths` in `schemas/config.schema.json`: displayable paths that the Context Room server must not create, edit, or delete.
- [Review queue](review-queue.md): inline accept and reject behavior reused by proposal review rooms.
- [Agent configuration](../agent-configuration.md): project config fields written by shared setup.
