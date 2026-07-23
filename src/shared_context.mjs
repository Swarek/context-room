import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

export const SHARED_REPOSITORY_CONFIG = ".context-room/shared-repository.json";
export const SHARED_REVIEW_CONFIG = ".context-room/shared-review.json";
export const SHARED_REPOSITORY_SCHEMA_VERSION = 1;
const MAX_SHARED_TEXT_BYTES = 750_000;
const SHARED_REPOSITORY_SCHEMA_URL = "https://unpkg.com/context-room@latest/schemas/shared-repository.schema.json";
const SHARED_PROJECTS_SCHEMA_URL = "https://unpkg.com/context-room@latest/schemas/shared-projects.schema.json";
const SHARED_REVIEW_TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".csv", ".tsv", ".txt", ".json", ".jsonc", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
  ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh", ".css", ".scss", ".sass",
  ".html", ".htm", ".xml", ".sql", ".graphql", ".gql", ".rs", ".go", ".java", ".kt", ".swift", ".rb", ".php",
  ".c", ".cc", ".cpp", ".h", ".hpp",
]);
const SHARED_REVIEW_TEXT_FILENAMES = new Set([
  "Dockerfile", "Containerfile", "Makefile", "Rakefile", "Gemfile", "Procfile", "README", "LICENSE", "CHANGELOG",
  ".dockerignore", ".editorconfig", ".eslintignore", ".gitattributes", ".gitignore", ".markdownlintignore", ".node-version",
  ".npmignore", ".nvmrc", ".prettierignore", ".python-version", ".ruby-version", ".tool-versions",
]);

const DEFAULT_REPOSITORY_CONFIG = {
  version: SHARED_REPOSITORY_SCHEMA_VERSION,
  name: "Shared Context",
  defaultBranch: "main",
  proposalPrefix: "proposal/",
  acceptancePrefix: "accepted/",
  globalSkillsPath: "skills/global",
  projectsPath: "projects",
  projectsFile: "projects.json",
};
const GITHUB_RULESET_PREFIX = "Context Room: protect ";
const MAX_PROPOSAL_TITLE_LENGTH = 160;
const MAX_PROPOSAL_DESCRIPTION_LENGTH = 6_000;

function sharedHome() {
  return process.env.CONTEXT_ROOM_SHARED_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_SHARED_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "shared");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
  return value;
}

function runGit(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding === null ? null : "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    env: { ...process.env, ...options.env },
  });
}

function tryGit(cwd, args) {
  try {
    return String(runGit(cwd, args)).trim();
  } catch {
    return "";
  }
}

function gitObjectExists(cwd, object) {
  return spawnSync("git", ["cat-file", "-e", String(object)], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  }).status === 0;
}

function splitNull(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""));
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function gitChangedPaths(cwd, range) {
  return splitNull(runGit(cwd, ["diff", "--name-only", "-z", range, "--"], { encoding: null }));
}

function gitTreeEntries(cwd, revision, prefixes = []) {
  const args = ["ls-tree", "-r", "-z", revision, "--", ...prefixes];
  return splitNull(runGit(cwd, args, { encoding: null })).map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error(`Unable to parse Git tree entry at ${revision}`);
    const [mode, type, object] = record.slice(0, separator).split(" ");
    return { mode, type, object, path: record.slice(separator + 1) };
  });
}

function assertSafeTreeEntries(cwd, revision, prefixes) {
  for (const entry of gitTreeEntries(cwd, revision, prefixes)) {
    if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob") {
      throw new Error(`Shared context rejects symlinks, gitlinks, and special files: ${entry.path}`);
    }
  }
}

function assertReviewableChangedPaths(cwd, baseRevision, headRevision, changedPaths) {
  for (const filePath of changedPaths) {
    const base = path.posix.basename(filePath);
    if (!SHARED_REVIEW_TEXT_EXTENSIONS.has(path.posix.extname(base)) && !SHARED_REVIEW_TEXT_FILENAMES.has(base)) {
      throw new Error(`Shared proposal file type is not reviewable in Context Room: ${filePath}`);
    }
  }
  for (const revision of [baseRevision, headRevision]) {
    const entries = new Map(gitTreeEntries(cwd, revision, changedPaths).map((entry) => [entry.path, entry]));
    for (const filePath of changedPaths) {
      const entry = entries.get(filePath);
      if (!entry) continue;
      if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob") {
        throw new Error(`Shared proposals reject symlinks, gitlinks, and special files: ${filePath}`);
      }
      const content = runGit(cwd, ["cat-file", "blob", entry.object], { encoding: null, maxBuffer: MAX_SHARED_TEXT_BYTES + 1 });
      if (content.length > MAX_SHARED_TEXT_BYTES) throw new Error(`Shared proposal file is too large to review: ${filePath}`);
      if (!isUtf8(content) || content.includes(0)) throw new Error(`Shared proposals only support reviewable UTF-8 text files: ${filePath}`);
    }
  }
}

function hashKey(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function safeId(value, label = "id") {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result)) {
    throw new Error(`${label} must use lowercase letters, numbers, and single hyphens`);
  }
  return result;
}

function safeRelativePath(value, label) {
  const clean = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const segments = clean.split("/");
  if (!clean || path.posix.isAbsolute(clean) || clean.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  if (segments.includes(".git")) throw new Error(`${label} must not enter .git`);
  if (path.posix.normalize(clean) !== clean) throw new Error(`${label} must be normalized`);
  return clean;
}

function safeBranchName(value, label = "branch") {
  const branch = String(value || "").trim();
  const invalid = !branch
    || branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
    || branch.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"));
  if (invalid) throw new Error(`Invalid ${label}: ${branch || "(empty)"}`);
  return branch;
}

function safeRepository(value) {
  const repository = String(value || "").trim();
  if (!repository || repository.startsWith("-") || /[\x00-\x1f\x7f]/.test(repository)) throw new Error("repository is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) {
    let parsed;
    try { parsed = new URL(repository); } catch { throw new Error("repository must be a valid Git URL or local path"); }
    if (parsed.username || parsed.password) throw new Error("repository URLs must not contain embedded credentials");
  }
  return repository;
}

function safeRevision(value, label = "revision") {
  const revision = String(value || "").trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error(`Invalid ${label}`);
  return revision;
}

function safeSessionId(value, { optional = true } = {}) {
  const sessionId = String(value || "").trim();
  if (!sessionId && optional) return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)) {
    throw new Error("session must use letters, numbers, dots, underscores, or hyphens");
  }
  return sessionId;
}

function proposalTitle(value, fallback = "Shared context proposal") {
  const title = String(value || fallback).trim();
  if (!title) throw new Error("proposal title is required");
  if (/\r|\n/.test(title)) throw new Error("proposal title must stay on one line");
  if (title.length > MAX_PROPOSAL_TITLE_LENGTH) throw new Error(`proposal title must be ${MAX_PROPOSAL_TITLE_LENGTH} characters or fewer`);
  return title;
}

function proposalDescription(value, { optional = true } = {}) {
  const description = String(value || "").replaceAll("\r\n", "\n").trim();
  if (!description && !optional) throw new Error("proposal description is required");
  if (description.length > MAX_PROPOSAL_DESCRIPTION_LENGTH) {
    throw new Error(`proposal description must be ${MAX_PROPOSAL_DESCRIPTION_LENGTH} characters or fewer`);
  }
  return description;
}

function encodeProposalDescription(value) {
  const description = proposalDescription(value);
  return description ? Buffer.from(description, "utf8").toString("base64url") : "";
}

