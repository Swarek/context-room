---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: file explorer and editor
  last_verified: 2026-07-09
  sources: [src/context_room.mjs, schemas/config.schema.json]
---

# File Explorer And Editor

## Purpose

The explorer and editor expose safe project text files in one compact workspace. They are not a full filesystem browser.

## Example Flow

1. Pick a hub card or browse the explorer.
2. Open an allowed text file.
3. Read rendered Markdown, preview HTML, or edit an allowed text file.
4. Save editable files with the UI or keyboard shortcut.

## Common Actions

- Browse, search, expand folders, or filter by all, watched, and not watched files.
- Browse safe hidden files and `.context-room` by default; use the global Appearance setting to hide dotfiles and dotfolders.
- Use the workspace toolbar to return to the hub, navigate history, and act on the current file.
- Collapsing the explorer expands the document without hiding the workspace toolbar; the desktop reopen control stays centered in the collapsed rail.
- Opening a file never reopens a collapsed explorer; use the explorer control when the file tree is needed.
- Open project text files; files outside `allowedPaths` stay read-only.
- Edit and save allowed files. HTML visual documents render directly; their source is changed by an agent and reviewed in the queue.
- Create Markdown files and folders from the explorer.
- Select files or folders for bulk actions.
- Add selected paths to `watchAllow` or remove them from `watchAllow`.
- Delete selected files or folders after confirmation.
- Inspect Git diffs, hide them, or revert the current file diff.
- Keep navigating when Git diffs, pending reviews, or disk changes exist; resolve a disk conflict only before overwriting it.

## Rules

- `allowedPaths` is the edit boundary.
- `watchAllow` is the review boundary.
- Secret-looking paths, dependency folders, build outputs, and binary files stay out.
- `.git`, dependencies, caches, and build outputs stay excluded even when hidden files are shown. Sensitive environment files remain read-only and expose names only, never values.
- External startup files are shown only through explicit startup surfaces.
- Pending changes never block navigation. A concurrent disk edit blocks only the save that would overwrite it silently.
- File data, annotations, Git diff state, and review data load concurrently.
- File text appears as soon as it is read; slow Git diff or review work never holds the document behind a loading screen.
- Intentional hover or keyboard focus preloads file content and Git diff; repeated opens reuse the result until the file changes.
- The workspace toolbar and file actions replace one stable loading state together instead of appearing in stages.
- Markdown keeps its rich line rendering and shows discreet source line numbers in a narrow gutter; wrapped text keeps one number for its source line. Code, JSON, and large files use a lightweight text surface to keep opening fast.
- HTML opens as a sandboxed visual preview. Scripts, navigation, forms, and external resources cannot run from the preview.
- HTML previews inherit the active Context Room theme and its built-in visual components.
- Watched HTML changes use the same review queue and source diff as other watched files.
- Search rendering is frame-scheduled so typing stays responsive in large explorers.

## Source Map

- `isAllowedMemoryPath` enforces the edit boundary.
- `listMemoryFiles` and `listExplorerFiles` build file lists.
- `readMemoryFile` and `writeMemoryFile` handle normal file IO.
- `renderExplorerContextMenu`, `createMarkdownFile`, and `createFolder` handle explorer creation.
- `addSelectedToWatch`, `removeSelectedFromWatch`, and `deletePaths` handle bulk actions.
- `renderViewer` renders preview, editor, diffs, conflicts, and annotations.
- `contextRoomVisualDocumentStyles` supplies themed HTML components without adding CSS to each document.
- `background_worker.mjs` keeps Git diff work off the HTTP and UI critical path.
