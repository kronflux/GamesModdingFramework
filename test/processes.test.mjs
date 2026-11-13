import test from "node:test";
import assert from "node:assert/strict";
import { isExecutableRunning, launchDetached, openUrl, runProcess, spawnOwned, stopOwned, withTimeout } from "../src/core/processes.mjs";

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

test("launchDetached spawns detached and unrefs", () => {
  const calls = [];
  let unrefs = 0;
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { pid: 4321, unref: () => { unrefs += 1; } };
  };
  const result = launchDetached("C:\\x\\Game.exe", ["-a"], { cwd: "C:\\x", spawnImpl });
  assert.deepEqual(result, { pid: 4321 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "C:\\x\\Game.exe");
  assert.deepEqual(calls[0].args, ["-a"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.cwd, "C:\\x");
  assert.equal(unrefs, 1);
});

test("openUrl picks the command per platform and refuses file: URLs", () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push([cmd, args]);
    return { unref() {} };
  };
  assert.deepEqual(openUrl("steam://run/1", { platform: "win32", spawnImpl }), {
    command: "cmd",
    args: ["/c", "start", "", "steam://run/1"],
  });
  assert.deepEqual(openUrl("https://example.com/", { platform: "darwin", spawnImpl }), {
    command: "open",
    args: ["https://example.com/"],
  });
  assert.deepEqual(openUrl("http://example.com/", { platform: "linux", spawnImpl }), {
    command: "xdg-open",
    args: ["http://example.com/"],
  });
  assert.equal(calls.length, 3);
  for (const url of ["file:///C:/Windows/notepad.exe", "javascript:alert(1)", "not a url"]) {
    assert.throws(() => openUrl(url, { platform: "win32", spawnImpl }), (error) => error.code === "GMF-E-PLAN-001");
  }
  assert.equal(calls.length, 3);
});

test("isExecutableRunning matches the full path only, not the image name", async () => {
  const other = async () => ({ code: 0, signal: null, stdout: "D:\\other\\Game.exe\r\n", stderr: "" });
  assert.equal(await isExecutableRunning("C:\\x\\Game.exe", { platform: "win32", runImpl: other }), false);
  const both = async () => ({ code: 0, signal: null, stdout: "D:\\other\\Game.exe\r\nc:\\X\\game.EXE\r\n", stderr: "" });
  assert.equal(await isExecutableRunning("C:\\x\\Game.exe", { platform: "win32", runImpl: both }), true);
  const none = async () => ({ code: 0, signal: null, stdout: "", stderr: "" });
  assert.equal(await isExecutableRunning("C:\\x\\Game.exe", { platform: "win32", runImpl: none }), false);
});
