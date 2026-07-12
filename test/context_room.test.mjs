#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AGENT_CONTEXT_DIR,
  AGENT_CONTEXT_FILE,
  CONFIG_DIR,
  CONFIG_FILE,
  GLOBAL_PREFERENCES_FILE,
  DEFAULT_MARKDOWN_TEMPLATES,
  CONCEPT_VISUAL_DOCUMENT_PATTERNS,
  DATA_VISUAL_DOCUMENT_PATTERNS,
  DIAGRAM_VISUAL_DOCUMENT_PATTERNS,
  FILE_THEME_OPTIONS,
  VISUAL_DOCUMENT_PATTERNS,
  acknowledgeContextHealthIssue,
  appendAgentAnnotation,
  applyMarkdownTemplateToFile,
  buildAgentBrief,
  buildAgentReviewQueue,
  buildContextRoomDoctorReport,
  buildContextRoomReports,
  buildDeletedReviewBatch,
  buildDocQaReport,
  buildDocumentationGraph,
  createStartupSkillFile,
  createFolder,
  createMarkdownFile,
  createMemoryServer,
  createDefaultProjectConfig,
  deleteStartupContextFile,
  deleteMemoryPaths,
  deleteStartupSkill,
  ensureRuntimeGitExcludes,
  hubSectionsForRoot,
  initializeContextRoomProject,
  isAllowedMemoryPath,
  listExplorerFiles,
  listMemoryFiles,
  listStartupContextFiles,
  listStartupHookFiles,
  listStartupSkillFolders,
  parseDocMetadata,
  readAgentAnnotations,
  readAgentCommand,
  readCollaborationSessionState,
  readContextHealthAcknowledgements,
  readFileDiff,
  readGlobalReviewLedger,
  readGlobalContextRoomPreferences,
  readMemoryFile,
  readMemoryWebappSettings,
  readResolvedContextRoomSettings,
  readReviewBaseFile,
  readStartupContextFile,
  readStartupHookFile,
  readStartupSkillFile,
  renderAppHtml,
  renderExplorerContextMenuMarkup,
  renderReviewSummary,
  renderTemplateOptionsMarkup,
  syncContextRoomAgentContext,
  revertMemoryFile,
  writeDocReviewBaseline,
  writeDeletedReviewBatchDecision,
  writeStartupContextFile,
  writeStartupHookFile,
  writeStartupSkillFile,
  writeAgentCommand,
  writeCollaborationSessionState,
  writeDocReviewDecision,
  writeGlobalContextRoomPreferences,
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
  assert.match(script, /function diffComparableLine\(line\)/);
  assert.match(script, /replace\(\/\^\(\\s\*last_verified\\s\*:\)\.\*\/, "\$1 #"\)/);
  assert.match(script, /replace\(\S+,\s*"\$1#\$2\$3"\)/);
  assert.match(script, /function diffLinesEqual\(leftLine, rightLine\)/);
  assert.match(script, /diffLinesEqual\(left\[i\], right\[j\]\)/);
  assert.match(script, /function reviewIdentityContentForUi\(content\)/);
  assert.match(script, /function onlyIgnoredReviewMetadataChanged\(leftContent, rightContent\)/);
});

test("app presents a compact review-first workspace", () => {
  const html = renderAppHtml();
  const asideEnd = html.indexOf("</aside>");
  const mainStart = html.indexOf("<main>", asideEnd);
  const dockStart = html.indexOf('class="workspace-dock"', mainStart);

  assert.ok(asideEnd >= 0 && mainStart > asideEnd && dockStart > mainStart);
  assert.match(html, /id="workspaceTitle" class="workspace-title">Context Room<\/div>/);
  assert.match(html, /<h2 id="reviewQueueHeading" tabindex="-1">Review queue<\/h2>/);
  assert.match(html, /hubDisclosuresOpen:\s*new Set\(\)/);
  assert.match(html, /data-hub-disclosure=/);
  assert.match(html, /@keyframes workbenchGridDrift/);
  assert.equal(
    renderReviewSummary({ changedDocs: 9, needsReview: 2 }),
    '<div class="review-summary-item"><strong>2</strong><span>to review</span></div>' +
      '<div class="review-summary-item"><strong>9</strong><span>changed</span></div>',
  );
});

test("app reveals one complete initial frame and keeps recurring refreshes in the background", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  const loadFilesSource = script.slice(script.indexOf("async function loadFiles"), script.indexOf("function reconcileMissingSelectedFile"));
  const diskRefreshSource = script.slice(script.indexOf("async function refreshFromDisk"), script.indexOf("function scheduleBackgroundRefresh"));

  assert.match(loadFilesSource, /const reportsRequest = options\.initial \? api\("\/api\/reports"\) : null;/);
  assert.match(loadFilesSource, /Promise\.all\(\[api\(filesApiPath\(\)\), api\("\/api\/settings"\)\]\)/);
  assert.match(loadFilesSource, /const restoreRequest = restoreNavigationAfterInitialLoad\(\);\s*const restored = await restoreRequest;/);
  assert.match(loadFilesSource, /const restored = await restoreRequest;/);
  assert.doesNotMatch(loadFilesSource, /await reportsRequest/);
  assert.match(loadFilesSource, /else if \(reportsRequest\) applyInitialReportsWhenReady\(reportsRequest\);/);
  assert.match(script, /function applyInitialReportsWhenReady\(reportsRequest\) \{[\s\S]*reportsRequest\.then\(\(reports\) => \{[\s\S]*requestAnimationFrame\(\(\) => window\.requestAnimationFrame\(\(\) => \{[\s\S]*applyBackgroundReportPayload\(reports\);[\s\S]*renderAfterBackgroundReportPayload\(\);/);
  assert.match(script, /function renderAfterBackgroundReportPayload\(\) \{[\s\S]*if \(state\.page === "file" && state\.selected && !state\.openingFilePath\) \{[\s\S]*renderViewer\(\);[\s\S]*restoreEditorViewState\(viewState\);/);
  assert.match(script, /function restoreNavigationAfterInitialLoad\(\)[\s\S]*void openRequest\.then\(\(\) => setStatus\("restored"\)\)/);
  assert.doesNotMatch(script, /await selectFile\(persisted\.selectedPath, options\)/);
  assert.match(html, /<body class="app-booting">/);
  assert.match(script, /loadFiles\(\{ initial: true \}\)[\s\S]*requestAnimationFrame\(finishInitialBoot\)/);
  assert.match(html, /body\.app-booting \.app \{ visibility: hidden; opacity: 0; pointer-events: none; \}/);
  assert.match(script, /const reportsPath = "\/api\/reports"/);
  assert.match(script, /readFileForOpen\(path, \{ force: options\.forceReload \}\)/);
  assert.match(diskRefreshSource, /const data = await readSelectedDiskFile\(previousSelected\)/);
  assert.doesNotMatch(diskRefreshSource, /Promise\.all\(\[[\s\S]*readSelectedDiff/);
  assert.match(script, /window\.setInterval\(\(\) => scheduleBackgroundRefresh\(\), 5_000\)/);
});

test("background report and diff endpoints preserve complete results", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupHooks.enabled = false;
  config.startupSkills.enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nUpdated.\n");

  const direct = buildContextRoomReports(root);
  assert.equal(direct.docqa.queue[0].path, "docs/guide.md");
  assert.equal(direct.doctor.docqa.needsReview, 1);

  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const [reportsResponse, diffResponse] = await Promise.all([
    fetch(baseUrl + "/api/reports?fresh=1"),
    fetch(baseUrl + "/api/file/diff?path=" + encodeURIComponent("docs/guide.md")),
  ]);
  const reports = await reportsResponse.json();
  const diff = await diffResponse.json();

  assert.equal(reportsResponse.status, 200);
  assert.equal(reports.docqa.queue[0].path, "docs/guide.md");
  assert.equal(diffResponse.status, 200);
  assert.equal(diff.changed, true);
  assert.match(diff.patch, /Updated\./);

  const sessionResponse = await fetch(baseUrl + "/api/session-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page: "hub", view: "hub" }),
  });
  assert.equal(sessionResponse.status, 200);
  const cachedReports = await (await fetch(baseUrl + "/api/reports")).json();
  assert.equal(cachedReports.generatedAt, reports.generatedAt);

  const writeResponse = await fetch(baseUrl + "/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs/guide.md", content: "# Guide\n\nUpdated through the API.\n" }),
  });
  assert.equal(writeResponse.status, 200);
  const refreshedReports = await (await fetch(baseUrl + "/api/reports")).json();
  assert.notEqual(refreshedReports.generatedAt, cachedReports.generatedAt);
  assert.equal(refreshedReports.docqa.queue[0].path, "docs/guide.md");
  const refreshedDiff = await (await fetch(baseUrl + "/api/file/diff?path=" + encodeURIComponent("docs/guide.md"))).json();
  assert.match(refreshedDiff.patch, /Updated through the API\./);
});

test("default config is project-agnostic and supports cards, nested cards, allowed paths, and watched paths", () => {
  const config = createDefaultProjectConfig({ title: "Demo Project" });

  assert.equal(CONFIG_DIR, ".context-room");
  assert.equal(CONFIG_FILE, ".context-room/config.json");
  assert.equal(config.title, "Demo Project");
  assert.match(config.$schema, /schemas\/config\.schema\.json$/);
  assert.deepEqual(config.watchAllow, []);
  assert.deepEqual(config.reviewPaths, []);
  assert.equal("appearance" in config, false);
  assert.deepEqual(config.startupSkills.folderNames, [".codex/skills", "skills"]);
  assert.equal(config.startupHooks.enabled, true);
  assert.equal(config.startupHooks.editable, false);
  assert.equal(config.startupHooks.agentHooks, true);
  assert.equal(config.startupHooks.codexHooks, true);
  assert.ok(config.startupHooks.fileNames.includes("pre-commit"));
  assert.ok(config.startupHooks.agentHookSources.some((source) => source.id === "codex" && source.paths.includes(".codex/hooks.json")));
  assert.ok(config.startupHooks.agentHookSources.some((source) => source.id === "claude-code" && source.paths.includes(".claude/settings.json")));
  assert.ok(config.startupHooks.agentHookPaths.includes(".codex/hooks.json"));
  assert.ok(config.startupHooks.agentHookPaths.includes(".claude/settings.json"));
  assert.ok(config.startupHooks.agentHookPaths.includes(".opencode/plugins/"));
  assert.ok(config.startupHooks.codexPaths.includes(".codex/hooks.json"));
  assert.ok(config.startupHooks.managerPaths.includes(".husky/"));
  assert.ok(FILE_THEME_OPTIONS.some((theme) => theme.id === "context-room"));
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
  assert.equal("appearance" in saved, false);
  assert.equal(JSON.stringify(saved).includes("Life OS"), false);
  assert.equal(JSON.stringify(saved).includes(".lifeos"), false);
  assert.equal(result.agentContextPath, path.join(root, AGENT_CONTEXT_FILE));
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_FILE)), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "README.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "html-visual-documents.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "html-visual-patterns.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "context-room-visual-components.html")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "context-room-data-visual-components.html")), true);
});

test("agent HTML context uses a stable project path and refreshes generated copies", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const entryPath = path.join(root, AGENT_CONTEXT_FILE);
  const legacyEntryPath = path.join(root, AGENT_CONTEXT_DIR, "README.md");
  const patternsPath = path.join(root, AGENT_CONTEXT_DIR, "html-visual-patterns.md");
  const canonicalPatterns = fs.readFileSync(new URL("../docs/features/html-visual-patterns.md", import.meta.url), "utf8");

  const entry = fs.readFileSync(entryPath, "utf8");
  assert.match(entry, /generated by Context Room/i);
  assert.match(entry, /## Workflow/);
  assert.match(entry, /## Choose The Visual/);
  assert.match(entry, /## Build The Document/);
  assert.match(entry, /## Interaction/);
  assert.match(entry, /## Theme Contract/);
  assert.match(entry, /automatically follows the active Context Room app theme/);
  assert.match(entry, /--cr-bg/);
  assert.match(entry, /Do not hard-code a page palette/);
  assert.match(entry, /## Where To Find HTML Examples/);
  assert.match(entry, /\.context-room\/agent-context\/context-room-visual-components\.html/);
  assert.match(entry, /\.context-room\/agent-context\/context-room-data-visual-components\.html/);
  assert.match(entry, /## Quality Gate/);
  assert.match(entry, /\[HTML visual patterns\]\(agent-context\/html-visual-patterns\.md\)/);
  assert.match(fs.readFileSync(legacyEntryPath, "utf8"), /\.context-room\/README\.md/);
  assert.equal(fs.readFileSync(patternsPath, "utf8"), canonicalPatterns);

  fs.writeFileSync(patternsPath, "stale generated copy\n", "utf8");
  const refreshed = syncContextRoomAgentContext(root);

  assert.equal(refreshed.entryPath, entryPath);
  assert.equal(refreshed.updated, 1);
  assert.equal(fs.readFileSync(patternsPath, "utf8"), canonicalPatterns);
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

test("appearance preferences are shared across Context Rooms and stay out of project config", async (t) => {
  const firstRoot = makeRoot();
  const secondRoot = makeRoot();
  const preferencesPath = path.join(makeRoot(), "preferences.json");
  initializeContextRoomProject(firstRoot, { allowedPaths: ["docs/"] });
  initializeContextRoomProject(secondRoot, { allowedPaths: ["docs/"] });

  assert.equal(GLOBAL_PREFERENCES_FILE, "~/.context-room/preferences.json");
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).appearance.autoOpenGitDiff, true);
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).appearance.showHiddenFiles, true);
  writeGlobalContextRoomPreferences({ appearance: { fileTheme: "dracula", autoOpenGitDiff: false, showHiddenFiles: false } }, preferencesPath);
  assert.deepEqual(readResolvedContextRoomSettings(firstRoot, { preferencesPath }).appearance, { fileTheme: "dracula", autoOpenGitDiff: false, showHiddenFiles: false });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).appearance, { fileTheme: "dracula", autoOpenGitDiff: false, showHiddenFiles: false });

  const { server } = createMemoryServer({ root: firstRoot, globalPreferencesPath: preferencesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { ...readMemoryWebappSettings(firstRoot), appearance: { fileTheme: "github-dark", autoOpenGitDiff: false, showHiddenFiles: true } } }),
  });
  const payload = await response.json();
  const savedProject = JSON.parse(fs.readFileSync(path.join(firstRoot, CONFIG_FILE), "utf8"));

  assert.equal(response.status, 200);
  assert.deepEqual(payload.settings.appearance, { fileTheme: "github-dark", autoOpenGitDiff: false, showHiddenFiles: true });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).appearance, { fileTheme: "github-dark", autoOpenGitDiff: false, showHiddenFiles: true });
  assert.equal("appearance" in savedProject, false);
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

test("HTML documents are listed as visual documents", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "map.html"), "<!doctype html><html><body><h1>Map</h1></body></html>\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const file = listMemoryFiles(root).find((item) => item.path === "docs/map.html");

  assert.equal(file?.kind, "html");
  assert.equal(file?.exists, true);
});

test("explorer listing can show project files outside watched docs as read-only", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = true;\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "hidden.ts"), "export const hidden = true;\n");
  fs.writeFileSync(path.join(root, ".env.example"), "TOKEN=example\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const files = listExplorerFiles(root);
  const guide = files.find((file) => file.path === "docs/guide.md");
  const code = files.find((file) => file.path === "src/app.ts");

  assert.equal(guide?.readOnly, false);
  assert.equal(code?.readOnly, true);
  assert.equal(files.some((file) => file.path === "node_modules/pkg/hidden.ts"), false);
  assert.equal(files.some((file) => file.path === ".env.example"), true);
});

