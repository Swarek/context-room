import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: packageRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
});

if (packed.status !== 0) {
  process.stderr.write(packed.stderr || packed.stdout || "Unable to inspect the npm package.\n");
  process.exit(packed.status || 1);
}

let manifest;
try {
  [manifest] = JSON.parse(packed.stdout);
} catch (error) {
  process.stderr.write(`Unable to parse npm package manifest: ${error.message}\n`);
  process.exit(1);
}

const deniedTerms = String(process.env.CONTEXT_ROOM_PRIVACY_DENY || "")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const findings = [];
const patterns = [
  { label: "absolute user-home path", expression: /(?:\/Users\/|\/home\/)[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+/g },
  { label: "email address", expression: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, ignore: (value) => value.toLowerCase().startsWith("git@") },
];

for (const entry of manifest?.files || []) {
  const relativePath = String(entry.path || "").replaceAll("\\", "/");
  const absolutePath = path.resolve(packageRoot, relativePath);
  if (absolutePath !== packageRoot && !absolutePath.startsWith(packageRoot + path.sep)) {
    findings.push(`${relativePath}: package path escapes the repository`);
    continue;
  }
  let content;
  try { content = fs.readFileSync(absolutePath, "utf8"); } catch { continue; }
  for (const pattern of patterns) {
    const matches = [...content.matchAll(pattern.expression)].filter((match) => !pattern.ignore?.(match[0]));
    if (matches.length) findings.push(`${relativePath}: ${pattern.label}`);
  }
  const lowered = content.toLowerCase();
  for (const term of deniedTerms) {
    if (lowered.includes(term)) findings.push(`${relativePath}: denied release term`);
  }
}

if (findings.length) {
  process.stderr.write(`Package privacy check failed:\n${[...new Set(findings)].map((item) => `- ${item}`).join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Package privacy check OK (${manifest.files.length} files).\n`);
