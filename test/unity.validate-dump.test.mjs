import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/engines/unity/index.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-validate-dump-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

test("unity.validate checks each Harmony target's method on its own class in the normalized dump", async () => {
  const workspaceRoot = path.join(root, "ws");
  const modDir = path.join(workspaceRoot, "mods", "Demo");
  fs.mkdirSync(path.join(modDir, "Patches"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "dumps"), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, "dumps", "unity-il2cpp.json"),
    JSON.stringify({
      version: 1,
      engine: "unity",
      classes: [
        { name: "PlayerEntity", namespace: "Entities.Player", assembly: "vhs", methods: ["CliUpdateStaminaContinuous"], fields: [] },
        { name: "OtherThing", namespace: "Entities", assembly: "vhs", methods: ["Explode"], fields: [] },
        { name: "Debug", namespace: "UnityEngine", assembly: "UnityEngine.CoreModule", methods: ["Log"], fields: [] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(modDir, "Patches", "Patch.cs"),
    [
      "[HarmonyPatch(typeof(PlayerEntity), nameof(PlayerEntity.CliUpdateStaminaContinuous))]",
      "class A {}",
      "[HarmonyPatch(typeof(PlayerEntity), \"Explode\")]",
      "class B {}",
      "[HarmonyPatch(typeof(UnityEngine.Debug), \"Log\")]",
      "class C {}",
      "[HarmonyPatch(typeof(MissingType), \"Run\")]",
      "class D {}",
    ].join("\n"),
  );
  const gameDir = fixturePath("unity-il2cpp");
  const result = await executeOperation(
    "unity.validate",
    { modDir, gameDir },
    { workspace: { root: workspaceRoot, profile: null } },
  );
  assert.equal(result.ok, true, result.error?.message);
  const byKey = Object.fromEntries(result.data.targets.map((t) => [`${t.type}.${t.method}`, t]));
  assert.equal(byKey["PlayerEntity.CliUpdateStaminaContinuous"].found, true);
  assert.equal(byKey["PlayerEntity.Explode"].found, false, "a method on another class does not count");
  assert.equal(byKey["UnityEngine.Debug.Log"].found, true, "a namespace-qualified type matches namespace and name");
  assert.equal(byKey["MissingType.Run"].found, false);
  for (const target of result.data.targets) assert.equal(target.checkedBy, "dump");
  assert.equal(result.data.ok, false);
  assert.ok(result.data.errors.some((e) => /PlayerEntity\.Explode/.test(e)));
  assert.ok(result.data.errors.some((e) => /^Harmony target type MissingType was not found/.test(e)), "the missing type is reported");
  assert.equal(result.data.errors.length, 2, "one error per target that was not found");
});

function dumpWorkspace(name, classes, sources) {
  const workspaceRoot = path.join(root, name);
  const modDir = path.join(workspaceRoot, "mods", "Demo");
  fs.mkdirSync(modDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, "dumps"), { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "dumps", "unity-il2cpp.json"), JSON.stringify({ version: 1, engine: "unity", classes }));
  fs.writeFileSync(path.join(modDir, "Patch.cs"), sources.join("\n"));
  return { workspaceRoot, modDir, gameDir: fixturePath("unity-il2cpp") };
}

async function validate({ workspaceRoot, modDir, gameDir }) {
  const result = await executeOperation("unity.validate", { modDir, gameDir }, { workspace: { root: workspaceRoot, profile: null } });
  assert.equal(result.ok, true, result.error?.message);
  return result.data;
}

test("a getter patch with nameof(Member) and a trailing MethodType resolves", async () => {
  const data = await validate(
    dumpWorkspace("getter", [{ name: "X", namespace: "Game", methods: ["get_Health", "Run"], fields: [] }], [
      "[HarmonyPatch(typeof(X), nameof(M), MethodType.Getter)]",
      "class A {}",
      "[HarmonyPatch(typeof(X), nameof(X.Run), MethodType.Normal)]",
      "class B {}",
      "[HarmonyPatch(typeof(X), nameof(X.Health), MethodType.Getter)]",
      "class C {}",
    ]),
  );
  assert.deepEqual(data.targets.map((t) => [t.method, t.found]), [["M", false], ["Run", true], ["Health", true]]);
  assert.equal(data.errors.length, 1);
  assert.match(data.errors[0], /X\.M\b/);
});

test("split attributes combine and a class-level type serves its method-level attributes", async () => {
  const data = await validate(
    dumpWorkspace("split", [{ name: "Player", namespace: "Game", methods: ["Update"], fields: [] }], [
      "[HarmonyPatch(typeof(Player))]",
      "[HarmonyPatch(\"Update\")]",
      "class A {}",
      "[HarmonyPatch(typeof(Player))]",
      "class B",
      "{",
      "    [HarmonyPatch(\"Update\")]",
      "    static void Prefix() {}",
      "    [HarmonyPatch(\"Missing\")]",
      "    static void Prefix2() {}",
      "}",
    ]),
  );
  const found = data.targets.filter((t) => t.method).map((t) => [t.type, t.method, t.found]);
  assert.deepEqual(found, [["Player", "Update", true], ["Player", "Update", true], ["Player", "Missing", false]]);
  assert.equal(data.warnings.length, 0);
});

test("an attribute that cannot be parsed yields one warning and ok is false", async () => {
  const data = await validate(
    dumpWorkspace("unparsed", [{ name: "X", namespace: "Game", methods: ["Run"], fields: [] }], [
      "[HarmonyPatch(typeof(X), \"Run\")]",
      "class A {}",
      "[HarmonyPatch(TargetType, \"Run\")]",
      "class B {}",
    ]),
  );
  assert.equal(data.errors.length, 0);
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0], /TargetType/);
  assert.equal(data.ok, false);
});

