import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleHook } from "../src/core/hooks.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function makeWorkspace({ validated = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-hooks-"));
  const gameDir = `${root}-game`;
  fs.mkdirSync(gameDir, { recursive: true });
  fs.mkdirSync(path.join(root, "mods", "MyMod"), { recursive: true });
  fs.writeFileSync(path.join(root, "gmf.json"), JSON.stringify({ version: 1, game: { name: "Test Game", engine: "unity" } }));
  fs.writeFileSync(path.join(root, "gmf.local.json"), JSON.stringify({ version: 1, gameDir }));
  fs.writeFileSync(
    path.join(root, "gmf.profile.json"),
    JSON.stringify({
      engine: { id: "unity" },
      runtime: { backend: "il2cpp" },
      loader: { id: "bepinex" },
      unknowns: [{ id: "a" }, { id: "b" }],
    }),
  );
  fs.writeFileSync(path.join(root, "mods", "MyMod", "Plugin.cs"), "// synthetic\n");
  if (validated) {
    fs.mkdirSync(path.join(root, ".gmf"));
    fs.writeFileSync(
      path.join(root, ".gmf", "last-validate.json"),
      JSON.stringify({ at: new Date(Date.now() + 60000).toISOString(), command: "gmf run unity.validate" }),
    );
  }
  return { root, gameDir, context: { cwd: root } };
}

function cleanup(ws) {
  fs.rmSync(ws.root, { recursive: true, force: true });
  fs.rmSync(ws.gameDir, { recursive: true, force: true });
}

test("pre-write blocks a decompiled path", () => {
  const ws = makeWorkspace();
  try {
    const result = handleHook("pre-write", { tool_input: { file_path: path.join(ws.root, "decompiled", "Foo.cs") } }, ws.context);
    assert.equal(result.decision, "block");
    assert.ok(result.reason);
    const game = handleHook("pre-write", { tool_input: { file_path: path.join(ws.gameDir, "readme.txt") } }, ws.context);
    assert.equal(game.decision, "block");
    const dll = handleHook("pre-write", { tool_input: { path: path.join(ws.root, "mods", "x.dll") } }, ws.context);
    assert.equal(dll.decision, "block");
  } finally {
    cleanup(ws);
  }
});

test("pre-write passes a mod source file", () => {
  const ws = makeWorkspace();
  try {
    const result = handleHook("pre-write", { tool_input: { file_path: path.join(ws.root, "mods", "MyMod", "Plugin.cs") } }, ws.context);
    assert.equal(result.decision, undefined);
  } finally {
    cleanup(ws);
  }
});

test("pre-write passes a payload with no path", () => {
  const ws = makeWorkspace();
  try {
    assert.equal(handleHook("pre-write", {}, ws.context).decision, undefined);
    assert.equal(handleHook("pre-write", { tool_input: {} }, ws.context).decision, undefined);
  } finally {
    cleanup(ws);
  }
});

test("session-start prints game and loader", () => {
  const ws = makeWorkspace();
  try {
    const { stdout } = handleHook("session-start", {}, ws.context);
    assert.match(stdout, /engine: unity/);
    assert.match(stdout, /Test Game/);
    assert.match(stdout, /loader: bepinex/);
    assert.match(stdout, /unknowns: 2/);
  } finally {
    cleanup(ws);
  }
});

test("session-start says the workspace is not configured when only mods/ exists", (t) => {
  const dir = tempDir(t, "gmf-hooks-");
  fs.mkdirSync(path.join(dir, "mods"));
  assert.match(handleHook("session-start", {}, { workspace: null, cwd: dir }).stdout, /gmf init --game <dir>/);
});

test("post-bash records a validate run and stop stays quiet afterwards", () => {
  const ws = makeWorkspace();
  try {
    handleHook("post-bash", { tool_input: { command: "ls" } }, ws.context);
    assert.equal(fs.existsSync(path.join(ws.root, ".gmf", "last-validate.json")), false);
    // Edit predates the validate run.
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(path.join(ws.root, "mods", "MyMod", "Plugin.cs"), past, past);
    handleHook("post-bash", { tool_input: { command: "gmf run unity.validate" } }, ws.context);
    const record = JSON.parse(fs.readFileSync(path.join(ws.root, ".gmf", "last-validate.json"), "utf8"));
    assert.equal(record.command, "gmf run unity.validate");
    assert.ok(record.at);
    assert.equal(handleHook("stop", {}, ws.context).stdout, "");
  } finally {
    cleanup(ws);
  }
});

