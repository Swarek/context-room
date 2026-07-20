#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateAllContextRooms } from "../scripts/update-context-rooms.mjs";
import {
  appendAgentAnnotation,
  buildAgentBrief,
  buildAgentReviewQueue,
  buildContextRoomDoctorReport,
  buildDocQaReport,
  createMemoryServer,
  initializeContextRoomProject,
  readAgentAnnotations,
  readCollaborationSessionState,
  readReviewGateSettings,
  removeFolderWatchRule,
  selectAvailableContextRoomPort,
  syncContextRoomGitHooks,
  writeAgentCommand,
  writeFolderWatchRule,
  CONFIG_FILE,
  WATCH_RULE_MODES,
} from "../src/context_room.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const option = arg.slice(2);
    const equalsIndex = option.indexOf("=");
    if (equalsIndex !== -1) {
      const key = option.slice(0, equalsIndex);
      args[key] = option.slice(equalsIndex + 1);
      continue;
    }
    const key = option;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function splitList(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function usage() {
  return `Context Room\n\nUsage:\n  context-room setup [--root .] [--title "My Project"] [--allow docs/] [--watch docs/] [--port 4317]\n  context-room init [--root .] [--title "My Project"] [--allow docs/] [--watch docs/]\n  context-room start [--root .] [--port 4317]\n  context-room doctor [--root .] [--strict]\n  context-room guard [--root .] [--profile advisory|review-only|strict] [--operation commit|push|pull-request|merge]\n  context-room brief [--root .] [--task "what the agent will do"] [--limit 12]\n  context-room agent state [--root .]\n  context-room agent open [--root .] [--path docs/INDEX.md] [--view hub|settings|file|diff] [--heading "Purpose"] [--text "needle"] [--percent 50]\n  context-room agent annotate --root . --path docs/INDEX.md --note "Human-facing note" [--target "text"]\n  context-room agent queue [--root .]\n  context-room agent watch --root . --path docs/ [--mode recursive-live|recursive-current|direct-current|direct-live]\n  context-room agent unwatch --root . --path docs/\n  context-room install-hook [--root .]\n  context-room install-hooks [--root .]\n  context-room update-all [--dry-run] [--no-restart] [--exclude /path]\n  context-room --version\n\nFolder watch modes:\n  recursive-live     Current and future files at any depth (default)\n  recursive-current  Current files at any depth; future files are excluded\n  direct-current     Current direct child files; future files and subfolders are excluded\n  direct-live        Current and future direct child files; subfolder files are excluded\n\nFresh setup discovers and watches project documentation, builds project-specific hub sections, and uses the first free port when --port is omitted.\n\nConfig: ${CONFIG_FILE}\n`;
}

const KNOWN_OPTIONS = new Set([
  "advisory", "allow", "dry-run", "exclude", "h", "heading", "help", "highlight", "hook",
  "limit", "message", "mode", "no-restart", "note", "operation", "path", "percent", "port", "profile",
  "root", "strict", "target", "task", "text", "title", "version", "view", "watch",
]);

function packageVersion() {
  return JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

function quotedCliValue(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "start";

if (args.version !== undefined) {
  console.log(packageVersion());
  process.exit(0);
}

if (args.help || args.h) {
  console.log(usage());
  process.exit(0);
}

const unknownOption = Object.keys(args).find((key) => key !== "_" && !KNOWN_OPTIONS.has(key));
if (unknownOption) {
  console.error(`Unknown option: --${unknownOption}`);
  process.exit(2);
}

if (args.root === true || args.root === "") {
  console.error("--root requires a path.");
  process.exit(2);
}

if (args.title === true || args.title === "") {
  console.error("--title requires a value.");
  process.exit(2);
}

if (args.allow === true || args.allow === "") {
  console.error("--allow requires a path list.");
  process.exit(2);
}

if (args.watch === true || args.watch === "") {
  console.error("--watch requires a path list.");
  process.exit(2);
}

const root = path.resolve(args.root || process.cwd());
let rootStats;
try {
  rootStats = fs.statSync(root);
} catch {
  rootStats = null;
}
if (!rootStats?.isDirectory()) {
  console.error(`Context Room root must be an existing directory: ${root}`);
  process.exit(2);
}

if (command === "init") {
  let result;
  try {
    result = initializeContextRoomProject(root, {
      title: args.title,
      allowedPaths: splitList(args.allow),
      watchAllow: splitList(args.watch),
    });
  } catch (error) {
    console.error(`Context Room initialization failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`Context Room initialized: ${result.configPath}`);
  if (result.discoverySkipped) console.log("Documentation discovery skipped: the existing configuration was preserved.");
  else console.log(`Documentation discovered: ${result.documentationPaths.length}`);
  console.log(`Watched paths: ${result.config.watchAllow.length}`);
  console.log(`Hub sections: ${result.config.hubSections.length}`);
  console.log(`Agent setup guide: ${result.agentContextPath}`);
  console.log(`Agent next step: read ${JSON.stringify(result.agentContextPath)} and follow its setup checklist.`);
  console.log(`Run: context-room setup --root ${quotedCliValue(root)}`);
  process.exit(0);
}

if (command === "doctor") {
  let report;
  try {
    report = buildContextRoomDoctorReport(root);
  } catch (error) {
    console.error(`Context Room doctor failed: [critical] ${error.message}`);
    process.exit(1);
  }
  const blocking = report.issues.filter((issue) => ["critical", "high"].includes(issue.severity));
  console.log(blocking.length ? "Context Room needs attention" : "Context Room OK");
  console.log(`Root: ${root}`);
  console.log(`Config: ${path.join(root, CONFIG_FILE)}`);
  console.log(`Allowed paths: ${report.settings.allowedPaths}`);
  console.log(`Watched paths: ${report.settings.watchAllow}`);
  console.log(`Docs in graph: ${report.graph.docs}`);
  console.log(`Missing metadata: ${report.graph.missingMetadata}`);
  console.log(`Health issues: ${report.issues.length}`);
  for (const issue of report.issues.slice(0, 20)) {
    console.log(`- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
  if ((args.strict || args.profile === "strict") && blocking.length) process.exit(1);
  process.exit(0);
}

if (command === "guard") {
  const allowedOperations = new Set(["commit", "push", "pull-request", "merge"]);
  const operation = args.operation ? String(args.operation).trim().toLowerCase() : "";
  if (operation && !allowedOperations.has(operation)) {
    console.error(`Unknown review-gate operation: ${operation}`);
    process.exit(2);
  }
  const requestedProfile = args.strict ? "strict" : args.advisory ? "advisory" : args.profile ? String(args.profile) : "";
  const gateActive = Boolean(operation && !requestedProfile && readReviewGateSettings(root).operations.includes(operation));
  if (args.hook && operation && !gateActive) process.exit(0);
  const profile = requestedProfile || (gateActive ? "review-gate" : "advisory");
  const report = buildDocQaReport(root);
  const doctor = profile === "strict" || profile === "advisory" ? buildContextRoomDoctorReport(root) : null;
  const blockingHealth = doctor ? doctor.issues.filter((issue) => ["critical", "high"].includes(issue.severity)) : [];
  const shouldBlock = gateActive ? report.queue.length > 0 : profile === "strict" && (report.queue.length || blockingHealth.length);
  const operationLabel = operation === "pull-request" ? "pull request" : operation || "commit";
  if (report.queue.length) {
    const write = shouldBlock ? console.error : console.log;
    write(shouldBlock
      ? `Context Room guard blocked this ${operationLabel}: watched documentation changes need human review:`
      : "Context Room guard found watched documentation changes that need human review:");
    for (const item of report.queue) write(`- ${item.gitStatus.trim() || "changed"} ${item.path}`);
  }
  if (blockingHealth.length) {
    console.error("High-impact Context Room health issues:");
    for (const issue of blockingHealth.slice(0, 20)) console.error(`- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
  if (shouldBlock) {
    console.error(
      "\nOpen the Context Room webapp for the user, show the Changed files to review queue, and have the user review each diff before continuing this Git operation. Agents must not mark files verified on the user's behalf.",
    );
    if (blockingHealth.length) console.error("If strict health issues are listed, fix them before asking the user to verify.");
    process.exit(1);
  }
  if (profile !== "strict" && !gateActive && (report.queue.length || blockingHealth.length)) {
    console.log(`Context Room ${profile} guard found issues but did not block.`);
  } else {
    console.log(profile === "strict" ? "Strict Context Room guard passed." : "No unverified watched documentation changes.");
  }
  process.exit(0);
}

if (command === "brief") {
  process.stdout.write(buildAgentBrief(root, { task: args.task || "", limit: Number(args.limit || 12) }));
  process.exit(0);
}

if (command === "agent") {
  const action = args._[1] || "state";
  if (action === "state") {
    console.log(JSON.stringify(readCollaborationSessionState(root), null, 2));
    process.exit(0);
  }
  if (action === "queue" || action === "review-queue") {
    console.log(JSON.stringify(buildAgentReviewQueue(root), null, 2));
    process.exit(0);
  }
  if (action === "watch") {
    if (!args.path || args.path === true) {
      console.error("Usage: context-room agent watch --root . --path docs/ [--mode recursive-live|recursive-current|direct-current|direct-live]");
      process.exit(2);
    }
    if (args.mode === true || args.mode === "") {
      console.error("--mode requires a folder watch mode.");
      process.exit(2);
    }
    const mode = args.mode ? String(args.mode).trim() : "recursive-live";
    if (!WATCH_RULE_MODES.includes(mode)) {
      console.error(`Unknown folder watch mode: ${mode}. Expected one of: ${WATCH_RULE_MODES.join(", ")}.`);
      process.exit(2);
    }
    try {
      console.log(JSON.stringify(writeFolderWatchRule(root, { path: args.path, mode }), null, 2));
    } catch (error) {
      console.error(`Unable to watch folder: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (action === "unwatch") {
    if (!args.path || args.path === true) {
      console.error("Usage: context-room agent unwatch --root . --path docs/");
      process.exit(2);
    }
    try {
      console.log(JSON.stringify(removeFolderWatchRule(root, { path: args.path }), null, 2));
    } catch (error) {
      console.error(`Unable to unwatch folder: ${error.message}`);
      process.exit(1);
    }
    process.exit(0);
  }
  if (action === "open" || action === "navigate" || action === "scroll" || action === "highlight") {
    const targetType = args.heading ? "heading" : args.text ? "text" : args.percent !== undefined ? "percent" : "";
    const targetValue = args.heading || args.text || args.percent || "";
    const command = writeAgentCommand(root, {
      action: action === "open" ? "navigate" : action,
      view: args.view || (args.path ? "file" : "hub"),
      path: args.path || "",
      targetType,
      targetValue,
      highlight: args.highlight !== false,
      message: args.message || "",
      source: "agent-cli",
    });
    console.log(JSON.stringify({ command }, null, 2));
    process.exit(0);
  }
  if (action === "annotate") {
    if (!args.path || !args.note) {
      console.error("Usage: context-room agent annotate --root . --path docs/INDEX.md --note \"Human-facing note\" [--target \"text\"]");
      process.exit(1);
    }
    const annotation = appendAgentAnnotation(root, {
      path: args.path,
      note: args.note,
      target: args.target || args.heading || args.text || "",
      targetType: args.heading ? "heading" : args.text || args.target ? "text" : "file",
      source: "agent-cli",
    });
    console.log(JSON.stringify({ annotation }, null, 2));
    process.exit(0);
  }
  if (action === "annotations") {
    console.log(JSON.stringify(readAgentAnnotations(root, args.path || ""), null, 2));
    process.exit(0);
  }
  console.error(`Unknown agent command: ${action}\n`);
  console.error(usage());
  process.exit(1);
}

if (command === "install-hook" || command === "install-hooks") {
  const result = syncContextRoomGitHooks(root, { cliPath: fileURLToPath(import.meta.url) });
  if (result.unavailable) {
    console.error(result.unavailable);
    process.exit(1);
  }
  for (const hook of result.installed) console.log(`Context Room ${hook} hook installed.`);
  for (const hook of result.updated) console.log(`Context Room ${hook} hook updated.`);
  for (const hook of result.removed) console.log(`Context Room ${hook} hook removed.`);
  if (result.conflicts.length) {
    console.error(`Context Room did not overwrite custom hooks: ${result.conflicts.join(", ")}`);
    process.exit(1);
  }
  if (result.externalOperations.length) console.log(`Hosted checks still need provider wiring: ${result.externalOperations.join(", ")}.`);
  if (!result.installed.length && !result.removed.length) console.log("No local Context Room Git hooks selected.");
  process.exit(0);
}

if (command === "update-all") {
  const updateArgs = process.argv.slice(3);
  await updateAllContextRooms(updateArgs);
  process.exit(0);
}

if (command === "start" || command === "setup") {
  if (args.port === true || args.port === "") {
    console.error("--port requires a number.");
    process.exit(2);
  }
  const preferredPort = args.port === undefined ? 4317 : Number(args.port);
  let port;
  try {
    port = await selectAvailableContextRoomPort(preferredPort, { allowFallback: args.port === undefined });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  let initialized;
  let server;
  try {
    initialized = initializeContextRoomProject(root, {
      title: args.title,
      allowedPaths: splitList(args.allow),
      watchAllow: splitList(args.watch),
    });
    ({ server } = createMemoryServer({ root, port }));
  } catch (error) {
    console.error(`Context Room setup failed: ${error.message}`);
    process.exit(1);
  }
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const url = `http://127.0.0.1:${port}`;
    const response = await fetch(url + "/api/health", { signal: AbortSignal.timeout(3000) });
    const health = await response.json();
    if (!response.ok || !health.ok || path.resolve(health.root) !== root) throw new Error("Context Room health check returned the wrong project root.");
    if (port !== preferredPort) console.log(`Port ${preferredPort} is in use; selected ${port} without stopping another Context Room.`);
    console.log(`Context Room: ${url}`);
    console.log(`Root: ${root}`);
    console.log(`Health: ${url}/api/health`);
    console.log(`Watched paths: ${initialized.config.watchAllow.length}`);
    console.log(`Hub sections: ${initialized.config.hubSections.length}`);
    console.log(`Agent setup guide: ${initialized.agentContextPath}`);
    console.log(`Agent next step: read ${JSON.stringify(initialized.agentContextPath)} and follow its setup checklist.`);
  } catch (error) {
    console.error(`Context Room failed to start: ${error.message}`);
    if (server.listening) server.close();
    process.exit(1);
  }
} else {
  console.error(`Unknown command: ${command}\n`);
  console.error(usage());
  process.exit(1);
}
