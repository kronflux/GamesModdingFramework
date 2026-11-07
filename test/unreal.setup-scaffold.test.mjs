import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const fixtures = fixturePath("unreal");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-unreal-setup-"));

after(() => fs.rmSync(root, { recursive: true, force: true }));

function copyFixture(name, target) {
  fs.cpSync(path.join(fixtures, name), target, { recursive: true });
  return target;
}

function workspaceAt(name) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  return { root: dir, config: { version: 1 }, local: { version: 1 }, profile: null };
}

function ue4ssCatalog() {
  const toolDir = path.join(fixtures, "ue4ss-tool");
  const dll = path.join(toolDir, "UE4SS.dll");
  return {
    version: 1,
    tools: [
      {
        id: "ue4ss",
        name: "UE4SS",
        purpose: "Unreal Lua and C++ modding",
        engine: "unreal",
        license: "MIT",
        source: { type: "local", path: toolDir, version: "fake-3.0" },
        versionPolicy: "local",
        asset: ".*",
        entry: "UE4SS.dll",
        verify: { kind: "size", value: fs.statSync(dll).size },
        effects: ["toolInstall", "network"],
        capabilities: ["unreal.lua", "unreal.cpp"],
      },
    ],
  };
}

function contextFor(workspace) {
  return {
    workspace,
    catalog: ue4ssCatalog(),
    toolCacheDir: path.join(root, "toolcache"),
    root: repoRoot,
  };
}

