import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside, readJson, writeJsonAtomic } from "./fsutil.mjs";

export const CONFIG_FILE = "gmf.json";
export const LOCAL_FILE = "gmf.local.json";
export const PROFILE_FILE = "gmf.profile.json";
export const PLAN_FILE = "gmf.plan.json";

export const AGENTS_FILE = "AGENTS.md";

const WORKSPACE_TEMPLATES = fileURLToPath(new URL("../../templates/workspace/", import.meta.url));

export function renderWorkspaceTemplate(name, values = {}) {
  const text = fs.readFileSync(path.join(WORKSPACE_TEMPLATES, name), "utf8");
  // Values are one line of plain text: no control characters, so a value cannot
  // add lines or sections to a generated instruction file.
  const clean = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (Object.hasOwn(values, key) ? clean(values[key]) : match));
}

const writeJson = writeJsonAtomic;

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function findWorkspaceRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readWorkspace(start = process.cwd()) {
  const root = findWorkspaceRoot(start);
  if (!root) return null;
  return {
    root,
    config: readJson(path.join(root, CONFIG_FILE), { version: 1, game: {} }),
    local: readJson(path.join(root, LOCAL_FILE), { version: 1 }),
    profile: readJson(path.join(root, PROFILE_FILE), null),
  };
}

export function initWorkspace({ gameDir, workspaceDir = process.cwd(), author = "" } = {}) {
  if (!gameDir) throw new Error("gameDir is required");
  const resolvedGame = path.resolve(gameDir);
  const resolvedWorkspace = path.resolve(workspaceDir);
  if (!fs.existsSync(resolvedGame)) throw new Error(`Game directory does not exist: ${resolvedGame}`);
  fs.mkdirSync(resolvedWorkspace, { recursive: true });

  const configPath = path.join(resolvedWorkspace, CONFIG_FILE);
  const existingConfig = readJson(configPath, null);
  const config = {
    version: 1,
    ...existingConfig,
    game: {
      name: existingConfig?.game?.name || path.basename(resolvedGame) || "Game",
      engine: existingConfig?.game?.engine || "unknown",
      author: author || existingConfig?.game?.author || "",
      ...existingConfig?.game,
    },
    package: existingConfig?.package || {},
  };
  if (author) config.game.author = author;
  const written = [];
  const skipped = [];
  const record = (rel, existed) => (existed ? skipped : written).push(rel);

  record(CONFIG_FILE, existingConfig !== null);
  writeJson(configPath, config);

  const localPath = path.join(resolvedWorkspace, LOCAL_FILE);
  const existingLocal = readJson(localPath, null);
  record(LOCAL_FILE, existingLocal !== null);
  writeJson(localPath, { version: 1, ...existingLocal, gameDir: resolvedGame });

  const values = {
    gameName: config.game.name,
    engine: config.game.engine,
    author: config.game.author,
  };
  const files = [
    [AGENTS_FILE, renderWorkspaceTemplate("AGENTS.md.tpl", values)],
    ["CLAUDE.md", renderWorkspaceTemplate("CLAUDE.md.tpl", values)],
    [".gitignore", renderWorkspaceTemplate("gitignore.tpl", values)],
    ["mods/.gitkeep", ""],
  ];
  for (const [rel, content] of files) {
    const target = path.join(resolvedWorkspace, ...rel.split("/"));
    if (fs.existsSync(target)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(rel);
  }

  return { ...readWorkspace(resolvedWorkspace), written, skipped };
}

export function writeProfile(workspace, profile) {
  writeJson(path.join(workspace.root, PROFILE_FILE), profile);
  return profile;
}

export function readProfile(workspace) {
  return readJson(path.join(workspace.root, PROFILE_FILE), null);
}

export function assertInside(workspace, targetPath) {
  const root = path.resolve(workspace.root);
  const target = path.resolve(targetPath);
  if (!isInside(root, target)) {
    throw new Error(`Path is outside the workspace: ${target}`);
  }
  return target;
}

export function backupFile(workspace, gamePath) {
  const source = path.resolve(gamePath);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`Not a file: ${source}`);
  const sha256 = sha256File(source);
  const dir = path.join(workspace.root, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const backupPath = path.join(dir, `${sha256.slice(0, 12)}-${path.basename(source)}`);
  // An existing file under that name is reused only when it is the same bytes.
  if (!fs.existsSync(backupPath) || sha256File(backupPath) !== sha256) fs.copyFileSync(source, backupPath);
  return { backupPath, sha256 };
}

export { readJson, writeJson };
