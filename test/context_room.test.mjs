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
  FILE_THEME_OPTIONS,
  appendAgentAnnotation,
  applyMarkdownTemplateToFile,
  buildAgentBrief,
  buildAgentReviewQueue,
  buildContextRoomDoctorReport,
  buildDocQaReport,
  buildDocumentationGraph,
  createStartupSkillFile,
  createFolder,
  createMarkdownFile,
  createDefaultProjectConfig,
  deleteMemoryPaths,
  deleteStartupSkill,
  ensureRuntimeGitExcludes,
  hubSectionsForRoot,
  initializeContextRoomProject,
  isAllowedMemoryPath,
  listMemoryFiles,
  listStartupContextFiles,
  listStartupSkillFolders,
  parseDocMetadata,
  readAgentAnnotations,
  readAgentCommand,
  readCollaborationSessionState,
  readFileDiff,
  readMemoryWebappSettings,
  readStartupContextFile,
  readStartupSkillFile,
  renderAppHtml,
  renderExplorerContextMenuMarkup,
  renderTemplateOptionsMarkup,
  revertMemoryFile,
  writeStartupContextFile,
  writeStartupSkillFile,
  writeAgentCommand,
  writeCollaborationSessionState,
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
  assert.deepEqual(config.reviewPaths, []);
  assert.equal(config.appearance.fileTheme, "context-room");
  assert.equal(config.appearance.autoOpenGitDiff, true);
  assert.deepEqual(config.startupSkills.folderNames, [".codex/skills", "skills"]);
  assert.ok(FILE_THEME_OPTIONS.some((theme) => theme.id === config.appearance.fileTheme));
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
  assert.equal(saved.appearance.autoOpenGitDiff, true);
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

