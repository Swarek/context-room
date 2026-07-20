import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);

export const CODEX_COMPOSER_INSERT_EVENT = "codex-micro-insert-composer-text";
export const MAX_CODEX_COMPOSER_TEXT_BYTES = 250_000;
export const CODEX_REFERENCE_AUTOCOMPLETE_TIMEOUT_MS = 2_500;

const CODEX_DECK_BRIDGE_STATE = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "CodexDeck",
  "codex-micro-bridge.json",
);

function normalizedDebugPort(value) {
  const port = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

export function codexRendererTargetPriority(target = {}) {
  if (target.type !== "page" || !target.webSocketDebuggerUrl || !String(target.url || "").startsWith("app://")) return -1;
  let pathname = "";
  let search = "";
  try {
    const url = new URL(target.url);
    pathname = url.pathname;
    search = url.search;
  } catch {
    return -1;
  }
  if (/avatar-overlay|composition-surface/i.test(target.url)) return 0;
  if (pathname === "/index.html" && !search) return 4;
  if (pathname === "/index.html") return 3;
  if (!target.url.includes("initialRoute=")) return 2;
  return 1;
}

export function selectCodexRendererTargets(targets = []) {
  return targets
    .map((target, index) => ({ target, index, priority: codexRendererTargetPriority(target) }))
    .filter((item) => item.priority > 0)
    .sort((left, right) => right.priority - left.priority || left.index - right.index)
    .map((item) => item.target);
}

export function buildCodexComposerInsertionExpression(text) {
  const value = String(text || "");
  if (!value.trim()) throw new Error("Codex composer text is required.");
  if (Buffer.byteLength(value, "utf8") > MAX_CODEX_COMPOSER_TEXT_BYTES) {
    throw new Error("Codex composer text is too large.");
  }
  return `(async () => {
    const text = ${JSON.stringify(value)};
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const likelyUrls = urls.filter((url) => /(?:vscode-api|codex-micro|app-initial|artifact-tab-content)/.test(url));
    let bus = null;
    for (const url of likelyUrls) {
      try {
        const namespace = await import(url);
        bus = [namespace.g, namespace.m, ...Object.values(namespace)].find((candidate) =>
          candidate && typeof candidate === 'object' && typeof candidate.dispatchHostMessage === 'function'
        ) ?? null;
        if (bus) break;
      } catch {}
    }
    if (!bus) return { inserted: false, reason: 'event-bus-unavailable' };
    const handlerCount = bus.handlers instanceof Map
      ? (bus.handlers.get(${JSON.stringify(CODEX_COMPOSER_INSERT_EVENT)})?.size ?? 0)
      : null;
    if (handlerCount === 0) return { inserted: false, reason: 'composer-handler-unavailable' };
    const composer = document.querySelector('[data-codex-composer="true"]');
    const existingDraft = typeof composer?.innerText === 'string' ? composer.innerText : '';
    bus.dispatchHostMessage({ type: ${JSON.stringify(CODEX_COMPOSER_INSERT_EVENT)}, text });
    const activeThreadKey = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
      ?.getAttribute('data-app-action-sidebar-thread-id')
      ?? document.querySelector('[data-above-composer-conversation-id]')
        ?.getAttribute('data-above-composer-conversation-id')
      ?? null;
    return { inserted: true, activeThreadKey, preservedDraft: Boolean(existingDraft.trim()) };
  })()`;
}

function normalizedReferencePath(value) {
  return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

export function codexNativeMentionPath(absolutePath, displayPath) {
  const absolute = normalizedReferencePath(absolutePath);
  const display = normalizedReferencePath(displayPath);
  if (!display) return "";
  if (!absolute.endsWith(`/${display}`)) return display;
  const root = absolute.slice(0, -(display.length + 1));
  const rootLabel = path.posix.basename(root);
  return rootLabel ? `${rootLabel}/${display}` : display;
}

export function codexReferenceLineLabel(startLine = 1, endLine = startLine) {
  const start = Math.max(1, Number.parseInt(String(startLine), 10) || 1);
  const end = Math.max(start, Number.parseInt(String(endLine), 10) || start);
  return start === end ? `L${start}` : `L${start}\u2013${end}`;
}

function quotedUnsavedSelection(text) {
  return String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function buildCompactCodexReferenceText({
  displayPath = "",
  startLine = 1,
  endLine = startLine,
  selectedText = "",
  dirty = false,
  nativeMention = false,
} = {}) {
  const cleanPath = normalizedReferencePath(displayPath);
  if (!cleanPath) throw new Error("Codex reference path is required.");
  const lineLabel = codexReferenceLineLabel(startLine, endLine);
  const prefix = nativeMention ? lineLabel : `@${cleanPath} ${lineLabel}`;
  if (!dirty) return `${prefix} `;
  const quote = quotedUnsavedSelection(selectedText);
  return `${prefix} \u00b7 unsaved${quote ? `\n${quote}` : ""}\n`;
}

export function codexMentionCandidateScore(candidate = {}, reference = {}) {
  const label = normalizedReferencePath(candidate.label).toLowerCase();
  const detail = normalizedReferencePath(candidate.detail).toLowerCase();
  const absolutePath = normalizedReferencePath(reference.absolutePath).toLowerCase();
  const displayPath = normalizedReferencePath(reference.displayPath).toLowerCase();
  const expectedLabel = path.posix.basename(displayPath || absolutePath).toLowerCase();
  if (!label || label !== expectedLabel) return -1;
  const candidatePath = normalizedReferencePath([detail, label].filter(Boolean).join("/"));
  if (candidatePath && absolutePath.endsWith(candidatePath)) return 20_000 + candidatePath.length;
  if (candidatePath && displayPath.endsWith(candidatePath)) return 10_000 + candidatePath.length;
  return detail ? -1 : 100;
}

export function selectCodexMentionCandidateIndex(candidates = [], reference = {}) {
  const scored = candidates
    .map((candidate, index) => ({ index, score: codexMentionCandidateScore(candidate, reference) }))
    .filter((item) => item.score >= 10_000)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  if (!scored.length) return -1;
  if (scored.length > 1 && scored[0].score === scored[1].score) return -1;
  return scored[0].index;
}

async function readBridgeStatePort(statePath = CODEX_DECK_BRIDGE_STATE) {
  try {
    const value = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return normalizedDebugPort(value?.port);
  } catch {
    return null;
  }
}

async function debugPortFromRunningProcess() {
  if (process.platform !== "darwin") return null;
  const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="], { timeout: 4_000 });
  for (const line of stdout.split("\n")) {
    if (!line.includes(".app/Contents/MacOS/")) continue;
    if (!/\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\//.test(line)) continue;
    if (!line.includes("--remote-debugging-address=127.0.0.1")) continue;
    const port = normalizedDebugPort(line.match(/--remote-debugging-port(?:=|\s+)(\d+)/)?.[1]);
    if (port) return port;
  }
  return null;
}

async function fetchJson(url, timeout = 1_200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new Error(`Codex debug endpoint returned HTTP ${response.status}.`);
  return response.json();
}

async function isCodexDebugPort(port) {
  if (!port) return false;
  try {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, 750);
    return selectCodexRendererTargets(targets).length > 0;
  } catch {
    return false;
  }
}

export async function discoverCodexDebugPort({ statePath = CODEX_DECK_BRIDGE_STATE } = {}) {
  const candidates = [];
  const configuredPort = normalizedDebugPort(process.env.CONTEXT_ROOM_CODEX_DEBUG_PORT);
  if (configuredPort) candidates.push(configuredPort);
  const statePort = await readBridgeStatePort(statePath);
  if (statePort && !candidates.includes(statePort)) candidates.push(statePort);
  for (const port of candidates) {
    if (await isCodexDebugPort(port)) return port;
  }
  const processPort = await debugPortFromRunningProcess();
  if (processPort && await isCodexDebugPort(processPort)) return processPort;
  const error = new Error("Codex is not running with its local composer bridge enabled.");
  error.code = "codex_composer_bridge_unavailable";
  error.statusCode = 503;
  throw error;
}

function evaluateRendererExpression(target, expression, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const requestId = 1;
    let settled = false;
    const timer = setTimeout(() => {
      finish(reject, new Error("Codex composer bridge timed out."));
    }, timeout);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      callback(value);
    };
    socket.once("open", () => {
      socket.send(JSON.stringify({
        id: requestId,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (message.id !== requestId) return;
      if (message.error) return finish(reject, new Error(message.error.message || "Codex composer bridge failed."));
      if (message.result?.exceptionDetails) {
        return finish(reject, new Error(
          message.result.exceptionDetails.exception?.description
          || message.result.exceptionDetails.text
          || "Codex renderer evaluation failed.",
        ));
      }
      finish(resolve, message.result?.result?.value);
    });
    socket.once("error", (error) => finish(reject, error));
    socket.once("close", () => finish(reject, new Error("Codex composer bridge closed before responding.")));
  });
}

async function openRendererSession(target, timeout = 8_000) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  let closed = false;
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Codex composer bridge timed out while connecting.")), timeout);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error) request.reject(new Error(message.error.message || "Codex renderer command failed."));
    else request.resolve(message);
  });
  socket.once("close", () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Codex composer bridge closed before responding."));
    }
    pending.clear();
  });
  await ready;
  return {
    request(method, params = {}) {
      if (closed) return Promise.reject(new Error("Codex composer bridge is closed."));
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex renderer command timed out: ${method}.`));
        }, timeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      if (!closed) socket.close();
    },
  };
}

async function rendererValue(session, expression, { awaitPromise = false } = {}) {
  const message = await session.request("Runtime.evaluate", {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (message.result?.exceptionDetails) {
    throw new Error(
      message.result.exceptionDetails.exception?.description
      || message.result.exceptionDetails.text
      || "Codex renderer evaluation failed.",
    );
  }
  return message.result?.result?.value;
}

async function dispatchRendererKey(session, key, options = {}) {
  const params = { key, ...options };
  await session.request("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await session.request("Input.dispatchKeyEvent", { type: "keyUp", ...params, text: undefined });
}

async function typeRendererText(session, text) {
  for (const character of Array.from(String(text || ""))) {
    await dispatchRendererKey(session, character, { text: character });
  }
}

async function eraseRendererText(session, text) {
  await dispatchRendererKey(session, "Escape", { code: "Escape" });
  await rendererValue(session, `(() => {
    const editor = document.querySelector('[data-codex-composer="true"] [contenteditable="true"], [contenteditable="true"]');
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  })()`);
  for (const _character of Array.from(String(text || ""))) {
    await dispatchRendererKey(session, "ArrowLeft", { code: "ArrowLeft", modifiers: 8 });
  }
  await dispatchRendererKey(session, "Backspace", { code: "Backspace" });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readMentionCandidates(session) {
  return rendererValue(session, `[
    ...document.querySelectorAll('[data-composer-overlay-floating-ui] [data-list-navigation-item="true"]')
  ].map((button) => {
    const lines = String(button.innerText || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
    return { label: lines[0] || '', detail: lines.slice(1).join('/') };
  })`);
}

async function waitForMentionCandidates(session, timeout = CODEX_REFERENCE_AUTOCOMPLETE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  let candidates = [];
  while (Date.now() < deadline) {
    candidates = await readMentionCandidates(session);
    if (candidates.length) return candidates;
    await delay(100);
  }
  return candidates;
}

async function insertFileReferenceInRenderer(target, reference, options = {}) {
  const session = await openRendererSession(target, options.timeout);
  const absolutePath = path.resolve(reference.absolutePath);
  const displayPath = normalizedReferencePath(reference.displayPath);
  const mentionPath = codexNativeMentionPath(absolutePath, displayPath);
  const queryText = `@${path.posix.basename(displayPath)}`;
  const nativeSuffix = buildCompactCodexReferenceText({ ...reference, displayPath, nativeMention: true });
  const fallbackText = buildCompactCodexReferenceText({ ...reference, displayPath, nativeMention: false });
  try {
    await session.request("Page.bringToFront").catch(() => {});
    const composer = await rendererValue(session, `(() => {
      const editor = document.querySelector('[data-codex-composer="true"] [contenteditable="true"], [contenteditable="true"]');
      if (!editor) return { ready: false };
      const host = editor.parentElement;
      const fiberKey = Object.getOwnPropertyNames(host || {}).find((key) => key.startsWith('__reactFiber$'));
      let fiber = host?.[fiberKey];
      while (fiber && !fiber.memoizedProps?.composerController) fiber = fiber.return;
      const controller = fiber?.memoizedProps?.composerController;
      if (controller?.view) {
        const { state, dispatch } = controller.view;
        const end = state.doc.content.size;
        const selection = state.selection.constructor.near(state.doc.resolve(end), -1);
        dispatch(state.tr.setSelection(selection));
        controller.view.focus();
      } else {
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      const exactMentions = [...editor.querySelectorAll('[at-mention-fs-path]')]
        .filter((mention) => mention.getAttribute('at-mention-fs-path') === ${JSON.stringify(absolutePath)}).length;
      const activeThreadKey = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
        ?.getAttribute('data-app-action-sidebar-thread-id')
        ?? document.querySelector('[data-above-composer-conversation-id]')
          ?.getAttribute('data-above-composer-conversation-id')
        ?? null;
      return { ready: true, hasDraft: Boolean(String(editor.innerText || '').trim()), exactMentions, activeThreadKey };
    })()`);
    if (!composer?.ready) return { inserted: false, reason: "composer-handler-unavailable" };
    if (composer.hasDraft) await session.request("Input.insertText", { text: " " });
    await typeRendererText(session, queryText);
    await rendererValue(session, `(() => {
      const editor = document.querySelector('[data-codex-composer="true"] [contenteditable="true"], [contenteditable="true"]');
      const host = editor?.parentElement;
      const fiberKey = Object.getOwnPropertyNames(host || {}).find((key) => key.startsWith('__reactFiber$'));
      let fiber = host?.[fiberKey];
      while (fiber && !fiber.memoizedProps?.composerController) fiber = fiber.return;
      const controller = fiber?.memoizedProps?.composerController;
      if (!controller || typeof controller.insertAtMention !== 'function') return false;
      try {
        controller.insertAtMention({
          label: ${JSON.stringify(path.posix.basename(displayPath))},
          path: ${JSON.stringify(mentionPath)},
          fsPath: ${JSON.stringify(absolutePath)},
          matchType: 'file'
        });
        return true;
      } catch {
        return false;
      }
    })()`);
    const controllerDeadline = Date.now() + 750;
    let controllerMentionCount = composer.exactMentions;
    while (Date.now() < controllerDeadline && controllerMentionCount <= composer.exactMentions) {
      await delay(40);
      controllerMentionCount = await rendererValue(session, `(() => {
        const editor = document.querySelector('[data-codex-composer="true"] [contenteditable="true"], [contenteditable="true"]');
        return [...(editor?.querySelectorAll('[at-mention-fs-path]') || [])]
          .filter((mention) => mention.getAttribute('at-mention-fs-path') === ${JSON.stringify(absolutePath)}).length;
      })()`);
    }
    if (controllerMentionCount > composer.exactMentions) {
      await session.request("Input.insertText", { text: nativeSuffix });
      return { inserted: true, nativeMention: true, activeThreadKey: composer.activeThreadKey, preservedDraft: composer.hasDraft };
    }
    const candidates = await waitForMentionCandidates(session, options.autocompleteTimeout);
    const candidateIndex = selectCodexMentionCandidateIndex(candidates, { absolutePath, displayPath });
    if (candidateIndex >= 0) {
      await rendererValue(session, `(() => {
        const items = [...document.querySelectorAll('[data-composer-overlay-floating-ui] [data-list-navigation-item="true"]')];
        const item = items[${candidateIndex}];
        if (!item) return false;
        item.click();
        return true;
      })()`);
      const deadline = Date.now() + 1_000;
      let mentionCount = composer.exactMentions;
      while (Date.now() < deadline && mentionCount <= composer.exactMentions) {
        await delay(50);
        mentionCount = await rendererValue(session, `(() => {
          const editor = document.querySelector('[data-codex-composer="true"] [contenteditable="true"], [contenteditable="true"]');
          return [...(editor?.querySelectorAll('[at-mention-fs-path]') || [])]
            .filter((mention) => mention.getAttribute('at-mention-fs-path') === ${JSON.stringify(absolutePath)}).length;
        })()`);
      }
      if (mentionCount > composer.exactMentions) {
        await session.request("Input.insertText", { text: nativeSuffix });
        return { inserted: true, nativeMention: true, activeThreadKey: composer.activeThreadKey, preservedDraft: composer.hasDraft };
      }
    }
    await eraseRendererText(session, queryText);
    await session.request("Input.insertText", { text: fallbackText });
    return { inserted: true, nativeMention: false, activeThreadKey: composer.activeThreadKey, preservedDraft: composer.hasDraft };
  } finally {
    session.close();
  }
}

export async function insertIntoActiveCodexComposer(text, options = {}) {
  const expression = buildCodexComposerInsertionExpression(text);
  const port = options.port || await discoverCodexDebugPort(options);
  const targets = selectCodexRendererTargets(await fetchJson(`http://127.0.0.1:${port}/json/list`));
  let lastReason = "renderer-unavailable";
  for (const target of targets) {
    const result = await evaluateRendererExpression(target, expression, options.timeout);
    if (result?.inserted) {
      return {
        inserted: true,
        activeThreadKey: result.activeThreadKey || null,
        preservedDraft: result.preservedDraft === true,
      };
    }
    lastReason = result?.reason || lastReason;
  }
  const error = new Error(lastReason === "composer-handler-unavailable"
    ? "The Codex composer bridge is not active in this Codex session."
    : "The active Codex composer could not be reached.");
  error.code = "codex_composer_bridge_inactive";
  error.statusCode = 503;
  throw error;
}

export async function insertFileReferenceIntoActiveCodexComposer(reference = {}, options = {}) {
  const absolutePath = String(reference.absolutePath || "").trim();
  const displayPath = normalizedReferencePath(reference.displayPath);
  const selectedText = typeof reference.selectedText === "string" ? reference.selectedText : "";
  if (!absolutePath || !displayPath) {
    const error = new Error("Codex reference file is required.");
    error.statusCode = 400;
    throw error;
  }
  if (Buffer.byteLength(selectedText, "utf8") > MAX_CODEX_COMPOSER_TEXT_BYTES) {
    const error = new Error("Codex reference selection is too large.");
    error.statusCode = 413;
    throw error;
  }
  const normalizedReference = {
    absolutePath: path.resolve(absolutePath),
    displayPath,
    startLine: Math.max(1, Number.parseInt(String(reference.startLine), 10) || 1),
    endLine: Math.max(1, Number.parseInt(String(reference.endLine), 10) || 1),
    selectedText,
    dirty: reference.dirty === true,
  };
  normalizedReference.endLine = Math.max(normalizedReference.startLine, normalizedReference.endLine);

  const port = options.port || await discoverCodexDebugPort(options);
  const targets = selectCodexRendererTargets(await fetchJson(`http://127.0.0.1:${port}/json/list`));
  let lastReason = "renderer-unavailable";
  for (const target of targets) {
    try {
      const result = await insertFileReferenceInRenderer(target, normalizedReference, options);
      if (result?.inserted) return result;
      lastReason = result?.reason || lastReason;
    } catch (error) {
      lastReason = error.message || lastReason;
    }
  }
  const error = new Error(lastReason === "composer-handler-unavailable"
    ? "The Codex composer bridge is not active in this Codex session."
    : "The active Codex composer could not be reached.");
  error.code = "codex_composer_bridge_inactive";
  error.statusCode = 503;
  throw error;
}