test("a method search uses the last name segment, any candidate type counts and nested owners match", async () => {
  const data = await validate(
    dumpWorkspace("candidates", [
      { name: "Item", namespace: "One", methods: [], fields: [] },
      { name: "Item", namespace: "Two", methods: ["Use"], fields: [] },
      { name: "Inner", namespace: "Game", methods: ["Go"], fields: [] },
    ], [
      "[HarmonyPatch(typeof(Item), \"Use\")]",
      "class A {}",
      "[HarmonyPatch(typeof(Game.Outer.Inner), \"Go\")]",
      "class B {}",
    ]),
  );
  assert.deepEqual(data.errors, []);
  assert.equal(data.ok, true);
});

test("without a dump the byte search matches whole names and reads the DLLs only then", async () => {
  const gameDir = fs.mkdtempSync(path.join(root, "game-"));
  const managed = path.join(gameDir, "Fixture_Data", "Managed");
  fs.mkdirSync(managed, { recursive: true });
  fs.writeFileSync(path.join(gameDir, "Fixture.exe"), "MZ");
  fs.writeFileSync(path.join(managed, "Assembly-CSharp.dll"), Buffer.concat([Buffer.from("\0Player\0Update\0TakeDamageNow\0", "latin1")]));
  const modDir = path.join(root, "bytes-mod");
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(path.join(modDir, "Patch.cs"), [
    "[HarmonyPatch(typeof(Game.Player), \"Update\")]",
    "class A {}",
    "[HarmonyPatch(typeof(Game.Player), \"TakeDamage\")]",
    "class B {}",
  ].join("\n"));
  const data = await validate({ workspaceRoot: path.join(root, "bytes-ws"), modDir, gameDir });
  assert.deepEqual(data.targets.map((t) => [t.method, t.found, t.checkedBy]), [["Update", true, "bytes"], ["TakeDamage", false, "bytes"]]);

  // With a dump, no assembly is opened.
  const withDump = dumpWorkspace("nodll", [{ name: "Player", namespace: "Game", methods: ["Update"], fields: [] }], ["[HarmonyPatch(typeof(Player), \"Update\")]"]);
  const opened = [];
  const original = fs.readFileSync;
  fs.readFileSync = (target, ...rest) => {
    if (String(target).toLowerCase().endsWith(".dll")) opened.push(String(target));
    return original(target, ...rest);
  };
  let checked;
  try {
    checked = await validate({ ...withDump, gameDir });
  } finally {
    fs.readFileSync = original;
  }
  assert.deepEqual(opened, []);
  assert.equal(checked.ok, true);
});
