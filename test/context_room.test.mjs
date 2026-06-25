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
  createFolder,
  createMarkdownFile,
  createDefaultProjectConfig,
  deleteMemoryPaths,
  initializeContextRoomProject,
  isAllowedMemoryPath,
  listMemoryFiles,
  readFileDiff,
  readMemoryWebappSettings,
  renderAppHtml,
  renderExplorerContextMenuMarkup,
  renderTemplateOptionsMarkup,
  writeDocReviewDecision,
} from "../src/context_room.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "context-room-"));
}

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
  assert.match(golden.content, /^# \{\{title\}\}/);
  assert.match(golden.content, /## Purpose/);
  assert.match(golden.content, /## Key facts/);
  assert.match(golden.content, /## References/);
  assert.ok(golden.content.length < 900, "golden template should stay simple enough to read quickly");
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
  assert.match(content, /^# Empty/);
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
  assert.match(html, /docs\/new-document\.md/);
  assert.match(html, /data-context-new-file-form hidden/);
  assert.match(html, /data-context-new-folder-form hidden/);
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

test("app CSS keeps hidden context menu forms hidden despite form display rules", () => {
  const html = renderAppHtml();

  assert.match(html, /data-template-enabled/);
  assert.match(html, /Show in selector/);
  assert.match(html, /\.explorer-context-form\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-actions\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-menu \{[^}]*width:\s*min\(245px,/);
  assert.match(html, /\.explorer-context-actions\.form-actions\s*\{\s*grid-template-columns:\s*1fr 1fr/);
  assert.match(html, /\.explorer-context-menu \.explorer-context-actions button\s*\{[^}]*padding:\s*8px 10px/);
});