function decodeProposalDescription(value) {
  const encoded = String(value || "").trim();
  if (!encoded) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return "";
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) return "";
    return proposalDescription(decoded.toString("utf8"));
  } catch {
    return "";
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

function normalizedRepositoryConfig(raw = {}) {
  const version = Number(raw.version || SHARED_REPOSITORY_SCHEMA_VERSION);
  if (version !== SHARED_REPOSITORY_SCHEMA_VERSION) throw new Error(`Unsupported shared repository version: ${version}`);
  const defaultBranch = safeBranchName(raw.defaultBranch || "main", "shared default branch");
  const proposalPrefix = String(raw.proposalPrefix || "proposal/").trim();
  if (!proposalPrefix.endsWith("/")) throw new Error("Proposal prefix must end with /");
  safeBranchName(proposalPrefix + "example", "proposal prefix");
  const acceptancePrefix = String(raw.acceptancePrefix || "accepted/").trim();
  if (!acceptancePrefix.endsWith("/")) throw new Error("Acceptance prefix must end with /");
  safeBranchName(acceptancePrefix + "example", "acceptance prefix");
  if (proposalPrefix === acceptancePrefix) throw new Error("proposalPrefix and acceptancePrefix must be different");
  const config = {
    version,
    name: String(raw.name || "Shared Context").trim() || "Shared Context",
    defaultBranch,
    proposalPrefix,
    acceptancePrefix,
    globalSkillsPath: safeRelativePath(raw.globalSkillsPath || "skills/global", "globalSkillsPath"),
    projectsPath: safeRelativePath(raw.projectsPath || "projects", "projectsPath"),
    projectsFile: safeRelativePath(raw.projectsFile || "projects.json", "projectsFile"),
  };
  if (pathsOverlap(config.globalSkillsPath, config.projectsPath)) throw new Error("globalSkillsPath and projectsPath must not overlap");
  if ([config.globalSkillsPath, config.projectsPath, config.projectsFile].some((value) => value === ".context-room" || value.startsWith(".context-room/"))) {
    throw new Error("Shared content paths must stay outside .context-room runtime state");
  }
  if (pathsOverlap(config.projectsFile, config.globalSkillsPath) || pathsOverlap(config.projectsFile, config.projectsPath)) {
    throw new Error("projectsFile must stay outside the shared content roots");
  }
  return config;
}

function githubRepositoryCoordinates(repository) {
  const value = safeRepository(repository).replace(/\.git$/i, "");
  let match = value.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (!match) match = value.match(/^ssh:\/\/(?:git@)?github\.com\/([^/]+)\/(.+)$/i);
  if (!match) match = value.match(/^https?:\/\/github\.com\/([^/]+)\/(.+)$/i);
  if (!match) throw new Error("GitHub security setup requires a github.com repository remote");
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo || repo.includes("/")) throw new Error("Unable to resolve GitHub owner/repository from the shared remote");
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function githubPullRequestUrl(repository, baseBranch, headBranch) {
  try {
    const { owner, repo } = githubRepositoryCoordinates(repository);
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}?expand=1`;
  } catch {
    return "";
  }
}

function safeSourceSubpath(value) {
  const clean = String(value || ".").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return clean === "." ? "." : safeRelativePath(clean, "project source subpath");
}

function normalizedProjectsCatalog(raw = {}) {
  if (Number(raw.version || 1) !== 1) throw new Error(`Unsupported shared projects version: ${raw.version}`);
  if (!Array.isArray(raw.projects)) throw new Error("Shared projects catalog must contain a projects array");
  const seen = new Set();
  const projects = raw.projects.map((item) => {
    const id = safeId(item?.id, "project id");
    if (seen.has(id)) throw new Error(`Duplicate shared project id: ${id}`);
    seen.add(id);
    const source = item?.source && typeof item.source === "object" ? {
      remotes: [...new Set((item.source.remotes || []).map((remote) => normalizeRemote(safeRepository(remote))).filter(Boolean))],
      subpath: safeSourceSubpath(item.source.subpath || "."),
    } : null;
    if (source && !source.remotes.length) throw new Error(`Shared project ${id} source.remotes must not be empty`);
    return { id, title: String(item?.title || id).trim() || id, source };
  });
  return { version: 1, projects };
}

function registryPath() {
  return path.join(sharedHome(), "registry.json");
}

function normalizeRemote(value) {
  let remote = String(value || "").trim().replace(/\.git$/, "");
  const scp = remote.match(/^[^@]+@([^:]+):(.+)$/);
  if (scp) remote = `${scp[1]}/${scp[2]}`;
  else remote = remote.replace(/^[a-z]+:\/\//i, "").replace(/^([^/]+@)?/, "");
  return remote.replace(/^github\.com\//i, "github.com/").toLowerCase();
}

function sourceIdentity(root) {
  const resolved = stableRoot(root);
  const topLevel = tryGit(resolved, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return null;
  const remotes = tryGit(topLevel, ["remote"]).split("\n").filter(Boolean)
    .flatMap((name) => tryGit(topLevel, ["remote", "get-url", "--all", name]).split("\n"))
    .map(normalizeRemote).filter(Boolean);
  if (!remotes.length) return null;
  const stableTopLevel = stableRoot(topLevel);
  const sourceSubpath = path.relative(stableTopLevel, resolved).replaceAll(path.sep, "/") || ".";
  return { topLevel: stableTopLevel, remotes: [...new Set(remotes)], sourceSubpath };
}

function stableRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function bindingMatchesSource(binding, source) {
  const bindingRemotes = [...new Set([...(binding.sourceRemotes || []), binding.sourceRemote].filter(Boolean).map(normalizeRemote))];
  if (!source || !source.remotes.some((remote) => bindingRemotes.includes(remote))) return false;
  const bindingPath = String(binding.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const sourcePath = String(source.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return bindingPath === "." || sourcePath === bindingPath || sourcePath.startsWith(bindingPath + "/");
}

function registerSourceBinding(root, connection) {
  const source = sourceIdentity(root);
  const registry = readJson(registryPath(), { version: 1, bindings: [] });
  const binding = source ? {
    repository: connection.repository,
    projectId: connection.projectId,
    sourceRemotes: source.remotes,
    sourceSubpath: source.sourceSubpath,
  } : {
    repository: connection.repository,
    projectId: connection.projectId,
    sourceRoot: stableRoot(root),
  };
  registry.bindings = [...(registry.bindings || []).filter((item) => !(
    source
      ? String(item.sourceSubpath || ".") === binding.sourceSubpath
        && [...new Set([...(item.sourceRemotes || []), item.sourceRemote].filter(Boolean).map(normalizeRemote))].some((remote) => source.remotes.includes(remote))
      : item.sourceRoot && stableRoot(item.sourceRoot) === binding.sourceRoot
  )), binding];
  writeJson(registryPath(), registry);
  return binding;
}

function resolveRegisteredConnection(root) {
  const source = sourceIdentity(root);
  const registry = readJson(registryPath(), { bindings: [] });
  if (!source) {
    const resolved = stableRoot(root);
    const matches = (registry.bindings || []).filter((binding) => {
      if (!binding.sourceRoot) return false;
      const bindingRoot = stableRoot(binding.sourceRoot);
      return resolved === bindingRoot || resolved.startsWith(bindingRoot + path.sep);
    }).sort((left, right) => String(right.sourceRoot || "").length - String(left.sourceRoot || "").length);
    const binding = matches[0];
    return binding ? {
      version: 1,
      repository: safeRepository(binding.repository),
      projectId: safeId(binding.projectId, "projectId"),
      projectRoot: stableRoot(binding.sourceRoot),
    } : null;
  }
  const matches = (registry.bindings || []).filter((binding) => bindingMatchesSource(binding, source));
  matches.sort((left, right) => String(right.sourceSubpath || ".").length - String(left.sourceSubpath || ".").length);
  const binding = matches[0];
  if (!binding) return null;
  const sourceSubpath = String(binding.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const projectRoot = sourceSubpath === "." ? source.topLevel : path.join(source.topLevel, ...sourceSubpath.split("/"));
  return {
    version: 1,
    repository: safeRepository(binding.repository),
    projectId: safeId(binding.projectId, "projectId"),
    projectRoot: stableRoot(projectRoot),
  };
}

function repositoryCacheRoot(repository) {
  return path.join(sharedHome(), hashKey(repository));
}

function repositoryCheckout(repository) {
  return path.join(repositoryCacheRoot(repository), "repository");
}

function sharedStatePath(repository) {
  return path.join(repositoryCacheRoot(repository), "state.json");
}

function syncSharedRepositoryState(repository, { allowOffline = true } = {}) {
  const safeRemote = safeRepository(repository);
  const checkout = ensureRepositoryClone(safeRemote);
  let fetchError = "";
  try {
    runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fetchError = String(error.stderr || error.message || error).trim();
    if (!allowOffline) throw new Error(`Unable to refresh shared context: ${fetchError}`);
  }
  const state = readJson(sharedStatePath(safeRemote), {});
  let descriptor;
  try {
    descriptor = readRemoteSharedDescriptor(checkout, state.defaultBranch || "");
  } catch (error) {
    if (!fetchError || !state.revision || !state.repositoryConfig || !state.catalog) throw error;
    descriptor = {
      revision: safeRevision(state.revision, "cached shared revision"),
      config: normalizedRepositoryConfig(state.repositoryConfig),
      catalog: normalizedProjectsCatalog(state.catalog),
    };
  }
  assertSafeTreeEntries(checkout, descriptor.revision, []);
  const cacheRoot = repositoryCacheRoot(safeRemote);
  const snapshot = path.join(cacheRoot, "snapshots", descriptor.revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, descriptor.revision, snapshot);
  const repositoryConfig = readSharedRepositoryConfig(snapshot);
  const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
  const nextState = {
    version: 1,
    repository: safeRemote,
    defaultBranch: repositoryConfig.defaultBranch,
    revision: descriptor.revision,
    syncedAt: new Date().toISOString(),
    online: !fetchError,
    fetchError,
    repositoryConfig,
    catalog,
  };
  writeJson(sharedStatePath(safeRemote), nextState);
  return {
    connection: { repository: safeRemote, projectId: "global", projectRoot: "" },
    repositoryConfig,
    catalog,
    revision: descriptor.revision,
    online: !fetchError,
    fetchError,
    cacheRoot,
    snapshot,
  };
}

function ensureRepositoryClone(repository) {
  const checkout = repositoryCheckout(repository);
  if (fs.existsSync(path.join(checkout, ".git"))) {
    configureExistingSharedAgentGit(repository, checkout);
    return checkout;
  }
  if (fs.existsSync(checkout)) throw new Error(`Shared cache path already exists and is not a Git clone: ${checkout}`);
  fs.mkdirSync(path.dirname(checkout), { recursive: true });
  runGit(path.dirname(checkout), ["clone", "--origin", "origin", "--no-checkout", repository, checkout], { stdio: ["ignore", "ignore", "pipe"] });
  configureExistingSharedAgentGit(repository, checkout);
  return checkout;
}

function remoteRevision(checkout, branch) {
  const safeBranch = safeBranchName(branch, "remote branch");
  const revision = tryGit(checkout, ["rev-parse", `refs/remotes/origin/${safeBranch}^{commit}`]);
  if (!revision) throw new Error(`The shared repository has no origin/${branch} commit`);
  return safeRevision(revision);
}

function remoteHeadBranch(checkout) {
  const value = tryGit(checkout, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!value.startsWith("origin/")) return "";
  try { return safeBranchName(value.slice("origin/".length), "remote default branch"); } catch { return ""; }
}

function readRemoteSharedDescriptor(checkout, fallbackBranch = "") {
  const bootstrapBranch = fallbackBranch || remoteHeadBranch(checkout) || "main";
  let revision = remoteRevision(checkout, bootstrapBranch);
  let config = normalizedRepositoryConfig(JSON.parse(runGit(checkout, ["show", `${revision}:${SHARED_REPOSITORY_CONFIG}`])));
  if (config.defaultBranch !== bootstrapBranch) {
    const selectedBranch = config.defaultBranch;
    revision = remoteRevision(checkout, selectedBranch);
    config = normalizedRepositoryConfig(JSON.parse(runGit(checkout, ["show", `${revision}:${SHARED_REPOSITORY_CONFIG}`])));
    if (config.defaultBranch !== selectedBranch) throw new Error("Shared defaultBranch must be stable across the selected branch");
  }
  const catalog = normalizedProjectsCatalog(JSON.parse(runGit(checkout, ["show", `${revision}:${config.projectsFile}`])));
  return { revision, config, catalog };
}

export function detectSharedProject(root, { repository, projectId = "" } = {}) {
  const resolvedRoot = stableRoot(root);
  const safeRemote = safeRepository(repository);
  const checkout = ensureRepositoryClone(safeRemote);
  runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  const descriptor = readRemoteSharedDescriptor(checkout);
  const source = sourceIdentity(resolvedRoot);
  const explicitProjectId = projectId ? safeId(projectId, "projectId") : "";
  if (explicitProjectId) {
    const project = descriptor.catalog.projects.find((item) => item.id === explicitProjectId);
    if (!project) throw new Error(`Shared project is not registered in ${descriptor.config.projectsFile}: ${explicitProjectId}`);
    const sourceMatches = source && project.source?.remotes.some((remote) => source.remotes.includes(remote));
    const projectRoot = sourceMatches
      ? project.source.subpath === "."
        ? source.topLevel
        : path.join(source.topLevel, ...project.source.subpath.split("/"))
      : resolvedRoot;
    return { projectId: project.id, projectRoot: stableRoot(projectRoot), repository: safeRemote, revision: descriptor.revision };
  }
  if (!source) throw new Error("--project is required because this directory has no Git remote identity");
  const matches = descriptor.catalog.projects.filter((project) => {
    if (!project.source || !project.source.remotes.some((remote) => source.remotes.includes(remote))) return false;
    return project.source.subpath === "."
      || source.sourceSubpath === project.source.subpath
      || source.sourceSubpath.startsWith(project.source.subpath + "/");
  }).sort((left, right) => right.source.subpath.length - left.source.subpath.length);
  const project = matches[0];
  if (!project) throw new Error("No shared project matches this Git remote and repository subpath; pass --project explicitly");
  const projectRoot = project.source.subpath === "."
    ? source.topLevel
    : path.join(source.topLevel, ...project.source.subpath.split("/"));
  return { projectId: project.id, projectRoot: stableRoot(projectRoot), repository: safeRemote, revision: descriptor.revision };
}

function materializeSnapshot(checkout, revision, destination) {
  if (fs.existsSync(path.join(destination, SHARED_REPOSITORY_CONFIG))) return destination;
  const cacheRoot = path.dirname(path.dirname(destination));
  const temporary = path.join(cacheRoot, `snapshot-${revision.slice(0, 12)}-${process.pid}.tmp`);
  fs.mkdirSync(temporary, { recursive: true });
  try {
    const archive = runGit(checkout, ["archive", "--format=tar", revision], { encoding: null });
    const extracted = spawnSync("tar", ["-xf", "-", "-C", temporary], { input: archive, encoding: "utf8" });
    if (extracted.status !== 0) throw new Error(extracted.stderr || "Unable to extract shared context snapshot");
    fs.renameSync(temporary, destination);
    makeTreeReadOnly(destination);
  } finally {
    if (fs.existsSync(temporary)) {
      makeTreeWritable(temporary);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return destination;
}

function makeTreeReadOnly(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeTreeReadOnly(target);
      fs.chmodSync(target, 0o555);
    } else if (entry.isFile()) {
      const executable = Boolean(fs.statSync(target).mode & 0o111);
      fs.chmodSync(target, executable ? 0o555 : 0o444);
    }
  }
  fs.chmodSync(root, 0o555);
}

function makeTreeWritable(root) {
  try { fs.chmodSync(root, 0o755); } catch {}
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeTreeWritable(target);
    else if (entry.isFile()) try { fs.chmodSync(target, 0o644); } catch {}
  }
}

function replaceSymlink(linkPath, targetPath, { managedRoot = "" } = {}) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {}
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace existing non-link path: ${linkPath}`);
  const existingTarget = existing?.isSymbolicLink() ? path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) : "";
  if (existingTarget === path.resolve(targetPath)) return false;
  if (existingTarget && managedRoot && existingTarget !== path.resolve(managedRoot) && !existingTarget.startsWith(path.resolve(managedRoot) + path.sep)) {
    throw new Error(`Refusing to replace unmanaged skill link: ${linkPath}`);
  }
  const temporary = `${linkPath}.context-room-${process.pid}.tmp`;
  try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(targetPath, temporary, "dir");
  fs.renameSync(temporary, linkPath);
  return true;
}

