import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseCrashStack } from "../src/engines/unreal/crash.mjs";
import unreal from "../src/engines/unreal/index.mjs";
import { executeOperation, registerOperation } from "../src/core/operations.mjs";
import { fixture as fixturePath } from "./helpers/paths.mjs";

for (const operation of unreal.operations) registerOperation(operation, operation.handler);

const fixtureDir = fixturePath("crash");
const logFile = path.join(fixtureDir, "UE4SS-crash.log");

test("frames carry module and offset and the nearest mod file", () => {
  const stack = parseCrashStack(fs.readFileSync(logFile, "utf8"));
  assert.equal(stack.faultingModule, "Game-Win64-Shipping.exe");
  assert.equal(stack.frames.length, 4);
  assert.deepEqual(stack.frames[1], {
    module: "UE4SS",
    offset: "0x124",
    symbol: "RC::LuaType::push_softobjectproperty",
  });
  assert.equal(stack.frames[0].symbol, null);
  assert.ok(stack.frames.every((frame) => frame.module && /^0x[0-9a-f]+$/.test(frame.offset)));
  assert.equal(stack.nearestMod, "Mods/GmfSample/Scripts/main.lua");
  assert.ok(fs.existsSync(path.join(fixtureDir, stack.nearestMod)), stack.nearestMod);
});

test("text without frames gives an empty stack", () => {
  const stack = parseCrashStack("nothing useful here\n");
  assert.deepEqual(stack, {
    frames: [],
    error: null,
    engineVersion: null,
    faultingModule: null,
    allSystemFrames: false,
    crashedThread: null,
    nearestMod: null,
  });
});

test("cdb frames with a trailing source location all parse", () => {
  const text = ["00 Game!Foo::Bar+0x12 [c:\\src\\a.cpp @ 123]", "01 Game!Baz+0x5", ""].join("\n");
  const stack = parseCrashStack(text);
  assert.deepEqual(stack.frames, [
    { module: "Game", offset: "0x12", symbol: "Foo::Bar" },
    { module: "Game", offset: "0x5", symbol: "Baz" },
  ]);
});

test("a Faulting module name header gives the module, not the word name", () => {
  const stack = parseCrashStack("Faulting module name: ntdll.dll, version 10.0\n");
  assert.equal(stack.faultingModule, "ntdll.dll");
  assert.equal(parseCrashStack("Faulting module name: Game.exe, version 1.0\n").faultingModule, "Game.exe");
  assert.equal(parseCrashStack("Exception in module Game.exe at 0x10\n").faultingModule, "Game.exe");
});

test("the text path blames the first module outside the Windows system modules", () => {
  const stack = parseCrashStack(["00 ntdll!RtlFoo+0x10", "01 Game!Baz+0x5"].join("\n"));
  assert.equal(stack.faultingModule, "Game");
  assert.equal(stack.allSystemFrames, false);
  const headed = parseCrashStack(["Faulting module name: ntdll.dll, version 10.0", "00 ntdll!RtlFoo+0x10", "01 Game!Baz+0x5"].join("\n"));
  assert.equal(headed.faultingModule, "Game");
  const onlySystem = parseCrashStack(["00 ntdll!RtlFoo+0x10", "01 KERNELBASE!Raise+0x2"].join("\n"));
  assert.equal(onlySystem.faultingModule, "ntdll");
  assert.equal(onlySystem.allSystemFrames, true);
});

test("unreal.crash_stack reads a log file", async () => {
  const result = await executeOperation("unreal.crash_stack", { file: logFile }, {});
  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.data.faultingModule, "Game-Win64-Shipping.exe");
  const missing = await executeOperation("unreal.crash_stack", { file: path.join(fixtureDir, "none.log") }, {});
  assert.equal(missing.ok, false);
});

test("an Unreal CrashContext.runtime-xml yields the error, engine version and the first non-system frame", async () => {
  const { parseCrashStack } = await import("../src/engines/unreal/crash.mjs");
  const xml = [
    "<?xml version=\"1.0\"?><FGenericCrashContext><RuntimeProperties>",
    "<ErrorMessage>Unhandled Exception: EXCEPTION_ACCESS_VIOLATION 0x0000000000000000</ErrorMessage>",
    "<EngineVersion>5.6.1-44394996+++UE5+Release-5.6</EngineVersion>",
    "<CallStack></CallStack>",
    "<Threads><Thread><CallStack>ntdll                       0x00007ffc8d100000 + 161c44          ",
    "ntdll                       0x00007ffc8d100000 + 162244          ",
    "UE4SS                       0x00007ffc70000000 + 1a2b3c          ",
    "FixtureGame-Win64-Shipping  0x00007ff633000000 + 3dc3320          ",
    "</CallStack>",
    "<IsCrashed>true</IsCrashed>",
    "<ThreadName>GameThread</ThreadName>",
    "</Thread><Thread><CallStack>ntdll                       0x00007ffc8d100000 + 161c44          ",
    "</CallStack>",
    "<IsCrashed>false</IsCrashed>",
    "<ThreadName>BackgroundThreadPool #0</ThreadName>",
    "</Thread></Threads>",
    "</RuntimeProperties></FGenericCrashContext>",
  ].join("\n");
  const stack = parseCrashStack(xml);
  assert.equal(stack.error, "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION 0x0000000000000000");
  assert.equal(stack.engineVersion, "5.6.1-44394996+++UE5+Release-5.6");
  assert.equal(stack.frames.length, 4);
  assert.deepEqual(stack.frames[2], { module: "UE4SS", offset: "0x1a2b3c", symbol: null });
  assert.equal(stack.faultingModule, "UE4SS", "the first frame outside Windows system modules");
  assert.equal(stack.allSystemFrames, false);
  assert.equal(stack.crashedThread, "GameThread");
});
