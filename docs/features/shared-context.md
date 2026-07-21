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
| Shared | The accepted commit on the shared repository's default branch | Create and publish a `proposal/*` branch, review its exact commit in a dedicated Context Room, then accept all or part of it |

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

Commit and push both schemas' data plus every registered `projects/<project-id>/` directory. The paths and proposal prefix come from the manifest; the implementation is not tied to one organization or project name. Context Room normalizes SSH and HTTPS forms of the same Git remote and chooses the longest matching source subpath.

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

Normal `setup`, `start`, `doctor`, `guard`, `brief`, and `agent` CLI invocations also attempt a shared refresh before doing their work. If the remote is unavailable and a previous snapshot exists, Context Room continues with that snapshot, reports `online: false`, and includes the fetch error and cached revision. Creating, publishing, reviewing, and accepting proposals still require the remote.

## Propose A Change

Create a project-scoped proposal from the latest accepted remote commit:

```bash
context-room shared propose --root . --title "Clarify onboarding"
```

The command prints a proposal branch and a writable worktree path. Make the documentation or skill changes inside that returned worktree, then publish the exact proposal:

```bash
context-room shared publish \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding \
  --message "Clarify onboarding"
```

Project proposals may change only `projects/<project-id>/docs/` and `projects/<project-id>/skills/`. A global proposal uses `--scope global`, receives a `proposal/global/...` branch by default, and may change only the configured global skills directory. The explicit branch scope must match the requested scope.

Context Room repeats that validation after fetching the remote branch, so bypassing the local publish command does not widen the review. Proposal files must be reviewable UTF-8 text supported by Context Room and no larger than 750 KB. Symlinks, gitlinks, binaries, and special files are rejected. The proposal commit records its accepted-doc base plus the source repository, branch, and commit when those are available.

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

The normal project room also shows a proposal selector in its top toolbar. Selecting a proposal and pressing **Review** performs the same exact-hash materialization and opens the dedicated room. Local-only projects simply keep the existing UI without these controls.

Use the existing inline controls to accept or reject each change. Rejecting a change block rewrites the review worktree to remove that block; accepting it keeps the proposed result. This means the final worktree diff contains only the parts the human chose to accept.

After the review queue is empty, the human owner presses **Accept into main** in the review room. The agent-facing CLI deliberately has no acceptance command.

Acceptance is bound to the recorded proposal hash. If the proposal branch moved after the room was created, acceptance expires and the new commit must be reviewed in a new room.

An exact review authority is single-use after a successful acceptance. Reopen the proposal if another reviewed result is needed.

Before writing, Context Room fetches the latest accepted default branch and applies only the reviewed result onto that newer commit. Unrelated accepted changes already on the default branch are preserved. If the selected result conflicts with the latest default branch, nothing is pushed and the resolved result must be reviewed again. If no accepted change remains, no commit is created.

## Shared Skills

A skill is shared when its directory contains `<skill-directory>/SKILL.md`.

- Global skills are linked into `~/.codex/skills/<skill-name>`.
- Project skills are linked into `<project>/.codex/skills/<skill-name>`.
- Both links target the exact accepted immutable snapshot, never a writable proposal checkout.
- Relative scripts and assets stay inside the skill directory; Git executable bits are preserved while all snapshot files remain non-writable.
- A project skill cannot shadow a global skill with the same name.
- Context Room refuses to replace an existing ordinary directory or a symbolic link that it does not manage.
- Refresh removes a managed link when its accepted skill is deleted or renamed, without touching unmanaged paths.

Skills therefore follow the same trust path as documentation: proposal, exact-commit human review, acceptance into the default branch, then refresh of the read-only snapshot.

## Permission Boundary

The CLI enforces proposal path scopes and keeps accepted snapshots read-only, but these are workflow protections, not a sandbox for a process with unrestricted filesystem access. It also cannot distinguish a human from an agent when both processes use the same Git credential. Local rules alone do not prevent that credential from pushing directly to the default branch.

For an actual owner-only default branch:

- protect the shared repository's default branch on the Git host;
- give the agent a distinct credential that can push proposal branches but cannot push the default branch; and
- let only a human owner credential, or an owner-controlled acceptance service, run the final default-branch push.

The owner button asks the local Context Room server to push directly to the configured default branch. The identity running that server must be allowed to do so. A host rule that requires every default-branch update to arrive through a pull request will reject this operation unless an owner-controlled acceptance service adapts the final step. `shared status` reports that provider-side protection is not locally verifiable.

## Source Map

- `src/shared_context.mjs`: repository format, connections, cache, snapshots, skill links, proposals, reviews, and acceptance.
- `bin/context-room.mjs`: shared CLI commands and automatic refresh before context-dependent commands.
- `schemas/shared-repository.schema.json`: shared repository manifest contract.
- `schemas/shared-projects.schema.json`: project catalog and cwd-resolution contract.
- `readOnlyPaths` in `schemas/config.schema.json`: displayable paths that the Context Room server must not create, edit, or delete.
- [Review queue](review-queue.md): inline accept and reject behavior reused by proposal review rooms.
- [Agent configuration](../agent-configuration.md): project config fields written by shared setup.
