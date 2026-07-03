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
const DOCQA_REVIEW_BASELINES = `${CONFIG_DIR}/review-baselines`;
const COLLAB_SESSION_STATE = `${CONFIG_DIR}/session-state.json`;
const COLLAB_AGENT_COMMAND = `${CONFIG_DIR}/agent-command.json`;
const COLLAB_AGENT_ANNOTATIONS = `${CONFIG_DIR}/agent-annotations.json`;
const MEMORY_WEBAPP_SETTINGS = CONFIG_FILE;
const HERMES_CRON_JOBS_FILE = "~/.hermes/cron/jobs.json";
const HERMES_CRON_JOBS_FOLDER = "~/.hermes/cron/jobs/";
const HERMES_CRON_MD_FOLDER = "~/.hermes/cron/jobs-md/";
const DEFAULT_STARTUP_CONTEXT = { enabled: false, fileNames: ["AGENTS.md", "CLAUDE.md"] };
const DEFAULT_STARTUP_SKILLS = { enabled: true, folderNames: [".codex/skills", "skills"] };
export const FILE_THEME_OPTIONS = [
  { id: "context-room", label: "Context Room", description: "Default dark theme" },
  { id: "vscode-dark", label: "VS Code Dark", description: "Quiet editor contrast" },
  { id: "github-dark", label: "GitHub Dark", description: "Clear docs contrast" },
  { id: "dracula", label: "Dracula", description: "High color structure" },
  { id: "solarized-dark", label: "Solarized Dark", description: "Soft long-read palette" },
  { id: "light-plus", label: "Light Plus", description: "Bright document surface" },
];
const DEFAULT_FILE_THEME = "context-room";
export const DOCUMENTATION_BEST_PRACTICES = [
  "One file, one clear scope: name what this document is responsible for and what belongs elsewhere.",
  "Start with the goal, then the few durable facts that change decisions.",
  "Keep sections stable and short; prefer links to source files over copied truth.",
  "Use explicit rules for agents and humans: what to do, avoid, verify, or ask.",
  "Update or delete stale context instead of accumulating contradictory prose.",
];
export const DEFAULT_MARKDOWN_TEMPLATES = [
  {
    id: "blank",
    title: "Blank",
    description: "Start with an empty Markdown file.",
    content: "",
  },
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
  const settings = effectiveMemoryWebappSettings(root);
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

export function listMemoryFiles(root = process.cwd(), { externalRoots = [] } = {}) {
  const baseSettings = effectiveMemoryWebappSettings(root);
  const activeRepoRoots = sanitizePathList((externalRoots || []).filter((item) => !normalizeRelPath(String(item || "")).startsWith("~")))
    .map((item) => item.endsWith("/") ? item : item + "/");
  const activeExternalRoots = sanitizeExternalPathList(externalRoots || []);
  const settings = activeRepoRoots.length || activeExternalRoots.length
    ? {
        ...baseSettings,
        allowedPaths: activeRepoRoots.length ? appendUniquePaths(baseSettings.allowedPaths || [], activeRepoRoots) : baseSettings.allowedPaths,
        externalAllowedPaths: activeExternalRoots.length ? appendUniquePaths(baseSettings.externalAllowedPaths || [], activeExternalRoots) : baseSettings.externalAllowedPaths,
      }
    : baseSettings;
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
      const found = stats.isDirectory() ? walkExternalTextFiles(externalPath, externalPath, normalizeRelPath(prefix).replace(/\/$/, "") + "/", settings) : [normalizeRelPath(prefix)];
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
      for (const rel of walkExternalTextFiles(absDir, absDir, prefix, settings)) {
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
  for (const prefix of sanitizeExternalPathList(externalRoots)) {
    const clean = normalizeRelPath(prefix).replace(/\/$/, "");
    if (!isAllowedExternalFolderPath(clean, settings) && !isAllowedMemoryPath(clean, settings)) continue;
    const absDir = resolveExternalPath(clean);
    if (!absDir || !fs.existsSync(absDir)) continue;
    const stats = fs.statSync(absDir);
    const found = stats.isDirectory() ? walkExternalTextFiles(absDir, absDir, clean + "/", settings) : [clean];
    for (const rel of found) {
      if (byPath.has(rel) || !isAllowedMemoryPath(rel, settings)) continue;
      byPath.set(rel, {
        path: rel,
        label: path.basename(rel),
        category: categoryForPath(rel),
      });
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
        explorerPath: memoryPathForAbsolutePath(root, item.abs),
        kind: "startup-context",
      },
    };
  });
}

export function readStartupContextFile(root = process.cwd(), order = 0, settings = readMemoryWebappSettings(root)) {
  const found = resolveStartupContextFile(root, order, settings);
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

export function writeStartupContextFile(root = process.cwd(), order = 0, content = "", settings = readMemoryWebappSettings(root)) {
  const found = resolveStartupContextFile(root, order, settings);
  if (!found) throw new Error(`Startup context file not found: ${order}`);
  return writeAbsoluteStartupFile(found.startupContext.absolutePath, content, publicStartupContextFile(found).startupContext);
}

export function deleteStartupContextFile(root = process.cwd(), order = 0, settings = readMemoryWebappSettings(root)) {
  const found = resolveStartupContextFile(root, order, settings);
  if (!found) throw new Error(`Startup context file not found: ${order}`);
  const startupContext = publicStartupContextFile(found).startupContext;
  const abs = path.resolve(found.startupContext.absolutePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Startup context file not found: ${startupContext.displayPath}`);
  if (path.extname(abs).toLowerCase() !== ".md") throw new Error(`Only Markdown startup context files can be deleted: ${startupContext.displayPath}`);
  const backupRel = buildBackupPath(startupContext.displayPath);
  const backupAbs = path.join(root, backupRel);
  fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
  fs.copyFileSync(abs, backupAbs);
  fs.unlinkSync(abs);
  return { order: startupContext.order, path: startupContext.displayPath, deleted: true, backupPath: backupRel, startupContext };
}

export function listStartupSkillFolders(root = process.cwd(), settings = readMemoryWebappSettings(root)) {
  const config = normalizeStartupSkillSettings(settings.startupSkills);
  if (!config.enabled) return [];
  const resolvedRoot = path.resolve(root);
  const dirs = ancestorDirsForRoot(resolvedRoot);
  const found = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const folderName of config.folderNames) {
      const abs = path.join(dir, folderName);
      if (seen.has(abs) || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
      seen.add(abs);
      found.push({ abs, dir, folderName, skills: startupSkillNamesInFolder(abs), readOnly: false });

      for (const nested of startupSkillNamespaceFolders(abs, folderName)) {
        if (seen.has(nested.abs)) continue;
        seen.add(nested.abs);
        found.push({ ...nested, dir, readOnly: true });
      }
    }
  }
  return found.map((item, index) => ({
    order: index + 1,
    folderName: item.folderName,
    absolutePath: item.abs,
    displayPath: displayPath(item.abs),
    skillCount: item.skills.length,
    skills: item.skills.slice(0, 60),
    readOnly: Boolean(item.readOnly),
  }));
}

function startupSkillNamesInFolder(abs) {
  const entries = fs.readdirSync(abs, { withFileTypes: true });
  const skills = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && fs.existsSync(path.join(abs, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "fr"));
  const looseFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md")
    .map((entry) => entry.name.replace(/\.md$/i, ""))
    .sort((a, b) => a.localeCompare(b, "fr"));
  return [...new Set([...skills, ...looseFiles])];
}

function startupSkillNamespaceFolders(abs, folderName) {
  return fs.readdirSync(abs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("."))
    .map((entry) => {
      const nestedAbs = path.join(abs, entry.name);
      return {
        abs: nestedAbs,
        folderName: `${folderName}/${entry.name}`,
        skills: startupSkillNamesInFolder(nestedAbs),
      };
    })
    .filter((item) => item.skills.length)
    .sort((a, b) => a.folderName.localeCompare(b.folderName, "fr"));
}

function effectiveMemoryWebappSettings(root = process.cwd()) {
  const settings = readMemoryWebappSettings(root);
  return withStartupSkillExternalPaths(root, settings);
}

function withStartupSkillExternalPaths(root, settings = defaultMemoryWebappSettings()) {
  const startupSkillPaths = startupSkillExternalAllowedPaths(root, settings);
  return {
    ...settings,
    externalAllowedPaths: appendUniquePaths(settings.externalAllowedPaths || [], startupSkillPaths),
  };
}

function startupSkillExternalAllowedPaths(root, settings = readMemoryWebappSettings(root)) {
  return listStartupSkillFolders(root, settings).flatMap((folder) => {
    const folderRoot = path.resolve(folder.absolutePath);
    return (folder.skills || []).map((skillName) => {
      const skillDir = path.resolve(folderRoot, skillName);
      const skillFile = path.resolve(folderRoot, `${skillName}.md`);
      if (fs.existsSync(path.join(skillDir, "SKILL.md"))) {
        const memoryPath = memoryPathForAbsolutePath(root, skillDir) + "/";
        return memoryPath.startsWith("~/") ? memoryPath : null;
      }
      if (fs.existsSync(skillFile)) {
        const memoryPath = memoryPathForAbsolutePath(root, skillFile);
        return memoryPath.startsWith("~/") ? memoryPath : null;
      }
      return null;
    }).filter(Boolean);
  });
}

function startupSkillExplorerRootPath(root = process.cwd(), folderOrder = 0, skillName = "", settings = readMemoryWebappSettings(root)) {
  const { folder, requestedName, abs } = resolveStartupSkillFile(root, folderOrder, skillName, settings);
  if (path.basename(abs) !== "SKILL.md") return memoryPathForAbsolutePath(root, abs);
  return memoryPathForAbsolutePath(root, path.join(folder.absolutePath, requestedName)) + "/";
}

function startupContextExplorerPath(root = process.cwd(), order = 0, settings = readMemoryWebappSettings(root)) {
  const found = resolveStartupContextFile(root, order, settings);
  if (!found?.startupContext?.absolutePath) return "";
  return memoryPathForAbsolutePath(root, found.startupContext.absolutePath);
}

function memoryPathForAbsolutePath(root, absPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absPath);
  if (resolvedPath === resolvedRoot) return "";
  if (resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return path.relative(resolvedRoot, resolvedPath).replaceAll(path.sep, "/");
  return displayPath(resolvedPath);
}

export function readStartupSkillFile(root = process.cwd(), folderOrder = 0, skillName = "", settings = readMemoryWebappSettings(root)) {
  const { folder, requestedName, abs } = resolveStartupSkillFile(root, folderOrder, skillName, settings);
  const stats = fs.statSync(abs);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${displayPath(abs)}`);
  const content = fs.readFileSync(abs, "utf8");
  const fileName = path.basename(abs) === "SKILL.md" ? `${requestedName}/SKILL.md` : path.basename(abs);
  return {
    label: path.basename(abs),
    path: displayPath(abs),
    content,
    exists: true,
    updatedAt: stats.mtime.toISOString(),
    chars: content.length,
    contentHash: hashContent(content),
    startupContext: {
      order: `${folder.order}:${requestedName}`,
      fileName,
      displayPath: displayPath(abs),
      explorerPath: memoryPathForAbsolutePath(root, abs),
      kind: "startup-skill",
      folder: folder.displayPath,
      skillName: requestedName,
      explorerRoot: startupSkillExplorerRootPath(root, folder.order, requestedName, settings).replace(/\/$/, ""),
    },
  };
}

export function writeStartupSkillFile(root = process.cwd(), folderOrder = 0, skillName = "", content = "", settings = readMemoryWebappSettings(root)) {
  const { folder, requestedName, abs } = resolveStartupSkillFile(root, folderOrder, skillName, settings);
  if (folder.readOnly) throw new Error(`Startup skill folder is read-only: ${folder.displayPath}`);
  const fileName = path.basename(abs) === "SKILL.md" ? `${requestedName}/SKILL.md` : path.basename(abs);
  return writeAbsoluteStartupFile(abs, content, {
    order: `${folder.order}:${requestedName}`,
    fileName,
    displayPath: displayPath(abs),
    explorerPath: memoryPathForAbsolutePath(root, abs),
    kind: "startup-skill",
    folder: folder.displayPath,
    skillName: requestedName,
    explorerRoot: startupSkillExplorerRootPath(root, folder.order, requestedName, settings).replace(/\/$/, ""),
  });
}

export function createStartupSkillFile(root = process.cwd(), folderOrder = 0, skillName = "", settings = readMemoryWebappSettings(root)) {
  const normalizedOrder = Number(folderOrder);
  const folder = listStartupSkillFolders(root, settings).find((item) => item.order === normalizedOrder);
  if (!folder) throw new Error(`Startup skill folder not found: ${folderOrder}`);
  if (folder.readOnly) throw new Error(`Startup skill folder is read-only: ${folder.displayPath}`);
  const requestedName = normalizeStartupSkillName(skillName);
  const folderAbs = path.resolve(folder.absolutePath);
  const skillDir = path.resolve(folderAbs, requestedName);
  if (!skillDir.startsWith(`${folderAbs}${path.sep}`)) throw new Error(`Startup skill path escapes folder: ${skillName}`);
  if (fs.existsSync(skillDir) || fs.existsSync(`${skillDir}.md`)) throw new Error(`Startup skill already exists: ${requestedName}`);
  fs.mkdirSync(skillDir, { recursive: false });
  const abs = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(abs, startupSkillTemplate(requestedName), "utf8");
  return readStartupSkillFile(root, normalizedOrder, requestedName, settings);
}

export function deleteStartupSkill(root = process.cwd(), folderOrder = 0, skillName = "", settings = readMemoryWebappSettings(root)) {
  const { folder, requestedName, abs } = resolveStartupSkillFile(root, folderOrder, skillName, settings);
  if (folder.readOnly) throw new Error(`Startup skill folder is read-only: ${folder.displayPath}`);
  const folderAbs = path.resolve(folder.absolutePath);
  const resolvedAbs = path.resolve(abs);
  if (!resolvedAbs.startsWith(`${folderAbs}${path.sep}`)) throw new Error(`Startup skill path escapes folder: ${skillName}`);
  const skillDir = path.resolve(folderAbs, requestedName);
  const isDirectorySkill = path.basename(resolvedAbs) === "SKILL.md" && path.dirname(resolvedAbs) === skillDir;
  const backupSourceAbs = isDirectorySkill ? skillDir : resolvedAbs;
  const backupRel = buildBackupPath(displayPath(backupSourceAbs));
  const backupAbs = path.join(root, backupRel);
  fs.mkdirSync(path.dirname(backupAbs), { recursive: true });
  if (isDirectorySkill) {
    fs.cpSync(backupSourceAbs, backupAbs, { recursive: true, errorOnExist: false });
    fs.rmSync(skillDir, { recursive: true, force: false });
  } else {
    fs.copyFileSync(resolvedAbs, backupAbs);
    fs.unlinkSync(resolvedAbs);
  }
  return { folder: folder.order, skillName: requestedName, deleted: true, backupPath: backupRel };
}

function normalizeStartupSkillName(skillName) {
  const clean = String(skillName || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!clean) throw new Error("Skill name is required");
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(clean) || isBlockedPath(clean)) throw new Error(`Invalid startup skill name: ${skillName}`);
  return clean;
}

function startupSkillTemplate(skillName) {
  return `---\nname: ${skillName}\ndescription: Describe when agents should use this skill.\n---\n\n# ${skillName}\n\n## Use when\n\n- \n\n## Goal\n\n\n## Do\n\n1. \n\n## Validate\n\n- \n\n## Stop when\n\n- \n\n## Output\n\n- \n\n## Anti-patterns\n\n- \n`;
}

function resolveStartupContextFile(root, order, settings = readMemoryWebappSettings(root)) {
  const normalizedOrder = Number(order);
  return listStartupContextFiles(root, settings).find((file) => file.startupContext.order === normalizedOrder);
}

function resolveStartupSkillFile(root, folderOrder, skillName, settings = readMemoryWebappSettings(root)) {
  const normalizedOrder = Number(folderOrder);
  const requestedName = path.basename(String(skillName || "").trim());
  const folder = listStartupSkillFolders(root, settings).find((item) => item.order === normalizedOrder);
  if (!folder || !requestedName || !folder.skills.includes(requestedName)) throw new Error(`Startup skill not found: ${skillName}`);
  const folderAbs = path.resolve(folder.absolutePath);
  const candidates = [
    path.join(folderAbs, requestedName, "SKILL.md"),
    path.join(folderAbs, `${requestedName}.md`),
  ];
  const abs = candidates.find((candidate) => {
    const resolved = path.resolve(candidate);
    return (resolved === folderAbs || resolved.startsWith(`${folderAbs}${path.sep}`)) && fs.existsSync(resolved) && fs.statSync(resolved).isFile();
  });
  if (!abs) throw new Error(`Startup skill file not found: ${skillName}`);
  return { folder, requestedName, abs };
}

function writeAbsoluteStartupFile(absPath, content, startupContext) {
  if (typeof content !== "string") throw new Error("Content must be a string");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
    throw new Error("Content is too large for the local context room");
  }
  const abs = path.resolve(absPath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`Startup file not found: ${displayPath(abs)}`);
  validateEditableContent(startupContext.fileName || path.basename(abs), content);
  fs.writeFileSync(abs, content, "utf8");
  const stats = fs.statSync(abs);
  return {
    label: path.basename(abs),
    path: displayPath(abs),
    exists: true,
    backupPath: null,
    bytes: stats.size,
    chars: content.length,
    updatedAt: stats.mtime.toISOString(),
    contentHash: hashContent(content),
    startupContext,
  };
}

function ancestorDirsForRoot(root) {
  const dirs = [];
  let current = path.resolve(root);
  while (current && current !== path.dirname(current)) {
    dirs.push(current);
    current = path.dirname(current);
  }
  dirs.push(path.parse(path.resolve(root)).root);
  return [...new Set(dirs)].reverse();
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
      explorerPath: file.startupContext.explorerPath,
      kind: "startup-context",
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
  const settings = effectiveMemoryWebappSettings(root);
  const alreadyAllowed = isAllowedMemoryPath(normalized, settings);
  const abs = alreadyAllowed ? resolveMemoryPath(root, normalized) : resolveCreatableRepoPath(root, normalized);
  if (fs.existsSync(abs)) throw new Error(`Markdown file already exists: ${normalized}`);
  if (!alreadyAllowed) allowCreatedMemoryPath(root, normalized);
  const content = applyTemplate ? renderMarkdownTemplateForPath(root, normalized, { title, templateId, metadata }) : "";
  return writeMemoryFile(root, normalized, content);
}

export function createFolder(root, { path: relPath } = {}) {
  const settings = effectiveMemoryWebappSettings(root);
  const normalized = normalizeRelPath(String(relPath || "")).replace(/\/$/, "");
  if (!normalized) throw new Error("Folder path is required");
  const alreadyAllowed = isAllowedFolderPath(normalized, settings);
  const abs = alreadyAllowed ? resolveMemoryFolderPath(root, normalized, settings) : resolveCreatableRepoPath(root, normalized);
  if (fs.existsSync(abs)) throw new Error(`Folder already exists: ${normalized}`);
  if (!alreadyAllowed) allowCreatedMemoryPath(root, normalized + "/");
  fs.mkdirSync(abs, { recursive: true });
  return { path: normalized + "/", existed: false };
}

function allowCreatedMemoryPath(root, relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  const settings = readMemoryWebappSettings(root);
  const allowedPaths = appendUniquePath(settings.allowedPaths || [], normalized);
  const watchAllow = appendUniquePath(settings.watchAllow || [], normalized);
  writeMemoryWebappSettings(root, { ...settings, allowedPaths, watchAllow });
}

function appendUniquePath(list, relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  return [...new Set([...(list || []).map((item) => normalizeRelPath(item)), normalized])].filter(Boolean);
}

function appendUniquePaths(list, relPaths = []) {
  return [...new Set([...(list || []), ...(relPaths || [])].map((item) => normalizeRelPath(String(item || ""))))].filter(Boolean);
}

function resolveCreatableRepoPath(root, relPath) {
  const normalized = normalizeRelPath(String(relPath || "")).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) {
    throw new Error(`Path escapes repository root: ${relPath}`);
  }
  if (normalized.startsWith("~")) throw new Error(`External paths cannot be created from the explorer: ${relPath}`);
  if (isBlockedPath(normalized) || hasSkippedPathSegment(normalized)) throw new Error(`Path not allowed in context room: ${relPath}`);
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, normalized);
  if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path escapes repository root: ${relPath}`);
  return abs;
}

function resolveMemoryFolderPath(root, relPath, settings = effectiveMemoryWebappSettings(root)) {
  const normalized = normalizeRelPath(String(relPath || "")).replace(/\/$/, "");
  if (!isAllowedFolderPath(normalized, settings)) throw new Error(`Path not allowed in context room: ${relPath}`);
  const external = resolveExternalPath(normalized);
  if (external) return external;
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, normalized);
  if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path escapes repository root: ${relPath}`);
  return abs;
}

function hasSkippedPathSegment(relPath) {
  return normalizeRelPath(relPath).split("/").some((part) => SKIP_DIRS.has(part));
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

export function renderExplorerContextMenuMarkup({ targetPath = "", directory = "", selectionCount = 1, templates = DEFAULT_MARKDOWN_TEMPLATES, settings = defaultMemoryWebappSettings() } = {}) {
  const normalizedTarget = normalizeRelPath(String(targetPath || ""));
  const cleanDirectory = normalizeRelPath(String(directory || "")).replace(/\/$/, "");
  const directoryLabel = cleanDirectory || "project root";
  const markdownDirectory = cleanDirectory;
  const markdownDirectoryLabel = markdownDirectory || "project root";
  const selectionLabel = selectionCount > 1 ? `${selectionCount} selected` : (normalizedTarget || directoryLabel);
  const defaultFolderPath = defaultFolderPathForDirectory(cleanDirectory);
  const createActions = '<button class="secondary" type="button" data-context-new-file>New file</button>' +
    '<button class="secondary" type="button" data-context-new-folder>New folder</button>';
  const targetActions = normalizedTarget
    ? '<button class="secondary" type="button" data-context-watch>Watch</button>' +
      createActions +
      '<button class="secondary" type="button" data-context-select>Select</button>' +
      '<button class="secondary danger-action" type="button" data-context-delete>Delete</button>'
    : createActions;
  return '<div class="explorer-context-title"><span>Actions</span><code>' + escapeHtmlServer(selectionLabel) + '</code></div>' +
    '<div class="explorer-context-actions menu-actions" data-context-action-list>' +
      targetActions +
    '</div>' +
    '<div class="explorer-context-form" data-context-new-file-form hidden>' +
      '<div class="explorer-context-title"><span>New file</span><code>' + escapeHtmlServer(markdownDirectoryLabel) + '</code></div>' +
      '<label class="explorer-context-label" for="contextMarkdownTitle">Name</label>' +
      '<input id="contextMarkdownTitle" placeholder="File name" value="New document" />' +
      '<div id="contextMarkdownError" class="explorer-context-error" hidden></div>' +
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
  const settings = effectiveMemoryWebappSettings(root);
  const deleted = [];
  const uniquePaths = [...new Set(relPaths.map((item) => normalizeRelPath(String(item || ""))).filter(Boolean))];
  for (const relPath of uniquePaths) {
    const normalized = relPath.replace(/\/$/, "");
    if (isCronJobMarkdownPath(normalized)) {
      const result = deleteCronJobMarkdownFile(root, normalized);
      if (result.deleted) deleted.push(normalized);
      continue;
    }
    if (isAllowedExternalPath(normalized, settings)) {
      const abs = resolveExternalPath(normalized);
      if (!abs || !fs.existsSync(abs)) continue;
      const stats = fs.statSync(abs);
      if (stats.isFile()) {
        fs.unlinkSync(abs);
        deleted.push(normalized);
        continue;
      }
      if (!stats.isDirectory()) throw new Error(`Not a file or folder: ${relPath}`);
      const prefix = externalPrefixForPath(normalized, settings);
      const baseDir = resolveExternalPath(prefix);
      if (!prefix || !baseDir) throw new Error(`Path not allowed in context room: ${relPath}`);
      const files = walkExternalTextFiles(abs, baseDir, prefix, settings).filter((file) => isAllowedMemoryPath(file, settings));
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

export function readReviewBaseFile(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) throw new Error("Path is required");
  if (resolveExternalPath(normalized)) {
    const file = readMemoryFile(root, normalized);
    return {
      path: normalized,
      baseContent: "",
      currentContent: file.content,
      currentHash: file.contentHash,
      changeKind: "external",
      available: false,
      reason: "Inline Git review is unavailable for files outside the repo.",
    };
  }
  const current = readMemoryFile(root, normalized);
  const review = readDocReviewState(root).reviews[normalized] || null;
  const reviewBaseline = readDocReviewBaseline(root, normalized, review);
  if (reviewBaseline) {
    const baselineHash = hashContent(reviewBaseline.content);
    const currentHash = current.contentHash;
    const changeKind = baselineHash === currentHash ? "unchanged" : current.exists ? "modified" : "deleted";
    return {
      path: normalized,
      baseContent: reviewBaseline.content,
      currentContent: current.content,
      currentHash,
      changeKind,
      available: true,
      baseline: "review",
      baselineHash,
    };
  }
  try {
    const statusLine = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", normalized], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").find(Boolean) || "";
    if (!statusLine) {
      return { path: normalized, baseContent: current.content, currentContent: current.content, currentHash: current.contentHash, changeKind: "unchanged", available: true };
    }
    if (statusLine.startsWith("?? ")) {
      return { path: normalized, baseContent: "", currentContent: current.content, currentHash: current.contentHash, changeKind: "added", available: true };
    }
    const treePath = gitTreePathForRootRelative(root, normalized);
    let baseContent = "";
    let trackedInHead = true;
    try {
      baseContent = execFileSync("git", ["show", "HEAD:" + treePath], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_FILE_BYTES + 64_000 });
    } catch {
      trackedInHead = false;
    }
    const statusCode = statusLine.slice(0, 2);
    const changeKind = !trackedInHead ? "added" : statusCode.includes("D") && !current.exists ? "deleted" : "modified";
    return { path: normalized, baseContent, currentContent: current.content, currentHash: current.contentHash, changeKind, available: true };
  } catch {
    return {
      path: normalized,
      baseContent: current.content,
      currentContent: current.content,
      currentHash: current.contentHash,
      changeKind: "unknown",
      available: false,
      reason: "Git base is unavailable for this file.",
    };
  }
}

function gitTreePathForRootRelative(root, normalized) {
  const prefix = gitRepoPrefixForRoot(root);
  return normalizeRelPath((prefix || "") + normalized);
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

function writeDocReviewState(root, state) {
  const statePath = path.join(root, DOCQA_REVIEW_STATE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function reviewBaselinePathFor(relPath) {
  return path.posix.join(DOCQA_REVIEW_BASELINES, backupSafePath(normalizeRelPath(relPath)) + ".baseline");
}

function writeDocReviewBaselineFile(root, relPath, content) {
  const baselinePath = reviewBaselinePathFor(relPath);
  const abs = path.join(root, baselinePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, String(content || ""), "utf8");
  return {
    baselinePath,
    baselineHash: hashContent(content),
    baselineAt: new Date().toISOString(),
  };
}

function readDocReviewBaseline(root, relPath, review = null) {
  const baselinePath = normalizeRelPath(review?.baselinePath || "");
  if (!baselinePath || !baselinePath.startsWith(DOCQA_REVIEW_BASELINES + "/")) return null;
  const abs = path.join(root, baselinePath);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  const content = fs.readFileSync(abs, "utf8");
  const baselineHash = hashContent(content);
  if (review?.baselineHash && review.baselineHash !== baselineHash) return null;
  return { path: baselinePath, content, contentHash: baselineHash };
}

export function writeDocReviewBaseline(root, relPath, { note = "" } = {}) {
  const normalized = normalizeRelPath(relPath);
  const state = readDocReviewState(root);
  const file = readMemoryFile(root, normalized);
  const existing = state.reviews[normalized] && typeof state.reviews[normalized] === "object" ? state.reviews[normalized] : {};
  const baseline = writeDocReviewBaselineFile(root, normalized, file.content);
  const next = {
    ...existing,
    baselinePath: baseline.baselinePath,
    baselineHash: baseline.baselineHash,
    baselineAt: baseline.baselineAt,
  };
  if (note) next.note = String(note || "").slice(0, 500);
  state.reviews[normalized] = next;
  writeDocReviewState(root, state);
  return { path: normalized, ...next };
}

export function writeDocReviewDecision(root, relPath, { status, note = "" } = {}) {
  const normalized = normalizeRelPath(relPath);
  const allowedStatuses = new Set(["verified", "needs_changes", "snoozed"]);
  const state = readDocReviewState(root);
  const file = readMemoryFile(root, normalized);
  if (status === "unverified") {
    delete state.reviews[normalized];
    writeDocReviewState(root, state);
    return { path: normalized, status: "unverified", note: "", reviewedAt: new Date().toISOString(), contentHash: hashContent(file.content) };
  }
  if (!allowedStatuses.has(status)) throw new Error(`Invalid review status: ${status}`);
  const baseline = writeDocReviewBaselineFile(root, normalized, file.content);
  const decision = {
    status,
    note: String(note || "").slice(0, 500),
    reviewedAt: new Date().toISOString(),
    contentHash: hashContent(file.content),
    baselinePath: baseline.baselinePath,
    baselineHash: baseline.baselineHash,
    baselineAt: baseline.baselineAt,
  };
  state.reviews[normalized] = decision;
  writeDocReviewState(root, state);
  return { path: normalized, ...decision };
}

export function readCollaborationSessionState(root = process.cwd()) {
  const statePath = path.join(root, COLLAB_SESSION_STATE);
  const fallback = defaultCollaborationSessionState(root);
  if (!fs.existsSync(statePath)) return fallback;
  try {
    const sanitized = sanitizeCollaborationSessionState(JSON.parse(fs.readFileSync(statePath, "utf8")));
    return { ...fallback, ...Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== undefined)) };
  } catch {
    return fallback;
  }
}

export function writeCollaborationSessionState(root = process.cwd(), next = {}) {
  const state = { ...sanitizeCollaborationSessionState(next), root: path.resolve(root) };
  const statePath = path.join(root, COLLAB_SESSION_STATE);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  return state;
}

export function readAgentCommand(root = process.cwd()) {
  const commandPath = path.join(root, COLLAB_AGENT_COMMAND);
  if (!fs.existsSync(commandPath)) return { command: null };
  try {
    const command = sanitizeAgentCommand(root, JSON.parse(fs.readFileSync(commandPath, "utf8")));
    return { command };
  } catch {
    return { command: null };
  }
}

export function writeAgentCommand(root = process.cwd(), next = {}) {
  const command = sanitizeAgentCommand(root, {
    ...next,
    id: next.id || "cmd-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    createdAt: next.createdAt || new Date().toISOString(),
    source: next.source || "agent",
  });
  const commandPath = path.join(root, COLLAB_AGENT_COMMAND);
  fs.mkdirSync(path.dirname(commandPath), { recursive: true });
  fs.writeFileSync(commandPath, JSON.stringify(command, null, 2) + "\n", "utf8");
  return command;
}

export function readAgentAnnotations(root = process.cwd(), relPath = "") {
  const annotationPath = path.join(root, COLLAB_AGENT_ANNOTATIONS);
  const state = readJsonFile(annotationPath, { version: 1, annotations: [] });
  const annotations = Array.isArray(state.annotations) ? state.annotations.map(sanitizeAgentAnnotation).filter(Boolean) : [];
  const normalized = normalizeRelPath(String(relPath || ""));
  return {
    version: 1,
    annotations: normalized ? annotations.filter((item) => item.path === normalized) : annotations,
  };
}

export function appendAgentAnnotation(root = process.cwd(), next = {}) {
  const annotation = sanitizeAgentAnnotation({
    ...next,
    id: next.id || "ann-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
    createdAt: next.createdAt || new Date().toISOString(),
    source: next.source || "agent",
    resolved: false,
  });
  if (!annotation) throw new Error("Invalid annotation");
  const settings = readMemoryWebappSettings(root);
  if (!isAllowedMemoryPath(annotation.path, settings)) throw new Error(`Path not allowed in context room: ${annotation.path}`);
  const annotationPath = path.join(root, COLLAB_AGENT_ANNOTATIONS);
  const state = readJsonFile(annotationPath, { version: 1, annotations: [] });
  const annotations = Array.isArray(state.annotations) ? state.annotations.map(sanitizeAgentAnnotation).filter(Boolean) : [];
  annotations.push(annotation);
  fs.mkdirSync(path.dirname(annotationPath), { recursive: true });
  fs.writeFileSync(annotationPath, JSON.stringify({ version: 1, annotations }, null, 2) + "\n", "utf8");
  return annotation;
}

export function resolveAgentAnnotation(root = process.cwd(), { id = "", path: relPath = "" } = {}) {
  const annotationPath = path.join(root, COLLAB_AGENT_ANNOTATIONS);
  const state = readJsonFile(annotationPath, { version: 1, annotations: [] });
  const normalizedPath = normalizeRelPath(String(relPath || ""));
  const annotations = Array.isArray(state.annotations) ? state.annotations.map(sanitizeAgentAnnotation).filter(Boolean) : [];
  let resolved = null;
  const nextAnnotations = annotations.map((annotation) => {
    if (annotation.id !== id || (normalizedPath && annotation.path !== normalizedPath)) return annotation;
    resolved = { ...annotation, resolved: true, resolvedAt: new Date().toISOString() };
    return resolved;
  });
  if (!resolved) throw new Error(`Annotation not found: ${id}`);
  fs.mkdirSync(path.dirname(annotationPath), { recursive: true });
  fs.writeFileSync(annotationPath, JSON.stringify({ version: 1, annotations: nextAnnotations }, null, 2) + "\n", "utf8");
  return resolved;
}

export function buildAgentReviewQueue(root = process.cwd()) {
  const report = buildDocQaReport(root);
  return {
    generatedAt: report.generatedAt,
    summary: report.summary,
    queue: report.queue.map((item) => ({
      path: item.path,
      label: item.label,
      gitStatus: item.gitStatus,
      riskScore: item.riskScore,
      issues: item.issues,
      review: item.review || null,
    })),
    note: "Read-only queue. Human verification must happen in the Context Room webapp.",
  };
}

function defaultCollaborationSessionState(root) {
  return {
    version: 1,
    root: path.resolve(root),
    updatedAt: null,
    source: "context-room",
    page: "unknown",
    view: "unknown",
    openFile: null,
    selectedPath: null,
    visibleHeading: null,
    scrollPercent: 0,
    pendingMiniDiffs: 0,
    gitDiffOpen: false,
    diffCollapsed: true,
    explorerFilter: "all",
    pathFilters: [],
    selectedReview: null,
    dirty: false,
    mode: "view",
    status: "No active webapp session state has been published yet.",
  };
}

function sanitizeCollaborationSessionState(next = {}) {
  return {
    version: 1,
    root: shortString(next.root, 1000) || undefined,
    updatedAt: next.updatedAt || new Date().toISOString(),
    source: shortString(next.source, 80) || "webapp",
    page: shortString(next.page, 40) || "unknown",
    view: shortString(next.view || next.page, 40) || "unknown",
    openFile: nullablePath(next.openFile),
    selectedPath: nullablePath(next.selectedPath),
    visibleHeading: nullableString(next.visibleHeading, 240),
    scrollPercent: clampNumber(next.scrollPercent, 0, 100),
    pendingMiniDiffs: Math.max(0, Math.floor(Number(next.pendingMiniDiffs) || 0)),
    gitDiffOpen: Boolean(next.gitDiffOpen),
    diffCollapsed: next.diffCollapsed !== false,
    explorerFilter: ["all", "watched", "unwatched"].includes(next.explorerFilter) ? next.explorerFilter : "all",
    pathFilters: Array.isArray(next.pathFilters) ? next.pathFilters.map(nullablePath).filter(Boolean).slice(0, 20) : [],
    selectedReview: nullablePath(next.selectedReview),
    dirty: Boolean(next.dirty),
    mode: next.mode === "edit" ? "edit" : "view",
    status: nullableString(next.status, 300),
  };
}

function sanitizeAgentCommand(root, next = {}) {
  const action = ["navigate", "open", "scroll", "highlight"].includes(next.action) ? next.action : "navigate";
  const view = ["hub", "settings", "file", "diff"].includes(next.view) ? next.view : (next.path ? "file" : "hub");
  const normalizedPath = nullablePath(next.path);
  if (normalizedPath) {
    const settings = readMemoryWebappSettings(root);
    if (!isAllowedMemoryPath(normalizedPath, settings)) throw new Error(`Path not allowed in context room: ${normalizedPath}`);
  }
  const targetType = ["heading", "text", "percent"].includes(next.targetType || next.target?.type) ? (next.targetType || next.target?.type) : "";
  const targetValue = next.targetValue ?? next.target?.value ?? "";
  return {
    version: 1,
    id: shortString(next.id, 120) || "cmd-" + Date.now().toString(36),
    source: shortString(next.source, 80) || "agent",
    createdAt: next.createdAt || new Date().toISOString(),
    action,
    view,
    path: normalizedPath,
    target: targetType ? { type: targetType, value: targetType === "percent" ? clampNumber(targetValue, 0, 100) : shortString(targetValue, 500) } : null,
    highlight: next.highlight !== false,
    message: nullableString(next.message, 300),
  };
}

function sanitizeAgentAnnotation(next = {}) {
  const normalizedPath = nullablePath(next.path);
  const note = shortString(next.note, 1000);
  if (!normalizedPath || !note) return null;
  const targetType = ["heading", "text", "file"].includes(next.targetType) ? next.targetType : (next.target ? "text" : "file");
  return {
    version: 1,
    id: shortString(next.id, 120) || "ann-" + Date.now().toString(36),
    source: shortString(next.source, 80) || "agent",
    createdAt: next.createdAt || new Date().toISOString(),
    path: normalizedPath,
    targetType,
    target: nullableString(next.target, 500),
    note,
    resolved: Boolean(next.resolved),
    resolvedAt: next.resolvedAt || null,
  };
}

function readJsonFile(absPath, fallback) {
  if (!fs.existsSync(absPath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(absPath, "utf8"));
  } catch {
    return fallback;
  }
}

function nullablePath(value) {
  const normalized = normalizeRelPath(String(value || ""));
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return null;
  return shortString(normalized, 1000);
}

function nullableString(value, max = 500) {
  const text = shortString(value, max);
  return text || null;
}

function shortString(value, max = 500) {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
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
  for (const relPath of settings.reviewPaths || []) {
    const covered = (settings.allowedPaths || []).some((allowed) => pathMatchesSetting(relPath, allowed) || pathMatchesSetting(allowed, relPath));
    if (!covered) issues.push({ type: "review_not_allowed", severity: "high", message: `Review path is not covered by allowedPaths: ${relPath}.` });
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
      appearance: settings.appearance,
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
    const reviewRequired = isRequiredReviewPath(file.path, settings);
    const abs = resolveExternalPath(file.path) || path.join(root, file.path);
    const content = file.exists && fs.existsSync(abs) && file.bytes <= MAX_FILE_BYTES ? fs.readFileSync(abs, "utf8") : "";
    const metadata = parseDocMetadata(content, file.path);
    const issues = computeDocIssues({ path: file.path, content, gitStatus, metadata });
    const riskScore = riskScoreFor({ classification, issues, gitStatus });
    const review = currentReviewFor(reviewState.reviews, file.path, content);
    return { path: file.path, label: file.label, summary: file.summary, updatedAt: file.updatedAt, classification, metadata, gitStatus, reviewRequired, issues, riskScore, review };
  }).filter((item) => item.gitStatus.trim() || item.reviewRequired
  ).filter((item) => isWatchedPath(item.path, settings) || item.reviewRequired
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
      requiredReview: queue.filter((item) => item.reviewRequired && !item.gitStatus.trim()).length,
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
    reviewPaths: [],
    integrations: { hermes: false },
    appearance: { fileTheme: DEFAULT_FILE_THEME, autoOpenGitDiff: true },
    startupContext: { ...DEFAULT_STARTUP_CONTEXT },
    startupSkills: { ...DEFAULT_STARTUP_SKILLS },
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
  ensureRuntimeGitExcludes(root);
  return { config: saved, configPath: path.join(root, MEMORY_WEBAPP_SETTINGS) };
}

export function ensureRuntimeGitExcludes(root = process.cwd()) {
  const excludePath = gitInfoExcludePath(root);
  if (!excludePath) return { updated: false, path: null };
  const prefix = gitRootRelativePrefix(root);
  const entries = [
    ".context-room/review-state.json",
    ".context-room/session-state.json",
    ".context-room/agent-command.json",
    ".context-room/agent-annotations.json",
    ".context-room/review-baselines/",
    ".context-room/memory-webapp-backups/",
  ].map((entry) => prefix + entry);
  const marker = "# Context Room runtime state";
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
  const missing = entries.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (!missing.length) return { updated: false, path: excludePath };
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const newlinePrefix = existing.endsWith("\n") || !existing ? "" : "\n";
  const markerLine = existing.includes(marker) ? "" : marker + "\n";
  fs.appendFileSync(excludePath, newlinePrefix + markerLine + missing.join("\n") + "\n", "utf8");
  return { updated: true, path: excludePath, entries: missing };
}

function gitInfoExcludePath(root) {
  try {
    const excludePath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return excludePath || null;
  } catch {
    return null;
  }
}

function gitRootRelativePrefix(root) {
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const rel = normalizeRelPath(path.relative(topLevel, path.resolve(root)));
    return rel && rel !== "." ? rel.replace(/\/$/, "") + "/" : "";
  } catch {
    return "";
  }
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
    reviewPaths: sanitizePathList(raw.reviewPaths ?? base.reviewPaths ?? []),
    integrations: { hermes: Boolean(raw.integrations?.hermes ?? base.integrations?.hermes ?? false) },
    appearance: normalizeAppearanceSettings(raw.appearance ?? base.appearance),
    startupContext: normalizeStartupContextSettings(raw.startupContext ?? base.startupContext),
    startupSkills: normalizeStartupSkillSettings(raw.startupSkills ?? base.startupSkills),
    bestPractices: sanitizeTextList(raw.bestPractices ?? base.bestPractices ?? DOCUMENTATION_BEST_PRACTICES),
    markdownTemplates: sanitizeMarkdownTemplates(raw.markdownTemplates ?? base.markdownTemplates ?? DEFAULT_MARKDOWN_TEMPLATES),
    hubCards,
    customHubCards,
    hubSections,
  };
}

