import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveAuthorization } from "./authorization.mjs";
import { readJson, writeJsonAtomic } from "./fsutil.mjs";

const MANIFEST = "tools.json";

export function toolCacheDir(env = process.env) {
  if (env.GMF_TOOLS_DIR) return path.resolve(env.GMF_TOOLS_DIR);
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "gmf", "tools");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "gmf", "tools");
  }
  return path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "gmf", "tools");
}

export function loadToolRegistry(catalog) {
  const registry = {};
  for (const tool of catalog?.tools || []) registry[tool.id] = tool;
  return registry;
}

function readManifest(cacheDir) {
  const manifest = readJson(path.join(cacheDir, MANIFEST), {});
  return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest : {};
}

function writeManifest(cacheDir, manifest) {
  writeJsonAtomic(path.join(cacheDir, MANIFEST), manifest);
}

function which(command) {
  const checker = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(checker, [command], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

const PATH_TOOLS = new Set(["dotnet", "ilspycmd", "python", "python3", "rea", "repak"]);

export function resolveTool(id, { cacheDir = toolCacheDir() } = {}) {
  const entry = readManifest(cacheDir)[id];
  if (entry && fs.existsSync(entry.path)) {
    return { cmd: entry.path, args: entry.args || [], path: entry.path, version: entry.version };
  }
  if (PATH_TOOLS.has(id)) {
    const found = which(id);
    if (found) return { cmd: found, args: [], path: found, version: "path" };
  }
  return null;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function copyRecursive(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyRecursive(path.join(source, entry.name), path.join(destination, entry.name));
    }
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

// GitHub publishes "sha256:<hex>" for each release asset. Verify the
// downloaded archive before extraction; an asset without a digest is recorded
// as unverified, never silently passed.
function verifyDigest(tool, asset, file) {
  const kind = tool.verify?.kind;
  if (kind !== "github-digest" && kind !== "sha256-or-size") return null;
  const published = typeof asset.digest === "string" ? asset.digest : "";
  if (!published.startsWith("sha256:")) {
    throw new Error(`verification failed: no published digest for ${asset.name}; pin a sha256 in the tool's verify entry or choose a release that publishes digests`);
  }
  const expected = published.slice("sha256:".length).toLowerCase();
  const actual = sha256File(file);
  if (actual !== expected) throw new Error(`verification failed: sha256 ${actual} != ${expected} for ${asset.name}`);
  return { kind: "github-digest", value: published, ok: true };
}

function verifyFile(tool, file) {
  const verify = tool.verify || {};
  if (verify.kind === "sha256" && verify.value) {
    const actual = sha256File(file);
    if (actual.toLowerCase() !== String(verify.value).toLowerCase()) {
      throw new Error(`verification failed: sha256 ${actual} != ${verify.value}`);
    }
    return { kind: "sha256", value: verify.value, ok: true };
  }
  if (verify.kind === "size" && Number.isFinite(verify.value)) {
    const actual = fs.statSync(file).size;
    if (actual !== verify.value) throw new Error(`verification failed: size ${actual} != ${verify.value}`);
    return { kind: "size", value: verify.value, ok: true };
  }
  return { kind: "none", value: null, ok: true };
}

export function verifyTool(id, { path: toolPath, catalog = null } = {}) {
  if (!toolPath || !fs.existsSync(toolPath)) return { ok: false, reason: "tool path does not exist" };
  if (!catalog) return { ok: true, reason: "existence only" };
  const tool = loadToolRegistry(catalog)[id];
  if (!tool) return { ok: true, reason: "no registry entry; existence only" };
  try {
    return { ok: true, ...verifyFile(tool, toolPath) };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

async function githubRelease(tool, fetchImpl) {
  const headers = { "User-Agent": "gmf", Accept: "application/vnd.github+json" };
  // A pinned tag, such as UE4SS's rolling experimental-latest, is fetched by
  // name. The release list is ordered by creation date, so a rolling tag
  // created long ago is not its first entry.
  if (tool.source.tag) {
    const tagged = await fetchImpl(
      `https://api.github.com/repos/${tool.source.repo}/releases/tags/${encodeURIComponent(tool.source.tag)}`,
      { headers },
    );
    if (!tagged.ok) throw new Error(`GitHub release lookup failed for tag ${tool.source.tag}: ${tagged.status}`);
    return tagged.json();
  }
  const response = await fetchImpl(`https://api.github.com/repos/${tool.source.repo}/releases`, { headers });
  if (!response.ok) throw new Error(`GitHub release lookup failed: ${response.status}`);
  const releases = await response.json();
  const usable = releases.filter(
    (release) => !release.draft && (tool.versionPolicy === "newest" || !release.prerelease),
  );
  if (usable.length === 0) throw new Error(`No release found for ${tool.source.repo}`);
  return usable[0];
}

// The entry file for this platform: tool.entries[platform], else tool.entry.
export function entryFor(tool, platform = process.platform) {
  return tool?.entries?.[platform] || tool?.entry || null;
}

// A tool may name one asset pattern, or one per platform in "assets"
// ({ win32, linux, darwin }), because releases list assets in no useful order
// and a loose pattern can match another platform's binary first.
export function selectAssetFor(tool, release, platform = process.platform) {
  const source = (tool.assets && tool.assets[platform]) || tool.asset || ".+";
  const pattern = new RegExp(source, "i");
  const asset = (release.assets || []).find((candidate) => pattern.test(candidate.name));
  if (!asset) throw new Error(`No asset matched ${source} for ${platform} in ${release.tag_name}`);
  return asset;
}

function selectAsset(tool, release) {
  return selectAssetFor(tool, release, process.platform);
}

// BepInEx bleeding-edge builds are listed newest first on an HTML page,
// with links such as /projects/bepinex_be/793/<artifact>.zip. There is no
// JSON API and no published checksum (checked 2026-11-07).
export function resolveBepInExArtifact(html, tool) {
  const base = new URL(tool.source.url);
  const pattern = new RegExp(tool.asset || ".+", "i");
  for (const match of String(html).matchAll(/href="([^"]*\/projects\/[^"/]+\/(\d+)\/([^"/]+))"/g)) {
    const name = decodeURIComponent(match[3]);
    if (!pattern.test(name)) continue;
    return { name, build: match[2], url: new URL(match[1], base.origin).href };
  }
  return null;
}

async function download(url, destination, fetchImpl) {
  const response = await fetchImpl(url, { headers: { "User-Agent": "gmf" } });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer);
}

// Git Bash puts GNU tar first on PATH, and GNU tar cannot read zip files.
// Windows ships bsdtar as System32/tar.exe, which reads zip, tar.gz and tar.xz.
export function tarCommand(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform !== "win32") return "tar";
  const systemTar = path.join(env.SystemRoot || env.windir || "C:/Windows", "System32", "tar.exe");
  return exists(systemTar) ? systemTar : "tar";
}

// The command that extracts an archive. Outside Windows tar is GNU tar, which cannot read zip
// files, so a zip goes to unzip there.
export function extractCommand(archive, destination, platform = process.platform) {
  if (platform !== "win32" && /[.]zip$/i.test(archive)) {
    return { command: "unzip", args: ["-q", "-o", archive, "-d", destination] };
  }
  return { command: tarCommand(platform), args: ["-xf", archive, "-C", destination] };
}

function extractArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const { command, args } = extractCommand(archive, destination);
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`Archive extraction failed: ${result.stderr || result.error?.message || command}`);
  }
  // A link entry could point a later entry outside the destination.
  const link = findSymlink(destination);
  if (link) throw new Error(`Archive extraction refused: ${path.relative(destination, link)} is a symbolic link`);
}

