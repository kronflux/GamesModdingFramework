import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeNormalizedDump, validateDump } from "../src/operations/analyze/normalize.mjs";
import { normalizeUnityDump, parseCSharp } from "../src/engines/unity/operations/normalize.mjs";
import { normalizeObjectDump, normalizeUnrealDump } from "../src/engines/unreal/operations/normalize.mjs";
import { executeOperation } from "../src/core/operations.mjs";
import "../src/operations/analyze/index.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir, tempRoot } from "./helpers/tmp.mjs";

const fixtures = fixturePath("normalize");

test("unity tree normalizes to classes and entrypoints without bodies", () => {
  const dump = normalizeUnityDump({ decompiledDir: path.join(fixtures, "unity-decompiled"), backend: "mono" });
  assert.equal(dump.version, 1);
  assert.equal(dump.engine, "unity");
  const player = dump.classes.find((c) => c.name === "Player");
  assert.ok(player, "Player class missing");
  assert.equal(player.namespace, "Fixture.Game");
  assert.equal(player.assembly, "Assembly-CSharp");
  assert.ok(player.methods.includes("Awake"));
  assert.ok(player.methods.includes("TakeDamage"));
  assert.ok(player.fields.some((field) => field.name === "Health"));
  const loader = dump.classes.find((c) => c.name === "Loader");
  assert.equal(loader.namespace, "Fixture.Plugins", "nested namespace is resolved");
  assert.ok(dump.entrypoints.some((e) => e.class === "Player" && e.name === "Awake"));
  assert.ok(dump.entrypoints.some((e) => e.class === "Loader" && e.kind === "plugin"));
  assert.ok(dump.references.some((r) => r.from === "Loader" && r.to === "Player"));
  assert.ok(dump.strings.some((s) => s.value === "Ouch"));
  const text = JSON.stringify(dump);
  assert.equal(/"body"|"source"|"code"/.test(text), false, "no reserved keys");
  assert.equal(text.includes("Health -= amount"), false, "no method bodies");
});

test("cpp2il text dump normalizes", () => {
  const dump = normalizeUnityDump({ dumpDir: path.join(fixtures, "cpp2il"), backend: "il2cpp" });
  const enemy = dump.classes.find((c) => c.name === "Enemy");
  assert.equal(enemy.namespace, "Fixture.Game");
  assert.deepEqual(enemy.methods, ["Attack", "Update"]);
  assert.deepEqual(enemy.fields, [{ name: "Speed", offset: null }]);
  assert.ok(dump.entrypoints.some((e) => e.class === "Enemy" && e.name === "Update"));
});

test("a real-format UE4SS object dump normalizes to level instances, classes with fields and entrypoints", () => {
  const text = fs.readFileSync(path.join(fixtures, "unreal", "UE4SS_ObjectDump.txt"), "utf8");
  const dump = normalizeObjectDump(text);
  assert.equal(dump.engine, "unreal");
  // Only instances placed in a level: no packages, types, functions, properties, Default__ objects or loose assets.
  assert.deepEqual(dump.objects.map((o) => o.name).sort(), ["BP_FixtureGameMode_C_0", "PlayerController_0"]);
  const gm = dump.objects.find((o) => o.name === "BP_FixtureGameMode_C_0");
  assert.equal(gm.class, "BP_FixtureGameMode_C");
  assert.equal(gm.address, "0x000001EC60470010");
  assert.equal(gm.path, "/Game/Fixture/Maps/FixtureMap.FixtureMap:PersistentLevel.BP_FixtureGameMode_C_0");
  assert.deepEqual(dump.classes.map((c) => c.name).sort(), ["BP_FixtureGameMode_C", "FixtureStruct", "GameModeBase", "PlayerController"]);
  const base = dump.classes.find((c) => c.name === "GameModeBase");
  assert.equal(base.path, "/Script/Engine.GameModeBase");
  assert.deepEqual(base.methods, ["BeginPlay"]);
  assert.deepEqual(base.fields, [{ name: "Health", type: "FloatProperty", offset: "0x2A8" }], "function parameters are not fields");
  assert.equal(dump.classes.find((c) => c.name === "FixtureStruct").kind, "ScriptStruct");
  assert.deepEqual(dump.classes.find((c) => c.name === "BP_FixtureGameMode_C").fields, [{ name: "SpawnedPawn", type: "ObjectProperty", offset: "0x3B0" }]);
  assert.ok(dump.entrypoints.some((e) => e.name === "ClientRestart" && e.class === "PlayerController" && e.path === "/Script/Engine.PlayerController:ClientRestart"));
  assert.ok(dump.entrypoints.some((e) => e.name === "BeginPlay" && e.class === "GameModeBase"));
  assert.ok(dump.entrypoints.some((e) => e.name === "ReceiveBeginPlay" && e.class === "BP_FixtureGameMode_C"));
  const fromDir = normalizeUnrealDump({ dumpsDir: path.join(fixtures, "unreal") });
  assert.equal(fromDir.objects.length, 2);
});