test("appearance settings preserve manual Git diff opening preference", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.appearance = { ...config.appearance, autoOpenGitDiff: false };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const settings = readMemoryWebappSettings(root);
  assert.equal(settings.appearance.fileTheme, "context-room");
  assert.equal(settings.appearance.autoOpenGitDiff, false);
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
  const written = writeStartupContextFile(root, 2, "# Updated Claude\n");

  assert.deepEqual(files.map((file) => file.startupContext.fileName), ["AGENTS.md", "CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(files.map((file) => file.startupContext.order), [1, 2, 3]);
  assert.equal(files[0].category, "0 · startup context");
  assert.match(files[0].startupContext.displayPath, /AGENTS\.md$/);
  assert.equal(files[0].startupContext.kind, "startup-context");
  assert.equal(files[2].startupContext.explorerPath, "AGENTS.md");
  assert.equal(memoryFiles.some((file) => file.startupContext), false);
  assert.equal(opened.content, "# Parent Claude\n");
  assert.equal(opened.startupContext.fileName, "CLAUDE.md");
  assert.equal(opened.startupContext.explorerPath, opened.startupContext.displayPath);
  assert.equal(written.contentHash, readStartupContextFile(root, 2).contentHash);
  assert.equal(fs.readFileSync(path.join(parent, "CLAUDE.md"), "utf8"), "# Updated Claude\n");
});

test("opened startup context files can be exposed and selected in the explorer", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const parent = path.join(base, "parent");
    const root = path.join(parent, "project");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "# Parent Agents\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext = { enabled: true, fileNames: ["AGENTS.md"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const opened = readStartupContextFile(root, 1);
    const files = listMemoryFiles(root, { externalRoots: [opened.startupContext.displayPath] });

    assert.equal(opened.startupContext.kind, "startup-context");
    assert.equal(opened.startupContext.displayPath, "~/parent/AGENTS.md");
    assert.equal(opened.startupContext.explorerPath, "~/parent/AGENTS.md");
    assert.ok(files.some((file) => file.path === opened.startupContext.displayPath));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup skills scanner lists configured skill folders from ancestors to root", () => {
  const base = makeRoot();
  const parent = path.join(base, "parent");
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(base, ".codex", "skills", "global-skill"), { recursive: true });
  fs.mkdirSync(path.join(base, ".codex", "skills", ".system", "skill-creator"), { recursive: true });
  fs.mkdirSync(path.join(base, ".codex", "skills", ".system", "skill-installer"), { recursive: true });
  fs.mkdirSync(path.join(parent, ".agents", "skills", "parent-skill"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex", "skills", "project-skill"), { recursive: true });
  fs.writeFileSync(path.join(base, ".codex", "skills", "global-skill", "SKILL.md"), "# Global\n");
  fs.writeFileSync(path.join(base, ".codex", "skills", ".system", "skill-creator", "SKILL.md"), "# Creator\n");
  fs.writeFileSync(path.join(base, ".codex", "skills", ".system", "skill-installer", "SKILL.md"), "# Installer\n");
  fs.writeFileSync(path.join(parent, ".agents", "skills", "parent-skill", "SKILL.md"), "# Parent\n");
  fs.writeFileSync(path.join(root, ".codex", "skills", "project-skill", "SKILL.md"), "# Project\n");
  initializeContextRoomProject(root, {
    allowedPaths: ["docs/"],
    watchAllow: [],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupSkills = { enabled: true, folderNames: [".codex/skills", ".agents/skills"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const folders = listStartupSkillFolders(root);
  const systemFolder = folders.find((folder) => folder.folderName === ".codex/skills/.system");
  const parentOrder = folders.find((folder) => folder.folderName === ".agents/skills")?.order;
  const openedSystem = readStartupSkillFile(root, systemFolder.order, "skill-installer");
  const opened = readStartupSkillFile(root, parentOrder, "parent-skill");
  const written = writeStartupSkillFile(root, parentOrder, "parent-skill", "# Parent Updated\n");
  const created = createStartupSkillFile(root, parentOrder, "Review Docs");
  fs.mkdirSync(path.join(parent, ".agents", "skills", "review-docs", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(parent, ".agents", "skills", "review-docs", "scripts", "check.sh"), "echo ok\n");
  const createdSkillFileExists = fs.existsSync(path.join(parent, ".agents", "skills", "review-docs", "SKILL.md"));
  const deleted = deleteStartupSkill(root, parentOrder, "review-docs");

  assert.deepEqual(folders.map((folder) => folder.folderName), [".codex/skills", ".codex/skills/.system", ".agents/skills", ".codex/skills"]);
  assert.deepEqual(folders.map((folder) => folder.order), [1, 2, 3, 4]);
  assert.deepEqual(folders.map((folder) => folder.skills), [["global-skill"], ["skill-creator", "skill-installer"], ["parent-skill"], ["project-skill"]]);
  assert.match(folders[0].displayPath, /\.codex\/skills$/);
  assert.equal(systemFolder.readOnly, true);
  assert.equal(openedSystem.content, "# Installer\n");
  assert.match(openedSystem.startupContext.displayPath, /\.codex\/skills\/\.system\/skill-installer\/SKILL\.md$/);
  assert.throws(() => writeStartupSkillFile(root, systemFolder.order, "skill-installer", "# Mutate\n"), /read-only/);
  assert.throws(() => createStartupSkillFile(root, systemFolder.order, "new-system-skill"), /read-only/);
  assert.throws(() => deleteStartupSkill(root, systemFolder.order, "skill-installer"), /read-only/);
  assert.equal(opened.content, "# Parent\n");
  assert.equal(opened.startupContext.kind, "startup-skill");
  assert.equal(opened.startupContext.skillName, "parent-skill");
  assert.match(opened.startupContext.displayPath, /parent-skill\/SKILL\.md$/);
  assert.equal(opened.startupContext.explorerPath, opened.startupContext.displayPath);
  assert.equal(written.contentHash, readStartupSkillFile(root, parentOrder, "parent-skill").contentHash);
  assert.equal(fs.readFileSync(path.join(parent, ".agents", "skills", "parent-skill", "SKILL.md"), "utf8"), "# Parent Updated\n");
  assert.equal(created.startupContext.skillName, "review-docs");
  assert.match(created.content, /name: review-docs/);
  assert.equal(createdSkillFileExists, true);
  assert.equal(deleted.deleted, true);
  assert.match(deleted.backupPath, /\.context-room\/memory-webapp-backups/);
  assert.equal(fs.readFileSync(path.join(root, deleted.backupPath, "scripts", "check.sh"), "utf8"), "echo ok\n");
  assert.equal(fs.existsSync(path.join(parent, ".agents", "skills", "review-docs")), false);
});

test("startup skill folders can be exposed in the explorer for file and folder creation", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const root = path.join(base, "project");
    const skillRootAbs = path.join(base, ".agents", "skills", "edit-me");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(skillRootAbs, "docs"), { recursive: true });
    fs.writeFileSync(path.join(skillRootAbs, "SKILL.md"), "# Edit Me\n");
    fs.writeFileSync(path.join(skillRootAbs, "docs", "guide.md"), "# Guide\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupSkills = { enabled: true, folderNames: [".agents/skills"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const opened = readStartupSkillFile(root, 1, "edit-me");
    const skillRoot = opened.startupContext.folder + "/edit-me";
    const files = listMemoryFiles(root, { externalRoots: [skillRoot] });
    const createdFile = createMarkdownFile(root, { path: skillRoot + "/notes.md", title: "Notes", applyTemplate: false });
    const createdFolder = createFolder(root, { path: skillRoot + "/references" });

    assert.equal(opened.startupContext.fileName, "edit-me/SKILL.md");
    assert.equal(opened.startupContext.explorerPath, skillRoot + "/SKILL.md");
    assert.ok(files.some((file) => file.path === skillRoot + "/SKILL.md"));
    assert.ok(files.some((file) => file.path === skillRoot + "/docs/guide.md"));
    assert.equal(createdFile.path, skillRoot + "/notes.md");
    assert.equal(createdFolder.path, skillRoot + "/references/");
    assert.equal(fs.existsSync(path.join(skillRootAbs, "notes.md")), true);
    assert.equal(fs.existsSync(path.join(skillRootAbs, "references")), true);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup context virtual files stay out of the explorer tree", () => {
  const html = renderAppHtml();

  assert.match(html, /api\("\/api\/startup-context"\)/);
  assert.match(html, /api\("\/api\/startup-skills"\)/);
  assert.match(html, /api\("\/api\/startup-skills\/file\?folder="/);
  assert.match(html, /api\("\/api\/startup-skills\/create"/);
  assert.match(html, /api\("\/api\/startup-skills\/delete"/);
  assert.match(html, /function renderStartupSkillsPanel\(\)/);
  assert.match(html, /function selectStartupSkillFile\(folderOrder, skillName\)/);
  assert.match(html, /const selectedPath = startupContextSelectedExplorerPath\(data\.startupContext\);[\s\S]*state\.selected = selectedPath \|\| selectedKey;/);
  assert.match(html, /state\.selected = startupSkillSelectedExplorerPath\(data\.startupContext\) \|\| selectedKey;/);
  assert.match(html, /function createStartupSkillFromPanel\(folderOrder\)/);
  assert.match(html, /function submitStartupSkillCreateForm\(folderOrder\)/);
  assert.match(html, /function cancelStartupSkillCreate\(\)/);
  assert.match(html, /function deleteStartupSkillFromPanel\(folderOrder, skillName\)/);
  assert.match(html, /function filesApiPath\(\)/);
  assert.match(html, /startupContextOrder/);
  assert.match(html, /function activateStartupSkillExplorer\(folderOrder, skillName, startupContext = null\)/);
  assert.match(html, /function activateStartupContextExplorer\(startupContext = null\)/);
  assert.match(html, /function startupContextSelectedExplorerPath\(startupContext = state\.selectedStartupContext\)/);
  assert.match(html, /startupContext\.explorerPath/);
  assert.match(html, /function revealActiveStartupContextExplorer\(\)/);
  assert.match(html, /function startupSkillSelectedExplorerPath\(startupContext = state\.selectedStartupContext\)/);
  assert.match(html, /function revealActiveStartupSkillExplorer\(\)/);
  assert.match(html, /function expandAndRevealExplorerPath\(path\)/);
  assert.doesNotMatch(html, /function isPathInsideActiveStartupSkill/);
  assert.doesNotMatch(html, /state\.activeStartupSkillExplorer = null;\s*state\.selected = selectedKey;\s*state\.openingFilePath = selectedKey;\s*state\.selectedStartupContext = pendingFile/);
  assert.match(html, /activeStartupSkillExplorer: null/);
  assert.match(html, /activeStartupContextExplorer: null/);
  assert.match(html, /Startup skills/);
  assert.match(html, /startupSkillFolders: \[\]/);
  assert.match(html, /data-startup-skill-name/);
  assert.match(html, /data-startup-skill-delete/);
  assert.match(html, /data-startup-skill-create-folder/);
  assert.match(html, /data-startup-skill-create-form/);
  assert.match(html, /data-startup-skill-create-input/);
  assert.match(html, /startup-context-item startup-skill-folder readonly/);
  assert.match(html, /\.startup-skill-button\s*\{[^}]*padding:\s*5px 8px/);
  assert.match(html, /\.startup-skill-delete\s*\{[^}]*position:\s*absolute;[^}]*top:\s*-7px;[^}]*right:\s*-7px;[^}]*background:\s*rgba\(139,211,255,0\.14\);[^}]*pointer-events:\s*none;[^}]*display:\s*grid;[^}]*place-items:\s*center/);
  assert.match(html, /\.startup-skill-pill:hover \.startup-skill-delete[^}]*pointer-events:\s*auto/);
  assert.doesNotMatch(html, /\.startup-skill-pill:hover[^}]*grid-template-columns/);
  assert.match(html, /\.startup-skill-add/);
  assert.match(html, /id="startupSkillsEnabled"/);
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

test("init adds Context Room runtime files to local Git excludes", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const result = ensureRuntimeGitExcludes(root);
  const excludePath = result.path || execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" }).trim() + "/info/exclude";
  const exclude = fs.readFileSync(path.isAbsolute(excludePath) ? excludePath : path.join(root, excludePath), "utf8");

  assert.match(exclude, /Context Room runtime state/);
  assert.match(exclude, /\.context-room\/session-state\.json/);
  assert.match(exclude, /\.context-room\/agent-command\.json/);
  assert.match(exclude, /\.context-room\/agent-annotations\.json/);
});

test("runtime Git excludes are scoped when Context Room root is a Git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "project");
  fs.mkdirSync(root);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" }).trim();
  const exclude = fs.readFileSync(path.join(repo, gitDir, "info", "exclude"), "utf8");

  assert.match(exclude, /project\/\.context-room\/session-state\.json/);
  assert.match(exclude, /project\/\.context-room\/agent-command\.json/);
  assert.match(exclude, /project\/\.context-room\/memory-webapp-backups\//);
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
      assert.match(output, /Context Room guard blocked this commit/);
      assert.match(output, /need human review/);
      assert.match(output, /Agents must not mark files verified on the user's behalf/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  writeDocReviewDecision(root, "README.md", { status: "verified", note: "test baseline" });
  const output = execFileSync(process.execPath, [cli, "guard"], { cwd: root, encoding: "utf8" });
  assert.match(output, /No unverified watched documentation changes/);

  const unverified = writeDocReviewDecision(root, "README.md", { status: "unverified", note: "undo" });
  assert.equal(unverified.status, "unverified");
  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this commit/);
      assert.match(output, /README\.md/);
      return true;
    },
  );
});