test("explorer shows safe hidden files by default and can hide them globally", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden-folder"));
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  fs.writeFileSync(path.join(root, ".hidden-folder", "notes.md"), "# Hidden notes\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "export {};\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const shown = listExplorerFiles(root);
  const hidden = listExplorerFiles(root, { showHiddenFiles: false });

  assert.ok(shown.some((file) => file.path === ".gitignore"));
  assert.ok(shown.some((file) => file.path === ".hidden-folder/notes.md"));
  assert.ok(shown.some((file) => file.path === ".context-room/config.json" && file.readOnly));
  assert.ok(shown.some((file) => file.path === ".context-room/README.md" && file.readOnly));
  assert.equal(shown.some((file) => file.path.startsWith(".git/")), false);
  assert.equal(shown.some((file) => file.path.startsWith("node_modules/")), false);
  assert.equal(hidden.some((file) => file.path.split("/").some((part) => part.startsWith("."))), false);
});

test("explorer lists env files as redacted sensitive files without exposing values", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=postgres://secret\nexport API_TOKEN=super-secret-token\n# ignored\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const files = listExplorerFiles(root);
  const env = files.find((file) => file.path === ".env");
  const read = readMemoryFile(root, ".env");

  assert.equal(env?.readOnly, true);
  assert.equal(env?.sensitive, true);
  assert.equal(env?.redacted, true);
  assert.equal(read.readOnly, true);
  assert.equal(read.sensitive, true);
  assert.equal(read.redacted, true);
  assert.match(read.content, /DATABASE_URL/);
  assert.match(read.content, /API_TOKEN/);
  assert.doesNotMatch(read.content, /postgres:\/\/secret/);
  assert.doesNotMatch(read.content, /super-secret-token/);
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
  const rewritten = readStartupContextFile(root, 2);
  const deleted = deleteStartupContextFile(root, 2);

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
  assert.equal(written.contentHash, rewritten.contentHash);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.path, opened.startupContext.displayPath);
  assert.equal(fs.existsSync(path.join(parent, "CLAUDE.md")), false);
  assert.ok(fs.existsSync(path.join(root, deleted.backupPath)));
  assert.equal(fs.readFileSync(path.join(root, deleted.backupPath), "utf8"), "# Updated Claude\n");
});

test("startup context scanner includes explicit global agent instruction paths", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const root = path.join(home, "work", "project");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# Codex Agents\n");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project Agents\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext = {
      enabled: true,
      fileNames: ["AGENTS.md"],
      globalPaths: ["~/.codex/AGENTS.md"],
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const files = listStartupContextFiles(root);
    const opened = readStartupContextFile(root, 1);

    assert.deepEqual(files.map((file) => file.startupContext.displayPath), ["~/.codex/AGENTS.md", "~/work/project/AGENTS.md"]);
    assert.deepEqual(files.map((file) => file.startupContext.explorerPath), ["~/.codex/AGENTS.md", "AGENTS.md"]);
    assert.equal(files[0].startupContext.source, "global");
    assert.equal(files[1].startupContext.source, "ancestor");
    assert.equal(opened.content, "# Codex Agents\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
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

test("doc QA tracks startup context changes with an internal baseline", () => {
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

    const initial = buildDocQaReport(root);
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "# Parent Agents\n\nNew global rule.\n");
    const changed = buildDocQaReport(root);
    const review = readReviewBaseFile(root, "~/parent/AGENTS.md");
    const baseline = writeDocReviewBaseline(root, "~/parent/AGENTS.md", { note: "inline review applied" });
    const afterBaseline = buildDocQaReport(root);

    assert.equal(initial.summary.needsReview, 0);
    assert.equal(changed.summary.needsReview, 1);
    assert.equal(changed.summary.changedDocs, 1);
    assert.equal(changed.queue[0].path, "~/parent/AGENTS.md");
    assert.equal(changed.queue[0].internalChange, true);
    assert.equal(changed.queue[0].startupContext.order, 1);
    assert.equal(changed.queue[0].gitStatus.trim(), "M");
    assert.equal(review.available, true);
    assert.equal(review.baseline, "review");
    assert.equal(review.changeKind, "modified");
    assert.equal(review.baseContent, "# Parent Agents\n");
    assert.equal(review.currentContent, "# Parent Agents\n\nNew global rule.\n");
    assert.match(baseline.baselinePath, /\.context-room\/review-baselines\/external\/home\/parent\/AGENTS\.md\.baseline$/);
    assert.equal(afterBaseline.summary.needsReview, 0);
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

test("startup hooks scanner lists Git hooks and hook-manager files", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const gitHooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(gitHooksDir, "pre-commit"), "#!/bin/sh\n# Run secret checks\n# Run type checks\necho git hook\n");
  fs.chmodSync(path.join(gitHooksDir, "pre-commit"), 0o755);
  fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
  fs.writeFileSync(path.join(root, ".husky", "pre-push"), "#!/bin/sh\necho husky\n");
  fs.chmodSync(path.join(root, ".husky", "pre-push"), 0o755);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ "lint-staged": { "*.js": "eslint" } }, null, 2) + "\n");
  execFileSync("git", ["add", ".husky/pre-push", "package.json"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupHooks = {
    enabled: true,
    editable: false,
    gitHooks: true,
    hookManagers: true,
    fileNames: ["pre-commit", "pre-push"],
    managerPaths: [".husky/", "package.json"],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const hooks = listStartupHookFiles(root);
  const gitHook = hooks.find((file) => file.startupHook.source === "git-hooks");
  const huskyHook = hooks.find((file) => file.startupHook.source === "husky");
  const packageHook = hooks.find((file) => file.startupHook.source === "package-hooks");
  const opened = readStartupHookFile(root, gitHook.startupHook.order);

  assert.equal(hooks.length, 3);
  assert.equal(gitHook.startupHook.fileName, "pre-commit");
  assert.equal(gitHook.startupHook.label, "Git pre-commit hook");
  assert.equal(gitHook.startupHook.description, "Run secret checks · Run type checks");
  assert.equal(gitHook.startupHook.executable, true);
  assert.equal(gitHook.startupHook.tracked, false);
  assert.equal(gitHook.startupHook.readOnly, true);
  assert.equal(huskyHook.startupHook.fileName, "pre-push");
  assert.equal(huskyHook.startupHook.tracked, true);
  assert.equal(packageHook.startupHook.fileName, "package.json");
  assert.match(opened.content, /git hook/);
  assert.equal(opened.startupContext.kind, "startup-hook");
  assert.throws(() => writeStartupHookFile(root, gitHook.startupHook.order, "#!/bin/sh\necho blocked\n"), /editing is disabled/);

  config.startupHooks.editable = true;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const written = writeStartupHookFile(root, huskyHook.startupHook.order, "#!/bin/sh\necho updated\n");
  assert.equal(readStartupHookFile(root, huskyHook.startupHook.order).content, "#!/bin/sh\necho updated\n");
  assert.equal(written.startupContext.readOnly, false);

  const graph = buildDocumentationGraph(root);
  assert.equal(graph.summary.startupHooks, 3);
  assert.ok(graph.startupHooks.some((file) => file.startupContext.source === "git-hooks"));
});

test("startup hooks scanner lists agent hooks from Codex, Claude Code, and OpenCode", () => {
  const repo = makeRoot();
  const root = path.join(repo, "project");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.mkdirSync(path.join(repo, ".codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".codex", "hooks", "protect.py"), "#!/usr/bin/env python3\n\"\"\"Protect risky tool calls before execution.\"\"\"\nprint('protect')\n");
  fs.writeFileSync(path.join(repo, ".codex", "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{
        hooks: [{
          type: "command",
          command: "/bin/sh -lc 'repo_root=$(git rev-parse --show-toplevel); exec /usr/bin/python3 \"$repo_root/.codex/hooks/protect.py\"'",
          timeout: 5,
        }],
      }],
    },
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(repo, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "hooks", "audit.sh"), "#!/bin/sh\n# Check Claude Code edits\necho audit\n");
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [{
        hooks: [{
          type: "command",
          command: ".claude/hooks/audit.sh",
        }],
      }],
    },
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(repo, ".opencode", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".opencode", "plugins", "policy.ts"), "/** Checks OpenCode tool activity. */\nexport default {}\n");
  execFileSync("git", ["add", ".codex/hooks.json", ".codex/hooks/protect.py", ".claude/settings.json", ".claude/hooks/audit.sh", ".opencode/plugins/policy.ts"], { cwd: repo, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });

  const hooks = listStartupHookFiles(root);
  const codexConfig = hooks.find((file) => file.startupHook.source === "codex-agent-hooks");
  const codexScript = hooks.find((file) => file.startupHook.source === "codex-agent-hook-script");
  const claudeConfig = hooks.find((file) => file.startupHook.source === "claude-agent-hooks");
  const claudeScript = hooks.find((file) => file.startupHook.source === "claude-agent-hook-script");
  const opencodePlugin = hooks.find((file) => file.startupHook.source === "opencode-agent-plugin");

  assert.ok(codexConfig);
  assert.ok(codexScript);
  assert.ok(claudeConfig);
  assert.ok(claudeScript);
  assert.ok(opencodePlugin);
  assert.equal(codexConfig.startupHook.provider, "codex");
  assert.equal(claudeConfig.startupHook.provider, "claude");
  assert.equal(opencodePlugin.startupHook.provider, "opencode");
  assert.equal(codexConfig.startupHook.tracked, true);
  assert.equal(codexConfig.startupHook.event, "hooks.json");
  assert.match(codexConfig.startupHook.description, /Defines Codex hook events/);
  assert.equal(codexScript.startupHook.tracked, true);
  assert.equal(codexScript.startupHook.event, "PreToolUse");
  assert.equal(codexScript.startupHook.label, "PreToolUse · protect.py");
  assert.equal(codexScript.startupHook.description, "Protect risky tool calls before execution.");
  assert.equal(codexScript.startupHook.commandSummary, "runs .codex/hooks/protect.py");
  assert.equal(claudeScript.startupHook.event, "PostToolUse");
  assert.equal(claudeScript.startupHook.commandSummary, "runs .claude/hooks/audit.sh");
  assert.equal(opencodePlugin.startupHook.label, "OpenCode hooks · policy.ts");
  assert.equal(opencodePlugin.startupHook.description, "Checks OpenCode tool activity.");
  assert.match(readStartupHookFile(root, codexScript.startupHook.order).content, /protect/);
});

