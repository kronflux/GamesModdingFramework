import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { runDumpOperation, renderConfig } from "../src/engines/unreal/operations/run_dump.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);
try {
  registerOperation(runDumpOperation, runDumpOperation.handler);
} catch {
  // The unreal index may already register it.
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gmf-run-dump-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const AUTH = [
  { effect: "gameWrite", source: "test: user asked for a dump run" },
  { effect: "launchGame", source: "test: user asked for a dump run" },
];

// A game folder with the dumper deployed, and a workspace.
function setup(name, { deployed = true } = {}) {
  const gameDir = path.join(root, `game-${name}`);
  fs.cpSync(path.join(fixturePath("unreal"), "ue4ss-dumps"), gameDir, { recursive: true });
  const ue4ss = path.join(gameDir, "ue4ss");
  const mod = path.join(ue4ss, "Mods", "GmfDumper");
  if (deployed) {
    fs.mkdirSync(path.join(mod, "Scripts"), { recursive: true });
    fs.writeFileSync(path.join(mod, "Scripts", "main.lua"), "-- entry\n");
  }
  const workspaceDir = path.join(root, `ws-${name}`);
  fs.mkdirSync(workspaceDir, { recursive: true });
  const workspace = { root: workspaceDir, config: { version: 1 }, local: { version: 1 }, profile: null };
  return { gameDir, ue4ss, mod, workspace };
}

function writeRun(ue4ss, name, complete, manifest) {
  const dir = path.join(ue4ss, "Dumps", name);
  fs.mkdirSync(path.join(dir, "Objects"), { recursive: true });
  fs.writeFileSync(path.join(dir, "Objects", "UE4SS_ObjectDump.txt"), "");
  if (manifest) fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  if (complete) {
    fs.writeFileSync(
      path.join(dir, "run_complete.json"),
      JSON.stringify({ schema: "gmfdumper.run_complete/1", finished: "2026-11-13T10:00:00Z", profile: "full", produced: true, ...complete }),
    );
  }
  return dir;
}

// Recording process stubs. script(tick) runs on each clock sleep; running is a list of answers
// for isExecutableRunning, the last one repeating.
function stubs({ onSleep = () => {}, running = [false] } = {}) {
  const calls = [];
  let polls = 0;
  let launched = false;
  let ticks = 0;
  let time = 1_000_000;
  const processes = {
    launchDetached(cmd) {
      calls.push(["launchDetached", cmd]);
      launched = true;
      return { pid: 4242 };
    },
    openUrl(url) {
      calls.push(["openUrl", url]);
      launched = true;
    },
    async isExecutableRunning(exe) {
      calls.push(["isExecutableRunning", exe]);
      if (!launched) return running.before ?? false;
      const answer = running[Math.min(polls, running.length - 1)];
      polls += 1;
      return answer;
    },
  };
  const clock = {
    now: () => time,
    async sleep(ms) {
      time += ms;
      ticks += 1;
      onSleep(ticks);
    },
  };
  return { processes, clock, calls, sleeps: () => ticks, launches: () => calls.filter(([name]) => name !== "isExecutableRunning") };
}

async function run(env, stub, inputs = {}, authorizations = AUTH, extra = {}) {
  return executeOperation(
    "unreal.run_dump",
    { gameDir: env.gameDir, ...inputs },
    { workspace: env.workspace, authorizations, processes: stub.processes, clock: stub.clock, ...extra },
  );
}

test("AC-3: without launchGame nothing starts; with it the game starts once and the run is collected", async () => {
  const env = setup("ac3");
  fs.writeFileSync(path.join(env.mod, "auto_run_done.txt"), "done\n");
  const stub = stubs({
    onSleep: (tick) => {
      if (tick === 1) writeRun(env.ue4ss, "Game-Win64-20261113-100000", {});
    },
    running: [true],
  });

  const refused = await run(env, stub, {}, [{ effect: "gameWrite", source: "test" }]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "GMF-E-GATE-001");
  assert.deepEqual(stub.calls, [], "the recorder is empty");
  assert.ok(fs.existsSync(path.join(env.mod, "auto_run_done.txt")), "the marker is untouched");
  assert.equal(fs.existsSync(path.join(env.mod, "config.lua")), false, "no config is written");

  const result = await run(env, stub);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.status, "complete");
  assert.equal(result.data.run, "Game-Win64-20261113-100000");
  assert.equal(result.data.collected.path, path.join(env.workspace.root, "dumps", "unreal", "runs", "Game-Win64-20261113-100000"));
  assert.ok(fs.existsSync(path.join(result.data.collected.path, "run_complete.json")));
  assert.equal(stub.launches().length, 1, "exactly one launch");
  assert.equal(stub.launches()[0][0], "launchDetached");
  assert.equal(result.data.launch.method, "exe");
  assert.equal(fs.existsSync(path.join(env.mod, "auto_run_done.txt")), false, "the marker is removed");
  const config = fs.readFileSync(path.join(env.mod, "config.lua"), "utf8");
  assert.match(config, /default_profile = "full"/);
  const names = stub.calls.map(([name]) => name);
  assert.deepEqual([...new Set(names)].sort(), ["isExecutableRunning", "launchDetached"], "no stop or kill call");
});

