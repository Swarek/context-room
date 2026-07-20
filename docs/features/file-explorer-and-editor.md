---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: file explorer and editor
  last_verified: 2026-07-20
  sources: [src/context_room.mjs, src/codex_composer_bridge.mjs, schemas/config.schema.json]
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
- Select Markdown text with normal editor gestures: drag, Shift-click, double-click a word, or triple-click a line. Native Delete, Backspace, cut, copy, paste, undo, redo, and keyboard selection operate on that selection.
- Select text in the source editor, then use the floating **@ Codex** action above the selection or its configurable shortcut. Context Room adds a native, clickable file mention and the source line range to the active Codex composer without sending it or replacing the existing draft. Clean saved files omit the selected passage because Codex can read it from disk. An unsaved selection includes the selected bytes and labels them `unsaved`. If the local bridge is unavailable, Context Room copies the same compact reference instead.
- Create Markdown files and folders from the explorer.
- Select files or folders for bulk actions.
- Watch one file exactly, or choose a folder watch mode for one or more selected folders.
- Remove exact selected file watches or folder rules without changing the files themselves; an ancestor rule may still apply.
- Delete selected files or folders after confirmation.
- Inspect Git diffs, hide them, or revert the current file diff.
- Keep navigating when Git diffs, pending reviews, or disk changes exist; resolve a disk conflict only before overwriting it.

## Rules

- `allowedPaths` is the edit boundary.
- `watchAllow` and `watchRules` form the review boundary.
- Secret-looking paths, dependency folders, build outputs, and binary files stay out.
- `.git`, dependencies, caches, and build outputs stay excluded even when hidden files are shown. Sensitive environment files remain read-only and expose names only, never values.
- External startup files are shown through explicit startup surfaces. Other external files appear only when their `~/...` file or folder is explicitly present in `allowedPaths`.
- Pending changes never block navigation. A disk edit becomes a conflict only when the current editor buffer differs from the last successful save; otherwise it enters normal external review.
- A Codex reference uses the live editor buffer and labels unsaved content. Diff-review selections are excluded because deleted and replacement lines do not map unambiguously to the current file.
- Direct composer insertion requires Codex to run with a loopback-only renderer bridge. Context Room resolves the selected file inside its allowed path boundary, chooses only an exact native Codex file-mention match, and never submits the composer.
- File data, annotations, Git diff state, and review data load concurrently.
- File text appears as soon as it is read; slow Git diff or review work never holds the document behind a loading screen.
- Intentional hover or keyboard focus preloads file content and Git diff; repeated opens reuse the result until the file changes.
- The workspace toolbar and file actions replace one stable loading state together instead of appearing in stages.
- Markdown keeps its rich line rendering and shows discreet source line numbers in a narrow gutter; wrapped text keeps one number for its source line. Code, JSON, and large files use a lightweight text surface to keep opening fast.
- The Markdown overlay is visual only. The real text field owns pointer selection, clipboard commands, keyboard editing, undo history, and scrolling; the overlay mirrors its caret, selection, and viewport.
- HTML opens as a sandboxed visual preview. Scripts, navigation, forms, and external resources cannot run from the preview.
- HTML previews inherit the active Context Room theme and its built-in visual components.
- Watched HTML changes use the same review queue and source diff as other watched files.
- Search rendering is frame-scheduled so typing stays responsive in large explorers.

## Folder Watch Options

Watching a folder from its context menu or a bulk selection presents four choices:

| Explorer option | Config mode | Result |
| --- | --- | --- |
| Folder and all subfolders — current and future files | `recursive-live` | Watches eligible files now and later at any depth. This is the default. |
| Existing files in folder and subfolders | `recursive-current` | Takes a snapshot of eligible files at any depth. Later files and folders do not join it. |
| Existing files in this folder only | `direct-current` | Takes a snapshot of eligible immediate file children. Subfolder contents and future files stay out. |
| This folder only — current and future files | `direct-live` | Watches eligible immediate file children now and later. Subfolder contents stay out. |

Watching one file remains an exact one-click watch. Allowed folders remain visible in the Explorer even when they are empty, so a live rule can be applied before the first file exists. Folder rules govern files; Git and the review queue do not review empty directories. The recursive live option retains the folder rule, so a file created later inside a new deeply nested folder enters review as a new file.

The same four options apply to an external `~/...` folder only after that folder is explicitly listed in `allowedPaths`. External watches never expand the edit boundary. Because project Git cannot describe those changes, Context Room labels a first-seen external file as new, records the accepted content in its local review baseline, and compares later edits or deletion against that baseline.

For the persisted JSON contract, overlap rules, and snapshot shape, see [Agent configuration](../agent-configuration.md#watchrules).

## Source Map

- `isAllowedMemoryPath` enforces the edit boundary.
- `listMemoryFiles`, `listExplorerFiles`, and `listExplorerDirectories` build the Explorer's file and folder nodes.
- `readMemoryFile` and `writeMemoryFile` handle normal file IO.
- `renderExplorerContextMenu`, `createMarkdownFile`, and `createFolder` handle explorer creation.
- `applyExplorerFolderWatchMode`, `showFolderWatchModeDialog`, `addSelectedToWatch`, and `removeSelectedFromWatch` apply the same four folder modes to context-menu and bulk actions.
- `deletePaths` handles bulk deletion separately from watch configuration.
- `renderViewer` renders preview, editor, diffs, conflicts, and annotations.
- `referenceCodexSelectionInCurrentTask` posts the selected path and line range to `/api/codex/reference`. `insertFileReferenceIntoActiveCodexComposer` creates the native file mention through the active loopback Codex renderer bridge; compact clipboard copy is the safe fallback when that bridge is unavailable.
- The renderer event and launcher pattern are compatible with the unofficial [Codex Deck bridge](https://github.com/dazer1234/codex-stream-deck). This is an internal Codex compatibility boundary and may require an update after a Codex release.
- `contextRoomVisualDocumentStyles` supplies themed HTML components without adding CSS to each document.
- `background_worker.mjs` keeps Git diff work off the HTTP and UI critical path.
