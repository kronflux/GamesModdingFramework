// unreal.build_docs: where the docs may be written, what a rebuild replaces, what a run without
// the native part still yields, and the sections added on top of the ported builder.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeOperation, registerOperation, getHandler } from "../src/core/operations.mjs";
import { buildDocsOperation, resolveDocsDir } from "../src/engines/unreal/operations/docs.mjs";
import { buildDocs } from "../src/engines/unreal/docs/build.mjs";
import { tempDir } from "./helpers/tmp.mjs";
import { snapshotTree } from "./helpers/tree.mjs";

if (!getHandler(buildDocsOperation.id)) registerOperation(buildDocsOperation, buildDocsOperation.handler);

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

const HEADER = JSON.stringify({ schema: "gmfdumper.values/1", kind: "asset values" });

// A workspace with one collected run. `native: false` marks the native steps skipped.
function makeWorkspace(t, { native = true } = {}) {
  const root = tempDir(t, "gmf-docs-");
  const run = path.join(root, "dumps", "unreal", "runs", "Demo-5.6-20261113-000000");
  // The reason the mod really writes when its native part is absent (runner.lua, skip_reason).
  const skipped = (id) => ({ id, status: "skipped", reason: "native unavailable", files: [] });
  const ok = (id) => ({ id, status: "ok", files: [] });
  write(path.join(run, "manifest.json"), {
    schema: "gmfdumper.manifest/1", game: "Demo", engine_version: "5.6", finished: "2026-11-13T00:00:00",
    steps: native
      ? [ok("reflection"), ok("asset_values"), ok("scripts")]
      : [skipped("reflection"), skipped("asset_values"), skipped("scripts"), skipped("class_defaults")],
  });
  write(path.join(run, "run_complete.json"), { schema: "gmfdumper.run_complete/1", produced: true, native });
  if (native) {
    write(path.join(run, "Assets", "asset_values.jsonl"), [
      HEADER,
      JSON.stringify({ path: "/Game/Audio/SC_Master.SC_Master", class: "/Script/Engine.SoundClass", values: { Volume: 0.5, Pitch: 1 } }),
      JSON.stringify({ path: "/Game/Input/IA_Jump.IA_Jump", class: "/Script/EnhancedInput.InputAction", values: {} }),
      "",
    ].join("\n"));
  }
  return { root, run, context: { workspace: { root, config: { version: 1 }, local: { version: 1 }, profile: null } } };
}

test("build_docs writes gamedocs with its marker, and a second build replaces the first", async (t) => {
  const ws = makeWorkspace(t);
  const first = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(first.ok, true, first.error?.message);
  const docs = path.join(ws.root, "gamedocs");
  assert.equal(first.data.outputDir, docs);
  assert.equal(first.data.run, "Demo-5.6-20261113-000000");
  const marker = JSON.parse(fs.readFileSync(path.join(docs, ".gmfdocs"), "utf8"));
  assert.equal(marker.schema, "gmf.docs/1");
  assert.equal(marker.run, "Demo-5.6-20261113-000000");
  assert.ok(fs.existsSync(path.join(docs, "README.md")));
  assert.ok(fs.existsSync(path.join(docs, "index.jsonl")));

  fs.writeFileSync(path.join(docs, "stale.md"), "left from the first build\n");
  const second = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(second.ok, true, second.error?.message);
  assert.equal(fs.existsSync(path.join(docs, "stale.md")), false, "the previous build is replaced as a whole");
  assert.equal(fs.existsSync(`${docs}.building`), false, "no build folder is left behind");
});

