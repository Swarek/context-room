import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  acceptSharedReview,
  connectSharedContext,
  createSharedProposal,
  detectSharedProject,
  initializeSharedRepository,
  listSharedProposals,
  materializeSharedReview,
  publishSharedProposal,
  readSharedProjectConnection,
  sharedContextStatus,
  syncSharedContext,
} from "../src/shared_context.mjs";
import {
  initializeContextRoomProject,
  createMemoryServer,
  deleteMemoryPaths,
  listExplorerFiles,
  readMemoryWebappSettings,
  renderAppHtml,
  revertMemoryFile,
  writeMemoryFile,
} from "../src/context_room.mjs";

test("shared proposal selector and exact-hash owner acceptance are present in the UI", () => {
  const html = renderAppHtml();
  assert.match(html, /id="sharedProposalSelect"/);
  assert.match(html, /id="sharedProposalReview"/);
  assert.match(html, /id="sharedProposalAccept"/);
  assert.match(html, /expectedProposalHead: review\.proposalHead/);
});

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: options.stdio || ["ignore", "pipe", "pipe"] }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "shared-context@example.test"]);
  git(root, ["config", "user.name", "Shared Context Test"]);
}

function writeFile(root, relPath, content) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  fs.mkdirSync(project, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Fixture Shared Context" });
  writeFile(seed, "projects.json", JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  writeFile(seed, "projects/demo/skills/demo-workflow/SKILL.md", "---\nname: demo-workflow\ndescription: Demo project workflow.\n---\n\n# Demo workflow\n");
  writeFile(seed, "projects/demo/skills/demo-workflow/scripts/run.sh", "#!/bin/sh\nprintf 'demo\\n'\n");
  fs.chmodSync(path.join(seed, "projects/demo/skills/demo-workflow/scripts/run.sh"), 0o755);
  writeFile(seed, "skills/global/global-workflow/SKILL.md", "---\nname: global-workflow\ndescription: Demo global workflow.\n---\n\n# Global workflow\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared context"]);
  git(seed, ["push", "origin", "main"]);
  initializeContextRoomProject(project, { title: "Demo", allowedPaths: ["README.md"], watchAllow: [] });
  return { base, remote, seed, project };
}

function withSharedHome(t, fixture) {
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const home = path.join(fixture.base, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });
}

