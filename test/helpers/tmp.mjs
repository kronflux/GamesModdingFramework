import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// A fresh folder under the system temp folder, removed when the test `t` finishes, pass or fail.
export function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fresh folder created at module level or in a shared helper, removed when the test file finishes.
export function tempRoot(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