function skillDirectories(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function homeVirtualPath(absolutePath, trailingSlash = false) {
  const home = path.resolve(process.env.HOME || os.homedir());
  const absolute = path.resolve(absolutePath);
  if (absolute !== home && !absolute.startsWith(home + path.sep)) throw new Error(`Shared cache must stay inside the user home: ${absolute}`);
  const value = "~/" + path.relative(home, absolute).replaceAll(path.sep, "/");
  return trailingSlash ? value.replace(/\/$/, "") + "/" : value;
}

function appendUnique(values, next) {
  return [...new Set([...(values || []), ...next].filter(Boolean))];
}

function managedSymlinkTarget(linkPath, managedRoot) {
  let stats;
  try { stats = fs.lstatSync(linkPath); } catch { return { exists: false, symbolic: false, target: "" }; }
  if (!stats.isSymbolicLink()) return { exists: true, symbolic: false, target: "" };
  const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  const root = path.resolve(managedRoot);
  return { exists: true, symbolic: true, target, managed: target === root || target.startsWith(root + path.sep) };
}

function skillLinkRegistryPath(repository, projectRoot) {
  return path.join(repositoryCacheRoot(repository), "skill-links", `${hashKey(stableRoot(projectRoot))}.json`);
}

function configureProjectRoom(root, connection, repositoryConfig, currentRoot) {
  const configPath = path.join(root, ".context-room", "config.json");
  if (!fs.existsSync(configPath)) return { updated: false, reason: "Context Room is not initialized yet" };
  const config = readJson(configPath, {});
  const previousRepository = config.sharedContext?.repository
    ? safeRepository(config.sharedContext.repository)
    : "";
  if (previousRepository) {
    const previousPrefix = homeVirtualPath(path.join(repositoryCacheRoot(previousRepository), "current"), true);
    const keepNonManaged = (value) => !String(value || "").startsWith(previousPrefix);
    config.allowedPaths = (config.allowedPaths || []).filter(keepNonManaged);
    config.readOnlyPaths = (config.readOnlyPaths || []).filter(keepNonManaged);
  }
  const projectRoot = path.join(currentRoot, repositoryConfig.projectsPath, connection.projectId);
  const docs = homeVirtualPath(path.join(projectRoot, "docs"), true);
  const projectSkills = homeVirtualPath(path.join(projectRoot, "skills"), true);
  const globalSkills = homeVirtualPath(path.join(currentRoot, repositoryConfig.globalSkillsPath), true);
  config.allowedPaths = appendUnique(config.allowedPaths, [docs, projectSkills, globalSkills]);
  config.readOnlyPaths = appendUnique(config.readOnlyPaths, [docs, projectSkills, globalSkills]);
  const section = {
    id: "shared-context",
    title: "Shared context",
    description: `${repositoryConfig.name} accepted main snapshot. Changes must go through proposal branches.`,
    cards: [
      { id: "shared-docs", title: "Shared project docs", path: docs, description: `Accepted documentation for ${connection.projectId}.` },
      { id: "shared-project-skills", title: "Shared project skills", path: projectSkills, description: `Accepted skills for ${connection.projectId}.` },
      { id: "shared-global-skills", title: "Shared global skills", path: globalSkills, description: "Accepted skills shared across projects." },
    ],
  };
  config.hubSections = [...(config.hubSections || []).filter((item) => item?.id !== section.id), section];
  config.sharedContext = { enabled: true, projectId: connection.projectId, repository: connection.repository };
  writeJson(configPath, config);
  return { updated: true, configPath, paths: { docs, projectSkills, globalSkills } };
}

function syncSkillLinks(root, connection, repositoryConfig, currentRoot) {
  const projectSkillSource = path.join(currentRoot, repositoryConfig.projectsPath, connection.projectId, "skills");
  const globalSkillSource = path.join(currentRoot, repositoryConfig.globalSkillsPath);
  const projectSkills = skillDirectories(projectSkillSource);
  const globalSkills = skillDirectories(globalSkillSource);
  const collisions = projectSkills.filter((name) => globalSkills.includes(name));
  if (collisions.length) throw new Error(`Project skills must not shadow global skills: ${collisions.join(", ")}`);
  const links = [];
  const globalDestination = path.join(process.env.HOME || os.homedir(), ".codex", "skills");
  const projectDestination = path.join(root, ".codex", "skills");
  for (const name of globalSkills) {
    const link = path.join(globalDestination, name);
    links.push({ scope: "global", name, link, target: path.join(globalSkillSource, name) });
  }
  for (const name of projectSkills) {
    const link = path.join(projectDestination, name);
    links.push({ scope: "project", name, link, target: path.join(projectSkillSource, name) });
  }
  const managedRoot = repositoryCacheRoot(connection.repository);
  const registryFile = skillLinkRegistryPath(connection.repository, root);
  const previous = readJson(registryFile, { version: 1, links: [] });
  const desiredPaths = new Set(links.map((item) => path.resolve(item.link)));
  const safeDestinations = new Set([path.resolve(globalDestination), path.resolve(projectDestination)]);
  const stale = (previous.links || []).filter((item) => {
    const link = path.resolve(String(item.link || ""));
    return safeDestinations.has(path.dirname(link)) && !desiredPaths.has(link);
  });
  const before = new Map();
  for (const item of [...links, ...stale]) {
    const link = path.resolve(item.link);
    if (!safeDestinations.has(path.dirname(link))) throw new Error(`Unsafe managed skill link path: ${link}`);
    const state = managedSymlinkTarget(link, managedRoot);
    before.set(link, state);
    if (links.includes(item) && state.exists && (!state.symbolic || !state.managed)) {
      throw new Error(`Refusing to replace unmanaged skill path: ${link}`);
    }
  }
  try {
    for (const item of links) replaceSymlink(item.link, item.target, { managedRoot });
    for (const item of stale) {
      const state = managedSymlinkTarget(item.link, managedRoot);
      if (state.symbolic && state.managed) fs.unlinkSync(item.link);
    }
    writeJson(registryFile, { version: 1, repository: connection.repository, projectRoot: stableRoot(root), links });
  } catch (error) {
    for (const [link, state] of [...before.entries()].reverse()) {
      try {
        const current = managedSymlinkTarget(link, managedRoot);
        if (!state.exists && current.symbolic && current.managed) fs.unlinkSync(link);
        else if (state.symbolic && state.managed) replaceSymlink(link, state.target, { managedRoot });
      } catch {}
    }
    throw error;
  }
  return links;
}

function detachInstalledSkillLinks(root, installed) {
  if (!installed?.repository) return [];
  const repository = safeRepository(installed.repository);
  const managedRoot = repositoryCacheRoot(repository);
  const registry = readJson(skillLinkRegistryPath(repository, root), { links: [] });
  const safeDestinations = new Set([
    path.resolve(process.env.HOME || os.homedir(), ".codex", "skills"),
    path.resolve(root, ".codex", "skills"),
  ]);
  const removed = [];
  try {
    for (const item of registry.links || []) {
      const link = path.resolve(String(item.link || ""));
      if (!safeDestinations.has(path.dirname(link))) continue;
      const state = managedSymlinkTarget(link, managedRoot);
      if (!state.symbolic || !state.managed) continue;
      fs.unlinkSync(link);
      removed.push({ link, target: state.target, managedRoot });
    }
  } catch (error) {
    restoreDetachedSkillLinks(removed);
    throw error;
  }
  return removed;
}

function restoreDetachedSkillLinks(links) {
  for (const item of links) {
    try { replaceSymlink(item.link, item.target, { managedRoot: item.managedRoot }); } catch {}
  }
}

export function initializeSharedRepository(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const configPath = path.join(resolvedRoot, SHARED_REPOSITORY_CONFIG);
  if (fs.existsSync(configPath)) return { configPath, config: readSharedRepositoryConfig(resolvedRoot), created: false };
  const config = normalizedRepositoryConfig({ ...DEFAULT_REPOSITORY_CONFIG, ...options });
  writeJson(configPath, { $schema: SHARED_REPOSITORY_SCHEMA_URL, ...config });
  fs.mkdirSync(path.join(resolvedRoot, config.globalSkillsPath), { recursive: true });
  const globalKeep = path.join(resolvedRoot, config.globalSkillsPath, ".gitkeep");
  if (!fs.existsSync(globalKeep)) fs.writeFileSync(globalKeep, "", "utf8");
  fs.mkdirSync(path.join(resolvedRoot, config.projectsPath), { recursive: true });
  if (!fs.existsSync(path.join(resolvedRoot, config.projectsFile))) {
    writeJson(path.join(resolvedRoot, config.projectsFile), { $schema: SHARED_PROJECTS_SCHEMA_URL, version: 1, projects: [] });
  }
  return { configPath, config, created: true };
}

export function readSharedRepositoryConfig(root) {
  const configPath = path.join(path.resolve(root), SHARED_REPOSITORY_CONFIG);
  const raw = readJson(configPath);
  if (!raw) throw new Error(`Missing ${SHARED_REPOSITORY_CONFIG}`);
  return normalizedRepositoryConfig(raw);
}

export function readSharedProjectConnection(root) {
  return resolveRegisteredConnection(root);
}

export function connectSharedContext(root, { repository, projectId, sync = true } = {}) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) throw new Error(`Project root does not exist: ${resolvedRoot}`);
  const safeRemote = safeRepository(repository);
  const detected = detectSharedProject(resolvedRoot, { repository: safeRemote, projectId });
  const bindingRoot = detected.projectRoot;
  const connection = { version: 1, repository: safeRemote, projectId: detected.projectId, projectRoot: bindingRoot };
  const previousRegistry = readJson(registryPath(), { version: 1, bindings: [] });
  registerSourceBinding(bindingRoot, connection);
  if (!sync) return { connection, connected: true };
  try {
    return syncSharedContext(bindingRoot);
  } catch (error) {
    writeJson(registryPath(), previousRegistry);
    throw error;
  }
}