test("shared setup publishes an exact main snapshot and safe global/project skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const synced = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  assert.equal(readSharedProjectConnection(fixture.project).projectId, "demo");
  assert.equal(sharedContextStatus(fixture.project).revision, synced.revision);
  assert.equal(fs.readFileSync(path.join(synced.current, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nInitial.\n");
  assert.equal(fs.statSync(path.join(synced.current, "projects/demo/docs/README.md")).mode & 0o222, 0);

  const globalLink = path.join(process.env.HOME, ".codex/skills/global-workflow");
  const projectLink = path.join(fixture.project, ".codex/skills/demo-workflow");
  assert.equal(fs.lstatSync(globalLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(projectLink).isSymbolicLink(), true);
  assert.match(fs.realpathSync(globalLink), /snapshots\/[a-f0-9]{40}\/skills\/global\/global-workflow$/);
  assert.match(fs.realpathSync(projectLink), /snapshots\/[a-f0-9]{40}\/projects\/demo\/skills\/demo-workflow$/);
  assert.notEqual(fs.statSync(path.join(projectLink, "scripts/run.sh")).mode & 0o111, 0);
  assert.equal(fs.statSync(path.join(projectLink, "SKILL.md")).mode & 0o222, 0);

  const settings = readMemoryWebappSettings(fixture.project);
  assert.equal(settings.readOnlyPaths.length, 3);
  const sharedDoc = listExplorerFiles(fixture.project).find((file) => file.path.endsWith("/projects/demo/docs/README.md"));
  assert.equal(sharedDoc?.readOnly, true);
  assert.throws(() => writeMemoryFile(fixture.project, sharedDoc.path, "changed\n"), /read-only/);
});

test("a failed first sync rolls back the approved binding, current snapshot, and skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  fs.writeFileSync(path.join(fixture.project, ".context-room/config.json"), "{ invalid json\n", "utf8");

  assert.throws(
    () => connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" }),
    /JSON/,
  );
  assert.equal(readSharedProjectConnection(fixture.project), null);
  assert.equal(fs.existsSync(path.join(process.env.HOME, ".codex/skills/global-workflow")), false);
  assert.equal(fs.existsSync(path.join(fixture.project, ".codex/skills/demo-workflow")), false);
  const cacheDirectory = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .find((entry) => /^[a-f0-9]{16}$/.test(entry));
  assert.ok(cacheDirectory);
  assert.equal(fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, cacheDirectory, "current")), false);
});

test("rebinding replaces only the previously managed paths and skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const first = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const projectLink = path.join(fixture.project, ".codex/skills/demo-workflow");
  const firstTarget = fs.realpathSync(projectLink);
  const secondRemote = path.join(fixture.base, "second-remote.git");
  git(fixture.base, ["clone", "--bare", fixture.seed, secondRemote], { stdio: "ignore" });

  const second = connectSharedContext(fixture.project, { repository: secondRemote, projectId: "demo" });
  const secondTarget = fs.realpathSync(projectLink);
  assert.notEqual(secondTarget, firstTarget);
  assert.equal(secondTarget.includes(`/${path.basename(second.cacheRoot)}/snapshots/`), true);
  assert.equal(readSharedProjectConnection(fixture.project).repository, secondRemote);

  const settings = readMemoryWebappSettings(fixture.project);
  const firstCacheId = path.basename(first.cacheRoot);
  const secondCacheId = path.basename(second.cacheRoot);
  assert.equal(settings.allowedPaths.some((item) => item.includes(`/shared/${firstCacheId}/current/`)), false);
  assert.equal(settings.readOnlyPaths.some((item) => item.includes(`/shared/${firstCacheId}/current/`)), false);
  assert.equal(settings.allowedPaths.filter((item) => item.includes(`/shared/${secondCacheId}/current/`)).length, 3);
});

test("shared sync advances current atomically and keeps an explicit offline snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const initial = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Demo\n\nUpdated.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Update docs"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const updated = syncSharedContext(fixture.project, { allowOffline: false });
  assert.notEqual(updated.revision, initial.revision);
  assert.equal(fs.readFileSync(path.join(updated.current, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nUpdated.\n");

  fs.renameSync(fixture.remote, fixture.remote + ".offline");
  const offline = syncSharedContext(fixture.project, { allowOffline: true });
  assert.equal(offline.online, false);
  assert.equal(offline.revision, updated.revision);
  assert.match(offline.fetchError, /remote|repository|read/i);
});

test("proposal branches stay scoped and a partially accepted review lands on a newer non-conflicting main", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Clarify demo",
    branch: "proposal/demo/clarify-demo",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted sentence.\n\nRejected sentence.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Clarify demo docs" });
  assert.equal(published.files.includes("projects/demo/docs/README.md"), true);
  assert.equal(listSharedProposals(fixture.project).some((item) => item.branch === proposal.branch && item.head === published.head), true);

  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeFile(review.reviewRoot, "projects/demo/docs/README.md", "# Demo\n\nAccepted sentence.\n");

  writeFile(fixture.seed, "projects/demo/docs/OTHER.md", "# Other\n\nAlready accepted on main.\n");
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance main independently"]);
  git(fixture.seed, ["push", "origin", "main"]);

  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept selected demo changes" });
  assert.equal(accepted.accepted, true);
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nAccepted sentence.\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/OTHER.md")), true);
  assert.throws(() => acceptSharedReview(review.reviewRoot), /already accepted/);
});

test("review acceptance expires when the proposal branch changes", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Change", branch: "proposal/demo/change" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nFirst proposal.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });

  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nChanged proposal.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Change proposal after review" });
  assert.throws(() => acceptSharedReview(review.reviewRoot), /Proposal changed after review/);
});