test("the legacy 0x-prefixed object dump form still parses", () => {
  const dump = normalizeObjectDump("[0x0000000000000010] Class /Script/Engine.GameModeBase\n[0x0000000000000030] GameModeBase /Game/M.M:PersistentLevel.GameModeBase_0\n");
  assert.equal(dump.classes[0].name, "GameModeBase");
  assert.equal(dump.objects[0].address, "0x0000000000000030");
});

test("reserved keys are rejected and the writer stores under dumps", (t) => {
  assert.throws(() => validateDump({ version: 1, engine: "unity", classes: [{ name: "A", body: "x" }] }), /body/);
  assert.throws(() => validateDump({ version: 1, engine: "godot" }), /engine/);
  const root = tempDir(t, "gmf-norm-");
  const file = writeNormalizedDump(root, "unity-mono.json", { version: 1, engine: "unity", classes: [{ name: "A" }] });
  assert.equal(file, path.join(root, "dumps", "unity-mono.json"));
  assert.throws(() => writeNormalizedDump(root, "../escape.json", { version: 1, engine: "unity" }), /inside/);
});

test("normalized dumps feed analyze.classes and analyze.objects", async (t) => {
  const root = tempDir(t, "gmf-norm-analyze-");
  writeNormalizedDump(root, "unity-mono.json", normalizeUnityDump({ decompiledDir: path.join(fixtures, "unity-decompiled"), backend: "mono" }));
  writeNormalizedDump(root, "unreal-objects.json", normalizeUnrealDump({ dumpsDir: path.join(fixtures, "unreal") }));
  const profile = { version: 1, engine: { id: "unity" }, paths: { dumps: path.join(root, "dumps") } };
  const classes = await executeOperation("analyze.classes", { profile, query: "Player" }, { root });
  assert.equal(classes.ok, true, classes.error?.message);
  assert.ok(classes.data.results.some((c) => c.name === "Player" && c.methods.includes("Awake")));
  const objects = await executeOperation("analyze.objects", { profile: { ...profile, engine: { id: "unreal" } }, query: "PlayerController" }, { root });
  assert.equal(objects.ok, true, objects.error?.message);
  assert.ok(objects.data.results.some((o) => o.name === "PlayerController_0"));
});

test("a Cpp2IL diffable-cs tree names the real assembly, keeps field offsets and counts each class once", () => {
  const dump = normalizeUnityDump({ decompiledDir: path.join(fixtures, "cpp2il-diffable"), backend: "il2cpp" });
  const stats = dump.classes.filter((c) => c.name === "PlayerStats");
  assert.equal(stats.length, 1, "each class once");
  assert.equal(stats[0].assembly, "Assembly-CSharp", "the DiffableCs format folder is not an assembly");
  assert.equal(stats[0].namespace, "Game", "file-scoped namespace");
  assert.deepEqual(stats[0].fields, [
    { name: "health", offset: "0x20" },
    { name: "maxHealth", offset: "0x24" },
  ]);
  assert.ok(stats[0].methods.includes("Heal"));
  assert.ok(dump.entrypoints.some((e) => e.class === "PlayerStats" && e.name === "Update"));
  assert.deepEqual(dump.classes.find((c) => c.name === "Cache").fields, [{ name: "last", offset: "0x10" }]);
});

