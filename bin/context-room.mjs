#!/usr/bin/env node
import path from "node:path";
import { createMemoryServer, initializeContextRoomProject, readMemoryWebappSettings, CONFIG_FILE } from "../src/context_room.mjs";

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
  return `Context Room\n\nUsage:\n  context-room init [--title "My Project"] [--allow docs/,src/] [--watch docs/]\n  context-room start [--port 4317] [--root .]\n  context-room doctor [--root .]\n\nConfig: ${CONFIG_FILE}\n`;
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
  console.log(`Context Room OK`);
  console.log(`Root: ${root}`);
  console.log(`Config: ${path.join(root, CONFIG_FILE)}`);
  console.log(`Allowed paths: ${settings.allowedPaths.length}`);
  console.log(`Watched paths: ${settings.watchAllow.length}`);
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