function normalizeAppearanceSettings(value = {}) {
  const allowed = new Set(FILE_THEME_OPTIONS.map((theme) => theme.id));
  const fileTheme = String(value.fileTheme || DEFAULT_FILE_THEME).trim();
  return {
    fileTheme: allowed.has(fileTheme) ? fileTheme : DEFAULT_FILE_THEME,
    autoOpenGitDiff: value.autoOpenGitDiff !== false,
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

function normalizeStartupSkillSettings(value = {}) {
  const rawFolderNames = Array.isArray(value.folderNames) ? value.folderNames : DEFAULT_STARTUP_SKILLS.folderNames;
  const folderNames = [...new Set(rawFolderNames
    .map((item) => normalizeRelPath(String(item || "")).replace(/\/$/, ""))
    .filter((item) => item && !item.startsWith("../") && !item.includes("/../") && !path.isAbsolute(item) && !isBlockedPath(item))
  )];
  return {
    enabled: value.enabled !== false,
    folderNames: folderNames.length ? folderNames : [...DEFAULT_STARTUP_SKILLS.folderNames],
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
  const rawContent = typeof template.content === "string" ? template.content : "";
  const content = rawContent.trim() ? rawContent.trimEnd() + "\n" : "";
  if (!id || !title || (!content.trim() && id !== "blank")) return null;
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

function sanitizeExternalPathList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeRelPath(String(item || ""))).filter((item) => item && item.startsWith("~/") && !item.includes("/../") && !isBlockedPath(item)))];
}

function isWatchedPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath);
  return settings.watchAllow.some((pattern) => pathMatchesSetting(normalized, pattern));
}

function isRequiredReviewPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath);
  return (settings.reviewPaths || []).some((pattern) => pathMatchesSetting(normalized, pattern));
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
    const startupSkillFolder = url.searchParams.get("startupSkillFolder") || "";
    const startupSkill = url.searchParams.get("startupSkill") || "";
    const startupContextOrder = url.searchParams.get("startupContextOrder") || "";
    const externalRoots = [];
    if (startupSkillFolder && startupSkill) externalRoots.push(startupSkillExplorerRootPath(root, startupSkillFolder, startupSkill));
    if (startupContextOrder) externalRoots.push(startupContextExplorerPath(root, startupContextOrder));
    sendJson(res, 200, { files: listMemoryFiles(root, { externalRoots }), root });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/startup-context") {
    sendJson(res, 200, { files: listStartupContextFiles(root).map(publicStartupContextFile), root });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/startup-skills") {
    sendJson(res, 200, { folders: listStartupSkillFolders(root), root });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/startup-skills/create") {
    const body = await readJsonBody(req);
    sendJson(res, 200, createStartupSkillFile(root, body.folder, body.skill));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/startup-skills/delete") {
    const body = await readJsonBody(req);
    sendJson(res, 200, deleteStartupSkill(root, body.folder, body.skill));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/startup-skills/file") {
    const folder = url.searchParams.get("folder") || "";
    const skill = url.searchParams.get("skill") || "";
    sendJson(res, 200, readStartupSkillFile(root, folder, skill));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/startup-skills/file") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeStartupSkillFile(root, body.folder, body.skill, body.content));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/startup-context/file") {
    const order = url.searchParams.get("order") || "";
    sendJson(res, 200, readStartupContextFile(root, order));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/startup-context/file") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeStartupContextFile(root, body.order, body.content));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/startup-context/delete") {
    const body = await readJsonBody(req);
    sendJson(res, 200, deleteStartupContextFile(root, body.order));
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
  if (req.method === "GET" && (url.pathname === "/api/session-state" || url.pathname === "/api/agent/state")) {
    sendJson(res, 200, readCollaborationSessionState(root));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/session-state") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeCollaborationSessionState(root, body));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/review-queue") {
    sendJson(res, 200, buildAgentReviewQueue(root));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/command") {
    sendJson(res, 200, readAgentCommand(root));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/command") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { command: writeAgentCommand(root, body) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/agent/annotations") {
    sendJson(res, 200, readAgentAnnotations(root, url.searchParams.get("path") || ""));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/annotations") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { annotation: appendAgentAnnotation(root, body) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/agent/annotations/resolve") {
    const body = await readJsonBody(req);
    sendJson(res, 200, { annotation: resolveAgentAnnotation(root, { id: body.id, path: body.path }) });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/docqa/review") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeDocReviewDecision(root, body.path, { status: body.status, note: body.note }));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/docqa/review-baseline") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeDocReviewBaseline(root, body.path, { note: body.note }));
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
  if (req.method === "GET" && url.pathname === "/api/file/review-base") {
    const relPath = url.searchParams.get("path") || "";
    sendJson(res, 200, readReviewBaseFile(root, relPath));
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

function walkExternalTextFiles(dir, baseDir, virtualPrefix, settings = defaultMemoryWebappSettings()) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkExternalTextFiles(abs, baseDir, virtualPrefix, settings));
    } else if (entry.isFile()) {
      const rel = virtualPrefix + path.relative(baseDir, abs).replaceAll(path.sep, "/");
      if (isAllowedMemoryPath(rel, settings)) results.push(rel);
    }
  }
  return results;
}

function isAllowedFolderPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  if (normalized.startsWith("~")) return isAllowedExternalFolderPath(normalized, settings);
  const allowed = sanitizePathList(settings.allowedPaths || ALLOWED_PREFIXES);
  return allowed.some((prefix) => {
    const clean = prefix.replace(/\/$/, "");
    return normalized === clean || normalized.startsWith(clean + "/");
  });
}

function isAllowedExternalPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  return Boolean(externalPrefixForPath(normalized, settings));
}

function isAllowedExternalMemoryPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath);
  if (!resolveExternalPath(normalized)) return false;
  if (normalized.startsWith("~/.hermes/")) {
    return Boolean(settings.integrations?.hermes) && ALLOWED_EXTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }
  const allowed = sanitizeExternalPathList(settings.externalAllowedPaths || []);
  return allowed.some((pattern) => pathMatchesSetting(normalized, pattern));
}

function isAllowedExternalFolderPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  if (normalized.startsWith("~/.hermes/")) {
    return Boolean(settings.integrations?.hermes) && ALLOWED_EXTERNAL_PREFIXES.some((prefix) => pathMatchesSetting(normalized, prefix));
  }
  const allowed = sanitizeExternalPathList(settings.externalAllowedPaths || []);
  return allowed.some((pattern) => pathMatchesSetting(normalized, pattern) || pathMatchesSetting(pattern, normalized));
}

