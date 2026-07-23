import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acceptSharedReview,
  checkSharedGitHubSecurity,
  connectSharedContext,
  createSharedProposal,
  detectSharedProject,
  ensureSharedProposal,
  initializeSharedRepository,
  listSharedRepositoryProposals,
  listSharedProposals,
  materializeSharedRepositoryReview,
  materializeSharedReview,
  publishSharedProposal,
  readSharedProjectConnection,
  resolveSharedSessionProposals,
  secureSharedGitHubRepository,
  sharedContextStatus,
  syncSharedContext,
} from "../src/shared_context.mjs";
import {
  buildDocumentationCorpus,
  readDocumentation,
  runDocumentationAgent,
  searchDocumentation,
} from "../src/doc_agent.mjs";
import {
  initializeContextRoomProject,
  contextHubUiState,
  createMemoryServer,
  deleteMemoryPaths,
  listExplorerFiles,
  readMemoryWebappSettings,
  renderAppHtml,
  revertMemoryFile,
  writeMemoryFile,
} from "../src/context_room.mjs";

const cli = fileURLToPath(new URL("../bin/context-room.mjs", import.meta.url));

test("shared proposal selector and exact-hash pull-request delivery are present in the UI", () => {
  const html = renderAppHtml();
  assert.match(html, /class="workspace-chrome"/);
  assert.match(html, /class="shared-context-heading"/);
  assert.match(html, />Choose proposal</);
  assert.match(html, /id="sharedProposalSelect"/);
  assert.match(html, /id="sharedProposalBrowser"/);
  assert.match(html, /id="sharedProposalWorkspace"/);
  assert.match(html, /id="contextHubOpen"/);
  assert.match(html, />Context Hub</);
  assert.match(html, />Local \+ shared</);
  assert.match(html, /Local files use the project review queue directly/);
  assert.match(html, /\/api\/context-hub\/review/);
  assert.match(html, /id="sharedProposalSearch"/);
  assert.match(html, /id="sharedProposalOverviewDescription"/);
  assert.match(html, /id="sharedProposalOverviewRecapLabel"/);
  assert.match(html, /Agent recap · updated with the latest publish/);
  assert.match(html, /id="sharedProposalFiles"/);
  assert.match(html, /id="sharedProposalOpenReview"/);
  assert.match(html, /\/?embedded=1/);
  assert.match(html, /id="sharedProposalReview"/);
  assert.match(html, /id="sharedProposalAccept"/);
  assert.match(html, /Open review/);
  assert.match(html, /expectedProposalHead: review\.proposalHead/);
  assert.match(html, /const wasOpen = state\.sharedProposalWorkspaceOpen/);
  assert.match(html, /Prepare pull request/);
  assert.doesNotMatch(html, /Accept into main/);
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

test("GitHub security setup installs and verifies a no-bypass pull-request ruleset", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-github-security-"));
  const repository = path.join(base, "shared");
  const fakeBin = path.join(base, "bin");
  const statePath = path.join(base, "ruleset.json");
  const keyStatePath = path.join(base, "deploy-key.json");
  const sharedHome = path.join(base, "shared-home");
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  initializeSharedRepository(repository, { name: "Secure shared context" });
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["remote", "add", "origin", "git@github.com:Acme/shared-context.git"]);
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args[1] || "";
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const statePath = process.env.FAKE_GH_STATE;
const keyStatePath = process.env.FAKE_GH_KEY_STATE;
const current = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
const currentKey = fs.existsSync(keyStatePath) ? JSON.parse(fs.readFileSync(keyStatePath, "utf8")) : null;
if (/\\/keys/.test(endpoint) && method === "POST") {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  const saved = { ...body, id: 84 };
  fs.writeFileSync(keyStatePath, JSON.stringify(saved));
  process.stdout.write(JSON.stringify(saved));
} else if (/\\/keys/.test(endpoint)) {
  process.stdout.write(JSON.stringify(currentKey ? [currentKey] : []));
} else if (method === "POST" || method === "PUT") {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  const saved = { ...body, id: 42, _links: { html: { href: "https://github.com/Acme/shared-context/rules/42" } } };
  fs.writeFileSync(statePath, JSON.stringify(saved));
  process.stdout.write(JSON.stringify(saved));
} else if (/\\/rulesets\\/42/.test(endpoint)) {
  process.stdout.write(JSON.stringify(current));
} else {
  process.stdout.write(JSON.stringify(current ? [{ id: 42, name: current.name }] : []));
}
`, "utf8");
  fs.chmodSync(fakeGh, 0o755);
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_GH_STATE;
  const previousKeyState = process.env.FAKE_GH_KEY_STATE;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_KEY_STATE = keyStatePath;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_GH_STATE;
    else process.env.FAKE_GH_STATE = previousState;
    if (previousKeyState === undefined) delete process.env.FAKE_GH_KEY_STATE;
    else process.env.FAKE_GH_KEY_STATE = previousKeyState;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });

  const secured = secureSharedGitHubRepository(repository);
  assert.equal(secured.verified, true);
  assert.equal(secured.rulesetCreated, true);
  assert.equal(Object.values(secured.checks).every(Boolean), true);
  const ruleset = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.equal(ruleset.rules.find((rule) => rule.type === "pull_request").parameters.required_approving_review_count, 0);
  const deployKey = JSON.parse(fs.readFileSync(keyStatePath, "utf8"));
  assert.equal(deployKey.read_only, false);
  assert.equal(git(repository, ["remote", "get-url", "origin"]), "git@github.com:Acme/shared-context.git");
  assert.match(git(repository, ["config", "--get", "core.sshCommand"]), /agent_ed25519/);
  assert.equal(checkSharedGitHubSecurity(repository).verified, true);
});

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

test("proposal branches stay scoped and partial acceptance becomes a PR branch on newer non-conflicting main", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Clarify demo",
    description: "Clarify the accepted and rejected sentences in the demo documentation.",
    branch: "proposal/demo/clarify-demo",
    sessionId: "task-clarify-123",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted sentence.\n\nRejected sentence.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Clarify demo docs" });
  assert.equal(published.files.includes("projects/demo/docs/README.md"), true);
  const listed = listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch);
  assert.equal(listed.head, published.head);
  assert.equal(listed.title, "Clarify demo");
  assert.equal(listed.description, "Clarify the accepted and rejected sentences in the demo documentation.");
  assert.equal(listed.sessionId, "task-clarify-123");
  assert.deepEqual(listed.files, ["projects/demo/docs/README.md"]);
  assert.equal(listed.fileCount, 1);

  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.equal(review.metadata.sessionId, "task-clarify-123");
  writeFile(review.reviewRoot, "projects/demo/docs/README.md", "# Demo\n\nAccepted sentence.\n");

  writeFile(fixture.seed, "projects/demo/docs/OTHER.md", "# Other\n\nAlready accepted on main.\n");
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance main independently"]);
  git(fixture.seed, ["push", "origin", "main"]);

  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept selected demo changes" });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.delivery, "pull-request");
  assert.match(accepted.acceptanceBranch, /^accepted\/demo\//);
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nInitial.\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/OTHER.md")), true);
  git(fixture.seed, ["fetch", "origin", accepted.acceptanceBranch]);
  assert.equal(
    git(fixture.seed, ["show", `origin/${accepted.acceptanceBranch}:projects/demo/docs/README.md`]),
    "# Demo\n\nAccepted sentence.",
  );
  assert.equal(
    git(fixture.seed, ["show", `origin/${accepted.acceptanceBranch}:projects/demo/docs/OTHER.md`]),
    "# Other\n\nAlready accepted on main.",
  );
  assert.throws(() => acceptSharedReview(review.reviewRoot), /already accepted/);
});

test("proposal updates require and expose fresh descriptive metadata, and expire an earlier review", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.throws(
    () => execFileSync(process.execPath, [cli, "shared", "propose", "--root", fixture.project, "--title", "Missing description"], { encoding: "utf8" }),
    (error) => /--description is required when creating a proposal/.test(String(error.stderr || "")),
  );
  const proposal = createSharedProposal(fixture.project, {
    title: "Change",
    description: "Describe the first proposal version.",
    branch: "proposal/demo/change",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nFirst proposal.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.equal(listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch).reviewStatus, "in_review");

  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nChanged proposal.\n");
  assert.throws(
    () => publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Change proposal after review" }),
    /--description is required whenever a published proposal is updated/,
  );
  const republished = publishSharedProposal(fixture.project, {
    proposal: proposal.branch,
    title: "Change demo guidance",
    description: "The updated proposal now replaces the first sentence with the final guidance.",
    message: "Change proposal after review",
  });
  const listed = listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch);
  assert.equal(listed.head, republished.head);
  assert.equal(listed.title, "Change demo guidance");
  assert.equal(listed.description, "The updated proposal now replaces the first sentence with the final guidance.");
  assert.equal(listed.reviewStatus, "updated");
  assert.equal(listed.updatedSinceReview, true);
  assert.throws(() => acceptSharedReview(review.reviewRoot), /Proposal changed after review/);
});

test("session-scoped proposal ensure reuses one workspace per project or global scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const first = ensureSharedProposal(fixture.project, {
    title: "Document the session",
    description: "Summarize every documentation change from this working session.",
    sessionId: "session-docs-123",
  });
  writeFile(first.root, "projects/demo/docs/README.md", "# Demo\n\nStill being edited.\n");
  const reused = ensureSharedProposal(fixture.project, {
    title: "A later message in the same session",
    description: "This input must not create another proposal workspace.",
    sessionId: "session-docs-123",
  });
  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(reused.branch, first.branch);
  assert.equal(reused.root, first.root);
  assert.equal(fs.readFileSync(path.join(reused.root, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nStill being edited.\n");

  const global = ensureSharedProposal(fixture.project, {
    title: "Update the global workflow",
    description: "Keep global skills in a separate proposal with the same session identity.",
    scope: "global",
    sessionId: "session-docs-123",
  });
  assert.equal(global.reused, false);
  assert.notEqual(global.branch, first.branch);
  assert.match(global.branch, /^proposal\/global\//);
});

test("a published session proposal can be rehydrated after its local workspace is removed", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = ensureSharedProposal(fixture.project, {
    title: "Resume on another checkout",
    description: "Publish a proposal that can be attached again from its commit metadata.",
    sessionId: "session-resume-123",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nPublished session proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const sharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const registryPath = fs.readdirSync(sharedHome)
    .map((entry) => path.join(sharedHome, entry, "proposals.json"))
    .find((candidate) => fs.existsSync(candidate));
  const checkout = path.join(path.dirname(registryPath), "repository");
  git(checkout, ["worktree", "remove", "--force", proposal.root]);
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.proposals[proposal.branch];
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

  const resumed = ensureSharedProposal(fixture.project, {
    title: "Ignored because the remote proposal is authoritative",
    description: "Ignored until the proposal is republished with a fresh cumulative description.",
    sessionId: "session-resume-123",
  });
  assert.equal(resumed.reused, true);
  assert.equal(resumed.branch, proposal.branch);
  assert.equal(git(resumed.root, ["rev-parse", "HEAD"]), published.head);
  assert.equal(fs.readFileSync(path.join(resumed.root, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nPublished session proposal.\n");
});

test("documentation research keeps accepted truth separate from the current session proposal overlay", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const projectProposal = ensureSharedProposal(fixture.project, {
    title: "Document pending session behavior",
    description: "Add one pending project document and delete one accepted project document.",
    sessionId: "session-overlay-a",
  });
  configureGit(projectProposal.root);
  writeFile(projectProposal.root, "projects/demo/docs/PENDING.md", "# Pending session\n\nPending session alpha.\n");
  fs.rmSync(path.join(projectProposal.root, "projects/demo/docs/README.md"));
  publishSharedProposal(fixture.project, { proposal: projectProposal.branch });

  const globalProposal = ensureSharedProposal(fixture.project, {
    title: "Update global workflow",
    description: "Add pending global guidance for this same documentation session.",
    scope: "global",
    sessionId: "session-overlay-a",
  });
  configureGit(globalProposal.root);
  writeFile(globalProposal.root, "skills/global/global-workflow/SKILL.md", "---\nname: global-workflow\ndescription: Demo global workflow.\n---\n\n# Global workflow\n\nGlobal pending alpha.\n");
  publishSharedProposal(fixture.project, { proposal: globalProposal.branch });

  const otherSession = ensureSharedProposal(fixture.project, {
    title: "Another session",
    description: "This proposal must remain invisible to session overlay A.",
    sessionId: "session-overlay-b",
  });
  configureGit(otherSession.root);
  writeFile(otherSession.root, "projects/demo/docs/OTHER-SESSION.md", "# Other session\n\nInvisible session beta.\n");
  publishSharedProposal(fixture.project, { proposal: otherSession.branch });

  const corpus = buildDocumentationCorpus(fixture.project, { sessionId: "session-overlay-a" });
  assert.equal(corpus.session.id, "session-overlay-a");
  assert.equal(corpus.session.proposals.length, 2);
  assert.ok(corpus.documents.some((document) => document.source === "shared-accepted" && document.repositoryPath === undefined));
  assert.equal(corpus.documents.some((document) => /OTHER-SESSION/.test(document.repositoryPath || "")), false);

  const defaultSearch = searchDocumentation(fixture.project, "Pending session alpha", { sessionId: "session-overlay-a" });
  assert.equal(defaultSearch.results.some((result) => result.truthState === "proposal"), false);
  const pendingSearch = searchDocumentation(fixture.project, "Pending session alpha", { sessionId: "session-overlay-a", status: "proposal" });
  assert.equal(pendingSearch.results[0].repositoryPath, "projects/demo/docs/PENDING.md");
  assert.equal(pendingSearch.results[0].proposal.sessionId, "session-overlay-a");
  assert.equal(pendingSearch.results[0].proposal.head, pendingSearch.results[0].revision);
  const deletion = searchDocumentation(fixture.project, "Deleted in session proposal", { sessionId: "session-overlay-a", status: "proposal" });
  assert.equal(deletion.results[0].repositoryPath, "projects/demo/docs/README.md");
  assert.equal(deletion.results[0].deleted, true);

  const frozen = resolveSharedSessionProposals(fixture.project, { sessionId: "session-overlay-a" });
  const packet = {
    summary: "The current session proposes one pending project-document change.",
    currentFacts: [],
    constraints: [],
    decisions: [],
    targetDifferences: [],
    pendingSessionChanges: [{
      claim: "The proposal adds pending session alpha.",
      path: pendingSearch.results[0].path,
      repositoryPath: pendingSearch.results[0].repositoryPath,
      section: pendingSearch.results[0].section,
      truthState: "proposal",
      revision: pendingSearch.results[0].revision,
      contentHash: pendingSearch.results[0].contentHash,
      deleted: false,
      proposal: pendingSearch.results[0].proposal,
    }],
    unknowns: [],
    conflicts: [],
    optionalReads: [],
    coverage: { project: "demo", docsRevision: "replaced", scope: "standard", sourcesExamined: 1, pathsExamined: [pendingSearch.results[0].path] },
  };
  const researched = runDocumentationAgent({
    root: fixture.project,
    cliPath: cli,
    task: "Use the pending session documentation",
    sessionId: "session-overlay-a",
    proposalOverlay: frozen,
    codexBin: "/test/codex",
    spawnSyncImpl() { return { status: 0, signal: null, stdout: JSON.stringify(packet), stderr: "" }; },
  });
  assert.equal(researched.packet.pendingSessionChanges[0].proposal.head, pendingSearch.results[0].proposal.head);
  const wrongHead = structuredClone(packet);
  wrongHead.pendingSessionChanges[0].proposal.head = "f".repeat(40);
  assert.throws(() => runDocumentationAgent({
    root: fixture.project,
    cliPath: cli,
    task: "Reject stale pending evidence",
    sessionId: "session-overlay-a",
    proposalOverlay: frozen,
    codexBin: "/test/codex",
    spawnSyncImpl() { return { status: 0, signal: null, stdout: JSON.stringify(wrongHead), stderr: "" }; },
  }), /exact proposal head/);

  writeFile(projectProposal.root, "projects/demo/docs/PENDING.md", "# Pending session\n\nPending session alpha, second head.\n");
  publishSharedProposal(fixture.project, {
    proposal: projectProposal.branch,
    description: "Keep the deletion and replace the pending project guidance with its second version.",
  });
  const frozenCorpus = buildDocumentationCorpus(fixture.project, { sessionId: "session-overlay-a", proposalOverlay: frozen });
  const frozenPath = frozenCorpus.documents.find((document) => document.repositoryPath === "projects/demo/docs/PENDING.md").path;
  assert.doesNotMatch(readDocumentation(fixture.project, frozenPath, { corpus: frozenCorpus }).content, /second head/);
  const liveCorpus = buildDocumentationCorpus(fixture.project, { sessionId: "session-overlay-a" });
  const livePath = liveCorpus.documents.find((document) => document.repositoryPath === "projects/demo/docs/PENDING.md").path;
  assert.match(readDocumentation(fixture.project, livePath, { corpus: liveCorpus }).content, /second head/);

  const sharedOnlyRoot = path.join(fixture.base, "shared-only-cwd");
  fs.mkdirSync(sharedOnlyRoot, { recursive: true });
  const sharedOnlyOptions = {
    repository: fixture.remote,
    projectId: "demo",
    sessionId: "session-overlay-a",
  };
  const sharedOnlyCorpus = buildDocumentationCorpus(sharedOnlyRoot, sharedOnlyOptions);
  assert.equal(sharedOnlyCorpus.target.mode, "shared-only");
  assert.equal(sharedOnlyCorpus.target.projectId, "demo");
  assert.equal(sharedOnlyCorpus.revision.local, "not-applicable");
  assert.equal(sharedOnlyCorpus.revision.shared, sharedOnlyCorpus.session.proposals[0].baseRevision);
  assert.equal(sharedOnlyCorpus.documents.some((document) => document.path === "projects/demo/docs/README.md" && document.source === "shared-accepted"), true);
  assert.equal(sharedOnlyCorpus.documents.some((document) => document.path === "projects/demo/skills/demo-workflow/SKILL.md"), true);
  assert.equal(sharedOnlyCorpus.documents.some((document) => document.path === "skills/global/global-workflow/SKILL.md"), true);
  assert.equal(sharedOnlyCorpus.documents.some((document) => /OTHER-SESSION/.test(document.repositoryPath || "")), false);
  assert.equal(fs.existsSync(path.join(sharedOnlyRoot, ".context-room")), false);
  const sharedOnlyDefault = searchDocumentation(sharedOnlyRoot, "Pending session alpha", sharedOnlyOptions);
  assert.equal(sharedOnlyDefault.results.some((result) => result.truthState === "proposal"), false);
  const sharedOnlyPending = searchDocumentation(sharedOnlyRoot, "second head", { ...sharedOnlyOptions, status: "proposal" });
  assert.equal(sharedOnlyPending.results[0].repositoryPath, "projects/demo/docs/PENDING.md");
  const sharedOnlyPacket = structuredClone(packet);
  sharedOnlyPacket.pendingSessionChanges = [{
    claim: "The latest proposal updates the pending session guidance.",
    path: sharedOnlyPending.results[0].path,
    repositoryPath: sharedOnlyPending.results[0].repositoryPath,
    section: sharedOnlyPending.results[0].section,
    truthState: "proposal",
    revision: sharedOnlyPending.results[0].revision,
    contentHash: sharedOnlyPending.results[0].contentHash,
    deleted: false,
    proposal: sharedOnlyPending.results[0].proposal,
  }];
  sharedOnlyPacket.coverage.pathsExamined = [sharedOnlyPending.results[0].path];

  const fakeCodex = path.join(fixture.base, "shared-only-codex.mjs");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!prompt.includes("--repository") || !prompt.includes("--project") || !process.env.CONTEXT_ROOM_DOC_ACCEPTED_REVISION) process.exit(9);
  process.stdout.write(${JSON.stringify(JSON.stringify(sharedOnlyPacket))});
});
`, "utf8");
  fs.chmodSync(fakeCodex, 0o755);
  const sharedOnlyCli = spawnSync(process.execPath, [
    cli,
    "context", "ask", "Use the pending session documentation",
    `--repository=${fixture.remote}`,
    "--project=demo",
    "--session=session-overlay-a",
    "--json",
  ], {
    cwd: sharedOnlyRoot,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_ROOM_CODEX_BIN: fakeCodex, NODE_TEST_CONTEXT: "1" },
  });
  assert.equal(sharedOnlyCli.status, 0, sharedOnlyCli.stderr);
  assert.equal(JSON.parse(sharedOnlyCli.stdout).pendingSessionChanges[0].proposal.sessionId, "session-overlay-a");
  assert.equal(fs.existsSync(path.join(sharedOnlyRoot, ".context-room")), false);
});

