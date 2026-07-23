#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { updateAllContextRooms } from "../scripts/update-context-rooms.mjs";
import {
  checkSharedGitHubSecurity,
  connectSharedContext,
  detectSharedProject,
  ensureSharedProposal,
  initializeSharedRepository,
  listSharedProposals,
  materializeSharedReview,
  publishSharedProposal,
  readSharedProjectConnection,
  secureSharedGitHubRepository,
  sharedContextStatus,
  syncSharedContext,
} from "../src/shared_context.mjs";
import {
  clearContextHubRuntime,
  contextHubHostRoot,
  listContextHubProjects,
  readContextHubRegistry,
  readContextHubRuntime,
  registerContextHubProject,
  registerContextHubSharedRepository,
  writeContextHubRuntime,
} from "../src/context_hub.mjs";
import {
  documentationCapabilities,
  readDocumentation,
  relatedDocumentation,
  renderDocumentationPacket,
  resolveDocumentationProjectRoot,
  runDocumentationAgent,
  searchDocumentation,
  traceDocumentation,
} from "../src/doc_agent.mjs";
import {
  appendAgentAnnotation,
  buildAgentBrief,
  buildAgentReviewQueue,
  buildContextRoomDoctorReport,
  buildDocQaReport,
  contextHubUiState,
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
  return `Context Room

Usage:
  context-room setup [--root .] [--title "My Project"] [--allow docs/] [--watch docs/] [--port 4317]
  context-room init [--root .] [--title "My Project"] [--allow docs/] [--watch docs/]
  context-room start [--root .] [--port 4317]
  context-room hub [--root .] [--port 4317] [--no-local]
  context-room hub list
  context-room hub proposals [--project <project-id>] [--session <task-id>]
  context-room hub open [--project <project-id>] [--session <task-id>] [--proposal proposal/...]
  context-room hub add-shared --repository <git-url>
  context-room doctor [--root .] [--strict]
  context-room guard [--root .] [--profile advisory|review-only|strict] [--operation commit|push|pull-request|merge]
  context-room brief [--root .] [--task "what the agent will do"] [--limit 12]
  context-room context ask "what the agent needs to do" [--root . | --repository <git-url> --project <project-id>] [--goal "desired outcome"] [--files path,...] [--depth quick|standard|exhaustive] [--budget 1200] [--session <task-id>] [--json]
  context-room docs capabilities [--root . | --repository <git-url> --project <project-id>] [--session <task-id>]
  context-room docs search "query" [--root . | --repository <git-url> --project <project-id>] [--status current|proposal] [--kind canonical] [--limit 8] [--budget 1200] [--session <task-id>]
  context-room docs read path[#section] [--root . | --repository <git-url> --project <project-id>] [--budget 1600] [--session <task-id>]
  context-room docs related path [--root . | --repository <git-url> --project <project-id>] [--session <task-id>]
  context-room docs trace path[#section] [--root . | --repository <git-url> --project <project-id>] [--session <task-id>]
  context-room agent state [--root .]
  context-room agent open [--root .] [--path docs/INDEX.md] [--view hub|settings|file|diff] [--heading "Purpose"] [--text "needle"] [--percent 50]
  context-room agent annotate --root . --path docs/INDEX.md --note "Human-facing note" [--target "text"]
  context-room agent queue [--root .]
  context-room agent watch --root . --path docs/ [--mode recursive-live|recursive-current|direct-current|direct-live]
  context-room agent unwatch --root . --path docs/
  context-room shared init-repository --root . --name "My Shared Context"
  context-room shared bind --root . --repository <git-url> [--project <projectId>]
  context-room shared setup --root . --repository <git-url> [--project <projectId>]
  context-room shared sync|status|proposals --root .
  context-room shared secure-github|security-check --root .
  context-room shared propose --root . --title "Change" --description "Current proposal summary" [--scope project|global] [--session <task-id>]
  context-room shared publish --root . --proposal proposal/... [--title "Updated name"] [--description "Required when updating"] [--message "..."]
  context-room shared review --root . --proposal proposal/... [--port 4317]
  context-room install-hook [--root .]
  context-room install-hooks [--root .]
  context-room update-all [--dry-run] [--no-restart] [--exclude /path]
  context-room --version

Folder watch modes:
  recursive-live     Current and future files at any depth (default)
  recursive-current  Current files at any depth; future files are excluded
  direct-current     Current direct child files; future files and subfolders are excluded
  direct-live        Current and future direct child files; subfolder files are excluded

Fresh setup discovers and watches project documentation, builds project-specific hub sections, and uses the first free port when --port is omitted.

Config: ${CONFIG_FILE}
`;
}