test("project proposals cannot modify global or another project scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Escape", branch: "proposal/demo/escape" });
  writeFile(proposal.root, "skills/global/global-workflow/SKILL.md", "outside project scope\n");
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: proposal.branch }), /outside projects\/demo\//);
});

test("partial acceptance includes new files and omits rejected new files", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Add docs", branch: "proposal/demo/add-docs" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/ACCEPTED.md", "# Accepted\n");
  writeFile(proposal.root, "projects/demo/docs/REJECTED.md", "# Rejected\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  fs.unlinkSync(path.join(review.reviewRoot, "projects/demo/docs/REJECTED.md"));
  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot);
  assert.equal(accepted.accepted, true);

  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/ACCEPTED.md"), "utf8"), "# Accepted\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/REJECTED.md")), false);
});

test("remote proposal branches are revalidated before review", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  git(fixture.seed, ["switch", "-c", "proposal/demo/bypass"]);
  writeFile(fixture.seed, "projects/demo/UNREVIEWED.md", "# Outside review surface\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Bypass local CLI"]);
  git(fixture.seed, ["push", "origin", "proposal/demo/bypass"]);
  git(fixture.seed, ["switch", "main"]);

  assert.throws(
    () => materializeSharedReview(fixture.project, { proposal: "proposal/demo/bypass" }),
    /outside projects\/demo\/docs\/ or projects\/demo\/skills\//,
  );
});

test("proposal branch scope must match the requested scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.throws(
    () => createSharedProposal(fixture.project, { title: "Mismatch", scope: "project", branch: "proposal/global/mismatch" }),
    /branch scope must be proposal\/demo\//,
  );
});

test("shared proposals reject symlinks and binary files", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const symlinkProposal = createSharedProposal(fixture.project, { title: "Link", branch: "proposal/demo/link" });
  configureGit(symlinkProposal.root);
  fs.symlinkSync("/tmp", path.join(symlinkProposal.root, "projects/demo/docs/escape.md"));
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: symlinkProposal.branch }), /reject symlinks/);

  const binaryProposal = createSharedProposal(fixture.project, { title: "Binary", branch: "proposal/demo/binary" });
  configureGit(binaryProposal.root);
  fs.writeFileSync(path.join(binaryProposal.root, "projects/demo/docs/binary.md"), Buffer.from([0, 1, 2, 3]));
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: binaryProposal.branch }), /UTF-8 text/);
});

test("acceptance rejects manual changes outside the proposal scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Scoped", branch: "proposal/demo/scoped" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nScoped.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeFile(review.reviewRoot, "projects/demo/UNREVIEWED.md", "# Manual escape\n");
  assert.throws(() => acceptSharedReview(review.reviewRoot), /outside projects\/demo\/docs\/ or projects\/demo\/skills\//);
});

test("an invalid online manifest never silently falls back to the previous snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const manifestPath = path.join(fixture.seed, ".context-room/shared-repository.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.projectsPath = "projects/..";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  git(fixture.seed, ["add", manifestPath]);
  git(fixture.seed, ["commit", "-m", "Break shared manifest"]);
  git(fixture.seed, ["push", "origin", "main"]);
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: true }), /safe repository-relative path|normalized/);
});

test("sync removes only obsolete managed skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const managedLink = path.join(fixture.project, ".codex/skills/demo-workflow");
  assert.equal(fs.lstatSync(managedLink).isSymbolicLink(), true);
  fs.rmSync(path.join(fixture.seed, "projects/demo/skills/demo-workflow"), { recursive: true });
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Remove project skill"]);
  git(fixture.seed, ["push", "origin", "main"]);
  syncSharedContext(fixture.project, { allowOffline: false });
  assert.equal(fs.existsSync(managedLink), false);
  assert.throws(() => fs.lstatSync(managedLink), /ENOENT/);
});

