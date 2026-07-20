import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_COMPOSER_INSERT_EVENT,
  MAX_CODEX_COMPOSER_TEXT_BYTES,
  buildCompactCodexReferenceText,
  buildCodexComposerInsertionExpression,
  codexMentionCandidateScore,
  codexNativeMentionPath,
  codexReferenceLineLabel,
  codexRendererTargetPriority,
  selectCodexMentionCandidateIndex,
  selectCodexRendererTargets,
} from "../src/codex_composer_bridge.mjs";

test("Codex renderer targets prefer the main visible application document", () => {
  const targets = [
    { type: "page", url: "app://codex/index.html?initialRoute=settings", webSocketDebuggerUrl: "ws://settings" },
    { type: "page", url: "app://codex/avatar-overlay.html", webSocketDebuggerUrl: "ws://overlay" },
    { type: "page", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://main" },
    { type: "worker", url: "app://codex/index.html", webSocketDebuggerUrl: "ws://worker" },
  ];

  assert.equal(codexRendererTargetPriority(targets[2]), 4);
  assert.equal(codexRendererTargetPriority(targets[1]), 0);
  assert.equal(codexRendererTargetPriority(targets[3]), -1);
  assert.deepEqual(selectCodexRendererTargets(targets).map((target) => target.webSocketDebuggerUrl), ["ws://main", "ws://settings"]);
});

test("Codex composer expression inserts escaped text without starting a turn", () => {
  const text = "Reference\n\nFile: `docs/guide.md`\n\nRequest: \"explain\"";
  const expression = buildCodexComposerInsertionExpression(text);

  assert.match(expression, new RegExp(CODEX_COMPOSER_INSERT_EVENT));
  assert.match(expression, /dispatchHostMessage\(\{ type:/);
  assert.match(expression, /composer-handler-unavailable/);
  assert.match(expression, /data-codex-composer/);
  assert.match(expression, /dispatchHostMessage\(\{ type:[^}]+text \}\)/);
  assert.doesNotMatch(expression, /text \+ existingDraft|existingDraft \+ text/);
  assert.match(expression, /preservedDraft/);
  assert.match(expression, /activeThreadKey/);
  assert.doesNotMatch(expression, /turn\/start|thread\/start|codex:\/\/threads\/new/);
  assert.ok(expression.includes(JSON.stringify(text)));
  assert.throws(() => buildCodexComposerInsertionExpression(" "), /required/);
  assert.throws(() => buildCodexComposerInsertionExpression("x".repeat(MAX_CODEX_COMPOSER_TEXT_BYTES + 1)), /too large/);
});

test("compact Codex references use native line labels and include unsaved bytes only when required", () => {
  assert.equal(codexReferenceLineLabel(14, 14), "L14");
  assert.equal(codexReferenceLineLabel(14, 16), "L14–16");
  assert.equal(codexNativeMentionPath("/Users/mathis/project/hicharlie.fr/docs/guide.md", "docs/guide.md"), "hicharlie.fr/docs/guide.md");
  assert.equal(codexNativeMentionPath("/Users/mathis/.codex/AGENTS.md", "~/.codex/AGENTS.md"), "~/.codex/AGENTS.md");
  assert.equal(buildCompactCodexReferenceText({ displayPath: "docs/guide.md", startLine: 14, endLine: 16 }), "@docs/guide.md L14–16 ");
  assert.equal(buildCompactCodexReferenceText({ displayPath: "docs/guide.md", startLine: 14, endLine: 16, nativeMention: true }), "L14–16 ");
  assert.equal(
    buildCompactCodexReferenceText({ displayPath: "docs/guide.md", startLine: 14, endLine: 16, selectedText: "changed\ntext", dirty: true }),
    "@docs/guide.md L14–16 · unsaved\n> changed\n> text\n",
  );
});

test("Codex mention candidate selection prefers the exact main checkout path", () => {
  const reference = {
    displayPath: "qa-reports/JOURNAL-ARCHIVE.md",
    absolutePath: "/Users/mathis/project/hicharlie.fr/qa-reports/JOURNAL-ARCHIVE.md",
  };
  const candidates = [
    { label: "JOURNAL-ARCHIVE.md", detail: ".claude/worktrees/visual/hicharlie.fr/qa-reports" },
    { label: "JOURNAL-ARCHIVE.md", detail: "hicharlie.fr/qa-reports" },
  ];

  assert.ok(codexMentionCandidateScore(candidates[1], reference) > codexMentionCandidateScore(candidates[0], reference));
  assert.equal(selectCodexMentionCandidateIndex(candidates, reference), 1);
  assert.equal(selectCodexMentionCandidateIndex([{ label: "other.md", detail: "hicharlie.fr/qa-reports" }], reference), -1);
});