test("startup context virtual files stay out of the explorer tree", () => {
  const html = renderAppHtml();

  assert.match(html, /api\("\/api\/startup-context"\)/);
  assert.match(html, /api\("\/api\/startup-skills"\)/);
  assert.match(html, /api\("\/api\/startup-hooks"\)/);
  assert.match(html, /api\("\/api\/startup-hooks\/file\?order="/);
  assert.match(html, /api\("\/api\/startup-skills\/file\?folder="/);
  assert.match(html, /api\("\/api\/startup-skills\/create"/);
  assert.match(html, /api\("\/api\/startup-skills\/delete"/);
  assert.match(html, /function renderStartupSkillsPanel\(\)/);
  assert.match(html, /function renderStartupHooksPanel\(\)/);
  assert.match(html, /function selectStartupSkillFile\(folderOrder, skillName, options = \{\}\)/);
  assert.match(html, /function selectStartupHookFile\(order, options = \{\}\)/);
  assert.match(html, /const selectedPath = startupContextSelectedExplorerPath\(data\.startupContext\);[\s\S]*const finalPath = selectedPath \|\| selectedKey;[\s\S]*state\.selected = finalPath;/);
  assert.match(html, /state\.selected = startupSkillSelectedExplorerPath\(data\.startupContext\) \|\| selectedKey;/);
  assert.match(html, /function createStartupSkillFromPanel\(folderOrder\)/);
  assert.match(html, /function submitStartupSkillCreateForm\(folderOrder\)/);
  assert.match(html, /function cancelStartupSkillCreate\(\)/);
  assert.match(html, /function deleteStartupSkillFromPanel\(folderOrder, skillName\)/);
  assert.match(html, /addEventListener\("contextmenu", \(event\) => openStartupContextContextMenu\(event, button\.dataset\.startupOrder\)\)/);
  assert.match(html, /function openStartupContextContextMenu\(event, order\)/);
  assert.match(html, /data-startup-context-delete/);
  assert.match(html, /async function deleteStartupContextFromPanel\(order\)/);
  assert.match(html, /api\("\/api\/startup-context\/delete"/);
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
  assert.match(html, /Startup hooks/);
  assert.match(html, /startupHooksHelpOpen: false/);
  assert.match(html, /startupHookFilter: "all"/);
  assert.match(html, /data-startup-hooks-help/);
  assert.match(html, /data-startup-hook-filter/);
  assert.match(html, /function setStartupHookFilter\(filter = "all"\)/);
  assert.match(html, /function startupHookKind\(hook = \{\}\)/);
  assert.match(html, /startupHookFilterLabel\(kind = "all", files = \[\]\)/);
  assert.match(html, /function startupHookFilterOptions\(files = \[\]/);
  assert.match(html, /state\.startupHooksHelpOpen = Boolean\(event\.currentTarget\.open\)/);
  assert.match(html, /Agent hook sources and related hooks/);
  assert.match(html, /Agent hook sources/);
  assert.match(html, /Codex/);
  assert.match(html, /Claude Code/);
  assert.match(html, /OpenCode/);
  assert.match(html, /Common agent events/);
  assert.match(html, /Before tool use/);
  assert.match(html, /After tool use/);
  assert.match(html, /User prompt/);
  assert.match(html, /Session start\/stop/);
  assert.match(html, /Config and plugins/);
  assert.match(html, /Git hooks/);
  assert.match(html, /Hook managers/);
  assert.match(html, /Examples include Husky/);
  assert.match(html, /class="startup-hook-kind/);
  assert.match(html, /\.startup-hook-filter/);
  assert.match(html, /startupSkillFolders: \[\]/);
  assert.match(html, /startupHookFiles: \[\]/);
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
  assert.match(html, /id="startupHooksEnabled"/);
  assert.match(html, /id="startupHooksEditable"/);
  assert.match(html, /id="startupAgentHooks"/);
  assert.match(html, /id="startupAgentHookSources"/);
  assert.match(html, /Name \| config path \| plugin folder/);
  assert.match(html, /data-startup-order/);
  assert.match(html, /data-startup-hook-order/);
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
  assert.match(exclude, /\.context-room\/review-ledger\.json/);
  assert.match(exclude, /\.context-room\/session-state\.json/);
  assert.match(exclude, /\.context-room\/agent-command\.json/);
  assert.match(exclude, /\.context-room\/agent-annotations\.json/);
  assert.match(exclude, /\.context-room\/health-acknowledgements\.json/);
  assert.match(exclude, /\.context-room\/README\.md/);
  assert.match(exclude, /\.context-room\/agent-context\//);
  assert.match(exclude, /\.context-room\/review-baselines\//);
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
  assert.match(exclude, /project\/\.context-room\/README\.md/);
  assert.match(exclude, /^\.context-room\/review-ledger\.json$/m);
  assert.match(exclude, /project\/\.context-room\/review-baselines\//);
  assert.match(exclude, /project\/\.context-room\/memory-webapp-backups\//);
});

test("CLI guard is non-blocking unless strict mode is explicit", () => {
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
  const advisoryOutput = execFileSync(process.execPath, [cli, "guard"], { cwd: root, encoding: "utf8" });
  assert.match(advisoryOutput, /found watched documentation changes/);
  assert.match(advisoryOutput, /did not block/);
  assert.doesNotMatch(advisoryOutput, /blocked this commit/);
  assert.match(advisoryOutput, /README\.md/);

  const reviewOnlyOutput = execFileSync(process.execPath, [cli, "guard", "--profile", "review-only"], { cwd: root, encoding: "utf8" });
  assert.match(reviewOnlyOutput, /found watched documentation changes/);
  assert.match(reviewOnlyOutput, /review-only guard found issues but did not block/);
  assert.doesNotMatch(reviewOnlyOutput, /blocked this commit/);

  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard", "--profile", "strict"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this commit/);
      assert.match(output, /need human review/);
      assert.match(output, /Open the Context Room webapp for the user/);
      assert.match(output, /show the Changed files to review queue/);
      assert.match(output, /Agents must not mark files verified on the user's behalf/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  writeDocReviewDecision(root, "README.md", { status: "verified", note: "test baseline" });
  const output = execFileSync(process.execPath, [cli, "guard", "--profile", "review-only"], { cwd: root, encoding: "utf8" });
  assert.match(output, /No unverified watched documentation changes/);

  const unverified = writeDocReviewDecision(root, "README.md", { status: "unverified", note: "undo" });
  assert.equal(unverified.status, "unverified");
  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard", "--profile", "strict"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this commit/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  execFileSync(process.execPath, [cli, "install-hook"], { cwd: root, encoding: "utf8" });
  const hook = fs.readFileSync(path.join(root, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(hook, /Reports watched documentation changes without blocking commits/);
  assert.match(hook, /--profile advisory/);
  assert.doesNotMatch(hook, /--profile review-only/);
});

test("shared review ledger verifies the same absolute path and content across rooms", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nShared review.\n");

  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);
  const verified = writeDocReviewDecision(root, "README.md", { status: "verified", note: "global proof" });
  const ledger = readGlobalReviewLedger(root);
  const entries = Object.values(ledger.reviews);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].absolutePath, fs.realpathSync(path.join(root, "README.md")));
  assert.equal(entries[0].contentHash, verified.contentHash);

  fs.unlinkSync(path.join(root, ".context-room", "review-ledger.json"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);
  assert.equal(Object.values(readGlobalReviewLedger(root).reviews).length, 1);

  fs.unlinkSync(path.join(root, ".context-room", "review-state.json"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);

  writeDocReviewDecision(root, "README.md", { status: "unverified" });
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);
});

test("watched HTML changes enter the review queue", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const filePath = path.join(root, "docs", "ideas.html");
  fs.writeFileSync(filePath, "<!doctype html><html><body><h1>Ideas</h1></body></html>\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(filePath, "<!doctype html><html><body><h1>Ideas</h1><p>New direction.</p></body></html>\n");

  const item = buildDocQaReport(root).queue.find((entry) => entry.path === "docs/ideas.html");

  assert.ok(item);
  assert.notEqual(item.gitStatus.trim(), "");
  assert.equal(item.reviewRequired, false);
});

test("last_verified-only edits preserve local and global review trust", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const contentFor = (date, body = "Stable truth.") => `---\ncontext_room:\n  kind: canonical\n  scope: demo\n  status: current\n  canonical_for: guide\n  last_verified: ${date}\n  sources: []\n---\n\n# Guide\n\n${body}\n`;
  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-07"));
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  writeDocReviewDecision(root, "README.md", { status: "verified" });

  const reviewStatePath = path.join(root, ".context-room", "review-state.json");
  const ledgerPath = path.join(root, ".context-room", "review-ledger.json");
  const legacyState = JSON.parse(fs.readFileSync(reviewStatePath, "utf8"));
  delete legacyState.reviews["README.md"].reviewHash;
  delete legacyState.reviews["README.md"].baselineReviewHash;
  fs.writeFileSync(reviewStatePath, JSON.stringify(legacyState, null, 2) + "\n");
  const legacyLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  for (const review of Object.values(legacyLedger.reviews)) delete review.reviewHash;
  fs.writeFileSync(ledgerPath, JSON.stringify(legacyLedger, null, 2) + "\n");

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-09"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);
  const migratedState = JSON.parse(fs.readFileSync(reviewStatePath, "utf8"));
  const migratedLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  assert.match(migratedState.reviews["README.md"].reviewHash, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(migratedLedger.reviews).every((review) => /^[a-f0-9]{64}$/.test(review.reviewHash)));

  fs.unlinkSync(reviewStatePath);
  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-10"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-10", "Changed truth."));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);
});

test("last_verified-only Git edits do not require review without prior trust", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const contentFor = (date, body = "Stable truth.") => `---\ncontext_room:\n  kind: canonical\n  scope: demo\n  status: current\n  canonical_for: guide\n  last_verified: ${date}\n  sources: []\n---\n\n# Guide\n\n${body}\n`;
  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-07"));
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-09"));
  assert.deepEqual(buildDocQaReport(root).queue, []);

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["README.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const requiredReview = buildDocQaReport(root);
  assert.equal(requiredReview.queue.length, 1);
  assert.equal(requiredReview.queue[0].reviewRequired, true);
  assert.equal(requiredReview.queue[0].gitStatus, "");
  assert.equal(requiredReview.summary.changedDocs, 0);
  assert.equal(requiredReview.summary.requiredReview, 1);

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-09", "Changed truth."));
  assert.notEqual(buildDocQaReport(root).queue[0].gitStatus.trim(), "");
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

test("doc QA reports Git renames as a single renamed review item", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "agent-bridge.md"), "# Agent Bridge\n\nCLI contract.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["mv", "docs/agent-bridge.md", "docs/agent-cli.md"], { cwd: root, stdio: "ignore" });

  const report = buildDocQaReport(root);
  const item = report.queue[0];
  const reviewBase = readReviewBaseFile(root, "docs/agent-cli.md");
  const diff = readFileDiff(root, "docs/agent-cli.md");

  assert.equal(report.summary.changedDocs, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(item.path, "docs/agent-cli.md");
  assert.equal(item.oldPath, "docs/agent-bridge.md");
  assert.equal(item.gitStatus.trim(), "R");
  assert.equal(reviewBase.changeKind, "renamed");
  assert.equal(reviewBase.oldPath, "docs/agent-bridge.md");
  assert.equal(reviewBase.baseContent, "# Agent Bridge\n\nCLI contract.\n");
  assert.match(diff.patch, /rename from docs\/agent-bridge\.md/);
  assert.match(diff.patch, /rename to docs\/agent-cli\.md/);
});

test("doc QA infers unstaged filesystem renames before Git reports R status", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "agent-bridge.md"), "# Agent Bridge\n\nThe agent bridge lets coding agents open docs through the CLI.\n\n## Rules\n\n- Agents can navigate and annotate.\n- Humans verify the review queue.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.renameSync(path.join(root, "docs", "agent-bridge.md"), path.join(root, "docs", "agent-cli.md"));
  fs.writeFileSync(path.join(root, "docs", "agent-cli.md"), "# Agent CLI\n\nThe agent CLI lets coding agents open docs through the CLI.\n\n## Rules\n\n- Agents can navigate and annotate.\n- Humans verify the review queue.\n");

  const report = buildDocQaReport(root);
  const reviewBase = readReviewBaseFile(root, "docs/agent-cli.md");
  const diff = readFileDiff(root, "docs/agent-cli.md");

  assert.equal(report.summary.changedDocs, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(report.queue[0].path, "docs/agent-cli.md");
  assert.equal(report.queue[0].oldPath, "docs/agent-bridge.md");
  assert.equal(report.queue[0].gitStatus.trim(), "R");
  assert.equal(report.queue.some((item) => item.path === "docs/agent-bridge.md"), false);
  assert.equal(reviewBase.changeKind, "renamed");
  assert.equal(reviewBase.oldPath, "docs/agent-bridge.md");
  assert.match(reviewBase.baseContent, /# Agent Bridge/);
  assert.match(diff.patch, /rename from docs\/agent-bridge\.md/);
  assert.match(diff.patch, /rename to docs\/agent-cli\.md/);
});

test("doc QA infers review-baseline renames for untracked verified docs", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "app-overview.md"), "---\ncontext_room:\n  kind: canonical\n  scope: context-room\n  status: current\n  canonical_for: app overview\n---\n\n# App Overview\n\nContext Room maps docs and source files.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"], reviewPaths: ["docs/"] });
  writeDocReviewBaseline(root, "docs/app-overview.md", { note: "verified from Context Room review queue" });

  fs.renameSync(path.join(root, "docs", "app-overview.md"), path.join(root, "docs", "product-overview.md"));
  fs.writeFileSync(path.join(root, "docs", "product-overview.md"), "---\ncontext_room:\n  kind: canonical\n  scope: context-room\n  status: current\n  canonical_for: product overview\n---\n\n# Product Overview\n\nContext Room maps docs and source files.\n");

  const report = buildDocQaReport(root);
  const item = report.queue.find((entry) => entry.path === "docs/product-overview.md");
  const reviewBase = readReviewBaseFile(root, "docs/product-overview.md");
  const diff = readFileDiff(root, "docs/product-overview.md");
  const deletionBatch = buildDeletedReviewBatch(root);

  assert.ok(item);
  assert.equal(item.oldPath, "docs/app-overview.md");
  assert.equal(item.gitStatus.trim(), "R");
  assert.equal(report.queue.some((entry) => entry.path === "docs/app-overview.md"), false);
  assert.equal(deletionBatch.items.some((entry) => entry.path === "docs/app-overview.md"), false);
  assert.equal(reviewBase.changeKind, "renamed");
  assert.equal(reviewBase.oldPath, "docs/app-overview.md");
  assert.match(reviewBase.baseContent, /# App Overview/);
  assert.match(diff.patch, /rename from docs\/app-overview\.md/);
  assert.match(diff.patch, /rename to docs\/product-overview\.md/);
});

test("batch deletion review records absent resources and revalidates every selected path", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/alpha.md"), "# Alpha\n\nLegacy alpha instructions.\n");
  fs.writeFileSync(path.join(root, "docs/beta.md"), "---\ncontext_room:\n  kind: canonical\n  scope: demo\n  status: current\n  canonical_for: beta\n  sources: []\n---\n\n# Beta\n\nLegacy beta instructions.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/alpha.md"));
  fs.unlinkSync(path.join(root, "docs/beta.md"));
  fs.writeFileSync(path.join(root, "docs/reworked.md"), "# Reworked\n\nConsolidated architecture and fresh workflow.\n");

  const before = buildDocQaReport(root);
  const batch = buildDeletedReviewBatch(root);

  assert.equal(before.summary.deletedDocs, 2);
  assert.equal(before.summary.protectedDeletedDocs, 1);
  assert.equal(batch.count, 2);
  assert.equal(batch.protectedCount, 1);
  assert.deepEqual(batch.items.map((item) => item.path).sort(), ["docs/alpha.md", "docs/beta.md"]);

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["docs/alpha.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const reclassifiedBatch = buildDeletedReviewBatch(root);
  assert.notEqual(reclassifiedBatch.key, batch.key, "changing protected status must invalidate an already loaded batch");
  assert.equal(reclassifiedBatch.protectedCount, 2);
  config.reviewPaths = [];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const result = writeDeletedReviewBatchDecision(root, ["docs/alpha.md", "docs/beta.md", "docs/reworked.md"], { protectedAcknowledged: true });
  assert.deepEqual(result.confirmed.sort(), ["docs/alpha.md", "docs/beta.md"]);
  assert.equal(result.protectedConfirmed, 1);
  assert.deepEqual(result.skipped, [{ path: "docs/reworked.md", reason: "not_pending_deletion" }]);

  const localState = JSON.parse(fs.readFileSync(path.join(root, ".context-room/review-state.json"), "utf8"));
  assert.equal(localState.reviews["docs/alpha.md"].resourceState, "absent");
  assert.equal(localState.reviews["docs/beta.md"].resourceState, "absent");
  assert.match(localState.reviews["docs/alpha.md"].resourceVersion, /^git-path:[a-f0-9]{40,64}$/);
  assert.equal(Object.values(readGlobalReviewLedger(root).reviews).filter((review) => review.resourceState === "absent").length, 2);
  const after = buildDocQaReport(root);
  assert.equal(after.summary.deletedDocs, 0);
  assert.equal(after.queue.some((item) => item.path === "docs/reworked.md"), true);

  fs.writeFileSync(path.join(root, "docs/alpha.md"), "# Alpha\n\nLegacy alpha instructions.\n");
  buildDocQaReport(root);
  fs.unlinkSync(path.join(root, "docs/alpha.md"));
  const deletedAfterRestore = buildDocQaReport(root);
  assert.equal(deletedAfterRestore.queue.some((item) => item.path === "docs/alpha.md"), true, "restoring a path clears its earlier absent-resource review");

  fs.writeFileSync(path.join(root, "docs/alpha.md"), "");
  const recreated = buildDocQaReport(root);
  assert.equal(recreated.queue.some((item) => item.path === "docs/alpha.md"), true, "a present empty file must not inherit an absent-resource review");
  execFileSync("git", ["add", "docs/alpha.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "recreate alpha"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/alpha.md"));
  const deletedAgain = buildDocQaReport(root);
  assert.equal(deletedAgain.queue.some((item) => item.path === "docs/alpha.md"), true, "a later deletion at the same path must receive a new review");
});

test("deleted review batch exposes the full set beyond the eighty-item queue cap", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  for (let index = 0; index < 85; index += 1) {
    fs.writeFileSync(path.join(root, "docs", "legacy-" + String(index).padStart(2, "0") + ".md"), "# Legacy " + index + "\n\nOld source " + index + ".\n");
  }
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  for (const file of fs.readdirSync(path.join(root, "docs"))) fs.unlinkSync(path.join(root, "docs", file));

  const report = buildDocQaReport(root);
  const batch = buildDeletedReviewBatch(root);

  assert.equal(report.summary.deletedDocs, 85);
  assert.equal(report.queue.length, 80);
  assert.equal(batch.count, 85);
  assert.equal(batch.items.length, 85);
});

test("deleted review batch protects paths whose historical content cannot be inspected safely", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/large.md"), "# Large\n\n" + "x".repeat(760_000));
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/large.md"));

  const batch = buildDeletedReviewBatch(root);

  assert.equal(batch.count, 1);
  assert.equal(batch.protectedCount, 1);
  assert.equal(batch.items[0].contentUnavailable, true);
});

test("unmerged deletion conflicts stay individual and out of the deletion batch", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const settings = readMemoryWebappSettings(root);
  const report = buildDocQaReport(root, {
    gitStatuses: new Map([["docs/conflict.md", { path: "docs/conflict.md", status: "DD", oldPath: null }]]),
    gitHeadContents: new Map([["docs/conflict.md", "# Conflicted deletion\n"]]),
    settings,
    reviewState: { version: 1, reviews: {} },
    files: [],
    startupFiles: [],
  });

  assert.equal(report.summary.deletedDocs, 0);
  assert.equal(report.queue.length, 1);
  assert.equal(report.queue[0].path, "docs/conflict.md");
  assert.equal(report.queue[0].batchDeletion, false);
  assert.equal(report.queue[0].issues[0].type, "git_conflict");
});

test("deleted review batch applies its cap after filtering already confirmed removals", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const paths = [];
  for (let index = 0; index < 5002; index += 1) {
    const relPath = "docs/legacy-" + String(index).padStart(4, "0") + ".md";
    paths.push(relPath);
    fs.writeFileSync(path.join(root, relPath), "# Legacy " + index + "\n");
  }
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  for (const relPath of paths) fs.unlinkSync(path.join(root, relPath));

  const emptyHash = createHash("sha256").update("").digest("hex");
  const reviews = Object.fromEntries(paths.slice(0, 5000).map((relPath) => [relPath, {
    status: "verified",
    contentHash: emptyHash,
    reviewHash: emptyHash,
    resourceState: "absent",
    resourceVersion: "git-path:" + revision,
  }]));
  fs.writeFileSync(path.join(root, ".context-room/review-state.json"), JSON.stringify({ version: 1, reviews }) + "\n");

  const batch = buildDeletedReviewBatch(root);

  assert.equal(batch.count, 2);
  assert.equal(batch.truncated, false);
  assert.deepEqual(batch.items.map((item) => item.path), paths.slice(5000));
});

