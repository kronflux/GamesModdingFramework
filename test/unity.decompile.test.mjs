import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/engines/unity/index.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";

const fixture = fixturePath("unity-mono");
const il2cppFixture = fixturePath("unity-il2cpp");
const tempRoots = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function snapshot(dir, base = dir, out = new Map()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(base, full);
    if (entry.isDirectory()) snapshot(full, base, out);
    else out.set(relative, `${fs.statSync(full).size}:${fs.statSync(full).mtimeMs}`);
  }
  return out;
}

function makeToolCache(ids) {
  const cacheDir = tempDir("gmf-decompile-tools-");
  const manifest = {};
  for (const id of ids) {
    const file = path.join(cacheDir, id, `${id}.exe`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "SYNTHETIC TOOL");
    manifest[id] = {
      id,
      version: "test",
      path: file,
      args: [],
      verification: { kind: "none", value: null, ok: true },
      installedAt: new Date().toISOString(),
      source: { type: "local" },
    };
  }
  fs.writeFileSync(path.join(cacheDir, "tools.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return cacheDir;
}

function fakeRunner(calls) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const flags = ["-o", "--output-to", "--output-dir"];
    const index = flags.map((flag) => args.lastIndexOf(flag)).sort((a, b) => b - a)[0];
    const outputDir = index >= 0 ? args[index + 1] : null;
    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.writeFileSync(path.join(outputDir, `decompiled-${calls.length}.cs`), "// synthetic output");
    }
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

test("the operation chooses ilspycmd for Mono and writes under decompiled/", async () => {
  const workspace = { root: tempDir("gmf-decompile-ws-") };
  const cacheDir = makeToolCache(["ilspycmd"]);
  const calls = [];
  const before = snapshot(fixture);

  const result = await executeOperation(
    "unity.decompile",
    { gameDir: fixture, backend: "mono" },
    { workspace, toolCacheDir: cacheDir, runProcess: fakeRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);

  assert.ok(calls.length >= 1);
  for (const call of calls) {
    assert.match(call.cmd, /ilspycmd\.exe$/);
    assert.ok(call.args.includes("-p"), "ilspycmd decompiles a whole project");
    assert.ok(call.args.some((arg) => arg.toLowerCase().endsWith(".dll")));
  }
  assert.ok(
    calls.some((call) => call.args.some((arg) => arg.endsWith("Assembly-CSharp.dll"))),
    "the fixture managed assembly is decompiled",
  );
  assert.match(result.data.outputDir, /decompiled[\\/]unity[\\/]mono$/);
  assert.ok(fs.existsSync(result.data.outputDir));
  assert.ok(result.data.count >= 1);
  assert.match(result.data.report, /ilspycmd/);
  assert.deepEqual(snapshot(fixture), before, "decompile must not modify the game directory");
});

test("IL2CPP uses Cpp2IL when it is installed and falls back to Il2CppDumper", async () => {
  const workspace = { root: tempDir("gmf-decompile-il2cpp-ws-") };
  const calls = [];

  const cpp2ilCache = makeToolCache(["cpp2il"]);
  const withCpp2il = await executeOperation(
    "unity.decompile",
    { gameDir: il2cppFixture, backend: "il2cpp" },
    { workspace, toolCacheDir: cpp2ilCache, runProcess: fakeRunner(calls) },
  );
  assert.equal(withCpp2il.ok, true, withCpp2il.error?.message);
  assert.match(calls[0].cmd, /cpp2il\.exe$/);
  assert.ok(calls[0].args.includes("--game-path"));
  // Cpp2IL 2022.1 takes --output-as and --output-to; there is no --output-root option.
  assert.equal(calls[0].args[calls[0].args.indexOf("--output-as") + 1], "diffable-cs");
  assert.ok(calls[0].args.includes("--output-to"));
  assert.equal(calls[0].args.includes("--output-root"), false);
  assert.match(withCpp2il.data.report, /cpp2il/);

  calls.length = 0;
  const dumperCache = makeToolCache(["il2cppdumper"]);
  const withDumper = await executeOperation(
    "unity.decompile",
    { gameDir: il2cppFixture, backend: "il2cpp" },
    { workspace, toolCacheDir: dumperCache, runProcess: fakeRunner(calls) },
  );
  assert.equal(withDumper.ok, true, withDumper.error?.message);
  assert.match(calls[0].cmd, /il2cppdumper\.exe$/);
  assert.equal(calls[0].args.length, 3, "Il2CppDumper takes <executable> <metadata> <output-dir>");
  assert.equal(calls[0].args.some((arg) => arg.startsWith("--")), false);
});

test("Cpp2IL dummy assemblies go to their own folder and never replace the class dump", async () => {
  const workspace = { root: tempDir("gmf-decompile-dummy-ws-") };
  fs.mkdirSync(path.join(workspace.root, "dumps"), { recursive: true });
  const dumpFile = path.join(workspace.root, "dumps", "unity-il2cpp.json");
  fs.writeFileSync(dumpFile, '{"version":1,"classes":[{"name":"Kept"}]}');
  const calls = [];
  const result = await executeOperation(
    "unity.decompile",
    { gameDir: il2cppFixture, backend: "il2cpp", format: "dummydll" },
    { workspace, toolCacheDir: makeToolCache(["cpp2il"]), runProcess: fakeRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const outputTo = calls[0].args[calls[0].args.indexOf("--output-to") + 1];
  assert.equal(outputTo, path.join(workspace.root, "decompiled", "unity", "il2cpp", "DummyDll"));
  assert.equal(result.data.outputDir, outputTo);
  assert.equal(result.data.dump, null, "assemblies are not normalized");
  assert.equal(fs.readFileSync(dumpFile, "utf8"), '{"version":1,"classes":[{"name":"Kept"}]}');
});

test("a missing decompiler fails with GMF-E-TOOL-001 and a remediation command", async () => {
  const workspace = { root: tempDir("gmf-decompile-missing-ws-") };
  const cacheDir = makeToolCache([]);

  // The resolver falls back to PATH for known tool names. An empty PATH keeps
  // this case isolated from a machine that has ilspycmd installed globally.
  const previousPath = process.env.PATH;
  process.env.PATH = tempDir("gmf-empty-path-");
  try {
    const result = await executeOperation(
      "unity.decompile",
      { gameDir: fixture, backend: "mono" },
      { workspace, toolCacheDir: cacheDir },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "GMF-E-TOOL-001");
    assert.match(result.error.message, /ilspycmd/);
    assert.match(result.error.remediation, /tool install|GMF_TOOLS_DIR/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("an output directory outside the workspace is refused", async () => {
  const workspace = { root: tempDir("gmf-decompile-escape-ws-") };
  const cacheDir = makeToolCache(["ilspycmd"]);
  const outside = path.join(tempDir("gmf-decompile-outside-"), "decompiled");
  const calls = [];

  const result = await executeOperation(
    "unity.decompile",
    { gameDir: fixture, backend: "mono", outputDir: outside },
    { workspace, toolCacheDir: cacheDir, runProcess: fakeRunner(calls) },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /outside the workspace/i);
  assert.ok(!fs.existsSync(outside));
  assert.equal(calls.length, 0, "the decompiler never runs for a refused output folder");
  assert.deepEqual(fs.readdirSync(workspace.root), [], "nothing is written to the workspace");
});

test("an unknown backend is rejected before a tool runs", async () => {
  const workspace = { root: tempDir("gmf-decompile-backend-ws-") };
  const result = await executeOperation(
    "unity.decompile",
    { gameDir: fixture, backend: "native" },
    { workspace },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /backend/i);
});

// Stands in for "ilspycmd -p -o <dir> <assembly>": a project tree with one
// namespace folder and one class named after the assembly.
function ilspyRunner(calls) {
  return async (cmd, args) => {
    calls.push({ cmd, args });
    const out = args[args.indexOf("-o") + 1];
    const assembly = path.basename(args[args.length - 1], ".dll").replace(/\W/g, "");
    fs.mkdirSync(path.join(out, "Some.Namespace"), { recursive: true });
    fs.writeFileSync(
      path.join(out, "Some.Namespace", `${assembly}Class.cs`),
      `namespace Some.Namespace\n{\n    public class ${assembly}Class\n    {\n        public void Run() { }\n    }\n}\n`,
    );
    return { code: 0, stdout: "ok", stderr: "" };
  };
}

test("Mono assemblies decompile into one folder each and classes keep their assembly", async () => {
  const workspace = { root: tempDir("gmf-decompile-layout-ws-") };
  const calls = [];
  const result = await executeOperation(
    "unity.decompile",
    { gameDir: fixture, backend: "mono" },
    { workspace, toolCacheDir: makeToolCache(["ilspycmd"]), runProcess: ilspyRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  const base = path.join(workspace.root, "decompiled", "unity", "mono");
  const outputs = calls.map((call) => call.args[call.args.indexOf("-o") + 1]).sort();
  assert.deepEqual(outputs, [path.join(base, "Assembly-CSharp"), path.join(base, "UnityEngine.CoreModule")]);
  const dump = JSON.parse(fs.readFileSync(result.data.dump, "utf8"));
  const assemblyOf = Object.fromEntries(dump.classes.map((entry) => [entry.name, entry.assembly]));
  assert.deepEqual(assemblyOf, { AssemblyCSharpClass: "Assembly-CSharp", UnityEngineCoreModuleClass: "UnityEngine.CoreModule" });
});

test("a second Mono decompile drops the folders of the first and keeps unrelated files", async () => {
  const workspace = { root: tempDir("gmf-decompile-stale-ws-") };
  const base = path.join(workspace.root, "decompiled", "unity", "mono");
  const options = { workspace, toolCacheDir: makeToolCache(["ilspycmd"]), runProcess: ilspyRunner([]) };
  const first = await executeOperation("unity.decompile", { gameDir: fixture, backend: "mono" }, options);
  assert.equal(first.ok, true, first.error?.message);
  fs.writeFileSync(path.join(base, "Assembly-CSharp", "Gone.cs"), "// left by an older game version");
  fs.cpSync(path.join(base, "UnityEngine.CoreModule"), path.join(base, "RemovedAssembly"), { recursive: true });
  fs.writeFileSync(path.join(base, "notes.txt"), "mine");
  const second = await executeOperation("unity.decompile", { gameDir: fixture, backend: "mono" }, options);
  assert.equal(second.ok, true, second.error?.message);
  assert.equal(fs.existsSync(path.join(base, "Assembly-CSharp", "Gone.cs")), false);
  assert.equal(fs.existsSync(path.join(base, "RemovedAssembly")), false);
  assert.equal(fs.readFileSync(path.join(base, "notes.txt"), "utf8"), "mine");
  assert.equal(second.data.count, 2);
});

test("Il2CppDumper gets the executable, the metadata file and the output folder as positional arguments", async () => {
  const workspace = { root: tempDir("gmf-decompile-dumper-ws-") };
  const calls = [];
  const result = await executeOperation(
    "unity.decompile",
    { gameDir: il2cppFixture, backend: "il2cpp" },
    { workspace, toolCacheDir: makeToolCache(["il2cppdumper"]), runProcess: fakeRunner(calls) },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(calls[0].args, [
    path.join(il2cppFixture, "GameAssembly.dll"),
    path.join(il2cppFixture, "FixtureIl2Cpp_Data", "il2cpp_data", "Metadata", "global-metadata.dat"),
    path.join(workspace.root, "decompiled", "unity", "il2cpp", "Il2CppDumper"),
  ]);
});
