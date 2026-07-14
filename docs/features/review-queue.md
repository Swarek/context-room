---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: review queue
  last_verified: 2026-07-14
  sources: [src/context_room.mjs, bin/context-room.mjs, docs/agent-configuration.md]
---

# Review Queue

## Purpose

The review queue shows watched documentation that needs verification before it becomes trusted context.

## Example Flow

1. Configure `watchAllow` and optional `reviewPaths`.
2. Open a queued file.
3. For a Git change, accept or reject every visible change; the completed diff records the review.
4. When several files were removed together, expand the deletion set, inspect or narrow the selected paths, then confirm their removal once.
5. For an unchanged `reviewPaths` file, read the current content and use `Mark verified`.

## Rules

- Review owns the final trust decision.
- Agents may surface the queue, but should never mark files verified for the user.
- The owner can select one or several blocking checkpoints: commit, push, pull request, or merge. Commit, push, and local merge use managed Git hooks; hosted checks require provider wiring.
- `watchAllow` follows changed tracked files and new untracked files.
- `reviewPaths` keeps important docs in the queue until the current content is verified.
- The `reviewPaths` array order defines the intended verification path. Critical safety issues remain first; unlisted changed files retain the default risk and documentation order.
- Reader-facing headings such as `Question: ...` are normal prose. Only explicit TODO markers, including `[QUESTION]` or `<!-- QUESTION -->`, create an unresolved-question issue.
- `Mark verified` appears only for unchanged `reviewPaths` files. Git changes must be completed through their inline diff.
- Mixed paragraph edits stay inline when changed words are at most 25% of the combined before and after text. Larger rewrites use separate paragraphs; simple additions or removals stay inline.
- Verified content is also recorded in the shared review ledger by canonical absolute path and content hash, so another Context Room watching the same file does not require a duplicate review.
- Updating only `context_room.last_verified` is not a review change: it stays out of the queue and inline diff, and syncs silently when the file is open.
- After the final inline decision, navigation waits until the review is saved.
- Pending review changes never block Hub, history, settings, reload, or another file. Partial decisions remain available when the file is reopened in the same session.
- Accepting or rejecting a change keeps the current reading position throughout the animation and final render.
- Review navigation is manual: use `Next review` to open another queued doc.
- High-confidence one-to-one renames stay a single `old path -> new path` review item. Unmatched deletions remain explicit.
- Two or more unmatched Git deletions are grouped into one expandable change set. New, modified, and rewritten replacement documents stay individually reviewable.
- Unmerged Git deletion conflicts stay individual and never enter the batch confirmation set.
- The deletion set loads pending paths on demand beyond the normal 80-item queue response, up to 5,000 at a time. After one very large set is confirmed, reopening loads the next pending set.
- `Confirm removals` never deletes files. It records that the selected paths are already absent and that their removal was intentional.
- Before saving a batch decision, the server checks that the loaded set key still matches, then rechecks that every selected path is still watched, Git-deleted, absent, and not recognized as a rename. A stale set must be reloaded; paths that change during the final write are skipped and remain visible for review.
- Required-review, canonical, agent-instruction, other high-authority, and uncertain-history deletions are marked `protected`, start unselected, and require a separate acknowledgement when included.
- Review trust records whether a resource was `present` or `absent` plus the last Git change for an absent path. When Context Room observes a restored path, it clears that deletion trust so a later deletion at the same path requires review again.
- Code and JSON should stay out of Markdown review unless the user explicitly wants them there.

## Source Map

- `buildDocQaReport` builds the queue.
- `buildDeletedReviewBatch` builds the current on-demand deletion page.
- `writeDeletedReviewBatchDecision` revalidates and records selected removals.
- `writeDocReviewDecision` records review decisions.
- `readGlobalReviewLedger` lets multiple Context Rooms trust the same absolute path and content hash.
- `readFileDiff`, `readReviewBaseFile`, and `startChangedFileInlineReview` power review diffs.
- `context-room guard` and `review-only` report pending review without blocking; only strict mode can fail.