export function syncSharedContext(root, { allowOffline = true } = {}) {
  const resolvedRoot = path.resolve(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (!connection) throw new Error("This project has no approved shared-context binding; run context-room shared setup first");
  const localProjectRoot = connection.projectRoot || resolvedRoot;
  const checkout = ensureRepositoryClone(connection.repository);
  let fetchError = "";
  try {
    runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    fetchError = String(error.stderr || error.message || error).trim();
    if (!allowOffline) throw new Error(`Unable to refresh shared context: ${fetchError}`);
  }
  const state = readJson(sharedStatePath(connection.repository), {});
  let repositoryConfig;
  let revision;
  let catalog;
  try {
    const descriptor = readRemoteSharedDescriptor(checkout, state.defaultBranch || "");
    ({ revision, config: repositoryConfig, catalog } = descriptor);
  } catch (error) {
    if (!fetchError || !state.revision || !state.repositoryConfig) throw error;
    revision = state.revision;
    repositoryConfig = normalizedRepositoryConfig(state.repositoryConfig);
    catalog = state.catalog
      ? normalizedProjectsCatalog(state.catalog)
      : normalizedProjectsCatalog(JSON.parse(runGit(checkout, ["show", `${revision}:${repositoryConfig.projectsFile}`])));
  }
  assertSafeTreeEntries(checkout, revision, []);
  const cacheRoot = repositoryCacheRoot(connection.repository);
  const snapshot = path.join(cacheRoot, "snapshots", revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, revision, snapshot);
  repositoryConfig = readSharedRepositoryConfig(snapshot);
  catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
  if (!catalog.projects.some((project) => project.id === connection.projectId)) {
    throw new Error(`Shared project is not registered in ${repositoryConfig.projectsFile}: ${connection.projectId}`);
  }
  const sharedProjectRoot = path.join(snapshot, repositoryConfig.projectsPath, connection.projectId);
  if (!fs.existsSync(sharedProjectRoot) || !fs.statSync(sharedProjectRoot).isDirectory()) {
    throw new Error(`Shared project does not exist in origin/${repositoryConfig.defaultBranch}: ${connection.projectId}`);
  }
  const current = path.join(cacheRoot, "current");
  const previousCurrent = (() => {
    try { return fs.lstatSync(current).isSymbolicLink() ? path.resolve(path.dirname(current), fs.readlinkSync(current)) : ""; } catch { return ""; }
  })();
  const configPath = path.join(localProjectRoot, ".context-room", "config.json");
  const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  let installedSharedContext = null;
  if (previousConfig !== null) {
    try { installedSharedContext = JSON.parse(previousConfig).sharedContext || null; } catch {}
  }
  const switchingSharedContext = installedSharedContext?.repository && (
    safeRepository(installedSharedContext.repository) !== connection.repository
    || installedSharedContext.projectId !== connection.projectId
  );
  let detachedSkillLinks = [];
  let links;
  let room;
  try {
    if (switchingSharedContext) detachedSkillLinks = detachInstalledSkillLinks(localProjectRoot, installedSharedContext);
    replaceSymlink(current, snapshot, { managedRoot: cacheRoot });
    room = configureProjectRoom(localProjectRoot, connection, repositoryConfig, current);
    links = syncSkillLinks(localProjectRoot, connection, repositoryConfig, snapshot);
  } catch (error) {
    restoreDetachedSkillLinks(detachedSkillLinks);
    if (previousCurrent) {
      try { replaceSymlink(current, previousCurrent, { managedRoot: cacheRoot }); } catch {}
    } else {
      const currentState = managedSymlinkTarget(current, cacheRoot);
      if (currentState.symbolic && currentState.managed) {
        try { fs.unlinkSync(current); } catch {}
      }
    }
    if (previousConfig !== null) {
      try { fs.writeFileSync(configPath, previousConfig, "utf8"); } catch {}
    }
    throw error;
  }
  const nextState = {
    version: 1,
    repository: connection.repository,
    defaultBranch: repositoryConfig.defaultBranch,
    revision,
    syncedAt: new Date().toISOString(),
    online: !fetchError,
    fetchError,
    repositoryConfig,
    catalog,
  };
  writeJson(sharedStatePath(connection.repository), nextState);
  return { connection: { ...connection, projectRoot: localProjectRoot }, repositoryConfig, catalog, revision, online: !fetchError, fetchError, cacheRoot, current, links, room };
}

export function sharedContextStatus(root) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return { connected: false };
  const state = readJson(sharedStatePath(connection.repository), {});
  const security = readJson(path.join(repositoryCacheRoot(connection.repository), "github-security.json"), null);
  return {
    connected: true,
    connection,
    ...state,
    cacheRoot: repositoryCacheRoot(connection.repository),
    permissionBoundary: {
      verified: Boolean(security?.verified),
      checkedAt: security?.checkedAt || null,
      enforcement: "GitHub ruleset requires a pull request and Context Room never pushes accepted changes to main",
      note: security?.verified
        ? `Last remote check passed for ${security.repository}:${security.defaultBranch}. Run shared security-check to verify again.`
        : "Run context-room shared secure-github once, then shared security-check to verify the remote rule.",
    },
  };
}

function sharedSecurityTarget(root) {
  const resolvedRoot = path.resolve(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (connection) {
    const state = readJson(sharedStatePath(connection.repository), {});
    let repositoryConfig = state.repositoryConfig ? normalizedRepositoryConfig(state.repositoryConfig) : null;
    if (!repositoryConfig) {
      const checkout = ensureRepositoryClone(connection.repository);
      runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
      repositoryConfig = readRemoteSharedDescriptor(checkout).config;
    }
    return { repository: connection.repository, repositoryConfig, gitRoots: [repositoryCheckout(connection.repository)] };
  }
  if (fs.existsSync(path.join(resolvedRoot, SHARED_REPOSITORY_CONFIG))) {
    const repository = tryGit(resolvedRoot, ["remote", "get-url", "origin"]);
    if (!repository) throw new Error("The shared repository has no origin remote");
    const cachedCheckout = repositoryCheckout(repository);
    const gitRoots = [resolvedRoot];
    if (fs.existsSync(path.join(cachedCheckout, ".git"))) gitRoots.push(cachedCheckout);
    return { repository, repositoryConfig: readSharedRepositoryConfig(resolvedRoot), gitRoots };
  }
  throw new Error("Run this command from a shared repository or a project connected to shared context");
}

function sharedAgentCredential(repository) {
  const directory = path.join(repositoryCacheRoot(repository), "credentials");
  return {
    directory,
    privateKey: path.join(directory, "agent_ed25519"),
    publicKey: path.join(directory, "agent_ed25519.pub"),
    title: `Context Room agent ${hashKey(repository, 8)}`,
  };
}

function ensureSharedAgentCredential(repository) {
  const credential = sharedAgentCredential(repository);
  fs.mkdirSync(credential.directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(credential.directory, 0o700);
  if (!fs.existsSync(credential.privateKey) || !fs.existsSync(credential.publicKey)) {
    if (fs.existsSync(credential.privateKey) || fs.existsSync(credential.publicKey)) {
      throw new Error(`Incomplete shared agent SSH credential at ${credential.directory}`);
    }
    const result = spawnSync("ssh-keygen", [
      "-q", "-t", "ed25519", "-N", "", "-C", credential.title, "-f", credential.privateKey,
    ], { encoding: "utf8" });
    if (result.error?.code === "ENOENT") throw new Error("ssh-keygen is required to create the restricted agent credential");
    if (result.status !== 0) throw new Error(`Unable to create the restricted agent credential: ${String(result.stderr || result.stdout).trim()}`);
  }
  fs.chmodSync(credential.privateKey, 0o600);
  fs.chmodSync(credential.publicKey, 0o644);
  return { ...credential, key: fs.readFileSync(credential.publicKey, "utf8").trim() };
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function configureSharedAgentGit(repository, github, gitRoots) {
  const credential = sharedAgentCredential(repository);
  if (!fs.existsSync(credential.privateKey)) throw new Error("Restricted shared agent credential is missing");
  const sshCommand = `ssh -i ${shellSingleQuote(credential.privateKey)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  const remote = `git@github.com:${github.fullName}.git`;
  for (const gitRoot of gitRoots) {
    if (!fs.existsSync(path.join(gitRoot, ".git"))) throw new Error(`Shared Git checkout is missing: ${gitRoot}`);
    runGit(gitRoot, ["remote", "set-url", "origin", remote]);
    runGit(gitRoot, ["config", "core.sshCommand", sshCommand]);
  }
  return { privateKey: credential.privateKey, remote, gitRoots };
}

function configureExistingSharedAgentGit(repository, gitRoot) {
  const credential = sharedAgentCredential(repository);
  if (!fs.existsSync(credential.privateKey)) return;
  let github;
  try { github = githubRepositoryCoordinates(repository); } catch { return; }
  configureSharedAgentGit(repository, github, [gitRoot]);
}

function normalizedSshPublicKey(value) {
  return String(value || "").trim().split(/\s+/).slice(0, 2).join(" ");
}

function inspectSharedAgentGit(repository, github, gitRoots, deployKeys) {
  const credential = sharedAgentCredential(repository);
  const publicKey = fs.existsSync(credential.publicKey) ? fs.readFileSync(credential.publicKey, "utf8").trim() : "";
  const deployKey = (deployKeys || []).find((item) => (
    item.title === credential.title
    && (!publicKey || normalizedSshPublicKey(item.key) === normalizedSshPublicKey(publicKey))
  ));
  const expectedRemote = `git@github.com:${github.fullName}.git`;
  const localConfigured = Boolean(publicKey && fs.existsSync(credential.privateKey) && gitRoots.every((gitRoot) => (
    tryGit(gitRoot, ["remote", "get-url", "origin"]) === expectedRemote
    && tryGit(gitRoot, ["config", "--get", "core.sshCommand"]).includes(credential.privateKey)
  )));
  return {
    deployKey,
    checks: {
      writableAgentDeployKey: Boolean(deployKey && deployKey.read_only === false),
      localAgentCredential: localConfigured,
    },
    credential: { title: credential.title, publicKey: credential.publicKey, privateKey: credential.privateKey },
  };
}

function runGitHubApi(endpoint, { method = "GET", body = null } = {}) {
  const args = [
    "api",
    endpoint,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (method !== "GET") args.push("--method", method);
  if (body !== null) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === null ? undefined : JSON.stringify(body),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") throw new Error("GitHub CLI is required; install gh and authenticate an owner account");
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "GitHub API request failed").trim().split("\n")[0];
    throw new Error(`GitHub API request failed: ${detail}`);
  }
  try {
    return result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    throw new Error("GitHub API returned an invalid JSON response");
  }
}

function githubRulesetName(defaultBranch) {
  return `${GITHUB_RULESET_PREFIX}${defaultBranch}`;
}

function githubRulesetPayload(defaultBranch) {
  return {
    name: githubRulesetName(defaultBranch),
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${defaultBranch}`], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
    ],
  };
}