test("deleted review batch API lists and confirms the current server-validated set", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/one.md"), "# One\n\nFirst old doc.\n");
  fs.writeFileSync(path.join(root, "docs/two.md"), "# Two\n\nSecond old doc.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/one.md"));
  fs.unlinkSync(path.join(root, "docs/two.md"));
  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listed = await (await fetch(baseUrl + "/api/docqa/review-deletions")).json();
  assert.equal(listed.count, 2);

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["docs/one.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const staleResponse = await fetch(baseUrl + "/api/docqa/review-deletions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["docs/one.md"], key: listed.key, protectedAcknowledged: true }),
  });
  assert.equal(staleResponse.status, 409);
  assert.match((await staleResponse.json()).error, /changed since this batch was loaded/);

  const relisted = await (await fetch(baseUrl + "/api/docqa/review-deletions")).json();
  assert.notEqual(relisted.key, listed.key);
  assert.equal(relisted.protectedCount, 1);
  const unacknowledgedResponse = await fetch(baseUrl + "/api/docqa/review-deletions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["docs/one.md"], key: relisted.key }),
  });
  assert.equal(unacknowledgedResponse.status, 400);
  assert.match((await unacknowledgedResponse.json()).error, /explicit acknowledgement/);

  const confirmed = await (await fetch(baseUrl + "/api/docqa/review-deletions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: ["docs/one.md", "docs/missing.md"], key: relisted.key, protectedAcknowledged: true }),
  })).json();
  assert.deepEqual(confirmed.confirmed, ["docs/one.md"]);
  assert.deepEqual(confirmed.skipped, [{ path: "docs/missing.md", reason: "not_pending_deletion" }]);
  assert.equal(confirmed.docqa.summary.deletedDocs, 1);

  const remaining = await (await fetch(baseUrl + "/api/docqa/review-deletions")).json();
  assert.deepEqual(remaining.items.map((item) => item.path), ["docs/two.md"]);
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

test("reviewPaths order defines the human verification path", () => {
  const root = makeRoot();
  const files = ["AGENTS.md", "docs/PRODUCT.md", "website/docs/PRODUCT.md"];
  for (const relPath of files) {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), `# ${relPath}\n`);
  }
  const reviewPaths = ["website/docs/PRODUCT.md", "AGENTS.md", "docs/PRODUCT.md"];
  initializeContextRoomProject(root, {
    allowedPaths: ["AGENTS.md", "docs/", "website/docs/"],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = reviewPaths;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), reviewPaths);
});

test("reader questions do not become unresolved TODO markers", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const filePath = path.join(root, "docs", "system-map.html");
  fs.writeFileSync(filePath, "<!doctype html><html><body><h1>Map</h1><h2>Question: what does the system own?</h2></body></html>\n");
  initializeContextRoomProject(root, {
    allowedPaths: ["docs/"],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["docs/system-map.html"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const readerQuestion = buildDocQaReport(root).queue[0];
  assert.equal(readerQuestion.issues.some((issue) => issue.type === "todo"), false);

  fs.appendFileSync(filePath, "\n<!-- QUESTION -->\n");
  const unresolvedMarker = buildDocQaReport(root).queue[0];
  assert.equal(unresolvedMarker.issues.some((issue) => issue.type === "todo"), true);
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

test("file diff counts tracked patch lines without a second Git diff", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nOld.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nNew.\n\nExtra.\n");

  const diff = readFileDiff(root, "docs/guide.md");

  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 1);
  assert.match(diff.patch, /\+Extra\./);
});

test("file diff skips repository-wide work outside Git", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md"], watchAllow: ["AGENTS.md"] });

  const diff = readFileDiff(root, "AGENTS.md");
  const cachedStart = performance.now();
  const cachedDiff = readFileDiff(root, "AGENTS.md");

  assert.equal(diff.available, false);
  assert.equal(diff.changed, false);
  assert.match(diff.reason, /outside a Git repository/);
  assert.equal(cachedDiff.available, false);
  assert.ok(performance.now() - cachedStart < 250, "negative Git lookup should be cached");
  assert.match(readFileDiff.toString(), /if \(!gitTopLevelRoot\(root\)\)/);
});

test("review base reads HEAD content for changed files from a git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "hicharlie.fr");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nOriginal.\n");
  fs.writeFileSync(path.join(root, "docs/old.md"), "# Old\n\nRemove me.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nUpdated.\n");
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New\n\nDraft.\n");
  fs.unlinkSync(path.join(root, "docs/old.md"));

  const modified = readReviewBaseFile(root, "docs/guide.md");
  const added = readReviewBaseFile(root, "docs/new.md");
  const deleted = readReviewBaseFile(root, "docs/old.md");

  assert.equal(modified.available, true);
  assert.equal(modified.changeKind, "modified");
  assert.equal(modified.baseContent, "# Guide\n\nOriginal.\n");
  assert.equal(modified.currentContent, "# Guide\n\nUpdated.\n");
  assert.equal(added.available, true);
  assert.equal(added.changeKind, "added");
  assert.equal(added.baseContent, "");
  assert.equal(added.currentContent, "# New\n\nDraft.\n");
  assert.equal(deleted.available, true);
  assert.equal(deleted.changeKind, "deleted");
  assert.equal(deleted.baseContent, "# Old\n\nRemove me.\n");
  assert.equal(deleted.currentContent, "");
});

test("review base prefers the last inline review baseline over HEAD", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nAlready reviewed.\n");

  const baseline = writeDocReviewBaseline(root, "README.md", { note: "inline review applied" });
  const unchanged = readReviewBaseFile(root, "README.md");
  const reportAfterInlineBaseline = buildDocQaReport(root);
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nAlready reviewed.\n\nNew small edit.\n");
  const next = readReviewBaseFile(root, "README.md");

  assert.match(baseline.baselinePath, /\.context-room\/review-baselines\/README\.md\.baseline$/);
  assert.equal(unchanged.baseline, "review");
  assert.equal(unchanged.changeKind, "unchanged");
  assert.equal(unchanged.baseContent, unchanged.currentContent);
  assert.equal(reportAfterInlineBaseline.queue.some((item) => item.path === "README.md"), false);
  assert.equal(next.baseline, "review");
  assert.equal(next.changeKind, "modified");
  assert.equal(next.baseContent, "# Demo\n\nAlready reviewed.\n");
  assert.equal(next.currentContent, "# Demo\n\nAlready reviewed.\n\nNew small edit.\n");
});

test("default config exposes scoped context and simple markdown templates without a writing guide", () => {
  const config = createDefaultProjectConfig({ title: "Docs Demo" });

  assert.ok(config.allowedPaths.includes("context/"));
  assert.ok(config.hubSections[0].cards.some((card) => card.id === "context"));
  assert.equal("bestPractices" in config, false);
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

  const html = renderAppHtml();
  assert.doesNotMatch(html, /Writing guide/i);
  assert.doesNotMatch(html, /Docs best practices/i);
  assert.doesNotMatch(html, /bestPractices/);
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
  assert.equal(graph.summary.missingMetadata, 1);
  assert.equal(graph.healthIssues.some((issue) => issue.type === "missing_metadata" && issue.path === "docs/plain.md"), false);
});

