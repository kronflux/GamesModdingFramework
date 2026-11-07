import test from "node:test";
import assert from "node:assert/strict";
import { runProcess, spawnOwned, stopOwned, withTimeout } from "../src/core/processes.mjs";

test("runProcess captures stdout and the exit code", async () => {
  const result = await runProcess(process.execPath, ["-e", "console.log('ok')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "ok");
});

test("withTimeout rejects a slow promise with a stable code", async () => {
  await assert.rejects(() => withTimeout(new Promise(() => {}), 20), /GMF-E-TIMEOUT-001/);
});

test("stopOwned stops an owned child by its process id", async () => {
  const owned = spawnOwned(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
  assert.ok(owned.pid > 0);
  await stopOwned(owned);
  assert.ok(owned.child.exitCode !== null || owned.child.signalCode !== null);
});

test("runProcess rejects with GMF-E-TIMEOUT-001 when the child outlives timeoutMs", async () => {
  await assert.rejects(
    () => runProcess(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { timeoutMs: 200 }),
    (error) => error.code === "GMF-E-TIMEOUT-001" && /timed out after 200 ms/.test(error.message),
  );
});

test("runProcess rejects with ENOENT when the binary does not exist", async () => {
  await assert.rejects(
    () => runProcess("gmf-no-such-binary-for-tests", []),
    (error) => error.code === "ENOENT",
  );
});

test("runProcess captures stderr separately from stdout", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err')"]);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "out");
  assert.equal(result.stderr, "err");
});

test("runProcess decodes multi-byte output as UTF-8 and reports a non-zero exit", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdout.write('\u00e9\u00e9'); process.exitCode = 3"]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "éé");
  assert.equal(result.timedOut, false);
});
