#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

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
const DEFAULT_HUB_CARDS = [
  { id: "docs", title: "Docs", path: "docs/", description: "Project documentation.", cards: [{ id: "agent-docs", title: "Agent docs", paths: ["AGENTS.md", "CLAUDE.md", ".hermes.md"], description: "Instructions loaded by AI agents." }] },
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
  if (normalized.startsWith("~")) {
    return Boolean(settings.integrations?.hermes) && ALLOWED_EXTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix)) && isEditableTextFile(normalized);
  }
  const allowed = sanitizePathList(settings.allowedPaths || ALLOWED_PREFIXES);
  return allowed.some((pattern) => pathMatchesSetting(normalized, pattern) || normalized.startsWith(pattern.replace(/\/$/, "") + "/")) && isEditableTextFile(normalized);
}

export function resolveMemoryPath(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  if (!isAllowedMemoryPath(normalized, readMemoryWebappSettings(root))) {
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

export function deleteMemoryPaths(root, relPaths = []) {
  if (!Array.isArray(relPaths) || relPaths.length === 0) throw new Error("No paths selected for deletion");
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
      const files = walkExternalTextFiles(abs, baseDir, prefix).filter((file) => isAllowedMemoryPath(file));
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
    if (isAllowedMemoryPath(normalized)) {
      const abs = resolveMemoryPath(root, normalized);
      if (fs.existsSync(abs)) {
        const stats = fs.statSync(abs);
        if (!stats.isFile()) throw new Error(`Not a file: ${relPath}`);
        fs.unlinkSync(abs);
        deleted.push(normalized);
      }
      continue;
    }
    if (!isAllowedFolderPath(normalized)) throw new Error(`Path not allowed in context room: ${relPath}`);
    const absDir = path.resolve(root, normalized);
    if (!fs.existsSync(absDir)) continue;
    if (!fs.statSync(absDir).isDirectory()) throw new Error(`Not a folder: ${relPath}`);
    const files = walkTextFiles(absDir, root).filter((file) => isAllowedMemoryPath(file));
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

function stringifyYaml(value, indent = 0) {
  return Object.entries(value || {}).map(([key, item]) => yamlLine(key, item, indent)).join("");
}

function yamlLine(key, value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) return `${pad}${key}: [${value.map(yamlScalar).join(", ")}]\n`;
  if (value && typeof value === "object") return `${pad}${key}:\n${stringifyYaml(value, indent + 2)}`;
  return `${pad}${key}: ${yamlScalar(value)}\n`;
}

function yamlScalar(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value ?? "");
  if (!text || /[:#\[\]{},&*?|>'"%@`\n]|^[-?]|\s$|^\s/.test(text)) return JSON.stringify(text);
  return text;
}

function parseSimpleYaml(source) {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const raw of String(source || "").split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;
    const indent = raw.match(/^ */)[0].length;
    const match = raw.trim().match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) throw new Error(`Unsupported YAML: ${raw}`);
    while (stack.length > 1 && indent <= stack.at(-1).indent) stack.pop();
    const parent = stack.at(-1).value;
    const key = match[1];
    const rest = match[2] ?? "";
    if (rest === "") {
      parent[key] = {};
      stack.push({ indent, value: parent[key] });
    } else {
      parent[key] = parseYamlScalar(rest);
    }
  }
  return root;
}

function parseYamlScalar(raw) {
  const text = String(raw || "").trim();
  if (text === "null" || text === "~") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineArray(inner).map(parseYamlScalar);
  }
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  return text;
}

function splitInlineArray(text) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  return items;
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

