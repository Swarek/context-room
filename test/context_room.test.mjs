#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_MARKDOWN_TEMPLATES,
  applyMarkdownTemplateToFile,
  buildAgentBrief,
  buildContextRoomDoctorReport,
  buildDocQaReport,
  buildDocumentationGraph,
  createFolder,
  createMarkdownFile,
  createDefaultProjectConfig,
  deleteMemoryPaths,
  hubSectionsForRoot,
  initializeContextRoomProject,
  isAllowedMemoryPath,
  listMemoryFiles,
  listStartupContextFiles,
  parseDocMetadata,
  readFileDiff,
  readMemoryWebappSettings,
  readStartupContextFile,
  renderAppHtml,
  renderExplorerContextMenuMarkup,
  renderTemplateOptionsMarkup,
  revertMemoryFile,
  writeDocReviewDecision,
} from "../src/context_room.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "context-room-"));
}

function extractInlineAppScript(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "expected Context Room HTML to contain an inline app script");
  return match[1];
}

test("rendered app inline script parses before the browser boots it", () => {
  const root = makeRoot();
  const script = extractInlineAppScript(renderAppHtml());
  const scriptPath = path.join(root, "context-room-inline.js");

  fs.writeFileSync(scriptPath, script);

  execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" });
  assert.match(script, /function setMode\(mode = "view"\)/);
  assert.doesNotMatch(script, /function setMode\(\)\s*\{\s*state\.mode = "edit"/);
});

test("default config is project-agnostic and supports cards, nested cards, allowed paths, and watched paths", () => {
  const config = createDefaultProjectConfig({ title: "Demo Project" });

  assert.equal(CONFIG_DIR, ".context-room");
  assert.equal(CONFIG_FILE, ".context-room/config.json");
  assert.equal(config.title, "Demo Project");
  assert.match(config.$schema, /schemas\/config\.schema\.json$/);
  assert.deepEqual(config.watchAllow, []);
  assert.ok(config.allowedPaths.includes("docs/"));
  assert.ok(config.allowedPaths.includes("src/"));
  assert.ok(config.hubSections[0].cards.some((card) => card.id === "docs"));
  assert.ok(config.hubSections[0].cards.some((card) => (card.cards || []).length > 0));
});

test("init writes a reusable project config without LifeOS-specific paths", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");

  const result = initializeContextRoomProject(root, { title: "Demo", preset: "generic" });
  const configPath = path.join(root, CONFIG_FILE);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.equal(saved.title, "Demo");
  assert.match(saved.$schema, /schemas\/config\.schema\.json$/);
  assert.ok(saved.allowedPaths.includes("docs/"));
  assert.ok(saved.allowedPaths.includes("src/"));
  assert.equal(JSON.stringify(saved).includes("Life OS"), false);
  assert.equal(JSON.stringify(saved).includes(".lifeos"), false);
});

test("allowed paths are driven by project config", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/", "README.md"], watchAllow: ["docs/"] });
  const settings = readMemoryWebappSettings(root);

  assert.equal(isAllowedMemoryPath("docs/guide.md", settings), true);
  assert.equal(isAllowedMemoryPath("README.md", settings), true);
  assert.equal(isAllowedMemoryPath("src/private.js", settings), false);
  assert.equal(isAllowedMemoryPath("../secret.md", settings), false);
});

test("file listing follows project config and does not inject Hermes/LifeOS files by default", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "src/app.js"), "console.log('private');\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const paths = listMemoryFiles(root).map((file) => file.path);

  assert.deepEqual(paths, ["docs/guide.md"]);
  assert.equal(paths.some((item) => item.includes("~/.hermes")), false);
  assert.equal(paths.some((item) => item.includes(".lifeos")), false);
});

