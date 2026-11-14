import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildDocs, Docs } from "../src/engines/unreal/docs/build.mjs";

const GUID = "687128044B2F7CCCE37F78A0A9946AB7";

function write(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
}

function prop(name, kind, extra = {}) {
  return { name, type: kind, offset: 16, size: 8, array_dim: 1, flag_names: ["CPF_Edit"], ...extra };
}

function u64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function i32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32LE(value);
  return buffer;
}

function u32s(...values) {
  const buffer = Buffer.alloc(4 * values.length);
  values.forEach((value, i) => buffer.writeUInt32LE(value, 4 * i));
  return buffer;
}

const b = (...bytes) => Buffer.from(bytes);
const jsonl = (records) => records.map((record) => JSON.stringify(record) + "\n").join("");

/** A game called Demo: one native class, one Blueprint class, one struct, one enum. */
export function makeDump(root) {
  write(join(root, "manifest.json"), { game: "Demo", engine_version: "5.6", map: "/Game/Maps/Menu.Menu" });
  const actor = { path: "/Script/Engine.Actor", name: "Actor", super: "/Script/CoreUObject.Object", native: true,
    properties: [prop("Tags", "ArrayProperty", { inner: prop("Tags", "NameProperty") })] };
  const base = { path: "/Script/CoreUObject.Object", name: "Object", super: null, native: true, properties: [] };
  const item = { path: "/Script/Demo.Item", name: "Item", super: "/Script/Engine.Actor", native: true, size: 800,
    default_object: "/Script/Demo.Default__Item", interfaces: [],
    properties: [
      prop("Info", "StructProperty", { struct: "/Script/Demo.ItemInfo" }),
      prop("Kind", "EnumProperty", { enum: "/Script/Demo.EItemKind" }),
      prop("Owner", "ObjectProperty", { class: "/Script/Engine.Actor" }),
      prop("Prices", "MapProperty", { key: prop("k", "NameProperty"), value: prop("v", "IntProperty") }),
    ] };
  const sword = { path: "/Game/Demo/Items/BP_Sword.BP_Sword_C", name: "BP_Sword_C", super: "/Script/Demo.Item",
    native: false, size: 900, default_object: null, interfaces: [], properties: [prop("Sharpness_3_" + GUID, "FloatProperty")] };
  const editor = { path: "/Script/DemoEditor.Tool", name: "Tool", super: "/Script/CoreUObject.Object", native: true, properties: [] };
  const mode = { path: "/Script/Demo.DemoGameMode", name: "DemoGameMode", super: "/Script/Engine.GameModeBase", native: true, properties: [] };
  write(join(root, "Reflection", "classes.json"), { classes: [base, actor, item, sword, editor, mode] });
  write(join(root, "Reflection", "structs.json"), { structs: [
    { path: "/Script/Demo.ItemInfo", name: "ItemInfo", super: null, native: true, size: 24, properties: [prop("Weight", "FloatProperty")] }] });
  write(join(root, "Reflection", "enums.json"), { enums: [
    { path: "/Script/Demo.EItemKind", name: "EItemKind", entries: [{ name: "EItemKind::Tool", value: 0 }] },
    { path: "/Script/Engine.ECollisionChannel", name: "ECollisionChannel", entries: [{ name: "ECC_Pawn", value: 2 }] }] });
  const use = { path: "/Script/Demo.Item:Use", name: "Use", owner: "/Script/Demo.Item", native: true,
    flag_names: ["FUNC_Native", "FUNC_BlueprintCallable"],
    parameters: [prop("Target", "ObjectProperty", { class: "/Script/Engine.Actor" }),
      prop("Channel", "ByteProperty", { enum: "/Script/Engine.ECollisionChannel" }),
      { ...prop("ReturnValue", "BoolProperty"), return: true }] };
  const swing = { path: "/Game/Demo/Items/BP_Sword.BP_Sword_C:Swing", name: "Swing", owner: sword.path, native: false,
    flag_names: ["FUNC_BlueprintEvent"], parameters: [] };
  const signal = { path: "/Script/Demo.Item:OnUsed__DelegateSignature", name: "OnUsed__DelegateSignature",
    owner: "/Script/Demo.Item", native: false, flag_names: [], parameters: [] };
  const play = { path: "/Script/Demo.Item:PlayEffect", name: "PlayEffect", owner: "/Script/Demo.Item", native: true,
    flag_names: ["FUNC_Native"], parameters: [] };
  write(join(root, "Reflection", "functions.json"), { functions: [use, swing, signal, play] });
  write(join(root, "Hooks", "hookable_functions.json"), { functions: [
    { hook: use.path, kind: "native" }, { hook: swing.path, kind: "blueprint" }, { hook: signal.path, kind: "delegate" }] });
  write(join(root, "DataTables", "_index.json"), { tables: [
    { path: "/Game/Demo/Data/DT_Prices.DT_Prices", row_struct: "/Script/Demo.ItemInfo", rows: 3, file: "DT_Prices.json" },
    { path: "/Game/Demo/Data/DT_Deep.DT_Deep", row_struct: "/Script/Demo.ItemInfo", rows: 1, file: "DT_Deep.json" }] });
  write(join(root, "DataTables", "DT_Prices.json"), { rows: [
    { name: "Row10", values: { ["Cost_2_" + GUID]: 30, Label: "c|d" } },
    { name: "Row2", values: { ["Cost_2_" + GUID]: 20, Label: "b" } },
    { name: "Row1", values: { ["Cost_2_" + GUID]: 10, Label: "a" } }] });
  write(join(root, "DataTables", "DT_Deep.json"), { rows: [
    { name: "Only", values: { Parts: [{ Name: "Hilt", Mass: 1.5 }], Tag: { TagName: "Item.Sword" } } }] });
  write(join(root, "DataAssets", "data_assets.jsonl"), jsonl([{ schema: "omnidumper.values/1" },
    { path: "/Game/Demo/Data/DA_Rules.DA_Rules", class: "/Script/Demo.Item", values: { MaxPlayers: 4, Spawn: { X: 1, Y: 2 } } }]));
  write(join(root, "UI", "widget_trees.json"), { trees: [
    { path: "/Game/Demo/UI/W_Menu.W_Menu_C:WidgetTree", owner: "/Game/Demo/UI/W_Menu.W_Menu_C", is_template: true,
      root: "Canvas", widgets: [
        { name: "Canvas", class: "/Script/UMG.CanvasPanel", parent: "", slot_class: "" },
        { name: "PlayButton", class: "/Script/UMG.Button", parent: "Canvas", slot_class: "" },
        { name: "Label", class: "/Script/UMG.TextBlock", parent: "PlayButton", slot_class: "" }] },
    { path: "/Engine/Transient.X:WidgetTree", owner: "/Engine/Transient.X", is_template: false, root: "A",
      widgets: [{ name: "A", class: "/Script/UMG.Button", parent: "", slot_class: "" }] }] });
  write(join(root, "Levels", "levels.json"), { maps: [
    { map: "/Game/Maps/Lobby", folder: "Levels/Lobby", status: "ok", actors: 3 },
    { map: "/Game/Maps/Broken", folder: "Levels/Broken", status: "failed", error: "the map package could not be loaded" }] });
  write(join(root, "Levels", "Lobby", "actors.json"), { player_world: "/Game/Maps/Menu.Menu", actors: [
    { path: "/Game/Maps/Lobby.Lobby:PersistentLevel.Sword_1", class: "/Game/Demo/Items/BP_Sword.BP_Sword_C",
      location: [1, 2, 3], components: [{ name: "Mesh", class: "/Script/Engine.StaticMeshComponent" }] },
    { path: "/Game/Maps/Lobby.Lobby:PersistentLevel.Sword_2", class: "/Game/Demo/Items/BP_Sword.BP_Sword_C", components: [] },
    { path: "/Game/Maps/Lobby.Lobby:PersistentLevel.Start", class: "/Script/Engine.PlayerStart", components: [] }] });

  // Bytecode of the Blueprint class, as the game holds it: pointers and name indices.
  const swordClass = "/Game/Demo/Items/BP_Sword.BP_Sword_C";
  write(join(root, "Objects", "UE4SS_ObjectDump.txt"),
    `[0000000000001000] Function ${swordClass}:ExecuteUbergraph_BP_Sword [n: 1]\n`
    + `[0000000000002000] IntProperty ${swordClass}:ExecuteUbergraph_BP_Sword:EntryPoint [o: 0]\n`
    + `[0000000000003000] IntProperty ${swordClass}:Damage [o: 8]\n`
    + "[0000000000004000] Function /Script/Demo.Item:Use [n: 2]\n"
    + "[0000000000005000] StructProperty /Script/Demo.Item:Info [o: 16]\n");
  write(join(root, "Names", "fnames.csv"), "index,number,name\n77,0,PlayEffect\n");
  const stub = Buffer.concat([b(0x46), u64(0x1000), b(0x1d), i32(10), b(0x16, 0x04, 0x0b, 0x53)]);
  const graph = Buffer.concat([b(0x4e, 0x00), u64(0x2000),
    b(0x0f), u64(0x3000), b(0x01), u64(0x3000), b(0x1d), i32(5),
    b(0x1b), u32s(77, 77, 0), b(0x21), u32s(78, 78, 0), b(0x16),
    b(0x1c), u64(0x4000), b(0x16),
    b(0x0f), u64(0x5000), b(0x01), u64(0x5000), b(0x01), u64(0x5000),
    b(0x04, 0x0b, 0x53)]);
  write(join(root, "Scripts", "bytecode.jsonl"), jsonl([
    { path: `${swordClass}:ReceiveBeginPlay`, type: "Function", size: stub.length, script: stub.toString("base64") },
    { path: `${swordClass}:ExecuteUbergraph_BP_Sword`, type: "Function", size: graph.length, script: graph.toString("base64") },
    { path: `${swordClass}:Broken`, type: "Function", size: 1, script: b(0xee).toString("base64") },
    { type: "Names", names: { 78: "Glow" } }]));
  write(join(root, "Names", "gameplay_tags.txt"), "# found in dumped values\nItem.Weapon\nItem.Weapon.Sword\nState.Dead\n");
  write(join(root, "Assets", "asset_registry.json"), { assets: [
    { path: swordClass, package: "/Game/Demo/Items/BP_Sword", class: "/Script/Engine.BlueprintGeneratedClass", loaded: true },
    { path: "/Game/Demo/Items/BP_Sword.BP_Sword", package: "/Game/Demo/Items/BP_Sword", class: "/Script/Engine.Blueprint", loaded: true },
    { path: "/Game/Demo/Art/T_Sword.T_Sword", package: "/Game/Demo/Art/T_Sword", class: "/Script/Engine.Texture2D",
      loaded: false, load_result: "skipped_bulk" },
    { path: "/Engine/Basic/Cube.Cube", package: "/Engine/Basic/Cube", class: "/Script/Engine.StaticMesh", loaded: true }] });
  // What each class starts out with, and what the placed actors of the Lobby hold.
  const meshClass = "/Script/Engine.StaticMeshComponent";
  // Python's json.dumps writes 1.5 as a float and 50 as an int; JSON.stringify keeps both.
  write(join(root, "Reflection", "class_defaults.jsonl"), jsonl([
    { schema: "omnidumper.class_defaults/1" },
    { path: "/Script/Engine.Default__Actor", class: "/Script/Engine.Actor", values: { bHidden: false, Tags: [] } },
    { path: "/Script/Demo.Default__Item", class: "/Script/Demo.Item",
      values: { bHidden: false, Tags: [], Damage: 1, Info: { Weight: 1.5 }, Root: "/Script/Demo.Default__Item:Light" } },
    { path: "/Game/Demo/Items/BP_Sword.Default__BP_Sword_C", class: swordClass,
      values: { bHidden: true, Tags: [], Damage: 7, Info: { Weight: 1.5 }, Root: "/Game/Demo/Items/BP_Sword.Default__BP_Sword_C:Light" } },
    { path: "/Script/Engine.Default__StaticMeshComponent", class: meshClass, values: { RelativeLocation: { X: 0, Y: 0, Z: 0 }, CastShadow: true } },
    { path: `${swordClass}:Mesh_GEN_VARIABLE`, class: meshClass, owner_class: swordClass,
      values: { RelativeLocation: { X: 0, Y: 0, Z: 10 }, CastShadow: true } },
    // A component a native class creates sits under its default object. A line may lack
    // owner_class; the path then says which class the template belongs to.
    { path: "/Script/Demo.Default__Item:Light", class: "/Script/Engine.PointLightComponent", values: { Intensity: 50 } },
    { path: `${swordClass}:Light_GEN_VARIABLE:Nested`, class: "/Script/Engine.PointLightComponent", values: { Intensity: 1 } }]));
  const level = "/Game/Maps/Lobby.Lobby:PersistentLevel.";
  const swordActor = (name, x) => ({ path: level + name, class: swordClass,
    values: { bHidden: true, Tags: [], Damage: 9, Info: { Weight: 1.5 }, Owner: level + name,
      Root: level + name + ":Light", MeshRef: level + name + ":Mesh" },
    components: [{ name: "Mesh", class: meshClass, values: { RelativeLocation: { X: x, Y: 2, Z: 3 }, CastShadow: false } }] });
  write(join(root, "Levels", "Lobby", "actor_values.jsonl"), jsonl([
    { schema: "omnidumper.actor_values/1" }, swordActor("Sword_1", 1), swordActor("Sword_2", 4),
    { path: level + "WorldSettings", class: "/Script/Engine.WorldSettings", values: { DefaultGameMode: "/Script/Demo.DemoGameMode" }, components: [] },
    { path: level + "Start", class: "/Script/Engine.PlayerStart", values: { bHidden: false, Tags: ["Spawn"] }, components: [] }]));
}

