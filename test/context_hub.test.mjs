import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  clearContextHubRuntime,
  listContextHubProjects,
  readContextHubRegistry,
  readContextHubRuntime,
  registerContextHubProject,
  registerContextHubSharedRepository,
  writeContextHubRuntime,
} from "../src/context_hub.mjs";
import {
  createMemoryServer,
  initializeContextRoomProject,
} from "../src/context_room.mjs";

function makeProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), `# ${name}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "hub@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Hub Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  return root;
}

function withHubHome(t, hubHome) {
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
  });
}

test("Context Hub registry keeps local projects and shared repositories independent", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-registry-"));
  withHubHome(t, path.join(base, "hub"));
  const first = makeProject(base, "First project");
  const registered = registerContextHubProject(first);
  registerContextHubSharedRepository("git@github.com:example/shared-context.git");

  const registry = readContextHubRegistry();
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].id, registered.id);
  assert.equal(registry.sharedRepositories.length, 1);
  assert.equal(listContextHubProjects()[0].available, true);
  assert.equal(fs.statSync(path.join(base, "hub")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(base, "hub", "registry.json")).mode & 0o777, 0o600);

  writeContextHubRuntime({ pid: 43210, port: 4319, root: first, url: "https://example.test/not-trusted" });
  assert.equal(readContextHubRuntime().port, 4319);
  assert.equal(readContextHubRuntime().url, "http://127.0.0.1:4319");
  assert.equal(clearContextHubRuntime(43210), true);
  assert.equal(readContextHubRuntime(), null);
});

test("Context Hub API combines local queues and opens another project in the same cockpit", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-api-"));
  withHubHome(t, path.join(base, "hub"));
  const first = makeProject(base, "First project");
  const second = makeProject(base, "Second project");
  fs.appendFileSync(path.join(second, "docs", "README.md"), "\nNeeds review.\n", "utf8");
  const firstEntry = registerContextHubProject(first);
  const secondEntry = registerContextHubProject(second);

  const room = createMemoryServer({ root: first });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const hubResponse = await fetch(origin + "/api/context-hub");
  assert.equal(hubResponse.status, 200);
  const hub = await hubResponse.json();
  assert.equal(hub.summary.localProjects, 2);
  assert.equal(hub.projects.some((project) => project.id === firstEntry.id && project.current), true);
  assert.equal(hub.items.some((item) => item.type === "local" && item.projectId === secondEntry.id && item.reviewStatus === "local_changes"), true);

  const openedResponse = await fetch(origin + "/api/context-hub/project", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ projectId: secondEntry.id }),
  });
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  assert.equal(opened.current, false);
  const healthResponse = await fetch(opened.url + "/api/health");
  const health = await healthResponse.json();
  assert.equal(fs.realpathSync(health.root), fs.realpathSync(second));
});
