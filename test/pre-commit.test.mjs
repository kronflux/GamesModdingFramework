// The pre-commit gate scans what will be committed: the staged blobs, not the
// working tree, and every .env.* file.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkContent, main, scanStaged, stagedFiles } from "../scripts/pre-commit.mjs";
import { tempDir } from "./helpers/tmp.mjs";

const SECRET = ["api_key", "=", '"', "0123456789abcdefghij", '"'].join("");

function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function repo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-precommit-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Test"]);
  return root;
}

function quiet(fn) {
  const log = console.log;
  const error = console.error;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    return { code: fn(), lines };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("checkContent flags a secret in text and game content by name, and treats .env.local as text", () => {
  assert.equal(checkContent("src/a.mjs", `const x = ${SECRET};`).length, 1);
  assert.equal(checkContent("src/a.mjs", "const x = 1;").length, 0);
  assert.equal(checkContent("tools/UE4SS.dll", Buffer.from([0x4d, 0x5a]))[0].kind, "game-content");
  assert.equal(checkContent(".env.local", `TOKEN=x\n${SECRET}\n`).length, 1, ".env.local is scanned as text");
  assert.equal(checkContent("test/fixtures/x/winhttp.dll", Buffer.from("SYNTHETIC")).length, 0, "synthetic fixtures are allowed");
});

test("the staged scan reads the index, so a secret staged then removed from the working tree is still caught", (t) => {
  const root = repo(t);
  const file = path.join(root, "config.mjs");
  fs.writeFileSync(file, `export const key = ${SECRET};\n`);
  git(root, ["add", "config.mjs"]);
  fs.writeFileSync(file, "export const key = process.env.KEY;\n");
  assert.deepEqual(stagedFiles(root), ["config.mjs"]);
  const result = scanStaged(root);
  assert.equal(result.ok, false);
  assert.equal(result.violations[0].path, "config.mjs");
  assert.equal(result.violations[0].kind, "secret");
  const run = quiet(() => main(["--staged"], root));
  assert.equal(run.code, 1);
});

test("a clean staged set exits 0, an empty staged set exits 0, and no git repository is an error", (t) => {
  const root = repo(t);
  fs.writeFileSync(path.join(root, "ok.mjs"), "export const ok = true;\n");
  git(root, ["add", "ok.mjs"]);
  assert.equal(quiet(() => main(["--staged"], root)).code, 0);
  git(root, ["commit", "-q", "-m", "ok"]);
  assert.deepEqual(stagedFiles(root), []);
  assert.equal(quiet(() => main(["--staged"], root)).code, 0, "nothing staged is nothing to check");
  const plain = tempDir(t, "gmf-precommit-plain-");
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal(stagedFiles(plain), null);
  const run = quiet(() => main(["--staged"], plain));
  assert.equal(run.code, 1);
  assert.ok(run.lines.some((line) => /git/.test(line)), run.lines.join("\n"));
});