const temp = mkdtempSync(join(tmpdir(), "gmf-docs-build-"));
const dump = join(temp, "run");
const out = join(temp, "out");
makeDump(dump);
const result = await buildDocs(dump, out);
test.after(() => rmSync(temp, { recursive: true, force: true }));

const read = (relative) => readFileSync(join(out, ...relative.split("/")), "utf8");
const exists = (relative) => existsSync(join(out, ...relative.split("/")));
const between = (text, start, end) => text.slice(text.indexOf(start), end ? text.indexOf(end) : undefined);

test("the build succeeds and every link resolves", () => {
  assert.deepEqual(result.brokenLinks, []);
  assert.ok(result.files > 10);
  assert.ok(result.bytes > 1000);
});

test("game types get files that mirror their paths", () => {
  assert.ok(exists("classes/Script/Demo/Item.md"));
  assert.ok(exists("classes/Game/Demo/Items/BP_Sword_C.md"));
  assert.ok(exists("structs/Script/Demo/ItemInfo.md"));
  assert.ok(exists("enums/Script/Demo/EItemKind.md"));
});

test("engine types and lookalike modules get no file of their own", () => {
  assert.ok(!exists("classes/Script/Engine/Actor.md"));
  assert.ok(!exists("classes/Script/DemoEditor/Tool.md"), "DemoEditor is not the Demo module");
});