function inspectGitHubRuleset(ruleset, defaultBranch) {
  const types = new Map((ruleset?.rules || []).map((rule) => [rule.type, rule]));
  const pullRequest = types.get("pull_request");
  const checks = {
    active: ruleset?.enforcement === "active",
    branchTarget: ruleset?.target === "branch",
    exactDefaultBranch: ruleset?.conditions?.ref_name?.include?.includes(`refs/heads/${defaultBranch}`) === true,
    noBypassActors: Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length === 0,
    requiresPullRequest: Boolean(pullRequest),
    resolvesReviewThreads: pullRequest?.parameters?.required_review_thread_resolution === true,
    blocksDeletion: types.has("deletion"),
    blocksForcePush: types.has("non_fast_forward"),
  };
  return { verified: Object.values(checks).every(Boolean), checks };
}

function writeGitHubSecurityState(repository, result) {
  return writeJson(path.join(repositoryCacheRoot(repository), "github-security.json"), result);
}

export function checkSharedGitHubSecurity(root) {
  const { repository, repositoryConfig, gitRoots } = sharedSecurityTarget(root);
  const github = githubRepositoryCoordinates(repository);
  const rulesets = runGitHubApi(`repos/${github.fullName}/rulesets?includes_parents=false&targets=branch`);
  const summary = (rulesets || []).find((item) => item.name === githubRulesetName(repositoryConfig.defaultBranch));
  let ruleset = null;
  if (summary?.id) ruleset = runGitHubApi(`repos/${github.fullName}/rulesets/${summary.id}?includes_parents=false`);
  const inspected = inspectGitHubRuleset(ruleset, repositoryConfig.defaultBranch);
  const deployKeys = runGitHubApi(`repos/${github.fullName}/keys?per_page=100`);
  const agentGit = inspectSharedAgentGit(repository, github, gitRoots, deployKeys);
  const checks = { ...inspected.checks, ...agentGit.checks };
  return writeGitHubSecurityState(repository, {
    verified: Object.values(checks).every(Boolean),
    checkedAt: new Date().toISOString(),
    repository: github.fullName,
    defaultBranch: repositoryConfig.defaultBranch,
    rulesetId: ruleset?.id || null,
    rulesetUrl: ruleset?._links?.html?.href || `https://github.com/${github.fullName}/settings/rules`,
    deployKeyId: agentGit.deployKey?.id || null,
    agentCredential: agentGit.credential,
    checks,
  });
}

export function secureSharedGitHubRepository(root) {
  const { repository, repositoryConfig, gitRoots } = sharedSecurityTarget(root);
  const github = githubRepositoryCoordinates(repository);
  const rulesets = runGitHubApi(`repos/${github.fullName}/rulesets?includes_parents=false&targets=branch`);
  const existing = (rulesets || []).find((item) => item.name === githubRulesetName(repositoryConfig.defaultBranch));
  const payload = githubRulesetPayload(repositoryConfig.defaultBranch);
  if (existing?.id) runGitHubApi(`repos/${github.fullName}/rulesets/${existing.id}`, { method: "PUT", body: payload });
  else runGitHubApi(`repos/${github.fullName}/rulesets`, { method: "POST", body: payload });
  const credential = ensureSharedAgentCredential(repository);
  const deployKeys = runGitHubApi(`repos/${github.fullName}/keys?per_page=100`);
  let deployKey = (deployKeys || []).find((item) => (
    item.title === credential.title
    && normalizedSshPublicKey(item.key) === normalizedSshPublicKey(credential.key)
  ));
  if (deployKey?.read_only) throw new Error(`GitHub deploy key ${credential.title} exists but is read-only`);
  if (!deployKey) {
    deployKey = runGitHubApi(`repos/${github.fullName}/keys`, {
      method: "POST",
      body: { title: credential.title, key: credential.key, read_only: false },
    });
  }
  configureSharedAgentGit(repository, github, gitRoots);
  const result = checkSharedGitHubSecurity(root);
  if (!result.verified) throw new Error("GitHub created the ruleset but its effective security checks did not pass");
  return { ...result, rulesetCreated: !existing, rulesetUpdated: Boolean(existing), deployKeyId: deployKey.id || result.deployKeyId };
}

function proposalScopePrefixes(config, projectId, scope) {
  if (scope === "global") return [config.globalSkillsPath.replace(/\/$/, "") + "/"];
  if (scope !== "project") throw new Error("Proposal scope must be project or global");
  const projectRoot = `${config.projectsPath.replace(/\/$/, "")}/${safeId(projectId, "projectId")}`;
  return [`${projectRoot}/docs/`, `${projectRoot}/skills/`];
}

function proposalIdentity(config, branch) {
  const safeBranch = safeBranchName(branch, "proposal branch");
  if (!safeBranch.startsWith(config.proposalPrefix)) throw new Error(`Proposal branch must start with ${config.proposalPrefix}`);
  const suffix = safeBranch.slice(config.proposalPrefix.length);
  const segments = suffix.split("/");
  if (segments.length < 2 || !segments.slice(1).join("/")) throw new Error("Proposal branch must include a scope and proposal name");
  const scopeId = safeId(segments[0], "proposal scope");
  return {
    branch: safeBranch,
    projectId: scopeId,
    scope: scopeId === "global" ? "global" : "project",
    allowedPrefixes: proposalScopePrefixes(config, scopeId, scopeId === "global" ? "global" : "project"),
  };
}

function assertPathsInProposalScope(files, policy) {
  const outside = files.filter((file) => !policy.allowedPrefixes.some((prefix) => file.startsWith(prefix)));
  if (outside.length) throw new Error(`Proposal changes files outside ${policy.allowedPrefixes.join(" or ")}: ${outside.join(", ")}`);
}

function proposalBranch(config, projectId, title, scope, explicit = "") {
  const scopeId = scope === "global" ? "global" : safeId(projectId, "projectId");
  if (!['project', 'global'].includes(scope)) throw new Error("Proposal scope must be project or global");
  if (explicit) {
    const identity = proposalIdentity(config, explicit);
    if (identity.projectId !== scopeId) throw new Error(`Proposal branch scope must be ${config.proposalPrefix}${scopeId}/`);
    return identity.branch;
  }
  const slug = String(title || "change").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "change";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `${config.proposalPrefix}${scopeId}/${stamp}-${slug}`;
}

function proposalRegistryPath(repository) {
  return path.join(repositoryCacheRoot(repository), "proposals.json");
}

export function createSharedProposal(root, { title, description = "", scope = "project", branch = "", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const synced = syncSharedContext(root, { allowOffline: false });
  const { connection, repositoryConfig, revision } = synced;
  const safeTitle = proposalTitle(title);
  const safeDescription = proposalDescription(description);
  const proposal = proposalBranch(repositoryConfig, connection.projectId, safeTitle, scope, branch);
  const checkout = repositoryCheckout(connection.repository);
  const proposalRoot = path.join(repositoryCacheRoot(connection.repository), "proposals", hashKey(proposal));
  if (fs.existsSync(proposalRoot)) throw new Error(`Proposal workspace already exists: ${proposalRoot}`);
  runGit(checkout, ["worktree", "add", "-b", proposal, proposalRoot, revision], { stdio: ["ignore", "ignore", "pipe"] });
  const sourceRoot = connection.projectRoot || path.resolve(root);
  const source = sourceIdentity(sourceRoot);
  const sourceCommit = tryGit(sourceRoot, ["rev-parse", "HEAD"]);
  const sourceBranch = tryGit(sourceRoot, ["branch", "--show-current"]);
  const registry = readJson(proposalRegistryPath(connection.repository), { version: 1, proposals: {} });
  registry.proposals[proposal] = {
    branch: proposal,
    root: proposalRoot,
    baseRevision: revision,
    projectId: connection.projectId,
    scope,
    title: safeTitle,
    description: safeDescription,
    sourceRemote: source?.remotes?.[0] || "",
    sourceBranch,
    sourceCommit: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceCommit) ? sourceCommit : "",
    sessionId: safeSessionId(sessionId),
    createdAt: new Date().toISOString(),
  };
  writeJson(proposalRegistryPath(connection.repository), registry);
  return registry.proposals[proposal];
}

function proposalScopeId(connection, scope) {
  if (scope === "global") return "global";
  if (scope !== "project") throw new Error("Proposal scope must be project or global");
  return safeId(connection.projectId, "projectId");
}

function proposalSessionMatches(entry, connection, scope, sessionId) {
  return entry
    && safeSessionId(entry.sessionId) === sessionId
    && String(entry.scope || "project") === scope
    && String(entry.scope === "global" ? "global" : entry.projectId) === proposalScopeId(connection, scope);
}

function remoteBranchRevision(checkout, branch) {
  const safeBranch = safeBranchName(branch, "proposal branch");
  const revision = tryGit(checkout, ["rev-parse", `refs/remotes/origin/${safeBranch}^{commit}`]);
  return revision ? safeRevision(revision, "proposal head") : "";
}