test("AC-4 (a): a new crash dump ends the wait at once", async () => {
  const env = setup("crash");
  const stub = stubs({
    onSleep: (tick) => {
      if (tick === 1) fs.writeFileSync(path.join(env.ue4ss, "crash_x.dmp"), "dump");
    },
    running: [true],
  });
  const result = await run(env, stub);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.status, "crashed");
  assert.equal(result.data.crashDump, path.join(env.ue4ss, "crash_x.dmp"));
  assert.equal(result.data.collected, undefined);
});

test("AC-4 (a): a crash dump that existed before the launch is not reported", async () => {
  const env = setup("crash-old");
  fs.writeFileSync(path.join(env.ue4ss, "crash_old.dmp"), "dump");
  const stub = stubs({ running: [true] });
  const result = await run(env, stub, { waitMinutes: 0.1 });
  assert.equal(result.data.status, "running");
});

test("AC-4 (b): the game seen running and then gone twice ends as exited with the log tail", async () => {
  const env = setup("exited");
  fs.writeFileSync(path.join(env.ue4ss, "UE4SS.log"), Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  const stub = stubs({ running: [true, true, false, false] });
  const result = await run(env, stub);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.status, "exited");
  const tail = result.data.logTail.split("\n").filter(Boolean);
  assert.equal(tail.length, 40);
  assert.equal(tail[0], "line 21");
  assert.equal(tail.at(-1), "line 60");
});

test("AC-4 (b): the run log of the newest new run is preferred for the tail", async () => {
  const env = setup("exited-log");
  fs.writeFileSync(path.join(env.ue4ss, "UE4SS.log"), "ue4ss line\n");
  const stub = stubs({
    running: [true, false, false],
    onSleep: (tick) => {
      if (tick === 1) {
        const dir = path.join(env.ue4ss, "Dumps", "Game-Win64-20261113-110000");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "gmfdumper.log"), "mod line\n");
      }
    },
  });
  const result = await run(env, stub);
  assert.equal(result.data.status, "exited");
  assert.match(result.data.logTail, /mod line/);
});

test("AC-4 (b): one poll without the game is not enough", async () => {
  const env = setup("blink");
  const stub = stubs({
    running: [true, false, true, true],
    onSleep: (tick) => {
      if (tick === 4) writeRun(env.ue4ss, "Game-Win64-20261113-120000", {});
    },
  });
  const result = await run(env, stub);
  assert.equal(result.data.status, "complete");
});

test("AC-4 (c): nothing happens until waitMinutes pass, then the status is running", async () => {
  const env = setup("waiting");
  const stub = stubs({ running: [true] });
  const result = await run(env, stub, { waitMinutes: 1 });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.status, "running");
  assert.match(result.data.advice, /unreal\.dump/);
  assert.match(result.data.advice, /collect/);
  assert.equal(stub.launches().length, 1);
});