test("startup context scanner lists configured agent files from ancestors to root", () => {
  const base = makeRoot();
  const parent = path.join(base, "parent");
  const root = path.join(parent, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(base, "AGENTS.md"), "# Global Agents\n");
  fs.writeFileSync(path.join(parent, "CLAUDE.md"), "# Parent Claude\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project Agents\n");
  initializeContextRoomProject(root, {
    allowedPaths: ["docs/"],
    watchAllow: [],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupContext = { enabled: true, fileNames: ["AGENTS.md", "CLAUDE.md"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const files = listStartupContextFiles(root);
  const memoryFiles = listMemoryFiles(root);
  const opened = readStartupContextFile(root, 2);

  assert.deepEqual(files.map((file) => file.startupContext.fileName), ["AGENTS.md", "CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(files.map((file) => file.startupContext.order), [1, 2, 3]);
  assert.equal(files[0].category, "0 · startup context");
  assert.match(files[0].startupContext.displayPath, /AGENTS\.md$/);
  assert.equal(memoryFiles.some((file) => file.startupContext), false);
  assert.equal(opened.content, "# Parent Claude\n");
  assert.equal(opened.startupContext.fileName, "CLAUDE.md");
});

test("startup context virtual files stay out of the explorer tree", () => {
  const html = renderAppHtml();

  assert.match(html, /api\("\/api\/startup-context"\)/);
  assert.match(html, /data-startup-order/);
  assert.doesNotMatch(html, /data-startup-file/);
  assert.doesNotMatch(html, /@startup-context/);
  assert.doesNotMatch(html, /\$startup-context/);
});

test("CLI init and doctor work in a fresh project", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");

  const cli = path.resolve("bin/context-room.mjs");
  execFileSync(process.execPath, [cli, "init", "--title", "CLI Demo", "--watch", "docs/"], { cwd: root, stdio: "pipe" });
  const doctor = execFileSync(process.execPath, [cli, "doctor"], { cwd: root, encoding: "utf8" });
  const saved = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));

  assert.equal(saved.title, "CLI Demo");
  assert.deepEqual(saved.watchAllow, ["docs/"]);
  assert.match(doctor, /Context Room OK/);
});

test("CLI guard blocks commits when watched docs changed without review", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nAgent change.\n");

  const cli = path.resolve("bin/context-room.mjs");
  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Unverified watched documentation changes/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  writeDocReviewDecision(root, "README.md", { status: "verified", note: "test baseline" });
  const output = execFileSync(process.execPath, [cli, "guard"], { cwd: root, encoding: "utf8" });
  assert.match(output, /No unverified watched documentation changes/);
});

test("doc QA detects watched changes when context root is a git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "hicharlie.fr");
  fs.mkdirSync(root);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md"], watchAllow: ["AGENTS.md"] });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n\nUpdated routing.\n");

  const report = buildDocQaReport(root);

  assert.equal(report.summary.changedDocs, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(report.queue[0].path, "AGENTS.md");
  assert.equal(report.queue[0].gitStatus.trim(), "M");
});

test("doc QA review queue follows a human docs verification order", () => {
  const root = makeRoot();
  const files = [
    ["AGENTS.md", "agents", "root-agent-routing"],
    ["docs/INDEX.md", "index", "global-docs-navigation"],
    ["docs/PRODUCT.md", "canonical", "global-product"],
    ["website/docs/INDEX.md", "index", "website-docs-navigation"],
    ["website/docs/PRODUCT.md", "canonical", "website-product"],
    ["our_agentic_system/AGENTS.md", "agents", "runtime-agent-routing"],
    ["our_agentic_system/docs/INDEX.md", "index", "runtime-docs-navigation"],
    ["our_agentic_system/docs/PRODUCT.md", "canonical", "runtime-product"],
    [".codex/skills/README.md", "index", "project-skill-routing"],
  ];
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  for (const [relPath, kind, canonicalFor] of files) {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), `---
context_room:
  kind: ${kind}
  scope: test
  status: current
  canonical_for: ${canonicalFor}
  last_verified: 2026-06-30
  sources: []
---

# ${relPath}
`);
  }
  initializeContextRoomProject(root, {
    allowedPaths: ["AGENTS.md", "docs/", "website/docs/", "our_agentic_system/AGENTS.md", "our_agentic_system/docs/", ".codex/skills/"],
    watchAllow: ["AGENTS.md", "docs/", "website/docs/", "our_agentic_system/AGENTS.md", "our_agentic_system/docs/", ".codex/skills/"],
  });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  for (const [relPath] of files) fs.appendFileSync(path.join(root, relPath), "\nUpdated.\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), files.map(([relPath]) => relPath));
});

test("revertMemoryFile restores tracked changes in a git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "hicharlie.fr");
  fs.mkdirSync(root);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md"], watchAllow: ["AGENTS.md"] });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n\nUpdated routing.\n");

  const result = revertMemoryFile(root, "AGENTS.md");

  assert.equal(result.reverted, true);
  assert.equal(result.deleted, false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# AGENTS\n");
  assert.equal(buildDocQaReport(root).summary.needsReview, 0);
});