function ensureProposalWorktree(checkout, repository, proposal) {
  const proposalRoot = path.join(repositoryCacheRoot(repository), "proposals", hashKey(proposal.branch));
  if (fs.existsSync(proposalRoot)) {
    const actualHead = tryGit(proposalRoot, ["rev-parse", "HEAD"]);
    if (!actualHead) throw new Error(`Proposal workspace is not a Git worktree: ${proposalRoot}`);
    return proposalRoot;
  }
  fs.mkdirSync(path.dirname(proposalRoot), { recursive: true });
  const localHead = tryGit(checkout, ["rev-parse", `refs/heads/${proposal.branch}^{commit}`]);
  if (localHead && safeRevision(localHead, "local proposal head") !== proposal.head) {
    throw new Error(`Local proposal branch diverges from origin/${proposal.branch}; resolve it before resuming this session`);
  }
  if (localHead) {
    runGit(checkout, ["worktree", "add", proposalRoot, proposal.branch], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    runGit(checkout, ["worktree", "add", "-b", proposal.branch, proposalRoot, proposal.head], { stdio: ["ignore", "ignore", "pipe"] });
  }
  return proposalRoot;
}

function proposalRegistryEntryFromRemote(proposal, proposalRoot) {
  return {
    branch: proposal.branch,
    root: proposalRoot,
    baseRevision: proposal.baseRevision,
    projectId: proposal.projectId,
    scope: proposal.scope,
    title: proposal.title,
    description: proposal.description,
    sourceRemote: proposal.sourceRemote || "",
    sourceBranch: proposal.sourceBranch || "",
    sourceCommit: proposal.sourceCommit || "",
    sessionId: proposal.sessionId,
    createdAt: proposal.createdAt || proposal.updatedAt || new Date().toISOString(),
    updatedAt: proposal.updatedAt || new Date().toISOString(),
    lastPublishedHead: proposal.head,
  };
}

export function ensureSharedProposal(root, { title, description = "", scope = "project", branch = "", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const normalizedSession = safeSessionId(sessionId);
  if (!normalizedSession || branch) {
    return { ...createSharedProposal(root, { title, description, scope, branch, sessionId: normalizedSession }), reused: false };
  }
  const synced = syncSharedContext(root, { allowOffline: false });
  const { connection } = synced;
  const registryFile = proposalRegistryPath(connection.repository);
  const registry = readJson(registryFile, { version: 1, proposals: {} });
  const checkout = repositoryCheckout(connection.repository);
  const remoteProposals = listRemoteSharedProposals(synced);
  const terminalBranches = new Set(remoteProposals
    .filter((proposal) => ["accepted", "merged"].includes(proposal.reviewStatus))
    .map((proposal) => proposal.branch));
  const localMatches = Object.values(registry.proposals || {}).filter((entry) => (
    proposalSessionMatches(entry, connection, scope, normalizedSession)
    && fs.existsSync(entry.root)
    && !terminalBranches.has(entry.branch)
    && (!entry.lastPublishedHead || remoteBranchRevision(checkout, entry.branch))
  ));
  const remoteMatches = remoteProposals.filter((proposal) => (
    proposalSessionMatches(proposal, connection, scope, normalizedSession)
    && !["accepted", "merged"].includes(proposal.reviewStatus)
  ));
  const matches = new Map();
  for (const entry of localMatches) matches.set(entry.branch, { kind: "local", entry });
  for (const proposal of remoteMatches) matches.set(proposal.branch, { kind: "remote", proposal });
  if (matches.size > 1) {
    throw new Error(`Several open proposals match session ${normalizedSession} and scope ${proposalScopeId(connection, scope)}: ${[...matches.keys()].join(", ")}`);
  }
  const match = [...matches.values()][0];
  if (!match) {
    return { ...createSharedProposal(root, { title, description, scope, sessionId: normalizedSession }), reused: false };
  }
  if (match.kind === "local") return { ...match.entry, reused: true };
  const proposalRoot = ensureProposalWorktree(checkout, connection.repository, match.proposal);
  const entry = proposalRegistryEntryFromRemote(match.proposal, proposalRoot);
  registry.proposals[entry.branch] = entry;
  writeJson(registryFile, registry);
  return { ...entry, reused: true };
}

function proposalCommitMessage(entry, message) {
  const trailers = [
    `Context-Room-Title: ${proposalTitle(entry.title)}`,
    entry.description ? `Context-Room-Description-Base64: ${encodeProposalDescription(entry.description)}` : "",
    `Context-Room-Project: ${entry.scope === "global" ? "global" : entry.projectId}`,
    `Context-Room-Base: ${entry.baseRevision}`,
    entry.sourceRemote ? `Context-Room-Source-Remote: ${entry.sourceRemote}` : "",
    entry.sourceBranch ? `Context-Room-Source-Branch: ${entry.sourceBranch}` : "",
    entry.sourceCommit ? `Context-Room-Source-Commit: ${entry.sourceCommit}` : "",
    entry.sessionId ? `Context-Room-Session: ${entry.sessionId}` : "",
  ].filter(Boolean);
  return `${String(message || entry.title || "Propose shared context changes").trim()}\n\n${trailers.join("\n")}`;
}

function proposalEntry(root, branch) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  const registry = readJson(proposalRegistryPath(connection.repository), { proposals: {} });
  const entry = registry.proposals?.[branch];
  if (!entry || !fs.existsSync(entry.root)) throw new Error(`Unknown local proposal workspace: ${branch}`);
  return { connection, entry, registry };
}

function changedFiles(cwd, base) {
  const committed = gitChangedPaths(cwd, `${base}...HEAD`);
  const working = splitNull(runGit(cwd, ["diff", "--name-only", "-z", "HEAD", "--"], { encoding: null }));
  const untracked = splitNull(runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"], { encoding: null }));
  return [...new Set([...committed, ...working, ...untracked])];
}

export function publishSharedProposal(root, { proposal, message = "", title, description } = {}) {
  const { connection, entry, registry } = proposalEntry(root, proposal);
  const config = readSharedRepositoryConfig(entry.root);
  const identity = proposalIdentity(config, entry.branch);
  const expectedScopeId = entry.scope === "global" ? "global" : entry.projectId;
  if (identity.projectId !== expectedScopeId) throw new Error(`Proposal branch scope must be ${config.proposalPrefix}${expectedScopeId}/`);
  const previousRemoteHead = tryGit(entry.root, ["rev-parse", "--verify", `refs/remotes/origin/${entry.branch}`]);
  if (previousRemoteHead && description === undefined) {
    throw new Error("--description is required whenever a published proposal is updated");
  }
  const nextTitle = proposalTitle(title === undefined ? entry.title : title);
  const nextDescription = proposalDescription(description === undefined ? entry.description : description, { optional: !previousRemoteHead });
  const pendingFiles = changedFiles(entry.root, entry.baseRevision);
  assertPathsInProposalScope(pendingFiles, identity);
  if (!pendingFiles.length) throw new Error("Proposal has no changes");
  runGit(entry.root, ["add", "-A"]);
  let hasStagedChanges = false;
  try {
    runGit(entry.root, ["diff", "--cached", "--quiet"]);
  } catch {
    hasStagedChanges = true;
  }
  const metadataChanged = nextTitle !== entry.title || nextDescription !== (entry.description || "");
  entry.title = nextTitle;
  entry.description = nextDescription;
  if (hasStagedChanges || metadataChanged) {
    const commitArgs = ["commit"];
    if (!hasStagedChanges) commitArgs.push("--allow-empty");
    commitArgs.push("-m", proposalCommitMessage(entry, message));
    runGit(entry.root, commitArgs, { stdio: ["ignore", "ignore", "pipe"] });
  }
  const head = safeRevision(tryGit(entry.root, ["rev-parse", "HEAD"]), "proposal head");
  const files = gitChangedPaths(entry.root, `${entry.baseRevision}...${head}`);
  assertPathsInProposalScope(files, identity);
  assertReviewableChangedPaths(entry.root, entry.baseRevision, head, files);
  runGit(entry.root, ["push", "--set-upstream", "origin", `${entry.branch}:${entry.branch}`], { stdio: ["ignore", "ignore", "pipe"] });
  entry.updatedAt = new Date().toISOString();
  entry.lastPublishedHead = head;
  writeJson(proposalRegistryPath(connection.repository), registry);
  return { ...entry, head, files };
}

export function listSharedProposals(root, { allProjects = true } = {}) {
  const synced = syncSharedContext(root, { allowOffline: true });
  return listRemoteSharedProposals(synced, { allProjects });
}

function sharedSessionProposalOverlay(synced, projectId, sessionId) {
  const normalizedSession = safeSessionId(sessionId);
  const normalizedProject = safeId(projectId, "projectId");
  const proposals = normalizedSession ? listRemoteSharedProposals(synced).filter((proposal) => (
    proposal.sessionId === normalizedSession
    && (proposal.scope === "global" || (normalizedProject !== "global" && proposal.projectId === normalizedProject))
    && proposal.reviewStatus !== "merged"
  )).map((proposal) => ({
    branch: proposal.branch,
    head: proposal.head,
    baseRevision: proposal.baseRevision || synced.revision,
    projectId: proposal.projectId,
    scope: proposal.scope,
    title: proposal.title,
    description: proposal.description,
    files: proposal.files,
    reviewStatus: proposal.reviewStatus,
    hasConflict: proposal.hasConflict,
  })) : [];
  return {
    version: 1,
    sessionId: normalizedSession,
    repository: synced.connection.repository,
    projectId: normalizedProject,
    acceptedRevision: synced.revision,
    proposals,
  };
}

export function resolveSharedSessionProposals(root, { sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const normalizedSession = safeSessionId(sessionId);
  const connection = readSharedProjectConnection(root);
  if (!normalizedSession || !connection) return { version: 1, sessionId: normalizedSession, repository: "", projectId: "", proposals: [] };
  const synced = syncSharedContext(root, { allowOffline: true });
  return sharedSessionProposalOverlay(synced, synced.connection.projectId, normalizedSession);
}

export function resolveSharedDocumentationTarget(repository, {
  projectId,
  sessionId = process.env.CODEX_THREAD_ID || "",
  allowOffline = true,
  acceptedRevision = process.env.CONTEXT_ROOM_DOC_ACCEPTED_REVISION || "",
} = {}) {
  const frozenRevision = acceptedRevision ? safeRevision(acceptedRevision, "accepted shared revision") : "";
  let synced;
  if (frozenRevision) {
    const safeRemote = safeRepository(repository);
    const checkout = ensureRepositoryClone(safeRemote);
    if (!gitObjectExists(checkout, `${frozenRevision}^{commit}`)) {
      throw new Error(`Accepted shared revision is unavailable locally: ${frozenRevision}`);
    }
    assertSafeTreeEntries(checkout, frozenRevision, []);
    const cacheRoot = repositoryCacheRoot(safeRemote);
    const snapshot = path.join(cacheRoot, "snapshots", frozenRevision);
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    materializeSnapshot(checkout, frozenRevision, snapshot);
    const repositoryConfig = readSharedRepositoryConfig(snapshot);
    const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
    const state = readJson(sharedStatePath(safeRemote), {});
    synced = {
      connection: { repository: safeRemote, projectId: "global", projectRoot: "" },
      repositoryConfig,
      catalog,
      revision: frozenRevision,
      online: Boolean(state.online),
      fetchError: String(state.fetchError || ""),
      cacheRoot,
      snapshot,
    };
  } else synced = syncSharedRepositoryState(repository, { allowOffline });
  const normalizedProject = safeId(projectId, "projectId");
  const project = normalizedProject === "global"
    ? { id: "global", title: "Global skills" }
    : synced.catalog.projects.find((item) => item.id === normalizedProject);
  if (!project) throw new Error(`Shared project is not registered in ${synced.repositoryConfig.projectsFile}: ${normalizedProject}`);
  const projectRoot = normalizedProject === "global"
    ? ""
    : path.join(synced.snapshot, synced.repositoryConfig.projectsPath, normalizedProject);
  if (projectRoot && (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory())) {
    throw new Error(`Shared project does not exist in origin/${synced.repositoryConfig.defaultBranch}: ${normalizedProject}`);
  }
  const roots = [];
  const addRoot = (repositoryPath) => {
    const absolutePath = path.join(synced.snapshot, ...repositoryPath.split("/"));
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) roots.push({ repositoryPath, absolutePath });
  };
  if (normalizedProject !== "global") {
    addRoot(`${synced.repositoryConfig.projectsPath}/${normalizedProject}/docs`);
    addRoot(`${synced.repositoryConfig.projectsPath}/${normalizedProject}/skills`);
  }
  addRoot(synced.repositoryConfig.globalSkillsPath);
  return {
    mode: "shared-only",
    repository: synced.connection.repository,
    repositoryName: synced.repositoryConfig.name,
    projectId: normalizedProject,
    projectTitle: project.title,
    revision: synced.revision,
    defaultBranch: synced.repositoryConfig.defaultBranch,
    online: synced.online,
    fetchError: synced.fetchError,
    root: synced.snapshot,
    roots,
    proposalOverlay: sharedSessionProposalOverlay(synced, normalizedProject, sessionId),
  };
}

export function readSharedDocumentationProposalDocuments(target = {}, overlay = {}) {
  const sessionId = safeSessionId(overlay.sessionId || "");
  if (!sessionId || !Array.isArray(overlay.proposals) || !overlay.proposals.length) return [];
  const repository = safeRepository(target.repository);
  const projectId = safeId(target.projectId, "projectId");
  const acceptedRevision = safeRevision(target.revision || overlay.acceptedRevision, "accepted shared revision");
  if (safeRepository(overlay.repository) !== repository) throw new Error("Session proposal overlay repository does not match this project");
  if (safeId(overlay.projectId, "projectId") !== projectId) throw new Error("Session proposal overlay project does not match this project");
  if (safeRevision(overlay.acceptedRevision, "session proposal accepted revision") !== acceptedRevision) {
    throw new Error("Session proposal overlay accepted revision does not match this documentation target");
  }
  const checkout = repositoryCheckout(repository);
  const config = readSharedRepositoryConfig(path.join(repositoryCacheRoot(repository), "snapshots", acceptedRevision));
  const documents = [];
  for (const rawProposal of overlay.proposals) {
    const identity = proposalIdentity(config, rawProposal.branch);
    if (identity.scope !== "global" && (projectId === "global" || identity.projectId !== projectId)) {
      throw new Error(`Session proposal is outside this project: ${rawProposal.branch}`);
    }
    const head = safeRevision(rawProposal.head, "session proposal head");
    const baseRevision = safeRevision(rawProposal.baseRevision, "session proposal base");
    if (!gitObjectExists(checkout, `${head}^{commit}`)) throw new Error(`Session proposal commit is unavailable locally: ${head}`);
    const files = Array.isArray(rawProposal.files) && rawProposal.files.length
      ? rawProposal.files.map((file) => safeRelativePath(file, "session proposal file"))
      : gitChangedPaths(checkout, `${baseRevision}...${head}`);
    assertPathsInProposalScope(files, identity);
    assertReviewableChangedPaths(checkout, baseRevision, head, files);
    for (const filePath of files) {
      if (!/[.](?:md|mdx|html?|txt)$/i.test(filePath)) continue;
      const existsAtHead = gitObjectExists(checkout, `${head}:${filePath}`);
      const content = existsAtHead
        ? String(runGit(checkout, ["show", `${head}:${filePath}`]))
        : `# Deleted in session proposal\n\n${filePath} is deleted by ${rawProposal.branch}.\n`;
      documents.push({
        path: filePath,
        content,
        deleted: !existsAtHead,
        proposal: {
          branch: rawProposal.branch,
          head,
          baseRevision,
          sessionId,
          projectId: identity.projectId,
          scope: identity.scope,
          title: proposalTitle(rawProposal.title || rawProposal.branch),
          description: proposalDescription(rawProposal.description || ""),
          reviewStatus: String(rawProposal.reviewStatus || "ready"),
          hasConflict: Boolean(rawProposal.hasConflict),
        },
      });
    }
  }
  return documents;
}

export function readSharedSessionProposalDocuments(root, overlay = {}) {
  const connection = readSharedProjectConnection(root);
  const sessionId = safeSessionId(overlay.sessionId || "");
  if (!connection || !sessionId || !Array.isArray(overlay.proposals) || !overlay.proposals.length) return [];
  return readSharedDocumentationProposalDocuments({
    repository: connection.repository,
    projectId: connection.projectId,
    revision: overlay.acceptedRevision,
  }, overlay);
}

export function listRegisteredSharedRepositories() {
  const registry = readJson(registryPath(), { bindings: [] });
  return [...new Set((registry.bindings || []).flatMap((binding) => {
    try { return [safeRepository(binding.repository)]; } catch { return []; }
  }))];
}

export function listSharedRepositoryProposals(repository, { allowOffline = true } = {}) {
  const synced = syncSharedRepositoryState(repository, { allowOffline });
  return {
    repository: synced.connection.repository,
    repositoryName: synced.repositoryConfig.name,
    status: {
      online: synced.online,
      fetchError: synced.fetchError,
      revision: synced.revision,
      defaultBranch: synced.repositoryConfig.defaultBranch,
      syncedAt: readJson(sharedStatePath(synced.connection.repository), {}).syncedAt || null,
    },
    projects: synced.catalog.projects,
    proposals: listRemoteSharedProposals(synced),
  };
}

function gitIsAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, encoding: "utf8" });
  return result.status === 0;
}