test("engine types the game refers to become stubs", () => {
  const stubs = read("engine/Engine.md");
  assert.ok(stubs.includes("**Actor** `/Script/Engine.Actor`: class, parents Object, 1 properties"));
  assert.ok(stubs.includes("**ECollisionChannel**"), "an engine enum used only as a parameter type is still a stub");
  assert.ok(stubs.includes("ECC_Pawn=2"));
  assert.ok(!stubs.includes("Tool"), "an engine type nothing refers to is left out");
});

test("a class page has front matter, lineage and typed properties", () => {
  const page = read("classes/Script/Demo/Item.md");
  assert.ok(page.startsWith('---\nkind: "class"\ntitle: "Item"\npath: "/Script/Demo.Item"\n'));
  assert.ok(page.includes('parent: "/Script/Engine.Actor"'));
  assert.ok(page.includes("**Inheritance:** **Item** → `Actor` → `Object`"));
  assert.ok(page.includes("| `Info` | [ItemInfo](../../../structs/Script/Demo/ItemInfo.md) | 0x10 | 8 | Edit |"));
  assert.ok(page.includes("| `Kind` | [EItemKind](../../../enums/Script/Demo/EItemKind.md) |"));
  assert.ok(page.includes("| `Owner` | `Actor`* |"));
  assert.ok(page.includes("| `Prices` | TMap<FName, int32> |"));
  assert.ok(page.includes("**Derived classes:** [BP_Sword_C](../../Game/Demo/Items/BP_Sword_C.md)"));
});

