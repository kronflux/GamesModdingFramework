// Removing the run files the docs distilled: what goes, what stays, when it is refused, and that
// a pruned run still verifies but cannot build docs again.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { executeOperation, registerOperation, getHandler } from "../src/core/operations.mjs";
import { buildDocsOperation, pruneRun } from "../src/engines/unreal/operations/docs.mjs";
import { verifyRun } from "../src/engines/unreal/operations/verify_dump.mjs";
import { DISTILLED } from "../src/engines/unreal/docs/build.mjs";
import { tempDir } from "./helpers/tmp.mjs";

if (!getHandler(buildDocsOperation.id)) registerOperation(buildDocsOperation, buildDocsOperation.handler);

function write(file, text = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A collected run holding one distilled file and one kept file per kind, listed in its manifest.
function makeRun(root) {
  const run = path.join(root, "dumps", "unreal", "runs", "Demo-5.6-20261114-000000");
  const files = {
    reflection: "Reflection/classes.json", scripts: "Scripts/bytecode.jsonl", level: "Levels/Lobby/actors.json",
    table: "DataTables/DT_A.json", usmap: "Mappings/Demo.usmap", jmap: "Mappings/Demo.jmap", objects: "Objects/UE4SS_ObjectDump.txt",
    hooks: "Hooks/hookable_functions.json", names: "Names/fnames.csv", lua: "LuaTypes/Types.lua",
  };
  // Each file holds the smallest content its reader accepts.
  const content = (file) => (file.endsWith(".json") ? "{}" : file.endsWith(".jsonl") ? "" : "x");
  for (const file of Object.values(files)) write(path.join(run, ...file.split("/")), content(file));
  const entries = Object.values(files).map((file) => ({ path: file, bytes: Buffer.byteLength(content(file)) }));
  write(path.join(run, "manifest.json"), JSON.stringify({ schema: "gmfdumper.manifest/1", finished: "x", steps: [{ id: "all", status: "ok", files: entries }] }));
  write(path.join(run, "run_complete.json"), JSON.stringify({ schema: "gmfdumper.run_complete/1", profile: "quick", produced: true }));
  return { run, files };
}

test("pruneRun removes only distilled files, keeps tool inputs, records pruned.json, and the run still verifies", (t) => {
  const root = tempDir(t, "gmf-prune-");
  const { run, files } = makeRun(root);
  const result = pruneRun(run, path.join(root, "dumps", "unreal", "runs"), { verified: verifyRun(run), missing: [], docs: "gamedocs" });
  assert.equal(result.done, true);
  assert.deepEqual(result.removed, ["Reflection/classes.json", "Scripts/bytecode.jsonl", "Levels/", "DataTables/"]);
  for (const kept of ["usmap", "jmap", "objects", "hooks", "names", "lua"]) {
    assert.ok(fs.existsSync(path.join(run, ...files[kept].split("/"))), `${kept} stays`);
  }
  for (const gone of ["reflection", "scripts", "level", "table"]) {
    assert.equal(fs.existsSync(path.join(run, ...files[gone].split("/"))), false, `${gone} is removed`);
  }
  assert.equal(fs.existsSync(path.join(run, "Reflection")), false, "a folder left empty is removed");
  assert.equal(fs.existsSync(path.join(run, "Scripts")), false);
  assert.ok(fs.existsSync(path.join(run, "Names", "fnames.csv")), "a folder that still holds a kept file stays");
  const record = JSON.parse(fs.readFileSync(path.join(run, "pruned.json"), "utf8"));
  assert.equal(record.schema, "gmf.pruned_run/1");
  assert.deepEqual(verifyRun(run), { pass: true, problems: [] }, "files removed on purpose are not problems");

  fs.rmSync(path.join(run, "Mappings", "Demo.usmap"));
  assert.match(verifyRun(run).problems.join("\n"), /missing file Mappings\/Demo\.usmap/, "a kept file that vanished still fails");
});

test("DISTILLED never names a tool input", () => {
  for (const entry of DISTILLED) assert.doesNotMatch(entry, /^(Mappings|Headers|LuaTypes|SDK|Objects|Hooks)\/|fnames/, entry);
});

test("pruneRun refuses a run outside the workspace runs folder, an unverified run, and a build with missing sections", (t) => {
  const root = tempDir(t, "gmf-prune-refuse-");
  const { run } = makeRun(root);
  const runs = path.join(root, "dumps", "unreal", "runs");
  const ok = { pass: true, problems: [] };
  assert.equal(pruneRun(run, path.join(root, "elsewhere"), { verified: ok, missing: [], docs: "d" }).reason, "the run is not in dumps/unreal/runs");
  assert.match(pruneRun(run, runs, { verified: { pass: false, problems: ["step x: failed"] }, missing: [], docs: "d" }).reason, /did not pass verification: step x/);
  assert.equal(pruneRun(run, runs, { verified: ok, missing: [{ name: "scripts" }], docs: "d" }).reason, "sections are missing: scripts");
  assert.ok(fs.existsSync(path.join(run, "Reflection", "classes.json")), "nothing was removed");
  assert.equal(fs.existsSync(path.join(run, "pruned.json")), false);
});

test("build_docs refuses a pruned run, and leaves a run with missing sections unpruned", async (t) => {
  const root = tempDir(t, "gmf-prune-op-");
  const { run } = makeRun(root);
  const context = { workspace: { root, config: { version: 1 }, local: { version: 1 }, profile: null } };
  const first = await executeOperation("unreal.build_docs", {}, context);
  assert.equal(first.ok, true, first.error?.message);
  assert.equal(first.data.pruned.done, false);
  assert.match(first.data.pruned.reason, /^sections are missing: /);
  assert.ok(fs.existsSync(path.join(run, "Reflection", "classes.json")));

  write(path.join(run, "pruned.json"), JSON.stringify({ schema: "gmf.pruned_run/1", removed: [] }));
  const again = await executeOperation("unreal.build_docs", {}, context);
  assert.equal(again.ok, false);
  assert.match(again.error.message, /was pruned after its docs were built/);
});