test("AC-13: a folder that is not a docs build, and a path outside the workspace, are refused untouched", async (t) => {
  const ws = makeWorkspace(t);
  write(path.join(ws.root, "notes", "mine.md"), "keep me\n");
  const before = snapshotTree(path.join(ws.root, "notes"));
  const foreign = await executeOperation("unreal.build_docs", { outputDir: "notes" }, ws.context);
  assert.equal(foreign.ok, false);
  assert.match(foreign.error.message, /not a docs build/);
  assert.deepEqual(snapshotTree(path.join(ws.root, "notes")), before);

  const outside = tempDir(t, "gmf-docs-outside-");
  for (const outputDir of [outside, path.join("gamedocs", "..", ".."), ".", path.join("..", "x")]) {
    const result = await executeOperation("unreal.build_docs", { outputDir }, ws.context);
    assert.equal(result.ok, false, outputDir);
    assert.equal(result.error.code, "GMF-E-PLAN-001", outputDir);
    assert.match(result.error.message, /inside the workspace/, outputDir);
  }
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(ws.root, "gamedocs")), false, "nothing was built");
});

test("resolveDocsDir accepts a folder below the workspace and refuses the workspace itself", () => {
  const root = path.resolve("ws-root");
  assert.equal(resolveDocsDir(root, "gamedocs"), path.join(root, "gamedocs"));
  assert.equal(resolveDocsDir(root, path.join("a", "b")), path.join(root, "a", "b"));
  assert.throws(() => resolveDocsDir(root, ""), /inside the workspace/);
  assert.throws(() => resolveDocsDir(root, root), /inside the workspace/);
});