test("functions show signature, kind and whether they can be hooked", () => {
  const page = read("classes/Script/Demo/Item.md");
  assert.ok(page.includes("The name to pass to `RegisterHook` is `/Script/Demo.Item:<FunctionName>`."));
  assert.ok(page.includes("| `bool Use(Actor* Target, ECollisionChannel Channel)` | native, BP callable | yes, before and after |"));
  assert.ok(page.includes("| `void OnUsed__DelegateSignature()` | Blueprint | no, delegate signature |"));
  const sword = read("classes/Game/Demo/Items/BP_Sword_C.md");
  assert.ok(sword.includes("| `void Swing()` | Blueprint, BP event | yes, after |"));
  assert.ok(sword.includes('RegisterHook("/Game/Demo/Items/BP_Sword.BP_Sword_C:Swing"'));
});

test("Blueprint member names are shown readable, with the raw name", () => {
  const sword = read("classes/Game/Demo/Items/BP_Sword_C.md");
  assert.ok(sword.includes(`| \`Sharpness\` (raw \`Sharpness_3_${GUID}\`) | float |`));
  assert.ok(sword.includes("Inherited properties are listed with the class that declares them: [Item](../../../Script/Demo/Item.md) (4), `Actor` (1)."));
});

test("a flat data table is a markdown table in natural row order", () => {
  const page = read("data_tables/Game/Demo/Data/DT_Prices.md");
  assert.ok(page.includes("| Row | Cost | Label |"));
  assert.ok(page.includes(`\`Cost\` is \`Cost_2_${GUID}\``));
  assert.ok(page.indexOf("`Row1`") < page.indexOf("`Row2`"));
  assert.ok(page.indexOf("`Row2`") < page.indexOf("`Row10`"));
  assert.ok(page.includes('| `Row10` | 30 | "c\\|d" |'), "a pipe inside a value does not break the table");
  assert.ok(page.includes("Row struct: [ItemInfo](../../../../structs/Script/Demo/ItemInfo.md)"));
});

