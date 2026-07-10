---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: review queue
  last_verified: 2026-07-08
  sources: [src/context_room.mjs, bin/context-room.mjs, docs/agent-configuration.md]
---

# Review Queue

## Purpose

The review queue shows watched documentation that needs verification before it becomes trusted context.

## Example Flow

1. Configure `watchAllow` and optional `reviewPaths`.
2. Open a queued file.
3. For a Git change, accept or reject every visible change; the completed diff records the review.
4. For an unchanged `reviewPaths` file, read the current content and use `Mark verified`.

## Rules

- Review owns the final trust decision.
- Agents may surface the queue, but should never mark files verified for the user.
- `watchAllow` follows changed tracked files and new untracked files.
- `reviewPaths` keeps important docs in the queue until the current content is verified.
- `Mark verified` appears only for unchanged `reviewPaths` files. Git changes must be completed through their inline diff.
- Similar paragraphs appear once: proposed additions are green, and proposed removals are red and struck through.
- Verified content is also recorded in the shared review ledger by canonical absolute path and content hash, so another Context Room watching the same file does not require a duplicate review.
- Updating only `context_room.last_verified` is not a review change: it stays out of the queue and inline diff, and syncs silently when the file is open.
- After the final inline decision, navigation waits until the review is saved.
- Accepting or rejecting a change keeps the current reading position throughout the animation and final render.
- Review navigation is manual: use `Next review` to open another queued doc.
- Code and JSON should stay out of Markdown review unless the user explicitly wants them there.

## Source Map

- `buildDocQaReport` builds the queue.
- `writeDocReviewDecision` records review decisions.
- `readGlobalReviewLedger` lets multiple Context Rooms trust the same absolute path and content hash.
- `readFileDiff`, `readReviewBaseFile`, and `startChangedFileInlineReview` power review diffs.
- `context-room guard` blocks commits when review is pending.