test("revertMemoryFile removes untracked new files", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "README.md", CONFIG_FILE], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New\n");

  const result = revertMemoryFile(root, "docs/new.md");

  assert.equal(result.reverted, true);
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(path.join(root, "docs/new.md")), false);
});

test("file diff renders new untracked watched docs as a Git new-file patch", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New doc\n\nAgent-written docs.\n");

  const diff = readFileDiff(root, "docs/new.md");

  assert.equal(diff.available, true);
  assert.equal(diff.changed, true);
  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 0);
  assert.match(diff.patch, /new file mode/);
  assert.match(diff.patch, /\+Agent-written docs\./);
});

test("default config exposes scoped-context best practices and simple markdown templates", () => {
  const config = createDefaultProjectConfig({ title: "Docs Demo" });

  assert.ok(config.allowedPaths.includes("context/"));
  assert.ok(config.hubSections[0].cards.some((card) => card.id === "context"));
  assert.ok(Array.isArray(config.markdownTemplates));
  assert.ok(config.markdownTemplates.some((template) => template.id === "context-golden"));

  const golden = DEFAULT_MARKDOWN_TEMPLATES.find((template) => template.id === "context-golden");
  assert.ok(golden);
  assert.match(golden.content, /context_room:/);
  assert.match(golden.content, /kind: canonical/);
  assert.match(golden.content, /# \{\{title\}\}/);
  assert.match(golden.content, /## Purpose/);
  assert.match(golden.content, /## Key facts/);
  assert.match(golden.content, /## References/);
  assert.ok(golden.content.length < 1100, "golden template should stay simple enough to read quickly");
});

test("createMarkdownFile writes a new empty allowed markdown file", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["context/"] });
  fs.mkdirSync(path.join(root, "context"));

  const result = createMarkdownFile(root, { path: "context/architecture.md", title: "Architecture", templateId: "context-golden" });

  const content = fs.readFileSync(path.join(root, "context/architecture.md"), "utf8");
  assert.equal(result.path, "context/architecture.md");
  assert.equal(result.existed, false);
  assert.equal(content, "");
});

test("createMarkdownFile can write a structured doc from metadata-aware templates", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  fs.mkdirSync(path.join(root, "docs"));

  const result = createMarkdownFile(root, {
    path: "docs/billing.md",
    title: "Billing",
    templateId: "context-golden",
    applyTemplate: true,
    metadata: {
      kind: "canonical",
      scope: "website",
      status: "current",
      canonical_for: "billing",
      last_verified: "2026-06-26",
      sources: ["src/billing.ts", "docs/pricing.md"],
    },
  });

  const content = fs.readFileSync(path.join(root, "docs/billing.md"), "utf8");
  const metadata = parseDocMetadata(content, result.path);

  assert.equal(result.path, "docs/billing.md");
  assert.equal(metadata.present, true);
  assert.equal(metadata.kind, "canonical");
  assert.equal(metadata.scope, "website");
  assert.equal(metadata.canonical_for, "billing");
  assert.deepEqual(metadata.sources, ["src/billing.ts", "docs/pricing.md"]);
  assert.match(content, /# Billing/);
});

test("createMarkdownFile refuses non-markdown paths and existing files", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["context/"] });
  fs.mkdirSync(path.join(root, "context"));
  fs.writeFileSync(path.join(root, "context/current.md"), "# Current\n");

  assert.throws(
    () => createMarkdownFile(root, { path: "context/current.md", title: "Current", templateId: "context-golden" }),
    /already exists/,
  );
  assert.throws(
    () => createMarkdownFile(root, { path: "context/data.json", title: "Data", templateId: "context-golden" }),
    /Markdown/,
  );
});

test("createFolder writes a new allowed folder and refuses invalid targets", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const result = createFolder(root, { path: "docs/new-section" });

  assert.equal(result.path, "docs/new-section/");
  assert.equal(fs.statSync(path.join(root, "docs/new-section")).isDirectory(), true);
  fs.writeFileSync(path.join(root, "docs/current.md"), "# Current\n");
  assert.throws(() => createFolder(root, { path: "docs/current.md" }), /already exists/);
  assert.throws(() => createFolder(root, { path: "private/new-section" }), /not allowed/);
});