function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.statSync(full);
      entries.push(`${path.relative(dir, full)}:${stat.size}:${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

// The game folder, the workspace and the tool cache (null while the cache does not exist yet).
function stateOf(gameDir, workspaceRoot, cacheDir) {
  return {
    game: snapshotTree(gameDir),
    workspace: snapshotTree(workspaceRoot),
    cache: fs.existsSync(cacheDir) ? snapshotTree(cacheDir) : null,
  };
}

test("setup refuses before an authorization and writes nothing", async () => {
  const gameDir = copyFixture("no-ue4ss", path.join(root, "game-unauthorized"));
  const workspace = workspaceAt("ws-unauthorized");
  const context = contextFor(workspace);
  const before = stateOf(gameDir, workspace.root, context.toolCacheDir);
  const result = await executeOperation("unreal.setup_ue4ss", { gameDir }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.equal(fs.existsSync(path.join(gameDir, "Binaries", "Win64", "ue4ss", "UE4SS.dll")), false);
  assert.deepEqual(stateOf(gameDir, workspace.root, context.toolCacheDir), before, "game, workspace and tool cache are unchanged");
});

test("setup refuses a toolInstall-only authorization, because it writes into the game folder", async () => {
  const gameDir = copyFixture("no-ue4ss", path.join(root, "game-toolinstall-only"));
  const workspace = workspaceAt("ws-toolinstall-only");
  const context = contextFor(workspace);
  context.authorizations = [{ effect: "toolInstall", source: "test: install only" }];
  const before = stateOf(gameDir, workspace.root, context.toolCacheDir);
  const result = await executeOperation("unreal.setup_ue4ss", { gameDir }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-GATE-001");
  assert.match(result.error.message, /gameWrite/);
  assert.deepEqual(stateOf(gameDir, workspace.root, context.toolCacheDir), before, "nothing was written");
});

test("setup installs UE4SS with an authorization and records its version", async () => {
  const gameDir = copyFixture("no-ue4ss", path.join(root, "game-authorized"));
  const workspace = workspaceAt("ws-authorized");
  const context = contextFor(workspace);
  context.authorizations = [
    { effect: "toolInstall", source: "test: user asked to install UE4SS" },
    { effect: "gameWrite", source: "test: user asked to install UE4SS" },
  ];
  const result = await executeOperation("unreal.setup_ue4ss", { gameDir }, context);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.version, "fake-3.0");
  assert.equal(result.data.path, path.join(gameDir, "Binaries", "Win64", "ue4ss"));
  assert.equal(result.data.mode, "installed");
  assert.ok(fs.existsSync(path.join(gameDir, "Binaries", "Win64", "ue4ss", "UE4SS.dll")));
  assert.ok(fs.existsSync(path.join(gameDir, "Binaries", "Win64", "ue4ss", "Mods")));
  assert.equal(result.authorization.effect, "toolInstall");
});

test("a Lua scaffold writes main.lua and enabled.txt under mods/", async () => {
  const workspace = workspaceAt("ws-scaffold");
  const result = await executeOperation(
    "unreal.scaffold",
    { name: "FixtureMod", author: "Tester", type: "lua" },
    { workspace, root: repoRoot },
  );
  assert.equal(result.ok, true, result.error?.message);
  const modDir = path.join(workspace.root, "mods", "FixtureMod");
  const main = path.join(modDir, "Scripts", "main.lua");
  assert.ok(fs.existsSync(main));
  assert.ok(fs.existsSync(path.join(modDir, "Scripts", "core", "util.lua")));
  assert.ok(fs.existsSync(path.join(modDir, "enabled.txt")));
  const source = fs.readFileSync(main, "utf8");
  assert.match(source, /local MOD_NAME = "FixtureMod"/);
  assert.match(source, /Tester/);
  assert.ok(result.data.files.every((file) => path.isAbsolute(file)));
});

test("cpp and pak scaffolds write their template files", async () => {
  const workspace = workspaceAt("ws-scaffold-types");
  const cpp = await executeOperation(
    "unreal.scaffold",
    { name: "CppMod", author: "Tester", type: "cpp" },
    { workspace },
  );
  assert.equal(cpp.ok, true, cpp.error?.message);
  assert.ok(fs.existsSync(path.join(workspace.root, "mods", "CppMod", "xmake.lua")));
  assert.ok(fs.existsSync(path.join(workspace.root, "mods", "CppMod", "Source", "CppMod", "CppMod.cpp")));

  const pak = await executeOperation(
    "unreal.scaffold",
    { name: "PakMod", author: "Tester", type: "pak" },
    { workspace },
  );
  assert.equal(pak.ok, true, pak.error?.message);
  assert.ok(fs.existsSync(path.join(workspace.root, "mods", "PakMod", "README.md")));
  assert.ok(fs.existsSync(path.join(workspace.root, "mods", "PakMod", "pack.json")));
});

test("an unknown type and an escaping name are refused", async () => {
  const workspace = workspaceAt("ws-scaffold-refused");
  const badType = await executeOperation("unreal.scaffold", { name: "Bad", type: "dll" }, { workspace });
  assert.equal(badType.ok, false);
  assert.equal(badType.error.code, "GMF-E-PLAN-001");

  const traversal = await executeOperation("unreal.scaffold", { name: "../escape", type: "lua" }, { workspace });
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error.code, "GMF-E-PLAN-001");
  assert.equal(fs.existsSync(path.join(workspace.root, "escape")), false);
});

test("dump prepares object, usmap and header artifacts without launching the game", async () => {
  const gameDir = copyFixture("ue4ss-game", path.join(root, "game-dump"));
  const workspace = workspaceAt("ws-dump");
  const before = snapshot(gameDir);
  const result = await executeOperation(
    "unreal.dump",
    { gameDir, kinds: ["objects", "usmap", "headers"] },
    { workspace },
  );
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.artifacts.length, 3);
  assert.ok(result.data.artifacts.every((artifact) => artifact.status === "planned"));
  assert.ok(fs.existsSync(result.data.plan));
  assert.deepEqual(snapshot(gameDir), before);
});

test("dump fails with GMF-E-TOOL-001 when UE4SS is absent", async () => {
  const gameDir = copyFixture("no-ue4ss", path.join(root, "game-dump-tool"));
  const workspace = workspaceAt("ws-dump-tool");
  const result = await executeOperation("unreal.dump", { gameDir }, { workspace });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-TOOL-001");
});

test("scaffold with features and helpers copies them", async () => {
  const workspace = workspaceAt("ws-scaffold-features");
  const result = await executeOperation(
    "unreal.scaffold",
    {
      name: "FeatureMod",
      author: "Tester",
      type: "lua",
      features: ["godmode", "feature-discovery"],
      helpers: ["load-class"],
    },
    { workspace, root: repoRoot },
  );
  assert.equal(result.ok, true, result.error?.message);
  const modDir = path.join(workspace.root, "mods", "FeatureMod");
  assert.ok(fs.existsSync(path.join(modDir, "Scripts", "features", "godmode.lua")));
  assert.ok(fs.existsSync(path.join(modDir, "Scripts", "features", "feature-discovery.lua")));
  assert.ok(fs.existsSync(path.join(modDir, "Scripts", "helpers", "load-class.lua")));
  assert.ok(fs.existsSync(path.join(modDir, "Scripts", "core", "util.lua")));
  assert.ok(result.data.files.every((file) => path.isAbsolute(file)));

  const unknown = await executeOperation(
    "unreal.scaffold",
    { name: "BadFeatureMod", type: "lua", features: ["no-such-feature"] },
    { workspace },
  );
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error.code, "GMF-E-TEMPLATE-001");
  assert.match(unknown.error.message, /no-such-feature/);
  assert.equal(fs.existsSync(path.join(workspace.root, "mods", "BadFeatureMod")), false);

  const badHelper = await executeOperation(
    "unreal.scaffold",
    { name: "BadHelperMod", type: "lua", helpers: ["../escape"] },
    { workspace },
  );
  assert.equal(badHelper.ok, false);
  assert.equal(badHelper.error.code, "GMF-E-TEMPLATE-001");
});

test("setup installs a UE4SS 3.x archive with dwmapi.dll and ue4ss/ beside the shipping exe", async () => {
  const gameDir = copyFixture("no-ue4ss", path.join(root, "game-v3"));
  const workspace = workspaceAt("ws-v3");
  const toolDir = path.join(fixtures, "ue4ss-tool-v3");
  const context = {
    workspace,
    catalog: {
      version: 1,
      tools: [
        {
          id: "ue4ss",
          name: "UE4SS",
          purpose: "Unreal Lua and C++ modding",
          engine: "unreal",
          license: "MIT",
          source: { type: "local", path: toolDir, version: "fake-3.x" },
          versionPolicy: "local",
          asset: ".*",
          entry: "dwmapi.dll",
          verify: { kind: "none", value: null },
          effects: ["toolInstall", "network", "gameWrite"],
          capabilities: ["unreal.lua"],
        },
      ],
    },
    toolCacheDir: path.join(root, "toolcache-v3"),
    root: repoRoot,
    authorizations: [
      { effect: "toolInstall", source: "test: install UE4SS 3.x" },
      { effect: "gameWrite", source: "test: install UE4SS 3.x" },
    ],
  };
  const result = await executeOperation("unreal.setup_ue4ss", { gameDir }, context);
  assert.equal(result.ok, true, result.error?.message);
  const win64 = path.join(gameDir, "Binaries", "Win64");
  assert.ok(fs.existsSync(path.join(win64, "dwmapi.dll")), "the proxy dll sits beside the shipping exe");
  assert.ok(fs.existsSync(path.join(win64, "ue4ss", "UE4SS.dll")));
  assert.ok(fs.existsSync(path.join(win64, "ue4ss", "UE4SS-settings.ini")));
  assert.equal(fs.existsSync(path.join(win64, "ue4ss", "dwmapi.dll")), false, "no proxy dll inside ue4ss/");
  assert.equal(fs.existsSync(path.join(win64, "ue4ss", "ue4ss")), false, "no nested ue4ss/ue4ss");
  assert.equal(result.data.path, path.join(win64, "ue4ss"));
  const { detectUe4ss } = await import("../src/engines/unreal/detect.mjs");
  assert.equal(detectUe4ss(gameDir).installed, true);
  const ini = fs.readFileSync(path.join(win64, "ue4ss", "UE4SS-settings.ini"), "utf8");
  assert.match(ini, /^GuiConsoleEnabled = 1$/m, "setup applies the development console profile by default");
  assert.match(ini, /^GuiConsoleVisible = 1$/m);
  assert.match(ini, /^ConsoleEnabled = 1$/m);
  assert.match(ini, /bUseUObjectArrayCache = 1/, "the shipped settings stay");
  assert.equal(result.data.settingsProfile, "development");
});

test("scaffolded features are listed in FEATURE_MODULES so main.lua loads them", async () => {
  const workspace = workspaceAt("ws-scaffold-feature-list");
  const result = await executeOperation(
    "unreal.scaffold",
    { name: "ListedMod", type: "lua-structured", features: ["infinite-stamina", "godmode"] },
    { workspace, root: repoRoot },
  );
  assert.equal(result.ok, true, result.error?.message);
  const main = fs.readFileSync(path.join(workspace.root, "mods", "ListedMod", "Scripts", "main.lua"), "utf8");
  const block = main.slice(main.indexOf("local FEATURE_MODULES = {"), main.indexOf("}", main.indexOf("local FEATURE_MODULES = {")));
  assert.match(block, /^\s+"features\.infinite-stamina",$/m);
  assert.match(block, /^\s+"features\.godmode",$/m);
  const minimal = await executeOperation(
    "unreal.scaffold",
    { name: "MinimalWithFeature", type: "lua-minimal", features: ["godmode"] },
    { workspace, root: repoRoot },
  );
  assert.equal(minimal.ok, false);
  assert.equal(minimal.error.code, "GMF-E-PLAN-001");
  assert.equal(fs.existsSync(path.join(workspace.root, "mods", "MinimalWithFeature")), false, "nothing written on refusal");
});

test("the structured Lua template binds keys only from a real keybinds.json, never from the example file", () => {
  const main = fs.readFileSync(path.join(repoRoot, "templates/unreal/lua-structured/Scripts/main.lua"), "utf8");
  assert.equal(/ReadFile\(Util\.ModPath\("keybinds\.json\.example"\)\)/.test(main), false, "the example file is never read as a bind source");
  assert.match(main, /ReadFile\(Util\.ModPath\("keybinds\.json"\)\)/);
});

test("the C++ scaffold exports start_mod and uninstall_mod, includes DynamicOutput and links UE4SS", async () => {
  const workspace = workspaceAt("ws-scaffold-cpp-contents");
  const result = await executeOperation(
    "unreal.scaffold",
    { name: "CppContents", author: "Tester", type: "cpp" },
    { workspace, root: repoRoot },
  );
  assert.equal(result.ok, true, result.error?.message);
  const modDir = path.join(workspace.root, "mods", "CppContents");
  const source = fs.readFileSync(path.join(modDir, "Source", "CppContents", "CppContents.cpp"), "utf8");
  assert.match(source, /extern "C" __declspec\(dllexport\) RC::CppUserModBase\* start_mod\(\)/);
  assert.match(source, /extern "C" __declspec\(dllexport\) void uninstall_mod\(RC::CppUserModBase\* mod\)/);
  assert.match(source, /#include <DynamicOutput\/DynamicOutput\.hpp>/);
  assert.match(source, /RC::Output::send<RC::LogLevel::Verbose>/);
  const xmake = fs.readFileSync(path.join(modDir, "xmake.lua"), "utf8");
  assert.match(xmake, /add_links\("UE4SS"\)/);
  assert.match(xmake, /set_languages\("cxx23"\)/);
  assert.match(xmake, /set_runtimes\("MD"\)/);
});

test("the structured Lua template follows the UE4SS threading and handler contracts", () => {
  const read = (file) => fs.readFileSync(path.join(repoRoot, "templates/unreal", file), "utf8");
  const main = read("lua-structured/Scripts/main.lua");
  // The hook parameter is resolved inside the hook, before the deferred closure.
  assert.ok(main.indexOf("Context:get()") < main.indexOf("ExecuteInGameThread(function()\n            Util.SafeCall(function()"));
  // Key callbacks hop to the game thread.
  assert.match(main, /RegisterKeyBind\(KeyValue, function\(\)\s+ExecuteInGameThread/);
  // Console handlers report "handled".
  assert.doesNotMatch(read("lua-structured/Scripts/core/help.lua"), /return false/);
  assert.doesNotMatch(read("lua-structured/Scripts/systems/dev.lua"), /return false\n\s+end\)/);
  assert.match(main, /SafeCall\(function\(\) SelfTest\.Run\(OutputDevice\) end, "selftest"\)\s+--[^\n]*\n\s+return true/);
  // A UFunction is userdata, so type(x) == "function" is never a valid test for one.
  for (const file of ["features/infinite-health.lua", "features/infinite-stamina.lua"]) {
    assert.doesNotMatch(read(file), /type\(Attribs\.OnRep_\w+\) == "function"/);
  }
  // LoadClass is not a UE4SS global.
  assert.doesNotMatch(read("features/spawn-item.lua"), /[^.\w]LoadClass\(/);
  // The config is written to a temporary file and renamed into place.
  const config = read("lua-structured/Scripts/core/config.lua");
  assert.match(config, /os\.rename\(TempName, FILE_NAME\)/);
});

test("a structured scaffold with every feature and helper passes the Lua check with zero issues", async () => {
  const workspace = workspaceAt("ws-scaffold-lua-check");
  const luaNames = (dir) =>
    fs
      .readdirSync(path.join(repoRoot, dir))
      .filter((file) => file.endsWith(".lua"))
      .map((file) => file.replace(/\.lua$/, ""));
  const features = luaNames("templates/unreal/features");
  const helpers = luaNames("templates/unreal/helpers");
  assert.ok(features.length >= 8 && helpers.length >= 5);
  const result = await executeOperation(
    "unreal.scaffold",
    { name: "AllFeatures", author: "Tester", type: "lua-structured", features, helpers },
    { workspace, root: repoRoot },
  );
  assert.equal(result.ok, true, result.error?.message);
  const check = await executeOperation(
    "unreal.lua_check",
    { modDir: path.join(workspace.root, "mods", "AllFeatures"), languageServer: false },
    { workspace },
  );
  assert.equal(check.ok, true, check.error?.message);
  assert.deepEqual(check.data.issues, []);
});

test("the author is escaped for Lua and C++ string literals and for JSON", async () => {
  const workspace = workspaceAt("ws-author");
  const author = 'A "B" \\ C';
  const lua = await executeOperation("unreal.scaffold", { name: "AuthorLua", author, type: "lua-minimal" }, { workspace });
  assert.equal(lua.ok, true, lua.error?.message);
  const luaSource = fs.readFileSync(path.join(workspace.root, "mods", "AuthorLua", "Scripts", "main.lua"), "utf8");
  assert.ok(luaSource.includes('local MOD_AUTHOR = "A \\"B\\" \\\\ C"'), luaSource.split("\n")[4]);

  const cpp = await executeOperation("unreal.scaffold", { name: "AuthorCpp", author, type: "cpp" }, { workspace });
  assert.equal(cpp.ok, true, cpp.error?.message);
  const cppFile = cpp.data.files.find((file) => file.endsWith("AuthorCpp.cpp"));
  assert.ok(fs.readFileSync(cppFile, "utf8").includes('STR("A \\"B\\" \\\\ C")'));

  const pak = await executeOperation("unreal.scaffold", { name: "AuthorPak", author, type: "pak" }, { workspace });
  assert.equal(pak.ok, true, pak.error?.message);
  const manifest = JSON.parse(fs.readFileSync(path.join(workspace.root, "mods", "AuthorPak", "pack.json"), "utf8"));
  assert.equal(manifest.author, author);
});

test("control characters and a closing long bracket in the author cannot leave their literal or comment", async () => {
  const workspace = workspaceAt("ws-author-control");
  const author = "Eve ]] end\nos.exit()\t\u0001";
  const result = await executeOperation("unreal.scaffold", { name: "AuthorControl", author, type: "lua-structured" }, { workspace });
  assert.equal(result.ok, true, result.error?.message);
  const main = fs.readFileSync(path.join(workspace.root, "mods", "AuthorControl", "Scripts", "main.lua"), "utf8");
  assert.ok(main.includes('local MOD_AUTHOR = "Eve ]\\093 end\\nos.exit()\\t\\001"'), main.split("\n").find((line) => line.includes("MOD_AUTHOR =")));
  assert.equal(main.split("\n").some((line) => line.startsWith("os.exit()")), false);
  const check = await executeOperation("unreal.lua_check", { modDir: path.join(workspace.root, "mods", "AuthorControl"), languageServer: false }, {});
  assert.equal(check.ok, true, check.error?.message);
  assert.deepEqual(check.data.issues, []);
  const cpp = await executeOperation("unreal.scaffold", { name: "AuthorControlCpp", author, type: "cpp" }, { workspace });
  const cppSource = fs.readFileSync(cpp.data.files.find((file) => file.endsWith("AuthorControlCpp.cpp")), "utf8");
  assert.ok(cppSource.includes('STR("Eve ]] end\\nos.exit()\\t\\001")'));
  assert.equal(cppSource.split("\n").some((line) => line.startsWith("os.exit()")), false);
});

test("Windows reserved device names and trailing dots are refused as mod names", async () => {
  const workspace = workspaceAt("ws-reserved");
  for (const name of ["con", "CON", "Nul", "aux", "prn", "com1", "LPT9", "con.txt", "Mod.", "Mod.."]) {
    const result = await executeOperation("unreal.scaffold", { name, type: "lua" }, { workspace });
    assert.equal(result.ok, false, name);
    assert.equal(result.error.code, "GMF-E-PLAN-001", name);
  }
  assert.equal(fs.existsSync(path.join(workspace.root, "mods")), false);
  for (const name of ["Console", "com10", "lpt", "My.Mod"]) {
    const result = await executeOperation("unreal.scaffold", { name, type: "lua-minimal" }, { workspace });
    assert.equal(result.ok, true, `${name}: ${result.error?.message}`);
  }
});

test("setup refuses a channel other than the one the catalog installs, before writing anything", async () => {
  const gameDir = copyFixture("no-ue4ss", path.join(root, "game-channel"));
  const workspace = workspaceAt("ws-channel");
  const context = contextFor(workspace);
  context.authorizations = [
    { effect: "toolInstall", source: "test: install" },
    { effect: "gameWrite", source: "test: install" },
  ];
  const before = fs.readdirSync(gameDir, { recursive: true }).map(String).sort();
  const result = await executeOperation("unreal.setup_ue4ss", { gameDir, channel: "stable" }, context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-PLAN-001");
  assert.match(result.error.message, /experimental-latest/);
  assert.deepEqual(fs.readdirSync(gameDir, { recursive: true }).map(String).sort(), before);
  const named = await executeOperation("unreal.setup_ue4ss", { gameDir, channel: "experimental-latest" }, context);
  assert.equal(named.ok, true, named.error?.message);
  assert.equal(named.data.channel, "experimental-latest");
});
