// Runs the GmfDumper mod's own Lua tests (test/dumper/*.lua) when a Lua interpreter is on PATH.
// gmf never installs one; without it the test is skipped. The Lua tests use Windows paths.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { repoRoot } from "./helpers/paths.mjs";

function luaAvailable() {
  const probe = spawnSync("lua", ["-v"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

const reason =
  process.platform !== "win32"
    ? "the mod's Lua tests use Windows paths"
    : luaAvailable()
      ? false
      : "lua is not on PATH";

test("the GmfDumper Lua tests pass", { skip: reason }, () => {
  const run = spawnSync("lua", [path.join("test", "dumper", "run.lua")], { cwd: repoRoot, encoding: "utf8" });
  const summary = (run.stdout || "").trim().split(/\r?\n/).pop() || "";
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(summary, /^\d+ passed, 0 failed, \d+ files$/);
});