function externalPrefixForPath(relPath, settings = defaultMemoryWebappSettings()) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  const prefixes = [...ALLOWED_EXTERNAL_PREFIXES, ...sanitizeExternalPathList(settings.externalAllowedPaths || [])];
  return prefixes.find((prefix) => {
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
  if (relPath.startsWith("~/")) return path.join(osHome(), relPath.slice(2));
  return null;
}

function getHermesHome() {
  return process.env.HERMES_HOME ? path.resolve(process.env.HERMES_HOME) : path.join(osHome(), ".hermes");
}

function osHome() {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function backupSafePath(relPath) {
  return relPath.replace(/^~\/\.hermes\//, "external/hermes/").replace(/^~\//, "external/home/");
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

export function renderFileActionButtons({ reviewAction = null, dirty = false, deletable = true } = {}) {
  return '<div class="file-actions">' +
    (reviewAction ? '<button class="file-action" type="button" data-file-review-decision="' + escapeHtmlServer(reviewAction.status) + '">' + escapeHtmlServer(reviewAction.label) + '</button>' : '') +
    (deletable ? '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' : '') +
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
<html lang="en" data-file-theme="${DEFAULT_FILE_THEME}">
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
      --on-accent: #07101e;
      --shadow: 0 24px 80px rgba(0, 0, 0, 0.38);
      --body-glow-1: rgba(139, 211, 255, 0.22);
      --body-glow-2: rgba(182, 156, 255, 0.18);
      --body-glow-3: rgba(139,211,255,0.16);
      --body-glow-4: rgba(182,156,255,0.12);
      --star-dot: rgba(255,255,255,0.42);
      --star-opacity: 0.16;
      --surface-wash: rgba(3, 7, 18, 0.36);
      --surface-sidebar: rgba(8, 13, 27, 0.72);
      --surface-floating: rgba(8,13,27,0.96);
      --surface-floating-soft: rgba(8,13,27,0.82);
      --surface-card: rgba(255,255,255,0.045);
      --surface-card-hover: rgba(139,211,255,0.08);
      --surface-reader: rgba(3, 7, 18, 0.42);
      --label-strong: #dce8fb;
      --space-1: 4px;
      --space-2: 8px;
      --space-3: 12px;
      --space-4: 16px;
      --space-5: 20px;
      --space-6: 24px;
      --space-8: 32px;
      --page-padding: var(--space-6);
      --panel-header-padding: var(--space-5) var(--space-6);
      --panel-body-padding: var(--space-4) var(--space-6);
      --card-padding: var(--space-4);
      --compact-card-padding: var(--space-3);
      --control-height: 40px;
      --control-padding: var(--space-3) var(--space-4);
      --file-panel-bg: rgba(8,13,27,0.72);
      --file-header-bg: rgba(8,13,27,0.36);
      --file-bg: rgba(3,7,18,0.16);
      --file-fg: #eef4ff;
      --file-muted: #98a6bd;
      --file-line: rgba(148,163,184,0.16);
      --file-h1: #8bd3ff;
      --file-h2: #b69cff;
      --file-h3: #8df0b4;
      --file-h4: #ffd48f;
      --file-code: #f8c37a;
      --file-quote: #aab8cd;
      --file-list: #8bd3ff;
      --file-marker: #64748b;
      --file-hr: rgba(139,211,255,0.35);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    :root[data-file-theme="vscode-dark"] {
      color-scheme: dark;
      --bg: #1e1e1e;
      --panel: rgba(37,37,38,0.88);
      --panel-strong: rgba(45,45,48,0.96);
      --line: rgba(204,204,204,0.16);
      --text: #d4d4d4;
      --muted: #9a9a9a;
      --accent: #569cd6;
      --accent-2: #4ec9b0;
      --good: #6a9955;
      --danger: #f48771;
      --shadow: 0 24px 80px rgba(0,0,0,0.46);
      --body-glow-1: rgba(86,156,214,0.16);
      --body-glow-2: rgba(78,201,176,0.12);
      --body-glow-3: rgba(86,156,214,0.10);
      --body-glow-4: rgba(197,134,192,0.10);
      --surface-wash: rgba(30,30,30,0.48);
      --surface-sidebar: rgba(30,30,30,0.82);
      --surface-floating: rgba(37,37,38,0.98);
      --surface-floating-soft: rgba(37,37,38,0.88);
      --surface-card: rgba(255,255,255,0.04);
      --surface-card-hover: rgba(86,156,214,0.10);
      --surface-reader: rgba(30,30,30,0.50);
      --label-strong: #d4d4d4;
      --file-panel-bg: #1e1e1e;
      --file-header-bg: #252526;
      --file-bg: #1e1e1e;
      --file-fg: #d4d4d4;
      --file-muted: #858585;
      --file-line: rgba(204,204,204,0.16);
      --file-h1: #4ec9b0;
      --file-h2: #569cd6;
      --file-h3: #c586c0;
      --file-h4: #dcdcaa;
      --file-code: #ce9178;
      --file-quote: #6a9955;
      --file-list: #9cdcfe;
      --file-marker: #808080;
      --file-hr: rgba(86,156,214,0.38);
    }
    :root[data-file-theme="github-dark"] {
      color-scheme: dark;
      --bg: #0d1117;
      --panel: rgba(22,27,34,0.88);
      --panel-strong: rgba(33,38,45,0.96);
      --line: rgba(139,148,158,0.22);
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #79c0ff;
      --accent-2: #d2a8ff;
      --good: #7ee787;
      --danger: #ff7b72;
      --shadow: 0 24px 80px rgba(0,0,0,0.48);
      --body-glow-1: rgba(121,192,255,0.15);
      --body-glow-2: rgba(210,168,255,0.12);
      --body-glow-3: rgba(121,192,255,0.10);
      --body-glow-4: rgba(126,231,135,0.08);
      --surface-wash: rgba(13,17,23,0.52);
      --surface-sidebar: rgba(13,17,23,0.84);
      --surface-floating: rgba(22,27,34,0.98);
      --surface-floating-soft: rgba(22,27,34,0.90);
      --surface-card: rgba(255,255,255,0.04);
      --surface-card-hover: rgba(121,192,255,0.09);
      --surface-reader: rgba(13,17,23,0.54);
      --label-strong: #c9d1d9;
      --file-panel-bg: #0d1117;
      --file-header-bg: #161b22;
      --file-bg: #0d1117;
      --file-fg: #c9d1d9;
      --file-muted: #8b949e;
      --file-line: rgba(139,148,158,0.22);
      --file-h1: #79c0ff;
      --file-h2: #a5d6ff;
      --file-h3: #ffa657;
      --file-h4: #7ee787;
      --file-code: #d2a8ff;
      --file-quote: #8b949e;
      --file-list: #7ee787;
      --file-marker: #6e7681;
      --file-hr: rgba(121,192,255,0.34);
    }
    :root[data-file-theme="dracula"] {
      color-scheme: dark;
      --bg: #282a36;
      --panel: rgba(40,42,54,0.88);
      --panel-strong: rgba(52,55,70,0.96);
      --line: rgba(248,248,242,0.14);
      --text: #f8f8f2;
      --muted: #b8bfdc;
      --accent: #ff79c6;
      --accent-2: #bd93f9;
      --good: #50fa7b;
      --danger: #ff5555;
      --shadow: 0 24px 80px rgba(0,0,0,0.42);
      --body-glow-1: rgba(255,121,198,0.16);
      --body-glow-2: rgba(189,147,249,0.16);
      --body-glow-3: rgba(139,233,253,0.10);
      --body-glow-4: rgba(80,250,123,0.08);
      --surface-wash: rgba(40,42,54,0.52);
      --surface-sidebar: rgba(40,42,54,0.84);
      --surface-floating: rgba(52,55,70,0.98);
      --surface-floating-soft: rgba(52,55,70,0.88);
      --surface-card: rgba(248,248,242,0.045);
      --surface-card-hover: rgba(189,147,249,0.10);
      --surface-reader: rgba(40,42,54,0.50);
      --label-strong: #f8f8f2;
      --file-panel-bg: #282a36;
      --file-header-bg: #343746;
      --file-bg: #282a36;
      --file-fg: #f8f8f2;
      --file-muted: #b8bfdc;
      --file-line: rgba(248,248,242,0.14);
      --file-h1: #ff79c6;
      --file-h2: #bd93f9;
      --file-h3: #50fa7b;
      --file-h4: #8be9fd;
      --file-code: #f1fa8c;
      --file-quote: #6272a4;
      --file-list: #8be9fd;
      --file-marker: #6272a4;
      --file-hr: rgba(189,147,249,0.38);
    }
    :root[data-file-theme="solarized-dark"] {
      color-scheme: dark;
      --bg: #002b36;
      --panel: rgba(7,54,66,0.88);
      --panel-strong: rgba(7,54,66,0.98);
      --line: rgba(131,148,150,0.22);
      --text: #93a1a1;
      --muted: #839496;
      --accent: #268bd2;
      --accent-2: #2aa198;
      --good: #859900;
      --danger: #dc322f;
      --shadow: 0 24px 80px rgba(0,0,0,0.42);
      --body-glow-1: rgba(38,139,210,0.14);
      --body-glow-2: rgba(42,161,152,0.12);
      --body-glow-3: rgba(181,137,0,0.08);
      --body-glow-4: rgba(133,153,0,0.08);
      --surface-wash: rgba(0,43,54,0.50);
      --surface-sidebar: rgba(0,43,54,0.86);
      --surface-floating: rgba(7,54,66,0.98);
      --surface-floating-soft: rgba(7,54,66,0.90);
      --surface-card: rgba(253,246,227,0.045);
      --surface-card-hover: rgba(38,139,210,0.10);
      --surface-reader: rgba(0,43,54,0.52);
      --label-strong: #eee8d5;
      --file-panel-bg: #002b36;
      --file-header-bg: #073642;
      --file-bg: #002b36;
      --file-fg: #93a1a1;
      --file-muted: #839496;
      --file-line: rgba(131,148,150,0.22);
      --file-h1: #b58900;
      --file-h2: #268bd2;
      --file-h3: #2aa198;
      --file-h4: #859900;
      --file-code: #cb4b16;
      --file-quote: #657b83;
      --file-list: #2aa198;
      --file-marker: #586e75;
      --file-hr: rgba(38,139,210,0.34);
    }
    :root[data-file-theme="light-plus"] {
      color-scheme: light;
      --bg: #f6f8fa;
      --panel: rgba(255,255,255,0.90);
      --panel-strong: rgba(255,255,255,0.98);
      --line: rgba(27,31,36,0.14);
      --text: #24292f;
      --muted: #57606a;
      --accent: #0550ae;
      --accent-2: #8250df;
      --good: #116329;
      --danger: #cf222e;
      --on-accent: #ffffff;
      --shadow: 0 24px 70px rgba(31,35,40,0.16);
      --body-glow-1: rgba(5,80,174,0.13);
      --body-glow-2: rgba(130,80,223,0.11);
      --body-glow-3: rgba(5,80,174,0.08);
      --body-glow-4: rgba(17,99,41,0.07);
      --star-dot: rgba(36,41,47,0.26);
      --star-opacity: 0.10;
      --surface-wash: rgba(255,255,255,0.58);
      --surface-sidebar: rgba(255,255,255,0.86);
      --surface-floating: rgba(255,255,255,0.98);
      --surface-floating-soft: rgba(255,255,255,0.90);
      --surface-card: rgba(27,31,36,0.045);
      --surface-card-hover: rgba(5,80,174,0.08);
      --surface-reader: rgba(255,255,255,0.70);
      --label-strong: #24292f;
      --file-panel-bg: #ffffff;
      --file-header-bg: #f6f8fa;
      --file-bg: #ffffff;
      --file-fg: #24292f;
      --file-muted: #57606a;
      --file-line: rgba(27,31,36,0.14);
      --file-h1: #0550ae;
      --file-h2: #8250df;
      --file-h3: #116329;
      --file-h4: #953800;
      --file-code: #a40e26;
      --file-quote: #57606a;
      --file-list: #0550ae;
      --file-marker: #6e7781;
      --file-hr: rgba(5,80,174,0.22);
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top left, var(--body-glow-1), transparent 30rem),
        radial-gradient(circle at 80% 20%, var(--body-glow-2), transparent 28rem),
        var(--bg);
      color: var(--text);
      overflow: hidden;
    }
    body::before, body::after { content: ""; position: fixed; inset: 0; pointer-events: none; z-index: 0; }
    body::before { background-image: radial-gradient(circle, var(--star-dot) 0 1px, transparent 1.6px); background-size: 86px 86px; opacity: var(--star-opacity); animation: starDrift 38s linear infinite; }
    body::after { background: radial-gradient(circle at 65% 48%, var(--body-glow-3), transparent 22rem), radial-gradient(circle at 30% 74%, var(--body-glow-4), transparent 26rem); animation: nebulaPulse 12s ease-in-out infinite alternate; }
    .app { position: relative; z-index: 1; display: grid; grid-template-columns: 390px 1fr; height: 100vh; min-height: 0; overflow: hidden; transition: grid-template-columns 260ms ease; }
    .app.sidebar-collapsed { grid-template-columns: 76px 1fr; }
    aside { border-right: 1px solid var(--line); padding: var(--space-4) var(--space-5); background: var(--surface-sidebar); backdrop-filter: blur(22px); height: 100vh; min-height: 0; overflow: auto; display: block; transition: padding 260ms ease, background 260ms ease; }
    .app.sidebar-collapsed aside { padding: var(--space-4) var(--space-2); overflow: visible; }
    .app.sidebar-collapsed .sidebar-toggle { position: fixed; left: 16px; top: 16px; z-index: 20; background: var(--surface-floating); }
    .sidebar-head { display: grid; grid-template-columns: 1fr auto; gap: var(--space-3); align-items: start; }
    .sidebar-toggle { border: 1px solid rgba(139,211,255,0.28); border-radius: 14px; background: rgba(255,255,255,0.06); color: var(--text); width: 42px; height: 42px; cursor: pointer; box-shadow: 0 0 28px rgba(139,211,255,0.12); transition: transform 160ms ease, background 160ms ease; }
    .sidebar-toggle:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .explorer-open { display: none; border: 1px solid rgba(139,211,255,0.28); border-radius: 14px; background: rgba(255,255,255,0.06); color: var(--text); width: 42px; height: 42px; cursor: pointer; align-items: center; justify-content: center; box-shadow: 0 0 28px rgba(139,211,255,0.12); transition: transform 160ms ease, background 160ms ease; }
    .explorer-open:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .app.sidebar-collapsed .sidebar-copy, .app.sidebar-collapsed .workspace-dock, .app.sidebar-collapsed .search-row, .app.sidebar-collapsed .watch-filter-row, .app.sidebar-collapsed .selection-bar, .app.sidebar-collapsed .explorer-title, .app.sidebar-collapsed .tree, .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateX(-10px); }
    .sidebar-copy, .workspace-dock, .search-row, .watch-filter-row, .selection-bar, .explorer-title, .tree, .hint { transition: opacity 180ms ease, transform 180ms ease; }
    main { padding: var(--page-padding); display: grid; grid-template-rows: 1fr; gap: var(--space-4); min-width: 0; min-height: 0; overflow: hidden; }
    h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.04em; }
    .subtitle { color: var(--muted); line-height: 1.35; font-size: 13px; }
    .launch-map { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 10px 0; }
    .launch-card { border: 1px solid var(--line); border-radius: 12px; padding: 8px; background: var(--surface-card); min-width: 0; transition: transform 180ms ease, border-color 180ms ease, background 180ms ease; }
    .launch-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 38%, transparent); background: var(--surface-card-hover); }
    .launch-card.hot { border-color: rgba(141, 240, 180, 0.42); background: rgba(141, 240, 180, 0.08); }
    .launch-card strong { display: block; font-size: 11px; line-height: 1.2; }
    .launch-card span { display: none; }
    .quick-files { display: grid; gap: var(--space-1); margin: var(--space-2) 0 var(--space-3); overflow: visible; padding-right: var(--space-1); }
    .quick-group { display: grid; gap: 4px; }
    .quick-group-title { color: var(--muted); font-size: 10px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.1em; margin: 6px 0 2px; }
    .quick-file { width: 100%; border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 9px; background: var(--surface-card); color: var(--text); text-align: left; padding: 6px 8px; cursor: pointer; display: grid; gap: 1px; }
    .quick-file:hover { background: var(--surface-card-hover); border-color: color-mix(in srgb, var(--accent) 28%, transparent); transform: translateX(2px); }
    .quick-file.active { background: color-mix(in srgb, var(--accent) 14%, transparent); border-color: color-mix(in srgb, var(--accent) 56%, transparent); }
    .quick-file strong { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .quick-file span { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .search-row { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center; margin: 10px 0 10px; }

    .search { width: 100%; margin: var(--space-5) 0 var(--space-4); padding: var(--space-3) var(--space-4); border-radius: 14px; border: 1px solid var(--line); background: rgba(255,255,255,0.05); color: var(--text); outline: none; }
    .search-row .search { margin: 0; }
    .clear-search { border: 1px solid var(--line); border-radius: 14px; padding: var(--space-3); background: rgba(255,255,255,0.055); color: var(--muted); cursor: pointer; }
    .clear-search:hover { color: var(--text); background: rgba(255,255,255,0.085); }
    .watch-filter-row { display: flex; gap: var(--space-1); margin: 0 0 var(--space-2); align-items: center; }
    .watch-filter { border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 999px; padding: 4px 7px; background: var(--surface-card); color: var(--muted); cursor: pointer; font-size: 10px; font-weight: 850; line-height: 1; }
    .watch-filter:hover { color: var(--text); background: var(--surface-card-hover); }
    .watch-filter.active { color: var(--on-accent); border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .explorer-context-menu { position: fixed; z-index: 80; width: min(248px, calc(100vw - 24px)); border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 14px; background: var(--surface-floating); box-shadow: 0 18px 48px rgba(0,0,0,0.38); backdrop-filter: blur(20px); padding: var(--space-2); display: grid; gap: var(--space-2); }
    .explorer-context-menu[hidden] { display: none; }
    .explorer-context-title { display: grid; gap: 2px; color: var(--label-strong); font-size: 11px; font-weight: 900; padding: 2px 4px; }
    .explorer-context-title code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .explorer-context-form { display: grid; gap: var(--space-2); }
    .explorer-context-form[hidden] { display: none; }
    .explorer-context-label { color: var(--muted); font-size: 10px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.08em; padding: 0 2px; }
    .explorer-context-form input, .explorer-context-form select, .file-template-select { width: 100%; padding: 8px 10px; border: 1px solid rgba(148,163,184,0.18); border-radius: 10px; background: rgba(255,255,255,0.045); color: var(--text); font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .explorer-context-form input:focus { outline: none; border-color: rgba(139,211,255,0.5); background: rgba(139,211,255,0.06); }
    .explorer-context-error { border: 1px solid rgba(255,140,157,0.34); border-radius: 10px; padding: 8px 10px; background: rgba(255,140,157,0.10); color: #ffc0c8; font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .explorer-context-error[hidden] { display: none; }
    .explorer-context-actions { display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center; }
    .explorer-context-actions[hidden] { display: none; }
    .explorer-context-actions.menu-actions { grid-template-columns: 1fr; }
    .explorer-context-actions.form-actions { grid-template-columns: 1fr 1fr; gap: 8px; }
    .explorer-context-menu .explorer-context-actions button { padding: 8px 10px; border-radius: 10px; font-size: 12px; line-height: 1.2; }
    select option { color: #111827; background: #ffffff; }
    select option:checked { color: #07101e; background: #93c5fd; }
    .empty-template-actions { display: grid; grid-template-columns: minmax(150px, 240px); gap: 8px; align-items: center; }
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
    .tree-children { margin-left: var(--space-4); border-left: 1px solid rgba(148,163,184,0.12); padding-left: var(--space-1); }
    .topbar, .editor-shell { background: var(--panel); border: 1px solid var(--line); border-radius: 24px; box-shadow: var(--shadow); backdrop-filter: blur(24px); }
    .topbar { display: none; }
    .topbar { display: none; }
    .selected-title { font-size: 22px; font-weight: 850; letter-spacing: -0.03em; }
    .selected-path { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; margin-top: 5px; }
    .selected-impact { color: #c5d2e8; font-size: 14px; line-height: 1.45; margin-top: 12px; max-width: 980px; }
    .actions { display: flex; gap: var(--space-3); align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .history-nav { display: flex; gap: 6px; }
    .history-nav button { min-width: 42px; padding-left: 12px; padding-right: 12px; }
    button.primary, button.secondary { border: 0; border-radius: 14px; padding: 12px 16px; color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); font-weight: 850; cursor: pointer; transition: transform 160ms ease, filter 160ms ease, background 160ms ease; }
    button.primary:hover, button.secondary:hover { transform: translateY(-1px); filter: brightness(1.08); }
    button.secondary { background: rgba(255,255,255,0.08); color: var(--text); border: 1px solid var(--line); }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    button.save-pending, .file-action.save-pending { position: relative; overflow: hidden; opacity: 0.92 !important; cursor: wait !important; filter: saturate(0.92); }
    button.save-pending::after, .file-action.save-pending::after { content: ""; position: absolute; inset: -35%; pointer-events: none; background: linear-gradient(105deg, transparent 34%, rgba(255,255,255,0.28) 48%, transparent 62%); transform: translateX(-125%); animation: savePendingSweep 1150ms ease-in-out infinite; }
    button.save-confirmed, .file-action.save-confirmed { position: relative; overflow: hidden; opacity: 1 !important; color: var(--on-accent) !important; background: linear-gradient(135deg, var(--good), color-mix(in srgb, var(--good) 64%, var(--accent))) !important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 18%, transparent), 0 0 28px color-mix(in srgb, var(--good) 24%, transparent); animation: saveConfirmPulse 900ms ease both; }
    button.save-confirmed::after, .file-action.save-confirmed::after { content: ""; position: absolute; inset: -35%; pointer-events: none; background: linear-gradient(105deg, transparent 34%, rgba(255,255,255,0.45) 48%, transparent 62%); transform: translateX(-125%); animation: saveConfirmShine 900ms ease forwards; }
    @keyframes savePendingSweep { 0% { transform: translateX(-125%); } 70%, 100% { transform: translateX(125%); } }
    @keyframes saveConfirmPulse { 0% { transform: scale(0.985); } 38% { transform: scale(1.025); } 100% { transform: scale(1); } }
    @keyframes saveConfirmShine { to { transform: translateX(125%); } }
    .status { color: var(--muted); font-size: 13px; min-width: 150px; text-align: right; }
    .editor-shell { min-height: 0; overflow: hidden; position: relative; }
    .workspace-dock { display: inline-flex; max-width: 100%; gap: var(--space-1); align-items: center; flex-wrap: wrap; margin: 0 0 var(--space-3); padding: var(--space-1); border: 1px solid var(--line); border-radius: 16px; background: var(--surface-floating-soft); backdrop-filter: blur(18px); box-shadow: 0 16px 48px rgba(0,0,0,0.22); }
    .dock-button { display: inline-flex; align-items: center; justify-content: center; min-width: var(--control-height); min-height: var(--control-height); border: 1px solid rgba(148,163,184,0.22); border-radius: 12px; background: rgba(255,255,255,0.06); color: var(--text); padding: 0 var(--space-3); font-weight: 850; line-height: 1; white-space: nowrap; cursor: pointer; }
    .workspace-dock .dock-button[hidden] { display: none !important; }
    #back.dock-button, #forward.dock-button { padding: 0; }
    .dock-button:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .dock-button.primary { color: var(--on-accent); border: 0; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .dock-button.diff-dock-button { min-width: auto; margin-left: var(--space-1); padding: 0 var(--space-3); color: var(--label-strong); border-color: color-mix(in srgb, var(--accent) 28%, transparent); background: color-mix(in srgb, var(--accent) 8%, transparent); font-size: 12px; letter-spacing: 0.01em; }
    .dock-button.diff-dock-button.active { color: var(--on-accent); border-color: transparent; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .dock-status { display: none; }
    .docqa-home { height: 100%; padding: var(--page-padding); overflow: auto; position: relative; background: radial-gradient(circle at 18% 0%, var(--body-glow-3), transparent 28rem), var(--surface-wash); scroll-padding-bottom: var(--space-8); }
    .docqa-grid { display: grid; grid-template-columns: 1fr; gap: var(--space-5); align-items: start; }
    .docqa-panel { border: 1px solid var(--line); border-radius: 22px; background: var(--panel); box-shadow: var(--shadow); overflow: hidden; }
    .docqa-panel header { padding: var(--panel-header-padding); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: var(--space-3); align-items: baseline; }
    .docqa-panel h2 { margin: 0; font-size: 18px; letter-spacing: -0.03em; }
    .docqa-panel .muted { color: var(--muted); font-size: 12px; }
    .review-summary { display: flex; gap: var(--space-3); align-items: stretch; flex-wrap: wrap; }
    .review-summary-item { min-width: 118px; border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 16px; background: var(--surface-card); padding: 10px 12px; }
    .review-summary-item strong { display: block; font-size: 24px; line-height: 1; }
    .review-summary-item span { display: block; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em; margin-top: 6px; }
    .review-list { display: grid; gap: 8px; padding: 12px; max-height: clamp(220px, 34vh, 360px); overflow: auto; overscroll-behavior-y: auto; scrollbar-gutter: stable; }
    .review-item { border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 16px; background: var(--surface-card); color: var(--text); text-align: left; padding: var(--space-4); cursor: pointer; display: grid; gap: var(--space-2); }
    .review-item:hover, .review-item.active { border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: var(--surface-card-hover); transform: translateX(2px); }
    .review-top { display: flex; justify-content: space-between; gap: 12px; align-items: center; }
    .review-title { font-weight: 850; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .review-path { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid var(--line); border-radius: 999px; padding: 4px 8px; color: var(--label-strong); background: var(--surface-card); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.08em; }
    .chip.critical { border-color: rgba(255,140,157,0.58); color: #ffc0c8; background: rgba(255,140,157,0.10); }
    .chip.high { border-color: rgba(255,196,107,0.55); color: #ffd79c; background: rgba(255,196,107,0.10); }
    .inspector-body { padding: var(--panel-body-padding); display: grid; gap: var(--space-4); }
    .inspector-path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); overflow-wrap: anywhere; }
    .issue-list { display: grid; gap: 8px; }
    .issue { border-left: 3px solid color-mix(in srgb, var(--accent) 50%, transparent); padding: 8px 10px; background: var(--surface-card); border-radius: 10px; color: var(--text); font-size: 13px; }
    .issue.critical { border-left-color: var(--danger); }
    .issue.high { border-left-color: #ffc46b; }
    .docqa-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .markdown-tools { padding: var(--panel-body-padding); display: grid; gap: var(--space-4); }
    .best-practice-list { margin: 0; padding-left: var(--space-5); display: grid; gap: var(--space-2); color: var(--text); font-size: 13px; line-height: 1.45; }
    .markdown-create { max-width: 1120px; margin: 0 auto; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
    .markdown-create .settings-field { min-width: 0; }
    .markdown-create .settings-field.paths { grid-column: 1 / -1; }
    .new-doc-title-field { grid-column: span 3; }
    .new-doc-compact-field { grid-column: span 2; }
    .markdown-create button { align-self: end; min-height: 42px; }
    .new-doc-actions { grid-column: 1 / -1; display: flex; justify-content: flex-end; gap: var(--space-3); flex-wrap: wrap; }
    .markdown-create .settings-field select { display: block; width: 100%; padding: 10px; border: 1px solid rgba(148,163,184,0.18); border-radius: 14px; background: rgba(255,255,255,0.045); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .path-picker-field { grid-column: 1 / -1; }
    .path-picker { position: relative; display: grid; gap: var(--space-4); padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); border-radius: 20px; background: linear-gradient(145deg, color-mix(in srgb, var(--surface-card) 92%, var(--accent) 8%), color-mix(in srgb, var(--surface-card) 94%, var(--accent-2) 6%)); box-shadow: 0 18px 54px rgba(0,0,0,0.18); }
    .path-picker-main { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(220px, 0.65fr); gap: var(--space-3); align-items: start; }
    .path-picker-control { min-width: 0; display: grid; gap: var(--space-2); }
    .path-picker-control-title { color: var(--muted); font-size: 10px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
    .locked-folder-display { min-width: 0; min-height: var(--control-height); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-2); align-items: center; padding: 0 var(--space-3); border: 1px solid color-mix(in srgb, var(--line) 90%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--surface-floating-soft) 72%, transparent); }
    .locked-folder-display code { min-width: 0; color: var(--accent); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .locked-folder-display span { flex: 0 0 auto; color: var(--muted); font-size: 10px; font-weight: 900; letter-spacing: 0.1em; text-transform: uppercase; }
    .path-picker input[id="markdownCreateFileName"] { min-height: var(--control-height); }
    .path-picker-preview { display: flex; align-items: center; gap: 8px; min-width: 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 14px; background: rgba(139,211,255,0.06); color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; }
    .path-picker-preview code { min-width: 0; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; text-transform: none; letter-spacing: 0; overflow-wrap: anywhere; }
    .settings-page { height: 100%; overflow: auto; padding: var(--page-padding); background: radial-gradient(circle at 20% 0%, var(--body-glow-4), transparent 28rem), var(--surface-wash); }
    .settings-page .settings-card { max-width: 1240px; margin: 0 auto; }
    .settings-card { box-shadow: var(--shadow); background: var(--panel); border: 1px solid var(--line); backdrop-filter: blur(18px); }
    .settings-card header { padding: var(--panel-header-padding); border-bottom: 1px solid var(--line); align-items: center; gap: var(--space-3); }
    .settings-card h2 { font-size: 22px; letter-spacing: -0.04em; }
    .settings-panel { padding: 20px; display: grid; gap: 16px; }
    .settings-shell { display: grid; gap: var(--space-4); }
    .settings-section { border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 22px; background: linear-gradient(145deg, color-mix(in srgb, var(--surface-card) 92%, var(--accent) 8%), var(--surface-card)); overflow: hidden; }
    .settings-section summary { list-style: none; }
    .settings-section summary::-webkit-details-marker { display: none; }
    .settings-section.collapsible > .settings-section-head { cursor: pointer; }
    .settings-section.collapsible:not([open]) > .settings-section-head { border-bottom: 0; }
    .settings-section.collapsible:not([open]) > .settings-section-body { display: none; }
    .settings-section-head { display: flex; justify-content: space-between; gap: var(--space-4); align-items: flex-start; padding: var(--space-4) var(--space-5); border-bottom: 1px solid color-mix(in srgb, var(--line) 84%, transparent); background: color-mix(in srgb, var(--surface-floating-soft) 78%, transparent); }
    .settings-section-title { display: grid; gap: var(--space-2); min-width: 0; }
    .settings-section-title h3 { margin: 0; color: var(--label-strong); font-size: 16px; line-height: 1.2; letter-spacing: 0; }
    .settings-kicker, .settings-title { color: var(--accent); font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.12em; }
    .settings-section-copy { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
    .settings-section-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .settings-pill { border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); border-radius: 999px; padding: var(--space-2) var(--space-3); color: var(--label-strong); background: color-mix(in srgb, var(--accent) 9%, transparent); font-size: 11px; font-weight: 850; line-height: 1; white-space: nowrap; }
    .settings-section-toggle { border-color: color-mix(in srgb, var(--accent) 38%, transparent); color: var(--accent); min-width: 52px; text-align: center; }
    .settings-section[open] .settings-section-toggle::after { content: "hide"; }
    .settings-section:not([open]) .settings-section-toggle::after { content: "open"; }
    .settings-section-body { padding: var(--space-4) var(--space-5) var(--space-5); display: grid; gap: var(--space-4); }
    .settings-body-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
    .settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); align-items: start; }
    .settings-grid.compact { grid-template-columns: minmax(220px, 0.72fr) minmax(240px, 1fr); }
    .settings-field { display: grid; gap: 8px; min-width: 0; align-content: start; }
    .settings-field label, .settings-field-title { color: var(--muted); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.09em; }
    .settings-field textarea, .settings-field input, .settings-field select { display: block; width: 100%; min-width: 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--line) 92%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--surface-reader) 74%, var(--surface-card)); color: var(--text); font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; box-shadow: inset 0 1px 0 rgba(255,255,255,0.025); }
    .settings-field textarea:focus, .settings-field input:focus, .settings-field select:focus { outline: none; border-color: color-mix(in srgb, var(--accent) 55%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
    .settings-field textarea { min-height: 118px; height: 118px; resize: vertical; }
    .settings-field.large textarea { min-height: 150px; height: 150px; }
    .settings-field-note, .settings-help { margin: -2px 0 0; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .settings-toggle { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 12px; align-items: center; min-height: 64px; padding: 12px; border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 16px; background: color-mix(in srgb, var(--surface-reader) 64%, var(--surface-card)); color: var(--text); cursor: pointer; text-transform: none; letter-spacing: 0; font-size: inherit; font-weight: inherit; }
    .settings-toggle:hover { border-color: color-mix(in srgb, var(--accent) 38%, transparent); background: var(--surface-card-hover); }
    .settings-toggle input { position: absolute; opacity: 0; pointer-events: none; }
    .settings-switch { width: 42px; height: 24px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--line) 95%, transparent); background: rgba(148,163,184,0.16); position: relative; box-shadow: inset 0 1px 4px rgba(0,0,0,0.25); }
    .settings-switch::after { content: ""; position: absolute; width: 18px; height: 18px; left: 2px; top: 2px; border-radius: 50%; background: var(--muted); transition: transform 160ms ease, background 160ms ease; }
    .settings-toggle input:checked + .settings-switch { border-color: color-mix(in srgb, var(--accent) 62%, transparent); background: color-mix(in srgb, var(--accent) 28%, transparent); }
    .settings-toggle input:checked + .settings-switch::after { transform: translateX(18px); background: var(--accent); }
    .settings-toggle input:focus-visible + .settings-switch { outline: 2px solid color-mix(in srgb, var(--accent) 62%, transparent); outline-offset: 3px; }
    .settings-toggle-copy { display: grid; gap: var(--space-1); min-width: 0; }
    .settings-toggle-copy strong { color: var(--label-strong); font-size: 13px; line-height: 1.25; }
    .settings-toggle-copy em { color: var(--muted); font-size: 12px; line-height: 1.35; font-style: normal; }
    .settings-theme-preview { border: 1px solid color-mix(in srgb, var(--file-line) 92%, transparent); border-radius: 18px; overflow: hidden; background: var(--file-bg); box-shadow: inset 0 1px 0 rgba(255,255,255,0.025); }
    .settings-theme-preview-head { display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; padding: var(--space-3); border-bottom: 1px solid var(--file-line); background: var(--file-header-bg); color: var(--file-fg); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.08em; }
    .settings-theme-preview .doc-editor { min-height: 0; max-height: none; padding: var(--space-4); font-size: 12px; line-height: 1.55; background: transparent; }
    .hub-card-options { display: grid; gap: var(--space-3); }
    .hub-card-option { min-height: 36px; display: flex; align-items: center; gap: var(--space-2); border: 1px solid var(--line); border-radius: 999px; padding: var(--space-2) var(--space-3); color: var(--label-strong); background: var(--surface-card); font-size: 12px; }
    .settings-editor-list { gap: var(--space-4); }
    .hub-section-editor { display: grid; gap: var(--space-4); padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--line) 86%, transparent); border-radius: 16px; background: color-mix(in srgb, var(--surface-card) 96%, var(--accent) 4%); }
    .hub-section-editor summary { list-style: none; cursor: pointer; }
    .hub-section-editor summary::-webkit-details-marker { display: none; }
    .hub-section-editor:not([open]) > :not(summary) { display: none; }
    .hub-section-editor-summary, .template-editor-summary, .hub-card-editor-summary { min-height: 32px; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); color: var(--label-strong); font-size: 12px; font-weight: 850; }
    .hub-section-editor-summary span, .template-editor-summary span, .hub-card-editor-summary span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hub-section-editor-summary code, .template-editor-summary code, .hub-card-editor-summary code { flex: 0 0 auto; color: var(--accent); font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .hub-section-editor-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: var(--space-3); align-items: end; }
    .hub-card-editor { display: grid; gap: var(--space-4); padding: var(--space-4); border: 1px solid color-mix(in srgb, var(--line) 86%, transparent); border-radius: 16px; background: var(--surface-card); }
    .hub-card-editor summary { list-style: none; cursor: pointer; }
    .hub-card-editor summary::-webkit-details-marker { display: none; }
    .hub-card-editor:not([open]) > :not(summary) { display: none; }
    .hub-card-editor.nested { margin-left: 0; border-left-color: color-mix(in srgb, var(--accent) 38%, transparent); background: color-mix(in srgb, var(--surface-card) 94%, var(--accent) 6%); }
    .hub-card-children { display: grid; gap: 0; padding-left: 0; border-left: 0; }
    .hub-card-children:not(:empty) { gap: var(--space-3); margin: var(--space-1) 0 0 var(--space-2); padding-left: var(--space-3); border-left: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); }
    .hub-card-editor-head { display: flex; justify-content: space-between; gap: var(--space-3); align-items: flex-start; flex-wrap: wrap; }
    .hub-card-editor-title { min-height: 32px; display: flex; gap: var(--space-2); align-items: center; color: var(--label-strong); font-size: 12px; font-weight: 850; }
    .hub-card-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
    .hub-card-editor .paths { grid-column: 1 / -1; }
    .template-editor { display: grid; gap: var(--space-3); padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--line) 86%, transparent); border-radius: 18px; background: var(--surface-card); }
    .template-editor summary { list-style: none; cursor: pointer; }
    .template-editor summary::-webkit-details-marker { display: none; }
    .template-editor:not([open]) > :not(summary) { display: none; }
    .template-editor-head { display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; color: var(--label-strong); font-size: 12px; font-weight: 850; }
    .template-enabled-toggle { display: inline-flex; gap: 8px; align-items: center; color: var(--label-strong); font-size: 12px; font-weight: 850; text-transform: none; letter-spacing: 0; }
    .template-enabled-toggle input { width: auto; accent-color: var(--accent); }
    .template-editor-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
    .template-editor .template-body { grid-column: 1 / -1; }
    .template-editor .template-body textarea { min-height: 220px; height: 220px; }
    .settings-footer { position: sticky; bottom: 0; z-index: 12; display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; margin: 0 calc(var(--space-5) * -1) calc(var(--space-5) * -1); padding: var(--space-4) var(--space-5); color: var(--muted); font-size: 12px; border-top: 1px solid color-mix(in srgb, var(--line) 88%, transparent); background: color-mix(in srgb, var(--surface-floating) 92%, transparent); backdrop-filter: blur(18px); }
    .hub-folders { margin-top: var(--space-4); display: grid; gap: var(--space-6); }
    .hub-breadcrumb { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-bottom: calc(var(--space-2) * -1); padding: var(--space-2) var(--space-3); border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 18px; background: var(--surface-floating-soft); color: var(--muted); font-size: 12px; font-weight: 800; }
    .hub-crumb { border: 1px solid var(--line); border-radius: 999px; padding: var(--space-2) var(--space-3); background: var(--surface-card); color: var(--label-strong); cursor: pointer; font-weight: 850; }
    .hub-crumb:hover { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); transform: translateY(-1px); }
    .hub-crumb.current { pointer-events: none; color: var(--accent); background: rgba(139,211,255,0.10); }
    .hub-crumb-separator { color: rgba(148,163,184,0.52); }
    .hub-section { display: grid; gap: var(--space-4); padding-top: var(--space-6); border-top: 1px solid rgba(139,211,255,0.24); }
    .hub-section:first-child { border-top: 0; padding-top: 0; }
    .hub-section-title { color: var(--muted); font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.13em; }
    .hub-section-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); gap: var(--space-4); align-items: start; }
    .hub-folder-card { min-width: 0; border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 22px; padding: 0; min-height: 132px; background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 10%, var(--surface-card)), color-mix(in srgb, var(--accent-2) 6%, var(--surface-card))); color: var(--text); text-align: left; display: grid; gap: 0; box-shadow: 0 18px 54px rgba(0,0,0,0.24); overflow: hidden; }
    .hub-folder-card.navigation { background: linear-gradient(145deg, color-mix(in srgb, var(--accent-2) 13%, var(--surface-card)), color-mix(in srgb, var(--accent) 7%, var(--surface-card))); }
    .hub-folder-card.expanded { grid-column: 1 / -1; border-color: color-mix(in srgb, var(--accent) 38%, transparent); background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 13%, var(--surface-card)), color-mix(in srgb, var(--accent-2) 8%, var(--surface-card))); }
    .hub-folder-card.current { border-color: color-mix(in srgb, var(--accent) 54%, transparent); }
    .hub-folder-card:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: linear-gradient(145deg, color-mix(in srgb, var(--accent) 16%, var(--surface-card)), color-mix(in srgb, var(--accent-2) 10%, var(--surface-card))); }
    .hub-folder-card-main { width: 100%; min-width: 0; min-height: 132px; border: 0; border-radius: 22px; padding: var(--space-5); background: transparent; color: inherit; text-align: left; cursor: pointer; display: grid; align-content: space-between; gap: var(--space-3); }
    .hub-folder-card-main:focus-visible { outline: 2px solid rgba(139,211,255,0.74); outline-offset: -4px; }
    .hub-folder-card.expanded > .hub-folder-card-main { min-height: 104px; }
    .hub-folder-children { display: grid; gap: var(--space-3); padding: 0 var(--space-4) var(--space-4); }
    .hub-folder-children-head { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; padding: var(--space-3) var(--space-1) 0; border-top: 1px solid rgba(148,163,184,0.16); color: var(--muted); font-size: 12px; font-weight: 850; }
    .hub-folder-children-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 12px; }
    .hub-folder-children .hub-folder-card { min-height: 112px; box-shadow: none; }
    .hub-folder-children .hub-folder-card-main { min-height: 112px; padding: var(--space-4); border-radius: 18px; }
    .hub-folder-card strong { display: block; min-width: 0; font-size: 20px; line-height: 1.05; letter-spacing: 0; overflow-wrap: anywhere; }
    .hub-folder-card span { min-width: 0; color: var(--muted); font-size: 13px; line-height: 1.35; overflow-wrap: anywhere; }
    .hub-folder-card code { min-width: 0; color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.25; overflow-wrap: anywhere; white-space: normal; }
    .hub-folder-meta { min-width: 0; display: flex; justify-content: space-between; gap: var(--space-3); align-items: end; color: var(--label-strong); font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
    .hub-folder-meta code { flex: 1 1 auto; }
    .hub-folder-meta span { flex: 0 0 auto; text-align: right; white-space: nowrap; }
    .startup-context-panel { display: grid; gap: var(--space-3); padding-top: var(--space-6); border-top: 1px solid rgba(139,211,255,0.24); }
    .startup-context-copy { color: var(--muted); font-size: 13px; line-height: 1.4; }
    .startup-context-list { display: grid; gap: 8px; }
    .startup-context-item { min-width: 0; border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 14px; padding: var(--space-3) var(--space-4); background: var(--surface-card); color: var(--text); cursor: pointer; text-align: left; display: grid; grid-template-columns: minmax(120px, 0.28fr) minmax(0, 1fr); gap: var(--space-3); align-items: center; }
    .startup-context-item:hover { transform: translateY(-1px); border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: var(--surface-card-hover); }
    .startup-context-item.readonly { cursor: default; }
    .startup-context-item.readonly:hover { transform: none; border-color: color-mix(in srgb, var(--line) 88%, transparent); background: var(--surface-card); }
    .startup-context-item strong { min-width: 0; font-size: 13px; line-height: 1.25; overflow-wrap: anywhere; }
    .startup-context-item span { min-width: 0; color: var(--muted); font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .startup-skill-names { min-width: 0; display: grid; gap: 4px; }
    .startup-skill-names code { min-width: 0; color: var(--muted); font: 12px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .startup-skill-names em { color: var(--muted); font-style: normal; font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
    .startup-skill-buttons { min-width: 0; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .startup-skill-pill { max-width: 100%; display: inline-flex; align-items: center; position: relative; border: 1px solid rgba(139,211,255,0.24); border-radius: 999px; background: rgba(139,211,255,0.08); overflow: visible; transition: border-color 160ms ease, background 160ms ease, transform 160ms ease; }
    .startup-skill-pill:hover, .startup-skill-pill:focus-within { border-color: rgba(139,211,255,0.5); background: rgba(139,211,255,0.14); transform: translateY(-1px); }
    .startup-skill-button { min-width: 0; border: 0; padding: 5px 8px; background: transparent; color: var(--text); cursor: pointer; font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .startup-skill-delete { position: absolute; top: -7px; right: -7px; z-index: 4; width: 18px; height: 18px; padding: 0; border: 1px solid rgba(139,211,255,0.42); border-radius: 999px; background: rgba(139,211,255,0.14); color: var(--accent); cursor: pointer; opacity: 0; pointer-events: none; transform: scale(0.7); box-shadow: 0 8px 18px rgba(0,0,0,0.28); transition: opacity 120ms ease, transform 140ms ease, background 120ms ease, border-color 120ms ease; display: grid; place-items: center; font-size: 12px; font-weight: 900; line-height: 1; }
    .startup-skill-pill:hover .startup-skill-delete, .startup-skill-pill:focus-within .startup-skill-delete { opacity: 1; pointer-events: auto; transform: scale(1); }
    .startup-skill-delete:hover { background: rgba(139,211,255,0.22); border-color: rgba(139,211,255,0.68); color: var(--text); }
    .startup-skill-add { width: 28px; height: 28px; border: 1px solid rgba(139,211,255,0.28); border-radius: 999px; background: rgba(139,211,255,0.08); color: var(--accent); cursor: pointer; font-weight: 900; line-height: 1; transition: transform 160ms ease, border-color 160ms ease, background 160ms ease; }
    .startup-skill-add:hover, .startup-skill-add:focus-visible { transform: translateY(-1px); border-color: rgba(139,211,255,0.54); background: rgba(139,211,255,0.16); }
    .startup-skill-create { display: inline-flex; align-items: center; gap: 4px; padding: 3px; border: 1px solid rgba(139,211,255,0.32); border-radius: 999px; background: rgba(6,12,24,0.36); box-shadow: inset 0 1px 0 rgba(255,255,255,0.04); }
    .startup-skill-create input { width: 150px; min-width: 90px; height: 26px; border: 0; border-radius: 999px; background: rgba(255,255,255,0.08); color: var(--text); padding: 0 10px; font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; outline: none; }
    .startup-skill-create input:focus { box-shadow: 0 0 0 2px rgba(139,211,255,0.28); }
    .startup-skill-create button { width: 24px; height: 24px; border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; background: rgba(255,255,255,0.06); color: var(--text); cursor: pointer; font-size: 12px; line-height: 1; display: grid; place-items: center; }
    .startup-skill-create button:hover, .startup-skill-create button:focus-visible { background: rgba(139,211,255,0.14); border-color: rgba(139,211,255,0.36); }
    .startup-skill-create button[data-startup-skill-create-cancel] { color: #ffb7c2; }
    .startup-skill-folder::before { display: none; }
    .startup-skill-folder.spotlight-active::before, .startup-skill-folder:focus-within::before { opacity: 0; }
    .launch-card, .review-item, .hub-folder-card, .startup-context-item, .settings-section, .settings-toggle, .settings-theme-preview, .template-editor, .hub-section-editor, .hub-card-editor, .path-picker, .card, .conflict-card { position: relative; isolation: isolate; overflow: hidden; --spotlight-x: 50%; --spotlight-y: 50%; }
    .launch-card::before, .review-item::before, .hub-folder-card::before, .startup-context-item::before, .settings-section::before, .settings-toggle::before, .settings-theme-preview::before, .template-editor::before, .hub-section-editor::before, .hub-card-editor::before, .path-picker::before, .card::before, .conflict-card::before { content: ""; position: absolute; inset: 0; z-index: 0; border-radius: inherit; pointer-events: none; background: radial-gradient(360px circle at var(--spotlight-x) var(--spotlight-y), rgba(139,211,255,0.18), rgba(182,156,255,0.08) 30%, transparent 62%); opacity: 0; transition: opacity 180ms ease; }
    .launch-card.spotlight-active::before, .launch-card:focus-within::before, .review-item.spotlight-active::before, .review-item:focus-within::before, .hub-folder-card.spotlight-active::before, .hub-folder-card:focus-within::before, .startup-context-item.spotlight-active::before, .startup-context-item:focus-within::before, .settings-section.spotlight-active::before, .settings-section:focus-within::before, .settings-toggle.spotlight-active::before, .settings-toggle:focus-within::before, .settings-theme-preview.spotlight-active::before, .settings-theme-preview:focus-within::before, .template-editor.spotlight-active::before, .template-editor:focus-within::before, .hub-section-editor.spotlight-active::before, .hub-section-editor:focus-within::before, .hub-card-editor.spotlight-active::before, .hub-card-editor:focus-within::before, .path-picker.spotlight-active::before, .path-picker:focus-within::before, .card.spotlight-active::before, .card:focus-within::before, .conflict-card.spotlight-active::before, .conflict-card:focus-within::before { opacity: 1; }
    .launch-card > *, .review-item > *, .hub-folder-card > *, .startup-context-item > *, .settings-section > *, .settings-toggle > *, .settings-theme-preview > *, .template-editor > *, .hub-section-editor > *, .hub-card-editor > *, .path-picker > *, .card > *, .conflict-card > * { position: relative; z-index: 1; }
    .selection-bar { margin: 6px 0 8px; padding: 5px 6px 5px 10px; border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 999px; background: var(--surface-floating-soft); display: flex; gap: 8px; align-items: center; justify-content: space-between; box-shadow: 0 10px 28px rgba(0,0,0,0.18); }
    .selection-bar[hidden] { display: none; }
    .selection-summary { min-width: 0; color: var(--label-strong); font-size: 11px; font-weight: 850; letter-spacing: 0.02em; white-space: nowrap; }
    .selection-actions { display: flex; gap: 4px; align-items: center; }
    .selection-action { width: 28px; height: 28px; padding: 0; border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; background: rgba(255,255,255,0.045); color: var(--muted); font-size: 13px; line-height: 1; cursor: pointer; display: grid; place-items: center; }
    .selection-action:hover { color: var(--text); background: rgba(139,211,255,0.10); transform: translateY(-1px); }
    .selection-action.danger-action { border-color: rgba(255,140,157,0.24) !important; color: #ffb5c0 !important; }
    .tree-entry { display: flex; align-items: stretch; gap: var(--space-1); }
    .tree-entry .tree-row { flex: 1; }
    .tree-entry.selected .tree-row { border-color: rgba(139,211,255,0.34); background: rgba(139,211,255,0.085); box-shadow: inset 2px 0 0 rgba(139,211,255,0.48); }
    .tree-entry.selected .tree-row::after { content: "✓"; margin-left: auto; color: var(--accent); font-size: 10px; line-height: 1; flex: 0 0 auto; }
    .tree-entry.watched .tree-name { color: var(--good); font-weight: 850; }
    .tree-entry.watched-inherited .tree-name { color: #bff5d0; }

    .danger-action { border-color: rgba(255,140,157,0.38) !important; color: #ffc0c8 !important; }
    @media (max-width: 860px) { .settings-card { position: static; width: 100%; max-height: none; margin-bottom: 12px; } }
    .cosmos-home { height: 100%; min-height: calc(100vh - 168px); padding: 34px; overflow: hidden; background: radial-gradient(circle at 50% 38%, var(--body-glow-3), transparent 24rem), var(--surface-wash); transition: padding-right 320ms ease; }
    .editor-shell.planet-file-open .cosmos-home { padding-right: min(46vw, 660px); }
    .planet-stage { position: relative; height: 100%; min-height: calc(100vh - 236px); border-radius: 28px; overflow: hidden; display: grid; place-items: center; background: radial-gradient(circle at 50% 50%, var(--body-glow-4), transparent 22rem); }
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
    textarea, .viewer { width: 100%; height: 100%; min-height: calc(100vh - 48px); border: 0; outline: none; padding: var(--space-8); background: var(--surface-reader); color: var(--text); font: 18px/1.72 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    textarea { resize: none; display: none; }
    .viewer { white-space: pre-wrap; overflow: auto; }
    .review-workspace { display: grid; grid-template-columns: minmax(320px, 0.92fr) minmax(420px, 1.08fr); gap: var(--space-5); min-height: 100%; }
    .review-workspace.no-diff { grid-template-columns: 1fr; }
    .diff-panel, .file-panel { border: 1px solid var(--line); border-radius: 22px; background: var(--panel); overflow: hidden; min-width: 0; }
    .file-panel { border-color: var(--file-line); background: var(--file-panel-bg); }
    .diff-header, .file-panel header { padding: var(--space-4) var(--space-5); border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; color: var(--label-strong); font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    .file-panel header { border-bottom-color: var(--file-line); background: var(--file-header-bg); color: var(--file-fg); }
    .diff-header strong, .file-panel strong { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; }
    .diff-meta { color: var(--muted); font-size: 12px; white-space: nowrap; }
    .diff-code, .doc-content, .doc-editor { margin: 0; padding: var(--space-5); white-space: pre-wrap; overflow: auto; max-height: calc(100vh - 162px); font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .doc-content { font-size: 15px; line-height: 1.7; }
    .doc-editor { display: block; width: 100%; min-height: calc(100vh - 162px); border: 0; border-radius: 0; resize: none; background: var(--file-bg); color: var(--file-fg); outline: none; font-size: 15px; line-height: 1.7; caret-color: var(--file-h1); }
    .doc-editor::selection, .markdown-view ::selection { background: color-mix(in srgb, var(--file-h2) 32%, transparent); }
    .markdown-view { white-space: normal; }
    .markdown-line { min-height: 1.7em; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--file-fg); }
    .markdown-line.blank { min-height: 1.15em; }
    .markdown-line.h1, .markdown-line.h2, .markdown-line.h3, .markdown-line.h4 { margin: 0.42em 0 0.18em; font-weight: 900; letter-spacing: 0; }
    .markdown-line.h1 { color: var(--file-h1); font-size: 1.28em; padding-bottom: 0.22em; border-bottom: 1px solid var(--file-hr); }
    .markdown-line.h2 { color: var(--file-h2); font-size: 1.16em; }
    .markdown-line.h3 { color: var(--file-h3); font-size: 1.06em; }
    .markdown-line.h4 { color: var(--file-h4); }
    .markdown-line.list { color: var(--file-fg); padding-left: 0.8em; }
    .markdown-line.list .markdown-marker { color: var(--file-list); font-weight: 900; }
    .markdown-line.quote { color: var(--file-quote); border-left: 2px solid var(--file-quote); padding-left: 0.8em; opacity: 0.9; }
    .markdown-line.code, .markdown-line.fence { color: var(--file-code); background: color-mix(in srgb, var(--file-code) 10%, transparent); }
    .markdown-line.frontmatter, .markdown-line.hr { color: var(--file-marker); }
    .markdown-inline-code { color: var(--file-code); background: color-mix(in srgb, var(--file-code) 12%, transparent); border-radius: 4px; padding: 0 3px; }
    .markdown-path { color: var(--file-list); border-bottom: 1px solid color-mix(in srgb, var(--file-list) 36%, transparent); }
    .markdown-path[data-doc-link-path] { cursor: inherit; text-decoration: none; background-image: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 72%, transparent), transparent); background-repeat: no-repeat; background-size: 0 2px; background-position: 0 100%; transition: color 140ms ease, border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease; }
    .doc-link-modifier-active .markdown-path[data-doc-link-path] { cursor: pointer; border-color: color-mix(in srgb, var(--accent) 54%, transparent); background-color: color-mix(in srgb, var(--accent) 5%, transparent); }
    .doc-link-modifier-active .markdown-path[data-doc-link-path]:hover, .doc-link-modifier-active .markdown-path[data-doc-link-path].doc-link-hover-target { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 72%, transparent); background-color: color-mix(in srgb, var(--accent) 9%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 7%, transparent); animation: docLinkClickableSweep 1.1s ease-in-out infinite; }
    @keyframes docLinkClickableSweep { 0% { background-size: 0 2px; background-position: 0 100%; } 46% { background-size: 100% 2px; background-position: 0 100%; } 100% { background-size: 0 2px; background-position: 100% 100%; } }
    .markdown-doc-link { color: var(--file-list); border-bottom: 1px solid color-mix(in srgb, var(--file-list) 42%, transparent); text-decoration: none; }
    .markdown-inline-code.markdown-path { color: var(--file-list); }
    .markdown-editor-shell { position: relative; min-height: calc(100vh - 162px); max-height: calc(100vh - 162px); overflow: hidden; background: var(--file-bg); isolation: isolate; }
    .markdown-editor-shell .doc-editor { min-height: 100%; max-height: none; box-sizing: border-box; }
    .markdown-editor-highlight { position: absolute; inset: 0; z-index: 1; pointer-events: none; overflow: auto; background: transparent; color: var(--file-fg); scrollbar-width: none; }
    .markdown-editor-highlight::-webkit-scrollbar { display: none; }
    .markdown-editor-input { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; resize: none; overflow: auto; background: transparent !important; color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: var(--file-h1); text-shadow: none !important; }
    .markdown-editor-input.doc-link-hover { cursor: pointer; }
    .markdown-editor-input::selection { background: color-mix(in srgb, var(--file-h2) 34%, transparent); color: transparent !important; -webkit-text-fill-color: transparent !important; }
    .markdown-editor-highlight .markdown-line { margin: 0; padding: 0; border: 0; min-height: 1.7em; font-size: inherit; line-height: inherit; font-weight: inherit; letter-spacing: 0; }
    .markdown-editor-highlight .markdown-line.h1, .markdown-editor-highlight .markdown-line.h2, .markdown-editor-highlight .markdown-line.h3, .markdown-editor-highlight .markdown-line.h4 { margin: 0; padding: 0; border: 0; font-size: inherit; line-height: inherit; font-weight: inherit; }
    .markdown-editor-highlight .markdown-line.h1 { color: var(--file-h1); }
    .markdown-editor-highlight .markdown-line.h2 { color: var(--file-h2); }
    .markdown-editor-highlight .markdown-line.h3 { color: var(--file-h3); }
    .markdown-editor-highlight .markdown-line.h4 { color: var(--file-h4); }
    .markdown-editor-highlight .markdown-line.list { padding-left: 0; }
    .markdown-editor-highlight .markdown-line.list .markdown-marker, .markdown-editor-highlight .markdown-path { color: var(--file-list); }
    .markdown-editor-highlight .markdown-line.quote { color: var(--file-quote); border-left: 0; padding-left: 0; opacity: 1; }
    .markdown-editor-highlight .markdown-line.code, .markdown-editor-highlight .markdown-line.fence { color: var(--file-code); background: transparent; }
    .markdown-editor-highlight .markdown-line.frontmatter, .markdown-editor-highlight .markdown-line.hr { color: var(--file-marker); }
    .markdown-editor-highlight .markdown-inline-code { color: var(--file-code); padding: 0; border-radius: 0; background: transparent; }
    .markdown-editor-highlight .markdown-inline-code.markdown-path { color: var(--file-list); }
    .external-review-doc.editor-metrics .markdown-line { margin: 0; padding: 0; border: 0; min-height: 1.7em; font-size: inherit; line-height: inherit; font-weight: inherit; letter-spacing: 0; }
    .external-review-doc.editor-metrics .markdown-line.h1, .external-review-doc.editor-metrics .markdown-line.h2, .external-review-doc.editor-metrics .markdown-line.h3, .external-review-doc.editor-metrics .markdown-line.h4 { margin: 0; padding: 0; border: 0; font-size: inherit; line-height: inherit; font-weight: inherit; }
    .external-review-doc.editor-metrics .markdown-line.h1 { color: var(--file-h1); }
    .external-review-doc.editor-metrics .markdown-line.h2 { color: var(--file-h2); }
    .external-review-doc.editor-metrics .markdown-line.h3 { color: var(--file-h3); }
    .external-review-doc.editor-metrics .markdown-line.h4 { color: var(--file-h4); }
    .external-review-doc.editor-metrics .markdown-line.list { padding-left: 0; }
    .external-review-doc.editor-metrics .markdown-line.list .markdown-marker, .external-review-doc.editor-metrics .markdown-path { color: var(--file-list); }
    .external-review-doc.editor-metrics .markdown-line.quote { color: var(--file-quote); border-left: 0; padding-left: 0; opacity: 1; }
    .external-review-doc.editor-metrics .markdown-line.code, .external-review-doc.editor-metrics .markdown-line.fence { color: var(--file-code); background: transparent; }
    .external-review-doc.editor-metrics .markdown-line.frontmatter, .external-review-doc.editor-metrics .markdown-line.hr { color: var(--file-marker); }
    .external-review-doc.editor-metrics .markdown-inline-code { color: var(--file-code); padding: 0; border-radius: 0; background: transparent; }
    .external-review-doc.editor-metrics .markdown-inline-code.markdown-path { color: var(--file-list); }
    .agent-focus-pulse.markdown-line { border-radius: 8px; }
    .diff-line { display: block; padding: 1px 8px; border-radius: 6px; }
    .diff-line.add { color: #b9ffd0; background: rgba(141,240,180,0.08); }
    .diff-line.del { color: #ffc0c8; background: rgba(255,140,157,0.08); }
    .diff-line.hunk { color: #b69cff; background: rgba(182,156,255,0.08); }
    .diff-line.meta { color: var(--muted); }
    .diff-raw-meta { margin: var(--space-1) var(--space-5) 0; color: rgba(148,163,184,0.55); font: 10px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .diff-raw-meta summary { cursor: pointer; width: fit-content; list-style: none; font-family: Inter, ui-sans-serif, system-ui, sans-serif; font-size: 9px; font-weight: 750; color: rgba(148,163,184,0.42); }
    .diff-raw-meta summary::-webkit-details-marker { display: none; }
    .diff-raw-meta pre { margin: 6px 0 0; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.025); white-space: pre-wrap; }
    .diff-empty { padding: var(--space-5); color: var(--muted); font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    .conflict-panel { position: sticky; top: 0; z-index: 8; margin: var(--space-4); border: 1px solid rgba(255,196,107,0.54); border-radius: 16px; background: linear-gradient(135deg, rgba(255,196,107,0.18), rgba(255,140,157,0.12)); box-shadow: 0 14px 44px rgba(0,0,0,0.24); padding: var(--space-4); display: grid; gap: var(--space-3); font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #f7efe1; }
    .external-review-actions { align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .external-choice { min-height: 24px; padding: 4px 8px; border-radius: 999px; font-size: 11px; font-weight: 900; letter-spacing: 0; box-shadow: 0 6px 18px rgba(0,0,0,0.22); }
    .external-choice.icon { width: 25px; min-height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    .external-choice.bulk { min-height: 28px; padding: 5px 9px; font-size: 10px; }
    .external-change-stats { display: flex; gap: 6px; flex-wrap: wrap; color: rgba(226,236,255,0.82); font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .external-change-stats span { border: 1px solid rgba(148,163,184,0.16); border-radius: 999px; padding: 3px 7px; background: rgba(2,6,23,0.24); }
    .external-change-stats .add { color: #9cffbc; border-color: rgba(93,244,143,0.28); }
    .external-change-stats .del { color: #ffb2bf; border-color: rgba(255,140,157,0.32); }
    .external-change-stats .pending { color: #dbeafe; border-color: rgba(125,211,252,0.28); }
    .external-review-doc { white-space: normal; background: var(--file-bg); }
    .external-review-block { position: relative; min-width: 0; }
    .external-review-block.change { display: block; position: relative; margin: 0; padding: 0; border-radius: 0 10px 10px 0; background: linear-gradient(90deg, rgba(125,211,252,0.06), rgba(125,211,252,0.018) 72%, transparent); box-shadow: inset 2px 0 0 rgba(125,211,252,0.46); }
    .external-review-block.attention { outline: 2px solid rgba(139,211,255,0.82); outline-offset: 2px; animation: externalReviewAttention 1.4s ease; }
    .external-review-block.resolved { color: rgba(226,236,255,0.86); margin: 0; padding: 0; border-radius: 0 10px 10px 0; background: rgba(148,163,184,0.035); box-shadow: inset 2px 0 0 rgba(148,163,184,0.22); transition: min-height 180ms ease, background 220ms ease; }
    .external-review-block.resolved.settling { overflow: hidden; transition: height 2s ease, min-height 2s ease, margin 2s ease, padding 2s ease, background 220ms ease, box-shadow 220ms ease; }
    .external-review-block.resolved.accept { box-shadow: inset 2px 0 0 rgba(93,244,143,0.46); background: rgba(48,215,111,0.06); }
    .external-review-block.resolved.reject { box-shadow: inset 2px 0 0 rgba(255,140,157,0.42); background: rgba(255,86,117,0.055); }
    .external-review-block.resolved.settled { margin: 0; padding: 0; box-shadow: inset 0 0 0 transparent; background: transparent; }
    .external-review-block.resolved.settled.accept, .external-review-block.resolved.settled.reject { background: transparent; }
    .external-review-block.resolved.settled.empty { min-height: 0; height: 0; border: 0; overflow: hidden; }
    .external-review-lines { min-width: 0; }
    .external-review-block-controls { position: absolute; top: 4px; right: 4px; z-index: 2; display: flex; gap: 4px; align-items: center; padding: 2px; border: 1px solid var(--line); border-radius: 999px; background: var(--surface-floating-soft); opacity: 0.66; transition: opacity 140ms ease, transform 140ms ease, border-color 140ms ease; }
    .external-review-block.change:hover .external-review-block-controls, .external-review-block.change:focus-within .external-review-block-controls { opacity: 1; border-color: rgba(139,211,255,0.26); transform: translateY(-1px); }
    .external-review-line { position: relative; border-radius: 5px; }
    .external-review-line::before { content: attr(data-review-marker); position: absolute; left: -1.35em; top: 0; width: 1em; color: rgba(226,236,255,0.58); text-align: center; user-select: none; pointer-events: none; }
    .external-review-line.add { background: rgba(48,215,111,0.12); }
    .external-review-line.add::before { color: #8df0b4; }
    .external-review-line.del { background: rgba(255,86,117,0.12); }
    .external-review-line.del::before { color: #ff9cac; }
    .external-review-block.resolved.empty { min-height: 32px; overflow: hidden; }
    .agent-annotations { display: grid; gap: var(--space-2); padding: var(--space-3) var(--space-4) 0; }
    .agent-annotation { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--space-3); align-items: center; border-left: 2px solid rgba(182,156,255,0.62); border-radius: 0 10px 10px 0; background: rgba(182,156,255,0.075); padding: var(--space-2) var(--space-3); color: rgba(226,236,255,0.9); font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    .agent-annotation strong { display: block; color: #f2edff; font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 3px; }
    .agent-annotation code { color: var(--accent-2); font: 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
    .agent-annotation-actions { display: flex; gap: var(--space-1); align-items: center; }
    .agent-toast { position: fixed; right: var(--space-5); bottom: var(--space-5); z-index: 60; max-width: min(420px, calc(100vw - 40px)); border: 1px solid rgba(139,211,255,0.34); border-radius: 18px; background: rgba(13,22,42,0.96); box-shadow: var(--shadow); padding: var(--space-3); color: var(--text); font: 13px/1.4 Inter, ui-sans-serif, system-ui, sans-serif; }
    .agent-toast strong { display: block; margin-bottom: 4px; }
    .agent-toast-actions { display: flex; gap: var(--space-2); justify-content: flex-end; margin-top: var(--space-3); }
    .agent-focus-pulse { animation: agentFocusPulse 1.5s ease; }
    @keyframes externalReviewAttention { 0%, 100% { box-shadow: 0 0 0 rgba(139,211,255,0); } 28% { box-shadow: 0 0 0 6px rgba(139,211,255,0.16); } 56% { box-shadow: 0 0 0 2px rgba(139,211,255,0.08); } }
    @keyframes agentFocusPulse { 0%, 100% { box-shadow: 0 0 0 rgba(182,156,255,0); } 25% { box-shadow: 0 0 0 5px rgba(182,156,255,0.16), inset 0 0 0 1px rgba(182,156,255,0.34); } 60% { box-shadow: 0 0 0 2px rgba(182,156,255,0.1), inset 0 0 0 1px rgba(182,156,255,0.2); } }
    .conflict-panel strong { font-size: 15px; letter-spacing: 0; text-transform: none; }
    .conflict-panel p { margin: 0; color: #d9c9a8; font-size: 13px; line-height: 1.45; }
    .conflict-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .conflict-compare { display: grid; gap: 12px; min-width: 0; }
    .conflict-card { min-width: 0; border: 1px solid var(--line); border-radius: 14px; background: var(--surface-card); overflow: hidden; }
    .conflict-card-head { display: flex; justify-content: space-between; gap: var(--space-3); align-items: center; padding: var(--space-2) var(--space-3); border-bottom: 1px solid rgba(148,163,184,0.12); color: var(--muted); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.08em; }
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
    .conflict-merge { display: grid; gap: var(--space-3); padding: var(--space-3); }
    .conflict-merge textarea { display: block; width: 100%; min-height: min(42vh, 430px); resize: vertical; border: 1px solid rgba(148,163,184,0.18); border-radius: 12px; background: rgba(2,6,23,0.56); color: var(--text); outline: none; padding: 12px; font: 12px/1.48 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
    .conflict-merge-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
    @media (max-width: 760px) { .external-review-actions { flex-wrap: wrap; justify-content: flex-start; } .external-review-block-controls { position: static; width: fit-content; margin: 4px 0 2px 8px; opacity: 1; } .external-review-line::before { left: -1.05em; } }
    .file-header-copy { min-width: 0; display: grid; gap: var(--space-1); }
    .file-header-copy .diff-meta { white-space: normal; line-height: 1.35; }
    .file-actions { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
    .file-action { border: 1px solid rgba(148,163,184,0.18); border-radius: 12px; padding: var(--space-2) var(--space-3); min-height: 36px; background: rgba(255,255,255,0.06); color: var(--text); font-weight: 850; cursor: pointer; }
    .file-action:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .file-action.primary { color: var(--on-accent); border: 0; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .confirm-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: var(--space-5); background: rgba(2,6,23,0.72); backdrop-filter: blur(14px); }
    .confirm-dialog { width: min(420px, 100%); border: 1px solid var(--line); border-radius: 18px; background: var(--surface-floating); box-shadow: 0 22px 80px rgba(0,0,0,0.45); padding: var(--space-6); color: var(--text); }
    .confirm-dialog strong { display: block; font-size: 18px; line-height: 1.2; margin-bottom: 8px; }
    .confirm-dialog p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 18px; }
    @media (max-width: 1280px) { .review-workspace { grid-template-columns: 1fr; } .diff-code, .doc-content { max-height: none; } }
    .viewer a.path-link { color: var(--file-list); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--file-list) 36%, transparent); cursor: inherit; }
    .doc-link-modifier-active .viewer a.path-link:hover { color: var(--accent); border-bottom-color: color-mix(in srgb, var(--accent) 72%, transparent); cursor: pointer; }
    .mode-toggle { display: flex; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; }
    .mode-toggle button { border: 0; background: transparent; color: var(--muted); padding: var(--space-3); font-weight: 850; cursor: pointer; }
    .mode-toggle button.active { color: var(--on-accent); background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .cards { display: none; grid-template-columns: repeat(3, 1fr); gap: var(--space-3); margin: var(--space-5) 0; }
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
      .app, .app.sidebar-collapsed { grid-template-columns: 1fr; height: 100dvh; overflow: hidden; padding-top: 56px; }
      aside { position: fixed; z-index: 30; top: 0; left: 0; right: 0; height: min(62dvh, 560px); max-height: min(62dvh, 560px); border-right: 0; border-bottom: 1px solid var(--line); padding: var(--space-3); overflow: auto; box-shadow: 0 18px 60px rgba(0,0,0,0.42); }
      .app.sidebar-collapsed aside { height: 56px; max-height: 56px; padding: var(--space-2) var(--space-3); overflow: hidden; }
      .app.sidebar-collapsed .sidebar-toggle { position: absolute; left: auto; right: 10px; top: 8px; z-index: 31; width: 40px; height: 40px; }
      .app.sidebar-collapsed .sidebar-copy, .app.sidebar-collapsed .search-row, .app.sidebar-collapsed .watch-filter-row, .app.sidebar-collapsed .selection-bar, .app.sidebar-collapsed .explorer-title, .app.sidebar-collapsed .tree, .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateY(-8px); }
      .app.sidebar-collapsed .workspace-dock { opacity: 1; pointer-events: auto; transform: none; width: calc(100% - 50px); margin: 0; padding: 4px; overflow-x: auto; flex-wrap: nowrap; scrollbar-width: none; }
      .app.sidebar-collapsed .workspace-dock::-webkit-scrollbar { display: none; }
      .workspace-dock { margin-right: 50px; }
      .app:not(.sidebar-collapsed) .workspace-dock { margin-right: 0; }
      .dock-button { min-height: 36px; min-width: 36px; padding: 0 10px; white-space: nowrap; }
      #back.dock-button, #forward.dock-button { padding: 0; }
      .dock-button.diff-dock-button { padding: 0 11px; }
      .sidebar-head { position: absolute; right: 10px; top: 8px; display: block; }
      .app:not(.sidebar-collapsed) .sidebar-head { position: static; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-1) var(--space-1) var(--space-2); }
      .sidebar-copy { padding-right: 52px; }
      .app:not(.sidebar-collapsed) .sidebar-copy { padding-right: 0; flex: 1 1 auto; min-width: 0; }
      .sidebar-toggle { width: 40px; height: 40px; }
      main { height: calc(100dvh - 56px); padding: var(--space-3); overflow: hidden; }
      .editor-shell { height: 100%; min-height: 0; border-radius: 18px; }
      .docqa-home, .settings-page { height: 100%; padding: 12px; overflow: auto; }
      .docqa-panel { border-radius: 18px; }
      .docqa-panel header { padding: var(--space-4); align-items: flex-start; flex-direction: column; }
      .review-summary { width: 100%; }
      .review-summary-item { flex: 1; min-width: 0; }
      .review-list { max-height: none; }
      .review-item { padding: var(--space-3); }
      .review-top { align-items: flex-start; }
      .settings-grid, .hub-card-editor-grid, .template-editor-grid, .markdown-create { grid-template-columns: 1fr; }
      .settings-grid.compact { grid-template-columns: 1fr; }
      .settings-section-head { flex-direction: column; }
      .settings-section-actions { justify-content: flex-start; width: 100%; }
      .hub-section-editor, .hub-card-editor { gap: var(--space-3); padding: var(--space-3); }
      .hub-card-children:not(:empty) { margin-left: var(--space-1); padding-left: var(--space-2); }
      .markdown-create .settings-field.paths, .new-doc-title-field, .new-doc-compact-field, .path-picker-field, .path-picker-preview, .new-doc-actions { grid-column: 1; }
      .path-picker-main { grid-template-columns: 1fr; }
      .hub-folders { gap: var(--space-5); }
      .hub-folder-card { min-height: 116px; border-radius: 18px; }
      .hub-folder-card-main { min-height: 116px; padding: var(--space-4); border-radius: 18px; }
      .hub-folder-children { padding: 0 var(--space-3) var(--space-3); }
      .hub-folder-card strong { font-size: 18px; }
      .startup-context-item { grid-template-columns: 1fr; gap: var(--space-2); }
      textarea, .viewer { min-height: 100%; padding: 16px; font-size: 14px; line-height: 1.58; }
      .review-workspace { grid-template-columns: 1fr; gap: 12px; }
      .diff-code, .doc-content, .doc-editor { max-height: none; padding: 12px; font-size: 12px; }
      .diff-header, .file-panel header { padding: var(--space-3); align-items: flex-start; }
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
      .app, .app.sidebar-collapsed { grid-template-columns: 1fr; grid-template-rows: 1fr; height: 100dvh; padding: 52px 0 0; overflow: hidden; }
      .explorer-open { display: inline-flex; position: fixed; top: 8px; right: 8px; z-index: 35; width: 38px; height: 38px; border-radius: 12px; }
      .app.explorer-expanded .explorer-open { display: none; }
      .workspace-dock, .app.sidebar-collapsed .workspace-dock { position: fixed; top: 0; left: 0; right: 0; z-index: 33; width: 100%; height: 52px; margin: 0; padding: var(--space-2) 52px var(--space-2) var(--space-2); gap: var(--space-1); border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: var(--surface-floating); backdrop-filter: blur(18px); box-shadow: 0 8px 24px rgba(0,0,0,0.32); flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; opacity: 1; pointer-events: auto; transform: none; }
      .app.sidebar-collapsed .workspace-dock { width: 100%; padding: var(--space-2) 52px var(--space-2) var(--space-2); margin: 0; opacity: 1; }
      .app.explorer-expanded .workspace-dock { display: none; }
      .workspace-dock::-webkit-scrollbar { display: none; }
      .workspace-dock .dock-button { min-height: 36px; min-width: 36px; padding: 0 10px; white-space: nowrap; flex: 0 0 auto; }
      .workspace-dock #back.dock-button, .workspace-dock #forward.dock-button { padding: 0; }
      .workspace-dock .dock-button.diff-dock-button { padding: 0 11px; }
      .workspace-dock .dock-status { display: none; }
      aside { position: fixed; left: 0; right: 0; bottom: 0; top: auto; width: 100%; height: auto; max-height: 0; min-height: 0; margin: 0; padding: 0; border: 0; border-radius: 22px 22px 0 0; background: rgba(6,10,22,0.985); backdrop-filter: none; box-shadow: 0 -20px 70px rgba(0,0,0,0.55); overflow: auto; overscroll-behavior: contain; transition: transform 280ms cubic-bezier(.2,.9,.2,1), max-height 280ms ease, padding 280ms ease; transform: translateY(100%); pointer-events: none; }
      .app.explorer-expanded aside { height: min(66dvh, 560px) !important; max-height: min(66dvh, 560px) !important; padding: 0 var(--space-3) var(--space-4) !important; border-top: 1px solid var(--line) !important; transform: translateY(0) !important; pointer-events: auto !important; }
      .app.sidebar-collapsed aside { height: auto; max-height: 0; padding: 0; border: 0; transform: translateY(100%); pointer-events: none; }
      .sidebar-head { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-1); background: rgba(6,10,22,0.98); border-bottom: 1px solid rgba(148,163,184,0.16); }
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
      main { height: calc(100dvh - 52px); padding: var(--space-2); overflow: hidden; }
      .editor-shell { height: 100%; min-height: 0; border-radius: 16px; }
      .docqa-home, .settings-page { padding: var(--space-2); }
      .docqa-panel { border-radius: 16px; }
      .docqa-panel header { padding: 12px; }
      .review-summary-item { min-width: 0; }
      .review-item { padding: var(--space-3); }
      .hub-folders { gap: var(--space-4); margin-top: var(--space-3); }
      .hub-folder-card { min-height: 104px; border-radius: 16px; }
      .hub-folder-card-main { min-height: 104px; padding: var(--space-4); border-radius: 16px; }
      .hub-folder-children { padding: 0 var(--space-2) var(--space-2); gap: var(--space-2); }
      .hub-folder-children-grid { gap: var(--space-2); }
      .hub-folder-card strong { font-size: 17px; }
      .hub-folder-card span { font-size: 12px; }
      .hub-breadcrumb { padding: var(--space-2) var(--space-3); font-size: 11px; gap: var(--space-1); }
      .hub-crumb { padding: 6px 9px; font-size: 11px; }
      textarea, .viewer { min-height: 100%; padding: var(--space-4); font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
      .diff-code, .doc-content, .doc-editor { padding: 10px; font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
      .diff-header, .file-panel header { padding: var(--space-3); }
      .file-actions { gap: 6px; }
      .file-action { padding: 8px 10px; font-size: 13px; }
      .selected-title { font-size: 18px; }
      .selected-path, .selected-impact { font-size: 12px; }
      .selected-impact { margin-top: 8px; }
      .actions { gap: 8px; }
      button.primary, button.secondary { padding: var(--space-2) var(--space-3); min-height: 36px; font-size: 13px; }
      .history-nav button { min-width: 38px; padding: 8px 10px; }
      .mode-toggle button { padding: 9px 11px; font-size: 13px; }
      .settings-field textarea, .settings-field input { font-size: 12px; }
      .settings-footer { flex-direction: column; align-items: flex-start; gap: 8px; }
      .settings-section-head, .settings-section-body { padding: var(--space-3); }
      .settings-toggle { min-height: 58px; padding: 10px; }
      .hub-section-editor-head { grid-template-columns: 1fr; align-items: stretch; }
      .hub-section-editor-head button { justify-self: start; }
      .hub-card-editor-head { flex-direction: column; align-items: flex-start; }
      .hub-card-editor-head .docqa-actions { justify-content: flex-start; }
      .hub-card-children:not(:empty) { margin-left: 0; }
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
        <button id="gitDiffToggle" class="dock-button diff-dock-button" type="button" title="Show Git diff" hidden>Show Git diff</button>
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
                <div class="muted">watch scope, themes, sections, and hub cards</div>
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
  <div id="agentToast" class="agent-toast" hidden></div>
<script>
const state = { files: [], startupContextFiles: [], startupSkillFolders: [], activeStartupSkillExplorer: null, activeStartupContextExplorer: null, startupSkillCreateFolder: null, startupContextContextTarget: null, selectedStartupContext: null, docqa: null, doctor: null, settings: null, settingsOpen: false, page: "hub", pendingMarkdown: null, availableHubCards: [], hubFolders: [], hubSections: [], rootHubSections: [], activeHubCardId: null, selectedReview: null, reviewModePath: null, reviewModeStatus: null, selected: null, selectedDiff: null, fileConflict: null, externalChange: null, conflictCompare: false, conflictMergeText: null, conflictMergeKey: "", conflictMergeMode: "auto", conflictCheckTimer: null, diffCollapsed: false, saved: "", savedHash: null, dirty: false, mode: "view", homeView: "root", planetStack: ["root"], filePanel: false, history: [], historyIndex: -1, pathFilters: [], explorerWatchFilter: "all", explorerRenderKey: "", selectedForDelete: new Set(), selectionRequest: 0, openingFilePath: null, mobileSidebarTouched: false, sessionStateTimer: null, agentCommandTimer: null, lastAgentCommandId: "", pendingAgentCommand: null, agentAnnotations: {}, userActiveAt: 0, markdownHighlightFrame: 0, markdownHighlightText: "", markdownHighlightLastText: "", docLinkModifierActive: false, expanded: new Set(["data", "automations", "integrations", "skills", "tools", "~", "~/.hermes", "~/.hermes/memories", "~/.hermes/skills"]) };
const FILE_THEMES = ${JSON.stringify(FILE_THEME_OPTIONS)};
const DEFAULT_FILE_THEME = "${DEFAULT_FILE_THEME}";
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

function currentFileThemeId() {
  const wanted = state.settings?.appearance?.fileTheme || DEFAULT_FILE_THEME;
  return normalizeFileThemeId(wanted);
}

function normalizeFileThemeId(wanted) {
  return FILE_THEMES.some((theme) => theme.id === wanted) ? wanted : DEFAULT_FILE_THEME;
}

function applyFileTheme(themeId = currentFileThemeId()) {
  const clean = normalizeFileThemeId(themeId);
  document.documentElement.dataset.fileTheme = clean;
  document.documentElement.dataset.appTheme = clean;
}

function previewSelectedFileTheme() {
  const clean = normalizeFileThemeId(el("fileTheme")?.value || currentFileThemeId());
  applyFileTheme(clean);
  const label = el("settingsThemePreviewName");
  if (label) label.textContent = clean;
}

function autoOpenGitDiffEnabled() {
  return state.settings?.appearance?.autoOpenGitDiff !== false;
}

function collapsedByGitDiffPreference(diff) {
  return !(diff?.available !== false && diff?.changed && autoOpenGitDiffEnabled());
}

function renderFileThemeOptions(selected = currentFileThemeId()) {
  return FILE_THEMES.map((theme) =>
    '<option value="' + escapeHtml(theme.id) + '" ' + (theme.id === selected ? 'selected' : '') + '>' +
      escapeHtml(theme.label + " - " + theme.description) +
    '</option>'
  ).join("");
}

function scheduleSessionStatePush() {
  window.clearTimeout(state.sessionStateTimer);
  state.sessionStateTimer = window.setTimeout(() => publishSessionState().catch(() => {}), 280);
}

async function publishSessionState() {
  await api("/api/session-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSessionStatePayload()),
  });
}

function buildSessionStatePayload() {
  const externalChange = activeExternalChange();
  const blocks = externalChange ? buildExternalReviewBlocks(externalReviewBaseContent(externalChange), externalChange.diskContent || "", externalChange.reviewDecisions || {}) : [];
  const pendingMiniDiffs = blocks.filter((block) => block.kind === "change" && !block.decision).length;
  return {
    source: "webapp",
    page: state.page,
    view: state.page,
    openFile: state.selectedStartupContext ? state.selectedStartupContext.displayPath : state.selected,
    selectedPath: state.selected,
    visibleHeading: currentVisibleHeading(),
    scrollPercent: currentScrollPercent(),
    pendingMiniDiffs,
    gitDiffOpen: Boolean(state.selectedDiff?.changed && !state.diffCollapsed),
    diffCollapsed: Boolean(state.diffCollapsed),
    explorerFilter: state.explorerWatchFilter,
    pathFilters: state.pathFilters || [],
    selectedReview: state.selectedReview,
    dirty: Boolean(state.dirty),
    mode: state.mode,
    status: el("status")?.textContent || "",
  };
}

function currentScrollPercent() {
  const scroller = activeDocumentScrollTarget();
  if (!scroller) return 0;
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (!max) return 0;
  return Math.round((scroller.scrollTop / max) * 100);
}

function currentVisibleHeading() {
  if (state.page !== "file") return null;
  const renderedHeading = currentMarkdownViewHeading();
  if (renderedHeading) return renderedHeading;
  const editor = activeEditor();
  const text = editor?.value || state.saved || "";
  if (!text) return null;
  const lineIndex = activeEditorCaretLineIndex(editor) ?? approximateVisibleLineIndex();
  const lines = text.split("\n");
  for (let index = Math.min(lineIndex, lines.length - 1); index >= 0; index -= 1) {
    const match = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (match) return match[1] + " " + match[2].trim();
  }
  return null;
}

function currentMarkdownViewHeading() {
  const reader = visibleMarkdownReader();
  if (!reader) return null;
  const headings = [...reader.querySelectorAll("[data-heading-text]")];
  if (!headings.length) return null;
  const readerTop = reader.getBoundingClientRect().top;
  let current = null;
  for (const heading of headings) {
    if (heading.getBoundingClientRect().top <= readerTop + 80) current = heading;
    else break;
  }
  current = current || headings.find((heading) => heading.getBoundingClientRect().top >= readerTop);
  if (!current) return null;
  return (current.dataset.headingMarker || "#") + " " + (current.dataset.headingText || "").trim();
}

function visibleMarkdownReader() {
  const reader = el("docReader") || el("docHighlighter");
  if (!reader || reader.hidden) return null;
  const style = window.getComputedStyle(reader);
  if (style.display === "none" || style.visibility === "hidden") return null;
  return reader;
}

function activeEditorCaretLineIndex(editor) {
  if (!editor || document.activeElement !== editor || typeof editor.selectionStart !== "number" || typeof editor.value !== "string") return null;
  return editor.value.slice(0, Math.max(0, Math.min(editor.selectionStart, editor.value.length))).split("\n").length - 1;
}

function approximateVisibleLineIndex() {
  const editor = activeEditor();
  const scroller = activeDocumentScrollTarget();
  const target = editor || scroller;
  if (!target) return 0;
  const style = window.getComputedStyle(target);
  const fontSize = Number.parseFloat(style.fontSize) || 14;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.6;
  return Math.max(0, Math.floor((scroller?.scrollTop || target.scrollTop || 0) / Math.max(1, lineHeight)));
}

function startAgentCommandPolling() {
  if (state.agentCommandTimer) window.clearInterval(state.agentCommandTimer);
  state.agentCommandTimer = window.setInterval(() => pollAgentCommand().catch(() => {}), 1500);
  pollAgentCommand().catch(() => {});
}

async function pollAgentCommand() {
  const data = await api("/api/agent/command");
  const command = data.command;
  if (!command?.id || command.id === state.lastAgentCommandId) return;
  state.lastAgentCommandId = command.id;
  handleAgentCommand(command).catch((error) => setStatus(error.message));
}

async function handleAgentCommand(command) {
  if (shouldDeferAgentCommand(command)) {
    showAgentCommandToast(command);
    return;
  }
  await executeAgentCommand(command);
}

function shouldDeferAgentCommand(command) {
  if (!command) return false;
  if (state.dirty || activeExternalChange() || activeFileConflict()) return true;
  return Date.now() - (state.userActiveAt || 0) < 1200 && command.path && command.path !== state.selected;
}

function showAgentCommandToast(command) {
  state.pendingAgentCommand = command;
  const toast = el("agentToast");
  if (!toast) return;
  const label = command.path || command.view || "Context Room";
  toast.innerHTML = '<strong>Agent wants to navigate</strong><div>Open <code>' + escapeHtml(label) + '</code> without losing your current place?</div><div class="agent-toast-actions"><button class="file-action" type="button" data-agent-toast-dismiss>Later</button><button class="file-action primary" type="button" data-agent-toast-go>Go</button></div>';
  toast.hidden = false;
  toast.querySelector("[data-agent-toast-dismiss]")?.addEventListener("click", hideAgentToast);
  toast.querySelector("[data-agent-toast-go]")?.addEventListener("click", () => {
    const pending = state.pendingAgentCommand;
    hideAgentToast();
    if (pending) executeAgentCommand(pending).catch((error) => setStatus(error.message));
  });
}

function hideAgentToast() {
  state.pendingAgentCommand = null;
  const toast = el("agentToast");
  if (toast) toast.hidden = true;
}

async function executeAgentCommand(command) {
  hideAgentToast();
  const view = command.view || (command.path ? "file" : "hub");
  if (view === "settings") {
    showSettingsPage();
  } else if (view === "hub" && !command.path) {
    goHub();
  } else if (command.path) {
    await selectFile(command.path, { revealInExplorer: true, pushHistory: true });
    if (view === "diff" && state.selected === command.path) {
      state.selectedDiff = await api("/api/file/diff?path=" + encodeURIComponent(command.path)).catch(() => state.selectedDiff);
      if (state.selectedDiff?.changed) setDiffCollapsed(false);
    }
  }
  window.setTimeout(() => applyAgentScrollTarget(command), 120);
  setStatus("agent navigated context room");
  scheduleSessionStatePush();
}

function applyAgentScrollTarget(command) {
  const target = command?.target || null;
  if (!target) {
    if (command?.highlight !== false) pulseAgentFocus(visibleMarkdownReader() || activeEditor() || el("viewer"));
    return;
  }
  if (target.type === "percent") {
    const scroller = activeDocumentScrollTarget();
    if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * (Number(target.value) / 100);
    pulseAgentFocus(scroller);
    scheduleSessionStatePush();
    return;
  }
  const found = scrollToEditorNeedle(String(target.value || ""), target.type);
  if (!found) setStatus("agent target not found");
  scheduleSessionStatePush();
}

function scrollToEditorNeedle(needle, type = "text") {
  if (scrollMarkdownViewToNeedle(needle, type)) return true;
  const editor = activeEditor();
  if (!editor || !needle) return false;
  const value = editor.value || "";
  const offset = type === "heading" ? findHeadingOffset(value, needle) : value.toLowerCase().indexOf(needle.toLowerCase());
  if (offset < 0) return false;
  const lineIndex = value.slice(0, offset).split("\n").length - 1;
  const style = window.getComputedStyle(editor);
  const fontSize = Number.parseFloat(style.fontSize) || 14;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.6;
  editor.scrollTop = Math.max(0, lineIndex * lineHeight - editor.clientHeight * 0.34);
  if (typeof editor.setSelectionRange === "function") {
    editor.setSelectionRange(offset, Math.min(value.length, offset + needle.length));
    try { editor.focus({ preventScroll: true }); }
    catch { editor.focus(); }
  }
  pulseAgentFocus(editor);
  return true;
}

function scrollMarkdownViewToNeedle(needle, type = "text") {
  const reader = visibleMarkdownReader();
  if (!reader || !needle) return false;
  const wanted = String(needle || "").trim();
  if (!wanted) return false;
  const normalizedWanted = normalizeHeadingText(wanted);
  const lines = [...reader.querySelectorAll(".markdown-line")];
  const target = type === "heading"
    ? lines.find((line) => line.dataset.headingText && (normalizeHeadingText(line.dataset.headingText) === normalizedWanted || normalizeHeadingText((line.dataset.headingMarker || "") + " " + line.dataset.headingText) === normalizedWanted))
    : lines.find((line) => line.textContent.toLowerCase().includes(wanted.toLowerCase()));
  if (!target) return false;
  const scroller = el("docEditor") || reader;
  scroller.scrollTop = Math.max(0, target.offsetTop - scroller.clientHeight * 0.34);
  syncMarkdownEditorScroll();
  pulseAgentFocus(target);
  return true;
}

function findHeadingOffset(value, heading) {
  const wanted = normalizeHeadingText(heading);
  const pattern = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm;
  let match;
  while ((match = pattern.exec(value))) {
    if (normalizeHeadingText(match[1]) === wanted || normalizeHeadingText(match[0]) === wanted) return match.index;
  }
  return value.toLowerCase().indexOf(String(heading || "").toLowerCase());
}

function normalizeHeadingText(value) {
  return String(value || "").replace(/^#+\s*/, "").replace(/\s*#+$/, "").trim().toLowerCase();
}

function pulseAgentFocus(target) {
  if (!target?.classList) return;
  target.classList.remove("agent-focus-pulse");
  void target.offsetWidth;
  target.classList.add("agent-focus-pulse");
  window.setTimeout(() => target.classList.remove("agent-focus-pulse"), 1600);
}

async function loadAnnotationsForPath(path) {
  if (!path) return;
  const data = await api("/api/agent/annotations?path=" + encodeURIComponent(path));
  state.agentAnnotations[path] = data.annotations || [];
}

function unresolvedAnnotationsForSelectedFile() {
  if (!state.selected) return [];
  return (state.agentAnnotations[state.selected] || []).filter((annotation) => !annotation.resolved);
}

function renderAgentAnnotations(path) {
  const annotations = (state.agentAnnotations[path] || []).filter((annotation) => !annotation.resolved);
  if (!annotations.length) return "";
  return '<div class="agent-annotations" aria-label="Agent annotations">' + annotations.map((annotation) =>
    '<div class="agent-annotation" data-agent-annotation="' + escapeHtml(annotation.id) + '">' +
      '<div><strong>Agent note</strong><div>' + escapeHtml(annotation.note) + '</div>' + (annotation.target ? '<code>' + escapeHtml(annotation.target) + '</code>' : '') + '</div>' +
      '<div class="agent-annotation-actions"><button class="file-action" type="button" data-agent-annotation-goto="' + escapeHtml(annotation.id) + '">Go</button><button class="file-action" type="button" data-agent-annotation-resolve="' + escapeHtml(annotation.id) + '">Resolve</button></div>' +
    '</div>'
  ).join("") + '</div>';
}

function wireAgentAnnotationButtons(root = document) {
  root.querySelectorAll("[data-agent-annotation-goto]").forEach((button) => button.addEventListener("click", () => {
    const annotation = unresolvedAnnotationsForSelectedFile().find((item) => item.id === button.dataset.agentAnnotationGoto);
    if (!annotation) return;
    if (annotation.target) scrollToEditorNeedle(annotation.target, annotation.targetType || "text");
    else pulseAgentFocus(visibleMarkdownReader() || activeEditor() || el("viewer"));
  }));
  root.querySelectorAll("[data-agent-annotation-resolve]").forEach((button) => button.addEventListener("click", () => resolveAnnotation(button.dataset.agentAnnotationResolve).catch((error) => setStatus(error.message))));
}

async function resolveAnnotation(id) {
  if (!id || !state.selected) return;
  await api("/api/agent/annotations/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, path: state.selected }),
  });
  await loadAnnotationsForPath(state.selected);
  renderViewer();
  setStatus("annotation resolved");
}

function markUserActive() {
  state.userActiveAt = Date.now();
  scheduleSessionStatePush();
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
  scheduleSessionStatePush();
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

function explorerRenderKey(files) {
  return JSON.stringify({
    files: files.map((file) => [file.path, file.label, file.category]),
    selected: state.selected,
    selectedForDelete: [...state.selectedForDelete].sort(),
    expanded: [...state.expanded].sort(),
    search: el("search")?.value || "",
    pathFilters: state.pathFilters || [],
    watchFilter: state.explorerWatchFilter,
    watchAllow: state.settings?.watchAllow || [],
    activeStartupSkill: state.activeStartupSkillExplorer,
    activeStartupContext: state.activeStartupContextExplorer,
  });
}

function renderFiles({ force = false } = {}) {
  wireExplorerTreeEvents();
  const files = visibleFiles();
  const nextKey = explorerRenderKey(files);
  if (!force && state.explorerRenderKey === nextKey) {
    updateExplorerWatchFilterButtons();
    updateSelectionBar();
    return;
  }
  state.explorerRenderKey = nextKey;
  const tree = buildTree(files);
  el("files").innerHTML = renderTreeChildren(tree, 0);
  updateExplorerWatchFilterButtons();
  updateSelectionBar();
}

function wireExplorerTreeEvents() {
  const holder = el("files");
  if (!holder || holder.dataset.wired === "true") return;
  holder.dataset.wired = "true";
  holder.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const toggle = target.closest("[data-toggle-folder]");
    if (toggle && holder.contains(toggle)) {
      event.stopPropagation();
      openSidebarIfCollapsed();
      toggleFolder(toggle.dataset.toggleFolder);
      return;
    }
    const fileButton = target.closest("[data-file-path]");
    if (fileButton && holder.contains(fileButton)) {
      hideExplorerContextMenu();
      if (shouldToggleSelection(event)) toggleDeleteSelection(fileButton.dataset.filePath);
      else selectFile(fileButton.dataset.filePath).catch((error) => setStatus(error.message));
      return;
    }
    const folderButton = target.closest("[data-folder-path]");
    if (folderButton && holder.contains(folderButton)) {
      hideExplorerContextMenu();
      const selectPath = folderButton.dataset.folderPath + "/";
      if (shouldToggleSelection(event)) toggleDeleteSelection(selectPath);
      else {
        openSidebarIfCollapsed();
        toggleFolder(folderButton.dataset.folderPath);
      }
    }
  });
  holder.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const fileButton = target.closest("[data-file-path]");
    if (fileButton && holder.contains(fileButton)) {
      openExplorerContextMenu(event, { kind: "file", path: fileButton.dataset.filePath });
      return;
    }
    const folderButton = target.closest("[data-folder-path]");
    if (folderButton && holder.contains(folderButton)) {
      openExplorerContextMenu(event, { kind: "folder", path: folderButton.dataset.folderPath });
    }
  });
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

function markdownCreateDirectoryForTarget(target = state.explorerContextTarget) {
  const directory = normalizeUiPath(target?.directory || "").replace(/\/$/, "");
  return directory;
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
  const markdownDirectory = markdownCreateDirectoryForTarget(target);
  const markdownDirectoryLabel = markdownDirectory || "project root";
  const label = target.path || directoryLabel;
  const createActions = '<button class="secondary" type="button" data-context-new-file>New file</button>' +
    '<button class="secondary" type="button" data-context-new-folder>New folder</button>';
  const targetActions = target.path
    ? '<button class="secondary" type="button" data-context-watch>Watch</button>' +
      createActions +
      '<button class="secondary" type="button" data-context-select>Select</button>' +
      '<button class="secondary danger-action" type="button" data-context-delete>Delete</button>'
    : createActions;
  menu.innerHTML = '<div class="explorer-context-title"><span>Actions</span><code>' + escapeHtml(label) + '</code></div>' +
    '<div class="explorer-context-actions menu-actions" data-context-action-list>' +
      targetActions +
    '</div>' +
    '<div class="explorer-context-form" data-context-new-file-form hidden>' +
      '<div class="explorer-context-title"><span>New file</span><code>' + escapeHtml(markdownDirectoryLabel) + '</code></div>' +
      '<label class="explorer-context-label" for="contextMarkdownTitle">Name</label>' +
      '<input id="contextMarkdownTitle" placeholder="File name" value="New document" />' +
      '<div id="contextMarkdownError" class="explorer-context-error" hidden></div>' +
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
  el("contextCreateMarkdown")?.addEventListener("click", () => submitMarkdownFromContextMenu());
  el("contextMarkdownTitle")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    submitMarkdownFromContextMenu();
  });
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
  setContextMarkdownError("");
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
  const directory = markdownCreateDirectoryForTarget();
  const relPath = markdownPathFromName(directory, title);
  if (!relPath) throw new Error("New markdown name is required");
  setStatus("creating file...");
  const result = await api("/api/markdown/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: relPath, title, applyTemplate: false }),
  });
  hideExplorerContextMenu();
  const parent = parentDirectoryFromUiPath(result.path);
  if (parent) state.expanded.add(parent);
  await loadFiles();
  await selectFile(result.path, { revealInExplorer: true });
  setStatus("file created");
}

async function submitMarkdownFromContextMenu() {
  const button = el("contextCreateMarkdown");
  setContextMarkdownError("");
  if (button?.disabled) return;
  const previousLabel = button?.textContent || "Create";
  if (button) {
    button.disabled = true;
    button.textContent = "Creating...";
  }
  try {
    await createMarkdownFromContextMenu();
  } catch (error) {
    setContextMarkdownError(error.message || "Could not create file");
    setStatus(error.message || "Could not create file");
  } finally {
    if (button && document.body.contains(button)) {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
}

function setContextMarkdownError(message) {
  const box = el("contextMarkdownError");
  if (!box) return;
  box.textContent = message || "";
  box.hidden = !message;
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
    state.openingFilePath = null;
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
  scheduleSessionStatePush();
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
  scheduleSessionStatePush();
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
  const [data, docqa, doctor, settingsData, startupData, startupSkillsData] = await Promise.all([api(filesApiPath()), api("/api/docqa"), api("/api/doctor"), api("/api/settings"), api("/api/startup-context"), api("/api/startup-skills")]);
  state.files = data.files;
  state.startupContextFiles = startupData.files || [];
  state.startupSkillFolders = startupSkillsData.folders || [];
  state.docqa = docqa;
  state.doctor = doctor;
  state.settings = settingsData.settings;
  applyFileTheme();
  state.availableHubCards = settingsData.availableHubCards || [];
  state.hubFolders = settingsData.hubCards || [];
  state.rootHubSections = settingsData.hubSections || [];
  state.hubSections = state.rootHubSections;
  state.selectedReview = docqa.queue[0]?.path || null;
  renderFiles();
  if (!state.selected) showHome();
  setStatus("ready");
  scheduleSessionStatePush();
}

function filesApiPath() {
  const params = new URLSearchParams();
  const activeSkill = state.activeStartupSkillExplorer;
  const activeContext = state.activeStartupContextExplorer;
  if (activeSkill?.folder && activeSkill?.skill) {
    params.set("startupSkillFolder", activeSkill.folder);
    params.set("startupSkill", activeSkill.skill);
  }
  if (activeContext?.order) params.set("startupContextOrder", activeContext.order);
  const query = params.toString();
  return query ? "/api/files?" + query : "/api/files";
}

async function selectFile(path, options = {}) {
  if (!path) return;
  if (state.selected && path !== state.selected && !options.forceReload && blockPendingExternalChange("before changing file")) return;
  if (state.dirty && !options.forceReload && !confirm("You have unsaved changes. Change file?")) return;

  const requestId = ++state.selectionRequest;
  state.selected = path;
  state.openingFilePath = path;
  state.selectedStartupContext = null;
  state.activeStartupContextExplorer = null;
  state.reviewModePath = options.reviewMode ? path : null;
  state.reviewModeStatus = options.reviewMode ? reviewStatusForPath(path) : null;
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
  state.mode = "edit";
  state.filePanel = false;
  state.diffCollapsed = !autoOpenGitDiffEnabled();
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
    state.openingFilePath = null;
    el("editor").value = data.content;
    await loadAnnotationsForPath(path).catch(() => {});
    if (options.pushHistory !== false) pushHistory(path);
    updateHeader();
    updateHistoryButtons();
    updatePreview();
    renderViewer();
    setStatus("open");

    const loadDiff = async () => {
      const diff = await readSelectedDiff(path);
      if (!isCurrentSelection(requestId, path)) return;
      state.selectedDiff = diff;
      state.diffCollapsed = collapsedByGitDiffPreference(diff);
      if (options.reviewMode && diff?.changed) await startChangedFileInlineReview(path, diff, requestId);
      renderViewer();
    };
    if (options.reviewMode) await loadDiff().catch((error) => {
      if (isCurrentSelection(requestId, path)) setStatus(error.message);
    });
    else loadDiff().catch((error) => {
      if (isCurrentSelection(requestId, path)) setStatus(error.message);
    });
  } catch (error) {
    if (isCurrentSelection(requestId, path)) {
      state.openingFilePath = null;
      setStatus(error.message);
    }
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
  state.openingFilePath = selectedKey;
  state.selectedStartupContext = pendingFile?.startupContext || { order, fileName: "Startup context", displayPath: "" };
  state.reviewModePath = null;
  state.reviewModeStatus = null;
  state.selectedDiff = null;
  resetExternalChangeState();
  state.saved = "";
  state.savedHash = null;
  state.dirty = false;
  state.mode = "edit";
  state.page = "file";
  state.settingsOpen = false;
  state.pendingMarkdown = null;
  state.pathFilters = [];
  el("search").value = "";
  openSidebarIfCollapsed();
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
    const selectedPath = startupContextSelectedExplorerPath(data.startupContext);
    state.selected = selectedPath || selectedKey;
    activateStartupContextExplorer(data.startupContext);
    state.saved = data.content;
    state.savedHash = data.contentHash;
    state.openingFilePath = null;
    el("editor").value = data.content;
    await loadFiles();
    revealActiveStartupContextExplorer();
    updateHeader();
    updatePreview();
    renderViewer();
    setStatus("startup context open");
    scheduleSessionStatePush();
  } catch (error) {
    if (isCurrentSelection(requestId, selectedKey)) {
      state.openingFilePath = null;
      setStatus(error.message);
    }
  }
}

async function selectStartupSkillFile(folderOrder, skillName) {
  if (!folderOrder || !skillName) return;
  if (state.dirty && !confirm("You have unsaved changes. Change file?")) return;
  const requestId = ++state.selectionRequest;
  const selectedKey = "startup-skill-" + folderOrder + "-" + skillName;
  state.selected = selectedKey;
  state.openingFilePath = selectedKey;
  state.activeStartupContextExplorer = null;
  state.selectedStartupContext = { order: folderOrder + ":" + skillName, fileName: skillName + "/SKILL.md", displayPath: "Startup skill" };
  state.reviewModePath = null;
  state.reviewModeStatus = null;
  state.selectedDiff = null;
  resetExternalChangeState();
  state.saved = "";
  state.savedHash = null;
  state.dirty = false;
  state.mode = "edit";
  state.page = "file";
  state.settingsOpen = false;
  state.pendingMarkdown = null;
  state.pathFilters = [];
  el("search").value = "";
  openSidebarIfCollapsed();
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
  setStatus("opening startup skill...");
  try {
    const data = await api("/api/startup-skills/file?folder=" + encodeURIComponent(folderOrder) + "&skill=" + encodeURIComponent(skillName));
    if (!isCurrentSelection(requestId, selectedKey)) return;
    state.selectedStartupContext = data.startupContext;
    state.selected = startupSkillSelectedExplorerPath(data.startupContext) || selectedKey;
    activateStartupSkillExplorer(folderOrder, data.startupContext?.skillName || skillName, data.startupContext);
    state.saved = data.content;
    state.savedHash = data.contentHash;
    state.openingFilePath = null;
    el("editor").value = data.content;
    await loadFiles();
    revealActiveStartupSkillExplorer();
    updateHeader();
    updatePreview();
    renderViewer();
    setStatus("startup skill open");
    scheduleSessionStatePush();
  } catch (error) {
    if (isCurrentSelection(requestId, selectedKey)) {
      state.openingFilePath = null;
      setStatus(error.message);
    }
  }
}

function createStartupSkillFromPanel(folderOrder) {
  if (!folderOrder) return;
  if (state.dirty && !confirm("You have unsaved changes. Create a new skill?")) return;
  state.startupSkillCreateFolder = String(folderOrder);
  renderHubFolders();
  focusStartupSkillCreateInput(folderOrder);
}

function focusStartupSkillCreateInput(folderOrder) {
  window.requestAnimationFrame(() => {
    const input = document.querySelector('[data-startup-skill-create-input="' + cssEscape(String(folderOrder)) + '"]');
    input?.focus();
    input?.select();
  });
}

function cancelStartupSkillCreate() {
  state.startupSkillCreateFolder = null;
  renderHubFolders();
  setStatus("skill creation cancelled");
}

async function submitStartupSkillCreateForm(folderOrder) {
  if (!folderOrder) return;
  const input = document.querySelector('[data-startup-skill-create-input="' + cssEscape(String(folderOrder)) + '"]');
  const rawName = input?.value || "";
  const skillName = slugifyUiId(rawName);
  if (!skillName) {
    setStatus("skill name required");
    input?.focus();
    return;
  }
  setStatus("creating startup skill...");
  const result = await api("/api/startup-skills/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder: folderOrder, skill: skillName }),
  });
  state.startupSkillCreateFolder = null;
  state.startupSkillFolders = (await api("/api/startup-skills")).folders || [];
  renderHubFolders();
  await selectStartupSkillFile(folderOrder, result.startupContext?.skillName || skillName);
  setStatus("startup skill created");
}

function activateStartupSkillExplorer(folderOrder, skillName, startupContext = null) {
  const rootPath = startupSkillExplorerRootFromContext(startupContext);
  if (!rootPath) {
    state.activeStartupSkillExplorer = null;
    return;
  }
  state.activeStartupSkillExplorer = {
    folder: String(folderOrder),
    skill: String(skillName || startupContext?.skillName || ""),
    rootPath,
  };
}

function startupSkillExplorerRootFromContext(startupContext = null) {
  if (startupContext?.kind !== "startup-skill") return "";
  if (startupContext.explorerRoot) return normalizeUiPath(startupContext.explorerRoot).replace(/\/$/, "");
  const folder = normalizeUiPath(startupContext.folder || "").replace(/\/$/, "");
  const skillName = normalizeUiPath(startupContext.skillName || "").replace(/\/$/, "");
  const fileName = normalizeUiPath(startupContext.fileName || "");
  if (folder && skillName && fileName.endsWith("/SKILL.md")) return folder + "/" + skillName;
  return parentDirectoryFromUiPath(startupContext.displayPath || "");
}

function startupSkillSelectedExplorerPath(startupContext = state.selectedStartupContext) {
  if (startupContext?.kind !== "startup-skill") return "";
  if (startupContext.explorerPath) return normalizeUiPath(startupContext.explorerPath).replace(/\/$/, "");
  return normalizeUiPath(startupContext.displayPath || "").replace(/\/$/, "");
}

function activateStartupContextExplorer(startupContext = null) {
  const selectedPath = startupContextSelectedExplorerPath(startupContext);
  if (!selectedPath) {
    state.activeStartupContextExplorer = null;
    return;
  }
  state.activeStartupContextExplorer = {
    order: String(startupContext.order || ""),
    path: selectedPath,
  };
}

function startupContextSelectedExplorerPath(startupContext = state.selectedStartupContext) {
  if (startupContext?.kind !== "startup-context") return "";
  if (startupContext.explorerPath) return normalizeUiPath(startupContext.explorerPath).replace(/\/$/, "");
  return normalizeUiPath(startupContext.displayPath || "").replace(/\/$/, "");
}

function expandAndRevealExplorerPath(path) {
  const clean = normalizeUiPath(path).replace(/\/$/, "");
  if (!clean) return;
  for (const folder of parentFolders(clean).slice(0, -1)) state.expanded.add(folder);
  renderFiles({ force: true });
  scrollExplorerToPath(clean);
}

function revealActiveStartupSkillExplorer() {
  const rootPath = normalizeUiPath(state.activeStartupSkillExplorer?.rootPath || "").replace(/\/$/, "");
  if (!rootPath) return;
  const selectedPath = startupSkillSelectedExplorerPath();
  expandAndRevealExplorerPath(selectedPath || rootPath);
}

function revealActiveStartupContextExplorer() {
  const selectedPath = startupContextSelectedExplorerPath();
  expandAndRevealExplorerPath(selectedPath || state.activeStartupContextExplorer?.path || "");
}

function startupContextFileByOrder(order) {
  return (state.startupContextFiles || []).find((file) => String(file.startupContext?.order || "") === String(order || ""));
}

function openStartupContextContextMenu(event, order) {
  event.preventDefault();
  event.stopPropagation();
  const file = startupContextFileByOrder(order);
  const startupContext = file?.startupContext;
  if (!startupContext) return;
  state.startupContextContextTarget = startupContext;
  const menu = el("explorerContextMenu");
  if (!menu) return;
  menu.innerHTML = '<div class="explorer-context-title"><span>Startup context</span><code>' + escapeHtml(startupContext.displayPath || startupContext.fileName || "startup context") + '</code></div>' +
    '<div class="explorer-context-actions menu-actions">' +
      '<button class="secondary" type="button" data-startup-context-open>Open</button>' +
      '<button class="secondary danger-action" type="button" data-startup-context-delete>Delete</button>' +
    '</div>';
  menu.hidden = false;
  menu.style.left = event.clientX + "px";
  menu.style.top = event.clientY + "px";
  clampContextMenuToViewport(menu);
  menu.querySelector("[data-startup-context-open]")?.addEventListener("click", () => {
    hideExplorerContextMenu();
    selectStartupContextFile(startupContext.order).catch((error) => setStatus(error.message));
  });
  menu.querySelector("[data-startup-context-delete]")?.addEventListener("click", () => {
    hideExplorerContextMenu();
    deleteStartupContextFromPanel(startupContext.order).catch((error) => setStatus(error.message));
  });
}

async function deleteStartupContextFromPanel(order) {
  if (!order) return;
  const file = startupContextFileByOrder(order);
  const startupContext = file?.startupContext || state.startupContextContextTarget;
  if (!startupContext) return;
  const isCurrent = String(state.selectedStartupContext?.order || "") === String(order);
  const unsavedNote = isCurrent && state.dirty ? "\n\nUnsaved editor changes will be lost." : "";
  if (!confirm("Delete startup context file?\n\n" + startupContext.displayPath + "\n\nContext Room will back it up first." + unsavedNote)) return;
  setStatus("deleting startup context...");
  const result = await api("/api/startup-context/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order }),
  });
  if (isCurrent) {
    state.activeStartupContextExplorer = null;
    state.selected = null;
    state.selectedStartupContext = null;
    state.saved = "";
    state.savedHash = null;
    state.dirty = false;
  }
  await loadFiles();
  setStatus(result.backupPath ? "startup context deleted · backup created" : "startup context deleted");
}

async function deleteStartupSkillFromPanel(folderOrder, skillName) {
  if (!folderOrder || !skillName) return;
  const selectedKey = "startup-skill-" + folderOrder + "-" + skillName;
  const unsavedNote = state.selected === selectedKey && state.dirty ? "\n\nUnsaved editor changes will be lost." : "";
  if (!confirm("Delete startup skill " + skillName + "? Context Room will back it up first." + unsavedNote)) return;
  setStatus("deleting startup skill...");
  const result = await api("/api/startup-skills/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ folder: folderOrder, skill: skillName }),
  });
  state.startupSkillFolders = (await api("/api/startup-skills")).folders || [];
  if (state.selected === selectedKey) {
    state.activeStartupSkillExplorer = null;
    state.selected = null;
    state.selectedStartupContext = null;
    showHome();
  } else {
    renderHubFolders();
  }
  setStatus(result.backupPath ? "startup skill deleted · backup created" : "startup skill deleted");
}

function scrollExplorerToPath(path) {
  const aside = document.querySelector("aside");
  const clean = normalizeUiPath(path).replace(/\/$/, "");
  const target = document.querySelector('[data-file-path="' + cssEscape(clean) + '"]') || document.querySelector('[data-folder-path="' + cssEscape(clean) + '"]');
  if (!aside || !target) return;
  aside.scrollTop += target.getBoundingClientRect().top - aside.getBoundingClientRect().top - 120;
}

function showHome() {
  state.page = "hub";
  state.openingFilePath = null;
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
  scheduleSessionStatePush();
}

function renderDocQaDashboard() {
  const report = state.docqa;
  if (!report) return;
  const s = report.summary;
  el("reviewSummary").innerHTML = renderReviewSummary(s);
  const queue = report.queue.length ? report.queue : [];
  el("reviewQueue").innerHTML = queue.length ? queue.map(renderReviewItem).join("") : '<div class="issue">No watched files changed or created in the current worktree.</div>';
  document.querySelectorAll("[data-review-path]").forEach((button) => button.addEventListener("click", () => {
    selectFile(button.dataset.reviewPath, { revealInExplorer: !isNarrowLayout(), reviewMode: true }).catch((error) => setStatus(error.message));
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
  state.openingFilePath = null;
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
  scheduleSessionStatePush();
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
    '<div class="settings-field new-doc-title-field"><label for="markdownCreateTitle">Title</label><input id="markdownCreateTitle" value="' + escapeHtml(pending.title) + '" /></div>' +
    '<div class="settings-field path-picker-field"><label>Path</label><div class="path-picker" data-path-picker>' +
      '<input id="markdownCreateFolder" type="hidden" value="' + escapeHtml(initialFolder) + '" />' +
      '<input id="markdownCreatePath" type="hidden" value="' + escapeHtml(initialPreview) + '" />' +
      '<div class="path-picker-main">' +
        '<div class="path-picker-control"><span class="path-picker-control-title">Location</span><div class="locked-folder-display"><code id="markdownCreateFolderDisplay">' + escapeHtml(pathFolderLabel(initialFolder)) + '</code><span>selected</span></div></div>' +
        '<div class="path-picker-control"><label class="path-picker-control-title" for="markdownCreateFileName">File</label><input id="markdownCreateFileName" aria-label="File name" data-auto-name="true" value="' + escapeHtml(initialFileName) + '" /></div>' +
      '</div>' +
      '<div class="path-picker-preview"><span>final path</span><code id="markdownCreatePathPreview">' + escapeHtml(initialPreview) + '</code></div>' +
    '</div></div>' +
    '<div class="settings-field new-doc-compact-field"><label for="markdownCreateTemplate">Template</label><select id="markdownCreateTemplate">' + renderTemplateOptions("context-golden") + '</select></div>' +
    '<div class="settings-field new-doc-compact-field"><label for="markdownCreateKind">Kind</label><select id="markdownCreateKind"><option value="canonical">canonical</option><option value="index">index</option><option value="agents">agents</option><option value="procedure">procedure</option><option value="decision">decision</option></select></div>' +
    '<div class="settings-field new-doc-compact-field"><label for="markdownCreateScope">Scope</label><input id="markdownCreateScope" value="project" /></div>' +
    '<div class="settings-field new-doc-compact-field"><label for="markdownCreateStatus">Status</label><select id="markdownCreateStatus"><option value="current">current</option><option value="draft">draft</option><option value="historical">historical</option><option value="superseded">superseded</option></select></div>' +
    '<div class="settings-field new-doc-compact-field"><label for="markdownCreateCanonical">Canonical for</label><input id="markdownCreateCanonical" value="' + escapeHtml(canonical) + '" placeholder="feature or system name" /></div>' +
    '<div class="settings-field paths"><label for="markdownCreateSources">Sources</label><textarea id="markdownCreateSources" placeholder="one source path or URL per line"></textarea></div>' +
    '<div class="new-doc-actions"><button id="cancelStructuredMarkdown" class="secondary" type="button">Cancel</button><button id="createStructuredMarkdown" class="primary" type="button">Create file</button></div>' +
  '</div>';
  el("markdownCreateTitle")?.addEventListener("input", suggestStructuredMarkdownPath);
  el("markdownCreateFileName")?.addEventListener("input", () => {
    el("markdownCreateFileName").dataset.autoName = "false";
    updateStructuredMarkdownPath();
  });
  el("markdownCreateFileName")?.addEventListener("blur", normalizeStructuredFileName);
  el("markdownCreateTemplate")?.addEventListener("change", syncStructuredTemplateKind);
  el("cancelStructuredMarkdown")?.addEventListener("click", () => goHub());
  el("createStructuredMarkdown")?.addEventListener("click", () => createStructuredMarkdownFromWizard().catch((error) => setStatus(error.message)));
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

function pathFolderLabel(folder = "") {
  return folder ? normalizeUiPath(folder).replace(/\/$/, "") + "/" : "project root";
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
  const cleanFolder = normalizeUiPath(folder).replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const cleanFileName = markdownFileNameFromName(fileName);
  return (cleanFolder ? cleanFolder + "/" : "") + cleanFileName;
}

function updateStructuredMarkdownPath() {
  const folder = normalizeUiPath(el("markdownCreateFolder")?.value || "").replace(/^\/+/, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
  const fileName = el("markdownCreateFileName")?.value || el("markdownCreateTitle")?.value || "New document";
  const relPath = markdownPathFromParts(folder, fileName);
  const pathInput = el("markdownCreatePath");
  const folderInput = el("markdownCreateFolder");
  const folderDisplay = el("markdownCreateFolderDisplay");
  const preview = el("markdownCreatePathPreview");
  if (pathInput) pathInput.value = relPath;
  if (folderInput) folderInput.value = folder;
  if (folderDisplay) folderDisplay.textContent = pathFolderLabel(folder);
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

function renderFileTemplateOptions(selectedId = "") {
  return '<option value="" disabled ' + (!selectedId ? 'selected' : '') + '>Choose template...</option>' + renderTemplateOptions(selectedId);
}

function renderReviewSummary(summary = {}) {
  const changed = Number(summary.changedDocs || 0).toLocaleString("en-US");
  const needsReview = Number(summary.needsReview || 0).toLocaleString("en-US");
  return '<div class="review-summary-item"><strong>' + changed + '</strong><span>changed</span></div>' +
    '<div class="review-summary-item"><strong>' + needsReview + '</strong><span>to review</span></div>';
}

function gitStatusLabel(status, reviewRequired = false) {
  const clean = String(status || "").trim();
  if (!clean && reviewRequired) return "review";
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
  const gitLabel = gitStatusLabel(item.gitStatus, item.reviewRequired);
  return '<button class="review-item ' + (state.selectedReview === item.path ? "active" : "") + '" type="button" data-review-path="' + escapeHtml(item.path) + '">' +
    '<div class="review-top"><div class="review-title">' + escapeHtml(item.label || item.path) + '</div><span class="chip high">' + escapeHtml(gitLabel) + '</span></div>' +
    '<div class="review-path">' + escapeHtml(item.path) + '</div>' +
    '<div class="chips"><span class="chip">' + escapeHtml(item.classification.type) + '</span><span class="chip">open to review</span></div>' +
  '</button>';
}

function renderFileActionButtons(options = {}) {
  return '<div class="file-actions">' + renderFileActionItems(options) + '</div>';
}

function renderFileActionItems({ reviewAction = null, dirty = false, templateState = null, blockedByConflict = false, deletable = true } = {}) {
  return '' +
    (templateState ? '<div class="empty-template-actions"><select class="file-template-select" data-empty-template-select aria-label="Template">' + renderFileTemplateOptions(templateState.selectedId) + '</select></div>' : '') +
    (reviewAction ? '<button class="file-action" type="button" data-file-review-decision="' + escapeHtml(reviewAction.status) + '">' + escapeHtml(reviewAction.label) + '</button>' : '') +
    (deletable ? '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' : '') +
    '<button class="file-action primary" type="button" data-file-save ' + (!dirty || blockedByConflict ? 'disabled' : '') + (blockedByConflict ? ' title="Resolve the disk change before saving"' : '') + '>Save</button>';
}

function reviewStatusForPath(path) {
  const item = state.docqa?.queue?.find((entry) => entry.path === path);
  return item?.review?.current ? item.review.status || null : null;
}

function reviewActionForSelectedFile() {
  if (!state.selected || state.reviewModePath !== state.selected) return null;
  if (state.reviewModeStatus === "verified") return { status: "unverified", label: "Mark unverified" };
  return { status: "verified", label: "Mark verified" };
}

const SETTINGS_THEME_PREVIEW_DOC = "# Preview document\n\n> Scope: docs/\n\n## Read first\n\n- Start in docs/INDEX.md.\n- Keep website/docs/ current.\n\n### Paths\n\nUse AGENTS.md, website/docs/, and our_agentic_system/docs/.";

function renderSettingsSection({ kicker, title, copy, pills = [], body = "", open = true } = {}) {
  return '<details class="settings-section collapsible" ' + (open ? 'open' : '') + '>' +
    '<summary class="settings-section-head">' +
      '<div class="settings-section-title"><span class="settings-kicker">' + escapeHtml(kicker || "") + '</span><h3>' + escapeHtml(title || "") + '</h3>' + (copy ? '<p class="settings-section-copy">' + escapeHtml(copy) + '</p>' : '') + '</div>' +
      '<div class="settings-section-actions">' + pills.map((pill) => '<span class="settings-pill">' + escapeHtml(pill) + '</span>').join("") + '<span class="settings-pill settings-section-toggle" aria-hidden="true"></span></div>' +
    '</summary>' +
    '<div class="settings-section-body">' + body + '</div>' +
  '</details>';
}

function renderSettingsThemePreview(themeId = currentFileThemeId()) {
  return '<div class="settings-theme-preview" aria-label="Document theme preview">' +
    '<div class="settings-theme-preview-head"><span>Document preview</span><code id="settingsThemePreviewName">' + escapeHtml(themeId) + '</code></div>' +
    '<div class="doc-editor markdown-view">' + renderMarkdownLines(SETTINGS_THEME_PREVIEW_DOC) + '</div>' +
  '</div>';
}

function renderSettingsPanel() {
  const holder = el("settingsPanel");
  if (!holder || !state.settings) return;
  const watchAllow = (state.settings.watchAllow || []).join("\n");
  const reviewPaths = (state.settings.reviewPaths || []).join("\n");
  const bestPractices = (state.settings.bestPractices || []).join("\n");
  const startupContext = state.settings.startupContext || { enabled: false, fileNames: ["AGENTS.md", "CLAUDE.md"] };
  const startupFileNames = (startupContext.fileNames || []).join("\n");
  const startupSkills = state.settings.startupSkills || { enabled: true, folderNames: [".codex/skills", "skills"] };
  const startupSkillFolderNames = (startupSkills.folderNames || []).join("\n");
  const appearance = state.settings.appearance || { fileTheme: DEFAULT_FILE_THEME, autoOpenGitDiff: true };
  const markdownTemplates = state.settings.markdownTemplates || [];
  const sections = state.settings.hubSections?.length ? state.settings.hubSections : [{ id: "main", title: "Main", cards: state.settings.customHubCards || state.availableHubCards || [] }];
  const watchCount = (state.settings.watchAllow || []).length;
  const reviewPathCount = (state.settings.reviewPaths || []).length;
  const practiceCount = (state.settings.bestPractices || []).length;
  const startupContextCount = (startupContext.fileNames || []).length;
  const startupSkillFolderCount = (startupSkills.folderNames || []).length;
  holder.innerHTML = '<div class="settings-shell">' +
  renderSettingsSection({
    kicker: "Review",
    title: "Watched docs",
    copy: "Changed files listed here require human review before handoff.",
    pills: [watchCount + " watched", reviewPathCount + " required", practiceCount + " rules"],
    open: true,
    body: '<div class="settings-grid">' +
      '<div class="settings-field large"><label for="watchAllow">Watched folders/files</label><span class="settings-field-note">One path per line.</span><textarea id="watchAllow" placeholder="docs/&#10;website/docs/">' + escapeHtml(watchAllow) + '</textarea></div>' +
      '<div class="settings-field large"><label for="reviewPaths">Required review files</label><span class="settings-field-note">Important files that stay in review until verified, even without a Git diff.</span><textarea id="reviewPaths" placeholder="AGENTS.md&#10;docs/INDEX.md">' + escapeHtml(reviewPaths) + '</textarea></div>' +
      '<div class="settings-field large"><label for="bestPractices">Docs best practices</label><span class="settings-field-note">Short rules shown on the hub.</span><textarea id="bestPractices" placeholder="one practice per line">' + escapeHtml(bestPractices) + '</textarea></div>' +
    '</div>',
  }) +
  renderSettingsSection({
    kicker: "Startup",
    title: "Injected context scanners",
    copy: "Files and skill folders discovered above this Context Room root.",
    pills: [startupContextCount + " names", startupSkillFolderCount + " folders"],
    open: true,
    body: '<div class="settings-grid">' +
      '<div class="settings-field"><label class="settings-toggle" for="startupContextEnabled"><input id="startupContextEnabled" type="checkbox" ' + (startupContext.enabled ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Startup context</strong><em>List agent instruction files above the repo.</em></span></label><textarea id="startupContextFileNames" placeholder="one filename per line">' + escapeHtml(startupFileNames) + '</textarea></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="startupSkillsEnabled"><input id="startupSkillsEnabled" type="checkbox" ' + (startupSkills.enabled !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Startup skills</strong><em>List global skill folders visible to agents.</em></span></label><textarea id="startupSkillFolderNames" placeholder="one folder path per line">' + escapeHtml(startupSkillFolderNames) + '</textarea></div>' +
    '</div>',
  }) +
  renderSettingsSection({
    kicker: "Appearance",
    title: "Theme and diff behavior",
    copy: "Theme changes preview instantly; Save keeps them in the project config.",
    open: true,
    body: '<div class="settings-grid compact">' +
      '<div class="settings-field"><label for="fileTheme">App theme</label><select id="fileTheme">' + renderFileThemeOptions(appearance.fileTheme) + '</select></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="autoOpenGitDiff"><input id="autoOpenGitDiff" type="checkbox" ' + (appearance.autoOpenGitDiff !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Auto-open Git diff</strong><em>Leave off to open the diff manually.</em></span></label></div>' +
    '</div>' + renderSettingsThemePreview(appearance.fileTheme),
  }) +
  renderSettingsSection({
    kicker: "Templates",
    title: "Markdown document templates",
    copy: "Reusable shapes for new documentation files.",
    pills: [markdownTemplates.length + " templates"],
    open: false,
    body: '<div class="settings-body-toolbar"><span>Open a template only when you need to edit its fields.</span><button id="addMarkdownTemplate" class="secondary" type="button">+ template</button></div>' +
      '<div class="hub-card-options settings-editor-list" id="markdownTemplateEditors">' + markdownTemplates.map((template) => renderMarkdownTemplateEditor(template, false)).join("") + '</div>',
  }) +
  renderSettingsSection({
    kicker: "Hub",
    title: "Sections and cards",
    copy: "Controls the cards shown on the first screen.",
    pills: [sections.length + " sections"],
    open: false,
    body: '<div class="settings-body-toolbar"><span>Open a section or card only when changing its routing.</span><button id="addHubSection" class="secondary" type="button">+ section</button></div>' +
      '<div class="hub-card-options settings-editor-list" id="hubSectionEditors">' + sections.map((section) => renderHubSectionEditor(section, false)).join("") + '</div>',
  }) +
  '</div>' +
  '<div class="settings-footer"><span>Saved in <code>.context-room/config.json</code></span><div class="docqa-actions"><button id="saveSettings" class="primary" type="button">Save settings</button></div></div>';
  wireHubSettingsButtons(holder);
  wireMarkdownTemplateButtons(holder);
  el("addMarkdownTemplate")?.addEventListener("click", addMarkdownTemplateEditor);
  el("addHubSection")?.addEventListener("click", addHubSectionEditor);
  el("fileTheme")?.addEventListener("change", previewSelectedFileTheme);
  previewSelectedFileTheme();
  el("saveSettings")?.addEventListener("click", () => saveSettings().catch((error) => setStatus(error.message)));
}

function renderMarkdownTemplateEditor(template = {}, open = false) {
  const enabled = template.enabled !== false;
  return '<details class="template-editor" data-markdown-template-editor data-template-id="' + escapeHtml(template.id || "") + '" ' + (open ? 'open' : '') + '>' +
    '<summary class="template-editor-summary"><span>' + escapeHtml(template.title || "Untitled template") + '</span><code>' + escapeHtml(template.id || "new-template") + '</code></summary>' +
    '<div class="template-editor-head"><label class="template-enabled-toggle"><input type="checkbox" data-template-enabled ' + (enabled ? 'checked' : '') + ' /> Show in selector</label><button class="selection-action danger-action" type="button" data-remove-markdown-template title="remove this template">×</button></div>' +
    '<div class="template-editor-grid">' +
      '<div class="settings-field"><label>Id</label><input data-template-id-input value="' + escapeHtml(template.id || "") + '" placeholder="context-golden" /></div>' +
      '<div class="settings-field"><label>Name</label><input data-template-title value="' + escapeHtml(template.title || "") + '" placeholder="Golden context file" /></div>' +
      '<div class="settings-field"><label>Description</label><input data-template-description value="' + escapeHtml(template.description || "") + '" placeholder="When to use this template" /></div>' +
      '<div class="settings-field template-body"><label>Content</label><textarea data-template-content placeholder="# {{title}}&#10;&#10;## Purpose&#10;...">' + escapeHtml(template.content || "") + '</textarea></div>' +
    '</div>' +
  '</details>';
}

function wireMarkdownTemplateButtons(root) {
  root.querySelectorAll("[data-remove-markdown-template]").forEach((button) => button.addEventListener("click", () => button.closest(".template-editor")?.remove()));
}

function addMarkdownTemplateEditor() {
  const holder = el("markdownTemplateEditors");
  if (!holder) return;
  holder.insertAdjacentHTML("beforeend", renderMarkdownTemplateEditor({ id: "custom-" + Date.now().toString(36), title: "New template", description: "", content: "# {{title}}\n\n## Purpose\n\n## Key facts\n\n## References\n" }, true));
  wireMarkdownTemplateButtons(holder.lastElementChild);
}

function renderHubSectionEditor(section, open = false) {
  const id = section.id || "section-" + Date.now().toString(36);
  const cards = section.cards || [];
  return '<details class="hub-section-editor" data-hub-section-editor data-section-id="' + escapeHtml(id) + '" ' + (open ? 'open' : '') + '>' +
    '<summary class="hub-section-editor-summary"><span>' + escapeHtml(section.title || "Section") + '</span><code>' + cards.length + ' cards</code></summary>' +
    '<div class="hub-section-editor-head"><div class="settings-field"><label>Section name</label><input data-section-title value="' + escapeHtml(section.title || "Section") + '" placeholder="Section name" /></div><button class="secondary" type="button" data-add-root-card>+ card</button><button class="selection-action danger-action" type="button" data-remove-section title="remove this section">×</button></div>' +
    '<div class="hub-card-options" data-section-cards>' + cards.map((card) => renderHubCardEditor(card, 0, false)).join("") + '</div>' +
  '</details>';
}

function renderHubCardEditor(card, depth = 0, open = false) {
  const paths = (card.paths || [card.path]).filter(Boolean).join("\n");
  const children = card.cards || [];
  const summaryMeta = [paths ? paths.split(/\r?\n/).length + " paths" : "no paths", children.length ? children.length + " subcards" : ""].filter(Boolean).join(" · ");
  return '<details class="hub-card-editor ' + (depth ? 'nested' : '') + '" data-hub-card-editor data-card-id="' + escapeHtml(card.id || "") + '" ' + (open ? 'open' : '') + '>' +
    '<summary class="hub-card-editor-summary"><span>' + escapeHtml(card.title || "New card") + '</span><code>' + escapeHtml(summaryMeta) + '</code></summary>' +
    '<div class="hub-card-editor-head"><label class="hub-card-editor-title"><input type="checkbox" data-card-enabled ' + (card.enabled !== false ? 'checked' : '') + ' /> active</label><label class="hub-card-editor-title"><input type="checkbox" data-card-auto-children ' + (card.autoChildren ? 'checked' : '') + ' /> auto subcards</label><div class="docqa-actions"><button class="selection-action" type="button" data-add-child-card title="add a child card">+</button><button class="selection-action danger-action" type="button" data-remove-hub-card title="remove this card">×</button></div></div>' +
    '<div class="hub-card-editor-grid">' +
      '<div class="settings-field"><label>Name</label><input data-card-title value="' + escapeHtml(card.title || "") + '" placeholder="Card name" /></div>' +
      '<div class="settings-field"><label>Description</label><input data-card-description value="' + escapeHtml(card.description || "") + '" placeholder="Short description" /></div>' +
      '<div class="settings-field paths"><label>Included folders / files</label><textarea data-card-paths placeholder="empty if this card only navigates\none path per line">' + escapeHtml(paths) + '</textarea></div>' +
    '</div>' +
    '<div class="hub-card-children" data-card-children>' + children.map((child) => renderHubCardEditor(child, depth + 1, false)).join("") + '</div>' +
  '</details>';
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
  holder.insertAdjacentHTML("beforeend", renderHubSectionEditor({ id, title: "New section", cards: [] }, true));
  wireHubSettingsButtons(holder.lastElementChild);
}

function addHubCardEditor(holder) {
  if (!holder) return;
  const id = "custom-" + Date.now().toString(36);
  holder.insertAdjacentHTML("beforeend", renderHubCardEditor({ id, title: "New card", description: "", paths: [], cards: [], enabled: true }, holder.closest(".hub-card-editor") ? 1 : 0, true));
  wireHubSettingsButtons(holder.lastElementChild);
}

async function saveSettings() {
  const watchAllow = linesFromTextarea("watchAllow");
  const reviewPaths = linesFromTextarea("reviewPaths");
  const bestPractices = linesFromTextarea("bestPractices");
  const startupContext = {
    enabled: Boolean(el("startupContextEnabled")?.checked),
    fileNames: linesFromTextarea("startupContextFileNames"),
  };
  const startupSkills = {
    enabled: Boolean(el("startupSkillsEnabled")?.checked),
    folderNames: linesFromTextarea("startupSkillFolderNames"),
  };
  const appearance = {
    fileTheme: el("fileTheme")?.value || DEFAULT_FILE_THEME,
    autoOpenGitDiff: el("autoOpenGitDiff")?.checked !== false,
  };
  const markdownTemplates = collectMarkdownTemplateEditors();
  const hubSections = collectHubSectionEditors();
  const allCards = flattenUiCards(hubSections.flatMap((section) => section.cards));
  const hubCards = Object.fromEntries(allCards.map((card) => [card.id, card.enabled !== false]));
  const saveButton = el("saveSettings");
  markButtonSaving(saveButton);
  setStatus("saving settings...");
  try {
    const result = await api("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { watchAllow, reviewPaths, bestPractices, startupContext, startupSkills, appearance, markdownTemplates, hubCards, hubSections } }),
    });
    state.settings = result.settings;
    applyFileTheme();
    state.availableHubCards = result.availableHubCards || state.availableHubCards;
    state.hubFolders = result.hubCards || [];
    state.rootHubSections = result.hubSections || [];
    state.hubSections = state.rootHubSections;
    state.startupContextFiles = (await api("/api/startup-context")).files || [];
    state.startupSkillFolders = (await api("/api/startup-skills")).folders || [];
    const [docqa, doctor] = await Promise.all([api("/api/docqa"), api("/api/doctor")]);
    state.docqa = docqa;
    state.doctor = doctor;
    state.selectedReview = state.docqa.queue[0]?.path || null;
    if (state.page === "settings") renderSettingsPanel();
    else renderDocQaDashboard();
    setStatus("settings saved");
    flashSavedButton(el("saveSettings"), "Saved");
    scheduleSessionStatePush();
  } catch (error) {
    restoreButtonLabel(saveButton);
    throw error;
  }
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
  applyFileTheme();
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
  applyFileTheme();
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
  applyFileTheme();
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
  state.openingFilePath = null;
  state.reviewModePath = null;
  state.reviewModeStatus = null;
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
  scheduleSessionStatePush();
}

function handleHubAction() {
  if (state.page === "hub") showSettingsPage();
  else goHub();
}

function updateActionBanner() {
  const onFile = state.page === "file" && Boolean(state.selected);
  const hasGitDiff = onFile && !state.selectedStartupContext && state.selectedDiff?.available !== false && Boolean(state.selectedDiff?.changed);
  el("hub").textContent = state.page === "hub" ? "settings" : "hub";
  el("hub").title = state.page === "hub" ? "Open settings" : "Back to hub";
  ["back", "forward"].forEach((id) => { el(id).hidden = !onFile; });
  const gitDiffButton = el("gitDiffToggle");
  if (gitDiffButton) {
    gitDiffButton.hidden = !hasGitDiff;
    gitDiffButton.textContent = state.diffCollapsed ? "Show Git diff" : "Hide Git diff";
    gitDiffButton.title = state.diffCollapsed ? "Show Git diff" : "Hide Git diff";
    gitDiffButton.classList.toggle("active", hasGitDiff && !state.diffCollapsed);
  }
  ["reload", "verifyCurrent", "deleteCurrent", "save"].forEach((id) => { el(id).hidden = true; });
}

function renderHubFolders() {
  const holder = el("hubFolders");
  if (!holder) return;
  const sections = state.rootHubSections?.length ? state.rootHubSections : state.hubSections?.length ? state.hubSections : [{ id: "main", title: "Main", cards: state.hubFolders || [] }];
  const activeIds = activeHubCardIds(sections);
  holder.innerHTML = sections.map((section) => '<section class="hub-section"><div class="hub-section-title">' + escapeHtml(section.title || "Section") + '</div><div class="hub-section-grid">' + (section.cards || []).map((card) => renderHubFolderCard(card, activeIds)).join("") + '</div></section>').join("") + renderStartupContextPanel() + renderStartupSkillsPanel();
  document.querySelectorAll("[data-hub-file]").forEach((button) => button.addEventListener("click", () => selectFile(button.dataset.hubFile).catch((error) => setStatus(error.message))));
  document.querySelectorAll("[data-hub-folders]").forEach((button) => button.addEventListener("click", () => filterFolders(button.dataset.hubFolders.split('|'))));
  document.querySelectorAll("[data-hub-card-children]").forEach((button) => button.addEventListener("click", () => openHubChildren(button.dataset.hubCardChildren)));
  document.querySelectorAll("[data-hub-crumb]").forEach((button) => button.addEventListener("click", () => openHubPath(button.dataset.hubCrumb || null)));
  document.querySelectorAll("[data-startup-order]").forEach((button) => button.addEventListener("click", () => selectStartupContextFile(button.dataset.startupOrder).catch((error) => setStatus(error.message))));
  document.querySelectorAll("[data-startup-order]").forEach((button) => button.addEventListener("contextmenu", (event) => openStartupContextContextMenu(event, button.dataset.startupOrder)));
  document.querySelectorAll("[data-startup-skill-name]").forEach((button) => button.addEventListener("click", () => selectStartupSkillFile(button.dataset.startupSkillFolder, button.dataset.startupSkillName).catch((error) => setStatus(error.message))));
  document.querySelectorAll("[data-startup-skill-delete]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    deleteStartupSkillFromPanel(button.dataset.startupSkillFolder, button.dataset.startupSkillDelete).catch((error) => setStatus(error.message));
  }));
  document.querySelectorAll("[data-startup-skill-create-folder]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    createStartupSkillFromPanel(button.dataset.startupSkillCreateFolder);
  }));
  document.querySelectorAll("[data-startup-skill-create-form]").forEach((form) => {
    form.addEventListener("click", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      submitStartupSkillCreateForm(form.dataset.startupSkillCreateForm).catch((error) => setStatus(error.message));
    });
  });
  document.querySelectorAll("[data-startup-skill-create-cancel]").forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    cancelStartupSkillCreate();
  }));
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

function renderStartupSkillsPanel() {
  if (state.settings?.startupSkills?.enabled === false) return "";
  const folders = (state.startupSkillFolders || []).sort((a, b) => (a.order || 0) - (b.order || 0));
  if (!folders.length) return "";
  const body = '<div class="startup-context-list">' + folders.map((folder) => {
    const names = (folder.skills || []).slice(0, 60);
    const isCreating = String(state.startupSkillCreateFolder || "") === String(folder.order || "");
    const canManage = !folder.readOnly;
    const skillButtons = names.map((name) => '<span class="startup-skill-pill">' +
      '<button class="startup-skill-button" type="button" data-startup-skill-folder="' + escapeHtml(folder.order) + '" data-startup-skill-name="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>' +
      (canManage ? '<button class="startup-skill-delete" type="button" data-startup-skill-folder="' + escapeHtml(folder.order) + '" data-startup-skill-delete="' + escapeHtml(name) + '" title="Delete ' + escapeHtml(name) + '" aria-label="Delete ' + escapeHtml(name) + '">×</button>' : '') +
    '</span>').join("");
    const createControl = !canManage
      ? '<em>System group</em>'
      : isCreating
      ? '<form class="startup-skill-create" data-startup-skill-create-form="' + escapeHtml(folder.order) + '">' +
          '<input data-startup-skill-create-input="' + escapeHtml(folder.order) + '" placeholder="skill-name" aria-label="New skill name" autocomplete="off" />' +
          '<button type="submit" title="Create skill" aria-label="Create skill">✓</button>' +
          '<button type="button" data-startup-skill-create-cancel="' + escapeHtml(folder.order) + '" title="Cancel" aria-label="Cancel">×</button>' +
        '</form>'
      : '<button class="startup-skill-add" type="button" data-startup-skill-create-folder="' + escapeHtml(folder.order) + '" title="Create skill in this folder" aria-label="Create skill in this folder">+</button>';
    const buttons = '<div class="startup-skill-buttons">' + skillButtons + createControl + '</div>' + (!names.length ? '<em>No SKILL.md folders found here</em>' : '');
    return '<div class="startup-context-item startup-skill-folder readonly">' +
      '<strong>' + escapeHtml((folder.order || "?") + ". " + (folder.skillCount || 0) + " skills") + '</strong>' +
      '<div class="startup-skill-names"><code>' + escapeHtml(folder.displayPath || folder.folderName || "skills") + '</code>' + buttons + '</div>' +
    '</div>';
  }).join("") + '</div>';
  return '<section class="startup-context-panel"><div class="hub-section-title">Startup skills</div><div class="startup-context-copy">Skill folders found from the filesystem root down to this Context Room root.</div>' + body + '</section>';
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
  if (!path) return;
  const normalizedStatus = status === "unverified" ? "unverified" : status === "verified" ? "verified" : "needs_changes";
  const note = normalizedStatus === "verified"
    ? "verified from Context Room review queue"
    : normalizedStatus === "unverified"
      ? "verification removed from Context Room review queue"
      : "needs changes from Context Room review queue";
  setStatus(normalizedStatus === "verified" ? "validating..." : normalizedStatus === "unverified" ? "marking unverified..." : "marking...");
  await api("/api/docqa/review", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, status: normalizedStatus, note }),
  });
  const docqa = await api("/api/docqa");
  state.docqa = docqa;
  if (state.reviewModePath === path) state.reviewModeStatus = normalizedStatus === "verified" ? "verified" : null;
  state.selectedReview = docqa.queue.find((item) => item.path === path)?.path || docqa.queue[0]?.path || null;
  if (state.selected === path) {
    renderViewer();
    updateHeader();
    updatePreview();
    setStatus(normalizedStatus === "verified" ? "file verified" : normalizedStatus === "unverified" ? "file marked unverified" : "needs changes");
  } else {
    renderDocQaDashboard();
    setStatus(normalizedStatus === "verified" ? "verified" : normalizedStatus === "unverified" ? "unverified" : "needs changes");
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
  if (state.reviewModePath !== state.selected) return;
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
  el("viewer").hidden = false;
  el("editor").hidden = true;
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
  if (blockPendingExternalChange(delta < 0 ? "before going back" : "before going forward")) return;
  state.historyIndex = nextIndex;
  await selectFile(state.history[state.historyIndex], { pushHistory: false });
}

function goHub() {
  if (blockPendingExternalChange("before returning to hub")) return;
  if (state.dirty && !confirm("You have unsaved changes. Return to hub?")) return;
  collapseSidebarOnNarrow();
  state.selected = null;
  state.openingFilePath = null;
  state.selectedStartupContext = null;
  state.reviewModePath = null;
  state.reviewModeStatus = null;
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
  const isStartupFile = Boolean(state.selectedStartupContext);
  const file = isStartupFile
    ? { label: state.selectedStartupContext.fileName, path: state.selectedStartupContext.displayPath }
    : state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  el("title").textContent = file.label || file.path;
  el("path").textContent = isStartupFile ? file.path : "";
  el("impact").textContent = "";
  const conflict = activeFileConflict();
  const externalChange = activeExternalChange();
  const blockedByDiskChange = Boolean(conflict || externalChange);
  el("save").disabled = blockedByDiskChange || !state.dirty || !state.selected;
  const headerSave = document.querySelector("[data-file-save]");
  if (headerSave) headerSave.disabled = blockedByDiskChange || !state.dirty || !state.selected;
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
  const viewState = captureEditorViewState();
  state.mode = mode === "edit" ? "edit" : "view";
  const hasSelectedFile = Boolean(state.selected || state.selectedStartupContext);
  el("viewer").style.display = hasSelectedFile ? "block" : "";
  el("editor").style.display = "none";
  if (hasSelectedFile) {
    renderViewer();
    restoreEditorViewState(viewState);
  }
}

function pathTitleFromUiPath(relPath) {
  const name = normalizeUiPath(relPath).split("/").pop() || "New document";
  return name.replace(/\.md$/i, "").split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") || "New document";
}

function templateStateForContent(text) {
  if (!state.selected?.endsWith(".md")) return null;
  const templates = visibleMarkdownTemplates(state.settings?.markdownTemplates || []);
  if (!templates.length) return null;
  const current = String(text || "");
  if (!current.trim()) {
    const blank = templates.find((template) => template.id === "blank");
    return { selectedId: blank?.id || "" };
  }
  const match = templates.find((template) => renderTemplateForSelectedPath(template.id) === current);
  return match ? { selectedId: match.id } : null;
}

function renderTemplateForSelectedPath(templateId) {
  const template = (state.settings?.markdownTemplates || []).find((item) => item.id === templateId);
  if (!template) return "";
  const normalized = normalizeUiPath(state.selected || "");
  const title = pathTitleFromUiPath(normalized);
  return renderUiTemplate(template.content || "", templateValuesForPath(title, normalized));
}

function renderUiTemplate(content, values = {}) {
  return String(content || "").replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g, (_match, key) => values[key] ?? "");
}

function templateValuesForPath(title, normalized) {
  const metadata = metadataDefaultsForUiPath(normalized);
  return {
    title,
    path: normalized,
    kind: metadata.kind,
    status: metadata.status,
    scope: metadata.scope,
    canonical_for: metadata.canonical_for,
    last_verified: metadata.last_verified,
    sources_inline: "[]",
    sources_list: "- Add source files, commands, or links.",
    kind_yaml: yamlScalarUi(metadata.kind),
    status_yaml: yamlScalarUi(metadata.status),
    scope_yaml: yamlScalarUi(metadata.scope),
    canonical_for_yaml: yamlScalarUi(metadata.canonical_for),
    last_verified_yaml: yamlScalarUi(metadata.last_verified),
  };
}

function metadataDefaultsForUiPath(relPath) {
  const kind = inferDocKindFromUiPath(relPath);
  return {
    kind,
    scope: "project",
    status: "current",
    canonical_for: kind === "canonical" ? (normalizeUiPath(relPath).split("/").pop() || "").replace(/\.md$/i, "") : "",
    last_verified: new Date().toISOString().slice(0, 10),
  };
}

function inferDocKindFromUiPath(relPath) {
  const normalized = normalizeUiPath(relPath);
  const originalBase = normalized.split("/").pop() || "";
  const base = originalBase.toLowerCase();
  const lowered = normalized.toLowerCase();
  if (originalBase === "AGENTS.md" || originalBase === "CLAUDE.md" || base === ".hermes.md") return "agents";
  if (["index.md", "readme.md"].includes(base)) return "index";
  if (lowered.includes("decision") || lowered.includes("adr")) return "decision";
  if (lowered.includes("runbook") || lowered.includes("procedure") || lowered.includes("deployment") || lowered.includes("testing") || lowered.includes("monitoring")) return "procedure";
  return "canonical";
}

function yamlScalarUi(value) {
  const text = String(value || "");
  if (!text) return '""';
  if (/^[A-Za-z0-9_./@-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function applySelectedTemplateToEditor(templateId) {
  if (!state.selected) return;
  if (!templateId) return;
  const rendered = renderTemplateForSelectedPath(templateId);
  const viewState = captureEditorViewState();
  el("editor").value = rendered;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = rendered;
  state.dirty = rendered !== state.saved;
  updateMarkdownEditorHighlight(rendered, { immediate: true });
  renderViewer();
  restoreEditorViewState(viewState);
  updateHeader();
  updatePreview();
  setStatus("template selected");
}

function renderViewer() {
  const text = el("editor").value;
  const diff = state.selectedDiff || { changed: false, additions: 0, deletions: 0, patch: "", available: false };
  const isStartupFile = Boolean(state.selectedStartupContext);
  const conflict = activeFileConflict();
  const externalChange = activeExternalChange();
  const file = isStartupFile
    ? { label: state.selectedStartupContext.fileName, path: state.selectedStartupContext.displayPath }
    : state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  const hasDiff = !isStartupFile && diff.available !== false && diff.changed;
  const diffMarkup = hasDiff ? renderDiffPanel(diff) : "";
  const templateState = !isStartupFile && !conflict && !externalChange ? templateStateForContent(text) : null;
  const actionsMarkup = externalChange && !conflict
      ? renderExternalReviewActions(externalChange, { fileActionOptions: externalReviewFileActionOptions() })
      : renderFileActionButtons({ reviewAction: isStartupFile ? null : reviewActionForSelectedFile(), dirty: state.dirty, templateState, blockedByConflict: Boolean(conflict || externalChange), deletable: !isStartupFile });
  const conflictMarkup = conflict ? renderConflictPanel(conflict, text) : "";
  const editorMarkup = !conflict && externalChange
    ? renderExternalReviewDocument(externalReviewBaseContent(externalChange), externalChange.diskContent || "")
    : state.mode === "edit"
      ? renderMarkdownEditor(text)
      : renderMarkdownLineView(text);
  const annotationMarkup = !isStartupFile && !conflict ? renderAgentAnnotations(state.selected) : "";
  el("viewer").innerHTML = '<div class="review-workspace ' + (!hasDiff || state.diffCollapsed ? 'no-diff' : '') + '">' +
    (state.diffCollapsed ? "" : diffMarkup) +
    '<section class="file-panel"><header><div class="file-header-copy"><strong>' + escapeHtml(file.label || "Document") + '</strong>' + (isStartupFile ? '<span class="muted">' + escapeHtml(file.path) + '</span>' : '') + '</div>' + actionsMarkup + '</header>' + conflictMarkup + annotationMarkup + editorMarkup + '</section></div>';
  updateActionBanner();
  document.querySelector("[data-hide-diff]")?.addEventListener("click", (event) => {
    event.preventDefault();
    setDiffCollapsed(true);
  });
  document.querySelector("[data-revert-diff]")?.addEventListener("click", () => promptRevertCurrentDiff());
  document.querySelector("[data-apply-external-change]")?.addEventListener("click", () => applyExternalChange().catch((error) => setStatus(error.message)));
  document.querySelector("[data-reject-external-change]")?.addEventListener("click", () => promptRejectExternalChange());
  wireExternalReviewDecisionButtons();
  wireExternalReviewAllButtons();
  wireAgentAnnotationButtons();
  wireMarkdownDocLinks();
  document.querySelector("[data-conflict-compare]")?.addEventListener("click", () => toggleConflictCompare());
  document.querySelector("[data-conflict-reload]")?.addEventListener("click", () => promptReloadConflictFromDisk());
  document.querySelector("[data-conflict-keep]")?.addEventListener("click", () => promptKeepConflictEdits());
  document.querySelector("[data-conflict-merge-editor]")?.addEventListener("input", (event) => {
    state.conflictMergeText = event.target.value;
    state.conflictMergeMode = "manual";
  });
  document.querySelectorAll("[data-conflict-merge-source]").forEach((button) => button.addEventListener("click", (event) => promptSaveConflictSource(event.currentTarget.dataset.conflictMergeSource)));
  wireFileActionButtons();
  wireRenderedMarkdownEditor();
  syncWorkspaceScroll();
  scheduleSessionStatePush();
}

function wireRenderedMarkdownEditor() {
  const docEditor = el("docEditor");
  if (!docEditor) return;
  state.markdownHighlightLastText = docEditor.value;
  syncMarkdownEditorScroll();
  docEditor.addEventListener("input", () => {
    el("editor").value = docEditor.value;
    state.dirty = docEditor.value !== state.saved;
    updateMarkdownEditorHighlight(docEditor.value);
    updateHeader();
    updatePreview();
    updateConflictCompareLive(docEditor.value);
    scheduleConflictCheck();
    scheduleSessionStatePush();
  });
  docEditor.addEventListener("scroll", syncMarkdownEditorScroll, { passive: true });
  wireMarkdownEditorDocLinks(docEditor);
}

function renderMarkdownLineView(text, options = {}) {
  return '<div id="docReader" class="doc-editor markdown-view" role="document" tabindex="0" aria-label="' + (options.readOnly ? "Read-only document" : "Document preview") + '">' +
    renderMarkdownLines(text) +
  '</div>';
}

function renderMarkdownEditor(text) {
  return '<div class="markdown-editor-shell">' +
    '<div id="docHighlighter" class="doc-editor markdown-view markdown-editor-highlight" aria-hidden="true">' + renderMarkdownLines(text) + '</div>' +
    '<textarea id="docEditor" class="doc-editor markdown-editor-input" spellcheck="false">' + escapeHtml(text) + '</textarea>' +
  '</div>';
}

function renderMarkdownLines(text, options = {}) {
  let inFence = false;
  const lines = String(text || "").split("\n");
  const decorations = Array.isArray(options.lineDecorations) ? options.lineDecorations : [];
  return lines.map((line, index) => {
      const startsFence = /^\s*(\`\`\`|~~~)/.test(line);
      const rendered = renderMarkdownLine(line, index, { inFence: inFence || startsFence });
      if (startsFence) inFence = !inFence;
      return decorateMarkdownLine(rendered, decorations[index]);
    }).join("");
}

function decorateMarkdownLine(rendered, decoration) {
  if (!decoration) return rendered;
  const extraClass = decoration.className ? " " + decoration.className : "";
  const markerAttr = decoration.marker ? ' data-review-marker="' + escapeHtml(decoration.marker) + '"' : "";
  const finalLineAttr = Number.isInteger(decoration.finalLineIndex) ? ' data-final-line-index="' + decoration.finalLineIndex + '"' : "";
  return String(rendered).replace(/^<div class="markdown-line([^"]*)"/, '<div class="markdown-line' + extraClass + '$1"' + markerAttr + finalLineAttr);
}

function updateMarkdownEditorHighlight(text, options = {}) {
  const highlighter = el("docHighlighter");
  if (!highlighter) return;
  state.markdownHighlightText = String(text || "");
  if (options.immediate) {
    renderMarkdownEditorHighlightNow(state.markdownHighlightText);
    return;
  }
  if (state.markdownHighlightFrame) return;
  state.markdownHighlightFrame = window.requestAnimationFrame(() => {
    state.markdownHighlightFrame = 0;
    if (state.markdownHighlightText === state.markdownHighlightLastText) {
      syncMarkdownEditorScroll();
      return;
    }
    renderMarkdownEditorHighlightNow(state.markdownHighlightText);
  });
}

function renderMarkdownEditorHighlightNow(text) {
  const highlighter = el("docHighlighter");
  if (!highlighter) return;
  const next = String(text || "");
  highlighter.innerHTML = renderMarkdownLines(next);
  state.markdownHighlightLastText = next;
  syncMarkdownEditorScroll();
}

function syncMarkdownEditorScroll() {
  const editor = el("docEditor");
  const highlighter = el("docHighlighter");
  if (!editor || !highlighter) return;
  highlighter.scrollTop = editor.scrollTop;
  highlighter.scrollLeft = editor.scrollLeft;
}

function renderMarkdownLine(line, index, options = {}) {
  const raw = String(line || "");
  const trimmed = raw.trim();
  const attrs = ' data-line-index="' + index + '"';
  if (!raw) return '<div class="markdown-line blank"' + attrs + '>&nbsp;</div>';
  const heading = raw.match(/^(\s{0,3})(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (heading && !options.inFence) {
    const level = Math.min(4, heading[2].length);
    const text = heading[3].trim();
    return '<div class="markdown-line h' + level + '"' + attrs + ' data-heading-marker="' + escapeHtml(heading[2]) + '" data-heading-text="' + escapeHtml(text) + '">' + renderMarkdownInline(raw) + '</div>';
  }
  if (options.inFence) return '<div class="markdown-line ' + (/^\s*(\`\`\`|~~~)/.test(raw) ? "fence" : "code") + '"' + attrs + '>' + escapeHtml(raw || " ") + '</div>';
  if (/^\s*[-*_]{3,}\s*$/.test(raw)) return '<div class="markdown-line hr"' + attrs + '>' + escapeHtml(raw) + '</div>';
  if (trimmed === "---" || trimmed === "...") return '<div class="markdown-line frontmatter"' + attrs + '>' + escapeHtml(raw) + '</div>';
  const quote = raw.match(/^(\s*>+\s?)(.*)$/);
  if (quote) return '<div class="markdown-line quote"' + attrs + '><span class="markdown-marker">' + escapeHtml(quote[1]) + '</span>' + renderMarkdownInline(quote[2]) + '</div>';
  const list = raw.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/);
  if (list) return '<div class="markdown-line list"' + attrs + '><span class="markdown-marker">' + escapeHtml(list[1]) + '</span>' + renderMarkdownInline(list[2]) + '</div>';
  return '<div class="markdown-line body"' + attrs + '>' + renderMarkdownInline(raw) + '</div>';
}

function renderMarkdownInline(value) {
  return String(value || "").split(/(\`[^\`\n]+\`)/g).map((part) => {
    if (/^\`[^\`\n]+\`$/.test(part)) {
      const token = part.slice(1, -1);
      const docLinkAttrs = markdownDocLinkAttributes(token);
      return '<span class="markdown-inline-code' + (isMarkdownPathToken(token) ? ' markdown-path' : '') + '"' + docLinkAttrs + '>' + escapeHtml(part) + '</span>';
    }
    return renderMarkdownPlainInline(part);
  }).join("");
}

function isMarkdownPathToken(value) {
  return isMarkdownDocLinkTarget(value) || /^(?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)[A-Za-z0-9_./@~-]+$/.test(String(value || ""));
}

function renderMarkdownPlainInline(value) {
  return String(value || "").split(/(\[[^\]\n]+\]\([^) \n]+\))/g).map((part) => {
    const link = part.match(/^\[([^\]\n]+)\]\(([^) \n]+)\)$/);
    if (link) {
      const label = renderMarkdownPlainInline(link[1]);
      const docLinkAttrs = markdownDocLinkAttributes(link[2]);
      if (docLinkAttrs) return '<a href="#" class="markdown-doc-link markdown-path"' + docLinkAttrs + '>' + label + '</a>';
      return escapeHtml(part);
    }
    return escapeHtml(part).replace(/(^|[\s([{])((?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)?[A-Za-z0-9_./@~-]*[A-Za-z0-9_@~-]+\.[A-Za-z0-9_-]+(?:#[A-Za-z0-9_.-]+)?|(?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)[A-Za-z0-9_./@~-]+)/g, (match, prefix, rawPath) => {
      const docLinkAttrs = markdownDocLinkAttributes(rawPath);
      return prefix + '<span class="markdown-path"' + docLinkAttrs + '>' + rawPath + '</span>';
    });
  }).join("");
}

function markdownDocLinkAttributes(rawTarget) {
  const resolved = resolveDocLinkPath(rawTarget);
  if (!resolved) return "";
  return ' data-doc-link-path="' + escapeHtml(rawTarget) + '" data-doc-link-resolved="' + escapeHtml(resolved) + '" title="Ctrl/Cmd-click to open ' + escapeHtml(resolved) + '"';
}

function isMarkdownDocLinkTarget(value) {
  const target = cleanMarkdownDocLinkTarget(value);
  if (!target) return false;
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return false;
  return /^(?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)?[A-Za-z0-9_./@~-]*[A-Za-z0-9_@~-]+\.[A-Za-z0-9_-]+(?:#[A-Za-z0-9_.-]+)?$/.test(target) ||
    /^(?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)[A-Za-z0-9_./@~-]+$/.test(target);
}

function cleanMarkdownDocLinkTarget(value) {
  let target = String(value || "").trim();
  if (!target) return "";
  target = target.replace(/^<(.+)>$/, "$1").replace(/^[\`'"]|[\`'"]$/g, "");
  if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) return "";
  return target.split(/[?#]/)[0].replaceAll("\\", "/").trim();
}

function resolveDocLinkPath(rawTarget) {
  const target = cleanMarkdownDocLinkTarget(rawTarget);
  if (!target || !isMarkdownDocLinkTarget(target) || target.startsWith("/")) return "";
  const candidates = [];
  if (/^(?:\.{1,2}\/)/.test(target)) {
    candidates.push(normalizeDocPath(currentDocumentDirectory() ? currentDocumentDirectory() + "/" + target : target));
  } else {
    candidates.push(normalizeDocPath(target));
    const relative = currentDocumentDirectory() ? normalizeDocPath(currentDocumentDirectory() + "/" + target) : "";
    if (relative && relative !== candidates[0]) candidates.push(relative);
  }
  return candidates.find((candidate) => candidate && isKnownContextRoomFile(candidate)) || "";
}

function normalizeDocPath(value) {
  const parts = String(value || "").replaceAll("\\", "/").split("/");
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!stack.length) return "";
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

function currentDocumentDirectory() {
  const selected = String(state.selected || "");
  if (!selected || selected.startsWith("startup-context-")) return "";
  const index = selected.lastIndexOf("/");
  return index > 0 ? selected.slice(0, index) : "";
}

function isKnownContextRoomFile(filePath) {
  return state.files.some((file) => file.path === filePath);
}

function wireMarkdownDocLinks(root = document) {
  root.querySelectorAll("[data-doc-link-path]").forEach((element) => element.addEventListener("click", (event) => {
    if (element.tagName === "A") event.preventDefault();
    if (!isDocLinkModifierEventActive(event)) return;
    event.preventDefault();
    event.stopPropagation();
    openMarkdownDocLink(element.dataset.docLinkResolved || element.dataset.docLinkPath).catch((error) => setStatus(error.message));
  }));
}

function wireMarkdownEditorDocLinks(editor) {
  editor.addEventListener("pointermove", (event) => updateMarkdownEditorDocLinkHover(editor, event), { passive: true });
  editor.addEventListener("pointerleave", () => clearMarkdownEditorDocLinkHover(editor), { passive: true });
  editor.addEventListener("click", (event) => {
    if (!isDocLinkModifierEventActive(event)) return;
    const target = markdownDocLinkAtPoint(event.clientX, event.clientY) || markdownDocLinkAtOffset(editor.value, editor.selectionStart || 0);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    openMarkdownDocLink(target).catch((error) => setStatus(error.message));
  });
}

function markdownDocLinkAtPoint(clientX, clientY) {
  const renderedTarget = markdownDocLinkElementAtPoint(clientX, clientY);
  if (renderedTarget?.dataset?.docLinkPath) return renderedTarget.dataset.docLinkResolved || renderedTarget.dataset.docLinkPath;
  if (!document.elementsFromPoint) return "";
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    const target = element?.closest?.("[data-doc-link-path]");
    if (target?.dataset?.docLinkPath) return target.dataset.docLinkResolved || target.dataset.docLinkPath;
  }
  return "";
}

function markdownDocLinkElementAtPoint(clientX, clientY) {
  const highlighter = el("docHighlighter");
  const editor = el("docEditor");
  if (!highlighter || !document.elementFromPoint) return null;
  const previousHighlighterPointerEvents = highlighter.style.pointerEvents;
  const previousEditorPointerEvents = editor?.style.pointerEvents || "";
  highlighter.style.pointerEvents = "auto";
  if (editor) editor.style.pointerEvents = "none";
  let target = null;
  try {
    target = document.elementFromPoint(clientX, clientY)?.closest?.("[data-doc-link-path]") || null;
  } finally {
    highlighter.style.pointerEvents = previousHighlighterPointerEvents;
    if (editor) editor.style.pointerEvents = previousEditorPointerEvents;
  }
  return target && highlighter.contains(target) ? target : null;
}

function updateMarkdownEditorDocLinkHover(editor, event) {
  setDocLinkModifierActive(isDocLinkModifierEventActive(event));
  if (!state.docLinkModifierActive) {
    clearMarkdownEditorDocLinkHover(editor);
    return;
  }
  const target = markdownDocLinkElementAtPoint(event.clientX, event.clientY);
  document.querySelectorAll(".doc-link-hover-target").forEach((element) => {
    if (element !== target) element.classList.remove("doc-link-hover-target");
  });
  editor.classList.toggle("doc-link-hover", Boolean(target));
  if (target) target.classList.add("doc-link-hover-target");
}

function clearMarkdownEditorDocLinkHover(editor = el("docEditor")) {
  document.querySelectorAll(".doc-link-hover-target").forEach((element) => element.classList.remove("doc-link-hover-target"));
  editor?.classList?.remove("doc-link-hover");
}

async function openMarkdownDocLink(rawTarget) {
  const resolved = resolveDocLinkPath(rawTarget) || normalizeDocPath(cleanMarkdownDocLinkTarget(rawTarget));
  if (!resolved || !isKnownContextRoomFile(resolved)) {
    setStatus("file not available in Context Room: " + cleanMarkdownDocLinkTarget(rawTarget));
    return;
  }
  if (state.selected === resolved) {
    setStatus("already open");
    return;
  }
  await selectFile(resolved, { revealInExplorer: true });
}

function markdownDocLinkAtOffset(text, offset) {
  const value = String(text || "");
  const safeOffset = Math.max(0, Math.min(Number(offset) || 0, value.length));
  const lineStart = value.lastIndexOf("\n", Math.max(0, safeOffset - 1)) + 1;
  const nextBreak = value.indexOf("\n", safeOffset);
  const lineEnd = nextBreak === -1 ? value.length : nextBreak;
  const line = value.slice(lineStart, lineEnd);
  const lineOffset = safeOffset - lineStart;
  const markdownLinkPattern = /\[[^\]\n]+\]\(([^) \n]+)\)/g;
  for (const match of line.matchAll(markdownLinkPattern)) {
    if (lineOffset >= match.index && lineOffset <= match.index + match[0].length) return match[1];
  }
  const pathPattern = /\`((?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)?[A-Za-z0-9_./@~-]*[A-Za-z0-9_@~-]+\.[A-Za-z0-9_-]+(?:#[A-Za-z0-9_.-]+)?|(?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)[A-Za-z0-9_./@~-]+)\`|((?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)?[A-Za-z0-9_./@~-]*[A-Za-z0-9_@~-]+\.[A-Za-z0-9_-]+(?:#[A-Za-z0-9_.-]+)?|(?:~\/|\.{1,2}\/|\.?[A-Za-z0-9_-]+\/)[A-Za-z0-9_./@~-]+)/g;
  for (const match of line.matchAll(pathPattern)) {
    if (lineOffset >= match.index && lineOffset <= match.index + match[0].length) return match[1] || match[2] || "";
  }
  return "";
}

function wireFileActionButtons(root = document) {
  root.querySelector("[data-file-review-decision]")?.addEventListener("click", (event) => applyReviewDecision(state.selected, event.currentTarget.dataset.fileReviewDecision).catch((error) => setStatus(error.message)));
  root.querySelector("[data-file-save]")?.addEventListener("click", () => saveCurrent().catch((error) => setStatus(error.message)));
  root.querySelector("[data-file-delete]")?.addEventListener("click", () => deletePaths([state.selected]).catch((error) => setStatus(error.message)));
  root.querySelector("[data-empty-template-select]")?.addEventListener("change", (event) => applySelectedTemplateToEditor(event.currentTarget.value));
}

function setDiffCollapsed(collapsed) {
  const viewState = captureEditorViewState();
  state.diffCollapsed = Boolean(collapsed);
  renderViewer();
  restoreEditorViewState(viewState);
  updateActionBanner();
}

function wireExternalReviewDecisionButtons(root = document) {
  root.querySelectorAll("[data-external-block-decision]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chooseExternalReviewBlock(event.currentTarget.dataset.externalBlockDecision, event.currentTarget.dataset.externalBlockId).catch((error) => setStatus(error.message));
  }));
}

function wireExternalReviewAllButtons(root = document) {
  root.querySelectorAll("[data-external-review-all]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    chooseAllExternalReviewBlocks(event.currentTarget.dataset.externalReviewAll).catch((error) => setStatus(error.message));
  }));
}

function renderExternalReviewActions(change, { fileActionOptions = null } = {}) {
  const beforeText = externalReviewBaseContent(change);
  const afterText = change.diskContent || "";
  const blocks = buildExternalReviewBlocks(beforeText, afterText, change.reviewDecisions || {});
  const summary = summarizeExternalReviewBlocks(blocks);
  const sourceLabel = change.source === "review" ? "Git changes waiting for review" : "File changed on disk";
  const bulkActions = summary.pending > 1 || summary.pendingLines > 1
    ? '<button class="file-action primary external-choice bulk" type="button" data-external-review-all="accept">Accept all</button>' +
      '<button class="file-action danger-action external-choice bulk" type="button" data-external-review-all="reject">Reject all</button>'
    : "";
  return '<div class="file-actions external-review-actions" aria-label="Review file changes">' +
    '<div class="external-change-stats" title="' + escapeHtml(sourceLabel + ": " + (change.path || "This file")) + '"><span class="pending">' + summary.pending + ' left</span><span class="add">+' + summary.additions + '</span><span class="del">-' + summary.deletions + '</span></div>' +
    bulkActions +
    (fileActionOptions ? renderFileActionItems(fileActionOptions) : '') +
  '</div>';
}

function externalReviewFileActionOptions() {
  return {
    reviewAction: null,
    dirty: state.dirty,
    blockedByConflict: true,
    deletable: !Boolean(state.selectedStartupContext),
  };
}

function renderExternalReviewDocument(beforeText, afterText) {
  const change = activeExternalChange();
  const blocks = buildExternalReviewBlocks(beforeText, afterText, change?.reviewDecisions || {});
  const metricClass = " editor-metrics";
  if (!blocks.some((block) => block.kind === "change")) return '<div class="doc-editor external-review-doc' + metricClass + '"><div class="diff-empty">No textual difference.</div></div>';
  return '<div class="doc-editor external-review-doc' + metricClass + '" role="document" aria-label="Document with file changes highlighted">' +
    renderExternalReviewBlocks(blocks) +
  '</div>';
}

function renderExternalReviewBlocks(blocks) {
  let finalLineStart = 0;
  return blocks.map((block) => {
    const html = renderExternalReviewBlock(block, { finalLineStart });
    finalLineStart += externalReviewRenderedRows(block).length;
    return html;
  }).join("");
}

function renderExternalReviewBlock(block, options = {}) {
  if (block.kind !== "change") {
    return '<div class="external-review-block context markdown-view">' +
      renderMarkdownLines(block.rows.map((row) => row.line).join("\n"), { lineDecorations: finalLineDecorations(block.rows, options.finalLineStart) }) +
    '</div>';
  }
  if (block.decision) {
    const rows = externalReviewRowsForDecision(block);
    return '<div class="external-review-block context resolved ' + escapeHtml(block.decision) + (rows.length ? '' : ' empty') + '" data-external-review-block="' + escapeHtml(block.id) + '">' +
      renderExternalReviewFinalLines(rows, { finalLineStart: options.finalLineStart }) +
    '</div>';
  }
  const decisionClass = block.decision || "pending";
  return '<div class="external-review-block change ' + decisionClass + '" data-external-review-block="' + escapeHtml(block.id) + '">' +
    renderExternalReviewRows(block.rows, { finalLineStart: options.finalLineStart }) +
    '<div class="external-review-block-controls" aria-label="Review this change">' +
      '<button class="file-action primary external-choice icon" type="button" data-external-block-decision="accept" data-external-block-id="' + escapeHtml(block.id) + '" title="Accept this change">OK</button>' +
      '<button class="file-action danger-action external-choice icon" type="button" data-external-block-decision="reject" data-external-block-id="' + escapeHtml(block.id) + '" title="Reject this change">x</button>' +
    '</div>' +
  '</div>';
}

function renderExternalReviewRows(rows, options = {}) {
  const text = rows.map((row) => row.line).join("\n");
  const lineDecorations = rows.map((row) => {
    const finalLineIndex = finalLineIndexForRow(row, rows, options.finalLineStart);
    if (row.type !== "add" && row.type !== "del") return null;
    const marker = row.type === "add" ? "+" : row.type === "del" ? "-" : "";
    return { className: "external-review-line " + row.type, marker, finalLineIndex };
  });
  return '<div class="external-review-lines markdown-view">' + renderMarkdownLines(text, { lineDecorations }) + '</div>';
}

function renderExternalReviewFinalLines(rows, options = {}) {
  if (!rows.length) return "";
  return '<div class="external-review-final-lines markdown-view">' +
    renderMarkdownLines(rows.map((row) => row.line).join("\n"), { lineDecorations: finalLineDecorations(rows, options.finalLineStart) }) +
  '</div>';
}

function externalReviewRenderedRows(block) {
  if (block.kind !== "change") return block.rows;
  if (block.decision) return externalReviewRowsForDecision(block);
  return block.rows;
}

function externalReviewFinalLineStart(blocks, blockId) {
  let finalLineStart = 0;
  for (const block of blocks) {
    if (block.id === blockId) return finalLineStart;
    finalLineStart += externalReviewRenderedRows(block).length;
  }
  return finalLineStart;
}

function finalLineDecorations(rows, finalLineStart = null) {
  if (!Number.isInteger(finalLineStart)) return [];
  return rows.map((_row, index) => ({ finalLineIndex: finalLineStart + index }));
}

function finalLineIndexForRow(row, rows, finalLineStart = null) {
  if (!Number.isInteger(finalLineStart)) return null;
  const index = rows.indexOf(row);
  return index >= 0 ? finalLineStart + index : null;
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
    const pendingBlock = block.kind === "change" && !block.decision;
    if (pendingBlock) summary.pending += 1;
    for (const row of block.rows) {
      if (row.type === "add") summary.additions += 1;
      if (row.type === "del") summary.deletions += 1;
      if (pendingBlock && (row.type === "add" || row.type === "del")) summary.pendingLines += 1;
    }
    return summary;
  }, { pending: 0, pendingLines: 0, additions: 0, deletions: 0 });
}

async function chooseExternalReviewBlock(decision, blockId) {
  const change = activeExternalChange();
  if (!change || !blockId || (decision !== "accept" && decision !== "reject")) return;
  const viewState = captureEditorViewState({ anchorBlockId: blockId });
  change.reviewDecisions = { ...(change.reviewDecisions || {}), [blockId]: decision };
  const blocks = buildExternalReviewBlocks(externalReviewBaseContent(change), change.diskContent || "", change.reviewDecisions);
  const pending = blocks.filter((block) => block.kind === "change" && !block.decision);
  const updatedInPlace = updateExternalReviewBlockInPlace(blocks, blockId, viewState);
  if (!updatedInPlace) renderViewer();
  updateHeader();
  updatePreview();
  const settlePromise = updatedInPlace
    ? settleExternalReviewBlocks([blockId], viewState, { restoreScroll: false })
    : Promise.resolve();
  if (pending.length) {
    setStatus(pending.length + " change" + (pending.length > 1 ? "s" : "") + " left to review");
    return;
  }
  setStatus("saving reviewed change...");
  await waitForInlineReviewTransition(settlePromise);
  await saveExternalReviewDecision(blocks, viewState);
}

async function chooseAllExternalReviewBlocks(decision) {
  const change = activeExternalChange();
  if (!change || (decision !== "accept" && decision !== "reject")) return;
  const currentBlocks = buildExternalReviewBlocks(externalReviewBaseContent(change), change.diskContent || "", change.reviewDecisions || {});
  const pendingBlocks = currentBlocks.filter((block) => block.kind === "change" && !block.decision);
  if (!pendingBlocks.length) return;
  const anchorBlockId = closestExternalReviewChangeBlockId() || pendingBlocks[0].id;
  const viewState = captureEditorViewState({ anchorBlockId });
  const nextDecisions = { ...(change.reviewDecisions || {}) };
  for (const block of pendingBlocks) nextDecisions[block.id] = decision;
  change.reviewDecisions = nextDecisions;
  const blocks = buildExternalReviewBlocks(externalReviewBaseContent(change), change.diskContent || "", change.reviewDecisions);
  const updatedInPlace = updateExternalReviewDocumentInPlace(blocks);
  if (!updatedInPlace) renderViewer();
  restoreEditorViewState(viewState);
  updateHeader();
  updatePreview();
  setStatus("saving reviewed changes...");
  const settlePromise = updatedInPlace
    ? settleExternalReviewBlocks(pendingBlocks.map((block) => block.id), viewState, { restoreScroll: false })
    : Promise.resolve();
  await waitForInlineReviewTransition(settlePromise);
  await saveExternalReviewDecision(blocks, viewState);
}

function updateExternalReviewBlockInPlace(blocks, blockId, viewState) {
  const block = blocks.find((item) => item.id === blockId);
  const current = externalReviewBlockElement(blockId);
  if (!block || !current) return false;
  const previousHeight = current.getBoundingClientRect().height;
  current.outerHTML = renderExternalReviewBlock(block, { finalLineStart: externalReviewFinalLineStart(blocks, blockId) });
  const next = externalReviewBlockElement(blockId);
  if (next) {
    if (block.decision && previousHeight > 0) next.style.minHeight = Math.ceil(previousHeight) + "px";
    wireExternalReviewDecisionButtons(next);
  }
  refreshExternalReviewFinalLineIndexes(blocks);
  return true;
}

function updateExternalReviewDocumentInPlace(blocks) {
  const doc = document.querySelector(".external-review-doc");
  if (!doc) return false;
  const previousHeights = new Map([...doc.querySelectorAll("[data-external-review-block]")].map((element) => [element.dataset.externalReviewBlock, element.getBoundingClientRect().height]));
  doc.innerHTML = renderExternalReviewBlocks(blocks);
  for (const block of blocks) {
    if (block.kind !== "change" || !block.decision) continue;
    const element = externalReviewBlockElement(block.id);
    const previousHeight = previousHeights.get(block.id) || 0;
    if (element && previousHeight > 0) element.style.minHeight = Math.ceil(previousHeight) + "px";
  }
  wireExternalReviewDecisionButtons(doc);
  refreshExternalReviewFinalLineIndexes(blocks);
  return true;
}

function refreshExternalReviewFinalLineIndexes(blocks) {
  const doc = document.querySelector(".external-review-doc");
  if (!doc) return;
  const elements = [...doc.querySelectorAll(":scope > .external-review-block")];
  let finalLineStart = 0;
  for (let index = 0; index < blocks.length && index < elements.length; index++) {
    const rows = externalReviewRenderedRows(blocks[index]);
    [...elements[index].querySelectorAll(".markdown-line")].forEach((line, lineIndex) => {
      if (lineIndex < rows.length) line.dataset.finalLineIndex = String(finalLineStart + lineIndex);
      else delete line.dataset.finalLineIndex;
    });
    finalLineStart += rows.length;
  }
}

function waitForInlineReviewTransition(settlePromise = null) {
  if (settlePromise?.then) return settlePromise;
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
  if (!change || state.selected !== change.path) return;
  const merged = computeExternalReviewContent(blocks, externalReviewBaseContent(change), change.diskContent || "");
  viewState.textAnchor = externalReviewTextAnchor(blocks, viewState.anchorBlockId, merged);
  setStatus("saving reviewed changes...");
  if (change.source === "review" && change.changeKind === "added" && merged.length === 0) {
    await api("/api/file/revert", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: change.path }),
    });
    resetConflictState();
    resetExternalChangeState();
    state.saved = "";
    state.savedHash = null;
    state.dirty = false;
    el("editor").value = "";
    await loadFiles();
    goHub();
    setStatus("new file rejected · file removed");
    return;
  }
  if (change.source === "review" && change.changeKind === "deleted" && merged.length === 0) {
    await recordSelectedReviewBaseline(change.path, "inline review applied");
    resetConflictState();
    resetExternalChangeState();
    state.diffCollapsed = true;
    state.saved = "";
    state.savedHash = null;
    state.dirty = false;
    el("editor").value = "";
    const docEditor = el("docEditor");
    if (docEditor) docEditor.value = "";
    await loadFiles();
    if (state.selected === change.path) {
      state.selectedDiff = await readSelectedDiff(change.path);
      if (!finishExternalReviewPanelInPlace(viewState)) {
        const restoreState = inlineReviewRestoreViewState(viewState);
        renderViewer();
        restoreEditorViewState(restoreState);
      }
      updateHeader();
      updatePreview();
      setStatus("deletion kept · mark verified when reviewed");
    }
    return;
  }
  const result = await writeSelectedDiskFile(merged, change.path);
  if (change.source === "review") await recordSelectedReviewBaseline(change.path, "inline review applied");
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
    state.selectedDiff = await readSelectedDiff(change.path);
    if (!finishExternalReviewPanelInPlace(viewState)) {
      const restoreState = inlineReviewRestoreViewState(viewState);
      renderViewer();
      restoreEditorViewState(restoreState);
    }
    updateHeader();
    updatePreview();
    setStatus(result.backupPath ? "review applied · backup created" : "review applied");
  }
}

function finishExternalReviewPanelInPlace(viewState) {
  if (!document.querySelector(".external-review-doc")) return false;
  window.setTimeout(() => {
    settleFinishedExternalReview(viewState).then(() => {
      if (!activeExternalChange() && document.querySelector(".external-review-doc")) {
        finalizeExternalReviewPanelInPlace(viewState);
      }
    });
  }, 80);
  return true;
}

function finalizeExternalReviewPanelInPlace(viewState) {
  const doc = document.querySelector(".external-review-doc");
  if (!doc) return false;
  const text = el("editor").value || state.saved || "";
  const visualAnchor = captureMarkdownVisualAnchor(doc);
  const restoreState = inlineReviewRestoreViewState(viewState);
  doc.outerHTML = state.mode === "edit" ? renderMarkdownEditor(text) : renderMarkdownLineView(text);
  replaceExternalReviewActionsInPlace(text);
  wireMarkdownDocLinks();
  wireRenderedMarkdownEditor();
  syncWorkspaceScroll();
  restoreEditorViewState(restoreState, { deferred: false });
  restoreMarkdownVisualAnchor(visualAnchor);
  scheduleSessionStatePush();
  return true;
}

function replaceExternalReviewActionsInPlace(text = "") {
  const actions = document.querySelector(".file-panel > header .file-actions");
  if (!actions) return;
  const templateState = !state.selectedStartupContext && !activeFileConflict() ? templateStateForContent(text) : null;
  actions.outerHTML = renderFileActionButtons({
    reviewAction: state.selectedStartupContext ? null : reviewActionForSelectedFile(),
    dirty: state.dirty,
    templateState,
    blockedByConflict: Boolean(activeFileConflict()),
    deletable: !Boolean(state.selectedStartupContext),
  });
  wireFileActionButtons(document.querySelector(".file-panel > header") || document);
}

function settleFinishedExternalReview(viewState) {
  const doc = document.querySelector(".external-review-doc");
  if (!doc) return Promise.resolve();
  return settleExternalReviewBlocks([...doc.querySelectorAll(".external-review-block.resolved")], viewState);
}

function settleExternalReviewBlocks(blocksOrIds, viewState, options = {}) {
  const restoreScroll = options.restoreScroll !== false;
  const blocks = blocksOrIds
    .map((item) => typeof item === "string" ? externalReviewBlockElement(item) : item)
    .filter((block) => block?.classList?.contains("resolved") && !block.classList.contains("settling") && !block.classList.contains("settled"));
  if (!blocks.length) return Promise.resolve();
  const anchor = viewState?.anchorBlockId ? externalReviewBlockElement(viewState.anchorBlockId) : null;
  const anchorTop = anchor ? anchor.getBoundingClientRect().top : null;
  for (const block of blocks) {
    const startHeight = Math.ceil(block.getBoundingClientRect().height);
    block.classList.add("settling");
    block.style.height = startHeight + "px";
    block.style.minHeight = startHeight + "px";
    block.style.overflow = "hidden";
  }
  void blocks[0].offsetHeight;
  for (const block of blocks) {
    block.classList.add("settled");
    const targetHeight = naturalExternalReviewBlockHeight(block);
    block.style.height = targetHeight + "px";
    block.style.minHeight = targetHeight + "px";
  }
  if (anchor && typeof anchorTop === "number") shiftScrollForElement(anchor, anchor.getBoundingClientRect().top - anchorTop);
  if (restoreScroll) restoreEditorViewState(viewState);
  const transitionScrollStart = captureInlineReviewScrollSnapshot(viewState);
  return Promise.all(blocks.map(waitForExternalReviewBlockSettle)).then(() => {
    for (const block of blocks) {
      block.classList.remove("settling");
      block.style.height = "";
      block.style.minHeight = "";
      block.style.overflow = "";
    }
    const scrolledDuringTransition = rememberInlineReviewLiveScrollIfChanged(viewState, transitionScrollStart);
    if (!scrolledDuringTransition) {
      if (anchor && typeof anchorTop === "number") shiftScrollForElement(anchor, anchor.getBoundingClientRect().top - anchorTop);
      if (restoreScroll) restoreEditorViewState(viewState);
    }
  });
}

function captureInlineReviewScrollSnapshot(viewState = null) {
  if (!viewState) return null;
  return captureEditorViewState({ anchorBlockId: viewState.anchorBlockId || "" });
}

function inlineReviewScrollChangedSince(snapshot) {
  if (!snapshot) return false;
  const current = captureInlineReviewScrollSnapshot(snapshot);
  if (!current) return false;
  const keys = [
    "documentScrollTop",
    "documentScrollLeft",
    "editorScrollTop",
    "editorScrollLeft",
    "viewerScrollTop",
    "viewerScrollLeft",
    "windowScrollX",
    "windowScrollY",
  ];
  return keys.some((key) => Math.abs((current[key] || 0) - (snapshot[key] || 0)) > 2);
}

function rememberInlineReviewLiveScrollIfChanged(viewState, snapshot) {
  if (!viewState || !inlineReviewScrollChangedSince(snapshot)) return false;
  viewState.userScrolledDuringInlineReview = true;
  viewState.liveScrollState = captureEditorViewState({ anchorBlockId: viewState.anchorBlockId || "" });
  viewState.liveScrollState.textAnchor = null;
  return true;
}

function inlineReviewRestoreViewState(viewState) {
  if (!viewState?.userScrolledDuringInlineReview) return viewState;
  return viewState.liveScrollState || captureEditorViewState({ anchorBlockId: viewState.anchorBlockId || "" });
}

function captureMarkdownVisualAnchor(root = null) {
  const container = root || document.querySelector(".external-review-doc") || el("docHighlighter") || el("docReader");
  if (!container) return null;
  const scroller = activeDocumentScrollTarget();
  const scrollRect = scroller && scroller !== document.body && scroller !== document.documentElement
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight || document.documentElement.clientHeight || 0 };
  const lines = [...container.querySelectorAll(".markdown-line")];
  const visibleLine = lines.find((line) => {
    const rect = line.getBoundingClientRect();
    return rect.bottom > scrollRect.top + 1 && rect.top < scrollRect.bottom - 1;
  });
  if (!visibleLine) return null;
  const lineIndex = visibleLine.dataset.finalLineIndex || visibleLine.dataset.lineIndex || "";
  if (!lineIndex) return null;
  return { lineIndex, top: visibleLine.getBoundingClientRect().top };
}

function restoreMarkdownVisualAnchor(anchor) {
  if (!anchor?.lineIndex) return false;
  const root = el("docHighlighter") || el("docReader") || document;
  const line = root.querySelector('.markdown-line[data-line-index="' + cssEscape(anchor.lineIndex) + '"]');
  if (!line) return false;
  const delta = line.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) < 0.5) return true;
  const scroller = activeDocumentScrollTarget();
  if (scroller && scroller !== document.body && scroller !== document.documentElement) scroller.scrollTop += delta;
  else window.scrollBy(0, delta);
  syncMarkdownEditorScroll();
  return true;
}

function naturalExternalReviewBlockHeight(block) {
  const clone = block.cloneNode(true);
  const rect = block.getBoundingClientRect();
  const parent = block.parentElement || document.body;
  clone.classList.remove("settling");
  clone.classList.add("settled");
  clone.style.position = "absolute";
  clone.style.visibility = "hidden";
  clone.style.pointerEvents = "none";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.width = Math.max(1, Math.ceil(rect.width)) + "px";
  clone.style.height = "";
  clone.style.minHeight = "";
  clone.style.overflow = "";
  clone.style.zIndex = "-1";
  parent.appendChild(clone);
  const height = Math.ceil(clone.getBoundingClientRect().height);
  clone.remove();
  return height;
}

function waitForExternalReviewBlockSettle(block) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      block.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(fallback);
      resolve();
    };
    const onTransitionEnd = (event) => {
      if (event.target === block && event.propertyName === "height") finish();
    };
    const fallback = window.setTimeout(finish, 2400);
    block.addEventListener("transitionend", onTransitionEnd);
  });
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
    syncMarkdownEditorScroll();
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

function externalReviewBaseContent(change = activeExternalChange()) {
  return typeof change?.baseContent === "string" ? change.baseContent : state.saved || "";
}

function startupSelectionRequest() {
  const startup = state.selectedStartupContext;
  if (!startup) return null;
  if (startup.kind === "startup-skill" || startup.skillName) {
    return {
      type: "startup-skill",
      folder: String(startup.order || "").split(":")[0],
      skill: startup.skillName || String(startup.order || "").split(":").slice(1).join(":"),
    };
  }
  return { type: "startup-context", order: startup.order };
}

async function readSelectedDiskFile(path = state.selected) {
  const startup = startupSelectionRequest();
  if (startup?.type === "startup-context") return api("/api/startup-context/file?order=" + encodeURIComponent(startup.order));
  if (startup?.type === "startup-skill") return api("/api/startup-skills/file?folder=" + encodeURIComponent(startup.folder) + "&skill=" + encodeURIComponent(startup.skill));
  return api("/api/file?path=" + encodeURIComponent(path));
}

async function readSelectedDiff(path = state.selected) {
  if (state.selectedStartupContext) return { path, available: false, changed: false, additions: 0, deletions: 0, patch: "" };
  return api("/api/file/diff?path=" + encodeURIComponent(path));
}

async function readSelectedReviewBase(path = state.selected) {
  if (state.selectedStartupContext) return null;
  return api("/api/file/review-base?path=" + encodeURIComponent(path));
}

async function recordSelectedReviewBaseline(path = state.selected, note = "") {
  if (!path || state.selectedStartupContext) return null;
  return api("/api/docqa/review-baseline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, note }),
  });
}

async function startChangedFileInlineReview(path, diff, requestId = state.selectionRequest) {
  if (!path || state.reviewModePath !== path || !diff?.changed) return false;
  const review = await readSelectedReviewBase(path);
  if (!isCurrentSelection(requestId, path) || !review?.available) return false;
  if ((review.baseContent || "") === (review.currentContent || "")) {
    state.saved = typeof review.currentContent === "string" ? review.currentContent : state.saved || "";
    state.savedHash = review.currentHash || state.savedHash;
    state.dirty = false;
    state.diffCollapsed = true;
    el("editor").value = state.saved;
    setStatus("changes already reviewed · mark verified when ready");
    return false;
  }
  state.externalChange = {
    path,
    source: "review",
    baseContent: typeof review.baseContent === "string" ? review.baseContent : "",
    diskContent: typeof review.currentContent === "string" ? review.currentContent : state.saved || "",
    diskHash: review.currentHash || state.savedHash,
    diskUpdatedAt: "",
    changeKind: review.changeKind || "modified",
    reviewDecisions: {},
  };
  state.saved = state.externalChange.diskContent;
  state.savedHash = state.externalChange.diskHash || state.savedHash;
  state.dirty = false;
  state.diffCollapsed = true;
  el("editor").value = state.saved;
  setStatus(review.changeKind === "added" ? "new file waiting for review" : "changes waiting for review");
  return true;
}

async function writeSelectedDiskFile(content, path = state.selected) {
  const startup = startupSelectionRequest();
  if (startup?.type === "startup-context") {
    return api("/api/startup-context/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: startup.order, content }),
    });
  }
  if (startup?.type === "startup-skill") {
    return api("/api/startup-skills/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ folder: startup.folder, skill: startup.skill, content }),
    });
  }
  return api("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
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
  const targetBlockId = closestExternalReviewChangeBlockId();
  const change = activeExternalChange();
  const prefix = change?.source === "review" ? "review pending" : "file changed on disk";
  setStatus(prefix + " · review the highlighted change " + action);
  if (state.mode !== "view") setMode("view");
  else renderViewer();
  updateHeader();
  const focus = () => focusExternalReviewChange(targetBlockId) || focusNearestExternalReviewChange();
  if (!focus()) window.requestAnimationFrame(focus);
  return true;
}

function externalReviewChangeElements() {
  return [...document.querySelectorAll(".external-review-block.change[data-external-review-block]")];
}

function closestExternalReviewChangeElement() {
  const changes = externalReviewChangeElements();
  if (!changes.length) return null;
  const scroller = activeDocumentScrollTarget();
  const rect = scroller?.getBoundingClientRect?.();
  const centerY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
  return changes.reduce((closest, element) => {
    const elementRect = element.getBoundingClientRect();
    const distance = Math.abs(elementRect.top + elementRect.height / 2 - centerY);
    return !closest || distance < closest.distance ? { element, distance } : closest;
  }, null)?.element || null;
}

function closestExternalReviewChangeBlockId() {
  return closestExternalReviewChangeElement()?.dataset.externalReviewBlock || "";
}

function focusNearestExternalReviewChange() {
  return focusExternalReviewChange(closestExternalReviewChangeBlockId());
}

function focusExternalReviewChange(blockId) {
  let target = blockId ? externalReviewBlockElement(blockId) : closestExternalReviewChangeElement();
  if (!target && activeExternalChange()) {
    renderViewer();
    target = blockId ? externalReviewBlockElement(blockId) : closestExternalReviewChangeElement();
  }
  if (!target) return false;
  target.classList.remove("attention");
  void target.offsetWidth;
  target.classList.add("attention");
  target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
  window.setTimeout(() => target.classList.remove("attention"), 1500);
  return true;
}

function scheduleConflictCheck() {
  if (!state.selected || !state.dirty || state.openingFilePath === state.selected || state.savedHash == null) return;
  window.clearTimeout(state.conflictCheckTimer);
  state.conflictCheckTimer = window.setTimeout(() => checkSelectedFileConflict().catch((error) => setStatus(error.message)), 250);
}

async function checkSelectedFileConflict() {
  if (!state.selected || !state.dirty || state.openingFilePath === state.selected || state.savedHash == null) return false;
  const path = state.selected;
  const [data, diff] = await Promise.all([
    readSelectedDiskFile(path),
    readSelectedDiff(path),
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
  if (!change || state.selected !== change.path) return;
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
    state.selectedDiff = await readSelectedDiff(change.path);
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
  if (!change || state.selected !== path) return;
  setStatus("rejecting disk change...");
  const viewState = captureEditorViewState();
  const result = await writeSelectedDiskFile(state.saved, path);
  resetConflictState();
  resetExternalChangeState();
  state.savedHash = result.contentHash;
  state.dirty = false;
  el("editor").value = state.saved;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = state.saved;
  await loadFiles();
  if (state.selected === path) {
    state.selectedDiff = await readSelectedDiff(path);
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
  const saveButton = document.querySelector("[data-file-save]");
  markButtonSaving(saveButton);
  setStatus("saving...");
  try {
    const viewState = captureEditorViewState();
    const content = activeEditor().value;
    const result = await writeSelectedDiskFile(content);
    state.saved = content;
    state.savedHash = result.contentHash;
    if (result.startupContext) state.selectedStartupContext = result.startupContext;
    state.dirty = false;
    resetConflictState();
    resetExternalChangeState();
    await loadFiles();
    renderViewer();
    restoreEditorViewState(viewState);
    setStatus(result.backupPath ? "saved · backup created" : "saved");
    updateHeader();
    flashSavedButton(document.querySelector("[data-file-save]"), "Saved");
  } catch (error) {
    restoreButtonLabel(saveButton);
    throw error;
  }
}

async function refreshFromDisk() {
  const previousSelected = state.selected;
  try {
    const [filesData, docqa, doctor, settingsData, startupData, startupSkillsData] = await Promise.all([api(filesApiPath()), api("/api/docqa"), api("/api/doctor"), api("/api/settings"), api("/api/startup-context"), api("/api/startup-skills")]);
    state.files = filesData.files;
    state.startupContextFiles = startupData.files || [];
    state.startupSkillFolders = startupSkillsData.folders || [];
    state.docqa = docqa;
    state.doctor = doctor;
    if (!state.settingsOpen) {
      state.settings = settingsData.settings;
      applyFileTheme();
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

    if (!previousSelected || previousSelected !== state.selected) return;
    if (state.openingFilePath === state.selected || state.savedHash == null) return;
    if (activeExternalChange()?.source === "review") {
      state.selectedDiff = await readSelectedDiff(previousSelected);
      updateHeader();
      updatePreview();
      return;
    }
    const [data, diff] = await Promise.all([
      readSelectedDiskFile(previousSelected),
      readSelectedDiff(previousSelected),
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
      source: "disk",
      baseContent: state.saved || "",
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
function rememberButtonLabel(button) {
  if (!button) return "";
  window.clearTimeout(button._saveConfirmTimer);
  const original = button.dataset.saveOriginalLabel || button.textContent || "";
  button.dataset.saveOriginalLabel = original;
  if (!button.dataset.saveWasDisabled) button.dataset.saveWasDisabled = button.disabled ? "true" : "false";
  const width = Math.ceil(button.getBoundingClientRect().width);
  if (width) button.style.minWidth = width + "px";
  return original;
}
function markButtonSaving(button, label = "Saving...") {
  if (!button) return;
  rememberButtonLabel(button);
  button.classList.remove("save-confirmed");
  button.classList.add("save-pending");
  button.textContent = label;
  button.disabled = true;
  button.setAttribute("aria-live", "polite");
}
function restoreButtonLabel(button) {
  if (!button) return;
  window.clearTimeout(button._saveConfirmTimer);
  button.classList.remove("save-pending", "save-confirmed");
  button.textContent = button.dataset.saveOriginalLabel || button.textContent || "";
  button.style.minWidth = "";
  button.disabled = button.dataset.saveWasDisabled === "true";
  button.removeAttribute("aria-live");
  delete button.dataset.saveOriginalLabel;
  delete button.dataset.saveWasDisabled;
}
function flashSavedButton(button, label = "Saved") {
  if (!button) return;
  rememberButtonLabel(button);
  button.disabled = button.dataset.saveWasDisabled === "true";
  button.classList.remove("save-pending", "save-confirmed");
  button.textContent = label;
  button.setAttribute("aria-live", "polite");
  void button.offsetWidth;
  button.classList.add("save-confirmed");
  button._saveConfirmTimer = window.setTimeout(() => restoreButtonLabel(button), 1300);
}
function activeEditor() { return el("docEditor") || el("editor"); }
function isScrollableY(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  return /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
}
function activeDocumentScrollTarget() {
  const documentSurface = document.querySelector(".external-review-doc") || el("docEditor") || el("docReader");
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
  if (state.page !== "file" || !state.selected) return false;
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
function restoreEditorViewState(snapshot, options = {}) {
  if (!snapshot || snapshot.path !== state.selected) return;
  const deferred = options.deferred !== false;
  const apply = () => {
    const editor = snapshot.textAnchor ? (el("docEditor") || activeEditor()) : (snapshot.editorId ? el(snapshot.editorId) : activeEditor());
    const viewer = el("viewer");
    const documentScrollTarget = (snapshot.documentScrollTarget === "external-review-doc"
      ? document.querySelector(".external-review-doc")
      : snapshot.documentScrollTarget === "docEditor"
        ? el("docEditor")
        : snapshot.documentScrollTarget === "docReader"
          ? el("docReader")
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
    syncMarkdownEditorScroll();
  };
  apply();
  if (!deferred) return;
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

const SPOTLIGHT_CARD_SELECTOR = ".launch-card, .review-item, .hub-folder-card, .startup-context-item:not(.startup-skill-folder), .settings-section, .settings-toggle, .settings-theme-preview, .template-editor, .hub-section-editor, .hub-card-editor, .path-picker, .card, .conflict-card";
let spotlightCard = null;
let spotlightPointer = null;
let spotlightFrame = 0;
function clearCardSpotlight() {
  if (spotlightCard) spotlightCard.classList.remove("spotlight-active");
  spotlightCard = null;
}
function setCardSpotlight(card, x, y) {
  if (spotlightCard && spotlightCard !== card) spotlightCard.classList.remove("spotlight-active");
  spotlightCard = card;
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.classList.add("spotlight-active");
  card.style.setProperty("--spotlight-x", Math.round(x - rect.left) + "px");
  card.style.setProperty("--spotlight-y", Math.round(y - rect.top) + "px");
}
function updateCardSpotlightAt(x, y) {
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
    clearCardSpotlight();
    return;
  }
  const element = document.elementFromPoint(x, y);
  const card = element instanceof Element ? element.closest(SPOTLIGHT_CARD_SELECTOR) : null;
  setCardSpotlight(card, x, y);
}
function scheduleCardSpotlightUpdate() {
  if (!spotlightPointer || spotlightFrame) return;
  spotlightFrame = window.requestAnimationFrame(() => {
    spotlightFrame = 0;
    updateCardSpotlightAt(spotlightPointer.x, spotlightPointer.y);
  });
}
function updateCardSpotlight(event) {
  spotlightPointer = { x: event.clientX, y: event.clientY };
  scheduleCardSpotlightUpdate();
}
function refreshCardSpotlightAfterScroll() {
  scheduleCardSpotlightUpdate();
}

function setDocLinkModifierActive(active) {
  const next = Boolean(active);
  if (state.docLinkModifierActive === next) return;
  state.docLinkModifierActive = next;
  document.documentElement.classList.toggle("doc-link-modifier-active", next);
  if (!next) clearMarkdownEditorDocLinkHover();
}

function isMacPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.platform || "";
  return /mac|iphone|ipad|ipod/i.test(platform);
}

function isDocLinkModifierEventActive(event) {
  return isMacPlatform() ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
}

el("editor").addEventListener("input", () => {
  markUserActive();
  state.dirty = el("editor").value !== state.saved;
  updateHeader();
  updatePreview();
  if (state.mode === "view") renderViewer();
});
el("search").addEventListener("input", () => { markUserActive(); state.pathFilters = []; expandSearchMatches(); renderFiles(); scheduleSessionStatePush(); });
el("clearSearch").addEventListener("click", () => clearExplorerFilter());
document.querySelectorAll("[data-watch-filter]").forEach((button) => button.addEventListener("click", () => setExplorerWatchFilter(button.dataset.watchFilter)));
document.querySelector("aside")?.addEventListener("contextmenu", openExplorerEmptyContextMenu);
document.addEventListener("click", (event) => {
  const menu = el("explorerContextMenu");
  if (!menu || menu.hidden || menu.contains(event.target)) return;
  hideExplorerContextMenu();
});
document.addEventListener("pointermove", (event) => {
  updateCardSpotlight(event);
  setDocLinkModifierActive(isDocLinkModifierEventActive(event));
}, { passive: true });
document.addEventListener("pointerleave", () => {
  spotlightPointer = null;
  clearCardSpotlight();
}, { passive: true });
document.addEventListener("pointercancel", () => {
  spotlightPointer = null;
  clearCardSpotlight();
}, { passive: true });
document.addEventListener("scroll", refreshCardSpotlightAfterScroll, { capture: true, passive: true });
window.addEventListener("resize", refreshCardSpotlightAfterScroll, { passive: true });
window.addEventListener("blur", () => {
  spotlightPointer = null;
  clearCardSpotlight();
  setDocLinkModifierActive(false);
});
document.addEventListener("keydown", (event) => {
  markUserActive();
  setDocLinkModifierActive(isDocLinkModifierEventActive(event));
  if (handleSaveShortcut(event)) return;
  if (event.key === "Escape") {
    hideExplorerContextMenu();
  }
});
document.addEventListener("keyup", (event) => setDocLinkModifierActive(isDocLinkModifierEventActive(event)));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setDocLinkModifierActive(false);
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
el("gitDiffToggle").addEventListener("click", () => {
  if (!state.selectedDiff?.changed) return;
  setDiffCollapsed(!state.diffCollapsed);
});
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
  if (!state.dirty && !activeExternalChange()) return;
  if (activeExternalChange()) focusNearestExternalReviewChange();
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("pointerdown", markUserActive, { passive: true });
document.addEventListener("scroll", scheduleSessionStatePush, { capture: true, passive: true });
syncResponsiveSidebar({ force: true });
window.addEventListener("resize", () => syncResponsiveSidebar());
setMode("view");
startAgentCommandPolling();
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