test("nested data table rows become sections", () => {
  const page = read("data_tables/Game/Demo/Data/DT_Deep.md");
  assert.ok(page.includes("## Only"));
  assert.ok(page.includes("- **Parts:**"));
  assert.ok(page.includes('**Name:** `"Hilt"`'));
});

test("a data asset page lists values and links its class", () => {
  const page = read("data_assets/Game/Demo/Data/DA_Rules.md");
  assert.ok(page.includes("of class [Item](../../../../classes/Script/Demo/Item.md)"));
  assert.ok(page.includes("- **MaxPlayers:** `4`"));
  assert.ok(page.includes("- **Spawn:**"));
});

test("a widget tree is a nested list and live copies are left out", () => {
  const page = read("ui/Game/Demo/UI/W_Menu_C.md");
  assert.ok(page.includes("- `Canvas` (`CanvasPanel`)\n  - `PlayButton` (`Button`)\n    - `Label` (`TextBlock`)"));
  assert.ok(!exists("ui/Engine/X.md"));
});

test("Referenced by points back from a struct to its users", () => {
  assert.ok(read("structs/Script/Demo/ItemInfo.md").includes("## Referenced by\n\n[Item](../../../classes/Script/Demo/Item.md)"));
});

test("every folder has an index and the top has a README", () => {
  assert.ok(read("classes/Script/Demo/_index.md").includes("[Item](Item.md): Native class, parent Actor, 4 properties, 3 functions"));
  assert.ok(read("classes/Script/_index.md").includes("- [Demo/](Demo/_index.md): 2 documents"));
  const readme = read("README.md");
  assert.ok(readme.includes("# Demo modding reference"));
  assert.ok(readme.includes("- [classes/](classes/_index.md): 4 documents"));
});