function writeTree(files) {
  const root = tempRoot("gmf-norm-tree-");
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

test("a plugin attribute on the same line as its type marks that type", () => {
  const { classes } = parseCSharp('[BepInPlugin("a.b", "A", "1.0")] public class A {}\npublic class B {}\n', "Asm");
  assert.equal(classes.find((c) => c.name === "A").plugin, true);
  assert.equal(classes.find((c) => c.name === "B").plugin, false);
  const root = writeTree({ "Asm/A.cs": '[BepInPlugin("a.b", "A", "1.0")] public class A { void Awake() {} }\npublic class B {}\n' });
  const dump = normalizeUnityDump({ decompiledDir: root, backend: "mono" });
  assert.deepEqual(dump.entrypoints.filter((e) => e.kind === "plugin").map((e) => e.class), ["A"]);
});

test("braces in strings, characters and comments do not change nesting and a double slash in a string keeps the line", () => {
  const text = [
    "namespace N",
    "{",
    "    public class A",
    "    {",
    '        private string url = "http://example.test/{";',
    "        private char open = '{';",
    '        private string verbatim = @"a ""}"" b }";',
    "        /* a block comment with } and",
    "           { on two lines */",
    "        public void M() { } // trailing }",
    "    }",
    "    public class B",
    "    {",
    "        public void Z() { }",
    "    }",
    "}",
    "",
  ].join("\n");
  const { classes, strings } = parseCSharp(text, "Asm");
  const a = classes.find((c) => c.name === "A");
  const b = classes.find((c) => c.name === "B");
  assert.deepEqual(a.methods, ["M"]);
  assert.deepEqual(a.fields.map((f) => f.name), ["url", "open", "verbatim"]);
  assert.deepEqual(b.methods, ["Z"]);
  assert.equal(b.namespace, "N");
  assert.ok(strings.includes("http://example.test/{"), "the string after // is kept whole");
  assert.equal(strings.some((value) => /trailing|block comment/.test(value)), false);
});

test("classes with one name in two namespaces both survive with their own references", () => {
  const root = writeTree({
    "Asm/One.cs": "namespace One\n{\n    public class Thing\n    {\n        Alpha a;\n    }\n}\n",
    "Asm/Two.cs": "namespace Two\n{\n    public class Thing\n    {\n        Beta b;\n    }\n}\n",
    "Asm/Types.cs": "public class Alpha { }\npublic class Beta { }\n",
  });
  const dump = normalizeUnityDump({ decompiledDir: root, backend: "mono" });
  assert.deepEqual(dump.classes.filter((c) => c.name === "Thing").map((c) => c.namespace).sort(), ["One", "Two"]);
  const targets = (from) => dump.references.filter((r) => r.from === from).map((r) => r.to);
  assert.deepEqual(targets("One.Thing"), ["Alpha"]);
  assert.deepEqual(targets("Two.Thing"), ["Beta"]);
});

test("sibling classes in one file get their own reference sets", () => {
  const root = writeTree({
    "Asm/File.cs": "public class First\n{\n    Target t;\n}\npublic class Second\n{\n    Other o;\n}\npublic class Target { }\npublic class Other { }\n",
  });
  const dump = normalizeUnityDump({ decompiledDir: root, backend: "mono" });
  const targets = (from) => dump.references.filter((r) => r.from === from).map((r) => r.to);
  assert.deepEqual(targets("First"), ["Target"]);
  assert.deepEqual(targets("Second"), ["Other"]);
});

test("references also come from C# files in the dump folder", () => {
  const root = writeTree({ "dump.cs": "public class Hero\n{\n    Sword s;\n}\npublic class Sword { }\n" });
  const dump = normalizeUnityDump({ dumpDir: root, backend: "il2cpp" });
  assert.deepEqual(dump.references.map((r) => [r.from, r.to]), [["Hero", "Sword"]]);
});

test("the backend must be mono or il2cpp", async (t) => {
  assert.throws(() => normalizeUnityDump({ backend: null }), /GMF-E-EXEC-001/);
  assert.throws(() => normalizeUnityDump({ backend: "../.." }), /GMF-E-EXEC-001/);
  const workspace = { root: tempDir(t, "gmf-norm-backend-") };
  const missing = await executeOperation("unity.normalize_dump", {}, { workspace });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, "GMF-E-EXEC-001");
  const escaped = await executeOperation("unity.normalize_dump", { backend: "../.." }, { workspace });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error.code, "GMF-E-EXEC-001");
});

test("a reserved key outside the analysis sections is rejected too", () => {
  assert.throws(() => validateDump({ version: 1, engine: "unity", body: "x" }), /body/);
  assert.throws(() => validateDump({ version: 1, engine: "unity", meta: { nested: { raw: "x" } } }), /meta\.nested\.raw/);
  assert.doesNotThrow(() => validateDump({ version: 1, engine: "unity", backend: "mono", classes: [{ name: "A" }] }));
});
