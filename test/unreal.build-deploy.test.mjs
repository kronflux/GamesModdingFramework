import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const fixtures = fixturePath("unreal");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unreal-build-"));

after(() => fs.rmSync(root, { recursive: true, force: true }));

function workspaceAt(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { root: dir, config: { version: 1 }, local: { version: 1 }, profile: null };
}

function copyFixture(name, target) {
  fs.cpSync(path.join(fixtures, name), target, { recursive: true });
  return target;
}

async function scaffoldLua(workspace, name) {
  const result = await executeOperation(
    "unreal.scaffold",
    { name, author: "Tester", type: "lua" },
    { workspace },
  );
  assert.equal(result.ok, true, result.error?.message);
  return path.join(workspace.root, "mods", name);
}

test("a Lua mod deploys to the UE4SS Mods folder, validate runs the Lua checks, and a second deploy backs up the first", async () => {
  const workspace = workspaceAt("ws-flow");
  const gameDir = copyFixture("ue4ss-game", path.join(root, "game-flow"));
  const modDir = await scaffoldLua(workspace, "FixtureMod");
  const context = { workspace, authorizations: [{ effect: "gameWrite", source: "test: game write" }] };

  const first = await executeOperation("unreal.deploy", { modDir, gameDir, type: "lua" }, context);
  assert.equal(first.ok, true, first.error?.message);
  const deployedMain = path.join(gameDir, "ue4ss", "Mods", "FixtureMod", "Scripts", "main.lua");
  assert.ok(fs.existsSync(deployedMain));
  assert.ok(fs.existsSync(path.join(gameDir, "ue4ss", "Mods", "FixtureMod", "enabled.txt")));
  assert.equal(first.data.backup.length, 0);

  const validation = await executeOperation("unreal.validate", { modDir, gameDir, type: "lua" }, context);
  assert.equal(validation.ok, true, validation.error?.message);
  assert.equal(validation.data.ok, true);
  assert.ok(validation.data.errors.length === 0);
  assert.ok(validation.data.warnings.some((warning) => /UE4SS log/.test(warning)));

  fs.writeFileSync(deployedMain, '-- second version of main.lua\nlocal MOD_NAME = "FixtureMod"\n');
  const second = await executeOperation("unreal.deploy", { modDir, gameDir, type: "lua" }, context);
  assert.equal(second.ok, true, second.error?.message);
  const backup = second.data.backup.find((entry) => entry.target.endsWith("main.lua"));
  assert.ok(backup, "a second deploy must back up the overwritten main.lua");
  assert.ok(fs.existsSync(backup.path));
  assert.match(fs.readFileSync(backup.path, "utf8"), /second version of main\.lua/);
  assert.match(fs.readFileSync(deployedMain, "utf8"), /FixtureMod/);
});

test("validate reports a missing module field", async () => {
  const workspace = workspaceAt("ws-validate");
  const gameDir = copyFixture("ue4ss-game", path.join(root, "game-validate"));
  const modDir = await scaffoldLua(workspace, "ValidateMod");
  const main = path.join(modDir, "Scripts", "main.lua");
  const source = fs.readFileSync(main, "utf8").replace(/^local MOD_NAME = .*\r?\n/m, "");
  fs.writeFileSync(main, source);

  const result = await executeOperation("unreal.validate", { modDir, gameDir, type: "lua" }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.ok, false);
  assert.ok(result.data.errors.some((error) => /module field MOD_NAME/.test(error)));
});

test("validate reports a module field that the required module does not define", async () => {
  const workspace = workspaceAt("ws-validate-fields");
  const modDir = await scaffoldLua(workspace, "FieldMod");
  fs.writeFileSync(
    path.join(modDir, "Scripts", "main.lua"),
    'local MOD_NAME = "FieldMod"\nlocal core = require("core.util")\ncore.init({})\n',
  );
  fs.writeFileSync(path.join(modDir, "Scripts", "core", "util.lua"), "local M = {}\n\nreturn M\n");

  const result = await executeOperation("unreal.validate", { modDir, type: "lua" }, {});
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.ok, false);
  assert.ok(result.data.errors.some((error) => /module field core\.init/.test(error)));
});

test("deploy refuses to overwrite without a workspace backup", async () => {
  const workspace = workspaceAt("ws-no-backup");
  const gameDir = copyFixture("ue4ss-game", path.join(root, "game-no-backup"));
  const modDir = await scaffoldLua(workspace, "NoBackupMod");

  const first = await executeOperation("unreal.deploy", { modDir, gameDir, type: "lua" }, { workspace, authorizations: [{ effect: "gameWrite", source: "test: game write" }] });
  assert.equal(first.ok, true, first.error?.message);
  const target = path.join(gameDir, "ue4ss", "Mods", "NoBackupMod", "Scripts", "main.lua");
  const before = '-- keep me\nlocal MOD_NAME = "NoBackupMod"\n';
  fs.writeFileSync(target, before);

  const second = await executeOperation("unreal.deploy", { modDir, gameDir, type: "lua" }, { authorizations: [{ effect: "gameWrite", source: "test: game write" }] });
  assert.equal(second.ok, false);
  assert.equal(second.error.code, "GMF-E-GATE-001");
  assert.match(second.error.message, /without a workspace backup/);
  assert.equal(fs.readFileSync(target, "utf8"), before);
});