export function computeDocIssues({ path: relPath, content = "", gitStatus = "" }) {
  const classification = classifyDocPath(relPath);
  const issues = [];
  const text = String(content);
  if (gitStatus.trim() && classification.sensitive) issues.push({ type: "sensitive_changed", severity: "critical", message: "Sensitive file changed: human review before canonical truth." });
  const todoCount = (text.match(/\b(TODO|FIXME|HACK|QUESTION|à clarifier|a verifier|à vérifier)\b/gi) || []).length;
  if (todoCount) issues.push({ type: "todo", severity: classification.type === "canonical" ? "high" : "medium", message: `${todoCount} TODO/question to consolidate.` });
  const verified = text.match(/last_verified:\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
  if ((classification.type === "canonical" || classification.type === "prompt" || classification.type === "memory") && !verified && gitStatus.trim()) issues.push({ type: "missing_last_verified", severity: "medium", message: "Missing last_verified while the file is modified." });
  if (verified && Date.parse(verified) < Date.now() - 1000 * 60 * 60 * 24 * 120) issues.push({ type: "stale_verified", severity: "medium", message: `Old last_verified: ${verified}.` });
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
    const issues = computeDocIssues({ path: file.path, content, gitStatus });
    const riskScore = riskScoreFor({ classification, issues, gitStatus });
    const review = currentReviewFor(reviewState.reviews, file.path, content);
    return { path: file.path, label: file.label, summary: file.summary, updatedAt: file.updatedAt, classification, gitStatus, issues, riskScore, review };
  }).filter((item) => item.gitStatus.trim()
  ).filter((item) => isWatchedPath(item.path, settings)
  ).filter((item) => !(item.review?.status === "verified" && item.review.current)
  ).sort((a, b) => b.riskScore - a.riskScore || a.path.localeCompare(b.path, "fr"));
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalDocs: files.length,
      changedDocs: queue.filter((item) => item.gitStatus.trim()).length,
      needsReview: queue.length,
      critical: queue.filter((item) => item.issues.some((issue) => issue.severity === "critical")).length,
      high: queue.filter((item) => item.issues.some((issue) => issue.severity === "high")).length,
      prompts: files.filter((file) => classifyDocPath(file.path).type === "prompt").length,
      canonical: files.filter((file) => classifyDocPath(file.path).type === "canonical").length,
    },
    queue: queue.slice(0, 80),
  };
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
  return hubCardsForSettings(settings).map((card) => materializeHubCardForRoot(root, card)).filter(Boolean);
}

