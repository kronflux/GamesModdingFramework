import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCatalog } from "../scripts/build-catalog.mjs";
import { loadCatalog, getOperation } from "../src/core/catalog.mjs";
import { discoverSkills } from "../src/core/hosts.mjs";
import { repoRoot, fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const fixture = fixturePath("dummy-engine");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-catalog-"));
const outDir = path.join(root, "catalog");

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("buildCatalog writes the dummy operation and loadCatalog finds it", async () => {
  const data = await buildCatalog({ root, moduleDirs: [fixture], outDir });
  assert.equal(data.operations.length, 1);
  assert.equal(data.operations[0].id, "dummy.ping");
  const catalog = loadCatalog(root);
  assert.equal(getOperation(catalog, "dummy.ping").title, "Ping");
});

test("buildCatalog --check rejects a changed catalog", async () => {
  await buildCatalog({ root, moduleDirs: [fixture], outDir });
  fs.writeFileSync(path.join(outDir, "operations.json"), "{}\n");
  await assert.rejects(() => buildCatalog({ root, moduleDirs: [fixture], outDir, check: true }), /drift/i);
});

function writeTree(base, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

const note = (name, sources) =>
  `---\nname: ${name}\ntitle: T\ndescription: D\nengine: unity\ntags: [a]\nconfidence: observed\nsources: [${sources}]\n---\n\nBody.\n`;

test("a skill naming a missing knowledge id fails catalog generation", async (t) => {
  const base = tempDir(t, "gmf-skillref-");
  writeTree(base, {
    "knowledge/unity/a.md": note("unity.a", "origin/a.md"),
    "skills/x/SKILL.md": "---\nname: x\ndescription: d\noperations: [dummy.ping]\nknowledge: [unity.missing]\n---\n\nBody.\n",
  });
  await assert.rejects(
    () => buildCatalog({ root: base, moduleDirs: [fixture], outDir: path.join(base, "catalog") }),
    /x -> unity\.missing/,
  );
});

test("a template without kind defaults to scaffold and an unknown kind is rejected", async (t) => {
  const base = tempDir(t, "gmf-tplkind-");
  writeTree(base, {
    "templates/unity/t1/template.json": JSON.stringify({ id: "t1", engine: "unity", type: "lua", files: [] }),
  });
  const data = await buildCatalog({ root: base, moduleDirs: [fixture], outDir: path.join(base, "catalog") });
  assert.equal(data.templates[0].kind, "scaffold");
  writeTree(base, {
    "templates/unity/t2/template.json": JSON.stringify({ id: "t2", engine: "unity", kind: "widget", files: [] }),
  });
  await assert.rejects(
    () => buildCatalog({ root: base, moduleDirs: [fixture], outDir: path.join(base, "catalog") }),
    /t2.*kind/,
  );
});

test("an engine knowledge note with empty sources fails catalog generation", async (t) => {
  const base = tempDir(t, "gmf-sources-");
  writeTree(base, { "knowledge/unreal/b.md": note("unreal.b", "") });
  await assert.rejects(
    () => buildCatalog({ root: base, moduleDirs: [fixture], outDir: path.join(base, "catalog") }),
    /unreal\.b.*sources/,
  );
});

test("every operation's skill names an existing skill", () => {
  const catalog = loadCatalog(repoRoot);
  const names = new Set(discoverSkills(repoRoot).map((skill) => skill.name));
  const missing = catalog.operations.filter((op) => !names.has(op.skill)).map((op) => `${op.id} -> ${op.skill}`);
  assert.deepEqual(missing, []);
});

test("loadCatalog and buildCatalog report a corrupt catalog file instead of treating it as empty", async (t) => {
  const brokenRoot = tempDir(t, "gmf-catalog-broken-");
  const brokenDir = path.join(brokenRoot, "catalog");
  fs.mkdirSync(brokenDir, { recursive: true });
  fs.writeFileSync(path.join(brokenDir, "tools.json"), "{ nope");
  assert.throws(() => loadCatalog(brokenRoot), (error) => error.code === "GMF-E-FILE-002");
  await assert.rejects(() => buildCatalog({ root: brokenRoot, moduleDirs: [fixture], outDir: brokenDir }), (error) => error.code === "GMF-E-FILE-002");
  assert.equal(fs.readFileSync(path.join(brokenDir, "tools.json"), "utf8"), "{ nope");
});

test("two engines exporting the same operation id fail catalog generation", async (t) => {
  const dupRoot = tempDir(t, "gmf-catalog-dup-");
  const engineDir = path.join(dupRoot, "second-engine");
  fs.mkdirSync(engineDir, { recursive: true });
  const source = fs.readFileSync(path.join(fixture, "index.mjs"), "utf8").replace('id: "dummy",\n  name: "Dummy"', 'id: "second",\n  name: "Second"');
  fs.writeFileSync(path.join(engineDir, "index.mjs"), source);
  await assert.rejects(
    () => buildCatalog({ root, moduleDirs: [fixture, engineDir], outDir: path.join(dupRoot, "catalog") }),
    /Duplicate operation id dummy\.ping/,
  );
});