test("collaboration state, commands, annotations, and queue are agent-safe", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\n## Purpose\nKeep humans in control.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const session = writeCollaborationSessionState(root, {
    page: "file",
    openFile: "docs/guide.md",
    selectedPath: "docs/guide.md",
    visibleHeading: "## Purpose",
    scrollPercent: 42,
    pendingMiniDiffs: 2,
    gitDiffOpen: true,
    explorerFilter: "watched",
    dirty: false,
  });
  assert.equal(session.openFile, "docs/guide.md");
  assert.equal(readCollaborationSessionState(root).visibleHeading, "## Purpose");

  const command = writeAgentCommand(root, { view: "file", path: "docs/guide.md", targetType: "heading", targetValue: "Purpose" });
  assert.equal(command.path, "docs/guide.md");
  assert.deepEqual(readAgentCommand(root).command.target, { type: "heading", value: "Purpose" });

  const annotation = appendAgentAnnotation(root, { path: "docs/guide.md", target: "Purpose", targetType: "heading", note: "Ask the user to verify this section." });
  const annotations = readAgentAnnotations(root, "docs/guide.md").annotations;
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].id, annotation.id);
  assert.equal(annotations[0].resolved, false);

  const queue = buildAgentReviewQueue(root);
  assert.match(queue.note, /Human verification must happen/);
  assert.ok(Array.isArray(queue.queue));
});

test("CLI agent commands expose state, navigation, annotations, and queue without verify", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const cli = path.resolve("bin/context-room.mjs");

  const open = JSON.parse(execFileSync(process.execPath, [cli, "agent", "open", "--root", root, "--path", "docs/guide.md", "--heading", "Guide"], { encoding: "utf8" }));
  assert.equal(open.command.path, "docs/guide.md");
  assert.equal(open.command.target.type, "heading");

  const stateOutput = JSON.parse(execFileSync(process.execPath, [cli, "agent", "state", "--root", root], { encoding: "utf8" }));
  assert.equal(stateOutput.status, "No active webapp session state has been published yet.");

  const annotation = JSON.parse(execFileSync(process.execPath, [cli, "agent", "annotate", "--root", root, "--path", "docs/guide.md", "--note", "Review this with the user."], { encoding: "utf8" }));
  assert.equal(annotation.annotation.path, "docs/guide.md");

  const queue = JSON.parse(execFileSync(process.execPath, [cli, "agent", "queue", "--root", root], { encoding: "utf8" }));
  assert.match(queue.note, /Human verification/);

  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /context-room agent state/);
  assert.doesNotMatch(help, /agent verify/);
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

test("doc QA can require human review for unchanged important docs", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"], watchAllow: [] });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  fs.writeFileSync(path.join(root, "docs", "INDEX.md"), "# Index\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["AGENTS.md", "docs/INDEX.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), ["AGENTS.md", "docs/INDEX.md"]);
  assert.equal(report.summary.changedDocs, 0);
  assert.equal(report.summary.needsReview, 2);
  assert.equal(report.summary.requiredReview, 2);
  assert.equal(report.queue[0].reviewRequired, true);

  writeDocReviewDecision(root, "AGENTS.md", { status: "verified" });
  const afterOneReview = buildDocQaReport(root);
  assert.deepEqual(afterOneReview.queue.map((item) => item.path), ["docs/INDEX.md"]);

  writeDocReviewDecision(root, "docs/INDEX.md", { status: "verified" });
  const afterAllReviews = buildDocQaReport(root);
  assert.deepEqual(afterAllReviews.queue.map((item) => item.path), []);
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
  assert.equal(config.markdownTemplates[0]?.id, "blank");
  assert.ok(config.markdownTemplates.some((template) => template.id === "context-golden"));

  const blank = DEFAULT_MARKDOWN_TEMPLATES.find((template) => template.id === "blank");
  assert.ok(blank);
  assert.equal(blank.title, "Blank");
  assert.equal(blank.content, "");

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

test("createMarkdownFile can create where clicked by registering the exact new file", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  fs.mkdirSync(path.join(root, "website"), { recursive: true });

  const result = createMarkdownFile(root, { path: "website/test.md", title: "Test" });
  const rootResult = createMarkdownFile(root, { path: "root-note.md", title: "Root note" });
  const settings = readMemoryWebappSettings(root);

  assert.equal(result.path, "website/test.md");
  assert.equal(rootResult.path, "root-note.md");
  assert.equal(fs.readFileSync(path.join(root, "website", "test.md"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(root, "root-note.md"), "utf8"), "");
  assert.ok(settings.allowedPaths.includes("website/test.md"));
  assert.ok(settings.allowedPaths.includes("root-note.md"));
  assert.ok(settings.watchAllow.includes("website/test.md"));
  assert.ok(settings.watchAllow.includes("root-note.md"));
  assert.equal(settings.allowedPaths.includes("website/"), false);
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
  assert.throws(
    () => createMarkdownFile(root, { path: ".context-room/private.md", title: "Private", templateId: "context-golden" }),
    /not allowed/,
  );
});

test("createFolder writes folders where clicked by registering the exact new folder", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const result = createFolder(root, { path: "docs/new-section" });
  const outside = createFolder(root, { path: "website/new-section" });
  const settings = readMemoryWebappSettings(root);

  assert.equal(result.path, "docs/new-section/");
  assert.equal(outside.path, "website/new-section/");
  assert.equal(fs.statSync(path.join(root, "docs/new-section")).isDirectory(), true);
  assert.equal(fs.statSync(path.join(root, "website/new-section")).isDirectory(), true);
  assert.ok(settings.allowedPaths.includes("website/new-section/"));
  assert.ok(settings.watchAllow.includes("website/new-section/"));
  assert.equal(settings.allowedPaths.includes("website/"), false);
  fs.writeFileSync(path.join(root, "docs/current.md"), "# Current\n");
  assert.throws(() => createFolder(root, { path: "docs/current.md" }), /already exists/);
  assert.throws(() => createFolder(root, { path: ".context-room/new-section" }), /not allowed/);
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
    { id: "blank", title: "Blank", description: "Start empty", content: "", enabled: true },
    { id: "published", title: "Published", description: "Ready to use", content: "# {{title}}\n", enabled: true },
    { id: "draft", title: "Draft", description: "Still being developed", content: "# Draft\n", enabled: false },
  ];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const settings = readMemoryWebappSettings(root);
  assert.equal(settings.markdownTemplates.length, 3);
  assert.equal(settings.markdownTemplates.find((template) => template.id === "blank")?.content, "");
  assert.equal(settings.markdownTemplates.find((template) => template.id === "draft")?.enabled, false);

  const html = renderTemplateOptionsMarkup(settings.markdownTemplates);
  assert.match(html, /Blank/);
  assert.match(html, /Published/);
  assert.doesNotMatch(html, /Draft/);
});

