import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { registerOperation, getHandler } from "../src/core/operations.mjs";
import { verifyRun, verifyDumpOperation } from "../src/engines/unreal/operations/verify_dump.mjs";
import { tempDir } from "./helpers/tmp.mjs";

if (!getHandler(verifyDumpOperation.id)) registerOperation(verifyDumpOperation, verifyDumpOperation.handler);

function write(root, relative, text) {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A complete run in `root`; `edit` can change the manifest or the completion record before they are written.
function makeRun(root, { edit } = {}) {
  write(root, "Objects/dump.txt", "12345");
  write(root, "Headers/CXX/a.hpp", "abc");
  const manifest = {
    schema: "gmfdumper.manifest/1",
    finished: "2026-11-13T10:00:00",
    steps: [
      { id: "objects", status: "ok", files: [{ path: "Objects/dump.txt", bytes: 5 }] },
      { id: "cxx", status: "ok", files: [{ path: "Headers/CXX", bytes: 3, count: 1, dir: true }] },
      { id: "usmap", status: "skipped", reason: "native library not loaded", files: [] },
    ],
  };
  const complete = {
    schema: "omnidumper.run_complete/1",
    finished: "2026-11-13T10:00:00",
    profile: "full",
    produced: true,
    levels_ok: 22,
    levels_total: 22,
  };
  const parts = { manifest, complete };
  if (edit) edit(parts);
  write(root, "manifest.json", JSON.stringify(parts.manifest));
  if (parts.complete) write(root, "run_complete.json", JSON.stringify(parts.complete));
}

test("a complete fixture run passes", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root);
  assert.deepEqual(verifyRun(root), { pass: true, problems: [] });
});

test("a size mismatch gives one problem line", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root, { edit: (p) => (p.manifest.steps[0].files[0].bytes = 9) });
  const { pass, problems } = verifyRun(root);
  assert.equal(pass, false);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /Objects\/dump\.txt/);
});

test("a missing file gives one problem line", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root);
  fs.rmSync(path.join(root, "Objects", "dump.txt"));
  const { problems } = verifyRun(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing/);
});

test("a failed step names the step and its error", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root, { edit: (p) => p.manifest.steps.push({ id: "jmap", status: "failed", error: "boom", files: [] }) });
  const { problems } = verifyRun(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /jmap/);
  assert.match(problems[0], /boom/);
});

test("a skipped step with no reason gives one problem line", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root, { edit: (p) => delete p.manifest.steps[2].reason });
  const { problems } = verifyRun(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /usmap/);
});

test("a missing run_complete.json gives one problem line", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root, { edit: (p) => (p.complete = null) });
  const { problems } = verifyRun(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /run_complete\.json/);
});

test("levels_ok below levels_total gives one problem line for the full profile only", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root, { edit: (p) => (p.complete.levels_ok = 20) });
  const { problems } = verifyRun(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /levels_ok/);
  const other = tempDir(t, "gmf-verify-");
  makeRun(other, { edit: (p) => { p.complete.levels_ok = 20; p.complete.profile = "quick"; } });
  assert.equal(verifyRun(other).pass, true);
});

test("an unfinished manifest and an unreadable manifest each give one problem line", (t) => {
  const root = tempDir(t, "gmf-verify-");
  makeRun(root, { edit: (p) => delete p.manifest.finished });
  const unfinished = verifyRun(root);
  assert.equal(unfinished.problems.length, 1);
  assert.match(unfinished.problems[0], /finished/);
  const empty = tempDir(t, "gmf-verify-");
  const missing = verifyRun(empty);
  assert.equal(missing.problems.length, 1);
  assert.match(missing.problems[0], /manifest\.json/);
  write(empty, "manifest.json", "{not json");
  assert.equal(verifyRun(empty).problems.length, 1);
});

test("the operation picks the newest run by name, or a named run, and reports text", async (t) => {
  const workspace = tempDir(t, "gmf-verify-ws-");
  const runs = path.join(workspace, "dumps", "unreal", "runs");
  makeRun(path.join(runs, "Game-5.6-20261112-053156"));
  makeRun(path.join(runs, "Game-5.6-20261113-101500"), { edit: (p) => (p.complete = null) });
  const context = { workspace: { root: workspace }, cwd: workspace };
  const newest = await verifyDumpOperation.handler({}, context);
  assert.equal(newest.data.run, "Game-5.6-20261113-101500");
  assert.equal(newest.data.pass, false);
  assert.match(newest.data.text, /run_complete\.json/);
  const named = await verifyDumpOperation.handler({ run: "Game-5.6-20261112-053156" }, context);
  assert.equal(named.data.pass, true);
  assert.equal(named.data.text, "PASS");
  const absolute = await verifyDumpOperation.handler({ run: path.join(runs, "Game-5.6-20261112-053156") }, context);
  assert.equal(absolute.data.pass, true);
});

test("a step that never ran is a problem", (t) => {
  const root = tempDir(t, "gmf-verify-pending-");
  makeRun(root, { edit: (parts) => parts.manifest.steps.push({ id: "scripts", status: "pending", files: [] }, { id: "names", status: "running", files: [] }) });
  const result = verifyRun(root);
  assert.equal(result.pass, false);
  assert.ok(result.problems.includes("step scripts: did not run (pending)"));
  assert.ok(result.problems.includes("step names: did not finish (running)"));
});
