import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkLuaBalance, checkModuleRefs, runLanguageServer } from "../src/engines/unreal/luacheck.mjs";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";
import { tempDir } from "./helpers/tmp.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const base = fixturePath("luacheck");
const scripts = (name) => path.join(base, name, "Scripts");
const luaFiles = (name) =>
  fs.readdirSync(scripts(name)).filter((file) => file.endsWith(".lua")).map((file) => path.join(scripts(name), file));
const balance = (name) =>
  luaFiles(name).flatMap((file) => checkLuaBalance(fs.readFileSync(file, "utf8"), path.basename(file)));

test("unbalanced block names file and line", () => {
  const issues = balance("unbalanced");
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 7);
  assert.equal(issues[0].file, "main.lua");
  assert.equal(issues[0].severity, "error");
  assert.match(issues[0].message, /function/);
});

test("missing module field names the field", () => {
  const issues = checkModuleRefs(scripts("missing-field"));
  assert.ok(issues.some((issue) => /vaild/.test(issue.message)));
  assert.equal(issues[0].line, 4);
});

test("ok folder has zero issues", () => {
  assert.deepEqual(balance("ok"), []);
  assert.deepEqual(checkModuleRefs(scripts("ok")), []);
});

test("long strings, nested blocks and stray closers are handled", () => {
  assert.deepEqual(checkLuaBalance("local s = [[ end ) ]]\nfor i = 1, 2 do\n  if i then end\nend\n", "a.lua"), []);
  assert.equal(checkLuaBalance("end\n", "a.lua")[0].line, 1);
  assert.equal(checkLuaBalance("local t = {\n  1,\n", "a.lua")[0].line, 1);
  assert.equal(checkLuaBalance("local s = 'open\nprint(s)\n", "a.lua")[0].line, 1);
});

test("language server is skipped when not on PATH", () => {
  const result = runLanguageServer(scripts("ok"), { resolveOnPath: () => null });
  assert.equal(result.ran, false);
  assert.deepEqual(result.issues, []);
});

test("unreal.lua_check reports issues through the operation", async () => {
  const bad = await executeOperation(
    "unreal.lua_check",
    { modDir: path.join(base, "unbalanced"), languageServer: false },
    {},
  );
  assert.equal(bad.ok, true, bad.error?.message);
  assert.equal(bad.data.ok, false);
  assert.equal(bad.data.issues[0].line, 7);
  const good = await executeOperation("unreal.lua_check", { modDir: path.join(base, "ok"), languageServer: false }, {});
  assert.equal(good.data.ok, true);
  assert.equal(good.data.issues.length, 0);
});

const lines = (...rows) => `${rows.join("\n")}\n`;

test("line numbers survive an unclosed string and a backslash-newline continuation", () => {
  const unclosed = checkLuaBalance(lines('local a = "oops', "local b = 1", "if x then"), "f.lua");
  assert.deepEqual(
    unclosed.map((entry) => [entry.line, entry.message]),
    [
      [1, "Unclosed string."],
      [3, "Unclosed 'if' block: no matching 'end' or 'until'."],
    ],
  );
  const continued = checkLuaBalance(lines('local a = "x\\', 'y"', "local c = 1", "if x then"), "f.lua");
  assert.deepEqual(
    continued.map((entry) => entry.line),
    [4],
  );
});

function withScripts(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-luacheck-"));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("fields declared in the module's table constructor are known", () => {
  const files = {
    "mod.lua": lines("local M = { a = 1, b = function() end, nested = { c = 2 } }", "return M"),
    "main.lua": lines('local m = require("mod")', "print(m.a, m.b, m.nested)", "print(m.c)"),
  };
  const issues = withScripts(files, checkModuleRefs);
  assert.deepEqual(
    issues.map((entry) => [entry.file, entry.line, entry.message]),
    [["main.lua", 3, "uses module field m.c, but mod does not define it."]],
  );
});

test("assigning to or defining a field through the alias is not a read, and a rebound alias is dropped", () => {
  const files = {
    "mod.lua": lines("local M = { a = 1 }", "return M"),
    "main.lua": lines(
      'local m = require("mod")',
      "m.extra = 1",
      "function m.helper() end",
      "function m:method() end",
      "print(m.missing)",
      "m = {}",
      "print(m.other)",
    ),
  };
  const issues = withScripts(files, checkModuleRefs);
  assert.deepEqual(
    issues.map((entry) => [entry.line, entry.message]),
    [[5, "uses module field m.missing, but mod does not define it."]],
  );
});

test("a language server that fails to start or is killed reports ran:false with a reason", (t) => {
  const dir = tempDir(t, "gmf-luacheck-");
  const found = () => "lua-language-server";
  const spawnError = runLanguageServer(dir, { resolveOnPath: found, spawn: () => ({ error: new Error("spawn failed"), stdout: "", stderr: "" }) });
  assert.equal(spawnError.ran, false);
  assert.match(spawnError.reason, /spawn failed/);
  assert.deepEqual(spawnError.issues, []);
  const killed = runLanguageServer(dir, { resolveOnPath: found, spawn: () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "" }) });
  assert.equal(killed.ran, false);
  assert.match(killed.reason, /SIGTERM/);
  const ok = runLanguageServer(dir, { resolveOnPath: found, spawn: () => ({ status: 0, signal: null, stdout: "", stderr: "" }) });
  assert.equal(ok.ran, true);
  assert.equal(runLanguageServer(dir, { resolveOnPath: () => null }).reason, "lua-language-server is not on PATH");
});
