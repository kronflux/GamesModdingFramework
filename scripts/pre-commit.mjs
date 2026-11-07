import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Files whose content is game content, a loader binary, a dump or an extracted
// asset. None of these may be committed.
export const GAME_CONTENT_EXTENSIONS = new Set([
  ".dll",
  ".pak",
  ".uasset",
  ".umap",
  ".ubulk",
  ".uexp",
  ".utoc",
  ".ucas",
  ".usmap",
  ".assets",
  ".bundle",
  ".unity3d",
  ".ress",
  ".resource",
  ".bank",
  ".bnk",
  ".wem",
  ".awb",
  ".acb",
  ".cpk",
  ".sig",
  ".blob",
]);

export const FORBIDDEN_NAMES = new Set([
  "winhttp.dll",
  "version.dll",
  "dwmapi.dll",
  "d3d11.dll",
  "dxgi.dll",
  "bepinex.dll",
  "bepinex.unity.il2cpp.dll",
  "bepinex.unity.mono.dll",
  "melonloader.dll",
  "ue4ss.dll",
  "gameassembly.dll",
  "unityplayer.dll",
  "global-metadata.dat",
]);

const SECRET_PATTERNS = [
  { name: "private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "AWS access key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "API key literal", regex: /\bsk-(?:live|test|proj|ant)-[A-Za-z0-9_-]{12,}\b/ },
  {
    name: "assigned secret",
    regex: /(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'`][^"'`\s]{12,}["'`]/i,
  },
];

const TEXT_EXTENSIONS = new Set([
  ".mjs",
  ".js",
  ".cjs",
  ".json",
  ".md",
  ".markdown",
  ".txt",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".ps1",
  ".sh",
  ".bash",
  ".py",
  ".cs",
  ".cpp",
  ".cc",
  ".c",
  ".h",
  ".hpp",
  ".lua",
  ".xml",
  ".html",
  ".css",
  ".env",
  ".properties",
  ".gradle",
  ".rs",
  ".go",
  ".java",
]);

const TEXT_NAMES = new Set([".env", ".gitignore", ".npmrc", ".prettierrc"]);
const SKIP_DIRS = new Set([".git", "node_modules", "backups", "decompiled", "extracted", "dumps", "logs", "coverage", ".venv"]);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function walk(dir, files, root) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), files, root);
    } else if (entry.isFile()) {
      files.push(path.join(dir, entry.name));
    }
  }
}

// Checks one file's content under its repository-relative path. content is a
// Buffer or string; a path is enough for the name checks.
export function checkContent(relative, content) {
  const lower = path.basename(relative).toLowerCase();
  const extension = path.extname(lower);
  const violations = [];
  const syntheticFixture = relative.startsWith("test/fixtures/");

  if (!syntheticFixture && GAME_CONTENT_EXTENSIONS.has(extension)) {
    violations.push({ path: relative, kind: "game-content", detail: `game content extension ${extension}` });
  }
  if (!syntheticFixture && FORBIDDEN_NAMES.has(lower)) {
    violations.push({ path: relative, kind: "game-content", detail: `loader or game binary ${lower}` });
  }

  const envFile = lower === ".env" || lower.startsWith(".env.");
  if (!TEXT_EXTENSIONS.has(extension) && !TEXT_NAMES.has(lower) && !envFile) return violations;
  if (content === null || content === undefined) return violations;

  let textContent = Buffer.isBuffer(content) ? content.toString("utf8") : String(content);
  if (textContent.includes("\u0000")) return violations;
  if (textContent.length > MAX_TEXT_BYTES) textContent = textContent.slice(0, MAX_TEXT_BYTES);

  const lines = textContent.split(/\r?\n/);
  for (const pattern of SECRET_PATTERNS) {
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.regex.test(lines[index])) {
        violations.push({ path: relative, kind: "secret", detail: `${pattern.name} on line ${index + 1}` });
        break;
      }
    }
  }
  return violations;
}

export function checkFile(file, root = process.cwd()) {
  const relative = toPosix(path.relative(root, file));
  let content = null;
  try {
    content = fs.readFileSync(file);
  } catch {
    content = null;
  }
  return checkContent(relative, content);
}

// Scan explicit paths when given, otherwise every text file under the root.
export function scanPaths(root = process.cwd(), paths = null) {
  const files = [];
  if (Array.isArray(paths) && paths.length > 0) {
    for (const item of paths) {
      const resolved = path.isAbsolute(item) ? item : path.join(root, item);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) files.push(resolved);
    }
  } else {
    walk(root, files, root);
  }

  const violations = [];
  for (const file of files.sort()) violations.push(...checkFile(file, root));
  return { ok: violations.length === 0, violations, scanned: files.length };
}

export function stagedFiles(root = process.cwd()) {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).filter(Boolean);
}

// The staged blob for a path, read from the index, because the working copy
// may already differ from what will be committed.
export function stagedContent(root, relative) {
  const result = spawnSync("git", ["show", `:${relative}`], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  return result.stdout;
}

// Scans the staged blobs. ok is false when git cannot list the index.
export function scanStaged(root = process.cwd()) {
  const staged = stagedFiles(root);
  if (staged === null) {
    return { ok: false, violations: [{ path: ".", kind: "git", detail: "git diff --cached failed; is this a git repository?" }], scanned: 0 };
  }
  const violations = [];
  for (const relative of staged.sort()) {
    violations.push(...checkContent(relative, stagedContent(root, relative)));
  }
  return { ok: violations.length === 0, violations, scanned: staged.length };
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const paths = argv.filter((argument) => !argument.startsWith("--"));
  const result = paths.length === 0 && argv.includes("--staged") ? scanStaged(root) : scanPaths(root, paths.length > 0 ? paths : null);
  if (result.ok) {
    console.log(`pre-commit: ${result.scanned} file(s) clean`);
    return 0;
  }
  for (const violation of result.violations) {
    console.error(`${violation.path}: ${violation.kind}: ${violation.detail}`);
  }
  console.error(`pre-commit: ${result.violations.length} problem(s) found; remove the game content or secret`);
  return 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  process.exitCode = main();
}
