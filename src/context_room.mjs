#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { collectInlinePathReferences, parseDocMetadata, renderDocMetadataTemplateValues } from "./doc_metadata.mjs";
import { parseSimpleYaml, stringifyYaml } from "./yaml_utils.mjs";

export { DOC_METADATA_KINDS, DOC_METADATA_STATUSES, parseDocMetadata } from "./doc_metadata.mjs";

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_PORT = 4317;
const MAX_FILE_BYTES = 750_000;
export const CONFIG_DIR = ".context-room";
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/Swarek/context-room/main/schemas/config.schema.json";
const DOCQA_REVIEW_STATE = `${CONFIG_DIR}/review-state.json`;
const MEMORY_WEBAPP_SETTINGS = CONFIG_FILE;
const HERMES_CRON_JOBS_FILE = "~/.hermes/cron/jobs.json";
const HERMES_CRON_JOBS_FOLDER = "~/.hermes/cron/jobs/";
const HERMES_CRON_MD_FOLDER = "~/.hermes/cron/jobs-md/";
const DEFAULT_STARTUP_CONTEXT = { enabled: false, fileNames: ["AGENTS.md", "CLAUDE.md"] };
export const DOCUMENTATION_BEST_PRACTICES = [
  "One file, one clear scope: name what this document is responsible for and what belongs elsewhere.",
  "Start with the goal, then the few durable facts that change decisions.",
  "Keep sections stable and short; prefer links to source files over copied truth.",
  "Use explicit rules for agents and humans: what to do, avoid, verify, or ask.",
  "Update or delete stale context instead of accumulating contradictory prose.",
];
export const DEFAULT_MARKDOWN_TEMPLATES = [
  {
    id: "agents",
    title: "Agent instructions",
    description: "Root or scoped instructions that are injected into AI coding agents.",
    content: `---
context_room:
  kind: agents
  scope: {{scope_yaml}}
  status: {{status_yaml}}
  canonical_for: {{canonical_for_yaml}}
  last_verified: {{last_verified_yaml}}
  sources: {{sources_inline}}
---

# {{title}}

## Purpose
What this instruction file controls, which agents read it, and what it must keep stable.

## Operating Rules
- Rule one.
- Rule two.
- Rule three.

## Read First
- Files or docs the agent should inspect before changing this scope.

## Do Not
- Things that would hurt quality, safety, or maintainability.

## Verification
- Commands, checks, or review gates expected before work is called done.
`,
  },
  {
    id: "docs-index",
    title: "Docs index",
    description: "Short map of a documentation folder: what is canonical and where to go next.",
    content: `---
context_room:
  kind: index
  scope: {{scope_yaml}}
  status: {{status_yaml}}
  canonical_for: {{canonical_for_yaml}}
  last_verified: {{last_verified_yaml}}
  sources: {{sources_inline}}
---

# {{title}}

## Purpose
What this documentation area covers.

## Start Here
- Primary doc:
- Agent instructions:
- Runbooks:
- Decisions:

## Current Sources Of Truth
- Document or source file:

## Historical Or Secondary Docs
- Older docs that may still be useful but are not canonical.
`,
  },
  {
    id: "context-golden",
    title: "Canonical doc",
    description: "Default source-of-truth document for a product, system, feature, or workflow.",
    content: `---
context_room:
  kind: canonical
  scope: {{scope_yaml}}
  status: {{status_yaml}}
  canonical_for: {{canonical_for_yaml}}
  last_verified: {{last_verified_yaml}}
  sources: {{sources_inline}}
---

# {{title}}

## Purpose
Why this file exists, who uses it, and what decision or action it should support.

## Key facts
The 5 to 10 most important durable facts. Short, concrete, current.

## Structure
What lives here, what lives elsewhere, and the important paths to know.

## Rules
Conventions, guardrails, pitfalls, quality criteria, and things not to do.

## References
Sources of truth, related files, commands, or useful links. Do not copy what can be linked.
`,
  },
  {
    id: "procedure",
    title: "Procedure",
    description: "A short repeatable workflow, runbook, checklist, or operational procedure.",
    content: `---
context_room:
  kind: procedure
  scope: {{scope_yaml}}
  status: {{status_yaml}}
  canonical_for: {{canonical_for_yaml}}
  last_verified: {{last_verified_yaml}}
  sources: {{sources_inline}}
---

# {{title}}

## When To Use
The exact situation where this procedure applies.

## Inputs
- Required files, environment, access, or context.

## Steps
1. First concrete step.
2. Second concrete step.
3. Verification step.

## Failure Modes
- What can go wrong and how to stop safely.

## References
{{sources_list}}
`,
  },
  {
    id: "decision-record",
    title: "Decision record",
    description: "Small ADR-style note for decisions that should be easy to revisit.",
    content: `---
context_room:
  kind: decision
  scope: {{scope_yaml}}
  status: {{status_yaml}}
  canonical_for: {{canonical_for_yaml}}
  last_verified: {{last_verified_yaml}}
  sources: {{sources_inline}}
---

# {{title}}

## Decision
The decision made, in one or two sentences.

## Context
Why this question matters now.

## Options considered
The serious alternatives and their main trade-off.

## Consequences
What this changes concretely, and what to watch next.

## References
Sources, discussions, PRs, or related files.
`,
  },
];
const DEFAULT_HUB_CARDS = [
  { id: "docs", title: "Docs", path: "docs/", description: "Project documentation.", cards: [{ id: "agent-docs", title: "Agent docs", paths: ["AGENTS.md", "CLAUDE.md", ".hermes.md"], description: "Instructions loaded by AI agents." }] },
  { id: "context", title: "Context", path: "context/", description: "Scoped context files created from lightweight templates." },
  { id: "source", title: "Source", paths: ["src/", "lib/", "app/"], description: "Application/source code." },
  { id: "tests", title: "Tests", paths: ["test/", "tests/"], description: "Automated tests." },
  { id: "scripts", title: "Scripts", paths: ["scripts/", "tools/"], description: "Project scripts and tooling." },
  { id: "readme", title: "Readme", path: "README.md", description: "Project entry point." },
];
const DEFAULT_HUB_SECTIONS = [
  { id: "main", title: "Main", cards: DEFAULT_HUB_CARDS },
];
const DEFAULT_HUB_CARD_VISIBILITY = Object.fromEntries(DEFAULT_HUB_CARDS.map((card) => [card.id, true]));
const HERMES_MEMORY_FILES = [
  {
    path: "~/.hermes/memories/USER.md",
    label: "Hermes memory · Mathis",
    category: "1 · injected by Hermes",
    impact: "Global Hermes user memory. Injected into sessions when user memory is active.",
  },
  {
    path: "~/.hermes/memories/MEMORY.md",
    label: "Hermes memory · notes",
    category: "1 · injected by Hermes",
    impact: "Global Hermes technical/operational memory. Injected into sessions when note memory is active.",
  },
];

const HERMES_CRON_FILES = [
  {
    path: HERMES_CRON_JOBS_FILE,
    label: "Hermes cron · jobs",
    category: "2 · Hermes automations",
    impact: "Live canonical Hermes cron jobs file. The webapp also exposes each job as a separate virtual file under ~/.hermes/cron/jobs/.",
  },
];

const CORE_FILES = [
  { path: ".hermes.md", label: "Hermes · project context", category: "1 · injected by Hermes", impact: "Project context loaded automatically when Hermes works in this repo. This is the short Context Room map." },
  { path: "memory/USER.md", label: "Project context · Mathis", category: "3 · Project folders", impact: "Short user memory in the Context Room repo. Separate from global Hermes memory." },
  { path: "memory/MEMORY.md", label: "Project context · system", category: "3 · Project folders", impact: "Short system memory in the Context Room repo. Separate from global Hermes memory." },
  { path: "memory/budget.md", label: "Memory budgets", category: "3 · Project folders", impact: "Size limits for Project context files." },
  { path: "memory/index.csv", label: "Memory index", category: "4 · indexes & registers", impact: "Navigation index for memory files." },
  { path: "memory/session-index.csv", label: "Session index", category: "4 · indexes & registers", impact: "Index of useful sessions/conversations." },
  { path: "memory/open_questions.md", label: "Open questions", category: "4 · indexes & registers", impact: "Register of questions to clarify." },
  { path: "memory/corrections.md", label: "Corrections", category: "4 · indexes & registers", impact: "Register of user or system corrections." },
  { path: "memory/conflicts.md", label: "Conflicts", category: "4 · indexes & registers", impact: "Register of contradictions to resolve." },
  { path: "memory/stale_review.md", label: "Stale review", category: "4 · indexes & registers", impact: "Register of information that may be outdated." },
];

const MAIN_FILE_PATHS = new Set([
  "~/.hermes/memories/USER.md",
  "~/.hermes/memories/MEMORY.md",
  ".hermes.md",
  "memory/USER.md",
  "memory/MEMORY.md",
]);

const ALLOWED_EXACT = new Set([...HERMES_MEMORY_FILES, ...HERMES_CRON_FILES, ...CORE_FILES].map((file) => file.path));
const ALLOWED_PREFIXES = [
  "docs/",
  "context/",
  "src/",
  "lib/",
  "app/",
  "test/",
  "tests/",
  "scripts/",
  "memory/",
  "data/",
  "tools/",
];
const ALLOWED_EXTERNAL_PREFIXES = ["~/.hermes/skills/"];
const SKIP_DIRS = new Set([".git", ".context-room", "node_modules", "__pycache__", ".pytest_cache", "dist", "build"]);

export function isAllowedMemoryPath(relPath, settings = defaultMemoryWebappSettings()) {
  if (typeof relPath !== "string" || !relPath.trim()) return false;
  const normalized = normalizeRelPath(relPath);
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../")) return false;
  if (path.isAbsolute(relPath)) return false;
  if (isBlockedPath(normalized)) return false;
  if (settings.integrations?.hermes && ALLOWED_EXACT.has(normalized)) return true;
  if (settings.integrations?.hermes && isCronJobVirtualPath(normalized)) return true;
  if (settings.integrations?.hermes && isCronJobMarkdownPath(normalized)) return true;
  if (normalized.startsWith("~")) return isAllowedExternalMemoryPath(normalized, settings) && isEditableTextFile(normalized);
  const allowed = sanitizePathList(settings.allowedPaths || ALLOWED_PREFIXES);
  return allowed.some((pattern) => pathMatchesSetting(normalized, pattern) || normalized.startsWith(pattern.replace(/\/$/, "") + "/")) && isEditableTextFile(normalized);
}

export function resolveMemoryPath(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  const settings = readMemoryWebappSettings(root);
  if (!isAllowedMemoryPath(normalized, settings)) {
    throw new Error(`Path not allowed in context room: ${relPath}`);
  }
  const external = resolveExternalPath(normalized);
  if (external) return external;
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, normalized);
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Path escapes repository root: ${relPath}`);
  }
  return resolvedPath;
}

export function listMemoryFiles(root = process.cwd()) {
  const settings = readMemoryWebappSettings(root);
  const byPath = new Map();
  if (settings.integrations?.hermes) {
    syncCronMarkdownSources(root);
    for (const file of HERMES_MEMORY_FILES) byPath.set(file.path, file);
    for (const file of HERMES_CRON_FILES) byPath.set(file.path, file);
    for (const file of listCronJobVirtualFiles()) byPath.set(file.path, file);
    for (const file of listCronJobMarkdownFiles()) byPath.set(file.path, file);
  }
  for (const file of CORE_FILES) {
    if (isAllowedMemoryPath(file.path, settings)) byPath.set(file.path, file);
  }
  for (const prefix of settings.allowedPaths || ALLOWED_PREFIXES) {
    const clean = normalizeRelPath(prefix).replace(/\/$/, "");
    const externalPath = resolveExternalPath(normalizeRelPath(prefix));
    if (externalPath && fs.existsSync(externalPath)) {
      const stats = fs.statSync(externalPath);
      const found = stats.isDirectory() ? walkExternalTextFiles(externalPath, externalPath, normalizeRelPath(prefix).replace(/\/$/, "") + "/") : [normalizeRelPath(prefix)];
      for (const rel of found) {
        if (byPath.has(rel) || !isAllowedMemoryPath(rel, settings)) continue;
        byPath.set(rel, {
          path: rel,
          label: path.basename(rel),
          category: categoryForPath(rel),
        });
      }
      continue;
    }
    const absPath = path.join(root, clean);
    if (!fs.existsSync(absPath)) continue;
    const stats = fs.statSync(absPath);
    const found = stats.isDirectory() ? walkTextFiles(absPath, root, settings) : [clean];
    for (const rel of found) {
      if (byPath.has(rel)) continue;
      byPath.set(rel, {
        path: rel,
        label: path.basename(rel),
        category: categoryForPath(rel),
      });
    }
  }
  if (settings.integrations?.hermes) {
    for (const prefix of ALLOWED_EXTERNAL_PREFIXES) {
      const absDir = resolveExternalPath(prefix);
      if (!absDir || !fs.existsSync(absDir)) continue;
      for (const rel of walkExternalTextFiles(absDir, absDir, prefix)) {
        if (byPath.has(rel)) continue;
        byPath.set(rel, {
          path: rel,
          label: labelForHermesSkillPath(rel),
          category: categoryForPath(rel),
          impact: "Skill installed in Hermes. Available globally for sessions in the current profile.",
        });
      }
    }
  }

  return [...byPath.values()]
    .filter((file) => isAllowedMemoryPath(file.path, settings))
    .map((file) => {
      if (isCronJobVirtualPath(file.path)) return cronJobVirtualMetadata(file);
      if (isCronJobMarkdownPath(file.path)) return cronJobMarkdownMetadata(file);
      const abs = resolveExternalPath(file.path) || path.join(root, file.path);
      const exists = fs.existsSync(abs);
      const stats = exists ? fs.statSync(abs) : null;
      const content = exists && stats.isFile() && stats.size <= MAX_FILE_BYTES
        ? fs.readFileSync(abs, "utf8")
        : "";
      return {
        ...file,
        exists,
        bytes: stats?.size ?? 0,
        chars: content.length,
        updatedAt: stats ? stats.mtime.toISOString() : null,
        kind: file.path.endsWith(".csv") ? "csv" : "markdown",
        summary: summarizeContent(content),
      };
    })
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.path.localeCompare(b.path, "fr"));
}

export function readMemoryFile(root, relPath) {
  if (isCronJobVirtualPath(relPath)) return readCronJobVirtualFile(relPath);
  if (isCronJobMarkdownPath(relPath)) return readCronJobMarkdownFile(relPath);
  const abs = resolveMemoryPath(root, relPath);
  if (!fs.existsSync(abs)) {
    return { path: normalizeRelPath(relPath), content: "", exists: false, updatedAt: null, chars: 0, contentHash: hashContent("") };
  }
  const stats = fs.statSync(abs);
  if (!stats.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${relPath}`);
  const content = fs.readFileSync(abs, "utf8");
  return {
    path: normalizeRelPath(relPath),
    content,
    exists: true,
    updatedAt: stats.mtime.toISOString(),
    chars: content.length,
    contentHash: hashContent(content),
  };
}

export function listStartupContextFiles(root = process.cwd(), settings = readMemoryWebappSettings(root)) {
  const config = normalizeStartupContextSettings(settings.startupContext);
  if (!config.enabled) return [];
  const resolvedRoot = path.resolve(root);
  const dirs = [];
  let current = resolvedRoot;
  while (current && current !== path.dirname(current)) {
    dirs.push(current);
    current = path.dirname(current);
  }
  dirs.push(path.parse(resolvedRoot).root);
  const seenDirs = [...new Set(dirs)].reverse();
  const found = [];
  for (const dir of seenDirs) {
    for (const fileName of config.fileNames) {
      const abs = path.join(dir, fileName);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      found.push({ abs, fileName, dir });
    }
  }
  return found.map((item, index) => {
    const order = index + 1;
    return {
      label: item.fileName,
      category: "0 · startup context",
      impact: "Startup context candidate loaded from " + displayPath(item.abs),
      startupContext: {
        order,
        fileName: item.fileName,
        absolutePath: item.abs,
        displayPath: displayPath(item.abs),
      },
    };
  });
}

export function readStartupContextFile(root = process.cwd(), order = 0, settings = readMemoryWebappSettings(root)) {
  const normalizedOrder = Number(order);
  const found = listStartupContextFiles(root, settings).find((file) => file.startupContext.order === normalizedOrder);
  if (!found) throw new Error(`Startup context file not found: ${order}`);
  const abs = found.startupContext.absolutePath;
  const stats = fs.statSync(abs);
  if (!stats.isFile()) throw new Error(`Not a file: ${found.startupContext.displayPath}`);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${found.startupContext.displayPath}`);
  const content = fs.readFileSync(abs, "utf8");
  return {
    label: found.label,
    path: found.startupContext.displayPath,
    content,
    exists: true,
    updatedAt: stats.mtime.toISOString(),
    chars: content.length,
    contentHash: hashContent(content),
    startupContext: publicStartupContextFile(found).startupContext,
  };
}

function publicStartupContextFile(file) {
  return {
    label: file.label,
    category: file.category,
    impact: file.impact,
    startupContext: {
      order: file.startupContext.order,
      fileName: file.startupContext.fileName,
      displayPath: file.startupContext.displayPath,
    },
  };
}

export function writeMemoryFile(root, relPath, content) {
  if (typeof content !== "string") throw new Error("Content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("Content is too large for the local context room");
  }
  const normalized = normalizeRelPath(relPath);
  validateEditableContent(normalized, content);
  if (isCronJobVirtualPath(normalized)) return writeCronJobVirtualFile(root, normalized, content);
  if (isCronJobMarkdownPath(normalized)) return writeCronJobMarkdownFile(root, normalized, content);
  const abs = resolveMemoryPath(root, normalized);
  const existed = fs.existsSync(abs);
  let backupPath = null;

  if (existed) {
    const backupRel = buildBackupPath(normalized);
    const backupAbs = path.join(root, backupRel);
    fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
    fs.copyFileSync(abs, backupAbs);
    backupPath = backupRel;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  const stats = fs.statSync(abs);
  return {
    path: normalized,
    existed,
    backupPath,
    bytes: stats.size,
    chars: content.length,
    updatedAt: stats.mtime.toISOString(),
    contentHash: hashContent(content),
  };
}

export function createMarkdownFile(root, { path: relPath, title = "New document", templateId = "context-golden", applyTemplate = false, metadata = {} } = {}) {
  const normalized = normalizeMarkdownTemplateTarget(relPath);
  const abs = resolveMemoryPath(root, normalized);
  if (fs.existsSync(abs)) throw new Error(`Markdown file already exists: ${normalized}`);
  const content = applyTemplate ? renderMarkdownTemplateForPath(root, normalized, { title, templateId, metadata }) : "";
  return writeMemoryFile(root, normalized, content);
}

export function createFolder(root, { path: relPath } = {}) {
  const settings = readMemoryWebappSettings(root);
  const normalized = normalizeRelPath(String(relPath || "")).replace(/\/$/, "");
  if (!normalized) throw new Error("Folder path is required");
  if (!isAllowedFolderPath(normalized, settings)) throw new Error(`Folder path not allowed in context room: ${relPath}`);
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, normalized);
  if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path escapes repository root: ${relPath}`);
  if (fs.existsSync(abs)) throw new Error(`Folder already exists: ${normalized}`);
  fs.mkdirSync(abs, { recursive: true });
  return { path: normalized + "/", existed: false };
}

export function applyMarkdownTemplateToFile(root, { path: relPath, title = "New document", templateId = "context-golden" } = {}) {
  const normalized = normalizeMarkdownTemplateTarget(relPath);
  const abs = resolveMemoryPath(root, normalized);
  if (!fs.existsSync(abs)) throw new Error(`Markdown file does not exist: ${normalized}`);
  const stats = fs.statSync(abs);
  if (!stats.isFile()) throw new Error(`Not a file: ${normalized}`);
  if (stats.size > 0) {
    const current = fs.readFileSync(abs, "utf8");
    if (current.trim()) throw new Error(`Markdown file is not empty: ${normalized}`);
  }
  const content = renderMarkdownTemplateForPath(root, normalized, { title, templateId });
  return writeMemoryFile(root, normalized, content);
}

export function renderExplorerContextMenuMarkup({ targetPath = "", directory = "", selectionCount = 1, templates = DEFAULT_MARKDOWN_TEMPLATES } = {}) {
  const normalizedTarget = normalizeRelPath(String(targetPath || ""));
  const cleanDirectory = normalizeRelPath(String(directory || "")).replace(/\/$/, "");
  const directoryLabel = cleanDirectory || "project root";
  const selectionLabel = selectionCount > 1 ? `${selectionCount} selected` : (normalizedTarget || directoryLabel);
  const defaultFolderPath = defaultFolderPathForDirectory(cleanDirectory);
  const targetActions = normalizedTarget
    ? '<button class="secondary" type="button" data-context-watch>Watch</button>' +
      '<button class="secondary" type="button" data-context-new-file>New file</button>' +
      '<button class="secondary" type="button" data-context-new-folder>New folder</button>' +
      '<button class="secondary" type="button" data-context-select>Select</button>' +
      '<button class="secondary danger-action" type="button" data-context-delete>Delete</button>'
    : '<button class="secondary" type="button" data-context-new-file>New file</button>' +
      '<button class="secondary" type="button" data-context-new-folder>New folder</button>';
  return '<div class="explorer-context-title"><span>Actions</span><code>' + escapeHtmlServer(selectionLabel) + '</code></div>' +
    '<div class="explorer-context-actions menu-actions" data-context-action-list>' +
      targetActions +
    '</div>' +
    '<div class="explorer-context-form" data-context-new-file-form hidden>' +
      '<div class="explorer-context-title"><span>New file</span><code>' + escapeHtmlServer(directoryLabel) + '</code></div>' +
      '<label class="explorer-context-label" for="contextMarkdownTitle">Name</label>' +
      '<input id="contextMarkdownTitle" placeholder="Document title" value="New document" />' +
      '<div class="explorer-context-actions form-actions"><button id="contextCancelMarkdown" class="secondary" type="button" title="Cancel" aria-label="Cancel">Cancel</button><button id="contextCreateMarkdown" class="primary" type="button">Create</button></div>' +
    '</div>' +
    '<div class="explorer-context-form" data-context-new-folder-form hidden>' +
      '<div class="explorer-context-title"><span>New folder</span><code>' + escapeHtmlServer(directoryLabel) + '</code></div>' +
      '<label class="explorer-context-label" for="contextFolderPath">Path</label>' +
      '<input id="contextFolderPath" placeholder="path/to/folder" value="' + escapeHtmlServer(defaultFolderPath) + '" />' +
      '<div class="explorer-context-actions form-actions"><button id="contextCancelFolder" class="secondary" type="button" title="Cancel" aria-label="Cancel">Cancel</button><button id="contextCreateFolder" class="primary" type="button">Create</button></div>' +
    '</div>';
}

function defaultFolderPathForDirectory(directory, title = "New folder") {
  const slug = slugifyServer(String(title || "New folder")) || "new-folder";
  return (directory ? directory.replace(/\/$/, "") + "/" : "") + slug;
}

function slugifyServer(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function renderTemplateOptionsMarkup(templates = DEFAULT_MARKDOWN_TEMPLATES, selectedId = "context-golden") {
  return visibleMarkdownTemplates(templates).map((template) => '<option value="' + escapeHtmlServer(template.id) + '" ' + (template.id === selectedId ? 'selected' : '') + '>' + escapeHtmlServer(template.title) + '</option>').join("");
}

function escapeHtmlServer(value) {
  return String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[ch]));
}

function normalizeMarkdownTemplateTarget(relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!normalized) throw new Error("Markdown path is required");
  if (path.extname(normalized) !== ".md") throw new Error("Template target must be Markdown (.md)");
  return normalized;
}

function renderMarkdownTemplateForPath(root, normalized, { title = "New document", templateId = "context-golden", metadata = {} } = {}) {
  const template = markdownTemplatesForSettings(readMemoryWebappSettings(root)).find((item) => item.id === templateId);
  if (!template) throw new Error(`Unknown markdown template: ${templateId}`);
  const safeTitle = String(title || path.basename(normalized, ".md")).trim() || path.basename(normalized, ".md");
  const values = renderDocMetadataTemplateValues({ title: safeTitle, normalized, metadata });
  return renderMarkdownTemplate(template.content, values);
}

function renderMarkdownTemplate(content, values = {}) {
  return String(content || "").replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

export function deleteMemoryPaths(root, relPaths = []) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) throw new Error("No paths selected for deletion");
  const settings = readMemoryWebappSettings(root);
  const deleted = [];
  const uniquePaths = [...new Set(relPaths.map((item) => normalizeRelPath(String(item || ""))).filter(Boolean))];
  for (const relPath of uniquePaths) {
    const normalized = relPath.replace(/\/$/, "");
    if (isCronJobMarkdownPath(normalized)) {
      const result = deleteCronJobMarkdownFile(root, normalized);
      if (result.deleted) deleted.push(normalized);
      continue;
    }
    if (isAllowedExternalPath(normalized)) {
      const abs = resolveExternalPath(normalized);
      if (!abs || !fs.existsSync(abs)) continue;
      const stats = fs.statSync(abs);
      if (stats.isFile()) {
        fs.unlinkSync(abs);
        deleted.push(normalized);
        continue;
      }
      if (!stats.isDirectory()) throw new Error(`Not a file or folder: ${relPath}`);
      const prefix = externalPrefixForPath(normalized);
      const baseDir = resolveExternalPath(prefix);
      if (!prefix || !baseDir) throw new Error(`Path not allowed in context room: ${relPath}`);
      const files = walkExternalTextFiles(abs, baseDir, prefix).filter((file) => isAllowedMemoryPath(file, settings));
      for (const file of files.sort((a, b) => b.length - a.length)) {
        const fileAbs = resolveExternalPath(file);
        if (fileAbs && fs.existsSync(fileAbs)) {
          fs.unlinkSync(fileAbs);
          deleted.push(file);
        }
      }
      pruneEmptyDirs(abs, baseDir);
      continue;
    }
    if (isAllowedMemoryPath(normalized, settings)) {
      const abs = resolveMemoryPath(root, normalized);
      if (fs.existsSync(abs)) {
        const stats = fs.statSync(abs);
        if (!stats.isFile()) throw new Error(`Not a file: ${relPath}`);
        fs.unlinkSync(abs);
        deleted.push(normalized);
      }
      continue;
    }
    if (!isAllowedFolderPath(normalized, settings)) throw new Error(`Path not allowed in context room: ${relPath}`);
    const absDir = path.resolve(root, normalized);
    if (!fs.existsSync(absDir)) continue;
    if (!fs.statSync(absDir).isDirectory()) throw new Error(`Not a folder: ${relPath}`);
    const files = walkTextFiles(absDir, root, settings).filter((file) => isAllowedMemoryPath(file, settings));
    for (const file of files.sort((a, b) => b.length - a.length)) {
      const abs = resolveMemoryPath(root, file);
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        deleted.push(file);
      }
    }
    pruneEmptyDirs(absDir, path.resolve(root));
  }
  return { deleted };
}