test("stop reminds after an unvalidated edit", () => {
  const ws = makeWorkspace();
  try {
    assert.match(handleHook("stop", {}, ws.context).stdout, /unity\.validate/);
    const quiet = makeWorkspace({ validated: true });
    try {
      assert.equal(handleHook("stop", {}, quiet.context).stdout, "");
    } finally {
      cleanup(quiet);
    }
  } finally {
    cleanup(ws);
  }
});

test("all events print nothing outside a workspace", (t) => {
  const dir = tempDir(t, "gmf-hooks-");
  for (const event of ["session-start", "pre-write", "post-bash", "stop"]) {
    const result = handleHook(
      event,
      { tool_input: { file_path: path.join(dir, "decompiled", "a.cs"), command: "unity.validate" } },
      { workspace: null, cwd: dir },
    );
    assert.equal(result.stdout, "", event);
    assert.equal(result.decision, undefined, event);
  }
  assert.equal(fs.existsSync(path.join(dir, ".gmf")), false);
});

test("the hook command prints a block decision as JSON and exits 0", async () => {
  const { runCli } = await import("../src/cli/main.mjs");
  const ws = makeWorkspace();
  try {
    const stdin = JSON.stringify({ cwd: ws.root, tool_input: { file_path: path.join(ws.root, "decompiled", "A.cs") } });
    const result = await runCli(["hook", "pre-write"], {}, { stdin });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(result.stdout).decision, "block");
    const empty = await runCli(["hook", "pre-write"], {}, { stdin: "" });
    assert.equal(empty.exitCode, 0);
  } finally {
    cleanup(ws);
  }
});

test("post-bash records only a real gmf validate invocation", () => {
  const ws = makeWorkspace();
  try {
    const record = path.join(ws.root, ".gmf", "last-validate.json");
    for (const command of ["echo unity.validate", "cat notes/unity.validate.md", "grep unreal.validate src"]) {
      handleHook("post-bash", { tool_input: { command } }, ws.context);
      assert.equal(fs.existsSync(record), false, `${command} is not a validate run`);
    }
    for (const command of ["gmf run unreal.validate --input modDir=mods/X", "node /p/gmf/bin/gmf.mjs run unity.validate", "cd ws && gmf --json run unity.validate"]) {
      fs.rmSync(record, { force: true });
      handleHook("post-bash", { tool_input: { command } }, ws.context);
      assert.equal(fs.existsSync(record), true, `${command} is a validate run`);
    }
  } finally {
    cleanup(ws);
  }
});

test("pre-write guards gamedocs, which holds game-derived docs", () => {
  const ws = makeWorkspace();
  try {
    const result = handleHook("pre-write", { tool_input: { file_path: path.join(ws.root, "gamedocs", "overview.md") } }, ws.context);
    assert.equal(result.decision, "block");
    assert.match(result.reason, /gamedocs/);
  } finally {
    cleanup(ws);
  }
});

test("pre-write judges names only inside the workspace: a loader-named file elsewhere passes", () => {
  const ws = makeWorkspace();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-hooks-other-"));
  try {
    const outside = handleHook("pre-write", { tool_input: { file_path: path.join(elsewhere, "UE4SS-settings.dumpers.ini") } }, ws.context);
    assert.equal(outside.decision, undefined, "a file outside the workspace and the game folder is not gmf's to guard");
    const inside = handleHook("pre-write", { tool_input: { file_path: path.join(ws.root, "mods", "UE4SS-settings.ini") } }, ws.context);
    assert.equal(inside.decision, "block");
  } finally {
    cleanup(ws);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("session-start points at gamedocs/overview.md when the docs are built", () => {
  const ws = makeWorkspace();
  try {
    assert.doesNotMatch(handleHook("session-start", {}, ws.context).stdout, /gamedocs/);
    fs.mkdirSync(path.join(ws.root, "gamedocs"));
    fs.writeFileSync(path.join(ws.root, "gamedocs", "overview.md"), "# synthetic\n");
    assert.match(handleHook("session-start", {}, ws.context).stdout, /docs: gamedocs\/overview\.md \(read it first\)/);
  } finally {
    cleanup(ws);
  }
});