test("shared read-only paths cannot be reverted or deleted through alternate mutations", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const sharedDoc = listExplorerFiles(fixture.project).find((file) => file.path.endsWith("/projects/demo/docs/README.md"));
  const sharedDocs = readMemoryWebappSettings(fixture.project).readOnlyPaths.find((item) => item.endsWith("/projects/demo/docs/"));
  assert.throws(() => revertMemoryFile(fixture.project, sharedDoc.path), /read-only/);
  assert.throws(() => deleteMemoryPaths(fixture.project, [sharedDocs]), /read-only/);
});

test("project catalog resolves nested cwd and the same binding in another worktree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const sourceRemote = path.join(fixture.base, "source.git");
  const firstClone = path.join(fixture.base, "source-one");
  const secondClone = path.join(fixture.base, "source-two");
  git(fixture.base, ["init", "--bare", "--initial-branch=main", sourceRemote], { stdio: "ignore" });
  git(fixture.base, ["clone", sourceRemote, firstClone], { stdio: "ignore" });
  configureGit(firstClone);
  writeFile(firstClone, "products/demo/website/README.md", "# Website\n");
  git(firstClone, ["add", "."]);
  git(firstClone, ["commit", "-m", "Initialize source"]);
  git(firstClone, ["push", "origin", "main"]);
  git(fixture.base, ["clone", sourceRemote, secondClone], { stdio: "ignore" });

  writeFile(fixture.seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo", source: { remotes: [sourceRemote], subpath: "products/demo" } }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "projects.json"]);
  git(fixture.seed, ["commit", "-m", "Register source mapping"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const firstProject = path.join(firstClone, "products/demo");
  const nested = path.join(firstProject, "website");
  initializeContextRoomProject(firstProject, { title: "Demo" });
  const detected = detectSharedProject(nested, { repository: fixture.remote });
  assert.equal(detected.projectId, "demo");
  assert.equal(detected.projectRoot, fs.realpathSync(firstProject));
  const explicit = detectSharedProject(nested, { repository: fixture.remote, projectId: "demo" });
  assert.equal(explicit.projectRoot, fs.realpathSync(firstProject));
  connectSharedContext(nested, { repository: fixture.remote, projectId: "demo" });
  assert.equal(readSharedProjectConnection(nested).projectRoot, fs.realpathSync(firstProject));
  assert.equal(fs.lstatSync(path.join(firstProject, ".codex/skills/demo-workflow")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(nested, ".codex/skills/demo-workflow")), false);

  const secondNested = path.join(secondClone, "products/demo/website");
  const secondConnection = readSharedProjectConnection(secondNested);
  assert.equal(secondConnection.projectId, "demo");
  assert.equal(secondConnection.projectRoot, fs.realpathSync(path.join(secondClone, "products/demo")));
});

test("shared Context Room API lists proposals and opens an exact review room", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "API review", branch: "proposal/demo/api-review" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAPI review.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const room = createMemoryServer({ root: fixture.project });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const sharedResponse = await fetch(origin + "/api/shared-context");
  const shared = await sharedResponse.json();
  assert.equal(shared.enabled, true);
  assert.equal(shared.mode, "project");
  assert.equal(shared.proposals.some((item) => item.branch === proposal.branch && item.head === published.head), true);

  const reviewResponse = await fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch }),
  });
  assert.equal(reviewResponse.status, 201);
  const opened = await reviewResponse.json();
  assert.equal(opened.review.proposalHead, published.head);
  assert.equal(readMemoryWebappSettings(opened.reviewRoot).reviewAgentInstructions, false);
  const exactResponse = await fetch(opened.url + "/api/shared-context");
  const exact = await exactResponse.json();
  assert.equal(exact.mode, "review");
  assert.equal(exact.review.proposalHead, published.head);

  const staleResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project") },
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40) }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "shared_context_proposal_head_mismatch");
});