export function readFileDiff(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  const abs = resolveMemoryPath(root, normalized);
  if (resolveExternalPath(normalized)) {
    return { path: normalized, changed: false, additions: 0, deletions: 0, patch: "", available: false, reason: "Git diff is unavailable for files outside the repo."};
  }
  try {
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", normalized], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").find(Boolean) || "";
    if (status.startsWith("?? ")) return buildNewFileDiff(root, normalized, abs);
    const patch = execFileSync("git", ["diff", "HEAD", "--", normalized], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const numstat = execFileSync("git", ["diff", "HEAD", "--numstat", "--", normalized], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const [rawAdditions = "0", rawDeletions = "0"] = numstat.split(/\s+/);
    const additions = Number.parseInt(rawAdditions, 10) || 0;
    const deletions = Number.parseInt(rawDeletions, 10) || 0;
    return { path: normalized, changed: patch.trim().length > 0, additions, deletions, patch, available: true };
  } catch {
    return { path: normalized, changed: false, additions: 0, deletions: 0, patch: "", available: false, reason: "Git diff is unavailable for this file."};
  }
}

function buildNewFileDiff(root, normalized, abs) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return { path: normalized, changed: false, additions: 0, deletions: 0, patch: "", available: false, reason: "Git diff is unavailable for this file."};
  const content = fs.readFileSync(abs, "utf8");
  const lines = content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n");
  const additions = content.length ? lines.length : 0;
  const patch = [
    `diff --git a/${normalized} b/${normalized}`,
    "new file mode 100644",
    "index 0000000..0000000",
    "--- /dev/null",
    `+++ b/${normalized}`,
    `@@ -0,0 +1,${additions} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
  return { path: normalized, changed: true, additions, deletions: 0, patch, available: true };
}

export function revertMemoryFile(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) throw new Error("Path is required");
  if (resolveExternalPath(normalized)) throw new Error("Git revert is unavailable for files outside the repo.");
  if (!isAllowedMemoryPath(normalized, readMemoryWebappSettings(root))) throw new Error(`Path not allowed in context room: ${relPath}`);
  const abs = resolveMemoryPath(root, normalized);
  try {
    const statusLine = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", normalized], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").find(Boolean) || "";
    if (!statusLine) return { path: normalized, reverted: false, deleted: false, reason: "No Git changes for this file." };
    if (statusLine.startsWith("?? ")) {
      if (fs.existsSync(abs)) {
        if (!fs.statSync(abs).isFile()) throw new Error(`Not a file: ${normalized}`);
        fs.unlinkSync(abs);
      }
      return { path: normalized, reverted: true, deleted: true };
    }
    execFileSync("git", ["restore", "--source=HEAD", "--staged", "--worktree", "--", normalized], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    return { path: normalized, reverted: true, deleted: false };
  } catch (error) {
    if (error?.message?.startsWith("Not a file:")) throw error;
    throw new Error(`Git revert failed for ${normalized}`);
  }
}

export function readDocReviewState(root = process.cwd()) {
  const statePath = path.join(root, DOCQA_REVIEW_STATE);
  if (!fs.existsSync(statePath)) return { version: 1, reviews: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return { version: 1, reviews: parsed.reviews && typeof parsed.reviews === "object" ? parsed.reviews : {} };
  } catch {
    return { version: 1, reviews: {} };
  }
}

export function writeDocReviewDecision(root, relPath, { status, note = "" } = {}) {
  const normalized = normalizeRelPath(relPath);
  const allowedStatuses = new Set(["verified", "needs_changes", "snoozed"]);
  if (!allowedStatuses.has(status)) throw new Error(`Invalid review status: ${status}`);
  const file = readMemoryFile(root, normalized);
  const state = readDocReviewState(root);
  const decision = {
    status,
    note: String(note || "").slice(0, 500),
    reviewedAt: new Date().toISOString(),
    contentHash: hashContent(file.content),
  };
  state.reviews[normalized] = decision;
  const statePath = path.join(root, DOCQA_REVIEW_STATE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return { path: normalized, ...decision };
}

function currentReviewFor(reviews, relPath, content) {
  const review = reviews[relPath] || null;
  if (!review) return null;
  return { ...review, current: review.contentHash === hashContent(content) };
}

function hashContent(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

function isCronJobVirtualPath(relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!normalized.startsWith(HERMES_CRON_JOBS_FOLDER) || !normalized.endsWith(".json")) return false;
  const id = cronJobIdFromVirtualPath(normalized);
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function isCronJobMarkdownPath(relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!normalized.startsWith(HERMES_CRON_MD_FOLDER) || !normalized.endsWith(".md")) return false;
  const id = cronJobIdFromMarkdownPath(normalized);
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function cronJobIdFromVirtualPath(relPath) {
  return normalizeRelPath(relPath).slice(HERMES_CRON_JOBS_FOLDER.length).replace(/\.json$/, "");
}

function cronJobIdFromMarkdownPath(relPath) {
  return normalizeRelPath(relPath).slice(HERMES_CRON_MD_FOLDER.length).replace(/\.md$/, "");
}

function readCronStore() {
  const abs = resolveExternalPath(HERMES_CRON_JOBS_FILE);
  if (!abs || !fs.existsSync(abs)) return { data: { jobs: [] }, abs, stats: null, raw: "" };
  const stats = fs.statSync(abs);
  const raw = fs.readFileSync(abs, "utf8");
  const data = JSON.parse(raw || "{}");
  if (!Array.isArray(data.jobs)) throw new Error("Hermes cron jobs.json invalide: champ jobs manquant");
  return { data, abs, stats, raw };
}


function syncCronMarkdownSources(root = process.cwd()) {
  const cronDir = path.join(getHermesHome(), "cron");
  const mdDir = path.join(cronDir, "jobs-md");
  const storePath = path.join(cronDir, "jobs.json");
  let store = readCronStore();
  let data = store.data;
  let changed = false;
  fs.mkdirSync(mdDir, { recursive: true });
  const storeMtime = store.stats?.mtimeMs || 0;

  for (const entry of fs.readdirSync(mdDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const id = entry.name.replace(/\.md$/, "");
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    const abs = path.join(mdDir, entry.name);
    const stats = fs.statSync(abs);
    const existingIndex = data.jobs.findIndex((job) => job?.id === id);
    if (existingIndex >= 0 && stats.mtimeMs <= storeMtime) continue;
    let parsed;
    try {
      parsed = markdownToCronJob(fs.readFileSync(abs, "utf8"), id);
    } catch {
      continue;
    }
    const now = new Date().toISOString();
    const baseJob = existingIndex >= 0 ? data.jobs[existingIndex] : defaultCronJob(id, now);
    const nextJob = mergeCronMarkdownFields(baseJob, parsed, id);
    if (existingIndex >= 0) data.jobs[existingIndex] = nextJob;
    else data.jobs.push(nextJob);
    changed = true;
  }

  if (changed) {
    data.updated_at = new Date().toISOString();
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2) + "\n", "utf8");
    store = readCronStore();
    data = store.data;
  }

  for (const job of data.jobs.filter((item) => item?.id)) {
    const abs = path.join(mdDir, `${job.id}.md`);
    const content = cronJobToMarkdown(job);
    if (!fs.existsSync(abs) || fs.readFileSync(abs, "utf8") !== content) {
      fs.writeFileSync(abs, content, "utf8");
    }
  }
}

function listCronJobVirtualFiles() {
  try {
    const { data } = readCronStore();
    return data.jobs.filter((job) => job?.id).map((job) => ({
      path: `${HERMES_CRON_JOBS_FOLDER}${job.id}.json`,
      label: `Cron · ${job.name || job.id}`,
      category: "2 · Hermes automations · jobs",
      impact: `Editable view of job ${job.id}. Saving rewrites the matching job in ${HERMES_CRON_JOBS_FILE}.`,
      cronJob: job,
    }));
  } catch {
    return [];
  }
}

function listCronJobMarkdownFiles() {
  try {
    const { data } = readCronStore();
    return data.jobs.filter((job) => job?.id).map((job) => ({
      path: `${HERMES_CRON_MD_FOLDER}${job.id}.md`,
      label: `Cron md · ${job.name || job.id}`,
      category: "2 · Hermes automations · markdown",
      impact: `Markdown source for job ${job.id}. The frontmatter configures the cron; the body is the prompt. Saving this file updates ${HERMES_CRON_JOBS_FILE}.`,
      cronJob: job,
    }));
  } catch {
    return [];
  }
}

function cronJobVirtualMetadata(file) {
  const content = JSON.stringify(file.cronJob || {}, null, 2) + "\n";
  const { stats } = readCronStore();
  return {
    ...file,
    exists: Boolean(file.cronJob),
    bytes: Buffer.byteLength(content, "utf8"),
    chars: content.length,
    updatedAt: stats ? stats.mtime.toISOString() : null,
    kind: "json",
    summary: file.cronJob?.schedule_display || file.cronJob?.schedule?.display || summarizeContent(content),
  };
}

function cronJobMarkdownMetadata(file) {
  const content = cronJobToMarkdown(file.cronJob || {});
  const { stats } = readCronStore();
  return {
    ...file,
    exists: Boolean(file.cronJob),
    bytes: Buffer.byteLength(content, "utf8"),
    chars: content.length,
    updatedAt: stats ? stats.mtime.toISOString() : null,
    kind: "markdown",
    summary: file.cronJob?.schedule_display || file.cronJob?.schedule || summarizeContent(content),
  };
}

function readCronJobVirtualFile(relPath) {
  const normalized = normalizeRelPath(relPath);
  const id = cronJobIdFromVirtualPath(normalized);
  const { data, stats } = readCronStore();
  const job = data.jobs.find((item) => item?.id === id);
  if (!job) return { path: normalized, content: "", exists: false, updatedAt: stats?.mtime.toISOString() || null, chars: 0, contentHash: hashContent("") };
  const content = JSON.stringify(job, null, 2) + "\n";
  return {
    path: normalized,
    content,
    exists: true,
    updatedAt: stats ? stats.mtime.toISOString() : null,
    chars: content.length,
    contentHash: hashContent(content),
  };
}

function readCronJobMarkdownFile(relPath) {
  const normalized = normalizeRelPath(relPath);
  const id = cronJobIdFromMarkdownPath(normalized);
  const { data, stats } = readCronStore();
  const job = data.jobs.find((item) => item?.id === id);
  if (!job) return { path: normalized, content: cronJobMarkdownTemplate(id), exists: false, updatedAt: stats?.mtime.toISOString() || null, chars: 0, contentHash: hashContent("") };
  const content = cronJobToMarkdown(job);
  return {
    path: normalized,
    content,
    exists: true,
    updatedAt: stats ? stats.mtime.toISOString() : null,
    chars: content.length,
    contentHash: hashContent(content),
  };
}

function writeCronJobVirtualFile(root, relPath, content) {
  const normalized = normalizeRelPath(relPath);
  const id = cronJobIdFromVirtualPath(normalized);
  const parsed = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("A cron job must be a JSON object");
  if (parsed.id !== id) throw new Error(`Job id must stay ${id}`);

  const { data, abs } = readCronStore();
  const index = data.jobs.findIndex((job) => job?.id === id);
  if (index < 0) throw new Error(`Cron job introuvable: ${id}`);
  const backupRel = buildBackupPath(HERMES_CRON_JOBS_FILE);
  const backupAbs = path.join(root, backupRel);
  fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
  fs.copyFileSync(abs, backupAbs);

  data.jobs[index] = parsed;
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n", "utf8");
  const stats = fs.statSync(abs);
  const writtenContent = JSON.stringify(parsed, null, 2) + "\n";
  return {
    path: normalized,
    existed: true,
    backupPath: backupRel,
    bytes: Buffer.byteLength(writtenContent, "utf8"),
    chars: writtenContent.length,
    updatedAt: stats.mtime.toISOString(),
    contentHash: hashContent(writtenContent),
  };
}


function writeCronJobMarkdownFile(root, relPath, content) {
  const normalized = normalizeRelPath(relPath);
  const id = cronJobIdFromMarkdownPath(normalized);
  const parsed = markdownToCronJob(content, id);
  const { data, abs } = readCronStore();
  const index = data.jobs.findIndex((job) => job?.id === id);
  const now = new Date().toISOString();
  const backupRel = buildBackupPath(HERMES_CRON_JOBS_FILE);
  const backupAbs = path.join(root, backupRel);
  if (abs && fs.existsSync(abs)) {
    fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
    fs.copyFileSync(abs, backupAbs);
  }
  const baseJob = index >= 0 ? data.jobs[index] : defaultCronJob(id, now);
  const nextJob = mergeCronMarkdownFields(baseJob, parsed, id);
  if (index >= 0) data.jobs[index] = nextJob;
  else data.jobs.push(nextJob);
  data.updated_at = now;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n", "utf8");
  const stats = fs.statSync(abs);
  const writtenContent = cronJobToMarkdown(nextJob);
  return {
    path: normalized,
    existed: index >= 0,
    backupPath: index >= 0 ? backupRel : null,
    bytes: Buffer.byteLength(writtenContent, "utf8"),
    chars: writtenContent.length,
    updatedAt: stats.mtime.toISOString(),
    contentHash: hashContent(writtenContent),
  };
}

function deleteCronJobMarkdownFile(root, relPath) {
  const id = cronJobIdFromMarkdownPath(relPath);
  const { data, abs } = readCronStore();
  const index = data.jobs.findIndex((job) => job?.id === id);
  if (index < 0) return { deleted: false };
  const backupRel = buildBackupPath(HERMES_CRON_JOBS_FILE);
  const backupAbs = path.join(root, backupRel);
  fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
  fs.copyFileSync(abs, backupAbs);
  data.jobs.splice(index, 1);
  data.updated_at = new Date().toISOString();
  fs.writeFileSync(abs, JSON.stringify(data, null, 2) + "\n", "utf8");
  return { deleted: true, backupPath: backupRel };
}

function defaultCronJob(id, now) {
  return {
    id,
    name: id,
    prompt: "",
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    schedule_display: "0 9 * * *",
    enabled: true,
    deliver: "origin",
    workdir: process.cwd(),
    created_at: now,
    last_run_at: null,
    next_run_at: null,
    last_status: null,
    last_error: null,
    last_delivery_error: null,
    paused_at: null,
    paused_reason: null,
    state: {},
  };
}

function cronJobToMarkdown(job) {
  const frontmatter = simplifiedCronFrontmatter(job || {});
  return "---\n" + stringifyYaml(frontmatter) + "---\n\n" + String(job?.prompt || "").trimEnd() + "\n";
}

function simplifiedCronFrontmatter(job) {
  const schedule = typeof job.schedule === "object" && job.schedule ? job.schedule.expr || job.schedule.display : job.schedule;
  const frontmatter = {
    name: job.name || job.id,
    schedule: schedule || job.schedule_display || "0 9 * * *",
    enabled: job.enabled !== false,
  };
  if (job.deliver && job.deliver !== "origin") frontmatter.deliver = job.deliver;
  if (job.workdir) frontmatter.workdir = job.workdir;
  return frontmatter;
}

function cronJobMarkdownTemplate(id) {
  return cronJobToMarkdown({
    name: id,
    schedule: { kind: "cron", expr: "0 9 * * *", display: "0 9 * * *" },
    enabled: true,
    deliver: "origin",
    workdir: process.cwd(),
    prompt: "Describe what this cron job should do here.",
  });
}

function mergeCronMarkdownFields(baseJob, parsed, id) {
  const nextJob = { ...baseJob, id, name: parsed.name, prompt: parsed.prompt, enabled: parsed.enabled !== false };
  if (parsed.deliver !== undefined) nextJob.deliver = parsed.deliver;
  if (parsed.workdir !== undefined) nextJob.workdir = parsed.workdir;
  const scheduleText = parsed.schedule;
  if (typeof baseJob.schedule === "object" && baseJob.schedule) {
    nextJob.schedule = { ...baseJob.schedule, expr: scheduleText, display: scheduleText };
  } else {
    nextJob.schedule = scheduleText;
  }
  nextJob.schedule_display = scheduleText;
  return nextJob;
}

function markdownToCronJob(content, expectedId) {
  const match = String(content || "").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("Invalid cron Markdown: YAML frontmatter is required");
  const data = parseSimpleYaml(match[1]);
  if (data.id && data.id !== expectedId) throw new Error(`Job id must stay ${expectedId}`);
  if (!data.name) data.name = expectedId;
  if (!data.schedule) throw new Error("Invalid cron Markdown: schedule is required");
  const allowed = new Set(["id", "name", "schedule", "enabled", "deliver", "workdir"]);
  const extra = Object.keys(data).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error(`Unsupported extra cron Markdown parameters: ${extra.join(", ")}`);
  return { ...data, id: expectedId, prompt: match[2].trim() };
}

function sourceReferenceExists(root, docPath, reference) {
  const resolved = resolveSourceReference(root, docPath, reference);
  if (!resolved) return true;
  return fs.existsSync(resolved);
}

function resolveSourceReference(root, docPath, reference) {
  const clean = String(reference || "").trim().replace(/#.*$/, "");
  if (!clean || /^[a-z]+:/i.test(clean)) return null;
  if (clean.startsWith("~")) return resolveExternalPath(clean) || null;
  if (path.isAbsolute(clean)) return clean;
  const normalized = normalizeRelPath(clean);
  const candidate = path.resolve(root, normalized);
  if (fs.existsSync(candidate)) return candidate;
  const docRelative = path.resolve(root, path.dirname(normalizeRelPath(docPath)), normalized);
  return docRelative;
}

function collectHubPathMatchers(sections = []) {
  const paths = [];
  const ids = [];
  const visit = (cards = []) => {
    for (const card of cards || []) {
      if (card.id) ids.push(card.id);
      paths.push(...hubCardPaths(card));
      visit(card.cards || []);
    }
  };
  for (const section of sections || []) {
    if (section.id) ids.push(section.id);
    visit(section.cards || []);
  }
  return { paths: [...new Set(paths)], ids };
}

function pathIsInHub(relPath, hubPaths = []) {
  return hubPaths.some((item) => pathMatchesSetting(relPath, item));
}

function startupRelPathsForRoot(root, startupFiles = []) {
  const resolvedRoot = path.resolve(root);
  const rels = new Set();
  for (const file of startupFiles || []) {
    const abs = file.startupContext?.absolutePath;
    if (!abs) continue;
    const resolved = path.resolve(abs);
    if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    rels.add(path.relative(resolvedRoot, resolved).replaceAll(path.sep, "/"));
  }
  return rels;
}

export function buildDocumentationGraph(root = process.cwd()) {
  const settings = readMemoryWebappSettings(root);
  const files = listMemoryFiles(root);
  const gitStatuses = readGitStatuses(root);
  const startupFiles = listStartupContextFiles(root, settings);
  const startupRelPaths = startupRelPathsForRoot(root, startupFiles);
  const hubInfo = collectHubPathMatchers(settings.hubSections || []);
  const nodes = [];
  const edges = [];
  const healthIssues = [];
  const canonicalGroups = new Map();

  for (const file of files) {
    if (!file.exists || file.kind !== "markdown") continue;
    const abs = resolveExternalPath(file.path) || path.join(root, file.path);
    const content = fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size <= MAX_FILE_BYTES ? fs.readFileSync(abs, "utf8") : "";
    const metadata = parseDocMetadata(content, file.path);
    const watched = isWatchedPath(file.path, settings);
    const inHub = pathIsInHub(file.path, hubInfo.paths);
    const startup = startupRelPaths.has(file.path);
    const references = collectInlinePathReferences(content);
    const issues = graphIssuesForDocument({ root, file, content, metadata, watched, inHub, startup, references });
    healthIssues.push(...issues.map((issue) => ({ ...issue, path: file.path })));
    const node = {
      id: `doc:${file.path}`,
      type: "doc",
      path: file.path,
      label: file.label || path.basename(file.path),
      summary: file.summary || summarizeContent(content),
      updatedAt: file.updatedAt,
      gitStatus: gitStatuses.get(file.path) || "",
      watched,
      inHub,
      startup,
      metadata,
      references,
      health: issues,
    };
    nodes.push(node);
    for (const source of metadata.sources) {
      edges.push({ from: node.id, to: `source:${source}`, type: "declares-source", source });
    }
    for (const reference of references) {
      edges.push({ from: node.id, to: `reference:${reference}`, type: "references", source: reference });
    }
    if (metadata.present && metadata.kind === "canonical" && metadata.status === "current" && metadata.canonical_for) {
      const key = `${metadata.scope}:${metadata.canonical_for}`;
      if (!canonicalGroups.has(key)) canonicalGroups.set(key, []);
      canonicalGroups.get(key).push(file.path);
    }
  }

  for (const [key, paths] of canonicalGroups.entries()) {
    if (paths.length <= 1) continue;
    for (const relPath of paths) {
      healthIssues.push({
        path: relPath,
        type: "duplicate_canonical",
        severity: "high",
        message: `Multiple current canonical docs for ${key}: ${paths.join(", ")}.`,
      });
    }
  }

  const configIssues = buildConfigDiagnostics(root, settings, files, startupFiles, hubInfo);
  healthIssues.push(...configIssues);
  return {
    generatedAt: new Date().toISOString(),
    root,
    summary: {
      docs: nodes.length,
      watched: nodes.filter((node) => node.watched).length,
      inHub: nodes.filter((node) => node.inHub).length,
      startup: nodes.filter((node) => node.startup).length,
      missingMetadata: nodes.filter((node) => !node.metadata.present).length,
      stale: healthIssues.filter((issue) => issue.type === "stale_last_verified").length,
      highOrCritical: healthIssues.filter((issue) => ["critical", "high"].includes(issue.severity)).length,
    },
    nodes,
    edges,
    healthIssues: sortHealthIssues(healthIssues).slice(0, 200),
    startupContext: startupFiles.map(publicStartupContextFile),
  };
}

function graphIssuesForDocument({ root, file, content, metadata, watched, inHub, startup, references }) {
  const issues = [];
  if (metadata.parseError) issues.push({ type: "metadata_parse_error", severity: "high", message: `Cannot parse context_room metadata: ${metadata.parseError}.` });
  if (!metadata.present && watched) issues.push({ type: "missing_metadata", severity: "medium", message: "Watched Markdown doc has no context_room metadata." });
  if (!metadata.present && (inHub || startup)) issues.push({ type: "missing_metadata", severity: "low", message: "Visible Markdown doc has no context_room metadata." });
  if (["canonical", "procedure", "agents"].includes(metadata.kind) && metadata.status === "current" && !metadata.last_verified) {
    issues.push({ type: "missing_last_verified", severity: watched ? "medium" : "low", message: "Current high-impact doc has no last_verified date." });
  }
  if (metadata.last_verified && Date.parse(metadata.last_verified) < Date.now() - 1000 * 60 * 60 * 24 * 120) {
    issues.push({ type: "stale_last_verified", severity: watched ? "medium" : "low", message: `last_verified is older than 120 days: ${metadata.last_verified}.` });
  }
  if (metadata.kind === "canonical" && metadata.status === "current" && !metadata.canonical_for) {
    issues.push({ type: "missing_canonical_for", severity: "medium", message: "Current canonical doc should declare canonical_for." });
  }
  if (["canonical", "procedure"].includes(metadata.kind) && metadata.status === "current" && metadata.sources.length === 0) {
    issues.push({ type: "missing_sources", severity: "low", message: "Current doc has no source files or links." });
  }
  for (const source of metadata.sources) {
    if (!sourceReferenceExists(root, file.path, source)) issues.push({ type: "broken_source", severity: "high", message: `Declared source does not exist: ${source}.` });
  }
  for (const reference of references) {
    if (!sourceReferenceExists(root, file.path, reference)) issues.push({ type: "broken_reference", severity: "medium", message: `Referenced file does not exist: ${reference}.` });
  }
  if (!inHub && !startup && watched) issues.push({ type: "watched_not_in_hub", severity: "low", message: "Watched doc is not reachable from any hub card." });
  if (!content.trim()) issues.push({ type: "empty_doc", severity: watched ? "medium" : "low", message: "Document is empty." });
  return issues;
}

export function buildConfigDiagnostics(root = process.cwd(), settings = readMemoryWebappSettings(root), files = listMemoryFiles(root), startupFiles = listStartupContextFiles(root, settings), hubInfo = collectHubPathMatchers(settings.hubSections || [])) {
  const issues = [];
  const configPath = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(configPath)) issues.push({ type: "missing_config", severity: "critical", message: `${CONFIG_FILE} is missing.` });
  for (const relPath of settings.allowedPaths || []) {
    if (resolveExternalPath(relPath)) continue;
    if (!fs.existsSync(path.join(root, relPath.replace(/\/$/, "")))) issues.push({ type: "allowed_path_missing", severity: "low", message: `Allowed path does not exist: ${relPath}.` });
  }
  for (const relPath of settings.watchAllow || []) {
    const covered = (settings.allowedPaths || []).some((allowed) => pathMatchesSetting(relPath, allowed) || pathMatchesSetting(allowed, relPath));
    if (!covered) issues.push({ type: "watch_not_allowed", severity: "high", message: `Watched path is not covered by allowedPaths: ${relPath}.` });
  }
  const duplicateIds = hubInfo.ids.filter((id, index) => hubInfo.ids.indexOf(id) !== index);
  for (const id of [...new Set(duplicateIds)]) issues.push({ type: "duplicate_hub_id", severity: "medium", message: `Duplicate hub section/card id: ${id}.` });
  for (const relPath of hubInfo.paths) {
    const allowed = isAllowedMemoryPath(relPath, settings) || isAllowedFolderPath(relPath, settings);
    if (!allowed) issues.push({ type: "hub_path_not_allowed", severity: "high", message: `Hub path is outside allowedPaths: ${relPath}.` });
  }
  if (!settings.markdownTemplates?.length) issues.push({ type: "missing_templates", severity: "medium", message: "No Markdown templates configured." });
  const filePaths = new Set(files.map((file) => file.path));
  for (const startupFile of startupFiles || []) {
    const display = startupFile.startupContext?.displayPath || "";
    const abs = startupFile.startupContext?.absolutePath;
    const rel = abs ? path.relative(path.resolve(root), path.resolve(abs)).replaceAll(path.sep, "/") : "";
    if (rel && !rel.startsWith("../") && !path.isAbsolute(rel) && filePaths.has(rel) && !isWatchedPath(rel, settings)) {
      issues.push({ type: "startup_not_watched", severity: "medium", message: `Startup context file is editable but not watched: ${rel}.` });
    } else if (display && (!rel || rel.startsWith("../"))) {
      issues.push({ type: "external_startup_context", severity: "low", message: `External startup context affects agents: ${display}.` });
    }
  }
  return issues;
}

function sortHealthIssues(issues = []) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...issues].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || String(a.path || "").localeCompare(String(b.path || ""), "fr") || String(a.type || "").localeCompare(String(b.type || ""), "fr"));
}

export function buildContextRoomDoctorReport(root = process.cwd()) {
  const settings = readMemoryWebappSettings(root);
  const graph = buildDocumentationGraph(root);
  const docqa = buildDocQaReport(root);
  return {
    generatedAt: new Date().toISOString(),
    root: path.resolve(root),
    configPath: path.join(root, CONFIG_FILE),
    settings: {
      title: settings.title,
      allowedPaths: settings.allowedPaths.length,
      watchAllow: settings.watchAllow.length,
      hubSections: settings.hubSections.length,
      markdownTemplates: settings.markdownTemplates.length,
      startupContext: settings.startupContext,
    },
    docqa: docqa.summary,
    graph: graph.summary,
    issues: graph.healthIssues,
  };
}

export function buildAgentBrief(root = process.cwd(), { task = "", limit = 12 } = {}) {
  const graph = buildDocumentationGraph(root);
  const docqa = buildDocQaReport(root);
  const terms = tokenizeBriefTask(task);
  const scored = graph.nodes
    .map((node) => ({ node, score: scoreBriefNode(node, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path, "fr"))
    .slice(0, Math.max(1, Number(limit) || 12));
  const lines = [];
  lines.push(`# Context Room Brief`);
  if (task) lines.push(`Task: ${task}`);
  lines.push("");
  lines.push("## Startup Context");
  const startup = graph.startupContext || [];
  if (startup.length) {
    for (const file of startup) lines.push(`- ${file.startupContext.order}. ${file.startupContext.fileName}: ${file.startupContext.displayPath}`);
  } else {
    lines.push("- No startup context files detected or scanner disabled.");
  }
  lines.push("");
  lines.push("## Read First");
  if (scored.length) {
    for (const { node } of scored) {
      const meta = node.metadata;
      lines.push(`- ${node.path} (${meta.kind}, ${meta.status}, scope: ${meta.scope})${node.summary ? ` - ${node.summary}` : ""}`);
    }
  } else {
    lines.push("- No matching docs. Start from the hub/index docs.");
  }
  lines.push("");
  lines.push("## Review Warnings");
  if (docqa.queue.length) {
    lines.push(`- ${docqa.queue.length} watched changed file(s) still need review.`);
    for (const item of docqa.queue.slice(0, 8)) lines.push(`- ${item.gitStatus.trim() || "changed"} ${item.path}`);
  } else {
    lines.push("- No watched documentation changes are pending review.");
  }
  const highIssues = graph.healthIssues.filter((issue) => ["critical", "high"].includes(issue.severity)).slice(0, 8);
  if (highIssues.length) {
    lines.push("");
    lines.push("## Health Issues");
    for (const issue of highIssues) lines.push(`- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function tokenizeBriefTask(task = "") {
  return String(task || "").toLowerCase().split(/[^a-z0-9_/-]+/).map((term) => term.trim()).filter((term) => term.length >= 3);
}

function scoreBriefNode(node, terms = []) {
  let score = 0;
  if (node.startup) score += 80;
  if (node.metadata.kind === "agents") score += 55;
  if (node.metadata.kind === "index") score += 45;
  if (node.metadata.status === "current") score += 25;
  if (node.watched) score += 15;
  if (node.inHub) score += 10;
  const haystack = [node.path, node.label, node.summary, node.metadata.scope, node.metadata.canonical_for, node.metadata.kind, ...node.metadata.sources].join(" ").toLowerCase();
  for (const term of terms) {
    if (haystack.includes(term)) score += 35;
  }
  if (!terms.length && score < 40) return 0;
  if (node.health.some((issue) => ["critical", "high"].includes(issue.severity))) score -= 20;
  return score;
}

export function classifyDocPath(relPath) {
  const normalized = normalizeRelPath(relPath);
  if (normalized === ".hermes.md" || normalized.includes("prompt")) {
    return { type: "prompt", authority: "critical", sensitive: true };
  }
  if (normalized.startsWith("~/.hermes/memories/") || normalized.startsWith("memory/")) {
    return { type: "memory", authority: "high", sensitive: true };
  }
  if (normalized.startsWith("decisions/") || normalized.includes("ADR")) return { type: "decision", authority: "high", sensitive: true };
  if (normalized.startsWith("data/daily/") || normalized.includes("scratch") || normalized.includes("capture") || normalized.includes("imports/")) return { type: "daily", authority: "low", sensitive: false };
  if (normalized.startsWith("tools/") || normalized.startsWith("integrations/") || normalized.startsWith("automations/")) return { type: "tooling", authority: "medium", sensitive: false };
  return { type: "unknown", authority: "low", sensitive: false };
}

export function computeDocIssues({ path: relPath, content = "", gitStatus = "", metadata = null }) {
  const classification = classifyDocPath(relPath);
  const issues = [];
  const text = String(content);
  const docMetadata = metadata || parseDocMetadata(text, relPath);
  if (gitStatus.trim() && classification.sensitive) issues.push({ type: "sensitive_changed", severity: "critical", message: "Sensitive file changed: human review before canonical truth." });
  const todoCount = (text.match(/\b(TODO|FIXME|HACK|QUESTION|à clarifier|a verifier|à vérifier)\b/gi) || []).length;
  if (todoCount) issues.push({ type: "todo", severity: docMetadata.kind === "canonical" ? "high" : "medium", message: `${todoCount} TODO/question to consolidate.` });
  if (path.extname(normalizeRelPath(relPath)) === ".md" && gitStatus.trim() && !docMetadata.present) issues.push({ type: "missing_metadata", severity: "medium", message: "Missing context_room metadata." });
  if (["agents", "canonical", "procedure"].includes(docMetadata.kind) && docMetadata.status === "current" && !docMetadata.last_verified && gitStatus.trim()) issues.push({ type: "missing_last_verified", severity: "medium", message: "Missing last_verified while the file is modified." });
  if (docMetadata.last_verified && Date.parse(docMetadata.last_verified) < Date.now() - 1000 * 60 * 60 * 24 * 120) issues.push({ type: "stale_verified", severity: "medium", message: `Old last_verified: ${docMetadata.last_verified}.` });
  if (classification.type === "daily" && /source of truth|canonique|vérité|source de vérité/i.test(text)) issues.push({ type: "temporary_truth_claim", severity: "high", message: "Temporary log presents itself as source of truth." });
  if (gitStatus.trim()) {
    for (const match of text.matchAll(/`([^`]+\.(?:md|mjs|js|py|json|yaml|yml|csv))`/g)) {
      const hinted = match[1];
      if (!hinted.startsWith("http") && !hinted.startsWith("~")) issues.push({ type: "path_reference", severity: "low", message: `Path reference to verify: ${hinted}.` });
      if (issues.filter((issue) => issue.type === "path_reference").length >= 10) break;
    }
  }
  return issues;
}

export function buildDocQaReport(root = process.cwd()) {
  const gitStatuses = readGitStatuses(root);
  const reviewState = readDocReviewState(root);
  const settings = readMemoryWebappSettings(root);
  const files = listMemoryFiles(root);
  const queue = files.map((file) => {
    const classification = classifyDocPath(file.path);
    const gitStatus = gitStatuses.get(file.path) || "";
    const abs = resolveExternalPath(file.path) || path.join(root, file.path);
    const content = file.exists && fs.existsSync(abs) && file.bytes <= MAX_FILE_BYTES ? fs.readFileSync(abs, "utf8") : "";
    const metadata = parseDocMetadata(content, file.path);
    const issues = computeDocIssues({ path: file.path, content, gitStatus, metadata });
    const riskScore = riskScoreFor({ classification, issues, gitStatus });
    const review = currentReviewFor(reviewState.reviews, file.path, content);
    return { path: file.path, label: file.label, summary: file.summary, updatedAt: file.updatedAt, classification, metadata, gitStatus, issues, riskScore, review };
  }).filter((item) => item.gitStatus.trim()
  ).filter((item) => isWatchedPath(item.path, settings)
  ).filter((item) => !(item.review?.status === "verified" && item.review.current)
  ).sort((a, b) => reviewSeverityRank(a) - reviewSeverityRank(b)
    || reviewOrderRank(a.path) - reviewOrderRank(b.path)
    || b.riskScore - a.riskScore
    || a.path.localeCompare(b.path, "fr"));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalDocs: files.length,
      changedDocs: queue.filter((item) => item.gitStatus.trim()).length,
      needsReview: queue.length,
      critical: queue.filter((item) => item.issues.some((issue) => issue.severity === "critical")).length,
      high: queue.filter((item) => item.issues.some((issue) => issue.severity === "high")).length,
      prompts: files.filter((file) => classifyDocPath(file.path).type === "prompt").length,
      canonical: queue.filter((item) => item.metadata.kind === "canonical").length,
    },
    queue: queue.slice(0, 80),
  };
}

function reviewSeverityRank(item) {
  if (item.issues.some((issue) => issue.severity === "critical")) return 0;
  if (item.issues.some((issue) => issue.severity === "high")) return 1;
  return 2;
}

function reviewOrderRank(relPath) {
  const normalized = normalizeRelPath(relPath);
  const exactOrder = new Map([
    ["AGENTS.md", 0],
    [".context-room/config.json", 1],
    ["docs/INDEX.md", 10],
    ["docs/DOCS_GUIDE.md", 11],
    ["docs/PRODUCT.md", 20],
    ["docs/ARCHITECTURE.md", 21],
    ["docs/OPERATING.md", 22],
    ["docs/INFRASTRUCTURE.md", 23],
    ["docs/RUNBOOKS.md", 24],
    ["website/AGENTS.md", 100],
    ["website/docs/INDEX.md", 110],
    ["website/docs/PRODUCT.md", 111],
    ["website/docs/WORKSPACE_MODEL.md", 112],
    ["website/docs/ARCHITECTURE.md", 113],
    ["website/docs/SURFACE_MAP.md", 114],
    ["website/docs/TESTING.md", 115],
    ["website/docs/QA_PLAYBOOK.md", 116],
    ["website/docs/DEPLOYMENT.md", 117],
    ["website/docs/MONITORING.md", 118],
    ["our_agentic_system/AGENTS.md", 200],
    ["our_agentic_system/docs/INDEX.md", 210],
    ["our_agentic_system/docs/PRODUCT.md", 211],
    ["our_agentic_system/docs/ARCHITECTURE.md", 212],
    ["our_agentic_system/docs/SURFACE_MAP.md", 213],
    ["our_agentic_system/docs/PROVIDERS.md", 214],
    ["our_agentic_system/docs/TESTING.md", 215],
    ["our_agentic_system/docs/EVAL_CHECKLIST.md", 216],
    ["our_agentic_system/docs/DEPLOYMENT.md", 217],
    ["our_agentic_system/docs/MONITORING.md", 218],
    [".codex/skills/README.md", 300],
  ]);
  if (exactOrder.has(normalized)) return exactOrder.get(normalized);
  if (normalized.startsWith("docs/")) return 50;
  if (normalized.startsWith("website/docs/")) return 140;
  if (normalized.startsWith("our_agentic_system/docs/")) return 240;
  if (normalized.startsWith(".codex/skills/")) return 310;
  return 1000;
}

export function nextReviewPath(queue = [], currentPath = null) {
  const paths = queue.map((item) => item?.path).filter(Boolean);
  if (!paths.length) return null;
  if (paths.length === 1 && paths[0] === currentPath) return null;
  const index = paths.indexOf(currentPath);
  if (index < 0) return paths[0] || null;
  return paths[(index + 1) % paths.length] || null;
}

export function folderFilterSearchQuery(folderPaths = []) {
  const seen = new Set();
  return folderPaths
    .map((folderPath) => normalizeRelPath(String(folderPath || "")).replace(/\/$/, ""))
    .filter((folderPath) => {
      if (!folderPath || seen.has(folderPath)) return false;
      seen.add(folderPath);
      return true;
    })
    .map((folderPath) => (folderPath.includes(".") && !folderPath.endsWith("/") ? folderPath : folderPath.replace(/\/$/, "") + "/"))
    .join(" ");
}

export function createDefaultProjectConfig({ title = "Context Room", allowedPaths = ALLOWED_PREFIXES, watchAllow = [] } = {}) {
  const hubSections = DEFAULT_HUB_SECTIONS.map(normalizeHubSectionDefinition).filter(Boolean);
  return {
    $schema: CONFIG_SCHEMA_URL,
    title,
    allowedPaths: sanitizePathList(allowedPaths),
    watchAllow: sanitizePathList(watchAllow),
    integrations: { hermes: false },
    startupContext: { ...DEFAULT_STARTUP_CONTEXT },
    bestPractices: [...DOCUMENTATION_BEST_PRACTICES],
    markdownTemplates: DEFAULT_MARKDOWN_TEMPLATES.map(normalizeMarkdownTemplate).filter(Boolean),
    hubCards: { ...DEFAULT_HUB_CARD_VISIBILITY },
    customHubCards: DEFAULT_HUB_CARDS.map(normalizeHubCardDefinition),
    hubSections,
  };
}

export function defaultMemoryWebappSettings() {
  return createDefaultProjectConfig();
}

export function initializeContextRoomProject(root = process.cwd(), options = {}) {
  const existing = fs.existsSync(path.join(root, MEMORY_WEBAPP_SETTINGS)) ? readMemoryWebappSettings(root) : {};
  const title = options.title || existing.title || path.basename(path.resolve(root)) || "Context Room";
  const allowedPaths = options.allowedPaths?.length ? options.allowedPaths : existing.allowedPaths?.length ? existing.allowedPaths : inferAllowedPathsForRoot(root);
  const watchAllow = options.watchAllow?.length ? options.watchAllow : existing.watchAllow?.length ? existing.watchAllow : [];
  const config = normalizeMemoryWebappSettings({ ...createDefaultProjectConfig({ title, allowedPaths, watchAllow }), ...existing, title, allowedPaths, watchAllow });
  const saved = writeMemoryWebappSettings(root, config);
  return { config: saved, configPath: path.join(root, MEMORY_WEBAPP_SETTINGS) };
}

function inferAllowedPathsForRoot(root) {
  const candidates = ["docs/", "src/", "lib/", "app/", "test/", "tests/", "scripts/", "tools/", "memory/", "data/", "README.md", "AGENTS.md", "CLAUDE.md", ".hermes.md", "package.json"];
  const existing = candidates.filter((candidate) => {
    const clean = candidate.replace(/\/$/, "");
    return fs.existsSync(path.join(root, clean));
  });
  return existing.length ? existing : ["docs/", "src/", "README.md"];
}

export function readMemoryWebappSettings(root = process.cwd()) {
  const defaults = defaultMemoryWebappSettings();
  const settingsPath = path.join(root, MEMORY_WEBAPP_SETTINGS);
  if (!fs.existsSync(settingsPath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return normalizeMemoryWebappSettings(parsed, defaults);
  } catch {
    return defaults;
  }
}

export function writeMemoryWebappSettings(root = process.cwd(), next = {}) {
  const settings = normalizeMemoryWebappSettings(next, readMemoryWebappSettings(root));
  const settingsPath = path.join(root, MEMORY_WEBAPP_SETTINGS);
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return settings;
}

export function hubCardsForSettings(settings = defaultMemoryWebappSettings()) {
  return flattenHubCards(hubSectionsForSettings(settings)).filter((card) => hubCardPaths(card).length > 0).map(stripHubCardRuntimeFields);
}

export function hubCardsForRoot(root = process.cwd(), settings = defaultMemoryWebappSettings()) {
  return hubCardsForSettings(settings).map((card) => materializeHubCardForRoot(root, card, settings)).filter(Boolean);
}

export function hubSectionsForRoot(root = process.cwd(), settings = defaultMemoryWebappSettings()) {
  return hubSectionsForSettings(settings)
    .map((section) => ({ ...section, cards: materializeHubCardsForRoot(root, section.cards, settings) }));
}

export function hubSectionViewForCard(sections = [], cardId = null) {
  if (!cardId) return sections;
  const found = findHubCardDefinitionById(sections, cardId);
  return found ? [{ id: found.id, title: found.title, cards: found.cards || [] }] : sections;
}

export function hubBreadcrumbForCard(sections = [], cardId = null) {
  const root = { id: null, title: "Hub" };
  if (!cardId) return [root];
  const path = findHubCardPathById(sections, cardId);
  return path.length ? [root, ...path.map((card) => ({ id: card.id, title: card.title }))] : [root];
}

function findHubCardPathById(sections = [], cardId = null) {
  const visit = (cards = [], ancestors = []) => {
    for (const card of cards) {
      const next = [...ancestors, card];
      if (card.id === cardId) return next;
      const child = visit(card.cards || [], next);
      if (child.length) return child;
    }
    return [];
  };
  for (const section of sections || []) {
    const found = visit(section.cards || []);
    if (found.length) return found;
  }
  return [];
}

function findHubCardDefinitionById(sections = [], cardId = null) {
  const visit = (cards = []) => {
    for (const card of cards) {
      if (card.id === cardId) return card;
      const child = visit(card.cards || []);
      if (child) return child;
    }
    return null;
  };
  for (const section of sections || []) {
    const found = visit(section.cards || []);
    if (found) return found;
  }
  return null;
}

function hubSectionsForSettings(settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeMemoryWebappSettings(settings, defaultMemoryWebappSettings());
  return normalized.hubSections.map((section) => ({ ...section, cards: filterEnabledHubCards(section.cards) }));
}

function materializeHubCardsForRoot(root, cards = [], settings = readMemoryWebappSettings(root)) {
  return cards.map((card) => {
    const explicitChildren = materializeHubCardsForRoot(root, card.cards || [], settings);
    const materialized = materializeHubCardForRoot(root, card, settings);
    const inferredChildren = explicitChildren.length || !card.autoChildren ? [] : inferHubCardChildrenForRoot(root, materialized || card, settings);
    const children = explicitChildren.length ? explicitChildren : inferredChildren;
    if (children.length) return { ...(materialized || stripHubCardRuntimeFields(card)), cards: children, autoChildren: Boolean(card.autoChildren) };
    return materialized;
  }).filter(Boolean);
}

function materializeHubCardForRoot(root, card, settings = readMemoryWebappSettings(root)) {
  const existingPaths = hubCardPaths(card).filter((folderPath) => hubCardPathExists(root, folderPath));
  if (existingPaths.length === 0) return stripHubCardRuntimeFields(card);
  const { path: _path, paths: _paths, cards: _cards, ...rest } = card;
  return existingPaths.length === 1 ? { ...rest, path: existingPaths[0] } : { ...rest, paths: existingPaths };
}

function inferHubCardChildrenForRoot(root, card, settings = readMemoryWebappSettings(root)) {
  const children = [];
  for (const folderPath of hubCardPaths(card)) {
    const cleanFolder = normalizeRelPath(folderPath).replace(/\/$/, "");
    if (!cleanFolder || resolveExternalPath(cleanFolder)) continue;
    const absDir = path.join(root, cleanFolder);
    if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) continue;
    const entries = fs.readdirSync(absDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, "fr"));
    for (const entry of entries) {
      const rel = normalizeRelPath(path.posix.join(cleanFolder, entry.name) + (entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory()) {
        if (!isAllowedFolderPath(rel, settings)) continue;
        children.push({
          id: sanitizeHubCardId(`${card.id || cleanFolder}-${rel}`),
          title: entry.name,
          description: `Folder in ${card.title || cleanFolder}.`,
          path: rel,
          enabled: true,
          autoChildren: true,
        });
        continue;
      }
      if (!isAllowedMemoryPath(rel, settings)) continue;
      children.push({
        id: sanitizeHubCardId(`${card.id || cleanFolder}-${rel}`),
        title: entry.name,
        description: summarizeFileAtPath(path.join(root, rel)),
        path: rel,
        enabled: true,
      });
    }
  }
  return materializeHubCardsForRoot(root, children, settings);
}