test("deleteMemoryPaths follows project-configured allowed paths", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["project-docs/"] });
  fs.mkdirSync(path.join(root, "project-docs"));
  fs.writeFileSync(path.join(root, "project-docs/current.md"), "# Current\n");

  const result = deleteMemoryPaths(root, ["project-docs/current.md"]);

  assert.deepEqual(result.deleted, ["project-docs/current.md"]);
  assert.equal(fs.existsSync(path.join(root, "project-docs/current.md")), false);
});

test("applyMarkdownTemplateToFile fills an existing empty markdown file only", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["context/"] });
  fs.mkdirSync(path.join(root, "context"));
  fs.writeFileSync(path.join(root, "context/empty.md"), "");
  fs.writeFileSync(path.join(root, "context/current.md"), "# Current\n");

  const result = applyMarkdownTemplateToFile(root, {
    path: "context/empty.md",
    title: "Empty",
    templateId: "context-golden",
  });

  const content = fs.readFileSync(path.join(root, "context/empty.md"), "utf8");
  assert.equal(result.path, "context/empty.md");
  assert.equal(result.existed, true);
  assert.match(content, /^---/);
  assert.match(content, /context_room:/);
  assert.match(content, /# Empty/);
  assert.match(content, /## Purpose/);

  assert.throws(
    () => applyMarkdownTemplateToFile(root, { path: "context/current.md", title: "Current", templateId: "context-golden" }),
    /not empty/,
  );
});

test("markdown templates can be kept hidden from the apply-template selector", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.markdownTemplates = [
    { id: "published", title: "Published", description: "Ready to use", content: "# {{title}}\n", enabled: true },
    { id: "draft", title: "Draft", description: "Still being developed", content: "# Draft\n", enabled: false },
  ];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const settings = readMemoryWebappSettings(root);
  assert.equal(settings.markdownTemplates.length, 2);
  assert.equal(settings.markdownTemplates.find((template) => template.id === "draft")?.enabled, false);

  const html = renderTemplateOptionsMarkup(settings.markdownTemplates);
  assert.match(html, /Published/);
  assert.doesNotMatch(html, /Draft/);
});

test("documentation graph reports metadata, broken sources, and duplicate canonical docs", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "billing.ts"), "export const billing = true;\n");
  fs.writeFileSync(path.join(root, "docs", "billing.md"), `---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: [src/billing.ts]
---

# Billing
`);
  fs.writeFileSync(path.join(root, "docs", "billing-copy.md"), `---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: [src/missing.ts]
---

# Billing Copy
`);
  fs.writeFileSync(path.join(root, "docs", "plain.md"), "# Plain\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/", "src/"], watchAllow: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.hubSections = [{ id: "docs", title: "Docs", cards: [{ id: "docs", title: "Docs", path: "docs/" }] }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const graph = buildDocumentationGraph(root);

  assert.equal(graph.summary.docs, 3);
  assert.equal(graph.nodes.find((node) => node.path === "docs/billing.md")?.metadata.present, true);
  assert.ok(graph.healthIssues.some((issue) => issue.type === "broken_source" && issue.path === "docs/billing-copy.md"));
  assert.ok(graph.healthIssues.some((issue) => issue.type === "duplicate_canonical" && issue.path === "docs/billing.md"));
  assert.ok(graph.healthIssues.some((issue) => issue.type === "missing_metadata" && issue.path === "docs/plain.md"));
});

test("documentation graph ignores non-context-room YAML frontmatter", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "skill.md"), `---
name: docs-sync
description: >
  A normal skill or static-site frontmatter block can use YAML features that
  Context Room does not parse.
---

# Skill
`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const metadata = parseDocMetadata(fs.readFileSync(path.join(root, "docs", "skill.md"), "utf8"), "docs/skill.md");
  const graph = buildDocumentationGraph(root);

  assert.equal(metadata.present, false);
  assert.equal(metadata.parseError, "");
  assert.equal(parseDocMetadata("# Product agents page\n", "docs/features/agents.md").kind, "canonical");
  assert.equal(parseDocMetadata("# Agent instructions\n", "AGENTS.md").kind, "agents");
  assert.equal(graph.healthIssues.some((issue) => issue.type === "metadata_parse_error"), false);
  assert.equal(graph.healthIssues.some((issue) => issue.type === "duplicate_canonical"), false);
});

