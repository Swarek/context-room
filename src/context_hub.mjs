import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const CONTEXT_HUB_REGISTRY_VERSION = 1;

function hubHome() {
  return process.env.CONTEXT_ROOM_HUB_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_HUB_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "hub");
}

export function contextHubHostRoot() {
  return path.join(hubHome(), "host");
}

function registryPath() {
  return path.join(hubHome(), "registry.json");
}

function runtimePath() {
  return path.join(hubHome(), "runtime.json");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  fs.chmodSync(filePath, 0o600);
  return value;
}

function stableRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function stableProjectId(root) {
  return createHash("sha256").update(stableRoot(root)).digest("hex").slice(0, 24);
}

function cleanTitle(value, fallback) {
  return String(value || "").trim().slice(0, 160) || fallback;
}

function projectTitle(root) {
  const fallback = path.basename(root) || "Local project";
  try {
    const config = readJson(path.join(root, ".context-room", "config.json"), {});
    return cleanTitle(config.title, fallback);
  } catch {
    return fallback;
  }
}

function cleanRepository(value) {
  const repository = String(value || "").trim();
  if (!repository || /[\u0000\r\n]/.test(repository)) throw new Error("Shared repository URL is required");
  return repository;
}

function normalizedRegistry(raw = {}) {
  const projects = Array.isArray(raw.projects) ? raw.projects.flatMap((entry) => {
    try {
      const root = stableRoot(entry.root);
      const registeredAt = String(entry.registeredAt || new Date().toISOString());
      return [{
        id: stableProjectId(root),
        root,
        title: cleanTitle(entry.title, projectTitle(root)),
        registeredAt,
        lastOpenedAt: String(entry.lastOpenedAt || registeredAt),
        shared: entry.shared && typeof entry.shared === "object" && entry.shared.repository && entry.shared.projectId ? {
          repository: cleanRepository(entry.shared.repository),
          projectId: String(entry.shared.projectId).trim(),
        } : null,
      }];
    } catch {
      return [];
    }
  }) : [];
  const sharedRepositories = Array.isArray(raw.sharedRepositories) ? raw.sharedRepositories.flatMap((entry) => {
    try {
      return [{
        repository: cleanRepository(entry.repository || entry),
        addedAt: String(entry.addedAt || new Date().toISOString()),
      }];
    } catch {
      return [];
    }
  }) : [];
  return {
    version: CONTEXT_HUB_REGISTRY_VERSION,
    projects: [...new Map(projects.map((entry) => [entry.id, entry])).values()],
    sharedRepositories: [...new Map(sharedRepositories.map((entry) => [entry.repository, entry])).values()],
  };
}

export function readContextHubRegistry() {
  return normalizedRegistry(readJson(registryPath(), {}));
}

export function registerContextHubSharedRepository(repository) {
  const safeRepository = cleanRepository(repository);
  const registry = readContextHubRegistry();
  const existing = registry.sharedRepositories.find((entry) => entry.repository === safeRepository);
  registry.sharedRepositories = [
    ...registry.sharedRepositories.filter((entry) => entry.repository !== safeRepository),
    { repository: safeRepository, addedAt: existing?.addedAt || new Date().toISOString() },
  ];
  writeJson(registryPath(), registry);
  return registry.sharedRepositories.at(-1);
}

export function registerContextHubProject(root, { title = "", shared = null } = {}) {
  const projectRoot = stableRoot(root);
  const configPath = path.join(projectRoot, ".context-room", "config.json");
  if (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory()) throw new Error(`Context Hub project root does not exist: ${projectRoot}`);
  if (!fs.existsSync(configPath)) throw new Error(`Context Hub project is not initialized: ${configPath}`);
  const registry = readContextHubRegistry();
  const id = stableProjectId(projectRoot);
  const existing = registry.projects.find((entry) => entry.id === id);
  const entry = {
    id,
    root: projectRoot,
    title: cleanTitle(title, projectTitle(projectRoot)),
    registeredAt: existing?.registeredAt || new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
    shared: shared?.repository && shared?.projectId ? {
      repository: cleanRepository(shared.repository),
      projectId: String(shared.projectId).trim(),
    } : existing?.shared || null,
  };
  registry.projects = [...registry.projects.filter((project) => project.id !== id), entry];
  if (entry.shared) {
    const existingRepository = registry.sharedRepositories.find((item) => item.repository === entry.shared.repository);
    registry.sharedRepositories = [
      ...registry.sharedRepositories.filter((item) => item.repository !== entry.shared.repository),
      { repository: entry.shared.repository, addedAt: existingRepository?.addedAt || new Date().toISOString() },
    ];
  }
  writeJson(registryPath(), registry);
  return entry;
}

export function listContextHubProjects() {
  const registry = readContextHubRegistry();
  return registry.projects.map((entry) => {
    let available = false;
    try {
      available = fs.statSync(entry.root).isDirectory()
        && fs.existsSync(path.join(entry.root, ".context-room", "config.json"));
    } catch {}
    return {
      ...entry,
      available,
      title: available ? projectTitle(entry.root) : entry.title,
    };
  }).sort((left, right) => {
    if (left.available !== right.available) return left.available ? -1 : 1;
    return String(right.lastOpenedAt).localeCompare(String(left.lastOpenedAt));
  });
}

export function recordContextHubProjectOpened(projectId) {
  const registry = readContextHubRegistry();
  const project = registry.projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error(`Unknown Context Hub project: ${projectId}`);
  project.lastOpenedAt = new Date().toISOString();
  writeJson(registryPath(), registry);
  return project;
}

export function readContextHubRuntime() {
  const runtime = readJson(runtimePath(), null);
  if (!runtime || !Number.isInteger(Number(runtime.port)) || !runtime.url) return null;
  const port = Number(runtime.port);
  if (port < 1 || port > 65535) return null;
  return {
    pid: Number(runtime.pid) || null,
    port,
    root: runtime.root ? stableRoot(runtime.root) : "",
    url: `http://127.0.0.1:${port}`,
    startedAt: String(runtime.startedAt || ""),
  };
}

export function writeContextHubRuntime({ pid = process.pid, port, root, url } = {}) {
  return writeJson(runtimePath(), {
    version: 1,
    pid: Number(pid),
    port: Number(port),
    root: stableRoot(root),
    url: String(url),
    startedAt: new Date().toISOString(),
  });
}

export function clearContextHubRuntime(pid = process.pid) {
  const runtime = readContextHubRuntime();
  if (!runtime || (pid && runtime.pid && Number(pid) !== runtime.pid)) return false;
  try {
    fs.unlinkSync(runtimePath());
    return true;
  } catch {
    return false;
  }
}