function summarizeFileAtPath(absPath) {
  try {
    const stats = fs.statSync(absPath);
    if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return "";
    return summarizeContent(fs.readFileSync(absPath, "utf8"));
  } catch {
    return "";
  }
}

function filterEnabledHubCards(cards = []) {
  return cards.filter((card) => card.enabled !== false).map((card) => ({ ...card, cards: filterEnabledHubCards(card.cards || []) }));
}

function flattenHubCards(sections = []) {
  const cards = [];
  const visit = (items = []) => {
    for (const card of items) {
      cards.push(card);
      visit(card.cards || []);
    }
  };
  for (const section of sections) visit(section.cards || []);
  return cards;
}

function hubCardPaths(card) {
  return (card.paths || [card.path]).filter(Boolean);
}

function hubCardPathExists(root, folderPath) {
  const normalized = normalizeRelPath(folderPath);
  const asFolder = normalized.replace(/\/$/, "") + "/";
  const externalFolder = resolveExternalPath(asFolder);
  if (externalFolder) return fs.existsSync(externalFolder);
  const externalExact = resolveExternalPath(normalized);
  if (externalExact) return fs.existsSync(externalExact);
  return fs.existsSync(path.join(root, normalized)) || fs.existsSync(path.join(root, asFolder));
}

function normalizeMemoryWebappSettings(raw = {}, base = defaultMemoryWebappSettings()) {
  const hubCards = { ...base.hubCards };
  for (const [id, enabled] of Object.entries(raw.hubCards || {})) hubCards[id] = Boolean(enabled);
  let hubSections;
  if (Array.isArray(raw.hubSections)) {
    hubSections = sanitizeHubSectionDefinitions(raw.hubSections);
  } else {
    const cards = Array.isArray(raw.customHubCards)
      ? sanitizeHubCardDefinitions(raw.customHubCards)
      : DEFAULT_HUB_CARDS.map((card) => ({ ...normalizeHubCardDefinition(card), enabled: hubCards[card.id] !== false }));
    hubSections = [{ id: "main", title: "Main", cards }];
  }
  const customHubCards = flattenHubCards(hubSections).filter((card) => hubCardPaths(card).length > 0).map((card) => ({ ...card, cards: undefined }));
  for (const card of flattenHubCards(hubSections)) hubCards[card.id] = card.enabled !== false;
  return {
    $schema: String(raw.$schema || base.$schema || CONFIG_SCHEMA_URL),
    title: String(raw.title || base.title || "Context Room").trim() || "Context Room",
    allowedPaths: sanitizePathList(raw.allowedPaths ?? base.allowedPaths ?? ALLOWED_PREFIXES),
    watchAllow: sanitizePathList(raw.watchAllow ?? base.watchAllow),
    integrations: { hermes: Boolean(raw.integrations?.hermes ?? base.integrations?.hermes ?? false) },
    startupContext: normalizeStartupContextSettings(raw.startupContext ?? base.startupContext),
    bestPractices: sanitizeTextList(raw.bestPractices ?? base.bestPractices ?? DOCUMENTATION_BEST_PRACTICES),
    markdownTemplates: sanitizeMarkdownTemplates(raw.markdownTemplates ?? base.markdownTemplates ?? DEFAULT_MARKDOWN_TEMPLATES),
    hubCards,
    customHubCards,
    hubSections,
  };
}

function normalizeStartupContextSettings(value = {}) {
  const rawFileNames = Array.isArray(value.fileNames) ? value.fileNames : DEFAULT_STARTUP_CONTEXT.fileNames;
  const fileNames = [...new Set(rawFileNames
    .map((item) => path.basename(String(item || "").trim()))
    .filter((item) => item && !isBlockedPath(item) && isEditableTextFile(item))
  )];
  return {
    enabled: Boolean(value.enabled),
    fileNames: fileNames.length ? fileNames : [...DEFAULT_STARTUP_CONTEXT.fileNames],
  };
}

function markdownTemplatesForSettings(settings = defaultMemoryWebappSettings()) {
  return sanitizeMarkdownTemplates(settings.markdownTemplates?.length ? settings.markdownTemplates : DEFAULT_MARKDOWN_TEMPLATES);
}

function sanitizeTextList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 12);
}

function sanitizeMarkdownTemplates(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.map(normalizeMarkdownTemplate).filter((template) => {
    if (!template || seen.has(template.id)) return false;
    seen.add(template.id);
    return true;
  });
}

function normalizeMarkdownTemplate(template = {}, index = 0) {
  const title = String(template.title || template.name || "").trim() || `Template ${index + 1}`;
  const id = sanitizeHubCardId(template.id || title || `template-${index + 1}`);
  const content = String(template.content || "").trimEnd() + "\n";
  if (!id || !title || !content.trim()) return null;
  return {
    id,
    title,
    description: String(template.description || "").trim(),
    content,
    enabled: template.enabled !== false,
  };
}

function visibleMarkdownTemplates(templates = []) {
  return templates.filter((template) => template.enabled !== false);
}

function sanitizeHubSectionDefinitions(sections = []) {
  const seen = new Set();
  return sections.map((section, index) => normalizeHubSectionDefinition(section, index)).filter((section) => {
    if (!section.id || seen.has(section.id) || !section.title) return false;
    seen.add(section.id);
    return true;
  });
}

function normalizeHubSectionDefinition(section = {}, index = 0) {
  const title = String(section.title || section.name || "").trim() || `Section ${index + 1}`;
  return {
    id: sanitizeHubCardId(section.id || title || `section-${index + 1}`),
    title,
    cards: sanitizeHubCardDefinitions(section.cards || []),
  };
}

function sanitizeHubCardDefinitions(cards = []) {
  const seen = new Set();
  return cards.map((card, index) => normalizeHubCardDefinition(card, index)).filter((card) => {
    if (!card.id || seen.has(card.id) || !card.title) return false;
    seen.add(card.id);
    return true;
  });
}

function normalizeHubCardDefinition(card = {}, index = 0) {
  const rawTitle = String(card.title || card.name || "").trim();
  const id = sanitizeHubCardId(card.id || rawTitle || `custom-${index + 1}`);
  const paths = sanitizePathList(card.paths || (card.path ? [card.path] : []));
  const children = sanitizeHubCardDefinitions(card.cards || []);
  const normalized = {
    id,
    title: rawTitle || id,
    description: String(card.description || "").trim(),
    paths,
    cards: children,
    enabled: card.enabled !== false,
  };
  if (card.autoChildren) normalized.autoChildren = true;
  if (paths.length === 1) normalized.path = paths[0];
  return normalized;
}

function sanitizeHubCardId(value) {
  const clean = String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || `custom-${Date.now().toString(36)}`;
}

function stripHubCardRuntimeFields(card) {
  const paths = hubCardPaths(card);
  const base = { id: card.id, title: card.title, description: card.description };
  if ((card.cards || []).length) base.cards = card.cards;
  if (card.autoChildren) base.autoChildren = true;
  return paths.length === 0 ? base : paths.length === 1 ? { ...base, path: paths[0] } : { ...base, paths };
}

function sanitizePathList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeRelPath(String(item || ""))).filter((item) => item && !item.startsWith("../") && !item.includes("/../") && !path.isAbsolute(item) && !isBlockedPath(item)))];
}

function isWatchedPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath);
  return settings.watchAllow.some((pattern) => pathMatchesSetting(normalized, pattern));
}

function pathMatchesSetting(relPath, pattern) {
  const clean = normalizeRelPath(pattern).replace(/\/$/, "");
  const normalizedPath = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!clean) return false;
  return normalizedPath === clean || normalizedPath.startsWith(clean + "/");
}

export function watchStateForPath(relPath, watchAllow = []) {
  const clean = normalizeRelPath(relPath);
  const normalizedWatch = (watchAllow || []).map((item) => normalizeRelPath(item));
  if (normalizedWatch.includes(clean)) return "watched";
  return normalizedWatch.some((pattern) => pathMatchesSetting(clean, pattern)) ? "watched-inherited" : "";
}

export function explorerWatchFilterMatches(relPath, filter = "all", watchAllow = []) {
  if (filter === "watched") return Boolean(watchStateForPath(relPath, watchAllow));
  if (filter === "unwatched") return !watchStateForPath(relPath, watchAllow);
  return true;
}

export function explorerExpansionPathsForFiles(files = []) {
  const seen = new Set();
  const paths = [];
  for (const item of files || []) {
    const filePath = normalizeRelPath(typeof item === "string" ? item : item?.path || "");
    const parts = filePath.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (parent && !seen.has(parent)) {
        seen.add(parent);
        paths.push(parent);
      }
    }
  }
  return paths;
}

function riskScoreFor({ classification, issues, gitStatus }) {
  const authorityScore = { critical: 80, high: 55, medium: 25, low: 10 }[classification.authority] || 0;
  const changeScore = gitStatus.trim() ? 35 : 0;
  const issueScore = issues.reduce((score, issue) => score + ({ critical: 90, high: 55, medium: 25, low: 8 }[issue.severity] || 0), 0);
  return changeScore + issueScore + (issues.length ? authorityScore : 0);
}

function readGitStatuses(root) {
  const statuses = new Map();
  try {
    const rootPrefix = gitRepoPrefixForRoot(root);
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const rawRel = gitStatusPathFromPorcelainLine(line);
      const rel = normalizeGitStatusPathForRoot(rawRel, rootPrefix);
      if (rel) statuses.set(rel, status);
    }
  } catch {
    // Git is optional for temp test roots and non-repo launches.
  }
  return statuses;
}

function gitRepoPrefixForRoot(root) {
  try {
    return normalizeRelPath(execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    return "";
  }
}

function gitStatusPathFromPorcelainLine(line) {
  const raw = line.slice(3).replace(/^"|"$/g, "").replaceAll("\\", "/");
  if (!raw.includes(" -> ")) return raw;
  return raw.split(" -> ").pop() || raw;
}

function normalizeGitStatusPathForRoot(relPath, rootPrefix = "") {
  const normalized = normalizeRelPath(relPath);
  const prefix = normalizeRelPath(rootPrefix);
  if (!prefix) return normalized;
  if (normalized === prefix.replace(/\/$/, "")) return "";
  if (!normalized.startsWith(prefix)) return "";
  return normalizeRelPath(normalized.slice(prefix.length));
}

export function createMemoryServer({ root = process.cwd(), port = DEFAULT_PORT } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, root);
    } catch (error) {
      sendJson(res, 500, { error: error.message });
    }
  });
  return { server, root, port };
}

async function routeRequest(req, res, root) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, renderAppHtml());
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/files") {
    sendJson(res, 200, { files: listMemoryFiles(root), root });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/startup-context") {
    sendJson(res, 200, { files: listStartupContextFiles(root).map(publicStartupContextFile), root });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/startup-context/file") {
    const order = url.searchParams.get("order") || "";
    sendJson(res, 200, readStartupContextFile(root, order));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    const settings = readMemoryWebappSettings(root);
    sendJson(res, 200, { settings, hubCards: hubCardsForRoot(root, settings), hubSections: hubSectionsForRoot(root, settings), availableHubCards: settings.customHubCards });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const settings = writeMemoryWebappSettings(root, body.settings || body);
    sendJson(res, 200, { settings, hubCards: hubCardsForRoot(root, settings), hubSections: hubSectionsForRoot(root, settings), availableHubCards: settings.customHubCards });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/docqa") {
    sendJson(res, 200, buildDocQaReport(root));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/graph") {
    sendJson(res, 200, buildDocumentationGraph(root));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/doctor") {
    sendJson(res, 200, buildContextRoomDoctorReport(root));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/brief") {
    sendJson(res, 200, { brief: buildAgentBrief(root, { task: url.searchParams.get("task") || "", limit: Number(url.searchParams.get("limit") || 12) }) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/docqa/review") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeDocReviewDecision(root, body.path, { status: body.status, note: body.note }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/file") {
    const relPath = url.searchParams.get("path") || "";
    sendJson(res, 200, readMemoryFile(root, relPath));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/file/diff") {
    const relPath = url.searchParams.get("path") || "";
    sendJson(res, 200, readFileDiff(root, relPath));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/file/revert") {
    const body = await readJsonBody(req);
    sendJson(res, 200, revertMemoryFile(root, body.path));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/file") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeMemoryFile(root, body.path, body.content));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/markdown/create") {
    const body = await readJsonBody(req);
    sendJson(res, 200, createMarkdownFile(root, { path: body.path, title: body.title, templateId: body.templateId, applyTemplate: body.applyTemplate, metadata: body.metadata }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/folder/create") {
    const body = await readJsonBody(req);
    sendJson(res, 200, createFolder(root, { path: body.path }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/markdown/apply-template") {
    const body = await readJsonBody(req);
    sendJson(res, 200, applyMarkdownTemplateToFile(root, { path: body.path, title: body.title, templateId: body.templateId }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/files/delete") {
    const body = await readJsonBody(req);
    sendJson(res, 200, deleteMemoryPaths(root, body.paths));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, root, files: listMemoryFiles(root).length });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function normalizeRelPath(relPath) {
  return relPath.replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function displayPath(absPath) {
  const home = process.env.HOME ? path.resolve(process.env.HOME) : "";
  const resolved = path.resolve(absPath);
  if (home && (resolved === home || resolved.startsWith(home + path.sep))) return "~/" + path.relative(home, resolved).replaceAll(path.sep, "/");
  return resolved;
}

function isEditableTextFile(relPath) {
  return [".md", ".csv", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".mjs", ".js", ".py"].includes(path.extname(relPath));
}

function validateEditableContent(relPath, content) {
  if (hasUnresolvedConflictMarkers(content)) {
    throw new Error(`Refusing to write unresolved conflict markers in ${relPath}`);
  }
  if (path.extname(relPath) !== ".json") return;
  try {
    JSON.parse(content || "null");
  } catch (error) {
    throw new Error(`Invalid JSON in ${relPath}: ${error.message}`);
  }
}

function hasUnresolvedConflictMarkers(content) {
  return /^(<<<<<<<|=======|>>>>>>>)/m.test(String(content || ""));
}

function walkTextFiles(dir, root, settings = defaultMemoryWebappSettings()) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkTextFiles(abs, root, settings));
    } else if (entry.isFile()) {
      const rel = path.relative(root, abs).replaceAll(path.sep, "/");
      if (isAllowedMemoryPath(rel, settings)) results.push(rel);
    }
  }
  return results;
}

function walkExternalTextFiles(dir, baseDir, virtualPrefix) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkExternalTextFiles(abs, baseDir, virtualPrefix));
    } else if (entry.isFile()) {
      const rel = virtualPrefix + path.relative(baseDir, abs).replaceAll(path.sep, "/");
      if (isAllowedMemoryPath(rel)) results.push(rel);
    }
  }
  return results;
}

function isAllowedFolderPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  if (normalized.startsWith("~")) return false;
  const allowed = sanitizePathList(settings.allowedPaths || ALLOWED_PREFIXES);
  return allowed.some((prefix) => {
    const clean = prefix.replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(clean + "/");
  });
}

function isAllowedExternalPath(relPath) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  return Boolean(externalPrefixForPath(normalized));
}

function isAllowedExternalMemoryPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath);
  if (!resolveExternalPath(normalized)) return false;
  if (normalized.startsWith("~/.hermes/")) {
    return Boolean(settings.integrations?.hermes) && ALLOWED_EXTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }
  const allowed = sanitizePathList(settings.allowedPaths || []);
  return allowed.some((pattern) => pathMatchesSetting(normalized, pattern));
}

function externalPrefixForPath(relPath) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  return ALLOWED_EXTERNAL_PREFIXES.find((prefix) => {
    const clean = prefix.replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(`${clean}/`);
  }) || null;
}

function pruneEmptyDirs(startDir, stopRoot) {
  let current = path.resolve(startDir);
  const resolvedStopRoot = path.resolve(stopRoot);
  while (current.startsWith(`${resolvedStopRoot}${path.sep}`)) {
    try {
      if (fs.existsSync(current) && fs.statSync(current).isDirectory() && fs.readdirSync(current).length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
        continue;
      }
    } catch {
      return;
    }
    return;
  }
}

function categoryForPath(relPath) {
  if (relPath.startsWith("~/.hermes/memories/")) return "1 · injected by Hermes";
  if (relPath.startsWith("~/.hermes/cron/")) return "2 · Hermes automations";
  if (relPath.startsWith("~/.hermes/skills/")) return "3 · Hermes folders · skills";
  if (relPath === ".hermes.md") return "1 · injected by Hermes";
  if (relPath.startsWith("data/daily/")) return "3 · Project folders · daily";
  if (relPath.startsWith("memory/")) return "3 · Project folders · memory";
  if (relPath.startsWith("data/")) return "3 · Project folders · data";
  if (relPath.startsWith("integrations/")) return "3 · Project folders · integrations";
  if (relPath.startsWith("skills/")) return "3 · Project folders · skills";
  if (relPath.startsWith("tools/")) return "3 · Project folders · tools";
  return "Files";
}