test("the search index has one record per document", () => {
  const records = read("index.jsonl").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  assert.equal(new Set(records.map((r) => r.file)).size, records.length);
  for (const record of records) {
    assert.ok(exists(record.file), record.file);
    assert.deepEqual(Object.keys(record).sort(), ["file", "id", "keywords", "kind", "summary", "title"]);
  }
  const item = records.find((r) => r.id === "/Script/Demo.Item");
  assert.equal(item.kind, "class");
  assert.ok(item.keywords.includes("Use"));
  assert.ok(item.keywords.includes("Prices"));
});

test("each level read as data gets an actor page and the levels are listed", () => {
  const page = read("levels/Lobby/actors.md");
  assert.ok(page.includes("# Actors of Lobby"));
  assert.ok(page.includes("Map `/Game/Maps/Lobby`, 3 actors"));
  assert.ok(!page.includes("/Game/Maps/Menu.Menu"), "the level is not the one the player was in");
  assert.ok(page.includes("| [BP_Sword_C](../../classes/Game/Demo/Items/BP_Sword_C.md) | 2 |"));
  assert.ok(page.includes("| `Sword_1` |"));
  assert.ok(page.includes("1.0, 2.0, 3.0"));
  const listing = read("levels/levels.md");
  assert.ok(listing.includes("| [Lobby](Lobby/actors.md) | `/Game/Maps/Lobby` | ok | 3 |"));
  assert.ok(listing.includes("| `Broken` | `/Game/Maps/Broken` | failed |  | the map package could not be loaded |"));
  assert.ok(!exists("levels/Broken/actors.md"));
});

test("Blueprint bytecode is shown as statements beside its class", () => {
  const page = read("classes/Game/Demo/Items/BP_Sword_C.script.md");
  assert.ok(page.includes("## ReceiveBeginPlay"));
  assert.ok(page.includes("```text\nBP_Sword_C::ExecuteUbergraph_BP_Sword(0x000A)"), "a function without jumps is shown structured, without offsets");
  assert.ok(page.includes("Flat listing: event graph, entered at the marked offsets."));
  assert.ok(page.includes("000A: self.Damage = 5    ; entry of ReceiveBeginPlay"));
  assert.ok(page.includes('PlayEffect(name("Glow"))'), "a name only bytecode uses comes from the Names record of the script file");
  assert.ok(page.includes("## Broken"));
  assert.ok(page.includes("could not be decoded: unknown opcode 0xEE"));
  assert.ok(read("classes/Game/Demo/Items/BP_Sword_C.md").includes("[3 functions as statements](BP_Sword_C.script.md)"));
});

test("gameplay tags are listed by root", () => {
  const page = read("names/gameplay_tags.md");
  assert.ok(page.includes("## Item\n\n- `Item.Weapon`\n- `Item.Weapon.Sword`"));
  assert.ok(page.includes("## State\n\n- `State.Dead`"));
  assert.ok(page.includes("not the game's full tag list"));
});