export function hubSectionsForRoot(root = process.cwd(), settings = defaultMemoryWebappSettings()) {
  return hubSectionsForSettings(settings)
    .map((section) => ({ ...section, cards: materializeHubCardsForRoot(root, section.cards) }));
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

function materializeHubCardsForRoot(root, cards = []) {
  return cards.map((card) => {
    const children = materializeHubCardsForRoot(root, card.cards || []);
    const materialized = materializeHubCardForRoot(root, card);
    if (children.length) return { ...(materialized || stripHubCardRuntimeFields(card)), cards: children };
    return materialized;
  }).filter(Boolean);
}

function materializeHubCardForRoot(root, card) {
  const existingPaths = hubCardPaths(card).filter((folderPath) => hubCardPathExists(root, folderPath));
  if (existingPaths.length === 0) return stripHubCardRuntimeFields(card);
  const { path: _path, paths: _paths, cards: _cards, ...rest } = card;
  return existingPaths.length === 1 ? { ...rest, path: existingPaths[0] } : { ...rest, paths: existingPaths };
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
    hubCards,
    customHubCards,
    hubSections,
  };
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
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const status = line.slice(0, 2);
      const rel = line.slice(3).replace(/^"|"$/g, "").replaceAll("\\", "/");
      if (rel) statuses.set(rel, status);
    }
  } catch {
    // Git is optional for temp test roots and non-repo launches.
  }
  return statuses;
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
  if (req.method === "POST" && url.pathname === "/api/file") {
    const body = await readJsonBody(req);
    sendJson(res, 200, writeMemoryFile(root, body.path, body.content));
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

function isEditableTextFile(relPath) {
  return [".md", ".csv", ".txt", ".json", ".jsonl", ".yaml", ".yml", ".mjs", ".js", ".py"].includes(path.extname(relPath));
}

function validateEditableContent(relPath, content) {
  if (path.extname(relPath) !== ".json") return;
  try {
    JSON.parse(content || "null");
  } catch (error) {
    throw new Error(`Invalid JSON in ${relPath}: ${error.message}`);
  }
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

function isAllowedFolderPath(relPath) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  if (normalized.startsWith("~")) return false;
  return ALLOWED_PREFIXES.some((prefix) => normalized === prefix.replace(/\/$/, "") || normalized.startsWith(prefix));
}

function isAllowedExternalPath(relPath) {
  const normalized = normalizeRelPath(relPath).replace(/\/$/, "");
  if (!normalized || normalized.startsWith("../") || normalized.includes("/../") || path.isAbsolute(normalized)) return false;
  if (isBlockedPath(normalized)) return false;
  return Boolean(externalPrefixForPath(normalized));
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
    .app.sidebar-collapsed .sidebar-copy, .app.sidebar-collapsed .workspace-dock, .app.sidebar-collapsed .search-row, .app.sidebar-collapsed .explorer-title, .app.sidebar-collapsed .tree, .app.sidebar-collapsed .hint { opacity: 0; pointer-events: none; transform: translateX(-10px); }
    .sidebar-copy, .workspace-dock, .search-row, .explorer-title, .tree, .hint { transition: opacity 180ms ease, transform 180ms ease; }
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
    .explorer-title { color: var(--accent); font-size: 11px; font-weight: 850; text-transform: uppercase; letter-spacing: 0.12em; margin: 10px 0 6px; }
    .tree { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; line-height: 1.35; overflow: visible; padding-right: 4px; }
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
    .hub-section-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
    .hub-folder-card { border: 1px solid rgba(148,163,184,0.16); border-radius: 22px; padding: 18px; min-height: 132px; background: linear-gradient(145deg, rgba(139,211,255,0.10), rgba(182,156,255,0.06)); color: var(--text); text-align: left; cursor: pointer; display: grid; align-content: space-between; gap: 12px; box-shadow: 0 18px 54px rgba(0,0,0,0.24); }
    .hub-folder-card.navigation { background: linear-gradient(145deg, rgba(182,156,255,0.13), rgba(139,211,255,0.07)); }
    .hub-folder-card:hover { transform: translateY(-2px); border-color: rgba(139,211,255,0.42); background: linear-gradient(145deg, rgba(139,211,255,0.16), rgba(182,156,255,0.10)); }
    .hub-folder-card strong { display: block; font-size: 20px; letter-spacing: -0.04em; }
    .hub-folder-card span { color: var(--muted); font-size: 13px; line-height: 1.35; }
    .hub-folder-card code { color: var(--accent); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .hub-folder-meta { display: flex; justify-content: space-between; gap: 10px; align-items: center; color: #cbd7ec; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; }
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
    @media (max-width: 1200px) { .hub-folders { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 860px) { .settings-card { position: static; width: 100%; max-height: none; margin-bottom: 12px; } .hub-folders { grid-template-columns: 1fr; } }
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
    .diff-empty { padding: 18px; color: var(--muted); font: 14px/1.5 Inter, ui-sans-serif, system-ui, sans-serif; }
    .file-header-copy { min-width: 0; display: grid; gap: 5px; }
    .file-header-copy .diff-meta { white-space: normal; line-height: 1.35; }
    .file-actions { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
    .file-action { border: 1px solid rgba(148,163,184,0.18); border-radius: 12px; padding: 9px 12px; background: rgba(255,255,255,0.06); color: var(--text); font-weight: 850; cursor: pointer; }
    .file-action:hover { transform: translateY(-1px); background: rgba(139,211,255,0.12); }
    .file-action.primary { color: #07101e; border: 0; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
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
    @media (max-width: 980px) { .app, .app.sidebar-collapsed { grid-template-columns: 1fr; height: auto; overflow: auto; } aside { border-right: 0; border-bottom: 1px solid var(--line); height: auto; max-height: 70vh; } .planet-system { min-height: 720px; } .planet.root.hermes { left: 50%; top: 20%; } .planet.root.life { left: 50%; top: 50%; } .planet.root.explorer { left: 50%; top: 80%; } }
  </style>
</head>
<body>
  <div class="app">
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
        <div id="viewer" class="viewer"></div>
        <textarea id="editor" spellcheck="false"></textarea>
      </section>
    </main>
  </div>
<script>
const state = { files: [], docqa: null, settings: null, settingsOpen: false, page: "hub", availableHubCards: [], hubFolders: [], hubSections: [], rootHubSections: [], activeHubCardId: null, selectedReview: null, selected: null, selectedDiff: null, diffCollapsed: false, saved: "", savedHash: null, dirty: false, mode: "view", homeView: "root", planetStack: ["root"], filePanel: false, history: [], historyIndex: -1, pathFilters: [], explorerWatchFilter: "all", selectedForDelete: new Set(), selectionRequest: 0, expanded: new Set(["data", "automations", "integrations", "skills", "tools", "~", "~/.hermes", "~/.hermes/memories", "~/.hermes/skills"]) };
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
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(path, options);
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
      if (shouldToggleSelection(event)) toggleDeleteSelection(button.dataset.filePath);
      else selectFile(button.dataset.filePath).catch((error) => setStatus(error.message));
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      toggleDeleteSelection(button.dataset.filePath);
    });
  });
  document.querySelectorAll("[data-folder-path]").forEach((button) => {
    button.addEventListener("click", (event) => {
      const selectPath = button.dataset.folderPath + "/";
      if (shouldToggleSelection(event)) toggleDeleteSelection(selectPath);
      else {
        openSidebarIfCollapsed();
        toggleFolder(button.dataset.folderPath);
      }
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      toggleDeleteSelection(button.dataset.folderPath + "/");
    });
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

function openSidebarIfCollapsed() {
  document.querySelector(".app")?.classList.remove("sidebar-collapsed");
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
      '<button class="tree-row file ' + (state.selected === file.path ? "active" : "") + '" style="padding-left:' + (depth * 12 + 7) + 'px" data-file-path="' + escapeHtml(file.path) + '" title="open · right-click or ⌘-click to select">' +
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
      '<button class="tree-row folder" style="padding-left:' + (depth * 12 + 7) + 'px" data-folder-path="' + escapeHtml(node.path) + '" title="open · right-click or ⌘-click to select">' +
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
  const [data, docqa, settingsData] = await Promise.all([api("/api/files"), api("/api/docqa"), api("/api/settings")]);
  state.files = data.files;
  state.docqa = docqa;
  state.settings = settingsData.settings;
  state.availableHubCards = settingsData.availableHubCards || [];
  state.hubFolders = settingsData.hubCards || [];
  state.rootHubSections = settingsData.hubSections || [];
  state.hubSections = hubSectionViewForCard(state.rootHubSections, state.activeHubCardId);
  state.selectedReview = docqa.queue[0]?.path || null;
  renderFiles();
  if (!state.selected) showHome();
  setStatus("ready");
}

async function selectFile(path, options = {}) {
  if (!path) return;
  if (state.dirty && !confirm("You have unsaved changes. Change file?")) return;

  const requestId = ++state.selectionRequest;
  state.selected = path;
  state.page = "file";
  state.settingsOpen = false;
  if (state.docqa?.queue?.some((item) => item.path === path)) state.selectedReview = path;
  state.selectedDiff = null;
  state.saved = "";
  state.savedHash = null;
  state.dirty = false;
  state.filePanel = false;
  if (options.revealInExplorer) {
    state.pathFilters = [];
    el("search").value = "";
    document.querySelector(".app").classList.remove("sidebar-collapsed");
  }
  for (const folder of parentFolders(path).slice(0, -1)) state.expanded.add(folder);
  document.querySelector(".editor-shell").classList.remove("planet-file-open");
  document.querySelector(".editor-shell").classList.add("file-open");
  el("home").hidden = true;
  el("settingsPage").hidden = true;
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

function scrollExplorerToPath(path) {
  const aside = document.querySelector("aside");
  const target = document.querySelector('[data-file-path="' + cssEscape(path) + '"]');
  if (!aside || !target) return;
  aside.scrollTop += target.getBoundingClientRect().top - aside.getBoundingClientRect().top - 120;
}

function showHome() {
  state.page = "hub";
  state.settingsOpen = false;
  state.filePanel = false;
  state.dirty = false;
  el("title").textContent = "Doc QA Control Room";
  el("path").textContent = "ce que l’agent peut croire · ce qu’il vient de modifier · ce que l’humain doit valider";
  el("impact").textContent = "V1: Git/docs review queue, risk signals, reliability inspector, and direct evidence access.";
  el("meta").textContent = state.docqa ? "audit generated " + new Date(state.docqa.generatedAt).toLocaleTimeString("en-US") : "";
  el("home").hidden = false;
  el("settingsPage").hidden = true;
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
    selectFile(button.dataset.reviewPath, { revealInExplorer: true }).catch((error) => setStatus(error.message));
  }));
  renderHubFolders();
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

function renderFileActionButtons({ hasReviewItem = false, dirty = false } = {}) {
  return '<div class="file-actions">' +
    (hasReviewItem ? '<button class="file-action" type="button" data-file-verify>Mark verified</button>' : '') +
    '<button class="file-action danger-action" type="button" data-file-delete>Delete</button>' +
    '<button class="file-action primary" type="button" data-file-save ' + (!dirty ? 'disabled' : '') + '>Save</button>' +
  '</div>';
}

function selectedFileNeedsReview() {
  return Boolean(state.selected && state.docqa?.queue?.some((item) => item.path === state.selected));
}

function renderSettingsPanel() {
  const holder = el("settingsPanel");
  if (!holder || !state.settings) return;
  const watchAllow = (state.settings.watchAllow || []).join("\n");
  const sections = state.settings.hubSections?.length ? state.settings.hubSections : [{ id: "main", title: "Main", cards: state.settings.customHubCards || state.availableHubCards || [] }];
  holder.innerHTML = '<div class="settings-grid">' +
    '<div class="settings-field"><label for="watchAllow">Watched folders/files</label><textarea id="watchAllow" placeholder="one path per line · empty = nothing to review">' + escapeHtml(watchAllow) + '</textarea></div>' +
  '</div>' +
  '<div><div class="settings-title">Hub sections and cards</div><div class="hub-card-options" id="hubSectionEditors">' +
    sections.map(renderHubSectionEditor).join("") +
  '</div></div>' +
  '<div class="settings-footer"><span>A card can open files/folders or contain child cards.</span><div class="docqa-actions"><button id="addHubSection" class="secondary" type="button">+ section</button><button id="saveSettings" class="secondary" type="button">save settings</button></div></div>';
  wireHubSettingsButtons(holder);
  el("addHubSection")?.addEventListener("click", addHubSectionEditor);
  el("saveSettings")?.addEventListener("click", saveSettings);
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
    '<div class="hub-card-editor-head"><label class="hub-card-editor-title"><input type="checkbox" data-card-enabled ' + (card.enabled !== false ? 'checked' : '') + ' /> active</label><div class="docqa-actions"><button class="selection-action" type="button" data-add-child-card title="add a child card">+</button><button class="selection-action danger-action" type="button" data-remove-hub-card title="remove this card">×</button></div></div>' +
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
  const hubSections = collectHubSectionEditors();
  const allCards = flattenUiCards(hubSections.flatMap((section) => section.cards));
  const hubCards = Object.fromEntries(allCards.map((card) => [card.id, card.enabled !== false]));
  setStatus("saving settings...");
  const result = await api("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings: { watchAllow, hubCards, hubSections } }),
  });
  state.settings = result.settings;
  state.availableHubCards = result.availableHubCards || state.availableHubCards;
  state.hubFolders = result.hubCards || [];
  state.rootHubSections = result.hubSections || [];
  state.hubSections = hubSectionViewForCard(state.rootHubSections, state.activeHubCardId);
  state.docqa = await api("/api/docqa");
  state.selectedReview = state.docqa.queue[0]?.path || null;
  if (state.page === "settings") renderSettingsPanel();
  else renderDocQaDashboard();
  setStatus("settings saved");
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
    const cards = collectHubCardEditors(row.querySelector(":scope > [data-card-children]"));
    return { id, title, description, paths, cards, enabled };
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
  state.docqa = await api("/api/docqa");
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
  state.docqa = await api("/api/docqa");
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
  state.docqa = await api("/api/docqa");
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
  if (state.dirty && !confirm("You have unsaved changes. Open settings?")) return;
  state.page = "settings";
  state.settingsOpen = true;
  state.selected = null;
  state.selectedDiff = null;
  state.savedHash = null;
  state.dirty = false;
  el("title").textContent = "Settings";
  el("path").textContent = "watch scope · sections · hub cards";
  el("impact").textContent = "Full page for managing the hub tree comfortably.";
  el("meta").textContent = "settings open";
  el("home").hidden = true;
  el("settingsPage").hidden = false;
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
  const sections = state.hubSections?.length ? state.hubSections : [{ id: "main", title: "Main", cards: state.hubFolders || [] }];
  holder.innerHTML = renderHubBreadcrumb() + sections.map((section) => '<section class="hub-section"><div class="hub-section-title">' + escapeHtml(section.title || "Section") + '</div><div class="hub-section-grid">' + (section.cards || []).map(renderHubFolderCard).join("") + '</div></section>').join("");
  document.querySelectorAll("[data-hub-folders]").forEach((button) => button.addEventListener("click", () => filterFolders(button.dataset.hubFolders.split('|'))));
  document.querySelectorAll("[data-hub-card-children]").forEach((button) => button.addEventListener("click", () => openHubChildren(button.dataset.hubCardChildren)));
  document.querySelectorAll("[data-hub-crumb]").forEach((button) => button.addEventListener("click", () => openHubPath(button.dataset.hubCrumb || null)));
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

function renderHubFolderCard(folder) {
  const children = folder.cards || [];
  const paths = folderPaths(folder);
  const count = countFolderFiles(paths) + children.reduce((sum, child) => sum + countFolderFiles(folderPaths(child)), 0);
  const meta = children.length ? children.length + ' child card' + (children.length > 1 ? 's' : '') : (paths.length > 1 ? paths.length + ' sources' : paths[0]);
  const data = children.length ? ' data-hub-card-children="' + escapeHtml(folder.id) + '"' : ' data-hub-folders="' + escapeHtml(paths.join('|')) + '"';
  return '<button class="hub-folder-card ' + (children.length ? 'navigation' : '') + '" type="button"' + data + '>' +
    '<div><strong>' + escapeHtml(folder.title) + '</strong><span>' + escapeHtml(folder.description) + '</span></div>' +
    '<div class="hub-folder-meta"><code>' + escapeHtml(meta || "navigation") + '</code><span>' + count + ' file' + (count > 1 ? 's' : '') + '</span></div>' +
  '</button>';
}

function openHubChildren(cardId) {
  openHubPath(cardId);
  setStatus("child cards open");
}

function openHubPath(cardId = null) {
  const nextSections = hubSectionViewForCard(state.rootHubSections || state.hubSections || [], cardId);
  state.activeHubCardId = cardId || null;
  state.hubSections = nextSections;
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
  if (state.dirty && !confirm("You have unsaved changes. Return to hub?")) return;
  state.selected = null;
  state.selectedDiff = null;
  state.savedHash = null;
  state.dirty = false;
  state.activeHubCardId = null;
  state.hubSections = state.rootHubSections;
  showHome();
}

function updateHeader() {
  const file = state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  el("title").textContent = file.label || file.path;
  el("path").textContent = "";
  el("impact").textContent = "";
  el("save").disabled = !state.dirty || !state.selected;
  const headerSave = document.querySelector("[data-file-save]");
  if (headerSave) headerSave.disabled = !state.dirty || !state.selected;
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

function setMode() {
  state.mode = "edit";
  el("viewer").style.display = "block";
  el("editor").style.display = "none";
  if (state.selected) renderViewer();
}

function renderViewer() {
  const text = el("editor").value;
  const diff = state.selectedDiff || { changed: false, additions: 0, deletions: 0, patch: "", available: false };
  const file = state.files.find((item) => item.path === state.selected) || { label: state.selected, path: state.selected };
  const hasDiff = diff.available !== false && diff.changed;
  const diffMarkup = hasDiff ? renderDiffPanel(diff) : "";
  const showDiffButton = hasDiff && state.diffCollapsed ? '<button class="diff-toggle" type="button" data-show-diff>Show Git diff</button>' : "";
  el("viewer").innerHTML = '<div class="review-workspace ' + (!hasDiff || state.diffCollapsed ? 'no-diff' : '') + '">' +
    (state.diffCollapsed ? "" : diffMarkup) +
    '<section class="file-panel">' + showDiffButton + '<header><div class="file-header-copy"><strong>' + escapeHtml(file.label || "Document") + '</strong></div>' + renderFileActionButtons({ hasReviewItem: selectedFileNeedsReview(), dirty: state.dirty }) + '</header><textarea id="docEditor" class="doc-editor" spellcheck="false">' + escapeHtml(text) + '</textarea></section></div>';
  document.querySelector("[data-hide-diff]")?.addEventListener("click", () => { state.diffCollapsed = true; renderViewer(); });
  document.querySelector("[data-show-diff]")?.addEventListener("click", () => { state.diffCollapsed = false; renderViewer(); });
  document.querySelector("[data-file-save]")?.addEventListener("click", () => saveCurrent().catch((error) => setStatus(error.message)));
  document.querySelector("[data-file-verify]")?.addEventListener("click", () => verifyCurrentFile().catch((error) => setStatus(error.message)));
  document.querySelector("[data-file-delete]")?.addEventListener("click", () => deletePaths([state.selected]).catch((error) => setStatus(error.message)));
  const docEditor = el("docEditor");
  if (docEditor) {
    docEditor.addEventListener("input", () => {
      el("editor").value = docEditor.value;
      state.dirty = docEditor.value !== state.saved;
      updateHeader();
      updatePreview();
    });
  }
  syncWorkspaceScroll();
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
  const body = '<pre class="diff-code">' + diff.patch.split("\n").map(renderDiffLine).join("") + '</pre>';
  return '<section class="diff-panel"><div class="diff-header"><strong>Git diff</strong><div class="file-actions"><span class="diff-meta">' + escapeHtml(meta) + '</span><button class="file-action" type="button" data-hide-diff>Hide</button></div></div>' + body + '</section>';
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

async function saveCurrent() {
  if (!state.selected) return;
  setStatus("saving...");
  const content = activeEditor().value;
  const result = await api("/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.selected, content }),
  });
  state.saved = content;
  state.savedHash = result.contentHash;
  state.dirty = false;
  await loadFiles();
  renderViewer();
  setStatus(result.backupPath ? "saved · backup created" : "saved");
  updateHeader();
}

async function refreshFromDisk() {
  const previousSelected = state.selected;
  try {
    const [filesData, docqa, settingsData] = await Promise.all([api("/api/files"), api("/api/docqa"), api("/api/settings")]);
    state.files = filesData.files;
    state.docqa = docqa;
    if (!state.settingsOpen) {
      state.settings = settingsData.settings;
      state.availableHubCards = settingsData.availableHubCards || [];
      state.hubFolders = settingsData.hubCards || [];
      state.rootHubSections = settingsData.hubSections || [];
      state.hubSections = hubSectionViewForCard(state.rootHubSections, state.activeHubCardId);
    }
    renderFiles();
    if (state.settingsOpen) {
      updateActionBanner();
      return;
    }
    if (!state.selected) renderDocQaDashboard();
    else updateHeader();

    if (!previousSelected || previousSelected !== state.selected) return;
    const [data, diff] = await Promise.all([
      api("/api/file?path=" + encodeURIComponent(previousSelected)),
      api("/api/file/diff?path=" + encodeURIComponent(previousSelected)),
    ]);
    if (data.contentHash === state.savedHash) return;
    if (state.dirty) {
      state.selectedDiff = diff;
      setStatus("changed elsewhere · reload blocked by your edits");
      return;
    }
    state.saved = data.content;
    state.savedHash = data.contentHash;
    state.selectedDiff = diff;
    el("editor").value = data.content;
    renderViewer();
    updateHeader();
    updatePreview();
    setStatus("reloaded from disk");
  } catch (error) {
    setStatus(error.message);
  }
}

function setStatus(text) { el("status").textContent = text; }
function activeEditor() { return el("docEditor") || el("editor"); }
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
el("sidebarToggle").addEventListener("click", () => document.querySelector(".app").classList.toggle("sidebar-collapsed"));
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
el("reload").addEventListener("click", () => selectFile(state.selected, { pushHistory: false, fromPlanet: state.filePanel }).catch((error) => setStatus(error.message)));
window.addEventListener("beforeunload", (event) => {
  if (!state.dirty) return;
  event.preventDefault();
  event.returnValue = "";
});
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