function findSymlink(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return full;
    if (entry.isDirectory()) {
      const found = findSymlink(full);
      if (found) return found;
    }
  }
  return null;
}

export async function installTool(
  id,
  {
    authorized = false,
    source = "",
    catalog = null,
    cacheDir = toolCacheDir(),
    fetchImpl = globalThis.fetch,
    spawn = spawnSync,
    python = null,
  } = {},
) {
  const tool = loadToolRegistry(catalog || {})[id];
  if (!tool) {
    const error = new Error(`GMF-E-TOOL-001: unknown tool ${id}`);
    error.code = "GMF-E-TOOL-001";
    throw error;
  }

  const effects = Array.isArray(tool.effects) && tool.effects.length > 0 ? tool.effects : ["toolInstall", "network"];
  const authorization = resolveAuthorization({
    effects,
    overrides: authorized ? effects.map((effect) => ({ effect, source: source || "authorized" })) : [],
  });
  if (!authorization.allowed) {
    const error = new Error(`GMF-E-GATE-001: ${id} requires authorization for ${effects.join(", ")}`);
    error.code = "GMF-E-GATE-001";
    throw error;
  }

  const version = tool.source?.version || "local";
  for (const [label, value] of [["id", id], ["version", version]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) {
      throw new Error(`GMF-E-TOOL-001: tool ${label} "${value}" is not a safe folder name`);
    }
  }
  // The install lands in a temp sibling and replaces the previous version only
  // after download, verification and extraction all succeeded.
  const finalDestination = path.join(cacheDir, id, version);
  const destination = `${finalDestination}.tmp-${process.pid}`;
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  try {
    return await installInto(destination, finalDestination);
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    // A tool folder that held only the failed attempt goes too.
    try {
      if (fs.readdirSync(path.dirname(destination)).length === 0) fs.rmdirSync(path.dirname(destination));
    } catch {
      // the folder is in use or already gone
    }
    throw error;
  }

  async function installInto(destination, finalDestination) {
  let entryPath;
  let githubVerification = null;
  let resolvedVersion = null;
  let releaseTag = null;
  if (tool.source?.type === "local") {
    const sourcePath = path.resolve(tool.source.path);
    if (!fs.existsSync(sourcePath)) throw new Error(`Local tool source does not exist: ${sourcePath}`);
    const stat = fs.statSync(sourcePath);
    if (stat.isDirectory()) {
      copyRecursive(sourcePath, destination);
      entryPath = path.join(destination, tool.entry || path.basename(sourcePath));
    } else {
      entryPath = path.join(destination, tool.entry || path.basename(sourcePath));
      fs.copyFileSync(sourcePath, entryPath);
    }
  } else if (tool.source?.type === "github") {
    const release = await githubRelease(tool, fetchImpl);
    const asset = { ...selectAsset(tool, release) };
    asset.name = safeName(asset.name);
    const archive = path.join(destination, asset.name);
    await download(asset.browser_download_url, archive, fetchImpl);
    githubVerification = verifyDigest(tool, asset, archive);
    resolvedVersion = asset.name.replace(/\.(zip|tar\.gz|tgz|tar\.xz|exe|dll)$/i, "");
    releaseTag = release.tag_name || null;
    if (/\.(zip|tar\.gz|tgz|tar\.xz)$/i.test(asset.name)) {
      extractArchive(archive, destination);
      fs.rmSync(archive, { force: true });
      entryPath = path.join(destination, entryFor(tool) || asset.name.replace(/\.(zip|tar\.gz|tgz|tar\.xz)$/i, ""));
    } else {
      entryPath = path.join(destination, asset.name);
    }
    if (entryFor(tool) && fs.existsSync(path.join(destination, entryFor(tool)))) {
      entryPath = path.join(destination, entryFor(tool));
    }
  } else if (tool.source?.type === "bepinex-be") {
    const page = await fetchImpl(tool.source.url, { headers: { "User-Agent": "gmf" } });
    if (!page.ok) throw new Error(`BepInEx build page lookup failed: ${page.status}`);
    const artifact = resolveBepInExArtifact(await page.text(), tool);
    if (!artifact) throw new Error(`No artifact matched ${tool.asset} on ${tool.source.url}`);
    artifact.name = safeName(artifact.name);
    const archive = path.join(destination, artifact.name);
    await download(artifact.url, archive, fetchImpl);
    // No checksum is published: record the hash of what was downloaded.
    githubVerification = { kind: "recorded-sha256", value: sha256File(archive), ok: true, published: false };
    resolvedVersion = artifact.name.replace(/\.(zip|tar\.gz|tgz|tar\.xz)$/i, "");
    releaseTag = `build ${artifact.build}`;
    if (/\.(zip|tar\.gz|tgz|tar\.xz)$/i.test(artifact.name)) {
      extractArchive(archive, destination);
      fs.rmSync(archive, { force: true });
    }
    entryPath = path.join(destination, tool.entry || artifact.name);
  } else if (tool.source?.type === "pypi") {
    // A Python package goes into its own virtual environment in the tool cache;
    // the tool is that environment's Python, with the package importable.
    const system = python || which("python") || which("python3");
    if (!system) {
      const error = new Error(`GMF-E-TOOL-001: ${id} needs Python 3 on PATH to create its environment.`);
      error.code = "GMF-E-TOOL-001";
      throw error;
    }
    const venv = path.join(destination, "venv");
    const run = (cmd, args) => {
      const result = spawn(cmd, args, { encoding: "utf8", windowsHide: true });
      if (result.status !== 0) {
        throw new Error(`${cmd} ${args.join(" ")} failed (exit ${result.status}): ${String(result.stderr || result.stdout || "").trim().slice(-400)}`);
      }
      return result;
    };
    run(system, ["-m", "venv", venv]);
    entryPath = process.platform === "win32" ? path.join(venv, "Scripts", "python.exe") : path.join(venv, "bin", "python");
    const spec = tool.source.version ? `${tool.source.package}==${tool.source.version}` : tool.source.package;
    run(entryPath, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", spec, ...(tool.source.extras || [])]);
    const module = tool.source.module || tool.source.package;
    const probe = run(entryPath, ["-c", `import ${module}; print(getattr(${module}, "__version__", "unknown"))`]);
    resolvedVersion = String(probe.stdout || "").trim() || "unknown";
    releaseTag = `pypi ${tool.source.package} ${resolvedVersion}`;
    // pip checks the download over TLS; no separate digest is published here.
    githubVerification = { kind: "pip", value: resolvedVersion, ok: true, published: false };
  } else {
    throw new Error(`Unsupported tool source: ${tool.source?.type}`);
  }

  if (!fs.existsSync(entryPath)) throw new Error(`Tool entry not found after install: ${entryPath}`);
  const verification = githubVerification || verifyFile(tool, entryPath);
  const installedVersion = resolvedVersion || version;
  const manifest = readManifest(cacheDir);
  fs.rmSync(finalDestination, { recursive: true, force: true });
  fs.renameSync(destination, finalDestination);
  entryPath = path.join(finalDestination, path.relative(destination, entryPath));
  manifest[id] = {
    id,
    version: installedVersion,
    release: releaseTag,
    path: entryPath,
    args: tool.args || [],
    verification,
    installedAt: new Date().toISOString(),
    source: tool.source,
  };
  writeManifest(cacheDir, manifest);
  return { version: installedVersion, release: releaseTag, path: entryPath, verification };
  }
}

// A remote asset or artifact name is used only as a file name inside the cache.
function safeName(name) {
  const base = path.basename(String(name || "").replace(/\\/g, "/"));
  if (!base || base === "." || base === "..") throw new Error(`GMF-E-TOOL-001: unusable asset name "${name}"`);
  return base;
}