test("AC-4 (d): produced false returns the manifest reasons and does not collect", async () => {
  const env = setup("empty");
  const stub = stubs({
    running: [true],
    onSleep: (tick) => {
      if (tick === 1) {
        writeRun(
          env.ue4ss,
          "Game-Win64-20261113-130000",
          { produced: false },
          {
            steps: [
              { id: "objects", status: "ok" },
              { id: "usmap", status: "failed", error: "native part missing" },
              { id: "uht", status: "skipped", reason: "disabled" },
            ],
          },
        );
      }
    },
  });
  const result = await run(env, stub);
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.status, "empty");
  assert.deepEqual(result.data.manifestReasons, [
    { id: "usmap", status: "failed", reason: "native part missing" },
    { id: "uht", status: "skipped", reason: "disabled" },
  ]);
  assert.equal(result.data.collected, undefined);
  assert.equal(fs.existsSync(path.join(env.workspace.root, "dumps", "unreal", "runs")), false);
});

test("a second run removes auto_run_done.txt and records one launch", async () => {
  const env = setup("second");
  const first = stubs({ running: [true] });
  await run(env, first, { waitMinutes: 0.1 });
  fs.writeFileSync(path.join(env.mod, "auto_run_done.txt"), "done\n");
  const second = stubs({ running: [true] });
  const result = await run(env, second, { waitMinutes: 0.1 });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(fs.existsSync(path.join(env.mod, "auto_run_done.txt")), false);
  assert.equal(second.launches().length, 1);
  assert.ok(
    fs.readdirSync(path.join(env.workspace.root, "backups")).some((name) => name.endsWith("-config.lua")),
    "the previous config.lua is backed up",
  );
});

test("a run folder that already had run_complete.json is not returned as the new run", async () => {
  const env = setup("preexisting");
  writeRun(env.ue4ss, "Game-Win64-20261112-090000", {});
  const stub = stubs({
    running: [true],
    onSleep: (tick) => {
      if (tick === 2) writeRun(env.ue4ss, "Game-Win64-20261113-140000", {});
    },
  });
  const result = await run(env, stub);
  assert.equal(result.data.status, "complete");
  assert.equal(result.data.run, "Game-Win64-20261113-140000");

  const idle = await run(env, stubs({ running: [true] }), { waitMinutes: 0.1 });
  assert.equal(idle.data.status, "running", "old complete runs alone never count");
});

test("a steam app id launches through openUrl, otherwise launchDetached with the executable", async () => {
  const withId = setup("steam");
  const steam = stubs({ running: [true] });
  const viaSteam = await run(withId, steam, { waitMinutes: 0.1 }, AUTH, { profile: { store: { id: "steam", appId: "3712080" } } });
  assert.equal(viaSteam.ok, true, viaSteam.error?.message);
  assert.deepEqual(steam.launches(), [["openUrl", "steam://rungameid/3712080"]]);
  assert.deepEqual(viaSteam.data.launch, { method: "steam", target: "steam://rungameid/3712080" });

  const without = setup("exe");
  const exe = stubs({ running: [true] });
  const viaExe = await run(without, exe, { waitMinutes: 0.1 });
  assert.deepEqual(exe.launches(), [["launchDetached", path.join(without.gameDir, "Binaries", "Win64", "Game-Win64-Shipping.exe")]]);
  assert.equal(viaExe.data.launch.method, "exe");
});

test("a missing dumper is refused before any write and names unreal.deploy_dumper", async () => {
  const env = setup("undeployed", { deployed: false });
  const stub = stubs();
  const result = await run(env, stub);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-TOOL-001");
  assert.match(`${result.error.message} ${result.error.remediation}`, /unreal\.deploy_dumper/);
  assert.deepEqual(stub.launches(), []);
  assert.equal(fs.existsSync(path.join(env.mod, "config.lua")), false);
});

test("a game that is already running is refused before any write", async () => {
  const env = setup("busy");
  const stub = stubs();
  stub.processes.isExecutableRunning = async (exe) => {
    stub.calls.push(["isExecutableRunning", exe]);
    return true;
  };
  const result = await run(env, stub);
  assert.equal(result.ok, false);
  assert.match(result.error.message, /close the game/i);
  assert.deepEqual(stub.launches(), []);
  assert.equal(fs.existsSync(path.join(env.mod, "config.lua")), false);
});

