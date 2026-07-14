---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: health guard and brief
  last_verified: 2026-07-14
  sources: [src/context_room.mjs, bin/context-room.mjs, src/doc_metadata.mjs, docs/agent-configuration.md]
---

# Health, Guard, And Brief

## Purpose

These commands turn project docs into local proof: health issues, review signals, and a deterministic read-first brief.

## Example Flow

1. Run `context-room doctor` after config or doc architecture changes.
2. Choose the owner review-gate operations in Settings, then install the matching local hooks.
3. Run `context-room brief --task "..."` before a focused agent task.

## Rules

- `doctor` reports health; strict mode fails on high-impact issues.
- The web UI can mark a triggered health issue `OK`; it hides from the panel until the issue changes, while `doctor` still reports it.
- `guard` and `review-only` report without blocking. Only explicit strict mode can fail.
- `guard --operation commit|push|pull-request|merge` follows the local owner policy. A selected operation fails when review is pending.
- Context Room manages local hooks for commit, push, and local merge commits without overwriting custom hooks. Pull requests and hosted merges require a provider check and repository rule.
- Review-gate operation policy is local owner state, separate from project config and unavailable to the agent CLI.
- `brief` ranks local docs only. It does not call an LLM.
- Metadata improves ranking and health checks, but existing Markdown still works.
- The web UI refreshes shared reports in the background and reuses one project scan.

## Source Map

- `buildDocumentationGraph` creates graph nodes, edges, and health issues.
- `buildContextRoomDoctorReport` packages health output.
- `buildContextRoomReports` and `background_worker.mjs` keep web reports off the HTTP critical path.
- The local health acknowledgements runtime file stores `OK` decisions.
- `buildDocQaReport` powers review state and guard decisions.
- `buildAgentBrief` ranks read-first docs.
- `parseDocMetadata` reads Markdown frontmatter.
