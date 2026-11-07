import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import { detectUnity } from "../src/engines/unity/detect.mjs";
import { buildProfile } from "../src/core/profile.mjs";
import { initWorkspace, readWorkspace, writeProfile } from "../src/core/workspace.mjs";
import "../src/engines/unity/index.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";

const fixture = fixturePath("unity-mono");
const tempRoots = [];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

async function makeWorkspace() {
  const workspaceDir = tempDir("gmf-scaffold-ws-");
  initWorkspace({ gameDir: fixture, workspaceDir });
  const detection = await detectUnity(fixture);
  const profile = buildProfile({ gameDir: fixture, detections: [detection] });
  const workspace = readWorkspace(workspaceDir);
  writeProfile(workspace, profile);
  return { workspaceDir, workspace: readWorkspace(workspaceDir) };
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

after(() => {
  for (const dir of tempRoots) fs.rmSync(dir, { recursive: true, force: true });
});

test("a Mono BepInEx 5 workspace renders a plugin and csproj with the game path variable", async () => {
  const { workspace } = await makeWorkspace();
  const result = await executeOperation(
    "unity.scaffold",
    { name: "FixtureMod", author: "Fixture Author", loader: "bepinex5", backend: "mono" },
    { workspace },
  );
  assert.equal(result.ok, true, result.error?.message);

  const modDir = path.join(workspace.root, "mods", "FixtureMod");
  assert.equal(result.data.outputDir, modDir);
  const csproj = path.join(modDir, "FixtureMod.csproj");
  const plugin = path.join(modDir, "Plugin.cs");
  const props = path.join(modDir, "Directory.Build.props");
  for (const file of [csproj, plugin, props]) assert.ok(fs.existsSync(file), `${file} exists`);
  assert.ok(result.data.files.some((file) => file.endsWith("FixtureMod.csproj")));

  const project = read(csproj);
  assert.match(project, /\$\(GameDir\)/, "the csproj keeps the MSBuild game path variable");
  assert.match(project, /BepInEx\.dll/);
  assert.match(project, /net472/);
  assert.match(project, /Fixture Author/);

  const properties = read(props);
  assert.ok(properties.includes(path.resolve(fixture)), "the props file resolves the game path");
  assert.match(properties, /<ModDeployDir>.*BepInEx[\\/]plugins<\/ModDeployDir>/);

  const source = read(plugin);
  assert.match(source, /FixtureMod/);
  assert.match(source, /BaseUnityPlugin/);
  assert.match(source, /BepInPlugin/);
});

test("every loader and backend combination renders its own template", async () => {
  const { workspace } = await makeWorkspace();
  const cases = [
    { name: "BepSixMonoMod", loader: "bepinex6", backend: "mono", framework: "netstandard2.1" },
    { name: "BepSixIl2CppMod", loader: "bepinex6", backend: "il2cpp", framework: "net6.0" },
    { name: "MelonMod", loader: "melonloader", backend: "mono", framework: "net472" },
    { name: "MelonIl2CppMod", loader: "melonloader", backend: "il2cpp", framework: "net6.0" },
  ];

  for (const entry of cases) {
    const result = await executeOperation(
      "unity.scaffold",
      { name: entry.name, author: "Fixture Author", loader: entry.loader, backend: entry.backend },
      { workspace },
    );
    assert.equal(result.ok, true, `${entry.name}: ${result.error?.message}`);
    const csproj = path.join(workspace.root, "mods", entry.name, `${entry.name}.csproj`);
    assert.ok(fs.existsSync(csproj), `${entry.name} csproj exists`);
    assert.match(read(csproj), new RegExp(entry.framework));
  }

  const melonProps = read(path.join(workspace.root, "mods", "MelonMod", "Directory.Build.props"));
  assert.match(melonProps, /<ModDeployDir>.*Mods<\/ModDeployDir>/);
  const melonSource = read(path.join(workspace.root, "mods", "MelonMod", "Mod.cs"));
  assert.match(melonSource, /MelonMod/);
  assert.match(melonSource, /MelonInfo/);

  // References follow the MelonLoader 0.7 release layout and include Harmony.
  const melonProject = read(path.join(workspace.root, "mods", "MelonMod", "MelonMod.csproj"));
  assert.match(melonProject, /0Harmony\.dll/);
  assert.match(melonProps, /<LoaderDir>.*MelonLoader[\\/]net472<\/LoaderDir>/);
  const il2cppProps = read(path.join(workspace.root, "mods", "MelonIl2CppMod", "Directory.Build.props"));
  assert.match(il2cppProps, /<LoaderDir>.*MelonLoader[\\/]net6<\/LoaderDir>/);
  assert.match(il2cppProps, /<InteropDir>.*MelonLoader[\\/]Il2CppAssemblies<\/InteropDir>/);
  const il2cppProject = read(path.join(workspace.root, "mods", "MelonIl2CppMod", "MelonIl2CppMod.csproj"));
  assert.match(il2cppProject, /Il2CppInterop\.Runtime\.dll/);
  assert.match(il2cppProject, /\$\(InteropDir\)\/\*\.dll/);
});

test("all four template folders exist with metadata", () => {
  for (const template of ["bepinex5", "bepinex6-mono", "bepinex6-il2cpp", "melonloader"]) {
    const file = path.join(repoRoot, "templates/unity", template, "template.json");
    assert.ok(fs.existsSync(file), `${template} template.json exists`);
    const metadata = JSON.parse(read(file));
    assert.equal(metadata.engine, "unity");
    assert.ok(metadata.id);
  }
});

test("an impossible loader and backend pair is rejected", async () => {
  const { workspace } = await makeWorkspace();
  const result = await executeOperation(
    "unity.scaffold",
    { name: "BadPairMod", author: "", loader: "bepinex5", backend: "il2cpp" },
    { workspace },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /mono/i);
});

test("an unsafe mod name and an existing project are rejected", async () => {
  const { workspace } = await makeWorkspace();

  const unsafe = await executeOperation(
    "unity.scaffold",
    { name: "../Escape", author: "", loader: "bepinex5", backend: "mono" },
    { workspace },
  );
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.error.message, /name/i);

  const first = await executeOperation(
    "unity.scaffold",
    { name: "OnceMod", author: "", loader: "bepinex5", backend: "mono" },
    { workspace },
  );
  assert.equal(first.ok, true, first.error?.message);
  const second = await executeOperation(
    "unity.scaffold",
    { name: "OnceMod", author: "", loader: "bepinex5", backend: "mono" },
    { workspace },
  );
  assert.equal(second.ok, false);
  assert.match(second.error.message, /exist/i);
});