const KNOWN_OPTIONS = new Set([
  "advisory", "allow", "branch", "budget", "depth", "description", "dry-run", "exclude", "files", "goal", "h", "heading", "help", "highlight", "hook",
  "json", "kind", "limit", "message", "mode", "name", "no-restart", "note", "operation", "path", "percent", "port", "profile", "query",
  "no-local", "project", "proposal", "repository", "root", "scope", "section", "session", "status", "strict", "target", "task", "text", "title", "version", "view", "watch",
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

if (args.description === true || args.description === "") {
  console.error("--description requires a value.");
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

const requestedRoot = path.resolve(args.root || process.cwd());
const documentationCommand = ["context", "docs"].includes(command);
if (documentationCommand && (args.repository === true || args.project === true)) {
  console.error("--repository and --project each require a value.");
  process.exit(2);
}
const sharedDocumentationTarget = documentationCommand && args.repository && args.repository !== true;
if (documentationCommand && (Boolean(args.repository && args.repository !== true) !== Boolean(args.project && args.project !== true))) {
  console.error("Shared-only documentation requires both --repository <git-url> and --project <project-id>.");
  process.exit(2);
}
const root = documentationCommand && !sharedDocumentationTarget ? resolveDocumentationProjectRoot(requestedRoot) : requestedRoot;
const documentationTargetOptions = sharedDocumentationTarget
  ? { repository: String(args.repository), projectId: String(args.project) }
  : {};
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

if (command === "hub") {
  const action = args._[1] || "start";
  try {
    if (action === "list" || action === "status") {
      console.log(JSON.stringify({
        runtime: readContextHubRuntime(),
        registry: readContextHubRegistry(),
        projects: listContextHubProjects(),
      }, null, 2));
      process.exit(0);
    }
    if (action === "add-shared") {
      if (!args.repository || args.repository === true) throw new Error("Usage: context-room hub add-shared --repository <git-url>");
      console.log(JSON.stringify(registerContextHubSharedRepository(args.repository), null, 2));
      process.exit(0);
    }
    if (action === "proposals") {
      let proposals = contextHubUiState(root).proposals;
      if (args.project && args.project !== true) proposals = proposals.filter((proposal) => proposal.projectId === args.project || proposal.projectTitle === args.project);
      if (args.session && args.session !== true) proposals = proposals.filter((proposal) => proposal.sessionId === args.session);
      console.log(JSON.stringify(proposals, null, 2));
      process.exit(0);
    }
    if (action === "open") {
      const active = readContextHubRuntime();
      if (!active) throw new Error("Context Hub is not running; run context-room hub first");
      const query = new URLSearchParams({ hub: "1" });
      if (args.project && args.project !== true) {
        const requestedProject = String(args.project);
        const project = contextHubUiState(root).projects.find((item) => (
          item.id === requestedProject
          || item.projectKey === requestedProject
          || item.shared?.projectId === requestedProject
          || item.title.toLowerCase() === requestedProject.toLowerCase()
        ));
        if (!project) throw new Error(`Unknown Context Hub project: ${requestedProject}`);
        query.set("project", project.id);
      }
      const search = [
        args.session && args.session !== true ? String(args.session) : "",
        args.proposal && args.proposal !== true ? String(args.proposal) : "",
      ].filter(Boolean).join(" ");
      if (search) query.set("q", search);
      console.log(`Context Room Hub: ${active.url}/?${query.toString()}`);
      process.exit(0);
    }
    if (action !== "start") throw new Error(`Unknown hub command: ${action}`);
    let focusedProject = null;
    if (!args["no-local"]) {
      initializeContextRoomProject(root, { title: args.title });
      const connection = readSharedProjectConnection(root);
      focusedProject = registerContextHubProject(root, {
        title: args.title,
        shared: connection ? { repository: connection.repository, projectId: connection.projectId } : null,
      });
    }
    const runtime = readContextHubRuntime();
    if (runtime) {
      try {
        const response = await fetch(runtime.url + "/api/health", { signal: AbortSignal.timeout(1500) });
        const health = response.ok ? await response.json() : null;
        const expectedRoot = runtime.root ? fs.realpathSync(runtime.root) : "";
        const actualRoot = health?.root ? fs.realpathSync(health.root) : "";
        if (response.ok && health?.ok === true && expectedRoot && actualRoot === expectedRoot) {
          const focus = focusedProject ? `&project=${encodeURIComponent(focusedProject.id)}` : "";
          console.log(`Context Room Hub: ${runtime.url}/?hub=1${focus}`);
          console.log(`Already running since: ${runtime.startedAt || "unknown"}`);
          process.exit(0);
        }
      } catch {}
      clearContextHubRuntime(runtime.pid);
    }
    if (args.port === true || args.port === "") throw new Error("--port requires a number");
    const hostRoot = contextHubHostRoot();
    fs.mkdirSync(hostRoot, { recursive: true });
    initializeContextRoomProject(hostRoot, {
      title: "Context Room Hub",
      allowedPaths: [],
      watchAllow: [],
      reviewAgentInstructions: false,
    });
    const preferredPort = args.port === undefined ? 4317 : Number(args.port);
    const port = await selectAvailableContextRoomPort(preferredPort, { allowFallback: args.port === undefined });
    const { server } = createMemoryServer({ root: hostRoot, port, registerInHub: false });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => { server.off("error", onError); resolve(); });
    });
    const url = `http://127.0.0.1:${port}`;
    writeContextHubRuntime({ port, root: hostRoot, url });
    const focus = focusedProject ? `&project=${encodeURIComponent(focusedProject.id)}` : "";
    console.log(`Context Room Hub: ${url}/?hub=1${focus}`);
    console.log(`Projects: ${listContextHubProjects().length}`);
    const close = () => server.close(() => {
      clearContextHubRuntime(process.pid);
      process.exit(0);
    });
    process.on("SIGINT", close);
    process.on("SIGTERM", close);
    await new Promise(() => {});
  } catch (error) {
    console.error(`Context Room Hub failed: ${error.message}`);
    process.exit(1);
  }
}