test("package writes a zip with the mod files", async () => {
  const workspace = workspaceAt("ws-package");
  const modDir = await scaffoldLua(workspace, "PackageMod");
  const result = await executeOperation("unreal.package", { modDir }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.ok(result.data.zip.startsWith(workspace.root));
  assert.ok(fs.existsSync(result.data.zip));
  const buffer = fs.readFileSync(result.data.zip);
  assert.equal(buffer.subarray(0, 4).toString("binary"), "PK\x03\x04");
  assert.ok(buffer.includes(Buffer.from("Scripts/main.lua")));
  assert.ok(buffer.includes(Buffer.from("enabled.txt")));
});

test("a Lua build is a successful no-op", async () => {
  const workspace = workspaceAt("ws-build-lua");
  const modDir = await scaffoldLua(workspace, "LuaBuildMod");
  const result = await executeOperation("unreal.build", { modDir, type: "lua" }, {});
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.code, 0);
});

test("a C++ build without xmake reports GMF-E-TOOL-001", async () => {
  const workspace = workspaceAt("ws-build-cpp");
  const scaffold = await executeOperation(
    "unreal.scaffold",
    { name: "CppBuildMod", author: "Tester", type: "cpp" },
    { workspace },
  );
  assert.equal(scaffold.ok, true, scaffold.error?.message);
  const modDir = path.join(workspace.root, "mods", "CppBuildMod");
  const result = await executeOperation(
    "unreal.build",
    { modDir, type: "cpp" },
    { toolCacheDir: path.join(root, "empty-tool-cache") },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-TOOL-001");
});

test("the build log tail joins stdout and stderr and ends with the last stderr line", async () => {
  const workspace = workspaceAt("ws-build-tail");
  const modDir = path.join(workspace.root, "mods", "TailMod");
  fs.mkdirSync(path.join(modDir, "Source"), { recursive: true });
  const stdout = `${Array.from({ length: 50 }, (_, index) => `out${index + 1}`).join("\n")}\n`;
  const stderr = "err1\nerr2\n";
  const tools = { xmake: { path: "xmake", args: [], run: async () => ({ code: 1, stdout, stderr }) } };
  const result = await executeOperation("unreal.build", { modDir, type: "cpp" }, { tools });
  assert.equal(result.ok, true, result.error?.message);
  const tail = result.data.logTail.split("\n");
  assert.equal(tail.length, 40);
  assert.deepEqual(tail.slice(-3), ["out50", "err1", "err2"]);
  assert.equal(tail[0], "out13");
});

function cppModWithDlls(name, dlls) {
  const modDir = path.join(root, "cpp-mods", name);
  for (const dll of dlls) {
    fs.mkdirSync(path.dirname(path.join(modDir, dll)), { recursive: true });
    fs.writeFileSync(path.join(modDir, dll), `DLL ${dll}`);
  }
  return modDir;
}

async function deployCpp(name, dlls) {
  const workspace = workspaceAt(`ws-dll-${name}`);
  const gameDir = copyFixture("ue4ss-game", path.join(root, `game-dll-${name}`));
  const modDir = cppModWithDlls(name, dlls);
  const result = await executeOperation(
    "unreal.deploy",
    { modDir, gameDir, type: "cpp" },
    { workspace, authorizations: [{ effect: "gameWrite", source: "test: game write" }] },
  );
  assert.equal(result.ok, true, result.error?.message);
  const deployed = path.join(gameDir, "ue4ss", "Mods", name, "dlls", "main.dll");
  return { result, content: fs.readFileSync(deployed, "utf8") };
}

test("a C++ deploy prefers main.dll, then the DLL named after the mod, and warns when it has to guess", async () => {
  const mainDll = await deployCpp("DllMain", ["aaa/helper.dll", "bbb/main.dll"]);
  assert.equal(mainDll.content, "DLL bbb/main.dll");
  assert.deepEqual(mainDll.result.data.warnings, []);

  const named = await deployCpp("DllNamed", ["aaa/helper.dll", "zzz/DllNamed.dll"]);
  assert.equal(named.content, "DLL zzz/DllNamed.dll");
  assert.deepEqual(named.result.data.warnings, []);

  const single = await deployCpp("DllSingle", ["build/windows/x64/release/other.dll"]);
  assert.equal(single.content, "DLL build/windows/x64/release/other.dll");
  assert.deepEqual(single.result.data.warnings, []);

  const ambiguous = await deployCpp("DllAmbiguous", ["aaa/first.dll", "build/windows/x64/release/second.dll", "ccc/third.dll"]);
  assert.equal(ambiguous.content, "DLL build/windows/x64/release/second.dll");
  assert.equal(ambiguous.result.data.warnings.length, 1);
  assert.match(ambiguous.result.data.warnings[0], /3 DLLs/);
});

function packTools(calls) {
  return {
    repak: {
      path: "repak",
      args: [],
      run: async (args) => {
        calls.push(args);
        fs.mkdirSync(path.dirname(args[2]), { recursive: true });
        fs.writeFileSync(args[2], "PAKDATA");
        return { code: 0, stdout: "", stderr: "" };
      },
    },
  };
}

function countOf(buffer, text) {
  let count = 0;
  for (let at = buffer.indexOf(text); at >= 0; at = buffer.indexOf(text, at + 1)) count += 1;
  return count;
}

test("packaging a pak mod twice without a Content folder does not grow the zip, and the pak stays out of the mod folder", async () => {
  const workspace = workspaceAt("ws-package-pak");
  const modDir = await scaffoldLua(workspace, "PackPak");
  fs.writeFileSync(path.join(modDir, "pack.json"), JSON.stringify({ container: "pak", version: "1 beta/../../x" }));
  const calls = [];
  const context = { workspace, tools: packTools(calls) };

  const first = await executeOperation("unreal.package", { modDir }, context);
  assert.equal(first.ok, true, first.error?.message);
  const firstZip = fs.readFileSync(first.data.zip);
  const second = await executeOperation("unreal.package", { modDir }, context);
  assert.equal(second.ok, true, second.error?.message);
  assert.equal(second.data.zip, first.data.zip);
  assert.equal(second.data.entries, first.data.entries);
  assert.equal(fs.readFileSync(second.data.zip).length, firstZip.length);

  assert.equal(path.dirname(first.data.zip), path.join(workspace.root, "dist"));
  assert.match(path.basename(first.data.zip), /^packpak-[a-z0-9._-]+\.zip$/);
  assert.equal(first.data.version, "1-beta-..-..-x");
  assert.equal(countOf(firstZip, "packpak.pak"), 2, "one local header and one central entry");
  assert.equal(path.dirname(calls[0][2]).startsWith(path.resolve(modDir)), false, "the pak is written outside the packed folder");
  const leftovers = fs.readdirSync(modDir, { recursive: true }).map(String).filter((name) => /\.(pak|zip)$/i.test(name));
  assert.deepEqual(leftovers, []);
});

test("an output zip inside the mod folder is not packed into itself", async () => {
  const workspace = workspaceAt("ws-package-inside");
  const modDir = await scaffoldLua(workspace, "InsideMod");
  const out = path.join(modDir, "out");
  const first = await executeOperation("unreal.package", { modDir, out }, { workspace });
  assert.equal(first.ok, true, first.error?.message);
  const second = await executeOperation("unreal.package", { modDir, out }, { workspace });
  assert.equal(second.ok, true, second.error?.message);
  assert.equal(second.data.entries, first.data.entries);
  assert.equal(countOf(fs.readFileSync(second.data.zip), ".zip"), 0);
});

test("validate degrades a stale workspace installDir to a warning but still refuses an explicit gameDir that is missing", async () => {
  const workspace = workspaceAt("ws-validate-stale");
  workspace.profile = { game: { installDir: path.join(root, "gone", "game") } };
  const modDir = await scaffoldLua(workspace, "StaleMod");
  const stale = await executeOperation("unreal.validate", { modDir, type: "lua" }, { workspace });
  assert.equal(stale.ok, true, stale.error?.message);
  assert.equal(stale.data.gameDir, null);
  assert.equal(stale.data.ok, true);
  assert.ok(stale.data.warnings.some((warning) => warning.includes(path.join(root, "gone", "game"))), JSON.stringify(stale.data.warnings));
  const explicit = await executeOperation("unreal.validate", { modDir, type: "lua", gameDir: path.join(root, "gone", "game") }, { workspace });
  assert.equal(explicit.ok, false);
  assert.equal(explicit.error.code, "GMF-E-GAME-001");
});

test("validate gives no pak advice for a C++ mod", async () => {
  const workspace = workspaceAt("ws-validate-cpp");
  const gameDir = copyFixture("ue4ss-dumps", path.join(root, "game-validate-cpp"));
  const modDir = cppModWithDlls("ValidateCpp", ["build/main.dll"]);
  const result = await executeOperation("unreal.validate", { modDir, gameDir, type: "cpp" }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(result.data.errors, []);
  assert.equal(result.data.warnings.some((warning) => /pak/i.test(warning)), false, JSON.stringify(result.data.warnings));
});
