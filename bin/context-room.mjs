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
  readMemoryWebappSettings,
  writeAgentCommand,
  CONFIG_FILE,
} from "../src/context_room.mjs";

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args._.push(arg);
      continue;
    }
    const key = arg.slice(2);
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
  return `Context Room\n\nUsage:\n  context-room init [--title "My Project"] [--allow docs/,src/] [--watch docs/]\n  context-room start [--port 4317] [--root .]\n  context-room doctor [--root .] [--strict]\n  context-room guard [--root .] [--profile advisory|review-only|strict]\n  context-room brief [--root .] [--task "what the agent will do"] [--limit 12]\n  context-room agent state [--root .]\n  context-room agent open [--root .] [--path docs/INDEX.md] [--view hub|settings|file|diff] [--heading "Purpose"] [--text "needle"] [--percent 50]\n  context-room agent annotate --root . --path docs/INDEX.md --note "Human-facing note" [--target "text"]\n  context-room agent queue [--root .]\n  context-room install-hook [--root .]\n  context-room update-all [--dry-run] [--no-restart] [--exclude /path]\n\nConfig: ${CONFIG_FILE}\n`;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] || "start";
const root = path.resolve(args.root || process.cwd());

if (args.help || args.h) {
  console.log(usage());
  process.exit(0);
}

if (command === "init") {
  const result = initializeContextRoomProject(root, {
    title: args.title,
    allowedPaths: splitList(args.allow),
    watchAllow: splitList(args.watch),
    preset: args.preset || "generic",
  });
  console.log(`Context Room initialized: ${result.configPath}`);
  console.log(`Run: context-room start --root ${root}`);
  process.exit(0);
}

if (command === "doctor") {
  const settings = readMemoryWebappSettings(root);
  const report = buildContextRoomDoctorReport(root);
  const blocking = report.issues.filter((issue) => ["critical", "high"].includes(issue.severity));
  console.log(`Context Room OK`);
  console.log(`Root: ${root}`);
  console.log(`Config: ${path.join(root, CONFIG_FILE)}`);
  console.log(`Allowed paths: ${settings.allowedPaths.length}`);
  console.log(`Watched paths: ${settings.watchAllow.length}`);
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
  const profile = args.strict ? "strict" : args.advisory ? "advisory" : String(args.profile || "advisory");
  const report = buildDocQaReport(root);
  const doctor = profile === "strict" || profile === "advisory" ? buildContextRoomDoctorReport(root) : null;
  const blockingHealth = doctor ? doctor.issues.filter((issue) => ["critical", "high"].includes(issue.severity)) : [];
  const shouldBlock = profile === "strict" && (report.queue.length || blockingHealth.length);
  if (report.queue.length) {
    const write = shouldBlock ? console.error : console.log;
    write(shouldBlock
      ? "Context Room guard blocked this commit: watched documentation changes need human review:"
      : "Context Room guard found watched documentation changes that need human review:");
    for (const item of report.queue) write(`- ${item.gitStatus.trim() || "changed"} ${item.path}`);
  }
  if (blockingHealth.length) {
    console.error("High-impact Context Room health issues:");
    for (const issue of blockingHealth.slice(0, 20)) console.error(`- [${issue.severity}] ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
  if (shouldBlock) {
    console.error(
      "\nOpen the Context Room webapp for the user, show the Changed files to review queue, and have the user review each diff before committing. Agents must not mark files verified on the user's behalf.",
    );
    if (blockingHealth.length) console.error("If strict health issues are listed, fix them before asking the user to verify.");
    process.exit(1);
  }
  if (profile !== "strict" && (report.queue.length || blockingHealth.length)) {
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

if (command === "install-hook") {
  const hooksDir = path.join(root, ".git", "hooks");
  if (!fs.existsSync(hooksDir)) {
    console.error(`No Git hooks directory found at ${hooksDir}`);
    process.exit(1);
  }
  const hookPath = path.join(hooksDir, "pre-commit");
  const cliPath = fileURLToPath(import.meta.url);
  const script = `#!/bin/sh\n# Installed by Context Room. Reports watched documentation changes without blocking commits.\nnode "${cliPath}" guard --root "${root}" --profile advisory\n`;
  fs.writeFileSync(hookPath, script, { mode: 0o755 });
  fs.chmodSync(hookPath, 0o755);
  console.log(`Context Room pre-commit hook installed: ${hookPath}`);
  process.exit(0);
}

if (command === "update-all") {
  const updateArgs = process.argv.slice(3);
  await updateAllContextRooms(updateArgs);
  process.exit(0);
}

if (command === "start") {
  const port = Number(args.port || 4317);
  initializeContextRoomProject(root, {});
  const { server } = createMemoryServer({ root, port });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Context Room: http://127.0.0.1:${port}`);
    console.log(`Root: ${root}`);
  });
} else {
  console.error(`Unknown command: ${command}\n`);
  console.error(usage());
  process.exit(1);
}