test("assets are listed by content folder and link to their documents", () => {
  const page = read("assets/Game/Demo/Items.md");
  assert.ok(page.includes("| [BP_Sword_C](../../../classes/Game/Demo/Items/BP_Sword_C.md) | BlueprintGeneratedClass | "
    + "`/Game/Demo/Items/BP_Sword.BP_Sword_C` |"));
  assert.ok(page.includes("| `BP_Sword` | Blueprint | `/Game/Demo/Items/BP_Sword.BP_Sword` |"));
  assert.ok(read("assets/Game/Demo/Art.md").includes("| `T_Sword` | Texture2D | `/Game/Demo/Art/T_Sword.T_Sword` |"));
  assert.ok(exists("assets/Engine/Basic.md"), "engine assets are listed too: a mod may refer to them");
});

test("a class page shows the defaults that differ from the parent class", () => {
  const sword = read("classes/Game/Demo/Items/BP_Sword_C.md");
  let section = between(sword, "## Default values", "## Use from");
  assert.ok(section.includes("| bHidden | `true` |"));
  assert.ok(section.includes("| Damage | `7` |"));
  assert.ok(!section.includes("| Info |"), "the same as in the parent class");
  assert.ok(!section.includes("Tags"));
  assert.ok(!section.includes("| Root |"), "a pointer into the class's own default object is the same thing in parent and child");
  assert.ok(section.includes("### Mesh\n\n`StaticMeshComponent`"));
  assert.ok(section.includes("| RelativeLocation | `X=0 Y=0 Z=10` |"));
  assert.ok(!section.includes("CastShadow"), "the same as the component class default");
  const item = read("classes/Script/Demo/Item.md");
  section = between(item, "## Default values", "## Use from");
  assert.ok(section.includes("### Light\n\n`PointLightComponent`"), "a template under the default object belongs to its class");
  assert.ok(section.includes("| Intensity | `50` |"));
  assert.ok(!sword.includes("Nested"), "an object inside a template is not a component of the class");
  assert.ok(section.includes("| Damage | `1` |"));
  assert.ok(section.includes("| Info | `Weight=1.5` |"), "a small struct stays one entry");
  assert.ok(!section.includes("bHidden"));
});

test("level values show only what differs from the class defaults", () => {
  const page = read("levels/Lobby/values/BP_Sword_C.md");
  assert.ok(page.includes("2 actors"));
  const shared = between(page, "## Same on every actor", "## Per actor");
  assert.ok(shared.includes("| Damage | `9` |"));
  assert.ok(shared.includes("| Owner | `<self>` |"), "a reference to the actor itself is the same for every actor");
  assert.ok(shared.includes("| Mesh.CastShadow | `false` |"));
  assert.ok(!page.includes("bHidden"), "equal to the class default");
  assert.ok(!page.includes("| Root |"), "points at the actor's own copy of what the class default points at");
  assert.ok(!page.includes("MeshRef"), "a pointer to one of the actor's own components says nothing about the level");
  const perActor = between(page, "## Per actor");
  assert.ok(perActor.includes("| Actor | Mesh.RelativeLocation |"));
  assert.ok(perActor.includes("| `Sword_1` | `X=1 Y=2 Z=3` |"));
  assert.ok(perActor.includes("| `Sword_2` | `X=4 Y=2 Z=3` |"));
  const start = read("levels/Lobby/values/PlayerStart.md");
  assert.ok(start.includes("1 actor"));
  assert.ok(start.includes('| Tags | `["Spawn"]` |'));
  assert.ok(!start.includes("## Per actor"));
  assert.ok(read("levels/Lobby/actors.md").includes("[values/](values/_index.md)"));
});