test("renderConfig writes only keys the mod knows and honours the inputs", () => {
  const full = renderConfig({ profile: "full", quitWhenDone: true });
  assert.match(full, /^return \{/m);
  assert.match(full, /default_profile = "full"/);
  assert.match(full, /mode = "once"/);
  assert.match(full, /freeze_input = true/);
  assert.match(full, /quit_when_done = true/);
  assert.match(full, /levels = \{ enabled = true \}/);
  assert.match(full, /map_tour = \{ enabled = false \}/);
  const quick = renderConfig({ profile: "quick", quitWhenDone: false });
  assert.match(quick, /default_profile = "quick"/);
  assert.match(quick, /quit_when_done = false/);
  assert.ok(full.endsWith("\n") && !full.includes("\r"));
});

test("an app id that is not a number is not sent to Steam: the executable is started instead", async () => {
  const env = setup("badid");
  const stub = stubs({ running: [true] });
  const result = await run(env, stub, { waitMinutes: 0.1 }, AUTH, { profile: { store: { id: "steam", appId: "480&hostname" } } });
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.launch.method, "exe");
  assert.equal(stub.launches().some(([name]) => name === "openUrl"), false);
});

test("a game that cannot be started is reported at once, without waiting", async () => {
  const env = setup("nostart");
  const stub = stubs();
  stub.processes.launchDetached = async () => {
    const error = new Error("GMF-E-EXEC-001: Game.exe could not be started: ENOENT");
    error.code = "GMF-E-EXEC-001";
    throw error;
  };
  const result = await run(env, stub, { waitMinutes: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "GMF-E-EXEC-001");
  assert.match(result.error.message, /could not be started/);
  assert.equal(stub.sleeps?.() ?? 0, 0, "no polling happened");
});

test("a complete run is removed from the game folder once its workspace copy verifies, and kept otherwise", async () => {
  const good = setup("copy-good");
  let gameRun = null;
  const goodStub = stubs({
    onSleep: (tick) => {
      if (tick === 1) gameRun = writeRun(good.ue4ss, "Game-Win64-20261114-100000", {}, { finished: "2026-11-14T10:00:00", steps: [] });
    },
    running: [true],
  });
  const removed = await run(good, goodStub);
  assert.equal(removed.ok, true, removed.error?.message);
  assert.deepEqual(removed.data.gameCopy, { removed: true, path: gameRun });
  assert.equal(fs.existsSync(gameRun), false, "the game folder copy is gone");
  assert.ok(fs.existsSync(path.join(removed.data.collected.path, "run_complete.json")), "the workspace copy stays");

  const bad = setup("copy-bad");
  let badRun = null;
  const badStub = stubs({
    onSleep: (tick) => {
      if (tick === 1) badRun = writeRun(bad.ue4ss, "Game-Win64-20261114-110000", {});
    },
    running: [true],
  });
  const kept = await run(bad, badStub);
  assert.equal(kept.data.gameCopy.removed, false);
  assert.match(kept.data.gameCopy.reason, /did not pass verification: cannot read manifest\.json/);
  assert.ok(fs.existsSync(badRun), "a run whose copy does not verify stays in the game folder");

  const off = setup("copy-off");
  let offRun = null;
  const offStub = stubs({
    onSleep: (tick) => {
      if (tick === 1) offRun = writeRun(off.ue4ss, "Game-Win64-20261114-120000", {}, { finished: "x", steps: [] });
    },
    running: [true],
  });
  const off2 = await run(off, offStub, { removeGameCopy: false });
  assert.deepEqual(off2.data.gameCopy, { removed: false, reason: "removeGameCopy is false" });
  assert.ok(fs.existsSync(offRun));
});

test("the steam app id is read from the profile's game.store, where game_profile writes it", async () => {
  const env = setup("steam-game");
  const stub = stubs({ running: [true] });
  const result = await run(env, stub, { waitMinutes: 0.1 }, AUTH, { profile: { game: { store: { id: "steam", appId: "3712080" } } } });
  assert.equal(result.ok, true, result.error?.message);
  assert.deepEqual(stub.launches(), [["openUrl", "steam://rungameid/3712080"]]);
});