function proposalHasConflict(cwd, mainRevision, proposalHead) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", mainRevision, proposalHead], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  return null;
}

function sharedReviewActivityIndex(repository, checkout, mainRevision) {
  const authorityRoot = path.join(sharedHome(), "review-authority");
  const index = new Map();
  if (!fs.existsSync(authorityRoot)) return index;
  for (const name of fs.readdirSync(authorityRoot)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
    try {
      const review = readJson(path.join(authorityRoot, name));
      if (!review || safeRepository(review.repository) !== repository) continue;
      const proposal = safeBranchName(review.proposal, "proposal branch");
      const proposalHead = safeRevision(review.proposalHead, "reviewed proposal head");
      const accepted = review.accepted?.accepted ? {
        accepted: true,
        acceptedAt: review.acceptedAt || null,
        commit: safeRevision(review.accepted.commit, "accepted commit"),
        acceptanceBranch: safeBranchName(review.accepted.acceptanceBranch, "acceptance branch"),
        pullRequestUrl: String(review.accepted.pullRequestUrl || ""),
        merged: gitIsAncestor(checkout, review.accepted.commit, mainRevision),
      } : null;
      const activity = {
        proposalHead,
        openedAt: String(review.createdAt || ""),
        accepted,
      };
      if (!index.has(proposal)) index.set(proposal, []);
      index.get(proposal).push(activity);
    } catch {}
  }
  for (const activities of index.values()) {
    activities.sort((left, right) => String(right.accepted?.acceptedAt || right.openedAt).localeCompare(String(left.accepted?.acceptedAt || left.openedAt)));
  }
  return index;
}

function sharedRemoteAcceptanceIndex(synced, checkout) {
  const prefix = `refs/remotes/origin/${synced.repositoryConfig.acceptancePrefix}`;
  const output = tryGit(checkout, ["for-each-ref", "--format=%(refname:strip=3)%09%(objectname)%09%(committerdate:iso8601)", prefix]);
  const index = new Map();
  for (const line of output.split("\n").filter(Boolean)) {
    const [acceptanceBranch, commitValue, acceptedAt] = line.split("\t");
    try {
      const commit = safeRevision(commitValue, "accepted commit");
      const metadata = String(runGit(checkout, [
        "log",
        "-1",
        "--format=%(trailers:key=Context-Room-Proposal,valueonly)%x00%(trailers:key=Context-Room-Proposal-Head,valueonly)%x00%(trailers:key=Context-Room-Session,valueonly)",
        commit,
      ])).split("\0").map((value) => value.trim());
      if (!metadata[0] || !metadata[1]) continue;
      const proposal = safeBranchName(metadata[0], "proposal branch");
      const proposalHead = safeRevision(metadata[1], "proposal head");
      const item = {
        accepted: true,
        acceptedAt,
        commit,
        acceptanceBranch: safeBranchName(acceptanceBranch, "acceptance branch"),
        pullRequestUrl: githubPullRequestUrl(synced.connection.repository, synced.repositoryConfig.defaultBranch, acceptanceBranch),
        merged: gitIsAncestor(checkout, commit, synced.revision),
        proposalHead,
        sessionId: safeSessionId(metadata[2]),
      };
      const previous = index.get(proposal);
      if (!previous || String(item.acceptedAt).localeCompare(String(previous.acceptedAt)) > 0) index.set(proposal, item);
    } catch {}
  }
  return index;
}