test("doctor report and deterministic brief summarize the context graph", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), `---
context_room:
  kind: agents
  scope: project
  status: current
  canonical_for: startup
  last_verified: 2026-06-26
  sources: []
---

# Agents
`);
  fs.writeFileSync(path.join(root, "docs", "billing.md"), `---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: []
---

# Billing
`);
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"], watchAllow: ["AGENTS.md", "docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupContext = { enabled: true, fileNames: ["AGENTS.md"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const doctor = buildContextRoomDoctorReport(root);
  const brief = buildAgentBrief(root, { task: "update billing docs", limit: 4 });

  assert.equal(doctor.graph.docs, 2);
  assert.match(brief, /Startup Context/);
  assert.match(brief, /AGENTS\.md/);
  assert.match(brief, /docs\/billing\.md/);
  assert.match(brief, /No watched documentation changes are pending review/);
});

test("explorer context menu renders action choices and keeps creation forms hidden", () => {
  const html = renderExplorerContextMenuMarkup({
    targetPath: "docs/guide.md",
    directory: "docs",
    selectionCount: 2,
    templates: DEFAULT_MARKDOWN_TEMPLATES,
  });

  assert.match(html, /data-context-watch/);
  assert.match(html, /data-context-action-list/);
  assert.match(html, /data-context-new-file/);
  assert.match(html, /data-context-new-folder/);
  assert.match(html, /data-context-select/);
  assert.match(html, /data-context-delete/);
  assert.match(html, /Watch/);
  assert.match(html, /New file/);
  assert.match(html, /New folder/);
  assert.match(html, /Select/);
  assert.match(html, /Delete/);
  assert.match(html, /2 selected/);
  assert.match(html, /data-context-new-file-form hidden/);
  assert.match(html, /data-context-new-folder-form hidden/);
  assert.doesNotMatch(html, /contextMarkdownPath/);
  assert.doesNotMatch(html, /docs\/new-document\.md/);
  assert.doesNotMatch(html, /contextMarkdownTemplate/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /Golden context file/);
  assert.match(html, /aria-label="Cancel"/);
  assert.match(html, />Cancel</);
  assert.match(html, /id="contextCreateMarkdown" class="primary"/);
  assert.match(html, /id="contextCreateFolder" class="primary"/);
  assert.match(html, /explorer-context-actions form-actions/);
  assert.match(html, /<label class="explorer-context-label" for="contextMarkdownTitle">Name<\/label>/);
  assert.match(html, /<label class="explorer-context-label" for="contextFolderPath">Path<\/label>/);
});

test("explorer empty-space context menu targets the project root for creation", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "",
    directory: "",
    selectionCount: 1,
    templates: DEFAULT_MARKDOWN_TEMPLATES,
  });
  const html = renderAppHtml();

  assert.match(menu, /project root/);
  assert.match(menu, /data-context-new-file/);
  assert.match(menu, /data-context-new-folder/);
  assert.doesNotMatch(menu, /data-context-watch/);
  assert.doesNotMatch(menu, /data-context-select/);
  assert.doesNotMatch(menu, /data-context-delete/);
  assert.match(html, /function openExplorerEmptyContextMenu\(event\)/);
  assert.match(html, /document\.querySelector\("aside"\)\?\.addEventListener\("contextmenu", openExplorerEmptyContextMenu\)/);
  assert.match(html, /openExplorerContextMenu\(event, \{ kind: "folder", path: "" \}\)/);
});

