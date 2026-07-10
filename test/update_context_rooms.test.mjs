import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextRoomInstanceFromProcess,
  isDevelopmentCheckout,
  selectRestartableInstances,
  tokenizeCommand,
} from "../scripts/update-context-rooms.mjs";

test("update command tokenizes quoted project paths", () => {
  assert.deepEqual(
    tokenizeCommand('node /opt/context-room.mjs start --root "/tmp/My Project" --port 4320'),
    ["node", "/opt/context-room.mjs", "start", "--root", "/tmp/My Project", "--port", "4320"],
  );
});

test("running Context Room processes expose their resolved root and port", () => {
  const instance = contextRoomInstanceFromProcess({
    pid: 42,
    cwd: "/tmp",
    command: "node /opt/context-room.mjs start --root project --port=4320",
  });

  assert.deepEqual(instance, {
    pid: 42,
    root: path.resolve("/tmp/project"),
    port: 4320,
    command: "node /opt/context-room.mjs start --root project --port=4320",
  });
  assert.equal(contextRoomInstanceFromProcess({ pid: 43, cwd: "/tmp", command: "/bin/bash node context-room.mjs start" }), null);
});

test("development checkouts and explicit paths are excluded from restarts", () => {
  const developmentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-development-"));
  fs.mkdirSync(path.join(developmentRoot, ".git"));
  fs.mkdirSync(path.join(developmentRoot, "bin"));
  fs.mkdirSync(path.join(developmentRoot, "src"));
  fs.writeFileSync(path.join(developmentRoot, "package.json"), JSON.stringify({ name: "context-room" }));
  fs.writeFileSync(path.join(developmentRoot, "bin", "context-room.mjs"), "");
  fs.writeFileSync(path.join(developmentRoot, "src", "context_room.mjs"), "");

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-project-"));
  const ignoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-ignored-"));
  const instances = [
    { pid: 1, root: developmentRoot, port: 4319 },
    { pid: 2, root: projectRoot, port: 4317 },
    { pid: 3, root: ignoredRoot, port: 4318 },
  ];

  assert.equal(isDevelopmentCheckout(developmentRoot), true);
  const selected = selectRestartableInstances(instances, [ignoredRoot]);
  assert.deepEqual(selected.restartable, [{ ...instances[1], root: fs.realpathSync(projectRoot) }]);
  assert.deepEqual(selected.excluded, [
    { ...instances[0], root: fs.realpathSync(developmentRoot) },
    { ...instances[2], root: fs.realpathSync(ignoredRoot) },
  ]);
});
