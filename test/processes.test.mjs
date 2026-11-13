import { EventEmitter } from "node:events";
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

test("launchDetached spawns detached and unrefs", async () => {
  const calls = [];
  let unrefs = 0;
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { pid: 4321, unref: () => { unrefs += 1; } };
  };
  const result = await launchDetached("C:\\x\\Game.exe", ["-a"], { cwd: "C:\\x", spawnImpl });
  assert.deepEqual(result, { pid: 4321 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "C:\\x\\Game.exe");
  assert.deepEqual(calls[0].args, ["-a"]);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, "ignore");
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, "C:\\x");
  assert.equal(unrefs, 1);
});

test("launchDetached rejects when the program cannot be started, and resolves once it has", async () => {
  const failing = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit("error", new Error("spawn nope ENOENT")));
    return child;
  };
  await assert.rejects(launchDetached("nope", [], { spawnImpl: failing }), (error) => {
    assert.equal(error.code, "GMF-E-EXEC-001");
    assert.match(error.message, /nope could not be started: spawn nope ENOENT/);
    return true;
  });
  const starting = () => {
    const child = new EventEmitter();
    child.pid = 77;
    child.unref = () => {};
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  assert.deepEqual(await launchDetached("ok", [], { spawnImpl: starting }), { pid: 77 });
  const throwing = () => {
    throw new Error("EACCES");
  };
  await assert.rejects(launchDetached("x", [], { spawnImpl: throwing }), /x could not be started: EACCES/);
});

test("openUrl uses the platform handler without a shell and refuses other schemes and unsafe characters", async () => {
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push([cmd, args, options.shell]);
    return { unref() {} };
  };
  assert.deepEqual(await openUrl("steam://rungameid/480", { platform: "win32", spawnImpl }), {
    command: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", "steam://rungameid/480"],
  });
  assert.deepEqual(await openUrl("https://example.com/?a=1&b=2", { platform: "darwin", spawnImpl }), {
    command: "open",
    args: ["https://example.com/?a=1&b=2"],
  });
  assert.deepEqual(await openUrl("http://example.com/", { platform: "linux", spawnImpl }), {
    command: "xdg-open",
    args: ["http://example.com/"],
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([command, , shell]) => command !== "cmd" && shell === false), "never through cmd or a shell");
  for (const url of [
    "file:///C:/Windows/notepad.exe",
    "javascript:alert(1)",
    "not a url",
    "steam://rungameid/480 & calc",
    'https://example.com/"x"',
    "https://example.com/a^b",
    "https://example.com/a|b",
  ]) {
    await assert.rejects(openUrl(url, { platform: "win32", spawnImpl }), (error) => error.code === "GMF-E-PLAN-001", url);
  }
  assert.equal(calls.length, 3);
});

test("isExecutableRunning on linux sees a game under Proton by its arguments, not another game of the same name", async () => {
  const exe = "/games/Demo/Binaries/Win64/Demo-Win64-Shipping.exe";
  const procFs = (cmdline) => ({
    readdirSync: () => ["1", "42", "self"],
    readlinkSync: (file) => (file.endsWith("/42/exe") ? "/usr/bin/wine64-preloader" : "/usr/bin/bash"),
    readFileSync: (file) => (file.endsWith("/42/cmdline") ? cmdline : "bash\0"),
  });
  const proton = "/usr/bin/wine64-preloader\0Z:\\games\\Demo\\Binaries\\Win64\\Demo-Win64-Shipping.exe\0-fullscreen\0";
  assert.equal(await isExecutableRunning(exe, { platform: "linux", procFs: procFs(proton) }), true);
  const otherFolder = "/usr/bin/wine64-preloader\0Z:\\games\\Other\\Binaries\\Linux\\Demo-Win64-Shipping.exe\0";
  assert.equal(await isExecutableRunning(exe, { platform: "linux", procFs: procFs(otherFolder) }), false);
  const native = { readdirSync: () => ["7"], readlinkSync: () => exe, readFileSync: () => "" };
  assert.equal(await isExecutableRunning(exe, { platform: "linux", procFs: native }), true);
  const unreadable = { readdirSync: () => { throw new Error("EACCES"); } };
  assert.equal(await isExecutableRunning(exe, { platform: "linux", procFs: unreadable }), false);
});

test("isExecutableRunning matches the full path only, not the image name", async () => {
  const other = async () => ({ code: 0, signal: null, stdout: "D:\\other\\Game.exe\r\n", stderr: "" });
  assert.equal(await isExecutableRunning("C:\\x\\Game.exe", { platform: "win32", runImpl: other }), false);
  const both = async () => ({ code: 0, signal: null, stdout: "D:\\other\\Game.exe\r\nc:\\X\\game.EXE\r\n", stderr: "" });
  assert.equal(await isExecutableRunning("C:\\x\\Game.exe", { platform: "win32", runImpl: both }), true);
  const none = async () => ({ code: 0, signal: null, stdout: "", stderr: "" });
  assert.equal(await isExecutableRunning("C:\\x\\Game.exe", { platform: "win32", runImpl: none }), false);
});