function listRemoteSharedProposals(synced, { allProjects = true } = {}) {
  const checkout = repositoryCheckout(synced.connection.repository);
  const reviewActivity = sharedReviewActivityIndex(synced.connection.repository, checkout, synced.revision);
  const remoteAcceptance = sharedRemoteAcceptanceIndex(synced, checkout);
  const prefix = `refs/remotes/origin/${synced.repositoryConfig.proposalPrefix}`;
  const output = tryGit(checkout, ["for-each-ref", "--format=%(refname:strip=3)%09%(objectname)%09%(committerdate:iso8601)%09%(authorname)%09%(authoremail)%09%(subject)", prefix]);
  return output.split("\n").filter(Boolean).flatMap((line) => {
    const [branch, head, updatedAt, authorName, authorEmail, subject] = line.split("\t");
    try {
      const identity = proposalIdentity(synced.repositoryConfig, branch);
      const proposalHead = safeRevision(head, "proposal head");
      let sessionId = "";
      let title = subject;
      let description = "";
      let baseRevision = "";
      let sourceRemote = "";
      let sourceBranch = "";
      let sourceCommit = "";
      try {
        const metadata = String(runGit(checkout, [
          "log",
          "-1",
          "--format=%(trailers:key=Context-Room-Title,valueonly)%x00%(trailers:key=Context-Room-Description-Base64,valueonly)%x00%(trailers:key=Context-Room-Session,valueonly)%x00%(trailers:key=Context-Room-Base,valueonly)%x00%(trailers:key=Context-Room-Source-Remote,valueonly)%x00%(trailers:key=Context-Room-Source-Branch,valueonly)%x00%(trailers:key=Context-Room-Source-Commit,valueonly)",
          proposalHead,
        ])).split("\0").map((value) => value.trim());
        title = proposalTitle(metadata[0] || subject);
        description = decodeProposalDescription(metadata[1]);
        sessionId = safeSessionId(metadata[2]);
        baseRevision = metadata[3] ? safeRevision(metadata[3], "proposal base") : "";
        sourceRemote = String(metadata[4] || "");
        sourceBranch = String(metadata[5] || "");
        sourceCommit = metadata[6] ? safeRevision(metadata[6], "source commit") : "";
      } catch {}
      const files = gitChangedPaths(checkout, `${synced.revision}...${proposalHead}`);
      const activities = reviewActivity.get(branch) || [];
      const currentActivity = activities.find((activity) => activity.proposalHead === proposalHead) || null;
      const latestActivity = activities[0] || null;
      const durableAccepted = remoteAcceptance.get(branch);
      const accepted = currentActivity?.accepted || (durableAccepted?.proposalHead === proposalHead ? durableAccepted : null);
      const reviewStatus = accepted?.merged
        ? "merged"
        : accepted
          ? "accepted"
          : currentActivity
            ? "in_review"
            : latestActivity
              ? "updated"
              : "ready";
      let mainAdvancedBy = 0;
      if (baseRevision && baseRevision !== synced.revision && gitIsAncestor(checkout, baseRevision, synced.revision)) {
        mainAdvancedBy = Number(tryGit(checkout, ["rev-list", "--count", `${baseRevision}..${synced.revision}`])) || 0;
      }
      return [{
        ...identity,
        repository: synced.connection.repository,
        repositoryName: synced.repositoryConfig.name,
        projectTitle: synced.catalog.projects.find((project) => project.id === identity.projectId)?.title || (identity.projectId === "global" ? "Global skills" : identity.projectId),
        head: proposalHead,
        baseRevision,
        updatedAt,
        author: { name: authorName, email: authorEmail },
        title,
        description,
        sessionId,
        sourceRemote,
        sourceBranch,
        sourceCommit,
        files,
        fileCount: files.length,
        reviewStatus,
        reviewActivity: currentActivity || latestActivity,
        updatedSinceReview: reviewStatus === "updated",
        mainAdvancedBy,
        hasConflict: mainAdvancedBy > 0 ? proposalHasConflict(checkout, synced.revision, proposalHead) : false,
      }];
    } catch {
      return [];
    }
  })
    .filter((item) => allProjects || item.projectId === synced.connection.projectId || item.projectId === "global")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function materializeSharedReview(root, { proposal } = {}) {
  const synced = syncSharedContext(root, { allowOffline: false });
  return materializeSharedReviewFromState(synced, { proposal });
}

export function materializeSharedRepositoryReview(repository, { proposal } = {}) {
  const synced = syncSharedRepositoryState(repository, { allowOffline: false });
  return materializeSharedReviewFromState(synced, { proposal });
}

function materializeSharedReviewFromState(synced, { proposal } = {}) {
  const match = listRemoteSharedProposals(synced).find((item) => item.branch === proposal);
  if (!match) throw new Error(`Remote proposal not found: ${proposal}`);
  const checkout = repositoryCheckout(synced.connection.repository);
  const changedFiles = gitChangedPaths(checkout, `${synced.revision}...${match.head}`);
  if (!changedFiles.length) throw new Error("Proposal has no changes relative to shared main");
  assertPathsInProposalScope(changedFiles, match);
  assertSafeTreeEntries(checkout, synced.revision, match.allowedPrefixes);
  assertSafeTreeEntries(checkout, match.head, match.allowedPrefixes);
  assertReviewableChangedPaths(checkout, synced.revision, match.head, changedFiles);
  const reviewRoot = path.join(repositoryCacheRoot(synced.connection.repository), "reviews", `${hashKey(proposal)}-${Date.now()}`);
  let worktreeCreated = false;
  try {
    runGit(checkout, ["worktree", "add", "--detach", reviewRoot, synced.revision], { stdio: ["ignore", "ignore", "pipe"] });
    worktreeCreated = true;
    const patch = runGit(checkout, ["diff", "--binary", "--full-index", `${synced.revision}...${match.head}`, "--"], { encoding: null });
    const applied = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: reviewRoot, input: patch, encoding: "utf8" });
    if (applied.status !== 0) throw new Error(applied.stderr || "Unable to materialize proposal diff");
    const authorityId = randomUUID();
    const metadata = {
      version: 1,
      authorityId,
      reviewRoot: stableRoot(reviewRoot),
      repository: synced.connection.repository,
      projectId: match.projectId,
      scope: match.scope,
      allowedPrefixes: match.allowedPrefixes,
      proposalFiles: changedFiles,
      proposal: match.branch,
      proposalHead: match.head,
      sessionId: match.sessionId,
      baseRevision: synced.revision,
      defaultBranch: synced.repositoryConfig.defaultBranch,
      createdAt: new Date().toISOString(),
    };
    writeJson(path.join(sharedHome(), "review-authority", `${authorityId}.json`), metadata);
    writeJson(path.join(reviewRoot, SHARED_REVIEW_CONFIG), {
      version: 1,
      authorityId,
      proposal: match.branch,
      proposalHead: match.head,
    });
    return { reviewRoot, metadata, repositoryConfig: synced.repositoryConfig };
  } catch (error) {
    if (worktreeCreated) {
      try { runGit(checkout, ["worktree", "remove", "--force", reviewRoot], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
    }
    throw error;
  }
}

export function readSharedReview(root) {
  const pointer = readJson(path.join(path.resolve(root), SHARED_REVIEW_CONFIG));
  if (!pointer) throw new Error(`Missing ${SHARED_REVIEW_CONFIG}`);
  const authorityId = String(pointer.authorityId || "");
  if (!/^[a-f0-9-]{36}$/i.test(authorityId)) throw new Error("Invalid shared review authority");
  const metadata = readJson(path.join(sharedHome(), "review-authority", `${authorityId}.json`));
  if (!metadata || stableRoot(metadata.reviewRoot) !== stableRoot(root)) throw new Error("Shared review authority does not match this worktree");
  safeRepository(metadata.repository);
  safeId(metadata.projectId, "projectId");
  safeBranchName(metadata.proposal, "proposal branch");
  safeBranchName(metadata.defaultBranch, "default branch");
  safeRevision(metadata.proposalHead, "proposal head");
  safeRevision(metadata.baseRevision, "review base");
  return metadata;
}

function isContextRoomControlPath(filePath) {
  return filePath === ".context-room" || filePath.startsWith(".context-room/");
}

function reviewWorkspaceChanges(reviewRoot, baseRevision) {
  const tracked = gitChangedPaths(reviewRoot, baseRevision);
  const untracked = splitNull(runGit(reviewRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"], { encoding: null }));
  return {
    files: [...new Set([...tracked, ...untracked])].filter((filePath) => !isContextRoomControlPath(filePath)),
    untracked: untracked.filter((filePath) => !isContextRoomControlPath(filePath)),
  };
}

function assertReviewWorkspaceFiles(reviewRoot, files) {
  const stableReviewRoot = stableRoot(reviewRoot);
  for (const filePath of files) {
    const base = path.posix.basename(filePath);
    if (!SHARED_REVIEW_TEXT_EXTENSIONS.has(path.posix.extname(base)) && !SHARED_REVIEW_TEXT_FILENAMES.has(base)) {
      throw new Error(`Shared review file type is not reviewable in Context Room: ${filePath}`);
    }
    const absolute = path.join(reviewRoot, ...filePath.split("/"));
    if (!fs.existsSync(absolute)) continue;
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Shared reviews reject symlinks and special files: ${filePath}`);
    const real = fs.realpathSync(absolute);
    if (real !== stableReviewRoot && !real.startsWith(stableReviewRoot + path.sep)) throw new Error(`Shared review path escapes its worktree: ${filePath}`);
    const content = fs.readFileSync(absolute);
    if (content.length > MAX_SHARED_TEXT_BYTES) throw new Error(`Shared review file is too large: ${filePath}`);
    if (!isUtf8(content) || content.includes(0)) throw new Error(`Shared reviews only support UTF-8 text files: ${filePath}`);
  }
}

function addIntentToAdd(root, files) {
  for (let index = 0; index < files.length; index += 200) {
    runGit(root, ["add", "-N", "--", ...files.slice(index, index + 200)]);
  }
}

function acceptedProposalCommitMessage(review, message) {
  const trailers = [
    `Context-Room-Proposal: ${safeBranchName(review.proposal, "proposal branch")}`,
    `Context-Room-Proposal-Head: ${safeRevision(review.proposalHead, "proposal head")}`,
    review.sessionId ? `Context-Room-Session: ${safeSessionId(review.sessionId)}` : "",
    `Context-Room-Project: ${safeId(review.projectId, "projectId")}`,
  ].filter(Boolean);
  return `${String(message || "Accept shared context proposal").trim()}\n\n${trailers.join("\n")}`;
}

export function acceptSharedReview(reviewRoot, { message = "Accept shared context proposal" } = {}) {
  const resolvedReviewRoot = path.resolve(reviewRoot);
  const review = readSharedReview(resolvedReviewRoot);
  if (review.accepted) throw new Error("This exact shared review was already accepted and cannot be reused");
  const checkout = ensureRepositoryClone(review.repository);
  runGit(checkout, ["fetch", "--prune", "origin"], { stdio: ["ignore", "ignore", "pipe"] });
  const reviewHead = safeRevision(tryGit(resolvedReviewRoot, ["rev-parse", "HEAD"]), "review worktree head");
  if (reviewHead !== review.baseRevision) throw new Error("Review worktree history changed; materialize the proposal again");
  const configText = runGit(checkout, ["show", `${review.baseRevision}:${SHARED_REPOSITORY_CONFIG}`]);
  const repositoryConfig = normalizedRepositoryConfig(JSON.parse(configText));
  const policy = proposalIdentity(repositoryConfig, review.proposal);
  if (policy.projectId !== review.projectId || policy.scope !== review.scope) throw new Error("Shared review scope metadata is invalid");
  const currentProposalHead = remoteRevision(checkout, review.proposal);
  if (currentProposalHead !== review.proposalHead) throw new Error("Proposal changed after review; materialize and review the new exact commit");
  const proposalFiles = gitChangedPaths(checkout, `${review.baseRevision}...${review.proposalHead}`);
  assertPathsInProposalScope(proposalFiles, policy);
  assertReviewableChangedPaths(checkout, review.baseRevision, review.proposalHead, proposalFiles);
  const currentMain = remoteRevision(checkout, review.defaultBranch);
  const workspace = reviewWorkspaceChanges(resolvedReviewRoot, review.baseRevision);
  assertPathsInProposalScope(workspace.files, policy);
  assertReviewWorkspaceFiles(resolvedReviewRoot, workspace.files);
  addIntentToAdd(resolvedReviewRoot, workspace.untracked);
  const acceptedPatch = runGit(resolvedReviewRoot, ["diff", "--binary", "--full-index", review.baseRevision, "--", ...policy.allowedPrefixes], { encoding: null });
  if (!acceptedPatch.length) return { accepted: false, reason: "No accepted changes remain", proposal: review.proposal };
  const acceptanceRoot = path.join(repositoryCacheRoot(review.repository), "accept", `${hashKey(review.proposal)}-${Date.now()}`);
  runGit(checkout, ["worktree", "add", "--detach", acceptanceRoot, currentMain], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const applied = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", "-"], { cwd: acceptanceRoot, input: acceptedPatch, encoding: "utf8" });
    if (applied.status !== 0 || tryGit(acceptanceRoot, ["diff", "--name-only", "--diff-filter=U"])) {
      throw new Error("Accepted result conflicts with the current main branch; review the resolved result again");
    }
    runGit(acceptanceRoot, ["add", "-A", "--", ...policy.allowedPrefixes]);
    try {
      runGit(acceptanceRoot, ["diff", "--cached", "--quiet"]);
      return { accepted: false, reason: "Accepted result is already present on main", proposal: review.proposal };
    } catch {}
    runGit(acceptanceRoot, ["commit", "-m", acceptedProposalCommitMessage(review, message)], { stdio: ["ignore", "ignore", "pipe"] });
    const acceptedCommit = safeRevision(tryGit(acceptanceRoot, ["rev-parse", "HEAD"]), "accepted commit");
    assertSafeTreeEntries(acceptanceRoot, acceptedCommit, policy.allowedPrefixes);
    assertReviewableChangedPaths(acceptanceRoot, currentMain, acceptedCommit, workspace.files);
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    const acceptanceBranch = safeBranchName(
      `${repositoryConfig.acceptancePrefix}${policy.projectId}/${stamp}-${acceptedCommit.slice(0, 12)}`,
      "acceptance branch",
    );
    if (acceptanceBranch === review.defaultBranch) throw new Error("Acceptance branch must not be the default branch");
    runGit(acceptanceRoot, ["push", "origin", `HEAD:refs/heads/${acceptanceBranch}`], { stdio: ["ignore", "ignore", "pipe"] });
    const result = {
      accepted: true,
      delivery: "pull-request",
      proposal: review.proposal,
      proposalHead: review.proposalHead,
      previousMain: currentMain,
      commit: acceptedCommit,
      acceptanceBranch,
      pullRequestUrl: githubPullRequestUrl(review.repository, review.defaultBranch, acceptanceBranch),
    };
    writeJson(path.join(sharedHome(), "review-authority", `${review.authorityId}.json`), { ...review, accepted: result, acceptedAt: new Date().toISOString() });
    return result;
  } finally {
    try { runGit(checkout, ["worktree", "remove", "--force", acceptanceRoot], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
  }
}