test("AC-12: a run without the native part still yields docs, and README lists what is missing and why", async (t) => {
  const ws = makeWorkspace(t, { native: false });
  const result = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(result.ok, true, result.error?.message);
  const readme = fs.readFileSync(path.join(ws.root, "gamedocs", "README.md"), "utf8");
  assert.match(readme, /## Missing sections/);
  assert.match(readme, /- scripts: the native part did not load/);
  assert.match(readme, /- asset_values: the native part did not load/);
  assert.match(readme, /- containers: containers not read; run unreal\.read_containers/);
  const missing = Object.fromEntries(result.data.missing.map((entry) => [entry.name, entry.reason]));
  assert.equal(missing.reflection, "the native part did not load");
});

test("a section whose step failed says so with the error", async (t) => {
  const ws = makeWorkspace(t, { native: false });
  const manifestPath = path.join(ws.run, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.steps = [{ id: "scripts", status: "failed", error: "access violation at 0x10\nstack: ...", files: [] }];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const built = await buildDocs(ws.run, path.join(ws.root, "out-failed"));
  assert.equal(built.sections.find((s) => s.name === "scripts").missing, "failed: access violation at 0x10");
});

test("asset values become one page per asset that has values, linked from the search index", async (t) => {
  const ws = makeWorkspace(t);
  const out = path.join(ws.root, "out");
  const built = await buildDocs(ws.run, out);
  const page = fs.readFileSync(path.join(out, "asset_values", "Game", "Audio", "SC_Master.md"), "utf8");
  assert.match(page, /kind: "asset_values"/);
  assert.match(page, /class: "\/Script\/Engine\.SoundClass"/);
  assert.match(page, /\*\*Volume:\*\* `0\.5`/);
  assert.equal(fs.existsSync(path.join(out, "asset_values", "Game", "Input", "IA_Jump.md")), false, "an asset with no values gets no page");
  assert.equal(built.sections.find((s) => s.name === "asset_values").pages, 1);
  const index = fs.readFileSync(path.join(out, "index.jsonl"), "utf8");
  assert.match(index, /"\/Game\/Audio\/SC_Master\.SC_Master"/);
  assert.deepEqual(built.brokenLinks, []);
});

test("container text is added when textDir is given, and reported missing when it is not", async (t) => {
  const ws = makeWorkspace(t);
  const textDir = path.join(ws.root, "extracted", "unreal", "text");
  write(path.join(textDir, "Demo-Windows", "Demo", "Config", "DefaultGame.ini"), "[/Script/Demo.Settings]\nSpeed=600\n+Maps=/Game/A\n");
  write(path.join(textDir, "Demo-Windows", "Demo", "Plugins", "Fun", "Fun.uplugin"), { FriendlyName: "Fun", VersionName: "1.0" });
  const without = await buildDocs(ws.run, path.join(ws.root, "out-a"));
  assert.equal(without.sections.find((s) => s.name === "containers").missing, "containers not read; run unreal.read_containers");

  const out = path.join(ws.root, "out-b");
  const built = await buildDocs(ws.run, out, { textDir });
  const containers = built.sections.find((s) => s.name === "containers");
  assert.equal(containers.missing, undefined);
  assert.equal(containers.pages, 2);
  const settings = fs.readFileSync(path.join(out, "settings", "Demo__Config__DefaultGame.md"), "utf8");
  assert.match(settings, /kind: "settings"/);
  assert.match(settings, /\| Maps \| \+ \| \/Game\/A \|/);
  assert.ok(fs.existsSync(path.join(out, "plugins.md")));
  assert.match(fs.readFileSync(path.join(out, "README.md"), "utf8"), /settings\//);
  assert.match(fs.readFileSync(path.join(out, "index.jsonl"), "utf8"), /"kind": ?"settings"/);
  assert.deepEqual(built.brokenLinks, []);

  // The operation finds the extracted text by itself.
  const viaOperation = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(viaOperation.ok, true, viaOperation.error?.message);
  assert.ok(fs.existsSync(path.join(ws.root, "gamedocs", "settings", "Demo__Config__DefaultGame.md")));
});

test("an outputDir that names a file is refused and the file is kept", async (t) => {
  const ws = makeWorkspace(t);
  write(path.join(ws.root, "notes.md"), "keep me\n");
  const result = await executeOperation("unreal.build_docs", { outputDir: "notes.md" }, ws.context);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-PLAN-001");
  assert.match(result.error.message, /not a folder/);
  assert.equal(fs.readFileSync(path.join(ws.root, "notes.md"), "utf8"), "keep me\n");
});

test("a swap that fails keeps the previous docs with their marker, and the next build succeeds", async (t) => {
  const ws = makeWorkspace(t);
  assert.equal((await executeOperation("unreal.build_docs", {}, ws.context)).ok, true);
  const docs = path.join(ws.root, "gamedocs");
  fs.writeFileSync(path.join(docs, "from-first-build.md"), "first\n");

  // The second rename (the new docs into place) fails, as when a program holds the folder open.
  let renames = 0;
  const fsImpl = { ...fs, renameSync: (from, to) => {
    renames += 1;
    if (renames === 2) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    return fs.renameSync(from, to);
  } };
  const failed = await executeOperation("unreal.build_docs", {}, { ...ws.context, fsImpl });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "GMF-E-EXEC-001");
  assert.ok(fs.existsSync(path.join(docs, ".gmfdocs")), "the marker of the previous build is still there");
  assert.ok(fs.existsSync(path.join(docs, "from-first-build.md")), "the previous docs are still there");
  assert.equal(fs.existsSync(`${docs}.old`), false);
  assert.equal(fs.existsSync(`${docs}.building`), false);

  const again = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(again.ok, true, again.error?.message);
  assert.equal(fs.existsSync(path.join(docs, "from-first-build.md")), false);
});

test("leftovers of an interrupted build are cleaned when they are ours and refused when they are not", async (t) => {
  const ws = makeWorkspace(t);
  const docs = path.join(ws.root, "gamedocs");
  write(path.join(`${docs}.building`, ".gmfdocs"), "{}");
  write(path.join(`${docs}.old`, ".gmfdocs"), "{}");
  const cleaned = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(cleaned.ok, true, cleaned.error?.message);
  assert.equal(fs.existsSync(`${docs}.old`), false);

  write(path.join(`${docs}.old`, "someone-elses.txt"), "x");
  const refused = await executeOperation("unreal.build_docs", {}, ws.context);
  assert.equal(refused.ok, false);
  assert.match(refused.error.message, /not a docs build/);
  assert.ok(fs.existsSync(path.join(`${docs}.old`, "someone-elses.txt")));
});