test("a registered shared repository can be browsed and reviewed without a local project connection", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Shared-only review",
    description: "Review this proposal directly from the global Context Hub.",
    branch: "proposal/demo/shared-only",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nShared-only review.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const repositoryState = listSharedRepositoryProposals(fixture.remote, { allowOffline: false });
  assert.equal(repositoryState.projects.some((project) => project.id === "demo"), true);
  assert.equal(repositoryState.proposals.some((item) => item.branch === proposal.branch && item.head === published.head), true);
  const review = materializeSharedRepositoryReview(fixture.remote, { proposal: proposal.branch });
  assert.equal(review.metadata.proposalHead, published.head);
  assert.equal(review.metadata.repository, fixture.remote);
});

test("Context Hub exposes global proposal scopes as filterable shared projects", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Global workflow update",
    description: "Update the workflow shared by every connected project.",
    scope: "global",
    branch: "proposal/global/workflow-update",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "skills/global/global-workflow/SKILL.md", "# Updated global workflow\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const hub = contextHubUiState(fixture.project);
  const globalProject = hub.projects.find((project) => project.projectKey.endsWith(":global"));
  assert.equal(globalProject?.title, "Global skills");
  assert.equal(globalProject?.mode, "shared");
  assert.equal(globalProject?.sharedProposalCount, 1);
  assert.equal(hub.proposals.find((item) => item.branch === proposal.branch)?.projectKey, globalProject.projectKey);
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
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/ACCEPTED.md")), false);
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/REJECTED.md")), false);
  git(fixture.seed, ["fetch", "origin", accepted.acceptanceBranch]);
  assert.equal(git(fixture.seed, ["show", `origin/${accepted.acceptanceBranch}:projects/demo/docs/ACCEPTED.md`]), "# Accepted");
  assert.throws(() => git(fixture.seed, ["cat-file", "-e", `origin/${accepted.acceptanceBranch}:projects/demo/docs/REJECTED.md`]));
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

  const reopenedResponse = await fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch }),
  });
  assert.equal(reopenedResponse.status, 201);
  const reopened = await reopenedResponse.json();
  assert.equal(reopened.url, opened.url);
  assert.equal(reopened.reviewRoot, opened.reviewRoot);

  const staleResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project") },
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40) }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "shared_context_proposal_head_mismatch");
});
