#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  CONFIG_DIR,
  CONFIG_FILE,
  createDefaultProjectConfig,
  initializeContextRoomProject,
  isAllowedMemoryPath,
  listMemoryFiles,
  readMemoryWebappSettings,
} from "../src/context_room.mjs";

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "context-room-"));
}

test("default config is project-agnostic and supports cards, nested cards, allowed paths, and watched paths", () => {
  const config = createDefaultProjectConfig({ title: "Demo Project" });

  assert.equal(CONFIG_DIR, ".context-room");
  assert.equal(CONFIG_FILE, ".context-room/config.json");
  assert.equal(config.title, "Demo Project");
  assert.match(config.$schema, /schemas\/config\.schema\.json$/);
  assert.deepEqual(config.watchAllow, []);
  assert.ok(config.allowedPaths.includes("docs/"));
  assert.ok(config.allowedPaths.includes("src/"));
  assert.ok(config.hubSections[0].cards.some((card) => card.id === "docs"));
  assert.ok(config.hubSections[0].cards.some((card) => (card.cards || []).length > 0));
});

test("init writes a reusable project config without LifeOS-specific paths", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");

  const result = initializeContextRoomProject(root, { title: "Demo", preset: "generic" });
  const configPath = path.join(root, CONFIG_FILE);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.equal(saved.title, "Demo");
  assert.match(saved.$schema, /schemas\/config\.schema\.json$/);
  assert.ok(saved.allowedPaths.includes("docs/"));
  assert.ok(saved.allowedPaths.includes("src/"));
  assert.equal(JSON.stringify(saved).includes("Life OS"), false);
  assert.equal(JSON.stringify(saved).includes(".lifeos"), false);
});

test("allowed paths are driven by project config", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/", "README.md"], watchAllow: ["docs/"] });
  const settings = readMemoryWebappSettings(root);

  assert.equal(isAllowedMemoryPath("docs/guide.md", settings), true);
  assert.equal(isAllowedMemoryPath("README.md", settings), true);
  assert.equal(isAllowedMemoryPath("src/private.js", settings), false);
  assert.equal(isAllowedMemoryPath("../secret.md", settings), false);
});

test("file listing follows project config and does not inject Hermes/LifeOS files by default", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "src/app.js"), "console.log('private');\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const paths = listMemoryFiles(root).map((file) => file.path);

  assert.deepEqual(paths, ["docs/guide.md"]);
  assert.equal(paths.some((item) => item.includes("~/.hermes")), false);
  assert.equal(paths.some((item) => item.includes(".lifeos")), false);
});

test("CLI init and doctor work in a fresh project", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");

  const cli = path.resolve("bin/context-room.mjs");
  execFileSync(process.execPath, [cli, "init", "--title", "CLI Demo", "--watch", "docs/"], { cwd: root, stdio: "pipe" });
  const doctor = execFileSync(process.execPath, [cli, "doctor"], { cwd: root, encoding: "utf8" });
  const saved = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));

  assert.equal(saved.title, "CLI Demo");
  assert.deepEqual(saved.watchAllow, ["docs/"]);
  assert.match(doctor, /Context Room OK/);
});
