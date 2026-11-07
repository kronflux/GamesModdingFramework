import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toolCacheDir, loadToolRegistry, resolveTool, installTool, verifyTool } from "../src/core/tools.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-tools-"));
const fixtureFile = path.join(root, "fake-tool.exe");
const cacheDir = path.join(root, "cache");
fs.writeFileSync(fixtureFile, "fake");

const tool = {
  id: "fake",
  name: "Fake",
  purpose: "test tool",
  engine: "core",
  license: "MIT",
  source: { type: "local", path: fixtureFile, version: "local" },
  versionPolicy: "local",
  asset: ".*",
  entry: "fake-tool.exe",
  verify: { kind: "size", value: 4 },
  effects: ["toolInstall", "network"],
  capabilities: ["test"],
};
const catalog = { version: 1, tools: [tool] };

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("toolCacheDir honors GMF_TOOLS_DIR", () => {
  assert.equal(toolCacheDir({ GMF_TOOLS_DIR: cacheDir }), path.resolve(cacheDir));
});

test("loadToolRegistry indexes tools by id", () => {
  assert.equal(loadToolRegistry(catalog).fake.name, "Fake");
});

test("a missing tool raises GMF-E-TOOL-001", async () => {
  await assert.rejects(
    () => installTool("missing", { authorized: true, source: "test", catalog, cacheDir }),
    /GMF-E-TOOL-001/,
  );
});

test("install copies a local tool, verifies it and resolves it", async () => {
  const result = await installTool("fake", { authorized: true, source: "test", catalog, cacheDir });
  assert.equal(result.version, "local");
  assert.ok(fs.existsSync(result.path));
  const resolved = resolveTool("fake", { cacheDir });
  assert.equal(resolved.version, "local");
  assert.equal(verifyTool("fake", { path: result.path, catalog }).ok, true);
});

test("a hash mismatch fails verification", async () => {
  const bad = { ...tool, id: "bad", verify: { kind: "sha256", value: "deadbeef" } };
  const badCatalog = { version: 1, tools: [bad] };
  const files = () => snapshotTree(cacheDir).filter((entry) => entry.kind !== "directory");
  const before = files();
  await assert.rejects(
    () => installTool("bad", { authorized: true, source: "test", catalog: badCatalog, cacheDir }),
    /verification|sha256/i,
  );
  assert.deepEqual(files(), before, "the unverified payload is not left in the cache");
  assert.ok(!fs.existsSync(path.join(cacheDir, "bad", "local")), "no version folder is created for the failed install");
});

test("install refuses without an authorization", async () => {
  const before = snapshotTree(cacheDir);
  await assert.rejects(
    () => installTool("fake", { authorized: false, source: "", catalog, cacheDir }),
    /GMF-E-GATE-001/,
  );
  assert.deepEqual(snapshotTree(cacheDir), before, "a refused install writes nothing to the cache");
});

test("a pypi tool installs into its own virtual environment and resolves to that Python", async () => {
  const pypi = {
    id: "pytool",
    name: "PyTool",
    purpose: "test python package",
    engine: "unity",
    license: "MIT",
    source: { type: "pypi", package: "PyTool", module: "pytool", extras: ["Pillow"] },
    versionPolicy: "newest",
    entry: null,
    verify: { kind: "none", value: null },
    effects: ["toolInstall", "network"],
    capabilities: ["test"],
  };
  const calls = [];
  const spawn = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === "-m" && args[1] === "venv") {
      const venvPython = process.platform === "win32" ? path.join(args[2], "Scripts", "python.exe") : path.join(args[2], "bin", "python");
      fs.mkdirSync(path.dirname(venvPython), { recursive: true });
      fs.writeFileSync(venvPython, "fake python");
    }
    if (args[0] === "-c") return { status: 0, stdout: "1.2.3\n", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  };
  const pyCache = path.join(root, "pycache");
  const result = await installTool("pytool", { authorized: true, source: "user: install it", catalog: { version: 1, tools: [pypi] }, cacheDir: pyCache, spawn, python: "python-on-path" });
  assert.equal(result.version, "1.2.3");
  assert.deepEqual(calls[0].slice(0, 3), ["python-on-path", "-m", "venv"]);
  const pip = calls.find((call) => call.includes("pip"));
  assert.ok(pip.includes("PyTool") && pip.includes("Pillow"), JSON.stringify(pip));
  // The environment is built in a temp sibling and renamed into place once
  // pip and the import probe succeed, so pip ran on the pre-rename path.
  assert.match(pip[0], /venv[\\/](Scripts[\\/]python\.exe|bin[\\/]python)$/, "pip runs inside the virtual environment");
  assert.ok(pip[0].startsWith(path.join(pyCache, "pytool")), pip[0]);
  const probe = calls.find((call) => call[1] === "-c");
  assert.ok(probe, "the import probe ran");
  assert.equal(probe[0], pip[0], "the import probe uses the virtual environment's Python, not the Python on PATH");
  assert.equal(result.path, path.join(pyCache, "pytool", "local", ...(process.platform === "win32" ? ["venv", "Scripts", "python.exe"] : ["venv", "bin", "python"])));
  const resolved = resolveTool("pytool", { cacheDir: pyCache });
  assert.equal(resolved.cmd, result.path);
  assert.deepEqual(resolved.args, []);
});

test("entryFor picks the platform's entry file, falling back to entry", async () => {
  const { entryFor } = await import("../src/core/tools.mjs");
  const tool = { entry: "Tool", entries: { win32: "Tool.exe" } };
  assert.equal(entryFor(tool, "win32"), "Tool.exe");
  assert.equal(entryFor(tool, "linux"), "Tool");
  assert.equal(entryFor({ entry: null }, "win32"), null);
});

test("a corrupt tools manifest is reported, not replaced", async () => {
  const brokenCache = path.join(root, "cache-broken");
  fs.mkdirSync(brokenCache, { recursive: true });
  const manifest = path.join(brokenCache, "tools.json");
  fs.writeFileSync(manifest, "{ broken");
  assert.throws(() => resolveTool("fake", { cacheDir: brokenCache }), (error) => error.code === "GMF-E-FILE-002");
  await assert.rejects(
    () => installTool("fake", { authorized: true, source: "test", catalog, cacheDir: brokenCache }),
    (error) => error.code === "GMF-E-FILE-002",
  );
  assert.equal(fs.readFileSync(manifest, "utf8"), "{ broken");
});