test("file template selector applies templates immediately while content is untouched", () => {
  const html = renderAppHtml();

  assert.match(html, /data-empty-template-select/);
  assert.doesNotMatch(html, /data-apply-template/);
  assert.doesNotMatch(html, /Use template/);
  assert.match(html, /function renderFileTemplateOptions\(selectedId = ""\)/);
  assert.match(html, /Choose template\.\.\./);
  assert.match(html, /function templateStateForContent\(text\)/);
  assert.match(html, /const blank = templates\.find\(\(template\) => template\.id === "blank"\);/);
  assert.match(html, /return \{ selectedId: blank\?\.id \|\| "" \};/);
  assert.match(html, /templates\.find\(\(template\) => renderTemplateForSelectedPath\(template\.id\) === current\)/);
  assert.match(html, /function renderTemplateForSelectedPath\(templateId\)/);
  assert.match(html, /function applySelectedTemplateToEditor\(templateId\)/);
  assert.match(html, /if \(!templateId\) return;/);
  assert.match(html, /state\.dirty = rendered !== state\.saved/);
  assert.match(html, /\[data-empty-template-select\]"\)\?\.addEventListener\("change", \(event\) => applySelectedTemplateToEditor\(event\.currentTarget\.value\)\)/);
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
  assert.match(html, /id="contextMarkdownError" class="explorer-context-error" hidden/);
  assert.match(html, /id="contextCreateFolder" class="primary"/);
  assert.match(html, /explorer-context-actions form-actions/);
  assert.match(html, /<label class="explorer-context-label" for="contextMarkdownTitle">Name<\/label>/);
  assert.match(html, /<label class="explorer-context-label" for="contextFolderPath">Path<\/label>/);
});

test("explorer rendering uses a cache and delegated tree events", () => {
  const html = renderAppHtml();

  assert.match(html, /explorerRenderKey:\s*""/);
  assert.match(html, /function explorerRenderKey\(files\)/);
  assert.match(html, /if \(!force && state\.explorerRenderKey === nextKey\)/);
  assert.match(html, /function wireExplorerTreeEvents\(\)/);
  assert.match(html, /holder\.dataset\.wired === "true"/);
  assert.match(html, /holder\.addEventListener\("click", \(event\) =>/);
  assert.match(html, /holder\.addEventListener\("contextmenu", \(event\) =>/);
  assert.doesNotMatch(html, /document\.querySelectorAll\("\\[data-file-path\\]"\)\.forEach\(\(button\) => \{\s*button\.addEventListener\("click"/);
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
  assert.match(menu, /New file[\s\S]*<code>project root<\/code>/);
  assert.match(menu, /data-context-new-file/);
  assert.match(menu, /data-context-new-folder/);
  assert.doesNotMatch(menu, /data-context-watch/);
  assert.doesNotMatch(menu, /data-context-select/);
  assert.doesNotMatch(menu, /data-context-delete/);
  assert.match(html, /function openExplorerEmptyContextMenu\(event\)/);
  assert.match(html, /document\.querySelector\("aside"\)\?\.addEventListener\("contextmenu", openExplorerEmptyContextMenu\)/);
  assert.match(html, /openExplorerContextMenu\(event, \{ kind: "folder", path: "" \}\)/);
});

test("explorer explicit folder context menu keeps the clicked folder target", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "website/docs",
    directory: "website/docs",
    settings: {
      ...readMemoryWebappSettings(makeRoot()),
      allowedPaths: ["docs/", "website/docs/"],
    },
  });
  const html = renderAppHtml();

  assert.match(menu, /data-context-new-file/);
  assert.match(menu, /data-context-new-folder/);
  assert.match(menu, /New file[\s\S]*<code>website\/docs<\/code>/);
  assert.doesNotMatch(menu, /New file[\s\S]*<code>docs<\/code>/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(target = state\.explorerContextTarget\) \{[\s\S]*return directory;/);
});

test("explorer folder context menu offers creation without broadening the folder allowlist", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "website",
    directory: "website",
    settings: {
      ...readMemoryWebappSettings(makeRoot()),
      allowedPaths: ["docs/", "website/docs/"],
    },
  });
  const html = renderAppHtml();
  const actionList = menu.match(/<div class="explorer-context-actions menu-actions" data-context-action-list>([\s\S]*?)<\/div>/)?.[1] || "";

  assert.match(menu, /Actions[\s\S]*<code>website<\/code>/);
  assert.match(actionList, /data-context-new-file/);
  assert.match(actionList, /data-context-new-folder/);
  assert.match(actionList, /data-context-watch/);
  assert.match(actionList, /data-context-select/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(/);
});

test("explorer new file creates markdown directly before opening it", () => {
  const html = renderAppHtml();
  const createMarkdownFn = html.match(/async function createMarkdownFromContextMenu\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(html, /id="newDocPage" class="settings-page" hidden/);
  assert.match(html, /function showNewDocPage\(/);
  assert.match(html, /function renderNewDocPanel\(/);
  assert.match(html, /placeholder="File name"/);
  assert.match(html, /data-structured-doc-form/);
  assert.match(html, /id="markdownCreateFolder" type="hidden"/);
  assert.match(html, /id="markdownCreateFolderDisplay"/);
  assert.match(html, /class="locked-folder-display"/);
  assert.match(html, /id="markdownCreateFileName"/);
  assert.match(html, /id="markdownCreatePath" type="hidden"/);
  assert.match(html, /id="markdownCreatePathPreview"/);
  assert.match(html, /function pathFolderLabel\(/);
  assert.match(html, /function updateStructuredMarkdownPath\(/);
  assert.match(createMarkdownFn, /api\("\/api\/markdown\/create"/);
  assert.match(createMarkdownFn, /const directory = markdownCreateDirectoryForTarget\(\);/);
  assert.match(createMarkdownFn, /body:\s*JSON\.stringify\(\{ path: relPath, title, applyTemplate: false \}\)/);
  assert.match(createMarkdownFn, /await loadFiles\(\);[\s\S]*await selectFile\(result\.path, \{ revealInExplorer: true \}\)/);
  assert.doesNotMatch(createMarkdownFn, /showNewDocPage/);
  assert.match(html, /function submitMarkdownFromContextMenu\(\)/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(target = state\.explorerContextTarget\) \{[\s\S]*return directory;/);
  assert.doesNotMatch(html, /function firstAllowedMarkdownCreateDirectory\(/);
  assert.doesNotMatch(html, /function isAllowedUiMemoryPath\(/);
  assert.match(html, /button\.textContent = "Creating\.\.\."/);
  assert.match(html, /function setContextMarkdownError\(message\)/);
  assert.match(html, /\.explorer-context-error\s*\{[^}]*rgba\(255,140,157,0\.10\)/);
  assert.doesNotMatch(html, /function createStructuredMarkdownFromHub/);
  assert.doesNotMatch(html, /<select id="markdownCreateFolder"/);
  assert.doesNotMatch(html, /id="markdownCreateFolderButton"/);
  assert.doesNotMatch(html, /id="markdownCreateFolderEntry"/);
  assert.doesNotMatch(html, /id="markdownCreateFolderMenu"/);
  assert.doesNotMatch(html, /<label for="markdownCreatePath">Path<\/label><input id="markdownCreatePath"/);
});

test("app CSS keeps hidden context menu forms hidden despite form display rules", () => {
  const html = renderAppHtml();

  assert.match(html, /data-template-enabled/);
  assert.match(html, /Show in selector/);
  assert.match(html, /\.explorer-context-form\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-actions\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-menu \{[^}]*width:\s*min\(248px,/);
  assert.match(html, /\.explorer-context-actions\.form-actions\s*\{\s*grid-template-columns:\s*1fr 1fr/);
  assert.match(html, /\.explorer-context-menu \.explorer-context-actions button\s*\{[^}]*padding:\s*8px 10px/);
  assert.match(html, /\.tree\s*\{[^}]*min-height:\s*180px/);
  assert.match(html, /select option\s*\{\s*color:\s*#111827;\s*background:\s*#ffffff;\s*\}/);
  assert.match(html, /select option:checked\s*\{\s*color:\s*#07101e;\s*background:\s*#93c5fd;\s*\}/);
  assert.match(html, /\.markdown-create\s*\{[^}]*grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.path-picker-main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.35fr\) minmax\(220px, 0\.65fr\)/);
  assert.match(html, /\.locked-folder-display\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(html, /\.locked-folder-display code\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(html, /\.path-picker-preview\s*\{[^}]*background:\s*rgba\(139,211,255,0\.06\)/);
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
  assert.match(html, /\.hub-folder-card-main\s*\{[^}]*min-height:\s*132px;[^}]*padding:\s*var\(--space-5\)/);
  assert.match(html, /\.hub-folder-card strong\s*\{[^}]*letter-spacing:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(html, /\.hub-folder-meta code\s*\{\s*flex:\s*1 1 auto;\s*\}/);
});

test("card hover spotlight follows the pointer without intercepting clicks", () => {
  const html = renderAppHtml();

  assert.match(html, /--spotlight-x:\s*50%;\s*--spotlight-y:\s*50%/);
  assert.match(html, /radial-gradient\(360px circle at var\(--spotlight-x\) var\(--spotlight-y\)/);
  assert.match(html, /pointer-events:\s*none/);
  assert.match(html, /\.hub-folder-card\.spotlight-active::before/);
  assert.match(html, /\.settings-section\.spotlight-active::before/);
  assert.match(html, /\.hub-card-editor\.spotlight-active::before/);
  assert.match(html, /\.startup-skill-folder::before\s*\{\s*display:\s*none/);
  assert.match(html, /const SPOTLIGHT_CARD_SELECTOR = ".*\.hub-folder-card.*\.startup-context-item:not\(\.startup-skill-folder\).*\.settings-section.*\.hub-card-editor/);
  assert.match(html, /function updateCardSpotlightAt\(x, y\)/);
  assert.match(html, /function scheduleCardSpotlightUpdate\(\)/);
  assert.match(html, /spotlightFrame = window\.requestAnimationFrame/);
  assert.match(html, /document\.elementFromPoint\(x, y\)/);
  assert.match(html, /function updateCardSpotlight\(event\)/);
  assert.match(html, /scheduleCardSpotlightUpdate\(\);/);
  assert.match(html, /function refreshCardSpotlightAfterScroll\(\)/);
  assert.match(html, /document\.addEventListener\("pointermove", updateCardSpotlight, \{ passive: true \}\)/);
  assert.match(html, /document\.addEventListener\("scroll", refreshCardSpotlightAfterScroll, \{ capture: true, passive: true \}\)/);
});

test("rendered app supports selectable file themes and colored markdown reading", () => {
  const html = renderAppHtml();

  assert.match(html, /data-file-theme="context-room"/);
  assert.match(html, /const FILE_THEMES = \[/);
  assert.match(html, /"vscode-dark"/);
  assert.match(html, /"dracula"/);
  assert.match(html, /id="fileTheme"/);
  assert.match(html, />App theme<\/label>/);
  assert.match(html, /id="autoOpenGitDiff"/);
  assert.match(html, /<strong>Auto-open Git diff<\/strong>/);
  assert.match(html, /class="settings-shell"/);
  assert.match(html, /function renderSettingsSection\(\{ kicker, title, copy/);
  assert.match(html, /'<details class="settings-section collapsible" '/);
  assert.match(html, /kicker:\s*"Review"[\s\S]*title:\s*"Watched docs"/);
  assert.match(html, /kicker:\s*"Startup"[\s\S]*title:\s*"Injected context scanners"/);
  assert.match(html, /kicker:\s*"Appearance"[\s\S]*title:\s*"Theme and diff behavior"/);
  assert.match(html, /kicker:\s*"Templates"[\s\S]*title:\s*"Markdown document templates"[\s\S]*open:\s*false/);
  assert.match(html, /kicker:\s*"Hub"[\s\S]*title:\s*"Sections and cards"[\s\S]*open:\s*false/);
  assert.match(html, /\.settings-section-head\s*\{[^}]*display:\s*flex/);
  assert.match(html, /\.settings-section\.collapsible:not\(\[open\]\) > \.settings-section-head/);
  assert.match(html, /\.settings-section\.collapsible:not\(\[open\]\) > \.settings-section-body\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.template-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.hub-section-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.hub-card-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.settings-section-toggle/);
  assert.match(html, /\.settings-toggle\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(html, /\.settings-footer\s*\{[^}]*position:\s*sticky/);
  assert.match(html, /button\.save-pending, \.file-action\.save-pending/);
  assert.match(html, /button\.save-confirmed, \.file-action\.save-confirmed/);
  assert.match(html, /@keyframes savePendingSweep/);
  assert.match(html, /@keyframes saveConfirmPulse/);
  assert.match(html, /class="settings-theme-preview"/);
  assert.match(html, /id="settingsThemePreviewName"/);
  assert.match(html, /SETTINGS_THEME_PREVIEW_DOC/);
  assert.match(html, /function normalizeFileThemeId\(wanted\)/);
  assert.match(html, /function applyFileTheme\(themeId = currentFileThemeId\(\)\)/);
  assert.match(html, /document\.documentElement\.dataset\.appTheme = clean;/);
  assert.match(html, /function previewSelectedFileTheme\(\)/);
  assert.match(html, /el\("fileTheme"\)\?\.addEventListener\("change", previewSelectedFileTheme\)/);
  assert.match(html, /function markButtonSaving\(button, label = "Saving\.\.\."\)/);
  assert.match(html, /function restoreButtonLabel\(button\)/);
  assert.match(html, /function flashSavedButton\(button, label = "Saved"\)/);
  assert.match(html, /markButtonSaving\(saveButton\)/);
  assert.match(html, /flashSavedButton\(el\("saveSettings"\), "Saved"\)/);
  assert.match(html, /flashSavedButton\(document\.querySelector\("\[data-file-save\]"\), "Saved"\)/);
  assert.match(html, /el\("saveSettings"\)\?\.addEventListener\("click", \(\) => saveSettings\(\)\.catch\(\(error\) => setStatus\(error\.message\)\)\)/);
  assert.match(html, /function autoOpenGitDiffEnabled\(\)/);
  assert.match(html, /function collapsedByGitDiffPreference\(diff\)/);
  assert.match(html, /autoOpenGitDiff:\s*el\("autoOpenGitDiff"\)\?\.checked !== false/);
  assert.match(html, /renderFileThemeOptions\(appearance\.fileTheme\)/);
  assert.match(html, /:root\[data-file-theme="dracula"\]\s*\{[\s\S]*--bg:\s*#282a36;[\s\S]*--panel:/);
  assert.match(html, /:root\[data-file-theme="light-plus"\]\s*\{[\s\S]*color-scheme:\s*light;[\s\S]*--bg:\s*#f6f8fa;[\s\S]*--on-accent:\s*#ffffff/);
  assert.match(html, /body\s*\{[\s\S]*radial-gradient\(circle at top left, var\(--body-glow-1\)/);
  assert.match(html, /aside\s*\{[^}]*background:\s*var\(--surface-sidebar\)/);
  assert.match(html, /\.docqa-home\s*\{[^}]*background:\s*radial-gradient\(circle at 18% 0%, var\(--body-glow-3\)/);
  assert.match(html, /--space-1:\s*4px;[\s\S]*--space-6:\s*24px;[\s\S]*--page-padding:\s*var\(--space-6\)/);
  assert.match(html, /\.workspace-dock\s*\{[^}]*display:\s*inline-flex;[^}]*padding:\s*var\(--space-1\);[^}]*background:\s*var\(--surface-floating-soft\)/);
  assert.match(html, /\.dock-button\s*\{[^}]*min-width:\s*var\(--control-height\);[^}]*min-height:\s*var\(--control-height\);[^}]*padding:\s*0 var\(--space-3\)/);
  assert.match(html, /\.workspace-dock \.dock-button\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
  assert.match(html, /id="gitDiffToggle" class="dock-button diff-dock-button" type="button" title="Show Git diff" hidden>Show Git diff<\/button>/);
  assert.match(html, /\.dock-button\.diff-dock-button\s*\{[^}]*margin-left:\s*var\(--space-1\);[^}]*padding:\s*0 var\(--space-3\)/);
  assert.match(html, /const gitDiffButton = el\("gitDiffToggle"\)/);
  assert.match(html, /gitDiffButton\.textContent = state\.diffCollapsed \? "Show Git diff" : "Hide Git diff"/);
  assert.match(html, /el\("gitDiffToggle"\)\.addEventListener\("click", \(\) => \{[\s\S]*setDiffCollapsed\(!state\.diffCollapsed\);[\s\S]*\}\);/);
  assert.doesNotMatch(html, /class="diff-toggle" type="button" data-show-diff/);
  assert.match(html, /function renderMarkdownLineView\(text, options = \{\}\)/);
  assert.match(html, /id="docReader" class="doc-editor markdown-view"/);
  assert.match(html, /function renderMarkdownEditor\(text\)/);
  assert.match(html, /id="docHighlighter" class="doc-editor markdown-view markdown-editor-highlight"/);
  assert.match(html, /data-heading-text/);
  assert.match(html, /\.markdown-line\.h1\s*\{[^}]*color:\s*var\(--file-h1\)/);
  assert.match(html, /\.markdown-inline-code/);
  assert.match(html, /\.markdown-path\s*\{[^}]*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-path\[data-doc-link-path\]\s*\{[^}]*cursor:\s*pointer[^}]*background-image:\s*linear-gradient/);
  assert.match(html, /\.markdown-path\[data-doc-link-path\]:hover, \.markdown-path\[data-doc-link-path\]\.doc-link-hover-target, \.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]:hover\s*\{[^}]*animation:\s*docLinkClickableSweep/);
  assert.match(html, /\.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]\s*\{[^}]*background-color/);
  assert.match(html, /@keyframes docLinkClickableSweep/);
  assert.match(html, /\.markdown-doc-link\s*\{[^}]*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-inline-code\.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-editor-shell\s*\{[^}]*isolation:\s*isolate/);
  assert.match(html, /\.markdown-editor-highlight\s*\{[^}]*z-index:\s*1/);
  assert.match(html, /\.markdown-editor-input\s*\{[^}]*position:\s*absolute;[^}]*-webkit-text-fill-color:\s*transparent !important/);
  assert.match(html, /\.markdown-editor-input\.doc-link-hover\s*\{\s*cursor:\s*pointer;\s*\}/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.h1\s*\{\s*color:\s*var\(--file-h1\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.h2\s*\{\s*color:\s*var\(--file-h2\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.list \.markdown-marker, \.markdown-editor-highlight \.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-inline-code\s*\{\s*color:\s*var\(--file-code\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-inline-code\.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /function isMarkdownPathToken\(value\)/);
  assert.match(html, /function resolveDocLinkPath\(rawTarget\)/);
  assert.match(html, /function markdownDocLinkAttributes\(rawTarget\)/);
  assert.match(html, /data-doc-link-path/);
  assert.match(html, /data-doc-link-resolved/);
  assert.match(html, /Ctrl\/Cmd-click to open/);
  assert.match(html, /function wireMarkdownDocLinks\(root = document\)/);
  assert.match(html, /if \(element\.tagName === "A"\) event\.preventDefault\(\);/);
  assert.match(html, /function wireMarkdownEditorDocLinks\(editor\)/);
  assert.match(html, /function markdownDocLinkAtPoint\(clientX, clientY\)/);
  assert.match(html, /function markdownDocLinkElementAtPoint\(clientX, clientY\)/);
  assert.match(html, /function updateMarkdownEditorDocLinkHover\(editor, event\)/);
  assert.match(html, /function clearMarkdownEditorDocLinkHover\(editor = el\("docEditor"\)\)/);
  assert.match(html, /editor\.addEventListener\("pointermove", \(event\) => updateMarkdownEditorDocLinkHover\(editor, event\), \{ passive: true \}\)/);
  assert.match(html, /editor\.addEventListener\("pointerleave", \(\) => clearMarkdownEditorDocLinkHover\(editor\), \{ passive: true \}\)/);
  assert.match(html, /highlighter\.style\.pointerEvents = "auto";[\s\S]*editor\.style\.pointerEvents = "none";/);
  assert.match(html, /editor\.classList\.toggle\("doc-link-hover", Boolean\(target\)\)/);
  assert.match(html, /target\.classList\.add\("doc-link-hover-target"\)/);
  assert.match(html, /document\.elementsFromPoint\(clientX, clientY\)/);
  assert.match(html, /markdownDocLinkAtPoint\(event\.clientX, event\.clientY\) \|\| markdownDocLinkAtOffset/);
  assert.match(html, /function markdownDocLinkAtOffset\(text, offset\)/);
  assert.match(html, /wireMarkdownDocLinks\(\);/);
  assert.match(html, /wireMarkdownEditorDocLinks\(docEditor\);/);
  assert.match(html, /function setDocLinkModifierActive\(active\)/);
  assert.match(html, /document\.documentElement\.classList\.toggle\("doc-link-modifier-active", Boolean\(active\)\)/);
  assert.match(html, /setDocLinkModifierActive\(event\.ctrlKey \|\| event\.metaKey\)/);
  assert.match(html, /document\.addEventListener\("keyup", \(event\) => setDocLinkModifierActive\(event\.ctrlKey \|\| event\.metaKey\)\)/);
  assert.match(html, /if \(!event\.ctrlKey && !event\.metaKey\) return;/);
  assert.match(html, /openMarkdownDocLink\(target\)/);
  assert.match(html, /selectFile\(resolved, \{ revealInExplorer: true \}\)/);
  assert.match(html, /markdown-inline-code' \+ \(isMarkdownPathToken\(token\) \? ' markdown-path' : ''\) \+ '"' \+ docLinkAttrs/);
  assert.match(html, /function updateMarkdownEditorHighlight\(text, options = \{\}\)/);
  assert.match(html, /state\.markdownHighlightFrame = window\.requestAnimationFrame/);
  assert.match(html, /function renderMarkdownEditorHighlightNow\(text\)/);
  assert.match(html, /state\.markdownHighlightLastText = docEditor\.value;/);
  assert.doesNotMatch(html, /syncMarkdownEditorHighlight/);
  assert.match(html, /function syncMarkdownEditorScroll\(\)/);
  assert.match(html, /function scrollMarkdownViewToNeedle\(needle, type = "text"\)/);
  assert.match(html, /function visibleMarkdownReader\(\)/);
  assert.match(html, /const reader = el\("docReader"\) \|\| el\("docHighlighter"\);/);
  assert.match(html, /visibleMarkdownReader\(\) \|\| activeEditor\(\) \|\| el\("viewer"\)/);
});

test("normal and startup files open directly editable while review mode owns verification", () => {
  const html = renderAppHtml();

  assert.match(html, /async function selectFile\(path, options = \{\}\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /async function selectStartupContextFile\(order\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /async function selectStartupSkillFile\(folderOrder, skillName\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /state\.mode === "edit"\s*\?\s*renderMarkdownEditor\(text\)/);
  assert.match(html, /writeSelectedDiskFile\(content\)/);
  assert.match(html, /api\("\/api\/startup-context\/file", \{/);
  assert.match(html, /api\("\/api\/startup-skills\/file", \{/);
  assert.match(html, /reviewAction: isStartupFile \? null : reviewActionForSelectedFile\(\)/);
  assert.match(html, /deletable: !isStartupFile/);
  assert.match(html, /el\("viewer"\)\.hidden = false;\s*el\("editor"\)\.hidden = true;\s*renderPlanetSystem\(\);/);
  assert.doesNotMatch(html, /data-file-mode-toggle/);
});

test("verification actions are limited to files opened from the review queue and can be undone", () => {
  const html = renderAppHtml();

  assert.match(html, /reviewModePath: null, reviewModeStatus: null/);
  assert.match(html, /selectFile\(button\.dataset\.reviewPath, \{ revealInExplorer: !isNarrowLayout\(\), reviewMode: true \}\)/);
  assert.match(html, /state\.reviewModePath = options\.reviewMode \? path : null;/);
  assert.match(html, /function reviewActionForSelectedFile\(\)/);
  assert.match(html, /if \(!state\.selected \|\| state\.reviewModePath !== state\.selected\) return null;/);
  assert.match(html, /status: "unverified", label: "Mark unverified"/);
  assert.match(html, /data-file-review-decision/);
  assert.match(html, /applyReviewDecision\(state\.selected, event\.currentTarget\.dataset\.fileReviewDecision\)/);
  assert.match(html, /status === "unverified"/);
  assert.doesNotMatch(html, /selectedFileNeedsReview/);
  assert.doesNotMatch(html, /data-file-verify/);
});

test("save preserves the editor scroll position after rerendering", () => {
  const html = renderAppHtml();

  assert.match(html, /const viewState = captureEditorViewState\(\);/);
  assert.match(html, /renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /function isScrollableY\(element\)/);
  assert.match(html, /function activeDocumentScrollTarget\(\)/);
  assert.match(html, /const documentSurface = document\.querySelector\("\.external-review-doc"\) \|\| el\("docEditor"\) \|\| el\("docReader"\);/);
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
  assert.match(html, /snapshot\.documentScrollTarget === "docReader"/);
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

test("rendered app exposes agent collaboration hooks without human review bypass", () => {
  const html = renderAppHtml();

  assert.match(html, /id="agentToast"/);
  assert.match(html, /function buildSessionStatePayload\(\)/);
  assert.match(html, /function activeEditorCaretLineIndex\(editor\)/);
  assert.match(html, /api\("\/api\/session-state"/);
  assert.match(html, /function startAgentCommandPolling\(\)/);
  assert.match(html, /api\("\/api\/agent\/command"\)/);
  assert.match(html, /function executeAgentCommand\(command\)/);
  assert.match(html, /function applyAgentScrollTarget\(command\)/);
  assert.match(html, /function renderAgentAnnotations\(path\)/);
  assert.match(html, /api\("\/api\/agent\/annotations\?path="/);
  assert.match(html, /api\("\/api\/agent\/annotations\/resolve"/);
  assert.match(html, /\.agent-annotation/);
  assert.match(html, /\.agent-toast/);
  assert.doesNotMatch(html, /agent\/verify/);
  assert.doesNotMatch(html, /agent[\s\S]{0,120}\/api\/docqa\/review/);
});

test("disk changes stay pending for review instead of silently reloading the open file", () => {
  const html = renderAppHtml();

  assert.match(html, /externalChange: null/);
  assert.match(html, /openingFilePath: null/);
  assert.match(html, /function activeExternalChange\(\)/);
  assert.match(html, /external-review-doc/);
  assert.match(html, /external-review-block change/);
  assert.match(html, /external-review-line/);
  assert.match(html, /Document with disk changes highlighted/);
  assert.match(html, /data-external-block-decision="accept"/);
  assert.match(html, /data-external-block-decision="reject"/);
  assert.match(html, /data-external-block-id/);
  assert.match(html, /data-external-review-all="accept"/);
  assert.match(html, /data-external-review-all="reject"/);
  assert.match(html, />OK<\/button>/);
  assert.match(html, />x<\/button>/);
  assert.match(html, />Accept all<\/button>/);
  assert.match(html, />Reject all<\/button>/);
  assert.match(html, /buildExternalReviewBlocks/);
  assert.match(html, /chooseExternalReviewBlock/);
  assert.match(html, /function chooseAllExternalReviewBlocks\(decision\)/);
  assert.match(html, /function wireExternalReviewAllButtons\(root = document\)/);
  assert.match(html, /updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /function updateExternalReviewDocumentInPlace\(blocks\)/);
  assert.match(html, /const settlePromise = updatedInPlace[\s\S]*settleExternalReviewBlocks\(\[blockId\], viewState, \{ restoreScroll: false \}\)/);
  assert.match(html, /if \(pending\.length\)[\s\S]*await waitForInlineReviewTransition\(settlePromise\);/);
  assert.match(html, /const updatedInPlace = updateExternalReviewBlockInPlace\(blocks, blockId, viewState\);[\s\S]*if \(!updatedInPlace\) renderViewer\(\);\s*updateHeader\(\);/);
  assert.doesNotMatch(html, /actions\.outerHTML = renderExternalReviewActions/);
  assert.match(html, /externalReviewRowsForDecision/);
  assert.match(html, /external-review-block context resolved/);
  assert.match(html, /external-review-block context resolved [^"]*empty/);
  assert.doesNotMatch(html, /external-review-resolved-label/);
  assert.doesNotMatch(html, /external-review-placeholder/);
  assert.doesNotMatch(html, /Change rejected/);
  assert.doesNotMatch(html, /Change accepted/);
  assert.match(html, /computeExternalReviewContent/);
  assert.match(html, /renderExternalReviewDocument/);
  assert.match(html, /renderExternalReviewActions/);
  assert.match(html, /function renderFileActionItems\(/);
  assert.match(html, /function externalReviewFileActionOptions\(\)/);
  assert.match(html, /renderExternalReviewActions\(externalChange, \{ fileActionOptions: externalReviewFileActionOptions\(\) \}\)/);
  assert.match(html, /blockedByConflict:\s*true/);
  assert.match(html, /summary\.pending > 1 \|\| summary\.pendingLines > 1/);
  assert.match(html, /pendingBlock && \(row\.type === "add" \|\| row\.type === "del"\)/);
  assert.match(html, /state\.externalChange = \{[\s\S]*reviewDecisions: \{\},[\s\S]*\};\s*state\.selectedDiff = diff;\s*state\.diffCollapsed = true;/);
  assert.match(html, /state\.openingFilePath = path;[\s\S]*state\.savedHash = data\.contentHash;[\s\S]*state\.openingFilePath = null;/);
  assert.match(html, /if \(state\.openingFilePath === state\.selected \|\| state\.savedHash == null\) return;/);
  assert.match(html, /if \(!state\.selected \|\| !state\.dirty \|\| state\.openingFilePath === state\.selected \|\| state\.savedHash == null\) return;/);
  assert.match(html, /const viewState = captureEditorViewState\(\);[\s\S]*state\.externalChange = \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /const previousHeight = current\.getBoundingClientRect\(\)\.height;/);
  assert.match(html, /next\.style\.minHeight = Math\.ceil\(previousHeight\) \+ "px"/);
  assert.match(html, /function waitForInlineReviewTransition\(settlePromise = null\)/);
  assert.match(html, /await waitForInlineReviewTransition\(settlePromise\)/);
  assert.match(html, /function externalReviewTextAnchor\(blocks, blockId, mergedText\)/);
  assert.match(html, /viewState\.textAnchor = externalReviewTextAnchor\(blocks, viewState\.anchorBlockId, merged\);/);
  assert.match(html, /function textOffsetForLineIndex\(lines, lineIndex\)/);
  assert.match(html, /function finishExternalReviewPanelInPlace\(viewState\)/);
  assert.match(html, /if \(!finishExternalReviewPanelInPlace\(viewState\)\) \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.doesNotMatch(html, /actions\.outerHTML = renderFileActionButtons\(\{/);
  assert.match(html, /function settleFinishedExternalReview\(viewState\)/);
  assert.doesNotMatch(html, /doc\.classList\.add\("settled"\)/);
  assert.match(html, /function settleExternalReviewBlocks\(blocksOrIds, viewState, options = \{\}\)/);
  assert.match(html, /const restoreScroll = options\.restoreScroll !== false/);
  assert.match(html, /!block\.classList\.contains\("settling"\) && !block\.classList\.contains\("settled"\)/);
  assert.match(html, /block\.classList\.add\("settled"\)/);
  assert.match(html, /settleFinishedExternalReview\(viewState\)\.then/);
  assert.match(html, /if \(!activeExternalChange\(\) && document\.querySelector\("\.external-review-doc"\)\) \{[\s\S]*renderViewer\(\);[\s\S]*restoreEditorViewState\(viewState\);/);
  assert.match(html, /\.external-review-block\.resolved\.settling\s*\{[^}]*height 2s ease[^}]*min-height 2s ease/);
  assert.match(html, /block\.classList\.add\("settling"\)/);
  assert.match(html, /const targetHeight = naturalExternalReviewBlockHeight\(block\);/);
  assert.match(html, /function naturalExternalReviewBlockHeight\(block\)/);
  assert.match(html, /clone\.classList\.remove\("settling"\);[\s\S]*clone\.classList\.add\("settled"\);/);
  assert.match(html, /function waitForExternalReviewBlockSettle\(block\)/);
  assert.match(html, /event\.target === block && event\.propertyName === "height"/);
  assert.match(html, /window\.setTimeout\(finish, 2400\)/);
  assert.doesNotMatch(html, /\.external-review-doc\.settled \.external-review-block\.resolved/);
  assert.match(html, /\.external-review-block\.resolved\.settled\.empty\s*\{[^}]*min-height:\s*0/);
  assert.match(html, /resetExternalChangeState\(\);\s*\/\/ Returning from inline review should keep[\s\S]*state\.diffCollapsed = true;/);
  assert.match(html, /block\.decision === "accept"[\s\S]*row\.type !== "del"/);
  assert.match(html, /block\.decision === "reject"[\s\S]*row\.type !== "add"/);
  assert.doesNotMatch(html, /external-review-block\.accept \.external-review-line\.del/);
  assert.doesNotMatch(html, /external-change-panel/);
  assert.match(html, /file changed on disk · review before applying/);
  assert.match(html, /function blockPendingExternalChange/);
  assert.match(html, /if \(blockPendingExternalChange\(delta < 0 \? "before going back" : "before going forward"\)\) return;/);
  assert.match(html, /const targetBlockId = closestExternalReviewChangeBlockId\(\);/);
  assert.match(html, /const focus = \(\) => focusExternalReviewChange\(targetBlockId\) \|\| focusNearestExternalReviewChange\(\);/);
  assert.match(html, /review the highlighted change/);
  assert.match(html, /function focusNearestExternalReviewChange\(\)/);
  assert.match(html, /function focusExternalReviewChange\(blockId\)/);
  assert.match(html, /function closestExternalReviewChangeElement\(\)/);
  assert.match(html, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center", inline: "nearest" \}\)/);
  assert.match(html, /\.external-review-block\.attention/);
  assert.match(html, /@keyframes externalReviewAttention/);
  assert.match(html, /if \(!state\.dirty && !activeExternalChange\(\)\) return;/);
  assert.match(html, /if \(activeExternalChange\(\)\) focusNearestExternalReviewChange\(\);/);
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