if (command !== "shared" && !sharedDocumentationTarget && ["setup", "start", "doctor", "guard", "brief", "context", "agent"].includes(command) && readSharedProjectConnection(root)) {
  try {
    const shared = syncSharedContext(root, { allowOffline: true });
    if (!shared.online) console.error(`Shared context offline: using ${shared.revision.slice(0, 12)} (${shared.fetchError})`);
  } catch (error) {
    console.error(`Shared context refresh failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "shared") {
  const action = args._[1] || "status";
  try {
    if (action === "init-repository") {
      console.log(JSON.stringify(initializeSharedRepository(root, { name: args.name || args.title || path.basename(root) }), null, 2));
      process.exit(0);
    }
    if (action === "bind") {
      if (!args.repository || args.repository === true || args.project === true) {
        throw new Error("Usage: context-room shared bind --root . --repository <git-url> [--project <projectId>]");
      }
      const detected = detectSharedProject(root, { repository: args.repository, projectId: args.project || "" });
      const bindingRoot = detected.projectRoot;
      const result = connectSharedContext(bindingRoot, {
        repository: args.repository,
        projectId: detected.projectId,
        sync: false,
      });
      if (!process.env.NODE_TEST_CONTEXT) registerContextHubSharedRepository(args.repository);
      if (!process.env.NODE_TEST_CONTEXT && fs.existsSync(path.join(bindingRoot, CONFIG_FILE))) {
        registerContextHubProject(bindingRoot, { shared: { repository: args.repository, projectId: detected.projectId } });
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    if (action === "setup" || action === "connect") {
      if (!args.repository || args.repository === true || args.project === true) {
        throw new Error("Usage: context-room shared setup --root . --repository <git-url> [--project <projectId>]");
      }
      const detected = detectSharedProject(root, { repository: args.repository, projectId: args.project || "" });
      const setupRoot = detected.projectRoot;
      initializeContextRoomProject(setupRoot);
      const result = connectSharedContext(setupRoot, { repository: args.repository, projectId: detected.projectId });
      if (!process.env.NODE_TEST_CONTEXT) {
        registerContextHubSharedRepository(args.repository);
        registerContextHubProject(setupRoot, { shared: { repository: args.repository, projectId: detected.projectId } });
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
    if (action === "sync") {
      console.log(JSON.stringify(syncSharedContext(root, { allowOffline: true }), null, 2));
      process.exit(0);
    }
    if (action === "status") {
      console.log(JSON.stringify(sharedContextStatus(root), null, 2));
      process.exit(0);
    }
    if (action === "secure-github") {
      console.log(JSON.stringify(secureSharedGitHubRepository(root), null, 2));
      process.exit(0);
    }
    if (action === "security-check") {
      const result = checkSharedGitHubSecurity(root);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.verified ? 0 : 1);
    }
    if (action === "proposals" || action === "list") {
      let proposals = listSharedProposals(root);
      if (args.project && args.project !== true) proposals = proposals.filter((proposal) => proposal.projectId === args.project);
      if (args.session && args.session !== true) proposals = proposals.filter((proposal) => proposal.sessionId === args.session);
      console.log(JSON.stringify(proposals, null, 2));
      process.exit(0);
    }
    if (action === "propose" || action === "proposal-create") {
      if (!args.description) throw new Error("--description is required when creating a proposal");
      console.log(JSON.stringify(ensureSharedProposal(root, {
        title: args.title || args.task || "Shared context change",
        description: args.description,
        scope: args.scope || "project",
        branch: args.branch || "",
        sessionId: args.session || process.env.CODEX_THREAD_ID || "",
      }), null, 2));
      process.exit(0);
    }
    if (action === "publish" || action === "proposal-push") {
      if (!args.proposal || args.proposal === true) throw new Error("--proposal requires a proposal/* branch");
      console.log(JSON.stringify(publishSharedProposal(root, {
        proposal: args.proposal,
        message: args.message,
        title: args.title,
        description: args.description,
      }), null, 2));
      process.exit(0);
    }
    if (action === "review") {
      if (!args.proposal || args.proposal === true) throw new Error("--proposal requires a proposal/* branch");
      const result = materializeSharedReview(root, { proposal: args.proposal });
      const config = result.repositoryConfig;
      const projectId = result.metadata.projectId;
      const projectPrefix = `${config.projectsPath}/${projectId}`;
      const allowedPaths = projectId === "global"
        ? [`${config.globalSkillsPath}/`]
        : [`${projectPrefix}/docs/`, `${projectPrefix}/skills/`];
      initializeContextRoomProject(result.reviewRoot, {
        title: `Review · ${args.proposal}`,
        allowedPaths,
        watchAllow: allowedPaths,
        reviewAgentInstructions: false,
      });
      const preferredPort = args.port === undefined ? 4317 : Number(args.port);
      const port = await selectAvailableContextRoomPort(preferredPort, { allowFallback: args.port === undefined });
      const { server } = createMemoryServer({ root: result.reviewRoot, port });
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => { server.off("error", onError); resolve(); });
      });
      console.log(`Context Room: http://127.0.0.1:${port}`);
      console.log(`Proposal: ${args.proposal}`);
      console.log(`Proposal head: ${result.metadata.proposalHead}`);
      console.log(`Review root: ${result.reviewRoot}`);
      process.on("SIGINT", () => server.close(() => process.exit(0)));
      process.on("SIGTERM", () => server.close(() => process.exit(0)));
      await new Promise(() => {});
    }
    throw new Error(`Unknown shared command: ${action}`);
  } catch (error) {
    console.error(`Shared context failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "context") {
  const action = args._[1] || "ask";
  if (action !== "ask") {
    console.error(`Unknown context command: ${action}`);
    process.exit(1);
  }
  const task = args.task && args.task !== true ? String(args.task) : args._.slice(2).join(" ").trim();
  if (!task) {
    console.error("Usage: context-room context ask \"what the agent needs to do\" [--root . | --repository <git-url> --project <project-id>] [--goal \"desired outcome\"] [--files path,...] [--depth quick|standard|exhaustive] [--budget 1200] [--session <task-id>] [--json]");
    process.exit(2);
  }
  try {
    const result = runDocumentationAgent({
      root,
      ...documentationTargetOptions,
      cliPath: fileURLToPath(import.meta.url),
      task,
      goal: args.goal && args.goal !== true ? String(args.goal) : "",
      files: splitList(args.files),
      depth: args.depth && args.depth !== true ? String(args.depth) : "standard",
      budget: args.budget === undefined ? undefined : args.budget,
      sessionId: args.session && args.session !== true ? String(args.session) : undefined,
    });
    if (args.json) console.log(JSON.stringify(result.packet, null, 2));
    else process.stdout.write(renderDocumentationPacket(result.packet));
    process.exit(0);
  } catch (error) {
    console.error(`Context Room documentation agent failed: ${error.message}`);
    process.exit(1);
  }
}

if (command === "docs") {
  const action = args._[1] || "capabilities";
  const selector = args._[2] || args.path || "";
  const sessionId = args.session && args.session !== true ? String(args.session) : "";
  try {
    if (action === "capabilities") {
      console.log(JSON.stringify(documentationCapabilities(root, { ...documentationTargetOptions, sessionId }), null, 2));
      process.exit(0);
    }
    if (action === "search") {
      const query = args.query && args.query !== true ? String(args.query) : args._.slice(2).join(" ").trim();
      console.log(JSON.stringify(searchDocumentation(root, query, {
        ...documentationTargetOptions,
        status: args.status && args.status !== true ? String(args.status) : "",
        kind: args.kind && args.kind !== true ? String(args.kind) : "",
        limit: args.limit,
        budget: args.budget,
        sessionId,
      }), null, 2));
      process.exit(0);
    }
    if (action === "read") {
      console.log(JSON.stringify(readDocumentation(root, selector, { ...documentationTargetOptions, section: args.section, budget: args.budget, sessionId }), null, 2));
      process.exit(0);
    }
    if (action === "related") {
      console.log(JSON.stringify(relatedDocumentation(root, selector, { ...documentationTargetOptions, sessionId }), null, 2));
      process.exit(0);
    }
    if (action === "trace") {
      console.log(JSON.stringify(traceDocumentation(root, selector, { ...documentationTargetOptions, section: args.section, sessionId }), null, 2));
      process.exit(0);
    }
    throw new Error(`Unknown docs command: ${action}`);
  } catch (error) {
    console.error(`Context Room docs failed: ${error.message}`);
    process.exit(1);
  }
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
  if (!process.env.NODE_TEST_CONTEXT) registerContextHubProject(root, { title: args.title });
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
    ({ server } = createMemoryServer({ root, port, registerInHub: true }));
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
