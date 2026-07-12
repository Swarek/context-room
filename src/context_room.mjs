#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { collectInlinePathReferences, parseDocMetadata, renderDocMetadataTemplateValues } from "./doc_metadata.mjs";
import { parseSimpleYaml, stringifyYaml } from "./yaml_utils.mjs";

export { DOC_METADATA_KINDS, DOC_METADATA_STATUSES, parseDocMetadata } from "./doc_metadata.mjs";

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_PORT = 4317;
const MAX_FILE_BYTES = 750_000;
const PROJECT_EXPLORER_MAX_FILES = 20000;
const MAX_BATCH_REVIEW_PATHS = 5000;
const MAX_GIT_HEAD_SNAPSHOT_BYTES = 64_000_000;
const DELETED_REVIEW_SCAN_CHUNK_PATHS = 250;
const MAX_RENAME_SIMILARITY_COMPARISONS = 100_000;
const MAX_RENAME_SIMILARITY_SIGNATURE_BYTES = 16_000_000;
const MAX_RENAME_SIMILARITY_TOKEN_CHECKS = 2_000_000;
const UNMERGED_GIT_STATUSES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
export const CONFIG_DIR = ".context-room";
export const CONFIG_FILE = `${CONFIG_DIR}/config.json`;
export const AGENT_CONTEXT_DIR = `${CONFIG_DIR}/agent-context`;
export const AGENT_CONTEXT_FILE = `${CONFIG_DIR}/README.md`;
const LEGACY_AGENT_CONTEXT_FILE = `${AGENT_CONTEXT_DIR}/README.md`;
export const GLOBAL_PREFERENCES_FILE = "~/.context-room/preferences.json";
const CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/Swarek/context-room/main/schemas/config.schema.json";
const DOCQA_REVIEW_STATE = `${CONFIG_DIR}/review-state.json`;
const DOCQA_REVIEW_BASELINES = `${CONFIG_DIR}/review-baselines`;
const DOCQA_GLOBAL_REVIEW_LEDGER = `${CONFIG_DIR}/review-ledger.json`;
const CONTEXT_HEALTH_ACKNOWLEDGEMENTS = `${CONFIG_DIR}/health-acknowledgements.json`;
const COLLAB_SESSION_STATE = `${CONFIG_DIR}/session-state.json`;
const COLLAB_AGENT_COMMAND = `${CONFIG_DIR}/agent-command.json`;
const COLLAB_AGENT_ANNOTATIONS = `${CONFIG_DIR}/agent-annotations.json`;
const MEMORY_WEBAPP_SETTINGS = CONFIG_FILE;
const HERMES_CRON_JOBS_FILE = "~/.hermes/cron/jobs.json";
const HERMES_CRON_JOBS_FOLDER = "~/.hermes/cron/jobs/";
const HERMES_CRON_MD_FOLDER = "~/.hermes/cron/jobs-md/";
const DEFAULT_STARTUP_CONTEXT = { enabled: false, fileNames: ["AGENTS.md", "CLAUDE.md"], globalPaths: ["~/.codex/AGENTS.md"] };
const DEFAULT_STARTUP_SKILLS = { enabled: true, folderNames: [".codex/skills", "skills"] };
const DEFAULT_AGENT_HOOK_SOURCES = [
  { id: "codex", label: "Codex", paths: [".codex/hooks.json"] },
  { id: "claude-code", label: "Claude Code", paths: [".claude/settings.json", ".claude/settings.local.json"] },
  { id: "opencode", label: "OpenCode", paths: [".config/opencode/opencode.json", ".config/opencode/plugin/", ".config/opencode/plugins/", ".opencode/plugin/", ".opencode/plugins/", "opencode.json", "opencode.jsonc"] },
];
const DEFAULT_STARTUP_HOOKS = {
  enabled: true,
  editable: false,
  agentHooks: true,
  codexHooks: true,
  gitHooks: true,
  hookManagers: true,
  fileNames: ["pre-commit", "pre-push", "commit-msg", "prepare-commit-msg"],
  agentHookSources: DEFAULT_AGENT_HOOK_SOURCES,
  agentHookPaths: DEFAULT_AGENT_HOOK_SOURCES.flatMap((source) => source.paths),
  codexPaths: [".codex/hooks.json"],
  managerPaths: [
    ".husky/",
    "lefthook.yml",
    ".lefthook.yml",
    "lefthook.yaml",
    ".lefthook.yaml",
    ".pre-commit-config.yaml",
    ".pre-commit-config.yml",
    "lint-staged.config.js",
    "lint-staged.config.mjs",
    "lint-staged.config.cjs",
    ".lintstagedrc",
    ".lintstagedrc.json",
    ".lintstagedrc.js",
    ".lintstagedrc.cjs",
    "package.json",
  ],
};
export const FILE_THEME_OPTIONS = [
  { id: "context-room", label: "Context Room", description: "Default dark theme" },
  { id: "vscode-dark", label: "VS Code Dark", description: "Quiet editor contrast" },
  { id: "github-dark", label: "GitHub Dark", description: "Clear docs contrast" },
  { id: "dracula", label: "Dracula", description: "High color structure" },
  { id: "solarized-dark", label: "Solarized Dark", description: "Soft long-read palette" },
  { id: "light-plus", label: "Light Plus", description: "Bright document surface" },
];
export const DATA_VISUAL_DOCUMENT_PATTERNS = Object.freeze([
  { id: "data-metric-grid", className: "cr-metrics", group: "data-summary" },
  { id: "data-kpi-grid", className: "cr-kpi-grid", group: "data-summary" },
  { id: "data-stat-strip", className: "cr-stat-strip", group: "data-summary" },
  { id: "data-scorecard", className: "cr-scorecard", group: "data-summary" },
  { id: "data-progress-list", className: "cr-progress-list", group: "data-summary" },
  { id: "data-bullet-chart", className: "cr-bullet-chart", group: "data-summary" },
  { id: "data-gauge", className: "cr-gauge", group: "data-summary" },
  { id: "data-ring", className: "cr-ring", group: "data-summary" },
  { id: "data-delta-grid", className: "cr-delta-grid", group: "data-summary" },
  { id: "data-status-summary", className: "cr-status-summary", group: "data-summary" },
  { id: "data-comparison", className: "cr-comparison", group: "data-comparison" },
  { id: "data-before-after", className: "cr-before-after", group: "data-comparison" },
  { id: "data-pros-cons", className: "cr-pros-cons", group: "data-comparison" },
  { id: "data-decision-matrix", className: "cr-decision-matrix", group: "data-comparison" },
  { id: "data-feature-matrix", className: "cr-feature-matrix", group: "data-comparison" },
  { id: "data-quadrant", className: "cr-quadrant", group: "data-comparison" },
  { id: "data-spectrum", className: "cr-spectrum", group: "data-comparison" },
  { id: "data-ranking", className: "cr-ranking", group: "data-comparison" },
  { id: "data-benchmark", className: "cr-benchmark", group: "data-comparison" },
  { id: "data-distribution", className: "cr-distribution", group: "data-comparison" },
  { id: "data-bar-chart", className: "cr-bar-chart", group: "data-chart" },
  { id: "data-grouped-bars", className: "cr-grouped-bars", group: "data-chart" },
  { id: "data-stacked-bar", className: "cr-stacked-bar", group: "data-chart" },
  { id: "data-diverging-bars", className: "cr-diverging-bars", group: "data-chart" },
  { id: "data-lollipop-chart", className: "cr-lollipop-chart", group: "data-chart" },
  { id: "data-dot-plot", className: "cr-dot-plot", group: "data-chart" },
  { id: "data-histogram", className: "cr-histogram", group: "data-chart" },
  { id: "data-sparkline", className: "cr-sparkline", group: "data-chart" },
  { id: "data-heatmap", className: "cr-heatmap", group: "data-chart" },
  { id: "data-waterfall", className: "cr-waterfall", group: "data-chart" },
  { id: "data-timeline", className: "cr-timeline", group: "data-structure" },
  { id: "data-roadmap", className: "cr-roadmap", group: "data-structure" },
  { id: "data-swimlane", className: "cr-swimlane", group: "data-structure" },
  { id: "data-flow", className: "cr-flow", group: "data-structure" },
  { id: "data-cycle", className: "cr-cycle", group: "data-structure" },
  { id: "data-funnel", className: "cr-funnel", group: "data-structure" },
  { id: "data-pyramid", className: "cr-pyramid", group: "data-structure" },
  { id: "data-tree", className: "cr-tree", group: "data-structure" },
  { id: "data-dependency-chain", className: "cr-dependency-chain", group: "data-structure" },
  { id: "data-status-board", className: "cr-status-board", group: "data-structure" },
]);

export const DIAGRAM_VISUAL_DOCUMENT_PATTERNS = Object.freeze([
  { id: "system-landscape", className: "cr-system-landscape", group: "diagram" },
  { id: "causal-chain", className: "cr-causal-chain-map", group: "diagram" },
  { id: "branching-decision", className: "cr-branching-decision", group: "diagram" },
  { id: "actor-sequence", className: "cr-actor-sequence", group: "diagram" },
  { id: "reasoning-map", className: "cr-reasoning-map", group: "diagram" },
]);
export const CONCEPT_VISUAL_DOCUMENT_PATTERNS = DIAGRAM_VISUAL_DOCUMENT_PATTERNS;
export const VISUAL_DOCUMENT_PATTERNS = Object.freeze([
  ...DATA_VISUAL_DOCUMENT_PATTERNS,
  ...DIAGRAM_VISUAL_DOCUMENT_PATTERNS,
]);
const DEFAULT_FILE_THEME = "context-room";
const DEFAULT_APPEARANCE = { fileTheme: DEFAULT_FILE_THEME, autoOpenGitDiff: true, showHiddenFiles: true };
const REPORT_CACHE_TTL_MS = 60_000;
const FILE_TASK_CACHE_TTL_MS = 30_000;
const BACKGROUND_REPORT_INVALIDATING_PATHS = new Set([
  "/api/startup-skills/create",
  "/api/startup-skills/delete",
  "/api/startup-skills/file",
  "/api/startup-context/file",
  "/api/startup-context/delete",
  "/api/startup-hooks/file",
  "/api/settings",
  "/api/doctor/ack",
  "/api/docqa/review",
  "/api/docqa/review-deletions",
  "/api/docqa/review-baseline",
  "/api/file/revert",
  "/api/file",
  "/api/markdown/create",
  "/api/folder/create",
  "/api/markdown/apply-template",
  "/api/files/delete",
]);
const BACKGROUND_WATCH_IGNORED_PATHS = new Set([
  COLLAB_SESSION_STATE,
  COLLAB_AGENT_COMMAND,
  COLLAB_AGENT_ANNOTATIONS,
]);
const gitTopLevelCache = new Map();
const backgroundReportCache = new Map();
const backgroundReportGenerations = new Map();
const backgroundFileTaskCache = new Map();
const backgroundFileTaskGenerations = new Map();
const backgroundExplicitInvalidations = new Map();
const backgroundWorkerPools = new Map();
let backgroundWorkerRequestId = 0;
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
const PROJECT_EXPLORER_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  "coverage",
  "dist",
  "build",
  "target",
  ".DS_Store",
]);
const PROJECT_TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".csv",
  ".tsv",
  ".txt",
  ".json",
  ".jsonc",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env.example",
  ".mjs",
  ".cjs",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".sh",
  ".bash",
  ".zsh",
  ".css",
  ".scss",
  ".sass",
  ".html",
  ".htm",
  ".xml",
  ".sql",
  ".graphql",
  ".gql",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".swift",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".Dockerfile",
]);
const PROJECT_TEXT_FILENAMES = new Set([
  "Dockerfile",
  "Containerfile",
  "Makefile",
  "Rakefile",
  "Gemfile",
  "Procfile",
  "README",
  "LICENSE",
  "CHANGELOG",
  ".dockerignore",
  ".editorconfig",
  ".eslintignore",
  ".gitattributes",
  ".gitignore",
  ".markdownlintignore",
  ".node-version",
  ".npmignore",
  ".nvmrc",
  ".prettierignore",
  ".python-version",
  ".ruby-version",
  ".tool-versions",
]);
const SAFE_ENV_SAMPLE_FILENAMES = new Set([".env.example", ".env.sample", ".env.template", ".env.defaults"]);

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
        kind: fileKindForPath(file.path),
        summary: summarizeContent(content),
      };
    })
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.path.localeCompare(b.path, "fr"));
}

export function listExplorerFiles(root = process.cwd(), { externalRoots = [], showHiddenFiles = true } = {}) {
  const settings = effectiveMemoryWebappSettings(root);
  const byPath = new Map();
  for (const file of listMemoryFiles(root, { externalRoots })) {
    byPath.set(file.path, { ...file, readOnly: false, explorerScope: "allowed" });
  }
  for (const rel of walkProjectExplorerTextFiles(root, { showHiddenFiles })) {
    if (byPath.has(rel)) continue;
    const abs = path.join(root, rel);
    const stats = fs.existsSync(abs) ? fs.statSync(abs) : null;
    if (!stats?.isFile()) continue;
    const canRead = isProjectReadableMemoryPath(rel, root);
    const sensitive = isSensitiveProjectFile(rel);
    if (!canRead && !sensitive) continue;
    const allowed = isAllowedMemoryPath(rel, settings);
    const safeContent = sensitive
      ? redactedSensitiveFileContent(abs, rel)
      : allowed && stats.size <= MAX_FILE_BYTES
        ? fs.readFileSync(abs, "utf8")
        : "";
    byPath.set(rel, {
      path: rel,
      label: path.basename(rel),
      category: categoryForPath(rel),
      exists: true,
      bytes: stats.size,
      chars: safeContent.length,
      updatedAt: stats.mtime.toISOString(),
      kind: fileKindForPath(rel),
      summary: sensitive ? sensitiveFileSummary(abs) : summarizeContent(safeContent),
      readOnly: sensitive || !allowed,
      sensitive,
      redacted: sensitive,
      explorerScope: allowed && !sensitive ? "allowed" : "project",
    });
  }
  return [...byPath.values()]
    .filter((file) => showHiddenFiles || !isHiddenProjectPath(file.path))
    .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.path.localeCompare(b.path, "fr"));
}

export function readMemoryFile(root, relPath) {
  if (isCronJobVirtualPath(relPath)) return readCronJobVirtualFile(relPath);
  if (isCronJobMarkdownPath(relPath)) return readCronJobMarkdownFile(relPath);
  const normalized = normalizeRelPath(relPath);
  if (isSensitiveProjectFile(normalized)) return readSensitiveProjectFile(root, normalized);
  const allowed = isAllowedMemoryPath(normalized, effectiveMemoryWebappSettings(root));
  const abs = allowed ? resolveMemoryPath(root, normalized) : resolveProjectReadableMemoryPath(root, normalized);
  if (!fs.existsSync(abs)) {
    return { path: normalized, content: "", exists: false, updatedAt: null, chars: 0, contentHash: hashContent(""), readOnly: !allowed };
  }
  const stats = fs.statSync(abs);
  if (!stats.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${relPath}`);
  const content = fs.readFileSync(abs, "utf8");
  return {
    path: normalized,
    content,
    exists: true,
    updatedAt: stats.mtime.toISOString(),
    chars: content.length,
    contentHash: hashContent(content),
    readOnly: !allowed,
  };
}

export function listStartupContextFiles(root = process.cwd(), settings = readMemoryWebappSettings(root)) {
  const config = normalizeStartupContextSettings(settings.startupContext);
  if (!config.enabled) return [];
  const resolvedRoot = path.resolve(root);
  const found = [];
  const seenAbs = new Set();
  const addFound = (abs, fileName, dir, source = "ancestor") => {
    const resolved = path.resolve(abs);
    if (seenAbs.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    seenAbs.add(resolved);
    found.push({ abs: resolved, fileName, dir, source });
  };
  for (const relPath of config.globalPaths || []) {
    const abs = resolveExternalPath(relPath);
    if (!abs) continue;
    addFound(abs, path.basename(abs), path.dirname(abs), "global");
  }
  for (const dir of ancestorDirsForRoot(resolvedRoot)) {
    for (const fileName of config.fileNames) {
      const abs = path.join(dir, fileName);
      addFound(abs, fileName, dir, "ancestor");
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
        source: item.source,
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

export function listStartupHookFiles(root = process.cwd(), settings = readMemoryWebappSettings(root)) {
  const config = normalizeStartupHookSettings(settings.startupHooks);
  if (!config.enabled) return [];
  const found = [];
  const seen = new Set();
  const pushHook = (abs, source, sourceLabel, metadata = {}) => {
    const resolved = path.resolve(abs);
    if (seen.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    if (resolved.endsWith(".sample")) return;
    if (path.basename(resolved) === "package.json" && !packageJsonHasHookConfig(resolved)) return;
    const summary = summarizeStartupHook(resolved, source, sourceLabel, metadata);
    seen.add(resolved);
    found.push({
      abs: resolved,
      source,
      sourceLabel,
      provider: metadata.provider || "",
      label: metadata.label || summary.name || path.basename(resolved),
      description: metadata.description || summary.description || "",
      commandSummary: summarizeHookCommand(metadata.command || ""),
      event: metadata.event || "",
      command: metadata.command || "",
      fileName: path.basename(resolved),
      executable: isExecutableFile(resolved),
      readOnly: !config.editable,
    });
  };

  if (config.agentHooks) {
    for (const hook of agentHookCandidates(root, config)) {
      pushHook(hook.abs, hook.source, hook.sourceLabel, hook);
    }
  }

  if (config.gitHooks) {
    for (const hookDir of gitHookDirectories(root)) {
      for (const fileName of config.fileNames) pushHook(path.join(hookDir.abs, fileName), hookDir.source, hookDir.sourceLabel);
    }
  }

  if (config.hookManagers) {
    for (const manager of hookManagerCandidates(root, config)) {
      if (manager.isDirectory) {
        for (const fileName of config.fileNames) pushHook(path.join(manager.abs, fileName), manager.source, manager.sourceLabel);
      } else {
        pushHook(manager.abs, manager.source, manager.sourceLabel);
      }
    }
  }

  const trackedFiles = trackedGitFileSet(root, found.map((item) => item.abs));
  return found.map((item, index) => ({
    label: item.label || item.fileName,
    category: "0 · startup hooks",
    impact: `${item.sourceLabel} hook${item.event ? ` (${item.event})` : ""} from ${displayPath(item.abs)}`,
    startupHook: {
      order: index + 1,
      fileName: item.fileName,
      label: item.label || item.fileName,
      description: item.description,
      commandSummary: item.commandSummary,
      absolutePath: item.abs,
      displayPath: displayPath(item.abs),
      explorerPath: memoryPathForAbsolutePath(root, item.abs),
      kind: "startup-hook",
      source: item.source,
      sourceLabel: item.sourceLabel,
      provider: item.provider || "",
      event: item.event,
      command: item.command,
      executable: item.executable,
      tracked: trackedFiles.has(safeRealPath(item.abs)),
      readOnly: item.readOnly,
    },
  }));
}

export function readStartupHookFile(root = process.cwd(), order = 0, settings = readMemoryWebappSettings(root)) {
  const found = resolveStartupHookFile(root, order, settings);
  if (!found) throw new Error(`Startup hook file not found: ${order}`);
  const abs = found.startupHook.absolutePath;
  const stats = fs.statSync(abs);
  if (!stats.isFile()) throw new Error(`Not a file: ${found.startupHook.displayPath}`);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${found.startupHook.displayPath}`);
  const content = fs.readFileSync(abs, "utf8");
  if (content.includes("\u0000")) throw new Error(`Startup hook file is not text: ${found.startupHook.displayPath}`);
  return {
    label: found.label,
    path: found.startupHook.displayPath,
    content,
    exists: true,
    updatedAt: stats.mtime.toISOString(),
    chars: content.length,
    contentHash: hashContent(content),
    startupContext: publicStartupHookFile(found).startupContext,
  };
}

export function writeStartupHookFile(root = process.cwd(), order = 0, content = "", settings = readMemoryWebappSettings(root)) {
  const found = resolveStartupHookFile(root, order, settings);
  if (!found) throw new Error(`Startup hook file not found: ${order}`);
  if (found.startupHook.readOnly) throw new Error(`Startup hook editing is disabled: ${found.startupHook.displayPath}`);
  return writeAbsoluteStartupFile(found.startupHook.absolutePath, content, publicStartupHookFile(found).startupContext);
}

function gitHookDirectories(root) {
  const dirs = [];
  try {
    const hookPath = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (hookPath) dirs.push({ abs: path.resolve(hookPath), source: "git-hooks", sourceLabel: "Git hooks" });
  } catch {}
  try {
    const configured = execFileSync("git", ["config", "--get", "core.hooksPath"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (configured) dirs.push({ abs: path.isAbsolute(configured) ? configured : path.resolve(root, configured), source: "core-hooks-path", sourceLabel: "Git core.hooksPath" });
  } catch {}
  const seen = new Set();
  return dirs.filter((item) => {
    const resolved = path.resolve(item.abs);
    if (seen.has(resolved) || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return false;
    seen.add(resolved);
    return true;
  });
}

function hookManagerCandidates(root, config) {
  const resolvedRoot = path.resolve(root);
  return config.managerPaths.flatMap((managerPath) => {
    const clean = normalizeRelPath(managerPath);
    if (!clean || clean.startsWith("../") || clean.includes("/../") || path.isAbsolute(clean) || isBlockedPath(clean)) return [];
    const abs = path.resolve(resolvedRoot, clean.replace(/\/$/, ""));
    if (abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`)) return [];
    if (!fs.existsSync(abs)) return [];
    const stats = fs.statSync(abs);
    return [{
      abs,
      isDirectory: stats.isDirectory(),
      source: hookManagerSourceForPath(clean),
      sourceLabel: hookManagerLabelForPath(clean),
    }];
  });
}

function agentHookCandidates(root, config) {
  const hooks = [];
  const seen = new Set();
  const push = (hook) => {
    const resolved = path.resolve(hook.abs);
    const key = `${hook.source}:${hook.event || ""}:${resolved}`;
    if (seen.has(key) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return;
    seen.add(key);
    hooks.push({ ...hook, abs: resolved });
  };
  for (const base of ancestorDirsForRoot(root)) {
    for (const source of config.agentHookSources || []) {
      for (const relPath of source.paths || []) {
        const clean = normalizeRelPath(relPath);
        if (!clean || clean.startsWith("../") || clean.includes("/../") || path.isAbsolute(clean) || isBlockedPath(clean)) continue;
        const hooksPath = path.resolve(base, clean.replace(/\/$/, ""));
        if (hooksPath !== base && !hooksPath.startsWith(`${base}${path.sep}`)) continue;
        if (!fs.existsSync(hooksPath)) continue;
        const stats = fs.statSync(hooksPath);
        if (stats.isDirectory()) {
          for (const file of agentHookFilesInDirectory(hooksPath)) {
            const provider = agentHookProviderForPath(file, source);
            push({
              abs: file,
              source: `${provider.id}-agent-plugin`,
              sourceLabel: provider.label,
              label: `${provider.label} · ${path.basename(file)}`,
              provider: provider.id,
            });
          }
          continue;
        }
        if (!stats.isFile()) continue;
        const provider = agentHookProviderForPath(hooksPath, source);
        push({
          abs: hooksPath,
          source: `${provider.id}-agent-hooks`,
          sourceLabel: provider.label,
          label: `${provider.label} config`,
          event: path.basename(hooksPath),
          provider: provider.id,
        });
        for (const commandHook of parseAgentHooksConfig(hooksPath)) {
          for (const target of agentHookCommandTargets(base, commandHook.command)) {
            const targetProvider = agentHookProviderForPath(target, provider);
            push({
              abs: target,
              source: `${targetProvider.id}-agent-hook-script`,
              sourceLabel: `${targetProvider.label} ${commandHook.event}`,
              label: `${commandHook.event} · ${path.basename(target)}`,
              event: commandHook.event,
              command: commandHook.command,
              provider: targetProvider.id,
            });
          }
        }
      }
    }
  }
  return hooks;
}

function agentHookFilesInDirectory(dir) {
  const allowedExts = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh", ".json", ".jsonc"]);
  const files = [];
  const walk = (current, depth = 0) => {
    if (depth > 2 || files.length >= 80) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(abs, depth + 1);
      } else if (entry.isFile() && allowedExts.has(path.extname(entry.name))) {
        files.push(abs);
      }
    }
  };
  try {
    walk(dir);
  } catch {}
  return files;
}

function parseAgentHooksConfig(abs) {
  try {
    const parsed = JSON.parse(stripJsonComments(fs.readFileSync(abs, "utf8")));
    const hooks = [];
    for (const [event, groups] of Object.entries(parsed.hooks || {})) {
      for (const group of Array.isArray(groups) ? groups : []) {
        for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
          if (hook?.type === "command" && typeof hook.command === "string" && hook.command.trim()) {
            hooks.push({ event, command: hook.command.trim() });
          }
        }
      }
    }
    return hooks;
  } catch {
    return [];
  }
}

function stripJsonComments(content) {
  return String(content || "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function agentHookCommandTargets(repoRoot, command) {
  const targets = new Set();
  const addCandidate = (candidate) => {
    const resolved = path.resolve(repoRoot, candidate);
    if (resolved !== repoRoot && resolved.startsWith(`${path.resolve(repoRoot)}${path.sep}`) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      targets.add(resolved);
    }
  };
  for (const match of String(command || "").matchAll(/\$repo_root\/([^"'\s]+)/g)) addCandidate(match[1]);
  for (const match of String(command || "").matchAll(/(^|[\s"'])(\.[A-Za-z0-9_-]+\/[^"'\s]+)/g)) addCandidate(match[2]);
  for (const match of String(command || "").matchAll(/(^|[\s"'])(\/[^"'\s]+\.(?:py|js|mjs|cjs|sh|bash|zsh))/g)) {
    const resolved = path.resolve(match[2]);
    const base = path.resolve(repoRoot);
    if (resolved !== base && resolved.startsWith(`${base}${path.sep}`) && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      targets.add(resolved);
    }
  }
  return [...targets];
}

function agentHookProviderForPath(abs, fallback = null) {
  const clean = displayPath(abs).toLowerCase();
  if (clean.includes("/.claude/")) return { id: "claude", label: "Claude Code hooks" };
  if (clean.includes("/.opencode/") || clean.includes("/.config/opencode/") || clean.endsWith("/opencode.json") || clean.endsWith("/opencode.jsonc")) {
    return { id: "opencode", label: "OpenCode hooks" };
  }
  if (clean.includes("/.codex/")) return { id: "codex", label: "Codex hooks" };
  if (fallback) return { id: sanitizeAgentHookSourceId(fallback.id || fallback.label), label: agentHookDisplayLabel(fallback.label || fallback.id || "Agent") };
  return { id: "agent", label: "Agent hooks" };
}

function agentHookDisplayLabel(label) {
  const clean = String(label || "Agent").trim() || "Agent";
  return /\bhooks$/i.test(clean) ? clean : `${clean} hooks`;
}

function hookManagerSourceForPath(relPath) {
  const clean = normalizeRelPath(relPath).replace(/\/$/, "");
  if (clean === ".husky") return "husky";
  if (clean.includes("lefthook")) return "lefthook";
  if (clean.includes("pre-commit")) return "pre-commit";
  if (clean.includes("lint-staged") || clean.includes("lintstaged")) return "lint-staged";
  if (clean === "package.json") return "package-hooks";
  return "hook-manager";
}

function hookManagerLabelForPath(relPath) {
  const source = hookManagerSourceForPath(relPath);
  if (source === "husky") return "Husky";
  if (source === "lefthook") return "Lefthook";
  if (source === "pre-commit") return "pre-commit";
  if (source === "lint-staged") return "lint-staged";
  if (source === "package-hooks") return "package.json hooks";
  return "Hook manager";
}

function summarizeStartupHook(abs, source, sourceLabel, metadata = {}) {
  const fileName = path.basename(abs);
  const name = metadata.label || startupHookDisplayName(fileName, source, sourceLabel, metadata);
  if (source.endsWith("-agent-hooks")) {
    const owner = String(sourceLabel || "Agent").replace(/\s+hooks$/i, "");
    return { name, description: `Defines ${owner} hook events and commands active for this workspace.` };
  }
  if (source === "package-hooks") {
    return { name, description: summarizePackageHookConfig(abs) || "Defines package-level hook tooling such as lint-staged, Husky, or simple-git-hooks." };
  }
  const description = extractHookFileDescription(abs) || genericHookDescription(fileName, source, sourceLabel, metadata);
  return { name, description };
}

function startupHookDisplayName(fileName, source, sourceLabel, metadata = {}) {
  if (source.endsWith("-agent-hook-script") && metadata.event) return `${metadata.event} · ${fileName}`;
  if (source.endsWith("-agent-hooks")) return `${sourceLabel || "Agent hooks"} config`;
  if (source.endsWith("-agent-plugin")) return `${sourceLabel || "Agent"} plugin · ${fileName}`;
  if (source === "git-hooks" || source === "core-hooks-path") return `Git ${fileName} hook`;
  if (source === "package-hooks") return "package.json hook config";
  if (source === "husky") return `Husky ${fileName}`;
  return `${sourceLabel || "Hook"} · ${fileName}`;
}

function genericHookDescription(fileName, source, sourceLabel, metadata = {}) {
  if (source.endsWith("-agent-hook-script")) {
    return `${metadata.event || "Agent"} hook script run by ${sourceLabel || "the agent"} for this workspace.`;
  }
  if (source.endsWith("-agent-plugin")) {
    return `${sourceLabel || "Agent"} plugin file that may register hooks or commands for this workspace.`;
  }
  if (source === "git-hooks" || source === "core-hooks-path" || source === "husky") {
    return `${sourceLabel || "Git"} ${fileName} hook that may block or mutate commits.`;
  }
  return `${sourceLabel || "Hook"} file that may affect agent work, commits, or validation.`;
}

function extractHookFileDescription(abs) {
  try {
    const content = fs.readFileSync(abs, "utf8").slice(0, 32_000);
    if (content.includes("\u0000")) return "";
    return extractTripleQuotedDescription(content)
      || extractJsDocDescription(content)
      || extractCommentSectionDescription(content)
      || "";
  } catch {
    return "";
  }
}

function extractTripleQuotedDescription(content) {
  const match = content.match(/^\s*(?:#![^\n]*\n)?(?:#.*\n|\s)*?(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
  return cleanHookDescription(match?.[1] || match?.[2] || "");
}

function extractJsDocDescription(content) {
  const match = content.match(/^\s*(?:#![^\n]*\n)?\s*\/\*\*([\s\S]*?)\*\//);
  if (!match) return "";
  return cleanHookDescription(match[1].split(/\r?\n/).map((line) => line.replace(/^\s*\*\s?/, "")).join(" "));
}

function extractCommentSectionDescription(content) {
  const comments = [];
  for (const line of content.split(/\r?\n/).slice(0, 120)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#!")) continue;
    if (trimmed.startsWith("#")) {
      const clean = trimmed.replace(/^#+\s?/, "").trim();
      if (clean && !/^shellcheck\b/i.test(clean)) comments.push(clean);
    }
  }
  return cleanHookDescription(comments.slice(0, 6).join(" · "));
}

function cleanHookDescription(value) {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > 220 ? normalized.slice(0, 217).trimEnd() + "..." : normalized;
}

function summarizeHookCommand(command) {
  const clean = String(command || "").replace(/\s+/g, " ").trim();
  if (!clean) return "";
  const target = clean.match(/\$repo_root\/([^"'\s]+)/)?.[1] || clean.match(/\.[A-Za-z0-9_-]+\/[^"'\s]+/)?.[0] || "";
  if (target) return `runs ${target}`;
  return clean.length > 140 ? clean.slice(0, 137).trimEnd() + "..." : clean;
}

function summarizePackageHookConfig(abs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    const parts = [];
    if (parsed["lint-staged"]) parts.push("lint-staged rules");
    if (parsed["simple-git-hooks"]) parts.push("simple-git-hooks commands");
    if (parsed.husky) parts.push("Husky config");
    const scripts = Object.entries(parsed.scripts || {})
      .filter(([, script]) => /\b(husky|lint-staged|lefthook|pre-commit)\b/.test(String(script || "")))
      .map(([name]) => `script:${name}`);
    parts.push(...scripts.slice(0, 4));
    return parts.length ? `Defines ${parts.join(", ")}.` : "";
  } catch {
    return "";
  }
}

function packageJsonHasHookConfig(abs) {
  try {
    const parsed = JSON.parse(fs.readFileSync(abs, "utf8"));
    if (parsed["lint-staged"] || parsed["simple-git-hooks"] || parsed.husky) return true;
    const scripts = parsed.scripts || {};
    return Object.values(scripts).some((script) => /\b(husky|lint-staged|lefthook|pre-commit)\b/.test(String(script || "")));
  } catch {
    return false;
  }
}

function isExecutableFile(abs) {
  try {
    return Boolean(fs.statSync(abs).mode & 0o111);
  } catch {
    return false;
  }
}

function trackedGitFileSet(root, absolutePaths = []) {
  const resolvedRoot = safeRealPath(gitTopLevel(root) || path.resolve(root));
  const relativePaths = absolutePaths.map((abs) => {
    const resolved = safeRealPath(abs);
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) return "";
    return path.relative(resolvedRoot, resolved).replaceAll(path.sep, "/");
  }).filter(Boolean);
  if (!relativePaths.length) return new Set();
  try {
    const output = execFileSync("git", ["ls-files", "--", ...relativePaths], { cwd: resolvedRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return new Set(output.split("\n").map((rel) => rel.trim()).filter(Boolean).map((rel) => safeRealPath(path.join(resolvedRoot, rel))));
  } catch {
    return new Set();
  }
}

function safeRealPath(value) {
  try {
    return fs.realpathSync(path.resolve(value));
  } catch {
    return path.resolve(value);
  }
}

function gitTopLevel(root) {
  return cachedGitTopLevel(root);
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

function resolveStartupHookFile(root, order, settings = readMemoryWebappSettings(root)) {
  const normalizedOrder = Number(order);
  return listStartupHookFiles(root, settings).find((file) => file.startupHook.order === normalizedOrder);
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
      source: file.startupContext.source || "ancestor",
    },
  };
}

function publicStartupHookFile(file) {
  return {
    label: file.label,
    category: file.category,
    impact: file.impact,
    startupContext: {
      order: file.startupHook.order,
      fileName: file.startupHook.fileName,
      label: file.startupHook.label,
      description: file.startupHook.description,
      commandSummary: file.startupHook.commandSummary,
      displayPath: file.startupHook.displayPath,
      explorerPath: file.startupHook.explorerPath,
      kind: "startup-hook",
      source: file.startupHook.source,
      sourceLabel: file.startupHook.sourceLabel,
      provider: file.startupHook.provider,
      event: file.startupHook.event,
      command: file.startupHook.command,
      executable: Boolean(file.startupHook.executable),
      tracked: Boolean(file.startupHook.tracked),
      readOnly: Boolean(file.startupHook.readOnly),
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
  if (!gitTopLevelRoot(root)) {
    return { path: normalized, changed: false, additions: 0, deletions: 0, patch: "", available: false, reason: "Git diff is unavailable outside a Git repository."};
  }
  try {
    const statusEntry = readReviewGitStatusEntry(root, normalized);
    const status = statusEntry?.status || "";
    if (status === "??" && !statusEntry?.oldPath) return buildNewFileDiff(root, normalized, abs);
    if (statusEntry?.baselineRename && statusEntry.oldPath) return buildReviewBaselineRenameDiff(root, statusEntry.oldPath, normalized);
    if (statusEntry?.inferredRename && statusEntry.oldPath) return buildInferredRenameDiff(root, statusEntry.oldPath, normalized);
    const diffPaths = statusEntry?.oldPath ? [statusEntry.oldPath, normalized] : [normalized];
    const patch = execFileSync("git", ["diff", "HEAD", "--", ...diffPaths], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const { additions, deletions } = countPatchChanges(patch);
    return { path: normalized, oldPath: statusEntry?.oldPath || null, changed: patch.trim().length > 0, additions, deletions, patch, available: true };
  } catch {
    return { path: normalized, changed: false, additions: 0, deletions: 0, patch: "", available: false, reason: "Git diff is unavailable for this file."};
  }
}

function countPatchChanges(patch = "") {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch).split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function buildReviewBaselineRenameDiff(root, oldPath, nextPath) {
  const review = readDocReviewState(root).reviews[oldPath] || null;
  const baseline = readDocReviewBaseline(root, oldPath, review);
  const baseContent = baseline?.content || "";
  const current = readMemoryFile(root, nextPath);
  const sameContent = hashContent(baseContent) === hashContent(current.content);
  const patch = [
    `diff --git a/${oldPath} b/${nextPath}`,
    `similarity index ${sameContent ? "100" : Math.round(renameSimilarityScore(baseContent, current.content, oldPath, nextPath) * 100)}%`,
    `rename from ${oldPath}`,
    `rename to ${nextPath}`,
    "",
  ].join("\n");
  return {
    path: nextPath,
    oldPath,
    changed: true,
    additions: sameContent ? 0 : Math.max(0, current.content.split("\n").length - baseContent.split("\n").length),
    deletions: sameContent ? 0 : Math.max(0, baseContent.split("\n").length - current.content.split("\n").length),
    patch,
    available: true,
  };
}

function buildInferredRenameDiff(root, oldPath, nextPath) {
  const baseContent = readGitHeadFileContent(root, oldPath);
  const current = readMemoryFile(root, nextPath);
  const baseLines = baseContent.split("\n");
  const currentLines = current.content.split("\n");
  const sameContent = hashContent(baseContent) === hashContent(current.content);
  const patch = [
    `diff --git a/${oldPath} b/${nextPath}`,
    `similarity index ${sameContent ? "100" : Math.round(renameSimilarityScore(baseContent, current.content, oldPath, nextPath) * 100) + ""}%`,
    `rename from ${oldPath}`,
    `rename to ${nextPath}`,
    "",
  ].join("\n");
  return {
    path: nextPath,
    oldPath,
    changed: true,
    additions: sameContent ? 0 : Math.max(0, currentLines.length - baseLines.length),
    deletions: sameContent ? 0 : Math.max(0, baseLines.length - currentLines.length),
    patch,
    available: true,
  };
}

export function readReviewBaseFile(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) throw new Error("Path is required");
  const startupFile = readStartupContextReviewFile(root, normalized);
  if (startupFile) return readInternalReviewBaseFile(root, startupFile);
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
  const internalBase = readInternalReviewBaseFile(root, { path: normalized, content: current.content, exists: current.exists, contentHash: current.contentHash });
  if (internalBase.baseline === "review") return internalBase;
  return readGitReviewBaseFile(root, normalized, current);
}

function readInternalReviewBaseFile(root, file) {
  const normalized = normalizeRelPath(file.path);
  const review = readDocReviewState(root).reviews[normalized] || null;
  const reviewBaseline = readDocReviewBaseline(root, normalized, review);
  if (reviewBaseline) {
    const baselineHash = hashContent(reviewBaseline.content);
    const currentHash = file.contentHash || hashContent(file.content || "");
    const changeKind = baselineHash === currentHash ? "unchanged" : file.exists ? "modified" : "deleted";
    return {
      path: normalized,
      baseContent: reviewBaseline.content,
      currentContent: file.content,
      currentHash,
      changeKind,
      available: true,
      baseline: "review",
      baselineHash,
    };
  }
  return {
    path: normalized,
    baseContent: file.content,
    currentContent: file.content,
    currentHash: file.contentHash || hashContent(file.content || ""),
    changeKind: "unchanged",
    available: true,
  };
}

function readGitReviewBaseFile(root, normalized, current) {
  try {
    const statusLine = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", normalized], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").find(Boolean) || "";
    const gitEntry = readReviewGitStatusEntry(root, normalized) || (statusLine ? gitStatusEntryFromPorcelainLine(statusLine, gitRepoPrefixForRoot(root)) : null);
    if (gitEntry?.baselineRename && gitEntry.oldPath) {
      const review = readDocReviewState(root).reviews[gitEntry.oldPath] || null;
      const baseline = readDocReviewBaseline(root, gitEntry.oldPath, review);
      const baseContent = baseline?.content || "";
      return { path: normalized, oldPath: gitEntry.oldPath, baseContent, currentContent: current.content, currentHash: current.contentHash, changeKind: "renamed", available: true, baseline: "review", baselineHash: baseline?.contentHash || hashContent(baseContent) };
    }
    if (!statusLine) {
      return { path: normalized, baseContent: current.content, currentContent: current.content, currentHash: current.contentHash, changeKind: "unchanged", available: true };
    }
    if (statusLine.startsWith("?? ") && !gitEntry?.oldPath) {
      return { path: normalized, baseContent: "", currentContent: current.content, currentHash: current.contentHash, changeKind: "added", available: true };
    }
    const treePath = gitTreePathForRootRelative(root, gitEntry?.oldPath || normalized);
    let baseContent = "";
    let trackedInHead = true;
    try {
      baseContent = execFileSync("git", ["show", "HEAD:" + treePath], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_FILE_BYTES + 64_000 });
    } catch {
      trackedInHead = false;
    }
    const statusCode = gitEntry?.status || statusLine.slice(0, 2);
    const changeKind = statusCode.includes("R") && gitEntry?.oldPath
      ? "renamed"
      : !trackedInHead ? "added" : statusCode.includes("D") && !current.exists ? "deleted" : "modified";
    return { path: normalized, oldPath: gitEntry?.oldPath || null, baseContent, currentContent: current.content, currentHash: current.contentHash, changeKind, available: true };
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

function readReviewGitStatusEntry(root, normalized) {
  if (!gitTopLevelRoot(root)) return null;
  const gitEntries = readGitStatusEntries(root);
  const direct = gitEntries.get(normalized) || null;
  if (direct?.oldPath) return direct;
  if (direct && direct.status !== "??" && !direct.status.includes("A")) return direct;
  if (!direct) return null;
  const settings = readMemoryWebappSettings(root);
  const files = listMemoryFiles(root);
  const reviewState = readDocReviewState(root);
  const gitRename = inferGitRenames(root, gitEntries, files, settings).inferredRenames.get(normalized) || null;
  if (gitRename) return gitRename;
  return inferReviewBaselineRenames(root, reviewState, gitEntries, files, settings).inferredRenames.get(normalized) || direct;
}

function readStartupContextReviewFile(root, relPath, settings = readMemoryWebappSettings(root)) {
  const normalized = normalizeRelPath(relPath);
  if (!normalized) return null;
  for (const file of listStartupContextFiles(root, settings)) {
    if (!isExternalStartupContextReviewFile(root, file)) continue;
    const key = normalizeRelPath(file.startupContext.displayPath || file.startupContext.explorerPath || "");
    const explorerPath = normalizeRelPath(file.startupContext.explorerPath || "");
    if (normalized !== key && normalized !== explorerPath) continue;
    const abs = path.resolve(file.startupContext.absolutePath);
    if (!fs.existsSync(abs)) {
      return { path: key, content: "", exists: false, updatedAt: null, chars: 0, contentHash: hashContent(""), startupContext: publicStartupContextFile(file).startupContext };
    }
    const stats = fs.statSync(abs);
    if (!stats.isFile()) throw new Error(`Not a file: ${key}`);
    if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${key}`);
    const content = fs.readFileSync(abs, "utf8");
    return {
      path: key,
      content,
      exists: true,
      updatedAt: stats.mtime.toISOString(),
      chars: content.length,
      contentHash: hashContent(content),
      startupContext: publicStartupContextFile(file).startupContext,
      label: file.label,
      summary: file.impact,
    };
  }
  return null;
}

function isExternalStartupContextReviewFile(root, file) {
  const abs = path.resolve(file?.startupContext?.absolutePath || "");
  const resolvedRoot = path.resolve(root);
  return abs && abs !== resolvedRoot && !abs.startsWith(`${resolvedRoot}${path.sep}`);
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

export function readGlobalReviewLedger(root = process.cwd()) {
  const ledgerPath = globalReviewLedgerPath(root);
  if (!fs.existsSync(ledgerPath)) return { version: 1, reviews: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    return { version: 1, reviews: parsed.reviews && typeof parsed.reviews === "object" ? parsed.reviews : {} };
  } catch {
    return { version: 1, reviews: {} };
  }
}

function writeGlobalReviewLedger(root, ledger) {
  const ledgerPath = globalReviewLedgerPath(root);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
}

function globalReviewLedgerPath(root = process.cwd()) {
  return path.join(globalReviewLedgerRoot(root), DOCQA_GLOBAL_REVIEW_LEDGER);
}

function globalReviewLedgerRoot(root = process.cwd()) {
  return gitTopLevelRoot(root) || path.resolve(root);
}

function globalReviewKeyFor(root, relPath) {
  return hashContent(canonicalReviewAbsolutePath(root, relPath));
}

function canonicalReviewAbsolutePath(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  const abs = resolveExternalPath(normalized) || path.resolve(root, normalized);
  try {
    return fs.existsSync(abs) ? fs.realpathSync(abs) : path.resolve(abs);
  } catch {
    return path.resolve(abs);
  }
}

function resourceStateForReviewFile(file) {
  return file?.exists === false ? "absent" : "present";
}

function resourceVersionForReviewFile(root, relPath, file, review = null) {
  if (resourceStateForReviewFile(file) === "present") return null;
  try {
    const revision = execFileSync("git", ["log", "-1", "--format=%H", "--", normalizeRelPath(relPath)], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (revision) return `git-path:${revision}`;
  } catch {}
  const baseline = readDocReviewBaseline(root, relPath, review);
  if (baseline?.contentHash) return `baseline:${baseline.contentHash}`;
  return `absent-path:${hashContent(canonicalReviewAbsolutePath(root, relPath))}`;
}

function reviewResourceIdentityMatches(review, resourceState, resourceVersion = null) {
  if (!review) return false;
  const stateMatches = review.resourceState === "present" || review.resourceState === "absent"
    ? review.resourceState === resourceState
    : resourceState === "present";
  if (!stateMatches) return false;
  if (resourceState === "absent") return Boolean(resourceVersion) && review.resourceVersion === resourceVersion;
  return true;
}

function absentReviewDecisionIsCurrent(review, resourceVersion) {
  if (!review || review.status !== "verified" || !reviewResourceIdentityMatches(review, "absent", resourceVersion)) return false;
  const emptyContentHash = hashContent("");
  return review.contentHash === emptyContentHash || review.reviewHash === emptyContentHash;
}

function applyGlobalReviewDecision(ledger, root, relPath, file, decision) {
  const key = globalReviewKeyFor(root, relPath);
  const contentHash = hashContent(file?.content || "");
  const reviewHash = reviewContentHash(file?.content || "");
  const resourceState = resourceStateForReviewFile(file);
  const resourceVersion = decision.resourceVersion ?? resourceVersionForReviewFile(root, relPath, file);
  const existing = ledger.reviews[key];
  if (decision.status !== "verified") {
    if (reviewResourceIdentityMatches(existing, resourceState, resourceVersion) && (existing?.contentHash === contentHash || existing?.reviewHash === reviewHash)) {
      delete ledger.reviews[key];
      return { entry: null, changed: true };
    }
    return { entry: null, changed: false };
  }
  if (existing?.status === "verified" && reviewResourceIdentityMatches(existing, resourceState, resourceVersion) && (existing.contentHash === contentHash || existing.reviewHash === reviewHash)) {
    const current = { ...existing, contentHash, reviewHash, resourceState, resourceVersion };
    if (existing.contentHash !== contentHash || existing.reviewHash !== reviewHash || existing.resourceState !== resourceState || existing.resourceVersion !== resourceVersion) {
      ledger.reviews[key] = current;
      return { entry: current, changed: true };
    }
    return { entry: current, changed: false };
  }
  const reviewedAt = decision.reviewedAt || new Date().toISOString();
  const entry = {
    status: "verified",
    reviewedAt,
    contentHash,
    reviewHash,
    resourceState,
    resourceVersion,
    absolutePath: canonicalReviewAbsolutePath(root, relPath),
    relPath: normalizeRelPath(relPath),
    root: path.resolve(root),
    note: String(decision.note || "").slice(0, 500),
  };
  ledger.reviews[key] = entry;
  return { entry, changed: true };
}

function writeGlobalReviewDecision(root, relPath, file, decision) {
  const ledger = readGlobalReviewLedger(root);
  const result = applyGlobalReviewDecision(ledger, root, relPath, file, decision);
  if (result.changed) writeGlobalReviewLedger(root, ledger);
  return result.entry;
}

function currentGlobalReviewFor(root, relPath, content, resourceState = "present", resourceVersion = null, providedLedger = null) {
  const ledger = providedLedger || readGlobalReviewLedger(root);
  const entry = ledger.reviews[globalReviewKeyFor(root, relPath)];
  const contentHash = hashContent(content);
  const reviewHash = reviewContentHash(content);
  if (!entry || entry.status !== "verified" || !reviewResourceIdentityMatches(entry, resourceState, resourceVersion) || (entry.contentHash !== contentHash && entry.reviewHash !== reviewHash)) return null;
  return {
    ...entry,
    resourceState,
    resourceVersion,
    status: "verified",
    current: true,
    global: true,
  };
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
    baselineReviewHash: reviewContentHash(content),
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
  return { path: baselinePath, content, contentHash: baselineHash, reviewHash: reviewContentHash(content) };
}

export function writeDocReviewBaseline(root, relPath, { note = "" } = {}) {
  const file = readReviewTrackedFile(root, relPath);
  const normalized = file.path;
  const resourceState = resourceStateForReviewFile(file);
  const state = readDocReviewState(root);
  const existing = state.reviews[normalized] && typeof state.reviews[normalized] === "object" ? state.reviews[normalized] : {};
  const resourceVersion = resourceVersionForReviewFile(root, normalized, file, existing);
  const baseline = writeDocReviewBaselineFile(root, normalized, file.content);
  const next = {
    ...existing,
    baselinePath: baseline.baselinePath,
    baselineHash: baseline.baselineHash,
    baselineReviewHash: baseline.baselineReviewHash,
    baselineAt: baseline.baselineAt,
    resourceState,
    resourceVersion,
  };
  if (note) next.note = String(note || "").slice(0, 500);
  state.reviews[normalized] = next;
  writeDocReviewState(root, state);
  return { path: normalized, ...next };
}

export function writeDocReviewDecision(root, relPath, { status, note = "", expectedResourceState = null, expectedResourceVersion = null } = {}) {
  const file = readReviewTrackedFile(root, relPath);
  const normalized = file.path;
  const resourceState = resourceStateForReviewFile(file);
  const state = readDocReviewState(root);
  const existing = state.reviews[normalized] && typeof state.reviews[normalized] === "object" ? state.reviews[normalized] : null;
  const resourceVersion = resourceVersionForReviewFile(root, normalized, file, existing);
  if (expectedResourceState && resourceState !== expectedResourceState) throw new Error(`Review target changed before the decision was saved: ${normalized}`);
  if (expectedResourceVersion && resourceVersion !== expectedResourceVersion) throw new Error(`Review target version changed before the decision was saved: ${normalized}`);
  const allowedStatuses = new Set(["verified", "needs_changes", "snoozed"]);
  if (status === "unverified") {
    delete state.reviews[normalized];
    writeDocReviewState(root, state);
    writeGlobalReviewDecision(root, normalized, file, { status: "unverified" });
    return { path: normalized, status: "unverified", note: "", reviewedAt: new Date().toISOString(), contentHash: hashContent(file.content), reviewHash: reviewContentHash(file.content), resourceState, resourceVersion };
  }
  if (!allowedStatuses.has(status)) throw new Error(`Invalid review status: ${status}`);
  const baseline = writeDocReviewBaselineFile(root, normalized, file.content);
  const decision = {
    status,
    note: String(note || "").slice(0, 500),
    reviewedAt: new Date().toISOString(),
    contentHash: hashContent(file.content),
    reviewHash: reviewContentHash(file.content),
    resourceState,
    resourceVersion,
    baselinePath: baseline.baselinePath,
    baselineHash: baseline.baselineHash,
    baselineReviewHash: baseline.baselineReviewHash,
    baselineAt: baseline.baselineAt,
  };
  state.reviews[normalized] = decision;
  writeDocReviewState(root, state);
  writeGlobalReviewDecision(root, normalized, file, decision);
  return { path: normalized, ...decision };
}

function readReviewTrackedFile(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  const startupFile = readStartupContextReviewFile(root, normalized);
  if (startupFile) return startupFile;
  return readMemoryFile(root, normalized);
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
      oldPath: item.oldPath || null,
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

function currentReviewFor(root, reviews, relPath, content, resourceState = "present", resourceVersion = null, globalReviewLedger = null) {
  const review = reviews[relPath] || null;
  const contentHash = hashContent(content);
  const reviewHash = reviewContentHash(content);
  if (review) {
    const baseline = readDocReviewBaseline(root, relPath, review);
    const baselineReviewHash = review.baselineReviewHash || baseline?.reviewHash || null;
    const semanticCurrent = review.reviewHash === reviewHash || baselineReviewHash === reviewHash;
    const resourceCurrent = reviewResourceIdentityMatches(review, resourceState, resourceVersion);
    const explicitCurrent = resourceCurrent && (review.contentHash === contentHash || semanticCurrent);
    const inlineBaselineCurrent = resourceCurrent && !review.status && review.note === "inline review applied" && (review.baselineHash === contentHash || baselineReviewHash === reviewHash);
    let local = {
      ...review,
      resourceState,
      resourceVersion,
      status: review.status || (inlineBaselineCurrent ? "verified" : undefined),
      current: explicitCurrent || inlineBaselineCurrent,
    };
    if (local.current && local.status !== "verified") return local;
    if (local.current && local.status === "verified") {
      if (review.status === "verified" && (review.contentHash !== contentHash || review.reviewHash !== reviewHash || review.baselineReviewHash !== baselineReviewHash || review.resourceState !== resourceState || review.resourceVersion !== resourceVersion)) {
        local = { ...local, contentHash, reviewHash, baselineReviewHash, resourceState, resourceVersion };
        reviews[relPath] = { ...review, contentHash, reviewHash, baselineReviewHash, resourceState, resourceVersion };
        try { writeDocReviewState(root, { version: 1, reviews }); } catch {}
      }
      try { writeGlobalReviewDecision(root, relPath, { content, exists: resourceState === "present" }, local); } catch {}
      return local;
    }
  }
  return currentGlobalReviewFor(root, relPath, content, resourceState, resourceVersion, globalReviewLedger);
}

function hashContent(content) {
  return createHash("sha256").update(String(content), "utf8").digest("hex");
}

function reviewIdentityContent(content) {
  const normalized = String(content || "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return normalized;
  const frontmatterEnd = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (frontmatterEnd < 0) return normalized;
  const endIndex = frontmatterEnd + 1;
  let contextIndent = null;
  const kept = lines.filter((line, index) => {
    if (index < 1 || index >= endIndex) return true;
    const match = line.match(/^(\s*)([^#\s][^:]*)\s*:/);
    if (match && match[2].trim() === "context_room") {
      contextIndent = match[1].length;
      return true;
    }
    if (contextIndent == null) return true;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    if (line.trim() && indent <= contextIndent) {
      contextIndent = null;
      return true;
    }
    return !/^\s+last_verified\s*:/.test(line);
  });
  return kept.join("\n");
}

function reviewContentHash(content) {
  return hashContent(reviewIdentityContent(content));
}

function meaningfulGitStatusForReview(root, relPath, gitEntry, content, reviews = {}, gitHeadContents = null, resourceState = "present") {
  const status = gitEntry?.status || "";
  if (!status.trim()) return "";
  if (gitEntry?.oldPath || gitEntry?.inferredRename || gitEntry?.baselineRename || !/^[ M]{2}$/.test(status) || !status.includes("M")) return status;
  try {
    const review = reviews[relPath] || null;
    const baseline = readDocReviewBaseline(root, relPath, review);
    if (baseline && !reviewResourceIdentityMatches(review, resourceState, resourceState === "absent" ? resourceVersionForReviewFile(root, relPath, { exists: false }, review) : null)) return status;
    const baseContent = baseline?.content ?? (gitHeadContents instanceof Map ? gitHeadContents.get(relPath) || "" : readGitHeadFileContent(root, relPath));
    if (reviewContentHash(baseContent) === reviewContentHash(content)) return "";
  } catch {}
  return status;
}

function normalizeHealthIssueForKey(issue = {}) {
  return {
    severity: shortString(issue.severity, 40),
    type: shortString(issue.type, 120),
    path: nullablePath(issue.path) || "",
    message: shortString(issue.message, 1000),
  };
}

export function healthIssueKey(issue = {}) {
  const normalized = normalizeHealthIssueForKey(issue);
  return hashContent([normalized.severity, normalized.type, normalized.path, normalized.message].join("\n")).slice(0, 24);
}

function healthAcknowledgementsPath(root = process.cwd()) {
  return path.join(root, CONTEXT_HEALTH_ACKNOWLEDGEMENTS);
}

export function readContextHealthAcknowledgements(root = process.cwd()) {
  const state = readJsonFile(healthAcknowledgementsPath(root), { version: 1, issues: {} });
  const issues = state && typeof state.issues === "object" && !Array.isArray(state.issues) ? state.issues : {};
  return { version: 1, updatedAt: state?.updatedAt || null, issues };
}

function writeContextHealthAcknowledgements(root = process.cwd(), state = {}) {
  const clean = { version: 1, updatedAt: new Date().toISOString(), issues: {} };
  for (const [key, value] of Object.entries(state.issues || {})) {
    const cleanKey = shortString(key, 128);
    if (!cleanKey) continue;
    clean.issues[cleanKey] = {
      acknowledgedAt: value?.acknowledgedAt || new Date().toISOString(),
      note: shortString(value?.note, 500),
      issue: normalizeHealthIssueForKey(value?.issue || {}),
    };
  }
  const statePath = healthAcknowledgementsPath(root);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(clean, null, 2) + "\n", "utf8");
  return clean;
}

function publicHealthIssue(issue, acknowledgements = readContextHealthAcknowledgements()) {
  const normalized = normalizeHealthIssueForKey(issue);
  const key = healthIssueKey(normalized);
  const acknowledgement = acknowledgements.issues?.[key] || null;
  return {
    ...issue,
    ...normalized,
    key,
    acknowledged: Boolean(acknowledgement),
    acknowledgedAt: acknowledgement?.acknowledgedAt || null,
    acknowledgementNote: acknowledgement?.note || "",
  };
}

export function acknowledgeContextHealthIssue(root = process.cwd(), { key = "", note = "" } = {}) {
  const cleanKey = shortString(key, 128);
  if (!cleanKey) throw new Error("Health issue key is required.");
  const currentIssues = buildDocumentationGraph(root).healthIssues.map((issue) => publicHealthIssue(issue, { version: 1, issues: {} }));
  const issue = currentIssues.find((item) => item.key === cleanKey);
  if (!issue) throw new Error("Health issue no longer exists.");
  const acknowledgements = readContextHealthAcknowledgements(root);
  acknowledgements.issues[cleanKey] = {
    acknowledgedAt: new Date().toISOString(),
    note: shortString(note, 500),
    issue: normalizeHealthIssueForKey(issue),
  };
  const saved = writeContextHealthAcknowledgements(root, acknowledgements);
  return { issue: publicHealthIssue(issue, saved), acknowledgements: saved };
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
  if (fs.existsSync(docRelative)) return docRelative;
  const rootAbs = path.resolve(root);
  let current = path.dirname(normalizeRelPath(docPath));
  while (current && current !== ".") {
    const ancestorRelative = path.resolve(rootAbs, current, normalized);
    if (ancestorRelative.startsWith(`${rootAbs}${path.sep}`) && fs.existsSync(ancestorRelative)) return ancestorRelative;
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
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

export function buildDocumentationGraph(root = process.cwd(), options = {}) {
  const settings = options.settings || readMemoryWebappSettings(root);
  const files = options.files || listMemoryFiles(root);
  const gitStatuses = options.gitStatuses || readGitStatuses(root);
  const startupFiles = options.startupFiles || listStartupContextFiles(root, settings);
  const startupHooks = options.startupHooks || listStartupHookFiles(root, settings);
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

  const configIssues = buildConfigDiagnostics(root, settings, files, startupFiles, hubInfo, startupHooks);
  healthIssues.push(...configIssues);
  return {
    generatedAt: new Date().toISOString(),
    root,
    summary: {
      docs: nodes.length,
      watched: nodes.filter((node) => node.watched).length,
      inHub: nodes.filter((node) => node.inHub).length,
      startup: nodes.filter((node) => node.startup).length,
      startupHooks: startupHooks.length,
      missingMetadata: nodes.filter((node) => !node.metadata.present).length,
      stale: healthIssues.filter((issue) => issue.type === "stale_last_verified").length,
      highOrCritical: healthIssues.filter((issue) => ["critical", "high"].includes(issue.severity)).length,
    },
    nodes,
    edges,
    healthIssues: sortHealthIssues(healthIssues).slice(0, 200),
    startupContext: startupFiles.map(publicStartupContextFile),
    startupHooks: startupHooks.map(publicStartupHookFile),
  };
}

function graphIssuesForDocument({ root, file, content, metadata, watched, inHub, startup, references }) {
  const issues = [];
  if (metadata.parseError) issues.push({ type: "metadata_parse_error", severity: "high", message: `Cannot parse context_room metadata: ${metadata.parseError}.` });
  if (metadata.present && ["canonical", "procedure", "agents"].includes(metadata.kind) && metadata.status === "current" && !metadata.last_verified) {
    issues.push({ type: "missing_last_verified", severity: watched ? "medium" : "low", message: "Current high-impact doc has no last_verified date." });
  }
  if (metadata.present && metadata.last_verified && Date.parse(metadata.last_verified) < Date.now() - 1000 * 60 * 60 * 24 * 120) {
    issues.push({ type: "stale_last_verified", severity: watched ? "medium" : "low", message: `last_verified is older than 120 days: ${metadata.last_verified}.` });
  }
  if (metadata.present && metadata.kind === "canonical" && metadata.status === "current" && !metadata.canonical_for) {
    issues.push({ type: "missing_canonical_for", severity: "medium", message: "Current canonical doc should declare canonical_for." });
  }
  if (metadata.present && ["canonical", "procedure"].includes(metadata.kind) && metadata.status === "current" && metadata.sources.length === 0) {
    issues.push({ type: "missing_sources", severity: "low", message: "Current doc has no source files or links." });
  }
  for (const source of metadata.sources) {
    if (!sourceReferenceExists(root, file.path, source)) issues.push({ type: "broken_source", severity: "high", message: `Declared source does not exist: ${source}.` });
  }
  if (metadata.present) for (const reference of references) {
    if (!sourceReferenceExists(root, file.path, reference)) issues.push({ type: "broken_reference", severity: "medium", message: `Referenced file does not exist: ${reference}.` });
  }
  if (metadata.present && !content.trim()) issues.push({ type: "empty_doc", severity: watched ? "medium" : "low", message: "Document is empty." });
  return issues;
}

export function buildConfigDiagnostics(root = process.cwd(), settings = readMemoryWebappSettings(root), files = listMemoryFiles(root), startupFiles = listStartupContextFiles(root, settings), hubInfo = collectHubPathMatchers(settings.hubSections || []), startupHooks = listStartupHookFiles(root, settings)) {
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
  for (const hookFile of startupHooks) {
    const hook = hookFile.startupHook || {};
    const rel = hook.absolutePath ? path.relative(path.resolve(root), path.resolve(hook.absolutePath)).replaceAll(path.sep, "/") : "";
    if (!rel || rel.startsWith("../") || path.isAbsolute(rel)) {
      issues.push({ type: "external_startup_hook", severity: "low", message: `External startup hook affects agents: ${hook.displayPath}.` });
    } else if (!hook.tracked) {
      issues.push({ type: "untracked_startup_hook", severity: "low", message: `Startup hook is active but not tracked by Git: ${rel}.` });
    }
    if (["git-hooks", "core-hooks-path", "husky"].includes(hook.source) && !hook.executable) {
      issues.push({ type: "startup_hook_not_executable", severity: "low", message: `Startup hook may not run because it is not executable: ${hook.displayPath}.` });
    }
  }
  return issues;
}

function sortHealthIssues(issues = []) {
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return [...issues].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9) || String(a.path || "").localeCompare(String(b.path || ""), "fr") || String(a.type || "").localeCompare(String(b.type || ""), "fr"));
}

export function buildContextRoomDoctorReport(root = process.cwd(), options = {}) {
  const settings = options.settings || readMemoryWebappSettings(root);
  const graph = options.graph || buildDocumentationGraph(root, { settings });
  const docqa = options.docqa || buildDocQaReport(root, { settings });
  const acknowledgements = readContextHealthAcknowledgements(root);
  const issues = graph.healthIssues.map((issue) => publicHealthIssue(issue, acknowledgements));
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
      startupHooks: settings.startupHooks,
    },
    docqa: docqa.summary,
    graph: graph.summary,
    issues,
    acknowledgedIssues: issues.filter((issue) => issue.acknowledged).length,
  };
}

function readDocQaSnapshot(root) {
  const settings = readMemoryWebappSettings(root);
  const files = listMemoryFiles(root);
  const gitEntries = readGitStatusEntries(root);
  const gitHeadContents = readGitHeadFileContents(root, [...gitEntries.values()].flatMap((entry) => [entry.path, entry.oldPath]).filter(Boolean));
  const reviewState = readDocReviewState(root);
  const startupFiles = listStartupContextFiles(root, settings);
  return { settings, files, gitEntries, gitHeadContents, reviewState, startupFiles };
}

function buildDocQaReportFromSnapshot(root, snapshot = readDocQaSnapshot(root)) {
  const { settings, files, gitEntries, gitHeadContents, reviewState, startupFiles } = snapshot;
  return buildDocQaReport(root, { settings, files, gitStatuses: gitEntries, gitHeadContents, reviewState, startupFiles });
}

export function buildContextRoomReports(root = process.cwd()) {
  const snapshot = readDocQaSnapshot(root);
  const { settings, files, gitEntries, startupFiles } = snapshot;
  const gitStatuses = new Map([...gitEntries.entries()].map(([rel, entry]) => [rel, entry.status]));
  const startupHooks = listStartupHookFiles(root, settings);
  const startupSkills = listStartupSkillFolders(root, settings);
  const docqa = buildDocQaReportFromSnapshot(root, snapshot);
  const graph = buildDocumentationGraph(root, { settings, files, gitStatuses, startupFiles, startupHooks });
  const doctor = buildContextRoomDoctorReport(root, { settings, graph, docqa });
  return {
    generatedAt: new Date().toISOString(),
    docqa,
    doctor,
    startupContext: startupFiles.map(publicStartupContextFile),
    startupSkills,
    startupHooks: startupHooks.map(publicStartupHookFile),
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
  const todoCount = (text.match(/\b(TODO|FIXME|HACK|à clarifier|a verifier|à vérifier)\b|\[QUESTION\]|<!--\s*QUESTION\b/gi) || []).length;
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

function invalidateAbsentReviewsForPresentFiles(root, reviewState, files) {
  const presentPaths = new Set(files.filter((file) => file.exists !== false).map((file) => file.path));
  let localChanged = false;
  for (const [relPath, review] of Object.entries(reviewState.reviews || {})) {
    if (review?.resourceState !== "absent" || !presentPaths.has(relPath)) continue;
    delete reviewState.reviews[relPath];
    localChanged = true;
  }
  if (localChanged) writeDocReviewState(root, reviewState);
  const ledger = readGlobalReviewLedger(root);
  let ledgerChanged = false;
  for (const [key, review] of Object.entries(ledger.reviews || {})) {
    if (review?.resourceState !== "absent" || !review.absolutePath || !fs.existsSync(review.absolutePath)) continue;
    delete ledger.reviews[key];
    ledgerChanged = true;
  }
  if (ledgerChanged) writeGlobalReviewLedger(root, ledger);
}

export function buildDocQaReport(root = process.cwd(), options = {}) {
  const gitStatuses = options.gitStatuses || readGitStatusEntries(root);
  const gitHeadContents = options.gitHeadContents || null;
  const reviewState = options.reviewState || readDocReviewState(root);
  const settings = options.settings || readMemoryWebappSettings(root);
  const files = options.files || listMemoryFiles(root);
  invalidateAbsentReviewsForPresentFiles(root, reviewState, files);
  const startupFiles = options.startupFiles || listStartupContextFiles(root, settings);
  const { inferredRenames, renamedDeletedPaths } = inferGitRenames(root, gitStatuses, files, settings, gitHeadContents);
  const { inferredRenames: inferredBaselineRenames, renamedDeletedPaths: baselineRenamedDeletedPaths } = inferReviewBaselineRenames(root, reviewState, gitStatuses, files, settings);
  const allRenamedDeletedPaths = new Set([...renamedDeletedPaths, ...baselineRenamedDeletedPaths]);
  const gitQueue = files.map((file) => {
    const classification = classifyDocPath(file.path);
    const gitEntry = inferredRenames.get(file.path) || inferredBaselineRenames.get(file.path) || gitStatuses.get(file.path) || null;
    const rawGitStatus = gitEntry?.status || "";
    const reviewRequired = isRequiredReviewPath(file.path, settings);
    if (!rawGitStatus.trim() && !reviewRequired) return null;
    const abs = resolveExternalPath(file.path) || path.join(root, file.path);
    const content = file.exists && fs.existsSync(abs) && file.bytes <= MAX_FILE_BYTES ? fs.readFileSync(abs, "utf8") : "";
    const gitStatus = meaningfulGitStatusForReview(root, file.path, gitEntry, content, reviewState.reviews, gitHeadContents, file.exists === false ? "absent" : "present");
    const resourceState = file.exists === false ? "absent" : "present";
    const resourceVersion = resourceVersionForReviewFile(root, file.path, file, reviewState.reviews[file.path] || null);
    const review = currentReviewFor(root, reviewState.reviews, file.path, content, resourceState, resourceVersion);
    if (!gitStatus.trim() && !reviewRequired) return null;
    const metadata = parseDocMetadata(content, file.path);
    const issues = computeDocIssues({ path: file.path, content, gitStatus, metadata });
    const riskScore = riskScoreFor({ classification, issues, gitStatus });
    return { path: file.path, oldPath: gitEntry?.oldPath || null, inferredRename: Boolean(gitEntry?.inferredRename), label: file.label, summary: file.summary, updatedAt: file.updatedAt, classification, metadata, gitStatus, reviewRequired, issues, riskScore, review, resourceState };
  }).filter(Boolean
  ).filter((item) => item.gitStatus.trim() || item.reviewRequired
  ).filter((item) => isWatchedPath(item.path, settings) || item.reviewRequired
  ).filter((item) => !(item.review?.status === "verified" && item.review.current));
  const deletedPage = buildDeletedReviewPage(root, {
    gitStatuses,
    gitHeadContents,
    settings,
    reviewState,
    files,
    renamedDeletedPaths: allRenamedDeletedPaths,
  });
  const deletedQueue = deletedPage.items;
  const unmergedDeletedQueue = buildPendingDeletedReviewItems(root, {
    gitStatuses,
    gitHeadContents,
    settings,
    reviewState,
    files,
    renamedDeletedPaths: new Set(),
    unmergedOnly: true,
    ignoreReviewTrust: true,
    limit: 80,
  }).map((item) => ({
    ...item,
    summary: "Unmerged deletion conflict.",
    batchDeletion: false,
    protected: true,
    riskScore: item.riskScore + 90,
    issues: [{ type: "git_conflict", severity: "critical", message: "Unmerged Git deletion conflict requires individual review." }, ...item.issues],
  }));
  const queue = [...gitQueue, ...deletedQueue, ...unmergedDeletedQueue, ...buildStartupContextReviewQueue(root, settings, reviewState, startupFiles)]
  .sort((a, b) => compareReviewQueueItems(a, b, settings));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalDocs: files.length,
      changedDocs: queue.filter((item) => item.gitStatus.trim()).length,
      needsReview: queue.length,
      requiredReview: queue.filter((item) => item.reviewRequired && !item.gitStatus.trim()).length,
      deletedDocs: deletedQueue.length + (deletedPage.truncated ? 1 : 0),
      protectedDeletedDocs: deletedQueue.filter((item) => item.protected).length,
      deletedReviewKey: deletedReviewBatchKey(deletedQueue),
      critical: queue.filter((item) => item.issues.some((issue) => issue.severity === "critical")).length,
      high: queue.filter((item) => item.issues.some((issue) => issue.severity === "high")).length,
      prompts: files.filter((file) => classifyDocPath(file.path).type === "prompt").length,
      canonical: queue.filter((item) => item.metadata.kind === "canonical").length,
    },
    queue: queue.slice(0, 80),
  };
}

function inferGitRenames(root, gitStatuses, files, settings, gitHeadContents = null) {
  const inferredRenames = new Map();
  const renamedDeletedPaths = new Set();
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const deleted = [...gitStatuses.values()].filter((entry) => entry.status.includes("D") && !entry.status.includes("R") && !isUnmergedGitStatus(entry.status) && isWatchedPath(entry.path, settings));
  const added = [...gitStatuses.values()].filter((entry) => (entry.status === "??" || entry.status.includes("A")) && filesByPath.has(entry.path) && isWatchedPath(entry.path, settings));
  if (!deleted.length || !added.length) return { inferredRenames, renamedDeletedPaths };
  const deletedByExtension = new Map();
  const exactDeleted = new Map();
  const addedCountByExtension = new Map();
  const deletedCountByExtension = new Map();
  for (const entry of added) {
    const extension = path.extname(entry.path).toLowerCase();
    addedCountByExtension.set(extension, (addedCountByExtension.get(extension) || 0) + 1);
  }
  for (const entry of deleted) {
    const extension = path.extname(entry.path).toLowerCase();
    deletedCountByExtension.set(extension, (deletedCountByExtension.get(extension) || 0) + 1);
  }
  const fuzzyAllowedByExtension = new Map([...deletedCountByExtension].map(([extension, count]) => [
    extension,
    count * (addedCountByExtension.get(extension) || 0) <= MAX_RENAME_SIMILARITY_COMPARISONS,
  ]));
  let signatureBytesRemaining = MAX_RENAME_SIMILARITY_SIGNATURE_BYTES;
  let tokenChecksRemaining = MAX_RENAME_SIMILARITY_TOKEN_CHECKS;
  for (const entry of deleted) {
    const content = gitHeadContents instanceof Map
      ? gitHeadContents.get(entry.path) || ""
      : readGitHeadFileContent(root, entry.path);
    if (!content) continue;
    const extension = path.extname(entry.path).toLowerCase();
    if (!deletedByExtension.has(extension)) deletedByExtension.set(extension, []);
    const includeWords = fuzzyAllowedByExtension.get(extension) === true && content.length <= signatureBytesRemaining;
    if (includeWords) signatureBytesRemaining -= content.length;
    const candidate = { entry, signature: renameSimilaritySignature(content, { includeWords }) };
    deletedByExtension.get(extension).push(candidate);
    appendExactRenameCandidate(exactDeleted, extension, candidate.signature.hash, candidate);
  }
  for (const entry of added) {
    const file = filesByPath.get(entry.path);
    if (!file?.exists || file.bytes > MAX_FILE_BYTES) continue;
    const currentAbs = path.join(root, file.path);
    if (!fs.existsSync(currentAbs) || !fs.statSync(currentAbs).isFile()) continue;
    const currentContent = fs.readFileSync(currentAbs, "utf8");
    const extension = path.extname(entry.path).toLowerCase();
    const includeWords = fuzzyAllowedByExtension.get(extension) === true && currentContent.length <= signatureBytesRemaining;
    if (includeWords) signatureBytesRemaining -= currentContent.length;
    const currentSignature = renameSimilaritySignature(currentContent, { includeWords });
    const deletedCandidates = deletedByExtension.get(extension) || [];
    let best = null;
    const exactCandidate = nextExactRenameCandidate(exactDeleted, extension, currentSignature.hash, renamedDeletedPaths, (candidate) => candidate.entry.path);
    if (exactCandidate) {
      best = { entry: exactCandidate.entry, score: 1 };
    } else if (fuzzyAllowedByExtension.get(extension) === true && currentSignature.words) {
      for (const candidate of deletedCandidates) {
        if (renamedDeletedPaths.has(candidate.entry.path)) continue;
        if (!renameSimilarityLengthsCanMatch(candidate.signature, currentSignature)) continue;
        const tokenCost = renameSimilarityTokenCost(candidate.signature, currentSignature);
        if (!Number.isFinite(tokenCost) || tokenCost > tokenChecksRemaining) continue;
        tokenChecksRemaining -= tokenCost;
        const score = renameSimilarityScoreFromSignatures(candidate.signature, currentSignature, candidate.entry.path, entry.path);
        if (!best || score > best.score) best = { entry: candidate.entry, score };
      }
    }
    if (!best || best.score < 0.72) continue;
    inferredRenames.set(entry.path, { ...entry, status: "R ", oldPath: best.entry.path, inferredRename: true });
    renamedDeletedPaths.add(best.entry.path);
  }
  return { inferredRenames, renamedDeletedPaths };
}

function inferReviewBaselineRenames(root, reviewState, gitStatuses, files, settings) {
  const inferredRenames = new Map();
  const usedOldPaths = new Set();
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const currentPaths = new Set(filesByPath.keys());
  const candidates = files.filter((file) => {
    if (!file.exists || file.bytes > MAX_FILE_BYTES) return false;
    if (!isWatchedPath(file.path, settings) && !isRequiredReviewPath(file.path, settings)) return false;
    const gitStatus = gitStatuses.get(file.path)?.status || "";
    return gitStatus === "??" || gitStatus.includes("A") || isRequiredReviewPath(file.path, settings);
  });
  const baselinesByExtension = new Map();
  const exactBaselines = new Map();
  const candidateCountByExtension = new Map();
  const potentialBaselineCountByExtension = new Map();
  for (const file of candidates) {
    const extension = path.extname(file.path).toLowerCase();
    candidateCountByExtension.set(extension, (candidateCountByExtension.get(extension) || 0) + 1);
  }
  for (const oldPath of Object.keys(reviewState.reviews || {})) {
    const normalizedOldPath = normalizeRelPath(oldPath);
    if (!normalizedOldPath || currentPaths.has(normalizedOldPath)) continue;
    if (!isWatchedPath(normalizedOldPath, settings) && !isRequiredReviewPath(normalizedOldPath, settings)) continue;
    const extension = path.extname(normalizedOldPath).toLowerCase();
    potentialBaselineCountByExtension.set(extension, (potentialBaselineCountByExtension.get(extension) || 0) + 1);
  }
  const fuzzyAllowedByExtension = new Map([...potentialBaselineCountByExtension].map(([extension, count]) => [
    extension,
    count * (candidateCountByExtension.get(extension) || 0) <= MAX_RENAME_SIMILARITY_COMPARISONS,
  ]));
  let signatureBytesRemaining = MAX_RENAME_SIMILARITY_SIGNATURE_BYTES;
  let tokenChecksRemaining = MAX_RENAME_SIMILARITY_TOKEN_CHECKS;
  if (candidates.length) {
    for (const [oldPath, review] of Object.entries(reviewState.reviews || {})) {
      const normalizedOldPath = normalizeRelPath(oldPath);
      if (!normalizedOldPath || currentPaths.has(normalizedOldPath)) continue;
      if (!isWatchedPath(normalizedOldPath, settings) && !isRequiredReviewPath(normalizedOldPath, settings)) continue;
      const baseline = readDocReviewBaseline(root, normalizedOldPath, review);
      if (!baseline?.content) continue;
      const extension = path.extname(normalizedOldPath).toLowerCase();
      if (!baselinesByExtension.has(extension)) baselinesByExtension.set(extension, []);
      const includeWords = fuzzyAllowedByExtension.get(extension) === true && baseline.content.length <= signatureBytesRemaining;
      if (includeWords) signatureBytesRemaining -= baseline.content.length;
      const candidate = { oldPath: normalizedOldPath, signature: renameSimilaritySignature(baseline.content, { includeWords }) };
      baselinesByExtension.get(extension).push(candidate);
      appendExactRenameCandidate(exactBaselines, extension, candidate.signature.hash, candidate);
    }
  }

  for (const file of candidates) {
    const currentAbs = resolveExternalPath(file.path) || path.join(root, file.path);
    if (!fs.existsSync(currentAbs) || !fs.statSync(currentAbs).isFile()) continue;
    const currentContent = fs.readFileSync(currentAbs, "utf8");
    const extension = path.extname(file.path).toLowerCase();
    const includeWords = fuzzyAllowedByExtension.get(extension) === true && currentContent.length <= signatureBytesRemaining;
    if (includeWords) signatureBytesRemaining -= currentContent.length;
    const currentSignature = renameSimilaritySignature(currentContent, { includeWords });
    const baselineCandidates = baselinesByExtension.get(extension) || [];
    let best = null;
    const exactCandidate = nextExactRenameCandidate(exactBaselines, extension, currentSignature.hash, usedOldPaths, (candidate) => candidate.oldPath);
    if (exactCandidate) {
      best = { oldPath: exactCandidate.oldPath, score: 1 };
    } else if (fuzzyAllowedByExtension.get(extension) === true && currentSignature.words) {
      for (const candidate of baselineCandidates) {
        if (usedOldPaths.has(candidate.oldPath)) continue;
        if (!renameSimilarityLengthsCanMatch(candidate.signature, currentSignature)) continue;
        const tokenCost = renameSimilarityTokenCost(candidate.signature, currentSignature);
        if (!Number.isFinite(tokenCost) || tokenCost > tokenChecksRemaining) continue;
        tokenChecksRemaining -= tokenCost;
        const score = renameSimilarityScoreFromSignatures(candidate.signature, currentSignature, candidate.oldPath, file.path);
        if (!best || score > best.score) best = { oldPath: candidate.oldPath, score };
      }
    }
    if (!best || best.score < 0.72) continue;
    inferredRenames.set(file.path, { path: file.path, status: "R ", oldPath: best.oldPath, inferredRename: true, baselineRename: true });
    usedOldPaths.add(best.oldPath);
  }
  return { inferredRenames, renamedDeletedPaths: usedOldPaths };
}

function renameSimilarityScore(baseContent, currentContent, oldPath, nextPath) {
  return renameSimilarityScoreFromSignatures(
    renameSimilaritySignature(baseContent),
    renameSimilaritySignature(currentContent),
    oldPath,
    nextPath,
  );
}

function appendExactRenameCandidate(index, extension, hash, candidate) {
  const key = `${extension}\0${hash}`;
  if (!index.has(key)) index.set(key, { cursor: 0, items: [] });
  index.get(key).items.push(candidate);
}

function nextExactRenameCandidate(index, extension, hash, usedPaths, pathForCandidate) {
  const queue = index.get(`${extension}\0${hash}`);
  if (!queue) return null;
  while (queue.cursor < queue.items.length && usedPaths.has(pathForCandidate(queue.items[queue.cursor]))) queue.cursor += 1;
  return queue.items[queue.cursor] || null;
}

function renameSimilaritySignature(content, { includeWords = true } = {}) {
  const text = String(content || "");
  return { hash: hashContent(text), length: text.length, words: includeWords ? wordSetForRenameSimilarity(text) : null };
}

function renameSimilarityLengthsCanMatch(base, current) {
  if (base.hash === current.hash) return true;
  const lengthRatio = Math.min(base.length, current.length) / Math.max(base.length, current.length, 1);
  return lengthRatio >= 0.6;
}

function renameSimilarityScoreFromSignatures(base, current, oldPath, nextPath) {
  if (base.hash === current.hash) return 1;
  const sameParent = path.dirname(oldPath) === path.dirname(nextPath);
  if (!base.words || !current.words || base.words.size < 3 || current.words.size < 3) return 0;
  const smallerWords = base.words.size <= current.words.size ? base.words : current.words;
  const largerWords = smallerWords === base.words ? current.words : base.words;
  let shared = 0;
  for (const word of smallerWords) if (largerWords.has(word)) shared += 1;
  const union = base.words.size + current.words.size - shared || 1;
  const lengthRatio = Math.min(base.length, current.length) / Math.max(base.length, current.length, 1);
  const score = (shared / union) * Math.min(1, lengthRatio * 1.2);
  return sameParent ? score : score * 0.82;
}

function renameSimilarityTokenCost(base, current) {
  if (!base.words || !current.words) return Number.POSITIVE_INFINITY;
  return Math.min(base.words.size, current.words.size);
}

function wordSetForRenameSimilarity(content) {
  return new Set(String(content || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9_/-]{3,}/g) || []);
}

function isUnmergedGitStatus(status = "") {
  return UNMERGED_GIT_STATUSES.has(String(status || "").trim());
}

function buildPendingDeletedReviewItems(root, options = {}) {
  const gitStatuses = options.gitStatuses || readGitStatusEntries(root);
  const settings = options.settings || readMemoryWebappSettings(root);
  const reviewState = options.reviewState || readDocReviewState(root);
  const files = options.files || listMemoryFiles(root);
  const filePaths = new Set(files.map((file) => file.path));
  const limit = Number.isFinite(options.limit) ? Math.max(0, Number(options.limit)) : null;
  const unmergedOnly = options.unmergedOnly === true;
  const deletedEntries = [...gitStatuses.values()]
    .filter((entry) => entry.status.includes("D") && !entry.status.includes("R"))
    .filter((entry) => unmergedOnly ? isUnmergedGitStatus(entry.status) : !isUnmergedGitStatus(entry.status))
    .filter((entry) => !filePaths.has(entry.path))
    .filter((entry) => isWatchedPath(entry.path, settings) || isRequiredReviewPath(entry.path, settings));
  const providedGitHeadContents = options.gitHeadContents instanceof Map ? options.gitHeadContents : null;
  const hasPossibleRenameAdditions = [...gitStatuses.values()].some((entry) => (entry.status === "??" || entry.status.includes("A")) && filePaths.has(entry.path));
  const renameGitHeadContents = providedGitHeadContents
    || (hasPossibleRenameAdditions ? readGitHeadFileContents(root, deletedEntries.map((entry) => entry.path)) : new Map());
  const renameInferenceUncertainPaths = hasPossibleRenameAdditions
    ? new Set(deletedEntries.filter((entry) => !renameGitHeadContents.has(entry.path)).map((entry) => entry.path))
    : new Set();
  let renamedDeletedPaths = options.renamedDeletedPaths;
  if (!(renamedDeletedPaths instanceof Set)) {
    const gitRenamedDeletedPaths = inferGitRenames(root, gitStatuses, files, settings, renameGitHeadContents).renamedDeletedPaths;
    const baselineRenamedDeletedPaths = inferReviewBaselineRenames(root, reviewState, gitStatuses, files, settings).renamedDeletedPaths;
    renamedDeletedPaths = new Set([...gitRenamedDeletedPaths, ...baselineRenamedDeletedPaths]);
  }
  const candidates = deletedEntries.filter((entry) => !renamedDeletedPaths.has(entry.path));
  const maxPending = limit == null ? Number.POSITIVE_INFINITY : limit;
  const globalReviewLedger = options.globalReviewLedger || readGlobalReviewLedger(root);
  const pending = [];
  for (let start = 0; start < candidates.length && pending.length < maxPending; start += DELETED_REVIEW_SCAN_CHUNK_PATHS) {
    const chunk = candidates.slice(start, start + DELETED_REVIEW_SCAN_CHUNK_PATHS);
    const chunkPaths = chunk.map((entry) => entry.path);
    const resourceVersions = options.resourceVersions instanceof Map
      ? options.resourceVersions
      : readGitPathLastChangeRevisions(root, chunkPaths);
    const pendingChunk = chunk.filter((entry) => {
      const resourceVersion = resourceVersions.get(entry.path)
        || resourceVersionForReviewFile(root, entry.path, { exists: false }, reviewState.reviews[entry.path] || null);
      const localCurrent = !options.ignoreReviewTrust && absentReviewDecisionIsCurrent(reviewState.reviews[entry.path], resourceVersion);
      const globalCurrent = !options.ignoreReviewTrust && absentReviewDecisionIsCurrent(globalReviewLedger.reviews[globalReviewKeyFor(root, entry.path)], resourceVersion);
      return !localCurrent && !globalCurrent;
    });
    if (!pendingChunk.length) continue;
    const chunkGitHeadContents = providedGitHeadContents || new Map();
    if (!providedGitHeadContents) {
      const missingPaths = [];
      for (const relPath of pendingChunk.map((entry) => entry.path)) {
        if (renameGitHeadContents.has(relPath)) chunkGitHeadContents.set(relPath, renameGitHeadContents.get(relPath));
        else missingPaths.push(relPath);
      }
      const additionalContents = readGitHeadFileContents(root, missingPaths);
      for (const [relPath, content] of additionalContents) chunkGitHeadContents.set(relPath, content);
    }
    for (const entry of pendingChunk) {
      let item = buildDeletedReviewQueueItem(root, entry, settings, reviewState, chunkGitHeadContents, resourceVersions, globalReviewLedger);
      if (renameInferenceUncertainPaths.has(entry.path)) item = { ...item, protected: true, renameInferenceUncertain: true };
      if (!options.ignoreReviewTrust && item.review?.status === "verified" && item.review.current) continue;
      pending.push(item);
      if (pending.length >= maxPending) break;
    }
  }
  return pending.sort((a, b) => compareReviewQueueItems(a, b, settings));
}

function isProtectedDeletedReviewItem(item) {
  return Boolean(item.reviewRequired
    || item.classification?.sensitive
    || ["critical", "high"].includes(item.classification?.authority)
    || (item.metadata?.present && ["agents", "canonical", "procedure"].includes(item.metadata?.kind))
    || item.issues?.some((issue) => ["critical", "high"].includes(issue.severity)));
}

function buildDeletedReviewQueueItem(root, entry, settings, reviewState, gitHeadContents = null, resourceVersions = null, globalReviewLedger = null) {
  const contentAvailable = !(gitHeadContents instanceof Map) || gitHeadContents.has(entry.path);
  const content = gitHeadContents instanceof Map ? gitHeadContents.get(entry.path) || "" : readGitHeadFileContent(root, entry.path);
  const classification = classifyDocPath(entry.path);
  const metadata = parseDocMetadata(content, entry.path);
  const issues = computeDocIssues({ path: entry.path, content, gitStatus: entry.status, metadata });
  const riskScore = riskScoreFor({ classification, issues, gitStatus: entry.status });
  const reviewRequired = isRequiredReviewPath(entry.path, settings);
  const resourceVersion = resourceVersions?.get(entry.path) || resourceVersionForReviewFile(root, entry.path, { exists: false }, reviewState.reviews[entry.path] || null);
  const review = currentReviewFor(root, reviewState.reviews, entry.path, "", "absent", resourceVersion, globalReviewLedger);
  const item = {
    path: entry.path,
    oldPath: null,
    label: path.basename(entry.path),
    summary: "Deleted file.",
    updatedAt: null,
    classification,
    metadata,
    gitStatus: entry.status,
    reviewRequired,
    issues,
    riskScore,
    review,
    resourceVersion,
    resourceState: "absent",
    batchDeletion: true,
    contentUnavailable: !contentAvailable,
  };
  return { ...item, protected: !contentAvailable || isProtectedDeletedReviewItem(item) };
}

function publicDeletedReviewBatchItem(item) {
  return {
    path: item.path,
    label: item.label,
    protected: Boolean(item.protected),
    contentUnavailable: Boolean(item.contentUnavailable),
    renameInferenceUncertain: Boolean(item.renameInferenceUncertain),
    reviewRequired: Boolean(item.reviewRequired),
    kind: item.metadata?.kind || "unknown",
    authority: item.classification?.authority || "low",
  };
}

function deletedReviewBatchKey(items = []) {
  return hashContent(items.slice(0, MAX_BATCH_REVIEW_PATHS).map((item) => [
    item.path,
    item.resourceVersion || "",
    item.gitStatus || "",
    item.protected ? "protected" : "standard",
    item.reviewRequired ? "required" : "optional",
  ].join("\0")).join("\n"));
}

export function buildDeletedReviewBatch(root = process.cwd()) {
  const { items, truncated } = buildDeletedReviewPage(root);
  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    protectedCount: items.filter((item) => item.protected).length,
    key: deletedReviewBatchKey(items),
    truncated,
    items: items.map(publicDeletedReviewBatchItem),
  };
}

function buildDeletedReviewPage(root, options = {}) {
  const pending = buildPendingDeletedReviewItems(root, { ...options, limit: MAX_BATCH_REVIEW_PATHS + 1 });
  return {
    items: pending.slice(0, MAX_BATCH_REVIEW_PATHS),
    truncated: pending.length > MAX_BATCH_REVIEW_PATHS,
  };
}

export function writeDeletedReviewBatchDecision(root, relPaths = [], {
  note = "batch deletion confirmed from Context Room review queue",
  expectedKey = null,
  protectedAcknowledged = false,
} = {}) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) throw new Error("No deleted review paths selected");
  if (relPaths.length > MAX_BATCH_REVIEW_PATHS) throw new Error(`Too many deleted review paths selected (maximum ${MAX_BATCH_REVIEW_PATHS})`);
  const requested = [];
  const invalid = [];
  const seen = new Set();
  for (const rawPath of relPaths) {
    const normalized = normalizeRelPath(String(rawPath || ""));
    if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) {
      invalid.push({ path: String(rawPath || ""), reason: "invalid_path" });
      continue;
    }
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    requested.push(normalized);
  }
  if (!requested.length) return { requested: relPaths.length, confirmed: [], protectedConfirmed: 0, skipped: invalid };
  const candidateItems = buildDeletedReviewPage(root).items;
  const currentKey = deletedReviewBatchKey(candidateItems);
  if (expectedKey != null && String(expectedKey) !== currentKey) {
    const error = new Error("Removed files changed since this batch was loaded. Reload the set before confirming it.");
    error.statusCode = 409;
    throw error;
  }
  const candidates = new Map(candidateItems.map((item) => [item.path, item]));
  if (!protectedAcknowledged && requested.some((relPath) => candidates.get(relPath)?.protected)) {
    const error = new Error("Protected removed paths require explicit acknowledgement.");
    error.statusCode = 400;
    throw error;
  }
  const currentResourceVersions = readGitPathLastChangeRevisions(root, requested);
  const confirmed = [];
  const skipped = [...invalid];
  let protectedConfirmed = 0;
  const reviewedAt = new Date().toISOString();
  const cleanNote = String(note || "").slice(0, 500);
  const state = readDocReviewState(root);
  const ledger = readGlobalReviewLedger(root);
  let ledgerChanged = false;
  for (const relPath of requested) {
    const candidate = candidates.get(relPath);
    if (!candidate) {
      skipped.push({ path: relPath, reason: "not_pending_deletion" });
      continue;
    }
    try {
      const file = readReviewTrackedFile(root, relPath);
      const existing = state.reviews[relPath] && typeof state.reviews[relPath] === "object" ? state.reviews[relPath] : null;
      const resourceState = resourceStateForReviewFile(file);
      const resourceVersion = currentResourceVersions.get(relPath) || resourceVersionForReviewFile(root, relPath, file, existing);
      if (resourceState !== "absent" || resourceVersion !== candidate.resourceVersion) throw new Error(`Review target changed before the decision was saved: ${relPath}`);
      const baseline = writeDocReviewBaselineFile(root, relPath, file.content);
      const decision = {
        status: "verified",
        note: cleanNote,
        reviewedAt,
        contentHash: hashContent(file.content),
        reviewHash: reviewContentHash(file.content),
        resourceState,
        resourceVersion,
        baselinePath: baseline.baselinePath,
        baselineHash: baseline.baselineHash,
        baselineReviewHash: baseline.baselineReviewHash,
        baselineAt: baseline.baselineAt,
      };
      state.reviews[relPath] = decision;
      const globalResult = applyGlobalReviewDecision(ledger, root, relPath, file, decision);
      ledgerChanged = ledgerChanged || globalResult.changed;
      confirmed.push(relPath);
      if (candidate.protected) protectedConfirmed += 1;
    } catch (error) {
      skipped.push({ path: relPath, reason: "state_changed", message: error.message });
    }
  }
  if (confirmed.length) writeDocReviewState(root, state);
  if (ledgerChanged) writeGlobalReviewLedger(root, ledger);
  return { requested: requested.length, confirmed, protectedConfirmed, skipped };
}

function readGitHeadFileContent(root, relPath) {
  try {
    return execFileSync("git", ["show", "HEAD:" + gitTreePathForRootRelative(root, relPath)], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: MAX_FILE_BYTES + 64_000 });
  } catch {
    return "";
  }
}

function readGitHeadFileContents(root, relPaths = [], { maxTotalBytes = MAX_GIT_HEAD_SNAPSHOT_BYTES } = {}) {
  const paths = [...new Set(relPaths.map(normalizeRelPath).filter(Boolean))];
  if (!paths.length) return new Map();
  const contents = new Map();
  const candidates = [];
  const totalLimit = Number.isFinite(maxTotalBytes) ? Math.max(0, Number(maxTotalBytes)) : MAX_GIT_HEAD_SNAPSHOT_BYTES;
  let selectedBytes = 0;
  for (let start = 0; start < paths.length && selectedBytes < totalLimit; start += 1000) {
    const chunk = paths.slice(start, start + 1000);
    const specs = chunk.map((relPath) => `HEAD:${gitTreePathForRootRelative(root, relPath)}`);
    try {
      const output = execFileSync("git", ["cat-file", "--batch-check"], {
        cwd: root,
        input: specs.join("\n") + "\n",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: Math.max(1_000_000, chunk.length * 256),
      });
      const lines = output.trimEnd().split("\n");
      for (let index = 0; index < chunk.length; index += 1) {
        const match = String(lines[index] || "").match(/^[0-9a-f]+ blob (\d+)$/);
        const size = match ? Number(match[1]) : Number.NaN;
        if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) continue;
        if (selectedBytes + size > totalLimit) continue;
        candidates.push({ relPath: chunk[index], spec: specs[index], size });
        selectedBytes += size;
      }
    } catch {
      // Missing Git objects stay absent from the bounded snapshot.
    }
  }
  for (let start = 0; start < candidates.length;) {
    const batch = [];
    let expectedBytes = 0;
    while (start < candidates.length && batch.length < 200) {
      const candidate = candidates[start];
      if (batch.length && expectedBytes + candidate.size > 16_000_000) break;
      batch.push(candidate);
      expectedBytes += candidate.size;
      start += 1;
    }
    try {
      const output = execFileSync("git", ["cat-file", "--batch"], {
        cwd: root,
        input: batch.map((candidate) => candidate.spec).join("\n") + "\n",
        encoding: null,
        stdio: ["pipe", "pipe", "ignore"],
        maxBuffer: Math.max(1_000_000, expectedBytes + batch.length * 1024 + 64_000),
      });
      let offset = 0;
      for (const candidate of batch) {
        const headerEnd = output.indexOf(10, offset);
        if (headerEnd < 0) break;
        const header = output.subarray(offset, headerEnd).toString("utf8");
        offset = headerEnd + 1;
        if (header.endsWith(" missing")) continue;
        const size = Number(header.split(" ").at(-1));
        if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES || offset + size > output.length) break;
        contents.set(candidate.relPath, output.subarray(offset, offset + size).toString("utf8"));
        offset += size + 1;
      }
    } catch {
      // Keep the other bounded chunks available when one Git read fails.
    }
  }
  return contents;
}

function readGitPathLastChangeRevisions(root, relPaths = []) {
  const paths = [...new Set(relPaths.map((relPath) => normalizeRelPath(String(relPath || ""))).filter(Boolean))];
  const revisions = new Map();
  for (let start = 0; start < paths.length; start += 400) {
    const chunk = paths.slice(start, start + 400);
    const wanted = new Set(chunk);
    try {
      const output = execFileSync("git", ["-c", "core.quotepath=false", "log", "--format=@@context-room-revision:%H", "--name-only", "--relative", "--", ...chunk], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16_000_000 });
      let revision = "";
      for (const rawLine of output.split("\n")) {
        const line = rawLine.trim();
        if (!line) continue;
        if (line.startsWith("@@context-room-revision:")) {
          revision = line.slice("@@context-room-revision:".length);
          continue;
        }
        const relPath = normalizeRelPath(line);
        if (revision && wanted.has(relPath) && !revisions.has(relPath)) revisions.set(relPath, `git-path:${revision}`);
      }
    } catch {}
  }
  return revisions;
}

function buildStartupContextReviewQueue(root, settings, reviewState, startupFiles = listStartupContextFiles(root, settings)) {
  const queue = [];
  let stateChanged = false;
  for (const startupFile of startupFiles) {
    if (!isExternalStartupContextReviewFile(root, startupFile)) continue;
    const file = readStartupContextReviewFile(root, startupFile.startupContext.displayPath, settings);
    if (!file) continue;
    const existing = reviewState.reviews[file.path] && typeof reviewState.reviews[file.path] === "object" ? reviewState.reviews[file.path] : {};
    const baseline = readDocReviewBaseline(root, file.path, existing);
    if (!baseline) {
      const nextBaseline = writeDocReviewBaselineFile(root, file.path, file.content);
      reviewState.reviews[file.path] = {
        ...existing,
        baselinePath: nextBaseline.baselinePath,
        baselineHash: nextBaseline.baselineHash,
        baselineReviewHash: nextBaseline.baselineReviewHash,
        baselineAt: nextBaseline.baselineAt,
        note: existing.note || "startup context baseline",
      };
      stateChanged = true;
      continue;
    }
    if (baseline.reviewHash === reviewContentHash(file.content)) continue;
    const classification = { type: "startup-context", authority: "critical", sensitive: false };
    const gitStatus = "M";
    const metadata = parseDocMetadata(file.content, file.path);
    const issues = computeDocIssues({ path: file.path, content: file.content, gitStatus, metadata });
    issues.unshift({ type: "internal_context_changed", severity: "high", message: "Startup context changed outside the Git review baseline." });
    const resourceState = file.exists === false ? "absent" : "present";
    const resourceVersion = resourceVersionForReviewFile(root, file.path, file, reviewState.reviews[file.path] || null);
    const review = currentReviewFor(root, reviewState.reviews, file.path, file.content, resourceState, resourceVersion);
    if (review?.status === "verified" && review.current) continue;
    queue.push({
      path: file.path,
      label: file.label || file.startupContext?.fileName || path.basename(file.path),
      summary: file.summary || "Startup context changed outside Git.",
      updatedAt: file.updatedAt,
      classification,
      metadata,
      gitStatus,
      internalChange: true,
      startupContext: file.startupContext,
      reviewRequired: true,
      issues,
      riskScore: riskScoreFor({ classification, issues, gitStatus }) + 20,
      review,
    });
  }
  if (stateChanged) writeDocReviewState(root, reviewState);
  return queue;
}

function reviewSeverityRank(item) {
  if (item.issues.some((issue) => issue.severity === "critical")) return 0;
  if (item.issues.some((issue) => issue.severity === "high")) return 1;
  return 2;
}

function configuredReviewOrderRank(relPath, settings = {}) {
  const normalized = normalizeRelPath(relPath);
  const index = (settings.reviewPaths || []).findIndex((pattern) => pathMatchesSetting(normalized, pattern));
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

function compareReviewQueueItems(a, b, settings = {}) {
  const aCritical = a.issues.some((issue) => issue.severity === "critical");
  const bCritical = b.issues.some((issue) => issue.severity === "critical");
  if (aCritical !== bCritical) return aCritical ? -1 : 1;
  const aConfigured = configuredReviewOrderRank(a.path, settings);
  const bConfigured = configuredReviewOrderRank(b.path, settings);
  if (aConfigured !== bConfigured) return aConfigured - bConfigured;
  return reviewSeverityRank(a) - reviewSeverityRank(b)
    || reviewOrderRank(a.path) - reviewOrderRank(b.path)
    || b.riskScore - a.riskScore
    || a.path.localeCompare(b.path, "fr");
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
    startupContext: { ...DEFAULT_STARTUP_CONTEXT },
    startupSkills: { ...DEFAULT_STARTUP_SKILLS },
    startupHooks: defaultStartupHookSettings(),
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
  const agentContext = syncContextRoomAgentContext(root);
  ensureRuntimeGitExcludes(root);
  return { config: saved, configPath: path.join(root, MEMORY_WEBAPP_SETTINGS), agentContextPath: agentContext.entryPath };
}

export function syncContextRoomAgentContext(root = process.cwd()) {
  const projectRoot = path.resolve(root);
  const sourceRoot = path.resolve(path.dirname(__filename), "..", "docs");
  const targetRoot = path.join(projectRoot, AGENT_CONTEXT_DIR);
  const assets = [
    [path.join(sourceRoot, "features", "html-visual-documents.md"), "html-visual-documents.md"],
    [path.join(sourceRoot, "features", "html-visual-patterns.md"), "html-visual-patterns.md"],
    [path.join(sourceRoot, "context-room-visual-components.html"), "context-room-visual-components.html"],
    [path.join(sourceRoot, "context-room-data-visual-components.html"), "context-room-data-visual-components.html"],
  ];
  const missing = assets.filter(([source]) => !fs.existsSync(source)).map(([source]) => source);
  if (missing.length) throw new Error(`Context Room agent context is incomplete: ${missing.join(", ")}`);

  fs.mkdirSync(targetRoot, { recursive: true });
  const entry = `# Context Room HTML Visual Context

This file is generated by Context Room. Do not edit it; \`context-room init\` and \`context-room start\` refresh it from the installed version.

## Goal

Create a visual HTML document only when spatial structure makes a complex subject easier to understand or decide. The rendered document must be clear for people and its semantic source must remain precise for agents.

## Workflow

1. Inspect the source truth before designing the page.
2. State the one question the document must answer.
3. Use Markdown if prose, bullets, or a short comparison remain equally clear.
4. Choose one visual family by reasoning job, not appearance.
5. Build with semantic HTML and injected \`cr-*\` classes.
6. Verify desktop, mobile, keyboard interaction, and the rendered review preview.

## Choose The Visual

- Parts, boundaries, and exchanges: system landscape.
- Causes, mechanisms, effects, and feedback: causal chain.
- Conditions and outcomes: branching decision.
- Actors, order, and handoffs: actor sequence.
- Claim, evidence, objection, and conclusion: reasoning map.
- Exact quantities: use a data pattern only when the numbers answer the question.

Do not diagram a simple idea. Use three to five nodes for a small subject. Split a map above fifteen meaningful nodes or when links obscure the reading path.

## Build The Document

- Start with \`<main class="cr-page">\` and a \`cr-header\` containing a literal title and one-sentence purpose.
- Use headings, paragraphs, lists, \`section\`, \`article\`, and \`table\` according to meaning.
- Use \`cr-section\`, \`cr-grid\`, \`cr-comparison\`, \`cr-card\`, \`cr-callout\`, and the catalog patterns instead of inventing repeated layout CSS.
- Put a diagram inside \`cr-diagram-scroll\` and \`cr-diagram\`. Position nodes with \`--col\`, \`--row\`, \`--span\`, and \`--rows\`.
- Name every non-obvious relationship. Color and position may reinforce meaning but must never carry it alone.
- For a large document, state the scenario, decision, and scale before the map; summarize the main reading, risk, and next question after it.
- Keep labels short and put explanation around the visual or inside optional \`details\` nodes.

## Interaction

- Prefer native radio controls for a few views and \`details\` / \`summary\` for secondary depth.
- Keep the main conclusion visible without interaction.
- Give every control a literal label and visible keyboard focus.
- Do not require hover or animation to understand the document.

Scripts, iframes, and external resources are removed from Context Room previews. Do not copy theme CSS into the file; Context Room injects the active theme and component styles.

## Theme Contract

The rendered HTML automatically follows the active Context Room app theme. Changing the theme in Context Room regenerates the preview with the matching background, surfaces, text, borders, accents, and status colors.

- Prefer injected \`cr-*\` components and \`data-tone="positive|warning|negative|accent"\`.
- If custom CSS is necessary, use \`--cr-bg\`, \`--cr-surface\`, \`--cr-surface-strong\`, \`--cr-text\`, \`--cr-muted\`, \`--cr-line\`, \`--cr-accent\`, \`--cr-secondary\`, \`--cr-positive\`, \`--cr-negative\`, and \`--cr-code\`.
- Do not hard-code a page palette, force light or dark mode, or add a theme selector inside the HTML.
- Keep custom CSS structural. Context Room owns visual theme tokens so the same document stays readable in every available app theme.

## Where To Find HTML Examples

Open these project-local files before building a visual:

- \`.context-room/agent-context/context-room-visual-components.html\`: five complete examples for systems, causality, decisions, sequences, and reasoning.
- \`.context-room/agent-context/context-room-data-visual-components.html\`: forty examples for metrics, comparisons, charts, timelines, planning, and status.

Read the rendered examples for composition and interaction, then inspect their semantic HTML source to reuse the relevant \`cr-*\` classes. Adapt the content and scale; do not copy an entire example when a smaller structure is enough.

## Quality Gate

- One explicit question is answered.
- The visual removes real cognitive work instead of decorating prose.
- Groupings, links, states, and boundaries are named in text.
- Parallel options contain parallel information.
- Text stays readable and the page has no global horizontal overflow.
- Large maps remain full-size inside a bounded, focusable scroll viewport.
- Mouse and keyboard interactions both work.
- The HTML appears as a rendered item in the review queue when watched.

## References

- [HTML visual documents](agent-context/html-visual-documents.md): full usage and review contract.
- [HTML visual patterns](agent-context/html-visual-patterns.md): classes, diagram grammar, and scale rules.
- [Five diagram examples](agent-context/context-room-visual-components.html): complex ideas and relationships.
- [Data visual catalog](agent-context/context-room-data-visual-components.html): quantitative and operational patterns.
`;
  const legacyEntry = `# Context Room Agent Context

Read [\`.context-room/README.md\`](../README.md) before creating or editing a visual HTML document.

This compatibility file is generated by Context Room.
`;
  const files = [
    [path.join(projectRoot, AGENT_CONTEXT_FILE), entry],
    [path.join(projectRoot, LEGACY_AGENT_CONTEXT_FILE), legacyEntry],
  ];
  for (const [source, fileName] of assets) files.push([path.join(targetRoot, fileName), fs.readFileSync(source, "utf8")]);

  let updated = 0;
  for (const [target, content] of files) {
    if (fs.existsSync(target) && fs.readFileSync(target, "utf8") === content) continue;
    fs.writeFileSync(target, content, "utf8");
    updated += 1;
  }
  return { entryPath: path.join(projectRoot, AGENT_CONTEXT_FILE), files: files.map(([target]) => target), updated };
}

export function ensureRuntimeGitExcludes(root = process.cwd()) {
  const excludePath = gitInfoExcludePath(root);
  if (!excludePath) return { updated: false, path: null };
  const prefix = gitRootRelativePrefix(root);
  const roomEntries = [
    ".context-room/review-state.json",
    ".context-room/session-state.json",
    ".context-room/agent-command.json",
    ".context-room/agent-annotations.json",
    ".context-room/health-acknowledgements.json",
    ".context-room/README.md",
    ".context-room/agent-context/",
    ".context-room/review-baselines/",
    ".context-room/memory-webapp-backups/",
  ].map((entry) => prefix + entry);
  const entries = [...new Set([".context-room/review-ledger.json", ...roomEntries])];
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

function cachedGitTopLevel(root) {
  const resolvedRoot = path.resolve(root);
  if (gitTopLevelCache.has(resolvedRoot)) return gitTopLevelCache.get(resolvedRoot);
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolvedRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const result = topLevel ? path.resolve(topLevel) : null;
    gitTopLevelCache.set(resolvedRoot, result);
    return result;
  } catch {
    gitTopLevelCache.set(resolvedRoot, null);
    return null;
  }
}

function gitTopLevelRoot(root) {
  return cachedGitTopLevel(root);
}

function gitRootRelativePrefix(root) {
  const topLevel = cachedGitTopLevel(root);
  if (!topLevel) return "";
  const rel = normalizeRelPath(path.relative(safeRealPath(topLevel), safeRealPath(root)));
  return rel && rel !== "." ? rel.replace(/\/$/, "") + "/" : "";
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

export function readGlobalContextRoomPreferences(preferencesPath = null) {
  const target = resolveGlobalPreferencesPath(preferencesPath);
  if (!fs.existsSync(target)) return { appearance: { ...DEFAULT_APPEARANCE } };
  try {
    const parsed = JSON.parse(fs.readFileSync(target, "utf8"));
    return { appearance: normalizeAppearanceSettings(parsed.appearance) };
  } catch {
    return { appearance: { ...DEFAULT_APPEARANCE } };
  }
}

export function writeGlobalContextRoomPreferences(next = {}, preferencesPath = null) {
  const target = resolveGlobalPreferencesPath(preferencesPath);
  const current = readGlobalContextRoomPreferences(target);
  const preferences = { appearance: normalizeAppearanceSettings({ ...current.appearance, ...(next.appearance || {}) }) };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(preferences, null, 2) + "\n", "utf8");
  return preferences;
}

export function readResolvedContextRoomSettings(root = process.cwd(), { preferencesPath = null } = {}) {
  const projectSettings = readMemoryWebappSettings(root);
  const preferences = readGlobalContextRoomPreferences(preferencesPath);
  return { ...projectSettings, appearance: preferences.appearance };
}

function resolveGlobalPreferencesPath(preferencesPath = null) {
  return preferencesPath ? path.resolve(preferencesPath) : path.join(os.homedir(), ".context-room", "preferences.json");
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
    startupContext: normalizeStartupContextSettings(raw.startupContext ?? base.startupContext),
    startupSkills: normalizeStartupSkillSettings(raw.startupSkills ?? base.startupSkills),
    startupHooks: normalizeStartupHookSettings(raw.startupHooks ?? base.startupHooks),
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
    showHiddenFiles: value.showHiddenFiles !== false,
  };
}

function normalizeStartupContextSettings(value = {}) {
  const rawFileNames = Array.isArray(value.fileNames) ? value.fileNames : DEFAULT_STARTUP_CONTEXT.fileNames;
  const fileNames = [...new Set(rawFileNames
    .map((item) => path.basename(String(item || "").trim()))
    .filter((item) => item && !isBlockedPath(item) && isEditableTextFile(item))
  )];
  const rawGlobalPaths = Array.isArray(value.globalPaths) ? value.globalPaths : [];
  const globalPaths = [...new Set(rawGlobalPaths
    .map((item) => normalizeRelPath(String(item || "")).replace(/\/$/, ""))
    .filter((item) => item.startsWith("~/") && !item.includes("/../") && !isBlockedPath(item) && isEditableTextFile(item))
  )];
  return {
    enabled: Boolean(value.enabled),
    fileNames: fileNames.length ? fileNames : [...DEFAULT_STARTUP_CONTEXT.fileNames],
    globalPaths,
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

function defaultStartupHookSettings() {
  return {
    ...DEFAULT_STARTUP_HOOKS,
    fileNames: [...DEFAULT_STARTUP_HOOKS.fileNames],
    agentHookSources: defaultAgentHookSources(),
    agentHookPaths: [...DEFAULT_STARTUP_HOOKS.agentHookPaths],
    codexPaths: [...DEFAULT_STARTUP_HOOKS.codexPaths],
    managerPaths: [...DEFAULT_STARTUP_HOOKS.managerPaths],
  };
}

function defaultAgentHookSources() {
  return DEFAULT_AGENT_HOOK_SOURCES.map((source) => ({ id: source.id, label: source.label, paths: [...source.paths] }));
}

function normalizeStartupHookSettings(value = {}) {
  const rawFileNames = Array.isArray(value.fileNames) ? value.fileNames : DEFAULT_STARTUP_HOOKS.fileNames;
  const fileNames = [...new Set(rawFileNames
    .map((item) => path.basename(String(item || "").trim()))
    .filter((item) => item && !isBlockedPath(item) && !item.endsWith(".sample"))
  )];
  const rawManagerPaths = Array.isArray(value.managerPaths) ? value.managerPaths : DEFAULT_STARTUP_HOOKS.managerPaths;
  const managerPaths = [...new Set(rawManagerPaths
    .map((item) => normalizeRelPath(String(item || "")))
    .filter((item) => item && !item.startsWith("../") && !item.includes("/../") && !path.isAbsolute(item) && !isBlockedPath(item))
  )];
  const agentHookSources = normalizeAgentHookSources(value);
  const agentHookPaths = [...new Set(agentHookSources.flatMap((source) => source.paths || []))];
  const codexPaths = agentHookPaths.filter((item) => item.includes(".codex/"));
  const agentHooks = value.agentHooks ?? value.codexHooks;
  return {
    enabled: value.enabled !== false,
    editable: Boolean(value.editable),
    agentHooks: agentHooks !== false,
    codexHooks: agentHooks !== false,
    gitHooks: value.gitHooks !== false,
    hookManagers: value.hookManagers !== false,
    fileNames: fileNames.length ? fileNames : [...DEFAULT_STARTUP_HOOKS.fileNames],
    agentHookSources,
    agentHookPaths: agentHookPaths.length ? agentHookPaths : [...DEFAULT_STARTUP_HOOKS.agentHookPaths],
    codexPaths: codexPaths.length ? codexPaths : [...DEFAULT_STARTUP_HOOKS.codexPaths],
    managerPaths: managerPaths.length ? managerPaths : [...DEFAULT_STARTUP_HOOKS.managerPaths],
  };
}

function normalizeAgentHookSources(value = {}) {
  const rawSources = Array.isArray(value.agentHookSources)
    ? value.agentHookSources
    : null;
  if (rawSources) {
    const byId = new Map();
    for (const rawSource of rawSources) {
      const label = String(rawSource?.label || rawSource?.name || rawSource?.id || "").trim();
      const id = sanitizeAgentHookSourceId(rawSource?.id || label);
      const paths = sanitizeAgentHookPathList(rawSource?.paths || rawSource?.path || []);
      if (!id || !label || !paths.length) continue;
      const existing = byId.get(id);
      if (existing) {
        existing.paths = [...new Set([...existing.paths, ...paths])];
      } else {
        byId.set(id, { id, label, paths });
      }
    }
    if (byId.size) return [...byId.values()];
  }

  const rawPaths = Array.isArray(value.agentHookPaths)
    ? value.agentHookPaths
    : Array.isArray(value.codexPaths)
      ? value.codexPaths
      : DEFAULT_STARTUP_HOOKS.agentHookPaths;
  return agentHookSourcesFromPaths(sanitizeAgentHookPathList(rawPaths));
}

function sanitizeAgentHookSourceId(value) {
  return slugifyServer(String(value || "").trim()).replace(/[^a-z0-9-]/g, "").replace(/^-+|-+$/g, "") || "agent";
}

function sanitizeAgentHookPathList(value) {
  const raw = Array.isArray(value) ? value : [value];
  return [...new Set(raw
    .map((item) => normalizeRelPath(String(item || "")))
    .filter((item) => item && !item.startsWith("../") && !item.includes("/../") && !path.isAbsolute(item) && !isBlockedPath(item))
  )];
}

function agentHookSourcesFromPaths(paths = []) {
  const byId = new Map();
  for (const relPath of paths) {
    const source = defaultAgentHookSourceForPath(relPath);
    const existing = byId.get(source.id);
    if (existing) {
      existing.paths.push(relPath);
    } else {
      byId.set(source.id, { id: source.id, label: source.label, paths: [relPath] });
    }
  }
  return byId.size ? [...byId.values()].map((source) => ({ ...source, paths: [...new Set(source.paths)] })) : defaultAgentHookSources();
}

function defaultAgentHookSourceForPath(relPath) {
  const clean = normalizeRelPath(relPath).toLowerCase();
  if (clean.includes(".codex/")) return { id: "codex", label: "Codex" };
  if (clean.includes(".claude/")) return { id: "claude-code", label: "Claude Code" };
  if (clean.includes("opencode")) return { id: "opencode", label: "OpenCode" };
  return { id: "agent", label: "Agent" };
}

function markdownTemplatesForSettings(settings = defaultMemoryWebappSettings()) {
  return sanitizeMarkdownTemplates(settings.markdownTemplates?.length ? settings.markdownTemplates : DEFAULT_MARKDOWN_TEMPLATES);
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

function readGitStatusEntries(root) {
  const statuses = new Map();
  try {
    const rootPrefix = gitRepoPrefixForRoot(root);
    const output = execFileSync("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const entry = gitStatusEntryFromPorcelainLine(line, rootPrefix);
      if (entry?.path) statuses.set(entry.path, entry);
    }
  } catch {
    // Git is optional for temp test roots and non-repo launches.
  }
  return statuses;
}

function readGitStatuses(root) {
  return new Map([...readGitStatusEntries(root).entries()].map(([rel, entry]) => [rel, entry.status]));
}

function gitRepoPrefixForRoot(root) {
  const topLevel = cachedGitTopLevel(root);
  if (!topLevel) return "";
  const rel = normalizeRelPath(path.relative(safeRealPath(topLevel), safeRealPath(root)));
  return rel && rel !== "." ? rel.replace(/\/$/, "") + "/" : "";
}

function gitStatusEntryFromPorcelainLine(line, rootPrefix = "") {
  const status = line.slice(0, 2);
  const { oldPath, path: nextPath } = gitStatusPathsFromPorcelainLine(line);
  const rel = normalizeGitStatusPathForRoot(nextPath, rootPrefix);
  const oldRel = oldPath ? normalizeGitStatusPathForRoot(oldPath, rootPrefix) : "";
  if (!rel) return null;
  return { path: rel, oldPath: oldRel || null, status };
}

function gitStatusPathsFromPorcelainLine(line) {
  const raw = line.slice(3);
  if (!raw.includes(" -> ")) return { path: cleanGitStatusPath(raw), oldPath: null };
  const [oldRaw, ...nextParts] = raw.split(" -> ");
  return {
    oldPath: cleanGitStatusPath(oldRaw),
    path: cleanGitStatusPath(nextParts.join(" -> ") || oldRaw),
  };
}

function gitStatusPathFromPorcelainLine(line) {
  return gitStatusPathsFromPorcelainLine(line).path;
}

function cleanGitStatusPath(raw) {
  return String(raw || "").trim().replace(/^"|"$/g, "").replaceAll("\\", "/");
}

function normalizeGitStatusPathForRoot(relPath, rootPrefix = "") {
  const normalized = normalizeRelPath(relPath);
  const prefix = normalizeRelPath(rootPrefix);
  if (!prefix) return normalized;
  if (normalized === prefix.replace(/\/$/, "")) return "";
  if (!normalized.startsWith(prefix)) return "";
  return normalizeRelPath(normalized.slice(prefix.length));
}

function backgroundWorkerKey(root, group) {
  return `${path.resolve(root)}\0${group}`;
}

function backgroundWorkerGroup(task) {
  return task === "reports" ? "reports" : "files";
}

function ensureBackgroundWorker(root, group) {
  const key = backgroundWorkerKey(root, group);
  const existing = backgroundWorkerPools.get(key);
  if (existing) return existing;
  const worker = new Worker(new URL("./background_worker.mjs", import.meta.url), {
    workerData: { persistent: true, root: path.resolve(root) },
  });
  const entry = { key, worker, pending: new Map() };
  const fail = (error) => {
    if (backgroundWorkerPools.get(key) === entry) backgroundWorkerPools.delete(key);
    for (const request of entry.pending.values()) request.reject(error);
    entry.pending.clear();
  };
  worker.on("message", (message = {}) => {
    const request = entry.pending.get(message.id);
    if (!request) return;
    entry.pending.delete(message.id);
    if (message.ok) request.resolve(message.value);
    else request.reject(new Error(message.error || "Background task failed"));
  });
  worker.once("error", fail);
  worker.once("exit", (code) => {
    if (entry.pending.size) fail(new Error(`Background worker stopped with code ${code}`));
    else if (backgroundWorkerPools.get(key) === entry) backgroundWorkerPools.delete(key);
  });
  worker.unref();
  backgroundWorkerPools.set(key, entry);
  return entry;
}

function closeBackgroundWorkers(root) {
  const prefix = `${path.resolve(root)}\0`;
  for (const [key, entry] of backgroundWorkerPools) {
    if (!key.startsWith(prefix)) continue;
    backgroundWorkerPools.delete(key);
    entry.worker.terminate().catch(() => {});
  }
}

function runBackgroundTask(task, root, payload = {}) {
  const entry = ensureBackgroundWorker(root, backgroundWorkerGroup(task));
  const id = ++backgroundWorkerRequestId;
  return new Promise((resolve, reject) => {
    entry.pending.set(id, { resolve, reject });
    entry.worker.postMessage({ id, task, payload });
  });
}

function backgroundFileTaskKey(task, root, payload = {}) {
  return `${path.resolve(root)}\0${task}\0${normalizeRelPath(payload.path || "")}`;
}

function readBackgroundFileTask(task, root, payload = {}) {
  const rootKey = path.resolve(root);
  const key = backgroundFileTaskKey(task, root, payload);
  const cached = backgroundFileTaskCache.get(key);
  if (cached?.value && cached.expiresAt > Date.now()) return Promise.resolve(cached.value);
  if (cached?.promise) return cached.promise;
  const generation = backgroundFileTaskGenerations.get(rootKey) || 0;
  const promise = runBackgroundTask(task, root, payload);
  backgroundFileTaskCache.set(key, { promise, value: cached?.value || null, expiresAt: cached?.expiresAt || 0 });
  return promise.then((value) => {
    if ((backgroundFileTaskGenerations.get(rootKey) || 0) !== generation) return readBackgroundFileTask(task, rootKey, payload);
    backgroundFileTaskCache.set(key, { value, expiresAt: Date.now() + FILE_TASK_CACHE_TTL_MS, promise: null });
    return value;
  }, (error) => {
    backgroundFileTaskCache.delete(key);
    throw error;
  });
}

function invalidateBackgroundFileTasks(root) {
  const rootKey = path.resolve(root);
  const prefix = `${rootKey}\0`;
  backgroundFileTaskGenerations.set(rootKey, (backgroundFileTaskGenerations.get(rootKey) || 0) + 1);
  for (const key of backgroundFileTaskCache.keys()) {
    if (key.startsWith(prefix)) backgroundFileTaskCache.delete(key);
  }
}

function invalidateBackgroundReports(root) {
  const key = path.resolve(root);
  backgroundReportGenerations.set(key, (backgroundReportGenerations.get(key) || 0) + 1);
  backgroundReportCache.delete(key);
}

function invalidateBackgroundCaches(root, { explicit = false } = {}) {
  const key = path.resolve(root);
  if (explicit) backgroundExplicitInvalidations.set(key, Date.now());
  invalidateBackgroundReports(key);
  invalidateBackgroundFileTasks(key);
}

function clearBackgroundCacheState(root) {
  const key = path.resolve(root);
  const prefix = `${key}\0`;
  backgroundReportCache.delete(key);
  backgroundReportGenerations.delete(key);
  backgroundFileTaskGenerations.delete(key);
  backgroundExplicitInvalidations.delete(key);
  for (const taskKey of backgroundFileTaskCache.keys()) {
    if (taskKey.startsWith(prefix)) backgroundFileTaskCache.delete(taskKey);
  }
}

function requestInvalidatesBackgroundCaches(req) {
  if (!req || req.method === "GET") return false;
  try {
    return BACKGROUND_REPORT_INVALIDATING_PATHS.has(new URL(req.url, "http://localhost").pathname);
  } catch {
    return false;
  }
}

function watchBackgroundInputs(root) {
  const resolvedRoot = path.resolve(root);
  const startedAt = Date.now();
  let timer = null;
  const watchers = [];
  const scheduleInvalidation = (fileName) => {
    if (Date.now() - startedAt < 250) return;
    const relPath = fileName == null ? "" : normalizeRelPath(String(fileName));
    if (BACKGROUND_WATCH_IGNORED_PATHS.has(relPath)) return;
    if (relPath === path.basename(resolvedRoot)) return;
    const watchedPath = relPath ? path.resolve(resolvedRoot, relPath) : "";
    if (watchedPath && fs.existsSync(watchedPath) && fs.statSync(watchedPath).isDirectory()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (Date.now() - (backgroundExplicitInvalidations.get(resolvedRoot) || 0) < 250) return;
      invalidateBackgroundCaches(resolvedRoot);
    }, 80);
    timer.unref?.();
  };
  const addWatcher = (target, options = {}) => {
    try {
      watchers.push(fs.watch(target, { persistent: false, ...options }, (_event, fileName) => scheduleInvalidation(fileName)));
      return true;
    } catch {
      return false;
    }
  };
  if (!addWatcher(resolvedRoot, { recursive: true })) addWatcher(resolvedRoot);
  const startupContextFiles = listStartupContextFiles(resolvedRoot);
  for (const file of startupContextFiles) {
    const abs = path.resolve(file.startupContext?.absolutePath || "");
    if (!abs || abs === resolvedRoot || abs.startsWith(`${resolvedRoot}${path.sep}`)) continue;
    addWatcher(abs);
  }
  return () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
}

async function readBackgroundReports(root, { force = false } = {}) {
  const key = path.resolve(root);
  const now = Date.now();
  const cached = backgroundReportCache.get(key);
  if (!force && cached?.value && cached.expiresAt > now) return cached.value;
  if (cached?.promise) return cached.promise;
  const generation = backgroundReportGenerations.get(key) || 0;
  const promise = runBackgroundTask("reports", key);
  backgroundReportCache.set(key, { promise, value: cached?.value || null, expiresAt: cached?.expiresAt || 0 });
  try {
    const value = await promise;
    if ((backgroundReportGenerations.get(key) || 0) !== generation) return readBackgroundReports(key, { force: true });
    backgroundReportCache.set(key, { value, expiresAt: Date.now() + REPORT_CACHE_TTL_MS, promise: null });
    return value;
  } catch (error) {
    backgroundReportCache.delete(key);
    throw error;
  }
}

export function createMemoryServer({ root = process.cwd(), port = DEFAULT_PORT, globalPreferencesPath = null } = {}) {
  ensureBackgroundWorker(root, "files");
  void readBackgroundReports(root).catch(() => {});
  const lastSelectedPath = normalizeRelPath(readCollaborationSessionState(root).selectedPath || "");
  if (lastSelectedPath) void readBackgroundFileTask("file-diff", root, { path: lastSelectedPath }).catch(() => {});
  const stopBackgroundWatch = watchBackgroundInputs(root);
  const server = http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res, root, globalPreferencesPath);
    } catch (error) {
      sendJson(res, Number(error.statusCode) || 500, { error: error.message });
    } finally {
      if (requestInvalidatesBackgroundCaches(req)) invalidateBackgroundCaches(root, { explicit: true });
    }
  });
  server.once("close", () => {
    stopBackgroundWatch();
    closeBackgroundWorkers(root);
    clearBackgroundCacheState(root);
  });
  return { server, root, port };
}

async function routeRequest(req, res, root, globalPreferencesPath = null) {
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
    const appearance = readGlobalContextRoomPreferences(globalPreferencesPath).appearance;
    sendJson(res, 200, { files: listExplorerFiles(root, { externalRoots, showHiddenFiles: appearance.showHiddenFiles !== false }), root });
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
  if (req.method === "GET" && url.pathname === "/api/startup-hooks") {
    sendJson(res, 200, { files: listStartupHookFiles(root).map(publicStartupHookFile), root });
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
  if (req.method === "GET" && url.pathname === "/api/startup-hooks/file") {
    const order = url.searchParams.get("order") || "";
    sendJson(res, 200, readStartupHookFile(root, order));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/startup-hooks/file") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeStartupHookFile(root, body.order, body.content));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/settings") {
    const settings = readResolvedContextRoomSettings(root, { preferencesPath: globalPreferencesPath });
    sendJson(res, 200, { settings, hubCards: hubCardsForRoot(root, settings), hubSections: hubSectionsForRoot(root, settings), availableHubCards: settings.customHubCards });
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const incoming = body.settings || body;
    const projectInput = { ...incoming };
    delete projectInput.appearance;
    const projectSettings = writeMemoryWebappSettings(root, projectInput);
    const preferences = writeGlobalContextRoomPreferences({ appearance: incoming.appearance }, globalPreferencesPath);
    const settings = { ...projectSettings, appearance: preferences.appearance };
    sendJson(res, 200, { settings, hubCards: hubCardsForRoot(root, settings), hubSections: hubSectionsForRoot(root, settings), availableHubCards: settings.customHubCards });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/reports") {
    sendJson(res, 200, await readBackgroundReports(root, { force: url.searchParams.get("fresh") === "1" }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/docqa") {
    sendJson(res, 200, (await readBackgroundReports(root)).docqa);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/graph") {
    sendJson(res, 200, buildDocumentationGraph(root));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/doctor") {
    sendJson(res, 200, (await readBackgroundReports(root)).doctor);
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/doctor/ack") {
    const body = await readJsonBody(req);
    sendJson(res, 200, acknowledgeContextHealthIssue(root, { key: body.key, note: body.note }));
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
  if (req.method === "GET" && url.pathname === "/api/docqa/review-deletions") {
    sendJson(res, 200, buildDeletedReviewBatch(root));
    return;
  }
  if (req.method === "POST" && url.pathname === "/api/docqa/review-deletions") {
    const body = await readJsonBody(req);
    if (typeof body.key !== "string" || !body.key) {
      const error = new Error("Removed review batch key is required.");
      error.statusCode = 400;
      throw error;
    }
    const result = writeDeletedReviewBatchDecision(root, body.paths, {
      note: body.note,
      expectedKey: body.key,
      protectedAcknowledged: body.protectedAcknowledged === true,
    });
    sendJson(res, 200, { ...result, docqa: buildDocQaReportFromSnapshot(root) });
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
    sendJson(res, 200, await readBackgroundFileTask("file-diff", root, { path: relPath }));
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/file/review-base") {
    const relPath = url.searchParams.get("path") || "";
    sendJson(res, 200, await readBackgroundFileTask("review-base", root, { path: relPath }));
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
  return isProjectTextFile(relPath);
}

function isProjectTextFile(relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  const base = path.basename(normalized);
  const ext = path.extname(base);
  return isSensitiveProjectFile(normalized) || SAFE_ENV_SAMPLE_FILENAMES.has(base) || PROJECT_TEXT_EXTENSIONS.has(ext) || PROJECT_TEXT_FILENAMES.has(base);
}

function fileKindForPath(relPath) {
  if (isSensitiveProjectFile(relPath)) return "secret";
  const ext = path.extname(normalizeRelPath(String(relPath || ""))).toLowerCase();
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".md" || ext === ".mdx" || ext === ".txt") return "markdown";
  return "text";
}

function isProjectReadableMemoryPath(relPath, root = process.cwd()) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  const contextRoomRuntime = normalized.startsWith(CONFIG_DIR + "/");
  if (normalized.startsWith("~") || (isBlockedPath(normalized) && !isSafeEnvSamplePath(normalized)) || (hasSkippedPathSegment(normalized) && !contextRoomRuntime)) return false;
  if (!isProjectTextFile(normalized)) return false;
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, normalized);
  if (abs === resolvedRoot || !abs.startsWith(`${resolvedRoot}${path.sep}`)) return false;
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
  return fs.statSync(abs).size <= MAX_FILE_BYTES;
}

function resolveProjectReadableMemoryPath(root, relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!isProjectReadableMemoryPath(normalized, root)) throw new Error(`Path not allowed in context room: ${relPath}`);
  return path.resolve(root, normalized);
}

function isSensitiveProjectFile(relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  const base = path.basename(normalized);
  if (!base.startsWith(".env")) return false;
  if (SAFE_ENV_SAMPLE_FILENAMES.has(base)) return false;
  return base === ".env" || base.startsWith(".env.");
}

function isSafeEnvSamplePath(relPath) {
  return SAFE_ENV_SAMPLE_FILENAMES.has(path.basename(normalizeRelPath(String(relPath || ""))));
}

function readSensitiveProjectFile(root, relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!isSensitiveProjectFile(normalized)) throw new Error(`Not a sensitive project file: ${relPath}`);
  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, normalized);
  if (abs === resolvedRoot || !abs.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`Path not allowed in context room: ${relPath}`);
  if (!fs.existsSync(abs)) {
    return { path: normalized, content: "", exists: false, updatedAt: null, chars: 0, contentHash: hashContent(""), readOnly: true, sensitive: true, redacted: true };
  }
  const stats = fs.statSync(abs);
  if (!stats.isFile()) throw new Error(`Not a file: ${relPath}`);
  if (stats.size > MAX_FILE_BYTES) throw new Error(`File too large for context room: ${relPath}`);
  const content = redactedSensitiveFileContent(abs, normalized);
  return {
    path: normalized,
    content,
    exists: true,
    updatedAt: stats.mtime.toISOString(),
    chars: content.length,
    contentHash: hashContent(content),
    readOnly: true,
    sensitive: true,
    redacted: true,
  };
}

function redactedSensitiveFileContent(abs, relPath) {
  const raw = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf8") : "";
  const keys = envKeysFromContent(raw);
  const keyLines = keys.length
    ? keys.map((key) => `- \`${key}\`: [redacted]`).join("\n")
    : "- No variable names detected.";
  return `# Sensitive file: ${relPath}

> Context Room intentionally never exposes raw secret values through its API.
> This view lists variable names only, so agents cannot retrieve secret values from Context Room commands.

## Variables

${keyLines}
`;
}

function sensitiveFileSummary(abs) {
  const raw = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf8") : "";
  const count = envKeysFromContent(raw).length;
  return `Sensitive env file · ${count} variable${count === 1 ? "" : "s"} · values redacted`;
}

function envKeysFromContent(content) {
  const keys = [];
  const seen = new Set();
  for (const line of String(content || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || seen.has(match[1])) continue;
    seen.add(match[1]);
    keys.push(match[1]);
  }
  return keys;
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

function walkProjectExplorerTextFiles(root, { showHiddenFiles = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const results = [];
  const walk = (dir) => {
    if (results.length >= PROJECT_EXPLORER_MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= PROJECT_EXPLORER_MAX_FILES) return;
      if (PROJECT_EXPLORER_SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      const rel = path.relative(resolvedRoot, abs).replaceAll(path.sep, "/");
      if (!rel || rel.startsWith("../") || rel.includes("/../")) continue;
      if (!showHiddenFiles && entry.name.startsWith(".")) continue;
      if (isBlockedPath(rel) && !isSensitiveProjectFile(rel) && !isSafeEnvSamplePath(rel)) continue;
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && isProjectTextFile(rel)) {
        try {
          if (fs.statSync(abs).size <= MAX_FILE_BYTES) results.push(rel);
        } catch {}
      }
    }
  };
  walk(resolvedRoot);
  return results;
}

function isHiddenProjectPath(relPath) {
  const normalized = normalizeRelPath(String(relPath || ""));
  if (!normalized || normalized.startsWith("~")) return false;
  return normalized.split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..");
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
  const normalized = normalizeRelPath(String(relPath || ""));
  if (path.isAbsolute(normalized)) return "external/absolute/" + normalized.replace(/^\/+/, "").replaceAll(":", "_");
  return normalized.replace(/^~\/\.hermes\//, "external/hermes/").replace(/^~\//, "external/home/");
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

export function renderFileActionButtons({ reviewAction = null, nextReviewAction = null, dirty = false, deletable = true, savable = true } = {}) {
  return '<div class="file-actions">' +
    (reviewAction ? '<button class="file-action" type="button" data-file-review-decision="' + escapeHtmlServer(reviewAction.status) + '">' + escapeHtmlServer(reviewAction.label) + '</button>' : '') +
    (nextReviewAction ? '<button class="file-action" type="button" data-next-review>' + escapeHtmlServer(nextReviewAction.label) + '</button>' : '') +
    (deletable ? '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' : '') +
    (savable ? '<button class="file-action primary" type="button" data-file-save ' + (!dirty ? 'disabled' : '') + '>Save</button>' : '') +
  '</div>';
}

export function renderReviewSummary(summary = {}) {
  const changed = Number(summary.changedDocs || 0).toLocaleString("en-US");
  const needsReview = Number(summary.needsReview || 0).toLocaleString("en-US");
  return '<div class="review-summary-item"><strong>' + needsReview + '</strong><span>to review</span></div>' +
    '<div class="review-summary-item"><strong>' + changed + '</strong><span>changed</span></div>';
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
      --bg: #101416;
      --panel: rgba(21, 27, 29, 0.94);
      --panel-strong: rgba(27, 34, 36, 0.98);
      --line: rgba(207, 220, 217, 0.14);
      --text: #edf2f0;
      --muted: #96a39f;
      --accent: #67c6d3;
      --accent-2: #e2b866;
      --good: #72d39a;
      --danger: #ee8793;
      --on-accent: #091315;
      --shadow: 0 16px 42px rgba(0, 0, 0, 0.28);
      --body-glow-1: rgba(103, 198, 211, 0.12);
      --body-glow-2: rgba(226, 184, 102, 0.08);
      --body-glow-3: rgba(103, 198, 211, 0.08);
      --body-glow-4: rgba(114, 211, 154, 0.06);
      --star-dot: rgba(237, 242, 240, 0.28);
      --star-opacity: 0.08;
      --surface-wash: rgba(13, 18, 20, 0.44);
      --surface-sidebar: rgba(14, 19, 21, 0.96);
      --surface-floating: rgba(22, 28, 30, 0.98);
      --surface-floating-soft: rgba(22, 28, 30, 0.9);
      --surface-card: rgba(237, 242, 240, 0.04);
      --surface-card-hover: rgba(103, 198, 211, 0.09);
      --surface-reader: rgba(12, 17, 19, 0.72);
      --label-strong: #dbe5e2;
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
      --file-panel-bg: rgba(16, 22, 24, 0.94);
      --file-header-bg: rgba(24, 31, 33, 0.98);
      --file-bg: rgba(11, 16, 18, 0.88);
      --file-fg: #edf2f0;
      --file-muted: #96a39f;
      --file-line: rgba(207, 220, 217, 0.14);
      --file-h1: #67c6d3;
      --file-h2: #e2b866;
      --file-h3: #72d39a;
      --file-h4: #e7a5ad;
      --file-code: #efbf76;
      --file-quote: #a7b5b1;
      --file-list: #75ccd7;
      --file-marker: #697672;
      --file-hr: rgba(103, 198, 211, 0.3);
      font-family: "Avenir Next", Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
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
    .app { position: relative; z-index: 1; display: grid; grid-template-columns: 390px 1fr; height: 100vh; min-height: 0; overflow: hidden; transition: grid-template-columns 260ms ease, opacity 120ms ease; }
    .app.sidebar-collapsed { grid-template-columns: 76px 1fr; }
    aside { border-right: 1px solid var(--line); padding: var(--space-4) var(--space-5); background: var(--surface-sidebar); backdrop-filter: blur(22px); height: 100vh; min-height: 0; overflow: auto; display: block; transition: padding 260ms ease, background 260ms ease; }
    .app.sidebar-collapsed aside { padding: var(--space-4) var(--space-2); overflow: visible; }
    .app.sidebar-collapsed .sidebar-toggle { position: fixed; left: 16px; top: 16px; z-index: 20; background: var(--surface-floating); }
    .sidebar-head { display: grid; grid-template-columns: 1fr auto; gap: var(--space-3); align-items: start; }
    .sidebar-toggle { border: 1px solid rgba(139,211,255,0.28); border-radius: 14px; background: rgba(255,255,255,0.06); color: var(--text); width: 42px; height: 42px; cursor: pointer; box-shadow: 0 0 28px rgba(139,211,255,0.12); transition: transform 160ms ease, background 160ms ease; }
    .sidebar-toggle:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .explorer-open { display: none; border: 1px solid rgba(139,211,255,0.28); border-radius: 14px; background: rgba(255,255,255,0.06); color: var(--text); width: 42px; height: 42px; cursor: pointer; align-items: center; justify-content: center; box-shadow: 0 0 28px rgba(139,211,255,0.12); transition: transform 160ms ease, background 160ms ease; }
    .explorer-open:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .app.sidebar-collapsed .sidebar-copy, .app.sidebar-collapsed .search-row, .app.sidebar-collapsed .watch-filter-row, .app.sidebar-collapsed .selection-bar, .app.sidebar-collapsed .explorer-title, .app.sidebar-collapsed .tree, .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateX(-10px); }
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
	    .file-load-state { min-height: min(56vh, 520px); display: grid; place-items: center; padding: var(--space-6); color: var(--muted); background: var(--file-bg); }
	    .file-load-state-inner { max-width: 520px; display: grid; gap: var(--space-3); text-align: center; }
	    .file-load-state strong { color: var(--text); font-size: 15px; }
	    .file-load-state code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
	    .file-load-state.error { color: #ffc0c8; }
	    .file-load-state.error strong { color: #ffd9df; }
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
    .review-list.batch-open { max-height: min(58vh, 560px); }
    .review-item { border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 16px; background: var(--surface-card); color: var(--text); text-align: left; padding: var(--space-4); cursor: pointer; display: grid; gap: var(--space-2); }
    .review-item:hover, .review-item.active { border-color: color-mix(in srgb, var(--accent) 42%, transparent); background: var(--surface-card-hover); transform: translateX(2px); }
    .review-deletion-batch { border: 1px solid color-mix(in srgb, var(--danger) 28%, var(--line)); border-left: 3px solid var(--danger); border-radius: 14px; background: color-mix(in srgb, var(--surface-card) 92%, var(--danger) 8%); overflow: clip; }
    .review-deletion-batch > summary { list-style: none; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 12px 14px; color: var(--text); cursor: pointer; }
    .review-deletion-batch > summary::-webkit-details-marker { display: none; }
    .review-deletion-batch > summary:focus-visible { outline: 2px solid color-mix(in srgb, var(--danger) 74%, transparent); outline-offset: -2px; }
    .review-deletion-count { color: var(--danger); font-size: 22px; font-weight: 950; font-variant-numeric: tabular-nums; line-height: 1; }
    .review-deletion-heading { min-width: 0; display: grid; gap: 2px; }
    .review-deletion-heading strong { font-size: 13px; line-height: 1.2; }
    .review-deletion-heading span { color: var(--muted); font-size: 11px; line-height: 1.35; }
    .review-deletion-chevron { color: var(--muted); font-size: 14px; transition: transform 160ms ease; }
    .review-deletion-batch[open] .review-deletion-chevron { transform: rotate(90deg); }
    .review-deletion-body { display: grid; gap: 10px; padding: 10px 12px 12px; border-top: 1px solid color-mix(in srgb, var(--danger) 18%, var(--line)); }
    .review-deletion-note { margin: 0; color: var(--muted); font-size: 11px; line-height: 1.45; }
    .review-deletion-toolbar, .review-deletion-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
    .review-deletion-toolbar span { color: var(--label-strong); font-size: 11px; font-weight: 800; }
    .review-deletion-toolbar-buttons { display: flex; gap: 6px; }
    .review-deletion-tool, .review-deletion-open { border: 1px solid var(--line); border-radius: 6px; background: var(--surface-card); color: var(--muted); padding: 5px 7px; cursor: pointer; font-size: 10px; font-weight: 800; }
    .review-deletion-tool:hover, .review-deletion-open:hover { border-color: color-mix(in srgb, var(--accent) 38%, transparent); color: var(--text); background: var(--surface-card-hover); }
    .review-deletion-paths { display: grid; gap: 1px; }
    .review-deletion-row { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 7px 8px; border-radius: 6px; background: color-mix(in srgb, var(--surface-card) 82%, transparent); }
    .review-deletion-row:hover { background: color-mix(in srgb, var(--danger) 7%, var(--surface-card)); }
    .review-deletion-selector { min-width: 0; display: flex; gap: 8px; align-items: center; cursor: pointer; }
    .review-deletion-selector input { flex: 0 0 auto; accent-color: var(--danger); }
    .review-deletion-selector code { min-width: 0; color: var(--label-strong); font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .review-deletion-protected { flex: 0 0 auto; color: var(--danger); font-size: 9px; font-weight: 900; letter-spacing: 0.06em; text-transform: uppercase; }
    .review-deletion-actions { position: sticky; bottom: 0; margin: 0 -12px -12px; padding: 9px 12px; border-top: 1px solid color-mix(in srgb, var(--danger) 16%, var(--line)); background: var(--panel); }
    .review-deletion-actions span { color: var(--muted); font-size: 11px; }
    .review-deletion-confirm { border: 1px solid color-mix(in srgb, var(--danger) 42%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--danger) 12%, var(--surface-card)); color: var(--danger); padding: 7px 10px; cursor: pointer; font-size: 11px; font-weight: 900; }
    .review-deletion-confirm:hover { background: color-mix(in srgb, var(--danger) 20%, var(--surface-card)); }
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
	    .context-health-alert { display: flex; align-items: center; justify-content: space-between; gap: 12px; border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--accent) 8%, transparent); padding: 10px 12px; color: var(--text); }
	    .context-health-alert strong { font-size: 14px; line-height: 1.2; }
	    .context-health-alert span { color: var(--muted); font-size: 12px; white-space: nowrap; }
	    .context-health-issue { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
	    .context-health-issue-copy { min-width: 0; line-height: 1.35; }
	    .context-health-ok { min-height: 30px; padding: 6px 10px; border-radius: 10px; flex: 0 0 auto; }
	    .docqa-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .markdown-tools { padding: var(--panel-body-padding); display: grid; gap: var(--space-4); }
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
    .settings-panel { padding: 20px; display: grid; gap: 0; }
    .settings-shell { min-width: 0; min-height: calc(100dvh - 190px); border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: clip; }
    .settings-tabs { position: sticky; top: 0; z-index: 10; display: flex; min-width: 0; overflow-x: auto; scrollbar-width: thin; border-bottom: 1px solid var(--line); background: var(--surface-floating); }
    .settings-tab { flex: 1 0 128px; min-width: 0; min-height: 52px; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 9px 12px; border: 0; border-right: 1px solid var(--line); border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); text-align: left; cursor: pointer; }
    .settings-tab:last-child { border-right: 0; }
    .settings-tab:hover { color: var(--text); background: color-mix(in srgb, var(--accent) 7%, transparent); }
    .settings-tab[aria-selected="true"] { color: var(--label-strong); border-bottom-color: var(--accent); background: color-mix(in srgb, var(--accent) 11%, transparent); }
    .settings-tab strong { min-width: 0; font-size: 12px; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .settings-tab small { border: 1px solid var(--line); border-radius: 4px; padding: 2px 4px; color: var(--muted); font-size: 8px; font-weight: 800; line-height: 1; text-transform: uppercase; }
    .settings-tab[aria-selected="true"] small { border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent); }
    .settings-content { min-width: 0; }
    .settings-section { min-width: 0; background: transparent; animation: settingsPanelEnter 180ms ease both; }
    .settings-section[hidden] { display: none; }
    .settings-section-head { display: flex; justify-content: space-between; gap: var(--space-4); align-items: flex-start; padding: var(--space-4) var(--space-5); border-bottom: 1px solid color-mix(in srgb, var(--line) 84%, transparent); background: color-mix(in srgb, var(--surface-floating-soft) 58%, transparent); }
    .settings-section-title { display: grid; gap: var(--space-2); min-width: 0; }
    .settings-section-title h3 { margin: 0; color: var(--label-strong); font-size: 16px; line-height: 1.2; letter-spacing: 0; }
    .settings-kicker, .settings-title { color: var(--accent); font-size: 10px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.12em; }
    .settings-section-copy { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.4; }
    .settings-section-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .settings-pill { border: 1px solid color-mix(in srgb, var(--accent) 28%, transparent); border-radius: 999px; padding: var(--space-2) var(--space-3); color: var(--label-strong); background: color-mix(in srgb, var(--accent) 9%, transparent); font-size: 11px; font-weight: 850; line-height: 1; white-space: nowrap; }
    .settings-section-body { padding: var(--space-4) var(--space-5) var(--space-5); display: grid; gap: var(--space-4); }
    .settings-group { display: grid; gap: var(--space-3); }
    .settings-group + .settings-group { padding-top: var(--space-4); border-top: 1px solid var(--line); }
    .settings-group-title { margin: 0; color: var(--label-strong); font-size: 13px; line-height: 1.2; }
    .settings-input-label { color: var(--muted); font-size: 10px; font-weight: 800; text-transform: uppercase; }
    @keyframes settingsPanelEnter { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
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
    .startup-hook-item > span { display: grid; gap: 6px; }
    .startup-hook-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .startup-hook-kind { width: fit-content; border: 1px solid color-mix(in srgb, var(--accent) 32%, transparent); border-radius: 999px; padding: 2px 7px; background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); font-size: 10px; line-height: 1.2; font-weight: 950; letter-spacing: 0.08em; text-transform: uppercase; }
    .startup-hook-kind.claude { border-color: color-mix(in srgb, #d19a66 36%, transparent); background: color-mix(in srgb, #d19a66 12%, transparent); color: #d19a66; }
    .startup-hook-kind.opencode { border-color: color-mix(in srgb, #98c379 32%, transparent); background: color-mix(in srgb, #98c379 10%, transparent); color: #98c379; }
    .startup-hook-kind.git { border-color: color-mix(in srgb, #d19a66 36%, transparent); background: color-mix(in srgb, #d19a66 12%, transparent); color: #d19a66; }
    .startup-hook-kind.manager { border-color: color-mix(in srgb, var(--danger) 34%, transparent); background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); }
    .startup-hook-item code { color: var(--text); font: inherit; overflow-wrap: anywhere; }
    .startup-hook-item p { margin: 0; color: var(--muted); font-size: 12px; line-height: 1.45; text-transform: none; letter-spacing: 0; }
    .startup-hook-item em { color: var(--muted); font-style: normal; font-size: 11px; line-height: 1.35; }
    .startup-hook-item small { color: var(--accent); font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .startup-hook-filters { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .startup-hook-filter { border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 999px; padding: 6px 9px; background: var(--surface-card); color: var(--muted); cursor: pointer; font-size: 11px; font-weight: 900; line-height: 1; }
    .startup-hook-filter:hover { border-color: color-mix(in srgb, var(--accent) 38%, transparent); color: var(--text); background: var(--surface-card-hover); }
    .startup-hook-filter.active { border-color: color-mix(in srgb, var(--accent) 52%, transparent); background: color-mix(in srgb, var(--accent) 16%, var(--surface-card)); color: var(--accent); }
    .startup-hooks-help { border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--surface-card) 88%, var(--accent) 6%); overflow: hidden; }
    .startup-hooks-help summary { min-height: 34px; display: flex; align-items: center; gap: 8px; padding: 7px 10px; color: var(--muted); cursor: pointer; list-style: none; font-size: 12px; font-weight: 850; }
    .startup-hooks-help summary::-webkit-details-marker { display: none; }
    .startup-hooks-help summary::before { content: "i"; width: 18px; height: 18px; display: inline-grid; place-items: center; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent); color: var(--accent); font: 900 12px/1 ui-sans-serif, system-ui, sans-serif; }
    .startup-hooks-help[open] summary { color: var(--text); border-bottom: 1px solid color-mix(in srgb, var(--line) 86%, transparent); }
    .startup-hooks-help > div { display: grid; gap: 10px; padding: 10px; color: var(--muted); font-size: 12px; line-height: 1.45; }
    .startup-hooks-help-section { display: grid; gap: 6px; border: 1px solid color-mix(in srgb, var(--line) 78%, transparent); border-radius: 12px; padding: 9px; background: color-mix(in srgb, var(--surface-card) 82%, transparent); }
    .startup-hooks-help-section h4 { margin: 0; color: var(--text); font-size: 12px; line-height: 1.25; }
    .startup-hooks-help p { margin: 0; }
    .startup-hooks-help strong { color: var(--text); font-weight: 900; }
    .startup-hooks-help ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
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
    .launch-card.spotlight-active::before, .launch-card:focus-within::before, .review-item.spotlight-active::before, .review-item:focus-within::before, .hub-folder-card.spotlight-active::before, .hub-folder-card:focus-within::before, .startup-context-item.spotlight-active::before, .startup-context-item:focus-within::before, .settings-toggle.spotlight-active::before, .settings-toggle:focus-within::before, .settings-theme-preview.spotlight-active::before, .settings-theme-preview:focus-within::before, .template-editor.spotlight-active::before, .template-editor:focus-within::before, .hub-section-editor.spotlight-active::before, .hub-section-editor:focus-within::before, .hub-card-editor.spotlight-active::before, .hub-card-editor:focus-within::before, .path-picker.spotlight-active::before, .path-picker:focus-within::before, .card.spotlight-active::before, .card:focus-within::before, .conflict-card.spotlight-active::before, .conflict-card:focus-within::before { opacity: 1; }
    .launch-card > *, .review-item > *, .hub-folder-card > *, .startup-context-item > *, .settings-section > *, .settings-toggle > *, .settings-theme-preview > *, .template-editor > *, .hub-section-editor > *, .hub-card-editor > *, .path-picker > *, .card > *, .conflict-card > * { position: relative; z-index: 1; }
    .selection-bar { margin: 6px 0 8px; padding: 5px 6px 5px 10px; border: 1px solid color-mix(in srgb, var(--accent) 18%, transparent); border-radius: 999px; background: var(--surface-floating-soft); display: flex; gap: 8px; align-items: center; justify-content: space-between; box-shadow: 0 10px 28px rgba(0,0,0,0.18); }
    .selection-bar[hidden] { display: none; }
    .selection-summary { min-width: 0; color: var(--label-strong); font-size: 11px; font-weight: 850; letter-spacing: 0.02em; white-space: nowrap; }
    .selection-actions { display: flex; gap: 4px; align-items: center; }
    .selection-action { width: 28px; height: 28px; padding: 0; border: 1px solid rgba(148,163,184,0.18); border-radius: 999px; background: rgba(255,255,255,0.045); color: var(--muted); font-size: 13px; line-height: 1; cursor: pointer; display: grid; place-items: center; }
    .selection-action:hover { color: var(--text); background: rgba(139,211,255,0.10); transform: translateY(-1px); }
    .selection-action.danger-action { border-color: rgba(255,140,157,0.24) !important; color: #ffb5c0 !important; }
    .tree-empty { margin: var(--space-3) 0; padding: var(--space-3); border: 1px solid color-mix(in srgb, var(--line) 88%, transparent); border-radius: 14px; background: var(--surface-card); color: var(--muted); font-size: 12px; line-height: 1.4; }
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
    .plain-text-editor, .plain-text-view { margin: 0; white-space: pre; overflow: auto; tab-size: 2; font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .plain-text-editor { display: block; width: 100%; min-height: 100%; resize: none; border: 0; outline: none; background: var(--file-bg); color: var(--file-fg); padding: 18px 22px; }
    .html-preview-shell { width: 100%; min-height: calc(100vh - 162px); max-height: calc(100vh - 162px); overflow: hidden; background: var(--file-bg); }
    .html-preview-frame { display: block; width: 100%; height: calc(100vh - 162px); min-height: 420px; border: 0; background: var(--file-bg); }
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
    .external-review-doc { white-space: normal; background: var(--file-bg); overflow-anchor: none; }
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
    .external-review-line.add { background: rgba(48,215,111,0.065); }
    .external-review-line.add::before { color: #8df0b4; }
    .external-review-line.del { background: rgba(255,86,117,0.065); }
    .external-review-line.del::before { color: #ff9cac; }
    .external-review-token { border-radius: 3px; padding: 0 1px; box-decoration-break: clone; -webkit-box-decoration-break: clone; }
    .external-review-token.add { background: rgba(48,215,111,0.32); box-shadow: inset 0 -1px 0 rgba(141,240,180,0.5); }
    .external-review-token.del { background: rgba(255,86,117,0.3); box-shadow: inset 0 -1px 0 rgba(255,156,172,0.48); text-decoration: line-through; text-decoration-thickness: 1px; }
    .external-review-line.intraline-superseded { display: none; }
    .external-review-line.intraline-merged { background: transparent; }
    .external-review-line.intraline-removal::before { color: #ff9cac; }
    .external-review-line.intraline-mixed::before { color: #d8c4ff; }
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
    .file-actions-loading { min-width: min(340px, 44vw); min-height: 36px; justify-content: flex-end; pointer-events: none; }
    .file-action-placeholder { width: 82px; height: 32px; border: 1px solid color-mix(in srgb, var(--line) 82%, transparent); border-radius: 7px; background: color-mix(in srgb, var(--surface-card) 82%, transparent); animation: fileActionLoadingPulse 1.1s ease-in-out infinite alternate; }
    .file-action-placeholder.wide { width: 112px; }
    .file-action-placeholder.short { width: 60px; }
    .file-action { border: 1px solid rgba(148,163,184,0.18); border-radius: 12px; padding: var(--space-2) var(--space-3); min-height: 36px; background: rgba(255,255,255,0.06); color: var(--text); font-weight: 850; cursor: pointer; }
    .file-action:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .file-action.primary { color: var(--on-accent); border: 0; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
    .confirm-backdrop { position: fixed; inset: 0; z-index: 90; display: grid; place-items: center; padding: var(--space-5); background: rgba(2,6,23,0.72); backdrop-filter: blur(14px); }
    .confirm-dialog { width: min(420px, 100%); border: 1px solid var(--line); border-radius: 18px; background: var(--surface-floating); box-shadow: 0 22px 80px rgba(0,0,0,0.45); padding: var(--space-6); color: var(--text); }
    .confirm-dialog strong { display: block; font-size: 18px; line-height: 1.2; margin-bottom: 8px; }
	    .confirm-dialog p { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.45; overflow-wrap: anywhere; }
	    .confirm-option { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; color: var(--text); font-size: 13px; line-height: 1.35; }
	    .confirm-option input { margin-top: 2px; accent-color: var(--accent); }
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
    @keyframes fileActionLoadingPulse { from { opacity: 0.38; } to { opacity: 0.72; } }
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

    /* Compact documentation workbench */
    *, *::before, *::after { letter-spacing: 0 !important; }
    body { background: var(--bg); }
    body::before {
      background-image:
        linear-gradient(to right, color-mix(in srgb, var(--line) 46%, transparent) 1px, transparent 1px),
        linear-gradient(to bottom, color-mix(in srgb, var(--line) 38%, transparent) 1px, transparent 1px);
      background-size: 32px 32px;
      opacity: 0.24;
      animation: workbenchGridDrift 28s linear infinite;
    }
    html.ui-scrolling body::before { animation-play-state: paused; }
    body::after { display: none; }
    @keyframes workbenchGridDrift { to { transform: translate(-32px, -32px); } }
    .app { grid-template-columns: 320px minmax(0, 1fr); }
    .app.sidebar-collapsed { grid-template-columns: 56px minmax(0, 1fr); }
    aside { padding: 12px; background: var(--surface-sidebar); backdrop-filter: none; }
    .app.sidebar-collapsed aside { padding: 10px 7px; }
    .app.sidebar-collapsed .sidebar-copy,
    .app.sidebar-collapsed .search-row,
    .app.sidebar-collapsed .watch-filter-row,
    .app.sidebar-collapsed .selection-bar,
    .app.sidebar-collapsed .explorer-title,
    .app.sidebar-collapsed .tree,
    .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateX(-8px); }
    .sidebar-head { align-items: center; }
    .sidebar-copy h1 { font-size: 18px; margin: 0; }
    .sidebar-toggle, .explorer-open { width: 36px; height: 36px; border-radius: 7px; box-shadow: none; }
    @media (min-width: 981px) {
      .app.sidebar-collapsed .sidebar-head { width: 100%; display: flex; justify-content: center; align-items: center; }
      .app.sidebar-collapsed .sidebar-copy { display: none; }
      .app.sidebar-collapsed .sidebar-toggle { position: static; inset: auto; flex: 0 0 36px; margin: 0 auto; }
    }
    .search-row { margin: 12px 0 8px; }
    .search, .clear-search { min-height: 36px; border-radius: 7px; padding: 8px 10px; }
    .watch-filter { min-height: 24px; border-radius: 6px; padding: 4px 7px; }
    .watch-filter.active { background: color-mix(in srgb, var(--accent) 22%, var(--surface-card)); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
    .explorer-title { margin: 12px 7px 5px; color: var(--muted); }
    .tree { font-size: 12px; }
    .tree-row { min-height: 30px; border-radius: 5px; padding: 5px 7px; }
    .tree-row:hover { transform: none; background: color-mix(in srgb, var(--accent) 8%, transparent); }
    .tree-row.active { border-color: color-mix(in srgb, var(--accent) 36%, transparent); background: color-mix(in srgb, var(--accent) 13%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
    main { padding: 12px; grid-template-rows: auto minmax(0, 1fr); gap: 8px; }
    .workspace-dock {
      width: 100%; min-height: 44px; margin: 0; padding: 4px; gap: 4px; flex-wrap: nowrap;
      border-radius: 8px; background: var(--surface-floating-soft); box-shadow: none;
    }
    .dock-button { min-width: 34px; min-height: 34px; border-radius: 6px; padding: 0 10px; font-size: 12px; }
    .dock-button:hover { transform: none; background: color-mix(in srgb, var(--accent) 12%, transparent); }
    .dock-button.primary, button.primary, .file-action.primary {
      background: var(--accent); color: var(--on-accent); box-shadow: none;
    }
    .dock-button.diff-dock-button.active, .mode-toggle button.active { background: var(--accent); color: var(--on-accent); }
    .workspace-title { min-width: 0; margin-left: auto; padding: 0 8px; color: var(--muted); font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .topbar { border-radius: 8px; box-shadow: none; backdrop-filter: none; }
    .editor-shell { border: 0; border-radius: 0; background: transparent; box-shadow: none; backdrop-filter: none; }
    .docqa-home, .settings-page { padding: 14px; border: 0; background: transparent; box-shadow: none; }
    .docqa-grid { gap: 12px; }
    .docqa-panel { border-radius: 8px; background: var(--panel); box-shadow: none; }
    .docqa-panel header { padding: 12px 14px; align-items: center; }
    .docqa-panel h2 { font-size: 15px; }
    .review-summary { gap: 14px; flex-wrap: nowrap; }
    .review-summary-item { min-width: 0; border: 0; border-radius: 0; background: transparent; padding: 0; display: flex; align-items: baseline; gap: 5px; }
    .review-summary-item strong { font-size: 18px; color: var(--accent); }
    .review-summary-item:first-child strong { color: var(--accent-2); }
    .review-summary-item span { margin: 0; font-size: 11px; text-transform: none; color: var(--muted); }
    .review-list { gap: 0; padding: 0; max-height: min(34vh, 300px); }
    .review-item { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; padding: 10px 14px; gap: 4px; }
    .review-deletion-batch { border-top: 0; border-right: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: color-mix(in srgb, var(--danger) 4%, transparent); }
    .review-item:last-child { border-bottom: 0; }
    .review-item:hover, .review-item.active { transform: none; background: color-mix(in srgb, var(--accent) 7%, transparent); box-shadow: inset 2px 0 0 var(--accent); }
    .review-title { font-size: 13px; }
    .review-path { font-size: 10px; }
    .review-item .chip { border: 0; border-radius: 4px; padding: 2px 5px; background: transparent; color: var(--muted); }
    .review-item .chip.high { color: var(--accent-2); background: color-mix(in srgb, var(--accent-2) 9%, transparent); }
    .hub-folders { margin-top: 12px; gap: 12px; }
    .hub-section { gap: 8px; padding-top: 12px; border-top-color: var(--line); }
    .hub-section-title { color: var(--muted); font-size: 10px; }
    .hub-section-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 8px; }
    .hub-folder-card, .hub-folder-card.navigation, .hub-folder-card.expanded, .hub-folder-card.current {
      min-height: 88px; border-radius: 8px; background: var(--surface-card); box-shadow: none;
    }
    .hub-folder-card:hover { transform: translateY(-1px); background: var(--surface-card-hover); }
    .hub-folder-card-main, .hub-folder-card.expanded > .hub-folder-card-main { min-height: 88px; border-radius: 8px; padding: 13px; gap: 10px; }
    .hub-folder-card strong { font-size: 15px; line-height: 1.2; }
    .hub-folder-card span { font-size: 11px; line-height: 1.35; }
    .hub-folder-card code, .hub-folder-meta { font-size: 10px; }
    .hub-folder-children { padding: 0 8px 8px; gap: 8px; }
    .hub-folder-children-grid { gap: 8px; }
    .hub-folder-children .hub-folder-card, .hub-folder-children .hub-folder-card-main { min-height: 76px; }
    .hub-breadcrumb { border-radius: 8px; background: var(--surface-card); }
    .hub-crumb { border-radius: 5px; }
    .hub-disclosure, .docqa-disclosure { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); overflow: hidden; }
    .hub-disclosure { display: block; padding: 0; }
    .hub-disclosure summary, .docqa-disclosure summary {
      min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 12px;
      padding: 10px 12px; cursor: pointer; list-style: none; color: var(--text);
    }
    .hub-disclosure summary::-webkit-details-marker, .docqa-disclosure summary::-webkit-details-marker { display: none; }
    .hub-disclosure summary::before, .docqa-disclosure summary::before { content: "›"; color: var(--muted); font-size: 18px; transition: transform 160ms ease; }
    .hub-disclosure[open] summary::before, .docqa-disclosure[open] summary::before { transform: rotate(90deg); }
    .hub-disclosure-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 800; }
    .hub-disclosure-count, .docqa-disclosure-count { color: var(--muted); font-size: 11px; white-space: nowrap; }
    .hub-disclosure-body { display: grid; gap: 10px; padding: 0 12px 12px; border-top: 1px solid var(--line); }
    .hub-disclosure-body .startup-context-copy { padding-top: 10px; }
    .startup-context-list { gap: 6px; }
    .startup-context-item { border-radius: 6px; padding: 9px 10px; background: var(--surface-card); }
    .startup-context-item:hover { transform: none; }
    .markdown-tools { padding: 12px 14px; }
    .launch-card::before, .review-item::before, .hub-folder-card::before, .startup-context-item::before,
    .settings-toggle::before, .settings-theme-preview::before, .template-editor::before,
    .hub-section-editor::before, .hub-card-editor::before, .path-picker::before, .card::before, .conflict-card::before { display: none; }
    .settings-page .settings-card { max-width: 1160px; border: 0; background: transparent; }
    .settings-page .settings-card > header { padding: 4px 0 12px; border: 0; }
    .settings-card, .settings-toggle, .settings-theme-preview, .template-editor, .hub-section-editor, .hub-card-editor, .path-picker { border-radius: 8px; box-shadow: none; }
    .settings-panel { padding: 0; gap: 10px; }
    .settings-section-head, .settings-section-body { padding: 12px; }
    .settings-toggle { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; background: transparent; }
    .settings-toggle:last-child { border-bottom: 0; }
    .settings-field textarea, .settings-field input, .settings-field select, .markdown-create .settings-field select { border-radius: 6px; }
    .viewer { padding: 0; min-height: 100%; background: transparent; }
    .review-workspace { height: 100%; min-height: 0; gap: 8px; }
    .diff-panel, .file-panel { border-radius: 8px; box-shadow: none; }
    .diff-header, .file-panel header { padding: 10px 12px; gap: 10px; }
    .diff-header strong, .file-panel strong { font-size: 13px; text-transform: none; }
    .file-header-copy { flex: 1 1 auto; }
    .file-actions { min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
    .file-actions-loading { min-width: min(340px, 44vw); flex-wrap: nowrap; }
    .file-action { min-height: 32px; border-radius: 6px; padding: 6px 9px; font-size: 12px; }
    .file-action:hover { transform: none; }
    .diff-code, .doc-content, .doc-editor { padding: 18px 22px; }
    .diff-panel, .file-panel { height: 100%; min-height: 0; display: flex; flex-direction: column; }
    .diff-code, .doc-content, .doc-editor, .external-review-doc, .markdown-editor-shell { flex: 1 1 auto; min-height: 0; max-height: none; }
    .doc-content { max-width: 1040px; margin: 0 auto; font-size: 14px; line-height: 1.68; }
    .file-panel .doc-editor.markdown-view, .file-panel .markdown-editor-input { padding-left: 36px; }
    .file-panel .doc-editor.markdown-view .markdown-line { position: relative; }
    .file-panel .doc-editor.markdown-view .markdown-line::before { content: attr(data-line-number); position: absolute; left: -30px; top: 0.18em; width: 22px; color: color-mix(in srgb, var(--file-muted) 42%, transparent); font: 500 9px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; text-align: right; user-select: none; pointer-events: none; }
    .confirm-dialog, .mode-toggle, .card, .conflict-card { border-radius: 8px; }
    button.primary, button.secondary { border-radius: 6px; }
    @media (max-width: 1180px) {
      .file-panel header { align-items: stretch; flex-direction: column; }
      .file-header-copy { flex: 0 0 auto; }
      .file-actions, .external-review-actions { justify-content: flex-start; width: 100%; }
      .external-change-stats { margin-right: auto; }
    }
    @media (max-width: 980px) {
      .app, .app.sidebar-collapsed { grid-template-columns: 1fr; }
      .app.sidebar-collapsed .workspace-dock { width: 100%; margin: 0; opacity: 1; pointer-events: auto; transform: none; }
      .workspace-dock { margin: 0; }
      main { grid-template-rows: auto minmax(0, 1fr); }
      .docqa-panel header { flex-direction: row; }
      .hub-section-grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 170px), 1fr)); }
    }
    @media (max-width: 640px) {
      main { grid-template-rows: minmax(0, 1fr); }
      .workspace-title { display: none; }
      .docqa-home, .settings-page { padding: 8px; }
      .settings-shell { min-height: calc(100dvh - 126px); }
      .settings-tab { flex-basis: 108px; min-height: 46px; padding: 8px 10px; }
      .settings-tab small { display: none; }
      .settings-section-head { flex-direction: column; gap: 10px; }
      .settings-section-actions { justify-content: flex-start; }
      .docqa-panel, .hub-disclosure, .docqa-disclosure, .editor-shell { border-radius: 7px; }
      .docqa-panel header { align-items: flex-start; flex-direction: column; }
      .review-summary { width: auto; }
      .hub-section-grid { grid-template-columns: 1fr 1fr; }
      .hub-folder-card, .hub-folder-card-main, .hub-folder-card.expanded > .hub-folder-card-main { min-height: 78px; }
      .hub-folder-card-main { padding: 10px; }
      .hub-folder-meta { align-items: start; flex-direction: column; gap: 2px; }
      .startup-context-item { grid-template-columns: 1fr; }
      .diff-code, .doc-content, .doc-editor { padding: 12px; }
      .file-panel .doc-editor.markdown-view, .file-panel .markdown-editor-input { padding-left: 32px; }
      .file-panel .doc-editor.markdown-view .markdown-line::before { left: -27px; width: 20px; font-size: 8px; }
      .file-panel header { padding: 8px; }
    }
    body.app-booting .app { visibility: hidden; opacity: 0; pointer-events: none; }
    .boot-screen { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; background: var(--bg); color: var(--muted); }
    .boot-screen-inner { display: flex; align-items: center; gap: 10px; font: 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .boot-indicator { width: 16px; height: 16px; border: 2px solid color-mix(in srgb, var(--line) 82%, transparent); border-top-color: var(--accent); border-radius: 50%; animation: bootSpin 700ms linear infinite; }
    body:not(.app-booting) .boot-screen { display: none; }
    @keyframes bootSpin { to { transform: rotate(360deg); } }
  </style>
</head>
<body class="app-booting">
  <div id="bootScreen" class="boot-screen" role="status"><div class="boot-screen-inner"><span class="boot-indicator" aria-hidden="true"></span><span>Opening Context Room</span></div></div>
  <div class="app">
    <button id="explorerOpen" class="explorer-open" type="button" title="Open explorer" aria-label="Open explorer">☰</button>
    <aside>
      <div class="sidebar-head">
        <div class="sidebar-copy">
          <h1>Explorer</h1>
        </div>
        <button id="sidebarToggle" class="sidebar-toggle" type="button" title="Collapse explorer" aria-label="Collapse explorer">☰</button>
      </div>
      <div class="search-row">
        <input id="search" class="search" placeholder="Search files..." aria-label="Search files" />
        <button id="clearSearch" class="clear-search" type="button" title="Show all files">All</button>
      </div>
                  <div class="watch-filter-row" aria-label="Explorer watch filter"><button id="watchFilterAll" class="watch-filter active" type="button" data-watch-filter="all" data-watch-label="all">all</button><button id="watchFilterWatched" class="watch-filter" type="button" data-watch-filter="watched" data-watch-label="watched">watched</button><button id="watchFilterUnwatched" class="watch-filter" type="button" data-watch-filter="unwatched" data-watch-label="not watched">not watched</button></div>
      <div id="selectionBar" class="selection-bar" hidden><span id="selectionCount" class="selection-summary">0 selected</span><div class="selection-actions"><button id="watchSelected" class="selection-action" type="button" title="Add selected to watch">👁+</button><button id="unwatchSelected" class="selection-action" type="button" title="Remove selected from watch">👁−</button><button id="clearSelection" class="selection-action" type="button" title="clear selection">×</button><button id="deleteSelected" class="selection-action danger-action" type="button" title="delete selection">⌫</button></div></div>
      <div class="explorer-title">Files</div>
      <div id="files" class="tree"></div>
    </aside>
    <main>
      <div class="workspace-dock" role="toolbar" aria-label="Workspace navigation">
        <button id="hub" class="dock-button" type="button" title="Open settings">Settings</button>
        <button id="back" class="dock-button" type="button" title="Previous file" aria-label="Previous file">←</button>
        <button id="forward" class="dock-button" type="button" title="Next file" aria-label="Next file">→</button>
        <button id="gitDiffToggle" class="dock-button diff-dock-button" type="button" title="Show Git diff" hidden>Show Git diff</button>
        <button id="reload" class="dock-button" type="button" hidden>Reload</button>
        <button id="verifyCurrent" class="dock-button" type="button" hidden>Verified</button>
        <button id="deleteCurrent" class="dock-button danger-action" type="button" hidden>Delete</button>
        <button id="save" class="dock-button primary" hidden disabled>Save</button>
        <div id="workspaceTitle" class="workspace-title">Context Room</div>
        <div id="status" class="dock-status" aria-live="polite">Ready</div>
      </div>
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
                  <h2 id="reviewQueueHeading" tabindex="-1">Review queue</h2>
                </div>
                <div id="reviewSummary" class="review-summary" aria-label="review metrics"></div>
              </header>
              <div id="reviewQueue" class="review-list"></div>
            </section>
            <section id="contextHealthPanel" class="docqa-panel" hidden>
              <header>
                <div>
                  <h2>Context health</h2>
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
                <div class="muted">Project setup and global preferences</div>
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
		const state = { root: null, files: [], startupContextFiles: [], startupSkillFolders: [], startupHookFiles: [], startupHooksHelpOpen: false, startupHookFilter: "all", hubDisclosuresOpen: new Set(), activeStartupSkillExplorer: null, activeStartupContextExplorer: null, startupSkillCreateFolder: null, startupContextContextTarget: null, selectedStartupContext: null, docqa: null, doctor: null, backgroundReportRenderKey: "", settings: null, settingsOpen: false, settingsSection: "review", page: "hub", pendingMarkdown: null, availableHubCards: [], hubFolders: [], hubSections: [], rootHubSections: [], activeHubCardId: null, selectedReview: null, deletionBatchExpanded: false, deletionBatchLoading: false, deletionBatchItems: [], deletionBatchKey: "", deletionBatchReportedCount: 0, deletionBatchError: "", selectedDeletionReviews: new Set(), reviewModePath: null, reviewModeStatus: null, reviewSessions: {}, reviewFinalizationPromise: null, selected: null, selectedReadOnly: false, selectedDiff: null, fileLoadError: null, fileConflict: null, externalChange: null, conflictCompare: false, conflictMergeText: null, conflictMergeKey: "", conflictMergeMode: "auto", diffCollapsed: false, saved: "", savedHash: null, dirty: false, mode: "view", homeView: "root", planetStack: ["root"], filePanel: false, history: [], historyIndex: -1, pathFilters: [], explorerWatchFilter: "all", explorerRenderKey: "", explorerSearchFrame: 0, selectedForDelete: new Set(), selectionRequest: 0, openingFilePath: null, fileContentReadyPath: null, mobileSidebarTouched: false, sessionStateTimer: null, agentCommandTimer: null, lastAgentCommandId: "", pendingAgentCommand: null, agentAnnotations: {}, userActiveAt: 0, userScrollIntentAt: 0, refreshInFlight: false, reportsRefreshInFlight: false, backgroundRefreshTimer: null, filePrefetches: new Map(), prefetchTimer: null, prefetchPath: "", lastDiffRefreshAt: 0, lastReportRefreshAt: 0, lastFullRefreshAt: 0, navigationRestoreAttempted: false, bootStartedAt: Date.now(), bootMilestones: {}, markdownHighlightFrame: 0, markdownHighlightText: "", markdownHighlightLastText: "", docLinkModifierActive: false, expanded: new Set(["data", "automations", "integrations", "skills", "tools", "~", "~/.hermes", "~/.hermes/memories", "~/.hermes/skills"]) };
	const VERIFY_CONFIRM_STORAGE_KEY = "context-room:skip-mark-verified-confirm";
const NAVIGATION_STATE_STORAGE_PREFIX = "context-room:navigation:";
const AGENT_COMMAND_ACK_STORAGE_KEY = "context-room:last-agent-command-id";
const AGENT_COMMAND_MAX_AGE_MS = 60_000;
const FILE_THEMES = ${JSON.stringify(FILE_THEME_OPTIONS)};
const DEFAULT_FILE_THEME = "${DEFAULT_FILE_THEME}";
const SETTINGS_SECTION_IDS = ["review", "startup", "appearance", "templates", "hub"];
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

function prefetchFile(path) {
  if (!path || state.filePrefetches.has(path)) return;
  const filePromise = api("/api/file?path=" + encodeURIComponent(path));
  const diffPromise = api("/api/file/diff?path=" + encodeURIComponent(path));
  const entry = { filePromise, diffPromise, expiresAt: Date.now() + 8_000 };
  state.filePrefetches.set(path, entry);
  Promise.allSettled([filePromise, diffPromise]).then(() => {
    window.setTimeout(() => {
      if (state.filePrefetches.get(path) === entry) state.filePrefetches.delete(path);
    }, Math.max(0, entry.expiresAt - Date.now()));
  });
}

function readFileForOpen(path, { force = false } = {}) {
  const entry = state.filePrefetches.get(path);
  if (!force && entry && entry.expiresAt > Date.now()) return entry.filePromise;
  if (entry) state.filePrefetches.delete(path);
  return api("/api/file?path=" + encodeURIComponent(path));
}

function readDiffForOpen(path, { force = false } = {}) {
  const entry = state.filePrefetches.get(path);
  if (!force && entry && entry.expiresAt > Date.now()) return entry.diffPromise;
  return readSelectedDiff(path);
}

function settleUiRequest(promise) {
  return promise.then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error }),
  );
}

function filePathFromPrefetchTarget(target) {
  const element = target instanceof Element ? target.closest("[data-file-path], [data-review-path], [data-hub-file], [data-main-path], [data-home-file]") : null;
  return element?.dataset.filePath || element?.dataset.reviewPath || element?.dataset.hubFile || element?.dataset.mainPath || element?.dataset.homeFile || "";
}

function schedulePrefetchPathFromTarget(target) {
  const path = filePathFromPrefetchTarget(target);
  if (!path) {
    window.clearTimeout(state.prefetchTimer);
    state.prefetchTimer = null;
    state.prefetchPath = "";
    return;
  }
  if (path === state.prefetchPath && (state.prefetchTimer || state.filePrefetches.has(path))) return;
  window.clearTimeout(state.prefetchTimer);
  state.prefetchPath = path;
  state.prefetchTimer = window.setTimeout(() => {
    state.prefetchTimer = null;
    prefetchFile(path);
  }, 80);
}

function prefetchPathFromTarget(target) {
  const path = filePathFromPrefetchTarget(target);
  if (path) prefetchFile(path);
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
  const themeChanged = document.documentElement.dataset.fileTheme !== clean || document.documentElement.dataset.appTheme !== clean;
  document.documentElement.dataset.fileTheme = clean;
  document.documentElement.dataset.appTheme = clean;
  if (themeChanged && document.querySelector("iframe.html-preview-frame") && isHtmlDocumentPath(state.selected) && state.openingFilePath !== state.selected) {
    const viewState = captureEditorViewState();
    renderViewer();
    restoreEditorViewState(viewState);
  }
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
  state.sessionStateTimer = window.setTimeout(() => {
    persistNavigationState();
    publishSessionState().catch(() => {});
  }, 280);
}

async function publishSessionState() {
  await api("/api/session-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(buildSessionStatePayload()),
  });
}

function navigationStorageKey(root = state.root) {
  return root ? NAVIGATION_STATE_STORAGE_PREFIX + root : "";
}

function readPersistedNavigationState(root = state.root) {
  const key = navigationStorageKey(root);
  if (!key) return null;
  try {
    const raw = JSON.parse(window.localStorage?.getItem(key) || "null");
    if (!raw || raw.version !== 1) return null;
    const page = ["hub", "file", "settings", "new-doc"].includes(raw.page) ? raw.page : "hub";
    return {
      version: 1,
      page,
      selectedPath: normalizeUiPath(raw.selectedPath || ""),
      startup: raw.startup && typeof raw.startup === "object" ? raw.startup : null,
      reviewMode: Boolean(raw.reviewMode),
      diffCollapsed: typeof raw.diffCollapsed === "boolean" ? raw.diffCollapsed : null,
      selectedReview: normalizeUiPath(raw.selectedReview || ""),
      explorerFilter: ["all", "watched", "unwatched"].includes(raw.explorerFilter) ? raw.explorerFilter : "all",
      searchText: typeof raw.searchText === "string" ? raw.searchText.slice(0, 300) : "",
      pathFilters: Array.isArray(raw.pathFilters) ? raw.pathFilters.map(normalizeUiPath).filter(Boolean).slice(0, 20) : [],
      activeHubCardId: typeof raw.activeHubCardId === "string" ? raw.activeHubCardId : null,
      settingsSection: SETTINGS_SECTION_IDS.includes(raw.settingsSection) ? raw.settingsSection : "review",
      pendingMarkdown: raw.pendingMarkdown && typeof raw.pendingMarkdown === "object" ? raw.pendingMarkdown : null,
      viewState: raw.viewState && typeof raw.viewState === "object" ? raw.viewState : null,
    };
  } catch {
    return null;
  }
}

function persistNavigationState() {
  const key = navigationStorageKey();
  if (!key) return;
  try {
    window.localStorage?.setItem(key, JSON.stringify({
      version: 1,
      page: state.page,
      selectedPath: state.selected || null,
      startup: startupSelectionRequest(),
      reviewMode: Boolean(state.reviewModePath && state.reviewModePath === state.selected),
      diffCollapsed: state.diffCollapsed,
      selectedReview: state.selectedReview || null,
      explorerFilter: state.explorerWatchFilter,
      searchText: el("search")?.value || "",
      pathFilters: state.pathFilters || [],
      activeHubCardId: state.activeHubCardId || null,
      settingsSection: normalizeSettingsSectionId(state.settingsSection),
      pendingMarkdown: state.page === "new-doc" ? state.pendingMarkdown : null,
      viewState: state.selected ? captureEditorViewState() : null,
      updatedAt: new Date().toISOString(),
    }));
  } catch {}
}

async function restoreNavigationAfterInitialLoad() {
  if (state.navigationRestoreAttempted || state.selected || state.openingFilePath) return false;
  state.navigationRestoreAttempted = true;
  const persisted = readPersistedNavigationState();
  if (!persisted) return false;
  state.selectedReview = persisted.selectedReview || state.selectedReview;
  state.explorerWatchFilter = persisted.explorerFilter;
  state.pathFilters = persisted.pathFilters;
  state.activeHubCardId = persisted.activeHubCardId;
  state.settingsSection = persisted.settingsSection;
  el("search").value = persisted.searchText || folderFilterSearchQuery(state.pathFilters);
  if (el("search").value.trim()) expandSearchMatches();
  renderFiles();

  if (persisted.page === "settings") {
    showSettingsPage();
    return true;
  }
  if (persisted.page === "new-doc" && persisted.pendingMarkdown) {
    showNewDocPage(persisted.pendingMarkdown);
    return true;
  }
  if (persisted.page === "hub") {
    showHome();
    return true;
  }
  if (persisted.page !== "file" || !persisted.selectedPath) return false;

  const options = {
    pushHistory: true,
    revealInExplorer: false,
    reviewMode: persisted.reviewMode,
    diffCollapsed: persisted.diffCollapsed,
    restoreViewState: persisted.viewState,
  };
  const startup = persisted.startup || null;
  let openRequest = null;
  if (startup?.type === "startup-context") openRequest = selectStartupContextFile(startup.order, options);
  else if (startup?.type === "startup-skill") openRequest = selectStartupSkillFile(startup.folder, startup.skill, options);
  else if (startup?.type === "startup-hook") openRequest = selectStartupHookFile(startup.order, options);
  else if (selectedFileExists(persisted.selectedPath)) openRequest = selectFile(persisted.selectedPath, options);
  else return false;
  void openRequest.then(() => setStatus("restored")).catch((error) => setStatus(error.message));
  return true;
}

function restorePersistedViewState(snapshot) {
  if (!snapshot || snapshot.path !== state.selected) return;
  restoreEditorViewState(snapshot);
  window.setTimeout(() => restoreEditorViewState(snapshot), 120);
  window.setTimeout(() => restoreEditorViewState(snapshot), 600);
}

function buildSessionStatePayload() {
  const validSelected = validSessionSelectedPath();
  const externalChange = activeExternalChange();
  const blocks = validSelected && externalChange ? buildExternalReviewBlocks(externalReviewBaseContent(externalChange), externalChange.diskContent || "", externalChange.reviewDecisions || {}) : [];
  const pendingMiniDiffs = blocks.filter((block) => block.kind === "change" && !block.decision).length;
  return {
    source: "webapp",
    page: validSelected ? state.page : "hub",
    view: validSelected ? state.page : "hub",
    openFile: state.selectedStartupContext ? state.selectedStartupContext.displayPath : validSelected,
    selectedPath: validSelected,
    visibleHeading: validSelected ? currentVisibleHeading() : null,
    scrollPercent: validSelected ? currentScrollPercent() : 0,
    pendingMiniDiffs,
    gitDiffOpen: Boolean(validSelected && state.selectedDiff?.changed && !state.diffCollapsed),
    diffCollapsed: Boolean(state.diffCollapsed),
    explorerFilter: state.explorerWatchFilter,
    pathFilters: state.pathFilters || [],
    selectedReview: state.selectedReview,
    dirty: Boolean(state.dirty),
    mode: state.mode,
    status: el("status")?.textContent || "",
  };
}

function validSessionSelectedPath() {
  if (state.selectedStartupContext) return state.selected;
  if (!state.selected) return null;
  return selectedFileExists(state.selected) ? state.selected : null;
}

function selectedFileExists(path = state.selected) {
  if (!path || state.selectedStartupContext) return Boolean(path);
  return state.files.some((file) => file.path === path) || canReviewMissingFile(path);
}

function reviewQueueItemForPath(path) {
  if (!path) return null;
  return (state.docqa?.queue || []).find((item) => item.path === path || item.oldPath === path)
    || state.deletionBatchItems.find((item) => item.path === path)
    || null;
}

function canReviewMissingFile(path) {
  const item = reviewQueueItemForPath(path);
  return Boolean(item && item.path === path && !item.oldPath);
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
  state.lastAgentCommandId = readLastAgentCommandId();
  state.agentCommandTimer = window.setInterval(() => pollAgentCommand().catch(() => {}), 1500);
  pollAgentCommand().catch(() => {});
}

async function pollAgentCommand() {
  const data = await api("/api/agent/command");
  const command = data.command;
  if (!command?.id || command.id === state.lastAgentCommandId) return;
  if (isStaleAgentCommand(command)) {
    rememberAgentCommandId(command.id);
    return;
  }
  state.lastAgentCommandId = command.id;
  handleAgentCommand(command).catch((error) => setStatus(error.message));
}

function readLastAgentCommandId() {
  try { return window.localStorage?.getItem(AGENT_COMMAND_ACK_STORAGE_KEY) || ""; }
  catch { return ""; }
}

function rememberAgentCommandId(id) {
  state.lastAgentCommandId = id || "";
  try {
    if (id) window.localStorage?.setItem(AGENT_COMMAND_ACK_STORAGE_KEY, id);
  } catch {}
}

function isStaleAgentCommand(command) {
  const createdAt = Date.parse(command?.createdAt || "");
  return Number.isFinite(createdAt) && Date.now() - createdAt > AGENT_COMMAND_MAX_AGE_MS;
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
  if (state.dirty || activeFileConflict()) return true;
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
  if (command?.id) rememberAgentCommandId(command.id);
  const view = command.view || (command.path ? "file" : "hub");
  if (view === "settings") {
    showSettingsPage();
  } else if (view === "hub" && !command.path) {
    goHub();
  } else if (command.path) {
    if (!state.files.some((file) => file.path === command.path)) await loadFiles();
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

function markUserScrollIntent() {
  markInterfaceScrolling();
  state.userScrollIntentAt = Date.now();
  markUserActive();
}

function isScrollIntentKey(event) {
  return ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key);
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
  renderFiles();
  const counts = explorerWatchCounts();
  const suffix = counts.all ? " (" + counts.watched + " watched, " + counts.unwatched + " not watched)" : "";
  setStatus(state.explorerWatchFilter === "all" ? "showing all project files" + suffix : "showing " + state.explorerWatchFilter + " files" + suffix);
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
  const counts = explorerWatchCounts();
  document.querySelectorAll("[data-watch-filter]").forEach((button) => {
    const filter = button.dataset.watchFilter || "all";
    const label = button.dataset.watchLabel || filter;
    button.textContent = label + " " + (counts[filter] ?? 0);
    button.classList.toggle("active", filter === state.explorerWatchFilter);
    button.title = filter === "all"
      ? counts.all + " project files visible in the explorer"
      : (counts[filter] ?? 0) + " " + label + " project files visible in the explorer";
  });
}

function explorerWatchCounts() {
  const watchAllow = state.settings?.watchAllow || [];
  const files = (state.files || []).filter((file) => !file.startupContext);
  const watched = files.filter((file) => Boolean(watchStateForPath(file.path, watchAllow))).length;
  return { all: files.length, watched, unwatched: Math.max(0, files.length - watched) };
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
  el("files").innerHTML = files.length ? renderTreeChildren(tree, 0) : renderExplorerEmptyState();
  updateExplorerWatchFilterButtons();
  updateSelectionBar();
}

function renderExplorerEmptyState() {
  const counts = explorerWatchCounts();
  const message = state.explorerWatchFilter === "unwatched" && counts.unwatched === 0
    ? "No not-watched files in this project."
    : state.explorerWatchFilter === "watched" && counts.watched === 0
      ? "No watched files in this project."
      : "No files match the current explorer filter.";
  return '<div class="tree-empty">' + escapeHtml(message) + '</div>';
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
    state.selectedReadOnly = false;
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

function scheduleExplorerSearchRender() {
  if (state.explorerSearchFrame) return;
  state.explorerSearchFrame = window.requestAnimationFrame(() => {
    state.explorerSearchFrame = 0;
    expandSearchMatches();
    renderFiles();
    scheduleSessionStatePush();
  });
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

function applySettingsPayload(settingsData = {}) {
  const previousKey = JSON.stringify([state.settings, state.availableHubCards, state.hubFolders, state.rootHubSections]);
  state.settings = settingsData.settings || state.settings;
  applyFileTheme();
  state.availableHubCards = settingsData.availableHubCards || [];
  state.hubFolders = settingsData.hubCards || [];
  state.rootHubSections = settingsData.hubSections || [];
  state.hubSections = state.rootHubSections;
  return previousKey !== JSON.stringify([state.settings, state.availableHubCards, state.hubFolders, state.rootHubSections]);
}

function backgroundReportRenderKey(reports = {}) {
  const { generatedAt: _docqaGeneratedAt, ...docqa } = reports.docqa || {};
  const { generatedAt: _doctorGeneratedAt, ...doctor } = reports.doctor || {};
  return JSON.stringify({
    docqa,
    doctor,
    startupContext: reports.startupContext || [],
    startupSkills: reports.startupSkills || [],
    startupHooks: reports.startupHooks || [],
  });
}

function applyBackgroundReportPayload(reports = {}) {
  const nextRenderKey = backgroundReportRenderKey(reports);
  const changed = nextRenderKey !== state.backgroundReportRenderKey;
  state.backgroundReportRenderKey = nextRenderKey;
  state.docqa = reports.docqa || state.docqa;
  state.doctor = reports.doctor || state.doctor;
  state.startupContextFiles = reports.startupContext || state.startupContextFiles;
  state.startupSkillFolders = reports.startupSkills || state.startupSkillFolders;
  state.startupHookFiles = reports.startupHooks || state.startupHookFiles;
  const queue = state.docqa?.queue || [];
  state.selectedReview = queue.find((item) => item.path === state.selectedReview)?.path || queue.find((item) => item.path === state.reviewModePath)?.path || queue[0]?.path || null;
  return changed;
}

function renderAfterBackgroundReportPayload() {
  renderFiles();
  if (state.page === "file" && state.selected && !state.openingFilePath) {
    const viewState = captureEditorViewState();
    renderViewer();
    updateHeader();
    updatePreview();
    restoreEditorViewState(viewState);
  } else if (state.page === "hub") {
    showHome();
  } else if (state.page === "settings") {
    renderSettingsPanel();
    updateActionBanner();
  }
}

function applyInitialReportsWhenReady(reportsRequest) {
  void reportsRequest.then((reports) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      state.bootMilestones.reportsReady = Date.now() - state.bootStartedAt;
      applyBackgroundReportPayload(reports);
      state.lastReportRefreshAt = Date.now();
      renderAfterBackgroundReportPayload();
    }));
  }).catch(() => scheduleBackgroundRefresh({ forceReports: true }));
}

async function loadFiles(options = {}) {
  setStatus("chargement...");
  if (options.initial) state.bootMilestones.requestsStarted = Date.now() - state.bootStartedAt;
  const reportsRequest = options.initial ? api("/api/reports") : null;
  const [data, settingsData] = await Promise.all([api(filesApiPath()), api("/api/settings")]);
  if (options.initial) state.bootMilestones.coreDataReady = Date.now() - state.bootStartedAt;
  state.root = data.root || state.root;
  state.files = data.files;
  applySettingsPayload(settingsData);
  state.lastFullRefreshAt = Date.now();
  const clearedMissingSelection = reconcileMissingSelectedFile();
  renderFiles();

  // File restoration and review reports use separate workers, so keep them concurrent.
  const restoreRequest = restoreNavigationAfterInitialLoad();
  const restored = await restoreRequest;
  if (options.initial) state.bootMilestones.initialDataReady = Date.now() - state.bootStartedAt;
  if (options.initial) state.bootMilestones.navigationReady = Date.now() - state.bootStartedAt;

  if (options.waitForBackground) await refreshBackgroundReports({ forceReports: true });
  else if (reportsRequest) applyInitialReportsWhenReady(reportsRequest);
  else scheduleBackgroundRefresh({ forceReports: true });
  if (restored) {
    scheduleSessionStatePush();
    return;
  }
  if (clearedMissingSelection || !state.selected) showHome();
  setStatus("ready");
  scheduleSessionStatePush();
}

function finishInitialBoot() {
  state.bootMilestones.complete = Math.max(0, Date.now() - state.bootStartedAt);
  document.body.dataset.bootMs = String(state.bootMilestones.complete);
  document.body.dataset.bootMilestones = JSON.stringify(state.bootMilestones);
  document.body.classList.remove("app-booting");
  el("bootScreen")?.setAttribute("aria-hidden", "true");
}

function reconcileMissingSelectedFile() {
  if (!state.selected || state.selectedStartupContext || state.openingFilePath) return false;
  if (selectedFileExists(state.selected)) return false;
  return clearMissingSelectedFile(state.selected);
}

function clearMissingSelectedFile(stalePath = state.selected) {
  resetExternalChangeState({ discardReview: true });
  resetConflictState();
  clearReviewSession(stalePath);
  state.selected = null;
  state.selectedReadOnly = false;
  state.reviewModePath = null;
  state.reviewModeStatus = null;
  state.selectedDiff = null;
  state.fileLoadError = null;
  state.saved = "";
  state.savedHash = null;
  state.dirty = false;
  state.mode = "view";
  state.page = "hub";
  el("editor").value = "";
  return true;
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
  await waitForReviewFinalizationBeforeNavigation();
  if (state.selected && path !== state.selected && !selectedFileExists()) reconcileMissingSelectedFile();
  if (state.dirty && !options.forceReload && !confirm("You have unsaved changes. Change file?")) return;

  const requestId = ++state.selectionRequest;
  const fileOpenStartedAt = performance.now();
  const profilingBoot = document.body.classList.contains("app-booting");
  if (profilingBoot) state.bootMilestones.fileOpenStarted = Date.now() - state.bootStartedAt;
  const previousSelected = state.selected;
  const explorerWasCollapsed = document.querySelector(".app")?.classList.contains("sidebar-collapsed");
  state.selected = path;
  state.selectedReadOnly = Boolean(state.files.find((item) => item.path === path)?.readOnly);
  state.openingFilePath = path;
  state.fileContentReadyPath = null;
  state.selectedStartupContext = null;
  state.activeStartupContextExplorer = null;
  state.reviewModePath = options.reviewMode ? path : null;
  state.reviewModeStatus = options.reviewMode ? reviewStatusForPath(path) : null;
  state.fileLoadError = null;
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
  if (options.revealInExplorer || !document.querySelector('[data-file-path="' + cssEscape(path) + '"]')) renderFiles();
  else updateExplorerSelectedFile(previousSelected, path);
  if (options.revealInExplorer && !explorerWasCollapsed) scrollExplorerToPath(path);
  renderViewer();
  setStatus("opening...");

  const fileRequest = readFileForOpen(path, { force: options.forceReload });
  const annotationsRequest = settleUiRequest(loadAnnotationsForPath(path));
  const diffRequest = settleUiRequest(readDiffForOpen(path, { force: options.forceReload }));
  const reviewBaseRequest = options.reviewMode
    ? settleUiRequest(readSelectedReviewBase(path))
    : Promise.resolve({ value: null, error: null });

  try {
    const data = await fileRequest;
    if (profilingBoot) state.bootMilestones.fileDataReady = Date.now() - state.bootStartedAt;
    if (!isCurrentSelection(requestId, path)) return;
    state.saved = data.content;
    state.savedHash = data.contentHash;
    state.selectedReadOnly = Boolean(data.readOnly);
    state.fileLoadError = null;
    el("editor").value = data.content;
    await annotationsRequest;
    if (!isCurrentSelection(requestId, path)) return;
    state.fileContentReadyPath = path;
    renderViewer();
    restorePersistedViewState(options.restoreViewState);
    setStatus("open · loading Git diff...");

    const finishOpen = (diffResult, reviewBaseResult) => {
      if (!isCurrentSelection(requestId, path)) return;
      const contentViewState = captureEditorViewState();
      const diff = diffResult?.value;
      setStatus(diffResult?.error?.message || reviewBaseResult?.error?.message || "open");
      if (diff) {
        state.selectedDiff = diff;
        state.lastDiffRefreshAt = Date.now();
        state.diffCollapsed = collapsedByGitDiffPreference(diff);
        if (typeof options.diffCollapsed === "boolean") state.diffCollapsed = options.diffCollapsed;
        if (options.reviewMode && diff.changed && reviewBaseResult?.value) {
          applyChangedFileInlineReview(path, diff, reviewBaseResult.value, requestId);
        }
      }
      state.openingFilePath = null;
      state.fileContentReadyPath = null;
      if (options.pushHistory !== false) pushHistory(path);
      updateHeader();
      updateHistoryButtons();
      updatePreview();
      if (profilingBoot) state.bootMilestones.beforeFileRender = Date.now() - state.bootStartedAt;
      renderViewer();
      if (profilingBoot) state.bootMilestones.fileRendered = Date.now() - state.bootStartedAt;
      document.body.dataset.lastFileOpenPath = path;
      document.body.dataset.lastFileOpenMs = String(Math.max(0, Math.round(performance.now() - fileOpenStartedAt)));
      restoreEditorViewState(contentViewState);
    };

    const [diffResult, reviewBaseResult] = await Promise.all([diffRequest, reviewBaseRequest]);
    if (profilingBoot) state.bootMilestones.fileDependenciesReady = Date.now() - state.bootStartedAt;
    finishOpen(diffResult, reviewBaseResult);
  } catch (error) {
    if (isCurrentSelection(requestId, path)) {
      state.openingFilePath = null;
      state.fileContentReadyPath = null;
      state.fileLoadError = { path, message: error.message || "Failed to open file." };
      state.saved = "";
      state.savedHash = null;
      el("editor").value = "";
      renderViewer();
      updateHeader();
      updatePreview();
      setStatus(error.message);
    }
  }
}

function updateExplorerSelectedFile(previousPath, nextPath) {
  if (previousPath) document.querySelectorAll('[data-file-path="' + cssEscape(previousPath) + '"]').forEach((row) => row.classList.remove("active"));
  if (nextPath) document.querySelectorAll('[data-file-path="' + cssEscape(nextPath) + '"]').forEach((row) => row.classList.add("active"));
}

function isCurrentSelection(requestId, path) {
  return state.selectionRequest === requestId && state.selected === path;
}

async function selectStartupContextFile(order, options = {}) {
  if (!order) return;
  await waitForReviewFinalizationBeforeNavigation();
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
  state.selectedReadOnly = false;
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
    const finalPath = selectedPath || selectedKey;
    state.selected = finalPath;
    state.reviewModePath = options.reviewMode ? finalPath : null;
    state.reviewModeStatus = options.reviewMode ? reviewStatusForPath(finalPath) : null;
    if (options.reviewMode) state.selectedReview = finalPath;
    activateStartupContextExplorer(data.startupContext);
    state.saved = data.content;
    state.savedHash = data.contentHash;
    state.openingFilePath = null;
    el("editor").value = data.content;
    await loadFiles();
    revealActiveStartupContextExplorer();
    updateHeader();
    updatePreview();
    if (options.reviewMode) await startChangedFileInlineReview(finalPath, { changed: true }, requestId).catch((error) => {
      if (isCurrentSelection(requestId, finalPath)) setStatus(error.message);
    });
    renderViewer();
    restorePersistedViewState(options.restoreViewState);
    setStatus(options.reviewMode ? "startup context review open" : "startup context open");
    scheduleSessionStatePush();
  } catch (error) {
    if (isCurrentSelection(requestId, selectedKey)) {
      state.openingFilePath = null;
      updateActionBanner();
      setStatus(error.message);
    }
  }
}

async function selectStartupSkillFile(folderOrder, skillName, options = {}) {
  if (!folderOrder || !skillName) return;
  await waitForReviewFinalizationBeforeNavigation();
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
  state.selectedReadOnly = false;
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
    restorePersistedViewState(options.restoreViewState);
    setStatus("startup skill open");
    scheduleSessionStatePush();
  } catch (error) {
    if (isCurrentSelection(requestId, selectedKey)) {
      state.openingFilePath = null;
      updateActionBanner();
      setStatus(error.message);
    }
  }
}

async function selectStartupHookFile(order, options = {}) {
  if (!order) return;
  await waitForReviewFinalizationBeforeNavigation();
  if (state.dirty && !confirm("You have unsaved changes. Change file?")) return;
  const requestId = ++state.selectionRequest;
  const selectedKey = "startup-hook-" + order;
  const pendingFile = (state.startupHookFiles || []).find((file) => String(file.startupContext.order) === String(order));
  state.selected = selectedKey;
  state.openingFilePath = selectedKey;
  state.activeStartupContextExplorer = null;
  state.activeStartupSkillExplorer = null;
  state.selectedStartupContext = pendingFile?.startupContext || { order, fileName: "Startup hook", displayPath: "", kind: "startup-hook", readOnly: true };
  state.reviewModePath = null;
  state.reviewModeStatus = null;
  state.selectedDiff = null;
  state.selectedReadOnly = false;
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
  setStatus("opening startup hook...");
  try {
    const data = await api("/api/startup-hooks/file?order=" + encodeURIComponent(order));
    if (!isCurrentSelection(requestId, selectedKey)) return;
    state.selectedStartupContext = data.startupContext;
    state.saved = data.content;
    state.savedHash = data.contentHash;
    state.openingFilePath = null;
    el("editor").value = data.content;
    updateHeader();
    updatePreview();
    renderViewer();
    restorePersistedViewState(options.restoreViewState);
    setStatus(data.startupContext?.readOnly ? "startup hook open · read only" : "startup hook open");
    scheduleSessionStatePush();
  } catch (error) {
    if (isCurrentSelection(requestId, selectedKey)) {
      state.openingFilePath = null;
      updateActionBanner();
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
    state.selectedReadOnly = false;
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
    state.selectedReadOnly = false;
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
  setStatus("ready");
  scheduleSessionStatePush();
}

function renderDocQaDashboard() {
  const report = state.docqa;
  if (!report) return;
  const s = report.summary;
  el("reviewSummary").innerHTML = renderReviewSummary(s);
  const queue = report.queue.length ? report.queue : [];
  const groupDeletions = Number(s.deletedDocs || 0) > 1 || state.deletionBatchItems.length > 0;
  const loadedBatchChanged = state.deletionBatchItems.length && (state.deletionBatchKey !== String(s.deletedReviewKey || "") || state.deletionBatchReportedCount !== Number(s.deletedDocs || 0));
  const previousDeletionBatch = document.querySelector("[data-review-deletion-batch]");
  const restoreDeletionBatchFocus = Boolean(loadedBatchChanged && document.activeElement && previousDeletionBatch?.contains(document.activeElement));
  if (loadedBatchChanged) {
    state.deletionBatchItems = [];
    state.deletionBatchReportedCount = 0;
  }
  const visibleQueue = groupDeletions ? queue.filter((item) => !isDeletedReviewQueueItem(item)) : queue;
  const deletionBatch = groupDeletions ? renderDeletionReviewBatch(s) : "";
  const regularItems = visibleQueue.map(renderReviewItem).join("");
  el("reviewQueue").classList.toggle("batch-open", groupDeletions && state.deletionBatchExpanded);
  el("reviewQueue").innerHTML = (deletionBatch || regularItems)
    ? deletionBatch + regularItems
    : '<div class="issue">No watched files changed or created in the current worktree.</div>';
  document.querySelectorAll("[data-review-path]").forEach((button) => button.addEventListener("click", () => {
    const item = state.docqa?.queue?.find((entry) => entry.path === button.dataset.reviewPath) || { path: button.dataset.reviewPath, startupContext: button.dataset.startupReviewOrder ? { order: button.dataset.startupReviewOrder } : null };
    openReviewQueueItem(item).catch((error) => setStatus(error.message));
  }));
  if (restoreDeletionBatchFocus) document.querySelector("[data-review-deletion-batch] > summary")?.focus();
  wireDeletionReviewBatch();
  renderContextHealth();
  renderHubFolders();
}

function renderContextHealth() {
  const holder = el("contextHealth");
  const panel = el("contextHealthPanel");
  if (!holder || !state.doctor) return;
  const issues = (state.doctor.issues || []).filter((issue) => ["critical", "high", "medium"].includes(issue.severity) && !issue.acknowledged);
  if (!issues.length) {
    holder.innerHTML = "";
    if (panel) panel.hidden = true;
    return;
  }
  if (panel) panel.hidden = false;
  const counts = issues.reduce((acc, issue) => {
    acc[issue.severity] = (acc[issue.severity] || 0) + 1;
    return acc;
  }, {});
  const countLabel = ["critical", "high", "medium"].filter((severity) => counts[severity]).map((severity) => counts[severity] + " " + severity).join(" · ");
  holder.innerHTML = '<div class="context-health-alert"><strong>' + issues.length + ' issue' + (issues.length > 1 ? 's' : '') + ' triggered</strong><span>' + escapeHtml(countLabel) + '</span></div>' +
    '<div class="issue-list compact">' + issues.slice(0, 5).map(renderContextHealthIssue).join("") + (issues.length > 5 ? '<div class="issue">+' + (issues.length - 5) + ' more in doctor.</div>' : '') + '</div>';
  holder.querySelectorAll("[data-health-ack]").forEach((button) => button.addEventListener("click", () => acknowledgeContextHealthIssueFromPanel(button.dataset.healthAck).catch((error) => setStatus(error.message))));
}

function renderContextHealthIssue(issue) {
  const label = (issue.path ? issue.path + ": " : "") + issue.message;
  return '<div class="issue context-health-issue ' + escapeHtml(issue.severity) + '">' +
    '<div class="context-health-issue-copy"><strong>[' + escapeHtml(issue.severity) + ']</strong> ' + escapeHtml(label) + '</div>' +
    '<button class="file-action context-health-ok" type="button" data-health-ack="' + escapeHtml(issue.key || "") + '" title="Hide this issue unless it changes">OK</button>' +
    '</div>';
}

async function acknowledgeContextHealthIssueFromPanel(key) {
  if (!key) return;
  setStatus("marking health issue OK...");
  await api("/api/doctor/ack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  state.doctor = await api("/api/doctor");
  renderContextHealth();
  setStatus("health issue marked OK");
}

function showNewDocPage({ title = "New document", path = "docs/new-document.md", directory = "" } = {}) {
  if (state.dirty && !confirm("You have unsaved changes. Create a new document?")) return;
  state.page = "new-doc";
  state.settingsOpen = false;
  state.pendingMarkdown = { title, path, directory };
  state.selected = null;
  state.selectedReadOnly = false;
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
  return '<div class="review-summary-item"><strong>' + needsReview + '</strong><span>to review</span></div>' +
    '<div class="review-summary-item"><strong>' + changed + '</strong><span>changed</span></div>';
}

function isDeletedReviewQueueItem(item) {
  return Boolean(item && item.batchDeletion === true && item.resourceState === "absent" && !item.oldPath && String(item.gitStatus || "").includes("D"));
}

function renderDeletionReviewBatch(summary = {}) {
  const count = Number(summary.deletedDocs || 0);
  const protectedCount = Number(summary.protectedDeletedDocs || 0);
  const selectedCount = state.deletionBatchItems.filter((item) => state.selectedDeletionReviews.has(item.path)).length;
  const detailsOpen = state.deletionBatchExpanded ? " open" : "";
  const detailsBusy = state.deletionBatchLoading ? ' aria-busy="true"' : "";
  const controlsDisabled = state.deletionBatchLoading ? " disabled" : "";
  const protectedSummary = protectedCount ? protectedCount + " protected · " : "";
  const protectedNote = protectedCount ? " Protected paths start unselected and require an extra acknowledgement." : "";
  let body = '<p class="review-deletion-note">Open the set to inspect paths or exclude files. Confirmation records that the files are already absent; it does not delete anything.' + protectedNote + '</p>';
  if (state.deletionBatchLoading && !state.deletionBatchItems.length) {
    body += '<div class="issue" role="status" aria-live="polite">Loading removed files...</div>';
  } else {
    if (state.deletionBatchError) {
      body += '<div class="issue critical" role="alert"><span>' + escapeHtml(state.deletionBatchError) + '</span><button class="review-deletion-tool" type="button" data-review-deletion-retry>Retry</button></div>';
    }
    if (state.deletionBatchItems.length) {
    body += '<div class="review-deletion-toolbar"><span>' + selectedCount + ' of ' + state.deletionBatchItems.length + ' selected</span>' +
      '<div class="review-deletion-toolbar-buttons"><button class="review-deletion-tool" type="button" data-review-deletion-select-all' + controlsDisabled + '>Select all</button><button class="review-deletion-tool" type="button" data-review-deletion-select-none' + controlsDisabled + '>Clear</button></div></div>' +
      '<div class="review-deletion-paths">' + state.deletionBatchItems.map((item) => {
        const checked = state.selectedDeletionReviews.has(item.path) ? " checked" : "";
        const protectedLabel = item.protected ? '<span class="review-deletion-protected">protected</span>' : "";
        return '<div class="review-deletion-row"><label class="review-deletion-selector"><input type="checkbox" data-review-deletion-path="' + escapeHtml(item.path) + '"' + checked + controlsDisabled + ' /><code title="' + escapeHtml(item.path) + '">' + escapeHtml(item.path) + '</code>' + protectedLabel + '</label><button class="review-deletion-open" type="button" aria-label="Review ' + escapeHtml(item.path) + '" data-review-deletion-open="' + escapeHtml(item.path) + '"' + controlsDisabled + '>Review</button></div>';
      }).join("") + '</div>' +
      '<div class="review-deletion-actions"><span data-review-deletion-selection-count>' + selectedCount + ' selected</span><button class="review-deletion-confirm" type="button" data-review-deletion-confirm' + (!selectedCount || state.deletionBatchLoading ? " disabled" : "") + '>' + (state.deletionBatchLoading ? "Confirming..." : "Confirm " + selectedCount + " removals") + '</button></div>';
    } else if (!state.deletionBatchError) {
      body += '<div class="issue">Open this set to load every removed path.</div>';
    }
  }
  return '<details class="review-deletion-batch" data-review-deletion-batch' + detailsOpen + detailsBusy + '>' +
    '<summary><span class="review-deletion-count">' + count + '</span><span class="review-deletion-heading"><strong>Files removed together</strong><span>' + protectedSummary + 'review this cleanup as one change set</span></span><span class="review-deletion-chevron" aria-hidden="true">›</span></summary>' +
    '<div class="review-deletion-body">' + body + '</div>' +
  '</details>';
}

function syncDeletionReviewBatchControls() {
  const selectedCount = state.deletionBatchItems.filter((item) => state.selectedDeletionReviews.has(item.path)).length;
  const count = document.querySelector("[data-review-deletion-selection-count]");
  const confirmButton = document.querySelector("[data-review-deletion-confirm]");
  if (count) count.textContent = selectedCount + " selected";
  if (confirmButton) {
    confirmButton.textContent = "Confirm " + selectedCount + " removals";
    confirmButton.disabled = !selectedCount || state.deletionBatchLoading;
  }
}

function wireDeletionReviewBatch() {
  const details = document.querySelector("[data-review-deletion-batch]");
  if (!details) return;
  details.addEventListener("toggle", () => {
    state.deletionBatchExpanded = details.open;
    if (details.open && !state.deletionBatchItems.length && !state.deletionBatchLoading) loadDeletionReviewBatch();
  });
  details.querySelectorAll("[data-review-deletion-path]").forEach((input) => input.addEventListener("change", () => {
    if (input.checked) state.selectedDeletionReviews.add(input.dataset.reviewDeletionPath);
    else state.selectedDeletionReviews.delete(input.dataset.reviewDeletionPath);
    syncDeletionReviewBatchControls();
  }));
  details.querySelector("[data-review-deletion-select-all]")?.addEventListener("click", () => {
    state.selectedDeletionReviews = new Set(state.deletionBatchItems.map((item) => item.path));
    details.querySelectorAll("[data-review-deletion-path]").forEach((input) => { input.checked = true; });
    syncDeletionReviewBatchControls();
  });
  details.querySelector("[data-review-deletion-select-none]")?.addEventListener("click", () => {
    state.selectedDeletionReviews.clear();
    details.querySelectorAll("[data-review-deletion-path]").forEach((input) => { input.checked = false; });
    syncDeletionReviewBatchControls();
  });
  details.querySelector("[data-review-deletion-retry]")?.addEventListener("click", () => loadDeletionReviewBatch());
  details.querySelectorAll("[data-review-deletion-open]").forEach((button) => button.addEventListener("click", () => {
    const item = state.deletionBatchItems.find((entry) => entry.path === button.dataset.reviewDeletionOpen);
    openReviewQueueItem(item).catch((error) => setStatus(error.message));
  }));
  details.querySelector("[data-review-deletion-confirm]")?.addEventListener("click", requestDeletionReviewBatchConfirmation);
  if (details.open && !state.deletionBatchItems.length && !state.deletionBatchLoading && !state.deletionBatchError) loadDeletionReviewBatch();
}

async function loadDeletionReviewBatch() {
  if (state.deletionBatchLoading) return;
  const details = document.querySelector("[data-review-deletion-batch]");
  const summary = details?.querySelector("summary");
  const restoreSummaryFocus = Boolean(summary && (document.activeElement === summary || details.contains(document.activeElement)));
  const previousSelection = new Set(state.selectedDeletionReviews);
  const preserveSelection = Boolean(state.deletionBatchKey);
  state.deletionBatchLoading = true;
  state.deletionBatchError = "";
  details?.setAttribute("aria-busy", "true");
  details?.querySelectorAll(".review-deletion-body button, .review-deletion-body input").forEach((control) => { control.disabled = true; });
  const retryButton = details?.querySelector("[data-review-deletion-retry]");
  if (retryButton) retryButton.textContent = "Retrying...";
  const loadingStatus = details?.querySelector(".issue");
  if (loadingStatus && !state.deletionBatchItems.length) {
    loadingStatus.textContent = "Loading removed files...";
    loadingStatus.setAttribute("role", "status");
    loadingStatus.setAttribute("aria-live", "polite");
  }
  try {
    const batch = await api("/api/docqa/review-deletions");
    state.deletionBatchItems = batch.items || [];
    state.deletionBatchKey = String(batch.key || "");
    const reportedCount = Number(batch.count || 0) + (batch.truncated ? 1 : 0);
    if (state.docqa?.summary) {
      const previousDeletedCount = Number(state.docqa.summary.deletedDocs || 0);
      const deletionDelta = reportedCount - previousDeletedCount;
      state.docqa = {
        ...state.docqa,
        generatedAt: batch.generatedAt || state.docqa.generatedAt,
        summary: {
          ...state.docqa.summary,
          deletedDocs: reportedCount,
          protectedDeletedDocs: Number(batch.protectedCount || 0),
          deletedReviewKey: state.deletionBatchKey,
          changedDocs: Math.max(0, Number(state.docqa.summary.changedDocs || 0) + deletionDelta),
          needsReview: Math.max(0, Number(state.docqa.summary.needsReview || 0) + deletionDelta),
        },
        queue: reportedCount ? state.docqa.queue : state.docqa.queue.filter((item) => !isDeletedReviewQueueItem(item)),
      };
    }
    state.deletionBatchReportedCount = reportedCount;
    state.selectedDeletionReviews = new Set(state.deletionBatchItems
      .filter((item) => preserveSelection ? previousSelection.has(item.path) : !item.protected)
      .map((item) => item.path));
  } catch (error) {
    state.deletionBatchError = error.message || "Removed files could not be loaded.";
  } finally {
    state.deletionBatchLoading = false;
    renderDocQaDashboard();
    if (restoreSummaryFocus) document.querySelector("[data-review-deletion-batch] > summary")?.focus();
  }
}

function requestDeletionReviewBatchConfirmation() {
  const selected = state.deletionBatchItems.filter((item) => state.selectedDeletionReviews.has(item.path));
  if (!selected.length) return;
  const batchKey = state.deletionBatchKey;
  const protectedCount = selected.filter((item) => item.protected).length;
  const protectedCopy = protectedCount ? " This selection includes " + protectedCount + " protected document" + (protectedCount === 1 ? "." : "s.") : "";
  showConfirmDialog({
    title: "Confirm " + selected.length + " removals?",
    body: "These files are already absent. This records that their removal was intentional; it does not delete files." + protectedCopy,
    confirmLabel: "Confirm removals",
    checkboxLabel: protectedCount ? "I reviewed the protected paths" : "",
    checkboxRequired: Boolean(protectedCount),
    onConfirm: ({ checked }) => confirmDeletionReviewBatch(selected.map((item) => item.path), { batchKey, protectedAcknowledged: checked }),
  });
}

async function confirmDeletionReviewBatch(paths, { batchKey = "", protectedAcknowledged = false } = {}) {
  let confirmationSucceeded = false;
  state.deletionBatchLoading = true;
  state.deletionBatchError = "";
  renderDocQaDashboard();
  setStatus("confirming removed files...");
  try {
    const result = await api("/api/docqa/review-deletions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paths, key: batchKey, protectedAcknowledged }),
    });
    state.deletionBatchItems = [];
    state.deletionBatchKey = "";
    state.deletionBatchReportedCount = 0;
    state.selectedDeletionReviews.clear();
    if (result.docqa) state.docqa = result.docqa;
    state.deletionBatchExpanded = Boolean(result.skipped?.length && Number(state.docqa?.summary?.deletedDocs || 0) > 1);
    confirmationSucceeded = true;
    const skipped = result.skipped?.length || 0;
    setStatus(result.confirmed.length + " removals confirmed" + (skipped ? " · " + skipped + " changed and stayed in review" : ""));
  } catch (error) {
    state.deletionBatchError = error.message || "Removed files could not be confirmed.";
    setStatus(state.deletionBatchError);
  } finally {
    state.deletionBatchLoading = false;
    if (!state.selected && !state.settingsOpen) renderDocQaDashboard();
    const focusTarget = confirmationSucceeded
      ? document.querySelector("[data-review-deletion-batch] > summary") || el("reviewQueueHeading")
      : document.querySelector("[data-review-deletion-retry]");
    focusTarget?.focus();
  }
}

function gitStatusLabel(status, reviewRequired = false) {
  const clean = String(status || "").trim();
  if (!clean && reviewRequired) return "review";
  if (!clean) return "modified";
  if (["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(clean)) return "conflict";
  if (clean === "??") return "new";
  if (clean === "M" || clean === "M M" || clean.includes("M")) return "modified";
  if (clean.includes("R")) return "renamed";
  if (clean.includes("A")) return "added";
  if (clean.includes("D")) return "deleted";
  if (clean.includes("U")) return "conflict";
  return clean;
}

function renderReviewItem(item) {
  const gitLabel = gitStatusLabel(item.gitStatus, item.reviewRequired);
  const startupOrder = item.startupContext?.order ? ' data-startup-review-order="' + escapeHtml(item.startupContext.order) + '"' : "";
  const pathLine = item.oldPath
    ? escapeHtml(item.oldPath) + " -> " + escapeHtml(item.path)
    : escapeHtml(item.path);
  return '<button class="review-item ' + (state.selectedReview === item.path ? "active" : "") + '" type="button" data-review-path="' + escapeHtml(item.path) + '"' + startupOrder + '>' +
    '<div class="review-top"><div class="review-title">' + escapeHtml(item.label || item.path) + '</div><span class="chip high">' + escapeHtml(gitLabel) + '</span></div>' +
    '<div class="review-path">' + pathLine + '</div>' +
  '</button>';
}

function renderFileActionButtons(options = {}) {
  return '<div class="file-actions">' + renderFileActionItems(options) + '</div>';
}

function renderFileActionItems({ reviewAction = null, nextReviewAction = null, dirty = false, templateState = null, blockedByConflict = false, readOnly = false, deletable = true, savable = true } = {}) {
  return '' +
    (templateState ? '<div class="empty-template-actions"><select class="file-template-select" data-empty-template-select aria-label="Template">' + renderFileTemplateOptions(templateState.selectedId) + '</select></div>' : '') +
    (reviewAction ? '<button class="file-action" type="button" data-file-review-decision="' + escapeHtml(reviewAction.status) + '">' + escapeHtml(reviewAction.label) + '</button>' : '') +
    (nextReviewAction ? '<button class="file-action" type="button" data-next-review>' + escapeHtml(nextReviewAction.label) + '</button>' : '') +
    (deletable ? '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' : '') +
    (savable ? '<button class="file-action primary" type="button" data-file-save ' + (!dirty || blockedByConflict || readOnly ? 'disabled' : '') + (readOnly ? ' title="This file is read-only in Context Room"' : blockedByConflict ? ' title="Resolve the disk change before saving"' : '') + '>Save</button>' : '');
}

function reviewStatusForPath(path) {
  const item = state.docqa?.queue?.find((entry) => entry.path === path);
  return item?.review?.current ? item.review.status || null : null;
}

function reviewActionForSelectedFile() {
  if (!state.selected || state.reviewModePath !== state.selected) return null;
  if (state.reviewModeStatus === "verified") return null;
  const reviewItem = state.docqa?.queue?.find((item) => item.path === state.selected);
  if (!reviewItem?.reviewRequired || String(reviewItem.gitStatus || "").trim()) return null;
  return { status: "verified", label: "Mark verified" };
}

function nextReviewActionForSelectedFile() {
  if (!state.selected || state.reviewModePath !== state.selected) return null;
  return nextReviewItemForManualAdvance() ? { label: "Next review" } : null;
}

function nextReviewItemAfter(previousQueue = [], currentPath = null, nextQueue = []) {
  const nextItems = nextQueue.filter((item) => item?.path);
  if (!nextItems.length) return null;
  const byPath = new Map(nextItems.map((item) => [item.path, item]));
  const previousPaths = previousQueue.map((item) => item?.path).filter(Boolean);
  const index = previousPaths.indexOf(currentPath);
  const ordered = index >= 0
    ? [...previousPaths.slice(index + 1), ...previousPaths.slice(0, index)]
    : previousPaths;
  for (const path of ordered) {
    if (path !== currentPath && byPath.has(path)) return byPath.get(path);
  }
  return nextItems.find((item) => item.path !== currentPath) || null;
}

function nextReviewItemForManualAdvance() {
  const queue = state.docqa?.queue || [];
  return nextReviewItemAfter(queue, state.reviewModePath || state.selected || state.selectedReview, queue);
}

async function waitForReviewFinalizationBeforeNavigation() {
  const finalization = state.reviewFinalizationPromise;
  if (!finalization) return;
  setStatus("finishing review...");
  await finalization;
}

async function openNextReviewManually() {
  await waitForReviewFinalizationBeforeNavigation();
  const nextItem = nextReviewItemForManualAdvance();
  if (!nextItem) {
    goHub();
    setStatus("no more docs to review");
    return;
  }
  await openReviewQueueItem(nextItem);
  setStatus("next doc open");
}

async function openReviewQueueItem(item) {
  if (!item?.path) return;
  if (item.startupContext?.order) {
    await selectStartupContextFile(item.startupContext.order, { reviewMode: true });
    return;
  }
  await selectFile(item.path, { reviewMode: true });
}

const SETTINGS_THEME_PREVIEW_DOC = "# Preview document\n\n> Scope: docs/\n\n## Read first\n\n- Start in docs/INDEX.md.\n- Keep website/docs/ current.\n\n### Paths\n\nUse AGENTS.md, website/docs/, and our_agentic_system/docs/.";

function normalizeSettingsSectionId(value) {
  return SETTINGS_SECTION_IDS.includes(value) ? value : "review";
}

function renderSettingsTabs(items = []) {
  return '<nav class="settings-tabs" role="tablist" aria-label="Settings categories">' + items.map((item) =>
    '<button id="settings-tab-' + escapeHtml(item.id) + '" class="settings-tab" type="button" role="tab" aria-selected="false" aria-controls="settings-section-' + escapeHtml(item.id) + '" tabindex="-1" data-settings-section-target="' + escapeHtml(item.id) + '">' +
      '<strong>' + escapeHtml(item.label) + '</strong><small>' + escapeHtml(item.scope) + '</small>' +
    '</button>'
  ).join("") + '</nav>';
}

function renderSettingsSection({ id, kicker, title, copy, scope = "Project", pills = [], body = "" } = {}) {
  const sectionId = normalizeSettingsSectionId(id);
  return '<section id="settings-section-' + sectionId + '" class="settings-section" role="tabpanel" aria-labelledby="settings-tab-' + sectionId + '" data-settings-section-panel="' + sectionId + '" hidden>' +
    '<div class="settings-section-head">' +
      '<div class="settings-section-title"><span class="settings-kicker">Settings / ' + escapeHtml(kicker || "") + '</span><h3>' + escapeHtml(title || "") + '</h3>' + (copy ? '<p class="settings-section-copy">' + escapeHtml(copy) + '</p>' : '') + '</div>' +
      '<div class="settings-section-actions"><span class="settings-pill">' + escapeHtml(scope) + '</span>' + pills.map((pill) => '<span class="settings-pill">' + escapeHtml(pill) + '</span>').join("") + '</div>' +
    '</div>' +
    '<div class="settings-section-body">' + body + '</div>' +
  '</section>';
}

function activateSettingsSection(sectionId, options = {}) {
  const next = normalizeSettingsSectionId(sectionId);
  state.settingsSection = next;
  document.querySelectorAll("[data-settings-section-target]").forEach((tab) => {
    const active = tab.dataset.settingsSectionTarget === next;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[data-settings-section-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsSectionPanel !== next;
  });
  if (options.resetScroll !== false) el("settingsPage").scrollTop = 0;
  if (options.focus) document.querySelector('[data-settings-section-target="' + next + '"]')?.focus();
  scheduleSessionStatePush();
}

function wireSettingsTabs(root) {
  const tabs = [...root.querySelectorAll("[data-settings-section-target]")];
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateSettingsSection(tab.dataset.settingsSectionTarget));
    tab.addEventListener("keydown", (event) => {
      let targetIndex = null;
      if (["ArrowRight", "ArrowDown"].includes(event.key)) targetIndex = (index + 1) % tabs.length;
      if (["ArrowLeft", "ArrowUp"].includes(event.key)) targetIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") targetIndex = 0;
      if (event.key === "End") targetIndex = tabs.length - 1;
      if (targetIndex == null) return;
      event.preventDefault();
      activateSettingsSection(tabs[targetIndex].dataset.settingsSectionTarget, { focus: true });
    });
  });
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
  const startupContext = state.settings.startupContext || { enabled: false, fileNames: ["AGENTS.md", "CLAUDE.md"], globalPaths: [] };
  const startupFileNames = (startupContext.fileNames || []).join("\n");
  const startupGlobalPaths = (startupContext.globalPaths || []).join("\n");
  const startupSkills = state.settings.startupSkills || { enabled: true, folderNames: [".codex/skills", "skills"] };
  const startupSkillFolderNames = (startupSkills.folderNames || []).join("\n");
  const startupHooks = state.settings.startupHooks || { enabled: true, editable: false, agentHooks: true, codexHooks: true, gitHooks: true, hookManagers: true, fileNames: ["pre-commit", "pre-push", "commit-msg", "prepare-commit-msg"], agentHookSources: [{ id: "codex", label: "Codex", paths: [".codex/hooks.json"] }], agentHookPaths: [".codex/hooks.json"], codexPaths: [".codex/hooks.json"], managerPaths: [".husky/", "lefthook.yml", ".pre-commit-config.yaml", "lint-staged.config.js", "package.json"] };
  const startupHookFileNames = (startupHooks.fileNames || []).join("\n");
  const startupAgentHookSources = formatAgentHookSourcesForTextarea(startupHooks.agentHookSources, startupHooks.agentHookPaths || startupHooks.codexPaths || []);
  const startupHookManagerPaths = (startupHooks.managerPaths || []).join("\n");
  const appearance = state.settings.appearance || { fileTheme: DEFAULT_FILE_THEME, autoOpenGitDiff: true, showHiddenFiles: true };
  const markdownTemplates = state.settings.markdownTemplates || [];
  const sections = state.settings.hubSections?.length ? state.settings.hubSections : [{ id: "main", title: "Main", cards: state.settings.customHubCards || state.availableHubCards || [] }];
  const watchCount = (state.settings.watchAllow || []).length;
  const reviewPathCount = (state.settings.reviewPaths || []).length;
  const startupContextCount = (startupContext.fileNames || []).length + (startupContext.globalPaths || []).length;
  const startupSkillFolderCount = (startupSkills.folderNames || []).length;
  const startupHookNameCount = (startupHooks.fileNames || []).length;
  const startupAgentHookCount = (startupHooks.agentHookSources || []).length || (startupHooks.agentHookPaths || startupHooks.codexPaths || []).length;
  const startupHookManagerCount = (startupHooks.managerPaths || []).length;
  holder.innerHTML = '<div class="settings-shell">' +
  renderSettingsTabs([
    { id: "review", label: "Review", scope: "Project" },
    { id: "startup", label: "Startup", scope: "Project" },
    { id: "appearance", label: "Appearance", scope: "Global" },
    { id: "templates", label: "Templates", scope: "Project" },
    { id: "hub", label: "Hub", scope: "Project" },
  ]) + '<div class="settings-content">' +
  renderSettingsSection({
    id: "review",
    kicker: "Review",
    title: "Watched docs",
    copy: "Changed files listed here require human review before handoff.",
    pills: [watchCount + " watched", reviewPathCount + " required"],
    body: '<div class="settings-grid">' +
      '<div class="settings-field large"><label for="watchAllow">Watched folders/files</label><span class="settings-field-note">One path per line.</span><textarea id="watchAllow" placeholder="docs/&#10;website/docs/">' + escapeHtml(watchAllow) + '</textarea></div>' +
      '<div class="settings-field large"><label for="reviewPaths">Required review files</label><span class="settings-field-note">Important files that stay in review until verified, even without a Git diff.</span><textarea id="reviewPaths" placeholder="AGENTS.md&#10;docs/INDEX.md">' + escapeHtml(reviewPaths) + '</textarea></div>' +
    '</div>',
  }) +
  renderSettingsSection({
    id: "startup",
    kicker: "Startup",
    title: "Injected context scanners",
    copy: "Files, skill folders, and hook files discovered around this Context Room root.",
    pills: [startupContextCount + " names", startupSkillFolderCount + " folders", startupHookNameCount + " git names", startupAgentHookCount + " agent paths", startupHookManagerCount + " managers"],
    body: '<div class="settings-group"><h4 class="settings-group-title">Agent context</h4><div class="settings-grid">' +
      '<div class="settings-field"><label class="settings-toggle" for="startupContextEnabled"><input id="startupContextEnabled" type="checkbox" ' + (startupContext.enabled ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Startup context</strong><em>List ancestor and global agent instruction files.</em></span></label><span class="settings-input-label">Ancestor filenames</span><textarea id="startupContextFileNames" placeholder="one ancestor filename per line">' + escapeHtml(startupFileNames) + '</textarea><span class="settings-input-label">Global instruction paths</span><textarea id="startupContextGlobalPaths" placeholder="one global path per line">' + escapeHtml(startupGlobalPaths) + '</textarea></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="startupSkillsEnabled"><input id="startupSkillsEnabled" type="checkbox" ' + (startupSkills.enabled !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Startup skills</strong><em>List global skill folders visible to agents.</em></span></label><span class="settings-input-label">Skill folder names</span><textarea id="startupSkillFolderNames" placeholder="one folder path per line">' + escapeHtml(startupSkillFolderNames) + '</textarea></div>' +
    '</div></div><div class="settings-group"><h4 class="settings-group-title">Hooks</h4><div class="settings-grid">' +
      '<div class="settings-field"><label class="settings-toggle" for="startupHooksEnabled"><input id="startupHooksEnabled" type="checkbox" ' + (startupHooks.enabled !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Startup hooks</strong><em>List hook files that can affect agents and commits.</em></span></label><span class="settings-input-label">Git hook filenames</span><textarea id="startupHookFileNames" placeholder="one hook filename per line">' + escapeHtml(startupHookFileNames) + '</textarea></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="startupHooksEditable"><input id="startupHooksEditable" type="checkbox" ' + (startupHooks.editable ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Edit hooks</strong><em>Off by default because hooks execute code.</em></span></label><span class="settings-input-label">Hook manager paths</span><textarea id="startupHookManagerPaths" placeholder="one hook manager path per line">' + escapeHtml(startupHookManagerPaths) + '</textarea></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="startupAgentHooks"><input id="startupAgentHooks" type="checkbox" ' + (startupHooks.agentHooks !== false && startupHooks.codexHooks !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Agent hook sources</strong><em>Choose which AI coding systems Context Room should show.</em></span></label><span class="settings-field-note">One source per line: <code>Name | config path | plugin folder</code>. Delete a line to hide that system.</span><textarea id="startupAgentHookSources" placeholder="Codex | .codex/hooks.json&#10;My Agent | .my-agent/hooks.json | .my-agent/plugins/">' + escapeHtml(startupAgentHookSources) + '</textarea></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="startupGitHooks"><input id="startupGitHooks" type="checkbox" ' + (startupHooks.gitHooks !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Git hooks</strong><em>Scan .git/hooks and core.hooksPath.</em></span></label></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="startupHookManagers"><input id="startupHookManagers" type="checkbox" ' + (startupHooks.hookManagers !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Hook managers</strong><em>Scan Husky, Lefthook, pre-commit, lint-staged, and package hooks.</em></span></label></div>' +
    '</div></div>',
  }) +
  renderSettingsSection({
    id: "appearance",
    kicker: "Appearance",
    title: "Theme, files, and diffs",
    copy: "Shared by every Context Room on this computer.",
    scope: "All rooms",
    body: '<div class="settings-grid compact">' +
      '<div class="settings-field"><label for="fileTheme">App theme</label><select id="fileTheme">' + renderFileThemeOptions(appearance.fileTheme) + '</select></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="autoOpenGitDiff"><input id="autoOpenGitDiff" type="checkbox" ' + (appearance.autoOpenGitDiff !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Auto-open Git diff</strong><em>Leave off to open the diff manually.</em></span></label></div>' +
      '<div class="settings-field"><label class="settings-toggle" for="showHiddenFiles"><input id="showHiddenFiles" type="checkbox" ' + (appearance.showHiddenFiles !== false ? 'checked' : '') + ' /><span class="settings-switch" aria-hidden="true"></span><span class="settings-toggle-copy"><strong>Show hidden files</strong><em>Display safe dotfiles and .context-room in every explorer.</em></span></label></div>' +
    '</div>' + renderSettingsThemePreview(appearance.fileTheme),
  }) +
  renderSettingsSection({
    id: "templates",
    kicker: "Templates",
    title: "Markdown document templates",
    copy: "Reusable shapes for new documentation files.",
    pills: [markdownTemplates.length + " templates"],
    body: '<div class="settings-body-toolbar"><span>Open a template only when you need to edit its fields.</span><button id="addMarkdownTemplate" class="secondary" type="button">+ template</button></div>' +
      '<div class="hub-card-options settings-editor-list" id="markdownTemplateEditors">' + markdownTemplates.map((template) => renderMarkdownTemplateEditor(template, false)).join("") + '</div>',
  }) +
  renderSettingsSection({
    id: "hub",
    kicker: "Hub",
    title: "Sections and cards",
    copy: "Controls the cards shown on the first screen.",
    pills: [sections.length + " sections"],
    body: '<div class="settings-body-toolbar"><span>Open a section or card only when changing its routing.</span><button id="addHubSection" class="secondary" type="button">+ section</button></div>' +
      '<div class="hub-card-options settings-editor-list" id="hubSectionEditors">' + sections.map((section) => renderHubSectionEditor(section, false)).join("") + '</div>',
  }) +
  '</div></div>' +
  '<div class="settings-footer"><span>Project setup stays in this room. Appearance applies to all rooms.</span><div class="docqa-actions"><button id="saveSettings" class="primary" type="button">Save settings</button></div></div>';
  wireSettingsTabs(holder);
  activateSettingsSection(state.settingsSection, { resetScroll: false });
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
  const startupContext = {
    enabled: Boolean(el("startupContextEnabled")?.checked),
    fileNames: linesFromTextarea("startupContextFileNames"),
    globalPaths: linesFromTextarea("startupContextGlobalPaths"),
  };
  const startupSkills = {
    enabled: Boolean(el("startupSkillsEnabled")?.checked),
    folderNames: linesFromTextarea("startupSkillFolderNames"),
  };
  const agentHookSources = agentHookSourcesFromTextarea("startupAgentHookSources");
  const agentHookPaths = agentHookSources.flatMap((source) => source.paths || []);
  const startupHooks = {
    enabled: Boolean(el("startupHooksEnabled")?.checked),
    editable: Boolean(el("startupHooksEditable")?.checked),
    agentHooks: Boolean(el("startupAgentHooks")?.checked),
    codexHooks: Boolean(el("startupAgentHooks")?.checked),
    gitHooks: Boolean(el("startupGitHooks")?.checked),
    hookManagers: Boolean(el("startupHookManagers")?.checked),
    fileNames: linesFromTextarea("startupHookFileNames"),
    agentHookSources,
    agentHookPaths,
    codexPaths: agentHookPaths.filter((item) => item.includes(".codex/")),
    managerPaths: linesFromTextarea("startupHookManagerPaths"),
  };
  const appearance = {
    fileTheme: el("fileTheme")?.value || DEFAULT_FILE_THEME,
    autoOpenGitDiff: el("autoOpenGitDiff")?.checked !== false,
    showHiddenFiles: el("showHiddenFiles")?.checked !== false,
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
      body: JSON.stringify({ settings: { watchAllow, reviewPaths, startupContext, startupSkills, startupHooks, appearance, markdownTemplates, hubCards, hubSections } }),
    });
    state.settings = result.settings;
    applyFileTheme();
    state.availableHubCards = result.availableHubCards || state.availableHubCards;
    state.hubFolders = result.hubCards || [];
    state.rootHubSections = result.hubSections || [];
    state.hubSections = state.rootHubSections;
    const [filesData, startupContextData, startupSkillsData, startupHooksData, docqa, doctor] = await Promise.all([
      api(filesApiPath()),
      api("/api/startup-context"),
      api("/api/startup-skills"),
      api("/api/startup-hooks"),
      api("/api/docqa"),
      api("/api/doctor"),
    ]);
    state.files = filesData.files || state.files;
    state.startupContextFiles = startupContextData.files || [];
    state.startupSkillFolders = startupSkillsData.folders || [];
    state.startupHookFiles = startupHooksData.files || [];
    renderFiles();
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

function formatAgentHookSourcesForTextarea(sources = [], fallbackPaths = []) {
  const usableSources = Array.isArray(sources) && sources.length
    ? sources
    : fallbackPaths.length
      ? [{ label: "Agent", paths: fallbackPaths }]
      : [{ label: "Codex", paths: [".codex/hooks.json"] }];
  return usableSources
    .map((source) => [source.label || source.id || "Agent", ...(source.paths || [])].filter(Boolean).join(" | "))
    .join("\n");
}

function agentHookSourcesFromTextarea(id) {
  return linesFromTextarea(id).map((line) => {
    const parts = line.split("|").map((part) => part.trim()).filter(Boolean);
    const label = parts.shift() || "";
    const paths = parts.map(normalizeUiPath).filter(Boolean);
    if (!label || !paths.length) return null;
    return { id: slugifyUiId(label) || "agent", label, paths };
  }).filter(Boolean);
}

function normalizeUiPath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").trim();
}

function showSettingsPage() {
  if (state.dirty && !confirm("You have unsaved changes. Open settings?")) return;
  state.page = "settings";
  state.settingsOpen = true;
  state.pendingMarkdown = null;
  state.selected = null;
  state.selectedReadOnly = false;
  state.openingFilePath = null;
  state.reviewModePath = null;
  state.reviewModeStatus = null;
  state.selectedDiff = null;
  resetExternalChangeState();
  state.savedHash = null;
  state.dirty = false;
  el("title").textContent = "Settings";
  el("path").textContent = "review · startup · appearance · templates · hub";
  el("impact").textContent = "Choose one category, make the change, then save once.";
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

async function handleHubAction() {
  if (state.page === "hub") showSettingsPage();
  else {
    await waitForReviewFinalizationBeforeNavigation();
    goHub();
  }
}

function updateActionBanner() {
  const onFile = state.page === "file" && Boolean(state.selected);
  const workspaceDock = document.querySelector(".workspace-dock");
  const fileOpening = onFile && Boolean(state.openingFilePath);
  workspaceDock?.setAttribute("aria-busy", fileOpening ? "true" : "false");
  const hasGitDiff = onFile && !state.selectedStartupContext && state.selectedDiff?.available !== false && Boolean(state.selectedDiff?.changed);
  el("hub").textContent = state.page === "hub" ? "Settings" : "Hub";
  el("hub").title = state.page === "hub" ? "Open settings" : "Back to hub";
  const workspaceTitle = el("workspaceTitle");
  if (workspaceTitle) {
    workspaceTitle.textContent = onFile
      ? state.selected
      : state.page === "settings"
        ? "Settings"
        : state.page === "new-doc"
          ? "New document"
          : "Context Room";
    workspaceTitle.title = workspaceTitle.textContent;
  }
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
  holder.innerHTML = sections.map((section) => '<section class="hub-section"><div class="hub-section-title">' + escapeHtml(section.title || "Section") + '</div><div class="hub-section-grid">' + (section.cards || []).map((card) => renderHubFolderCard(card, activeIds)).join("") + '</div></section>').join("") + renderStartupContextPanel() + renderStartupSkillsPanel() + renderStartupHooksPanel();
  document.querySelectorAll("[data-hub-disclosure]").forEach((details) => details.addEventListener("toggle", () => {
    const id = details.dataset.hubDisclosure;
    if (!id) return;
    if (details.open) state.hubDisclosuresOpen.add(id);
    else state.hubDisclosuresOpen.delete(id);
  }));
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
  document.querySelector("[data-startup-hooks-help]")?.addEventListener("toggle", (event) => {
    state.startupHooksHelpOpen = Boolean(event.currentTarget.open);
  });
  document.querySelectorAll("[data-startup-hook-filter]").forEach((button) => button.addEventListener("click", () => setStartupHookFilter(button.dataset.startupHookFilter)));
  document.querySelectorAll("[data-startup-hook-order]").forEach((button) => button.addEventListener("click", () => selectStartupHookFile(button.dataset.startupHookOrder).catch((error) => setStatus(error.message))));
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
  return renderHubDisclosure({
    id: "startup-context",
    title: "Startup context",
    count: files.length + " file" + (files.length === 1 ? "" : "s"),
    copy: "Agent instruction files found from the filesystem root down to this Context Room root.",
    body,
  });
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
  const skillCount = folders.reduce((sum, folder) => sum + Number(folder.skillCount || 0), 0);
  return renderHubDisclosure({
    id: "startup-skills",
    title: "Startup skills",
    count: skillCount + " skill" + (skillCount === 1 ? "" : "s"),
    copy: "Skill folders found from the filesystem root down to this Context Room root.",
    body,
  });
}

function renderStartupHooksPanel() {
  if (state.settings?.startupHooks?.enabled === false) return "";
  const files = (state.startupHookFiles || []).sort((a, b) => (a.startupContext.order || 0) - (b.startupContext.order || 0));
  if (!files.length) return "";
  const counts = startupHookFilterCounts(files);
  const activeFilter = startupHookFilterId(state.startupHookFilter);
  const visibleFiles = activeFilter === "all"
    ? files
    : files.filter((file) => startupHookFilterMatches(file.startupContext || {}, activeFilter));
  const filterControls = '<div class="startup-hook-filters" role="group" aria-label="Startup hook filters">' + startupHookFilterOptions(files, counts)
    .map(([id, label, count]) => '<button class="startup-hook-filter ' + (activeFilter === id ? 'active' : '') + '" type="button" data-startup-hook-filter="' + escapeHtml(id) + '">' + escapeHtml(label) + ' · ' + escapeHtml(count) + '</button>').join("") + '</div>';
  const body = visibleFiles.length
    ? '<div class="startup-context-list">' + visibleFiles.map((file) => {
    const hook = file.startupContext || {};
    const kind = startupHookKind(hook);
    const kindLabel = kind === "git" || kind === "manager" ? startupHookFilterLabel(kind, files) : startupHookProviderShortLabel(hook);
    const flags = [
      hook.sourceLabel || "hook",
      hook.event || "",
      hook.tracked ? "tracked" : "untracked",
      hook.executable ? "executable" : "not executable",
      hook.readOnly ? "read-only" : "editable",
    ].filter(Boolean).join(" · ");
    const commandLine = hook.commandSummary ? '<small>' + escapeHtml(hook.commandSummary) + '</small>' : '';
    return '<button class="startup-context-item startup-hook-item" type="button" data-startup-hook-order="' + escapeHtml(hook.order) + '">' +
      '<strong>' + escapeHtml((hook.order || "?") + ". " + (hook.label || hook.fileName || "hook")) + '</strong>' +
      '<span><span class="startup-hook-meta"><b class="startup-hook-kind ' + escapeHtml(kind) + '">' + escapeHtml(kindLabel) + '</b><em>' + escapeHtml(flags) + '</em></span><p>' + escapeHtml(hook.description || "Hook file that can affect agent work, commits, or validation.") + '</p><code>' + escapeHtml(hook.displayPath || "") + '</code>' + commandLine + '</span>' +
    '</button>';
  }).join("") + '</div>'
    : '<div class="issue">No ' + escapeHtml(startupHookFilterLabel(activeFilter, files).toLowerCase()) + ' found.</div>';
  const help = '<details class="startup-hooks-help" data-startup-hooks-help ' + (state.startupHooksHelpOpen ? 'open' : '') + '><summary>Agent hook sources and related hooks</summary><div>' +
    '<section class="startup-hooks-help-section"><h4>Agent hook sources</h4><p>Agent hooks are files owned by an AI coding tool or assistant runtime. Configure the systems to show in settings with lines like <code>Name | config path | plugin folder</code>. Context Room then groups them by that source name, whether the tool is Codex, Claude Code, OpenCode, or something custom.</p></section>' +
    '<section class="startup-hooks-help-section"><h4>Common agent events</h4><p>Some tools expose JSON lifecycle hooks. Names vary by provider, but common events include:</p><ul><li><strong>Before tool use</strong>: runs before an agent command or tool call.</li><li><strong>After tool use</strong>: runs after an agent command or tool call.</li><li><strong>User prompt</strong>: runs when the user submits a message.</li><li><strong>Notification</strong>: runs when the agent app sends a notification.</li><li><strong>Session start/stop</strong>: runs around agent session boundaries.</li><li><strong>Subagent stop</strong>: runs when a delegated agent finishes.</li></ul></section>' +
    '<section class="startup-hooks-help-section"><h4>Config and plugins</h4><p>Some systems store hooks in one config file. Others use plugin folders or scripts. Add every relevant config or folder path to that source in settings; remove a source line when you do not want that system shown.</p></section>' +
    '<section class="startup-hooks-help-section"><h4>Git hooks</h4><p>Git-owned scripts from <code>.git/hooks</code> or <code>core.hooksPath</code>. They run on Git actions such as commit, push, or commit-message preparation.</p></section>' +
    '<section class="startup-hooks-help-section"><h4>Hook managers</h4><p>Repo tools that install or orchestrate Git hooks. Examples include Husky, Lefthook, pre-commit, lint-staged, and package hook config.</p></section>' +
    '<p>Hooks are read-only by default because they execute code. Enable editing only when you intentionally want Context Room to modify them.</p>' +
  '</div></details>';
  return renderHubDisclosure({
    id: "startup-hooks",
    title: "Startup hooks",
    count: files.length + " hook" + (files.length === 1 ? "" : "s"),
    copy: "Hooks and hook-manager files that can change or block agent work.",
    body: help + filterControls + body,
  });
}

function renderHubDisclosure({ id, title, count, copy, body }) {
  const open = state.hubDisclosuresOpen.has(id) ? " open" : "";
  return '<details class="startup-context-panel hub-disclosure" data-hub-disclosure="' + escapeHtml(id) + '"' + open + '>' +
    '<summary><span class="hub-disclosure-title">' + escapeHtml(title) + '</span><span class="hub-disclosure-count">' + escapeHtml(count) + '</span></summary>' +
    '<div class="hub-disclosure-body"><div class="startup-context-copy">' + escapeHtml(copy) + '</div>' + body + '</div>' +
  '</details>';
}

function setStartupHookFilter(filter = "all") {
  state.startupHookFilter = startupHookFilterId(filter);
  renderHubFolders();
  setStatus("showing " + startupHookFilterLabel(state.startupHookFilter, state.startupHookFiles || []).toLowerCase());
}

function startupHookFilterId(filter = "all") {
  const clean = String(filter || "all").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  return clean || "all";
}

function startupHookFilterCounts(files = []) {
  const counts = { all: files.length, agent: 0, git: 0, manager: 0 };
  for (const file of files) {
    const kind = startupHookKind(file.startupContext || {});
    counts[kind] = (counts[kind] || 0) + 1;
    if (isAgentHookKind(kind)) counts.agent += 1;
  }
  return counts;
}

function startupHookFilterOptions(files = [], counts = startupHookFilterCounts(files)) {
  const providerLabels = new Map();
  for (const file of files) {
    const hook = file.startupContext || {};
    const kind = startupHookKind(hook);
    if (isAgentHookKind(kind) && kind !== "agent" && !providerLabels.has(kind)) {
      providerLabels.set(kind, startupHookProviderShortLabel(hook));
    }
  }
  const options = [["all", "All", counts.all], ["agent", "Agent hooks", counts.agent]];
  for (const [id, label] of providerLabels) options.push([id, label, counts[id] || 0]);
  options.push(["git", "Git hooks", counts.git || 0], ["manager", "Hook managers", counts.manager || 0]);
  return options;
}

function startupHookFilterMatches(hook = {}, filter = "all") {
  const kind = startupHookKind(hook);
  if (filter === "all") return true;
  if (filter === "agent") return isAgentHookKind(kind);
  return kind === filter;
}

function startupHookKind(hook = {}) {
  if (hook.provider) return startupHookFilterId(hook.provider);
  if (String(hook.source || "").includes("-agent-")) return "agent";
  if (["git-hooks", "core-hooks-path"].includes(hook.source)) return "git";
  return "manager";
}

function isAgentHookKind(kind = "") {
  return !["all", "git", "manager"].includes(kind);
}

function startupHookProviderShortLabel(hook = {}) {
  return String(hook.sourceLabel || hook.provider || "Agent hooks").replace(/\s+hooks$/i, "") || "Agent";
}

function startupHookFilterLabel(kind = "all", files = []) {
  if (kind === "agent") return "Agent hooks";
  if (kind === "git") return "Git hooks";
  if (kind === "manager") return "Hook managers";
  if (kind !== "all") {
    const match = (files || []).find((file) => startupHookKind(file.startupContext || {}) === kind);
    if (match) return startupHookProviderShortLabel(match.startupContext || {});
    return kind.split(/[-_]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  }
  return "All hooks";
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


async function applyReviewDecision(path, status, options = {}) {
  if (!path) return;
  const normalizedStatus = status === "unverified" ? "unverified" : status === "verified" ? "verified" : "needs_changes";
  const previousQueue = options.previousQueue || state.docqa?.queue || [];
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
  state.selectedReview = docqa.queue.find((item) => item.path === path)?.path || nextReviewItemAfter(previousQueue, path, docqa.queue || [])?.path || docqa.queue[0]?.path || null;
  if (state.selected === path) {
    updateHeader();
    updatePreview();
    const finalizedInPlace = options.viewState ? finalizeExternalReviewPanelInPlace(options.viewState) : false;
    if (!finalizedInPlace) {
      renderViewer();
      if (options.viewState) restoreEditorViewState(options.viewState);
    }
    setStatus(normalizedStatus === "verified" ? "file verified" : normalizedStatus === "unverified" ? "file marked unverified" : "needs changes");
  } else {
    renderDocQaDashboard();
    setStatus(normalizedStatus === "verified" ? "verified" : normalizedStatus === "unverified" ? "unverified" : "needs changes");
  }
}

async function advanceAfterInlineReviewRemoval(path, previousQueue, statusWhenDone) {
  const nextItem = nextReviewItemAfter(previousQueue, path, state.docqa?.queue || []);
  state.selectedReview = nextItem?.path || state.docqa?.queue?.[0]?.path || null;
  goHub();
  setStatus(nextItem ? "review applied · next review available" : statusWhenDone);
}

function nextReviewPath(queue = [], currentPath = null) {
  const paths = queue.map((item) => item?.path).filter(Boolean);
  if (!paths.length) return null;
  if (paths.length === 1 && paths[0] === currentPath) return null;
  const index = paths.indexOf(currentPath);
  if (index < 0) return paths[0] || null;
  return paths[(index + 1) % paths.length] || null;
}

function skipVerifyConfirmEnabled() {
  try { return window.localStorage?.getItem(VERIFY_CONFIRM_STORAGE_KEY) === "1"; }
  catch { return false; }
}

function setSkipVerifyConfirm(enabled) {
  try {
    if (enabled) window.localStorage?.setItem(VERIFY_CONFIRM_STORAGE_KEY, "1");
    else window.localStorage?.removeItem(VERIFY_CONFIRM_STORAGE_KEY);
  } catch {}
}

async function requestReviewDecision(path, status) {
  const normalizedStatus = status === "unverified" ? "unverified" : status === "verified" ? "verified" : "needs_changes";
  if (normalizedStatus !== "verified") {
    await applyReviewDecision(path, normalizedStatus);
    return;
  }
  if (!path || state.reviewModePath !== path) return;
  if (!reviewActionForSelectedFile()) return;
  if (state.dirty && !confirm("This file has unsaved changes. Mark verified without saving?")) return;
  if (skipVerifyConfirmEnabled()) {
    await applyReviewDecision(path, "verified");
    return;
  }
  showConfirmDialog({
    title: "Mark verified?",
    body: "This marks the current content as trusted. Use Next review when ready.",
    confirmLabel: "Mark verified",
    confirmVariant: "primary",
    checkboxLabel: "Do not ask again",
    onConfirm: ({ checked } = {}) => {
      if (checked) setSkipVerifyConfirm(true);
      applyReviewDecision(path, "verified").catch((error) => setStatus(error.message));
    },
  });
}

async function verifyCurrentFile() {
  if (!state.selected) return;
  if (state.reviewModePath !== state.selected) return;
  await requestReviewDecision(state.selected, "verified");
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
  await waitForReviewFinalizationBeforeNavigation();
  state.historyIndex = nextIndex;
  await selectFile(state.history[state.historyIndex], { pushHistory: false });
}

function goHub() {
  if (state.dirty && !confirm("You have unsaved changes. Return to hub?")) return;
  collapseSidebarOnNarrow();
  state.selected = null;
  state.selectedReadOnly = false;
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
  const readOnlySelected = Boolean(state.selectedStartupContext?.readOnly || state.selectedReadOnly);
  el("save").disabled = blockedByDiskChange || readOnlySelected || !state.dirty || !state.selected;
  const headerSave = document.querySelector("[data-file-save]");
  if (headerSave) headerSave.disabled = blockedByDiskChange || readOnlySelected || !state.dirty || !state.selected;
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
  const openingFile = state.openingFilePath === state.selected && state.fileContentReadyPath !== state.selected;
  const loadingFile = openingFile;
  const loadError = !isStartupFile && state.fileLoadError?.path === state.selected ? state.fileLoadError : null;
  const conflict = activeFileConflict();
  const externalChange = activeExternalChange();
  const file = isStartupFile
    ? { label: state.selectedStartupContext.fileName, path: state.selectedStartupContext.displayPath }
    : state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  const isHtmlDocument = !isStartupFile && isHtmlDocumentPath(file.path);
  const hasDiff = !isStartupFile && diff.available !== false && diff.changed;
  const diffMarkup = hasDiff ? renderDiffPanel(diff) : "";
  const templateState = !isStartupFile && !isHtmlDocument && !openingFile && !loadError && !conflict && !externalChange ? templateStateForContent(text) : null;
  const actionsMarkup = loadError
    ? '<div class="file-actions"><button class="file-action primary" type="button" data-file-retry>Retry</button></div>'
    : openingFile
      ? renderFileActionsLoading()
      : externalChange && !conflict
      ? renderExternalReviewActions(externalChange, { fileActionOptions: externalReviewFileActionOptions() })
      : renderFileActionButtons({ reviewAction: isStartupFile || state.selectedReadOnly ? null : reviewActionForSelectedFile(), nextReviewAction: isStartupFile || state.selectedReadOnly ? null : nextReviewActionForSelectedFile(), dirty: state.dirty, templateState, blockedByConflict: Boolean(conflict || externalChange), readOnly: Boolean(state.selectedStartupContext?.readOnly || state.selectedReadOnly), deletable: !isStartupFile && !state.selectedReadOnly, savable: !isHtmlDocument });
  const conflictMarkup = conflict ? renderConflictPanel(conflict, text) : "";
  const editorMarkup = loadError
    ? renderFileLoadError(loadError)
    : loadingFile
      ? renderFileLoadingState(file)
      : !conflict && externalChange
        ? isHtmlDocument
          ? renderHtmlDocumentPreview(externalChange.diskContent || "", file.path)
          : renderExternalReviewDocument(externalReviewBaseContent(externalChange), externalChange.diskContent || "")
        : isHtmlDocument
          ? renderHtmlDocumentPreview(text, file.path)
        : state.mode === "edit"
          ? renderDocumentEditor(text, file.path)
          : renderDocumentView(text, file.path);
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
  document.querySelector("[data-file-retry]")?.addEventListener("click", () => selectFile(state.selected, { forceReload: true, pushHistory: false, revealInExplorer: false, reviewMode: state.reviewModePath === state.selected }).catch((error) => setStatus(error.message)));
  document.querySelector("[data-apply-external-change]")?.addEventListener("click", () => applyExternalChange().catch((error) => setStatus(error.message)));
  document.querySelector("[data-reject-external-change]")?.addEventListener("click", () => promptRejectExternalChange());
  wireExternalReviewDecisionButtons();
  wireExternalReviewAllButtons();
  wireExternalReviewJumpButtons();
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

function renderFileLoadingState(file = {}) {
  return '<div class="file-load-state"><div class="file-load-state-inner"><strong>Opening file...</strong><span><code>' + escapeHtml(file.path || state.selected || "") + '</code></span></div></div>';
}

function renderFileActionsLoading() {
  return '<div class="file-actions file-actions-loading" aria-hidden="true">' +
    '<span class="file-action-placeholder wide"></span>' +
    '<span class="file-action-placeholder"></span>' +
    '<span class="file-action-placeholder short"></span>' +
  '</div>';
}

function renderFileLoadError(error = {}) {
  return '<div class="file-load-state error"><div class="file-load-state-inner"><strong>Could not open this file</strong><span>' + escapeHtml(error.message || "Request failed.") + '</span><span><code>' + escapeHtml(error.path || state.selected || "") + '</code></span></div></div>';
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

function usePlainTextSurface(filePath, text) {
  const value = String(text || "");
  return !String(filePath || "").toLowerCase().endsWith(".md") || value.length > 120_000 || value.split("\n", 2_501).length > 2_500;
}

function isHtmlDocumentPath(filePath) {
  return /\.html?$/i.test(String(filePath || ""));
}

function contextRoomVisualPatternStyles() {
  return [
    "[data-tone='accent'] { --cr-tone: var(--cr-accent); }",
    "[data-tone='positive'] { --cr-tone: var(--cr-positive); }",
    "[data-tone='warning'] { --cr-tone: var(--cr-secondary); }",
    "[data-tone='negative'] { --cr-tone: var(--cr-negative); }",
    ".cr-vis-label { color: var(--cr-muted); font: 750 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-vis-value { color: var(--cr-text); font-size: 24px; font-weight: 850; line-height: 1; }",
    ".cr-vis-note { color: var(--cr-muted); font-size: 11px; }",
    ".cr-kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }",
    ".cr-kpi { --cr-tone: var(--cr-accent); min-width: 0; border: 1px solid var(--cr-line); border-top: 3px solid var(--cr-tone); border-radius: var(--cr-radius); background: var(--cr-surface); padding: 15px; }",
    ".cr-kpi strong { display: block; margin: 8px 0 5px; color: var(--cr-text); font-size: 28px; line-height: 1; }",
    ".cr-kpi span { color: var(--cr-muted); font-size: 12px; }",
    ".cr-stat-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); border: 1px solid var(--cr-line); border-radius: var(--cr-radius); background: var(--cr-surface-strong); overflow: hidden; }",
    ".cr-stat { min-width: 0; padding: 14px 16px; }",
    ".cr-stat + .cr-stat { border-left: 1px solid var(--cr-line); }",
    ".cr-stat strong { display: block; color: var(--cr-text); font-size: 20px; }",
    ".cr-stat span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-scorecard { display: grid; border-top: 1px solid var(--cr-line); }",
    ".cr-score { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--cr-line); }",
    ".cr-score strong { color: var(--cr-text); font-size: 13px; }",
    ".cr-score span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-score-grade { min-width: 58px; border: 1px solid color-mix(in srgb, var(--cr-tone) 55%, var(--cr-line)); border-radius: 999px; padding: 5px 8px; color: var(--cr-tone) !important; text-align: center; font-weight: 850; }",
    ".cr-progress-list, .cr-bullet-chart, .cr-bar-chart, .cr-grouped-bars, .cr-benchmark, .cr-distribution, .cr-lollipop-chart, .cr-dot-plot { display: grid; gap: 12px; }",
    ".cr-progress { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px 12px; align-items: center; }",
    ".cr-progress strong, .cr-chart-label { color: var(--cr-text); font-size: 12px; }",
    ".cr-progress > span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-progress-track, .cr-bar-track, .cr-benchmark-track { grid-column: 1 / -1; height: 9px; border-radius: 999px; background: color-mix(in srgb, var(--cr-line) 68%, transparent); overflow: hidden; }",
    ".cr-progress-fill, .cr-bar-fill { width: var(--value, 0%); height: 100%; border-radius: inherit; background: var(--cr-tone, var(--cr-accent)); }",
    ".cr-bullet { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(90px, .35fr) minmax(180px, 1fr) auto; gap: 12px; align-items: center; }",
    ".cr-bullet-track { position: relative; height: 14px; background: linear-gradient(90deg, color-mix(in srgb, var(--cr-line) 58%, transparent) 0 33%, color-mix(in srgb, var(--cr-line) 78%, transparent) 33% 66%, color-mix(in srgb, var(--cr-line) 95%, transparent) 66%); }",
    ".cr-bullet-track::before { content: ''; position: absolute; inset: 3px auto 3px 0; width: var(--value, 0%); background: var(--cr-tone); }",
    ".cr-bullet-track::after { content: ''; position: absolute; top: -3px; bottom: -3px; left: var(--target, 100%); width: 2px; background: var(--cr-text); }",
    ".cr-bullet > span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-gauge { --cr-tone: var(--cr-accent); display: grid; gap: 9px; }",
    ".cr-gauge-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }",
    ".cr-gauge-track { position: relative; height: 18px; border-radius: 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--cr-negative) 75%, var(--cr-surface)) 0 33%, color-mix(in srgb, var(--cr-secondary) 75%, var(--cr-surface)) 33% 66%, color-mix(in srgb, var(--cr-positive) 75%, var(--cr-surface)) 66%); }",
    ".cr-gauge-track::after { content: ''; position: absolute; top: -5px; left: var(--value, 0%); width: 4px; height: 28px; border-radius: 4px; background: var(--cr-text); transform: translateX(-2px); box-shadow: 0 0 0 3px var(--cr-bg); }",
    ".cr-ring { --cr-tone: var(--cr-accent); position: relative; display: inline-grid; width: 124px; aspect-ratio: 1; place-items: center; border-radius: 50%; background: conic-gradient(var(--cr-tone) var(--value, 0%), color-mix(in srgb, var(--cr-line) 65%, transparent) 0); }",
    ".cr-ring::after { content: ''; position: absolute; inset: 13px; border-radius: 50%; background: var(--cr-surface); }",
    ".cr-ring > * { position: relative; z-index: 1; text-align: center; }",
    ".cr-ring strong { display: block; color: var(--cr-text); font-size: 24px; line-height: 1; }",
    ".cr-ring span { color: var(--cr-muted); font-size: 10px; }",
    ".cr-delta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }",
    ".cr-delta { --cr-tone: var(--cr-accent); border-left: 3px solid var(--cr-tone); background: color-mix(in srgb, var(--cr-tone) 7%, var(--cr-surface)); padding: 12px 14px; }",
    ".cr-delta strong { display: block; color: var(--cr-tone); font-size: 22px; }",
    ".cr-delta span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-status-summary { display: flex; flex-wrap: wrap; gap: 8px; }",
    ".cr-status { --cr-tone: var(--cr-accent); display: inline-flex; align-items: baseline; gap: 7px; border: 1px solid color-mix(in srgb, var(--cr-tone) 42%, var(--cr-line)); border-radius: 999px; padding: 7px 10px; background: color-mix(in srgb, var(--cr-tone) 8%, var(--cr-surface)); }",
    ".cr-status strong { color: var(--cr-tone); font-size: 15px; }",
    ".cr-status span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-before-after { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 12px; align-items: stretch; }",
    ".cr-before-after > article, .cr-pros-cons > article { min-width: 0; border: 1px solid var(--cr-line); border-radius: var(--cr-radius); padding: 16px; background: var(--cr-surface); }",
    ".cr-change-arrow { align-self: center; color: var(--cr-accent); font: 850 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-pros-cons { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }",
    ".cr-pros-cons ul { margin: 10px 0 0; padding-left: 18px; color: var(--cr-muted); }",
    ".cr-pros-cons li + li { margin-top: 6px; }",
    ".cr-decision-matrix { overflow-x: auto; border: 1px solid var(--cr-line); border-radius: var(--cr-radius); }",
    ".cr-decision-row { --columns: 3; min-width: 620px; display: grid; grid-template-columns: minmax(160px, 1.35fr) repeat(var(--columns), minmax(90px, 1fr)); }",
    ".cr-decision-row > * { padding: 10px 12px; border-right: 1px solid var(--cr-line); border-bottom: 1px solid var(--cr-line); color: var(--cr-muted); font-size: 12px; text-align: center; }",
    ".cr-decision-row > :first-child { color: var(--cr-text); text-align: left; }",
    ".cr-decision-row[data-head] > * { background: var(--cr-surface-strong); color: var(--cr-text); font-weight: 800; }",
    ".cr-decision-row:last-child > * { border-bottom: 0; }",
    ".cr-feature-matrix { width: 100%; min-width: 560px; border-collapse: collapse; }",
    ".cr-feature-matrix th, .cr-feature-matrix td { padding: 10px 12px; border-bottom: 1px solid var(--cr-line); text-align: center; }",
    ".cr-feature-matrix th:first-child, .cr-feature-matrix td:first-child { text-align: left; }",
    ".cr-feature-matrix th { color: var(--cr-text); font-size: 11px; }",
    ".cr-feature-matrix td { color: var(--cr-muted); font-size: 12px; }",
    ".cr-quadrant { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-height: 320px; border: 1px solid var(--cr-line); background: linear-gradient(90deg, transparent calc(50% - .5px), var(--cr-line) 50%, transparent calc(50% + .5px)), linear-gradient(0deg, transparent calc(50% - .5px), var(--cr-line) 50%, transparent calc(50% + .5px)); }",
    ".cr-quadrant-cell { min-width: 0; padding: 18px; }",
    ".cr-quadrant-cell h3 { color: var(--cr-text); }",
    ".cr-quadrant-cell p { font-size: 12px; }",
    ".cr-spectrum { display: grid; gap: 10px; padding: 8px 0; }",
    ".cr-spectrum-track { position: relative; height: 10px; margin: 12px 8px; border-radius: 999px; background: linear-gradient(90deg, var(--cr-negative), var(--cr-secondary), var(--cr-positive)); }",
    ".cr-spectrum-point { --cr-tone: var(--cr-text); position: absolute; left: var(--value, 50%); top: 50%; width: 14px; height: 14px; border: 3px solid var(--cr-bg); border-radius: 50%; background: var(--cr-tone); transform: translate(-50%, -50%); }",
    ".cr-spectrum-labels { display: flex; justify-content: space-between; gap: 12px; color: var(--cr-muted); font-size: 10px; }",
    ".cr-ranking { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; counter-reset: cr-rank; }",
    ".cr-ranking > li { --cr-tone: var(--cr-accent); counter-increment: cr-rank; display: grid; grid-template-columns: 28px minmax(100px, .4fr) minmax(160px, 1fr) auto; gap: 10px; align-items: center; }",
    ".cr-ranking > li::before { content: counter(cr-rank); color: var(--cr-muted); font: 800 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-ranking-bar { height: 8px; background: color-mix(in srgb, var(--cr-line) 65%, transparent); }",
    ".cr-ranking-bar::before { content: ''; display: block; width: var(--value, 0%); height: 100%; background: var(--cr-tone); }",
    ".cr-ranking strong { color: var(--cr-text); font-size: 12px; }",
    ".cr-ranking span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-benchmark-row { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(90px, .3fr) minmax(180px, 1fr) auto; gap: 12px; align-items: center; }",
    ".cr-benchmark-track { position: relative; grid-column: auto; height: 14px; overflow: visible; }",
    ".cr-benchmark-track::before { content: ''; position: absolute; inset: 3px auto 3px 0; width: var(--baseline, 0%); background: var(--cr-muted); opacity: .45; }",
    ".cr-benchmark-track::after { content: ''; position: absolute; inset: 0 auto 0 0; width: var(--value, 0%); border-right: 2px solid var(--cr-tone); background: color-mix(in srgb, var(--cr-tone) 48%, transparent); }",
    ".cr-distribution-row { display: grid; grid-template-columns: minmax(90px, .3fr) minmax(180px, 1fr); gap: 12px; align-items: center; }",
    ".cr-distribution-track { position: relative; height: 16px; border-bottom: 1px solid var(--cr-line); }",
    ".cr-distribution-range { position: absolute; left: var(--low, 10%); right: calc(100% - var(--high, 90%)); top: 5px; height: 6px; background: color-mix(in srgb, var(--cr-accent) 30%, var(--cr-line)); }",
    ".cr-distribution-track::after { content: ''; position: absolute; left: var(--median, 50%); top: 1px; width: 2px; height: 14px; background: var(--cr-accent); }",
    ".cr-chart-row { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(90px, .32fr) minmax(180px, 1fr) auto; gap: 12px; align-items: center; }",
    ".cr-chart-row .cr-bar-track { grid-column: auto; }",
    ".cr-grouped-bars .cr-bar-group { display: grid; gap: 4px; }",
    ".cr-grouped-bars .cr-bar-track { grid-column: auto; height: 6px; }",
    ".cr-stacked-bar { display: flex; width: 100%; min-height: 26px; overflow: hidden; border-radius: 5px; background: color-mix(in srgb, var(--cr-line) 65%, transparent); }",
    ".cr-stacked-segment { --cr-tone: var(--cr-accent); flex: 0 0 var(--value, 0%); display: grid; place-items: center; min-width: 0; background: var(--cr-tone); color: var(--cr-bg); font-size: 10px; font-weight: 850; }",
    ".cr-diverging-bars { display: grid; gap: 10px; }",
    ".cr-diverging-row { display: grid; grid-template-columns: minmax(120px, 1fr) auto minmax(120px, 1fr); gap: 10px; align-items: center; }",
    ".cr-diverging-side { display: flex; height: 12px; background: color-mix(in srgb, var(--cr-line) 60%, transparent); }",
    ".cr-diverging-side.negative { justify-content: flex-end; }",
    ".cr-diverging-fill { width: var(--value, 0%); background: var(--cr-tone, var(--cr-accent)); }",
    ".cr-diverging-row > strong { color: var(--cr-text); font-size: 11px; }",
    ".cr-lollipop-row { display: grid; grid-template-columns: minmax(90px, .3fr) minmax(180px, 1fr) auto; gap: 12px; align-items: center; }",
    ".cr-lollipop-track { --cr-tone: var(--cr-accent); position: relative; height: 18px; }",
    ".cr-lollipop-track::before { content: ''; position: absolute; top: 8px; left: 0; width: var(--value, 0%); height: 2px; background: color-mix(in srgb, var(--cr-tone) 65%, var(--cr-line)); }",
    ".cr-lollipop-track::after { content: ''; position: absolute; left: var(--value, 0%); top: 3px; width: 12px; height: 12px; border: 3px solid var(--cr-bg); border-radius: 50%; background: var(--cr-tone); transform: translateX(-50%); }",
    ".cr-dot-row { display: grid; grid-template-columns: minmax(90px, .3fr) minmax(180px, 1fr); gap: 12px; align-items: center; }",
    ".cr-dot-track { position: relative; height: 18px; border-bottom: 1px solid var(--cr-line); }",
    ".cr-dot { --cr-tone: var(--cr-accent); position: absolute; left: var(--value, 50%); bottom: -5px; width: 10px; height: 10px; border: 2px solid var(--cr-bg); border-radius: 50%; background: var(--cr-tone); transform: translateX(-50%); }",
    ".cr-histogram, .cr-sparkline, .cr-waterfall { display: flex; align-items: end; gap: 5px; min-height: 150px; padding-top: 12px; border-bottom: 1px solid var(--cr-line); }",
    ".cr-histogram-bar, .cr-sparkline-bar, .cr-waterfall-bar { --cr-tone: var(--cr-accent); flex: 1 1 0; min-width: 5px; height: var(--value, 0%); background: var(--cr-tone); }",
    ".cr-sparkline { min-height: 52px; gap: 3px; border-bottom: 0; }",
    ".cr-sparkline-bar { border-radius: 2px 2px 0 0; opacity: .8; }",
    ".cr-heatmap { display: grid; grid-template-columns: repeat(var(--columns, 7), minmax(24px, 1fr)); gap: 4px; }",
    ".cr-heatmap-cell { --cr-tone: var(--cr-accent); display: grid; min-height: 38px; place-items: center; border: 1px solid color-mix(in srgb, var(--cr-tone) 18%, var(--cr-line)); background: color-mix(in srgb, var(--cr-tone) var(--level, 20%), var(--cr-surface)); color: var(--cr-text); font-size: 10px; }",
    ".cr-waterfall { min-height: 180px; gap: 8px; }",
    ".cr-waterfall-bar { align-self: end; margin-bottom: var(--offset, 0%); position: relative; }",
    ".cr-waterfall-bar span { position: absolute; left: 50%; bottom: calc(100% + 5px); color: var(--cr-muted); font-size: 9px; transform: translateX(-50%); white-space: nowrap; }",
    ".cr-timeline { display: grid; gap: 0; margin-left: 8px; border-left: 1px solid var(--cr-line); }",
    ".cr-timeline-item { --cr-tone: var(--cr-accent); position: relative; padding: 0 0 20px 22px; }",
    ".cr-timeline-item::before { content: ''; position: absolute; left: -6px; top: 4px; width: 11px; height: 11px; border: 3px solid var(--cr-bg); border-radius: 50%; background: var(--cr-tone); }",
    ".cr-timeline-item time { color: var(--cr-tone); font: 750 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-timeline-item h3 { margin: 5px 0 4px; }",
    ".cr-roadmap { overflow-x: auto; }",
    ".cr-roadmap-grid { min-width: 680px; display: grid; grid-template-columns: 120px repeat(var(--periods, 4), minmax(120px, 1fr)); gap: 6px; }",
    ".cr-roadmap-label, .cr-roadmap-period { padding: 8px; color: var(--cr-muted); font-size: 10px; }",
    ".cr-roadmap-period { text-align: center; border-bottom: 1px solid var(--cr-line); }",
    ".cr-roadmap-lane { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(var(--periods, 4), minmax(120px, 1fr)); min-height: 42px; background: repeating-linear-gradient(90deg, transparent 0 calc(25% - 1px), var(--cr-line) calc(25% - 1px) 25%); }",
    ".cr-roadmap-item { --cr-tone: var(--cr-accent); grid-column: var(--start, 1) / span var(--span, 1); align-self: center; margin: 4px; border-left: 3px solid var(--cr-tone); padding: 7px 9px; background: color-mix(in srgb, var(--cr-tone) 12%, var(--cr-surface)); color: var(--cr-text); font-size: 11px; }",
    ".cr-swimlane { overflow-x: auto; }",
    ".cr-swimlane-row { --columns: 4; min-width: 680px; display: grid; grid-template-columns: 120px repeat(var(--columns), minmax(120px, 1fr)); border-bottom: 1px solid var(--cr-line); }",
    ".cr-swimlane-row > strong { padding: 11px; color: var(--cr-text); font-size: 11px; }",
    ".cr-swimlane-track { grid-column: 2 / -1; display: grid; grid-template-columns: repeat(var(--columns), minmax(120px, 1fr)); min-height: 46px; border-left: 1px solid var(--cr-line); }",
    ".cr-swimlane-item { --cr-tone: var(--cr-accent); grid-column: var(--start, 1) / span var(--span, 1); align-self: center; margin: 5px; border: 1px solid color-mix(in srgb, var(--cr-tone) 42%, var(--cr-line)); border-radius: 5px; padding: 7px 9px; background: color-mix(in srgb, var(--cr-tone) 8%, var(--cr-surface)); color: var(--cr-text); font-size: 10px; }",
    ".cr-cycle { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 24px; }",
    ".cr-cycle-step { --cr-tone: var(--cr-accent); position: relative; border-top: 3px solid var(--cr-tone); padding: 13px; background: var(--cr-surface); }",
    ".cr-cycle-step:not(:last-child)::after { content: '>'; position: absolute; top: 50%; right: -17px; color: var(--cr-muted); transform: translateY(-50%); }",
    ".cr-funnel, .cr-pyramid { display: flex; flex-direction: column; align-items: center; gap: 5px; }",
    ".cr-funnel-step, .cr-pyramid-step { --cr-tone: var(--cr-accent); width: var(--width, 100%); min-width: 180px; padding: 10px 14px; background: color-mix(in srgb, var(--cr-tone) 20%, var(--cr-surface)); color: var(--cr-text); text-align: center; font-size: 12px; }",
    ".cr-tree, .cr-tree ul { margin: 0; padding-left: 20px; list-style: none; }",
    ".cr-tree { padding-left: 0; }",
    ".cr-tree li { position: relative; padding: 5px 0 5px 16px; color: var(--cr-muted); font-size: 12px; }",
    ".cr-tree li::before { content: ''; position: absolute; left: 0; top: 0; bottom: 50%; width: 10px; border-left: 1px solid var(--cr-line); border-bottom: 1px solid var(--cr-line); }",
    ".cr-tree strong { color: var(--cr-text); }",
    ".cr-dependency-chain { display: flex; align-items: stretch; gap: 22px; overflow-x: auto; padding: 2px; }",
    ".cr-dependency-node { --cr-tone: var(--cr-accent); position: relative; flex: 0 0 min(220px, 70vw); border: 1px solid var(--cr-line); border-left: 3px solid var(--cr-tone); padding: 13px; background: var(--cr-surface); }",
    ".cr-dependency-node:not(:last-child)::after { content: '>'; position: absolute; left: calc(100% + 8px); top: 50%; color: var(--cr-muted); transform: translateY(-50%); }",
    ".cr-status-board { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; }",
    ".cr-status-column { min-width: 0; border-top: 3px solid var(--cr-tone, var(--cr-accent)); background: color-mix(in srgb, var(--cr-tone, var(--cr-accent)) 5%, var(--cr-surface)); padding: 12px; }",
    ".cr-status-column > header { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 10px; color: var(--cr-text); font-size: 12px; font-weight: 800; }",
    ".cr-status-item { padding: 9px 0; border-top: 1px solid var(--cr-line); color: var(--cr-muted); font-size: 11px; }",
    "@media (max-width: 760px) { .cr-before-after, .cr-pros-cons { grid-template-columns: 1fr; } .cr-change-arrow { justify-self: center; transform: rotate(90deg); } .cr-quadrant { grid-template-columns: 1fr; background: none; } .cr-quadrant-cell + .cr-quadrant-cell { border-top: 1px solid var(--cr-line); } .cr-bullet, .cr-chart-row, .cr-lollipop-row, .cr-benchmark-row, .cr-distribution-row, .cr-dot-row { grid-template-columns: 1fr auto; } .cr-bullet-track, .cr-chart-row .cr-bar-track, .cr-lollipop-track, .cr-benchmark-track, .cr-distribution-track, .cr-dot-track { grid-column: 1 / -1; } .cr-ranking > li { grid-template-columns: 24px minmax(90px, 1fr) auto; } .cr-ranking-bar { grid-column: 2 / -1; } .cr-stat + .cr-stat { border-left: 0; border-top: 1px solid var(--cr-line); } .cr-cycle { grid-template-columns: 1fr 1fr; } }",
    "@media (max-width: 480px) { .cr-cycle { grid-template-columns: 1fr; gap: 10px; } .cr-cycle-step::after { display: none; } .cr-ring { width: 108px; } .cr-histogram, .cr-waterfall { min-height: 130px; } }",
  ].join("\n");
}

function contextRoomConceptPatternStyles() {
  return [
    ".cr-concept-spotlight { display: grid; grid-template-columns: minmax(0, 1fr) minmax(180px, 1.2fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }",
    ".cr-concept-core, .cr-concept-context { display: grid; align-content: center; min-width: 0; padding: 16px; text-align: center; }",
    ".cr-concept-core { border: 2px solid var(--cr-accent); background: color-mix(in srgb, var(--cr-accent) 10%, var(--cr-surface)); }",
    ".cr-concept-context { border-top: 1px solid var(--cr-line); border-bottom: 1px solid var(--cr-line); }",
    ".cr-concept-core strong { color: var(--cr-text); font-size: 18px; }",
    ".cr-concept-core span, .cr-concept-context span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-definition-anatomy { display: grid; grid-template-columns: minmax(150px, .45fr) minmax(0, 1fr); gap: 18px; }",
    ".cr-definition-term { display: grid; align-content: center; border-left: 4px solid var(--cr-accent); padding: 16px; background: color-mix(in srgb, var(--cr-accent) 8%, var(--cr-surface)); }",
    ".cr-definition-term strong { color: var(--cr-text); font-size: 20px; }",
    ".cr-definition-parts { display: grid; gap: 0; border-top: 1px solid var(--cr-line); }",
    ".cr-definition-part { display: grid; grid-template-columns: minmax(80px, .3fr) minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--cr-line); }",
    ".cr-definition-part strong { color: var(--cr-accent); font-size: 11px; }",
    ".cr-definition-part span { color: var(--cr-muted); font-size: 12px; }",
    ".cr-principle-stack { display: grid; gap: 7px; margin: 0; padding: 0; list-style: none; counter-reset: cr-principle; }",
    ".cr-principle-stack > li { --cr-tone: var(--cr-accent); counter-increment: cr-principle; display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; align-items: center; border-left: 3px solid var(--cr-tone); padding: 12px 14px; background: color-mix(in srgb, var(--cr-tone) 6%, var(--cr-surface)); }",
    ".cr-principle-stack > li::before { content: counter(cr-principle, decimal-leading-zero); color: var(--cr-tone); font: 850 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-layered-model { display: grid; gap: 5px; }",
    ".cr-model-layer { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(100px, .3fr) minmax(0, 1fr); gap: 14px; align-items: center; border-left: 4px solid var(--cr-tone); padding: 12px 14px; background: color-mix(in srgb, var(--cr-tone) 7%, var(--cr-surface)); }",
    ".cr-model-layer strong { color: var(--cr-text); font-size: 12px; }",
    ".cr-model-layer span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-example-nonexample { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }",
    ".cr-example-side { --cr-tone: var(--cr-positive); border-top: 3px solid var(--cr-tone); padding: 15px; background: color-mix(in srgb, var(--cr-tone) 6%, var(--cr-surface)); }",
    ".cr-example-side h3 { color: var(--cr-tone); }",
    ".cr-example-side ul { margin: 10px 0 0; padding-left: 18px; color: var(--cr-muted); }",
    ".cr-misconception-correction { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 14px; align-items: center; }",
    ".cr-misconception, .cr-correction { padding: 16px; background: var(--cr-surface); }",
    ".cr-misconception { border-left: 3px solid var(--cr-negative); color: var(--cr-muted); text-decoration: line-through; text-decoration-color: var(--cr-negative); }",
    ".cr-correction { border-left: 3px solid var(--cr-positive); color: var(--cr-text); }",
    ".cr-concept-arrow { color: var(--cr-accent); font: 850 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-claim-evidence { display: grid; grid-template-columns: minmax(180px, .8fr) minmax(0, 1.2fr); gap: 16px; }",
    ".cr-claim { display: grid; align-content: center; border: 1px solid var(--cr-accent); padding: 16px; background: color-mix(in srgb, var(--cr-accent) 8%, var(--cr-surface)); color: var(--cr-text); font-weight: 800; }",
    ".cr-evidence-list { display: grid; gap: 7px; }",
    ".cr-evidence { position: relative; border-left: 2px solid var(--cr-positive); padding: 9px 12px; background: var(--cr-surface); color: var(--cr-muted); font-size: 11px; }",
    ".cr-question-answer { display: grid; gap: 0; }",
    ".cr-question { border-left: 3px solid var(--cr-secondary); padding: 12px 15px; background: color-mix(in srgb, var(--cr-secondary) 8%, var(--cr-surface)); color: var(--cr-text); font-weight: 800; }",
    ".cr-answer { margin-left: 24px; border-left: 1px solid var(--cr-line); padding: 13px 15px; color: var(--cr-muted); }",
    ".cr-analogy-bridge { display: grid; gap: 7px; }",
    ".cr-analogy-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(90px, .7fr) minmax(110px, 1fr); gap: 10px; align-items: center; }",
    ".cr-analogy-side { border: 1px solid var(--cr-line); padding: 10px 12px; color: var(--cr-text); text-align: center; }",
    ".cr-analogy-link { color: var(--cr-accent); font-size: 10px; text-align: center; }",
    ".cr-insight-ladder { display: grid; gap: 7px; }",
    ".cr-insight-step { --cr-tone: var(--cr-accent); width: calc(100% - var(--indent, 0px)); margin-left: var(--indent, 0px); border-left: 3px solid var(--cr-tone); padding: 10px 13px; background: color-mix(in srgb, var(--cr-tone) 6%, var(--cr-surface)); }",
    ".cr-insight-step strong { color: var(--cr-text); font-size: 12px; }",
    ".cr-insight-step span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-concept-map { position: relative; display: grid; grid-template-columns: repeat(3, minmax(90px, 1fr)); grid-template-rows: repeat(3, minmax(70px, auto)); gap: 12px; }",
    ".cr-concept-map::before { content: ''; position: absolute; inset: 16% 16%; background: linear-gradient(90deg, transparent calc(50% - .5px), var(--cr-line) 50%, transparent calc(50% + .5px)), linear-gradient(0deg, transparent calc(50% - .5px), var(--cr-line) 50%, transparent calc(50% + .5px)); pointer-events: none; }",
    ".cr-map-node { --cr-tone: var(--cr-accent); z-index: 1; display: grid; place-items: center; min-width: 0; border: 1px solid color-mix(in srgb, var(--cr-tone) 42%, var(--cr-line)); padding: 11px; background: var(--cr-surface); color: var(--cr-text); text-align: center; font-size: 11px; }",
    ".cr-map-node[data-slot='top'] { grid-column: 2; grid-row: 1; } .cr-map-node[data-slot='left'] { grid-column: 1; grid-row: 2; } .cr-map-node[data-slot='center'] { grid-column: 2; grid-row: 2; border-width: 2px; background: color-mix(in srgb, var(--cr-accent) 10%, var(--cr-surface)); font-weight: 850; } .cr-map-node[data-slot='right'] { grid-column: 3; grid-row: 2; } .cr-map-node[data-slot='bottom'] { grid-column: 2; grid-row: 3; }",
    ".cr-hub-spoke { display: grid; grid-template-columns: repeat(3, minmax(90px, 1fr)); grid-template-rows: repeat(3, minmax(74px, auto)); gap: 8px; align-items: center; }",
    ".cr-hub { grid-column: 2; grid-row: 2; display: grid; width: 132px; max-width: 100%; aspect-ratio: 1; place-self: center; place-items: center; border: 2px solid var(--cr-accent); border-radius: 50%; background: color-mix(in srgb, var(--cr-accent) 10%, var(--cr-surface)); color: var(--cr-text); text-align: center; font-weight: 850; }",
    ".cr-spoke { --cr-tone: var(--cr-accent); border-bottom: 2px solid var(--cr-tone); padding: 9px; color: var(--cr-muted); text-align: center; font-size: 11px; }",
    ".cr-spoke[data-slot='top'] { grid-column: 2; grid-row: 1; } .cr-spoke[data-slot='left'] { grid-column: 1; grid-row: 2; } .cr-spoke[data-slot='right'] { grid-column: 3; grid-row: 2; } .cr-spoke[data-slot='bottom'] { grid-column: 2; grid-row: 3; }",
    ".cr-relationship-pairs { display: grid; gap: 8px; }",
    ".cr-relationship-row { display: grid; grid-template-columns: minmax(110px, 1fr) minmax(90px, .6fr) minmax(110px, 1fr); gap: 10px; align-items: center; }",
    ".cr-relationship-node { border: 1px solid var(--cr-line); padding: 10px; color: var(--cr-text); text-align: center; }",
    ".cr-relationship-label { position: relative; color: var(--cr-accent); font-size: 10px; text-align: center; }",
    ".cr-relationship-label::before, .cr-relationship-label::after { content: ''; position: absolute; top: 50%; width: 18%; border-top: 1px solid var(--cr-line); } .cr-relationship-label::before { left: 0; } .cr-relationship-label::after { right: 0; }",
    ".cr-cause-effect, .cr-logic-chain, .cr-ipo { display: flex; gap: 22px; align-items: stretch; overflow-x: auto; padding: 2px; }",
    ".cr-cause-node, .cr-logic-node, .cr-ipo-stage { --cr-tone: var(--cr-accent); position: relative; flex: 1 0 150px; border-top: 3px solid var(--cr-tone); padding: 13px; background: var(--cr-surface); }",
    ".cr-cause-node:not(:last-child)::after, .cr-logic-node:not(:last-child)::after, .cr-ipo-stage:not(:last-child)::after { content: '>'; position: absolute; top: 50%; left: calc(100% + 8px); color: var(--cr-muted); transform: translateY(-50%); }",
    ".cr-causal-loop, .cr-feedback-loop { display: grid; grid-template-columns: repeat(2, minmax(120px, 1fr)); gap: 26px; }",
    ".cr-loop-node { --cr-tone: var(--cr-accent); position: relative; min-width: 0; border: 1px solid var(--cr-line); border-left: 3px solid var(--cr-tone); padding: 13px; background: var(--cr-surface); }",
    ".cr-loop-node::after { content: '>'; position: absolute; right: -18px; top: 50%; color: var(--cr-tone); }",
    ".cr-loop-node:nth-child(2)::after, .cr-loop-node:nth-child(4)::after { right: auto; left: -18px; transform: rotate(180deg); }",
    ".cr-dependency-map { display: grid; gap: 14px; }",
    ".cr-dependency-root { justify-self: center; min-width: 180px; border: 2px solid var(--cr-accent); padding: 12px; background: color-mix(in srgb, var(--cr-accent) 8%, var(--cr-surface)); color: var(--cr-text); text-align: center; font-weight: 800; }",
    ".cr-dependency-branches { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; border-top: 1px solid var(--cr-line); padding-top: 14px; }",
    ".cr-dependency-branch { --cr-tone: var(--cr-accent); border-top: 3px solid var(--cr-tone); padding: 11px; background: var(--cr-surface); color: var(--cr-muted); font-size: 11px; }",
    ".cr-influence-map { display: grid; gap: 8px; }",
    ".cr-influence-row { display: grid; grid-template-columns: minmax(110px, 1fr) 44px minmax(110px, 1fr); gap: 10px; align-items: center; }",
    ".cr-influence-node { padding: 10px; background: var(--cr-surface); color: var(--cr-text); text-align: center; }",
    ".cr-influence-sign { --cr-tone: var(--cr-positive); display: grid; width: 30px; aspect-ratio: 1; place-items: center; justify-self: center; border: 1px solid var(--cr-tone); border-radius: 50%; color: var(--cr-tone); font-weight: 850; }",
    ".cr-tradeoff-balance { display: grid; grid-template-columns: minmax(0, 1fr) 54px minmax(0, 1fr); gap: 8px; align-items: end; }",
    ".cr-balance-side { --cr-tone: var(--cr-accent); border-bottom: 3px solid var(--cr-tone); padding: 14px; background: var(--cr-surface); text-align: center; }",
    ".cr-balance-side strong { color: var(--cr-text); } .cr-balance-side span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-balance-center { width: 0; height: 0; justify-self: center; border-left: 24px solid transparent; border-right: 24px solid transparent; border-bottom: 42px solid var(--cr-line); }",
    ".cr-overlap-map { position: relative; min-height: 260px; }",
    ".cr-overlap-circle { --cr-tone: var(--cr-accent); position: absolute; top: 25px; display: grid; width: 210px; max-width: 58%; aspect-ratio: 1; place-items: center; border: 2px solid var(--cr-tone); border-radius: 50%; background: color-mix(in srgb, var(--cr-tone) 13%, transparent); color: var(--cr-text); text-align: center; }",
    ".cr-overlap-circle:first-child { left: 12%; } .cr-overlap-circle:last-child { right: 12%; }",
    ".cr-overlap-center { position: absolute; z-index: 2; left: 50%; top: 50%; width: 120px; color: var(--cr-text); text-align: center; font-size: 11px; font-weight: 850; transform: translate(-50%, -50%); }",
    ".cr-ecosystem-map { display: grid; min-height: 320px; place-items: center; }",
    ".cr-ecosystem-ring { display: grid; width: min(100%, var(--size, 100%)); aspect-ratio: 1; place-items: center; border: 1px solid var(--cr-line); border-radius: 50%; background: color-mix(in srgb, var(--cr-accent) 3%, transparent); padding: 30px; }",
    ".cr-ecosystem-core { display: grid; width: 120px; aspect-ratio: 1; place-items: center; border-radius: 50%; background: var(--cr-accent); color: var(--cr-bg); text-align: center; font-weight: 850; }",
    ".cr-taxonomy { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; }",
    ".cr-taxonomy-group { border-top: 3px solid var(--cr-tone, var(--cr-accent)); padding-top: 10px; }",
    ".cr-taxonomy-group h3 { color: var(--cr-text); } .cr-taxonomy-group ul { margin: 8px 0 0; padding-left: 17px; color: var(--cr-muted); }",
    ".cr-cluster-map, .cr-affinity-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }",
    ".cr-cluster, .cr-affinity-group { --cr-tone: var(--cr-accent); border: 1px dashed color-mix(in srgb, var(--cr-tone) 55%, var(--cr-line)); padding: 13px; }",
    ".cr-cluster h3, .cr-affinity-group h3 { color: var(--cr-tone); }",
    ".cr-cluster-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }",
    ".cr-cluster-tag { border: 1px solid var(--cr-line); border-radius: 999px; padding: 5px 8px; color: var(--cr-muted); font-size: 10px; }",
    ".cr-nested-scopes { display: grid; place-items: center; }",
    ".cr-scope { width: min(100%, var(--width, 100%)); border: 1px solid var(--cr-line); padding: 18px; background: color-mix(in srgb, var(--cr-accent) 3%, var(--cr-surface)); }",
    ".cr-scope > strong { display: block; margin-bottom: 10px; color: var(--cr-accent); font-size: 11px; }",
    ".cr-architecture-layers { display: grid; gap: 6px; }",
    ".cr-architecture-layer { --cr-tone: var(--cr-accent); display: grid; grid-template-columns: minmax(110px, .3fr) minmax(0, 1fr); gap: 14px; border: 1px solid var(--cr-line); border-left: 4px solid var(--cr-tone); padding: 12px 14px; }",
    ".cr-architecture-layer strong { color: var(--cr-text); } .cr-architecture-layer span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-system-map { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(170px, 1.2fr) minmax(120px, 1fr); gap: 18px; align-items: stretch; }",
    ".cr-system-side, .cr-system-core { display: grid; align-content: center; gap: 7px; padding: 14px; }",
    ".cr-system-side { border-top: 2px solid var(--cr-line); border-bottom: 2px solid var(--cr-line); }",
    ".cr-system-core { border: 2px solid var(--cr-accent); background: color-mix(in srgb, var(--cr-accent) 8%, var(--cr-surface)); }",
    ".cr-system-map strong { color: var(--cr-text); } .cr-system-map span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-affinity-group ul { margin: 8px 0 0; padding: 0; list-style: none; color: var(--cr-muted); font-size: 11px; } .cr-affinity-group li + li { margin-top: 5px; }",
    ".cr-knowledge-index { columns: 2 220px; column-gap: 28px; }",
    ".cr-index-group { break-inside: avoid; margin-bottom: 18px; border-top: 2px solid var(--cr-accent); padding-top: 8px; }",
    ".cr-index-group h3 { color: var(--cr-accent); } .cr-index-group ul { margin: 7px 0 0; padding: 0; list-style: none; color: var(--cr-muted); font-size: 11px; }",
    ".cr-matrix-map { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--cr-line); }",
    ".cr-matrix-cell { min-height: 130px; padding: 14px; } .cr-matrix-cell:nth-child(odd) { border-right: 1px solid var(--cr-line); } .cr-matrix-cell:nth-child(-n+2) { border-bottom: 1px solid var(--cr-line); }",
    ".cr-matrix-cell h3 { color: var(--cr-text); } .cr-matrix-cell p { font-size: 11px; }",
    ".cr-topic-lanes { display: grid; gap: 6px; }",
    ".cr-topic-lane { display: grid; grid-template-columns: minmax(100px, .28fr) minmax(0, 1fr); gap: 12px; align-items: center; border-bottom: 1px solid var(--cr-line); padding: 9px 0; }",
    ".cr-topic-lane > strong { color: var(--cr-text); font-size: 11px; }",
    ".cr-topic-items { display: flex; flex-wrap: wrap; gap: 6px; } .cr-topic-item { padding: 6px 8px; background: var(--cr-surface); color: var(--cr-muted); font-size: 10px; }",
    ".cr-decision-tree { display: grid; gap: 14px; }",
    ".cr-decision-root { justify-self: center; min-width: 200px; border: 2px solid var(--cr-secondary); padding: 12px; color: var(--cr-text); text-align: center; font-weight: 800; }",
    ".cr-decision-branches { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; border-top: 1px solid var(--cr-line); padding-top: 14px; }",
    ".cr-decision-branch { --cr-tone: var(--cr-accent); border-top: 3px solid var(--cr-tone); padding: 12px; background: var(--cr-surface); }",
    ".cr-decision-branch strong { color: var(--cr-text); } .cr-decision-branch span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-argument-map { display: grid; gap: 14px; }",
    ".cr-argument-claim { justify-self: center; max-width: 580px; border: 2px solid var(--cr-accent); padding: 14px; background: color-mix(in srgb, var(--cr-accent) 8%, var(--cr-surface)); color: var(--cr-text); text-align: center; font-weight: 800; }",
    ".cr-argument-branches { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }",
    ".cr-argument-side { --cr-tone: var(--cr-positive); border-top: 3px solid var(--cr-tone); padding: 13px; background: var(--cr-surface); }",
    ".cr-argument-side h3 { color: var(--cr-tone); } .cr-argument-side ul { margin: 8px 0 0; padding-left: 17px; color: var(--cr-muted); }",
    ".cr-hypothesis-test { display: grid; gap: 12px; }",
    ".cr-hypothesis { border-left: 4px solid var(--cr-secondary); padding: 13px 15px; background: color-mix(in srgb, var(--cr-secondary) 7%, var(--cr-surface)); color: var(--cr-text); font-weight: 800; }",
    ".cr-test-evidence { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }",
    ".cr-test-side { --cr-tone: var(--cr-positive); border-top: 3px solid var(--cr-tone); padding: 12px; background: var(--cr-surface); }",
    ".cr-test-verdict { border-left: 4px solid var(--cr-accent); padding: 12px 14px; color: var(--cr-muted); }",
    ".cr-problem-solution { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 14px; align-items: stretch; }",
    ".cr-problem, .cr-solution { display: grid; align-content: center; padding: 15px; background: var(--cr-surface); } .cr-problem { border-left: 3px solid var(--cr-negative); } .cr-solution { border-left: 3px solid var(--cr-positive); }",
    ".cr-feedback-loop { position: relative; }",
    "@media (max-width: 760px) { .cr-concept-spotlight, .cr-definition-anatomy, .cr-example-nonexample, .cr-claim-evidence, .cr-system-map, .cr-argument-branches, .cr-test-evidence { grid-template-columns: 1fr; } .cr-misconception-correction, .cr-problem-solution { grid-template-columns: 1fr; } .cr-concept-arrow { justify-self: center; transform: rotate(90deg); } .cr-analogy-row, .cr-relationship-row, .cr-influence-row { grid-template-columns: 1fr; } .cr-relationship-label::before, .cr-relationship-label::after { display: none; } .cr-concept-map, .cr-hub-spoke { grid-template-columns: repeat(3, minmax(72px, 1fr)); } .cr-overlap-map { min-height: 220px; } .cr-overlap-circle { width: 170px; } .cr-architecture-layer, .cr-model-layer, .cr-topic-lane { grid-template-columns: 1fr; } .cr-matrix-map { grid-template-columns: 1fr; } .cr-matrix-cell { border-right: 0 !important; border-bottom: 1px solid var(--cr-line); } .cr-tradeoff-balance { grid-template-columns: 1fr; } .cr-balance-center { transform: rotate(90deg); } }",
    "@media (max-width: 480px) { .cr-concept-map, .cr-hub-spoke { display: flex; flex-direction: column; } .cr-hub { order: -1; } .cr-map-node, .cr-spoke { width: 100%; } .cr-causal-loop, .cr-feedback-loop { grid-template-columns: 1fr; gap: 8px; } .cr-loop-node::after { display: none; } .cr-overlap-circle { width: 150px; max-width: 68%; } .cr-knowledge-index { columns: 1; } }",
  ].join("\n");
}

function contextRoomDiagramStyles() {
  return [
    ".cr-diagram-scroll { width: 100%; overflow-x: auto; padding: 2px; }",
    ".cr-diagram { --cr-cols: 12; position: relative; display: grid; min-width: 680px; grid-template-columns: repeat(var(--cr-cols), minmax(0, 1fr)); grid-auto-rows: minmax(42px, auto); gap: 8px; isolation: isolate; }",
    ".cr-system-landscape, .cr-causal-chain-map, .cr-branching-decision, .cr-actor-sequence, .cr-reasoning-map { --cr-cols: 12; }",
    ".cr-system-landscape { grid-auto-rows: minmax(48px, auto); }",
    ".cr-causal-chain-map { grid-auto-rows: minmax(50px, auto); }",
    ".cr-branching-decision { grid-auto-rows: minmax(54px, auto); }",
    ".cr-actor-sequence { grid-auto-rows: minmax(46px, auto); }",
    ".cr-reasoning-map { grid-auto-rows: minmax(52px, auto); }",
    ".cr-diagram-node { --cr-tone: var(--cr-accent); z-index: 3; position: relative; grid-column: var(--col, auto) / span var(--span, 3); grid-row: var(--row, auto) / span var(--rows, 1); min-width: 0; border: 1px solid color-mix(in srgb, var(--cr-tone) 42%, var(--cr-line)); border-left: 3px solid var(--cr-tone); border-radius: 5px; padding: 10px 12px; background: var(--cr-surface); color: var(--cr-text); box-shadow: 0 4px 14px color-mix(in srgb, var(--cr-bg) 58%, transparent); transition: transform 150ms ease, border-color 150ms ease, box-shadow 150ms ease, background 150ms ease; }",
    ".cr-diagram-node strong { display: block; overflow-wrap: anywhere; color: var(--cr-text); font-size: 11px; line-height: 1.3; }",
    ".cr-diagram-node span, .cr-diagram-node p { margin: 4px 0 0; color: var(--cr-muted); font-size: 10px; line-height: 1.35; }",
    ".cr-diagram-node[data-kind='external'] { border-style: dashed; background: transparent; }",
    ".cr-diagram-node[data-kind='state'] { border-radius: 999px; border-left-width: 1px; text-align: center; }",
    ".cr-diagram-node[data-kind='decision'] { border-left-width: 1px; background: color-mix(in srgb, var(--cr-secondary) 9%, var(--cr-surface)); clip-path: polygon(9% 0, 91% 0, 100% 50%, 91% 100%, 9% 100%, 0 50%); padding-left: 18px; padding-right: 18px; text-align: center; }",
    ".cr-diagram-node[data-kind='event'] { border-left-width: 5px; }",
    ".cr-diagram-node[data-kind='store'] { border-radius: 50% / 12%; border-left-width: 1px; text-align: center; }",
    ".cr-diagram-node:is(:hover, :focus-within) { z-index: 7; border-color: var(--cr-tone); background: color-mix(in srgb, var(--cr-tone) 8%, var(--cr-surface)); box-shadow: 0 8px 22px color-mix(in srgb, var(--cr-tone) 18%, transparent); transform: translateY(-2px); }",
    ".cr-diagram-node:focus-visible, .cr-diagram-node:has(> summary:focus-visible) { outline: 2px solid var(--cr-tone); outline-offset: 2px; }",
    "details.cr-diagram-node { cursor: pointer; }",
    "details.cr-diagram-node > summary { list-style: none; }",
    "details.cr-diagram-node > summary::-webkit-details-marker { display: none; }",
    "details.cr-diagram-node > summary::after { content: '+'; position: absolute; top: 7px; right: 9px; color: var(--cr-tone); font: 800 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    "details.cr-diagram-node[open] > summary::after { content: '−'; }",
    "details.cr-diagram-node[open] > p { padding-top: 6px; border-top: 1px solid var(--cr-line); }",
    ".cr-diagram-group, .cr-diagram-boundary, .cr-diagram-lane { z-index: 0; grid-column: var(--col, 1) / span var(--span, 12); grid-row: var(--row, 1) / span var(--rows, 1); min-width: 0; border: 1px dashed color-mix(in srgb, var(--cr-tone, var(--cr-accent)) 42%, var(--cr-line)); border-radius: 7px; padding: 9px; background: color-mix(in srgb, var(--cr-tone, var(--cr-accent)) 3%, transparent); color: var(--cr-muted); font: 750 9px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }",
    ".cr-diagram-boundary { border-width: 2px; border-style: solid; }",
    ".cr-diagram-lane { border-style: solid; border-width: 1px 0 0; border-radius: 0; padding-left: 10px; }",
    ".cr-diagram-edge { --cr-tone: var(--cr-accent); z-index: 1; position: relative; pointer-events: none; color: var(--cr-tone); }",
    ".cr-diagram-edge[data-dir='h'] { grid-column: var(--col, auto) / span var(--span, 1); grid-row: var(--row, auto); align-self: center; height: 0; border-top: 2px solid var(--cr-tone); }",
    ".cr-diagram-edge[data-dir='h']::after { content: ''; position: absolute; top: -5px; right: -1px; width: 0; height: 0; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 7px solid var(--cr-tone); }",
    ".cr-diagram-edge[data-dir='h'][data-reverse]::after { right: auto; left: -1px; border-left: 0; border-right: 7px solid var(--cr-tone); }",
    ".cr-diagram-edge[data-dir='v'] { grid-column: var(--col, auto); grid-row: var(--row, auto) / span var(--rows, 1); justify-self: center; width: 0; border-left: 2px solid var(--cr-tone); }",
    ".cr-diagram-edge[data-dir='v']::after { content: ''; position: absolute; left: -5px; bottom: -1px; width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 7px solid var(--cr-tone); }",
    ".cr-diagram-edge[data-dir='v'][data-reverse]::after { top: -1px; bottom: auto; border-top: 0; border-bottom: 7px solid var(--cr-tone); }",
    ".cr-diagram-edge[data-arrow='none']::after { display: none; }",
    ".cr-diagram-edge > span { position: absolute; left: 50%; top: 50%; max-width: 150px; padding: 2px 5px; background: var(--cr-bg); color: var(--cr-muted); font: 700 8px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; transform: translate(-50%, -50%); white-space: nowrap; }",
    ".cr-diagram-note { z-index: 4; grid-column: var(--col, auto) / span var(--span, 3); grid-row: var(--row, auto) / span var(--rows, 1); align-self: start; border-left: 2px solid var(--cr-secondary); padding: 7px 9px; background: color-mix(in srgb, var(--cr-secondary) 7%, var(--cr-surface)); color: var(--cr-muted); font-size: 9px; }",
    ".cr-diagram-junction { z-index: 2; grid-column: var(--col, auto); grid-row: var(--row, auto); align-self: center; justify-self: center; width: 9px; height: 9px; border-radius: 50%; background: var(--cr-tone, var(--cr-accent)); }",
    ".cr-entity { padding: 0; overflow: hidden; }",
    ".cr-entity > strong { padding: 8px 10px; background: color-mix(in srgb, var(--cr-tone, var(--cr-accent)) 10%, var(--cr-surface)); }",
    ".cr-entity ul { margin: 0; padding: 7px 10px; list-style: none; color: var(--cr-muted); font-size: 9px; }",
    ".cr-entity li + li { margin-top: 3px; }",
    ".cr-sequence-actor { z-index: 3; grid-column: var(--col, auto) / span var(--span, 2); grid-row: 1; border: 1px solid var(--cr-line); padding: 8px; background: var(--cr-surface); color: var(--cr-text); text-align: center; font-size: 10px; font-weight: 800; }",
    ".cr-sequence-lifeline { z-index: 0; grid-column: var(--col, auto); grid-row: 2 / span var(--rows, 7); justify-self: center; border-left: 1px dashed var(--cr-line); }",
    ".cr-sequence-message { z-index: 2; position: relative; grid-column: var(--col, auto) / span var(--span, 3); grid-row: var(--row, auto); align-self: center; border-top: 2px solid var(--cr-tone, var(--cr-accent)); color: var(--cr-muted); font-size: 8px; text-align: center; }",
    ".cr-sequence-message::after { content: ''; position: absolute; right: -1px; margin-top: -4px; border-top: 4px solid transparent; border-bottom: 4px solid transparent; border-left: 7px solid var(--cr-tone, var(--cr-accent)); }",
    ".cr-diagram-legend { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; color: var(--cr-muted); font-size: 9px; }",
    ".cr-diagram-legend span { display: inline-flex; align-items: center; gap: 5px; }",
    ".cr-diagram-legend i { width: 12px; height: 3px; background: var(--cr-tone, var(--cr-accent)); }",
    "@media (max-width: 760px) { .cr-diagram { min-width: 620px; } .cr-diagram-node { padding: 8px 10px; } }",
    "@media (prefers-reduced-motion: reduce) { .cr-diagram-node { transition: none; } }",
  ].join("\n");
}

function contextRoomVisualDocumentStyles() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const scheme = token("color-scheme", "dark").includes("light") ? "light" : "dark";
  const variables = [
    ["--cr-bg", token("--file-bg", "#101416")],
    ["--cr-surface", token("--file-panel-bg", "#151b1d")],
    ["--cr-surface-strong", token("--file-header-bg", "#1b2224")],
    ["--cr-text", token("--file-fg", "#edf2f0")],
    ["--cr-muted", token("--file-muted", "#96a39f")],
    ["--cr-line", token("--file-line", "rgba(207,220,217,.18)")],
    ["--cr-accent", token("--file-h1", "#67c6d3")],
    ["--cr-secondary", token("--file-h2", "#e2b866")],
    ["--cr-positive", token("--file-h3", "#72d39a")],
    ["--cr-negative", token("--file-h4", "#e7a5ad")],
    ["--cr-code", token("--file-code", "#efbf76")],
  ].map(([name, value]) => name + ": " + value + ";").join(" ");
  return [
    ":root { color-scheme: " + scheme + "; " + variables + " --cr-radius: 8px; --cr-gap: clamp(12px, 2vw, 20px); }",
    "* { box-sizing: border-box; }",
    "html { min-height: 100%; background: var(--cr-bg); }",
    "body { min-height: 100%; margin: 0; padding: clamp(20px, 4vw, 48px); background: var(--cr-bg); color: var(--cr-text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; line-height: 1.5; }",
    "main, .cr-page { width: min(1120px, 100%); margin: 0 auto; }",
    "h1, h2, h3, p { margin-top: 0; }",
    "h1 { margin-bottom: 10px; color: var(--cr-text); font-size: 48px; line-height: 1; letter-spacing: 0; }",
    "h2 { margin-bottom: 16px; color: var(--cr-text); font-size: 22px; line-height: 1.2; letter-spacing: 0; }",
    "h3 { margin-bottom: 8px; color: var(--cr-text); font-size: 15px; line-height: 1.3; letter-spacing: 0; }",
    "p { margin-bottom: 0; color: var(--cr-muted); }",
    "code { color: var(--cr-code); font: .92em/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; overflow-wrap: anywhere; }",
    ".cr-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: var(--cr-gap); align-items: end; margin-bottom: clamp(24px, 5vw, 48px); padding-bottom: 22px; border-bottom: 2px solid var(--cr-accent); }",
    ".cr-kicker { margin-bottom: 10px; color: var(--cr-accent); font: 800 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }",
    ".cr-badge { width: fit-content; border: 1px solid color-mix(in srgb, var(--cr-positive) 58%, var(--cr-line)); border-radius: 999px; padding: 6px 10px; background: color-mix(in srgb, var(--cr-positive) 13%, var(--cr-surface)); color: var(--cr-positive); font-size: 11px; font-weight: 850; white-space: nowrap; }",
    ".cr-section { margin-top: var(--cr-gap); border: 1px solid var(--cr-line); border-radius: var(--cr-radius); background: var(--cr-surface); padding: clamp(16px, 2.5vw, 24px); }",
    ".cr-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--cr-gap); }",
    ".cr-grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--cr-gap); }",
    ".cr-card { min-width: 0; border: 1px solid var(--cr-line); border-radius: var(--cr-radius); background: var(--cr-surface); padding: clamp(15px, 2vw, 20px); }",
    ".cr-card[data-tone='accent'] { border-top: 3px solid var(--cr-accent); }",
    ".cr-card[data-tone='positive'] { border-top: 3px solid var(--cr-positive); }",
    ".cr-card[data-tone='warning'] { border-top: 3px solid var(--cr-secondary); }",
    ".cr-card[data-tone='negative'] { border-top: 3px solid var(--cr-negative); }",
    ".cr-flow { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; counter-reset: cr-step; }",
    ".cr-step { counter-increment: cr-step; min-width: 0; border: 1px solid var(--cr-line); border-radius: var(--cr-radius); background: var(--cr-surface); padding: 18px; }",
    ".cr-step::before { content: counter(cr-step, decimal-leading-zero) ' / STEP'; display: block; margin-bottom: 18px; color: var(--cr-accent); font: 800 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }",
    ".cr-comparison { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--cr-gap); }",
    ".cr-option { position: relative; min-width: 0; border: 1px solid var(--cr-line); border-radius: var(--cr-radius); background: var(--cr-surface); padding: 20px; }",
    ".cr-option[data-tone='positive'] { border-color: color-mix(in srgb, var(--cr-positive) 56%, var(--cr-line)); background: color-mix(in srgb, var(--cr-positive) 8%, var(--cr-surface)); }",
    ".cr-option[data-tone='warning'] { border-color: color-mix(in srgb, var(--cr-secondary) 56%, var(--cr-line)); background: color-mix(in srgb, var(--cr-secondary) 8%, var(--cr-surface)); }",
    ".cr-option[data-tone='negative'] { border-color: color-mix(in srgb, var(--cr-negative) 56%, var(--cr-line)); background: color-mix(in srgb, var(--cr-negative) 8%, var(--cr-surface)); }",
    ".cr-option > .cr-badge { margin-bottom: 14px; }",
    ".cr-metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }",
    ".cr-metric { border-left: 3px solid var(--cr-accent); background: color-mix(in srgb, var(--cr-accent) 8%, var(--cr-surface)); padding: 12px 14px; }",
    ".cr-metric strong { display: block; margin-bottom: 3px; color: var(--cr-text); font-size: 28px; line-height: 1; }",
    ".cr-metric span { color: var(--cr-muted); font-size: 11px; }",
    ".cr-callout { margin-top: var(--cr-gap); border-left: 3px solid var(--cr-accent); border-radius: 0 var(--cr-radius) var(--cr-radius) 0; background: color-mix(in srgb, var(--cr-accent) 9%, var(--cr-surface)); padding: 14px 16px; }",
    ".cr-callout[data-tone='positive'] { border-left-color: var(--cr-positive); background: color-mix(in srgb, var(--cr-positive) 9%, var(--cr-surface)); }",
    ".cr-callout[data-tone='warning'] { border-left-color: var(--cr-secondary); background: color-mix(in srgb, var(--cr-secondary) 9%, var(--cr-surface)); }",
    ".cr-callout[data-tone='negative'] { border-left-color: var(--cr-negative); background: color-mix(in srgb, var(--cr-negative) 9%, var(--cr-surface)); }",
    ".cr-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }",
    ".cr-list > li { display: grid; grid-template-columns: minmax(90px, .28fr) minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--cr-line); }",
    ".cr-list > li:last-child { border-bottom: 0; }",
    ".cr-list strong { color: var(--cr-accent); font-size: 12px; }",
    ".cr-list span { color: var(--cr-muted); font-size: 13px; }",
    ".cr-table-wrap { overflow-x: auto; border: 1px solid var(--cr-line); border-radius: var(--cr-radius); }",
    ".cr-table { width: 100%; border-collapse: collapse; background: var(--cr-surface); }",
    ".cr-table th, .cr-table td { padding: 11px 13px; border-bottom: 1px solid var(--cr-line); text-align: left; vertical-align: top; }",
    ".cr-table th { background: var(--cr-surface-strong); color: var(--cr-text); font-size: 11px; }",
    ".cr-table td { color: var(--cr-muted); font-size: 13px; }",
    ".cr-table tr:last-child td { border-bottom: 0; }",
    contextRoomVisualPatternStyles(),
    contextRoomConceptPatternStyles(),
    contextRoomDiagramStyles(),
    ".cr-footer { display: flex; justify-content: space-between; gap: 14px; margin-top: var(--cr-gap); color: var(--cr-muted); font-size: 11px; }",
    "@media (max-width: 760px) { body { padding: 16px; } h1 { font-size: 34px; } h2 { font-size: 20px; } .cr-header, .cr-grid, .cr-grid-3, .cr-comparison { grid-template-columns: 1fr; } .cr-flow { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cr-header { align-items: start; } .cr-footer { display: grid; } }",
    "@media (max-width: 480px) { .cr-flow { grid-template-columns: 1fr; } }",
  ].join("\n");
}

function sanitizedHtmlPreviewDocument(source) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(String(source || ""), "text/html");
  doc.querySelectorAll("script, iframe, frame, object, embed, base").forEach((element) => element.remove());
  doc.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on") || name === "href" || name === "xlink:href" || name === "action" || name === "formaction") {
        element.removeAttribute(attribute.name);
      } else if (["src", "srcset", "poster"].includes(name) && !/^data:(?:image|font|audio|video)\//i.test(value)) {
        element.removeAttribute(attribute.name);
      } else if (name === "http-equiv" && value.toLowerCase() === "refresh") {
        element.remove();
        break;
      }
    }
  });
  const policy = doc.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; connect-src 'none'");
  const theme = doc.createElement("style");
  theme.setAttribute("data-context-room-visual-system", currentFileThemeId());
  theme.textContent = contextRoomVisualDocumentStyles();
  doc.documentElement.dataset.contextRoomTheme = currentFileThemeId();
  doc.head.prepend(theme);
  doc.head.prepend(policy);
  return "<!doctype html>\n" + doc.documentElement.outerHTML;
}

function renderHtmlDocumentPreview(text, filePath = state.selected) {
  return '<div class="html-preview-shell"><iframe class="html-preview-frame" sandbox="" referrerpolicy="no-referrer" title="HTML preview: ' + escapeHtml(filePath || "document") + '" srcdoc="' + escapeHtml(sanitizedHtmlPreviewDocument(text)) + '"></iframe></div>';
}

function renderDocumentView(text, filePath = state.selected) {
  if (!usePlainTextSurface(filePath, text)) return renderMarkdownLineView(text);
  return '<pre id="docReader" class="doc-editor plain-text-view" role="document" tabindex="0" aria-label="Text file">' + escapeHtml(text) + '</pre>';
}

function renderDocumentEditor(text, filePath = state.selected) {
  if (!usePlainTextSurface(filePath, text)) return renderMarkdownEditor(text);
  return '<textarea id="docEditor" class="doc-editor plain-text-editor" spellcheck="false">' + escapeHtml(text) + '</textarea>';
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
  const decorated = String(rendered).replace(/^<div class="markdown-line([^"]*)"/, '<div class="markdown-line' + extraClass + '$1"' + markerAttr + finalLineAttr);
  if (!decoration.intralineHtml) return decorated;
  const contentStart = decorated.indexOf(">");
  const contentEnd = decorated.lastIndexOf("</div>");
  if (contentStart < 0 || contentEnd <= contentStart) return decorated;
  return decorated.slice(0, contentStart + 1) + decoration.intralineHtml + decorated.slice(contentEnd);
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
  const attrs = ' data-line-index="' + index + '" data-line-number="' + (index + 1) + '"';
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
  root.querySelector("[data-file-review-decision]")?.addEventListener("click", (event) => requestReviewDecision(state.selected, event.currentTarget.dataset.fileReviewDecision).catch((error) => setStatus(error.message)));
  root.querySelector("[data-next-review]")?.addEventListener("click", () => openNextReviewManually().catch((error) => setStatus(error.message)));
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

function wireExternalReviewJumpButtons(root = document) {
  root.querySelectorAll("[data-external-review-jump]").forEach((button) => button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (focusFirstExternalReviewChange()) setStatus("showing first change");
    else setStatus("no pending change to show");
  }));
}

function renderExternalReviewActions(change, { fileActionOptions = null } = {}) {
  const beforeText = externalReviewBaseContent(change);
  const afterText = change.diskContent || "";
  const blocks = buildExternalReviewBlocks(beforeText, afterText, change.reviewDecisions || {});
  const summary = summarizeExternalReviewBlocks(blocks);
  const visualHtmlReview = isHtmlDocumentPath(change.path);
  const sourceLabel = change.source === "review" ? "Git changes waiting for review" : "File changed on disk";
  const pendingLabel = summary.pending ? summary.pending + " left" : "saving...";
  const jumpAction = summary.pending && !visualHtmlReview
    ? '<button class="file-action external-choice bulk" type="button" data-external-review-jump="first" title="Jump to the first pending change">First change</button>'
    : "";
  const bulkActions = summary.pending && (visualHtmlReview || summary.pending > 1 || summary.pendingLines > 1)
    ? '<button class="file-action primary external-choice bulk" type="button" data-external-review-all="accept">Accept all</button>' +
      '<button class="file-action danger-action external-choice bulk" type="button" data-external-review-all="reject">Reject all</button>'
    : "";
  return '<div class="file-actions external-review-actions" aria-label="Review file changes">' +
    '<div class="external-change-stats" title="' + escapeHtml(sourceLabel + ": " + (change.path || "This file")) + '"><span class="pending">' + pendingLabel + '</span><span class="add">+' + summary.additions + '</span><span class="del">-' + summary.deletions + '</span></div>' +
    jumpAction +
    bulkActions +
    (fileActionOptions ? renderFileActionItems(fileActionOptions) : '') +
  '</div>';
}

function updateExternalReviewActionsInPlace(change = activeExternalChange()) {
  const actions = document.querySelector(".file-panel > header .file-actions");
  if (!actions || !change || activeFileConflict()) return false;
  actions.outerHTML = renderExternalReviewActions(change, { fileActionOptions: externalReviewFileActionOptions() });
  wireExternalReviewAllButtons(document.querySelector(".file-panel > header") || document);
  wireExternalReviewJumpButtons(document.querySelector(".file-panel > header") || document);
  wireFileActionButtons(document.querySelector(".file-panel > header") || document);
  return true;
}

function externalReviewFileActionOptions() {
  return {
    reviewAction: null,
    nextReviewAction: nextReviewActionForSelectedFile(),
    dirty: state.dirty,
    blockedByConflict: true,
    deletable: !Boolean(state.selectedStartupContext),
    savable: !isHtmlDocumentPath(state.selected),
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
  const intralineRows = externalReviewIntralineRows(rows);
  const lineDecorations = rows.map((row, index) => {
    const finalLineIndex = finalLineIndexForRow(row, rows, options.finalLineStart);
    if (row.type !== "add" && row.type !== "del") return null;
    const intraline = intralineRows.get(index);
    const marker = intraline?.marker || (row.type === "add" ? "+" : row.type === "del" ? "-" : "");
    const intralineClass = intraline?.hidden
      ? " intraline-superseded"
      : intraline?.merged
        ? " intraline-merged intraline-" + intraline.kind
        : intraline?.split
          ? " intraline-split"
          : "";
    return { className: "external-review-line " + row.type + intralineClass, marker, finalLineIndex, intralineHtml: intraline?.html || "" };
  });
  return '<div class="external-review-lines markdown-view">' + renderMarkdownLines(text, { lineDecorations }) + '</div>';
}

function externalReviewIntralineRows(rows) {
  const result = new Map();
  const deleted = [];
  const added = [];
  rows.forEach((row, index) => {
    if (row.type === "del" && isIntralineReviewCandidate(row.line)) deleted.push({ index, line: row.line });
    if (row.type === "add" && isIntralineReviewCandidate(row.line)) added.push({ index, line: row.line });
  });
  if (!deleted.length || !added.length || deleted.length > 12 || added.length > 12) return result;
  const candidates = [];
  for (const before of deleted) {
    for (const after of added) {
      const diff = buildIntralineTokenDiff(before.line, after.line);
      if (diff && diff.similarity >= 0.34) candidates.push({ before, after, diff });
    }
  }
  candidates.sort((left, right) => right.diff.similarity - left.diff.similarity || Math.abs(left.before.index - left.after.index) - Math.abs(right.before.index - right.after.index));
  const usedDeleted = new Set();
  const usedAdded = new Set();
  for (const candidate of candidates) {
    if (usedDeleted.has(candidate.before.index) || usedAdded.has(candidate.after.index)) continue;
    usedDeleted.add(candidate.before.index);
    usedAdded.add(candidate.after.index);
    const hasAddition = candidate.diff.merged.some((segment) => segment.type === "add");
    const hasDeletion = candidate.diff.merged.some((segment) => segment.type === "del");
    const kind = hasAddition && hasDeletion ? "mixed" : hasDeletion ? "removal" : "addition";
    const marker = kind === "mixed" ? "±" : kind === "removal" ? "-" : "+";
    if (shouldMergeIntralineDiff(candidate.diff)) {
      result.set(candidate.before.index, { hidden: true });
      result.set(candidate.after.index, { html: renderMergedIntralineSegments(candidate.diff.merged), merged: true, kind, marker });
      continue;
    }
    result.set(candidate.before.index, { html: renderIntralineSegments(candidate.diff.before, "del"), split: true });
    result.set(candidate.after.index, { html: renderIntralineSegments(candidate.diff.after, "add"), split: true });
  }
  return result;
}

function shouldMergeIntralineDiff(diff) {
  return Boolean(diff && (diff.deletedWords === 0 || diff.addedWords === 0 || diff.changeRatio <= 0.25));
}

function isIntralineReviewCandidate(line) {
  const text = String(line || "");
  if (!text.trim() || text.length > 4000) return false;
  return !/^\s*(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\`\`\`|~~~)/.test(text);
}

function intralineTokens(value) {
  return String(value || "").match(/\[[^\n]+?\]\([^\n)]+\)|\x60[^\x60\n]+\x60|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || [];
}

function appendIntralineSegment(segments, type, text) {
  if (!text) return;
  const previous = segments[segments.length - 1];
  if (previous?.type === type) previous.text += text;
  else segments.push({ type, text });
}

function buildIntralineTokenDiff(beforeText, afterText) {
  const before = intralineTokens(beforeText);
  const after = intralineTokens(afterText);
  if (!before.length || !after.length || before.length * after.length > 40_000) return null;
  const dp = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      dp[i][j] = before[i] === after[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const beforeSegments = [];
  const afterSegments = [];
  const mergedSegments = [];
  let commonMeaningful = 0;
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      appendIntralineSegment(beforeSegments, "same", before[i]);
      appendIntralineSegment(afterSegments, "same", after[j]);
      appendIntralineSegment(mergedSegments, "same", before[i]);
      if (before[i].trim()) commonMeaningful += 1;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      appendIntralineSegment(beforeSegments, "del", before[i]);
      appendIntralineSegment(mergedSegments, "del", before[i]);
      i += 1;
    } else {
      appendIntralineSegment(afterSegments, "add", after[j]);
      appendIntralineSegment(mergedSegments, "add", after[j]);
      j += 1;
    }
  }
  while (i < before.length) {
    appendIntralineSegment(beforeSegments, "del", before[i]);
    appendIntralineSegment(mergedSegments, "del", before[i]);
    i += 1;
  }
  while (j < after.length) {
    appendIntralineSegment(afterSegments, "add", after[j]);
    appendIntralineSegment(mergedSegments, "add", after[j]);
    j += 1;
  }
  const beforeMeaningful = before.filter((token) => token.trim()).length;
  const afterMeaningful = after.filter((token) => token.trim()).length;
  const similarity = commonMeaningful / Math.max(1, beforeMeaningful, afterMeaningful);
  const wordChange = buildIntralineWordChange(beforeText, afterText);
  return { before: beforeSegments, after: afterSegments, merged: mergedSegments, similarity, ...wordChange };
}

function buildIntralineWordChange(beforeText, afterText) {
  const beforeWords = String(beforeText || "").match(/[\p{L}\p{N}_]+/gu) || [];
  const afterWords = String(afterText || "").match(/[\p{L}\p{N}_]+/gu) || [];
  const dp = Array.from({ length: beforeWords.length + 1 }, () => new Uint16Array(afterWords.length + 1));
  for (let i = beforeWords.length - 1; i >= 0; i -= 1) {
    for (let j = afterWords.length - 1; j >= 0; j -= 1) {
      dp[i][j] = beforeWords[i] === afterWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const commonWords = dp[0][0];
  const deletedWords = beforeWords.length - commonWords;
  const addedWords = afterWords.length - commonWords;
  const changeRatio = (deletedWords + addedWords) / Math.max(1, beforeWords.length + afterWords.length);
  return { beforeWords: beforeWords.length, afterWords: afterWords.length, deletedWords, addedWords, changeRatio };
}

function renderIntralineSegments(segments, changeType) {
  return segments.map((segment) => {
    const rendered = renderMarkdownInline(segment.text);
    return segment.type === "same" ? rendered : '<span class="external-review-token ' + changeType + '">' + rendered + '</span>';
  }).join("");
}

function renderMergedIntralineSegments(segments) {
  return segments.map((segment) => {
    const rendered = renderMarkdownInline(segment.text);
    return segment.type === "same" ? rendered : '<span class="external-review-token ' + segment.type + '">' + rendered + '</span>';
  }).join("");
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

async function finalizeExternalReview(settlePromise, blocks, viewState) {
  if (state.reviewFinalizationPromise) return state.reviewFinalizationPromise;
  const finalization = (async () => {
    await waitForInlineReviewTransition(settlePromise);
    await saveExternalReviewDecision(blocks, viewState);
  })();
  state.reviewFinalizationPromise = finalization;
  try {
    await finalization;
  } finally {
    if (state.reviewFinalizationPromise === finalization) {
      state.reviewFinalizationPromise = null;
    }
  }
}

async function chooseExternalReviewBlock(decision, blockId) {
  const change = activeExternalChange();
  if (!change || !blockId || (decision !== "accept" && decision !== "reject")) return;
  const viewState = captureEditorViewState({ anchorBlockId: blockId });
  viewState.visualAnchor = captureMarkdownVisualAnchor();
  change.reviewDecisions = { ...(change.reviewDecisions || {}), [blockId]: decision };
  const blocks = buildExternalReviewBlocks(externalReviewBaseContent(change), change.diskContent || "", change.reviewDecisions);
  const pending = blocks.filter((block) => block.kind === "change" && !block.decision);
  const updatedInPlace = updateExternalReviewBlockInPlace(blocks, blockId, viewState);
  if (!updatedInPlace) renderViewer();
  else updateExternalReviewActionsInPlace(change);
  updateHeader();
  updatePreview();
  restoreInlineReviewViewport(viewState);
  const settlePromise = updatedInPlace
    ? settleExternalReviewBlocks([blockId], viewState, { restoreScroll: false })
    : Promise.resolve();
  if (pending.length) {
    setStatus(pending.length + " change" + (pending.length > 1 ? "s" : "") + " left to review");
    return;
  }
  setStatus("saving reviewed change...");
  await finalizeExternalReview(settlePromise, blocks, viewState);
}

async function chooseAllExternalReviewBlocks(decision) {
  const change = activeExternalChange();
  if (!change || (decision !== "accept" && decision !== "reject")) return;
  const currentBlocks = buildExternalReviewBlocks(externalReviewBaseContent(change), change.diskContent || "", change.reviewDecisions || {});
  const pendingBlocks = currentBlocks.filter((block) => block.kind === "change" && !block.decision);
  if (!pendingBlocks.length) return;
  const anchorBlockId = closestExternalReviewChangeBlockId() || pendingBlocks[0].id;
  const viewState = captureEditorViewState({ anchorBlockId });
  viewState.visualAnchor = captureMarkdownVisualAnchor();
  const nextDecisions = { ...(change.reviewDecisions || {}) };
  for (const block of pendingBlocks) nextDecisions[block.id] = decision;
  change.reviewDecisions = nextDecisions;
  const blocks = buildExternalReviewBlocks(externalReviewBaseContent(change), change.diskContent || "", change.reviewDecisions);
  const updatedInPlace = updateExternalReviewDocumentInPlace(blocks);
  if (!updatedInPlace) renderViewer();
  else updateExternalReviewActionsInPlace(change);
  restoreEditorViewState(viewState);
  updateHeader();
  updatePreview();
  restoreInlineReviewViewport(viewState);
  setStatus("saving reviewed changes...");
  const settlePromise = updatedInPlace
    ? settleExternalReviewBlocks(pendingBlocks.map((block) => block.id), viewState, { restoreScroll: false })
    : Promise.resolve();
  await finalizeExternalReview(settlePromise, blocks, viewState);
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
  const previousQueue = state.docqa?.queue || [];
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
    resetExternalChangeState({ discardReview: true });
    state.saved = "";
    state.savedHash = null;
    state.dirty = false;
    el("editor").value = "";
    await loadFiles();
    await advanceAfterInlineReviewRemoval(change.path, previousQueue, "new file rejected · no more docs to review");
    return;
  }
  if (change.source === "review" && change.changeKind === "deleted" && merged.length === 0) {
    await recordSelectedReviewBaseline(change.path, "inline review applied");
    resetConflictState();
    resetExternalChangeState({ discardReview: true });
    state.diffCollapsed = true;
    state.saved = "";
    state.savedHash = null;
    state.dirty = false;
    el("editor").value = "";
    const docEditor = el("docEditor");
    if (docEditor) docEditor.value = "";
    await loadFiles();
    await applyReviewDecision(change.path, "verified", { previousQueue, viewState });
    if (state.selected === change.path) goHub();
    return;
  }
  const result = await writeSelectedDiskFile(merged, change.path);
  const shouldRecordReviewBaseline = change.source === "review" || change.source === "disk";
  if (shouldRecordReviewBaseline) await recordSelectedReviewBaseline(change.path, "inline review applied");
  resetConflictState();
  resetExternalChangeState(change.source === "review" ? { discardReview: true } : {});
  // Returning from inline review should keep the reader in the document, not open the Git diff panel.
  state.diffCollapsed = true;
  state.saved = merged;
  state.savedHash = result.contentHash;
  state.dirty = false;
  el("editor").value = merged;
  const docEditor = el("docEditor");
  if (docEditor) docEditor.value = merged;
  await loadFiles();
  if (change.source === "review") {
    await applyReviewDecision(change.path, "verified", { previousQueue });
    return;
  }
  if (state.selected === change.path) {
    state.selectedDiff = await readSelectedDiff(change.path);
    replaceExternalReviewActionsInPlace(merged);
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
  restoreFinalReviewViewport(visualAnchor, restoreState);
  scheduleSessionStatePush();
  return true;
}

function restoreFinalReviewViewport(visualAnchor, restoreState) {
  const apply = () => {
    if (!restoreMarkdownVisualAnchor(visualAnchor)) restoreEditorViewState(restoreState, { deferred: false });
  };
  apply();
  window.requestAnimationFrame(() => {
    apply();
    window.requestAnimationFrame(apply);
  });
  window.setTimeout(apply, 0);
}

function replaceExternalReviewActionsInPlace(text = "") {
  const actions = document.querySelector(".file-panel > header .file-actions");
  if (!actions) return;
  const templateState = !state.selectedStartupContext && !activeFileConflict() ? templateStateForContent(text) : null;
  actions.outerHTML = renderFileActionButtons({
    reviewAction: state.selectedStartupContext || state.selectedReadOnly ? null : reviewActionForSelectedFile(),
    nextReviewAction: state.selectedStartupContext || state.selectedReadOnly ? null : nextReviewActionForSelectedFile(),
    dirty: state.dirty,
    templateState,
    blockedByConflict: Boolean(activeFileConflict()),
    readOnly: Boolean(state.selectedStartupContext?.readOnly || state.selectedReadOnly),
    deletable: !Boolean(state.selectedStartupContext || state.selectedReadOnly),
    savable: !isHtmlDocumentPath(state.selected),
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
  const anchorTop = typeof viewState?.anchorTop === "number" ? viewState.anchorTop : anchor ? anchor.getBoundingClientRect().top : null;
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
  if (!restoreInlineReviewViewport(viewState) && anchor && typeof anchorTop === "number") shiftScrollForElement(anchor, anchor.getBoundingClientRect().top - anchorTop);
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
      if (!restoreInlineReviewViewport(viewState) && anchor && typeof anchorTop === "number") shiftScrollForElement(anchor, anchor.getBoundingClientRect().top - anchorTop);
      if (restoreScroll) restoreEditorViewState(viewState);
    }
  });
}

function captureInlineReviewScrollSnapshot(viewState = null) {
  if (!viewState) return null;
  return {
    ...captureEditorViewState({ anchorBlockId: viewState.anchorBlockId || "" }),
    userScrollIntentAt: state.userScrollIntentAt || 0,
  };
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
  const userRequestedScroll = (state.userScrollIntentAt || 0) > (snapshot?.userScrollIntentAt || 0);
  if (!viewState || !userRequestedScroll || !inlineReviewScrollChangedSince(snapshot)) return false;
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
  const visibleLines = lines.filter((line) => {
    const rect = line.getBoundingClientRect();
    return rect.bottom > scrollRect.top + 1 && rect.top < scrollRect.bottom - 1;
  });
  const visibleLine = visibleLines.find((line) => line.textContent.trim() && !line.closest(".external-review-block.change")) ||
    visibleLines.find((line) => line.textContent.trim()) ||
    visibleLines[0];
  if (!visibleLine) return null;
  const lineIndex = visibleLine.dataset.finalLineIndex || visibleLine.dataset.lineIndex || "";
  if (!lineIndex) return null;
  return { lineIndex, lineText: visibleLine.textContent || "", top: visibleLine.getBoundingClientRect().top };
}

function restoreExternalReviewVisualAnchor(anchor) {
  if (!anchor?.lineIndex && !anchor?.lineText) return false;
  const root = document.querySelector(".external-review-doc");
  if (!root) return false;
  const targetIndex = Number(anchor.lineIndex);
  const textMatches = anchor.lineText
    ? [...root.querySelectorAll(".markdown-line")].filter((candidate) => candidate.textContent === anchor.lineText)
    : [];
  let line = textMatches.reduce((closest, candidate) => {
    const index = Number(candidate.dataset.finalLineIndex);
    const distance = Number.isFinite(targetIndex) && Number.isFinite(index) ? Math.abs(index - targetIndex) : 0;
    return !closest || distance < closest.distance ? { candidate, distance } : closest;
  }, null)?.candidate || null;
  if (!line && anchor.lineIndex) line = root.querySelector('.markdown-line[data-final-line-index="' + cssEscape(anchor.lineIndex) + '"]');
  if (!line) {
    if (Number.isFinite(targetIndex)) {
      line = [...root.querySelectorAll(".markdown-line[data-final-line-index]")].reduce((closest, candidate) => {
        const distance = Math.abs(Number(candidate.dataset.finalLineIndex) - targetIndex);
        return !closest || distance < closest.distance ? { candidate, distance } : closest;
      }, null)?.candidate || null;
    }
  }
  if (!line) return false;
  shiftScrollForElement(line, line.getBoundingClientRect().top - anchor.top);
  return true;
}

function restoreInlineReviewViewport(viewState) {
  if (!viewState) return false;
  const scroller = activeDocumentScrollTarget();
  if (scroller && typeof viewState.documentViewportTop === "number") {
    const currentTop = scroller.getBoundingClientRect?.().top;
    const topDelta = typeof currentTop === "number" ? currentTop - viewState.documentViewportTop : 0;
    scroller.scrollTop = Math.max(0, (viewState.documentScrollTop || 0) + topDelta);
    scroller.scrollLeft = viewState.documentScrollLeft || 0;
  }
  return restoreExternalReviewVisualAnchor(viewState.visualAnchor) || Boolean(scroller);
}

function restoreMarkdownVisualAnchor(anchor) {
  if (!anchor?.lineIndex && !anchor?.lineText) return false;
  const root = el("docHighlighter") || el("docReader") || document;
  const textLine = anchor.lineText
    ? [...root.querySelectorAll(".markdown-line")].find((candidate) => candidate.textContent === anchor.lineText)
    : null;
  const line = textLine || root.querySelector('.markdown-line[data-line-index="' + cssEscape(anchor.lineIndex) + '"]');
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

function diffComparableLine(line) {
  return String(line || "")
    .replace(/^(\s*last_verified\s*:).*/, "$1 #")
    .replace(/^(\s*)\d+([.)])(\s+)/, "$1#$2$3");
}

function diffLinesEqual(leftLine, rightLine) {
  return leftLine === rightLine || diffComparableLine(leftLine) === diffComparableLine(rightLine);
}

function diffContextLine(leftLine, rightLine) {
  return leftLine === rightLine ? leftLine : rightLine;
}

function reviewIdentityContentForUi(content) {
  const normalized = String(content || "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return normalized;
  const frontmatterEnd = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (frontmatterEnd < 0) return normalized;
  const endIndex = frontmatterEnd + 1;
  let contextIndent = null;
  return lines.filter((line, index) => {
    if (index < 1 || index >= endIndex) return true;
    const match = line.match(/^(\s*)([^#\s][^:]*)\s*:/);
    if (match && match[2].trim() === "context_room") {
      contextIndent = match[1].length;
      return true;
    }
    if (contextIndent == null) return true;
    const indent = line.match(/^\s*/)?.[0].length || 0;
    if (line.trim() && indent <= contextIndent) {
      contextIndent = null;
      return true;
    }
    return !/^\s+last_verified\s*:/.test(line);
  }).join("\n");
}

function onlyIgnoredReviewMetadataChanged(leftContent, rightContent) {
  return leftContent !== rightContent && reviewIdentityContentForUi(leftContent) === reviewIdentityContentForUi(rightContent);
}

function buildLcsTextDiffRows(left, right) {
  const dp = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] = diffLinesEqual(left[i], right[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (diffLinesEqual(left[i], right[j])) {
      rows.push({ type: "ctx", line: diffContextLine(left[i], right[j]) });
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
  while (prefix < left.length && prefix < right.length && diffLinesEqual(left[prefix], right[prefix])) prefix += 1;
  let leftEnd = left.length;
  let rightEnd = right.length;
  while (leftEnd > prefix && rightEnd > prefix && diffLinesEqual(left[leftEnd - 1], right[rightEnd - 1])) {
    leftEnd -= 1;
    rightEnd -= 1;
  }
  const rows = [];
  for (let index = 0; index < prefix; index += 1) rows.push({ type: "ctx", line: diffContextLine(left[index], right[index]) });
  for (const line of left.slice(prefix, leftEnd)) rows.push({ type: "del", line });
  for (const line of right.slice(prefix, rightEnd)) rows.push({ type: "add", line });
  for (let leftIndex = leftEnd, rightIndex = rightEnd; leftIndex < left.length && rightIndex < right.length; leftIndex += 1, rightIndex += 1) {
    rows.push({ type: "ctx", line: diffContextLine(left[leftIndex], right[rightIndex]) });
  }
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

function showConfirmDialog({ title, body, confirmLabel = "Confirm", confirmVariant = "danger", checkboxLabel = "", checkboxRequired = false, onConfirm }) {
  document.querySelector(".app")?.removeAttribute("inert");
  document.querySelector(".confirm-backdrop")?.remove();
  const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const backdrop = document.createElement("div");
  const appShell = document.querySelector(".app");
  backdrop.className = "confirm-backdrop";
  const confirmClass = confirmVariant === "primary" ? "primary" : confirmVariant === "secondary" ? "" : "danger-action";
  const checkboxMarkup = checkboxLabel
    ? '<label class="confirm-option"><input type="checkbox" data-confirm-checkbox /><span>' + escapeHtml(checkboxLabel) + '</span></label>'
    : "";
  backdrop.innerHTML = '<section class="confirm-dialog" role="dialog" aria-modal="true" aria-label="' + escapeHtml(title) + '">' +
    '<strong>' + escapeHtml(title) + '</strong>' +
    '<p>' + escapeHtml(body) + '</p>' +
    checkboxMarkup +
    '<div class="confirm-actions"><button class="file-action" type="button" data-confirm-cancel>Cancel</button><button class="file-action ' + confirmClass + '" type="button" data-confirm-accept' + (checkboxRequired ? ' disabled' : '') + '>' + escapeHtml(confirmLabel) + '</button></div>' +
  '</section>';
  const close = ({ restoreFocus = true } = {}) => {
    backdrop.remove();
    appShell?.removeAttribute("inert");
    document.removeEventListener("keydown", onKeydown);
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus();
  };
  const onKeydown = (event) => {
    if (event.key === "Escape") {
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...backdrop.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) close();
  });
  backdrop.querySelector("[data-confirm-cancel]").addEventListener("click", close);
  if (checkboxRequired) backdrop.querySelector("[data-confirm-checkbox]")?.addEventListener("change", (event) => {
    backdrop.querySelector("[data-confirm-accept]").disabled = !event.currentTarget.checked;
  });
  backdrop.querySelector("[data-confirm-accept]").addEventListener("click", () => {
    const checked = Boolean(backdrop.querySelector("[data-confirm-checkbox]")?.checked);
    close({ restoreFocus: false });
    onConfirm?.({ checked });
  });
  document.addEventListener("keydown", onKeydown);
  appShell?.setAttribute("inert", "");
  document.body.appendChild(backdrop);
  backdrop.querySelector(checkboxRequired ? "[data-confirm-checkbox]" : "[data-confirm-accept]")?.focus();
}

async function revertCurrentDiff(path = state.selected) {
  if (state.selectedStartupContext || state.selectedReadOnly) return;
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
  if (!state.externalChange || state.externalChange.path !== state.selected) return null;
  if (!selectedFileExists(state.externalChange.path)) return null;
  return state.externalChange;
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
  if (startup.kind === "startup-hook") return { type: "startup-hook", order: startup.order };
  return { type: "startup-context", order: startup.order };
}

async function readSelectedDiskFile(path = state.selected) {
  const startup = startupSelectionRequest();
  if (startup?.type === "startup-context") return api("/api/startup-context/file?order=" + encodeURIComponent(startup.order));
  if (startup?.type === "startup-skill") return api("/api/startup-skills/file?folder=" + encodeURIComponent(startup.folder) + "&skill=" + encodeURIComponent(startup.skill));
  if (startup?.type === "startup-hook") return api("/api/startup-hooks/file?order=" + encodeURIComponent(startup.order));
  return api("/api/file?path=" + encodeURIComponent(path));
}

async function readSelectedDiff(path = state.selected) {
  if (state.selectedStartupContext || state.selectedReadOnly) return { path, available: false, changed: false, additions: 0, deletions: 0, patch: "" };
  return api("/api/file/diff?path=" + encodeURIComponent(path));
}

async function readSelectedReviewBase(path = state.selected) {
  const startupReviewPath = selectedStartupContextReviewPath(path);
  if (startupReviewPath) return api("/api/file/review-base?path=" + encodeURIComponent(startupReviewPath));
  if (state.selectedStartupContext || state.selectedReadOnly) return null;
  return api("/api/file/review-base?path=" + encodeURIComponent(path));
}

async function recordSelectedReviewBaseline(path = state.selected, note = "") {
  const startupReviewPath = selectedStartupContextReviewPath(path);
  if (!path || (state.selectedStartupContext && !startupReviewPath) || state.selectedReadOnly) return null;
  const reviewPath = startupReviewPath || path;
  return api("/api/docqa/review-baseline", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: reviewPath, note }),
  });
}

function selectedStartupContextReviewPath(path = state.selected) {
  if (state.selectedStartupContext?.kind !== "startup-context") return "";
  return startupContextSelectedExplorerPath(state.selectedStartupContext) || path || "";
}

function applyChangedFileInlineReview(path, diff, review, requestId = state.selectionRequest) {
  if (!path || state.reviewModePath !== path || !diff?.changed) return false;
  if (!isCurrentSelection(requestId, path) || !review?.available) return false;
  const baseContent = typeof review.baseContent === "string" ? review.baseContent : "";
  const diskContent = typeof review.currentContent === "string" ? review.currentContent : state.saved || "";
  const ignoredMetadataOnly = onlyIgnoredReviewMetadataChanged(baseContent, diskContent);
  if (baseContent === diskContent || ignoredMetadataOnly) {
    clearReviewSession(path);
    state.saved = typeof review.currentContent === "string" ? review.currentContent : state.saved || "";
    state.savedHash = review.currentHash || state.savedHash;
    state.dirty = false;
    state.diffCollapsed = true;
    if (ignoredMetadataOnly && state.selectedDiff) state.selectedDiff = { ...state.selectedDiff, changed: false, additions: 0, deletions: 0, patch: "" };
    el("editor").value = state.saved;
    setStatus(ignoredMetadataOnly ? "last_verified synced · ready for verification" : "changes already reviewed · mark verified when ready");
    return false;
  }
  const previousSession = state.reviewSessions?.[path] || null;
  const reviewDecisions = previousSession &&
    previousSession.baseContent === baseContent &&
    previousSession.diskContent === diskContent
      ? { ...(previousSession.reviewDecisions || {}) }
      : {};
  state.externalChange = {
    path,
    source: "review",
    baseContent,
    diskContent,
    diskHash: review.currentHash || state.savedHash,
    diskUpdatedAt: "",
    changeKind: review.changeKind || "modified",
    reviewDecisions,
  };
  state.saved = state.externalChange.diskContent;
  state.savedHash = state.externalChange.diskHash || state.savedHash;
  state.dirty = false;
  state.diffCollapsed = true;
  el("editor").value = state.saved;
  setStatus(review.changeKind === "added" ? "new file waiting for review" : review.changeKind === "renamed" ? "renamed file waiting for review" : "changes waiting for review");
  return true;
}

async function startChangedFileInlineReview(path, diff, requestId = state.selectionRequest) {
  if (!path || state.reviewModePath !== path || !diff?.changed) return false;
  const review = await readSelectedReviewBase(path);
  return applyChangedFileInlineReview(path, diff, review, requestId);
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
  if (startup?.type === "startup-hook") {
    return api("/api/startup-hooks/file", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order: startup.order, content }),
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

function rememberActiveReviewSession() {
  const change = state.externalChange;
  if (!change || change.source !== "review" || !change.path) return;
  state.reviewSessions[change.path] = {
    baseContent: externalReviewBaseContent(change),
    diskContent: change.diskContent || "",
    diskHash: change.diskHash || "",
    changeKind: change.changeKind || "modified",
    reviewDecisions: { ...(change.reviewDecisions || {}) },
  };
}

function clearReviewSession(path) {
  if (!path || !state.reviewSessions) return;
  delete state.reviewSessions[path];
}

function resetExternalChangeState(options = {}) {
  const path = state.externalChange?.path || "";
  if (options.discardReview) clearReviewSession(path);
  else rememberActiveReviewSession();
  state.externalChange = null;
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

function firstExternalReviewChangeBlockId() {
  return externalReviewChangeElements()[0]?.dataset.externalReviewBlock || "";
}

function focusFirstExternalReviewChange() {
  return focusExternalReviewChange(firstExternalReviewChangeBlockId());
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
  if (!state.selected || state.selectedReadOnly || !state.dirty || state.openingFilePath === state.selected || state.savedHash == null) return;
  window.clearTimeout(state.conflictCheckTimer);
  state.conflictCheckTimer = window.setTimeout(() => checkSelectedFileConflict().catch((error) => setStatus(error.message)), 250);
}

async function checkSelectedFileConflict() {
  if (!state.selected || state.selectedReadOnly || !state.dirty || state.openingFilePath === state.selected || state.savedHash == null) return false;
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
  if (state.selectedReadOnly) {
    setStatus("read-only file · add it to watched/allowed paths before editing");
    updateHeader();
    return;
  }
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
  if (document.hidden || state.refreshInFlight) return;
  state.refreshInFlight = true;
  try {
    if (!previousSelected || previousSelected !== state.selected) return;
    if (state.openingFilePath === state.selected || state.savedHash == null) return;
    if (activeExternalChange()?.source === "review") {
      if (Date.now() - (state.lastDiffRefreshAt || 0) < 15_000) return;
      state.selectedDiff = await readSelectedDiff(previousSelected);
      state.lastDiffRefreshAt = Date.now();
      updateHeader();
      updatePreview();
      return;
    }
    const data = await readSelectedDiskFile(previousSelected);
    if (previousSelected !== state.selected) return;
    if (!data.exists && !canReviewMissingFile(previousSelected)) {
      clearMissingSelectedFile(previousSelected);
      renderFiles();
      showHome();
      scheduleSessionStatePush();
      setStatus("file removed or renamed · returned to hub");
      return;
    }
    if (state.dirty) {
      await checkSelectedFileConflict();
      return;
    }
    if (data.contentHash === state.savedHash) {
      if (activeExternalChange()) {
        const diff = await readSelectedDiff(previousSelected);
        resetExternalChangeState();
        state.selectedDiff = diff;
        state.lastDiffRefreshAt = Date.now();
        renderViewer();
        updateHeader();
        updatePreview();
      }
      return;
    }
    if (onlyIgnoredReviewMetadataChanged(state.saved || "", data.content)) {
      const viewState = captureEditorViewState();
      resetConflictState();
      resetExternalChangeState();
      state.saved = data.content;
      state.savedHash = data.contentHash;
      state.dirty = false;
      el("editor").value = data.content;
      const docEditor = el("docEditor");
      if (docEditor) docEditor.value = data.content;
      renderViewer();
      restoreEditorViewState(viewState);
      updateHeader();
      updatePreview();
      setStatus("last_verified synced");
      return;
    }
    const diff = await readSelectedDiff(previousSelected);
    if (previousSelected !== state.selected) return;
    state.lastDiffRefreshAt = Date.now();
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
  } finally {
    state.refreshInFlight = false;
  }
}

function scheduleBackgroundRefresh(options = {}) {
  if (document.hidden || state.backgroundRefreshTimer) return;
  const run = () => {
    state.backgroundRefreshTimer = null;
    refreshBackgroundReports(options).catch((error) => setStatus(error.message));
  };
  if ("requestIdleCallback" in window) state.backgroundRefreshTimer = window.requestIdleCallback(run, { timeout: 800 });
  else state.backgroundRefreshTimer = window.setTimeout(run, 120);
}

async function refreshBackgroundReports(options = {}) {
  if (document.hidden || state.reportsRefreshInFlight) return;
  const now = Date.now();
  const reportInterval = state.selected ? 30_000 : 15_000;
  const fullInterval = state.selected ? 60_000 : 30_000;
  const shouldRefreshReports = options.forceReports || now - (state.lastReportRefreshAt || 0) >= reportInterval;
  const shouldRefreshFull = options.forceFull || now - (state.lastFullRefreshAt || 0) >= fullInterval;
  if (!shouldRefreshReports && !shouldRefreshFull) return;
  state.reportsRefreshInFlight = true;
  try {
    const reportsPath = "/api/reports" + (options.forceReports ? "?fresh=1" : "");
    const [reports, filesData, settingsData] = await Promise.all([
      shouldRefreshReports ? api(reportsPath) : Promise.resolve(null),
      shouldRefreshFull ? api(filesApiPath()) : Promise.resolve(null),
      shouldRefreshFull ? api("/api/settings") : Promise.resolve(null),
    ]);
    const reportsChanged = reports ? applyBackgroundReportPayload(reports) : false;
    if (reports) {
      state.lastReportRefreshAt = Date.now();
    }
    let settingsChanged = false;
    if (filesData) {
      state.files = filesData.files;
      state.root = filesData.root || state.root;
      state.lastFullRefreshAt = Date.now();
      if (!state.settingsOpen && settingsData) settingsChanged = applySettingsPayload(settingsData);
    }
    if (filesData) renderFiles();
    if (reconcileMissingSelectedFile()) {
      showHome();
      scheduleSessionStatePush();
      setStatus("file removed or renamed · returned to hub");
      return;
    }
    if (state.settingsOpen) {
      if (reportsChanged || settingsChanged) updateActionBanner();
    } else if (!state.selected) {
      if (reportsChanged || settingsChanged) renderDocQaDashboard();
    } else if (reportsChanged || settingsChanged) {
      updateHeader();
    }
  } finally {
    state.reportsRefreshInFlight = false;
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
    documentViewportTop: documentScrollTarget?.getBoundingClientRect?.().top ?? null,
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

const SPOTLIGHT_CARD_SELECTOR = ".launch-card, .review-item, .hub-folder-card, .startup-context-item:not(.startup-skill-folder), .settings-toggle, .settings-theme-preview, .template-editor, .hub-section-editor, .hub-card-editor, .path-picker, .card, .conflict-card";
let spotlightCard = null;
let spotlightPointer = null;
let spotlightFrame = 0;
let interfaceScrollEndTimer = 0;
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
  if (!spotlightPointer || spotlightFrame || document.documentElement.classList.contains("ui-scrolling")) return;
  const pointer = spotlightPointer;
  spotlightFrame = window.requestAnimationFrame(() => {
    spotlightFrame = 0;
    if (spotlightPointer !== pointer) return;
    updateCardSpotlightAt(pointer.x, pointer.y);
  });
}
function updateCardSpotlight(event) {
  spotlightPointer = { x: event.clientX, y: event.clientY };
  scheduleCardSpotlightUpdate();
}
function refreshCardSpotlightAfterScroll() {
  markInterfaceScrolling();
  scheduleCardSpotlightUpdate();
}

function markInterfaceScrolling() {
  document.documentElement.classList.add("ui-scrolling");
  clearCardSpotlight();
  window.clearTimeout(interfaceScrollEndTimer);
  interfaceScrollEndTimer = window.setTimeout(() => {
    document.documentElement.classList.remove("ui-scrolling");
    scheduleCardSpotlightUpdate();
  }, 140);
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
el("search").addEventListener("input", () => { markUserActive(); state.pathFilters = []; scheduleExplorerSearchRender(); });
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
  if (isScrollIntentKey(event)) markUserScrollIntent();
  markUserActive();
  setDocLinkModifierActive(isDocLinkModifierEventActive(event));
  if (handleSaveShortcut(event)) return;
  if (event.key === "Escape") {
    hideExplorerContextMenu();
  }
});
document.addEventListener("keyup", (event) => setDocLinkModifierActive(isDocLinkModifierEventActive(event)));
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    setDocLinkModifierActive(false);
    return;
  }
  refreshFromDisk();
  scheduleBackgroundRefresh();
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
el("refreshDocQa")?.addEventListener("click", () => loadFiles({ waitForBackground: true }).catch((error) => setStatus(error.message)));
document.querySelectorAll("[data-home-action]").forEach((button) => button.addEventListener("click", () => homeAction(button.dataset.homeAction)));
document.querySelectorAll("[data-home-file]").forEach((button) => button.addEventListener("click", () => selectFile(button.dataset.homeFile).catch((error) => setStatus(error.message))));
el("back").addEventListener("click", () => goHistory(-1).catch((error) => setStatus(error.message)));
el("forward").addEventListener("click", () => goHistory(1).catch((error) => setStatus(error.message)));
el("hub").addEventListener("click", () => handleHubAction().catch((error) => setStatus(error.message)));
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
  if (state.dirty && !confirm("Discard unsaved editor changes and reload this file from disk?")) return;
  state.dirty = false;
  selectFile(state.selected, { pushHistory: false, fromPlanet: state.filePanel, forceReload: true }).catch((error) => setStatus(error.message));
});
window.addEventListener("beforeunload", (event) => {
  persistNavigationState();
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
document.addEventListener("pointerdown", markUserActive, { passive: true });
document.addEventListener("wheel", markUserScrollIntent, { capture: true, passive: true });
document.addEventListener("touchmove", markUserScrollIntent, { capture: true, passive: true });
document.addEventListener("pointerover", (event) => schedulePrefetchPathFromTarget(event.target), { passive: true });
document.addEventListener("focusin", (event) => prefetchPathFromTarget(event.target));
document.addEventListener("scroll", scheduleSessionStatePush, { capture: true, passive: true });
syncResponsiveSidebar({ force: true });
window.addEventListener("resize", () => syncResponsiveSidebar());
setMode("view");
startAgentCommandPolling();
loadFiles({ initial: true })
  .catch((error) => setStatus(error.message))
  .finally(() => window.requestAnimationFrame(finishInitialBoot));
window.setInterval(() => refreshFromDisk(), 2200);
window.setInterval(() => scheduleBackgroundRefresh(), 5_000);
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
