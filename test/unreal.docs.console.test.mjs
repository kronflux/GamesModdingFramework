// The console section of the docs: console variable names read from the game executable, with
// the values the game's ini files set, and how build_docs finds the executable.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildDocs } from "../src/engines/unreal/docs/build.mjs";
import { iniConsoleValues, scanConsoleNames } from "../src/engines/unreal/docs/sections/console.mjs";
import { findGameExe } from "../src/engines/unreal/operations/docs.mjs";
import { tempDir } from "./helpers/tmp.mjs";

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content));
}

// An executable stand-in: the names as UTF-16LE string literals between binary bytes.
function fakeExe(names) {
  const parts = [Buffer.from([0x4d, 0x5a, 0x90, 0x00])];
  for (const name of names) parts.push(Buffer.from(`${name}\u0000`, "utf16le"), Buffer.from([0xcc, 0xcc]));
  return Buffer.concat(parts);
}

function makeRun(root, manifest = {}) {
  const run = path.join(root, "run");
  write(path.join(run, "manifest.json"), { schema: "gmfdumper.manifest/1", game: "Demo", finished: "x", steps: [], ...manifest });
  write(path.join(run, "Reflection", "classes.json"), {
    schema: "gmfdumper.classes/1",
    classes: [{ name: "KismetMathLibrary", path: "/Script/Engine.KismetMathLibrary", super: null, properties: [], functions: [] }],
  });
  return run;
}

test("scanConsoleNames keeps UTF-16 names shaped like console variables and drops files and numbers", () => {
  const buffer = Buffer.concat([
    fakeExe(["r.Shadow.MaxResolution", "t.MaxFPS", "DefaultEngine.ini", "avc1.640028", "NoDotHere", "a b.c"]),
    Buffer.from("r.AsciiOnly\u0000", "latin1"),
  ]);
  assert.deepEqual(scanConsoleNames(buffer), ["r.Shadow.MaxResolution", "t.MaxFPS"]);
});

test("iniConsoleValues reads console sections, scalability groups and device profile CVars, and skips removals", (t) => {
  const text = tempDir(t, "gmf-cvar-ini-");
  write(path.join(text, "pakchunk0", "Game", "Config", "DefaultEngine.ini"), [
    "[SystemSettings]", "r.MotionBlurQuality=0", "-r.Removed=1",
    "[/Script/Engine.RendererSettings]", "r.NotAConsoleSection=1",
    "[ShadowQuality@2]", "r.Shadow.MaxResolution=1024",
    "",
  ].join("\r\n"));
  write(path.join(text, "pakchunk0", "Game", "Config", "DefaultDeviceProfiles.ini"),
    "[Windows DeviceProfile]\n+CVars=r.ViewDistanceScale=0.8\n[Android DeviceProfile]\n+CVars=r.MobileOnly=1\n");
  const values = iniConsoleValues(text);
  assert.deepEqual([...values.keys()].sort(), ["r.MotionBlurQuality", "r.Shadow.MaxResolution", "r.ViewDistanceScale"]);
  assert.deepEqual(values.get("r.Shadow.MaxResolution"), [
    { value: "1024", file: "pakchunk0/Game/Config/DefaultEngine.ini", section: "ShadowQuality@2" },
  ]);
  assert.equal(values.get("r.ViewDistanceScale")[0].value, "0.8");
});

test("the console section lists names by prefix, removes type paths, and gives prefixes that differ in case their own files", async (t) => {
  const root = tempDir(t, "gmf-cvar-docs-");
  const run = makeRun(root);
  const names = ["KismetMathLibrary.Abs", "t.MaxFPS"];
  for (let i = 0; i < 5; i += 1) names.push(`net.Lower${i}`, `Net.Upper${i}`);
  const exe = path.join(root, "Game-Win64-Shipping.exe");
  write(exe, fakeExe(names));
  const text = path.join(root, "text");
  write(path.join(text, "p", "DefaultEngine.ini"), "[SystemSettings]\nt.MaxFPS=144\n");

  const out = path.join(root, "out");
  const built = await buildDocs(run, out, { gameExe: exe, textDir: text });
  assert.deepEqual(built.brokenLinks, []);
  const section = built.sections.find((entry) => entry.name === "console");
  assert.equal(section.missing, undefined);

  const files = fs.readdirSync(path.join(out, "console")).sort();
  assert.deepEqual(files, ["_index.md", "_other.md", "net-2.md", "net.md", "overview.md"]);
  const pages = files.map((file) => fs.readFileSync(path.join(out, "console", file), "utf8")).join("\n");
  assert.doesNotMatch(pages, /KismetMathLibrary\.Abs/, "a property path of a reflected type is not a console variable");
  const overview = fs.readFileSync(path.join(out, "console", "overview.md"), "utf8");
  assert.match(overview, /\| `t\.MaxFPS` \| `144` \| p\/DefaultEngine\.ini \| SystemSettings \|/);
  assert.match(fs.readFileSync(path.join(out, "console", "_other.md"), "utf8"), /- `t\.MaxFPS`: `144` in p\/DefaultEngine\.ini/);
});

test("without a game executable the console section is reported missing", async (t) => {
  const root = tempDir(t, "gmf-cvar-missing-");
  const built = await buildDocs(makeRun(root), path.join(root, "out"), {});
  const section = built.sections.find((entry) => entry.name === "console");
  assert.equal(section.missing, "the game executable was not found");
  assert.equal(fs.existsSync(path.join(root, "out", "console")), false);
});

test("findGameExe takes the input, then the run's game_exe, then the profile, and skips paths that are not files", (t) => {
  const root = tempDir(t, "gmf-cvar-find-");
  const recorded = path.join(root, "recorded.exe");
  const profiled = path.join(root, "profiled.exe");
  const given = path.join(root, "given.exe");
  for (const file of [recorded, profiled, given]) write(file, "MZ");
  const run = makeRun(root, { game_exe: recorded });
  const context = { workspace: { profile: { paths: { executable: profiled } } } };

  assert.equal(findGameExe({ gameExe: given }, run, context), given);
  assert.equal(findGameExe({ gameExe: path.join(root, "absent.exe") }, run, context), recorded);
  assert.equal(findGameExe({}, makeRun(path.join(root, "b")), context), profiled);
  assert.equal(findGameExe({}, makeRun(path.join(root, "c")), {}), null);
});