test("documentation graph resolves inline references from project sub-roots", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "projects", "hicharlie", "website", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", "hicharlie", "website", "docs", "PRODUCT.md"), "# Product\n");
  fs.writeFileSync(path.join(root, "projects", "hicharlie", "website", "docs", "DEPLOYMENT.md"), `---
context_room:
  kind: procedure
  scope: hicharlie
  status: current
  canonical_for: deployment
  last_verified: 2026-06-26
  sources: []
---

See \`docs/PRODUCT.md\`.
`);
  initializeContextRoomProject(root, {
    allowedPaths: ["projects/hicharlie/website/docs/"],
    watchAllow: ["projects/hicharlie/website/docs/"],
  });

  const graph = buildDocumentationGraph(root);

  assert.equal(graph.healthIssues.some((issue) => issue.type === "broken_reference" && issue.path === "projects/hicharlie/website/docs/DEPLOYMENT.md"), false);
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

test("doctor report keeps acknowledged health issues visible but marked", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "plain.md"), `---
context_room:
  kind: canonical
  scope: docs
  status: current
  canonical_for: plain
  last_verified: 2026-06-26
  sources: [missing.md]
---

# Plain
`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const before = buildContextRoomDoctorReport(root);
  const issue = before.issues.find((item) => item.type === "broken_source" && item.path === "docs/plain.md");
  assert.ok(issue?.key);
  assert.equal(issue.acknowledged, false);

  const result = acknowledgeContextHealthIssue(root, { key: issue.key, note: "Known docs gap" });
  const saved = readContextHealthAcknowledgements(root);
  const after = buildContextRoomDoctorReport(root);
  const acknowledged = after.issues.find((item) => item.key === issue.key);

  assert.equal(result.issue.acknowledged, true);
  assert.equal(saved.issues[issue.key].note, "Known docs gap");
  assert.equal(acknowledged?.acknowledged, true);
  assert.equal(after.acknowledgedIssues, 1);
  assert.ok(after.issues.some((item) => item.type === "broken_source" && item.path === "docs/plain.md"));
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
  assert.match(html, /function explorerWatchCounts\(\)/);
  assert.match(html, /function renderExplorerEmptyState\(\)/);
  assert.match(html, /data-watch-label="all"/);
  assert.match(html, /data-watch-label="watched"/);
  assert.match(html, /No not-watched files in this project\./);
  assert.match(html, /if \(!force && state\.explorerRenderKey === nextKey\)/);
  assert.doesNotMatch(html, /if \(state\.explorerWatchFilter !== "all"\) expandExplorerFilterResults\(\);/);
  assert.match(html, /function wireExplorerTreeEvents\(\)/);
  assert.match(html, /holder\.dataset\.wired === "true"/);
  assert.match(html, /holder\.addEventListener\("click", \(event\) =>/);
  assert.match(html, /holder\.addEventListener\("contextmenu", \(event\) =>/);
  assert.match(html, /function scheduleExplorerSearchRender\(\)[\s\S]*requestAnimationFrame/);
  assert.match(html, /addEventListener\("input", \(\) => \{ markUserActive\(\); state\.pathFilters = \[\]; scheduleExplorerSearchRender\(\); \}\)/);
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
  assert.doesNotMatch(html, /\.app\.sidebar-collapsed \.sidebar-copy,\s*\.app\.sidebar-collapsed \.workspace-dock/);
  assert.match(html, /@media \(min-width: 981px\) \{[\s\S]*\.app\.sidebar-collapsed \.sidebar-head\s*\{[^}]*justify-content:\s*center[^}]*\}[\s\S]*\.app\.sidebar-collapsed \.sidebar-copy\s*\{\s*display:\s*none;\s*\}[\s\S]*\.app\.sidebar-collapsed \.sidebar-toggle\s*\{[^}]*position:\s*static[^}]*margin:\s*0 auto/);
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
  assert.match(html, /\.hub-card-editor\.spotlight-active::before/);
  assert.match(html, /\.startup-skill-folder::before\s*\{\s*display:\s*none/);
  assert.match(html, /const SPOTLIGHT_CARD_SELECTOR = ".*\.hub-folder-card.*\.startup-context-item:not\(\.startup-skill-folder\).*\.settings-toggle.*\.hub-card-editor/);
  assert.doesNotMatch(html, /SPOTLIGHT_CARD_SELECTOR = "[^"]*\.settings-section/);
  assert.match(html, /function updateCardSpotlightAt\(x, y\)/);
  assert.match(html, /function scheduleCardSpotlightUpdate\(\)/);
  assert.match(html, /const pointer = spotlightPointer;/);
  assert.match(html, /if \(spotlightPointer !== pointer\) return;/);
  assert.match(html, /spotlightFrame = window\.requestAnimationFrame/);
  assert.match(html, /document\.elementFromPoint\(x, y\)/);
  assert.match(html, /function updateCardSpotlight\(event\)/);
  assert.match(html, /scheduleCardSpotlightUpdate\(\);/);
  assert.match(html, /function refreshCardSpotlightAfterScroll\(\)/);
  assert.match(html, /document\.addEventListener\("pointermove", \(event\) => \{[\s\S]*updateCardSpotlight\(event\);[\s\S]*setDocLinkModifierActive\(isDocLinkModifierEventActive\(event\)\);[\s\S]*\}, \{ passive: true \}\)/);
  assert.match(html, /document\.addEventListener\("scroll", refreshCardSpotlightAfterScroll, \{ capture: true, passive: true \}\)/);
  assert.match(html, /html\.ui-scrolling body::before\s*\{\s*animation-play-state:\s*paused/);
  assert.match(html, /function markInterfaceScrolling\(\)\s*\{[\s\S]*classList\.add\("ui-scrolling"\)[\s\S]*clearCardSpotlight\(\)[\s\S]*classList\.remove\("ui-scrolling"\)/);
  assert.match(html, /classList\.contains\("ui-scrolling"\)/);
  assert.doesNotMatch(html, /will-change:\s*transform/);
  assert.doesNotMatch(html, /backface-visibility:\s*hidden/);
});

test("rendered app supports selectable file themes and colored markdown reading", () => {
  const html = renderAppHtml();

  assert.match(html, /data-file-theme="context-room"/);
  assert.match(html, /const FILE_THEMES = \[/);
  assert.match(html, /"vscode-dark"/);
  assert.match(html, /"dracula"/);
  assert.match(html, /id="fileTheme"/);
  assert.match(html, /data-line-number="' \+ \(index \+ 1\) \+ '"/);
  assert.match(html, /\.file-panel \.doc-editor\.markdown-view \.markdown-line::before \{ content: attr\(data-line-number\)/);
  assert.match(html, /\.file-panel \.doc-editor\.markdown-view, \.file-panel \.markdown-editor-input \{ padding-left: 36px; \}/);
  assert.match(html, /font-variant-numeric: tabular-nums/);
  assert.match(html, />App theme<\/label>/);
  assert.match(html, /id="autoOpenGitDiff"/);
  assert.match(html, /<strong>Auto-open Git diff<\/strong>/);
  assert.match(html, /id="showHiddenFiles"/);
  assert.match(html, /<strong>Show hidden files<\/strong>/);
  assert.match(html, /Display safe dotfiles and \.context-room in every explorer\./);
  assert.match(html, /class="settings-shell"/);
  assert.match(html, /function renderSettingsTabs\(items = \[\]\)/);
  assert.match(html, /role="tablist" aria-label="Settings categories"/);
  assert.match(html, /data-settings-section-target="' \+ escapeHtml\(item\.id\)/);
  assert.match(html, /function renderSettingsSection\(\{ id, kicker, title, copy, scope/);
  assert.match(html, /'<section id="settings-section-' \+ sectionId/);
  assert.match(html, /id:\s*"review"[\s\S]*kicker:\s*"Review"[\s\S]*title:\s*"Watched docs"/);
  assert.match(html, /id:\s*"startup"[\s\S]*kicker:\s*"Startup"[\s\S]*title:\s*"Injected context scanners"/);
  assert.match(html, /id:\s*"appearance"[\s\S]*kicker:\s*"Appearance"[\s\S]*title:\s*"Theme, files, and diffs"/);
  assert.match(html, /copy:\s*"Shared by every Context Room on this computer\."/);
  assert.match(html, /scope:\s*"All rooms"/);
  assert.match(html, /id:\s*"templates"[\s\S]*kicker:\s*"Templates"[\s\S]*title:\s*"Markdown document templates"/);
  assert.match(html, /id:\s*"hub"[\s\S]*kicker:\s*"Hub"[\s\S]*title:\s*"Sections and cards"/);
  assert.match(html, /\.settings-section-head\s*\{[^}]*display:\s*flex/);
  assert.match(html, /\.settings-tabs\s*\{[^}]*position:\s*sticky/);
  assert.match(html, /\.settings-tab\[aria-selected="true"\]/);
  assert.match(html, /\.settings-section\[hidden\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(html, /settings-section collapsible/);
  assert.match(html, /\.template-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.hub-section-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.hub-card-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /function activateSettingsSection\(sectionId, options = \{\}\)/);
  assert.match(html, /function wireSettingsTabs\(root\)/);
  assert.match(html, /\["ArrowRight", "ArrowDown"\]/);
  assert.match(html, /settingsSection: normalizeSettingsSectionId\(state\.settingsSection\)/);
  assert.match(html, /state\.settingsSection = persisted\.settingsSection/);
  assert.match(html, /activateSettingsSection\(state\.settingsSection, \{ resetScroll: false \}\)/);
  assert.match(html, /Project setup stays in this room\. Appearance applies to all rooms\./);
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
  assert.match(html, /showHiddenFiles:\s*el\("showHiddenFiles"\)\?\.checked !== false/);
  assert.match(html, /state\.files = filesData\.files \|\| state\.files;[\s\S]*renderFiles\(\);/);
  assert.doesNotMatch(html, /autoAdvanceReview/);
  assert.doesNotMatch(html, /Auto-open next review/);
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
  assert.match(html, /function usePlainTextSurface\(filePath, text\)/);
  assert.match(html, /!String\(filePath \|\| ""\)\.toLowerCase\(\)\.endsWith\("\.md"\)/);
  assert.match(html, /value\.length > 120_000/);
  assert.match(html, /function renderDocumentEditor\(text, filePath = state\.selected\)/);
  assert.match(html, /id="docEditor" class="doc-editor plain-text-editor"/);
  assert.match(html, /\.plain-text-editor\s*\{[^}]*display:\s*block/);
  assert.match(html, /data-heading-text/);
  assert.match(html, /\.markdown-line\.h1\s*\{[^}]*color:\s*var\(--file-h1\)/);
  assert.match(html, /\.markdown-inline-code/);
  assert.match(html, /\.markdown-path\s*\{[^}]*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-path\[data-doc-link-path\]\s*\{[^}]*cursor:\s*inherit[^}]*background-image:\s*linear-gradient/);
  assert.match(html, /\.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]\s*\{[^}]*cursor:\s*pointer[^}]*background-color/);
  assert.match(html, /\.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]:hover, \.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]\.doc-link-hover-target\s*\{[^}]*animation:\s*docLinkClickableSweep/);
  assert.match(html, /@keyframes docLinkClickableSweep/);
  assert.match(html, /\.markdown-doc-link\s*\{[^}]*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-inline-code\.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.viewer a\.path-link\s*\{[^}]*cursor:\s*inherit/);
  assert.match(html, /\.doc-link-modifier-active \.viewer a\.path-link:hover\s*\{[^}]*cursor:\s*pointer/);
  assert.match(html, /\.markdown-editor-shell\s*\{[^}]*isolation:\s*isolate/);
  assert.match(html, /\.markdown-editor-highlight\s*\{[^}]*z-index:\s*1/);
  assert.match(html, /\.markdown-editor-input\s*\{[^}]*position:\s*absolute;[^}]*-webkit-text-fill-color:\s*transparent !important/);
  assert.match(html, /\.markdown-editor-input\.doc-link-hover\s*\{\s*cursor:\s*pointer;\s*\}/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\s*\{[^}]*padding:\s*0;[^}]*font-size:\s*inherit/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.h1\s*\{\s*color:\s*var\(--file-h1\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.h2\s*\{\s*color:\s*var\(--file-h2\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.list\s*\{\s*padding-left:\s*0/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.list \.markdown-marker, \.markdown-editor-highlight \.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-inline-code\s*\{\s*color:\s*var\(--file-code\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-inline-code\.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-line\s*\{[^}]*padding:\s*0;[^}]*font-size:\s*inherit/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-line\.h1, \.external-review-doc\.editor-metrics \.markdown-line\.h2, \.external-review-doc\.editor-metrics \.markdown-line\.h3, \.external-review-doc\.editor-metrics \.markdown-line\.h4\s*\{[^}]*border:\s*0/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-line\.list\s*\{\s*padding-left:\s*0/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-inline-code\s*\{\s*color:\s*var\(--file-code\);[^}]*background:\s*transparent/);
  assert.doesNotMatch(html, /\.external-review-doc \.markdown-line\s*\{[^}]*padding:\s*0/);
  assert.doesNotMatch(html, /\.external-review-doc \.markdown-line\.list\s*\{\s*padding-left:\s*0/);
  assert.doesNotMatch(html, /\.external-review-final-lines \.markdown-line\.h1, \.external-review-line-content \.markdown-line\.h1/);
  assert.match(html, /function decorateMarkdownLine\(rendered, decoration\)/);
  assert.match(html, /lineDecorations/);
  assert.match(html, /data-review-marker/);
  assert.match(html, /data-final-line-index/);
  assert.match(html, /\.external-review-line \{[^}]*position:\s*relative/);
  assert.doesNotMatch(html, /\.external-review-line \{[^}]*grid-template-columns/);
  assert.match(html, /\.external-review-line::before \{[^}]*content:\s*attr\(data-review-marker\)/);
  assert.match(html, /\.external-review-token\.add \{[^}]*background:\s*rgba\(48,215,111,0\.32\)/);
  assert.match(html, /\.external-review-token\.del \{[^}]*background:\s*rgba\(255,86,117,0\.3\)/);
  assert.match(html, /\.external-review-block\.change \{[^}]*margin:\s*0;[^}]*padding:\s*0;[^}]*box-shadow:\s*inset 2px 0 0/);
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
  assert.match(html, /if \(!state\.docLinkModifierActive\) \{[\s\S]*clearMarkdownEditorDocLinkHover\(editor\);[\s\S]*return;/);
  assert.match(html, /editor\.classList\.toggle\("doc-link-hover", Boolean\(target\)\)/);
  assert.match(html, /target\.classList\.add\("doc-link-hover-target"\)/);
  assert.match(html, /document\.elementsFromPoint\(clientX, clientY\)/);
  assert.match(html, /markdownDocLinkAtPoint\(event\.clientX, event\.clientY\) \|\| markdownDocLinkAtOffset/);
  assert.match(html, /function markdownDocLinkAtOffset\(text, offset\)/);
  assert.match(html, /wireMarkdownDocLinks\(\);/);
  assert.match(html, /wireMarkdownEditorDocLinks\(docEditor\);/);
  assert.match(html, /function setDocLinkModifierActive\(active\)/);
  assert.match(html, /if \(state\.docLinkModifierActive === next\) return;/);
  assert.match(html, /state\.docLinkModifierActive = next;/);
  assert.match(html, /document\.documentElement\.classList\.toggle\("doc-link-modifier-active", next\)/);
  assert.match(html, /if \(!next\) clearMarkdownEditorDocLinkHover\(\);/);
  assert.match(html, /function isMacPlatform\(\)/);
  assert.match(html, /function isDocLinkModifierEventActive\(event\)/);
  assert.match(html, /return isMacPlatform\(\) \? Boolean\(event\.metaKey\) : Boolean\(event\.ctrlKey\);/);
  assert.match(html, /setDocLinkModifierActive\(isDocLinkModifierEventActive\(event\)\)/);
  assert.match(html, /document\.addEventListener\("keyup", \(event\) => setDocLinkModifierActive\(isDocLinkModifierEventActive\(event\)\)\)/);
  assert.match(html, /if \(!isDocLinkModifierEventActive\(event\)\) return;/);
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
  assert.match(html, /async function selectStartupContextFile\(order, options = \{\}\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /async function selectStartupSkillFile\(folderOrder, skillName, options = \{\}\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /state\.mode === "edit"\s*\?\s*renderMarkdownEditor\(text\)/);
  assert.match(html, /writeSelectedDiskFile\(content\)/);
  assert.match(html, /api\("\/api\/startup-context\/file", \{/);
  assert.match(html, /api\("\/api\/startup-skills\/file", \{/);
  assert.match(html, /reviewAction: isStartupFile \|\| state\.selectedReadOnly \? null : reviewActionForSelectedFile\(\)/);
  assert.match(html, /deletable: !isStartupFile && !state\.selectedReadOnly/);
  assert.match(html, /el\("viewer"\)\.hidden = false;\s*el\("editor"\)\.hidden = true;\s*renderPlanetSystem\(\);/);
  assert.doesNotMatch(html, /data-file-mode-toggle/);
});

test("browser refresh restores the last Context Room page", () => {
  const html = renderAppHtml();

  assert.match(html, /NAVIGATION_STATE_STORAGE_PREFIX = "context-room:navigation:"/);
  assert.match(html, /function navigationStorageKey\(root = state\.root\)/);
  assert.match(html, /window\.localStorage\?\.setItem\(key, JSON\.stringify/);
  assert.match(html, /searchText: el\("search"\)\?\.value \|\| ""/);
  assert.match(html, /el\("search"\)\.value = persisted\.searchText \|\| folderFilterSearchQuery\(state\.pathFilters\);/);
  assert.match(html, /state\.root = data\.root \|\| state\.root;/);
  assert.match(html, /const restoreRequest = restoreNavigationAfterInitialLoad\(\);/);
  assert.match(html, /const restored = await restoreRequest;/);
  assert.match(html, /if \(restored\) \{[\s\S]*scheduleSessionStatePush\(\);[\s\S]*return;/);
  assert.match(html, /openRequest = selectFile\(persisted\.selectedPath, options\);/);
  assert.match(html, /openRequest = selectStartupContextFile\(startup\.order, options\);/);
  assert.match(html, /void openRequest\.then\(\(\) => setStatus\("restored"\)\)/);
  assert.match(html, /showSettingsPage\(\);[\s\S]*return true;/);
  assert.match(html, /restorePersistedViewState\(options\.restoreViewState\);/);
  assert.match(html, /if \(typeof options\.diffCollapsed === "boolean"\) state\.diffCollapsed = options\.diffCollapsed;/);
  assert.match(html, /window\.addEventListener\("beforeunload", \(event\) => \{[\s\S]*persistNavigationState\(\);/);
  assert.match(html, /window\.addEventListener\("beforeunload", \(event\) => \{[\s\S]*if \(!state\.dirty\) return;[\s\S]*event\.preventDefault\(\);/);
});

test("file opening renders loading and retry states instead of a blank document", () => {
  const html = renderAppHtml();

  assert.match(html, /fileLoadError: null/);
  assert.match(html, /state\.fileLoadError = null;/);
  assert.match(html, /const openingFile = state\.openingFilePath === state\.selected && state\.fileContentReadyPath !== state\.selected;/);
  assert.match(html, /const loadingFile = openingFile;/);
  assert.match(html, /const loadError = !isStartupFile && state\.fileLoadError\?\.path === state\.selected/);
  assert.match(html, /function renderFileLoadingState\(file = \{\}\)/);
  assert.match(html, /function renderFileActionsLoading\(\)/);
  assert.match(html, /file-actions file-actions-loading/);
  assert.match(html, /@keyframes fileActionLoadingPulse/);
  assert.match(html, /Opening file\.\.\./);
  assert.match(html, /function renderFileLoadError\(error = \{\}\)/);
  assert.match(html, /Could not open this file/);
  assert.match(html, /data-file-retry/);
  assert.match(html, /state\.fileLoadError = \{ path, message: error\.message \|\| "Failed to open file\." \};/);
  assert.match(html, /updateExplorerSelectedFile\(previousSelected, path\)/);
  assert.match(html, /function reconcileMissingSelectedFile\(\)/);
  assert.match(html, /function clearMissingSelectedFile\(stalePath = state\.selected\)/);
  assert.match(html, /function canReviewMissingFile\(path\)/);
  assert.match(html, /return state\.files\.some\(\(file\) => file\.path === path\) \|\| canReviewMissingFile\(path\);/);
  assert.match(html, /item\.path === path && !item\.oldPath/);
  assert.match(html, /clearReviewSession\(stalePath\)/);
  assert.match(html, /state\.page = "hub";/);
  assert.match(html, /function showHome\(\) \{[\s\S]*setStatus\("ready"\);\s*scheduleSessionStatePush\(\);/);
  assert.match(html, /function validSessionSelectedPath\(\)/);
  assert.match(html, /function selectedFileExists\(path = state\.selected\)/);
  assert.match(html, /if \(state\.selected && path !== state\.selected && !selectedFileExists\(\)\) reconcileMissingSelectedFile\(\);/);
  assert.match(html, /if \(!data\.exists && !canReviewMissingFile\(previousSelected\)\) \{/);
  assert.match(html, /if \(reconcileMissingSelectedFile\(\)\) \{/);
  assert.match(html, /openFile: state\.selectedStartupContext \? state\.selectedStartupContext\.displayPath : validSelected/);
  assert.match(html, /selectedPath: validSelected/);
  assert.doesNotMatch(html, /renderFiles\(\);\s*if \(options\.revealInExplorer\)/);
});

test("HTML files open as sandboxed visual previews without source editing", () => {
  const html = renderAppHtml();

  assert.match(html, /function isHtmlDocumentPath\(filePath\)/);
  assert.match(html, /function sanitizedHtmlPreviewDocument\(source\)/);
  assert.match(html, /doc\.querySelectorAll\("script, iframe, frame, object, embed, base"\)/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(html, /function contextRoomVisualDocumentStyles\(\)/);
  assert.match(html, /getComputedStyle\(document\.documentElement\)/);
  assert.match(html, /\["--cr-bg", token\("--file-bg"/);
  assert.match(html, /\.cr-comparison/);
  assert.match(html, /\.cr-flow/);
  assert.match(html, /\.cr-flow \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(html, /@media \(max-width: 760px\)[^\n]*\.cr-flow \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.cr-metrics/);
  assert.match(html, /\.cr-callout/);
  assert.match(html, /theme\.setAttribute\("data-context-room-visual-system", currentFileThemeId\(\)\)/);
  assert.match(html, /doc\.documentElement\.dataset\.contextRoomTheme = currentFileThemeId\(\)/);
  assert.match(html, /function applyFileTheme\(themeId = currentFileThemeId\(\)\)[\s\S]*document\.querySelector\("iframe\.html-preview-frame"\)[\s\S]*renderViewer\(\);/);
  assert.match(html, /function renderHtmlDocumentPreview\(text, filePath = state\.selected\)/);
  assert.match(html, /class="html-preview-frame" sandbox="" referrerpolicy="no-referrer"/);
  assert.match(html, /isHtmlDocument\s*\? renderHtmlDocumentPreview\(text, file\.path\)/);
  assert.match(html, /externalChange[\s\S]*isHtmlDocument[\s\S]*renderHtmlDocumentPreview\(externalChange\.diskContent \|\| "", file\.path\)/);
  assert.match(html, /const visualHtmlReview = isHtmlDocumentPath\(change\.path\);/);
  assert.match(html, /const jumpAction = summary\.pending && !visualHtmlReview/);
  assert.match(html, /const bulkActions = summary\.pending && \(visualHtmlReview \|\| summary\.pending > 1 \|\| summary\.pendingLines > 1\)/);
  assert.match(html, /savable: !isHtmlDocument/);
  assert.match(html, /savable \? '<button class="file-action primary"/);
});

test("recurring theme refresh keeps an unchanged HTML preview iframe alive", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const themeSource = script.slice(script.indexOf("function currentFileThemeId"), script.indexOf("function previewSelectedFileTheme"));
  const settingsSource = script.slice(script.indexOf("function applySettingsPayload"), script.indexOf("function backgroundReportRenderKey"));
  const document = {
    documentElement: { dataset: { fileTheme: "context-room", appTheme: "context-room" } },
    frame: { id: "interactive-preview" },
    querySelector(selector) {
      return selector === "iframe.html-preview-frame" ? this.frame : null;
    },
  };
  const state = {
    settings: { appearance: { fileTheme: "context-room" } },
    availableHubCards: [],
    hubFolders: [],
    rootHubSections: [],
    hubSections: [],
    selected: "docs/interactive.html",
    openingFilePath: null,
  };
  const harness = Function(
    "state",
    "document",
    "FILE_THEMES",
    "DEFAULT_FILE_THEME",
    "isHtmlDocumentPath",
    "captureEditorViewState",
    "restoreEditorViewState",
    `let renderViewer = () => {};
    ` + themeSource + settingsSource + `
      let renderCount = 0;
      renderViewer = () => {
        renderCount += 1;
        document.frame = { id: "replacement-" + renderCount };
      };
      return {
        applySettingsPayload,
        renderCount: () => renderCount,
      };
    `,
  )(
    state,
    document,
    FILE_THEME_OPTIONS,
    "context-room",
    (filePath) => /\.html?$/i.test(filePath),
    () => ({ path: state.selected }),
    () => {},
  );

  const originalFrame = document.frame;
  harness.applySettingsPayload({ settings: { appearance: { fileTheme: "context-room" } } });
  assert.strictEqual(document.frame, originalFrame);
  assert.equal(harness.renderCount(), 0);

  harness.applySettingsPayload({ settings: { appearance: { fileTheme: "light-plus" } } });
  assert.notStrictEqual(document.frame, originalFrame);
  assert.equal(harness.renderCount(), 1);
});

test("visual HTML library keeps forty data patterns and exposes five distinct diagram templates", () => {
  const html = renderAppHtml();
  const conceptCatalog = fs.readFileSync(new URL("../docs/context-room-visual-components.html", import.meta.url), "utf8");
  const dataCatalog = fs.readFileSync(new URL("../docs/context-room-data-visual-components.html", import.meta.url), "utf8");
  const reference = fs.readFileSync(new URL("../docs/features/html-visual-patterns.md", import.meta.url), "utf8");
  const groups = VISUAL_DOCUMENT_PATTERNS.reduce((result, pattern) => {
    (result[pattern.group] ||= []).push(pattern);
    return result;
  }, {});
  const conceptCatalogIds = [...conceptCatalog.matchAll(/data-pattern="([^"]+)"/g)].map((match) => match[1]);
  const dataCatalogIds = [...dataCatalog.matchAll(/data-pattern="([^"]+)"/g)].map((match) => match[1]);
  const conceptPanels = conceptCatalog.split('<article class="pattern-panel"').slice(1);

  assert.equal(DIAGRAM_VISUAL_DOCUMENT_PATTERNS.length, 5);
  assert.strictEqual(CONCEPT_VISUAL_DOCUMENT_PATTERNS, DIAGRAM_VISUAL_DOCUMENT_PATTERNS);
  assert.equal(DATA_VISUAL_DOCUMENT_PATTERNS.length, 40);
  assert.equal(VISUAL_DOCUMENT_PATTERNS.length, 45);
  assert.equal(new Set(VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.id)).size, 45);
  assert.equal(new Set(VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.className)).size, 45);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([group, patterns]) => [group, patterns.length])), {
    "data-summary": 10,
    "data-comparison": 10,
    "data-chart": 10,
    "data-structure": 10,
    diagram: 5,
  });
  assert.deepEqual(conceptCatalogIds, DIAGRAM_VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.id));
  assert.deepEqual(dataCatalogIds, DATA_VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.id));
  assert.equal((conceptCatalog.match(/type="radio"/g) || []).length, 5);
  assert.ok((conceptCatalog.match(/<details\b/g) || []).length >= 5);
  assert.equal((conceptCatalog.match(/pattern-demo cr-diagram-scroll" tabindex="0"/g) || []).length, 5);
  assert.match(conceptCatalog, /--cr-cols: 16/);
  assert.match(conceptCatalog, /min-width: 1480px/);
  assert.match(conceptCatalog, /max-height: 720px/);
  assert.equal(conceptPanels.length, 5);
  for (const panel of conceptPanels) {
    assert.ok((panel.match(/class="cr-diagram-node"/g) || []).length >= 10);
    assert.equal((panel.match(/class="example-brief"/g) || []).length, 1);
    assert.equal((panel.match(/class="example-reading"/g) || []).length, 1);
  }
  assert.match(conceptCatalog, /#view-system:checked ~ \.pattern-panels \[data-panel="system"\]/);
  assert.match(conceptCatalog, /#view-reasoning:focus-visible ~ \.pattern-tabs label\[for="view-reasoning"\]/);
  assert.ok(html.includes("details.cr-diagram-node > summary"));
  assert.ok(html.includes(".cr-diagram-node:has(> summary:focus-visible)"));
  for (const pattern of VISUAL_DOCUMENT_PATTERNS) {
    assert.ok(html.includes("." + pattern.className), `missing injected styles for ${pattern.className}`);
    assert.ok(reference.includes("`." + pattern.className), `missing reference for ${pattern.className}`);
  }
  for (const catalog of [conceptCatalog, dataCatalog]) {
    assert.doesNotMatch(catalog, /<script\b/i);
    assert.doesNotMatch(catalog, /\b(?:src|href)=["']https?:/i);
  }
});

test("file opening shows content before secondary dependencies and keeps actions stable", () => {
  const html = renderAppHtml();
  const selectFileFn = html.match(/async function selectFile\(path, options = \{\}\) \{[\s\S]*?\n\}\n\nasync function selectStartupContextFile/)?.[0] || "";

  assert.match(selectFileFn, /const fileRequest = readFileForOpen\(path, \{ force: options\.forceReload \}\);/);
  assert.match(selectFileFn, /const annotationsRequest = settleUiRequest\(loadAnnotationsForPath\(path\)\);/);
  assert.match(selectFileFn, /const diffRequest = settleUiRequest\(readDiffForOpen\(path, \{ force: options\.forceReload \}\)\);/);
  assert.match(selectFileFn, /const reviewBaseRequest = options\.reviewMode[\s\S]*settleUiRequest\(readSelectedReviewBase\(path\)\)/);
  assert.match(selectFileFn, /const data = await fileRequest;[\s\S]*await annotationsRequest;/);
  assert.match(selectFileFn, /state\.fileContentReadyPath = path;\s*renderViewer\(\);\s*restorePersistedViewState\(options\.restoreViewState\);/);
  assert.match(selectFileFn, /setStatus\("open · loading Git diff\.\.\."\);/);
  assert.match(selectFileFn, /const \[diffResult, reviewBaseResult\] = await Promise\.all\(\[diffRequest, reviewBaseRequest\]\);/);
  assert.match(selectFileFn, /const \[diffResult, reviewBaseResult\] = await Promise\.all\(\[diffRequest, reviewBaseRequest\]\);[\s\S]*?finishOpen\(diffResult, reviewBaseResult\);/);
  assert.doesNotMatch(selectFileFn, /finishOpen\(null, null\)/);
  assert.doesNotMatch(selectFileFn, /diffRequest\.then/);
  assert.doesNotMatch(selectFileFn, /await loadAnnotationsForPath\(path\)[\s\S]*renderViewer\(\);[\s\S]*const loadDiff/);
  assert.match(selectFileFn, /const contentViewState = captureEditorViewState\(\);/);
  assert.match(selectFileFn, /state\.openingFilePath = null;\s*state\.fileContentReadyPath = null;/);
  assert.match(selectFileFn, /restoreEditorViewState\(contentViewState\);/);
  assert.match(html, /function applyChangedFileInlineReview\(path, diff, review, requestId = state\.selectionRequest\)/);
  assert.match(html, /return applyChangedFileInlineReview\(path, diff, review, requestId\);/);
  assert.match(html, /\[data-file-path\], \[data-review-path\], \[data-hub-file\]/);
  assert.match(html, /const diffPromise = api\("\/api\/file\/diff\?path=" \+ encodeURIComponent\(path\)\);/);
  assert.match(html, /document\.addEventListener\("pointerover", \(event\) => schedulePrefetchPathFromTarget\(event\.target\)/);
  assert.match(html, /workspaceDock\?\.setAttribute\("aria-busy", fileOpening \? "true" : "false"\);/);
  assert.doesNotMatch(html, /\.workspace-dock\.file-opening\s*\{[^}]*visibility:\s*hidden/);
});

test("verification actions are limited to files opened from the review queue", () => {
  const html = renderAppHtml();

  assert.match(html, /reviewModePath: null, reviewModeStatus: null/);
  assert.match(html, /openReviewQueueItem\(item\)\.catch\(\(error\) => setStatus\(error\.message\)\)/);
  assert.match(html, /await selectStartupContextFile\(item\.startupContext\.order, \{ reviewMode: true \}\);/);
  assert.match(html, /await selectFile\(item\.path, \{ reviewMode: true \}\);/);
  assert.match(html, /state\.reviewModePath = options\.reviewMode \? path : null;/);
  assert.match(html, /state\.reviewModePath = options\.reviewMode \? finalPath : null;/);
  assert.match(html, /function reviewActionForSelectedFile\(\)/);
  assert.match(html, /if \(!state\.selected \|\| state\.reviewModePath !== state\.selected\) return null;/);
  assert.match(html, /if \(state\.reviewModeStatus === "verified"\) return null;/);
  assert.match(html, /const reviewItem = state\.docqa\?\.queue\?\.find\(\(item\) => item\.path === state\.selected\);/);
  assert.match(html, /if \(!reviewItem\?\.reviewRequired \|\| String\(reviewItem\.gitStatus \|\| ""\)\.trim\(\)\) return null;/);
  assert.doesNotMatch(html, /label: "Mark unverified"/);
  assert.doesNotMatch(html, />Mark unverified</);
  assert.match(html, /function nextReviewActionForSelectedFile\(\)/);
  assert.match(html, /return nextReviewItemForManualAdvance\(\) \? \{ label: "Next review" \} : null;/);
  assert.doesNotMatch(html, /state\.reviewModeStatus !== "verified"/);
  assert.match(html, /data-file-review-decision/);
  assert.match(html, /data-next-review/);
  assert.match(html, /openNextReviewManually\(\)\.catch\(\(error\) => setStatus\(error\.message\)\)/);
  assert.match(html, /requestReviewDecision\(state\.selected, event\.currentTarget\.dataset\.fileReviewDecision\)/);
  assert.match(html, /VERIFY_CONFIRM_STORAGE_KEY = "context-room:skip-mark-verified-confirm"/);
  assert.match(html, /checkboxLabel: "Do not ask again"/);
  assert.match(html, /confirmVariant: "primary"/);
  assert.match(html, /body: "This marks the current content as trusted\. Use Next review when ready\."/);
  assert.match(html, /if \(!reviewActionForSelectedFile\(\)\) return;/);
  assert.match(html, /applyReviewDecision\(path, "verified"\)/);
  assert.match(html, /const previousQueue = options\.previousQueue \|\| state\.docqa\?\.queue \|\| \[\];/);
  assert.match(html, /function nextReviewItemAfter\(previousQueue = \[\], currentPath = null, nextQueue = \[\]\)/);
  assert.match(html, /function nextReviewItemForManualAdvance\(\) \{[\s\S]*return nextReviewItemAfter\(queue, state\.reviewModePath \|\| state\.selected \|\| state\.selectedReview, queue\);/);
  assert.match(html, /async function waitForReviewFinalizationBeforeNavigation\(\)/);
  assert.match(html, /async function openNextReviewManually\(\) \{\s*await waitForReviewFinalizationBeforeNavigation\(\);/);
  assert.match(html, /async function handleHubAction\(\)[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);\s*goHub\(\);/);
  assert.match(html, /async function selectFile\(path, options = \{\}\) \{[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);/);
  assert.match(html, /async function advanceAfterInlineReviewRemoval\(path, previousQueue, statusWhenDone\)/);
  assert.doesNotMatch(html, /file verified · next doc open/);
  assert.doesNotMatch(html, /review applied · next doc open/);
  assert.match(html, /status === "unverified"/);
  assert.doesNotMatch(html, /selectedFileNeedsReview/);
  assert.doesNotMatch(html, /data-file-verify/);
});

test("review queue groups removed files into a selectable human-confirmed batch", () => {
  const html = renderAppHtml();

  assert.match(html, /const groupDeletions = Number\(s\.deletedDocs \|\| 0\) > 1 \|\| state\.deletionBatchItems\.length > 0;/);
  assert.match(html, /item\.resourceState === "absent"/);
  assert.match(html, /item\.batchDeletion === true/);
  assert.match(html, /queue\.filter\(\(item\) => !isDeletedReviewQueueItem\(item\)\)/);
  assert.match(html, /data-review-deletion-batch/);
  assert.match(html, /Files removed together/);
  assert.match(html, /review this cleanup as one change set/);
  assert.match(html, /data-review-deletion-path/);
  assert.match(html, /data-review-deletion-select-all/);
  assert.match(html, /data-review-deletion-confirm/);
  assert.match(html, /preserveSelection \? previousSelection\.has\(item\.path\) : !item\.protected/);
  assert.match(html, /checkboxLabel: protectedCount \? "I reviewed the protected paths" : ""/);
  assert.match(html, /checkboxRequired: Boolean\(protectedCount\)/);
  assert.match(html, /checkboxRequired \? ' disabled' : ''/);
  assert.match(html, /data-confirm-accept\]"\)\.disabled = !event\.currentTarget\.checked/);
  assert.match(html, /state\.deletionBatchKey !== String\(s\.deletedReviewKey \|\| ""\)/);
  assert.match(html, /const restoreDeletionBatchFocus = Boolean\(loadedBatchChanged/);
  assert.match(html, /if \(restoreDeletionBatchFocus\) document\.querySelector\("\[data-review-deletion-batch\] > summary"\)\?\.focus\(\);/);
  assert.match(html, /details\?\.setAttribute\("aria-busy", "true"\)/);
  assert.match(html, /if \(state\.deletionBatchLoading\) return;/);
  assert.match(html, /\.review-deletion-body button, \.review-deletion-body input/);
  assert.match(html, /deletedReviewKey: state\.deletionBatchKey/);
  assert.match(html, /data-review-deletion-retry/);
  assert.match(html, /data-review-deletion-batch' \+ detailsOpen \+ detailsBusy/);
  assert.match(html, /data-review-deletion-select-all' \+ controlsDisabled/);
  assert.match(html, /api\("\/api\/docqa\/review-deletions"\)/);
  assert.match(html, /const batchKey = state\.deletionBatchKey;/);
  assert.match(html, /method: "POST"[\s\S]*JSON\.stringify\(\{ paths, key: batchKey, protectedAcknowledged \}\)/);
  assert.match(html, /onConfirm: \(\{ checked \}\) => confirmDeletionReviewBatch/);
  assert.match(html, /These files are already absent\. This records that their removal was intentional; it does not delete files\./);
  assert.match(html, /if \(result\.docqa\) state\.docqa = result\.docqa;/);
  assert.match(html, /backdrop\.querySelector\(checkboxRequired \? "\[data-confirm-checkbox\]" : "\[data-confirm-accept\]"\)\?\.focus\(\);/);
  assert.match(html, /if \(restoreFocus && returnFocus\?\.isConnected\) returnFocus\.focus\(\);/);
  assert.match(html, /appShell\?\.setAttribute\("inert", ""\)/);
  assert.match(html, /if \(event\.key !== "Tab"\) return;/);
  assert.match(html, /document\.querySelector\("\[data-review-deletion-batch\] > summary"\) \|\| el\("reviewQueueHeading"\)/);
  assert.match(html, /state\.deletionBatchItems\.find\(\(item\) => item\.path === path\)/);
  assert.match(html, /\.review-deletion-batch \{[^}]*border-left: 3px solid var\(--danger\)/);
});

test("opening a file never reopens a collapsed explorer", () => {
  const html = renderAppHtml();

  assert.match(html, /const explorerWasCollapsed = document\.querySelector\("\.app"\)\?\.classList\.contains\("sidebar-collapsed"\);/);
  assert.doesNotMatch(html, /if \(options\.revealInExplorer\) \{[\s\S]{0,180}classList\.remove\("sidebar-collapsed"\)/);
  assert.match(html, /if \(options\.revealInExplorer && !explorerWasCollapsed\) scrollExplorerToPath\(path\);/);
});

test("context health is a compact triggered-alert panel", () => {
  const html = renderAppHtml();

  assert.match(html, /id="contextHealthPanel" class="docqa-panel" hidden/);
  assert.doesNotMatch(html, /shown only when checks need attention/);
  assert.match(html, /\["critical", "high", "medium"\]\.includes\(issue\.severity\) && !issue\.acknowledged/);
  assert.match(html, /if \(!issues\.length\) \{[\s\S]*panel\.hidden = true;[\s\S]*return;/);
  assert.match(html, /panel\.hidden = false;/);
  assert.match(html, /issue' \+ \(issues\.length > 1 \? 's' : ''\) \+ ' triggered/);
  assert.match(html, /issues\.slice\(0, 5\)/);
  assert.match(html, /data-health-ack/);
  assert.match(html, /api\("\/api\/doctor\/ack"/);
  assert.match(html, /function acknowledgeContextHealthIssueFromPanel\(key\)/);
  assert.doesNotMatch(html, /<span>no metadata<\/span>/);
  assert.doesNotMatch(html, /Context health is clean\./);
});

test("review queue opens changed files with the inline segment review engine", () => {
  const html = renderAppHtml();

  assert.match(html, /\/api\/file\/review-base\?path=/);
  assert.match(html, /data-startup-review-order/);
  assert.match(html, /async function startChangedFileInlineReview\(path, diff, requestId = state\.selectionRequest\)/);
  assert.match(html, /if \(options\.reviewMode && diff\.changed && reviewBaseResult\?\.value\) \{\s*applyChangedFileInlineReview\(path, diff, reviewBaseResult\.value, requestId\);/);
  assert.match(html, /if \(options\.reviewMode\) await startChangedFileInlineReview\(finalPath, \{ changed: true \}, requestId\)/);
  assert.match(html, /source: "review"/);
  assert.match(html, /reviewSessions: \{\}/);
  assert.match(html, /const baseContent = typeof review\.baseContent === "string" \? review\.baseContent : "";/);
  assert.match(html, /const previousSession = state\.reviewSessions\?\.\[path\] \|\| null;/);
  assert.match(html, /previousSession\.baseContent === baseContent/);
  assert.match(html, /previousSession\.diskContent === diskContent/);
  assert.match(html, /reviewDecisions,\s*};/);
  assert.match(html, /changeKind: review\.changeKind \|\| "modified"/);
  assert.match(html, /function externalReviewBaseContent\(change = activeExternalChange\(\)\)/);
  assert.match(html, /function rememberActiveReviewSession\(\)/);
  assert.match(html, /state\.reviewSessions\[change\.path\] = \{/);
  assert.match(html, /function clearReviewSession\(path\)/);
  assert.match(html, /function resetExternalChangeState\(options = \{\}\)/);
  assert.match(html, /if \(options\.discardReview\) clearReviewSession\(path\);/);
  assert.match(html, /const pathLine = item\.oldPath/);
  assert.match(html, /escapeHtml\(item\.oldPath\) \+ " -> " \+ escapeHtml\(item\.path\)/);
  assert.match(html, /async function recordSelectedReviewBaseline\(path = state\.selected, note = ""\)/);
  assert.match(html, /function selectedStartupContextReviewPath\(path = state\.selected\)/);
  assert.match(html, /\/api\/docqa\/review-baseline/);
  assert.match(html, /const shouldRecordReviewBaseline = change\.source === "review" \|\| change\.source === "disk";/);
  assert.match(html, /if \(shouldRecordReviewBaseline\) await recordSelectedReviewBaseline\(change\.path, "inline review applied"\);/);
  assert.match(html, /const previousQueue = state\.docqa\?\.queue \|\| \[\];/);
  assert.match(html, /await applyReviewDecision\(change\.path, "verified", \{ previousQueue \}\);/);
  assert.match(html, /await advanceAfterInlineReviewRemoval\(change\.path, previousQueue, "new file rejected · no more docs to review"\);/);
  assert.match(html, /nextReviewAction: nextReviewActionForSelectedFile\(\)/);
  assert.match(html, /replaceExternalReviewActionsInPlace\(merged\);/);
  assert.match(html, /renderExternalReviewDocument\(externalReviewBaseContent\(externalChange\), externalChange\.diskContent \|\| ""\)/);
  assert.match(html, /buildExternalReviewBlocks\(externalReviewBaseContent\(change\), change\.diskContent \|\| "", change\.reviewDecisions/);
  assert.match(html, /computeExternalReviewContent\(blocks, externalReviewBaseContent\(change\), change\.diskContent \|\| ""\)/);
  assert.match(html, /const change = state\.externalChange;/);
  assert.match(html, /const ignoredMetadataOnly = onlyIgnoredReviewMetadataChanged\(baseContent, diskContent\);/);
  assert.match(html, /if \(baseContent === diskContent \|\| ignoredMetadataOnly\) \{/);
  assert.match(html, /last_verified synced · ready for verification/);
  assert.match(html, /changes already reviewed · mark verified when ready/);
  assert.match(html, /review\.changeKind === "renamed" \? "renamed file waiting for review"/);
  assert.match(html, /if \(activeExternalChange\(\)\?\.source === "review"\) \{[\s\S]*state\.selectedDiff = await readSelectedDiff\(previousSelected\);[\s\S]*return;[\s\S]*\}/);
  assert.doesNotMatch(html, /function activeBlockingExternalChange\(\)/);
  assert.doesNotMatch(html, /function blockPendingExternalChange\(/);
  assert.doesNotMatch(html, /shouldAutoReloadCleanStartupDiskChange/);
  assert.doesNotMatch(html, /external startup file reloaded from disk/);
  assert.match(html, /state\.externalChange = \{\s*path: previousSelected,\s*source: "disk",/);
  assert.match(html, /setStatus\("file changed on disk · review before applying"\);/);
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
  assert.match(html, /userScrollIntentAt: 0/);
  assert.match(html, /function markUserScrollIntent\(\)/);
  assert.match(html, /function isScrollIntentKey\(event\)/);
  assert.match(html, /document\.addEventListener\("wheel", markUserScrollIntent/);
  assert.match(html, /document\.addEventListener\("touchmove", markUserScrollIntent/);
  assert.match(html, /function setDiffCollapsed\(collapsed\)/);
  assert.match(html, /function wireFileActionButtons\(root = document\)/);
  assert.match(html, /setDiffCollapsed\(true\)/);
  assert.match(html, /setDiffCollapsed\(false\)/);
  assert.match(html, /function updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /function wireExternalReviewDecisionButtons\(root = document\)/);
  assert.match(html, /captureEditorViewState\(\{ anchorBlockId: blockId \}\)/);
  assert.match(html, /viewState\.visualAnchor = captureMarkdownVisualAnchor\(\);/);
  assert.match(html, /event\.stopPropagation\(\)/);
  assert.match(html, /anchorTop/);
  assert.match(html, /document\.querySelector\("\.external-review-doc"\)/);
  assert.match(html, /\.external-review-doc\s*\{[^}]*overflow-anchor:\s*none/);
  assert.match(html, /snapshot\.documentScrollTarget === "docReader"/);
  assert.match(html, /documentScrollTop/);
  assert.match(html, /documentViewportTop/);
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

test("inline review distinguishes layout scroll from user scroll", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const source = script.slice(
    script.indexOf("function captureInlineReviewScrollSnapshot"),
    script.indexOf("function captureMarkdownVisualAnchor"),
  );
  const state = { userScrollIntentAt: 10 };
  const currentScroll = {
    path: "docs/guide.md",
    documentScrollTop: 420,
    documentScrollLeft: 0,
    editorScrollTop: 420,
    editorScrollLeft: 0,
    viewerScrollTop: 420,
    viewerScrollLeft: 0,
    windowScrollX: 0,
    windowScrollY: 0,
  };
  const helpers = Function(
    "state",
    "captureEditorViewState",
    source + "; return { rememberInlineReviewLiveScrollIfChanged };",
  )(state, () => ({ ...currentScroll }));
  const transitionStart = { ...currentScroll, documentScrollTop: 240, editorScrollTop: 240, viewerScrollTop: 240, userScrollIntentAt: 10 };
  const viewState = { path: "docs/guide.md", anchorBlockId: "change-1" };

  assert.equal(helpers.rememberInlineReviewLiveScrollIfChanged(viewState, transitionStart), false);
  assert.equal(viewState.userScrolledDuringInlineReview, undefined);

  state.userScrollIntentAt = 11;
  assert.equal(helpers.rememberInlineReviewLiveScrollIfChanged(viewState, transitionStart), true);
  assert.equal(viewState.userScrolledDuringInlineReview, true);
  assert.equal(viewState.liveScrollState.documentScrollTop, 420);
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
  assert.match(html, /AGENT_COMMAND_ACK_STORAGE_KEY = "context-room:last-agent-command-id"/);
  assert.match(html, /AGENT_COMMAND_MAX_AGE_MS = 60_000/);
  assert.match(html, /function startAgentCommandPolling\(\)/);
  assert.match(html, /api\("\/api\/agent\/command"\)/);
  assert.match(html, /state\.lastAgentCommandId = readLastAgentCommandId\(\);/);
  assert.match(html, /if \(isStaleAgentCommand\(command\)\) \{[\s\S]*rememberAgentCommandId\(command\.id\);[\s\S]*return;[\s\S]*\}/);
  assert.match(html, /function rememberAgentCommandId\(id\)/);
  assert.match(html, /function isStaleAgentCommand\(command\)/);
  assert.match(html, /function executeAgentCommand\(command\)/);
  assert.match(html, /if \(command\?\.id\) rememberAgentCommandId\(command\.id\);/);
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
  assert.match(html, /Document with file changes highlighted/);
  assert.match(html, /data-external-block-decision="accept"/);
  assert.match(html, /data-external-block-decision="reject"/);
  assert.match(html, /data-external-block-id/);
  assert.match(html, /data-external-review-all="accept"/);
  assert.match(html, /data-external-review-all="reject"/);
  assert.match(html, /data-external-review-jump="first"/);
  assert.match(html, />OK<\/button>/);
  assert.match(html, />x<\/button>/);
  assert.match(html, />First change<\/button>/);
  assert.match(html, />Accept all<\/button>/);
  assert.match(html, />Reject all<\/button>/);
  assert.match(html, /buildExternalReviewBlocks/);
  assert.match(html, /chooseExternalReviewBlock/);
  assert.match(html, /function chooseAllExternalReviewBlocks\(decision\)/);
  assert.match(html, /function wireExternalReviewAllButtons\(root = document\)/);
  assert.match(html, /function wireExternalReviewJumpButtons\(root = document\)/);
  assert.match(html, /if \(focusFirstExternalReviewChange\(\)\) setStatus\("showing first change"\);/);
  assert.match(html, /updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /renderExternalReviewBlock\(block, \{ finalLineStart: externalReviewFinalLineStart\(blocks, blockId\) \}\)/);
  assert.match(html, /function updateExternalReviewDocumentInPlace\(blocks\)/);
  assert.match(html, /doc\.innerHTML = renderExternalReviewBlocks\(blocks\);/);
  assert.match(html, /function refreshExternalReviewFinalLineIndexes\(blocks\)/);
  assert.match(html, /refreshExternalReviewFinalLineIndexes\(blocks\);/);
  assert.match(html, /const settlePromise = updatedInPlace[\s\S]*settleExternalReviewBlocks\(\[blockId\], viewState, \{ restoreScroll: false \}\)/);
  assert.match(html, /if \(pending\.length\)[\s\S]*await finalizeExternalReview\(settlePromise, blocks, viewState\);/);
  assert.match(html, /const updatedInPlace = updateExternalReviewBlockInPlace\(blocks, blockId, viewState\);[\s\S]*if \(!updatedInPlace\) renderViewer\(\);\s*else updateExternalReviewActionsInPlace\(change\);\s*updateHeader\(\);/);
  assert.match(html, /actions\.outerHTML = renderExternalReviewActions\(change, \{ fileActionOptions: externalReviewFileActionOptions\(\) \}\);/);
  assert.match(html, /wireExternalReviewJumpButtons\(document\.querySelector\("\.file-panel > header"\) \|\| document\);/);
  assert.match(html, /externalReviewRowsForDecision/);
  assert.match(html, /function renderExternalReviewFinalLines\(rows, options = \{\}\)/);
  assert.match(html, /function renderExternalReviewBlocks\(blocks\)/);
  assert.match(html, /function externalReviewFinalLineStart\(blocks, blockId\)/);
  assert.match(html, /function finalLineDecorations\(rows, finalLineStart = null\)/);
  assert.match(html, /external-review-block context markdown-view[\s\S]*renderMarkdownLines\(block\.rows\.map\(\(row\) => row\.line\)\.join\("\\n"\), \{ lineDecorations: finalLineDecorations\(block\.rows, options\.finalLineStart\) \}\)/);
  assert.match(html, /external-review-final-lines markdown-view/);
  assert.match(html, /external-review-block context resolved/);
  assert.match(html, /external-review-block context resolved [^"]*empty/);
  assert.match(html, /external-review-lines markdown-view/);
  assert.doesNotMatch(html, /external-review-line-content markdown-view/);
  assert.match(html, /renderMarkdownLines\(text, \{ lineDecorations \}\)/);
  assert.match(html, /function externalReviewIntralineRows\(rows\)/);
  assert.match(html, /function buildIntralineTokenDiff\(beforeText, afterText\)/);
  assert.match(html, /function renderIntralineSegments\(segments, changeType\)/);
  assert.match(html, /intralineHtml:\s*intraline\?\.html \|\| ""/);
  assert.match(html, /intraline-superseded/);
  assert.match(html, /intraline-merged/);
  assert.match(html, /if \(!decoration\.intralineHtml\) return decorated;/);
  assert.doesNotMatch(html, /external-review-resolved-label/);
  assert.doesNotMatch(html, /external-review-placeholder/);
  assert.doesNotMatch(html, /Change rejected/);
  assert.doesNotMatch(html, /Change accepted/);
  assert.match(html, /computeExternalReviewContent/);
  assert.match(html, /renderExternalReviewDocument/);
  assert.match(html, /const metricClass = " editor-metrics";/);
  assert.match(html, /doc-editor external-review-doc' \+ metricClass/);
  assert.match(html, /renderExternalReviewActions/);
  assert.match(html, /const pendingLabel = summary\.pending \? summary\.pending \+ " left" : "saving\.\.\.";/);
  assert.doesNotMatch(html, /const pendingLabel = summary\.pending \? summary\.pending \+ " left" : "reviewed";/);
  assert.match(html, /const bulkActions = summary\.pending && \(visualHtmlReview \|\| summary\.pending > 1 \|\| summary\.pendingLines > 1\)/);
  assert.match(html, /function updateExternalReviewActionsInPlace\(change = activeExternalChange\(\)\)/);
  assert.match(html, /function renderFileActionItems\(/);
  assert.match(html, /function externalReviewFileActionOptions\(\)/);
  assert.match(html, /renderExternalReviewActions\(externalChange, \{ fileActionOptions: externalReviewFileActionOptions\(\) \}\)/);
  assert.match(html, /blockedByConflict:\s*true/);
  assert.match(html, /summary\.pending && \(visualHtmlReview \|\| summary\.pending > 1 \|\| summary\.pendingLines > 1\)/);
  assert.match(html, /pendingBlock && \(row\.type === "add" \|\| row\.type === "del"\)/);
  assert.match(html, /state\.externalChange = \{[\s\S]*reviewDecisions: \{\},[\s\S]*\};\s*state\.selectedDiff = diff;\s*state\.diffCollapsed = true;/);
  assert.match(html, /state\.openingFilePath = path;[\s\S]*state\.savedHash = data\.contentHash;[\s\S]*state\.openingFilePath = null;/);
  assert.match(html, /if \(state\.openingFilePath === state\.selected \|\| state\.savedHash == null\) return;/);
  assert.match(html, /if \(!state\.selected \|\| state\.selectedReadOnly \|\| !state\.dirty \|\| state\.openingFilePath === state\.selected \|\| state\.savedHash == null\) return;/);
  assert.match(html, /const viewState = captureEditorViewState\(\);[\s\S]*state\.externalChange = \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /const previousHeight = current\.getBoundingClientRect\(\)\.height;/);
  assert.match(html, /next\.style\.minHeight = Math\.ceil\(previousHeight\) \+ "px"/);
  assert.match(html, /function waitForInlineReviewTransition\(settlePromise = null\)/);
  assert.match(html, /await waitForInlineReviewTransition\(settlePromise\)/);
  assert.match(html, /reviewFinalizationPromise: null/);
  assert.match(html, /async function finalizeExternalReview\(settlePromise, blocks, viewState\)/);
  assert.match(html, /state\.reviewFinalizationPromise = finalization;/);
  assert.match(html, /await saveExternalReviewDecision\(blocks, viewState\);/);
  assert.match(html, /if \(state\.reviewFinalizationPromise === finalization\) \{\s*state\.reviewFinalizationPromise = null;/);
  assert.match(html, /function externalReviewTextAnchor\(blocks, blockId, mergedText\)/);
  assert.match(html, /viewState\.textAnchor = externalReviewTextAnchor\(blocks, viewState\.anchorBlockId, merged\);/);
  assert.match(html, /function textOffsetForLineIndex\(lines, lineIndex\)/);
  assert.match(html, /function finishExternalReviewPanelInPlace\(viewState\)/);
  assert.match(html, /if \(!finishExternalReviewPanelInPlace\(viewState\)\) \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /function finalizeExternalReviewPanelInPlace\(viewState\)/);
  assert.match(html, /const visualAnchor = captureMarkdownVisualAnchor\(doc\);/);
  assert.match(html, /const restoreState = inlineReviewRestoreViewState\(viewState\);/);
  assert.match(html, /doc\.outerHTML = state\.mode === "edit" \? renderMarkdownEditor\(text\) : renderMarkdownLineView\(text\);/);
  assert.match(html, /restoreFinalReviewViewport\(visualAnchor, restoreState\);/);
  assert.match(html, /function restoreFinalReviewViewport\(visualAnchor, restoreState\)/);
  assert.match(html, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*window\.requestAnimationFrame\(apply\)/);
  assert.match(html, /function replaceExternalReviewActionsInPlace\(text = ""\)/);
  assert.match(html, /replaceExternalReviewActionsInPlace\(text\);/);
  assert.match(html, /function wireRenderedMarkdownEditor\(\)/);
  assert.match(html, /function settleFinishedExternalReview\(viewState\)/);
  assert.doesNotMatch(html, /doc\.classList\.add\("settled"\)/);
  assert.match(html, /function settleExternalReviewBlocks\(blocksOrIds, viewState, options = \{\}\)/);
  assert.match(html, /const restoreScroll = options\.restoreScroll !== false/);
  assert.match(html, /!block\.classList\.contains\("settling"\) && !block\.classList\.contains\("settled"\)/);
  assert.match(html, /block\.classList\.add\("settled"\)/);
  assert.match(html, /settleFinishedExternalReview\(viewState\)\.then/);
  assert.match(html, /if \(!activeExternalChange\(\) && document\.querySelector\("\.external-review-doc"\)\) \{[\s\S]*finalizeExternalReviewPanelInPlace\(viewState\);/);
  assert.match(html, /\.external-review-block\.resolved\.settling\s*\{[^}]*height 2s ease[^}]*min-height 2s ease/);
  assert.match(html, /block\.classList\.add\("settling"\)/);
  assert.match(html, /const targetHeight = naturalExternalReviewBlockHeight\(block\);/);
  assert.match(html, /function naturalExternalReviewBlockHeight\(block\)/);
  assert.match(html, /const parent = block\.parentElement \|\| document\.body;/);
  assert.match(html, /parent\.appendChild\(clone\);/);
  assert.doesNotMatch(html, /document\.body\.appendChild\(clone\);/);
  assert.match(html, /const anchorTop = typeof viewState\?\.anchorTop === "number" \? viewState\.anchorTop : anchor \? anchor\.getBoundingClientRect\(\)\.top : null;/);
  assert.match(html, /shiftScrollForElement\(anchor, anchor\.getBoundingClientRect\(\)\.top - anchorTop\);/);
  assert.match(html, /const transitionScrollStart = captureInlineReviewScrollSnapshot\(viewState\);/);
  assert.match(html, /const scrolledDuringTransition = rememberInlineReviewLiveScrollIfChanged\(viewState, transitionScrollStart\);/);
  assert.match(html, /if \(!scrolledDuringTransition\) \{[\s\S]*restoreEditorViewState\(viewState\);[\s\S]*\}/);
  assert.match(html, /function captureInlineReviewScrollSnapshot\(viewState = null\)/);
  assert.match(html, /function inlineReviewScrollChangedSince\(snapshot\)/);
  assert.match(html, /function rememberInlineReviewLiveScrollIfChanged\(viewState, snapshot\)/);
  assert.match(html, /const userRequestedScroll = \(state\.userScrollIntentAt \|\| 0\) > \(snapshot\?\.userScrollIntentAt \|\| 0\);/);
  assert.match(html, /!viewState \|\| !userRequestedScroll \|\| !inlineReviewScrollChangedSince\(snapshot\)/);
  assert.match(html, /viewState\.userScrolledDuringInlineReview = true;/);
  assert.match(html, /viewState\.liveScrollState = captureEditorViewState/);
  assert.match(html, /function inlineReviewRestoreViewState\(viewState\)/);
  assert.match(html, /viewState\.liveScrollState \|\| captureEditorViewState/);
  assert.match(html, /function captureMarkdownVisualAnchor\(root = null\)/);
  assert.match(html, /visibleLines\.find\(\(line\) => line\.textContent\.trim\(\) && !line\.closest\("\.external-review-block\.change"\)\)/);
  assert.match(html, /lineText: visibleLine\.textContent \|\| ""/);
  assert.match(html, /function restoreExternalReviewVisualAnchor\(anchor\)/);
  assert.match(html, /function restoreInlineReviewViewport\(viewState\)/);
  assert.match(html, /scroller\.scrollTop = Math\.max\(0, \(viewState\.documentScrollTop \|\| 0\) \+ topDelta\)/);
  assert.match(html, /data-final-line-index/);
  assert.match(html, /visibleLine\.dataset\.finalLineIndex \|\| visibleLine\.dataset\.lineIndex/);
  assert.match(html, /function restoreMarkdownVisualAnchor\(anchor\)/);
  assert.match(html, /root\.querySelector\('\.markdown-line\[data-line-index="/);
  assert.match(html, /clone\.classList\.remove\("settling"\);[\s\S]*clone\.classList\.add\("settled"\);/);
  assert.match(html, /function waitForExternalReviewBlockSettle\(block\)/);
  assert.match(html, /event\.target === block && event\.propertyName === "height"/);
  assert.match(html, /window\.setTimeout\(finish, 2400\)/);
  assert.match(html, /function restoreEditorViewState\(snapshot, options = \{\}\)/);
  assert.match(html, /const deferred = options\.deferred !== false;/);
  assert.match(html, /if \(!deferred\) return;[\s\S]*window\.requestAnimationFrame/);
  assert.doesNotMatch(html, /\.external-review-doc\.settled \.external-review-block\.resolved/);
  assert.match(html, /\.external-review-block\.resolved\.settled\.empty\s*\{[^}]*min-height:\s*0/);
  assert.match(html, /resetExternalChangeState\(change\.source === "review" \? \{ discardReview: true \} : \{\}\);\s*\/\/ Returning from inline review should keep[\s\S]*state\.diffCollapsed = true;/);
  assert.match(html, /applyReviewDecision\(change\.path, "verified", \{ previousQueue, viewState \}\)/);
  assert.match(html, /const finalizedInPlace = options\.viewState \? finalizeExternalReviewPanelInPlace\(options\.viewState\) : false;/);
  assert.match(html, /if \(!restoreInlineReviewViewport\(viewState\) && anchor && typeof anchorTop === "number"\)/);
  assert.match(html, /block\.decision === "accept"[\s\S]*row\.type !== "del"/);
  assert.match(html, /block\.decision === "reject"[\s\S]*row\.type !== "add"/);
  assert.doesNotMatch(html, /external-review-block\.accept \.external-review-line\.del/);
  assert.match(html, /external-review-final-lines markdown-view/);
  assert.match(html, /external-review-lines markdown-view/);
  assert.doesNotMatch(html, /external-review-line-content markdown-view/);
  assert.doesNotMatch(html, /external-change-panel/);
  assert.match(html, /file changed on disk · review before applying/);
  assert.doesNotMatch(html, /blockPendingExternalChange/);
  assert.match(html, /async function goHistory\(delta\) \{[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);[\s\S]*await selectFile/);
  assert.match(html, /function goHub\(\) \{[\s\S]*resetExternalChangeState\(\);[\s\S]*showHome\(\);/);
  assert.match(html, /function firstExternalReviewChangeBlockId\(\)/);
  assert.match(html, /return externalReviewChangeElements\(\)\[0\]\?\.dataset\.externalReviewBlock \|\| "";/);
  assert.match(html, /function focusFirstExternalReviewChange\(\)/);
  assert.match(html, /function focusExternalReviewChange\(blockId\)/);
  assert.match(html, /function closestExternalReviewChangeElement\(\)/);
  assert.match(html, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center", inline: "nearest" \}\)/);
  assert.match(html, /\.external-review-block\.attention/);
  assert.match(html, /@keyframes externalReviewAttention/);
  assert.match(html, /if \(!state\.dirty\) return;/);
  assert.match(html, /if \(onlyIgnoredReviewMetadataChanged\(state\.saved \|\| "", data\.content\)\) \{/);
  assert.match(html, /setStatus\("last_verified synced"\);/);
  assert.doesNotMatch(html, /activeBlockingExternalChange/);
  assert.match(html, /apply or reject before saving/);
  assert.doesNotMatch(html, /setStatus\("reloaded from disk"\);\n  \} catch \(error\) \{\n    setStatus\(error\.message\);\n  \}\n\}/);
});

test("inline review highlights only changed paragraph fragments", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const source = script.slice(
    script.indexOf("function renderExternalReviewRows"),
    script.indexOf("function renderExternalReviewFinalLines"),
  );
  const renderMarkdownInline = (text) => text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const renderMarkdownLines = (text, { lineDecorations }) => text.split("\n").map((line, index) => {
    const decoration = lineDecorations[index];
    return '<div class="' + decoration.className + '">' + (decoration.intralineHtml || line) + "</div>";
  }).join("");
  const helpers = Function(
    "renderMarkdownInline",
    "renderMarkdownLines",
    "finalLineIndexForRow",
    source + "; return { renderExternalReviewRows, externalReviewIntralineRows, buildIntralineTokenDiff, renderIntralineSegments, renderMergedIntralineSegments, shouldMergeIntralineDiff };",
  )(renderMarkdownInline, renderMarkdownLines, () => null);

  const insertion = helpers.buildIntralineTokenDiff(
    "The shared key is canonical.",
    "The shared key is canonical. A date-only edit is omitted.",
  );
  assert.ok(insertion.similarity >= 0.34);
  assert.equal(insertion.deletedWords, 0);
  assert.ok(insertion.changeRatio > 0.25);
  assert.equal(helpers.shouldMergeIntralineDiff(insertion), true);
  assert.equal(helpers.renderIntralineSegments(insertion.before, "del"), "The shared key is canonical.");
  assert.match(
    helpers.renderIntralineSegments(insertion.after, "add"),
    /The shared key is canonical\.<span class="external-review-token add"> A date-only edit is omitted\.<\/span>/,
  );
  const insertionRows = helpers.externalReviewIntralineRows([
    { type: "del", line: "The shared key is canonical." },
    { type: "add", line: "The shared key is canonical. A date-only edit is omitted." },
  ]);
  assert.equal(insertionRows.get(0).hidden, true);
  assert.equal(insertionRows.get(1).merged, true);
  assert.equal(insertionRows.get(1).kind, "addition");
  const insertionHtml = helpers.renderExternalReviewRows([
    { type: "del", line: "The shared key is canonical." },
    { type: "add", line: "The shared key is canonical. A date-only edit is omitted." },
  ]);
  assert.match(insertionHtml, /external-review-line del intraline-superseded/);
  assert.match(insertionHtml, /external-review-line add intraline-merged/);
  assert.match(insertionHtml, /<span class="external-review-token add"> A date-only edit is omitted\.<\/span>/);

  const replacement = helpers.buildIntralineTokenDiff(
    "Keep the **clear rule** here.",
    "Keep the **short rule** here.",
  );
  assert.match(
    helpers.renderIntralineSegments(replacement.before, "del"),
    /<span class="external-review-token del"><strong>clear rule<\/strong><\/span>/,
  );
  assert.match(
    helpers.renderIntralineSegments(replacement.after, "add"),
    /<span class="external-review-token add"><strong>short rule<\/strong><\/span>/,
  );
  const replacementRows = helpers.externalReviewIntralineRows([
    { type: "del", line: "Keep the **clear rule** here." },
    { type: "add", line: "Keep the **short rule** here." },
  ]);
  assert.equal(replacementRows.get(0).hidden, true);
  assert.equal(replacementRows.get(1).merged, true);
  assert.equal(replacementRows.get(1).kind, "mixed");
  const replacementHtml = helpers.renderExternalReviewRows([
    { type: "del", line: "Keep the **clear rule** here." },
    { type: "add", line: "Keep the **short rule** here." },
  ]);
  assert.match(replacementHtml, /external-review-line add intraline-merged intraline-mixed/);
  assert.match(replacementHtml, /external-review-token del"><strong>clear rule<\/strong>/);
  assert.match(replacementHtml, /external-review-token add"><strong>short rule<\/strong>/);

  const deletionRows = helpers.externalReviewIntralineRows([
    { type: "del", line: "Keep this obsolete detail here." },
    { type: "add", line: "Keep this detail here." },
  ]);
  assert.equal(deletionRows.get(0).hidden, true);
  assert.equal(deletionRows.get(1).merged, true);
  assert.equal(deletionRows.get(1).kind, "removal");
  const deletionHtml = helpers.renderExternalReviewRows([
    { type: "del", line: "Keep this obsolete detail here." },
    { type: "add", line: "Keep this detail here." },
  ]);
  assert.match(deletionHtml, /external-review-line add intraline-merged intraline-removal/);
  assert.match(deletionHtml, /Keep this <span class="external-review-token del">obsolete <\/span>detail here\./);

  const shared = "Clear reviews keep the reader oriented while preserving enough surrounding context to understand every proposed documentation change";
  const largeBefore = shared + " with many old words that make the previous paragraph needlessly long and difficult to scan for a reviewer.";
  const largeAfter = shared + " with several new terms that make the revised paragraph direct and much easier to verify during review.";
  const largeDiff = helpers.buildIntralineTokenDiff(largeBefore, largeAfter);
  assert.ok(largeDiff.similarity >= 0.34);
  assert.ok(largeDiff.changeRatio > 0.25);
  assert.ok(largeDiff.deletedWords > 0);
  assert.ok(largeDiff.addedWords > 0);
  assert.equal(helpers.shouldMergeIntralineDiff(largeDiff), false);
  const largeRows = helpers.externalReviewIntralineRows([
    { type: "del", line: largeBefore },
    { type: "add", line: largeAfter },
  ]);
  assert.equal(largeRows.get(0).hidden, undefined);
  assert.equal(largeRows.get(0).split, true);
  assert.equal(largeRows.get(1).split, true);
  const largeHtml = helpers.renderExternalReviewRows([
    { type: "del", line: largeBefore },
    { type: "add", line: largeAfter },
  ]);
  assert.equal((largeHtml.match(/intraline-split/g) || []).length, 2);
  assert.match(largeHtml, /external-review-token del/);
  assert.match(largeHtml, /external-review-token add/);

  const longShared = Array.from({ length: 75 }, (_item, index) => "stable" + index).join(" ");
  const longBefore = longShared + " " + Array.from({ length: 12 }, (_item, index) => "old" + index).join(" ");
  const longAfter = longShared + " " + Array.from({ length: 12 }, (_item, index) => "new" + index).join(" ");
  const longDiff = helpers.buildIntralineTokenDiff(longBefore, longAfter);
  assert.ok(longDiff.deletedWords + longDiff.addedWords > 20);
  assert.ok(longDiff.changeRatio < 0.25);
  assert.equal(helpers.shouldMergeIntralineDiff(longDiff), true);
  const longRows = helpers.externalReviewIntralineRows([
    { type: "del", line: longBefore },
    { type: "add", line: longAfter },
  ]);
  assert.equal(longRows.get(0).hidden, true);
  assert.equal(longRows.get(1).merged, true);
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