test("scaffold needs a workspace profile to resolve the game paths", async () => {
  const workspace = { root: tempDir("gmf-scaffold-empty-ws-"), local: { gameDir: fixture }, profile: null };
  const result = await executeOperation(
    "unity.scaffold",
    { name: "NoProfileMod", author: "", loader: "bepinex5", backend: "mono" },
    { workspace },
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /profile|investigate/i);
});

test("bepinex5 scaffold has an example patch that unity.validate resolves", async () => {
  const { workspace } = await makeWorkspace();
  const scaffold = await executeOperation(
    "unity.scaffold",
    { name: "PatchMod", author: "Fixture Author", loader: "bepinex5", backend: "mono" },
    { workspace },
  );
  assert.equal(scaffold.ok, true, scaffold.error?.message);
  const modDir = path.join(workspace.root, "mods", "PatchMod");
  const patch = path.join(modDir, "Patches", "ExamplePatch.cs");
  assert.ok(fs.existsSync(patch), "Patches/ExamplePatch.cs exists");
  assert.match(read(patch), /typeof\(UnityEngine\.Debug\), "Log"/);
  assert.doesNotMatch(read(patch), /\$\(/, "no unrendered placeholder is left");

  const validate = await executeOperation("unity.validate", { modDir, gameDir: fixture }, { workspace });
  assert.equal(validate.ok, true, validate.error?.message);
  assert.equal(validate.data.ok, true, JSON.stringify(validate.data.errors));
  const target = validate.data.targets.find((entry) => entry.source === "Patches/ExamplePatch.cs");
  assert.ok(target, "the example patch is parsed as a target");
  assert.equal(target.type, "UnityEngine.Debug");
  assert.equal(target.method, "Log");
  assert.equal(target.found, true);
});

test("every loader template ships an example patch", () => {
  for (const template of ["bepinex5", "bepinex6-mono", "bepinex6-il2cpp", "melonloader"]) {
    const dir = path.join(repoRoot, "templates/unity", template);
    assert.ok(fs.existsSync(path.join(dir, "Patches", "ExamplePatch.cs.tpl")), `${template} patch exists`);
    const metadata = JSON.parse(read(path.join(dir, "template.json")));
    assert.ok(metadata.files.includes("Patches/ExamplePatch.cs.tpl"), `${template} lists the patch`);
  }
});

test("BepInEx 6 templates reference Harmony, apply their patches and use the right plugin base", () => {
  for (const loader of ["bepinex6-il2cpp", "bepinex6-mono"]) {
    const dir = path.join(repoRoot, "templates/unity", loader);
    const project = fs.readFileSync(path.join(dir, "$(ModName).csproj.tpl"), "utf8");
    const plugin = fs.readFileSync(path.join(dir, "Plugin.cs.tpl"), "utf8");
    assert.match(project, /<HintPath>\$\(LoaderDir\)\/core\/0Harmony\.dll<\/HintPath>/, `${loader} references 0Harmony`);
    assert.match(plugin, /PatchAll\(/, `${loader} applies its Harmony patches`);
    if (loader === "bepinex6-il2cpp") {
      assert.match(plugin, /: BasePlugin/);
      assert.match(plugin, /internal static new ManualLogSource Log/, "does not hide BasePlugin.Log silently");
      assert.match(project, /Il2CppInterop\.Runtime\.dll/);
    } else {
      assert.match(plugin, /: BaseUnityPlugin/, "BepInEx 6 Mono plugins derive from BaseUnityPlugin");
      assert.match(plugin, /void Awake\(\)/);
    }
  }
});

test("the BepInEx 6 IL2CPP template references every interop assembly, so game types and their base types resolve", () => {
  const project = fs.readFileSync(path.join(repoRoot, "templates/unity/bepinex6-il2cpp/$(ModName).csproj.tpl"), "utf8");
  assert.match(project, /<Reference Include="\$\(InteropDir\)\/\*\.dll"/);
  assert.equal(/HintPath>\$\(InteropDir\)\/Il2Cppmscorlib\.dll/.test(project), false, "no duplicate explicit interop references");
});

test("an author with quotes and an ampersand renders valid C# and XML, and paths stay raw in markdown", async () => {
  const parent = tempDir("gmf-scaffold-amp-");
  const game = path.join(parent, "a&b");
  fs.cpSync(fixture, game, { recursive: true });
  const workspaceDir = tempDir("gmf-scaffold-amp-ws-");
  initWorkspace({ gameDir: game, workspaceDir });
  const profile = buildProfile({ gameDir: game, detections: [await detectUnity(game)] });
  writeProfile(readWorkspace(workspaceDir), profile);
  const workspace = readWorkspace(workspaceDir);
  const author = 'Ann "Q" & Co\\';
  const result = await executeOperation(
    "unity.scaffold",
    { name: "AuthorMod", author, loader: "melonloader", backend: "mono" },
    { workspace },
  );
  assert.equal(result.ok, true, result.error?.message);
  const modDir = path.join(workspace.root, "mods", "AuthorMod");
  assert.match(read(path.join(modDir, "Mod.cs")), /"Ann \\"Q\\" & Co\\\\"/);
  assert.match(read(path.join(modDir, "AuthorMod.csproj")), /<Authors>Ann &quot;Q&quot; &amp; Co\\<\/Authors>/);
  const readme = read(path.join(modDir, "README.md"));
  assert.ok(readme.includes(`author ${author}`), "the markdown keeps the author as typed");
  assert.ok(readme.includes("a&b") && !readme.includes("a&amp;b"), "paths in markdown are not XML-escaped");
  assert.ok(read(path.join(modDir, "Directory.Build.props")).includes("a&amp;b"), "paths in the props file are XML-escaped");
});