test("explorer new file opens the structured document page before writing", () => {
  const html = renderAppHtml();

  assert.match(html, /id="newDocPage" class="settings-page" hidden/);
  assert.match(html, /function showNewDocPage\(/);
  assert.match(html, /function renderNewDocPanel\(/);
  assert.match(html, /data-structured-doc-form/);
  assert.match(html, /id="markdownCreateFolder" type="hidden"/);
  assert.match(html, /id="markdownCreateFolderButton"/);
  assert.match(html, /id="markdownCreateFolderMenu" class="path-picker-menu" hidden/);
  assert.match(html, /id="markdownCreateFolderSearch"/);
  assert.match(html, /id="markdownCreateFolderOptions"/);
  assert.match(html, /id="markdownCreateFileName"/);
  assert.match(html, /id="markdownCreatePath" type="hidden"/);
  assert.match(html, /id="markdownCreatePathPreview"/);
  assert.match(html, /function markdownFolderOptions\(/);
  assert.match(html, /function togglePathPickerMenu\(/);
  assert.match(html, /function renderPathPickerOptions\(/);
  assert.match(html, /function setStructuredFolder\(/);
  assert.match(html, /function updateStructuredMarkdownPath\(/);
  assert.match(html, /function createMarkdownFromContextMenu\(\)[\s\S]*showNewDocPage\(\{ title, path: relPath, directory \}\)/);
  assert.doesNotMatch(html, /function createStructuredMarkdownFromHub/);
  assert.doesNotMatch(html, /<select id="markdownCreateFolder"/);
  assert.doesNotMatch(html, /<label for="markdownCreatePath">Path<\/label><input id="markdownCreatePath"/);
});

test("app CSS keeps hidden context menu forms hidden despite form display rules", () => {
  const html = renderAppHtml();

  assert.match(html, /data-template-enabled/);
  assert.match(html, /Show in selector/);
  assert.match(html, /\.explorer-context-form\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-actions\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-menu \{[^}]*width:\s*min\(245px,/);
  assert.match(html, /\.explorer-context-actions\.form-actions\s*\{\s*grid-template-columns:\s*1fr 1fr/);
  assert.match(html, /\.explorer-context-menu \.explorer-context-actions button\s*\{[^}]*padding:\s*8px 10px/);
  assert.match(html, /\.tree\s*\{[^}]*min-height:\s*180px/);
  assert.match(html, /select option\s*\{\s*color:\s*#111827;\s*background:\s*#ffffff;\s*\}/);
  assert.match(html, /select option:checked\s*\{\s*color:\s*#07101e;\s*background:\s*#93c5fd;\s*\}/);
  assert.match(html, /\.path-picker\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.2fr\) minmax\(0, 1fr\)/);
  assert.match(html, /\.path-picker-trigger\s*\{[^}]*grid-template-columns:\s*1fr auto/);
  assert.match(html, /\.path-picker-menu\s*\{[^}]*position:\s*absolute/);
  assert.match(html, /\.path-picker-search\s*\{[^}]*background:\s*rgba\(255,255,255,0\.055\)/);
  assert.match(html, /\.path-picker-option\s*\{[^}]*grid-template-columns:\s*1fr auto/);
  assert.match(html, /\.path-picker-preview\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(html, /\.app\.sidebar-collapsed \.sidebar-copy,[^}]*\.app\.sidebar-collapsed \.watch-filter-row,[^}]*\.app\.sidebar-collapsed \.selection-bar,[^}]*opacity:\s*0/);
  assert.match(html, /@media \(max-width: 980px\) \{[\s\S]*\.app\.sidebar-collapsed \.sidebar-copy,[^}]*\.app\.sidebar-collapsed \.watch-filter-row,[^}]*\.app\.sidebar-collapsed \.selection-bar,[^}]*opacity:\s*0/);
});

test("app CSS keeps hub sections stacked and cards responsive", () => {
  const html = renderAppHtml();
  const hubFoldersRule = html.match(/\.hub-folders\s*\{[^}]*\}/)?.[0] || "";

  assert.doesNotMatch(hubFoldersRule, /grid-template-columns/);
  assert.doesNotMatch(html, /@media \(max-width: 1200px\)\s*\{[^}]*\.hub-folders[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.match(html, /\.hub-section-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 260px\), 1fr\)\)/);
  assert.match(html, /\.hub-folder-card\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden/);
  assert.match(html, /\.hub-folder-card-main\s*\{[^}]*min-height:\s*132px;[^}]*padding:\s*18px/);
  assert.match(html, /\.hub-folder-card strong\s*\{[^}]*letter-spacing:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(html, /\.hub-folder-meta code\s*\{\s*flex:\s*1 1 auto;\s*\}/);
});

test("save preserves the editor scroll position after rerendering", () => {
  const html = renderAppHtml();

  assert.match(html, /const viewState = captureEditorViewState\(\);/);
  assert.match(html, /renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /function isScrollableY\(element\)/);
  assert.match(html, /function activeDocumentScrollTarget\(\)/);
  assert.match(html, /if \(isScrollableY\(documentSurface\)\) return documentSurface;/);
  assert.match(html, /if \(isScrollableY\(el\("viewer"\)\)\) return el\("viewer"\);/);
  assert.match(html, /function externalReviewBlockElement\(blockId\)/);
  assert.match(html, /function shiftScrollForElement\(element, delta\)/);
  assert.match(html, /function setDiffCollapsed\(collapsed\)/);
  assert.match(html, /function wireFileActionButtons\(root = document\)/);
  assert.match(html, /setDiffCollapsed\(true\)/);
  assert.match(html, /setDiffCollapsed\(false\)/);
  assert.match(html, /function updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /function wireExternalReviewDecisionButtons\(root = document\)/);
  assert.match(html, /captureEditorViewState\(\{ anchorBlockId: blockId \}\)/);
  assert.match(html, /event\.stopPropagation\(\)/);
  assert.match(html, /anchorTop/);
  assert.match(html, /document\.querySelector\("\.external-review-doc"\)/);
  assert.match(html, /documentScrollTop/);
  assert.match(html, /editorScrollTop/);
  assert.match(html, /viewerScrollTop/);
  assert.match(html, /windowScrollY/);
  assert.match(html, /const editor = snapshot\.textAnchor \? \(el\("docEditor"\) \|\| activeEditor\(\)\) : \(snapshot\.editorId \? el\(snapshot\.editorId\) : activeEditor\(\)\);/);
  assert.doesNotMatch(html, /snapshot\.editorId === "docEditor" \? el\("docEditor"\) : activeEditor\(\)/);
  assert.match(html, /function scrollEditorToTextAnchor\(editor, snapshot\)/);
  assert.match(html, /const restoredTextAnchor = scrollEditorToTextAnchor\(editor, snapshot\);/);
  assert.match(html, /window\.requestAnimationFrame\(apply\)/);
  assert.match(html, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*window\.requestAnimationFrame\(apply\)/);
  assert.match(html, /window\.setTimeout\(apply, 0\)/);
});

test("Ctrl or Cmd S saves the selected dirty file", () => {
  const html = renderAppHtml();

  assert.match(html, /function isSaveShortcut\(event\)/);
  assert.match(html, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(html, /String\(event\.key \|\| ""\)\.toLowerCase\(\) === "s"/);
  assert.match(html, /function handleSaveShortcut\(event\)/);
  assert.match(html, /event\.preventDefault\(\);/);
  assert.match(html, /if \(!state\.dirty\) \{/);
  assert.match(html, /setStatus\("no changes to save"\)/);
  assert.match(html, /saveCurrent\(\)\.catch\(\(error\) => setStatus\(error\.message\)\)/);
  assert.match(html, /if \(handleSaveShortcut\(event\)\) return;/);
});

test("disk changes stay pending for review instead of silently reloading the open file", () => {
  const html = renderAppHtml();

  assert.match(html, /externalChange: null/);
  assert.match(html, /function activeExternalChange\(\)/);
  assert.match(html, /external-review-doc/);
  assert.match(html, /external-review-block change/);
  assert.match(html, /external-review-line/);
  assert.match(html, /Document with disk changes highlighted/);
  assert.match(html, /data-external-block-decision="accept"/);
  assert.match(html, /data-external-block-decision="reject"/);
  assert.match(html, /data-external-block-id/);
  assert.match(html, />OK<\/button>/);
  assert.match(html, />x<\/button>/);
  assert.match(html, /buildExternalReviewBlocks/);
  assert.match(html, /chooseExternalReviewBlock/);
  assert.match(html, /updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /externalReviewRowsForDecision/);
  assert.match(html, /external-review-block context resolved/);
  assert.match(html, /external-review-block context resolved [^"]*empty/);
  assert.match(html, /external-review-resolved-label/);
  assert.match(html, /external-review-placeholder/);
  assert.match(html, /computeExternalReviewContent/);
  assert.match(html, /renderExternalReviewDocument/);
  assert.match(html, /renderExternalReviewActions/);
  assert.match(html, /state\.externalChange = \{[\s\S]*reviewDecisions: \{\},[\s\S]*\};\s*state\.selectedDiff = diff;\s*state\.diffCollapsed = true;/);
  assert.match(html, /const viewState = captureEditorViewState\(\);[\s\S]*state\.externalChange = \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /const previousHeight = current\.getBoundingClientRect\(\)\.height;/);
  assert.match(html, /next\.style\.minHeight = Math\.ceil\(previousHeight\) \+ "px"/);
  assert.match(html, /function waitForInlineReviewTransition\(\)/);
  assert.match(html, /await waitForInlineReviewTransition\(\)/);
  assert.match(html, /function externalReviewTextAnchor\(blocks, blockId, mergedText\)/);
  assert.match(html, /viewState\.textAnchor = externalReviewTextAnchor\(blocks, viewState\.anchorBlockId, merged\);/);
  assert.match(html, /function textOffsetForLineIndex\(lines, lineIndex\)/);
  assert.match(html, /function finishExternalReviewPanelInPlace\(viewState\)/);
  assert.match(html, /if \(!finishExternalReviewPanelInPlace\(viewState\)\) \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /actions\.outerHTML = renderFileActionButtons\(\{/);
  assert.match(html, /function settleFinishedExternalReview\(viewState\)/);
  assert.match(html, /window\.setTimeout\(\(\) => settleFinishedExternalReview\(viewState\), 520\)/);
  assert.match(html, /\.external-review-block\.resolved\.settling\s*\{[^}]*height 2s ease[^}]*min-height 2s ease/);
  assert.match(html, /block\.classList\.add\("settling"\)/);
  assert.match(html, /const targetHeight = block\.classList\.contains\("empty"\) \? 0 : Math\.ceil\(block\.scrollHeight\);/);
  assert.match(html, /window\.setTimeout\(\(\) => \{[\s\S]*block\.classList\.remove\("settling"\)[\s\S]*\}, 2050\);/);
  assert.match(html, /\.external-review-doc\.settled \.external-review-resolved-label,[^}]*\.external-review-doc\.settled \.external-review-placeholder\s*\{\s*display:\s*none/);
  assert.match(html, /\.external-review-doc\.settled \.external-review-block\.resolved\.empty\s*\{[^}]*min-height:\s*0/);
  assert.match(html, /resetExternalChangeState\(\);\s*\/\/ Returning from inline review should keep[\s\S]*state\.diffCollapsed = true;/);
  assert.match(html, /block\.decision === "accept"[\s\S]*row\.type !== "del"/);
  assert.match(html, /block\.decision === "reject"[\s\S]*row\.type !== "add"/);
  assert.doesNotMatch(html, /external-review-block\.accept \.external-review-line\.del/);
  assert.doesNotMatch(html, /external-change-panel/);
  assert.match(html, /file changed on disk · review before applying/);
  assert.match(html, /function blockPendingExternalChange/);
  assert.match(html, /apply or reject before saving/);
  assert.doesNotMatch(html, /setStatus\("reloaded from disk"\);\n  \} catch \(error\) \{\n    setStatus\(error\.message\);\n  \}\n\}/);
});

test("hub child cards expand inline without replacing root sections", () => {
  const html = renderAppHtml();

  assert.match(html, /\.hub-folder-card\.expanded\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(html, /function renderHubFolderChildren\(folder, activeIds\)/);
  assert.match(html, /const sections = state\.rootHubSections\?\.length \? state\.rootHubSections/);
  assert.doesNotMatch(html, /holder\.innerHTML = renderHubBreadcrumb\(\) \+ sections/);
  assert.doesNotMatch(html, /const nextSections = hubSectionViewForCard/);
});

test("hub folder cards can infer child cards from allowed folders", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
  fs.writeFileSync(path.join(root, "docs", "b.md"), "# B\n");
  fs.writeFileSync(path.join(root, "docs", "nested", "c.md"), "# C\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.hubSections = [{
    id: "docs",
    title: "Docs",
    cards: [{
      id: "docs-card",
      title: "Docs",
      description: "Project docs.",
      path: "docs/",
      autoChildren: true,
      enabled: true,
    }],
  }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  const sections = hubSectionsForRoot(root, readMemoryWebappSettings(root));
  const card = sections[0].cards[0];

  assert.deepEqual(card.cards.map((child) => child.title), ["nested", "a.md", "b.md"]);
  assert.equal(card.cards[0].autoChildren, true);
  assert.deepEqual(card.cards[0].cards.map((child) => child.title), ["c.md"]);
  assert.equal(card.cards[1].path, "docs/a.md");
});

test("hub cards open direct file paths without filtering folders", () => {
  const html = renderAppHtml();

  assert.match(html, /\[data-hub-file\]/);
  assert.match(html, /selectFile\(button\.dataset\.hubFile\)/);
  assert.match(html, /data-hub-file="[^"]*directFilePath/);
  assert.match(html, /data-hub-folders="[^"]*paths\.join/);
});
