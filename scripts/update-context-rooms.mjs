#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "context-room";
const DEFAULT_PORT = 4317;
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return path.normalize(absolute);
  }
}

export function tokenizeCommand(command) {
  const tokens = [];
  let token = "";
  let quote = "";
  let escaped = false;

  for (const character of String(command || "")) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
      continue;
    }
    token += character;
  }
  if (escaped) token += "\\";
  if (token) tokens.push(token);
  return tokens;
}

function flagValue(tokens, name) {
  const prefix = `--${name}=`;
  const inline = tokens.find((token) => token.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = tokens.indexOf(`--${name}`);
  return index >= 0 ? tokens[index + 1] : undefined;
}

function isContextRoomExecutable(tokens, startIndex) {
  if (!tokens.length || startIndex < 1) return false;
  const executable = path.basename(tokens[0]);
  if (!/^node(?:\.exe)?$/i.test(executable) && !/^context-room(?:\.cmd)?$/i.test(executable)) return false;
  return tokens.slice(0, startIndex).some((token) => /(?:^|\/)(?:context[-_]room)(?:\.mjs)?$/i.test(token));
}

export function contextRoomInstanceFromProcess({ pid, command, cwd }) {
  const tokens = tokenizeCommand(command);
  const startIndex = tokens.indexOf("start");
  if (!isContextRoomExecutable(tokens, startIndex) || !cwd) return null;

  const rootValue = flagValue(tokens, "root") || ".";
  const portValue = flagValue(tokens, "port") || String(DEFAULT_PORT);
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    pid: Number(pid),
    root: canonicalPath(path.resolve(cwd, rootValue)),
    port,
    command,
  };
}

export function isDevelopmentCheckout(root) {
  const packagePath = path.join(root, "package.json");
  try {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    return packageJson.name === PACKAGE_NAME
      && fs.existsSync(path.join(root, ".git"))
      && fs.existsSync(path.join(root, "bin", "context-room.mjs"))
      && fs.existsSync(path.join(root, "src", "context_room.mjs"));
  } catch {
    return false;
  }
}

export function selectRestartableInstances(instances, excludedRoots = []) {
  const exclusions = new Set(excludedRoots.map(canonicalPath));
  const restartable = new Map();
  const excluded = [];

  for (const instance of instances) {
    const normalizedInstance = { ...instance, root: canonicalPath(instance.root) };
    if (exclusions.has(normalizedInstance.root) || isDevelopmentCheckout(normalizedInstance.root)) {
      excluded.push(normalizedInstance);
      continue;
    }
    restartable.set(`${normalizedInstance.root}\0${normalizedInstance.port}`, normalizedInstance);
  }

  return { restartable: [...restartable.values()], excluded };
}

function processCwd(pid) {
  try {
    const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" });
    const cwdLine = output.split("\n").find((line) => line.startsWith("n"));
    return cwdLine ? cwdLine.slice(1) : "";
  } catch {
    return "";
  }
}

export function discoverRunningInstances() {
  const output = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  const instances = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;
    const tokens = tokenizeCommand(match[2]);
    if (!isContextRoomExecutable(tokens, tokens.indexOf("start"))) continue;
    const instance = contextRoomInstanceFromProcess({
      pid: Number(match[1]),
      command: match[2],
      cwd: processCwd(match[1]),
    });
    if (instance) instances.push(instance);
  }
  return instances;
}

function parseArgs(argv) {
  const options = { dryRun: false, noRestart: false, excludes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--no-restart") options.noRestart = true;
    else if (argument === "--exclude") {
      if (!argv[index + 1]) throw new Error("--exclude requires a path");
      options.excludes.push(argv[index + 1]);
      index += 1;
    } else if (argument.startsWith("--exclude=")) options.excludes.push(argument.slice("--exclude=".length));
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function latestVersion() {
  const output = execFileSync("npm", ["view", PACKAGE_NAME, "version", "--json"], { encoding: "utf8" });
  return JSON.parse(output);
}

function installLatestGlobal(version) {
  execFileSync("npm", ["install", "--global", `${PACKAGE_NAME}@${version}`], { stdio: "inherit" });
}

function globalCliPath() {
  const prefix = execFileSync("npm", ["prefix", "--global"], { encoding: "utf8" }).trim();
  return path.join(prefix, "bin", process.platform === "win32" ? "context-room.cmd" : "context-room");
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Process ${pid} did not stop after ${timeoutMs}ms`);
}

async function waitForHealth(instance, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${instance.port}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      const health = await response.json();
      if (response.ok && health.ok && canonicalPath(health.root) === instance.root) return;
      lastError = new Error(`Unexpected health response on port ${instance.port}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Context Room on port ${instance.port} did not become healthy: ${lastError?.message || "timeout"}`);
}

async function restartInstance(instance, cliPath, logDir) {
  process.kill(instance.pid, "SIGTERM");
  await waitForExit(instance.pid);

  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `context-room-${instance.port}.log`);
  const logFd = fs.openSync(logPath, "a");
  try {
    const child = spawn(cliPath, ["start", "--root", instance.root, "--port", String(instance.port)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
  await waitForHealth(instance);
  return logPath;
}

function printUsage() {
  console.log(`Update every running Context Room to the latest npm release.\n\nUsage:\n  context-room update-all [--dry-run] [--no-restart] [--exclude /path]\n\nThe Context Room development checkout is always excluded.`);
}

export async function updateAllContextRooms(argv = []) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return { version: "", restarted: [], excluded: [] };
  }

  const running = discoverRunningInstances();
  const excludedRoots = [SCRIPT_ROOT, ...options.excludes];
  const { restartable, excluded } = selectRestartableInstances(running, excludedRoots);
  const version = latestVersion();

  console.log(`Latest npm release: ${PACKAGE_NAME}@${version}`);
  for (const instance of excluded) console.log(`Excluded development room: ${instance.root} (port ${instance.port})`);
  for (const instance of restartable) console.log(`Will update: ${instance.root} (port ${instance.port}, pid ${instance.pid})`);
  if (!restartable.length) console.log("No non-development Context Room is currently running.");

  if (options.dryRun) {
    console.log("Dry run: no installation or process was changed.");
    return { version, restarted: [], excluded };
  }

  console.log(`Installing ${PACKAGE_NAME}@${version} globally...`);
  installLatestGlobal(version);
  if (options.noRestart) {
    console.log("Global CLI updated; running rooms were left unchanged.");
    return { version, restarted: [], excluded };
  }

  const cliPath = globalCliPath();
  const logDir = path.join(os.homedir(), ".context-room", "logs");
  const restarted = [];
  for (const instance of restartable) {
    const logPath = await restartInstance(instance, cliPath, logDir);
    restarted.push(instance);
    console.log(`Updated: ${instance.root} -> http://127.0.0.1:${instance.port} (log: ${logPath})`);
  }
  console.log(`Done: ${restarted.length} room(s) restarted on ${PACKAGE_NAME}@${version}.`);
  return { version, restarted, excluded };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  updateAllContextRooms(process.argv.slice(2)).catch((error) => {
    console.error(`Context Room update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