function labelForHermesSkillPath(relPath) {
  const parts = relPath.replace(/^~\/\.hermes\/skills\//, "").split("/").filter(Boolean);
  if (parts.at(-1) === "SKILL.md" && parts.length >= 2) return `Hermes skill · ${parts.at(-2)}`;
  return path.basename(relPath);
}

function categoryRank(category) {
  const match = category.match(/^(\d+)/);
  return match ? Number(match[1]) : 99;
}

function summarizeContent(content) {
  const firstHeading = content.match(/^#\s+(.+)$/m)?.[1];
  const frontmatterStatus = content.match(/^status:\s*(.+)$/m)?.[1];
  const lines = content.split("\n").filter((line) => line.trim());
  return firstHeading || (frontmatterStatus ? `status: ${frontmatterStatus}` : lines[0] || "");
}

function buildBackupPath(relPath) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.posix.join(".context-room/memory-webapp-backups", stamp, backupSafePath(relPath));
}

function resolveExternalPath(relPath) {
  if (relPath === "~/.hermes/memories/") return path.join(getHermesHome(), "memories") + path.sep;
  if (relPath === "~/.hermes/memories/USER.md") return path.join(getHermesHome(), "memories", "USER.md");
  if (relPath === "~/.hermes/memories/MEMORY.md") return path.join(getHermesHome(), "memories", "MEMORY.md");
  if (relPath === HERMES_CRON_JOBS_FOLDER) return path.join(getHermesHome(), "cron", "jobs.json");
  if (relPath === HERMES_CRON_MD_FOLDER) return path.join(getHermesHome(), "cron", "jobs-md") + path.sep;
  if (relPath === "~/.hermes/cron/jobs.json") return path.join(getHermesHome(), "cron", "jobs.json");
  if (relPath === "~/.hermes/skills/") return path.join(getHermesHome(), "skills") + path.sep;
  if (relPath.startsWith("~/.hermes/skills/")) return path.join(getHermesHome(), "skills", relPath.slice("~/.hermes/skills/".length));
  return null;
}

function getHermesHome() {
  return process.env.HERMES_HOME ? path.resolve(process.env.HERMES_HOME) : path.join(osHome(), ".hermes");
}

function osHome() {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function backupSafePath(relPath) {
  return relPath.replace(/^~\/\.hermes\//, "external/hermes/");
}

function isBlockedPath(relPath) {
  const lowered = relPath.toLowerCase();
  return lowered.includes(".env")
    || lowered.includes("auth.json")
    || lowered.includes("credential")
    || lowered.includes("secret")
    || lowered.includes("token")
    || lowered.includes("private_key")
    || lowered.includes("id_rsa")
    || lowered.includes("id_ed25519");
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export function renderFileActionButtons({ hasReviewItem = false, dirty = false } = {}) {
  return '<div class="file-actions">' +
    (hasReviewItem ? '<button class="file-action" type="button" data-file-verify>Mark verified</button>' : '') +
    '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' +
    '<button class="file-action primary" type="button" data-file-save ' + (!dirty ? 'disabled' : '') + '>Save</button>' +
  '</div>';
}

export function renderReviewSummary(summary = {}) {
  const changed = Number(summary.changedDocs || 0).toLocaleString("en-US");
  const needsReview = Number(summary.needsReview || 0).toLocaleString("en-US");
  return '<div class="review-summary-item"><strong>' + changed + '</strong><span>changed</span></div>' +
    '<div class="review-summary-item"><strong>' + needsReview + '</strong><span>to review</span></div>';
}

export function renderAppHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Context Room</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0b1020;
      --panel: rgba(18, 25, 46, 0.82);
      --panel-strong: rgba(25, 35, 63, 0.96);
      --line: rgba(148, 163, 184, 0.18);
      --text: #eef4ff;
      --muted: #98a6bd;
      --accent: #8bd3ff;
      --accent-2: #b69cff;
      --good: #8df0b4;
      --danger: #ff8c9d;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, rgba(139, 211, 255, 0.22), transparent 30rem),
        radial-gradient(circle at 80% 20%, rgba(182, 156, 255, 0.18), transparent 28rem),
        var(--bg);
      color: var(--text);
      overflow: hidden;
    }
    body::before, body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; }
    body::before { background-image: radial-gradient(circle, rgba(255,255,255,0.42) 0 1px, transparent 1.6px); background-size: 86px 86px; opacity: 0.16; animation: starDrift 38s linear infinite; }
    body::after { background: radial-gradient(circle at 65% 48%, rgba(139,211,255,0.16), transparent 22rem), radial-gradient(circle at 30% 74%, rgba(182,156,255,0.12), transparent 26rem); animation: nebulaPulse 12s ease-in-out infinite alternate; }
    .app { position: relative; z-index: 1; display: grid; grid-template-columns: 390px 1fr; height: 100vh; min-height: 0; overflow: hidden; transition: grid-template-columns 260ms ease; }
    .app.sidebar-collapsed { grid-template-columns: 76px 1fr; }
    aside { border-right: 1px solid var(--line); padding: 14px 18px; background: rgba(8, 13, 27, 0.72); backdrop-filter: blur(22px); height: 100vh; min-height: 0; overflow: auto; display: block; transition: padding 260ms ease, background 260ms ease; }
    .app.sidebar-collapsed aside { padding: 14px 10px; overflow: visible; }
    .app.sidebar-collapsed .sidebar-toggle { position: fixed; left: 16px; top: 16px; z-index: 20; background: rgba(12,20,38,0.96); }
    .sidebar-head { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: start; }
    .sidebar-toggle { border: 1px solid rgba(139,211,255,0.28); border-radius: 14px; background: rgba(255,255,255,0.06); color: var(--text); width: 42px; height: 42px; cursor: pointer; box-shadow: 0 0 28px rgba(139,211,255,0.12); transition: transform 160ms ease, background 160ms ease; }
    .sidebar-toggle:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .explorer-open { display: none; border: 1px solid rgba(139,211,255,0.28); border-radius: 14px; background: rgba(255,255,255,0.06); color: var(--text); width: 42px; height: 42px; cursor: pointer; align-items: center; justify-content: center; box-shadow: 0 0 28px rgba(139,211,255,0.12); transition: transform 160ms ease, background 160ms ease; }
    .explorer-open:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .app.sidebar-collapsed .sidebar-copy, .app.sidebar-collapsed .workspace-dock, .app.sidebar-collapsed .search-row, .app.sidebar-collapsed .watch-filter-row, .app.sidebar-collapsed .selection-bar, .app.sidebar-collapsed .explorer-title, .app.sidebar-collapsed .tree, .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateX(-10px); }
    .sidebar-copy, .workspace-dock, .search-row, .watch-filter-row, .selection-bar, .explorer-title, .tree, .hint { transition: opacity 180ms ease, transform 180ms ease; }
    main { padding: 24px; display: grid; grid-template-rows: 1fr; gap: 18px; min-width: 0; min-height: 0; overflow: hidden; }
    h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.04em; }
    .subtitle { color: var(--muted); line-height: 1.35; font-size: 13px; }
    .launch-map { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 10px 0; }
    .launch-card { border: 1px solid var(--line); border-radius: 12px; padding: 8px; background: rgba(255,255,255,0.045); min-width: 0; transition: transform 180ms ease, border-color 180ms ease, background 180ms ease; }
    .launch-card:hover { transform: translateY(-2px); border-color: rgba(139,211,255,0.38); background: rgba(139,211,255,0.08); }
    .launch-card.hot { border-color: rgba(141, 240, 180, 0.42); background: rgba(141, 240, 180, 0.08); }
    .launch-card strong { display: block; font-size: 11px; line-height: 1.2; }
    .launch-card span { display: none; }
    .quick-files { display: grid; gap: 5px; margin: 6px 0 10px; overflow: visible; padding-right: 4px; }
    .quick-group { display: grid; gap: 4px; }
    .quick-group-title { color: var(--muted); font-size: 10px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.1em; margin: 6px 0 2px; }
    .quick-file { width: 100%; border: 1px solid rgba(148,163,184,0.16); border-radius: 9px; background: rgba(255,255,255,0.035); color: var(--text); text-align: left; padding: 6px 8px; cursor: pointer; display: grid; gap: 1px; }
    .quick-file:hover { background: rgba(139,211,255,0.08); border-color: rgba(139,211,255,0.28); transform: translateX(2px); }
    .quick-file.active { background: rgba(139,211,255,0.14); border-color: rgba(139,211,255,0.56); }
    .quick-file strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-file span { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .search-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; margin: 10px 0 10px; }

    .search { width: 100%; margin: 20px 0 16px; padding: 13px 14px; border-radius: 14px; border: 1px solid var(--line); background: rgba(255,255,255,0.05); color: var(--text); outline: none; }
    .search-row .search { margin: 0; }
    .clear-search { border: 1px solid var(--line); border-radius: 14px; padding: 12px 13px; background: rgba(255,255,255,0.055); color: var(--muted); cursor: pointer; }
    .clear-search:hover { color: var(--text); background: rgba(255,255,255,0.085); }
    .watch-filter-row { display: flex; gap: 4px; margin: -3px 0 6px; align-items: center; }
    .watch-filter { border: 1px solid rgba(148,163,184,0.16); border-radius: 999px; padding: 4px 7px; background: rgba(255,255,255,0.035); color: var(--muted); cursor: pointer; font-size: 10px; font-weight: 850; line-height: 1; }
    .watch-filter:hover { color: var(--text); background: rgba(139,211,255,0.08); }
    .watch-filter.active { color: #07101e; border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .explorer-context-menu { position: fixed; z-index: 80; width: min(245px, calc(100vw - 24px)); border: 1px solid rgba(139,211,255,0.24); border-radius: 14px; background: rgba(8,13,27,0.96); box-shadow: 0 18px 48px rgba(0,0,0,0.38); backdrop-filter: blur(20px); padding: 8px; display: grid; gap: 7px; }
    .explorer-context-menu[hidden] { display: none; }
    .explorer-context-title { display: grid; gap: 2px; color: #dce8fb; font-size: 11px; font-weight: 900; padding: 2px 4px; }
    .explorer-context-title code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .explorer-context-form { display: grid; gap: 7px; }
    .explorer-context-form[hidden] { display: none; }
    .explorer-context-label { color: var(--muted); font-size: 10px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.08em; padding: 0 2px; }
    .explorer-context-form input, .explorer-context-form select, .file-template-select { width: 100%; padding: 8px 10px; border: 1px solid rgba(148,163,184,0.18); border-radius: 10px; background: rgba(255,255,255,0.045); color: var(--text); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .explorer-context-form input:focus { outline: none; border-color: rgba(139,211,255,0.5); background: rgba(139,211,255,0.06); }
    .explorer-context-actions { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; }
    .explorer-context-actions[hidden] { display: none; }
    .explorer-context-actions.menu-actions { grid-template-columns: 1fr; }
    .explorer-context-actions.form-actions { grid-template-columns: 1fr 1fr; gap: 8px; }
    .explorer-context-menu .explorer-context-actions button { padding: 8px 10px; border-radius: 10px; font-size: 12px; line-height: 1.2; }
    select option { color: #111827; background: #ffffff; }
    select option:checked { color: #07101e; background: #93c5fd; }
    .empty-template-actions { display: grid; grid-template-columns: minmax(140px, 220px) auto; gap: 8px; align-items: center; }
    .empty-template-actions .file-template-select { min-width: 0; }
    .explorer-title { color: var(--accent); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.12em; margin: 10px 0 6px; }
    .tree { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.35; overflow: visible; padding-right: 4px; min-height: 180px; }
    .tree-node { min-width: 0; }
    .tree-row { width: 100%; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--text); text-align: left; padding: 5px 7px; cursor: pointer; display: flex; align-items: center; gap: 6px; min-width: 0; }
    .tree-row:hover { background: rgba(255,255,255,0.065); transform: translateX(2px); }
    .tree-row.active { border-color: rgba(139,211,255,0.48); background: rgba(139,211,255,0.12); }
    .tree-row.folder { color: #d8e4f8; font-weight: 700; }
    .tree-row.file { color: #c7d2e6; }
    .twisty { color: var(--muted); width: 13px; flex: 0 0 auto; }
    .icon { width: 16px; flex: 0 0 auto; opacity: 0.9; }
    .tree-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tree-children { margin-left: 15px; border-left: 1px solid rgba(148,163,184,0.12); padding-left: 4px; }
    .topbar, .editor-shell { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow); backdrop-filter: blur(24px); }
    .topbar { display: none; }
    .topbar { display: none; }
    .selected-title { font-size: 22px; font-weight: 850; letter-spacing: -0.03em; }
    .selected-path { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-top: 5px; }
    .selected-impact { color: #c5d2e8; font-size: 14px; line-height: 1.45; margin-top: 12px; max-width: 980px; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .history-nav { display: flex; gap: 6px; }
    .history-nav button { min-width: 42px; padding-left: 12px; padding-right: 12px; }
    button.primary, button.secondary { border: 0; border-radius: 14px; padding: 12px 16px; color: #07101e; background: linear-gradient(135deg, var(--accent), var(--accent-2)); font-weight: 850; cursor: pointer; transition: transform 160ms ease, filter 160ms ease, background 160ms ease; }
    button.primary:hover, button.secondary:hover { transform: translateY(-1px); filter: brightness(1.08); }
    button.secondary { background: rgba(255,255,255,0.08); color: var(--text); border: 1px solid var(--line); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .status { color: var(--muted); font-size: 13px; min-width: 150px; text-align: right; }
    .editor-shell { min-height: 0; overflow: hidden; position: relative; }
    .workspace-dock { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin: 0 0 12px; padding: 7px; border: 1px solid rgba(148,163,184,0.18); border-radius: 18px; background: rgba(8,13,27,0.82); backdrop-filter: blur(18px); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
    .dock-button { border: 1px solid rgba(148,163,184,0.22); border-radius: 12px; background: rgba(255,255,255,0.06); color: var(--text); padding: 9px 11px; font-weight: 850; cursor: pointer; }
    .dock-button:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .dock-button.primary { color: #07101e; border: 0; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .dock-status { display: none; }
    .docqa-home { height: 100%; padding: 24px; overflow: auto; position: relative; background: radial-gradient(circle at 18% 0%, rgba(139,211,255,0.12), transparent 28rem), rgba(3, 7, 18, 0.36); scroll-padding-bottom: 28px; }
    .docqa-grid { display: grid; grid-template-columns: 1fr; gap: 18px; align-items: start; }
    .docqa-panel { border: 1px solid var(--line); border-radius: 22px; background: rgba(8, 13, 27, 0.72); box-shadow: var(--shadow); overflow: hidden; }
    .docqa-panel header { padding: 18px 20px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
    .docqa-panel h2 { margin: 0; font-size: 18px; letter-spacing: -0.03em; }
    .docqa-panel .muted { color: var(--muted); font-size: 12px; }
    .review-summary { display: flex; gap: 10px; align-items: stretch; flex-wrap: wrap; }
    .review-summary-item { min-width: 118px; border: 1px solid rgba(148,163,184,0.16); border-radius: 16px; background: rgba(255,255,255,0.045); padding: 10px 12px; }
    .review-summary-item strong { display: block; font-size: 24px; line-height: 1; }
    .review-summary-item span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; }
    .review-list { display: grid; gap: 8px; padding: 12px; max-height: clamp(220px, 34vh, 360px); overflow: auto; overscroll-behavior-y: auto; scrollbar-gutter: stable; }
    .review-item { border: 1px solid rgba(148,163,184,0.16); border-radius: 16px; background: rgba(255,255,255,0.04); color: var(--text); text-align: left; padding: 13px; cursor: pointer; display: grid; gap: 8px; }
    .review-item:hover, .review-item.active { border-color: rgba(139,211,255,0.42); background: rgba(139,211,255,0.08); transform: translateX(2px); }
    .review-top { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .review-title { font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .review-path { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; padding: 4px 8px; color: #dce8fb; background: rgba(255,255,255,0.045); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
    .chip.critical { border-color: rgba(255,140,157,0.58); color: #ffc0c8; background: rgba(255,140,157,0.10); }
    .chip.high { border-color: rgba(255,196,107,0.55); color: #ffd79c; background: rgba(255,196,107,0.10); }
    .inspector-body { padding: 16px 18px; display: grid; gap: 14px; }
    .inspector-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); overflow-wrap: anywhere; }
    .issue-list { display: grid; gap: 8px; }
    .issue { border-left: 3px solid rgba(139,211,255,0.5); padding: 8px 10px; background: rgba(255,255,255,0.035); border-radius: 10px; color: #d7e2f4; font-size: 13px; }
    .issue.critical { border-left-color: var(--danger); }
    .issue.high { border-left-color: #ffc46b; }
    .docqa-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .markdown-tools { padding: 16px 18px 18px; display: grid; gap: 16px; }
    .best-practice-list { margin: 0; padding-left: 20px; display: grid; gap: 7px; color: #d7e2f4; font-size: 13px; line-height: 1.45; }
    .markdown-create { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr)); gap: 10px; align-items: end; }
    .markdown-create .settings-field.paths { grid-column: span 2; }
    .markdown-create button { align-self: end; min-height: 42px; }
    .new-doc-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: 10px; flex-wrap: wrap; }
    .markdown-create .settings-field select { display: block; width: 100%; padding: 10px; border: 1px solid rgba(148,163,184,0.18); border-radius: 14px; background: rgba(255,255,255,0.045); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .path-picker-field { grid-column: span 2; }
    .path-picker { position: relative; display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 8px; padding: 10px; border: 1px solid rgba(139,211,255,0.18); border-radius: 16px; background: rgba(255,255,255,0.035); }
    .path-picker-trigger { min-width: 0; min-height: 42px; border: 1px solid rgba(148,163,184,0.18); border-radius: 14px; padding: 10px 12px; background: rgba(255,255,255,0.045); color: var(--text); cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; text-align: left; }
    .path-picker-trigger:hover, .path-picker-trigger[aria-expanded="true"] { border-color: rgba(139,211,255,0.42); background: rgba(139,211,255,0.08); }
    .path-picker-trigger code { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #edf5ff; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .path-picker-trigger span { color: var(--muted); font-size: 13px; }
    .path-picker-menu { position: absolute; z-index: 70; top: calc(100% + 8px); left: 10px; width: min(620px, calc(100vw - 56px)); max-height: min(430px, 52vh); border: 1px solid rgba(139,211,255,0.26); border-radius: 16px; background: rgba(8,13,27,0.98); box-shadow: 0 24px 70px rgba(0,0,0,0.42); backdrop-filter: blur(20px); padding: 10px; display: grid; gap: 10px; }
    .path-picker-menu[hidden] { display: none; }
    .path-picker-search { width: 100%; padding: 10px 12px; border: 1px solid rgba(148,163,184,0.20); border-radius: 12px; background: rgba(255,255,255,0.055); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .path-picker-options { display: grid; gap: 5px; max-height: min(330px, 40vh); overflow: auto; padding-right: 3px; }
    .path-picker-option { width: 100%; min-width: 0; border: 1px solid rgba(148,163,184,0.14); border-radius: 10px; padding: 9px 10px; background: rgba(255,255,255,0.035); color: #dce8fb; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; text-align: left; }
    .path-picker-option:hover, .path-picker-option.active { border-color: rgba(139,211,255,0.45); background: rgba(139,211,255,0.10); }
    .path-picker-option code { min-width: 0; color: var(--accent); font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .path-picker-option span { color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; white-space: nowrap; }
    .path-picker-empty { color: var(--muted); padding: 10px; font-size: 13px; }
    .path-picker-preview { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .path-picker-preview code { min-width: 0; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; text-transform: none; letter-spacing: 0; overflow-wrap: anywhere; }
    .settings-page { height: 100%; overflow: auto; padding: 24px; background: radial-gradient(circle at 20% 0%, rgba(182,156,255,0.14), transparent 28rem), rgba(3, 7, 18, 0.36); }
    .settings-page .settings-card { max-width: 1180px; margin: 0 auto; }
    .settings-card { box-shadow: var(--shadow); background: rgba(8,13,27,0.76); border: 1px solid var(--line); backdrop-filter: blur(18px); }
    .settings-card header { padding: 18px 20px; border-bottom: 1px solid var(--line); align-items: center; gap: 10px; }
    .settings-card h2 { font-size: 22px; letter-spacing: -0.04em; }
    .settings-panel { padding: 20px; display: grid; gap: 18px; }
    .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .settings-field { display: grid; gap: 6px; }
    .settings-field label, .settings-title { color: var(--muted); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.09em; }
    .settings-field textarea, .settings-field input { display: block; width: 100%; padding: 10px; border: 1px solid rgba(148,163,184,0.18); border-radius: 14px; background: rgba(255,255,255,0.045); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .settings-field textarea { min-height: 88px; height: 88px; resize: vertical; }
    .hub-card-options { display: grid; gap: 12px; }
    .hub-card-option { display: flex; align-items: center; gap: 6px; border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; padding: 7px 10px; color: #dce8fb; background: rgba(255,255,255,0.04); font-size: 12px; }
    .hub-section-editor { display: grid; gap: 10px; padding-top: 12px; border-top: 1px solid rgba(139,211,255,0.24); }
    .hub-section-editor:first-child { padding-top: 0; border-top: 0; }
    .hub-section-editor-head { display: grid; grid-template-columns: 1fr auto auto; gap: 8px; align-items: end; }
    .hub-card-editor { display: grid; gap: 10px; padding: 12px; border: 1px solid rgba(148,163,184,0.16); border-radius: 18px; background: rgba(255,255,255,0.035); }
    .hub-card-editor.nested { margin-left: 18px; border-left-color: rgba(139,211,255,0.42); }
    .hub-card-children { display: grid; gap: 8px; padding-left: 8px; border-left: 1px solid rgba(139,211,255,0.20); }
    .hub-card-editor-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; }
    .hub-card-editor-title { display: flex; gap: 8px; align-items: center; color: #dce8fb; font-size: 12px; font-weight: 850; }
    .hub-card-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .hub-card-editor .paths { grid-column: 1 / -1; }
    .template-editor { display: grid; gap: 10px; padding: 12px; border: 1px solid rgba(148,163,184,0.16); border-radius: 18px; background: rgba(255,255,255,0.035); }
    .template-editor-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; color: #dce8fb; font-size: 12px; font-weight: 850; }
    .template-enabled-toggle { display: inline-flex; gap: 8px; align-items: center; color: #dce8fb; font-size: 12px; font-weight: 850; }
    .template-enabled-toggle input { width: auto; accent-color: var(--accent); }
    .template-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .template-editor .template-body { grid-column: 1 / -1; }
    .template-editor .template-body textarea { min-height: 220px; height: 220px; }
    .settings-footer { display: flex; justify-content: space-between; gap: 12px; align-items: center; color: var(--muted); font-size: 12px; }
    .hub-folders { margin-top: 16px; display: grid; gap: 26px; }
    .hub-breadcrumb { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: -6px; padding: 10px 12px; border: 1px solid rgba(139,211,255,0.18); border-radius: 18px; background: rgba(8,13,27,0.58); color: var(--muted); font-size: 12px; font-weight: 800; }
    .hub-crumb { border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; padding: 7px 10px; background: rgba(255,255,255,0.04); color: #dce8fb; cursor: pointer; font-weight: 850; }
    .hub-crumb:hover { color: #07101e; background: linear-gradient(135deg, var(--accent), var(--accent-2)); transform: translateY(-1px); }
    .hub-crumb.current { pointer-events: none; color: var(--accent); background: rgba(139,211,255,0.10); }
    .hub-crumb-separator { color: rgba(148,163,184,0.52); }
    .hub-section { display: grid; gap: 14px; padding-top: 18px; border-top: 1px solid rgba(139,211,255,0.24); }
    .hub-section:first-child { border-top: 0; padding-top: 0; }
    .hub-section-title { color: var(--muted); font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.13em; }
    .hub-section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: 14px; align-items: start; }
    .hub-folder-card { min-width: 0; border: 1px solid rgba(148,163,184,0.16); border-radius: 22px; padding: 0; min-height: 132px; background: linear-gradient(145deg, rgba(139,211,255,0.10), rgba(182,156,255,0.06)); color: var(--text); text-align: left; display: grid; gap: 0; box-shadow: 0 18px 54px rgba(0,0,0,0.24); overflow: hidden; }
    .hub-folder-card.navigation { background: linear-gradient(145deg, rgba(182,156,255,0.13), rgba(139,211,255,0.07)); }
    .hub-folder-card.expanded { grid-column: 1 / -1; border-color: rgba(139,211,255,0.38); background: linear-gradient(145deg, rgba(139,211,255,0.13), rgba(182,156,255,0.08)); }
    .hub-folder-card.current { border-color: rgba(139,211,255,0.54); }
    .hub-folder-card:hover { transform: translateY(-2px); border-color: rgba(139,211,255,0.42); background: linear-gradient(145deg, rgba(139,211,255,0.16), rgba(182,156,255,0.10)); }
    .hub-folder-card-main { width: 100%; min-width: 0; min-height: 132px; border: 0; border-radius: 22px; padding: 18px; background: transparent; color: inherit; text-align: left; cursor: pointer; display: grid; align-content: space-between; gap: 12px; }
    .hub-folder-card-main:focus-visible { outline: 2px solid rgba(139,211,255,0.74); outline-offset: -4px; }
    .hub-folder-card.expanded > .hub-folder-card-main { min-height: 104px; }
    .hub-folder-children { display: grid; gap: 12px; padding: 0 14px 14px; }
    .hub-folder-children-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 13px 4px 0; border-top: 1px solid rgba(148,163,184,0.16); color: var(--muted); font-size: 12px; font-weight: 850; }
    .hub-folder-children-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 12px; }
    .hub-folder-children .hub-folder-card { min-height: 112px; box-shadow: none; }
    .hub-folder-children .hub-folder-card-main { min-height: 112px; padding: 14px; border-radius: 18px; }
    .hub-folder-card strong { display: block; min-width: 0; font-size: 20px; line-height: 1.05; letter-spacing: 0; overflow-wrap: anywhere; }
    .hub-folder-card span { min-width: 0; color: var(--muted); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
    .hub-folder-card code { min-width: 0; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.25; overflow-wrap: anywhere; white-space: normal; }
    .hub-folder-meta { min-width: 0; display: flex; justify-content: space-between; gap: 10px; align-items: end; color: #cbd7ec; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .hub-folder-meta code { flex: 1 1 auto; }
    .hub-folder-meta span { flex: 0 0 auto; text-align: right; white-space: nowrap; }
    .startup-context-panel { display: grid; gap: 10px; padding-top: 18px; border-top: 1px solid rgba(139,211,255,0.24); }
    .startup-context-copy { color: var(--muted); font-size: 13px; line-height: 1.4; }
    .startup-context-list { display: grid; gap: 8px; }
    .startup-context-item { min-width: 0; border: 1px solid rgba(148,163,184,0.16); border-radius: 14px; padding: 12px 14px; background: rgba(255,255,255,0.04); color: var(--text); cursor: pointer; text-align: left; display: grid; grid-template-columns: minmax(120px, 0.28fr) minmax(0, 1fr); gap: 12px; align-items: center; }
    .startup-context-item:hover { transform: translateY(-1px); border-color: rgba(139,211,255,0.42); background: rgba(139,211,255,0.09); }
    .startup-context-item strong { min-width: 0; font-size: 13px; line-height: 1.25; overflow-wrap: anywhere; }
    .startup-context-item span { min-width: 0; color: var(--muted); font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .selection-bar { margin: 6px 0 8px; padding: 5px 6px 5px 10px; border: 1px solid rgba(139,211,255,0.18); border-radius: 999px; background: rgba(8,13,27,0.72); display: flex; gap: 8px; align-items: center; justify-content: space-between; box-shadow: 0 10px 28px rgba(0,0,0,0.18); }
    .selection-bar[hidden] { display: none; }
    .selection-summary { min-width: 0; color: #dce8fb; font-size: 11px; font-weight: 850; letter-spacing: 0.02em; white-space: nowrap; }
    .selection-actions { display: flex; gap: 4px; align-items: center; }
    .selection-action { width: 28px; height: 28px; padding: 0; border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; background: rgba(255,255,255,0.045); color: var(--muted); font-size: 13px; line-height: 1; cursor: pointer; display: grid; place-items: center; }
    .selection-action:hover { color: var(--text); background: rgba(139,211,255,0.10); transform: translateY(-1px); }
    .selection-action.danger-action { border-color: rgba(255,140,157,0.24) !important; color: #ffb5c0 !important; }
    .tree-entry { display: flex; align-items: stretch; gap: 5px; }
    .tree-entry .tree-row { flex: 1; }
    .tree-entry.selected .tree-row { border-color: rgba(139,211,255,0.34); background: rgba(139,211,255,0.085); box-shadow: inset 2px 0 0 rgba(139,211,255,0.48); }
    .tree-entry.selected .tree-row::after { content: "✓"; margin-left: auto; color: var(--accent); font-size: 10px; line-height: 1; flex: 0 0 auto; }
    .tree-entry.watched .tree-name { color: var(--good); font-weight: 850; }
    .tree-entry.watched-inherited .tree-name { color: #bff5d0; }

    .danger-action { border-color: rgba(255,140,157,0.38) !important; color: #ffc0c8 !important; }
    @media (max-width: 860px) { .settings-card { position: static; width: 100%; max-height: none; margin-bottom: 12px; } }
    .cosmos-home { height: 100%; min-height: calc(100vh - 168px); padding: 34px; overflow: hidden; background: radial-gradient(circle at 50% 38%, rgba(139,211,255,0.13), transparent 24rem), rgba(3, 7, 18, 0.36); transition: padding-right 320ms ease; }
    .editor-shell.planet-file-open .cosmos-home { padding-right: min(46vw, 660px); }
    .planet-stage { position: relative; height: 100%; min-height: calc(100vh - 236px); border-radius: 28px; overflow: hidden; display: grid; place-items: center; background: radial-gradient(circle at 50% 50%, rgba(182,156,255,0.10), transparent 22rem); }
    .planet-stage::before, .planet-stage::after { content: ""; position: absolute; border: 1px solid rgba(139,211,255,0.13); border-radius: 50%; pointer-events: none; }
    .planet-stage::before { width: min(72vw, 920px); height: min(72vw, 920px); animation: orbitSpin 46s linear infinite; }
    .planet-stage::after { width: min(46vw, 620px); height: min(46vw, 620px); border-color: rgba(182,156,255,0.16); animation: orbitSpin 34s linear reverse infinite; }
    .planet-system { position: relative; z-index: 1; width: min(980px, 100%); min-height: 560px; }
    .planet-field { position: absolute; inset: 0; display: grid; place-items: center; }
    .planet { border: 0; border-radius: 999px; color: white; cursor: pointer; position: absolute; display: grid; place-items: center; text-align: center; padding: 0; isolation: isolate; transform: translate(-50%, -50%); transition: transform 420ms cubic-bezier(.2,.9,.2,1), filter 220ms ease, box-shadow 220ms ease; }
    .planet::before { content: ""; position: absolute; inset: 0; border-radius: inherit; background: radial-gradient(circle at 30% 24%, rgba(255,255,255,0.96), rgba(255,255,255,0.12) 18%, transparent 19%), radial-gradient(circle at 36% 34%, var(--planet-a), var(--planet-b) 42%, var(--planet-c) 68%, #0a1025 100%); box-shadow: inset -28px -36px 55px rgba(0,0,0,0.44), inset 18px 16px 34px rgba(255,255,255,0.14), 0 0 80px var(--glow); z-index: -2; }
    .planet::after { content: ""; position: absolute; inset: -12%; border-radius: inherit; background: radial-gradient(circle, var(--glow), transparent 65%); opacity: 0.42; filter: blur(18px); z-index: -3; }
    .planet:hover { transform: translate(-50%, -50%) scale(1.06); filter: brightness(1.12); }
    .planet.root { width: clamp(190px, 22vw, 300px); height: clamp(190px, 22vw, 300px); animation: planetFloat 6s ease-in-out infinite alternate; }
    .planet.root.hermes { left: 24%; top: 52%; --planet-a: #95d9ff; --planet-b: #4c8dff; --planet-c: #35217b; --glow: rgba(101,174,255,0.52); }
    .planet.root.life { left: 50%; top: 36%; --planet-a: #b6ffc9; --planet-b: #49c996; --planet-c: #164a7a; --glow: rgba(141,240,180,0.42); animation-delay: -1.7s; }
    .planet.root.explorer { left: 76%; top: 56%; --planet-a: #e8d3ff; --planet-b: #9d73ff; --planet-c: #39205d; --glow: rgba(182,156,255,0.50); animation-delay: -3.2s; }
    .planet.main { left: 50%; top: 47%; width: clamp(240px, 28vw, 390px); height: clamp(240px, 28vw, 390px); animation: planetZoom 520ms cubic-bezier(.2,.9,.2,1), planetFloat 7s ease-in-out infinite alternate; }
    .planet.main.hermes { --planet-a: #95d9ff; --planet-b: #4c8dff; --planet-c: #35217b; --glow: rgba(101,174,255,0.52); }
    .planet.main.life { --planet-a: #b6ffc9; --planet-b: #49c996; --planet-c: #164a7a; --glow: rgba(141,240,180,0.42); }
    .planet.main.explorer { --planet-a: #e8d3ff; --planet-b: #9d73ff; --planet-c: #39205d; --glow: rgba(182,156,255,0.50); }
    .planet.satellite { width: 128px; height: 128px; --planet-a: #ffffff; --planet-b: #8bd3ff; --planet-c: #25315f; --glow: rgba(139,211,255,0.28); animation: satelliteIn 520ms cubic-bezier(.2,.9,.2,1) both, planetFloat 5.5s ease-in-out infinite alternate; }
    .planet.satellite:nth-child(2n) { --planet-b: #b69cff; --planet-c: #3a2462; animation-delay: 80ms; }
    .planet.satellite:nth-child(3n) { --planet-b: #8df0b4; --planet-c: #174663; animation-delay: 140ms; }
    .planet.satellite.folder { width: 158px; height: 158px; }
    .planet.satellite.file { width: 116px; height: 116px; --planet-b: #ffd48f; --planet-c: #493057; --glow: rgba(255,212,143,0.26); }
    .planet-label { position: relative; z-index: 2; width: 78%; font-weight: 950; letter-spacing: -0.04em; line-height: 0.98; text-shadow: 0 3px 18px rgba(0,0,0,0.62); }
    .planet.root .planet-label, .planet.main .planet-label { font-size: clamp(26px, 4vw, 58px); }
    .planet.satellite .planet-label { font-size: 14px; letter-spacing: -0.02em; }
    .planet-path { display: block; margin-top: 6px; color: rgba(236,245,255,0.74); font: 10px/1.15 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .planet-back { position: absolute; z-index: 3; left: 18px; top: 18px; }
    .planet-breadcrumb { position: absolute; z-index: 3; left: 18px; bottom: 18px; max-width: 52%; color: rgba(226,236,255,0.72); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .editor-shell.planet-file-open .viewer, .editor-shell.planet-file-open textarea { position: absolute; z-index: 6; top: 18px; right: 18px; bottom: 18px; width: min(43vw, 620px); height: auto; min-height: 0; border: 1px solid rgba(148,163,184,0.22); border-radius: 28px; box-shadow: -30px 0 90px rgba(0,0,0,0.34); background: rgba(5, 10, 24, 0.92); backdrop-filter: blur(22px); }
    @keyframes planetFloat { from { translate: 0 -8px; } to { translate: 0 12px; } }
    @keyframes planetZoom { from { transform: translate(-50%, -50%) scale(0.35); opacity: 0; } to { transform: translate(-50%, -50%) scale(1); opacity: 1; } }
    @keyframes satelliteIn { from { opacity: 0; transform: translate(-50%, -50%) scale(0.25); } to { opacity: 1; transform: translate(-50%, -50%) scale(1); } }
    textarea, .viewer { width: 100%; height: 100%; min-height: calc(100vh - 48px); border: 0; outline: none; padding: 34px; background: rgba(3, 7, 18, 0.42); color: var(--text); font: 18px/1.72 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    textarea { resize: none; display: none; }
    .viewer { white-space: pre-wrap; overflow: auto; }
    .review-workspace { display: grid; grid-template-columns: minmax(320px, 0.92fr) minmax(420px, 1.08fr); gap: 18px; min-height: 100%; }
    .review-workspace.no-diff { grid-template-columns: 1fr; }
    .diff-panel, .file-panel { border: 1px solid rgba(148,163,184,0.16); border-radius: 22px; background: rgba(8,13,27,0.72); overflow: hidden; min-width: 0; }
    .diff-header, .file-panel header { padding: 15px 17px; border-bottom: 1px solid rgba(148,163,184,0.14); display: flex; justify-content: space-between; gap: 10px; align-items: center; color: #e8f1ff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .diff-header strong, .file-panel strong { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; }
    .diff-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .diff-code, .doc-content, .doc-editor { margin: 0; padding: 18px; white-space: pre-wrap; overflow: auto; max-height: calc(100vh - 162px); font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .doc-content { font-size: 15px; line-height: 1.7; }
    .doc-editor { display: block; width: 100%; min-height: calc(100vh - 162px); border: 0; border-radius: 0; resize: none; background: rgba(3,7,18,0.16); color: var(--text); outline: none; font-size: 15px; line-height: 1.7; }
    .diff-line { display: block; padding: 1px 8px; border-radius: 6px; }
    .diff-line.add { color: #b9ffd0; background: rgba(141,240,180,0.08); }
    .diff-line.del { color: #ffc0c8; background: rgba(255,140,157,0.08); }
    .diff-line.hunk { color: #b69cff; background: rgba(182,156,255,0.08); }
    .diff-line.meta { color: var(--muted); }
    .diff-raw-meta { margin: 2px 18px 0; color: rgba(148,163,184,0.55); font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .diff-raw-meta summary { cursor: pointer; width: fit-content; list-style: none; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 9px; font-weight: 750; color: rgba(148,163,184,0.42); }
    .diff-raw-meta summary::-webkit-details-marker { display: none; }
    .diff-raw-meta pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.025); white-space: pre-wrap; }
    .diff-empty { padding: 18px; color: var(--muted); font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    .conflict-panel { position: sticky; top: 0; z-index: 8; margin: 14px; border: 1px solid rgba(255,196,107,0.54); border-radius: 16px; background: linear-gradient(135deg, rgba(255,196,107,0.18), rgba(255,140,157,0.12)); box-shadow: 0 14px 44px rgba(0,0,0,0.24); padding: 14px; display: grid; gap: 12px; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #f7efe1; }
    .external-review-actions { align-items: center; flex-wrap: nowrap; }
    .external-choice { min-height: 24px; padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 900; letter-spacing: 0; box-shadow: 0 6px 18px rgba(0,0,0,0.22); }
    .external-choice.icon { width: 25px; min-height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .external-change-stats { display: flex; gap: 6px; flex-wrap: wrap; color: rgba(226,236,255,0.82); font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .external-change-stats span { border: 1px solid rgba(148,163,184,0.16); border-radius: 999px; padding: 3px 7px; background: rgba(2,6,23,0.24); }
    .external-change-stats .add { color: #9cffbc; border-color: rgba(93,244,143,0.28); }
    .external-change-stats .del { color: #ffb2bf; border-color: rgba(255,140,157,0.32); }
    .external-change-stats .pending { color: #dbeafe; border-color: rgba(125,211,252,0.28); }
    .external-review-doc { white-space: normal; background: rgba(3,7,18,0.16); }
    .external-review-block { position: relative; min-width: 0; }
    .external-review-block.change { display: block; position: relative; margin: 6px 0; padding: 2px 34px 2px 0; border-left: 2px solid rgba(125,211,252,0.46); border-radius: 0 10px 10px 0; background: linear-gradient(90deg, rgba(125,211,252,0.06), rgba(125,211,252,0.018) 72%, transparent); }
    .external-review-block.resolved { color: rgba(226,236,255,0.86); margin: 4px 0; padding: 2px 78px 2px 0; border-left: 2px solid rgba(148,163,184,0.22); border-radius: 0 10px 10px 0; background: rgba(148,163,184,0.035); transition: min-height 180ms ease, background 220ms ease; }
    .external-review-block.resolved.settling { overflow: hidden; transition: height 2s ease, min-height 2s ease, margin 2s ease, padding 2s ease, border-width 2s ease, background 220ms ease, border-color 220ms ease; }
    .external-review-block.resolved.accept { border-left-color: rgba(93,244,143,0.46); background: rgba(48,215,111,0.06); }
    .external-review-block.resolved.reject { border-left-color: rgba(255,140,157,0.42); background: rgba(255,86,117,0.055); }
    .external-review-resolved-label { position: absolute; top: 5px; right: 7px; z-index: 1; border: 1px solid rgba(148,163,184,0.16); border-radius: 999px; padding: 2px 7px; background: rgba(8,13,27,0.78); color: rgba(226,236,255,0.72); font: 9px/1.35 Inter, ui-sans-serif, system-ui, sans-serif; font-weight: 900; text-transform: uppercase; letter-spacing: 0.08em; }
    .external-review-block.resolved.accept .external-review-resolved-label { color: #b9ffd0; border-color: rgba(93,244,143,0.28); }
    .external-review-block.resolved.reject .external-review-resolved-label { color: #ffc0c8; border-color: rgba(255,140,157,0.30); }
    .external-review-placeholder { min-height: 24px; display: flex; align-items: center; padding: 2px 8px; color: rgba(226,236,255,0.62); font: 11px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; font-weight: 800; }
    .external-review-doc.settled .external-review-block.resolved { margin: 0; padding: 0; border-left-color: transparent; background: transparent; }
    .external-review-doc.settled .external-review-block.resolved.accept, .external-review-doc.settled .external-review-block.resolved.reject { background: transparent; }
    .external-review-doc.settled .external-review-resolved-label, .external-review-doc.settled .external-review-placeholder { display: none; }
    .external-review-doc.settled .external-review-block.resolved.empty { min-height: 0; height: 0; border: 0; overflow: hidden; }
    .external-review-lines { display: grid; gap: 1px; min-width: 0; }
    .external-review-block-controls { position: absolute; top: 4px; right: 4px; z-index: 2; display: flex; gap: 4px; align-items: center; padding: 2px; border: 1px solid rgba(148,163,184,0.14); border-radius: 999px; background: rgba(8,13,27,0.86); opacity: 0.66; transition: opacity 140ms ease, transform 140ms ease, border-color 140ms ease; }
    .external-review-block.change:hover .external-review-block-controls, .external-review-block.change:focus-within .external-review-block-controls { opacity: 1; border-color: rgba(139,211,255,0.26); transform: translateY(-1px); }
    .external-review-line { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; padding: 1px 8px; border-radius: 5px; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.58; }
    .external-review-line .marker { color: rgba(226,236,255,0.58); user-select: none; }
    .external-review-line.add { color: #d6ffe0; background: rgba(48,215,111,0.12); }
    .external-review-line.add .marker { color: #8df0b4; }
    .external-review-line.del { color: #ffd5dc; background: rgba(255,86,117,0.12); }
    .external-review-line.del .marker { color: #ff9cac; }
    .external-review-line.ctx { color: rgba(226,236,255,0.86); }
    .external-review-block.resolved.empty { min-height: 32px; overflow: hidden; }
    .conflict-panel strong { font-size: 15px; letter-spacing: 0; text-transform: none; }
    .conflict-panel p { margin: 0; color: #d9c9a8; font-size: 13px; line-height: 1.45; }
    .conflict-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .conflict-compare { display: grid; gap: 12px; min-width: 0; }
    .conflict-card { min-width: 0; border: 1px solid rgba(148,163,184,0.16); border-radius: 14px; background: rgba(3,7,18,0.34); overflow: hidden; }
    .conflict-card-head { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 8px 10px; border-bottom: 1px solid rgba(148,163,184,0.12); color: var(--muted); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.08em; }
    .conflict-card-head small { color: rgba(226,236,255,0.58); font-size: 10px; font-weight: 800; letter-spacing: 0.04em; text-transform: none; }
    .conflict-card-head .diff-line { display: inline; padding: 1px 5px; border-radius: 999px; }
    .conflict-diff { max-height: min(42vh, 440px); overflow: auto; padding: 10px; font: 12px/1.46 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .conflict-diff-line { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 8px; padding: 2px 8px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .conflict-diff-line .marker { color: rgba(226,236,255,0.56); user-select: none; }
    .conflict-diff-line.add { color: #ccffd9; background: rgba(48, 215, 111, 0.18); border-left: 3px solid rgba(93, 244, 143, 0.78); }
    .conflict-diff-line.add .marker { color: #8df0b4; }
    .conflict-diff-line.del { color: #ffd0d8; background: rgba(255, 86, 117, 0.18); border-left: 3px solid rgba(255, 140, 157, 0.78); }
    .conflict-diff-line.del .marker { color: #ff9cac; }
    .conflict-diff-line.ctx { color: rgba(226,236,255,0.82); border-left: 3px solid transparent; }
    .conflict-diff-line.skip { color: rgba(148,163,184,0.72); background: rgba(148,163,184,0.07); border-left: 3px solid transparent; font-style: italic; }
    .conflict-diff-line.skip .marker { color: rgba(148,163,184,0.62); }
    .conflict-merge { display: grid; gap: 10px; padding: 10px; }
    .conflict-merge textarea { display: block; width: 100%; min-height: min(42vh, 430px); resize: vertical; border: 1px solid rgba(148,163,184,0.18); border-radius: 12px; background: rgba(2,6,23,0.56); color: var(--text); outline: none; padding: 12px; font: 12px/1.48 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .conflict-merge-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    @media (max-width: 760px) { .external-review-actions { flex-wrap: wrap; justify-content: flex-start; } .external-review-block.change { padding-right: 0; } .external-review-block-controls { position: static; width: fit-content; margin: 4px 0 2px 8px; opacity: 1; } .external-review-line { grid-template-columns: 22px minmax(0, 1fr); } }
    .file-header-copy { min-width: 0; display: grid; gap: 5px; }
    .file-header-copy .diff-meta { white-space: normal; line-height: 1.35; }
    .file-actions { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
    .file-action { border: 1px solid rgba(148,163,184,0.18); border-radius: 12px; padding: 9px 12px; background: rgba(255,255,255,0.06); color: var(--text); font-weight: 850; cursor: pointer; }
    .file-action:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .file-action.primary { color: #07101e; border: 0; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .confirm-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: 18px; background: rgba(2,6,23,0.72); backdrop-filter: blur(14px); }
    .confirm-dialog { width: min(420px, 100%); border: 1px solid rgba(148,163,184,0.24); border-radius: 18px; background: rgba(8,13,27,0.96); box-shadow: 0 22px 80px rgba(0,0,0,0.45); padding: 18px; color: var(--text); }
    .confirm-dialog strong { display: block; font-size: 18px; line-height: 1.2; margin-bottom: 8px; }
    .confirm-dialog p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 18px; }
    .diff-toggle { border: 1px solid rgba(139,211,255,0.24); border-radius: 14px; padding: 10px 13px; margin-bottom: 10px; background: rgba(139,211,255,0.08); color: var(--text); font-weight: 850; cursor: pointer; }
    .diff-toggle:hover { transform: translateY(-1px); background: rgba(139,211,255,0.14); }
    @media (max-width: 1280px) { .review-workspace { grid-template-columns: 1fr; } .diff-code, .doc-content { max-height: none; } }
    .viewer a.path-link { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(139,211,255,0.35); cursor: pointer; }
    .viewer a.path-link:hover { color: #ffffff; border-bottom-color: #ffffff; }
    .mode-toggle { display: flex; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
    .mode-toggle button { border: 0; background: transparent; color: var(--muted); padding: 11px 13px; font-weight: 850; cursor: pointer; }
    .mode-toggle button.active { color: #07101e; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .cards { display: none; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 18px 0; }
    .card { padding: 12px; border-radius: 16px; border: 1px solid var(--line); background: rgba(255,255,255,0.045); }
    .card strong { display: block; font-size: 18px; margin-bottom: 3px; }
    .card span { color: var(--muted); font-size: 12px; }
    .hint { display: none; margin-top: 16px; color: var(--muted); font-size: 13px; line-height: 1.45; }
    @keyframes starDrift { from { transform: translate3d(0,0,0); } to { transform: translate3d(-86px, -86px, 0); } }
    @keyframes nebulaPulse { from { opacity: 0.65; transform: scale(1); } to { opacity: 1; transform: scale(1.04); } }
    @keyframes orbitSpin { to { transform: rotate(352deg); } }
    @keyframes orbFloat { from { transform: translateY(0); } to { transform: translateY(12px); } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
    @media (max-width: 980px) {
      body { overflow: hidden; }
      .app, .app.sidebar-collapsed { grid-template-columns: 1fr; height: 100dvh; overflow: hidden; padding-top: 58px; }
      aside { position: fixed; z-index: 30; top: 0; left: 0; right: 0; height: min(62dvh, 560px); max-height: min(62dvh, 560px); border-right: 0; border-bottom: 1px solid var(--line); padding: 10px; overflow: auto; box-shadow: 0 18px 60px rgba(0,0,0,0.42); }
      .app.sidebar-collapsed aside { height: 58px; max-height: 58px; padding: 8px 10px; overflow: hidden; }
      .app.sidebar-collapsed .sidebar-toggle { position: absolute; left: auto; right: 10px; top: 8px; z-index: 31; width: 40px; height: 40px; }
      .app.sidebar-collapsed .sidebar-copy, .app.sidebar-collapsed .search-row, .app.sidebar-collapsed .watch-filter-row, .app.sidebar-collapsed .selection-bar, .app.sidebar-collapsed .explorer-title, .app.sidebar-collapsed .tree, .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateY(-8px); }
      .app.sidebar-collapsed .workspace-dock { opacity: 1; pointer-events: auto; transform: none; width: calc(100% - 50px); margin: 0; padding: 5px; overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
      .app.sidebar-collapsed .workspace-dock::-webkit-scrollbar { display: none; }
      .workspace-dock { margin-right: 50px; }
      .app:not(.sidebar-collapsed) .workspace-dock { margin-right: 0; }
      .dock-button { padding: 8px 10px; white-space: nowrap; }
      .sidebar-head { position: absolute; right: 10px; top: 8px; display: block; }
      .app:not(.sidebar-collapsed) .sidebar-head { position: static; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 2px 8px; }
      .sidebar-copy { padding-right: 52px; }
      .app:not(.sidebar-collapsed) .sidebar-copy { padding-right: 0; flex: 1 1 auto; min-width: 0; }
      .sidebar-toggle { width: 40px; height: 40px; }
      main { height: calc(100dvh - 58px); padding: 10px; overflow: hidden; }
      .editor-shell { height: 100%; min-height: 0; border-radius: 18px; }
      .docqa-home, .settings-page { height: 100%; padding: 12px; overflow: auto; }
      .docqa-panel { border-radius: 18px; }
      .docqa-panel header { padding: 14px; align-items: flex-start; flex-direction: column; }
      .review-summary { width: 100%; }
      .review-summary-item { flex: 1; min-width: 0; }
      .review-list { max-height: none; }
      .review-item { padding: 11px; }
      .review-top { align-items: flex-start; }
      .settings-grid, .hub-card-editor-grid, .template-editor-grid, .markdown-create { grid-template-columns: 1fr; }
      .markdown-create .settings-field.paths, .path-picker-field, .path-picker-preview, .new-doc-actions { grid-column: 1; }
      .path-picker { grid-template-columns: 1fr; }
      .path-picker-menu { left: 8px; right: 8px; width: auto; }
      .hub-folders { gap: 18px; }
      .hub-folder-card { min-height: 116px; border-radius: 18px; }
      .hub-folder-card-main { min-height: 116px; padding: 15px; border-radius: 18px; }
      .hub-folder-children { padding: 0 12px 12px; }
      .hub-folder-card strong { font-size: 18px; }
      .startup-context-item { grid-template-columns: 1fr; gap: 5px; }
      textarea, .viewer { min-height: 100%; padding: 16px; font-size: 14px; line-height: 1.58; }
      .review-workspace { grid-template-columns: 1fr; gap: 12px; }
      .diff-code, .doc-content, .doc-editor { max-height: none; padding: 12px; font-size: 12px; }
      .diff-header, .file-panel header { padding: 12px; align-items: flex-start; }
      .file-actions { gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
      .conflict-compare { grid-template-columns: 1fr; }
      .file-action { padding: 8px 10px; }
      .planet-system { min-height: 620px; }
      .cosmos-home { min-height: 100%; padding: 16px; overflow: auto; }
      .planet-stage { min-height: 560px; }
      .planet.root.hermes { left: 50%; top: 20%; }
      .planet.root.life { left: 50%; top: 50%; }
      .planet.root.explorer { left: 50%; top: 80%; }
      .editor-shell.planet-file-open .cosmos-home { padding-right: 16px; }
      .editor-shell.planet-file-open .viewer, .editor-shell.planet-file-open textarea { position: static; width: 100%; height: 100%; min-height: 100%; border-radius: 18px; box-shadow: none; }
    }
    @media (max-width: 640px) {
      body { overflow: hidden; }
      .app, .app.sidebar-collapsed { grid-template-columns: 1fr; grid-template-rows: 1fr; height: 100dvh; padding: 54px 0 0; overflow: hidden; }
      .explorer-open { display: inline-flex; position: fixed; top: 8px; right: 8px; z-index: 35; width: 38px; height: 38px; border-radius: 12px; }
      .app.explorer-expanded .explorer-open { display: none; }
      .workspace-dock, .app.sidebar-collapsed .workspace-dock { position: fixed; top: 0; left: 0; right: 0; z-index: 33; width: 100%; height: 54px; margin: 0; padding: 7px 52px 7px 8px; gap: 5px; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: rgba(8,13,27,0.94); backdrop-filter: blur(18px); box-shadow: 0 8px 24px rgba(0,0,0,0.32); flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; opacity: 1; pointer-events: auto; transform: none; }
      .app.sidebar-collapsed .workspace-dock { width: 100%; padding: 7px 52px 7px 8px; margin: 0; opacity: 1; }
      .app.explorer-expanded .workspace-dock { display: none; }
      .workspace-dock::-webkit-scrollbar { display: none; }
      .workspace-dock .dock-button { padding: 8px 11px; white-space: nowrap; flex: 0 0 auto; }
      .workspace-dock .dock-status { display: none; }
      aside { position: fixed; left: 0; right: 0; bottom: 0; top: auto; width: 100%; height: auto; max-height: 0; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 22px 22px 0 0; background: rgba(6,10,22,0.985); backdrop-filter: none; box-shadow: 0 -20px 70px rgba(0,0,0,0.55); overflow: auto; overscroll-behavior: contain; transition: transform 280ms cubic-bezier(.2,.9,.2,1), max-height 280ms ease, padding 280ms ease; transform: translateY(100%); pointer-events: none; }
      .app.explorer-expanded aside { height: min(66dvh, 560px) !important; max-height: min(66dvh, 560px) !important; padding: 0 12px 14px !important; border-top: 1px solid var(--line) !important; transform: translateY(0) !important; pointer-events: auto !important; }
      .app.sidebar-collapsed aside { height: auto; max-height: 0; padding: 0; border: 0; transform: translateY(100%); pointer-events: none; }
      .sidebar-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 2px 10px; background: rgba(6,10,22,0.98); border-bottom: 1px solid rgba(148,163,184,0.16); }
      .sidebar-copy { padding-right: 0; flex: 1 1 auto; min-width: 0; }
      .sidebar-copy h1 { font-size: 15px; margin: 0; }
      .sidebar-copy .subtitle { font-size: 11px; }
      .sidebar-toggle { position: static; width: 38px; height: 38px; flex: 0 0 auto; }
      .search-row { margin: 10px 0 8px; }
      .search { margin: 0; padding: 11px 12px; font-size: 15px; }
      .clear-search { padding: 11px 12px; }
      .watch-filter-row { margin: 0 0 8px; }
      .explorer-title { margin: 8px 0 4px; }
      .tree { font-size: 13px; padding-right: 2px; }
      .hint { font-size: 11px; line-height: 1.4; padding: 8px 0 2px; }
      main { height: calc(100dvh - 54px); padding: 10px; overflow: hidden; }
      .editor-shell { height: 100%; min-height: 0; border-radius: 16px; }
      .docqa-home, .settings-page { padding: 12px 10px; }
      .docqa-panel { border-radius: 16px; }
      .docqa-panel header { padding: 12px; }
      .review-summary-item { min-width: 0; }
      .review-item { padding: 10px; }
      .hub-folders { gap: 14px; margin-top: 12px; }
      .hub-folder-card { min-height: 104px; border-radius: 16px; }
      .hub-folder-card-main { min-height: 104px; padding: 14px; border-radius: 16px; }
      .hub-folder-children { padding: 0 10px 10px; gap: 10px; }
      .hub-folder-children-grid { gap: 10px; }
      .hub-folder-card strong { font-size: 17px; }
      .hub-folder-card span { font-size: 12px; }
      .hub-breadcrumb { padding: 8px 10px; font-size: 11px; gap: 5px; }
      .hub-crumb { padding: 6px 9px; font-size: 11px; }
      textarea, .viewer { min-height: 100%; padding: 14px; font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
      .diff-code, .doc-content, .doc-editor { padding: 10px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .diff-header, .file-panel header { padding: 10px 12px; }
      .file-actions { gap: 6px; }
      .file-action { padding: 8px 10px; font-size: 13px; }
      .selected-title { font-size: 18px; }
      .selected-path, .selected-impact { font-size: 12px; }
      .selected-impact { margin-top: 8px; }
      .actions { gap: 8px; }
      button.primary, button.secondary { padding: 10px 13px; font-size: 13px; }
      .history-nav button { min-width: 38px; padding: 8px 10px; }
      .mode-toggle button { padding: 9px 11px; font-size: 13px; }
      .diff-toggle { padding: 9px 11px; margin-bottom: 8px; }
      .settings-field textarea, .settings-field input { font-size: 12px; }
      .settings-footer { flex-direction: column; align-items: flex-start; gap: 8px; }
      .planet-system { min-height: 560px; }
      .cosmos-home { padding: 12px; }
      .planet-stage { min-height: 520px; }
      .editor-shell.planet-file-open .cosmos-home { padding-right: 12px; }
      .editor-shell.planet-file-open .viewer, .editor-shell.planet-file-open textarea { position: static; width: 100%; height: 100%; min-height: 100%; border-radius: 16px; box-shadow: none; }
    }
  </style>
</head>
<body>
  <div class="app">
    <button id="explorerOpen" class="explorer-open" type="button" title="Open explorer" aria-label="Open explorer">☰</button>
    <aside>
      <div class="workspace-dock">
        <button id="hub" class="dock-button" type="button" title="Hub / settings">hub</button>
        <button id="back" class="dock-button" type="button" title="Previous file">←</button>
        <button id="forward" class="dock-button" type="button" title="Next file">→</button>
        <button id="reload" class="dock-button" type="button" hidden>reload</button>
        <button id="verifyCurrent" class="dock-button" type="button" hidden>verified</button>
        <button id="deleteCurrent" class="dock-button danger-action" type="button" hidden>delete</button>
        <button id="save" class="dock-button primary" hidden disabled>save</button>
        <div id="status" class="dock-status" aria-live="polite">ready</div>
      </div>
      <div class="sidebar-head">
        <div class="sidebar-copy">
          <h1>Explorer</h1>
          <div class="subtitle">Allowed files and folders.</div>
        </div>
        <button id="sidebarToggle" class="sidebar-toggle" type="button" title="hide/show sidebar">☰</button>
      </div>
      <div class="search-row">
        <input id="search" class="search" placeholder="search explorer..." />
        <button id="clearSearch" class="clear-search" type="button" title="show full explorer">all</button>
      </div>
      <div class="watch-filter-row" aria-label="Explorer watch filter"><button id="watchFilterAll" class="watch-filter active" type="button" data-watch-filter="all">all</button><button id="watchFilterWatched" class="watch-filter" type="button" data-watch-filter="watched">watched</button><button id="watchFilterUnwatched" class="watch-filter" type="button" data-watch-filter="unwatched">unwatched</button></div>
      <div id="selectionBar" class="selection-bar" hidden><span id="selectionCount" class="selection-summary">0 selected</span><div class="selection-actions"><button id="watchSelected" class="selection-action" type="button" title="Add selected to watch">👁+</button><button id="unwatchSelected" class="selection-action" type="button" title="Remove selected from watch">👁−</button><button id="clearSelection" class="selection-action" type="button" title="clear selection">×</button><button id="deleteSelected" class="selection-action danger-action" type="button" title="delete selection">⌫</button></div></div>
      <div class="explorer-title">explorer</div>
      <div id="files" class="tree"></div>
      <div class="hint">Every save creates a copy in <code>.context-room/memory-webapp-backups/</code>. Secrets, credentials, and out-of-scope files are blocked.</div>
    </aside>
    <main>
      <section class="topbar" aria-hidden="true">
        <div id="title" class="selected-title">Loading...</div>
        <div id="path" class="selected-path"></div>
        <div id="impact" class="selected-impact"></div>
        <div id="meta" class="selected-path"></div>
      </section>
      <section class="editor-shell">
        <div id="home" class="docqa-home" hidden>
          <div class="docqa-grid">
            <section class="docqa-panel">
              <header>
                <div>
                  <h2>Changed files to review</h2>
                  <div class="muted">watched files changed or created in this Git worktree</div>
                </div>
                <div id="reviewSummary" class="review-summary" aria-label="review metrics"></div>
              </header>
              <div id="reviewQueue" class="review-list"></div>
            </section>
            <section class="docqa-panel markdown-panel">
              <header>
                <div>
                  <h2>Docs best practices</h2>
                  <div class="muted">create scoped Markdown files from lightweight templates</div>
                </div>
              </header>
              <div id="markdownTools" class="markdown-tools"></div>
            </section>
            <section class="docqa-panel">
              <header>
                <div>
                  <h2>Context health</h2>
                  <div class="muted">metadata, graph, links, startup context, and config checks</div>
                </div>
              </header>
              <div id="contextHealth" class="markdown-tools"></div>
            </section>
          </div>
          <div id="hubFolders" class="hub-folders"></div>
        </div>
        <div id="settingsPage" class="settings-page" hidden>
          <section id="settingsCard" class="docqa-panel settings-card">
            <header>
              <div>
                <h2>Settings</h2>
                <div class="muted">watch scope, sections, and hub cards</div>
              </div>
            </header>
            <div id="settingsPanel" class="settings-panel"></div>
          </section>
        </div>
        <div id="newDocPage" class="settings-page" hidden>
          <section class="docqa-panel settings-card">
            <header>
              <div>
                <h2>New document</h2>
                <div class="muted">choose the template and metadata before the file is created</div>
              </div>
            </header>
            <div id="newDocPanel" class="settings-panel"></div>
          </section>
        </div>
        <div id="viewer" class="viewer"></div>
        <textarea id="editor" spellcheck="false"></textarea>
      </section>
    </main>
  </div>
  <div id="explorerContextMenu" class="explorer-context-menu" hidden></div>
<script>
const state = { files: [], startupContextFiles: [], selectedStartupContext: null, docqa: null, doctor: null, settings: null, settingsOpen: false, page: "hub", pendingMarkdown: null, availableHubCards: [], hubFolders: [], hubSections: [], rootHubSections: [], activeHubCardId: null, selectedReview: null, selected: null, selectedDiff: null, fileConflict: null, externalChange: null, conflictCompare: false, conflictMergeText: null, conflictMergeKey: "", conflictMergeMode: "auto", conflictCheckTimer: null, diffCollapsed: false, saved: "", savedHash: null, dirty: false, mode: "view", homeView: "root", planetStack: ["root"], filePanel: false, history: [], historyIndex: -1, pathFilters: [], explorerWatchFilter: "all", selectedForDelete: new Set(), selectionRequest: 0, mobileSidebarTouched: false, expanded: new Set(["data", "automations", "integrations", "skills", "tools", "~", "~/.hermes", "~/.hermes/memories", "~/.hermes/skills"]) };
const MAIN_FILE_PATHS = new Set([
  "~/.hermes/memories/USER.md",
  "~/.hermes/memories/MEMORY.md",
  ".hermes.md",
  "memory/USER.md",
  "memory/MEMORY.md",
]);
const PLANET_GROUPS = {
  hermes: {
    title: "Injected",
    className: "hermes",
    files: [".hermes.md", "~/.hermes/memories/USER.md", "~/.hermes/memories/MEMORY.md"],
  },
  lifeos: {
    title: "Main",
    className: "life",
    files: ["memory/USER.md", "memory/MEMORY.md", ".hermes.md"],
  },
  explorer: {
    title: "Explorer",
    className: "explorer",
    folders: ["data", "automations", "integrations", "skills", "tools"],
  },
};
const SATELLITE_POSITIONS = [
  [23, 18], [77, 18], [17, 54], [83, 54], [32, 82], [68, 82], [50, 12], [50, 88]
];
const el = (id) => document.getElementById(id);

async function api(path, options) {
  const attempts = options ? 1 : 3;
  const requestOptions = options ? { cache: "no-store", ...options } : { cache: "no-store" };
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(path, requestOptions);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "request failed");
      return json;
    } catch (error) {
      lastError = error;
      const transient = error instanceof TypeError && /fetch/i.test(error.message || "");
      if (!transient || attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, 180 * attempt));
    }
  }
  throw lastError || new Error("request failed");
}

function renderStats(files) {
  const existing = files.filter((file) => file.exists).length;
  const chars = files.reduce((sum, file) => sum + (file.chars || 0), 0);
  el("stats").innerHTML = [
    '<div class="card"><strong>' + files.length + '</strong><span>tracked files</span></div>',
    '<div class="card"><strong>' + existing + '</strong><span>present</span></div>',
    '<div class="card"><strong>' + chars.toLocaleString("en-US") + '</strong><span>characters</span></div>',
  ].join("");
}

function renderMainFiles() {
  const mainFiles = state.files.filter((file) => MAIN_FILE_PATHS.has(file.path));
  const groups = groupMainFiles(mainFiles);
  el("mainFiles").innerHTML = groups.map((group) =>
    '<div class="quick-group">' +
      '<div class="quick-group-title">' + escapeHtml(group.title) + '</div>' +
      group.files.map((file) =>
        '<button class="quick-file ' + (state.selected === file.path ? "active" : "") + '" data-main-path="' + escapeHtml(file.path) + '" title="' + escapeHtml(file.impact || file.path) + '">' +
          '<strong>' + escapeHtml(file.label || file.path) + '</strong>' +
          '<span>' + escapeHtml(file.path) + '</span>' +
        '</button>'
      ).join("") +
    '</div>'
  ).join("");
  document.querySelectorAll("[data-main-path]").forEach((button) => button.addEventListener("click", () => selectFile(button.dataset.mainPath)));
}

function groupMainFiles(files) {
  const buckets = [
    { title: "injected by Hermes", test: (file) => file.category.startsWith("1") },
    { title: "Project context", test: (file) => file.path === "memory/USER.md" || file.path === "memory/MEMORY.md" },
  ];
  const used = new Set();
  const groups = buckets.map((bucket) => {
    const grouped = files.filter((file) => bucket.test(file) && !used.has(file.path));
    for (const file of grouped) used.add(file.path);
    return { title: bucket.title, files: grouped };
  }).filter((group) => group.files.length);
  const rest = files.filter((file) => !used.has(file.path));
  if (rest.length) groups.push({ title: "other core files", files: rest });
  return groups;
}

function buildTree(files) {
  const root = { name: "", path: "", type: "folder", children: new Map(), file: null };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    let current = "";
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      current = current ? current + "/" + part : part;
      const isFile = index === parts.length - 1;
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, path: current, type: isFile ? "file" : "folder", children: new Map(), file: null });
      }
      node = node.children.get(part);
      if (isFile) {
        node.type = "file";
        node.file = file;
      }
    }
  }
  return root;
}

function visibleFiles() {
  const q = el("search").value.toLowerCase().trim();
  const filters = state.pathFilters || [];
  const generatedFilterQuery = folderFilterSearchQuery(filters).toLowerCase().trim();
  return state.files.filter((file) => {
    if (file.startupContext) return false;
    const inScope = !filters.length || filters.some((filter) => pathMatchesFilter(file.path, filter));
    const matchesWatchFilter = explorerWatchFilterMatches(file.path, state.explorerWatchFilter, state.settings?.watchAllow || []);
    const haystack = (file.path + " " + file.label + " " + file.category).toLowerCase();
    const normalizedQuery = q.replace(/\/$/, "");
    const matchesQuery = !q
      || (filters.length && q === generatedFilterQuery)
      || haystack.includes(q)
      || (normalizedQuery !== q && haystack.includes(normalizedQuery));
    return inScope && matchesWatchFilter && matchesQuery;
  });
}

function setExplorerWatchFilter(filter) {
  state.explorerWatchFilter = ["watched", "unwatched"].includes(filter) ? filter : "all";
  if (state.explorerWatchFilter !== "all") expandExplorerFilterResults();
  renderFiles();
  setStatus(state.explorerWatchFilter === "all" ? "showing all docs" : "showing " + state.explorerWatchFilter + " docs");
}

function expandExplorerFilterResults() {
  explorerExpansionPathsForFiles(visibleFiles()).forEach((path) => state.expanded.add(path));
}

function explorerExpansionPathsForFiles(files = []) {
  const seen = new Set();
  const paths = [];
  for (const item of files || []) {
    const filePath = normalizeUiPath(typeof item === "string" ? item : item?.path || "");
    const parts = filePath.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (parent && !seen.has(parent)) {
        seen.add(parent);
        paths.push(parent);
      }
    }
  }
  return paths;
}

function updateExplorerWatchFilterButtons() {
  document.querySelectorAll("[data-watch-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.watchFilter === state.explorerWatchFilter);
  });
}

function renderFiles() {
  const tree = buildTree(visibleFiles());
  el("files").innerHTML = renderTreeChildren(tree, 0);
  updateExplorerWatchFilterButtons();
  document.querySelectorAll("[data-file-path]").forEach((button) => {
    button.addEventListener("click", (event) => {
      hideExplorerContextMenu();
      if (shouldToggleSelection(event)) toggleDeleteSelection(button.dataset.filePath);
      else selectFile(button.dataset.filePath).catch((error) => setStatus(error.message));
    });
    button.addEventListener("contextmenu", (event) => openExplorerContextMenu(event, { kind: "file", path: button.dataset.filePath }));
  });
  document.querySelectorAll("[data-folder-path]").forEach((button) => {
    button.addEventListener("click", (event) => {
      hideExplorerContextMenu();
      const selectPath = button.dataset.folderPath + "/";
      if (shouldToggleSelection(event)) toggleDeleteSelection(selectPath);
      else {
        openSidebarIfCollapsed();
        toggleFolder(button.dataset.folderPath);
      }
    });
    button.addEventListener("contextmenu", (event) => openExplorerContextMenu(event, { kind: "folder", path: button.dataset.folderPath }));
  });
  document.querySelectorAll("[data-toggle-folder]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    openSidebarIfCollapsed();
    toggleFolder(button.dataset.toggleFolder);
  }));
  updateSelectionBar();
}

function shouldToggleSelection(event) {
  return event.metaKey || event.ctrlKey || event.shiftKey || state.selectedForDelete.size > 0;
}

function openExplorerContextMenu(event, target) {
  event.preventDefault();
  event.stopPropagation();
  const directory = explorerTargetDirectory(target);
  state.explorerContextTarget = { kind: target.kind, path: normalizeUiPath(target.path), directory };
  renderExplorerContextMenu(event.clientX, event.clientY);
}

function explorerTargetDirectory(target = {}) {
  const relPath = normalizeUiPath(target.path || "");
  if (target.kind === "folder") return relPath.replace(/\/$/, "");
  return parentDirectoryFromUiPath(relPath);
}

function parentDirectoryFromUiPath(relPath) {
  const parts = normalizeUiPath(relPath).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function defaultFolderPathForDirectory(directory, title = "New folder") {
  const slug = slugifyUiId(title) || "new-folder";
  return (directory ? directory.replace(/\/$/, "") + "/" : "") + slug;
}

function renderExplorerContextMenu(x, y) {
  const menu = el("explorerContextMenu");
  const target = state.explorerContextTarget;
  if (!menu || !target || !state.settings) return;
  const directoryLabel = target.directory || "project root";
  const label = target.path || directoryLabel;
  const targetActions = target.path
    ? '<button class="secondary" type="button" data-context-watch>Watch</button>' +
      '<button class="secondary" type="button" data-context-new-file>New file</button>' +
      '<button class="secondary" type="button" data-context-new-folder>New folder</button>' +
      '<button class="secondary" type="button" data-context-select>Select</button>' +
      '<button class="secondary danger-action" type="button" data-context-delete>Delete</button>'
    : '<button class="secondary" type="button" data-context-new-file>New file</button>' +
      '<button class="secondary" type="button" data-context-new-folder>New folder</button>';
  menu.innerHTML = '<div class="explorer-context-title"><span>Actions</span><code>' + escapeHtml(label) + '</code></div>' +
    '<div class="explorer-context-actions menu-actions" data-context-action-list>' +
      targetActions +
    '</div>' +
    '<div class="explorer-context-form" data-context-new-file-form hidden>' +
      '<div class="explorer-context-title"><span>New file</span><code>' + escapeHtml(directoryLabel) + '</code></div>' +
      '<label class="explorer-context-label" for="contextMarkdownTitle">Name</label>' +
      '<input id="contextMarkdownTitle" placeholder="Document title" value="New document" />' +
      '<div class="explorer-context-actions form-actions"><button id="contextCancelMarkdown" class="secondary" type="button" title="Cancel" aria-label="Cancel">Cancel</button><button id="contextCreateMarkdown" class="primary" type="button">Create</button></div>' +
    '</div>' +
    '<div class="explorer-context-form" data-context-new-folder-form hidden>' +
      '<div class="explorer-context-title"><span>New folder</span><code>' + escapeHtml(directoryLabel) + '</code></div>' +
      '<label class="explorer-context-label" for="contextFolderPath">Path</label>' +
      '<input id="contextFolderPath" placeholder="path/to/folder" value="' + escapeHtml(defaultFolderPathForDirectory(target.directory)) + '" />' +
      '<div class="explorer-context-actions form-actions"><button id="contextCancelFolder" class="secondary" type="button" title="Cancel" aria-label="Cancel">Cancel</button><button id="contextCreateFolder" class="primary" type="button">Create</button></div>' +
    '</div>';
  menu.hidden = false;
  menu.style.left = x + "px";
  menu.style.top = y + "px";
  clampContextMenuToViewport(menu);
  document.querySelector("[data-context-watch]")?.addEventListener("click", () => watchExplorerContextTarget().catch((error) => setStatus(error.message)));
  document.querySelector("[data-context-new-file]")?.addEventListener("click", showContextNewFileForm);
  document.querySelector("[data-context-new-folder]")?.addEventListener("click", showContextNewFolderForm);
  document.querySelector("[data-context-select]")?.addEventListener("click", selectExplorerContextTarget);
  document.querySelector("[data-context-delete]")?.addEventListener("click", () => deleteExplorerContextTarget().catch((error) => setStatus(error.message)));
  el("contextCreateMarkdown")?.addEventListener("click", () => createMarkdownFromContextMenu().catch((error) => setStatus(error.message)));
  el("contextCancelMarkdown")?.addEventListener("click", hideExplorerContextMenu);
  el("contextCreateFolder")?.addEventListener("click", () => createFolderFromContextMenu().catch((error) => setStatus(error.message)));
  el("contextCancelFolder")?.addEventListener("click", hideExplorerContextMenu);
}

function openExplorerEmptyContextMenu(event) {
  if (event.target.closest("#explorerContextMenu")) return;
  if (event.target.closest("[data-file-path], [data-folder-path], [data-toggle-folder]")) return;
  if (event.target.closest("button, input, textarea, select, a, .workspace-dock, .search-row, .watch-filter-row, .selection-bar, .sidebar-head")) return;
  openExplorerContextMenu(event, { kind: "folder", path: "" });
}

function hideContextCreationForms() {
  const actionList = document.querySelector("[data-context-action-list]");
  const fileForm = document.querySelector("[data-context-new-file-form]");
  const folderForm = document.querySelector("[data-context-new-folder-form]");
  if (actionList) actionList.hidden = false;
  if (fileForm) fileForm.hidden = true;
  if (folderForm) folderForm.hidden = true;
}

function showContextNewFileForm() {
  hideContextCreationForms();
  const actionList = document.querySelector("[data-context-action-list]");
  const form = document.querySelector("[data-context-new-file-form]");
  if (actionList) actionList.hidden = true;
  if (!form) return;
  form.hidden = false;
  el("contextMarkdownTitle")?.focus();
  el("contextMarkdownTitle")?.select();
}

function showContextNewFolderForm() {
  hideContextCreationForms();
  const actionList = document.querySelector("[data-context-action-list]");
  const form = document.querySelector("[data-context-new-folder-form]");
  if (actionList) actionList.hidden = true;
  if (!form) return;
  form.hidden = false;
  el("contextFolderPath")?.focus();
  el("contextFolderPath")?.select();
}

function clampContextMenuToViewport(menu) {
  window.requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    const left = Math.min(Math.max(8, rect.left), window.innerWidth - rect.width - 8);
    const top = Math.min(Math.max(8, rect.top), window.innerHeight - rect.height - 8);
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  });
}

function hideExplorerContextMenu() {
  const menu = el("explorerContextMenu");
  if (menu) menu.hidden = true;
}

function selectionPathForExplorerTarget(target) {
  if (!target?.path) return "";
  return target.kind === "folder" ? target.path.replace(/\/$/, "") + "/" : target.path;
}

function contextTargetSelectionPath() {
  return selectionPathForExplorerTarget(state.explorerContextTarget);
}

function contextMenuActionPaths() {
  const selectionPath = contextTargetSelectionPath();
  return selectionPath ? [selectionPath] : [];
}

function selectExplorerContextTarget() {
  const selectionPath = contextTargetSelectionPath();
  if (!selectionPath) return;
  hideExplorerContextMenu();
  toggleDeleteSelection(selectionPath);
}

async function watchExplorerContextTarget() {
  const selectionPath = contextTargetSelectionPath();
  if (!selectionPath) return;
  hideExplorerContextMenu();
  await updateWatchSelection(selectionPath, "allow");
}

async function deleteExplorerContextTarget() {
  const paths = contextMenuActionPaths();
  if (!paths.length) return;
  hideExplorerContextMenu();
  await deletePaths(paths);
}

async function createMarkdownFromContextMenu() {
  const title = el("contextMarkdownTitle")?.value.trim() || "New document";
  const directory = state.explorerContextTarget?.directory || "";
  const relPath = markdownPathFromName(directory, title);
  if (!relPath) throw new Error("New markdown name is required");
  hideExplorerContextMenu();
  showNewDocPage({ title, path: relPath, directory });
  setStatus("new document setup");
}

function markdownPathFromName(directory, name) {
  const cleanDirectory = normalizeUiPath(directory).replace(/\/$/, "");
  const rawName = String(name || "").trim().replace(/\.md$/i, "");
  const slug = slugifyUiId(rawName) || "new-document";
  return (cleanDirectory ? cleanDirectory + "/" : "") + slug + ".md";
}

async function createFolderFromContextMenu() {
  const relPath = normalizeUiPath(el("contextFolderPath")?.value || "");
  if (!relPath) throw new Error("New folder path is required");
  setStatus("creating folder...");
  const result = await api("/api/folder/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: relPath }),
  });
  hideExplorerContextMenu();
  const folderPath = result.path.replace(/\/$/, "");
  if (folderPath) state.expanded.add(folderPath);
  const parent = parentDirectoryFromUiPath(folderPath);
  if (parent) state.expanded.add(parent);
  await loadFiles();
  setStatus("folder created");
}

function openSidebarIfCollapsed() {
  const app = document.querySelector(".app");
  app?.classList.remove("sidebar-collapsed");
  if (app && window.matchMedia("(max-width: 980px)").matches) state.mobileSidebarTouched = true;
}
function syncResponsiveSidebar({ force = false } = {}) {
  const app = document.querySelector(".app");
  if (!app) return;
  const isMobile = window.matchMedia("(max-width: 980px)").matches;
  const isDrawer = window.matchMedia("(max-width: 640px)").matches;
  if (isMobile) {
    if (force || !state.mobileSidebarTouched) app.classList.add("sidebar-collapsed");
  } else {
    app.classList.remove("sidebar-collapsed");
    app.classList.remove("explorer-expanded");
    state.mobileSidebarTouched = false;
  }
  if (!isDrawer || app.classList.contains("sidebar-collapsed")) app.classList.remove("explorer-expanded");
  syncSidebarToggleIcon();
}

function collapseSidebarOnNarrow() {
  const app = document.querySelector(".app");
  if (window.matchMedia("(max-width: 980px)").matches) app?.classList.add("sidebar-collapsed");
  app?.classList.remove("explorer-expanded");
  syncSidebarToggleIcon();
}

function isNarrowLayout() {
  return window.matchMedia("(max-width: 980px)").matches;
}

function syncSidebarToggleIcon() {
  const toggle = el("sidebarToggle");
  if (toggle) toggle.textContent = window.matchMedia("(max-width: 640px)").matches ? "✕" : "☰";
}

function toggleDeleteSelection(path) {
  if (state.selectedForDelete.has(path)) state.selectedForDelete.delete(path);
  else state.selectedForDelete.add(path);
  renderFiles();
  setStatus(state.selectedForDelete.size ? "selection mode" : "ready");
}

function clearDeleteSelection() {
  state.selectedForDelete.clear();
  renderFiles();
  setStatus("selection cleared");
}

function updateSelectionBar() {
  const count = state.selectedForDelete.size;
  el("selectionBar").hidden = count === 0;
  el("selectionCount").textContent = count + " selected";
}

async function deletePaths(paths) {
  const selected = [...new Set(paths.filter(Boolean))];
  if (!selected.length) return;
  const message = "Permanently delete " + selected.length + " item" + (selected.length > 1 ? "s" : "") + "?\n\n" + selected.slice(0, 12).join("\n") + (selected.length > 12 ? "\n…" : "");
  if (!confirm(message)) return;
  if (state.dirty && selected.includes(state.selected) && !confirm("The current file has unsaved changes. Delete anyway?")) return;
  setStatus("deleting...");
  const result = await api("/api/files/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ paths: selected }),
  });
  state.selectedForDelete.clear();
  if (selected.includes(state.selected) || result.deleted.includes(state.selected)) {
    state.selected = null;
    state.selectedDiff = null;
    resetExternalChangeState();
    state.savedHash = null;
    state.dirty = false;
  }
  await loadFiles();
  setStatus(result.deleted.length + " file" + (result.deleted.length > 1 ? "s" : "") + " deleted");
}

function renderTreeChildren(node, depth) {
  return [...node.children.values()].sort(compareTreeNodes).map((child) => renderTreeNode(child, depth)).join("");
}

function renderTreeNode(node, depth) {
  if (node.type === "file") {
    const file = node.file || { path: node.path, label: node.name };
    const selected = state.selectedForDelete.has(file.path);
    const watchClass = watchStateForPath(file.path, state.settings?.watchAllow || []);
    return '<div class="tree-node tree-entry ' + [selected ? "selected" : "", watchClass].filter(Boolean).join(" ") + '">' +
      '<button class="tree-row file ' + (state.selected === file.path ? "active" : "") + '" style="padding-left:' + (depth * 12 + 7) + 'px" data-file-path="' + escapeHtml(file.path) + '" title="open · right-click for actions · ⌘-click to select">' +
        '<span class="twisty"></span><span class="icon">' + iconForPath(file.path) + '</span><span class="tree-name">' + escapeHtml(file.label || node.name) + '</span>' +
      '</button>' +
    '</div>';
  }
  const open = state.expanded.has(node.path);
  const selectPath = node.path + "/";
  const selected = state.selectedForDelete.has(selectPath);
  const watchClass = watchStateForPath(selectPath, state.settings?.watchAllow || []);
  return '<div class="tree-node">' +
    '<div class="tree-entry ' + [selected ? "selected" : "", watchClass].filter(Boolean).join(" ") + '">' +
      '<button class="tree-row folder" style="padding-left:' + (depth * 12 + 7) + 'px" data-folder-path="' + escapeHtml(node.path) + '" title="open · right-click for actions · ⌘-click to select">' +
        '<span class="twisty" data-toggle-folder="' + escapeHtml(node.path) + '" title="ouvrir/fermer">' + (open ? "▾" : "▸") + '</span><span class="icon">' + (open ? "📂" : "📁") + '</span><span class="tree-name">' + escapeHtml(node.name) + '</span>' +
      '</button>' +
    '</div>' +
    (open ? '<div class="tree-children">' + renderTreeChildren(node, depth + 1) + '</div>' : "") +
  '</div>';
}

function watchStateForPath(relPath, watchAllow = []) {
  const clean = normalizeUiPath(relPath);
  const exact = (watchAllow || []).map(normalizeUiPath).includes(clean);
  if (exact) return "watched";
  return (watchAllow || []).some((pattern) => pathMatchesUiSetting(clean, pattern)) ? "watched-inherited" : "";
}

function explorerWatchFilterMatches(relPath, filter = "all", watchAllow = []) {
  if (filter === "watched") return Boolean(watchStateForPath(relPath, watchAllow));
  if (filter === "unwatched") return !watchStateForPath(relPath, watchAllow);
  return true;
}

function pathMatchesUiSetting(relPath, pattern) {
  const clean = normalizeUiPath(pattern).replace(/\/$/, "");
  const path = normalizeUiPath(relPath).replace(/\/$/, "");
  if (!clean) return false;
  return path === clean || path.startsWith(clean + "/");
}

function compareTreeNodes(a, b) {
  if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
  return a.name.localeCompare(b.name, "fr");
}

function toggleFolder(folderPath) {
  if (state.expanded.has(folderPath)) closeFolder(folderPath);
  else state.expanded.add(folderPath);
  renderFiles();
}

function filterFolder(folderPath) {
  filterFolders([folderPath]);
}

function filterFolders(folderPaths) {
  openSidebarIfCollapsed();
  const cleans = folderPaths.map((folderPath) => (folderPath || "").replace(/\/$/, "")).filter(Boolean);
  state.pathFilters = cleans;
  const search = el("search");
  search.value = folderFilterSearchQuery(cleans);
  search.focus();
  search.setSelectionRange(search.value.length, search.value.length);
  state.expanded = new Set(cleans.flatMap((clean) => parentFolders(clean)));
  renderFiles();
  const aside = document.querySelector("aside");
  const target = document.querySelector('[data-folder-path="' + cssEscape(cleans[0] || "") + '"]');
  if (aside && target) aside.scrollTop += target.getBoundingClientRect().top - aside.getBoundingClientRect().top - 16;
  setStatus(cleans.length > 1 ? "folders filtered" : "folder filtered");
}

function folderFilterSearchQuery(folderPaths = []) {
  const seen = new Set();
  return folderPaths
    .map((folderPath) => normalizeUiPath(folderPath).replace(/\/$/, ""))
    .filter((folderPath) => {
      if (!folderPath || seen.has(folderPath)) return false;
      seen.add(folderPath);
      return true;
    })
    .map((folderPath) => (folderPath.includes(".") && !folderPath.endsWith("/") ? folderPath : folderPath.replace(/\/$/, "") + "/"))
    .join(" ");
}

function clearExplorerFilter() {
  state.pathFilters = [];
  el("search").value = "";
  renderFiles();
  setStatus("explorateur complet");
}

function pathMatchesFilter(filePath, filterPath) {
  const clean = (filterPath || "").replace(/\/$/, "");
  return filePath === clean || filePath.startsWith(clean + "/");
}

function closeFolder(folderPath) {
  const clean = (folderPath || "").replace(/\/$/, "");
  for (const openPath of [...state.expanded]) {
    if (openPath === clean || openPath.startsWith(clean + "/")) state.expanded.delete(openPath);
  }
}

function openFolder(folderPath) {
  for (const part of parentFolders(folderPath)) state.expanded.add(part);
  renderFiles();
  const aside = document.querySelector("aside");
  const target = document.querySelector('[data-folder-path="' + cssEscape(folderPath.replace(/\/$/, "")) + '"]');
  if (aside && target) aside.scrollTop += target.getBoundingClientRect().top - aside.getBoundingClientRect().top - 16;
  setStatus("folder open");
}

function expandSearchMatches() {
  if (!el("search").value.trim()) return;
  for (const file of visibleFiles()) {
    for (const folder of parentFolders(file.path).slice(0, -1)) state.expanded.add(folder);
  }
}

function parentFolders(target) {
  const clean = target.replace(/\/$/, "");
  const parts = clean.split("/");
  const folders = [];
  for (let i = 1; i <= parts.length; i += 1) folders.push(parts.slice(0, i).join("/"));
  return folders;
}

function iconForPath(filePath) {
  if (filePath.endsWith(".csv")) return "▦";
  if (filePath.endsWith(".json") || filePath.endsWith(".jsonl")) return "{}";
  if (filePath.endsWith(".mjs") || filePath.endsWith(".js") || filePath.endsWith(".py")) return "⌘";
  return "◇";
}

async function loadFiles() {
  setStatus("chargement...");
  const [data, docqa, doctor, settingsData, startupData] = await Promise.all([api("/api/files"), api("/api/docqa"), api("/api/doctor"), api("/api/settings"), api("/api/startup-context")]);
  state.files = data.files;
  state.startupContextFiles = startupData.files || [];
  state.docqa = docqa;
  state.doctor = doctor;
  state.settings = settingsData.settings;
  state.availableHubCards = settingsData.availableHubCards || [];
  state.hubFolders = settingsData.hubCards || [];
  state.rootHubSections = settingsData.hubSections || [];
  state.hubSections = state.rootHubSections;
  state.selectedReview = docqa.queue[0]?.path || null;
  renderFiles();
  if (!state.selected) showHome();
  setStatus("ready");
}

async function selectFile(path, options = {}) {
  if (!path) return;
  if (state.selected && path !== state.selected && !options.forceReload && blockPendingExternalChange("before changing file")) return;
  if (state.dirty && !options.forceReload && !confirm("You have unsaved changes. Change file?")) return;

  const requestId = ++state.selectionRequest;
  state.selected = path;
  state.selectedStartupContext = null;
  state.page = "file";
  state.settingsOpen = false;
  state.pendingMarkdown = null;
  if (state.docqa?.queue?.some((item) => item.path === path)) state.selectedReview = path;
  state.selectedDiff = null;
  resetConflictState();
  resetExternalChangeState();
  state.saved = "";
  state.savedHash = null;
  state.dirty = false;
  state.filePanel = false;
  if (options.revealInExplorer) {
    state.pathFilters = [];
    el("search").value = "";
    document.querySelector(".app").classList.remove("sidebar-collapsed");
  } else {
    collapseSidebarOnNarrow();
  }
  for (const folder of parentFolders(path).slice(0, -1)) state.expanded.add(folder);
  document.querySelector(".editor-shell").classList.remove("planet-file-open");
  document.querySelector(".editor-shell").classList.add("file-open");
  el("home").hidden = true;
  el("settingsPage").hidden = true;
  el("newDocPage").hidden = true;
  el("viewer").hidden = false;
  el("editor").hidden = true;
  el("editor").value = "";
  updateHeader();
  updateHistoryButtons();
  updateActionBanner();
  updatePreview();
  renderFiles();
  if (options.revealInExplorer) scrollExplorerToPath(path);
  renderViewer();
  setStatus("opening...");

  try {
    const data = await api("/api/file?path=" + encodeURIComponent(path));
    if (!isCurrentSelection(requestId, path)) return;
    state.saved = data.content;
    state.savedHash = data.contentHash;
    el("editor").value = data.content;
    if (options.pushHistory !== false) pushHistory(path);
    updateHeader();
    updateHistoryButtons();
    updatePreview();
    renderViewer();
    setStatus("open");

    api("/api/file/diff?path=" + encodeURIComponent(path))
      .then((diff) => {
        if (!isCurrentSelection(requestId, path)) return;
        state.selectedDiff = diff;
        renderViewer();
      })
      .catch((error) => {
        if (isCurrentSelection(requestId, path)) setStatus(error.message);
      });
  } catch (error) {
    if (isCurrentSelection(requestId, path)) setStatus(error.message);
  }
}

function isCurrentSelection(requestId, path) {
  return state.selectionRequest === requestId && state.selected === path;
}

async function selectStartupContextFile(order) {
  if (!order) return;
  if (state.dirty && !confirm("You have unsaved changes. Change file?")) return;
  const requestId = ++state.selectionRequest;
  const selectedKey = "startup-context-" + order;
  const pendingFile = (state.startupContextFiles || []).find((file) => String(file.startupContext.order) === String(order));
  state.selected = selectedKey;
  state.selectedStartupContext = pendingFile?.startupContext || { order, fileName: "Startup context", displayPath: "" };
  state.selectedDiff = null;
  resetExternalChangeState();
  state.saved = "";
  state.savedHash = null;
  state.dirty = false;
  state.page = "file";
  state.settingsOpen = false;
  state.pendingMarkdown = null;
  collapseSidebarOnNarrow();
  document.querySelector(".editor-shell").classList.remove("planet-file-open");
  document.querySelector(".editor-shell").classList.add("file-open");
  el("home").hidden = true;
  el("settingsPage").hidden = true;
  el("newDocPage").hidden = true;
  el("viewer").hidden = false;
  el("editor").hidden = true;
  el("editor").value = "";
  updateHeader();
  updateHistoryButtons();
  updateActionBanner();
  updatePreview();
  renderFiles();
  renderViewer();
  setStatus("opening startup context...");
  try {
    const data = await api("/api/startup-context/file?order=" + encodeURIComponent(order));
    if (!isCurrentSelection(requestId, selectedKey)) return;
    state.selectedStartupContext = data.startupContext;
    state.saved = data.content;
    state.savedHash = data.contentHash;
    el("editor").value = data.content;
    updateHeader();
    updatePreview();
    renderViewer();
    setStatus("startup context open");
  } catch (error) {
    if (isCurrentSelection(requestId, selectedKey)) setStatus(error.message);
  }
}

function scrollExplorerToPath(path) {
  const aside = document.querySelector("aside");
  const target = document.querySelector('[data-file-path="' + cssEscape(path) + '"]');
  if (!aside || !target) return;
  aside.scrollTop += target.getBoundingClientRect().top - aside.getBoundingClientRect().top - 120;
}

function showHome() {
  state.page = "hub";
  state.settingsOpen = false;
  state.pendingMarkdown = null;
  state.filePanel = false;
  state.dirty = false;
  el("title").textContent = "Doc QA Control Room";
  el("path").textContent = "ce que l’agent peut croire · ce qu’il vient de modifier · ce que l’humain doit valider";
  el("impact").textContent = "V1: Git/docs review queue, risk signals, reliability inspector, and direct evidence access.";
  el("meta").textContent = state.docqa ? "audit generated " + new Date(state.docqa.generatedAt).toLocaleTimeString("en-US") : "";
  el("home").hidden = false;
  el("settingsPage").hidden = true;
  el("newDocPage").hidden = true;
  el("viewer").hidden = true;
  el("editor").hidden = true;
  el("save").disabled = true;
  document.querySelector(".editor-shell").classList.remove("planet-file-open", "file-open");
  renderDocQaDashboard();
  updateHistoryButtons();
  updateActionBanner();
  renderHubFolders();
}

function renderDocQaDashboard() {
  const report = state.docqa;
  if (!report) return;
  const s = report.summary;
  el("reviewSummary").innerHTML = renderReviewSummary(s);
  const queue = report.queue.length ? report.queue : [];
  el("reviewQueue").innerHTML = queue.length ? queue.map(renderReviewItem).join("") : '<div class="issue">No watched files changed or created in the current worktree.</div>';
  document.querySelectorAll("[data-review-path]").forEach((button) => button.addEventListener("click", () => {
    selectFile(button.dataset.reviewPath, { revealInExplorer: !isNarrowLayout() }).catch((error) => setStatus(error.message));
  }));
  renderMarkdownTools();
  renderContextHealth();
  renderHubFolders();
}

function renderMarkdownTools() {
  const holder = el("markdownTools");
  if (!holder || !state.settings) return;
  const bestPractices = state.settings.bestPractices || [];
  holder.innerHTML = '<ol class="best-practice-list">' + bestPractices.map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ol>';
}

function renderContextHealth() {
  const holder = el("contextHealth");
  if (!holder || !state.doctor) return;
  const summary = state.doctor.graph || {};
  const issues = state.doctor.issues || [];
  holder.innerHTML = '<div class="review-summary">' +
    '<div class="review-summary-item"><strong>' + Number(summary.docs || 0).toLocaleString("en-US") + '</strong><span>docs</span></div>' +
    '<div class="review-summary-item"><strong>' + Number(summary.missingMetadata || 0).toLocaleString("en-US") + '</strong><span>no metadata</span></div>' +
    '<div class="review-summary-item"><strong>' + Number(summary.highOrCritical || 0).toLocaleString("en-US") + '</strong><span>high risk</span></div>' +
  '</div>' +
  '<div class="issue-list">' + (issues.length ? issues.slice(0, 10).map((issue) => '<div class="issue ' + escapeHtml(issue.severity) + '"><strong>[' + escapeHtml(issue.severity) + ']</strong> ' + escapeHtml((issue.path ? issue.path + ": " : "") + issue.message) + '</div>').join("") : '<div class="issue">Context health is clean.</div>') + '</div>';
}

function showNewDocPage({ title = "New document", path = "docs/new-document.md", directory = "" } = {}) {
  if (blockPendingExternalChange("before creating a document")) return;
  if (state.dirty && !confirm("You have unsaved changes. Create a new document?")) return;
  state.page = "new-doc";
  state.settingsOpen = false;
  state.pendingMarkdown = { title, path, directory };
  state.selected = null;
  state.selectedStartupContext = null;
  state.selectedDiff = null;
  resetExternalChangeState();
  state.savedHash = null;
  state.dirty = false;
  el("title").textContent = "New document";
  el("path").textContent = path;
  el("impact").textContent = "Configure the document before Context Room writes it to disk.";
  el("meta").textContent = directory ? "folder: " + directory : "project root";
  el("home").hidden = true;
  el("settingsPage").hidden = true;
  el("newDocPage").hidden = false;
  el("viewer").hidden = true;
  el("editor").hidden = true;
  el("save").disabled = true;
  document.querySelector(".editor-shell").classList.remove("planet-file-open", "file-open");
  renderNewDocPanel();
  updateHistoryButtons();
  updateActionBanner();
  collapseSidebarOnNarrow();
}

function renderNewDocPanel() {
  const holder = el("newDocPanel");
  if (!holder || !state.pendingMarkdown) return;
  const pending = state.pendingMarkdown;
  const canonical = slugifyUiId(pending.title).replaceAll("-", "_");
  const initialPath = splitMarkdownPath(pending.path);
  const initialFolder = initialPath.folder || pending.directory || "";
  const initialFileName = initialPath.fileName || markdownFileNameFromName(pending.title);
  const initialPreview = markdownPathFromParts(initialFolder, initialFileName);
  holder.innerHTML = '<div class="markdown-create" data-structured-doc-form>' +
    '<div class="settings-field"><label for="markdownCreateTitle">Title</label><input id="markdownCreateTitle" value="' + escapeHtml(pending.title) + '" /></div>' +
    '<div class="settings-field path-picker-field"><label>Path</label><div class="path-picker" data-path-picker>' +
      '<input id="markdownCreateFolder" type="hidden" value="' + escapeHtml(initialFolder) + '" />' +
      '<button id="markdownCreateFolderButton" class="path-picker-trigger" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="markdownCreateFolderMenu"><code id="markdownCreateFolderLabel">' + escapeHtml(pathFolderLabel(initialFolder)) + '</code><span>choose</span></button>' +
      '<input id="markdownCreateFileName" aria-label="File name" data-auto-name="true" value="' + escapeHtml(initialFileName) + '" />' +
      '<input id="markdownCreatePath" type="hidden" value="' + escapeHtml(initialPreview) + '" />' +
      '<div id="markdownCreateFolderMenu" class="path-picker-menu" hidden><input id="markdownCreateFolderSearch" class="path-picker-search" placeholder="search folder..." /><div id="markdownCreateFolderOptions" class="path-picker-options" role="listbox" aria-label="Folder choices"></div></div>' +
      '<div class="path-picker-preview"><span>final path</span><code id="markdownCreatePathPreview">' + escapeHtml(initialPreview) + '</code></div>' +
    '</div></div>' +
    '<div class="settings-field"><label for="markdownCreateTemplate">Template</label><select id="markdownCreateTemplate">' + renderTemplateOptions("context-golden") + '</select></div>' +
    '<div class="settings-field"><label for="markdownCreateKind">Kind</label><select id="markdownCreateKind"><option value="canonical">canonical</option><option value="index">index</option><option value="agents">agents</option><option value="procedure">procedure</option><option value="decision">decision</option></select></div>' +
    '<div class="settings-field"><label for="markdownCreateScope">Scope</label><input id="markdownCreateScope" value="project" /></div>' +
    '<div class="settings-field"><label for="markdownCreateStatus">Status</label><select id="markdownCreateStatus"><option value="current">current</option><option value="draft">draft</option><option value="historical">historical</option><option value="superseded">superseded</option></select></div>' +
    '<div class="settings-field"><label for="markdownCreateCanonical">Canonical for</label><input id="markdownCreateCanonical" value="' + escapeHtml(canonical) + '" placeholder="feature or system name" /></div>' +
    '<div class="settings-field paths"><label for="markdownCreateSources">Sources</label><textarea id="markdownCreateSources" placeholder="one source path or URL per line"></textarea></div>' +
    '<div class="new-doc-actions"><button id="cancelStructuredMarkdown" class="secondary" type="button">Cancel</button><button id="createStructuredMarkdown" class="primary" type="button">Create file</button></div>' +
  '</div>';
  el("markdownCreateTitle")?.addEventListener("input", suggestStructuredMarkdownPath);
  el("markdownCreateFolderButton")?.addEventListener("click", () => togglePathPickerMenu());
  el("markdownCreateFolderSearch")?.addEventListener("input", () => renderPathPickerOptions(el("markdownCreateFolderSearch")?.value || ""));
  el("markdownCreateFolderSearch")?.addEventListener("keydown", (event) => {
    if (event.key === "Escape") togglePathPickerMenu(false);
  });
  el("markdownCreateFileName")?.addEventListener("input", () => {
    el("markdownCreateFileName").dataset.autoName = "false";
    updateStructuredMarkdownPath();
  });
  el("markdownCreateFileName")?.addEventListener("blur", normalizeStructuredFileName);
  el("markdownCreateTemplate")?.addEventListener("change", syncStructuredTemplateKind);
  el("cancelStructuredMarkdown")?.addEventListener("click", () => goHub());
  el("createStructuredMarkdown")?.addEventListener("click", () => createStructuredMarkdownFromWizard().catch((error) => setStatus(error.message)));
  renderPathPickerOptions();
  updateStructuredMarkdownPath();
}

function suggestStructuredMarkdownPath() {
  const title = el("markdownCreateTitle")?.value || "New document";
  const fileName = el("markdownCreateFileName");
  if (fileName && fileName.dataset.autoName !== "false") fileName.value = markdownFileNameFromName(title);
  updateStructuredMarkdownPath();
  const canonical = el("markdownCreateCanonical");
  if (canonical && !canonical.value.trim()) canonical.value = slugifyUiId(title).replaceAll("-", "_");
}

function markdownFolderOptions(selectedFolder = "") {
  const folders = new Set([""]);
  const addFolder = (folderPath) => {
    const clean = normalizeUiPath(folderPath).replace(/\/$/, "");
    if (!clean || clean.startsWith("~")) {
      if (!clean) folders.add("");
      return;
    }
    folders.add(clean);
    for (const parent of parentFolders(clean)) folders.add(parent);
  };
  addFolder(selectedFolder);
  addFolder(state.pendingMarkdown?.directory || "");
  for (const item of state.files || []) {
    const folder = parentDirectoryFromUiPath(item.path || "");
    if (folder) addFolder(folder);
  }
  for (const configured of [...(state.settings?.allowedPaths || []), ...(state.settings?.watchAllow || [])]) {
    const clean = normalizeUiPath(configured);
    if (clean.endsWith("/")) addFolder(clean);
  }
  return [...folders]
    .sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map((value) => ({ value, label: value ? value + "/" : "project root" }));
}

function pathFolderLabel(folder = "") {
  return folder ? normalizeUiPath(folder).replace(/\/$/, "") + "/" : "project root";
}

function togglePathPickerMenu(forceOpen) {
  const menu = el("markdownCreateFolderMenu");
  const button = el("markdownCreateFolderButton");
  if (!menu || !button) return;
  const open = typeof forceOpen === "boolean" ? forceOpen : menu.hidden;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    const search = el("markdownCreateFolderSearch");
    if (search) {
      search.value = "";
      renderPathPickerOptions();
      search.focus();
    }
  }
}

function renderPathPickerOptions(query = "") {
  const holder = el("markdownCreateFolderOptions");
  if (!holder) return;
  const selected = normalizeUiPath(el("markdownCreateFolder")?.value || "").replace(/\/$/, "");
  const cleanQuery = String(query || "").toLowerCase().trim();
  const options = markdownFolderOptions(selected).filter((folder) => {
    if (!cleanQuery) return true;
    return folder.label.toLowerCase().includes(cleanQuery) || folder.value.toLowerCase().includes(cleanQuery);
  });
  holder.innerHTML = options.length
    ? options.slice(0, 80).map((folder) =>
      '<button class="path-picker-option ' + (folder.value === selected ? 'active' : '') + '" type="button" role="option" aria-selected="' + (folder.value === selected ? 'true' : 'false') + '" data-path-folder="' + escapeHtml(folder.value) + '">' +
        '<code>' + escapeHtml(folder.label) + '</code><span>' + (folder.value === selected ? 'current' : 'select') + '</span>' +
      '</button>'
    ).join("")
    : '<div class="path-picker-empty">No folder matches this search.</div>';
  holder.querySelectorAll("[data-path-folder]").forEach((button) => button.addEventListener("click", () => setStructuredFolder(button.dataset.pathFolder || "")));
}

function setStructuredFolder(folder) {
  const clean = normalizeUiPath(folder).replace(/\/$/, "");
  const input = el("markdownCreateFolder");
  const label = el("markdownCreateFolderLabel");
  if (input) input.value = clean;
  if (label) label.textContent = pathFolderLabel(clean);
  togglePathPickerMenu(false);
  updateStructuredMarkdownPath();
}

function splitMarkdownPath(relPath = "") {
  const normalized = normalizeUiPath(relPath);
  const parts = normalized.split("/").filter(Boolean);
  const fileName = parts.pop() || "";
  return { folder: parts.join("/"), fileName };
}

function markdownFileNameFromName(name) {
  const raw = String(name || "").trim().replace(/\.md$/i, "");
  const slug = slugifyUiId(raw) || "new-document";
  return slug + ".md";
}

function markdownPathFromParts(folder, fileName) {
  const cleanFolder = normalizeUiPath(folder).replace(/\/$/, "");
  const cleanFileName = markdownFileNameFromName(fileName);
  return (cleanFolder ? cleanFolder + "/" : "") + cleanFileName;
}

function updateStructuredMarkdownPath() {
  const folder = el("markdownCreateFolder")?.value || "";
  const fileName = el("markdownCreateFileName")?.value || el("markdownCreateTitle")?.value || "New document";
  const relPath = markdownPathFromParts(folder, fileName);
  const pathInput = el("markdownCreatePath");
  const preview = el("markdownCreatePathPreview");
  if (pathInput) pathInput.value = relPath;
  if (preview) preview.textContent = relPath;
  if (state.pendingMarkdown) {
    state.pendingMarkdown.path = relPath;
    state.pendingMarkdown.directory = folder;
  }
  if (state.page === "new-doc") {
    el("path").textContent = relPath;
    el("meta").textContent = folder ? "folder: " + folder : "project root";
  }
  return relPath;
}

function normalizeStructuredFileName() {
  const input = el("markdownCreateFileName");
  if (!input) return;
  input.value = splitMarkdownPath(markdownPathFromParts("", input.value)).fileName;
  updateStructuredMarkdownPath();
}

function syncStructuredTemplateKind() {
  const templateId = el("markdownCreateTemplate")?.value || "context-golden";
  const kindByTemplate = { agents: "agents", "docs-index": "index", "context-golden": "canonical", procedure: "procedure", "decision-record": "decision" };
  const kind = kindByTemplate[templateId];
  if (kind && el("markdownCreateKind")) el("markdownCreateKind").value = kind;
}

async function createStructuredMarkdownFromWizard() {
  const title = el("markdownCreateTitle")?.value.trim() || "New document";
  const relPath = normalizeUiPath(updateStructuredMarkdownPath() || el("markdownCreatePath")?.value || "");
  if (!relPath) throw new Error("New markdown path is required");
  const metadata = {
    kind: el("markdownCreateKind")?.value || "canonical",
    scope: el("markdownCreateScope")?.value.trim() || "project",
    status: el("markdownCreateStatus")?.value || "current",
    canonical_for: el("markdownCreateCanonical")?.value.trim() || "",
    last_verified: new Date().toISOString().slice(0, 10),
    sources: linesFromTextarea("markdownCreateSources"),
  };
  setStatus("creating structured doc...");
  const result = await api("/api/markdown/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: relPath,
      title,
      templateId: el("markdownCreateTemplate")?.value || "context-golden",
      applyTemplate: true,
      metadata,
    }),
  });
  const parent = parentDirectoryFromUiPath(result.path);
  if (parent) state.expanded.add(parent);
  state.pendingMarkdown = null;
  await loadFiles();
  await selectFile(result.path, { revealInExplorer: true });
  setStatus("structured doc created");
}

function visibleMarkdownTemplates(templates = []) {
  return templates.filter((template) => template.enabled !== false);
}

function renderTemplateOptions(selectedId = "context-golden") {
  const templates = state.settings?.markdownTemplates || [];
  return visibleMarkdownTemplates(templates).map((template) => '<option value="' + escapeHtml(template.id) + '" ' + (template.id === selectedId ? 'selected' : '') + '>' + escapeHtml(template.title) + '</option>').join("");
}

function renderReviewSummary(summary = {}) {
  const changed = Number(summary.changedDocs || 0).toLocaleString("en-US");
  const needsReview = Number(summary.needsReview || 0).toLocaleString("en-US");
  return '<div class="review-summary-item"><strong>' + changed + '</strong><span>changed</span></div>' +
    '<div class="review-summary-item"><strong>' + needsReview + '</strong><span>to review</span></div>';
}

function gitStatusLabel(status) {
  const clean = String(status || "").trim();
  if (!clean) return "modified";
  if (clean === "??") return "new";
  if (clean === "M" || clean === "M M" || clean.includes("M")) return "modified";
  if (clean.includes("A")) return "added";
  if (clean.includes("D")) return "deleted";
  if (clean.includes("R")) return "renamed";
  if (clean.includes("U")) return "conflict";
  return clean;
}

function renderReviewItem(item) {
  const gitLabel = gitStatusLabel(item.gitStatus);
  return '<button class="review-item ' + (state.selectedReview === item.path ? "active" : "") + '" type="button" data-review-path="' + escapeHtml(item.path) + '">' +
    '<div class="review-top"><div class="review-title">' + escapeHtml(item.label || item.path) + '</div><span class="chip high">' + escapeHtml(gitLabel) + '</span></div>' +
    '<div class="review-path">' + escapeHtml(item.path) + '</div>' +
    '<div class="chips"><span class="chip">' + escapeHtml(item.classification.type) + '</span><span class="chip">open to review</span></div>' +
  '</button>';
}

function renderFileActionButtons({ hasReviewItem = false, dirty = false, canApplyTemplate = false, blockedByConflict = false } = {}) {
  return '<div class="file-actions">' +
    (canApplyTemplate ? '<div class="empty-template-actions"><select class="file-template-select" data-empty-template-select aria-label="Template">' + renderTemplateOptions() + '</select><button class="file-action" type="button" data-apply-template>Use template</button></div>' : '') +
    (hasReviewItem ? '<button class="file-action" type="button" data-file-verify>Mark verified</button>' : '') +
    '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' +
    '<button class="file-action primary" type="button" data-file-save ' + (!dirty || blockedByConflict ? 'disabled' : '') + (blockedByConflict ? ' title="Resolve the disk change before saving"' : '') + '>Save</button>' +
  '</div>';
}

function selectedFileNeedsReview() {
  return Boolean(state.selected && state.docqa?.queue?.some((item) => item.path === state.selected));
}

function renderSettingsPanel() {
  const holder = el("settingsPanel");
  if (!holder || !state.settings) return;
  const watchAllow = (state.settings.watchAllow || []).join("\n");
  const bestPractices = (state.settings.bestPractices || []).join("\n");
  const startupContext = state.settings.startupContext || { enabled: false, fileNames: ["AGENTS.md", "CLAUDE.md"] };
  const startupFileNames = (startupContext.fileNames || []).join("\n");
  const markdownTemplates = state.settings.markdownTemplates || [];
  const sections = state.settings.hubSections?.length ? state.settings.hubSections : [{ id: "main", title: "Main", cards: state.settings.customHubCards || state.availableHubCards || [] }];
  holder.innerHTML = '<div class="settings-grid">' +
    '<div class="settings-field"><label for="watchAllow">Watched folders/files</label><textarea id="watchAllow" placeholder="one path per line · empty = nothing to review">' + escapeHtml(watchAllow) + '</textarea></div>' +
    '<div class="settings-field"><label for="bestPractices">Docs best practices</label><textarea id="bestPractices" placeholder="one practice per line">' + escapeHtml(bestPractices) + '</textarea></div>' +
    '<div class="settings-field"><label class="template-enabled-toggle" for="startupContextEnabled"><input id="startupContextEnabled" type="checkbox" ' + (startupContext.enabled ? 'checked' : '') + ' /> Startup context scanner</label><textarea id="startupContextFileNames" placeholder="one filename per line">' + escapeHtml(startupFileNames) + '</textarea></div>' +
  '</div>' +
  '<div><div class="settings-title">Markdown templates</div><div class="hub-card-options" id="markdownTemplateEditors">' +
    markdownTemplates.map(renderMarkdownTemplateEditor).join("") +
  '</div></div>' +
  '<div><div class="settings-title">Hub sections and cards</div><div class="hub-card-options" id="hubSectionEditors">' +
    sections.map(renderHubSectionEditor).join("") +
  '</div></div>' +
  '<div class="settings-footer"><span>A card can open files/folders or contain child cards.</span><div class="docqa-actions"><button id="addMarkdownTemplate" class="secondary" type="button">+ template</button><button id="addHubSection" class="secondary" type="button">+ section</button><button id="saveSettings" class="secondary" type="button">save settings</button></div></div>';
  wireHubSettingsButtons(holder);
  wireMarkdownTemplateButtons(holder);
  el("addMarkdownTemplate")?.addEventListener("click", addMarkdownTemplateEditor);
  el("addHubSection")?.addEventListener("click", addHubSectionEditor);
  el("saveSettings")?.addEventListener("click", saveSettings);
}

function renderMarkdownTemplateEditor(template = {}) {
  const enabled = template.enabled !== false;
  return '<div class="template-editor" data-markdown-template-editor data-template-id="' + escapeHtml(template.id || "") + '">' +
    '<div class="template-editor-head"><label class="template-enabled-toggle"><input type="checkbox" data-template-enabled ' + (enabled ? 'checked' : '') + ' /> Show in selector</label><button class="selection-action danger-action" type="button" data-remove-markdown-template title="remove this template">×</button></div>' +
    '<div class="template-editor-grid">' +
      '<div class="settings-field"><label>Id</label><input data-template-id-input value="' + escapeHtml(template.id || "") + '" placeholder="context-golden" /></div>' +
      '<div class="settings-field"><label>Name</label><input data-template-title value="' + escapeHtml(template.title || "") + '" placeholder="Golden context file" /></div>' +
      '<div class="settings-field"><label>Description</label><input data-template-description value="' + escapeHtml(template.description || "") + '" placeholder="When to use this template" /></div>' +
      '<div class="settings-field template-body"><label>Content</label><textarea data-template-content placeholder="# {{title}}&#10;&#10;## Purpose&#10;...">' + escapeHtml(template.content || "") + '</textarea></div>' +
    '</div>' +
  '</div>';
}

function wireMarkdownTemplateButtons(root) {
  root.querySelectorAll("[data-remove-markdown-template]").forEach((button) => button.addEventListener("click", () => button.closest(".template-editor")?.remove()));
}

function addMarkdownTemplateEditor() {
  const holder = el("markdownTemplateEditors");
  if (!holder) return;
  holder.insertAdjacentHTML("beforeend", renderMarkdownTemplateEditor({ id: "custom-" + Date.now().toString(36), title: "New template", description: "", content: "# {{title}}\n\n## Purpose\n\n## Key facts\n\n## References\n" }));
  wireMarkdownTemplateButtons(holder.lastElementChild);
}

function renderHubSectionEditor(section) {
  const id = section.id || "section-" + Date.now().toString(36);
  return '<div class="hub-section-editor" data-hub-section-editor data-section-id="' + escapeHtml(id) + '">' +
    '<div class="hub-section-editor-head"><div class="settings-field"><label>Section name</label><input data-section-title value="' + escapeHtml(section.title || "Section") + '" placeholder="Section name" /></div><button class="secondary" type="button" data-add-root-card>+ card</button><button class="selection-action danger-action" type="button" data-remove-section title="remove this section">×</button></div>' +
    '<div class="hub-card-options" data-section-cards>' + (section.cards || []).map((card) => renderHubCardEditor(card, 0)).join("") + '</div>' +
  '</div>';
}

function renderHubCardEditor(card, depth = 0) {
  const paths = (card.paths || [card.path]).filter(Boolean).join("\n");
  return '<div class="hub-card-editor ' + (depth ? 'nested' : '') + '" data-hub-card-editor data-card-id="' + escapeHtml(card.id || "") + '">' +
    '<div class="hub-card-editor-head"><label class="hub-card-editor-title"><input type="checkbox" data-card-enabled ' + (card.enabled !== false ? 'checked' : '') + ' /> active</label><label class="hub-card-editor-title"><input type="checkbox" data-card-auto-children ' + (card.autoChildren ? 'checked' : '') + ' /> auto subcards</label><div class="docqa-actions"><button class="selection-action" type="button" data-add-child-card title="add a child card">+</button><button class="selection-action danger-action" type="button" data-remove-hub-card title="remove this card">×</button></div></div>' +
    '<div class="hub-card-editor-grid">' +
      '<div class="settings-field"><label>Name</label><input data-card-title value="' + escapeHtml(card.title || "") + '" placeholder="Card name" /></div>' +
      '<div class="settings-field"><label>Description</label><input data-card-description value="' + escapeHtml(card.description || "") + '" placeholder="Short description" /></div>' +
      '<div class="settings-field paths"><label>Included folders / files</label><textarea data-card-paths placeholder="empty if this card only navigates\none path per line">' + escapeHtml(paths) + '</textarea></div>' +
    '</div>' +
    '<div class="hub-card-children" data-card-children>' + (card.cards || []).map((child) => renderHubCardEditor(child, depth + 1)).join("") + '</div>' +
  '</div>';
}

function wireHubSettingsButtons(root) {
  root.querySelectorAll("[data-remove-hub-card]").forEach((button) => button.addEventListener("click", () => button.closest(".hub-card-editor")?.remove()));
  root.querySelectorAll("[data-remove-section]").forEach((button) => button.addEventListener("click", () => button.closest(".hub-section-editor")?.remove()));
  root.querySelectorAll("[data-add-root-card]").forEach((button) => button.addEventListener("click", () => addHubCardEditor(button.closest(".hub-section-editor")?.querySelector("[data-section-cards]"))));
  root.querySelectorAll("[data-add-child-card]").forEach((button) => button.addEventListener("click", () => addHubCardEditor(button.closest(".hub-card-editor")?.querySelector("[data-card-children]"))));
}

function addHubSectionEditor() {
  const holder = el("hubSectionEditors");
  if (!holder) return;
  const id = "section-" + Date.now().toString(36);
  holder.insertAdjacentHTML("beforeend", renderHubSectionEditor({ id, title: "New section", cards: [] }));
  wireHubSettingsButtons(holder.lastElementChild);
}

function addHubCardEditor(holder) {
  if (!holder) return;
  const id = "custom-" + Date.now().toString(36);
  holder.insertAdjacentHTML("beforeend", renderHubCardEditor({ id, title: "New card", description: "", paths: [], cards: [], enabled: true }, holder.closest(".hub-card-editor") ? 1 : 0));
  wireHubSettingsButtons(holder.lastElementChild);
}

async function saveSettings() {
  const watchAllow = linesFromTextarea("watchAllow");
  const bestPractices = linesFromTextarea("bestPractices");
  const startupContext = {
    enabled: Boolean(el("startupContextEnabled")?.checked),
    fileNames: linesFromTextarea("startupContextFileNames"),
  };
  const markdownTemplates = collectMarkdownTemplateEditors();
  const hubSections = collectHubSectionEditors();
  const allCards = flattenUiCards(hubSections.flatMap((section) => section.cards));
  const hubCards = Object.fromEntries(allCards.map((card) => [card.id, card.enabled !== false]));
  setStatus("saving settings...");
  const result = await api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { watchAllow, bestPractices, startupContext, markdownTemplates, hubCards, hubSections } }),
  });
  state.settings = result.settings;
  state.availableHubCards = result.availableHubCards || state.availableHubCards;
  state.hubFolders = result.hubCards || [];
  state.rootHubSections = result.hubSections || [];
  state.hubSections = state.rootHubSections;
  state.startupContextFiles = (await api("/api/startup-context")).files || [];
  const [docqa, doctor] = await Promise.all([api("/api/docqa"), api("/api/doctor")]);
  state.docqa = docqa;
  state.doctor = doctor;
  state.selectedReview = state.docqa.queue[0]?.path || null;
  if (state.page === "settings") renderSettingsPanel();
  else renderDocQaDashboard();
  setStatus("settings saved");
}

function collectMarkdownTemplateEditors() {
  return [...document.querySelectorAll("[data-markdown-template-editor]")].map((row, index) => {
    const title = row.querySelector("[data-template-title]")?.value.trim() || "Template " + (index + 1);
    const id = slugifyUiId(row.querySelector("[data-template-id-input]")?.value || title) || "template-" + (index + 1);
    const description = row.querySelector("[data-template-description]")?.value.trim() || "";
    const content = row.querySelector("[data-template-content]")?.value || "";
    const enabled = row.querySelector("[data-template-enabled]")?.checked !== false;
    return { id, title, description, content, enabled };
  }).filter((template) => template.title && template.content.trim());
}

function collectHubSectionEditors() {
  return [...document.querySelectorAll("[data-hub-section-editor]")].map((section, index) => {
    const title = section.querySelector("[data-section-title]")?.value.trim() || "Section " + (index + 1);
    const existingId = section.dataset.sectionId || "";
    const id = existingId || slugifyUiId(title) || "section-" + (index + 1);
    const cards = collectHubCardEditors(section.querySelector("[data-section-cards]"));
    return { id, title, cards };
  }).filter((section) => section.title);
}

function collectHubCardEditors(container) {
  return [...(container?.children || [])].filter((row) => row.matches?.("[data-hub-card-editor]")).map((row, index) => {
    const title = row.querySelector(":scope > .hub-card-editor-grid [data-card-title]")?.value.trim() || "Card " + (index + 1);
    const existingId = row.dataset.cardId || "";
    const id = existingId || slugifyUiId(title) || "custom-" + (index + 1);
    const description = row.querySelector(":scope > .hub-card-editor-grid [data-card-description]")?.value.trim() || "";
    const paths = (row.querySelector(":scope > .hub-card-editor-grid [data-card-paths]")?.value || "").split(/\r?\n/).map((line) => normalizeUiPath(line)).filter(Boolean);
    const enabled = row.querySelector(":scope > .hub-card-editor-head [data-card-enabled]")?.checked !== false;
    const autoChildren = row.querySelector(":scope > .hub-card-editor-head [data-card-auto-children]")?.checked === true;
    const cards = collectHubCardEditors(row.querySelector(":scope > [data-card-children]"));
    return { id, title, description, paths, cards, autoChildren, enabled };
  }).filter((card) => card.title);
}

function flattenUiCards(cards = []) {
  return cards.flatMap((card) => [card, ...flattenUiCards(card.cards || [])]);
}

function slugifyUiId(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function updateWatchSelection(path, action) {
  const clean = normalizeUiPath(path);
  if (!clean) return;
  const current = state.settings || { watchAllow: [], hubCards: {} };
  let watchAllow = [...new Set(current.watchAllow || [])];
  if (action === "allow") {
    if (watchAllow.includes(clean)) watchAllow = watchAllow.filter((item) => item !== clean);
    else watchAllow = [...watchAllow, clean];
  }
  setStatus("updating watch scope...");
  const result = await api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { ...current, watchAllow } }),
  });
  state.settings = result.settings;
  state.availableHubCards = result.availableHubCards || state.availableHubCards;
  state.hubFolders = result.hubCards || state.hubFolders;
  const [docqa, doctor] = await Promise.all([api("/api/docqa"), api("/api/doctor")]);
  state.docqa = docqa;
  state.doctor = doctor;
  state.selectedReview = state.docqa.queue.find((item) => item.path === state.selectedReview)?.path || state.docqa.queue[0]?.path || null;
  renderFiles();
  if (state.page === "settings") renderSettingsPanel();
  else renderDocQaDashboard();
  setStatus(watchAllow.includes(clean) ? "path watched" : "path removed");
}

async function addSelectedToWatch() {
  const selected = [...state.selectedForDelete].map(normalizeUiPath).filter(Boolean);
  if (!selected.length) return;
  const current = state.settings || { watchAllow: [], hubCards: {} };
  const watchAllow = [...new Set([...(current.watchAllow || []), ...selected])];
  setStatus("updating watch scope...");
  const result = await api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { ...current, watchAllow } }),
  });
  state.settings = result.settings;
  state.availableHubCards = result.availableHubCards || state.availableHubCards;
  state.hubFolders = result.hubCards || state.hubFolders;
  const [docqa, doctor] = await Promise.all([api("/api/docqa"), api("/api/doctor")]);
  state.docqa = docqa;
  state.doctor = doctor;
  state.selectedReview = state.docqa.queue.find((item) => item.path === state.selectedReview)?.path || state.docqa.queue[0]?.path || null;
  state.selectedForDelete.clear();
  renderFiles();
  if (state.page === "settings") renderSettingsPanel();
  else renderDocQaDashboard();
  setStatus(selected.length + " selected path" + (selected.length > 1 ? "s" : "") + " watched");
}

async function removeSelectedFromWatch() {
  const selected = [...state.selectedForDelete].map(normalizeUiPath).filter(Boolean);
  if (!selected.length) return;
  const current = state.settings || { watchAllow: [], hubCards: {} };
  const watchAllow = (current.watchAllow || []).filter((path) => !selected.includes(normalizeUiPath(path)));
  setStatus("updating watch scope...");
  const result = await api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { ...current, watchAllow } }),
  });
  state.settings = result.settings;
  state.availableHubCards = result.availableHubCards || state.availableHubCards;
  state.hubFolders = result.hubCards || state.hubFolders;
  const [docqa, doctor] = await Promise.all([api("/api/docqa"), api("/api/doctor")]);
  state.docqa = docqa;
  state.doctor = doctor;
  state.selectedReview = state.docqa.queue.find((item) => item.path === state.selectedReview)?.path || state.docqa.queue[0]?.path || null;
  state.selectedForDelete.clear();
  renderFiles();
  if (state.page === "settings") renderSettingsPanel();
  else renderDocQaDashboard();
  setStatus(selected.length + " selected path" + (selected.length > 1 ? "s" : "") + " removed from watch");
}

function linesFromTextarea(id) {
  return el(id).value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function normalizeUiPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function showSettingsPage() {
  if (blockPendingExternalChange("before opening settings")) return;
  if (state.dirty && !confirm("You have unsaved changes. Open settings?")) return;
  state.page = "settings";
  state.settingsOpen = true;
  state.pendingMarkdown = null;
  state.selected = null;
  state.selectedDiff = null;
  resetExternalChangeState();
  state.savedHash = null;
  state.dirty = false;
  el("title").textContent = "Settings";
  el("path").textContent = "watch scope · sections · hub cards";
  el("impact").textContent = "Full page for managing the hub tree comfortably.";
  el("meta").textContent = "settings open";
  el("home").hidden = true;
  el("settingsPage").hidden = false;
  el("newDocPage").hidden = true;
  el("viewer").hidden = true;
  el("editor").hidden = true;
  el("save").disabled = true;
  document.querySelector(".editor-shell").classList.remove("planet-file-open", "file-open");
  renderSettingsPanel();
  updateHistoryButtons();
  updateActionBanner();
  setStatus("settings");
}

function handleHubAction() {
  if (state.page === "hub") showSettingsPage();
  else goHub();
}

function updateActionBanner() {
  const onFile = state.page === "file" && Boolean(state.selected);
  el("hub").textContent = state.page === "hub" ? "settings" : "hub";
  el("hub").title = state.page === "hub" ? "Open settings" : "Back to hub";
  ["back", "forward"].forEach((id) => { el(id).hidden = !onFile; });
  ["reload", "verifyCurrent", "deleteCurrent", "save"].forEach((id) => { el(id).hidden = true; });
}

function renderHubFolders() {
  const holder = el("hubFolders");
  if (!holder) return;
  const sections = state.rootHubSections?.length ? state.rootHubSections : state.hubSections?.length ? state.hubSections : [{ id: "main", title: "Main", cards: state.hubFolders || [] }];
  const activeIds = activeHubCardIds(sections);
  holder.innerHTML = sections.map((section) => '<section class="hub-section"><div class="hub-section-title">' + escapeHtml(section.title || "Section") + '</div><div class="hub-section-grid">' + (section.cards || []).map((card) => renderHubFolderCard(card, activeIds)).join("") + '</div></section>').join("") + renderStartupContextPanel();
  document.querySelectorAll("[data-hub-file]").forEach((button) => button.addEventListener("click", () => selectFile(button.dataset.hubFile).catch((error) => setStatus(error.message))));
  document.querySelectorAll("[data-hub-folders]").forEach((button) => button.addEventListener("click", () => filterFolders(button.dataset.hubFolders.split('|'))));
  document.querySelectorAll("[data-hub-card-children]").forEach((button) => button.addEventListener("click", () => openHubChildren(button.dataset.hubCardChildren)));
  document.querySelectorAll("[data-hub-crumb]").forEach((button) => button.addEventListener("click", () => openHubPath(button.dataset.hubCrumb || null)));
  document.querySelectorAll("[data-startup-order]").forEach((button) => button.addEventListener("click", () => selectStartupContextFile(button.dataset.startupOrder).catch((error) => setStatus(error.message))));
}

function renderHubBreadcrumb() {
  const crumbs = hubBreadcrumbForCard(state.rootHubSections || state.hubSections || [], state.activeHubCardId);
  if (crumbs.length <= 1) return "";
  return '<nav class="hub-breadcrumb" aria-label="hub path">' + crumbs.map((crumb, index) => {
    const isCurrent = index === crumbs.length - 1;
    const button = '<button class="hub-crumb ' + (isCurrent ? 'current' : '') + '" type="button" data-hub-crumb="' + escapeHtml(crumb.id || '') + '">' + escapeHtml(crumb.title || "Hub") + '</button>';
    return (index ? '<span class="hub-crumb-separator">›</span>' : '') + button;
  }).join("") + '</nav>';
}

function activeHubCardIds(sections = state.rootHubSections || state.hubSections || []) {
  return new Set(hubBreadcrumbForCard(sections, state.activeHubCardId).map((crumb) => crumb.id).filter(Boolean));
}

function renderHubFolderCard(folder, activeIds = activeHubCardIds()) {
  const children = folder.cards || [];
  const paths = folderPaths(folder);
  const directFilePath = hubCardDirectFilePath(paths, children);
  const ownCount = children.length && folder.autoChildren ? 0 : countFolderFiles(paths);
  const count = ownCount + children.reduce((sum, child) => sum + countFolderFiles(folderPaths(child)), 0);
  const meta = children.length ? children.length + ' child card' + (children.length > 1 ? 's' : '') : (paths.length > 1 ? paths.length + ' sources' : paths[0]);
  const expanded = children.length && activeIds.has(folder.id);
  const current = state.activeHubCardId === folder.id;
  const data = children.length
    ? ' data-hub-card-children="' + escapeHtml(folder.id) + '"'
    : directFilePath
      ? ' data-hub-file="' + escapeHtml(directFilePath) + '"'
      : ' data-hub-folders="' + escapeHtml(paths.join('|')) + '"';
  return '<article class="hub-folder-card ' + (children.length ? 'navigation ' : '') + (expanded ? 'expanded ' : '') + (current ? 'current' : '') + '">' +
    '<button class="hub-folder-card-main" type="button"' + data + '>' +
      '<div><strong>' + escapeHtml(folder.title) + '</strong><span>' + escapeHtml(folder.description) + '</span></div>' +
      '<div class="hub-folder-meta"><code>' + escapeHtml(meta || "navigation") + '</code><span>' + count + ' file' + (count > 1 ? 's' : '') + '</span></div>' +
    '</button>' +
    (expanded ? renderHubFolderChildren(folder, activeIds) : '') +
  '</article>';
}

function renderHubFolderChildren(folder, activeIds) {
  const crumbs = hubBreadcrumbForCard(state.rootHubSections || state.hubSections || [], folder.id);
  const crumbText = crumbs.slice(1).map((crumb) => crumb.title).join(" / ") || folder.title;
  return '<div class="hub-folder-children">' +
    '<div class="hub-folder-children-head"><span>' + escapeHtml(crumbText) + '</span><span>' + (folder.cards || []).length + ' subcard' + ((folder.cards || []).length > 1 ? 's' : '') + '</span></div>' +
    '<div class="hub-folder-children-grid">' + (folder.cards || []).map((child) => renderHubFolderCard(child, activeIds)).join("") + '</div>' +
  '</div>';
}

function renderStartupContextPanel() {
  if (!state.settings?.startupContext?.enabled) return "";
  const files = (state.startupContextFiles || []).sort((a, b) => (a.startupContext.order || 0) - (b.startupContext.order || 0));
  const fileNames = (state.settings.startupContext.fileNames || []).join(", ");
  const body = files.length
    ? '<div class="startup-context-list">' + files.map((file) => '<button class="startup-context-item" type="button" data-startup-order="' + escapeHtml(file.startupContext.order) + '"><strong>' + escapeHtml(file.startupContext.order + ". " + file.startupContext.fileName) + '</strong><span>' + escapeHtml(file.startupContext.displayPath) + '</span></button>').join("") + '</div>'
    : '<div class="issue">No startup context files found for: ' + escapeHtml(fileNames || "AGENTS.md, CLAUDE.md") + '</div>';
  return '<section class="startup-context-panel"><div class="hub-section-title">Startup context</div><div class="startup-context-copy">Agent instruction files found from the filesystem root down to this Context Room root.</div>' + body + '</section>';
}

function hubCardDirectFilePath(paths = [], children = []) {
  if (children.length || paths.length !== 1) return null;
  const clean = normalizeUiPath(paths[0]);
  if (!clean || clean.endsWith("/")) return null;
  return state.files.some((file) => file.path === clean) ? clean : null;
}

function openHubChildren(cardId) {
  const nextId = state.activeHubCardId === cardId ? null : cardId;
  openHubPath(nextId);
  setStatus(nextId ? "child cards open" : "child cards closed");
}

function openHubPath(cardId = null) {
  state.activeHubCardId = cardId || null;
  state.hubSections = state.rootHubSections || state.hubSections;
  renderHubFolders();
  setStatus(cardId ? "hub path" : "hub");
}

function hubSectionViewForCard(sections = [], cardId = null) {
  if (!cardId) return sections;
  const found = findHubCardById(sections || [], cardId);
  return found ? [{ id: found.id, title: found.title, cards: found.cards || [] }] : sections;
}

function hubBreadcrumbForCard(sections = [], cardId = null) {
  const root = { id: null, title: "Hub" };
  if (!cardId) return [root];
  const path = findHubCardPathById(sections, cardId);
  return path.length ? [root, ...path.map((card) => ({ id: card.id, title: card.title }))] : [root];
}

function findHubCardPathById(sections = [], cardId = null) {
  const visit = (cards = [], ancestors = []) => {
    for (const card of cards) {
      const next = [...ancestors, card];
      if (card.id === cardId) return next;
      const child = visit(card.cards || [], next);
      if (child.length) return child;
    }
    return [];
  };
  for (const section of sections || []) {
    const found = visit(section.cards || []);
    if (found.length) return found;
  }
  return [];
}

function findHubCardById(sections, cardId) {
  const visit = (cards = []) => {
    for (const card of cards) {
      if (card.id === cardId) return card;
      const child = visit(card.cards || []);
      if (child) return child;
    }
    return null;
  };
  for (const section of sections) {
    const found = visit(section.cards || []);
    if (found) return found;
  }
  return null;
}

function folderPaths(folder) {
  return (folder.paths || [folder.path]).filter(Boolean);
}

function countFolderFiles(folderPaths) {
  return folderPaths.reduce((sum, folderPath) => {
    const clean = folderPath.replace(/\/$/, "");
    return sum + state.files.filter((file) => pathMatchesFilter(file.path, clean)).length;
  }, 0);
}


async function applyReviewDecision(path, status) {
  const note = status === "verified" ? "verified from Doc QA Control Room" : "needs changes from Doc QA Control Room";
  const nextPath = status === "verified" ? nextReviewPath(state.docqa?.queue || [], path) : null;
  setStatus(status === "verified" ? "validating..." : "marking...");
  await api("/api/docqa/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, status, note }),
  });
  const docqa = await api("/api/docqa");
  state.docqa = docqa;
  const nextAvailablePath = nextPath && docqa.queue.some((item) => item.path === nextPath) ? nextPath : docqa.queue[0]?.path || null;
  state.selectedReview = docqa.queue.find((item) => item.path === path)?.path || nextAvailablePath;
  if (status === "verified" && nextAvailablePath) {
    await selectFile(nextAvailablePath, { revealInExplorer: true });
    setStatus("file verified · next opened");
  } else if (state.selected) {
    setStatus(status === "verified" ? "file verified" : "needs changes");
  } else {
    renderDocQaDashboard();
    setStatus(status === "verified" ? "verified" : "needs changes");
  }
}

function nextReviewPath(queue = [], currentPath = null) {
  const paths = queue.map((item) => item?.path).filter(Boolean);
  if (!paths.length) return null;
  if (paths.length === 1 && paths[0] === currentPath) return null;
  const index = paths.indexOf(currentPath);
  if (index < 0) return paths[0] || null;
  return paths[(index + 1) % paths.length] || null;
}

async function verifyCurrentFile() {
  if (!state.selected) return;
  if (state.dirty && !confirm("This file has unsaved changes. Mark verified without saving?")) return;
  await applyReviewDecision(state.selected, "verified");
}

function renderPlanetSystem() {
  const holder = el("planetSystem");
  if (!holder) return;
  if (state.homeView === "root") {
    holder.innerHTML = '<div class="planet-field">' +
      planetButton("group:hermes", "root hermes", "Injected", "") +
      planetButton("group:lifeos", "root life", "Main", "") +
      planetButton("group:explorer", "root explorer", "Explorer", "") +
    '</div>';
  } else {
    const items = planetItems(state.homeView);
    holder.innerHTML = '<button class="secondary planet-back" type="button" data-planet-back>← back</button>' +
      '<div class="planet-breadcrumb">' + escapeHtml(planetTitle(state.homeView)) + '</div>' +
      items.map((item, index) => satelliteButton(item, index)).join("");
  }
  holder.querySelectorAll("[data-planet-action]").forEach((button) => button.addEventListener("click", () => openPlanet(button.dataset.planetAction)));
  holder.querySelectorAll("[data-planet-file]").forEach((button) => button.addEventListener("click", () => selectPlanetFile(button.dataset.planetFile).catch((error) => setStatus(error.message))));
  holder.querySelectorAll("[data-planet-folder]").forEach((button) => button.addEventListener("click", () => openPlanetFolder(button.dataset.planetFolder)));
  holder.querySelectorAll("[data-planet-back]").forEach((button) => button.addEventListener("click", goPlanetBack));
}

function planetItems(view) {
  if (view.startsWith("group:")) {
    const group = PLANET_GROUPS[view.slice(6)];
    if (!group) return [];
    if (group.files) return group.files.map((path) => ({ kind: "file", path }));
    return group.folders.map((path) => ({ kind: "folder", path }));
  }
  if (view.startsWith("folder:")) {
    const folderPath = view.slice(7);
    const node = findTreeNode(buildTree(state.files), folderPath);
    if (!node) return [];
    return [...node.children.values()].sort(compareTreeNodes).map((child) => ({ kind: child.type, path: child.path }));
  }
  return [];
}

function planetTitle(view) {
  if (view === "root") return "Context Room cockpit";
  if (view.startsWith("group:")) return PLANET_GROUPS[view.slice(6)]?.title || view;
  if (view.startsWith("folder:")) return view.slice(7) + "/";
  return view;
}

function findTreeNode(root, path) {
  if (!path) return root;
  let node = root;
  for (const part of path.split("/")) {
    node = node.children.get(part);
    if (!node) return null;
  }
  return node;
}

function planetButton(action, className, label, path) {
  return '<button class="planet ' + className + '" type="button" data-planet-action="' + escapeHtml(action) + '">' +
    '<span class="planet-label">' + escapeHtml(label) + (path ? '<span class="planet-path">' + escapeHtml(path) + '</span>' : '') + '</span>' +
  '</button>';
}

function satelliteButton(item, index) {
  const file = item.kind === "file" ? state.files.find((entry) => entry.path === item.path) : null;
  const label = file?.label || item.path.split("/").pop() || item.path;
  const pos = SATELLITE_POSITIONS[index % SATELLITE_POSITIONS.length];
  const attr = item.kind === "file" ? 'data-planet-file="' + escapeHtml(item.path) + '"' : 'data-planet-folder="' + escapeHtml(item.path) + '"';
  return '<button class="planet satellite ' + escapeHtml(item.kind) + '" type="button" style="left:' + pos[0] + '%;top:' + pos[1] + '%" ' + attr + '>' +
    '<span class="planet-label">' + escapeHtml(label) + '<span class="planet-path">' + escapeHtml(item.path) + '</span></span>' +
  '</button>';
}

function openPlanet(action) {
  state.homeView = action;
  state.planetStack = ["root", action];
  showHome();
}

function openPlanetFolder(folderPath) {
  state.homeView = "folder:" + folderPath;
  state.planetStack.push(state.homeView);
  for (const folder of parentFolders(folderPath)) state.expanded.add(folder);
  renderFiles();
  showHome();
}

function goPlanetBack() {
  if (state.planetStack.length <= 1) {
    state.homeView = "root";
  } else {
    state.planetStack.pop();
    state.homeView = state.planetStack[state.planetStack.length - 1] || "root";
  }
  showHome();
}

async function selectPlanetFile(path) {
  await selectFile(path, { fromPlanet: true });
  state.filePanel = true;
  document.querySelector(".editor-shell").classList.add("planet-file-open");
  el("home").hidden = false;
  el("viewer").hidden = state.mode !== "view";
  el("editor").hidden = state.mode !== "edit";
  renderPlanetSystem();
}

function focusExplorer() {
  document.querySelector(".app").classList.remove("sidebar-collapsed");
  const aside = document.querySelector("aside");
  const target = el("files");
  if (aside && target) aside.scrollTop += target.getBoundingClientRect().top - aside.getBoundingClientRect().top - 18;
}

function homeAction(action) {
  document.querySelector(".app").classList.remove("sidebar-collapsed");
  state.pathFilters = [];
  if (action === "hermes") el("search").value = "~/.hermes/";
  else if (action === "lifeos") el("search").value = "";
  else el("search").value = "";
  expandSearchMatches();
  renderFiles();
  focusExplorer();
}

function pushHistory(path) {
  if (state.history[state.historyIndex] === path) return;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(path);
  state.historyIndex = state.history.length - 1;
}

function updateHistoryButtons() {
  el("back").disabled = state.historyIndex <= 0;
  el("forward").disabled = state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
}

async function goHistory(delta) {
  const nextIndex = state.historyIndex + delta;
  if (nextIndex < 0 || nextIndex >= state.history.length) return;
  state.historyIndex = nextIndex;
  await selectFile(state.history[state.historyIndex], { pushHistory: false });
}

function goHub() {
  if (blockPendingExternalChange("before returning to hub")) return;
  if (state.dirty && !confirm("You have unsaved changes. Return to hub?")) return;
  collapseSidebarOnNarrow();
  state.selected = null;
  state.selectedStartupContext = null;
  state.selectedDiff = null;
  resetConflictState();
  resetExternalChangeState();
  state.savedHash = null;
  state.dirty = false;
  state.pendingMarkdown = null;
  state.activeHubCardId = null;
  state.hubSections = state.rootHubSections;
  showHome();
}

function updateHeader() {
  const file = state.selectedStartupContext
    ? { label: state.selectedStartupContext.fileName, path: state.selectedStartupContext.displayPath }
    : state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  el("title").textContent = file.label || file.path;
  el("path").textContent = state.selectedStartupContext ? file.path : "";
  el("impact").textContent = "";
  const conflict = activeFileConflict();
  const externalChange = activeExternalChange();
  const blockedByDiskChange = Boolean(conflict || externalChange);
  el("save").disabled = Boolean(state.selectedStartupContext) || blockedByDiskChange || !state.dirty || !state.selected;
  const headerSave = document.querySelector("[data-file-save]");
  if (headerSave) headerSave.disabled = Boolean(state.selectedStartupContext) || blockedByDiskChange || !state.dirty || !state.selected;
  updateActionBanner();
}

function fallbackImpact(path) {
  if (path.includes("/capture/")) return "Historical capture. Useful for finding what was learned, but not injected raw into every prompt.";
  if (path.includes("/topics/")) return "Thematic memory file. Useful when the topic returns, not automatically injected context.";
  if (path.includes("/reflections/")) return "Memory synthesis/reflection. Consult when relevant to the topic.";
  return "Memory file available for reading/editing from this interface.";
}

function updatePreview() {
  const text = activeEditor().value;
  const lines = text.split("\n").length;
  el("meta").textContent = text.length.toLocaleString("en-US") + " characters · " + lines.toLocaleString("en-US") + " lines" + (state.dirty ? " · modified" : "");
}

function setMode(mode = "view") {
  state.mode = mode === "edit" ? "edit" : "view";
  const hasSelectedFile = Boolean(state.selected || state.selectedStartupContext);
  el("viewer").style.display = hasSelectedFile && state.mode === "view" ? "block" : "";
  el("editor").style.display = hasSelectedFile && state.mode === "edit" ? "block" : "none";
  if (hasSelectedFile && state.mode === "view") renderViewer();
}

async function applyTemplateToCurrentFile() {
  if (!state.selected) return;
  if (activeEditor().value.trim() && !confirm("This editor is not empty. Apply template anyway?")) return;
  const templateId = document.querySelector("[data-empty-template-select]")?.value || "context-golden";
  const title = pathTitleFromUiPath(state.selected);
  setStatus("applying template...");
  await api("/api/markdown/apply-template", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.selected, title, templateId }),
  });
  await loadFiles();
  await selectFile(state.selected, { pushHistory: false, revealInExplorer: false });
  setStatus("template applied");
}

function pathTitleFromUiPath(relPath) {
  const name = normalizeUiPath(relPath).split("/").pop() || "New document";
  return name.replace(/\.md$/i, "").split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "New document";
}

function renderViewer() {
  const text = el("editor").value;
  const diff = state.selectedDiff || { changed: false, additions: 0, deletions: 0, patch: "", available: false };
  const readOnlyStartup = Boolean(state.selectedStartupContext);
  const conflict = activeFileConflict();
  const externalChange = activeExternalChange();
  const file = readOnlyStartup
    ? { label: state.selectedStartupContext.fileName, path: state.selectedStartupContext.displayPath }
    : state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  const hasDiff = !readOnlyStartup && diff.available !== false && diff.changed;
  const diffMarkup = hasDiff ? renderDiffPanel(diff) : "";
  const showDiffButton = hasDiff && state.diffCollapsed ? '<button class="diff-toggle" type="button" data-show-diff>Show Git diff</button>' : "";
  const canApplyTemplate = Boolean(!readOnlyStartup && state.selected?.endsWith(".md") && !text.trim());
  const actionsMarkup = readOnlyStartup
    ? ""
    : externalChange && !conflict
      ? renderExternalReviewActions(externalChange)
      : renderFileActionButtons({ hasReviewItem: selectedFileNeedsReview(), dirty: state.dirty, canApplyTemplate, blockedByConflict: Boolean(conflict || externalChange) });
  const conflictMarkup = conflict ? renderConflictPanel(conflict, text) : "";
  const editorMarkup = !conflict && externalChange
    ? renderExternalReviewDocument(state.saved || "", externalChange.diskContent || "")
    : '<textarea id="docEditor" class="doc-editor" spellcheck="false" ' + (readOnlyStartup ? 'readonly' : '') + '>' + escapeHtml(text) + '</textarea>';
  el("viewer").innerHTML = '<div class="review-workspace ' + (!hasDiff || state.diffCollapsed ? 'no-diff' : '') + '">' +
    (state.diffCollapsed ? "" : diffMarkup) +
    '<section class="file-panel">' + showDiffButton + '<header><div class="file-header-copy"><strong>' + escapeHtml(file.label || "Document") + '</strong>' + (readOnlyStartup ? '<span class="muted">' + escapeHtml(file.path) + '</span>' : '') + '</div>' + actionsMarkup + '</header>' + conflictMarkup + editorMarkup + '</section></div>';
  document.querySelector("[data-hide-diff]")?.addEventListener("click", (event) => {
    event.preventDefault();
    setDiffCollapsed(true);
  });
  document.querySelector("[data-show-diff]")?.addEventListener("click", (event) => {
    event.preventDefault();
    setDiffCollapsed(false);
  });
  document.querySelector("[data-revert-diff]")?.addEventListener("click", () => promptRevertCurrentDiff());
  document.querySelector("[data-apply-external-change]")?.addEventListener("click", () => applyExternalChange().catch((error) => setStatus(error.message)));
  document.querySelector("[data-reject-external-change]")?.addEventListener("click", () => promptRejectExternalChange());
  wireExternalReviewDecisionButtons();
  document.querySelector("[data-conflict-compare]")?.addEventListener("click", () => toggleConflictCompare());
  document.querySelector("[data-conflict-reload]")?.addEventListener("click", () => promptReloadConflictFromDisk());
  document.querySelector("[data-conflict-keep]")?.addEventListener("click", () => promptKeepConflictEdits());
  document.querySelector("[data-conflict-merge-editor]")?.addEventListener("input", (event) => {
    state.conflictMergeText = event.target.value;
    state.conflictMergeMode = "manual";
  });
  document.querySelectorAll("[data-conflict-merge-source]").forEach((button) => button.addEventListener("click", (event) => promptSaveConflictSource(event.currentTarget.dataset.conflictMergeSource)));
  wireFileActionButtons();
  const docEditor = el("docEditor");
  if (docEditor && !readOnlyStartup) {
    docEditor.addEventListener("input", () => {
      el("editor").value = docEditor.value;
      state.dirty = docEditor.value !== state.saved;
      updateHeader();
      updatePreview();
      updateConflictCompareLive(docEditor.value);
      scheduleConflictCheck();
    });
  }
  syncWorkspaceScroll();
}

function wireFileActionButtons(root = document) {
  root.querySelector("[data-file-save]")?.addEventListener("click", () => saveCurrent().catch((error) => setStatus(error.message)));
  root.querySelector("[data-file-verify]")?.addEventListener("click", () => verifyCurrentFile().catch((error) => setStatus(error.message)));
  root.querySelector("[data-file-delete]")?.addEventListener("click", () => deletePaths([state.selected]).catch((error) => setStatus(error.message)));
  root.querySelector("[data-apply-template]")?.addEventListener("click", () => applyTemplateToCurrentFile().catch((error) => setStatus(error.message)));
}

function setDiffCollapsed(collapsed) {
  const viewState = captureEditorViewState();
  state.diffCollapsed = Boolean(collapsed);
  renderViewer();
  restoreEditorViewState(viewState);
}

function wireExternalReviewDecisionButtons(root = document) {
  root.querySelectorAll("[data-external-block-decision]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chooseExternalReviewBlock(event.currentTarget.dataset.externalBlockDecision, event.currentTarget.dataset.externalBlockId).catch((error) => setStatus(error.message));
  }));
}

function renderExternalReviewActions(change) {
  const beforeText = state.saved || "";
  const afterText = change.diskContent || "";
  const blocks = buildExternalReviewBlocks(beforeText, afterText, change.reviewDecisions || {});
  const summary = summarizeExternalReviewBlocks(blocks);
  return '<div class="file-actions external-review-actions" aria-label="Review disk change">' +
    '<div class="external-change-stats" title="' + escapeHtml(change.path || "This file") + ' changed on disk"><span class="pending">' + summary.pending + ' left</span><span class="add">+' + summary.additions + '</span><span class="del">-' + summary.deletions + '</span></div>' +
  '</div>';
}

function renderExternalReviewDocument(beforeText, afterText) {
  const change = activeExternalChange();
  const blocks = buildExternalReviewBlocks(beforeText, afterText, change?.reviewDecisions || {});
  if (!blocks.some((block) => block.kind === "change")) return '<div class="doc-editor external-review-doc"><div class="diff-empty">No textual difference.</div></div>';
  return '<div class="doc-editor external-review-doc" role="document" aria-label="Document with disk changes highlighted">' +
    blocks.map((block) => renderExternalReviewBlock(block)).join("") +
  '</div>';
}

function renderExternalReviewBlock(block) {
  if (block.kind !== "change") {
    return '<div class="external-review-block context">' + block.rows.map((row) => renderExternalReviewLine(row)).join("") + '</div>';
  }
  if (block.decision) {
    const rows = externalReviewRowsForDecision(block);
    const decisionLabel = block.decision === "accept" ? "accepted" : "rejected";
    const body = rows.length ? rows.map((row) => renderExternalReviewLine(row)).join("") : '<div class="external-review-placeholder">Change ' + escapeHtml(decisionLabel) + '</div>';
    return '<div class="external-review-block context resolved ' + escapeHtml(block.decision) + (rows.length ? '' : ' empty') + '" data-external-review-block="' + escapeHtml(block.id) + '">' +
      '<span class="external-review-resolved-label">' + escapeHtml(decisionLabel) + '</span>' +
      body +
    '</div>';
  }
  const decisionClass = block.decision || "pending";
  return '<div class="external-review-block change ' + decisionClass + '" data-external-review-block="' + escapeHtml(block.id) + '">' +
    '<div class="external-review-lines">' + block.rows.map((row) => renderExternalReviewLine(row)).join("") + '</div>' +
    '<div class="external-review-block-controls" aria-label="Review this change">' +
      '<button class="file-action primary external-choice icon" type="button" data-external-block-decision="accept" data-external-block-id="' + escapeHtml(block.id) + '" title="Accept this change">OK</button>' +
      '<button class="file-action danger-action external-choice icon" type="button" data-external-block-decision="reject" data-external-block-id="' + escapeHtml(block.id) + '" title="Reject this change">x</button>' +
    '</div>' +
  '</div>';
}

function renderExternalReviewLine(row) {
  const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : " ";
  return '<div class="external-review-line ' + row.type + '"><span class="marker">' + escapeHtml(marker) + '</span><span>' + escapeHtml(row.line || " ") + '</span></div>';
}

function externalReviewRowsForDecision(block) {
  if (block.decision === "accept") return block.rows.filter((row) => row.type !== "del").map((row) => ({ type: "ctx", line: row.line }));
  if (block.decision === "reject") return block.rows.filter((row) => row.type !== "add").map((row) => ({ type: "ctx", line: row.line }));
  return block.rows;
}

function buildExternalReviewBlocks(beforeText, afterText, decisions = {}) {
  const rows = buildSimpleTextDiffRows(beforeText, afterText);
  const blocks = [];
  let current = null;
  let changeIndex = 0;
  for (const row of rows) {
    const kind = row.type === "add" || row.type === "del" ? "change" : "context";
    if (!current || current.kind !== kind) {
      const id = kind === "change" ? "change-" + changeIndex++ : "context-" + blocks.length;
      current = { id, kind, rows: [], decision: kind === "change" ? decisions[id] || null : null };
      blocks.push(current);
    }
    current.rows.push(row);
  }
  return blocks;
}

function summarizeExternalReviewBlocks(blocks) {
  return blocks.reduce((summary, block) => {
    if (block.kind === "change" && !block.decision) summary.pending += 1;
    for (const row of block.rows) {
      if (row.type === "add") summary.additions += 1;
      if (row.type === "del") summary.deletions += 1;
    }
    return summary;
  }, { pending: 0, additions: 0, deletions: 0 });
}

async function chooseExternalReviewBlock(decision, blockId) {
  const change = activeExternalChange();
  if (!change || !blockId || (decision !== "accept" && decision !== "reject")) return;
  const viewState = captureEditorViewState({ anchorBlockId: blockId });
  change.reviewDecisions = { ...(change.reviewDecisions || {}), [blockId]: decision };
  const blocks = buildExternalReviewBlocks(state.saved || "", change.diskContent || "", change.reviewDecisions);
  const pending = blocks.filter((block) => block.kind === "change" && !block.decision);
  const updatedInPlace = updateExternalReviewBlockInPlace(blocks, blockId, viewState);
  if (!updatedInPlace) renderViewer();
  restoreEditorViewState(viewState);
  updateHeader();
  updatePreview();
  if (pending.length) {
    setStatus(pending.length + " change" + (pending.length > 1 ? "s" : "") + " left to review");
    return;
  }
  setStatus("saving reviewed change...");
  if (updatedInPlace) await waitForInlineReviewTransition();
  await saveExternalReviewDecision(blocks, viewState);
}

function updateExternalReviewBlockInPlace(blocks, blockId, viewState) {
  const block = blocks.find((item) => item.id === blockId);
  const current = externalReviewBlockElement(blockId);
  if (!block || !current) return false;
  const previousHeight = current.getBoundingClientRect().height;
  current.outerHTML = renderExternalReviewBlock(block);
  const next = externalReviewBlockElement(blockId);
  if (next) {
    if (block.decision && previousHeight > 0) next.style.minHeight = Math.ceil(previousHeight) + "px";
    wireExternalReviewDecisionButtons(next);
  }
  const actions = document.querySelector(".external-review-actions");
  const change = activeExternalChange();
  if (actions && change) actions.outerHTML = renderExternalReviewActions(change);
  return true;
}

function waitForInlineReviewTransition() {
  return new Promise((resolve) => window.setTimeout(resolve, 260));
}

function externalReviewTextAnchor(blocks, blockId, mergedText) {
  if (!blockId) return null;
  const finalLines = splitMergeLines(mergedText).lines;
  let lineIndex = 0;
  for (const block of blocks) {
    const rows = block.kind === "context" ? block.rows : externalReviewRowsForDecision(block);
    if (block.id === blockId) {
      const safeLineIndex = Math.max(0, Math.min(lineIndex, Math.max(0, finalLines.length - 1)));
      const anchorRow = rows.find((row) => String(row.line || "").trim()) || rows[0] || null;
      return {
        lineIndex: safeLineIndex,
        textOffset: textOffsetForLineIndex(finalLines, safeLineIndex),
        lineText: anchorRow?.line || finalLines[safeLineIndex] || "",
      };
    }
    lineIndex += rows.length;
  }
  return null;
}

async function saveExternalReviewDecision(blocks, viewState) {
  const change = activeExternalChange();
  if (!change || state.selectedStartupContext || state.selected !== change.path) return;
  const merged = computeExternalReviewContent(blocks, state.saved || "", change.diskContent || "");
  viewState.textAnchor = externalReviewTextAnchor(blocks, viewState.anchorBlockId, merged);
  setStatus("saving reviewed changes...");
  const result = await api("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: change.path, content: merged }),
  });
  resetConflictState();
  resetExternalChangeState();
  // Returning from inline review should keep the reader in the document, not open the Git diff panel.
  state.diffCollapsed = true;
  state.saved = merged;
  state.savedHash = result.contentHash;
  state.dirty = false;
  el("editor").value = merged;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = merged;
  await loadFiles();
  if (state.selected === change.path) {
    state.selectedDiff = await api("/api/file/diff?path=" + encodeURIComponent(change.path));
    if (!finishExternalReviewPanelInPlace(viewState)) {
      renderViewer();
      restoreEditorViewState(viewState);
    }
    updateHeader();
    updatePreview();
    setStatus(result.backupPath ? "review applied · backup created" : "review applied");
  }
}

function finishExternalReviewPanelInPlace(viewState) {
  if (!document.querySelector(".external-review-doc")) return false;
  const actions = document.querySelector(".external-review-actions");
  if (!actions) return false;
  actions.outerHTML = renderFileActionButtons({
    hasReviewItem: selectedFileNeedsReview(),
    dirty: false,
    canApplyTemplate: false,
    blockedByConflict: false,
  });
  const header = document.querySelector(".file-panel header");
  if (header) wireFileActionButtons(header);
  window.setTimeout(() => settleFinishedExternalReview(viewState), 520);
  return true;
}

function settleFinishedExternalReview(viewState) {
  const doc = document.querySelector(".external-review-doc");
  if (!doc || doc.classList.contains("settled")) return;
  const blocks = [...doc.querySelectorAll(".external-review-block.resolved")];
  for (const block of blocks) {
    const startHeight = Math.ceil(block.getBoundingClientRect().height);
    block.classList.add("settling");
    block.style.height = startHeight + "px";
    block.style.minHeight = startHeight + "px";
    block.style.overflow = "hidden";
  }
  void doc.offsetHeight;
  doc.classList.add("settled");
  for (const block of blocks) {
    const targetHeight = block.classList.contains("empty") ? 0 : Math.ceil(block.scrollHeight);
    block.style.height = targetHeight + "px";
    block.style.minHeight = targetHeight + "px";
  }
  restoreEditorViewState(viewState);
  window.setTimeout(() => {
    for (const block of blocks) {
      block.classList.remove("settling");
      block.style.height = "";
      block.style.minHeight = "";
      block.style.overflow = "";
    }
    restoreEditorViewState(viewState);
  }, 2050);
}

function computeExternalReviewContent(blocks, beforeText, afterText) {
  if (blocks.every((block) => block.kind !== "change" || block.decision === "accept")) return afterText;
  if (blocks.every((block) => block.kind !== "change" || block.decision === "reject")) return beforeText;
  const lines = [];
  for (const block of blocks) {
    if (block.kind === "context") {
      lines.push(...block.rows.map((row) => row.line));
      continue;
    }
    lines.push(...externalReviewRowsForDecision(block).map((row) => row.line));
  }
  return joinMergeLines(lines, splitMergeLines(afterText).trailingNewline);
}

function renderConflictPanel(conflict, editorText) {
  const compare = state.conflictCompare ? renderConflictCompare(conflict, editorText) : "";
  return '<section class="conflict-panel">' +
    '<div><strong>File changed on disk</strong><p>This editor has unsaved changes, but the file was also changed outside Context Room. Normal save is blocked until you choose which version wins.</p></div>' +
    '<div class="conflict-actions">' +
      '<button class="file-action" type="button" data-conflict-compare>' + (state.conflictCompare ? "Hide compare" : "Compare / merge") + '</button>' +
      '<button class="file-action" type="button" data-conflict-reload>Reload from disk</button>' +
      '<button class="file-action danger-action" type="button" data-conflict-keep>Keep my edits</button>' +
    '</div>' +
    compare +
  '</section>';
}

function renderConflictCompare(conflict, editorText) {
  const mergeText = ensureConflictMergeText(conflict, editorText);
  return '<div class="conflict-compare">' +
    '<div class="conflict-card"><div class="conflict-card-head"><span>Disk vs your editor</span><small><span class="diff-line del">- disk</span> <span class="diff-line add">+ editor</span></small></div>' + renderConflictDiff(conflict.diskContent || "", editorText || "") + '</div>' +
    '<div class="conflict-card"><div class="conflict-card-head"><span>Merged result</span><small>edit, then choose a version to save</small></div><div class="conflict-merge">' +
      '<textarea data-conflict-merge-editor spellcheck="false">' + escapeHtml(mergeText) + '</textarea>' +
      '<div class="conflict-merge-actions">' +
        '<button class="file-action" type="button" data-conflict-merge-source="editor">Use editor</button>' +
        '<button class="file-action" type="button" data-conflict-merge-source="disk">Use disk</button>' +
        '<button class="file-action primary" type="button" data-conflict-merge-source="both">Use both</button>' +
      '</div>' +
    '</div></div>' +
  '</div>';
}

function renderConflictDiff(diskText, editorText) {
  const rows = compactConflictDiffRows(buildSimpleTextDiffRows(diskText, editorText));
  if (!rows.some((row) => row.type === "add" || row.type === "del")) return '<div class="diff-empty">No textual difference.</div>';
  return '<div class="conflict-diff" data-conflict-diff-root>' + rows.map((row) => {
    const marker = row.type === "add" ? "+ editor" : row.type === "del" ? "- disk" : row.type === "skip" ? "..." : " ";
    return '<div class="conflict-diff-line ' + row.type + '"><span class="marker">' + escapeHtml(marker) + '</span><span>' + escapeHtml(row.line || " ") + '</span></div>';
  }).join("") + '</div>';
}

function compactConflictDiffRows(rows, contextSize = 3) {
  const changedIndexes = rows
    .map((row, index) => (row.type === "add" || row.type === "del" ? index : -1))
    .filter((index) => index >= 0);
  if (!changedIndexes.length) return rows;
  const keep = new Set();
  for (const index of changedIndexes) {
    const from = Math.max(0, index - contextSize);
    const to = Math.min(rows.length - 1, index + contextSize);
    for (let cursor = from; cursor <= to; cursor += 1) keep.add(cursor);
  }
  const keptIndexes = [...keep].sort((a, b) => a - b);
  const compact = [];
  let previous = -1;
  for (const index of keptIndexes) {
    const skipped = index - previous - 1;
    if (skipped > 0) compact.push({ type: "skip", line: skipped + " unchanged line" + (skipped > 1 ? "s" : "") });
    compact.push(rows[index]);
    previous = index;
  }
  const trailing = rows.length - previous - 1;
  if (trailing > 0) compact.push({ type: "skip", line: trailing + " unchanged line" + (trailing > 1 ? "s" : "") });
  return compact;
}

function buildSimpleTextDiffRows(leftText, rightText) {
  const left = splitMergeLines(leftText).lines;
  const right = splitMergeLines(rightText).lines;
  const cellCount = (left.length + 1) * (right.length + 1);
  if (cellCount <= 700000) return buildLcsTextDiffRows(left, right);
  return buildPrefixSuffixTextDiffRows(left, right);
}

function buildLcsTextDiffRows(left, right) {
  const dp = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      rows.push({ type: "ctx", line: left[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", line: left[i] });
      i += 1;
    } else {
      rows.push({ type: "add", line: right[j] });
      j += 1;
    }
  }
  while (i < left.length) {
    rows.push({ type: "del", line: left[i] });
    i += 1;
  }
  while (j < right.length) {
    rows.push({ type: "add", line: right[j] });
    j += 1;
  }
  return rows;
}

function buildPrefixSuffixTextDiffRows(left, right) {
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > prefix && rightEnd > prefix && left[leftEnd - 1] === right[rightEnd - 1]) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const rows = [];
  for (const line of left.slice(0, prefix)) rows.push({ type: "ctx", line });
  for (const line of left.slice(prefix, leftEnd)) rows.push({ type: "del", line });
  for (const line of right.slice(prefix, rightEnd)) rows.push({ type: "add", line });
  for (const line of left.slice(leftEnd)) rows.push({ type: "ctx", line });
  return rows;
}

function ensureConflictMergeText(conflict, editorText) {
  const key = conflictMergeKey(conflict, editorText);
  if (state.conflictMergeText === null || (state.conflictMergeKey !== key && state.conflictMergeMode !== "manual")) {
    state.conflictMergeKey = key;
    state.conflictMergeText = buildConflictMergeTextForMode(conflict, editorText || "");
  }
  return state.conflictMergeText;
}

function buildConflictMergeTextForMode(conflict, editorText) {
  if (state.conflictMergeMode === "editor") return editorText || "";
  if (state.conflictMergeMode === "disk") return conflict.diskContent || "";
  return buildDefaultMergeText(state.saved, editorText || "", conflict.diskContent || "");
}

function updateConflictCompareLive(editorText) {
  const conflict = activeFileConflict();
  if (!conflict || !state.conflictCompare) return;
  const diffRoot = document.querySelector("[data-conflict-diff-root]");
  if (diffRoot) {
    const scrollTop = diffRoot.scrollTop;
    diffRoot.outerHTML = renderConflictDiff(conflict.diskContent || "", editorText || "");
    const nextDiffRoot = document.querySelector("[data-conflict-diff-root]");
    if (nextDiffRoot) nextDiffRoot.scrollTop = Math.min(scrollTop, Math.max(0, nextDiffRoot.scrollHeight - nextDiffRoot.clientHeight));
  }
  if (state.conflictMergeMode === "manual") return;
  const mergeEditor = document.querySelector("[data-conflict-merge-editor]");
  if (!mergeEditor) return;
  const nextMergeText = buildConflictMergeTextForMode(conflict, editorText || "");
  const wasFocused = document.activeElement === mergeEditor;
  const selectionStart = mergeEditor.selectionStart;
  const selectionEnd = mergeEditor.selectionEnd;
  state.conflictMergeText = nextMergeText;
  state.conflictMergeKey = conflictMergeKey(conflict, editorText || "");
  mergeEditor.value = nextMergeText;
  if (wasFocused && typeof selectionStart === "number" && typeof selectionEnd === "number") {
    const nextStart = Math.min(selectionStart, mergeEditor.value.length);
    const nextEnd = Math.min(selectionEnd, mergeEditor.value.length);
    mergeEditor.setSelectionRange(nextStart, nextEnd);
  }
}

function conflictMergeKey(conflict, editorText) {
  return [conflict.path || "", conflict.diskHash || "", lightweightTextHash(state.saved || ""), lightweightTextHash(editorText || "")].join("|");
}

function lightweightTextHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return text.length + ":" + (hash >>> 0).toString(36);
}

function splitMergeLines(text) {
  const value = String(text || "");
  if (!value) return { lines: [], trailingNewline: false };
  const trailingNewline = value.endsWith("\n");
  const lines = value.split("\n");
  if (trailingNewline) lines.pop();
  return { lines, trailingNewline };
}

function joinMergeLines(lines, trailingNewline = false) {
  const text = lines.join("\n");
  return text + (trailingNewline && (text || lines.length) ? "\n" : "");
}

function textOffsetForLineIndex(lines, lineIndex) {
  const safeIndex = Math.max(0, Math.min(Number(lineIndex) || 0, lines.length));
  let offset = 0;
  for (let index = 0; index < safeIndex; index += 1) offset += String(lines[index] || "").length + 1;
  return offset;
}

function changedLineRange(baseLines, nextLines) {
  let start = 0;
  while (start < baseLines.length && start < nextLines.length && baseLines[start] === nextLines[start]) start += 1;
  let baseEnd = baseLines.length;
  let nextEnd = nextLines.length;
  while (baseEnd > start && nextEnd > start && baseLines[baseEnd - 1] === nextLines[nextEnd - 1]) {
    baseEnd -= 1;
    nextEnd -= 1;
  }
  return {
    start,
    baseEnd,
    nextEnd,
    replacement: nextLines.slice(start, nextEnd),
    changed: start !== baseEnd || start !== nextEnd,
  };
}

function buildDefaultMergeText(baseText, editorText, diskText) {
  if (editorText === diskText) return editorText;
  if (baseText === editorText) return diskText;
  if (baseText === diskText) return editorText;
  const base = splitMergeLines(baseText);
  const editor = splitMergeLines(editorText);
  const disk = splitMergeLines(diskText);
  const editorChange = changedLineRange(base.lines, editor.lines);
  const diskChange = changedLineRange(base.lines, disk.lines);
  if (!editorChange.changed) return diskText;
  if (!diskChange.changed) return editorText;
  if (editorChange.baseEnd < diskChange.start || diskChange.baseEnd < editorChange.start) {
    const merged = base.lines.slice();
    const edits = [
      { ...editorChange, source: "editor" },
      { ...diskChange, source: "disk" },
    ].sort((a, b) => b.start - a.start);
    for (const edit of edits) merged.splice(edit.start, edit.baseEnd - edit.start, ...edit.replacement);
    return joinMergeLines(merged, editor.trailingNewline || disk.trailingNewline || base.trailingNewline);
  }
  if (editorChange.replacement.join("\n") === diskChange.replacement.join("\n")) {
    const merged = base.lines.slice();
    merged.splice(editorChange.start, editorChange.baseEnd - editorChange.start, ...editorChange.replacement);
    return joinMergeLines(merged, editor.trailingNewline || disk.trailingNewline || base.trailingNewline);
  }
  const start = Math.min(editorChange.start, diskChange.start);
  const end = Math.max(editorChange.baseEnd, diskChange.baseEnd);
  const merged = [
    ...base.lines.slice(0, start),
    "<<<<<<< your unsaved editor",
    ...editor.lines.slice(editorChange.start, editorChange.nextEnd),
    "=======",
    ...disk.lines.slice(diskChange.start, diskChange.nextEnd),
    ">>>>>>> current disk version",
    ...base.lines.slice(end),
  ];
  return joinMergeLines(merged, editor.trailingNewline || disk.trailingNewline || base.trailingNewline);
}

function conflictResolutionContent(source) {
  const conflict = activeFileConflict();
  if (!conflict) return { content: "", label: "merged result", title: "Save merged result" };
  const editorText = el("docEditor")?.value || el("editor").value || "";
  if (source === "editor") return { content: editorText, label: "your editor version", title: "Save editor version" };
  if (source === "disk") return { content: conflict.diskContent || "", label: "the disk version", title: "Save disk version" };
  const mergeEditor = document.querySelector("[data-conflict-merge-editor]");
  const content = state.conflictMergeMode === "manual" && mergeEditor
    ? mergeEditor.value
    : buildDefaultMergeText(state.saved, editorText, conflict.diskContent || "");
  return { content, label: "the merged result", title: "Save merged result" };
}

function hasConflictMarkers(content) {
  return /^(<<<<<<<|=======|>>>>>>>)/m.test(content);
}

function promptSaveConflictSource(source) {
  const conflict = activeFileConflict();
  if (!conflict) return;
  const normalizedSource = source === "editor" || source === "disk" || source === "both" ? source : "both";
  if (normalizedSource === "disk") {
    showConfirmDialog({
      title: "Reload disk version",
      body: "Discard your unsaved editor changes and reload the current disk version for " + conflict.path + "? Nothing will be written.",
      confirmLabel: "Reload",
      onConfirm: () => reloadConflictFromDisk(conflict.path).catch((error) => setStatus(error.message)),
    });
    return;
  }
  const resolution = conflictResolutionContent(normalizedSource);
  state.conflictMergeMode = normalizedSource;
  state.conflictMergeText = resolution.content;
  state.conflictMergeKey = conflictMergeKey(conflict, el("docEditor")?.value || el("editor").value || "");
  const mergeEditor = document.querySelector("[data-conflict-merge-editor]");
  if (mergeEditor) mergeEditor.value = resolution.content;
  if (normalizedSource === "both" && hasConflictMarkers(resolution.content)) {
    state.conflictMergeMode = "manual";
    if (!state.conflictCompare) {
      state.conflictCompare = true;
      renderViewer();
    }
    setStatus("manual merge required · edit Merged result, then click Use both again");
    return;
  }
  if (hasConflictMarkers(resolution.content)) {
    state.conflictMergeMode = "manual";
    if (!state.conflictCompare) {
      state.conflictCompare = true;
      renderViewer();
    }
    setStatus("unresolved conflict markers · remove them before saving");
    return;
  }
  showConfirmDialog({
    title: resolution.title,
    body: "Save " + resolution.label + " for " + conflict.path + "? Context Room will create a backup of the current disk version first.",
    confirmLabel: "Save",
    onConfirm: () => saveConflictMerge(resolution.content).catch((error) => setStatus(error.message)),
  });
}

function syncWorkspaceScroll() {
  const diff = document.querySelector(".diff-code");
  const editor = el("docEditor");
  if (!diff || !editor) return;
  let syncing = false;
  const mirror = (source, target) => {
    if (syncing) return;
    syncing = true;
    const sourceMax = Math.max(1, source.scrollHeight - source.clientHeight);
    const targetMax = Math.max(0, target.scrollHeight - target.clientHeight);
    target.scrollTop = targetMax * (source.scrollTop / sourceMax);
    window.requestAnimationFrame(() => { syncing = false; });
  };
  diff.addEventListener("scroll", () => mirror(diff, editor), { passive: true });
  editor.addEventListener("scroll", () => mirror(editor, diff), { passive: true });
}

function renderDiffPanel(diff) {
  const meta = "+" + diff.additions + " / -" + diff.deletions;
  const lines = diff.patch.split("\n");
  const gitMeta = lines.filter(isGitDiffMetadataLine);
  const reviewLines = lines.filter((line) => !isGitDiffMetadataLine(line));
  const rawMeta = gitMeta.length ? '<details class="diff-raw-meta"><summary title="Raw Git metadata">⋯</summary><pre>' + gitMeta.map(escapeHtml).join("\n") + '</pre></details>' : "";
  const body = rawMeta + '<pre class="diff-code">' + reviewLines.map(renderDiffLine).join("") + '</pre>';
  return '<section class="diff-panel"><div class="diff-header"><strong>Git diff</strong><div class="file-actions"><span class="diff-meta">' + escapeHtml(meta) + '</span><button class="file-action danger-action" type="button" data-revert-diff>Revert</button><button class="file-action" type="button" data-hide-diff>Hide</button></div></div>' + body + '</section>';
}

function isGitDiffMetadataLine(line) {
  return line.startsWith("diff --git") || line.startsWith("new file mode") || line.startsWith("deleted file mode") || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("@@");
}

function renderDiffLine(line) {
  let kind = "ctx";
  if (line.startsWith("+++ ") || line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("index ")) kind = "meta";
  else if (line.startsWith("@@")) kind = "hunk";
  else if (line.startsWith("+")) kind = "add";
  else if (line.startsWith("-")) kind = "del";
  return '<span class="diff-line ' + kind + '">' + escapeHtml(line || " ") + '</span>';
}

function linkifyPaths(text) {
  const targets = buildPathTargets();
  if (!targets.length) return escapeHtml(text);
  const pattern = new RegExp("(^|[^\\w~./-])(" + targets.map((target) => escapeRegExp(target.display)).join("|") + ")(?=$|[^\\w/.-])", "g");
  return escapeHtml(text).replace(pattern, (match, prefix, rawTarget) => {
    const found = targets.find((target) => target.display === rawTarget);
    if (!found) return match;
    return escapeHtml(prefix) + '<a class="path-link" href="#" data-kind="' + found.kind + '" data-target="' + escapeHtml(found.path) + '">' + escapeHtml(rawTarget) + '</a>';
  });
}

function buildPathTargets() {
  const targets = new Map();
  for (const file of state.files) {
    targets.set(file.path, { display: file.path, path: file.path, kind: "file" });
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const folder = parts.slice(0, i).join("/");
      if (!folder || folder.startsWith("~")) continue;
      targets.set(folder + "/", { display: folder + "/", path: folder, kind: "folder" });
    }
  }
  return [...targets.values()].sort((a, b) => b.display.length - a.display.length);
}

function promptRevertCurrentDiff() {
  if (!state.selected || !state.selectedDiff?.changed || state.diffCollapsed) return;
  const path = state.selected;
  const body = state.dirty
    ? "Discard the Git diff and your unsaved editor changes for " + state.selected + "? This cannot be undone."
    : "Discard the Git diff for " + state.selected + "? This cannot be undone.";
  showConfirmDialog({
    title: "Revert Git diff",
    body,
    confirmLabel: "Revert",
    onConfirm: () => revertCurrentDiff(path).catch((error) => setStatus(error.message)),
  });
}

function showConfirmDialog({ title, body, confirmLabel = "Confirm", onConfirm }) {
  document.querySelector(".confirm-backdrop")?.remove();
  const backdrop = document.createElement("div");
  backdrop.className = "confirm-backdrop";
  backdrop.innerHTML = '<section class="confirm-dialog" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
    '<strong>' + escapeHtml(title) + '</strong>' +
    '<p>' + escapeHtml(body) + '</p>' +
    '<div class="confirm-actions"><button class="file-action" type="button" data-confirm-cancel>Cancel</button><button class="file-action danger-action" type="button" data-confirm-accept>' + escapeHtml(confirmLabel) + '</button></div>' +
  '</section>';
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKeydown);
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("[data-confirm-cancel]").addEventListener("click", close);
  backdrop.querySelector("[data-confirm-accept]").addEventListener("click", () => {
    close();
    onConfirm?.();
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(backdrop);
}

async function revertCurrentDiff(path = state.selected) {
  if (state.selectedStartupContext) return;
  if (!path || state.selected !== path || !state.selectedDiff?.changed || state.diffCollapsed) return;
  setStatus("reverting diff...");
  const result = await api("/api/file/revert", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  state.dirty = false;
  await loadFiles();
  const stillExists = state.files.some((item) => item.path === path);
  if (result.deleted || !stillExists) {
    goHub();
    setStatus("diff reverted · file removed");
    return;
  }
  await selectFile(path, { pushHistory: false, revealInExplorer: false });
  setStatus(result.reverted ? "diff reverted" : "no diff to revert");
}

function activeFileConflict() {
  return state.fileConflict && state.fileConflict.path === state.selected ? state.fileConflict : null;
}

function activeExternalChange() {
  return state.externalChange && state.externalChange.path === state.selected ? state.externalChange : null;
}

function resetConflictState() {
  state.fileConflict = null;
  state.conflictCompare = false;
  state.conflictMergeText = null;
  state.conflictMergeKey = "";
  state.conflictMergeMode = "auto";
}

function resetExternalChangeState() {
  state.externalChange = null;
}

function blockPendingExternalChange(action = "before leaving") {
  if (!activeExternalChange()) return false;
  setStatus("file changed on disk · apply or reject " + action);
  renderViewer();
  updateHeader();
  return true;
}

function scheduleConflictCheck() {
  if (!state.selected || state.selectedStartupContext || !state.dirty) return;
  window.clearTimeout(state.conflictCheckTimer);
  state.conflictCheckTimer = window.setTimeout(() => checkSelectedFileConflict().catch((error) => setStatus(error.message)), 250);
}

async function checkSelectedFileConflict() {
  if (!state.selected || state.selectedStartupContext || !state.dirty) return false;
  const path = state.selected;
  const [data, diff] = await Promise.all([
    api("/api/file?path=" + encodeURIComponent(path)),
    api("/api/file/diff?path=" + encodeURIComponent(path)),
  ]);
  if (state.selected !== path || !state.dirty) return false;
  if (data.contentHash === state.savedHash) {
    if (activeFileConflict() || activeExternalChange()) {
      resetConflictState();
      resetExternalChangeState();
      renderViewer();
      updateHeader();
      updatePreview();
    }
    return false;
  }
  const existingConflict = activeFileConflict();
  if (existingConflict && existingConflict.diskHash === data.contentHash && existingConflict.diskContent === data.content) {
    state.selectedDiff = diff;
    updateHeader();
    updatePreview();
    setStatus("file changed on disk · resolve conflict before saving");
    return true;
  }
  state.fileConflict = {
    path,
    diskContent: data.content,
    diskHash: data.contentHash,
    diskUpdatedAt: data.updatedAt || "",
  };
  state.conflictMergeText = null;
  state.conflictMergeKey = "";
  state.conflictMergeMode = "auto";
  state.selectedDiff = diff;
  renderViewer();
  updateHeader();
  updatePreview();
  setStatus("file changed on disk · resolve conflict before saving");
  return true;
}

async function applyExternalChange() {
  const change = activeExternalChange();
  if (!change || state.selectedStartupContext || state.selected !== change.path) return;
  if (state.dirty && activeEditor().value !== state.saved && !confirm("Discard your unsaved editor changes and apply the disk version?")) return;
  const viewState = captureEditorViewState();
  resetConflictState();
  resetExternalChangeState();
  state.saved = change.diskContent;
  state.savedHash = change.diskHash;
  state.dirty = false;
  el("editor").value = change.diskContent;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = change.diskContent;
  await loadFiles();
  if (state.selected === change.path) {
    state.selectedDiff = await api("/api/file/diff?path=" + encodeURIComponent(change.path));
    renderViewer();
    restoreEditorViewState(viewState);
    updateHeader();
    updatePreview();
    setStatus("disk change applied");
  }
}

function promptRejectExternalChange() {
  const change = activeExternalChange();
  if (!change) return;
  const unsavedNote = state.dirty && activeEditor().value !== state.saved ? " Any unsaved editor edits will be discarded." : "";
  showConfirmDialog({
    title: "Reject disk change",
    body: "Restore the version Context Room was showing before the disk change for " + change.path + "? A backup of the current disk version will be created." + unsavedNote,
    confirmLabel: "Reject change",
    onConfirm: () => rejectExternalChange(change.path).catch((error) => setStatus(error.message)),
  });
}

async function rejectExternalChange(path) {
  const change = activeExternalChange();
  if (!change || state.selectedStartupContext || state.selected !== path) return;
  setStatus("rejecting disk change...");
  const viewState = captureEditorViewState();
  const result = await api("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content: state.saved }),
  });
  resetConflictState();
  resetExternalChangeState();
  state.savedHash = result.contentHash;
  state.dirty = false;
  el("editor").value = state.saved;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = state.saved;
  await loadFiles();
  if (state.selected === path) {
    state.selectedDiff = await api("/api/file/diff?path=" + encodeURIComponent(path));
    renderViewer();
    restoreEditorViewState(viewState);
    updateHeader();
    updatePreview();
    setStatus(result.backupPath ? "disk change rejected · backup created" : "disk change rejected");
  }
}

function toggleConflictCompare() {
  if (!activeFileConflict()) return;
  state.conflictCompare = !state.conflictCompare;
  renderViewer();
}

function promptReloadConflictFromDisk() {
  const conflict = activeFileConflict();
  if (!conflict) return;
  showConfirmDialog({
    title: "Reload from disk",
    body: "Discard your unsaved editor changes and load the current disk version for " + conflict.path + "?",
    confirmLabel: "Reload",
    onConfirm: () => reloadConflictFromDisk(conflict.path).catch((error) => setStatus(error.message)),
  });
}

async function reloadConflictFromDisk(path) {
  if (!activeFileConflict() || state.selected !== path) return;
  resetConflictState();
  state.dirty = false;
  await selectFile(path, { pushHistory: false, revealInExplorer: false, forceReload: true });
  setStatus("reloaded from disk");
}

function promptKeepConflictEdits() {
  const conflict = activeFileConflict();
  if (!conflict) return;
  showConfirmDialog({
    title: "Keep my edits",
    body: "Overwrite the current disk version with your editor buffer for " + conflict.path + "? Context Room will create a backup of the disk version first.",
    confirmLabel: "Keep my edits",
    onConfirm: () => saveCurrent({ forceConflict: true }).catch((error) => setStatus(error.message)),
  });
}

async function saveConflictMerge(merged) {
  const conflict = activeFileConflict();
  if (!conflict) return;
  if (hasConflictMarkers(merged)) {
    state.conflictCompare = true;
    state.conflictMergeMode = "manual";
    state.conflictMergeText = merged;
    renderViewer();
    setStatus("save blocked · unresolved conflict markers");
    return;
  }
  el("editor").value = merged;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = merged;
  state.dirty = true;
  await saveCurrent({ forceConflict: true });
}

async function saveCurrent(options = {}) {
  if (state.selectedStartupContext) {
    setStatus("startup context is read-only");
    return;
  }
  if (!state.selected) return;
  const conflict = activeFileConflict();
  if (conflict && !options.forceConflict) {
    state.conflictCompare = true;
    renderViewer();
    updateHeader();
    setStatus("file changed on disk · choose reload or keep my edits");
    return;
  }
  const externalChange = activeExternalChange();
  if (externalChange && !options.forceExternalChange) {
    renderViewer();
    updateHeader();
    setStatus("file changed on disk · apply or reject before saving");
    return;
  }
  setStatus("saving...");
  const viewState = captureEditorViewState();
  const content = activeEditor().value;
  const result = await api("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.selected, content }),
  });
  state.saved = content;
  state.savedHash = result.contentHash;
  state.dirty = false;
  resetConflictState();
  resetExternalChangeState();
  await loadFiles();
  renderViewer();
  restoreEditorViewState(viewState);
  setStatus(result.backupPath ? "saved · backup created" : "saved");
  updateHeader();
}

async function refreshFromDisk() {
  const previousSelected = state.selected;
  try {
    const [filesData, docqa, doctor, settingsData, startupData] = await Promise.all([api("/api/files"), api("/api/docqa"), api("/api/doctor"), api("/api/settings"), api("/api/startup-context")]);
    state.files = filesData.files;
    state.startupContextFiles = startupData.files || [];
    state.docqa = docqa;
    state.doctor = doctor;
    if (!state.settingsOpen) {
      state.settings = settingsData.settings;
      state.availableHubCards = settingsData.availableHubCards || [];
      state.hubFolders = settingsData.hubCards || [];
      state.rootHubSections = settingsData.hubSections || [];
      state.hubSections = state.rootHubSections;
    }
    renderFiles();
    if (state.settingsOpen) {
      updateActionBanner();
      return;
    }
    if (!state.selected) renderDocQaDashboard();
    else updateHeader();

    if (!previousSelected || previousSelected !== state.selected || state.selectedStartupContext) return;
    const [data, diff] = await Promise.all([
      api("/api/file?path=" + encodeURIComponent(previousSelected)),
      api("/api/file/diff?path=" + encodeURIComponent(previousSelected)),
    ]);
    if (state.dirty) {
      await checkSelectedFileConflict();
      return;
    }
    if (data.contentHash === state.savedHash) {
      if (activeExternalChange()) {
        resetExternalChangeState();
        state.selectedDiff = diff;
        renderViewer();
        updateHeader();
        updatePreview();
      }
      return;
    }
    const existingExternalChange = activeExternalChange();
    if (existingExternalChange && existingExternalChange.diskHash === data.contentHash && existingExternalChange.diskContent === data.content) {
      state.selectedDiff = diff;
      updateHeader();
      updatePreview();
      return;
    }
    const viewState = captureEditorViewState();
    resetConflictState();
    state.externalChange = {
      path: previousSelected,
      diskContent: data.content,
      diskHash: data.contentHash,
      diskUpdatedAt: data.updatedAt || "",
      reviewDecisions: {},
    };
    state.selectedDiff = diff;
    state.diffCollapsed = true;
    renderViewer();
    restoreEditorViewState(viewState);
    updateHeader();
    updatePreview();
    setStatus("file changed on disk · review before applying");
  } catch (error) {
    setStatus(error.message);
  }
}

function setStatus(text) { el("status").textContent = text; }
function activeEditor() { return el("docEditor") || el("editor"); }
function isScrollableY(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
}
function activeDocumentScrollTarget() {
  const documentSurface = document.querySelector(".external-review-doc") || el("docEditor");
  if (isScrollableY(documentSurface)) return documentSurface;
  if (isScrollableY(el("viewer"))) return el("viewer");
  return documentSurface || el("viewer");
}
function externalReviewBlockElement(blockId) {
  if (!blockId) return null;
  return document.querySelector('[data-external-review-block="' + cssEscape(blockId) + '"]');
}
function scrollableParentForElement(element) {
  let current = element?.parentElement;
  while (current && current !== document.body) {
    const style = window.getComputedStyle(current);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return activeDocumentScrollTarget() || el("viewer");
}
function shiftScrollForElement(element, delta) {
  if (!element || Math.abs(delta) < 0.5) return;
  const scroller = scrollableParentForElement(element);
  if (scroller && scroller !== document.body && scroller !== document.documentElement) scroller.scrollTop += delta;
  else window.scrollBy(0, delta);
}
function isSaveShortcut(event) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && String(event.key || "").toLowerCase() === "s";
}
function handleSaveShortcut(event) {
  if (!isSaveShortcut(event)) return false;
  if (state.page !== "file" || !state.selected || state.selectedStartupContext) return false;
  event.preventDefault();
  if (activeExternalChange()) {
    setStatus("file changed on disk · apply or reject before saving");
    renderViewer();
    updateHeader();
    return true;
  }
  if (!state.dirty) {
    setStatus("no changes to save");
    return true;
  }
  saveCurrent().catch((error) => setStatus(error.message));
  return true;
}
function captureEditorViewState(options = {}) {
  const editor = activeEditor();
  const viewer = el("viewer");
  const documentScrollTarget = activeDocumentScrollTarget();
  const anchor = externalReviewBlockElement(options.anchorBlockId);
  return {
    path: state.selected,
    editorId: editor?.id || "",
    anchorBlockId: options.anchorBlockId || "",
    anchorTop: anchor ? anchor.getBoundingClientRect().top : null,
    documentScrollTarget: documentScrollTarget?.classList?.contains("external-review-doc") ? "external-review-doc" : documentScrollTarget?.id || "",
    documentScrollTop: documentScrollTarget?.scrollTop || 0,
    documentScrollLeft: documentScrollTarget?.scrollLeft || 0,
    editorScrollTop: editor?.scrollTop || 0,
    editorScrollLeft: editor?.scrollLeft || 0,
    viewerScrollTop: viewer?.scrollTop || 0,
    viewerScrollLeft: viewer?.scrollLeft || 0,
    windowScrollX: window.scrollX || 0,
    windowScrollY: window.scrollY || 0,
    selectionStart: typeof editor?.selectionStart === "number" ? editor.selectionStart : null,
    selectionEnd: typeof editor?.selectionEnd === "number" ? editor.selectionEnd : null,
    focused: document.activeElement === editor,
  };
}
function restoreEditorViewState(snapshot) {
  if (!snapshot || snapshot.path !== state.selected) return;
  const apply = () => {
    const editor = snapshot.textAnchor ? (el("docEditor") || activeEditor()) : (snapshot.editorId ? el(snapshot.editorId) : activeEditor());
    const viewer = el("viewer");
    const documentScrollTarget = (snapshot.documentScrollTarget === "external-review-doc"
      ? document.querySelector(".external-review-doc")
      : snapshot.documentScrollTarget === "docEditor"
        ? el("docEditor")
        : null) || activeDocumentScrollTarget();
    if (documentScrollTarget) {
      documentScrollTarget.scrollTop = snapshot.documentScrollTop || 0;
      documentScrollTarget.scrollLeft = snapshot.documentScrollLeft || 0;
    }
    if (viewer) {
      viewer.scrollTop = snapshot.viewerScrollTop || 0;
      viewer.scrollLeft = snapshot.viewerScrollLeft || 0;
    }
    window.scrollTo(snapshot.windowScrollX || 0, snapshot.windowScrollY || 0);
    const anchor = externalReviewBlockElement(snapshot.anchorBlockId);
    if (anchor && typeof snapshot.anchorTop === "number") shiftScrollForElement(anchor, anchor.getBoundingClientRect().top - snapshot.anchorTop);
    if (!editor) return;
    const restoredTextAnchor = scrollEditorToTextAnchor(editor, snapshot);
    if (!restoredTextAnchor) editor.scrollTop = snapshot.editorScrollTop || 0;
    editor.scrollLeft = snapshot.editorScrollLeft || 0;
    if (!restoredTextAnchor && typeof snapshot.selectionStart === "number" && typeof snapshot.selectionEnd === "number" && typeof editor.setSelectionRange === "function") {
      const start = Math.min(snapshot.selectionStart, editor.value.length);
      const end = Math.min(snapshot.selectionEnd, editor.value.length);
      editor.setSelectionRange(start, end);
    }
    if (snapshot.focused) {
      try { editor.focus({ preventScroll: true }); }
      catch { editor.focus(); }
    }
  };
  apply();
  window.requestAnimationFrame(() => {
    apply();
    window.requestAnimationFrame(apply);
  });
  window.setTimeout(apply, 0);
}

function scrollEditorToTextAnchor(editor, snapshot) {
  const anchor = snapshot?.textAnchor;
  if (!editor || !anchor || typeof editor.value !== "string") return false;
  const value = editor.value;
  let offset = Math.max(0, Math.min(Number(anchor.textOffset) || 0, value.length));
  const lineText = String(anchor.lineText || "");
  if (lineText) {
    const searchStart = Math.max(0, offset - 2000);
    const found = value.indexOf(lineText, searchStart);
    if (found >= 0 && found <= offset + 2000) offset = found;
  }
  const lineIndex = value.slice(0, offset).split("\n").length - 1;
  const style = window.getComputedStyle(editor);
  const fontSize = Number.parseFloat(style.fontSize) || 15;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.7;
  const rect = editor.getBoundingClientRect();
  const desiredTop = typeof snapshot.anchorTop === "number"
    ? Math.max(24, Math.min(editor.clientHeight * 0.68, snapshot.anchorTop - rect.top))
    : editor.clientHeight * 0.36;
  editor.scrollTop = Math.max(0, lineIndex * lineHeight - desiredTop);
  if (typeof editor.setSelectionRange === "function") {
    const caret = Math.max(0, Math.min(offset, value.length));
    editor.setSelectionRange(caret, caret);
  }
  return true;
}
function escapeHtml(value) { return String(value).replace(/[&<>"]/g, (ch) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[ch])); }
function escapeRegExp(value) { return String(value).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&"); }
function cssEscape(value) { return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/(["\\])/g, "\\$1"); }

el("editor").addEventListener("input", () => {
  state.dirty = el("editor").value !== state.saved;
  updateHeader();
  updatePreview();
  if (state.mode === "view") renderViewer();
});
el("search").addEventListener("input", () => { state.pathFilters = []; expandSearchMatches(); renderFiles(); });
el("clearSearch").addEventListener("click", () => clearExplorerFilter());
document.querySelectorAll("[data-watch-filter]").forEach((button) => button.addEventListener("click", () => setExplorerWatchFilter(button.dataset.watchFilter)));
document.querySelector("aside")?.addEventListener("contextmenu", openExplorerEmptyContextMenu);
document.addEventListener("click", (event) => {
  const menu = el("explorerContextMenu");
  if (!menu || menu.hidden || menu.contains(event.target)) return;
  hideExplorerContextMenu();
});
document.addEventListener("click", (event) => {
  const picker = document.querySelector("[data-path-picker]");
  if (!picker || picker.contains(event.target)) return;
  togglePathPickerMenu(false);
});
document.addEventListener("keydown", (event) => {
  if (handleSaveShortcut(event)) return;
  if (event.key === "Escape") {
    hideExplorerContextMenu();
    togglePathPickerMenu(false);
  }
});
el("sidebarToggle").addEventListener("click", () => {
  state.mobileSidebarTouched = true;
  const app = document.querySelector(".app");
  app.classList.toggle("sidebar-collapsed");
  if (window.matchMedia("(max-width: 640px)").matches && !app.classList.contains("sidebar-collapsed")) app.classList.add("explorer-expanded");
  else app.classList.remove("explorer-expanded");
  syncSidebarToggleIcon();
});
el("explorerOpen")?.addEventListener("click", () => {
  state.mobileSidebarTouched = true;
  const app = document.querySelector(".app");
  app.classList.remove("sidebar-collapsed");
  if (window.matchMedia("(max-width: 640px)").matches) app.classList.add("explorer-expanded");
  syncSidebarToggleIcon();
});
el("refreshDocQa")?.addEventListener("click", () => loadFiles().catch((error) => setStatus(error.message)));
document.querySelectorAll("[data-home-action]").forEach((button) => button.addEventListener("click", () => homeAction(button.dataset.homeAction)));
document.querySelectorAll("[data-home-file]").forEach((button) => button.addEventListener("click", () => selectFile(button.dataset.homeFile).catch((error) => setStatus(error.message))));
el("back").addEventListener("click", () => goHistory(-1).catch((error) => setStatus(error.message)));
el("forward").addEventListener("click", () => goHistory(1).catch((error) => setStatus(error.message)));
el("hub").addEventListener("click", () => handleHubAction());
el("verifyCurrent").addEventListener("click", () => verifyCurrentFile().catch((error) => setStatus(error.message)));
el("deleteCurrent").addEventListener("click", () => deletePaths([state.selected]).catch((error) => setStatus(error.message)));
el("watchSelected").addEventListener("click", () => addSelectedToWatch().catch((error) => setStatus(error.message)));
el("unwatchSelected").addEventListener("click", () => removeSelectedFromWatch().catch((error) => setStatus(error.message)));
el("clearSelection").addEventListener("click", () => clearDeleteSelection());
el("deleteSelected").addEventListener("click", () => deletePaths([...state.selectedForDelete]).catch((error) => setStatus(error.message)));
el("save").addEventListener("click", () => saveCurrent().catch((error) => setStatus(error.message)));
el("reload").addEventListener("click", () => {
  if (blockPendingExternalChange("before reloading")) return;
  if (state.dirty && !confirm("Discard unsaved editor changes and reload this file from disk?")) return;
  state.dirty = false;
  selectFile(state.selected, { pushHistory: false, fromPlanet: state.filePanel, forceReload: true }).catch((error) => setStatus(error.message));
});
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
syncResponsiveSidebar({ force: true });
window.addEventListener("resize", () => syncResponsiveSidebar());
setMode("view");
loadFiles().catch((error) => setStatus(error.message));
window.setInterval(() => refreshFromDisk(), 2200);
</script>
</body>
</html>`;
}

if (process.argv[1] === __filename) {
  const portArgIndex = process.argv.indexOf("--port");
  const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : DEFAULT_PORT;
  const rootArgIndex = process.argv.indexOf("--root");
  const root = rootArgIndex >= 0 ? path.resolve(process.argv[rootArgIndex + 1]) : process.cwd();
  const { server } = createMemoryServer({ root, port });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Context Room: http://127.0.0.1:${port}`);
    console.log(`Root: ${root}`);
  });
}