test("a class page lists the scripts that use its members", () => {
  const item = read("classes/Script/Demo/Item.md");
  const section = between(item, "## Used by", "## Default values");
  const user = "[BP_Sword_C](../../Game/Demo/Items/BP_Sword_C.script.md): `ExecuteUbergraph_BP_Sword`";
  assert.ok(section.includes(`| \`Use\` | ${user} |`));
  assert.ok(section.includes(`| \`Info\` | ${user} |`));
  assert.ok(section.includes(`| \`PlayEffect\` (by name) | ${user} |`));
  assert.ok(!read("classes/Game/Demo/Items/BP_Sword_C.md").includes("## Used by"),
    "a class using its own members is not listed: its script page shows that");
});

test("the overview names the classes a mod starts from and the game mode of each map", () => {
  const page = read("overview.md");
  assert.ok(page.includes("## Game modes\n\n- [DemoGameMode](classes/Script/Demo/DemoGameMode.md)"));
  assert.ok(page.includes("| [Lobby](levels/Lobby/actors.md) | [DemoGameMode](classes/Script/Demo/DemoGameMode.md) | 3 |"));
  assert.ok(page.includes("| `Broken` | | |"));
  assert.ok(page.includes("- [BP_Sword_C](classes/Game/Demo/Items/BP_Sword_C.script.md): 8 statements in 3 functions"));
  assert.ok(read("README.md").includes("[overview.md](overview.md)"));
});

test("documents over the size limit are written in parts with working links", () => {
  const docs = new Docs(dump, join(temp, "small"));
  docs.maxBytes = 1200;
  docs.build();
  const parts = [...docs.files.keys()].filter((name) => name.includes(".part2."));
  assert.ok(parts.length);
  assert.deepEqual(docs.brokenLinks(), []);
  const records = new Map(docs.records.map((record) => [record.file, record]));
  assert.equal(records.size, docs.records.length);
  for (const name of parts) {
    assert.ok(records.has(name));
    assert.ok(records.get(name).title.includes("part 2 of"));
  }
});

test("a folder without a manifest is refused", async () => {
  await assert.rejects(buildDocs(temp, join(temp, "none")), /no manifest\.json/);
});

test("sections report their pages, and a section without input is missing with the manifest's reason", async () => {
  const byName = new Map(result.sections.map((s) => [s.name, s]));
  assert.deepEqual(result.sections.map((s) => s.name),
    ["defaults", "scripts", "reflection", "data", "world", "asset_values", "levels", "tags", "assets", "containers", "console", "overview"]);
  assert.equal(byName.get("scripts").pages, 1);
  assert.ok(byName.get("defaults").pages >= 1, "the level value pages are counted for the defaults section");
  assert.equal(byName.get("world").missing, "not collected");
  assert.equal(byName.get("levels").missing, undefined);

  const bare = join(temp, "bare");
  write(join(bare, "manifest.json"), { schema: "gmfdumper.manifest/1", game: "Demo",
    steps: [{ id: "scripts", status: "skipped", reason: "native unavailable" }] });
  const built = await buildDocs(bare, join(temp, "bare-out"));
  const scripts = built.sections.find((s) => s.name === "scripts");
  assert.deepEqual(scripts, { name: "scripts", pages: 0, missing: "the native part did not load" });
  assert.equal(built.sections.find((s) => s.name === "tags").missing, "not collected");
});

test("a manifest of another program is refused; both dumper schema prefixes are read", async () => {
  const other = join(temp, "other");
  write(join(other, "manifest.json"), { schema: "somethingelse.manifest/1" });
  await assert.rejects(buildDocs(other, join(temp, "other-out")), /not a dumper schema/);
  const gmf = join(temp, "gmf");
  write(join(gmf, "manifest.json"), { schema: "gmfdumper.manifest/1", game: "Demo" });
  write(join(gmf, "DataAssets", "data_assets.jsonl"), jsonl([{ schema: "gmfdumper.values/1" },
    { path: "/Game/D/DA_X.DA_X", class: "/Script/Demo.Item", values: { A: 1 } }]));
  await buildDocs(gmf, join(temp, "gmf-out"));
  assert.ok(existsSync(join(temp, "gmf-out", "data_assets", "Game", "D", "DA_X.md")));
});
