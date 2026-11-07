import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hashOperation } from "../src/operations/generic/hash.mjs";
import { runToolOperation } from "../src/operations/generic/run_tool.mjs";
import { genericOperations } from "../src/operations/generic/index.mjs";
import { tempDir } from "./helpers/tmp.mjs";

test("generic index exports backup, restore, hash and run_tool", () => {
  assert.deepEqual(
    genericOperations.map((op) => op.id).sort(),
    ["generic.backup", "generic.hash", "generic.restore", "generic.run_tool"],
  );
});

test("generic.hash returns the sha256 and size of a file and refuses a folder", async (t) => {
  const dir = tempDir(t, "gmf-hash-");
  const file = path.join(dir, "a.bin");
  fs.writeFileSync(file, "hello");
  const result = await hashOperation.handler({ file });
  assert.equal(result.data.sha256, crypto.createHash("sha256").update("hello").digest("hex"));
  assert.equal(result.data.size, 5);
  await assert.rejects(() => hashOperation.handler({ file: dir }), /GMF-E-FILE-001/);
});

test("generic.run_tool runs a resolved tool and returns the exit code and tails", async () => {
  const calls = [];
  const context = {
    tools: { fake: { cmd: "fake.exe", args: ["--base"] } },
    runProcess: async (cmd, args) => {
      calls.push([cmd, args]);
      return { code: 3, stdout: "l1\nl2\nl3\n", stderr: "boom" };
    },
  };
  const result = await runToolOperation.handler({ tool: "fake", args: ["x"], tailLines: 2 }, context);
  assert.deepEqual(calls[0], ["fake.exe", ["--base", "x"]]);
  assert.equal(result.data.exitCode, 3);
  assert.equal(result.data.stdoutTail, "l2\nl3", "the trailing newline does not take a line slot");
  assert.equal(result.data.stderrTail, "boom");
  await assert.rejects(() => runToolOperation.handler({ tool: "missing" }, { tools: {} }), /GMF-E-TOOL-001/);
});

test("generic.run_tool refuses a working directory outside the workspace and runs one inside it", async (t) => {
  const workspaceRoot = tempDir(t, "gmf-run-tool-ws-");
  const outside = tempDir(t, "gmf-run-tool-outside-");
  fs.mkdirSync(path.join(workspaceRoot, "work"));
  const seen = [];
  const context = {
    workspace: { root: workspaceRoot },
    tools: { fake: { cmd: "fake.exe", args: [] } },
    runProcess: async (cmd, args, options) => {
      seen.push(options.cwd);
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  for (const cwd of [outside, path.join(workspaceRoot, "..", "elsewhere"), ".."]) {
    await assert.rejects(() => runToolOperation.handler({ tool: "fake", cwd }, context), /GMF-E-PLAN-001/);
  }
  await assert.rejects(() => runToolOperation.handler({ tool: "fake", cwd: outside }, { ...context, workspace: null }), /GMF-E-PLAN-001/);
  assert.deepEqual(seen, [], "the tool never ran");
  await runToolOperation.handler({ tool: "fake", cwd: "work" }, context);
  await runToolOperation.handler({ tool: "fake", cwd: path.join(workspaceRoot, "work") }, context);
  await runToolOperation.handler({ tool: "fake" }, context);
  assert.deepEqual(seen, [path.join(workspaceRoot, "work"), path.join(workspaceRoot, "work"), workspaceRoot]);
});
